import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { types as utilityTypes } from 'node:util';

import {
  createMetadataEvidenceRecord,
  type MetadataEvidenceRecord
} from '@palancar/transcription';

import { spikeFailure } from './errors.js';

export const MAX_EVIDENCE_LINE_BYTES = 4_096;
export const MAX_EVIDENCE_RECORDS = 250_000;
export const MAX_EVIDENCE_FILE_BYTES = 256 * 1024 * 1024;

export const SPIKE_EVIDENCE_EVENTS = Object.freeze([
  'spike.run.started',
  'spike.trial.started',
  'spike.session.started',
  'spike.audio.appended',
  'spike.vad.started',
  'spike.vad.stopped',
  'spike.transcript.partial',
  'spike.transcript.final',
  'spike.session.failed',
  'spike.session.timed-out',
  'spike.session.cancelled',
  'spike.trial.completed',
  'spike.wer.substitutions',
  'spike.wer.deletions',
  'spike.wer.insertions',
  'spike.wer.numerator',
  'spike.wer.denominator',
  'spike.aggregate.completed'
] as const);

export type SpikeEvidenceEvent = typeof SPIKE_EVIDENCE_EVENTS[number];

const LANGUAGES = new Set(['es', 'tr']);
const TERMINAL_STATUS: Readonly<Record<string, string>> = Object.freeze({
  'spike.session.failed': 'failed',
  'spike.session.timed-out': 'timed-out',
  'spike.session.cancelled': 'cancelled'
});
const WER_EVENTS = new Set([
  'spike.wer.substitutions',
  'spike.wer.deletions',
  'spike.wer.insertions',
  'spike.wer.numerator',
  'spike.wer.denominator'
]);
const AGGREGATE_STATUSES = new Set([
  'es.p50', 'es.p95', 'es.expected-accept', 'es.expected-reject',
  'es.false-accept', 'es.false-reject',
  'tr.p50', 'tr.p95', 'tr.expected-accept', 'tr.expected-reject',
  'tr.false-accept', 'tr.false-reject'
]);

function normalizePlainData(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== 'object' || value === null || Array.isArray(value) ||
      utilityTypes.isProxy(value)
    ) {
      spikeFailure('invalid-evidence');
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      spikeFailure('invalid-evidence');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) spikeFailure('invalid-evidence');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
        descriptor.get !== undefined || descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        spikeFailure('invalid-evidence');
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    spikeFailure('invalid-evidence');
  }
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function normalizeExactScores(value: unknown, expected: readonly string[]):
Readonly<Record<string, unknown>> | undefined {
  try {
    const snapshot = normalizePlainData(value);
    return hasExactKeys(snapshot, expected) ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

function validateClosedRecord(input: unknown): Readonly<Record<string, unknown>> {
  const snapshot = normalizePlainData(input);
  let normalized = snapshot;
  const event = snapshot.event;
  if (typeof event !== 'string') spikeFailure('invalid-evidence');
  const languageStatus = LANGUAGES.has(snapshot.status as string);
  let valid = false;
  if (event === 'spike.run.started') {
    valid = hasExactKeys(snapshot, ['event', 'timestamp', 'status']) &&
      snapshot.status === 'started';
  } else if (
    event === 'spike.trial.started' || event === 'spike.session.started' ||
    event === 'spike.vad.started'
  ) {
    valid = hasExactKeys(snapshot, ['event', 'timestamp', 'status']) && languageStatus;
  } else if (event === 'spike.audio.appended') {
    valid = hasExactKeys(snapshot, [
      'event', 'timestamp', 'status', 'byteCount', 'sampleCount'
    ]) &&
      languageStatus;
  } else if (event === 'spike.vad.stopped') {
    valid = hasExactKeys(snapshot, ['event', 'timestamp', 'status', 'sampleCount']) &&
      languageStatus;
  } else if (event === 'spike.transcript.partial' || event === 'spike.transcript.final') {
    valid = hasExactKeys(snapshot, [
      'event', 'timestamp', 'status', 'tokenCount', 'sampleCount'
    ]) &&
      languageStatus;
  } else if (Object.hasOwn(TERMINAL_STATUS, event)) {
    valid = hasExactKeys(snapshot, ['event', 'timestamp', 'status']) &&
      snapshot.status === TERMINAL_STATUS[event];
  } else if (event === 'spike.trial.completed') {
    const acceptanceScores = normalizeExactScores(snapshot.scores, [
      'wordErrorRate', 'gateAcceptanceRate'
    ]);
    const rejectionScores = acceptanceScores === undefined
      ? normalizeExactScores(snapshot.scores, ['wordErrorRate', 'gateRejectionRate'])
      : undefined;
    valid = hasExactKeys(snapshot, [
      'event', 'timestamp', 'status', 'latencyMs', 'tokenCount', 'scores'
    ]) && languageStatus &&
      (acceptanceScores !== undefined || rejectionScores !== undefined);
    if (valid) normalized = Object.freeze({
      ...snapshot,
      scores: acceptanceScores ?? rejectionScores
    });
  } else if (WER_EVENTS.has(event)) {
    valid = hasExactKeys(snapshot, ['event', 'timestamp', 'status', 'tokenCount']) &&
      languageStatus;
  } else if (event === 'spike.aggregate.completed') {
    const scores = normalizeExactScores(snapshot.scores, [
      'accuracy', 'wordErrorRate', 'gateAcceptanceRate', 'gateRejectionRate'
    ]);
    valid = hasExactKeys(snapshot, [
      'event', 'timestamp', 'status', 'sampleCount', 'latencyMs', 'scores'
    ]) && AGGREGATE_STATUSES.has(snapshot.status as string) && scores !== undefined;
    if (valid) normalized = Object.freeze({ ...snapshot, scores });
  }
  if (!valid) spikeFailure('invalid-evidence');
  return normalized;
}

export function createSpikeEvidenceRecord(input: unknown): MetadataEvidenceRecord {
  const closed = validateClosedRecord(input);
  try {
    return createMetadataEvidenceRecord(closed);
  } catch {
    spikeFailure('invalid-evidence');
  }
}

export function serializeSpikeEvidenceRecord(input: unknown): string {
  const snapshot = createSpikeEvidenceRecord(input);
  try {
    return `${JSON.stringify(snapshot)}\n`;
  } catch {
    spikeFailure('invalid-evidence');
  }
}

export interface MetadataEvidenceSink {
  add(input: unknown): MetadataEvidenceRecord;
}

export interface MetadataEvidenceWriterOptions {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
  readonly maxLineBytes?: number;
  /** Test seam only; production uses a cryptographically unpredictable UUID. */
  readonly temporaryIdGenerator?: () => string;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    spikeFailure('invalid-input');
  }
  return selected;
}

function validTemporaryId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export class MetadataEvidenceJsonlWriter implements MetadataEvidenceSink {
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  readonly #maxLineBytes: number;
  readonly #temporaryIdGenerator: () => string;
  readonly #records: MetadataEvidenceRecord[] = [];
  #byteCount = 0;
  #written = false;

  constructor(options: MetadataEvidenceWriterOptions = {}) {
    this.#maxRecords = boundedInteger(
      options.maxRecords,
      MAX_EVIDENCE_RECORDS,
      MAX_EVIDENCE_RECORDS
    );
    this.#maxBytes = boundedInteger(
      options.maxBytes,
      MAX_EVIDENCE_FILE_BYTES,
      MAX_EVIDENCE_FILE_BYTES
    );
    this.#maxLineBytes = boundedInteger(
      options.maxLineBytes,
      MAX_EVIDENCE_LINE_BYTES,
      MAX_EVIDENCE_LINE_BYTES
    );
    if (options.temporaryIdGenerator !== undefined &&
      typeof options.temporaryIdGenerator !== 'function') {
      spikeFailure('invalid-input');
    }
    this.#temporaryIdGenerator = options.temporaryIdGenerator ?? randomUUID;
  }

  add(input: unknown): MetadataEvidenceRecord {
    if (this.#written) spikeFailure('evidence-write');
    const record = createSpikeEvidenceRecord(input);
    const line = serializeSpikeEvidenceRecord(record);
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (
      lineBytes > this.#maxLineBytes ||
      this.#records.length >= this.#maxRecords ||
      this.#byteCount + lineBytes > this.#maxBytes
    ) {
      spikeFailure('evidence-limit');
    }
    this.#records.push(record);
    this.#byteCount += lineBytes;
    return record;
  }

  get records(): readonly MetadataEvidenceRecord[] {
    return Object.freeze([...this.#records]);
  }

  get byteCount(): number {
    return this.#byteCount;
  }

  toJsonLines(): string {
    return this.#records.map((record) => serializeSpikeEvidenceRecord(record)).join('');
  }

  async writeAtomic(filePath: string): Promise<void> {
    if (this.#written || typeof filePath !== 'string' || filePath.length === 0) {
      spikeFailure('evidence-write');
    }
    this.#written = true;
    let temporaryPath: string | undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let ownsTemporary = false;
    try {
      const temporaryId = this.#temporaryIdGenerator();
      if (!validTemporaryId(temporaryId)) spikeFailure('evidence-write');
      temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${temporaryId}.pending`);
      handle = await open(temporaryPath, 'wx', 0o600);
      ownsTemporary = true;
      await handle.writeFile(this.toJsonLines(), { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, filePath);
      ownsTemporary = false;
    } catch {
      try {
        await handle?.close();
      } catch {
        // The fixed write failure below is authoritative.
      }
      if (ownsTemporary && temporaryPath !== undefined) {
        try {
          await unlink(temporaryPath);
        } catch {
          // Cleanup is best effort and only targets the file this writer opened.
        }
      }
      spikeFailure('evidence-write');
    }
  }
}

export function assertSpikeEvidenceRecords(
  records: readonly unknown[]
): readonly MetadataEvidenceRecord[] {
  if (!Array.isArray(records) || records.length > MAX_EVIDENCE_RECORDS) {
    spikeFailure('invalid-evidence');
  }
  let bytes = 0;
  const validated: MetadataEvidenceRecord[] = [];
  for (const input of records) {
    const record = createSpikeEvidenceRecord(input);
    const lineBytes = Buffer.byteLength(serializeSpikeEvidenceRecord(record), 'utf8');
    bytes += lineBytes;
    if (lineBytes > MAX_EVIDENCE_LINE_BYTES || bytes > MAX_EVIDENCE_FILE_BYTES) {
      spikeFailure('evidence-limit');
    }
    validated.push(record);
  }
  return Object.freeze(validated);
}
