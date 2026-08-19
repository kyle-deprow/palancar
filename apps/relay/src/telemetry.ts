import { ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import {
  AzureMonitorMetricExporter,
  type AzureMonitorExporterOptions
} from '@azure/monitor-opentelemetry-exporter';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type IMetricReader,
  type PushMetricExporter,
  type ResourceMetrics
} from '@opentelemetry/sdk-metrics';
import {
  TELEMETRY_METRIC_NAMES,
  sanitizeTelemetryForExport,
  type DeploymentSlot,
  type SanitizedTelemetryRecord,
  type TelemetryMetricName
} from '@palancar/telemetry';
import { types as utilTypes } from 'node:util';

export const AZURE_MONITOR_TOKEN_SCOPE = 'https://monitor.azure.com/.default';

const SERVICE_NAME = 'palancar-relay';
const SERVICE_VERSION = '0.1.0';
const METER_NAME = '@palancar/telemetry';
const EXPORT_INTERVAL_MS = 60_000;
const EXPORT_TIMEOUT_MS = 5_000;
const READINESS_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXPORT_RESULT_SUCCESS = 0;
const EXPORT_RESULT_FAILED = 1;
const CANONICAL_LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTRUMENTATION_KEY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGIONAL_INGESTION_SUFFIX = '.in.applicationinsights.azure.com';
const CLASSIC_INGESTION_HOST = 'dc.services.visualstudio.com';
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const APPROVED_CONNECTION_STRING_KEYS = new Set(['InstrumentationKey', 'IngestionEndpoint']);
const EXPORT_RECORD_KEYS = new Set([
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
  'reconnectReason'
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
const CONNECTION_STRING_ENCODER = new TextEncoder();

type MetricAttributeValue = string | number;
type MetricAttributes = Readonly<Record<string, MetricAttributeValue>>;
type TimerHandle = ReturnType<typeof setTimeout>;
type RelayMeterProvider = Pick<MeterProvider, 'getMeter' | 'forceFlush' | 'shutdown'>;
type RelayMeter = ReturnType<RelayMeterProvider['getMeter']>;
type RelayCounter = ReturnType<RelayMeter['createCounter']>;
type RelayHistogram = ReturnType<RelayMeter['createHistogram']>;
type MetricExportResult = Parameters<Parameters<PushMetricExporter['export']>[1]>[0];

interface RelayMetricExporter extends Omit<PushMetricExporter, 'export'> {
  export(
    metrics: ResourceMetrics,
    resultCallback: Parameters<PushMetricExporter['export']>[1]
  ): void | Promise<void>;
}

interface RelayMetricSinkRuntime {
  createCredential(options: Readonly<{ clientId: string }>): TokenCredential;
  createExporter(options: AzureMonitorExporterOptions): RelayMetricExporter;
  createResource(attributes: Readonly<Record<string, string>>): Resource;
  createReader(options: Readonly<{
    exporter: PushMetricExporter;
    exportIntervalMillis: number;
    exportTimeoutMillis: number;
  }>): IMetricReader;
  createProvider(options: Readonly<{
    resource: Resource;
    readers: readonly IMetricReader[];
  }>): RelayMeterProvider;
  now(): number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export interface RelayMetricSinkConfig {
  readonly clientId: string;
  readonly deploymentSlot: DeploymentSlot;
  readonly connectionString: string;
  /** Must reflect APPLICATIONINSIGHTS_STATSBEAT_DISABLED=true, enforced by the host. */
  readonly applicationInsightsStatsbeatDisabled: boolean;
  /** Must reflect APPLICATION_INSIGHTS_NO_STATSBEAT=true, enforced by the host. */
  readonly applicationInsightsNoStatsbeat: boolean;
}

export const AZURE_MONITOR_STATSBEAT_HOST_PREREQUISITES = Object.freeze({
  APPLICATIONINSIGHTS_STATSBEAT_DISABLED: 'true',
  APPLICATION_INSIGHTS_NO_STATSBEAT: 'true'
});

export interface RelayMetricSink {
  record(input: unknown): void;
  checkReadiness(signal?: AbortSignal): Promise<boolean>;
  shutdown(): Promise<void>;
}

export type RelayMetricSinkConfigurationErrorReason = 'invalid-config' | 'initialization-failed';

/** Configuration failures deliberately contain no caller-provided values. */
export class RelayMetricSinkConfigurationError extends TypeError {
  readonly reason: RelayMetricSinkConfigurationErrorReason;

  constructor(reason: RelayMetricSinkConfigurationErrorReason) {
    super(
      reason === 'invalid-config'
        ? 'Invalid relay metric sink configuration.'
        : 'Unable to initialize relay metric sink.'
    );
    this.name = 'RelayMetricSinkConfigurationError';
    this.reason = reason;
  }
}

interface ValidatedConfig {
  readonly clientId: string;
  readonly deploymentSlot: DeploymentSlot;
  readonly connectionString: string;
}

type RelayInstrument =
  | Readonly<{ kind: 'counter'; instrument: RelayCounter }>
  | Readonly<{ kind: 'histogram'; instrument: RelayHistogram }>;

class ExportHealth {
  failed = false;

  observe(code: number): void {
    if (code === EXPORT_RESULT_FAILED) {
      this.failed = true;
    } else if (code === EXPORT_RESULT_SUCCESS) {
      this.failed = false;
    }
  }

  fail(): void {
    this.failed = true;
  }
}

interface OneShotTimer {
  cancel(): void;
}

const FAILED_EXPORT_RESULT: MetricExportResult = Object.freeze({
  code: EXPORT_RESULT_FAILED
});

function configurationError(reason: RelayMetricSinkConfigurationErrorReason): RelayMetricSinkConfigurationError {
  return new RelayMetricSinkConfigurationError(reason);
}

function descriptorValue(
  descriptors: PropertyDescriptorMap,
  key: keyof RelayMetricSinkConfig
): unknown {
  const descriptor = descriptors[key];
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    throw configurationError('invalid-config');
  }
  return descriptor.value;
}

function isDeploymentSlot(value: unknown): value is DeploymentSlot {
  return value === 'dev' || value === 'staging' || value === 'production';
}

function isApprovedIngestionHostname(hostname: string): boolean {
  if (hostname === CLASSIC_INGESTION_HOST) {
    return true;
  }
  if (!hostname.endsWith(REGIONAL_INGESTION_SUFFIX)) {
    return false;
  }
  const regionalPrefix = hostname.slice(0, -REGIONAL_INGESTION_SUFFIX.length);
  return (
    regionalPrefix.length > 0 &&
    regionalPrefix.split('.').every((label) => DNS_LABEL.test(label))
  );
}

function canonicalIngestionEndpoint(input: string): string {
  if (!/^https:\/\/[a-z0-9.-]+\/?$/u.test(input)) {
    throw configurationError('invalid-config');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(input);
  } catch {
    throw configurationError('invalid-config');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.hostname.length === 0 ||
    endpoint.hostname !== endpoint.hostname.toLowerCase() ||
    endpoint.port.length !== 0 ||
    endpoint.pathname !== '/' ||
    endpoint.username.length !== 0 ||
    endpoint.password.length !== 0 ||
    endpoint.search.length !== 0 ||
    endpoint.hash.length !== 0 ||
    !isApprovedIngestionHostname(endpoint.hostname)
  ) {
    throw configurationError('invalid-config');
  }
  return `https://${endpoint.hostname}`;
}

function validateConnectionString(input: unknown): string {
  if (typeof input !== 'string' || /[\r\n\0]/u.test(input)) {
    throw configurationError('invalid-config');
  }

  const connectionString = input.trim();
  const byteLength = CONNECTION_STRING_ENCODER.encode(connectionString).byteLength;
  if (byteLength < 1 || byteLength > 2_048) {
    throw configurationError('invalid-config');
  }

  const entries = new Map<string, string>();
  const segments = connectionString.split(';');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      throw configurationError('invalid-config');
    }
    if (segment.length === 0 && index === segments.length - 1) {
      continue;
    }
    const separator = segment.indexOf('=');
    if (separator < 1) {
      throw configurationError('invalid-config');
    }
    const key = segment.slice(0, separator);
    const value = segment.slice(separator + 1);
    if (
      key.length === 0 ||
      value.length === 0 ||
      key !== key.trim() ||
      value !== value.trim() ||
      !APPROVED_CONNECTION_STRING_KEYS.has(key) ||
      entries.has(key)
    ) {
      throw configurationError('invalid-config');
    }
    entries.set(key, value);
  }

  const instrumentationKey = entries.get('InstrumentationKey');
  const ingestionEndpoint = entries.get('IngestionEndpoint');
  if (
    entries.size !== 2 ||
    instrumentationKey === undefined ||
    !INSTRUMENTATION_KEY_UUID.test(instrumentationKey) ||
    ingestionEndpoint === undefined
  ) {
    throw configurationError('invalid-config');
  }

  const endpoint = canonicalIngestionEndpoint(ingestionEndpoint);
  return `InstrumentationKey=${instrumentationKey};IngestionEndpoint=${endpoint}`;
}

function validateConfig(input: RelayMetricSinkConfig): ValidatedConfig {
  try {
    if (
      typeof input !== 'object' ||
      input === null ||
      utilTypes.isProxy(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      throw configurationError('invalid-config');
    }
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== 5 ||
      keys.some(
        (key) =>
          key !== 'clientId' &&
          key !== 'deploymentSlot' &&
          key !== 'connectionString' &&
          key !== 'applicationInsightsStatsbeatDisabled' &&
          key !== 'applicationInsightsNoStatsbeat'
      )
    ) {
      throw configurationError('invalid-config');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const clientId = descriptorValue(descriptors, 'clientId');
    const deploymentSlot = descriptorValue(descriptors, 'deploymentSlot');
    const connectionString = descriptorValue(descriptors, 'connectionString');
    const statsbeatDisabled = descriptorValue(
      descriptors,
      'applicationInsightsStatsbeatDisabled'
    );
    const noStatsbeat = descriptorValue(descriptors, 'applicationInsightsNoStatsbeat');
    if (
      typeof clientId !== 'string' ||
      !CANONICAL_LOWERCASE_UUID.test(clientId) ||
      !isDeploymentSlot(deploymentSlot) ||
      statsbeatDisabled !== true ||
      noStatsbeat !== true
    ) {
      throw configurationError('invalid-config');
    }
    return Object.freeze({
      clientId,
      deploymentSlot,
      connectionString: validateConnectionString(connectionString)
    });
  } catch (error) {
    if (error instanceof RelayMetricSinkConfigurationError) {
      throw error;
    }
    throw configurationError('invalid-config');
  }
}

function hasExactExportRecordKeys(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || utilTypes.isProxy(input)) {
    return false;
  }
  try {
    return Reflect.ownKeys(input).every(
      (key) => typeof key === 'string' && EXPORT_RECORD_KEYS.has(key)
    );
  } catch {
    return false;
  }
}

function abortSignalIsAborted(signal: AbortSignal): boolean {
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
  if (getter === undefined) {
    return true;
  }
  return getter.call(signal) === true;
}

function scheduleOneShotTimer(
  runtime: RelayMetricSinkRuntime,
  callback: () => void,
  delayMs: number
): OneShotTimer {
  let handle: TimerHandle | undefined;
  let fired = false;
  let cancelled = false;
  const fire = (): void => {
    if (fired || cancelled) {
      return;
    }
    fired = true;
    callback();
  };
  try {
    const candidate = runtime.setTimer(fire, delayMs);
    if (fired || cancelled) {
      try {
        runtime.clearTimer(candidate);
      } catch {
        // Cleanup is best-effort.
      }
    } else {
      handle = candidate;
    }
  } catch {
    fire();
  }
  return Object.freeze({
    cancel(): void {
      if (cancelled) {
        return;
      }
      cancelled = true;
      const current = handle;
      handle = undefined;
      if (current !== undefined) {
        try {
          runtime.clearTimer(current);
        } catch {
          // Cleanup is best-effort.
        }
      }
    }
  });
}

function createTrackingExporter(
  exporter: RelayMetricExporter,
  exportHealth: ExportHealth,
  runtime: RelayMetricSinkRuntime
): PushMetricExporter {
  const selectAggregationTemporality = exporter.selectAggregationTemporality;
  const selectAggregation = exporter.selectAggregation;
  return {
    export(
      metrics: ResourceMetrics,
      resultCallback: Parameters<PushMetricExporter['export']>[1]
    ): void {
      let finished = false;
      const watchdogHolder: { current?: OneShotTimer } = {};
      const complete = (result: MetricExportResult): void => {
        if (finished) {
          return;
        }
        finished = true;
        watchdogHolder.current?.cancel();
        try {
          exportHealth.observe(result.code);
        } catch {
          exportHealth.fail();
        }
        try {
          resultCallback(result);
        } catch {
          // Export callback failures must not escape into the exporter.
        }
      };
      const fail = (): void => {
        if (finished) {
          return;
        }
        finished = true;
        watchdogHolder.current?.cancel();
        exportHealth.fail();
        try {
          resultCallback(FAILED_EXPORT_RESULT);
        } catch {
          // Export callback failures must not escape into the exporter.
        }
      };
      const watchdog = scheduleOneShotTimer(runtime, fail, EXPORT_TIMEOUT_MS);
      watchdogHolder.current = watchdog;
      if (finished) {
        watchdog.cancel();
        return;
      }
      try {
        const attempt = exporter.export(metrics, complete);
        if (attempt !== undefined) {
          void attempt.catch(fail);
        }
      } catch {
        fail();
      }
    },
    forceFlush: () => exporter.forceFlush(),
    shutdown: () => exporter.shutdown(),
    ...(selectAggregationTemporality === undefined
      ? {}
      : {
          selectAggregationTemporality: (
            instrumentType: Parameters<NonNullable<
              PushMetricExporter['selectAggregationTemporality']
            >>[0]
          ) => selectAggregationTemporality.call(exporter, instrumentType)
        }),
    ...(selectAggregation === undefined
      ? {}
      : {
          selectAggregation: (
            instrumentType: Parameters<NonNullable<PushMetricExporter['selectAggregation']>>[0]
          ) => selectAggregation.call(exporter, instrumentType)
        })
  };
}

function pointAttributes(record: SanitizedTelemetryRecord): MetricAttributes {
  const attributes: Record<string, MetricAttributeValue> = Object.create(null);
  if (record.protocolVersion !== undefined) {
    attributes['palancar.protocol.version'] = record.protocolVersion;
  }
  if (record.targetLanguage !== undefined) {
    attributes['palancar.target_language'] = record.targetLanguage;
  }
  if (record.gateDecision !== undefined) {
    attributes['palancar.gate_decision'] = record.gateDecision;
  }
  if (record.operation !== undefined) {
    attributes['palancar.operation'] = record.operation;
  }
  if (record.outcome !== undefined) {
    attributes['palancar.outcome'] = record.outcome;
  }
  if (record.providerId !== undefined) {
    attributes['palancar.provider.id'] = record.providerId;
  }
  if (record.providerVersion !== undefined) {
    attributes['palancar.provider.version'] = record.providerVersion;
  }
  if (record.reconnectReason !== undefined) {
    attributes['palancar.reconnect.reason'] = record.reconnectReason;
  }
  return attributes;
}

function metricValue(record: SanitizedTelemetryRecord): number {
  if (LATENCY_METRIC_NAMES.has(record.name)) {
    if (typeof record.durationMs !== 'number') {
      throw new TypeError('Sanitized latency record is missing its value.');
    }
    return record.durationMs;
  }
  if (AUDIO_SAMPLE_METRIC_NAMES.has(record.name)) {
    if (typeof record.sampleCount !== 'number') {
      throw new TypeError('Sanitized audio record is missing its value.');
    }
    return record.sampleCount;
  }
  return record.count ?? 1;
}

class AzureRelayMetricSink implements RelayMetricSink {
  readonly #deploymentSlot: DeploymentSlot;
  readonly #credential: TokenCredential;
  readonly #provider: RelayMeterProvider;
  readonly #instruments: ReadonlyMap<TelemetryMetricName, RelayInstrument>;
  readonly #runtime: RelayMetricSinkRuntime;
  readonly #exportHealth: ExportHealth;
  readonly #activeReadinessControllers = new Set<AbortController>();
  #sealed = false;
  #shutdownPromise: Promise<void> | undefined;

  constructor(
    deploymentSlot: DeploymentSlot,
    credential: TokenCredential,
    provider: RelayMeterProvider,
    instruments: ReadonlyMap<TelemetryMetricName, RelayInstrument>,
    runtime: RelayMetricSinkRuntime,
    exportHealth: ExportHealth
  ) {
    this.#deploymentSlot = deploymentSlot;
    this.#credential = credential;
    this.#provider = provider;
    this.#instruments = instruments;
    this.#runtime = runtime;
    this.#exportHealth = exportHealth;
  }

  record(input: unknown): void {
    if (this.#sealed) {
      return;
    }
    try {
      if (!hasExactExportRecordKeys(input)) {
        return;
      }
      const record = sanitizeTelemetryForExport(input, this.#deploymentSlot);
      const selected = this.#instruments.get(record.name);
      if (selected === undefined) {
        return;
      }
      const value = metricValue(record);
      const attributes = pointAttributes(record);
      if (selected.kind === 'histogram') {
        selected.instrument.record(value, attributes);
      } else {
        selected.instrument.add(value, attributes);
      }
    } catch {
      // Telemetry is best-effort and must never affect the relay request path.
    }
  }

  async checkReadiness(signal?: AbortSignal): Promise<boolean> {
    if (this.#sealed) {
      return false;
    }

    const controller = new AbortController();
    let cancelled = false;
    let cleaned = false;
    let callerListenerRegistered = false;
    let watchdog: OneShotTimer | undefined;
    let resolveCancellation: (() => void) | undefined;
    const cancellation = new Promise<undefined>((resolve) => {
      resolveCancellation = () => resolve(undefined);
    });
    const onInternalAbort = (): void => {
      cancelled = true;
      resolveCancellation?.();
    };
    const onCallerAbort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };
    const cleanup = (): void => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      watchdog?.cancel();
      this.#activeReadinessControllers.delete(controller);
      try {
        EventTarget.prototype.removeEventListener.call(
          controller.signal,
          'abort',
          onInternalAbort
        );
      } catch {
        // The internal signal is trusted; cleanup still fails closed.
      }
      if (signal !== undefined && callerListenerRegistered) {
        try {
          EventTarget.prototype.removeEventListener.call(signal, 'abort', onCallerAbort);
        } catch {
          // Hostile signals fail closed.
        }
      }
    };

    try {
      EventTarget.prototype.addEventListener.call(
        controller.signal,
        'abort',
        onInternalAbort,
        { once: true }
      );
      this.#activeReadinessControllers.add(controller);
      if (this.#sealed) {
        controller.abort();
        return false;
      }

      if (signal !== undefined) {
        if (abortSignalIsAborted(signal)) {
          controller.abort();
          return false;
        }
        EventTarget.prototype.addEventListener.call(signal, 'abort', onCallerAbort, {
          once: true
        });
        callerListenerRegistered = true;
        if (abortSignalIsAborted(signal)) {
          controller.abort();
        }
      }

      if (this.#sealed) {
        controller.abort();
      }
      watchdog = scheduleOneShotTimer(
        this.#runtime,
        () => {
          if (!controller.signal.aborted) {
            controller.abort();
          }
        },
        READINESS_TIMEOUT_MS
      );
      if (cancelled) {
        watchdog.cancel();
        return false;
      }
      const token = Promise.resolve()
        .then(() =>
          this.#credential.getToken(AZURE_MONITOR_TOKEN_SCOPE, {
            abortSignal: controller.signal
          })
        )
        .catch(() => undefined);
      const result = await Promise.race([token, cancellation]);
      if (
        result === undefined ||
        result === null ||
        cancelled ||
        controller.signal.aborted ||
        this.#sealed
      ) {
        return false;
      }
      return !this.#exportHealth.failed;
    } catch {
      try {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      } catch {
        // Fail closed if cancellation itself is hostile.
      }
      return false;
    } finally {
      cleanup();
    }
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) {
      return this.#shutdownPromise;
    }
    this.#sealed = true;
    for (const controller of this.#activeReadinessControllers) {
      try {
        controller.abort();
      } catch {
        // All active readiness checks still fail closed on their sealed-state check.
      }
    }
    this.#shutdownPromise = this.#shutdownWithinDeadline();
    return this.#shutdownPromise;
  }

  async #shutdownWithinDeadline(): Promise<void> {
    const deadline = this.#safeNow() + SHUTDOWN_TIMEOUT_MS;
    await this.#settleWithinDeadline(
      () => this.#provider.forceFlush({ timeoutMillis: this.#remaining(deadline) }),
      deadline
    );
    await this.#settleWithinDeadline(
      () => this.#provider.shutdown({ timeoutMillis: this.#remaining(deadline) }),
      deadline
    );
  }

  #safeNow(): number {
    try {
      const value = this.#runtime.now();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  #remaining(deadline: number): number {
    return Math.max(0, deadline - this.#safeNow());
  }

  async #settleWithinDeadline(operation: () => Promise<void>, deadline: number): Promise<void> {
    const pending = Promise.resolve()
      .then(operation)
      .catch(() => undefined);
    const remaining = this.#remaining(deadline);
    if (remaining === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      let finished = false;
      const timerHolder: { current?: OneShotTimer } = {};
      const finish = (): void => {
        if (finished) {
          return;
        }
        finished = true;
        timerHolder.current?.cancel();
        resolve();
      };
      const timer = scheduleOneShotTimer(this.#runtime, finish, remaining);
      timerHolder.current = timer;
      if (finished) {
        timer.cancel();
      }
      void pending.then(finish);
    });
  }
}

class DisabledRelayMetricSink implements RelayMetricSink {
  record(): void {}

  checkReadiness(): Promise<boolean> {
    return Promise.resolve(true);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const PRODUCTION_RUNTIME: RelayMetricSinkRuntime = Object.freeze({
  createCredential: (options: Readonly<{ clientId: string }>) =>
    new ManagedIdentityCredential(options),
  createExporter: (options: AzureMonitorExporterOptions) =>
    new AzureMonitorMetricExporter(options),
  createResource: (attributes: Readonly<Record<string, string>>) =>
    resourceFromAttributes(attributes),
  createReader: (options: Parameters<RelayMetricSinkRuntime['createReader']>[0]) =>
    new PeriodicExportingMetricReader(options),
  createProvider: (options: Parameters<RelayMetricSinkRuntime['createProvider']>[0]) =>
    new MeterProvider({
      resource: options.resource,
      readers: [...options.readers]
    }),
  now: () => Date.now(),
  setTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimer: (handle: TimerHandle) => clearTimeout(handle)
});

const DISABLED_SINK_REGISTRY = new WeakSet<object>();
const DISABLED_SINK: RelayMetricSink = Object.freeze(new DisabledRelayMetricSink());
DISABLED_SINK_REGISTRY.add(DISABLED_SINK);

export function createDisabledRelayMetricSink(): RelayMetricSink {
  return DISABLED_SINK;
}

export function isDisabledRelayMetricSink(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return false;
  }
  const visited = new Set<object>();
  let current: object | null = value;
  try {
    while (current !== null) {
      if (utilTypes.isProxy(current) || visited.has(current)) {
        return false;
      }
      visited.add(current);
      if (DISABLED_SINK_REGISTRY.has(current)) {
        return true;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return false;
  }
  return false;
}

export function createProductionRelayMetricSink(
  config: RelayMetricSinkConfig,
  runtime: RelayMetricSinkRuntime = PRODUCTION_RUNTIME
): RelayMetricSink {
  const validated = validateConfig(config);
  let provider: RelayMeterProvider | undefined;
  try {
    const credential = runtime.createCredential({ clientId: validated.clientId });
    const retryOptions = {
      maxRetries: 2,
      retryDelayInMs: 1_000,
      maxRetryDelayInMs: 2_000
    };
    const exporterOptions = {
      credential,
      connectionString: validated.connectionString,
      disableOfflineStorage: true,
      retryOptions
    } satisfies AzureMonitorExporterOptions;
    const exporter = runtime.createExporter(exporterOptions);
    const exportHealth = new ExportHealth();
    const trackingExporter = createTrackingExporter(exporter, exportHealth, runtime);
    const reader = runtime.createReader({
      exporter: trackingExporter,
      exportIntervalMillis: EXPORT_INTERVAL_MS,
      exportTimeoutMillis: EXPORT_TIMEOUT_MS
    });
    const resource = runtime.createResource({
      'service.name': SERVICE_NAME,
      'service.version': SERVICE_VERSION,
      'deployment.environment.name': validated.deploymentSlot
    });
    provider = runtime.createProvider({ resource, readers: [reader] });
    const meter = provider.getMeter(METER_NAME, SERVICE_VERSION);
    const instruments = new Map<TelemetryMetricName, RelayInstrument>();
    for (const name of Object.values(TELEMETRY_METRIC_NAMES)) {
      if (LATENCY_METRIC_NAMES.has(name)) {
        instruments.set(
          name,
          Object.freeze({
            kind: 'histogram',
            instrument: meter.createHistogram(name, { unit: 'ms' })
          })
        );
      } else {
        instruments.set(
          name,
          Object.freeze({
            kind: 'counter',
            instrument: meter.createCounter(name, { unit: '1' })
          })
        );
      }
    }
    return new AzureRelayMetricSink(
      validated.deploymentSlot,
      credential,
      provider,
      instruments,
      runtime,
      exportHealth
    );
  } catch {
    if (provider !== undefined) {
      void Promise.resolve()
        .then(() => provider?.shutdown({ timeoutMillis: SHUTDOWN_TIMEOUT_MS }))
        .catch(() => undefined);
    }
    throw configurationError('initialization-failed');
  }
}
