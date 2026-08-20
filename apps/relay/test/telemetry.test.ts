import { readFile } from 'node:fs/promises';

import { AzureMonitorMetricExporter } from '@azure/monitor-opentelemetry-exporter';
import { type TokenCredential } from '@azure/identity';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  DEPLOYMENT_SLOTS,
  ERROR_CATEGORIES,
  GATE_DECISIONS,
  RECONNECT_REASONS,
  TARGET_LANGUAGES,
  TELEMETRY_METRIC_NAMES,
  TELEMETRY_OPERATIONS,
  TELEMETRY_OUTCOMES,
  TELEMETRY_PROTOCOL_VERSION,
  type TelemetryMetricName
} from '@palancar/telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AZURE_MONITOR_TOKEN_SCOPE,
  AZURE_MONITOR_STATSBEAT_HOST_PREREQUISITES,
  RelayMetricSinkConfigurationError,
  createDisabledRelayMetricSink,
  createProductionRelayMetricSink,
  isDisabledRelayMetricSink,
  type RelayMetricSinkConfig
} from '../src/telemetry.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_STRING =
  'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
  'IngestionEndpoint=https://westus-0.in.applicationinsights.azure.com/';
const NORMALIZED_CONNECTION_STRING = CONNECTION_STRING.slice(0, -1);
const TIMESTAMP = '2026-08-19T12:34:56.789Z';
const HASH = `sha256:${'a'.repeat(64)}`;
const LATENCY_NAMES = new Set<TelemetryMetricName>([
  TELEMETRY_METRIC_NAMES.TRANSCRIPTION_FIRST_PARTIAL_LATENCY,
  TELEMETRY_METRIC_NAMES.TRANSCRIPTION_FINAL_LATENCY,
  TELEMETRY_METRIC_NAMES.TRANSLATION_LATENCY,
  TELEMETRY_METRIC_NAMES.SUGGESTION_LATENCY
]);
const AUDIO_NAMES = new Set<TelemetryMetricName>([
  TELEMETRY_METRIC_NAMES.AUDIO_ACCEPTED_SAMPLES,
  TELEMETRY_METRIC_NAMES.AUDIO_DUPLICATE_SAMPLES,
  TELEMETRY_METRIC_NAMES.AUDIO_REJECTED_SAMPLES
]);

type Runtime = NonNullable<Parameters<typeof createProductionRelayMetricSink>[1]>;
type Exporter = ReturnType<Runtime['createExporter']>;
type ExportCallback = Parameters<Exporter['export']>[1];
type ExportResult = Parameters<ExportCallback>[0];

interface Measurement {
  readonly kind: 'counter' | 'histogram';
  readonly name: string;
  readonly value: number;
  readonly attributes: Readonly<Record<string, string | number>> | undefined;
}

interface HarnessOptions {
  readonly throwFromInstrument?: boolean;
  readonly forceFlush?: () => Promise<void>;
  readonly shutdown?: () => Promise<void>;
  readonly setTimer?: Runtime['setTimer'];
  readonly clearTimer?: Runtime['clearTimer'];
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function validConfig(connectionString = CONNECTION_STRING): RelayMetricSinkConfig {
  return Object.freeze({
    clientId: CLIENT_ID,
    deploymentSlot: DEPLOYMENT_SLOTS.DEV,
    connectionString,
    applicationInsightsStatsbeatDisabled: true,
    applicationInsightsNoStatsbeat: true
  });
}

function recordFor(name: TelemetryMetricName): Record<string, unknown> {
  const record: Record<string, unknown> = {
    name,
    timestamp: TIMESTAMP,
    deploymentSlot: DEPLOYMENT_SLOTS.DEV
  };
  if (LATENCY_NAMES.has(name)) {
    record.durationMs = 25;
  } else if (AUDIO_NAMES.has(name)) {
    record.sampleCount = 160;
  } else {
    record.count = 3;
  }
  return record;
}

function coreSessionRecord(
  name:
    | typeof TELEMETRY_METRIC_NAMES.SESSION_START
    | typeof TELEMETRY_METRIC_NAMES.SESSION_END
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    name,
    timestamp: TIMESTAMP,
    count: 1,
    protocolVersion: TELEMETRY_PROTOCOL_VERSION,
    targetLanguage: TARGET_LANGUAGES.ES,
    operation: TELEMETRY_OPERATIONS.SESSION,
    outcome:
      name === TELEMETRY_METRIC_NAMES.SESSION_START
        ? TELEMETRY_OUTCOMES.SUCCESS
        : TELEMETRY_OUTCOMES.COMPLETED
  });
}

function createHarness(options: HarnessOptions = {}): Readonly<{
  runtime: Runtime;
  measurements: Measurement[];
  counters: Map<string, Readonly<{ unit: string }>>;
  histograms: Map<string, Readonly<{ unit: string }>>;
  credentialGetToken: ReturnType<typeof vi.fn>;
  createCredential: ReturnType<typeof vi.fn>;
  createExporter: ReturnType<typeof vi.fn>;
  exporterExport: ReturnType<typeof vi.fn>;
  createResource: ReturnType<typeof vi.fn>;
  createReader: ReturnType<typeof vi.fn>;
  createProvider: ReturnType<typeof vi.fn>;
  forceFlush: ReturnType<typeof vi.fn>;
  providerShutdown: ReturnType<typeof vi.fn>;
  getMeter: ReturnType<typeof vi.fn>;
  resourceAttributes: () => Readonly<Record<string, string>> | undefined;
  providerOptions: () => Parameters<Runtime['createProvider']>[0] | undefined;
  readerOptions: () => Parameters<Runtime['createReader']>[0] | undefined;
  exporterOptions: () => Parameters<Runtime['createExporter']>[0] | undefined;
  beginExport: () => Readonly<{
    complete: (result: ExportResult) => void;
    downstream: ReturnType<typeof vi.fn>;
  }>;
}> {
  const measurements: Measurement[] = [];
  const counters = new Map<string, Readonly<{ unit: string }>>();
  const histograms = new Map<string, Readonly<{ unit: string }>>();
  let capturedResourceAttributes: Readonly<Record<string, string>> | undefined;
  let capturedProviderOptions: Parameters<Runtime['createProvider']>[0] | undefined;
  let capturedReaderOptions: Parameters<Runtime['createReader']>[0] | undefined;
  let capturedExporterOptions: Parameters<Runtime['createExporter']>[0] | undefined;
  let exportCallback: ExportCallback | undefined;

  const credentialGetToken = vi.fn<TokenCredential['getToken']>(() =>
    Promise.resolve({ token: 'fake-token', expiresOnTimestamp: 1 })
  );
  const credential: TokenCredential = { getToken: credentialGetToken };
  const createCredential = vi.fn<Runtime['createCredential']>(() => credential);
  const exporterExport = vi.fn<Exporter['export']>((_metrics, callback) => {
    exportCallback = callback;
  });
  const exporter: Exporter = {
    export: exporterExport,
    forceFlush: vi.fn(() => Promise.resolve()),
    shutdown: vi.fn(() => Promise.resolve())
  };
  const createExporter = vi.fn<Runtime['createExporter']>((exporterOptions) => {
    capturedExporterOptions = exporterOptions;
    return exporter;
  });
  const forceFlush = vi.fn(options.forceFlush ?? (() => Promise.resolve()));
  const providerShutdown = vi.fn(options.shutdown ?? (() => Promise.resolve()));
  const meter = {
    createCounter(name: string, instrumentOptions: Readonly<{ unit: string }>) {
      counters.set(name, instrumentOptions);
      return {
        add(value: number, attributes?: Readonly<Record<string, string | number>>) {
          if (options.throwFromInstrument === true) {
            throw new Error('hostile-instrument-canary');
          }
          measurements.push({ kind: 'counter', name, value, attributes });
        }
      };
    },
    createHistogram(name: string, instrumentOptions: Readonly<{ unit: string }>) {
      histograms.set(name, instrumentOptions);
      return {
        record(value: number, attributes?: Readonly<Record<string, string | number>>) {
          if (options.throwFromInstrument === true) {
            throw new Error('hostile-instrument-canary');
          }
          measurements.push({ kind: 'histogram', name, value, attributes });
        }
      };
    }
  };
  const getMeter = vi.fn<ReturnType<Runtime['createProvider']>['getMeter']>(
    () => meter as ReturnType<ReturnType<Runtime['createProvider']>['getMeter']>
  );
  const provider = { getMeter, forceFlush, shutdown: providerShutdown };
  const createResource = vi.fn<Runtime['createResource']>((attributes) => {
    capturedResourceAttributes = attributes;
    return resourceFromAttributes(attributes);
  });
  const createReader = vi.fn<Runtime['createReader']>((readerOptions) => {
    capturedReaderOptions = readerOptions;
    return new PeriodicExportingMetricReader(readerOptions);
  });
  const createProvider = vi.fn<Runtime['createProvider']>((providerOptions) => {
    capturedProviderOptions = providerOptions;
    return provider;
  });
  const runtime: Runtime = {
    createCredential,
    createExporter,
    createResource,
    createReader,
    createProvider,
    now: () => Date.now(),
    setTimer: options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearTimer: options.clearTimer ?? ((handle) => clearTimeout(handle))
  };

  return Object.freeze({
    runtime,
    measurements,
    counters,
    histograms,
    credentialGetToken,
    createCredential,
    createExporter,
    exporterExport,
    createResource,
    createReader,
    createProvider,
    forceFlush,
    providerShutdown,
    getMeter,
    resourceAttributes: () => capturedResourceAttributes,
    providerOptions: () => capturedProviderOptions,
    readerOptions: () => capturedReaderOptions,
    exporterOptions: () => capturedExporterOptions,
    beginExport: () => {
      const readerOptions = capturedReaderOptions;
      if (readerOptions === undefined) {
        throw new Error('reader not created');
      }
      const downstream = vi.fn();
      readerOptions.exporter.export({} as Parameters<Exporter['export']>[0], downstream);
      return Object.freeze({
        complete: (result: ExportResult) => {
          if (exportCallback === undefined) {
            throw new Error('export not started');
          }
          exportCallback(result);
        },
        downstream
      });
    }
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('production relay metric sink construction', () => {
  it('creates the exact private resource, reader, exporter, and managed identity inputs', () => {
    const harness = createHarness();
    const spacedConnectionString = `  ${CONNECTION_STRING}  `;

    createProductionRelayMetricSink(validConfig(spacedConnectionString), harness.runtime);

    expect(harness.createCredential).toHaveBeenCalledOnce();
    expect(harness.createCredential).toHaveBeenCalledWith({ clientId: CLIENT_ID });
    expect(harness.createExporter).toHaveBeenCalledOnce();
    expect(harness.exporterOptions()).toEqual({
      credential: expect.any(Object),
      connectionString: NORMALIZED_CONNECTION_STRING,
      disableOfflineStorage: true,
      retryOptions: {
        maxRetries: 2,
        retryDelayInMs: 1_000,
        maxRetryDelayInMs: 2_000
      }
    });
    expect(harness.createReader).toHaveBeenCalledOnce();
    expect(harness.readerOptions()).toMatchObject({
      exportIntervalMillis: 60_000,
      exportTimeoutMillis: 5_000
    });
    expect(harness.createResource).toHaveBeenCalledOnce();
    expect(harness.resourceAttributes()).toEqual({
      'service.name': 'palancar-relay',
      'service.version': '0.1.0',
      'deployment.environment.name': 'dev'
    });
    expect(Object.keys(harness.resourceAttributes() ?? {})).toHaveLength(3);
    expect(harness.createProvider).toHaveBeenCalledOnce();
    expect(harness.providerOptions()?.readers).toHaveLength(1);
    expect(harness.getMeter).toHaveBeenCalledWith('@palancar/telemetry', '0.1.0');
    expect(AZURE_MONITOR_STATSBEAT_HOST_PREREQUISITES).toEqual({
      APPLICATIONINSIGHTS_STATSBEAT_DISABLED: 'true',
      APPLICATION_INSIGHTS_NO_STATSBEAT: 'true'
    });
  });

  it('creates exactly 19 closed instruments with only four histograms', () => {
    const harness = createHarness();
    createProductionRelayMetricSink(validConfig(), harness.runtime);

    const names = Object.values(TELEMETRY_METRIC_NAMES);
    expect(names).toHaveLength(19);
    expect(new Set([...harness.counters.keys(), ...harness.histograms.keys()])).toEqual(
      new Set(names)
    );
    expect(new Set(harness.histograms.keys())).toEqual(LATENCY_NAMES);
    expect(harness.histograms.size).toBe(4);
    expect(harness.counters.size).toBe(15);
    expect([...harness.histograms.values()]).toEqual(
      Array.from({ length: 4 }, () => ({ unit: 'ms' }))
    );
    expect([...harness.counters.values()]).toEqual(
      Array.from({ length: 15 }, () => ({ unit: '1' }))
    );
  });

  it('accepts and normalizes the classic public-cloud ingestion hostname', () => {
    const harness = createHarness();
    createProductionRelayMetricSink(
      validConfig(
        'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
          'IngestionEndpoint=https://dc.services.visualstudio.com/'
      ),
      harness.runtime
    );

    expect(harness.exporterOptions()?.connectionString).toBe(
      'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
        'IngestionEndpoint=https://dc.services.visualstudio.com'
    );
  });

  it('uses no global provider, automatic instrumentation, DefaultAzureCredential, or env mutation', async () => {
    const source = await readFile(new URL('../src/telemetry.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('setGlobalMeterProvider');
    expect(source).not.toContain('DefaultAzureCredential');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('tryTimeoutInMs');
    expect(source).not.toMatch(/auto.?instrument/i);
    expect(source.match(/new ManagedIdentityCredential/g)).toHaveLength(1);
  });

  it('rejects non-exact configuration before constructing credentials', () => {
    const invalidConfigs: readonly unknown[] = [
      null,
      {
        clientId: CLIENT_ID,
        deploymentSlot: DEPLOYMENT_SLOTS.DEV,
        connectionString: CONNECTION_STRING
      },
      { ...validConfig(), clientId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
      { ...validConfig(), clientId: '00000000-0000-0000-0000-000000000000' },
      { ...validConfig(), deploymentSlot: 'qa' },
      { ...validConfig(), applicationInsightsStatsbeatDisabled: false },
      { ...validConfig(), applicationInsightsNoStatsbeat: false },
      { ...validConfig(), connectionString: '' },
      { ...validConfig(), connectionString: `${CONNECTION_STRING}\ncanary` },
      { ...validConfig(), connectionString: `${CONNECTION_STRING}\0canary` },
      {
        ...validConfig(),
        connectionString:
          'InstrumentationKey=not-a-uuid;IngestionEndpoint=https://example.test/'
      },
      {
        ...validConfig(),
        connectionString:
          'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
          'IngestionEndpoint=http://example.test/'
      },
      {
        ...validConfig(),
        connectionString:
          'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
          'IngestionEndpoint=https://evil.example.test/'
      },
      {
        ...validConfig(),
        connectionString:
          'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
          'IngestionEndpoint=https://westus-0.in.applicationinsights.azure.com:443/'
      },
      {
        ...validConfig(),
        connectionString:
          'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
          'IngestionEndpoint=https://westus-0.in.applicationinsights.azure.com/path'
      },
      {
        ...validConfig(),
        connectionString:
          'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
          'IngestionEndpoint=https://westus-0.in.applicationinsights.azure.com;' +
          'AADAudience=https://monitor.azure.com'
      },
      {
        ...validConfig(),
        connectionString:
          'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
          'IngestionEndpoint=https://westus-0.in.applicationinsights.azure.com;' +
          'LiveEndpoint=https://westus.livediagnostics.monitor.azure.com'
      },
      {
        ...validConfig(),
        connectionString:
          'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
          'InstrumentationKey=11111111-1111-1111-1111-111111111111;' +
          'IngestionEndpoint=https://westus-0.in.applicationinsights.azure.com'
      },
      {
        ...validConfig(),
        connectionString:
          'instrumentationkey=00000000-0000-0000-0000-000000000000;' +
          'IngestionEndpoint=https://westus-0.in.applicationinsights.azure.com'
      },
      {
        ...validConfig(),
        connectionString: `${CONNECTION_STRING}Extra=${'x'.repeat(2_048)}`
      },
      { ...validConfig(), extra: true },
      new Proxy(validConfig(), {})
    ];

    for (const invalidConfig of invalidConfigs) {
      const harness = createHarness();
      expect(() =>
        createProductionRelayMetricSink(invalidConfig as never, harness.runtime)
      ).toThrow(RelayMetricSinkConfigurationError);
      expect(harness.createCredential).not.toHaveBeenCalled();
    }
  });

  it('keeps connection strings and SDK initialization failures secret', () => {
    const canary =
      'InstrumentationKey=not-a-secret-canary;IngestionEndpoint=https://secret.example.test/';
    const invalidHarness = createHarness();
    let invalidError: unknown;
    try {
      createProductionRelayMetricSink(validConfig(canary), invalidHarness.runtime);
    } catch (error) {
      invalidError = error;
    }
    expect(String(invalidError)).not.toContain(canary);
    expect(String(invalidError)).not.toContain('secret.example.test');

    const initializationHarness = createHarness();
    initializationHarness.createExporter.mockImplementation(() => {
      throw new Error(CONNECTION_STRING);
    });
    let initializationError: unknown;
    try {
      createProductionRelayMetricSink(validConfig(), initializationHarness.runtime);
    } catch (error) {
      initializationError = error;
    }
    expect(initializationError).toMatchObject({ reason: 'initialization-failed' });
    expect(String(initializationError)).not.toContain(CONNECTION_STRING);
  });

  it('matches the pinned exporter connection normalization and Statsbeat contract', async () => {
    const statsbeatDisabled = process.env.APPLICATIONINSIGHTS_STATSBEAT_DISABLED;
    const noStatsbeat = process.env.APPLICATION_INSIGHTS_NO_STATSBEAT;
    process.env.APPLICATIONINSIGHTS_STATSBEAT_DISABLED = 'true';
    process.env.APPLICATION_INSIGHTS_NO_STATSBEAT = 'true';
    try {
      const harness = createHarness();
      createProductionRelayMetricSink(validConfig(), harness.runtime);
      const options = harness.exporterOptions();
      if (options === undefined) {
        throw new Error('exporter options not captured');
      }
      const exporter = new AzureMonitorMetricExporter(options);

      expect(Object.getOwnPropertyDescriptor(exporter, 'endpointUrl')?.value).toBe(
        'https://westus-0.in.applicationinsights.azure.com'
      );
      expect(Object.getOwnPropertyDescriptor(exporter, 'trackStatsbeat')?.value).toBe(false);
      expect(options.retryOptions).toEqual({
        maxRetries: 2,
        retryDelayInMs: 1_000,
        maxRetryDelayInMs: 2_000
      });
      expect(process.env.APPLICATIONINSIGHTS_STATSBEAT_DISABLED).toBe('true');
      expect(process.env.APPLICATION_INSIGHTS_NO_STATSBEAT).toBe('true');
      await exporter.shutdown();

      const productionSink = createProductionRelayMetricSink(validConfig());
      await productionSink.shutdown();
    } finally {
      if (statsbeatDisabled === undefined) {
        delete process.env.APPLICATIONINSIGHTS_STATSBEAT_DISABLED;
      } else {
        process.env.APPLICATIONINSIGHTS_STATSBEAT_DISABLED = statsbeatDisabled;
      }
      if (noStatsbeat === undefined) {
        delete process.env.APPLICATION_INSIGHTS_NO_STATSBEAT;
      } else {
        process.env.APPLICATION_INSIGHTS_NO_STATSBEAT = noStatsbeat;
      }
    }
  });
});

describe('record', () => {
  it.each([
    {
      name: TELEMETRY_METRIC_NAMES.SESSION_START,
      outcome: TELEMETRY_OUTCOMES.SUCCESS
    },
    {
      name: TELEMETRY_METRIC_NAMES.SESSION_END,
      outcome: TELEMETRY_OUTCOMES.COMPLETED
    }
  ])('adds the trusted deployment slot to exact core $name records', ({ name, outcome }) => {
    const harness = createHarness();
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);

    sink.record(coreSessionRecord(name));

    expect(harness.measurements).toEqual([
      {
        kind: 'counter',
        name,
        value: 1,
        attributes: {
          'palancar.protocol.version': TELEMETRY_PROTOCOL_VERSION,
          'palancar.target_language': TARGET_LANGUAGES.ES,
          'palancar.operation': TELEMETRY_OPERATIONS.SESSION,
          'palancar.outcome': outcome
        }
      }
    ]);
  });

  it('accepts only an exact matching own deployment-slot data property', () => {
    const harness = createHarness();
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);
    const matching = {
      ...coreSessionRecord(TELEMETRY_METRIC_NAMES.SESSION_START),
      deploymentSlot: DEPLOYMENT_SLOTS.DEV
    };

    sink.record(matching);

    expect(harness.measurements).toHaveLength(1);
    expect(harness.measurements[0]).toMatchObject({
      kind: 'counter',
      name: TELEMETRY_METRIC_NAMES.SESSION_START,
      value: 1
    });
  });

  it('drops invalid deployment slots and malformed roots without invoking accessors', () => {
    const harness = createHarness();
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);
    let deploymentSlotReads = 0;
    let nameReads = 0;
    const slotAccessor = {
      ...coreSessionRecord(TELEMETRY_METRIC_NAMES.SESSION_START)
    };
    Object.defineProperty(slotAccessor, 'deploymentSlot', {
      enumerable: true,
      get() {
        deploymentSlotReads += 1;
        return DEPLOYMENT_SLOTS.DEV;
      }
    });
    const nameAccessor = {
      timestamp: TIMESTAMP,
      count: 1,
      protocolVersion: TELEMETRY_PROTOCOL_VERSION,
      operation: TELEMETRY_OPERATIONS.SESSION,
      outcome: TELEMETRY_OUTCOMES.SUCCESS
    };
    Object.defineProperty(nameAccessor, 'name', {
      enumerable: true,
      get() {
        nameReads += 1;
        return TELEMETRY_METRIC_NAMES.SESSION_START;
      }
    });
    const symbolKey = {
      ...coreSessionRecord(TELEMETRY_METRIC_NAMES.SESSION_START)
    };
    Object.defineProperty(symbolKey, Symbol('forbidden'), {
      value: true
    });
    const core = coreSessionRecord(TELEMETRY_METRIC_NAMES.SESSION_START);
    const invalid: readonly unknown[] = [
      { ...core, deploymentSlot: DEPLOYMENT_SLOTS.STAGING },
      { ...core, deploymentSlot: null },
      { ...core, deploymentSlot: undefined },
      { ...core, deploymentSlot: Symbol('dev') },
      slotAccessor,
      nameAccessor,
      symbolKey,
      new Proxy(core, {}),
      { ...core, correlationId: HASH },
      { name: TELEMETRY_METRIC_NAMES.SESSION_START }
    ];

    for (const input of invalid) {
      expect(() => sink.record(input)).not.toThrow();
    }

    expect(deploymentSlotReads).toBe(0);
    expect(nameReads).toBe(0);
    expect(harness.measurements).toHaveLength(0);
  });

  it('records the sanitizer-defined values for every closed metric name', () => {
    const harness = createHarness();
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);

    for (const name of Object.values(TELEMETRY_METRIC_NAMES)) {
      sink.record(recordFor(name));
    }

    expect(harness.measurements).toHaveLength(19);
    for (const measurement of harness.measurements) {
      const name = measurement.name as TelemetryMetricName;
      expect(measurement.kind).toBe(LATENCY_NAMES.has(name) ? 'histogram' : 'counter');
      expect(measurement.value).toBe(
        LATENCY_NAMES.has(name) ? 25 : AUDIO_NAMES.has(name) ? 160 : 3
      );
    }
  });

  it('defaults ordinary counters to one without fabricating latency, audio, or zero values', () => {
    const harness = createHarness();
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);

    sink.record({
      name: TELEMETRY_METRIC_NAMES.SESSION_START,
      timestamp: TIMESTAMP,
      deploymentSlot: DEPLOYMENT_SLOTS.DEV
    });
    sink.record({
      name: TELEMETRY_METRIC_NAMES.TRANSLATION_LATENCY,
      timestamp: TIMESTAMP,
      deploymentSlot: DEPLOYMENT_SLOTS.DEV,
      durationMs: 0
    });
    sink.record({
      name: TELEMETRY_METRIC_NAMES.AUDIO_ACCEPTED_SAMPLES,
      timestamp: TIMESTAMP,
      deploymentSlot: DEPLOYMENT_SLOTS.DEV,
      sampleCount: 0
    });
    sink.record({
      name: TELEMETRY_METRIC_NAMES.SESSION_END,
      timestamp: TIMESTAMP,
      deploymentSlot: DEPLOYMENT_SLOTS.DEV,
      count: 0
    });

    expect(harness.measurements.map(({ name, value }) => [name, value])).toEqual([
      [TELEMETRY_METRIC_NAMES.SESSION_START, 1],
      [TELEMETRY_METRIC_NAMES.TRANSLATION_LATENCY, 0]
    ]);
  });

  it('exports only the exact point-attribute allow-list', () => {
    const harness = createHarness();
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);

    sink.record({
      name: TELEMETRY_METRIC_NAMES.TRANSPORT_RECONNECT,
      timestamp: TIMESTAMP,
      deploymentSlot: DEPLOYMENT_SLOTS.DEV,
      count: 2,
      protocolVersion: TELEMETRY_PROTOCOL_VERSION,
      targetLanguage: TARGET_LANGUAGES.ES,
      gateDecision: GATE_DECISIONS.TARGET,
      operation: TELEMETRY_OPERATIONS.TRANSPORT,
      outcome: TELEMETRY_OUTCOMES.RECONNECTED,
      providerId: 'azure-realtime',
      providerVersion: 'ga-transcription-websocket',
      reconnectReason: RECONNECT_REASONS.NETWORK
    });

    expect(harness.measurements).toHaveLength(1);
    expect(harness.measurements[0]?.attributes).toEqual({
      'palancar.protocol.version': 1,
      'palancar.target_language': 'es',
      'palancar.gate_decision': 'target',
      'palancar.operation': 'transport',
      'palancar.outcome': 'reconnected',
      'palancar.provider.id': 'azure-realtime',
      'palancar.provider.version': 'ga-transcription-websocket',
      'palancar.reconnect.reason': 'network'
    });
    expect(Object.keys(harness.measurements[0]?.attributes ?? {})).toHaveLength(8);
  });

  it('drops every non-production root key before sanitization instead of stripping it', () => {
    const forbiddenFields: Readonly<Record<string, unknown>> = {
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
      errorCategory: ERROR_CATEGORIES.UNKNOWN,
      errorId: 'unknown_failure',
      content: 'private-content-canary',
      id: 'private-id-canary',
      endpoint: 'https://private.example.test',
      url: 'https://private.example.test',
      extra: true
    };

    for (const [field, value] of Object.entries(forbiddenFields)) {
      const harness = createHarness();
      const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);
      expect(() =>
        sink.record({
          ...recordFor(TELEMETRY_METRIC_NAMES.SESSION_START),
          [field]: value
        })
      ).not.toThrow();
      expect(harness.measurements, field).toHaveLength(0);
    }

    const harness = createHarness();
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);
    let getterReads = 0;
    const rejectedBeforeSanitization = {
      ...recordFor(TELEMETRY_METRIC_NAMES.SESSION_START),
      correlationId: HASH
    };
    Object.defineProperty(rejectedBeforeSanitization, 'name', {
      enumerable: true,
      get() {
        getterReads += 1;
        return TELEMETRY_METRIC_NAMES.SESSION_START;
      }
    });
    sink.record(rejectedBeforeSanitization);
    expect(getterReads).toBe(0);
    expect(harness.measurements).toHaveLength(0);
  });

  it('is nonthrowing for hostile inputs, forbidden fields, and SDK errors', () => {
    const harness = createHarness({ throwFromInstrument: true });
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);
    const accessor = Object.defineProperty({}, 'name', {
      get() {
        throw new Error('hostile-accessor-canary');
      }
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    for (const input of [
      null,
      new Proxy({}, { ownKeys: () => { throw new Error('proxy-canary'); } }),
      accessor,
      cyclic,
      { ...recordFor(TELEMETRY_METRIC_NAMES.SESSION_START), content: 'private' },
      recordFor(TELEMETRY_METRIC_NAMES.SESSION_START)
    ]) {
      expect(() => sink.record(input)).not.toThrow();
    }
    expect(harness.measurements).toHaveLength(0);
  });
});

describe('readiness', () => {
  it('preflights the managed identity scope and emits no synthetic metric', async () => {
    const harness = createHarness();
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);

    await expect(sink.checkReadiness()).resolves.toBe(true);

    expect(harness.credentialGetToken).toHaveBeenCalledOnce();
    expect(harness.credentialGetToken.mock.calls[0]?.[0]).toBe(AZURE_MONITOR_TOKEN_SCOPE);
    expect(harness.credentialGetToken.mock.calls[0]?.[1]).toMatchObject({
      abortSignal: expect.any(AbortSignal)
    });
    expect(AZURE_MONITOR_TOKEN_SCOPE).toBe('https://monitor.azure.com/.default');
    expect(harness.measurements).toHaveLength(0);
  });

  it('honors already-aborted and in-flight cancellation', async () => {
    const alreadyAbortedHarness = createHarness();
    const alreadyAbortedSink = createProductionRelayMetricSink(
      validConfig(),
      alreadyAbortedHarness.runtime
    );
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(alreadyAbortedSink.checkReadiness(alreadyAborted.signal)).resolves.toBe(false);
    expect(alreadyAbortedHarness.credentialGetToken).not.toHaveBeenCalled();

    const pending = deferred<never>();
    const activeHarness = createHarness();
    activeHarness.credentialGetToken.mockReturnValue(pending.promise);
    const activeSink = createProductionRelayMetricSink(validConfig(), activeHarness.runtime);
    const caller = new AbortController();
    const readiness = activeSink.checkReadiness(caller.signal);
    await Promise.resolve();
    const credentialSignal = activeHarness.credentialGetToken.mock.calls[0]?.[1]
      ?.abortSignal as AbortSignal;
    caller.abort();

    await expect(readiness).resolves.toBe(false);
    expect(credentialSignal.aborted).toBe(true);
  });

  it('fails closed at the five-second token timeout even when the credential ignores abort', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pending = deferred<never>();
    const harness = createHarness();
    harness.credentialGetToken.mockReturnValue(pending.promise);
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);

    const readiness = sink.checkReadiness();
    await Promise.resolve();
    const credentialSignal = harness.credentialGetToken.mock.calls[0]?.[1]
      ?.abortSignal as AbortSignal;
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(readiness).resolves.toBe(false);
    expect(credentialSignal.aborted).toBe(true);
  });

  it('latches actual failed exports and restores readiness only on actual success', async () => {
    const harness = createHarness();
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);
    await expect(sink.checkReadiness()).resolves.toBe(true);

    const failed = harness.beginExport();
    const failedResult = { code: 1 } as ExportResult;
    failed.complete(failedResult);
    expect(failed.downstream).toHaveBeenCalledWith(failedResult);
    await expect(sink.checkReadiness()).resolves.toBe(false);

    const ignored = harness.beginExport();
    ignored.complete({ code: 99 } as unknown as ExportResult);
    await expect(sink.checkReadiness()).resolves.toBe(false);

    const succeeded = harness.beginExport();
    succeeded.complete({ code: 0 } as ExportResult);
    await expect(sink.checkReadiness()).resolves.toBe(true);
  });

  it('latches synchronous exporter throws and callback watchdog timeouts exactly once', async () => {
    const throwingHarness = createHarness();
    const throwingSink = createProductionRelayMetricSink(
      validConfig(),
      throwingHarness.runtime
    );
    await expect(throwingSink.checkReadiness()).resolves.toBe(true);
    throwingHarness.exporterExport.mockImplementation(() => {
      throw new Error('sync-export-canary');
    });

    const thrown = throwingHarness.beginExport();
    expect(thrown.downstream).toHaveBeenCalledOnce();
    expect(thrown.downstream).toHaveBeenCalledWith({ code: 1 });
    await expect(throwingSink.checkReadiness()).resolves.toBe(false);

    const rejectingHarness = createHarness();
    const rejectingSink = createProductionRelayMetricSink(
      validConfig(),
      rejectingHarness.runtime
    );
    await expect(rejectingSink.checkReadiness()).resolves.toBe(true);
    rejectingHarness.exporterExport.mockRejectedValue(new Error('async-export-canary'));
    const rejected = rejectingHarness.beginExport();
    await Promise.resolve();
    expect(rejected.downstream).toHaveBeenCalledOnce();
    expect(rejected.downstream).toHaveBeenCalledWith({ code: 1 });
    await expect(rejectingSink.checkReadiness()).resolves.toBe(false);

    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timeoutHarness = createHarness();
    const timeoutSink = createProductionRelayMetricSink(validConfig(), timeoutHarness.runtime);
    await expect(timeoutSink.checkReadiness()).resolves.toBe(true);
    const timedOut = timeoutHarness.beginExport();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(timedOut.downstream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut.downstream).toHaveBeenCalledOnce();
    expect(timedOut.downstream).toHaveBeenCalledWith({ code: 1 });
    await expect(timeoutSink.checkReadiness()).resolves.toBe(false);

    timedOut.complete({ code: 0 } as ExportResult);
    expect(timedOut.downstream).toHaveBeenCalledOnce();
    await expect(timeoutSink.checkReadiness()).resolves.toBe(false);
  });

  it('uses EventTarget prototypes and closes the post-registration abort race', async () => {
    const shadowedHarness = createHarness();
    const shadowedSink = createProductionRelayMetricSink(validConfig(), shadowedHarness.runtime);
    const shadowed = new AbortController();
    Object.defineProperty(shadowed.signal, 'addEventListener', {
      value: () => {
        throw new Error('shadowed-add-listener-canary');
      }
    });
    Object.defineProperty(shadowed.signal, 'removeEventListener', {
      value: () => {
        throw new Error('shadowed-remove-listener-canary');
      }
    });
    await expect(shadowedSink.checkReadiness(shadowed.signal)).resolves.toBe(true);

    const racingHarness = createHarness();
    const racingSink = createProductionRelayMetricSink(validConfig(), racingHarness.runtime);
    const racing = new AbortController();
    const originalAdd = EventTarget.prototype.addEventListener;
    vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ): void {
      originalAdd.call(this, type, callback, options);
      if (this === racing.signal && type === 'abort') {
        racing.abort();
      }
    });

    await expect(racingSink.checkReadiness(racing.signal)).resolves.toBe(false);
    expect(racingHarness.credentialGetToken).not.toHaveBeenCalled();
  });

  it('shutdown immediately aborts every active readiness credential request', async () => {
    const pending = deferred<never>();
    const harness = createHarness();
    harness.credentialGetToken.mockReturnValue(pending.promise);
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);
    const first = sink.checkReadiness();
    const second = sink.checkReadiness();
    await Promise.resolve();
    const firstSignal = harness.credentialGetToken.mock.calls[0]?.[1]
      ?.abortSignal as AbortSignal;
    const secondSignal = harness.credentialGetToken.mock.calls[1]?.[1]
      ?.abortSignal as AbortSignal;

    const shutdown = sink.shutdown();
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(true);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('maps hostile credential behavior and shutdown state to false', async () => {
    const harness = createHarness();
    harness.credentialGetToken.mockImplementation(() => {
      throw new Error(CONNECTION_STRING);
    });
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);

    await expect(sink.checkReadiness()).resolves.toBe(false);
    await sink.shutdown();
    await expect(sink.checkReadiness()).resolves.toBe(false);
  });
});

describe('shutdown and disabled sink', () => {
  it('seals immediately and shares one five-second deadline across flush and shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const neverFlushes = deferred<void>();
    const neverShutsDown = deferred<void>();
    const harness = createHarness({
      forceFlush: () => neverFlushes.promise,
      shutdown: () => neverShutsDown.promise
    });
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);
    const first = sink.shutdown();
    const second = sink.shutdown();

    expect(second).toBe(first);
    sink.record(recordFor(TELEMETRY_METRIC_NAMES.SESSION_START));
    expect(harness.measurements).toHaveLength(0);
    await Promise.resolve();
    expect(harness.forceFlush).toHaveBeenCalledOnce();
    expect(harness.forceFlush).toHaveBeenCalledWith({ timeoutMillis: 5_000 });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.providerShutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toBeUndefined();
    expect(harness.forceFlush).toHaveBeenCalledOnce();
    expect(harness.providerShutdown).toHaveBeenCalledOnce();
    expect(harness.providerShutdown).toHaveBeenCalledWith({ timeoutMillis: 0 });
  });

  it('uses the remaining shared deadline when flush completes and swallows secret failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness({
      forceFlush: () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000);
        }),
      shutdown: () => Promise.reject(new Error(CONNECTION_STRING))
    });
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);
    const shutdown = sink.shutdown();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.providerShutdown).toHaveBeenCalledWith({ timeoutMillis: 3_000 });
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('cleans synchronously firing timer handles across readiness, export, and shutdown', async () => {
    vi.useFakeTimers();
    const clearTimer = vi.fn<Runtime['clearTimer']>((handle) => clearTimeout(handle));
    const harness = createHarness({
      setTimer: (callback) => {
        callback();
        return setTimeout(() => undefined, 10_000);
      },
      clearTimer
    });
    const sink = createProductionRelayMetricSink(validConfig(), harness.runtime);

    await expect(sink.checkReadiness()).resolves.toBe(false);
    expect(harness.credentialGetToken).not.toHaveBeenCalled();
    const exported = harness.beginExport();
    expect(exported.downstream).toHaveBeenCalledOnce();
    expect(harness.exporterExport).not.toHaveBeenCalled();
    await expect(sink.shutdown()).resolves.toBeUndefined();

    expect(clearTimer).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('provides a stable disabled sink that never records and reports locally healthy', async () => {
    const first = createDisabledRelayMetricSink();
    const second = createDisabledRelayMetricSink();

    expect(second).toBe(first);
    expect(() => first.record(new Proxy({}, {}))).not.toThrow();
    await expect(first.checkReadiness()).resolves.toBe(true);
    await expect(first.shutdown()).resolves.toBeUndefined();
    await expect(first.shutdown()).resolves.toBeUndefined();
  });

  it('classifies the disabled singleton and every finite inherited wrapper', () => {
    const disabled = createDisabledRelayMetricSink();
    const inherited = Object.create(disabled) as object;
    const deeplyInherited = Object.create(Object.create(inherited)) as object;

    expect(isDisabledRelayMetricSink(disabled)).toBe(true);
    expect(isDisabledRelayMetricSink(inherited)).toBe(true);
    expect(isDisabledRelayMetricSink(deeplyInherited)).toBe(true);
  });

  it('does not classify production sinks, test doubles, or primitive values as disabled', async () => {
    const harness = createHarness();
    const production = createProductionRelayMetricSink(validConfig(), harness.runtime);
    const fake = {
      record: () => undefined,
      checkReadiness: async () => true,
      shutdown: async () => undefined
    };

    expect(isDisabledRelayMetricSink(production)).toBe(false);
    expect(isDisabledRelayMetricSink(Object.create(production))).toBe(false);
    expect(isDisabledRelayMetricSink(fake)).toBe(false);
    expect(isDisabledRelayMetricSink(undefined)).toBe(false);
    expect(isDisabledRelayMetricSink('disabled')).toBe(false);
    await production.shutdown();
  });

  it('contains proxies, hostile prototype traversal, and prototype cycles', () => {
    const disabled = createDisabledRelayMetricSink();
    const getPrototypeOf = vi.fn(() => {
      throw new Error('hostile prototype canary');
    });
    const hostileProxy = new Proxy(Object.create(disabled) as object, { getPrototypeOf });
    const inheritedFromHostileProxy = Object.create(hostileProxy) as object;
    const revocable = Proxy.revocable(Object.create(disabled) as object, {});
    revocable.revoke();

    expect(() => isDisabledRelayMetricSink(hostileProxy)).not.toThrow();
    expect(isDisabledRelayMetricSink(hostileProxy)).toBe(false);
    expect(isDisabledRelayMetricSink(inheritedFromHostileProxy)).toBe(false);
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(() => isDisabledRelayMetricSink(revocable.proxy)).not.toThrow();
    expect(isDisabledRelayMetricSink(revocable.proxy)).toBe(false);

    const cyclic = {};
    const originalGetPrototypeOf = Object.getPrototypeOf;
    const prototypeSpy = vi.spyOn(Object, 'getPrototypeOf').mockImplementation((value) =>
      value === cyclic ? cyclic : originalGetPrototypeOf(value)
    );
    let cyclicResult: boolean;
    try {
      cyclicResult = isDisabledRelayMetricSink(cyclic);
    } finally {
      prototypeSpy.mockRestore();
    }
    expect(cyclicResult).toBe(false);
  });
});
