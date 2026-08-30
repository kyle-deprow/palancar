import type { EmbeddingRunner } from "./types.js";
import { cosineSimilarity, normalizeVector } from "./verifier.js";
import { PCM_SAMPLE_RATE_HZ, PcmSlidingWindow } from "./window.js";
export const DEFAULT_ENROLLMENT_CONFIG = Object.freeze({
  minEnrollmentMs: 10_000,
  minEnrollmentEmbeddings: 8,
  minEnrollmentCoherence: 0.5,
  windowMs: 1_000,
  embedIntervalMs: 250,
});
export interface EnrollmentConfig {
  readonly minEnrollmentMs?: number;
  readonly minEnrollmentEmbeddings?: number;
  readonly minEnrollmentCoherence?: number;
  readonly windowMs?: number;
  readonly embedIntervalMs?: number;
}
interface ResolvedEnrollmentConfig {
  readonly minEnrollmentMs: number;
  readonly minEnrollmentEmbeddings: number;
  readonly minEnrollmentCoherence: number;
  readonly windowMs: number;
  readonly embedIntervalMs: number;
}
export interface EnrollmentSessionOptions {
  readonly embedding: EmbeddingRunner;
  readonly config?: EnrollmentConfig;
}
export interface EnrollmentResult {
  readonly centroid: Float32Array;
  readonly embeddingCount: number;
  readonly speechMs: number;
  readonly coherence: number;
}
export interface EnrollmentSnapshot {
  readonly speechMs: number;
  readonly embeddingCount: number;
  readonly retainedSamples: number;
}
export class EnrollmentError extends Error {
  readonly reason: "insufficient-speech" | "insufficient-embeddings" | "incoherent" | "invalid-embedding";
  constructor(reason: EnrollmentError["reason"], message: string) {
    super(message);
    this.name = "EnrollmentError";
    this.reason = reason;
  }
}
function resolveConfig(config: EnrollmentConfig | undefined): ResolvedEnrollmentConfig {
  const resolved = { ...DEFAULT_ENROLLMENT_CONFIG, ...config };
  if (!Number.isFinite(resolved.minEnrollmentMs) || resolved.minEnrollmentMs <= 0) {
    throw new RangeError("minEnrollmentMs must be positive and finite");
  }
  if (!Number.isInteger(resolved.minEnrollmentEmbeddings) || resolved.minEnrollmentEmbeddings < 1) {
    throw new RangeError("minEnrollmentEmbeddings must be a positive integer");
  }
  if (
    !Number.isFinite(resolved.minEnrollmentCoherence) ||
    resolved.minEnrollmentCoherence < -1 ||
    resolved.minEnrollmentCoherence > 1
  ) {
    throw new RangeError("minEnrollmentCoherence must be within [-1, 1]");
  }
  if (!Number.isFinite(resolved.windowMs) || resolved.windowMs <= 0) {
    throw new RangeError("windowMs must be positive and finite");
  }
  if (!Number.isFinite(resolved.embedIntervalMs) || resolved.embedIntervalMs <= 0) {
    throw new RangeError("embedIntervalMs must be positive and finite");
  }
  return resolved;
}
const samplesForMs = (milliseconds: number): number =>
  Math.max(1, Math.round((milliseconds * PCM_SAMPLE_RATE_HZ) / 1_000));
export interface EnrollmentSession {
  /** Audio is ineligible unless the caller explicitly confirms speech. */
  pushPcm(bytes: Uint8Array, speech?: boolean): Promise<void>;
  complete(): Promise<EnrollmentResult>;
  reset(): void;
  snapshot(): EnrollmentSnapshot;
}
export function createEnrollmentSession(options: EnrollmentSessionOptions): EnrollmentSession {
  const config = resolveConfig(options.config);
  const window = new PcmSlidingWindow({ capacitySamples: samplesForMs(config.windowMs) });
  const processHopSamples = Math.min(960, samplesForMs(config.embedIntervalMs));
  const embeddings: Float32Array[] = [];
  let speechMs = 0;
  let speechSamples = 0;
  let processedHops = 0;
  let claimedHops = 0;
  let lastEmbeddingAtMs: number | undefined;
  let generation = 0;
  let worker: Promise<void> | undefined;
  let activeSamples: Float32Array | undefined;
  let workerError: unknown;
  let pendingByte: number | undefined;
  let pendingByteSpeech = false;
  const alignedPair = new Uint8Array(2);
  const waiters: Array<{
    readonly targetHops: number;
    readonly resolve: () => void;
    readonly reject: (reason?: unknown) => void;
  }> = [];
  function clearEmbeddings(): void {
    for (const embedding of embeddings) embedding.fill(0);
    embeddings.length = 0;
  }
  function clearState(): void {
    window.clear();
    clearEmbeddings();
    speechMs = 0;
    speechSamples = 0;
    processedHops = 0;
    claimedHops = 0;
    lastEmbeddingAtMs = undefined;
    pendingByte = undefined;
    pendingByteSpeech = false;
    alignedPair.fill(0);
    workerError = undefined;
  }
  function retainAlignedSample(low: number, high: number): void {
    alignedPair[0] = low;
    alignedPair[1] = high;
    window.push(alignedPair);
    speechSamples += 1;
  }
  function ingest(bytes: Uint8Array, speech: boolean): void {
    let offset = 0;
    if (pendingByte !== undefined && bytes.length > 0) {
      if (pendingByteSpeech && speech) retainAlignedSample(pendingByte, bytes[0] ?? 0);
      pendingByte = undefined;
      pendingByteSpeech = false;
      offset = 1;
    }
    while (offset + 1 < bytes.length) {
      if (speech) window.push(bytes.subarray(offset, offset + 2));
      if (speech) speechSamples += 1;
      offset += 2;
    }
    if (offset < bytes.length) {
      pendingByte = bytes[offset];
      pendingByteSpeech = speech;
    }
    speechMs = (speechSamples * 1_000) / PCM_SAMPLE_RATE_HZ;
  }
  function normalizedEmbedding(raw: Float32Array): Float32Array {
    for (const value of raw) {
      if (!Number.isFinite(value)) {
        throw new EnrollmentError("invalid-embedding", "Enrollment embedding contains a non-finite value");
      }
    }
    const normalized = normalizeVector(raw);
    let norm = 0;
    for (const value of normalized) norm += value * value;
    if (normalized.length === 0 || norm === 0) {
      throw new EnrollmentError("invalid-embedding", "Enrollment produced a zero-norm embedding");
    }
    return normalized;
  }
  async function processHop(samples: Float32Array, processedSpeechSamples: number, token: number): Promise<void> {
    if (token !== generation) return;
    if (processedSpeechSamples < window.capacitySamples) return;
    const due = lastEmbeddingAtMs === undefined ||
      (processedSpeechSamples * 1_000) / PCM_SAMPLE_RATE_HZ - lastEmbeddingAtMs >= config.embedIntervalMs;
    if (!due) return;
    const normalized = normalizedEmbedding(await options.embedding.embed(samples));
    if (token !== generation) {
      normalized.fill(0);
      return;
    }
    embeddings.push(normalized);
    lastEmbeddingAtMs = (processedSpeechSamples * 1_000) / PCM_SAMPLE_RATE_HZ;
  }
  function settleWaiters(error?: unknown): void {
    let index = 0;
    while (index < waiters.length) {
      const waiter = waiters[index];
      if (waiter === undefined || waiter.targetHops > processedHops) {
        index += 1;
        continue;
      }
      waiters.splice(index, 1);
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
    }
  }
  function schedule(): void {
    if (worker !== undefined || workerError !== undefined) return;
    const availableHops = Math.floor(speechSamples / processHopSamples);
    if (claimedHops >= availableHops) return;
    claimedHops += 1;
    const processedSpeechSamples = claimedHops * processHopSamples;
    const token = generation;
    const samples = window.trailingSamples();
    activeSamples = samples;
    const task = processHop(samples, processedSpeechSamples, token);
    worker = task;
    void task.then(
      () => {
        if (activeSamples === samples) activeSamples = undefined;
        if (worker === task) worker = undefined;
        samples.fill(0);
        if (token === generation) {
          processedHops += 1;
          settleWaiters();
        }
        schedule();
      },
      (error: unknown) => {
        if (activeSamples === samples) activeSamples = undefined;
        if (worker === task) worker = undefined;
        samples.fill(0);
        if (token === generation) {
          processedHops += 1;
          workerError = error;
          settleWaiters(error);
        } else {
          settleWaiters();
          schedule();
        }
      },
    );
  }
  function pushPcm(bytes: Uint8Array, speech?: boolean): Promise<void> {
    ingest(bytes, speech === true);
    const targetHops = Math.floor(speechSamples / processHopSamples);
    if (targetHops <= processedHops) return Promise.resolve();
    if (workerError !== undefined) return Promise.reject(workerError);
    const result = new Promise<void>((resolve, reject) => {
      waiters.push({ targetHops, resolve, reject });
    });
    schedule();
    return result;
  }
  function waitForHops(targetHops: number): Promise<void> {
    if (targetHops <= processedHops) return Promise.resolve();
    if (workerError !== undefined) return Promise.reject(workerError);
    const result = new Promise<void>((resolve, reject) => {
      waiters.push({ targetHops, resolve, reject });
    });
    schedule();
    return result;
  }
  async function complete(): Promise<EnrollmentResult> {
    const token = generation;
    try {
      await waitForHops(Math.floor(speechSamples / processHopSamples));
      if (token !== generation) {
        throw new EnrollmentError("insufficient-speech", "Enrollment was reset before completion");
      }
      if (speechMs < config.minEnrollmentMs) {
        throw new EnrollmentError("insufficient-speech", `Enrollment requires at least ${config.minEnrollmentMs} ms of speech`);
      }
      if (window.sampleCount > 0 && (lastEmbeddingAtMs === undefined || speechMs > lastEmbeddingAtMs)) {
        const samples = window.trailingSamples();
        try {
          const normalized = normalizedEmbedding(await options.embedding.embed(samples));
          if (token !== generation) {
            normalized.fill(0);
            throw new EnrollmentError("insufficient-speech", "Enrollment was reset before completion");
          }
          embeddings.push(normalized);
          lastEmbeddingAtMs = speechMs;
        } finally {
          samples.fill(0);
        }
      }
      if (embeddings.length < config.minEnrollmentEmbeddings) {
        throw new EnrollmentError(
          "insufficient-embeddings",
          `Enrollment collected ${embeddings.length} embeddings; ${config.minEnrollmentEmbeddings} required`,
        );
      }
      const length = embeddings[0]?.length ?? 0;
      const mean = new Float32Array(length);
      for (const embedding of embeddings) {
        if (embedding.length !== length) throw new EnrollmentError("invalid-embedding", "Enrollment embedding lengths differ");
        for (let i = 0; i < length; i += 1) mean[i] = (mean[i] ?? 0) + (embedding[i] ?? 0);
      }
      for (let i = 0; i < mean.length; i += 1) mean[i] = (mean[i] ?? 0) / embeddings.length;
      const centroid = normalizeVector(mean);
      let centroidNorm = 0;
      for (const value of centroid) centroidNorm += value * value;
      if (!Number.isFinite(centroidNorm) || centroidNorm === 0) {
        throw new EnrollmentError("invalid-embedding", "Enrollment produced a zero-norm centroid");
      }
      const coherence = embeddings.reduce((sum, item) => sum + cosineSimilarity(item, centroid), 0) / embeddings.length;
      if (coherence < config.minEnrollmentCoherence) {
        throw new EnrollmentError(
          "incoherent",
          `Enrollment coherence ${coherence.toFixed(3)} is below ${config.minEnrollmentCoherence}`,
        );
      }
      return { centroid: new Float32Array(centroid), embeddingCount: embeddings.length, speechMs, coherence };
    } finally {
      if (token === generation) {
        generation += 1;
        activeSamples?.fill(0);
        waiters.splice(0).forEach((waiter) => waiter.resolve());
        clearState();
      }
    }
  }
  function reset(): void {
    generation += 1;
    activeSamples?.fill(0);
    waiters.splice(0).forEach((waiter) => waiter.resolve());
    clearState();
  }
  return {
    pushPcm,
    complete,
    reset,
    snapshot: () => ({ speechMs, embeddingCount: embeddings.length, retainedSamples: window.sampleCount }),
  };
}
export interface CentroidStore {
  load(): Float32Array | undefined;
  save(centroid: Float32Array): boolean;
  clear(): boolean;
}
export interface CentroidStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface LocalStorageCentroidStoreOptions {
  readonly storage?: CentroidStorage;
  readonly key?: string;
  readonly schemaVersion?: number;
  readonly embeddingModelId?: string;
  readonly calibrationId?: string;
}
export const DEFAULT_CENTROID_STORAGE_KEY = "palancar.voice.centroid.v1";
export const DEFAULT_CENTROID_SCHEMA_VERSION = 1 as const;
export const DEFAULT_EMBEDDING_MODEL_ID = "palancar-voice-embedding-v1" as const;
export const DEFAULT_CALIBRATION_ID = "palancar-voice-calibration-v1" as const;
function defaultStorage(): CentroidStorage | undefined {
  try {
    return typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage;
  } catch {
    return undefined;
  }
}
function encode(bytes: Uint8Array): string | undefined {
  try {
    if (typeof btoa !== "function") return undefined;
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  } catch {
    return undefined;
  }
}
function decode(value: string): Float32Array | undefined {
  try {
    if (typeof atob !== "function") return undefined;
    const binary = atob(value);
    if (binary.length === 0 || binary.length % Float32Array.BYTES_PER_ELEMENT !== 0) return undefined;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const values = new Float32Array(bytes.buffer.slice(0));
    if (values.some((item) => !Number.isFinite(item))) return undefined;
    let squaredNorm = 0;
    for (const item of values) squaredNorm += item * item;
    return squaredNorm === 0 ? undefined : new Float32Array(values);
  } catch {
    return undefined;
  }
}
// The centroid is device-local biometric data: never send it to relay,
// telemetry, logs, browser sync, or any other destination.
export function createLocalStorageCentroidStore(
  options: LocalStorageCentroidStoreOptions | CentroidStorage = {},
): CentroidStore {
  const storage = "getItem" in options ? options : options.storage ?? defaultStorage();
  const key = "getItem" in options ? DEFAULT_CENTROID_STORAGE_KEY : options.key ?? DEFAULT_CENTROID_STORAGE_KEY;
  const schemaVersion = "getItem" in options ? DEFAULT_CENTROID_SCHEMA_VERSION : options.schemaVersion ?? DEFAULT_CENTROID_SCHEMA_VERSION;
  const embeddingModelId = "getItem" in options ? DEFAULT_EMBEDDING_MODEL_ID : options.embeddingModelId ?? DEFAULT_EMBEDDING_MODEL_ID;
  const calibrationId = "getItem" in options ? DEFAULT_CALIBRATION_ID : options.calibrationId ?? DEFAULT_CALIBRATION_ID;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new RangeError("schemaVersion must be a positive integer");
  }
  if (
    typeof embeddingModelId !== "string" ||
    typeof calibrationId !== "string" ||
    embeddingModelId.length === 0 ||
    calibrationId.length === 0
  ) {
    throw new RangeError("embeddingModelId and calibrationId must not be empty");
  }
  return {
    load(): Float32Array | undefined {
      try {
        if (storage === undefined) return undefined;
        const value = storage.getItem(key);
        if (value === null) return undefined;
        const record: unknown = JSON.parse(value);
        if (typeof record !== "object" || record === null) return undefined;
        const candidate = record as {
          schemaVersion?: unknown;
          embeddingModelId?: unknown;
          calibrationId?: unknown;
          centroid?: unknown;
        };
        if (
          candidate.schemaVersion !== schemaVersion ||
          candidate.embeddingModelId !== embeddingModelId ||
          candidate.calibrationId !== calibrationId ||
          typeof candidate.centroid !== "string"
        ) return undefined;
        return decode(candidate.centroid);
      } catch {
        return undefined;
      }
    },
    save(centroid: Float32Array): boolean {
      try {
        if (storage === undefined || centroid.length === 0) return false;
        let squaredNorm = 0;
        for (const value of centroid) {
          if (!Number.isFinite(value)) return false;
          squaredNorm += value * value;
        }
        if (!Number.isFinite(squaredNorm) || squaredNorm === 0) return false;
        const encoded = encode(new Uint8Array(centroid.buffer, centroid.byteOffset, centroid.byteLength));
        if (encoded === undefined) return false;
        storage.setItem(key, JSON.stringify({
          schemaVersion,
          embeddingModelId,
          calibrationId,
          centroid: encoded,
        }));
        return true;
      } catch {
        return false;
      }
    },
    clear(): boolean {
      try {
        if (storage === undefined) return false;
        storage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}
