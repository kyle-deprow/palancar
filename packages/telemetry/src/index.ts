const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NESTING = 32;
const MAX_GRAPH_OBJECTS = 2_048;
const MAX_GRAPH_PROPERTIES = 16_384;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

/** Canonical low-cardinality metric and event names. */
export const TELEMETRY_METRIC_NAMES = Object.freeze({
  SESSION_START: 'session.start',
  SESSION_REJECT: 'session.reject',
  SESSION_END: 'session.end',
  UTTERANCE_START: 'utterance.start',
  UTTERANCE_ABORT: 'utterance.abort',
  UTTERANCE_COMPLETE: 'utterance.complete',
  AUDIO_ACCEPTED_SAMPLES: 'audio.samples.accepted',
  AUDIO_DUPLICATE_SAMPLES: 'audio.samples.duplicate',
  AUDIO_REJECTED_SAMPLES: 'audio.samples.rejected',
  TRANSPORT_RECONNECT: 'transport.reconnect',
  TRANSCRIPTION_FIRST_PARTIAL_LATENCY: 'transcription.first_partial_latency',
  TRANSCRIPTION_FINAL_LATENCY: 'transcription.final_latency',
  LANGUAGE_DECISION: 'language.decision',
  TRANSLATION_LATENCY: 'translation.latency',
  TRANSLATION_RESULT: 'translation.result',
  SUGGESTION_LATENCY: 'suggestion.latency',
  SUGGESTION_RESULT: 'suggestion.result',
  PROVIDER_FAILURE: 'provider.failure',
  STATE_STORE_FAILURE: 'state_store.failure'
} as const);

/** Short aliases for callers that use metric-oriented names. */
export const METRIC_NAMES = TELEMETRY_METRIC_NAMES;
export const SESSION_START = TELEMETRY_METRIC_NAMES.SESSION_START;
export const SESSION_REJECT = TELEMETRY_METRIC_NAMES.SESSION_REJECT;
export const SESSION_END = TELEMETRY_METRIC_NAMES.SESSION_END;
export const UTTERANCE_START = TELEMETRY_METRIC_NAMES.UTTERANCE_START;
export const UTTERANCE_ABORT = TELEMETRY_METRIC_NAMES.UTTERANCE_ABORT;
export const UTTERANCE_COMPLETE = TELEMETRY_METRIC_NAMES.UTTERANCE_COMPLETE;
export const AUDIO_ACCEPTED_SAMPLES = TELEMETRY_METRIC_NAMES.AUDIO_ACCEPTED_SAMPLES;
export const AUDIO_DUPLICATE_SAMPLES = TELEMETRY_METRIC_NAMES.AUDIO_DUPLICATE_SAMPLES;
export const AUDIO_REJECTED_SAMPLES = TELEMETRY_METRIC_NAMES.AUDIO_REJECTED_SAMPLES;
export const TRANSPORT_RECONNECT = TELEMETRY_METRIC_NAMES.TRANSPORT_RECONNECT;
export const TRANSCRIPTION_FIRST_PARTIAL_LATENCY =
  TELEMETRY_METRIC_NAMES.TRANSCRIPTION_FIRST_PARTIAL_LATENCY;
export const TRANSCRIPTION_FINAL_LATENCY = TELEMETRY_METRIC_NAMES.TRANSCRIPTION_FINAL_LATENCY;
export const LANGUAGE_DECISION = TELEMETRY_METRIC_NAMES.LANGUAGE_DECISION;
export const TRANSLATION_LATENCY = TELEMETRY_METRIC_NAMES.TRANSLATION_LATENCY;
export const TRANSLATION_RESULT = TELEMETRY_METRIC_NAMES.TRANSLATION_RESULT;
export const SUGGESTION_LATENCY = TELEMETRY_METRIC_NAMES.SUGGESTION_LATENCY;
export const SUGGESTION_RESULT = TELEMETRY_METRIC_NAMES.SUGGESTION_RESULT;
export const PROVIDER_FAILURE = TELEMETRY_METRIC_NAMES.PROVIDER_FAILURE;
export const STATE_STORE_FAILURE = TELEMETRY_METRIC_NAMES.STATE_STORE_FAILURE;

export type TelemetryMetricName =
  (typeof TELEMETRY_METRIC_NAMES)[keyof typeof TELEMETRY_METRIC_NAMES];
export type MetricName = TelemetryMetricName;

export const TARGET_LANGUAGES = Object.freeze({
  ES: 'es',
  TR: 'tr'
} as const);
export type TelemetryTargetLanguage = (typeof TARGET_LANGUAGES)[keyof typeof TARGET_LANGUAGES];
export type TargetLanguage = TelemetryTargetLanguage;

export const GATE_DECISIONS = Object.freeze({
  PROVISIONAL: 'provisional',
  TARGET: 'target',
  MIXED: 'mixed',
  ENGLISH: 'english',
  SUPPORTED_UNSELECTED: 'supported_unselected',
  UNSUPPORTED: 'unsupported',
  UNCERTAIN: 'uncertain'
} as const);
export type TelemetryGateDecision = (typeof GATE_DECISIONS)[keyof typeof GATE_DECISIONS];
export type GateDecision = TelemetryGateDecision;

export const TELEMETRY_OPERATIONS = Object.freeze({
  SESSION: 'session',
  UTTERANCE: 'utterance',
  AUDIO: 'audio',
  TRANSPORT: 'transport',
  TRANSCRIPTION: 'transcription',
  LANGUAGE: 'language',
  TRANSLATION: 'translation',
  SUGGESTION: 'suggestion',
  PROVIDER: 'provider',
  STATE_STORE: 'state_store'
} as const);
export type TelemetryOperation =
  (typeof TELEMETRY_OPERATIONS)[keyof typeof TELEMETRY_OPERATIONS];
export type Operation = TelemetryOperation;

export const TELEMETRY_OUTCOMES = Object.freeze({
  ACCEPTED: 'accepted',
  DUPLICATE: 'duplicate',
  REJECTED: 'rejected',
  COMPLETED: 'completed',
  ABORTED: 'aborted',
  RECONNECTED: 'reconnected',
  SUCCESS: 'success',
  FAILURE: 'failure'
} as const);
export type TelemetryOutcome = (typeof TELEMETRY_OUTCOMES)[keyof typeof TELEMETRY_OUTCOMES];
export type Outcome = TelemetryOutcome;

export const DEPLOYMENT_SLOTS = Object.freeze({
  DEV: 'dev',
  STAGING: 'staging',
  PRODUCTION: 'production'
} as const);
export type DeploymentSlot = (typeof DEPLOYMENT_SLOTS)[keyof typeof DEPLOYMENT_SLOTS];

export const RECONNECT_REASONS = Object.freeze({
  NETWORK: 'network',
  SERVER: 'server',
  HEARTBEAT: 'heartbeat',
  ABNORMAL_EXIT: 'abnormal_exit',
  SESSION_EXPIRED: 'session_expired',
  UNKNOWN: 'unknown'
} as const);
export type ReconnectReason = (typeof RECONNECT_REASONS)[keyof typeof RECONNECT_REASONS];

export const ERROR_CATEGORIES = Object.freeze({
  UNKNOWN: 'unknown',
  PROVIDER: 'provider',
  STATE_STORE: 'state_store',
  TRANSPORT: 'transport',
  VALIDATION: 'validation',
  CONFIGURATION: 'configuration',
  TIMEOUT: 'timeout',
  AUTHORIZATION: 'authorization',
  STORAGE: 'storage',
  LANGUAGE: 'language'
} as const);
export type TelemetryErrorCategory =
  (typeof ERROR_CATEGORIES)[keyof typeof ERROR_CATEGORIES];
export type ErrorCategory = TelemetryErrorCategory;

export const TELEMETRY_PROTOCOL_VERSION = 1 as const;
export type TelemetryProtocolVersion = typeof TELEMETRY_PROTOCOL_VERSION;

export interface TelemetryRecordInput {
  readonly name: TelemetryMetricName;
  readonly timestamp: string;
  readonly protocolVersion?: TelemetryProtocolVersion;
  readonly durationMs?: number;
  readonly sampleCount?: number;
  readonly count?: number;
  readonly targetLanguage?: TelemetryTargetLanguage;
  readonly gateDecision?: TelemetryGateDecision;
  readonly operation?: TelemetryOperation;
  readonly outcome?: TelemetryOutcome;
  readonly providerId?: string;
  readonly providerVersion?: string;
  readonly deploymentSlot?: DeploymentSlot;
  readonly reconnectReason?: ReconnectReason;
  readonly correlationId?: string;
  readonly sessionId?: string;
  readonly sessionIdHash?: string;
  readonly utteranceId?: string;
  readonly utteranceIdHash?: string;
  readonly installationId?: string;
  readonly installationIdHash?: string;
  readonly requestId?: string;
  readonly requestIdHash?: string;
  readonly traceId?: string;
  readonly traceIdHash?: string;
  readonly spanId?: string;
  readonly spanIdHash?: string;
  readonly errorCategory?: TelemetryErrorCategory;
  readonly errorId?: string;
}

export interface SanitizedTelemetryRecord extends Readonly<TelemetryRecordInput> {
  readonly name: TelemetryMetricName;
  readonly timestamp: string;
}

export type TelemetryValidationReason =
  | 'input-shape'
  | 'unsafe-key'
  | 'accessor'
  | 'cycle'
  | 'nesting'
  | 'invalid-field'
  | 'invalid-timestamp'
  | 'invalid-number'
  | 'invalid-hash'
  | 'invalid-token'
  | 'invalid-error'
  | 'work-budget'
  | 'record-not-sanitized'
  | 'invalid-capacity';

/** Public validation failures intentionally contain no caller-provided values. */
export class TelemetryValidationError extends TypeError {
  readonly reason!: TelemetryValidationReason;

  constructor(reason: TelemetryValidationReason) {
    super('Invalid telemetry input');
    Object.defineProperty(this, 'name', {
      configurable: false,
      enumerable: false,
      value: 'TelemetryValidationError',
      writable: false
    });
    Object.defineProperty(this, 'reason', {
      configurable: false,
      enumerable: true,
      value: reason,
      writable: false
    });
  }
}

const FORBIDDEN_KEY_PARTS = Object.freeze([
  'text',
  'transcript',
  'translation',
  'suggestion',
  'audio',
  'pcm',
  'prompt',
  'content',
  'authorization',
  'cookie',
  'ticket',
  'token',
  'secret',
  'credential',
  'pairing',
  'code',
  'url',
  'uri',
  'query',
  'header',
  'body',
  'message',
  'stack',
  'cause'
] as const);

const CORRELATION_FIELDS = new Set<string>([
  'correlationId',
  'sessionId',
  'sessionIdHash',
  'utteranceId',
  'utteranceIdHash',
  'installationId',
  'installationIdHash',
  'requestId',
  'requestIdHash',
  'traceId',
  'traceIdHash',
  'spanId',
  'spanIdHash'
]);

const OUTPUT_KEYS = new Set<string>([
  'name',
  'timestamp',
  'protocolVersion',
  'durationMs',
  'sampleCount',
  'count',
  'targetLanguage',
  'gateDecision',
  'operation',
  'outcome',
  'providerId',
  'providerVersion',
  'deploymentSlot',
  'reconnectReason',
  'errorCategory',
  'errorId',
  ...CORRELATION_FIELDS
]);

function fail(reason: TelemetryValidationReason): never {
  throw new TelemetryValidationError(reason);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function safeIsArray(value: object): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function reflect<T>(operation: () => T, reason: TelemetryValidationReason = 'input-shape'): T {
  try {
    return operation();
  } catch {
    fail(reason);
  }
}

function defineDataProperty(
  target: object,
  key: string,
  value: unknown,
  enumerable = true,
  writable = true,
  configurable = true
): void {
  reflect(() => {
    Object.defineProperty(target, key, {
      configurable,
      enumerable,
      value,
      writable
    });
  });
}

function freezeOutput<T extends object>(value: T): Readonly<T> {
  return reflect(() => Object.freeze(value)) as Readonly<T>;
}

function createNullPrototypeArray<T>(): T[] {
  const array: T[] = [];
  reflect(() => Object.setPrototypeOf(array, null));
  return array;
}

function hasForbiddenKeyPart(key: string): boolean {
  const normalized = key.toLowerCase();
  return FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part));
}

function ownDescriptors(
  value: object,
  remainingPropertyBudget = MAX_GRAPH_PROPERTIES
): ReadonlyMap<string, PropertyDescriptor> {
  if (reflect(() => Object.getOwnPropertySymbols(value)).length > 0) {
    fail('input-shape');
  }

  const descriptors = new Map<string, PropertyDescriptor>();
  const names = reflect(() => Object.getOwnPropertyNames(value));
  if (names.length > remainingPropertyBudget) {
    fail('work-budget');
  }

  for (const key of names) {
    if (hasForbiddenKeyPart(key)) {
      fail('unsafe-key');
    }

    const descriptor = reflect(() => Object.getOwnPropertyDescriptor(value, key));
    if (descriptor === undefined) {
      fail('input-shape');
    }
    if ('get' in descriptor || 'set' in descriptor) {
      fail('accessor');
    }
    descriptors.set(key, descriptor);
  }
  return descriptors;
}

interface GraphInspectionState {
  readonly ancestors: Set<object>;
  readonly visited: Set<object>;
  objectCount: number;
  propertyCount: number;
}

/**
 * Inspects the complete input graph without reading a property through the
 * object itself. Data descriptor values are safe to read; accessors are not.
 */
function inspectInputGraph(
  value: unknown,
  state: GraphInspectionState,
  depth: number
): ReadonlyMap<string, PropertyDescriptor> | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return;
  }
  if (typeof value === 'undefined') {
    return;
  }
  if (typeof value !== 'object') {
    fail('input-shape');
  }
  if (safeIsArray(value) || !isPlainObject(value)) {
    fail('input-shape');
  }
  if (depth >= MAX_NESTING) {
    fail('nesting');
  }
  if (state.ancestors.has(value)) {
    fail('cycle');
  }
  if (state.visited.has(value)) {
    return;
  }
  if (state.objectCount >= MAX_GRAPH_OBJECTS) {
    fail('work-budget');
  }

  state.objectCount += 1;
  state.visited.add(value);
  state.ancestors.add(value);
  const descriptors = ownDescriptors(value, MAX_GRAPH_PROPERTIES - state.propertyCount);
  for (const descriptor of descriptors.values()) {
    state.propertyCount += 1;
    if (state.propertyCount > MAX_GRAPH_PROPERTIES) {
      fail('work-budget');
    }
    inspectInputGraph(descriptor.value, state, depth + 1);
  }
  state.ancestors.delete(value);
  return descriptors;
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SAFE_INTEGER
  );
}

function isAllowedValue<T extends string>(value: unknown, values: ReadonlySet<T>): value is T {
  return typeof value === 'string' && values.has(value as T);
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function isProviderToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function isCorrelationHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value) && !UUID_PATTERN.test(value);
}

function isErrorId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    TOKEN_PATTERN.test(value) &&
    !UUID_PATTERN.test(value) &&
    !value.toLowerCase().includes('sha256:')
  );
}

function valuesFor<T extends string>(values: Readonly<Record<string, T>>): ReadonlySet<T> {
  return new Set(Object.values(values));
}

const METRIC_NAME_VALUES = valuesFor(TELEMETRY_METRIC_NAMES);
const TARGET_LANGUAGE_VALUES = valuesFor(TARGET_LANGUAGES);
const GATE_DECISION_VALUES = valuesFor(GATE_DECISIONS);
const OPERATION_VALUES = valuesFor(TELEMETRY_OPERATIONS);
const OUTCOME_VALUES = valuesFor(TELEMETRY_OUTCOMES);
const DEPLOYMENT_SLOT_VALUES = valuesFor(DEPLOYMENT_SLOTS);
const RECONNECT_REASON_VALUES = valuesFor(RECONNECT_REASONS);
const ERROR_CATEGORY_VALUES = valuesFor(ERROR_CATEGORIES);

function descriptorValue(
  descriptors: ReadonlyMap<string, PropertyDescriptor>,
  key: string
): unknown {
  return descriptors.get(key)?.value;
}

function hasKey(descriptors: ReadonlyMap<string, PropertyDescriptor>, key: string): boolean {
  return descriptors.has(key);
}

function validateKnownFields(descriptors: ReadonlyMap<string, PropertyDescriptor>): void {
  const name = descriptorValue(descriptors, 'name');
  const timestamp = descriptorValue(descriptors, 'timestamp');
  if (!isAllowedValue(name, METRIC_NAME_VALUES)) {
    fail('invalid-field');
  }
  if (!isUtcTimestamp(timestamp)) {
    fail('invalid-timestamp');
  }

  const protocolVersion = descriptorValue(descriptors, 'protocolVersion');
  if (
    hasKey(descriptors, 'protocolVersion') &&
    (protocolVersion !== TELEMETRY_PROTOCOL_VERSION || !isSafeNonnegativeInteger(protocolVersion))
  ) {
    fail('invalid-field');
  }

  for (const key of ['durationMs', 'sampleCount', 'count']) {
    if (hasKey(descriptors, key) && descriptorValue(descriptors, key) !== undefined) {
      if (!isSafeNonnegativeInteger(descriptorValue(descriptors, key))) {
        fail('invalid-number');
      }
    }
  }

  const enumFields: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
    ['targetLanguage', TARGET_LANGUAGE_VALUES],
    ['gateDecision', GATE_DECISION_VALUES],
    ['operation', OPERATION_VALUES],
    ['outcome', OUTCOME_VALUES],
    ['deploymentSlot', DEPLOYMENT_SLOT_VALUES],
    ['reconnectReason', RECONNECT_REASON_VALUES],
    ['errorCategory', ERROR_CATEGORY_VALUES]
  ];
  for (const [key, values] of enumFields) {
    if (hasKey(descriptors, key) && descriptorValue(descriptors, key) !== undefined) {
      if (!isAllowedValue(descriptorValue(descriptors, key), values)) {
        fail(key === 'errorCategory' ? 'invalid-error' : 'invalid-field');
      }
    }
  }

  for (const key of ['providerId', 'providerVersion'] as const) {
    if (hasKey(descriptors, key) && descriptorValue(descriptors, key) !== undefined) {
      if (!isProviderToken(descriptorValue(descriptors, key))) {
        fail('invalid-token');
      }
    }
  }

  for (const key of CORRELATION_FIELDS) {
    if (hasKey(descriptors, key) && descriptorValue(descriptors, key) !== undefined) {
      if (!isCorrelationHash(descriptorValue(descriptors, key))) {
        fail('invalid-hash');
      }
    }
  }

  const errorCategoryPresent =
    hasKey(descriptors, 'errorCategory') && descriptorValue(descriptors, 'errorCategory') !== undefined;
  const errorIdPresent = hasKey(descriptors, 'errorId') && descriptorValue(descriptors, 'errorId') !== undefined;
  if (errorCategoryPresent !== errorIdPresent) {
    fail('invalid-error');
  }
  if (errorIdPresent && !isErrorId(descriptorValue(descriptors, 'errorId'))) {
    fail('invalid-error');
  }
}

const EXPORT_PROVIDER_VERSIONS = new Map<string, string>([
  ['deterministic-mock', '1.0.0'],
  ['deterministic-mock-generation', '1.0.0'],
  ['azure-realtime', 'ga-transcription-websocket'],
  ['litellm-chat', '1.0.0']
]);

const EXPORT_ERROR_IDS = new Map<TelemetryErrorCategory, string>([
  [ERROR_CATEGORIES.UNKNOWN, 'unknown_failure'],
  [ERROR_CATEGORIES.PROVIDER, 'provider_failure'],
  [ERROR_CATEGORIES.STATE_STORE, 'state_store_failure'],
  [ERROR_CATEGORIES.TRANSPORT, 'transport_failure'],
  [ERROR_CATEGORIES.VALIDATION, 'validation_failure'],
  [ERROR_CATEGORIES.CONFIGURATION, 'configuration_failure'],
  [ERROR_CATEGORIES.TIMEOUT, 'timeout_failure'],
  [ERROR_CATEGORIES.AUTHORIZATION, 'authorization_failure'],
  [ERROR_CATEGORIES.STORAGE, 'storage_failure'],
  [ERROR_CATEGORIES.LANGUAGE, 'language_failure']
]);

const LATENCY_METRIC_NAMES = new Set<TelemetryMetricName>([
  TELEMETRY_METRIC_NAMES.TRANSCRIPTION_FIRST_PARTIAL_LATENCY,
  TELEMETRY_METRIC_NAMES.TRANSCRIPTION_FINAL_LATENCY,
  TELEMETRY_METRIC_NAMES.TRANSLATION_LATENCY,
  TELEMETRY_METRIC_NAMES.SUGGESTION_LATENCY
]);

const AUDIO_SAMPLE_METRIC_NAMES = new Set<TelemetryMetricName>([
  TELEMETRY_METRIC_NAMES.AUDIO_ACCEPTED_SAMPLES,
  TELEMETRY_METRIC_NAMES.AUDIO_DUPLICATE_SAMPLES,
  TELEMETRY_METRIC_NAMES.AUDIO_REJECTED_SAMPLES
]);

function validateExportMetricFields(
  descriptors: ReadonlyMap<string, PropertyDescriptor>
): void {
  const name = descriptorValue(descriptors, 'name') as TelemetryMetricName;
  const hasDuration = descriptorValue(descriptors, 'durationMs') !== undefined;
  const hasSamples = descriptorValue(descriptors, 'sampleCount') !== undefined;
  const hasCount = descriptorValue(descriptors, 'count') !== undefined;

  if (LATENCY_METRIC_NAMES.has(name)) {
    if (!hasDuration || hasSamples || hasCount) {
      fail('invalid-field');
    }
    return;
  }

  if (AUDIO_SAMPLE_METRIC_NAMES.has(name)) {
    const sampleCount = descriptorValue(descriptors, 'sampleCount');
    if (!hasSamples || hasDuration || hasCount || sampleCount === 0) {
      fail('invalid-field');
    }
    return;
  }

  const count = descriptorValue(descriptors, 'count');
  if (hasDuration || hasSamples || (hasCount && count === 0)) {
    fail('invalid-field');
  }
}

function validateExportPairs(descriptors: ReadonlyMap<string, PropertyDescriptor>): void {
  const providerId = descriptorValue(descriptors, 'providerId');
  const providerVersion = descriptorValue(descriptors, 'providerVersion');
  if ((providerId === undefined) !== (providerVersion === undefined)) {
    fail('invalid-field');
  }
  if (
    typeof providerId === 'string' &&
    EXPORT_PROVIDER_VERSIONS.get(providerId) !== providerVersion
  ) {
    fail('invalid-field');
  }

  const errorCategory = descriptorValue(descriptors, 'errorCategory');
  const errorId = descriptorValue(descriptors, 'errorId');
  if (
    typeof errorCategory === 'string' &&
    EXPORT_ERROR_IDS.get(errorCategory as TelemetryErrorCategory) !== errorId
  ) {
    fail('invalid-error');
  }
}

function copyAllowedFields(
  descriptors: ReadonlyMap<string, PropertyDescriptor>
): SanitizedTelemetryRecord {
  const result = Object.create(null) as Record<string, unknown>;
  defineDataProperty(result, 'name', descriptorValue(descriptors, 'name'));
  defineDataProperty(result, 'timestamp', descriptorValue(descriptors, 'timestamp'));

  for (const key of OUTPUT_KEYS) {
    if (key === 'name' || key === 'timestamp') {
      continue;
    }
    if (hasKey(descriptors, key) && descriptorValue(descriptors, key) !== undefined) {
      defineDataProperty(result, key, descriptorValue(descriptors, key));
    }
  }

  const frozen = freezeOutput(result) as unknown as SanitizedTelemetryRecord;
  SANITIZED_RECORDS.add(frozen);
  return frozen;
}

const SANITIZED_RECORDS = new WeakSet<object>();

/**
 * Validates an unknown graph and returns a new, deeply frozen allow-listed
 * record. Unknown fields are intentionally ignored after the complete graph
 * has been inspected for forbidden content and unsafe object behavior.
 */
export function sanitizeTelemetry(input: unknown): SanitizedTelemetryRecord {
  const descriptors = inspectInputGraph(
    input,
    {
      ancestors: new Set<object>(),
      visited: new Set<object>(),
      objectCount: 0,
      propertyCount: 0
    },
    0
  );
  if (descriptors === undefined) {
    fail('input-shape');
  }
  if (!hasKey(descriptors, 'name') || !hasKey(descriptors, 'timestamp')) {
    fail('invalid-field');
  }
  validateKnownFields(descriptors);
  return copyAllowedFields(descriptors);
}

/**
 * Strict exporter boundary. The complete graph is inspected before the exact
 * root shape and metric-specific contract are evaluated.
 */
export function sanitizeTelemetryForExport(
  input: unknown,
  deploymentSlot: DeploymentSlot
): SanitizedTelemetryRecord {
  const descriptors = inspectInputGraph(
    input,
    {
      ancestors: new Set<object>(),
      visited: new Set<object>(),
      objectCount: 0,
      propertyCount: 0
    },
    0
  );
  if (descriptors === undefined) {
    fail('input-shape');
  }
  for (const [key, descriptor] of descriptors) {
    if (!OUTPUT_KEYS.has(key) || descriptor.value === undefined) {
      fail('invalid-field');
    }
  }
  if (!hasKey(descriptors, 'name') || !hasKey(descriptors, 'timestamp')) {
    fail('invalid-field');
  }
  validateKnownFields(descriptors);
  const timestamp = descriptorValue(descriptors, 'timestamp');
  if (typeof timestamp !== 'string' || Number(timestamp.slice(0, 4)) < 1970) {
    fail('invalid-timestamp');
  }
  if (descriptorValue(descriptors, 'deploymentSlot') !== deploymentSlot) {
    fail('invalid-field');
  }
  validateExportMetricFields(descriptors);
  validateExportPairs(descriptors);
  return copyAllowedFields(descriptors);
}

export function createTelemetryRecord(input: TelemetryRecordInput): SanitizedTelemetryRecord {
  return sanitizeTelemetry(input);
}

export interface RedactedErrorSummary {
  readonly errorCategory: TelemetryErrorCategory;
  readonly errorId: string;
}

let nextGeneratedErrorId = 1;

function generatedErrorId(): string {
  const id = `err_${nextGeneratedErrorId}`;
  nextGeneratedErrorId += 1;
  return id;
}

function safeErrorCategory(value: unknown): TelemetryErrorCategory {
  return isAllowedValue(value, ERROR_CATEGORY_VALUES) ? value : ERROR_CATEGORIES.UNKNOWN;
}

function safeErrorId(value: unknown): string {
  return isErrorId(value) ? value : generatedErrorId();
}

function createErrorSummary(
  errorCategory: TelemetryErrorCategory,
  errorId: string
): RedactedErrorSummary {
  const summary = Object.create(null) as Record<string, unknown>;
  defineDataProperty(summary, 'errorCategory', errorCategory);
  defineDataProperty(summary, 'errorId', errorId);
  return freezeOutput(summary) as unknown as RedactedErrorSummary;
}

/**
 * A safe replacement for provider/state errors. It deliberately never reads
 * the supplied error, including Error.message, stack, cause, or custom fields.
 */
export class RedactedError extends Error implements RedactedErrorSummary {
  readonly errorCategory!: TelemetryErrorCategory;
  readonly errorId!: string;

  constructor(categoryOrError?: unknown, providedErrorId?: unknown) {
    super('Telemetry error redacted');
    const errorCategory = safeErrorCategory(categoryOrError);
    const errorId = safeErrorId(providedErrorId);
    defineDataProperty(this, 'name', 'RedactedError', false, false, false);
    defineDataProperty(this, 'errorCategory', errorCategory, true, false, false);
    defineDataProperty(this, 'errorId', errorId, true, false, false);
    defineDataProperty(
      this,
      'toJSON',
      () => createErrorSummary(errorCategory, errorId),
      false,
      false,
      false
    );
    freezeOutput(this);
  }
}

export function summarizeError(
  _error: unknown,
  category: TelemetryErrorCategory = ERROR_CATEGORIES.UNKNOWN,
  errorId?: string
): RedactedErrorSummary {
  return createErrorSummary(safeErrorCategory(category), safeErrorId(errorId));
}

export const redactError = summarizeError;

export const DEFAULT_TELEMETRY_SINK_CAPACITY = 256;
export const MAX_TELEMETRY_SINK_CAPACITY = 10_000;
export const DEFAULT_SINK_CAPACITY = DEFAULT_TELEMETRY_SINK_CAPACITY;
export const MAX_SINK_CAPACITY = MAX_TELEMETRY_SINK_CAPACITY;

export interface TelemetrySinkSnapshot {
  readonly records: readonly SanitizedTelemetryRecord[];
  readonly droppedCount: number;
}

export interface TelemetrySinkOptions {
  readonly capacity?: number;
}

function capacityFromOptions(options: number | TelemetrySinkOptions): number {
  if (typeof options === 'number') {
    return options;
  }
  if (!isPlainObject(options)) {
    fail('invalid-capacity');
  }
  const descriptors = ownDescriptors(options);
  const capacity = descriptorValue(descriptors, 'capacity');
  return capacity === undefined ? DEFAULT_TELEMETRY_SINK_CAPACITY : capacity as number;
}

function validateCapacity(capacity: number): void {
  if (
    !Number.isInteger(capacity) ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > MAX_TELEMETRY_SINK_CAPACITY
  ) {
    fail('invalid-capacity');
  }
}

function isSanitizedRecord(value: unknown): value is SanitizedTelemetryRecord {
  if (!isObject(value) || !SANITIZED_RECORDS.has(value)) {
    return false;
  }
  try {
    if (!Object.isFrozen(value) || !isPlainObject(value)) {
      return false;
    }
    const descriptors = ownDescriptors(value);
    for (const key of descriptors.keys()) {
      if (!OUTPUT_KEYS.has(key)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Bounded metadata-only sink. `add` accepts only records already returned by
 * the sanitizer; it makes a fresh frozen copy before retaining each record.
 */
export class InMemoryTelemetrySink {
  readonly capacity!: number;
  #capacity: number;
  #records: SanitizedTelemetryRecord[] = createNullPrototypeArray<SanitizedTelemetryRecord>();
  #droppedCount = 0;

  constructor(options: number | TelemetrySinkOptions = DEFAULT_TELEMETRY_SINK_CAPACITY) {
    const capacity = capacityFromOptions(options);
    validateCapacity(capacity);
    this.#capacity = capacity;
    defineDataProperty(this, 'capacity', capacity, true, false, false);
  }

  get droppedCount(): number {
    return this.#droppedCount;
  }

  add(record: SanitizedTelemetryRecord): void {
    if (!isSanitizedRecord(record)) {
      fail('record-not-sanitized');
    }
    if (this.#records.length >= this.#capacity) {
      this.#droppedCount += 1;
      return;
    }
    const copied = sanitizeTelemetry(record);
    this.#records[this.#records.length] = copied;
  }

  push(record: SanitizedTelemetryRecord): void {
    this.add(record);
  }

  write(record: SanitizedTelemetryRecord): void {
    this.add(record);
  }

  snapshot(): TelemetrySinkSnapshot {
    const records = createNullPrototypeArray<SanitizedTelemetryRecord>();
    for (let index = 0; index < this.#records.length; index += 1) {
      const record = this.#records[index];
      if (record === undefined) {
        fail('record-not-sanitized');
      }
      records[records.length] = sanitizeTelemetry(record);
    }
    freezeOutput(records);

    const snapshot = Object.create(null) as Record<string, unknown>;
    defineDataProperty(snapshot, 'records', records, true, false, false);
    defineDataProperty(snapshot, 'droppedCount', this.#droppedCount, true, false, false);
    return freezeOutput(snapshot) as unknown as TelemetrySinkSnapshot;
  }

  getSnapshot(): TelemetrySinkSnapshot {
    return this.snapshot();
  }

  clear(): void {
    this.#records = createNullPrototypeArray<SanitizedTelemetryRecord>();
    this.#droppedCount = 0;
  }
}

export type MetadataTelemetrySink = InMemoryTelemetrySink;

export function createTelemetrySink(
  options: number | TelemetrySinkOptions = DEFAULT_TELEMETRY_SINK_CAPACITY
): InMemoryTelemetrySink {
  return new InMemoryTelemetrySink(options);
}

export * from './otlp-json-exporter.js';
