import type {
  EmbeddingRunner,
  SpeakerVerifier,
  SpeakerVerifierConfig,
  VadRunner,
  VerifierDecision,
  VerifierSnapshot,
} from "./types.js";
import { PCM_SAMPLE_RATE_HZ, PcmSlidingWindow } from "./window.js";
export const DEFAULT_SPEAKER_VERIFIER_CONFIG = Object.freeze({
  windowMs: 1_000,
  embedIntervalMs: 250,
  emaAlpha: 0.4,
  wearerEnterThreshold: 0.75,
  wearerExitThreshold: 0.65,
  minConsecutiveHits: 2,
  neutralScore: 0,
});
interface ResolvedVerifierConfig {
  readonly windowMs: number;
  readonly embedIntervalMs: number;
  readonly emaAlpha: number;
  readonly wearerEnterThreshold: number;
  readonly wearerExitThreshold: number;
  readonly minConsecutiveHits: number;
  readonly neutralScore: number;
}
export interface SpeakerVerifierOptions {
  readonly vad: VadRunner;
  readonly embedding: EmbeddingRunner;
  readonly centroid: Float32Array;
  readonly config?: SpeakerVerifierConfig;
}
function resolveConfig(config: SpeakerVerifierConfig | undefined): ResolvedVerifierConfig {
  const resolved = {
    ...DEFAULT_SPEAKER_VERIFIER_CONFIG,
    ...config,
  };
  if (!Number.isFinite(resolved.windowMs) || resolved.windowMs <= 0) {
    throw new RangeError("windowMs must be positive and finite");
  }
  if (!Number.isFinite(resolved.embedIntervalMs) || resolved.embedIntervalMs <= 0) {
    throw new RangeError("embedIntervalMs must be positive and finite");
  }
  if (!Number.isFinite(resolved.emaAlpha) || resolved.emaAlpha <= 0 || resolved.emaAlpha > 1) {
    throw new RangeError("emaAlpha must be greater than zero and at most one");
  }
  if (
    !Number.isFinite(resolved.wearerEnterThreshold) ||
    !Number.isFinite(resolved.wearerExitThreshold) ||
    resolved.wearerEnterThreshold < -1 ||
    resolved.wearerEnterThreshold > 1 ||
    resolved.wearerExitThreshold < -1 ||
    resolved.wearerExitThreshold > 1 ||
    resolved.wearerExitThreshold >= resolved.wearerEnterThreshold
  ) {
    throw new RangeError("wearer thresholds must be ordered within [-1, 1]");
  }
  if (!Number.isInteger(resolved.minConsecutiveHits) || resolved.minConsecutiveHits < 1) {
    throw new RangeError("minConsecutiveHits must be a positive integer");
  }
  if (!Number.isFinite(resolved.neutralScore) || resolved.neutralScore < -1 || resolved.neutralScore > 1) {
    throw new RangeError("neutralScore must be within [-1, 1]");
  }
  return resolved;
}
function assertUsableVector(vector: Float32Array, name: string): void {
  if (vector.length === 0) throw new RangeError(`${name} must not be empty`);
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new RangeError(`${name} must contain only finite values`);
    squaredNorm += value * value;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm === 0) {
    throw new RangeError(`${name} must have a non-zero finite norm`);
  }
}
export function normalizeVector(vector: Float32Array): Float32Array {
  const normalized = new Float32Array(vector.length);
  let squaredNorm = 0;
  for (const value of vector) squaredNorm += value * value;
  if (!Number.isFinite(squaredNorm) || squaredNorm === 0) return normalized;
  const scale = 1 / Math.sqrt(squaredNorm);
  for (let i = 0; i < vector.length; i += 1) {
    normalized[i] = (vector[i] ?? 0) * scale;
  }
  return normalized;
}
export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new RangeError("Embedding lengths must match");
  let leftSquared = 0;
  let rightSquared = 0;
  let dot = 0;
  for (let i = 0; i < left.length; i += 1) {
    const leftValue = left[i] ?? 0;
    const rightValue = right[i] ?? 0;
    leftSquared += leftValue * leftValue;
    rightSquared += rightValue * rightValue;
    dot += leftValue * rightValue;
  }
  if (!Number.isFinite(leftSquared) || !Number.isFinite(rightSquared)) return 0;
  if (leftSquared === 0 || rightSquared === 0) return 0;
  const quotient = dot / Math.sqrt(leftSquared * rightSquared);
  return Number.isFinite(quotient) ? Math.min(1, Math.max(-1, quotient)) : 0;
}
function samplesForMs(milliseconds: number): number {
  return Math.max(1, Math.round((milliseconds * PCM_SAMPLE_RATE_HZ) / 1_000));
}
const DEFAULT_PROCESS_HOP_SAMPLES = 960;
export function createSpeakerVerifier(options: SpeakerVerifierOptions): SpeakerVerifier {
  const config = resolveConfig(options.config);
  const window = new PcmSlidingWindow({ capacitySamples: samplesForMs(config.windowMs) });
  assertUsableVector(options.centroid, "centroid");
  const centroid = normalizeVector(options.centroid);
  const processHopSamples = Math.min(DEFAULT_PROCESS_HOP_SAMPLES, samplesForMs(config.embedIntervalMs));
  let audioMs = 0;
  let audioSamples = 0;
  let processedHops = 0;
  let claimedHops = 0;
  let lastEmbeddingAtMs: number | undefined;
  let embeddingsProduced = 0;
  let score = 0;
  let smoothedScore = config.neutralScore;
  let isWearer = false;
  let consecutiveHits = 0;
  let generation = 0;
  let disposed = false;
  let worker: Promise<void> | undefined;
  let activeSamples: Float32Array | undefined;
  let workerError: unknown;
  const waiters: Array<{
    readonly targetHops: number;
    readonly resolve: (value: VerifierDecision) => void;
    readonly reject: (reason?: unknown) => void;
  }> = [];
  function transitionIfReady(): boolean {
    const previous = isWearer;
    if (!isWearer) {
      if (smoothedScore >= config.wearerEnterThreshold) {
        consecutiveHits += 1;
        if (consecutiveHits >= config.minConsecutiveHits) {
          isWearer = true;
          consecutiveHits = 0;
        }
      } else {
        consecutiveHits = 0;
      }
    } else if (smoothedScore <= config.wearerExitThreshold) {
      consecutiveHits += 1;
      if (consecutiveHits >= config.minConsecutiveHits) {
        isWearer = false;
        consecutiveHits = 0;
      }
    } else {
      consecutiveHits = 0;
    }
    return previous !== isWearer;
  }
  function decision(speech: boolean, rawScore: number, changed: boolean): VerifierDecision {
    return {
      speech,
      score: rawScore,
      smoothedScore,
      isWearer,
      changed,
    };
  }
  async function processHop(samples: Float32Array, processedAudioMs: number, token: number): Promise<void> {
    if (disposed || token !== generation) return;
    const speech = await options.vad.detect(samples);
    if (disposed || token !== generation) return;
    if (!speech) {
      score = 0;
      smoothedScore += config.emaAlpha * (config.neutralScore - smoothedScore);
      latestDecision = decision(false, 0, transitionIfReady());
      return;
    }
    if (processedAudioMs * PCM_SAMPLE_RATE_HZ < window.capacitySamples * 1_000) {
      latestDecision = decision(true, score, false);
      return;
    }
    if (
      lastEmbeddingAtMs !== undefined &&
      processedAudioMs - lastEmbeddingAtMs < config.embedIntervalMs
    ) {
      latestDecision = decision(true, score, false);
      return;
    }
    const embedding = await options.embedding.embed(samples);
    if (disposed || token !== generation) return;
    score = cosineSimilarity(embedding, centroid);
    smoothedScore += config.emaAlpha * (score - smoothedScore);
    lastEmbeddingAtMs = processedAudioMs;
    embeddingsProduced += 1;
    latestDecision = decision(true, score, transitionIfReady());
  }
  let latestDecision = decision(false, 0, false);
  function settleWaiters(error?: unknown): void {
    let index = 0;
    while (index < waiters.length) {
      const waiter = waiters[index];
      if (waiter === undefined || waiter.targetHops > processedHops) {
        index += 1;
        continue;
      }
      waiters.splice(index, 1);
      if (error === undefined) waiter.resolve(latestDecision);
      else waiter.reject(error);
    }
  }
  function schedule(): void {
    if (disposed || worker !== undefined || workerError !== undefined) return;
    const availableHops = Math.floor(audioSamples / processHopSamples);
    if (claimedHops >= availableHops) return;
    claimedHops += 1;
    const processedAudioMs = (claimedHops * processHopSamples * 1_000) / PCM_SAMPLE_RATE_HZ;
    const token = generation;
    const samples = window.trailingSamples();
    activeSamples = samples;
    const task = processHop(samples, processedAudioMs, token);
    worker = task;
    void task.then(
      () => {
        if (activeSamples === samples) activeSamples = undefined;
        if (worker === task) worker = undefined;
        samples.fill(0);
        if (token === generation && !disposed) {
          processedHops += 1;
          settleWaiters();
        }
        schedule();
      },
      (error: unknown) => {
        if (activeSamples === samples) activeSamples = undefined;
        if (worker === task) worker = undefined;
        samples.fill(0);
        if (token === generation && !disposed) {
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
  function pushPcm(bytes: Uint8Array): Promise<VerifierDecision> {
    if (disposed) return Promise.resolve(decision(false, 0, false));
    const addedSamples = window.push(bytes);
    audioSamples += addedSamples;
    audioMs = (audioSamples * 1_000) / PCM_SAMPLE_RATE_HZ;
    const targetHops = Math.floor(audioSamples / processHopSamples);
    if (targetHops <= processedHops) return Promise.resolve(latestDecision);
    if (workerError !== undefined) return Promise.reject(workerError);
    const result = new Promise<VerifierDecision>((resolve, reject) => {
      waiters.push({ targetHops, resolve, reject });
    });
    schedule();
    return result;
  }
  const verifier: SpeakerVerifier = {
    pushPcm,
    reset(): void {
      if (disposed) return;
      generation += 1;
      activeSamples?.fill(0);
      waiters.splice(0).forEach((waiter) => waiter.resolve(decision(false, 0, false)));
      window.clear();
      audioMs = 0;
      audioSamples = 0;
      processedHops = 0;
      claimedHops = 0;
      lastEmbeddingAtMs = undefined;
      embeddingsProduced = 0;
      score = 0;
      smoothedScore = config.neutralScore;
      isWearer = false;
      consecutiveHits = 0;
      workerError = undefined;
      latestDecision = decision(false, 0, false);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      activeSamples?.fill(0);
      waiters.splice(0).forEach((waiter) => waiter.resolve(decision(false, 0, false)));
      window.clear();
      centroid.fill(0);
      audioMs = 0;
      audioSamples = 0;
      processedHops = 0;
      claimedHops = 0;
      lastEmbeddingAtMs = undefined;
      embeddingsProduced = 0;
      score = 0;
      smoothedScore = config.neutralScore;
      isWearer = false;
      consecutiveHits = 0;
      latestDecision = decision(false, 0, false);
    },
    snapshot(): VerifierSnapshot {
      return {
        audioMs,
        retainedSamples: window.sampleCount,
        embeddingsProduced,
        lastEmbeddingAtMs,
        score,
        smoothedScore,
        isWearer,
        consecutiveHits,
      };
    },
  };
  return verifier;
}
