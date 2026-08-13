import { VERSION_PATTERN } from '@palancar/contracts';
import type { GenerationErrorCategory } from './types.js';
import { isTargetLanguage } from '@palancar/language-registry';

import { GenerationError } from './errors.js';
import type {
  GenerationCorrelation,
  GenerationEvidenceRecord,
  MetadataOnlyEvidenceCollectorLike
} from './types.js';

const MACHINE_VALUE = /^[a-z][a-z0-9._:-]{0,63}$/;
const PROVIDER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEGMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const VERSION = new RegExp(VERSION_PATTERN);
const MAX_UINT32 = 4_294_967_295;

const ALLOWED_KEYS = new Set([
  'sessionId',
  'sessionEpoch',
  'utteranceId',
  'segmentId',
  'acceptedFinalRevision',
  'selectedTargetLanguage',
  'gatePolicyVersion',
  'operation',
  'status',
  'failureCategory',
  'providerId',
  'providerVersion',
  'startMonotonicMs',
  'endMonotonicMs',
  'latencyMs'
]);

const FAILURE_CATEGORIES: ReadonlySet<GenerationErrorCategory> = new Set([
  'invalid-input',
  'forged-value',
  'correlation-mismatch',
  'invalid-provider',
  'invalid-provider-result',
  'provider-failure',
  'invalid-evidence'
]);

function invalid(): never {
  throw new GenerationError('invalid-evidence');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function snapshotEvidence(input: Record<string, unknown>): Record<string, unknown> {
  let descriptors: Record<string | symbol, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new GenerationError('invalid-evidence');
  }

  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) {
        invalid();
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        invalid();
      }
    }
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    throw new GenerationError('invalid-evidence');
  }

  const copy: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
      copy[key] = descriptor.value;
    }
  }
  return copy;
}

function validateCorrelation(input: Record<string, unknown>): asserts input is Record<string, unknown> & GenerationCorrelation {
  if (
    typeof input.sessionId !== 'string' ||
    !CORRELATION_ID.test(input.sessionId) ||
    typeof input.sessionEpoch !== 'number' ||
    !Number.isSafeInteger(input.sessionEpoch) ||
    input.sessionEpoch < 1 ||
    input.sessionEpoch > MAX_UINT32 ||
    typeof input.utteranceId !== 'string' ||
    !CORRELATION_ID.test(input.utteranceId) ||
    typeof input.segmentId !== 'string' ||
    !SEGMENT_ID.test(input.segmentId) ||
    typeof input.acceptedFinalRevision !== 'number' ||
    !Number.isSafeInteger(input.acceptedFinalRevision) ||
    input.acceptedFinalRevision < 1 ||
    input.acceptedFinalRevision > 4_294_967_295 ||
    typeof input.selectedTargetLanguage !== 'string' ||
    !isTargetLanguage(input.selectedTargetLanguage) ||
    typeof input.gatePolicyVersion !== 'string' ||
    input.gatePolicyVersion.length < 5 ||
    input.gatePolicyVersion.length > 32 ||
    !VERSION.test(input.gatePolicyVersion)
  ) {
    invalid();
  }
}

export function createGenerationEvidenceRecord(input: unknown): GenerationEvidenceRecord {
  if (!isPlainObject(input)) {
    invalid();
  }
  const snapshot = snapshotEvidence(input);
  validateCorrelation(snapshot);
  if (
    (snapshot.operation !== 'complete' &&
      snapshot.operation !== 'translate' &&
      snapshot.operation !== 'suggest') ||
    (snapshot.status !== 'success' &&
      snapshot.status !== 'failure' &&
      snapshot.status !== 'cancelled') ||
    typeof snapshot.providerId !== 'string' ||
    !PROVIDER_VALUE.test(snapshot.providerId) ||
    typeof snapshot.providerVersion !== 'string' ||
    !PROVIDER_VALUE.test(snapshot.providerVersion) ||
    !isFiniteNonNegative(snapshot.startMonotonicMs) ||
    !isFiniteNonNegative(snapshot.endMonotonicMs) ||
    snapshot.endMonotonicMs < snapshot.startMonotonicMs ||
    !isFiniteNonNegative(snapshot.latencyMs) ||
    snapshot.latencyMs !== snapshot.endMonotonicMs - snapshot.startMonotonicMs
  ) {
    invalid();
  }
  if (
    snapshot.status === 'failure' &&
    (typeof snapshot.failureCategory !== 'string' ||
      !MACHINE_VALUE.test(snapshot.failureCategory) ||
      !FAILURE_CATEGORIES.has(snapshot.failureCategory as GenerationErrorCategory))
  ) {
    invalid();
  }
  if (snapshot.status === 'success' && snapshot.failureCategory !== undefined) {
    invalid();
  }
  if (snapshot.status === 'cancelled' && snapshot.failureCategory !== undefined) {
    invalid();
  }

  const copy: GenerationEvidenceRecord = {
    sessionId: snapshot.sessionId,
    sessionEpoch: snapshot.sessionEpoch,
    utteranceId: snapshot.utteranceId,
    segmentId: snapshot.segmentId,
    acceptedFinalRevision: snapshot.acceptedFinalRevision,
    selectedTargetLanguage: snapshot.selectedTargetLanguage,
    gatePolicyVersion: snapshot.gatePolicyVersion,
    operation: snapshot.operation,
    status: snapshot.status,
    ...(snapshot.failureCategory === undefined ? {} : { failureCategory: snapshot.failureCategory }),
    providerId: snapshot.providerId,
    providerVersion: snapshot.providerVersion,
    startMonotonicMs: snapshot.startMonotonicMs,
    endMonotonicMs: snapshot.endMonotonicMs,
    latencyMs: snapshot.latencyMs
  } as GenerationEvidenceRecord;
  return Object.freeze(copy);
}

export class MetadataOnlyEvidenceCollector implements MetadataOnlyEvidenceCollectorLike {
  readonly #records: GenerationEvidenceRecord[] = [];

  add(input: unknown): GenerationEvidenceRecord {
    const record = createGenerationEvidenceRecord(input);
    this.#records.push(record);
    return record;
  }

  get records(): readonly GenerationEvidenceRecord[] {
    return Object.freeze([...this.#records]);
  }

  toJsonLines(): string {
    if (this.#records.length === 0) {
      return '';
    }
    return `${this.#records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  }
}

export { MetadataOnlyEvidenceCollector as EvidenceCollector };
export { MetadataOnlyEvidenceCollector as GenerationEvidenceCollector };
