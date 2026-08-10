import { isUtcTimestamp } from '@palancar/contracts';

import { EvidenceValidationError } from './errors.js';

export interface AggregateEvidenceScores {
  readonly accuracy?: number;
  readonly wordErrorRate?: number;
  readonly gateAcceptanceRate?: number;
  readonly gateRejectionRate?: number;
  readonly boundaryStability?: number;
  readonly confidenceLowerBound?: number;
  readonly confidenceUpperBound?: number;
}

export interface MetadataEvidenceRecord {
  readonly event: string;
  readonly timestamp: string;
  readonly eventId?: string;
  readonly sessionId?: string;
  readonly utteranceId?: string;
  readonly segmentId?: string;
  readonly correlationId?: string;
  readonly operationId?: string;
  readonly requestId?: string;
  readonly status?: string;
  readonly configurationVersion?: string;
  readonly modelVersion?: string;
  readonly providerVersion?: string;
  readonly sampleCount?: number;
  readonly byteCount?: number;
  readonly tokenCount?: number;
  readonly latencyMs?: number;
  readonly scores?: Readonly<AggregateEvidenceScores>;
}

const REQUIRED_FIELDS = Object.freeze(['event', 'timestamp'] as const);
const STRING_FIELDS = new Set([
  'event',
  'timestamp',
  'eventId',
  'sessionId',
  'utteranceId',
  'segmentId',
  'correlationId',
  'operationId',
  'requestId',
  'status',
  'configurationVersion',
  'modelVersion',
  'providerVersion'
]);
const COUNT_FIELDS = new Set(['sampleCount', 'byteCount', 'tokenCount']);
const TOP_LEVEL_FIELDS = new Set([
  ...STRING_FIELDS,
  ...COUNT_FIELDS,
  'latencyMs',
  'scores'
]);
const SCORE_FIELDS = new Set([
  'accuracy',
  'wordErrorRate',
  'gateAcceptanceRate',
  'gateRejectionRate',
  'boundaryStability',
  'confidenceLowerBound',
  'confidenceUpperBound'
]);
const IDENTIFIER_FIELDS = new Set([
  'eventId',
  'sessionId',
  'utteranceId',
  'segmentId',
  'correlationId',
  'operationId',
  'requestId'
]);
const VERSION_FIELDS = new Set([
  'configurationVersion',
  'modelVersion',
  'providerVersion'
]);
const MACHINE_VALUE_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

export const MetadataEvidenceRecordSchema = Object.freeze({
  additionalProperties: false,
  required: REQUIRED_FIELDS,
  properties: Object.freeze([...TOP_LEVEL_FIELDS].sort()),
  scoreProperties: Object.freeze([...SCORE_FIELDS].sort())
});

function validationFailure(
  reason: ConstructorParameters<typeof EvidenceValidationError>[0],
  message: string
): never {
  throw new EvidenceValidationError(reason, message);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBlobOrFileLike(value: object): boolean {
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return true;
  }
  const candidate = value as {
    readonly arrayBuffer?: unknown;
    readonly stream?: unknown;
    readonly size?: unknown;
    readonly type?: unknown;
  };
  return (
    typeof candidate.arrayBuffer === 'function' &&
    typeof candidate.stream === 'function' &&
    typeof candidate.size === 'number' &&
    typeof candidate.type === 'string'
  );
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

function isForbiddenKey(key: string): boolean {
  if (key === 'tokenCount') {
    return false;
  }
  const normalized = normalizedKey(key);
  return (
    normalized.includes('pcm') ||
    normalized.includes('audio') ||
    normalized.includes('transcript') ||
    normalized.includes('translation') ||
    normalized.includes('suggestion') ||
    normalized.includes('prompt') ||
    normalized.includes('response') ||
    normalized.includes('providerbody') ||
    normalized.includes('credential') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.endsWith('key') ||
    normalized.endsWith('keys')
  );
}

function privacyScan(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    isBlobOrFileLike(value)
  ) {
    validationFailure('binary-value', 'Evidence cannot contain binary values');
  }
  if (seen.has(value)) {
    validationFailure('cyclic-value', 'Evidence cannot contain cyclic values');
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenKey(key)) {
      validationFailure('forbidden-key', `Forbidden evidence field: ${key}`);
    }
    privacyScan(child, seen);
  }
  seen.delete(value);
}

function assertFiniteNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    validationFailure('invalid-value', `${field} must be a finite non-negative number`);
  }
}

function assertMachineValue(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !MACHINE_VALUE_PATTERN.test(value)) {
    validationFailure('invalid-value', `${field} must be a bounded machine value`);
  }
}

function validateScores(value: unknown): AggregateEvidenceScores {
  if (typeof value !== 'object' || value === null || !isPlainObject(value)) {
    validationFailure('invalid-value', 'scores must be a plain object');
  }
  const copy: Record<string, number> = {};
  for (const [key, score] of Object.entries(value)) {
    if (!SCORE_FIELDS.has(key)) {
      validationFailure('unknown-field', `Unknown evidence score field: ${key}`);
    }
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      validationFailure('invalid-value', `${key} must be a finite score from zero to one`);
    }
    copy[key] = score;
  }
  return Object.freeze(copy);
}

export function createMetadataEvidenceRecord(input: unknown): MetadataEvidenceRecord {
  privacyScan(input, new Set());
  if (typeof input !== 'object' || input === null || !isPlainObject(input)) {
    validationFailure('record', 'Evidence record must be a plain object');
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in input)) {
      validationFailure('invalid-value', `Evidence record requires ${field}`);
    }
  }

  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!TOP_LEVEL_FIELDS.has(key)) {
      validationFailure('unknown-field', `Unknown evidence field: ${key}`);
    }
    if (key === 'timestamp') {
      if (!isUtcTimestamp(value)) {
        validationFailure('invalid-value', 'timestamp must be a valid UTC timestamp');
      }
      copy[key] = value;
    } else if (key === 'event' || key === 'status') {
      assertMachineValue(value, key);
      copy[key] = value;
    } else if (IDENTIFIER_FIELDS.has(key)) {
      if (typeof value !== 'string' || !OPAQUE_ID_PATTERN.test(value)) {
        validationFailure('invalid-value', `${key} must be a bounded opaque identifier`);
      }
      copy[key] = value;
    } else if (VERSION_FIELDS.has(key)) {
      if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
        validationFailure('invalid-value', `${key} must be a bounded version`);
      }
      copy[key] = value;
    } else if (COUNT_FIELDS.has(key)) {
      assertFiniteNonNegative(value, key);
      if (!Number.isSafeInteger(value)) {
        validationFailure('invalid-value', `${key} must be a safe integer`);
      }
      copy[key] = value;
    } else if (key === 'latencyMs') {
      assertFiniteNonNegative(value, key);
      copy[key] = value;
    } else if (key === 'scores') {
      copy[key] = validateScores(value);
    }
  }
  return Object.freeze(copy) as unknown as MetadataEvidenceRecord;
}

export function isMetadataEvidenceRecord(
  input: unknown
): input is MetadataEvidenceRecord {
  try {
    createMetadataEvidenceRecord(input);
    return true;
  } catch (error) {
    if (error instanceof EvidenceValidationError) {
      return false;
    }
    throw error;
  }
}

export class MetadataEvidenceCollector {
  readonly #records: MetadataEvidenceRecord[] = [];

  add(input: unknown): MetadataEvidenceRecord {
    const record = createMetadataEvidenceRecord(input);
    this.#records.push(record);
    return record;
  }

  get records(): readonly MetadataEvidenceRecord[] {
    return Object.freeze([...this.#records]);
  }

  toJsonLines(): string {
    if (this.#records.length === 0) {
      return '';
    }
    return `${this.#records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  }
}

export function parseMetadataEvidenceJsonLines(
  jsonLines: string
): readonly MetadataEvidenceRecord[] {
  if (typeof jsonLines !== 'string') {
    throw new TypeError('JSONL evidence must be a string');
  }
  const records = jsonLines
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => createMetadataEvidenceRecord(JSON.parse(line) as unknown));
  return Object.freeze(records);
}
