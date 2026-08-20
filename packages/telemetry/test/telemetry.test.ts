import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TELEMETRY_SINK_CAPACITY,
  DEPLOYMENT_SLOTS,
  ERROR_CATEGORIES,
  GENERATION_FAILURE_INTERNAL,
  GENERATION_FAILURE_INVALID_GENERATED_LANGUAGE,
  GENERATION_FAILURE_LANGUAGE_VALIDATION,
  GENERATION_FAILURE_PROVIDER_RESPONSE,
  GATE_DECISIONS,
  InMemoryTelemetrySink,
  MAX_TELEMETRY_SINK_CAPACITY,
  RECONNECT_REASONS,
  RedactedError,
  TARGET_LANGUAGES,
  TELEMETRY_METRIC_NAMES,
  TELEMETRY_OPERATIONS,
  TELEMETRY_OUTCOMES,
  TELEMETRY_PROTOCOL_VERSION,
  TelemetryValidationError,
  createTelemetryRecord,
  sanitizeTelemetry,
  summarizeError,
  type SanitizedTelemetryRecord,
  type TelemetryRecordInput,
  type TelemetryValidationReason
} from '../src/index.js';

const TIMESTAMP = '2026-08-10T12:34:56.789Z';
const HASH = `sha256:${'a'.repeat(64)}`;
const RAW_UUID = '11111111-1111-4111-8111-111111111111';
const SPANISH_CONVERSATION = '¿Puedes traducir esta conversación, por favor?';
const TURKISH_CONVERSATION = 'Bu konuşmayı Türkçeye çevirebilir misin?';
const ENGLISH_CONVERSATION = 'Please translate this private conversation.';

const CORRELATION_FIELDS = [
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
] as const;

const MINIMAL_RECORD = {
  name: TELEMETRY_METRIC_NAMES.SESSION_START,
  timestamp: TIMESTAMP
} satisfies TelemetryRecordInput;

const FULL_RECORD = {
  ...MINIMAL_RECORD,
  protocolVersion: TELEMETRY_PROTOCOL_VERSION,
  durationMs: 125,
  sampleCount: 16_000,
  count: 2,
  targetLanguage: TARGET_LANGUAGES.ES,
  gateDecision: GATE_DECISIONS.TARGET,
  operation: TELEMETRY_OPERATIONS.SESSION,
  outcome: TELEMETRY_OUTCOMES.SUCCESS,
  providerId: 'provider_alpha',
  providerVersion: 'v1.2.3',
  deploymentSlot: DEPLOYMENT_SLOTS.DEV,
  reconnectReason: RECONNECT_REASONS.NETWORK,
  correlationId: HASH,
  sessionId: HASH,
  sessionIdHash: HASH,
  utteranceId: HASH,
  utteranceIdHash: HASH,
  installationId: HASH,
  installationIdHash: HASH,
  requestId: HASH,
  requestIdHash: HASH,
  traceId: HASH,
  traceIdHash: HASH,
  spanId: HASH,
  spanIdHash: HASH,
  errorCategory: ERROR_CATEGORIES.PROVIDER,
  errorId: 'provider_failure'
} satisfies TelemetryRecordInput;

const ENUM_FIELD_CASES = [
  ['targetLanguage', TARGET_LANGUAGES],
  ['gateDecision', GATE_DECISIONS],
  ['operation', TELEMETRY_OPERATIONS],
  ['outcome', TELEMETRY_OUTCOMES],
  ['deploymentSlot', DEPLOYMENT_SLOTS],
  ['reconnectReason', RECONNECT_REASONS],
  ['errorCategory', ERROR_CATEGORIES]
] as const;

const FORBIDDEN_KEY_PARTS = [
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
] as const;

function expectValidation(input: unknown, reason?: TelemetryValidationReason): void {
  let caught: unknown;
  try {
    sanitizeTelemetry(input);
  } catch (error: unknown) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(TelemetryValidationError);
  const validationError = caught as TelemetryValidationError;
  expect(validationError.message).toBe('Invalid telemetry input');
  expect(String(validationError)).toBe('TelemetryValidationError: Invalid telemetry input');
  if (reason !== undefined) {
    expect(validationError.reason).toBe(reason);
  }
  expect(String(caught)).not.toMatch(/traducir|konuşmayı|private conversation|secret/i);
}

function withField(field: string, value: unknown): Record<string, unknown> {
  return { ...MINIMAL_RECORD, [field]: value };
}

describe('telemetry vocabulary and record sanitization', () => {
  it('does not expose or accept the removed non-resumable vocabulary', () => {
    expect(Object.values(TELEMETRY_METRIC_NAMES)).not.toContain('transport.non_resumable');
    expect(Object.values(TELEMETRY_OUTCOMES)).not.toContain('non_resumable');
    expectValidation({ ...MINIMAL_RECORD, name: 'transport.non_resumable' }, 'invalid-field');
    expectValidation({ ...MINIMAL_RECORD, outcome: 'non_resumable' }, 'invalid-field');
  });

  it('accepts every canonical metric name', () => {
    const names = Object.values(TELEMETRY_METRIC_NAMES);
    expect(new Set(names).size).toBe(names.length);

    for (const name of names) {
      const record = sanitizeTelemetry({ ...MINIMAL_RECORD, name });
      expect(record.name).toBe(name);
      expect(record.timestamp).toBe(TIMESTAMP);
    }
  });

  it('accepts the fixed generation failure vocabulary and aliases', () => {
    const names = [
      TELEMETRY_METRIC_NAMES.GENERATION_FAILURE_PROVIDER_RESPONSE,
      TELEMETRY_METRIC_NAMES.GENERATION_FAILURE_INVALID_GENERATED_LANGUAGE,
      TELEMETRY_METRIC_NAMES.GENERATION_FAILURE_LANGUAGE_VALIDATION,
      TELEMETRY_METRIC_NAMES.GENERATION_FAILURE_INTERNAL
    ] as const;
    expect(names).toEqual([
      'generation.failure.provider_response',
      'generation.failure.invalid_generated_language',
      'generation.failure.language_validation',
      'generation.failure.internal'
    ]);
    expect([
      GENERATION_FAILURE_PROVIDER_RESPONSE,
      GENERATION_FAILURE_INVALID_GENERATED_LANGUAGE,
      GENERATION_FAILURE_LANGUAGE_VALIDATION,
      GENERATION_FAILURE_INTERNAL
    ]).toEqual(names);

    for (const name of names) {
      const record = sanitizeTelemetry({
        ...MINIMAL_RECORD,
        name,
        count: 1,
        targetLanguage: TARGET_LANGUAGES.ES,
        operation: TELEMETRY_OPERATIONS.GENERATION,
        outcome: TELEMETRY_OUTCOMES.FAILURE,
        providerId: 'litellm-chat',
        providerVersion: '1.1.0'
      });
      expect(record).toMatchObject({
        name,
        count: 1,
        operation: TELEMETRY_OPERATIONS.GENERATION,
        outcome: TELEMETRY_OUTCOMES.FAILURE,
        providerId: 'litellm-chat',
        providerVersion: '1.1.0'
      });
      expect(record).not.toHaveProperty('errorCategory');
      expect(record).not.toHaveProperty('errorId');
      for (const field of CORRELATION_FIELDS) {
        expect(record).not.toHaveProperty(field);
      }
    }
  });

  it('accepts both target languages', () => {
    for (const targetLanguage of Object.values(TARGET_LANGUAGES)) {
      const record = createTelemetryRecord({ ...MINIMAL_RECORD, targetLanguage });
      expect(record.targetLanguage).toBe(targetLanguage);
    }
  });

  it('accepts every value in every exported enum family', () => {
    for (const [field, family] of ENUM_FIELD_CASES) {
      for (const value of Object.values(family)) {
        const record = sanitizeTelemetry({
          ...MINIMAL_RECORD,
          [field]: value,
          ...(field === 'errorCategory' ? { errorId: 'enum_error' } : {})
        });
        expect(record[field]).toBe(value);
      }
    }
  });

  it('accepts a complete record containing only hashed correlations', () => {
    const input = { ...FULL_RECORD };
    const record = createTelemetryRecord(input);

    expect(record).toEqual(input);
    expect(record).not.toBe(input);
    expect(Object.isFrozen(record)).toBe(true);
    for (const value of Object.values(record)) {
      if (typeof value === 'object' && value !== null) {
        expect(Object.isFrozen(value)).toBe(true);
      }
    }
  });

  it('rejects a raw UUID in every correlation field', () => {
    for (const field of CORRELATION_FIELDS) {
      expectValidation(withField(field, RAW_UUID), 'invalid-hash');
    }
  });

  it('rejects invalid hashes in every correlation field', () => {
    const invalidHashes = [
      'sha256:',
      `sha256:${'a'.repeat(63)}`,
      `sha256:${'a'.repeat(65)}`,
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'g'.repeat(64)}`,
      'sha512:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      HASH.slice(7)
    ];

    for (const field of CORRELATION_FIELDS) {
      for (const invalidHash of invalidHashes) {
        expectValidation(withField(field, invalidHash), 'invalid-hash');
      }
    }
  });

  it('rejects invalid UTC timestamps, including impossible calendar dates', () => {
    for (const timestamp of [
      '0000-01-01T00:00:00Z',
      '2023-02-29T12:00:00Z',
      '2026-04-31T12:00:00Z',
      '2026-00-01T12:00:00Z',
      '2026-13-01T12:00:00Z',
      '2026-08-10T24:00:00Z',
      '2026-08-10T12:60:00Z',
      '2026-08-10T12:34:60Z',
      '2026-08-10T12:34:56.1234Z',
      '2026-08-10T12:34:56+00:00Z',
      '2026-08-10T12:34:56'
    ]) {
      expectValidation({ ...MINIMAL_RECORD, timestamp }, 'invalid-timestamp');
    }
  });

  it('rejects invalid numeric values for every numeric field', () => {
    const invalidNumbers: readonly unknown[] = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      null
    ];

    for (const field of ['durationMs', 'sampleCount', 'count']) {
      for (const invalidNumber of invalidNumbers) {
        expectValidation(withField(field, invalidNumber), 'invalid-number');
      }
    }
  });

  it('rejects invalid protocol and enum values', () => {
    expectValidation(withField('protocolVersion', 2), 'invalid-field');

    for (const [field, family] of ENUM_FIELD_CASES) {
      const invalidValue = `${field}_not_allowed`;
      const reason: TelemetryValidationReason =
        field === 'errorCategory' ? 'invalid-error' : 'invalid-field';
      expectValidation(withField(field, invalidValue), reason);
      expect(Object.values(family)).not.toContain(invalidValue);
    }
  });

  it('rejects invalid provider IDs and versions', () => {
    const invalidTokens: readonly unknown[] = [
      '',
      '.provider',
      '-provider',
      'provider with spaces',
      'provider/one',
      'é',
      'a'.repeat(65),
      null
    ];

    for (const field of ['providerId', 'providerVersion']) {
      for (const invalidToken of invalidTokens) {
        expectValidation(withField(field, invalidToken), 'invalid-token');
      }
    }
  });

  it('requires valid error category and error ID pairs', () => {
    expectValidation(withField('errorCategory', ERROR_CATEGORIES.PROVIDER), 'invalid-error');
    expectValidation(withField('errorId', 'provider_failure'), 'invalid-error');
    expectValidation(
      { ...MINIMAL_RECORD, errorCategory: 'not-a-category', errorId: 'provider_failure' },
      'invalid-error'
    );

    for (const errorId of [RAW_UUID, HASH, '', 'error id', 'a'.repeat(65)]) {
      expectValidation(
        { ...MINIMAL_RECORD, errorCategory: ERROR_CATEGORIES.PROVIDER, errorId },
        'invalid-error'
      );
    }
  });

  it('rejects every forbidden key family at top level and nested depths', () => {
    for (const part of FORBIDDEN_KEY_PARTS) {
      const keys = [part, part.toUpperCase(), `safe_prefix_${part}`, `${part}_safe_suffix`];
      for (const key of keys) {
        for (const value of [
          { ...MINIMAL_RECORD, [key]: ENGLISH_CONVERSATION },
          { ...MINIMAL_RECORD, safe: { [key]: TURKISH_CONVERSATION } },
          { ...MINIMAL_RECORD, safe: { deeper: { [key]: SPANISH_CONVERSATION } } }
        ]) {
          expectValidation(value, 'unsafe-key');
        }
      }
    }
  });

  it('does not invoke accessors, including accessors below unknown keys', () => {
    let reads = 0;
    const topLevelAccessor = { ...MINIMAL_RECORD };
    Object.defineProperty(topLevelAccessor, 'safeExtra', {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error(ENGLISH_CONVERSATION);
      }
    });
    expectValidation(topLevelAccessor, 'accessor');

    const nestedValue: Record<string, unknown> = {};
    Object.defineProperty(nestedValue, 'nestedSafe', {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error(TURKISH_CONVERSATION);
      }
    });
    expectValidation({ ...MINIMAL_RECORD, safe: nestedValue }, 'accessor');
    expect(reads).toBe(0);
  });

  it('fails closed for cycles, throwing proxies, and unsupported values', () => {
    const cycle: Record<string, unknown> = { ...MINIMAL_RECORD };
    cycle.safe = cycle;
    expectValidation(cycle, 'cycle');

    const prototypeThrowingProxy = new Proxy({ ...MINIMAL_RECORD }, {
      getPrototypeOf: () => {
        throw new Error(SPANISH_CONVERSATION);
      }
    });
    expectValidation(prototypeThrowingProxy, 'input-shape');

    const keysThrowingProxy = new Proxy({ ...MINIMAL_RECORD }, {
      ownKeys: () => {
        throw new Error(TURKISH_CONVERSATION);
      }
    });
    expectValidation(keysThrowingProxy, 'input-shape');

    const descriptorThrowingProxy = new Proxy({ ...MINIMAL_RECORD }, {
      getOwnPropertyDescriptor: () => {
        throw new Error(ENGLISH_CONVERSATION);
      }
    });
    expectValidation(descriptorThrowingProxy, 'input-shape');

    const revoked = Proxy.revocable({ ...MINIMAL_RECORD }, {});
    revoked.revoke();
    expectValidation(revoked.proxy, 'input-shape');

    for (const unsupported of [
      [],
      () => ENGLISH_CONVERSATION,
      1n,
      Symbol('conversation'),
      new Date('2026-08-10T12:34:56.789Z'),
      new Map<string, string>(),
      new Set<string>(),
      new (class UnsupportedObject {})()
    ]) {
      expectValidation(unsupported, 'input-shape');
    }
  });

  it('fails closed for revoked proxies and proxies that throw proxy errors', () => {
    const revoked = Proxy.revocable({ ...MINIMAL_RECORD }, {});
    revoked.revoke();
    expectValidation(revoked.proxy, 'input-shape');

    const thrownProxy = new Proxy(new Error(SPANISH_CONVERSATION), {
      getPrototypeOf: () => {
        throw new Error(TURKISH_CONVERSATION);
      }
    });
    const reflectiveTrapProxy = new Proxy({ ...MINIMAL_RECORD }, {
      getPrototypeOf: () => Object.prototype,
      ownKeys: () => ['name', 'timestamp'],
      getOwnPropertyDescriptor: () => {
        throw thrownProxy;
      }
    });
    expectValidation(reflectiveTrapProxy, 'input-shape');

    const ownKeysTrapProxy = new Proxy({ ...MINIMAL_RECORD }, {
      ownKeys: () => {
        throw thrownProxy;
      }
    });
    expectValidation(ownKeysTrapProxy, 'input-shape');
  });

  it('inspects shared DAG nodes once and enforces a total graph work budget', () => {
    let proxyOwnKeyCalls = 0;
    const shared = new Proxy({ leaf: 'safe' }, {
      ownKeys: (target) => {
        proxyOwnKeyCalls += 1;
        return Reflect.ownKeys(target);
      }
    });
    let dag: unknown = shared;
    for (let index = 0; index < 20; index += 1) {
      dag = { left: dag, right: dag };
    }

    expect(sanitizeTelemetry({ ...MINIMAL_RECORD, safe: dag })).toEqual(MINIMAL_RECORD);
    expect(proxyOwnKeyCalls).toBe(2);

    const tooManyProperties: Record<string, unknown> = { ...MINIMAL_RECORD };
    for (let index = 0; index < 16_400; index += 1) {
      tooManyProperties[`safe_${index}`] = 'safe';
    }
    expectValidation(tooManyProperties, 'work-budget');

    let descriptorTrapCalls = 0;
    const manyNames = Array.from({ length: 20_002 }, (_value, index) => `safe_${index}`);
    const tooManyProxy = new Proxy(Object.create(null) as Record<string, unknown>, {
      ownKeys: () => manyNames,
      getOwnPropertyDescriptor: () => {
        descriptorTrapCalls += 1;
        return {
          configurable: true,
          enumerable: true,
          value: 'safe',
          writable: true
        };
      },
      getPrototypeOf: () => Object.prototype
    });
    expectValidation(tooManyProxy, 'work-budget');
    expect(descriptorTrapCalls).toBe(0);
  });

  it('rejects excessive nesting before producing a record', () => {
    let nested: Record<string, unknown> = { leaf: 'safe' };
    for (let index = 0; index < 40; index += 1) {
      nested = { level: nested };
    }
    expectValidation({ ...MINIMAL_RECORD, safe: nested }, 'nesting');
  });

  it('fails closed on excessive graph work without rescanning shared nodes', () => {
    const tooWide: Record<string, unknown> = { ...MINIMAL_RECORD };
    for (let index = 0; index < 16_500; index += 1) {
      tooWide[`safe_${index}`] = 'safe';
    }
    expectValidation(tooWide, 'work-budget');

    let shared: Record<string, unknown> = { leaf: 'safe' };
    for (let index = 0; index < 24; index += 1) {
      shared = { left: shared, right: shared };
    }
    const record = sanitizeTelemetry({ ...MINIMAL_RECORD, safe: shared });
    expect(record.name).toBe(MINIMAL_RECORD.name);
  });

  it('drops unknown safe keys recursively without mutating or freezing inputs', () => {
    const safeMetadata = {
      nested: {
        spanish: SPANISH_CONVERSATION,
        turkish: TURKISH_CONVERSATION,
        english: ENGLISH_CONVERSATION
      }
    };
    const input = {
      ...MINIMAL_RECORD,
      safeMetadata,
      harmlessCount: 3
    };
    const before = {
      ...input,
      safeMetadata: { nested: { ...safeMetadata.nested } }
    };

    const result = sanitizeTelemetry(input);

    expect(result).toEqual(MINIMAL_RECORD);
    expect(Object.getPrototypeOf(result)).toBe(null);
    expect(input).toEqual(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(safeMetadata)).toBe(false);
    expect(Object.isFrozen(safeMetadata.nested)).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SPANISH_CONVERSATION);
    expect(serialized).not.toContain(TURKISH_CONVERSATION);
    expect(serialized).not.toContain(ENGLISH_CONVERSATION);
  });

  it('returns null-prototype records and ignores polluted setters and toJSON hooks', () => {
    const previousToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    const previousDurationMs = Object.getOwnPropertyDescriptor(Object.prototype, 'durationMs');
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => ENGLISH_CONVERSATION
    });
    Object.defineProperty(Object.prototype, 'durationMs', {
      configurable: true,
      set: () => {
        throw new Error(SPANISH_CONVERSATION);
      }
    });

    try {
      const record = sanitizeTelemetry({ ...MINIMAL_RECORD, durationMs: 125 });
      const sink = new InMemoryTelemetrySink(1);
      sink.add(record);
      const snapshot = sink.snapshot();
      const summary = summarizeError(new Error(TURKISH_CONVERSATION), ERROR_CATEGORIES.PROVIDER);
      const redacted = new RedactedError(ERROR_CATEGORIES.PROVIDER, 'provider_failure');

      expect(Object.getPrototypeOf(record)).toBeNull();
      expect(Object.getPrototypeOf(summary)).toBeNull();
      expect(Object.getPrototypeOf(snapshot)).toBeNull();
      expect(Object.getPrototypeOf(snapshot.records)).toBeNull();
      expect(record.durationMs).toBe(125);
      expect(JSON.stringify(record)).not.toContain(ENGLISH_CONVERSATION);
      expect(JSON.stringify(summary)).not.toContain(ENGLISH_CONVERSATION);
      expect(JSON.stringify(redacted)).toBe(
        '{"errorCategory":"provider","errorId":"provider_failure"}'
      );
      expect(JSON.stringify(snapshot)).not.toContain(ENGLISH_CONVERSATION);
      expect(JSON.stringify(snapshot)).not.toContain(SPANISH_CONVERSATION);
      expect(JSON.stringify(snapshot)).not.toContain(TURKISH_CONVERSATION);
    } finally {
      if (previousToJSON === undefined) {
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      } else {
        Object.defineProperty(Object.prototype, 'toJSON', previousToJSON);
      }
      if (previousDurationMs === undefined) {
        delete (Object.prototype as { durationMs?: unknown }).durationMs;
      } else {
        Object.defineProperty(Object.prototype, 'durationMs', previousDurationMs);
      }
    }
  });
});

describe('redacted errors', () => {
  it('summarizes errors without reading or exposing source error data', () => {
    const source = new Error(ENGLISH_CONVERSATION);
    Object.defineProperty(source, 'stack', {
      configurable: true,
      value: TURKISH_CONVERSATION
    });
    Object.defineProperty(source, 'cause', {
      enumerable: true,
      value: new Error(SPANISH_CONVERSATION)
    });
    Object.defineProperty(source, 'providerDetails', {
      enumerable: true,
      value: ENGLISH_CONVERSATION
    });

    const summary = summarizeError(source, ERROR_CATEGORIES.PROVIDER, 'provider_failure');
    const redacted = new RedactedError(ERROR_CATEGORIES.PROVIDER, 'provider_failure');
    const serialized = JSON.stringify({ summary, redacted });

    expect(summary).toEqual({
      errorCategory: ERROR_CATEGORIES.PROVIDER,
      errorId: 'provider_failure'
    });
    expect(Object.getPrototypeOf(summary)).toBe(null);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(redacted.errorCategory).toBe(ERROR_CATEGORIES.PROVIDER);
    expect(redacted.errorId).toBe('provider_failure');
    expect(serialized).not.toContain(SPANISH_CONVERSATION);
    expect(serialized).not.toContain(TURKISH_CONVERSATION);
    expect(serialized).not.toContain(ENGLISH_CONVERSATION);
  });

  it('does not touch a throwing source proxy and uses safe fallback values', () => {
    const source = new Proxy(new Error(ENGLISH_CONVERSATION), {
      get: () => {
        throw new Error(SPANISH_CONVERSATION);
      },
      ownKeys: () => {
        throw new Error(TURKISH_CONVERSATION);
      }
    });

    const summary = summarizeError(source, 'not-a-category' as never, RAW_UUID);
    const redacted = new RedactedError(source, RAW_UUID);

    expect(summary.errorCategory).toBe(ERROR_CATEGORIES.UNKNOWN);
    expect(summary.errorId).toMatch(/^err_\d+$/);
    expect(redacted.errorCategory).toBe(ERROR_CATEGORIES.UNKNOWN);
    expect(redacted.errorId).toMatch(/^err_\d+$/);
    expect(JSON.stringify({ summary, redacted })).not.toMatch(
      /traducir|konuşmayı|translate this private conversation/i
    );
  });
});

describe('in-memory telemetry sink', () => {
  it('uses bounded capacity, counts drops, and resets with clear', () => {
    expect(new InMemoryTelemetrySink().capacity).toBe(DEFAULT_TELEMETRY_SINK_CAPACITY);
    expect(new InMemoryTelemetrySink(MAX_TELEMETRY_SINK_CAPACITY).capacity).toBe(
      MAX_TELEMETRY_SINK_CAPACITY
    );

    const sink = new InMemoryTelemetrySink({ capacity: 2 });
    const first = sanitizeTelemetry(FULL_RECORD);
    const second = sanitizeTelemetry({
      ...FULL_RECORD,
      name: TELEMETRY_METRIC_NAMES.SESSION_END,
      targetLanguage: TARGET_LANGUAGES.TR
    });

    sink.add(first);
    sink.push(second);
    sink.write(first);

    const snapshot = sink.snapshot();
    expect(Object.getPrototypeOf(snapshot)).toBe(null);
    expect(Object.getPrototypeOf(snapshot.records)).toBe(null);
    expect(snapshot.droppedCount).toBe(1);
    expect(snapshot.records).toHaveLength(2);
    expect(snapshot.records[0]).toEqual(first);
    expect(snapshot.records[0]).not.toBe(first);
    expect(snapshot.records[1]).toEqual(second);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(Object.isFrozen(snapshot.records[0])).toBe(true);
    expect(Object.isFrozen(snapshot.records[1])).toBe(true);

    sink.clear();
    expect(sink.droppedCount).toBe(0);
    expect(sink.snapshot()).toEqual({ records: [], droppedCount: 0 });
    expect(snapshot.records).toHaveLength(2);
  });

  it('does not trust runtime capacity mutation', () => {
    const sink = new InMemoryTelemetrySink(1);
    const first = sanitizeTelemetry(FULL_RECORD);
    const second = sanitizeTelemetry({ ...FULL_RECORD, name: TELEMETRY_METRIC_NAMES.SESSION_END });

    try {
      (sink as { capacity: number }).capacity = Number.POSITIVE_INFINITY;
    } catch {
      // Non-writable runtime capacity may throw in strict mode.
    }

    expect(sink.capacity).toBe(1);
    sink.add(first);
    sink.add(second);
    const snapshot = sink.snapshot();
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.droppedCount).toBe(1);
  });

  it('returns defensive snapshots and rejects records that were not sanitized', () => {
    const sink = new InMemoryTelemetrySink(1);
    const record = sanitizeTelemetry(FULL_RECORD);
    sink.add(record);

    const firstSnapshot = sink.snapshot();
    const secondSnapshot = sink.getSnapshot();
    expect(firstSnapshot.records).not.toBe(secondSnapshot.records);
    expect(firstSnapshot.records[0]).not.toBe(secondSnapshot.records[0]);

    const unsanitized = { ...FULL_RECORD } as SanitizedTelemetryRecord;
    expect(() => sink.add(unsanitized)).toThrowError(TelemetryValidationError);
    expect(() => sink.add(Object.freeze({ ...FULL_RECORD, safeExtra: true }) as SanitizedTelemetryRecord))
      .toThrowError(TelemetryValidationError);
    expect(() => sink.add(Object.freeze({ ...FULL_RECORD }) as SanitizedTelemetryRecord))
      .toThrowError(TelemetryValidationError);
    const revoked = Proxy.revocable(record, {});
    revoked.revoke();
    expect(() => sink.add(revoked.proxy)).toThrowError(TelemetryValidationError);
    expect(sink.droppedCount).toBe(0);
  });

  it('rejects a frozen hand-crafted record and malicious sink proxies', () => {
    const sink = new InMemoryTelemetrySink(1);
    const handCrafted = Object.freeze({ ...FULL_RECORD }) as SanitizedTelemetryRecord;
    expect(() => sink.add(handCrafted)).toThrowError(TelemetryValidationError);

    const revoked = Proxy.revocable({ ...FULL_RECORD }, {});
    revoked.revoke();
    expect(() => sink.add(revoked.proxy as SanitizedTelemetryRecord)).toThrowError(
      TelemetryValidationError
    );

    const throwing = new Proxy(Object.freeze({ ...FULL_RECORD }), {
      getPrototypeOf: () => {
        throw new Error(ENGLISH_CONVERSATION);
      }
    });
    expect(() => sink.add(throwing as SanitizedTelemetryRecord)).toThrowError(
      TelemetryValidationError
    );
    expect(sink.droppedCount).toBe(0);
  });

  it('uses fixed private capacity and cannot bypass drop accounting by mutation', () => {
    const sink = new InMemoryTelemetrySink(1);
    const record = sanitizeTelemetry(MINIMAL_RECORD);

    expect(Reflect.set(sink, 'capacity', 10_000)).toBe(false);
    expect(sink.capacity).toBe(1);
    sink.add(record);
    sink.add(record);

    expect(sink.snapshot().records).toHaveLength(1);
    expect(sink.droppedCount).toBe(1);
  });

  it('rejects invalid capacities without exposing caller values', () => {
    for (const capacity of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_TELEMETRY_SINK_CAPACITY + 1,
      Number.MAX_SAFE_INTEGER + 1
    ]) {
      expect(() => new InMemoryTelemetrySink(capacity)).toThrowError(TelemetryValidationError);
    }

    expect(() => new InMemoryTelemetrySink('2' as never)).toThrowError(TelemetryValidationError);
    expect(() => new InMemoryTelemetrySink([] as never)).toThrowError(TelemetryValidationError);

    const revoked = Proxy.revocable({ capacity: 1 }, {});
    revoked.revoke();
    expect(() => new InMemoryTelemetrySink(revoked.proxy)).toThrowError(TelemetryValidationError);

    const throwingOptions = new Proxy({ capacity: 1 }, {
      getOwnPropertyDescriptor: () => {
        throw new Error(ENGLISH_CONVERSATION);
      }
    });
    try {
      new InMemoryTelemetrySink(throwingOptions);
      expect.fail('expected invalid sink options');
    } catch (error) {
      expect(error).toBeInstanceOf(TelemetryValidationError);
      expect(String(error)).not.toContain(ENGLISH_CONVERSATION);
    }
  });
});
