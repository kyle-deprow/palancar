import { describe, expect, it } from 'vitest';

import {
  OTLP_JSON_BATCH_LIMIT,
  OTLP_JSON_BODY_LIMIT_BYTES,
  OTLP_JSON_CONTENT_TYPE,
  OTLP_JSON_EXPORT_PATH,
  OTLP_JSON_QUEUE_LIFETIME_MS,
  OTLP_JSON_REQUEST_TIMEOUT_MS,
  OtlpJsonExporter,
  TELEMETRY_EXPORT_COUNTERS,
  TELEMETRY_METRIC_NAMES,
  TelemetryValidationError,
  type OtlpJsonExporterOptions,
  type TelemetryMetricName,
  type TelemetryRecordInput
} from '../src/index.js';

const SLOT = 'dev' as const;
const EPOCH = '1970-01-01T00:00:00Z';
const HASH = `sha256:${'a'.repeat(64)}`;
const CANARY = 'private-canary-never-export';
const OPTIONS = {
  serviceName: 'palancar-relay',
  serviceVersion: '1.2.3',
  deploymentSlot: SLOT,
  retryJitterPermille: [1_000, 1_000]
} as const satisfies OtlpJsonExporterOptions;
const EXACT_METRIC_MAPPING = [
  { name: 'session.start', kind: 'sum', unit: '1', valueField: 'asInt', monotonic: true },
  { name: 'session.reject', kind: 'sum', unit: '1', valueField: 'asInt', monotonic: true },
  { name: 'session.end', kind: 'sum', unit: '1', valueField: 'asInt', monotonic: true },
  { name: 'utterance.start', kind: 'sum', unit: '1', valueField: 'asInt', monotonic: true },
  { name: 'utterance.abort', kind: 'sum', unit: '1', valueField: 'asInt', monotonic: true },
  { name: 'utterance.complete', kind: 'sum', unit: '1', valueField: 'asInt', monotonic: true },
  {
    name: 'audio.samples.accepted',
    kind: 'sum',
    unit: '{sample}',
    valueField: 'asInt',
    monotonic: true
  },
  {
    name: 'audio.samples.duplicate',
    kind: 'sum',
    unit: '{sample}',
    valueField: 'asInt',
    monotonic: true
  },
  {
    name: 'audio.samples.rejected',
    kind: 'sum',
    unit: '{sample}',
    valueField: 'asInt',
    monotonic: true
  },
  { name: 'transport.reconnect', kind: 'sum', unit: '1', valueField: 'asInt', monotonic: true },
  {
    name: 'transcription.first_partial_latency',
    kind: 'histogram',
    unit: 'ms',
    valueField: 'sum',
    monotonic: false
  },
  {
    name: 'transcription.final_latency',
    kind: 'histogram',
    unit: 'ms',
    valueField: 'sum',
    monotonic: false
  },
  { name: 'language.decision', kind: 'sum', unit: '1', valueField: 'asInt', monotonic: true },
  {
    name: 'translation.latency',
    kind: 'histogram',
    unit: 'ms',
    valueField: 'sum',
    monotonic: false
  },
  { name: 'translation.result', kind: 'sum', unit: '1', valueField: 'asInt', monotonic: true },
  {
    name: 'suggestion.latency',
    kind: 'histogram',
    unit: 'ms',
    valueField: 'sum',
    monotonic: false
  },
  { name: 'suggestion.result', kind: 'sum', unit: '1', valueField: 'asInt', monotonic: true },
  { name: 'provider.failure', kind: 'sum', unit: '1', valueField: 'asInt', monotonic: true },
  { name: 'state_store.failure', kind: 'sum', unit: '1', valueField: 'asInt', monotonic: true }
] as const satisfies ReadonlyArray<{
  readonly name: TelemetryMetricName;
  readonly kind: 'sum' | 'histogram';
  readonly unit: '1' | '{sample}' | 'ms';
  readonly valueField: 'asInt' | 'sum';
  readonly monotonic: boolean;
}>;

function exporter(options: OtlpJsonExporterOptions = OPTIONS): OtlpJsonExporter {
  return new OtlpJsonExporter(options);
}

function input(
  name: TelemetryMetricName = TELEMETRY_METRIC_NAMES.SESSION_START,
  additions: Partial<TelemetryRecordInput> = {}
): TelemetryRecordInput {
  const mapping = EXACT_METRIC_MAPPING.find((candidate) => candidate.name === name);
  const measurement = mapping?.kind === 'histogram'
    ? { durationMs: 12 }
    : mapping?.unit === '{sample}' ? { sampleCount: 160 } : {};
  return {
    name,
    timestamp: EPOCH,
    deploymentSlot: SLOT,
    ...measurement,
    ...additions
  };
}

function requiredRequest(instance: OtlpJsonExporter, nowMs = 0) {
  const request = instance.next(nowMs);
  expect(request).not.toBeNull();
  if (request === null) {
    throw new Error('expected request');
  }
  return request;
}

function parsedBody(request: { readonly body: string }): {
  resourceMetrics: Array<{
    resource: { attributes: Array<{ key: string; value: unknown }> };
    scopeMetrics: Array<{
      scope: { name: string; version: string };
      metrics: Array<Record<string, unknown>>;
    }>;
  }>;
} {
  return JSON.parse(request.body) as ReturnType<typeof parsedBody>;
}

function firstMetric(request: { readonly body: string }): Record<string, unknown> {
  const metric = parsedBody(request).resourceMetrics[0]?.scopeMetrics[0]?.metrics[0];
  if (metric === undefined) {
    throw new Error('expected metric');
  }
  return metric;
}

function exporterWithSinglePointBodyLength(targetBytes: number): OtlpJsonExporter {
  const probe = exporter();
  probe.enqueue(input());
  const probeLength = requiredRequest(probe).body.length;
  const componentLength = targetBytes - probeLength + 1;
  if (componentLength < 1) {
    throw new Error('target body is too small');
  }
  return exporter({
    ...OPTIONS,
    serviceVersion: `${'9'.repeat(componentLength)}.2.3`
  });
}

describe('OTLP JSON construction', () => {
  it('emits the exact canonical compact sum request', () => {
    const instance = exporter();
    instance.enqueue(input(TELEMETRY_METRIC_NAMES.SESSION_START, {
      protocolVersion: 1,
      targetLanguage: 'es',
      operation: 'session',
      outcome: 'success'
    }));

    const request = requiredRequest(instance);
    expect(request).toEqual({
      method: 'POST',
      path: OTLP_JSON_EXPORT_PATH,
      contentType: OTLP_JSON_CONTENT_TYPE,
      body: request.body,
      requestId: 'otlp-1',
      timeoutMs: OTLP_JSON_REQUEST_TIMEOUT_MS
    });
    expect(Object.getPrototypeOf(request)).toBeNull();
    expect(Object.isFrozen(request)).toBe(true);
    expect(request.body).toBe(
      '{"resourceMetrics":[{"resource":{"attributes":[{"key":"deployment.environment.name","value":{"stringValue":"dev"}},{"key":"service.name","value":{"stringValue":"palancar-relay"}},{"key":"service.version","value":{"stringValue":"1.2.3"}}]},"scopeMetrics":[{"scope":{"name":"@palancar/telemetry","version":"0.1.0"},"metrics":[{"name":"session.start","unit":"1","sum":{"aggregationTemporality":1,"isMonotonic":true,"dataPoints":[{"attributes":[{"key":"palancar.operation","value":{"stringValue":"session"}},{"key":"palancar.outcome","value":{"stringValue":"success"}},{"key":"palancar.protocol.version","value":{"intValue":"1"}},{"key":"palancar.target_language","value":{"stringValue":"es"}}],"timeUnixNano":"0","asInt":"1"}]}}]}]}]}'
    );
  });

  it('emits the exact delta histogram shape', () => {
    const instance = exporter();
    instance.enqueue(input(TELEMETRY_METRIC_NAMES.TRANSLATION_LATENCY, {
      durationMs: 125,
      targetLanguage: 'tr'
    }));

    expect(firstMetric(requiredRequest(instance))).toEqual({
      name: TELEMETRY_METRIC_NAMES.TRANSLATION_LATENCY,
      unit: 'ms',
      histogram: {
        aggregationTemporality: 1,
        dataPoints: [{
          attributes: [{
            key: 'palancar.target_language',
            value: { stringValue: 'tr' }
          }],
          timeUnixNano: '0',
          count: '1',
          sum: 125,
          bucketCounts: ['1'],
          explicitBounds: []
        }]
      }
    });
  });

  it('maps the exact fixed 19-name vocabulary to its complete OTLP contract', () => {
    const instance = exporter();
    expect(Object.values(TELEMETRY_METRIC_NAMES)).toEqual(
      EXACT_METRIC_MAPPING.map((mapping) => mapping.name)
    );
    expect(new Set(EXACT_METRIC_MAPPING.map((mapping) => mapping.name)).size).toBe(19);
    for (const mapping of EXACT_METRIC_MAPPING) {
      instance.enqueue(input(mapping.name));
    }

    const metrics = parsedBody(requiredRequest(instance)).resourceMetrics[0]
      ?.scopeMetrics[0]?.metrics;
    expect(metrics).toHaveLength(19);
    for (const [index, expected] of EXACT_METRIC_MAPPING.entries()) {
      const metric = metrics?.[index];
      expect(metric?.name).toBe(expected.name);
      expect(metric?.unit).toBe(expected.unit);
      expect(metric).toHaveProperty(expected.kind);
      expect(metric).not.toHaveProperty(expected.kind === 'sum' ? 'histogram' : 'sum');
      const aggregation = metric?.[expected.kind] as {
        aggregationTemporality?: unknown;
        isMonotonic?: unknown;
        dataPoints?: Array<Record<string, unknown>>;
      } | undefined;
      expect(aggregation?.aggregationTemporality).toBe(1);
      if (expected.monotonic) {
        expect(aggregation?.isMonotonic).toBe(true);
      } else {
        expect(aggregation).not.toHaveProperty('isMonotonic');
      }
      const point = aggregation?.dataPoints?.[0];
      expect(point).toHaveProperty(expected.valueField);
      expect(point).not.toHaveProperty(expected.valueField === 'asInt' ? 'asDouble' : 'asInt');
    }
  });

  it('groups by first-seen metric while preserving point queue order', () => {
    const instance = exporter();
    instance.enqueue(input(TELEMETRY_METRIC_NAMES.SESSION_END, { count: 2 }));
    instance.enqueue(input(TELEMETRY_METRIC_NAMES.SESSION_START, { count: 3 }));
    instance.enqueue(input(TELEMETRY_METRIC_NAMES.SESSION_END, { count: 4 }));

    const metrics = parsedBody(requiredRequest(instance)).resourceMetrics[0]
      ?.scopeMetrics[0]?.metrics;
    expect(metrics?.map((metric) => metric.name)).toEqual(['session.end', 'session.start']);
    expect(JSON.stringify(metrics?.[0])).toContain('"asInt":"2"');
    expect(JSON.stringify(metrics?.[0])).toContain('"asInt":"4"');
    expect(JSON.stringify(metrics?.[0])?.indexOf('"asInt":"2"')).toBeLessThan(
      JSON.stringify(metrics?.[0])?.indexOf('"asInt":"4"') ?? 0
    );
  });

  it('sorts the complete allowed point attribute set and exports no correlations', () => {
    const instance = exporter();
    instance.enqueue(input(TELEMETRY_METRIC_NAMES.PROVIDER_FAILURE, {
      protocolVersion: 1,
      targetLanguage: 'es',
      gateDecision: 'target',
      operation: 'provider',
      outcome: 'failure',
      providerId: 'azure-realtime',
      providerVersion: 'ga-transcription-websocket',
      reconnectReason: 'network',
      errorCategory: 'provider',
      errorId: 'provider_failure',
      correlationId: HASH,
      sessionIdHash: HASH,
      requestIdHash: HASH
    }));

    const body = requiredRequest(instance).body;
    const point = ((firstMetric({ body }).sum as {
      dataPoints: Array<{ attributes: Array<{ key: string }> }>;
    }).dataPoints[0]);
    expect(point?.attributes.map((attribute) => attribute.key)).toEqual([
      'error.type',
      'palancar.error.id',
      'palancar.gate_decision',
      'palancar.operation',
      'palancar.outcome',
      'palancar.protocol.version',
      'palancar.provider.id',
      'palancar.provider.version',
      'palancar.reconnect.reason',
      'palancar.target_language'
    ]);
    expect(body).not.toContain(HASH);
    expect(body).not.toMatch(/correlation|sessionId|requestId/);
  });

  it('converts both supported UTC boundaries to exact nanosecond decimal strings', () => {
    const instance = exporter();
    instance.enqueue(input(TELEMETRY_METRIC_NAMES.SESSION_START, {
      timestamp: '1970-01-01T00:00:00.001Z'
    }));
    instance.enqueue(input(TELEMETRY_METRIC_NAMES.SESSION_END, {
      timestamp: '9999-12-31T23:59:59.999Z'
    }));

    const body = requiredRequest(instance, 1);
    expect(body.body).toContain('"timeUnixNano":"1000000"');
    expect(body.body).toContain('"timeUnixNano":"253402300799999000000"');
  });
});

describe('strict enqueue boundary', () => {
  it('rejects unknown root keys only after inspecting their complete graph', () => {
    const instance = exporter();
    expect(() => instance.enqueue({ ...input(), harmless: 1 })).toThrowError(
      TelemetryValidationError
    );
    try {
      instance.enqueue({ ...input(), harmless: { secretValue: CANARY } });
      expect.fail('expected rejection');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(TelemetryValidationError);
      expect((error as TelemetryValidationError).reason).toBe('unsafe-key');
      expect(String(error)).not.toContain(CANARY);
    }
    expect(instance.counter('telemetry.export.rejected')).toBe(2);
  });

  it('rejects accessors, symbols, cycles, nonplain values, and throwing proxies', () => {
    const cases: unknown[] = [];
    const accessor = { ...input() };
    let reads = 0;
    Object.defineProperty(accessor, 'safe', {
      enumerable: true,
      get: () => {
        reads += 1;
        return CANARY;
      }
    });
    cases.push(accessor);
    cases.push({ ...input(), [Symbol('safe')]: CANARY });
    const cycle: Record<string, unknown> = { ...input() };
    cycle.safe = cycle;
    cases.push(cycle, { ...input(), safe: new Date(0) });
    cases.push(new Proxy({ ...input() }, {
      ownKeys: () => {
        throw new Error(CANARY);
      }
    }));

    for (const candidate of cases) {
      expect(() => exporter().enqueue(candidate)).toThrowError(TelemetryValidationError);
    }
    expect(reads).toBe(0);
  });

  it('enforces slot, metric value, provider pair, error pair, and timestamp contracts', () => {
    const invalid: unknown[] = [
      { ...input(), deploymentSlot: 'staging' },
      { ...input(), deploymentSlot: undefined },
      {
        ...input(TELEMETRY_METRIC_NAMES.TRANSLATION_LATENCY),
        durationMs: undefined
      },
      input(TELEMETRY_METRIC_NAMES.TRANSLATION_LATENCY, { durationMs: 1, count: 1 }),
      input(TELEMETRY_METRIC_NAMES.AUDIO_ACCEPTED_SAMPLES, { sampleCount: 0 }),
      input(TELEMETRY_METRIC_NAMES.SESSION_START, { count: 0 }),
      input(TELEMETRY_METRIC_NAMES.SESSION_START, { sampleCount: 1 }),
      input(TELEMETRY_METRIC_NAMES.PROVIDER_FAILURE, {
        providerId: 'azure-realtime',
        providerVersion: '1.0.0'
      }),
      input(TELEMETRY_METRIC_NAMES.PROVIDER_FAILURE, {
        providerId: 'deterministic-mock'
      }),
      input(TELEMETRY_METRIC_NAMES.STATE_STORE_FAILURE, {
        errorCategory: 'state_store',
        errorId: 'provider_failure'
      }),
      input(TELEMETRY_METRIC_NAMES.SESSION_START, {
        timestamp: '1969-12-31T23:59:59.999Z'
      })
    ];

    for (const candidate of invalid) {
      expect(() => exporter().enqueue(candidate)).toThrowError(TelemetryValidationError);
    }
  });

  it('accepts only the closed provider and error pairs', () => {
    const providerPairs = [
      ['deterministic-mock', '1.0.0'],
      ['deterministic-mock-generation', '1.0.0'],
      ['azure-realtime', 'ga-transcription-websocket'],
      ['litellm-chat', '1.0.0']
    ] as const;
    const errorPairs = [
      ['unknown', 'unknown_failure'],
      ['provider', 'provider_failure'],
      ['state_store', 'state_store_failure'],
      ['transport', 'transport_failure'],
      ['validation', 'validation_failure'],
      ['configuration', 'configuration_failure'],
      ['timeout', 'timeout_failure'],
      ['authorization', 'authorization_failure'],
      ['storage', 'storage_failure'],
      ['language', 'language_failure']
    ] as const;

    for (const [providerId, providerVersion] of providerPairs) {
      expect(exporter().enqueue(input(undefined, { providerId, providerVersion }))).toBe(true);
    }
    for (const [errorCategory, errorId] of errorPairs) {
      expect(exporter().enqueue(input(undefined, { errorCategory, errorId }))).toBe(true);
    }
  });

  it('validates and defensively copies constructor policy', () => {
    const jitters: [number, number] = [1_000, 1_500];
    const instance = exporter({ ...OPTIONS, retryJitterPermille: jitters });
    jitters[0] = 500;
    instance.enqueue(input());
    const first = requiredRequest(instance);
    instance.settle(first.requestId, { kind: 'network-error' }, 0);
    expect(instance.next(999)).toBeNull();
    expect(instance.next(1_000)).not.toBeNull();

    for (const options of [
      { ...OPTIONS, serviceName: 'other' },
      { ...OPTIONS, serviceVersion: '01.2.3' },
      { ...OPTIONS, serviceVersion: '1.2.3+metadata' },
      { ...OPTIONS, deploymentSlot: 'qa' },
      { ...OPTIONS, retryJitterPermille: [499, 1_000] },
      { ...OPTIONS, retryJitterPermille: [1_000, 1_501] }
    ]) {
      expect(() => exporter(options as OtlpJsonExporterOptions)).toThrowError(
        TelemetryValidationError
      );
    }
  });
});

describe('bounded queue and request lifecycle', () => {
  it('batches at 64 and leaves the next point queued', () => {
    const instance = exporter();
    for (let index = 0; index < OTLP_JSON_BATCH_LIMIT + 1; index += 1) {
      instance.enqueue(input(undefined, { count: index + 1 }));
    }
    const first = requiredRequest(instance);
    const firstMetricBody = JSON.stringify(firstMetric(first));
    expect((firstMetricBody.match(/"asInt"/g) ?? [])).toHaveLength(OTLP_JSON_BATCH_LIMIT);
    instance.settle(first.requestId, { kind: 'http', status: 200 }, 0);
    expect(requiredRequest(instance).body).toContain('"asInt":"65"');
  });

  it('evicts the oldest queued point at retained capacity and accepts the newest', () => {
    const instance = exporter();
    for (let index = 1; index <= 257; index += 1) {
      expect(instance.enqueue(input(undefined, { count: index }))).toBe(true);
    }
    const request = requiredRequest(instance);
    expect(request.body).not.toContain('"asInt":"1"');
    expect(request.body).toContain('"asInt":"2"');
    expect(instance.counter('telemetry.export.accepted')).toBe(257);
    expect(instance.counter('telemetry.export.dropped.queue_full')).toBe(1);
  });

  it('counts in-flight points inside the exact retained limit of 256', () => {
    const instance = exporter();
    for (let index = 1; index <= 256; index += 1) {
      instance.enqueue(input(undefined, { count: index }));
    }
    const inFlight = requiredRequest(instance);
    expect(instance.enqueue(input(undefined, { count: 257 }))).toBe(true);
    expect(instance.counter('telemetry.export.dropped.queue_full')).toBe(1);
    instance.settle(inFlight.requestId, { kind: 'http', status: 200 }, 0);
    const next = requiredRequest(instance);
    expect(next.body).not.toContain('"asInt":"65"');
    expect(next.body).toContain('"asInt":"66"');
  });

  it('counts pending-retry points inside the exact retained limit of 256', () => {
    const instance = exporter();
    for (let index = 1; index <= 256; index += 1) {
      instance.enqueue(input(undefined, { count: index }));
    }
    const first = requiredRequest(instance);
    instance.settle(first.requestId, { kind: 'network-error' }, 0);
    expect(instance.enqueue(input(undefined, { count: 257 }))).toBe(true);
    expect(instance.counter('telemetry.export.dropped.queue_full')).toBe(1);
    const retry = requiredRequest(instance, 1_000);
    expect(retry.body).toBe(first.body);
    instance.settle(retry.requestId, { kind: 'http', status: 200 }, 1_000);
    const next = requiredRequest(instance, 1_000);
    expect(next.body).not.toContain('"asInt":"65"');
    expect(next.body).toContain('"asInt":"66"');
  });

  it('expires queued points at the exact queue lifetime boundary', () => {
    const instance = exporter();
    instance.enqueue(input());
    expect(instance.next(OTLP_JSON_QUEUE_LIFETIME_MS)).toBeNull();
    expect(instance.counter('telemetry.export.dropped.expired')).toBe(1);
  });

  it('accepts exactly 262144 UTF-8 bytes and drops a 262145-byte single point', () => {
    const exact = exporterWithSinglePointBodyLength(OTLP_JSON_BODY_LIMIT_BYTES);
    exact.enqueue(input());
    const accepted = requiredRequest(exact);
    expect(accepted.body.length).toBe(OTLP_JSON_BODY_LIMIT_BYTES);
    expect(exact.counter('telemetry.export.dropped.oversize')).toBe(0);

    const over = exporterWithSinglePointBodyLength(OTLP_JSON_BODY_LIMIT_BYTES + 1);
    over.enqueue(input());
    expect(over.next(0)).toBeNull();
    expect(over.counter('telemetry.export.dropped.oversize')).toBe(1);
  });

  it('shrinks a multi-point oversized body to the largest fitting prefix', () => {
    const instance = exporterWithSinglePointBodyLength(OTLP_JSON_BODY_LIMIT_BYTES);
    instance.enqueue(input(undefined, { count: 1 }));
    instance.enqueue(input(undefined, { count: 2 }));
    const first = requiredRequest(instance);
    expect(first.body.length).toBe(OTLP_JSON_BODY_LIMIT_BYTES);
    expect(first.body).toContain('"asInt":"1"');
    expect(first.body).not.toContain('"asInt":"2"');
    instance.settle(first.requestId, { kind: 'http', status: 200 }, 0);
    const second = requiredRequest(instance);
    expect(second.body.length).toBe(OTLP_JSON_BODY_LIMIT_BYTES);
    expect(second.body).toContain('"asInt":"2"');
    expect(instance.counter('telemetry.export.dropped.oversize')).toBe(0);
  });

  it('allows at most one in-flight request', () => {
    const instance = exporter();
    instance.enqueue(input());
    instance.enqueue(input());
    requiredRequest(instance);
    expect(instance.next(1)).toBeNull();
  });
});

describe('settlement, retries, and races', () => {
  it('treats exactly HTTP 200 as success and every other 2xx as permanent', () => {
    const success = exporter();
    success.enqueue(input());
    const successfulRequest = requiredRequest(success);
    success.settle(successfulRequest.requestId, { kind: 'http', status: 200 }, 0);
    expect(success.counter('telemetry.export.exported')).toBe(1);
    expect(success.counter('telemetry.export.dropped.permanent')).toBe(0);

    for (const status of [201, 202, 204, 206, 299]) {
      const instance = exporter();
      instance.enqueue(input());
      const request = requiredRequest(instance);
      instance.settle(request.requestId, {
        kind: 'http',
        status,
        rejectedDataPoints: 0
      }, 0);
      expect(instance.counter('telemetry.export.exported')).toBe(0);
      expect(instance.counter('telemetry.export.dropped.partial')).toBe(0);
      expect(instance.counter('telemetry.export.dropped.permanent')).toBe(1);
    }
  });

  it('retries only network, timeout, 429, 502, 503, and 504 outcomes', () => {
    const retryResults = [
      { kind: 'network-error' },
      { kind: 'timeout' },
      { kind: 'http', status: 429 },
      { kind: 'http', status: 502 },
      { kind: 'http', status: 503 },
      { kind: 'http', status: 504 }
    ] as const;
    for (const result of retryResults) {
      const instance = exporter();
      instance.enqueue(input());
      const first = requiredRequest(instance);
      instance.settle(first.requestId, result, 0);
      expect(instance.next(999)).toBeNull();
      const retry = requiredRequest(instance, 1_000);
      expect(retry.body).toBe(first.body);
      expect(instance.counter('telemetry.export.retried')).toBe(1);
    }

    for (const status of [400, 404, 408, 409, 500, 501, 505]) {
      const instance = exporter();
      instance.enqueue(input());
      const request = requiredRequest(instance);
      instance.settle(request.requestId, { kind: 'http', status }, 0);
      expect(instance.next(60_000)).toBeNull();
      expect(instance.counter('telemetry.export.dropped.permanent')).toBe(1);
    }
  });

  it('honors exact Retry-After boundaries 0 and 60000', () => {
    const zero = exporter();
    zero.enqueue(input());
    const zeroFirst = requiredRequest(zero);
    zero.settle(zeroFirst.requestId, {
      kind: 'http',
      status: 429,
      retryAfterMs: 0
    }, 0);
    expect(zero.next(999)).toBeNull();
    expect(requiredRequest(zero, 1_000).body).toBe(zeroFirst.body);

    const maximum = exporter();
    maximum.enqueue(input());
    const maximumFirst = requiredRequest(maximum);
    maximum.settle(maximumFirst.requestId, {
      kind: 'http',
      status: 429,
      retryAfterMs: 60_000
    }, 0);
    expect(maximum.next(59_999)).toBeNull();
    expect(requiredRequest(maximum, 60_000).body).toBe(maximumFirst.body);
  });

  it('permanently drops invalid adjacent Retry-After values', () => {
    for (const retryAfterMs of [-1, 60_001]) {
      const instance = exporter();
      instance.enqueue(input());
      const request = requiredRequest(instance);
      instance.settle(request.requestId, {
        kind: 'http',
        status: 429,
        retryAfterMs
      }, 0);
      expect(instance.next(60_001)).toBeNull();
      expect(instance.counter('telemetry.export.retried')).toBe(0);
      expect(instance.counter('telemetry.export.dropped.permanent')).toBe(1);
    }
  });

  it('uses 1000/2000 jittered delays and drops after three attempts', () => {
    const instance = exporter({ ...OPTIONS, retryJitterPermille: [500, 1_500] });
    instance.enqueue(input());
    const first = requiredRequest(instance);
    instance.settle(first.requestId, { kind: 'timeout' }, 0);
    const second = requiredRequest(instance, 500);
    instance.settle(second.requestId, { kind: 'network-error' }, 500);
    expect(instance.next(3_499)).toBeNull();
    const third = requiredRequest(instance, 3_500);
    expect(second.body).toBe(first.body);
    expect(third.body).toBe(first.body);
    instance.settle(third.requestId, { kind: 'http', status: 503 }, 3_500);
    expect(instance.counter('telemetry.export.retried')).toBe(2);
    expect(instance.counter('telemetry.export.dropped.retry_exhausted')).toBe(1);
  });

  it('expires only old pending-retry points and preserves inherited attempts and order', () => {
    const instance = exporter();
    instance.enqueue(input(undefined, { count: 1 }));
    instance.enqueue(input(undefined, {
      count: 2,
      timestamp: '1970-01-01T00:00:10Z'
    }));
    const first = requiredRequest(instance, 299_999);
    expect(first.body).toContain('"asInt":"1"');
    expect(first.body).toContain('"asInt":"2"');
    instance.settle(first.requestId, { kind: 'network-error' }, 299_999);

    expect(instance.next(300_000)).toBeNull();
    expect(instance.counter('telemetry.export.dropped.expired')).toBe(1);
    const second = requiredRequest(instance, 300_999);
    expect(second.body).not.toContain('"asInt":"1"');
    expect(second.body).toContain('"asInt":"2"');
    expect(second.body).not.toBe(first.body);
    expect(instance.next(301_000)).toBeNull();
    instance.settle(second.requestId, { kind: 'network-error' }, 300_999);

    const third = requiredRequest(instance, 302_999);
    expect(third.body).toBe(second.body);
    instance.settle(third.requestId, { kind: 'network-error' }, 302_999);
    expect(instance.counter('telemetry.export.retried')).toBe(3);
    expect(instance.counter('telemetry.export.dropped.retry_exhausted')).toBe(1);
    expect(instance.next(303_000)).toBeNull();
  });

  it('turns a request deadline into a retry and ignores stale or duplicate settles', () => {
    const instance = exporter();
    instance.enqueue(input());
    const first = requiredRequest(instance);
    expect(instance.next(4_999)).toBeNull();
    expect(instance.next(5_000)).toBeNull();
    instance.settle(first.requestId, { kind: 'http', status: 200 }, 5_001);
    expect(instance.counter('telemetry.export.exported')).toBe(0);
    const second = requiredRequest(instance, 6_000);
    instance.settle(second.requestId, { kind: 'http', status: 200 }, 6_000);
    instance.settle(second.requestId, { kind: 'http', status: 200 }, 6_000);
    expect(instance.counter('telemetry.export.exported')).toBe(1);
  });

  it('treats a settlement at the exact deadline as a timeout race', () => {
    const instance = exporter();
    instance.enqueue(input());
    const first = requiredRequest(instance);
    instance.settle(first.requestId, { kind: 'http', status: 200 }, 5_000);
    expect(instance.counter('telemetry.export.exported')).toBe(0);
    expect(instance.next(5_999)).toBeNull();
    expect(requiredRequest(instance, 6_000).body).toBe(first.body);
  });

  it('handles zero, partial, and full partial-success counts exactly', () => {
    for (const [rejectedDataPoints, exported, dropped] of [
      [0, 3, 0],
      [1, 2, 1],
      [3, 0, 3]
    ] as const) {
      const instance = exporter();
      for (let index = 0; index < 3; index += 1) {
        instance.enqueue(input());
      }
      const request = requiredRequest(instance);
      instance.settle(request.requestId, {
        kind: 'http',
        status: 200,
        rejectedDataPoints
      }, 0);
      expect(instance.counter('telemetry.export.exported')).toBe(exported);
      expect(instance.counter('telemetry.export.dropped.partial')).toBe(dropped);
      expect(instance.counter('telemetry.export.dropped.permanent')).toBe(0);
    }
  });

  it('permanently drops batches with invalid partial-success counts', () => {
    for (const rejectedDataPoints of [-1, 4]) {
      const instance = exporter();
      for (let index = 0; index < 3; index += 1) {
        instance.enqueue(input());
      }
      const request = requiredRequest(instance);
      instance.settle(request.requestId, {
        kind: 'http',
        status: 200,
        rejectedDataPoints
      }, 0);
      expect(instance.counter('telemetry.export.exported')).toBe(0);
      expect(instance.counter('telemetry.export.dropped.partial')).toBe(0);
      expect(instance.counter('telemetry.export.dropped.permanent')).toBe(3);
    }
  });

  it('clears and latches on both 401 and 403 until explicitly resumed', () => {
    for (const status of [401, 403]) {
      const instance = exporter();
      instance.enqueue(input());
      instance.enqueue(input());
      const request = requiredRequest(instance);
      instance.enqueue(input());
      instance.settle(request.requestId, { kind: 'http', status }, 0);
      expect(instance.counter('telemetry.export.dropped.authorization')).toBe(3);
      expect(instance.next(1)).toBeNull();
      expect(instance.enqueue(input())).toBe(false);
      expect(instance.counter('telemetry.export.dropped.authorization')).toBe(4);
      instance.resumeAfterAuthorizationChange();
      expect(instance.enqueue(input())).toBe(true);
      expect(instance.next(1)).not.toBeNull();
    }
  });
});

describe('shutdown, disposal, counters, and secrecy', () => {
  it('drains during shutdown and drops retained work at 5000ms', () => {
    const instance = exporter();
    instance.enqueue(input());
    instance.beginShutdown(10);
    expect(instance.enqueue(input())).toBe(false);
    const request = requiredRequest(instance, 11);
    expect(instance.next(5_009)).toBeNull();
    expect(instance.next(5_010)).toBeNull();
    instance.settle(request.requestId, { kind: 'http', status: 200 }, 5_010);
    expect(instance.counter('telemetry.export.dropped.shutdown')).toBe(2);
    expect(instance.counter('telemetry.export.exported')).toBe(0);
  });

  it('disposes idempotently and makes all later settlement inert', () => {
    const instance = exporter();
    instance.enqueue(input());
    const request = requiredRequest(instance);
    instance.dispose();
    instance.dispose();
    instance.settle(request.requestId, { kind: 'http', status: 200 }, 0);
    expect(instance.next(0)).toBeNull();
    expect(instance.counter('telemetry.export.dropped.shutdown')).toBe(1);
    expect(instance.counter('telemetry.export.exported')).toBe(0);
  });

  it('returns fresh frozen null-prototype snapshots with exactly the counter vocabulary', () => {
    const instance = exporter();
    instance.enqueue(input());
    const first = instance.counterSnapshot();
    const second = instance.counterSnapshot();
    expect(first).not.toBe(second);
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(first)).toEqual(TELEMETRY_EXPORT_COUNTERS);
    expect(first['telemetry.export.accepted']).toBe(1);
  });

  it('never places hostile canaries in requests, rejection text, or public state', () => {
    const instance = exporter();
    try {
      instance.enqueue({ ...input(), safe: { message: CANARY } });
      expect.fail('expected rejection');
    } catch (error: unknown) {
      expect(String(error)).not.toContain(CANARY);
    }
    instance.enqueue(input(undefined, {
      correlationId: HASH,
      errorCategory: 'unknown',
      errorId: 'unknown_failure'
    }));
    const request = requiredRequest(instance);
    expect(JSON.stringify({ request, counters: instance.counterSnapshot() })).not.toContain(CANARY);
    expect(request.body).not.toContain(HASH);
  });
});
