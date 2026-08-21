import {
  TelemetryValidationError,
  sanitizeTelemetryForExport,
  type DeploymentSlot,
  type SanitizedTelemetryRecord,
  type TelemetryMetricName
} from './index.js';

export const OTLP_JSON_EXPORT_PATH = '/v1/metrics' as const;
export const OTLP_JSON_CONTENT_TYPE = 'application/json' as const;
export const OTLP_JSON_REQUEST_TIMEOUT_MS = 5_000 as const;
export const OTLP_JSON_RETAINED_LIMIT = 256 as const;
export const OTLP_JSON_BATCH_LIMIT = 64 as const;
export const OTLP_JSON_BODY_LIMIT_BYTES = 262_144 as const;
export const OTLP_JSON_QUEUE_LIFETIME_MS = 300_000 as const;
export const OTLP_JSON_MAX_ATTEMPTS = 3 as const;
export const OTLP_JSON_SHUTDOWN_DRAIN_MS = 5_000 as const;

const SCOPE_NAME = '@palancar/telemetry';
const SCOPE_VERSION = '0.1.0';
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

const LATENCY_METRICS = new Set<TelemetryMetricName>([
  'transcription.first_partial_latency',
  'transcription.final_latency',
  'translation.latency',
  'suggestion.latency'
]);

const AUDIO_SAMPLE_METRICS = new Set<TelemetryMetricName>([
  'audio.samples.accepted',
  'audio.samples.duplicate',
  'audio.samples.rejected'
]);

export const TELEMETRY_EXPORT_COUNTERS = Object.freeze([
  'telemetry.export.accepted',
  'telemetry.export.rejected',
  'telemetry.export.exported',
  'telemetry.export.retried',
  'telemetry.export.dropped.queue_full',
  'telemetry.export.dropped.expired',
  'telemetry.export.dropped.oversize',
  'telemetry.export.dropped.permanent',
  'telemetry.export.dropped.retry_exhausted',
  'telemetry.export.dropped.partial',
  'telemetry.export.dropped.authorization',
  'telemetry.export.dropped.shutdown'
] as const);

export type TelemetryExportCounterName = (typeof TELEMETRY_EXPORT_COUNTERS)[number];

export type OtlpJsonServiceName = 'palancar-relay' | 'palancar-g2-client';

export interface OtlpJsonExporterOptions {
  readonly serviceName: OtlpJsonServiceName;
  readonly serviceVersion: string;
  readonly deploymentSlot: DeploymentSlot;
  readonly retryJitterPermille: readonly [number, number];
}

export interface OtlpJsonExportRequest {
  readonly method: 'POST';
  readonly path: typeof OTLP_JSON_EXPORT_PATH;
  readonly contentType: typeof OTLP_JSON_CONTENT_TYPE;
  readonly body: string;
  readonly requestId: string;
  readonly timeoutMs: typeof OTLP_JSON_REQUEST_TIMEOUT_MS;
}

export type OtlpJsonExportResult =
  | { readonly kind: 'network-error' }
  | { readonly kind: 'timeout' }
  | {
      readonly kind: 'http';
      readonly status: number;
      readonly retryAfterMs?: number;
      readonly rejectedDataPoints?: number;
    };

export type TelemetryExportCounterSnapshot = Readonly<
  Record<TelemetryExportCounterName, number>
>;

interface QueuedPoint {
  readonly record: SanitizedTelemetryRecord;
  readonly timestampMs: number;
}

interface PendingBatch {
  readonly points: readonly QueuedPoint[];
  readonly body: string;
  readonly attempt: number;
  readonly availableAtMs: number;
}

interface InFlightBatch extends PendingBatch {
  readonly requestId: string;
  readonly deadlineMs: number;
}

interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string } | { readonly intValue: string };
}

interface MetricGroup {
  readonly name: TelemetryMetricName;
  readonly points: SanitizedTelemetryRecord[];
}

function configurationFailure(): never {
  throw new TelemetryValidationError('invalid-field');
}

function isPlainObject(value: unknown): value is object {
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

function ownDataValues(value: object): ReadonlyMap<string, unknown> {
  let symbols: symbol[];
  let names: string[];
  try {
    symbols = Object.getOwnPropertySymbols(value);
    names = Object.getOwnPropertyNames(value);
  } catch {
    return configurationFailure();
  }
  if (symbols.length > 0) {
    return configurationFailure();
  }

  const values = new Map<string, unknown>();
  for (const name of names) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name);
    } catch {
      return configurationFailure();
    }
    if (descriptor === undefined || 'get' in descriptor || 'set' in descriptor) {
      return configurationFailure();
    }
    values.set(name, descriptor.value);
  }
  return values;
}

function parseOptions(options: OtlpJsonExporterOptions): {
  readonly serviceName: OtlpJsonServiceName;
  readonly serviceVersion: string;
  readonly deploymentSlot: DeploymentSlot;
  readonly firstJitter: number;
  readonly secondJitter: number;
} {
  if (!isPlainObject(options)) {
    return configurationFailure();
  }
  const values = ownDataValues(options);
  const expected = new Set([
    'serviceName',
    'serviceVersion',
    'deploymentSlot',
    'retryJitterPermille'
  ]);
  if (values.size !== expected.size || [...values.keys()].some((key) => !expected.has(key))) {
    return configurationFailure();
  }

  const serviceName = values.get('serviceName');
  const serviceVersion = values.get('serviceVersion');
  const deploymentSlot = values.get('deploymentSlot');
  const jitter = values.get('retryJitterPermille');
  if (
    (serviceName !== 'palancar-relay' && serviceName !== 'palancar-g2-client') ||
    typeof serviceVersion !== 'string' ||
    !SEMVER_PATTERN.test(serviceVersion) ||
    (deploymentSlot !== 'dev' && deploymentSlot !== 'staging' && deploymentSlot !== 'production') ||
    !Array.isArray(jitter) ||
    jitter.length !== 2
  ) {
    return configurationFailure();
  }
  const firstJitter: unknown = jitter[0];
  const secondJitter: unknown = jitter[1];
  if (!isJitter(firstJitter) || !isJitter(secondJitter)) {
    return configurationFailure();
  }
  return { serviceName, serviceVersion, deploymentSlot, firstJitter, secondJitter };
}

function isJitter(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 500 && value <= 1_500;
}

function assertNow(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    configurationFailure();
  }
}

function saturatingAdd(left: number, right: number): number {
  return left >= MAX_COUNTER - right ? MAX_COUNTER : left + right;
}

function deadlineFrom(nowMs: number, durationMs: number): number {
  return nowMs >= MAX_COUNTER - durationMs ? MAX_COUNTER : nowMs + durationMs;
}

function timestampNanoseconds(timestamp: string): string {
  const match = TIMESTAMP_PATTERN.exec(timestamp);
  if (match === null) {
    configurationFailure();
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));
  const epochDay = ordinalDay(1970, 1, 1);
  const dayOffset = ordinalDay(year, month, day) - epochDay;
  const seconds =
    dayOffset * 86_400n +
    BigInt(hour) * 3_600n +
    BigInt(minute) * 60n +
    BigInt(second);
  return (seconds * 1_000_000_000n + BigInt(milliseconds) * 1_000_000n).toString();
}

function timestampMilliseconds(timestamp: string): number {
  return Number(BigInt(timestampNanoseconds(timestamp)) / 1_000_000n);
}

function ordinalDay(year: number, month: number, day: number): bigint {
  const previousYear = BigInt(year - 1);
  const daysBeforeYear =
    365n * previousYear +
    previousYear / 4n -
    previousYear / 100n +
    previousYear / 400n;
  const monthOffsets = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const offset = monthOffsets[month - 1];
  if (offset === undefined) {
    configurationFailure();
  }
  const leapAdjustment = month > 2 && isLeapYear(year) ? 1 : 0;
  return daysBeforeYear + BigInt(offset + leapAdjustment + day - 1);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function stringAttribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function pointAttributes(record: SanitizedTelemetryRecord): OtlpAttribute[] {
  const attributes: OtlpAttribute[] = [];
  if (record.errorCategory !== undefined) {
    attributes.push(stringAttribute('error.type', record.errorCategory));
  }
  if (record.errorId !== undefined) {
    attributes.push(stringAttribute('palancar.error.id', record.errorId));
  }
  if (record.gateDecision !== undefined) {
    attributes.push(stringAttribute('palancar.gate_decision', record.gateDecision));
  }
  if (record.operation !== undefined) {
    attributes.push(stringAttribute('palancar.operation', record.operation));
  }
  if (record.outcome !== undefined) {
    attributes.push(stringAttribute('palancar.outcome', record.outcome));
  }
  if (record.protocolVersion !== undefined) {
    attributes.push({
      key: 'palancar.protocol.version',
      value: { intValue: String(record.protocolVersion) }
    });
  }
  if (record.providerId !== undefined) {
    attributes.push(stringAttribute('palancar.provider.id', record.providerId));
  }
  if (record.providerVersion !== undefined) {
    attributes.push(stringAttribute('palancar.provider.version', record.providerVersion));
  }
  if (
    record.name === 'generation.failure.provider_response' &&
    record.providerFailureStage !== undefined
  ) {
    attributes.push(
      stringAttribute('palancar.provider.failure_stage', record.providerFailureStage)
    );
  }
  if (record.reconnectReason !== undefined) {
    attributes.push(stringAttribute('palancar.reconnect.reason', record.reconnectReason));
  }
  if (record.targetLanguage !== undefined) {
    attributes.push(stringAttribute('palancar.target_language', record.targetLanguage));
  }
  attributes.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  return attributes;
}

function sumValue(record: SanitizedTelemetryRecord): string {
  if (AUDIO_SAMPLE_METRICS.has(record.name)) {
    return String(record.sampleCount);
  }
  return String(record.count ?? 1);
}

function serializeMetric(group: MetricGroup): object {
  if (LATENCY_METRICS.has(group.name)) {
    return {
      name: group.name,
      unit: 'ms',
      histogram: {
        aggregationTemporality: 1,
        dataPoints: group.points.map((record) => ({
          attributes: pointAttributes(record),
          timeUnixNano: timestampNanoseconds(record.timestamp),
          count: '1',
          sum: record.durationMs,
          bucketCounts: ['1'],
          explicitBounds: []
        }))
      }
    };
  }

  return {
    name: group.name,
    unit: AUDIO_SAMPLE_METRICS.has(group.name) ? '{sample}' : '1',
    sum: {
      aggregationTemporality: 1,
      isMonotonic: true,
      dataPoints: group.points.map((record) => ({
        attributes: pointAttributes(record),
        timeUnixNano: timestampNanoseconds(record.timestamp),
        asInt: sumValue(record)
      }))
    }
  };
}

function groupRecords(points: readonly QueuedPoint[]): MetricGroup[] {
  const groups: MetricGroup[] = [];
  const byKey = new Map<string, MetricGroup>();
  for (const point of points) {
    const kind = LATENCY_METRICS.has(point.record.name) ? 'histogram' : 'sum';
    const unit = kind === 'histogram'
      ? 'ms'
      : AUDIO_SAMPLE_METRICS.has(point.record.name) ? '{sample}' : '1';
    const key = `${point.record.name}\u0000${kind}\u0000${unit}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = { name: point.record.name, points: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.points.push(point.record);
  }
  return groups;
}

function serializeBody(
  points: readonly QueuedPoint[],
  serviceName: OtlpJsonServiceName,
  serviceVersion: string,
  deploymentSlot: DeploymentSlot
): string {
  const body = {
    resourceMetrics: [{
      resource: {
        attributes: [
          stringAttribute('deployment.environment.name', deploymentSlot),
          stringAttribute('service.name', serviceName),
          stringAttribute('service.version', serviceVersion)
        ]
      },
      scopeMetrics: [{
        scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
        metrics: groupRecords(points).map(serializeMetric)
      }]
    }]
  };
  return JSON.stringify(body);
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

function requestMetadata(requestId: string, body: string): OtlpJsonExportRequest {
  const request = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(request, {
    method: { enumerable: true, value: 'POST' },
    path: { enumerable: true, value: OTLP_JSON_EXPORT_PATH },
    contentType: { enumerable: true, value: OTLP_JSON_CONTENT_TYPE },
    body: { enumerable: true, value: body },
    requestId: { enumerable: true, value: requestId },
    timeoutMs: { enumerable: true, value: OTLP_JSON_REQUEST_TIMEOUT_MS }
  });
  return Object.freeze(request) as unknown as OtlpJsonExportRequest;
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** A dependency-free, host-driven OTLP/HTTP JSON export state machine. */
export class OtlpJsonExporter {
  readonly #serviceName: OtlpJsonServiceName;
  readonly #serviceVersion: string;
  readonly #deploymentSlot: DeploymentSlot;
  readonly #jitters: readonly [number, number];
  readonly #counters = new Map<TelemetryExportCounterName, number>();
  #queue: QueuedPoint[] = [];
  #pendingRetry: PendingBatch | undefined;
  #inFlight: InFlightBatch | undefined;
  #nextRequestId = 1;
  #authorizationBlocked = false;
  #shutdownDeadlineMs: number | undefined;
  #disposed = false;

  constructor(options: OtlpJsonExporterOptions) {
    const parsed = parseOptions(options);
    this.#serviceName = parsed.serviceName;
    this.#serviceVersion = parsed.serviceVersion;
    this.#deploymentSlot = parsed.deploymentSlot;
    this.#jitters = Object.freeze([parsed.firstJitter, parsed.secondJitter]);
    for (const name of TELEMETRY_EXPORT_COUNTERS) {
      this.#counters.set(name, 0);
    }
  }

  enqueue(input: unknown): boolean {
    let record: SanitizedTelemetryRecord;
    try {
      record = sanitizeTelemetryForExport(input, this.#deploymentSlot);
    } catch (error: unknown) {
      this.#increment('telemetry.export.rejected', 1);
      if (error instanceof TelemetryValidationError) {
        throw error;
      }
      throw new TelemetryValidationError('invalid-field');
    }

    this.#increment('telemetry.export.accepted', 1);
    if (this.#disposed || this.#shutdownDeadlineMs !== undefined) {
      this.#increment('telemetry.export.dropped.shutdown', 1);
      return false;
    }
    if (this.#authorizationBlocked) {
      this.#increment('telemetry.export.dropped.authorization', 1);
      return false;
    }

    if (this.#retainedCount() >= OTLP_JSON_RETAINED_LIMIT) {
      const evicted = this.#queue.shift();
      if (evicted === undefined) {
        this.#increment('telemetry.export.dropped.queue_full', 1);
        return false;
      }
      this.#increment('telemetry.export.dropped.queue_full', 1);
    }
    this.#queue.push({ record, timestampMs: timestampMilliseconds(record.timestamp) });
    return true;
  }

  next(nowMs: number): OtlpJsonExportRequest | null {
    assertNow(nowMs);
    if (this.#disposed || this.#authorizationBlocked) {
      return null;
    }
    if (this.#shutdownDeadlineMs !== undefined && nowMs >= this.#shutdownDeadlineMs) {
      this.#dropAll('telemetry.export.dropped.shutdown');
      return null;
    }

    if (this.#inFlight !== undefined) {
      if (nowMs < this.#inFlight.deadlineMs) {
        return null;
      }
      const timedOut = this.#inFlight;
      this.#inFlight = undefined;
      this.#scheduleRetry(timedOut, nowMs);
    }

    this.#expireQueued(nowMs);
    if (this.#pendingRetry !== undefined) {
      this.#removeExpiredPendingPoints(nowMs);
      if (this.#pendingRetry !== undefined) {
        if (nowMs < this.#pendingRetry.availableAtMs) {
          return null;
        }
        const pending = this.#pendingRetry;
        this.#pendingRetry = undefined;
        return this.#startRequest(pending, nowMs);
      }
    }

    if (this.#queue.length === 0) {
      return null;
    }
    let size = Math.min(OTLP_JSON_BATCH_LIMIT, this.#queue.length);
    let points = this.#queue.slice(0, size);
    let body = serializeBody(
      points,
      this.#serviceName,
      this.#serviceVersion,
      this.#deploymentSlot
    );
    while (size > 1 && utf8Length(body) > OTLP_JSON_BODY_LIMIT_BYTES) {
      size -= 1;
      points = this.#queue.slice(0, size);
      body = serializeBody(
        points,
        this.#serviceName,
        this.#serviceVersion,
        this.#deploymentSlot
      );
    }
    if (utf8Length(body) > OTLP_JSON_BODY_LIMIT_BYTES) {
      this.#queue.shift();
      this.#increment('telemetry.export.dropped.oversize', 1);
      return null;
    }
    this.#queue.splice(0, size);
    return this.#startRequest({ points, body, attempt: 1, availableAtMs: nowMs }, nowMs);
  }

  settle(requestId: string, result: OtlpJsonExportResult, nowMs: number): void {
    const current = this.#inFlight;
    if (current === undefined || current.requestId !== requestId) {
      return;
    }
    assertNow(nowMs);
    this.#inFlight = undefined;

    if (this.#shutdownDeadlineMs !== undefined && nowMs >= this.#shutdownDeadlineMs) {
      this.#increment('telemetry.export.dropped.shutdown', current.points.length);
      this.#dropAll('telemetry.export.dropped.shutdown');
      return;
    }
    if (nowMs >= current.deadlineMs) {
      this.#scheduleRetry(current, nowMs);
      return;
    }

    if (result.kind === 'network-error' || result.kind === 'timeout') {
      this.#scheduleRetry(current, nowMs);
      return;
    }
    const status = result.status;
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
      this.#increment('telemetry.export.dropped.permanent', current.points.length);
      return;
    }
    if (status === 200) {
      this.#completeSuccess(current, result.rejectedDataPoints);
      return;
    }
    if (status === 401 || status === 403) {
      this.#authorizationBlocked = true;
      this.#increment('telemetry.export.dropped.authorization', current.points.length);
      this.#dropAll('telemetry.export.dropped.authorization');
      return;
    }
    if (retryableStatus(status)) {
      const retryAfterMs = result.retryAfterMs;
      if (
        retryAfterMs !== undefined &&
        (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 60_000)
      ) {
        this.#increment('telemetry.export.dropped.permanent', current.points.length);
        return;
      }
      this.#scheduleRetry(current, nowMs, retryAfterMs);
      return;
    }
    this.#increment('telemetry.export.dropped.permanent', current.points.length);
  }

  beginShutdown(nowMs: number): void {
    assertNow(nowMs);
    if (this.#disposed || this.#shutdownDeadlineMs !== undefined) {
      return;
    }
    this.#shutdownDeadlineMs = deadlineFrom(nowMs, OTLP_JSON_SHUTDOWN_DRAIN_MS);
  }

  resumeAfterAuthorizationChange(): void {
    if (!this.#disposed) {
      this.#authorizationBlocked = false;
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#dropAll('telemetry.export.dropped.shutdown');
  }

  counter(name: TelemetryExportCounterName): number {
    return this.#counters.get(name) ?? 0;
  }

  counterSnapshot(): TelemetryExportCounterSnapshot {
    const snapshot = Object.create(null) as Record<TelemetryExportCounterName, number>;
    for (const name of TELEMETRY_EXPORT_COUNTERS) {
      Object.defineProperty(snapshot, name, {
        configurable: false,
        enumerable: true,
        value: this.counter(name),
        writable: false
      });
    }
    return Object.freeze(snapshot);
  }

  #increment(name: TelemetryExportCounterName, amount: number): void {
    this.#counters.set(name, saturatingAdd(this.counter(name), amount));
  }

  #retainedCount(): number {
    return this.#queue.length +
      (this.#pendingRetry?.points.length ?? 0) +
      (this.#inFlight?.points.length ?? 0);
  }

  #isExpired(point: QueuedPoint, nowMs: number): boolean {
    return nowMs - point.timestampMs >= OTLP_JSON_QUEUE_LIFETIME_MS;
  }

  #expireQueued(nowMs: number): void {
    const retained: QueuedPoint[] = [];
    let expired = 0;
    for (const point of this.#queue) {
      if (this.#isExpired(point, nowMs)) {
        expired += 1;
      } else {
        retained.push(point);
      }
    }
    this.#queue = retained;
    this.#increment('telemetry.export.dropped.expired', expired);
  }

  #removeExpiredPendingPoints(nowMs: number): void {
    const pending = this.#pendingRetry;
    if (pending === undefined) {
      return;
    }
    const fresh: QueuedPoint[] = [];
    let expired = 0;
    for (const point of pending.points) {
      if (this.#isExpired(point, nowMs)) {
        expired += 1;
      } else {
        fresh.push(point);
      }
    }
    if (expired === 0) {
      return;
    }
    this.#increment('telemetry.export.dropped.expired', expired);
    if (fresh.length === 0) {
      this.#pendingRetry = undefined;
      return;
    }
    this.#pendingRetry = {
      points: fresh,
      body: serializeBody(
        fresh,
        this.#serviceName,
        this.#serviceVersion,
        this.#deploymentSlot
      ),
      attempt: pending.attempt,
      availableAtMs: pending.availableAtMs
    };
  }

  #startRequest(batch: PendingBatch, nowMs: number): OtlpJsonExportRequest {
    const requestId = `otlp-${this.#nextRequestId}`;
    this.#nextRequestId = this.#nextRequestId === MAX_COUNTER ? 1 : this.#nextRequestId + 1;
    this.#inFlight = {
      ...batch,
      requestId,
      deadlineMs: deadlineFrom(nowMs, OTLP_JSON_REQUEST_TIMEOUT_MS)
    };
    return requestMetadata(requestId, batch.body);
  }

  #scheduleRetry(batch: PendingBatch, nowMs: number, retryAfterMs = 0): void {
    if (batch.attempt >= OTLP_JSON_MAX_ATTEMPTS) {
      this.#increment('telemetry.export.dropped.retry_exhausted', batch.points.length);
      return;
    }
    const retryIndex = batch.attempt - 1;
    const jitter = this.#jitters[retryIndex];
    if (jitter === undefined) {
      this.#increment('telemetry.export.dropped.retry_exhausted', batch.points.length);
      return;
    }
    const baseDelay = batch.attempt === 1 ? 1_000 : 2_000;
    const jitteredDelay = baseDelay * jitter / 1_000;
    const delay = Math.max(jitteredDelay, retryAfterMs);
    this.#increment('telemetry.export.retried', batch.points.length);
    this.#pendingRetry = {
      points: batch.points,
      body: batch.body,
      attempt: batch.attempt + 1,
      availableAtMs: deadlineFrom(nowMs, delay)
    };
  }

  #completeSuccess(batch: PendingBatch, rejectedDataPoints: number | undefined): void {
    if (
      rejectedDataPoints === undefined ||
      rejectedDataPoints === 0
    ) {
      this.#increment('telemetry.export.exported', batch.points.length);
      return;
    }
    if (
      !Number.isSafeInteger(rejectedDataPoints) ||
      rejectedDataPoints < 0 ||
      rejectedDataPoints > batch.points.length
    ) {
      this.#increment('telemetry.export.dropped.permanent', batch.points.length);
      return;
    }
    this.#increment('telemetry.export.exported', batch.points.length - rejectedDataPoints);
    this.#increment('telemetry.export.dropped.partial', rejectedDataPoints);
  }

  #dropAll(counter: TelemetryExportCounterName): void {
    const count = this.#retainedCount();
    this.#queue = [];
    this.#pendingRetry = undefined;
    this.#inFlight = undefined;
    this.#increment(counter, count);
  }
}

export function createOtlpJsonExporter(options: OtlpJsonExporterOptions): OtlpJsonExporter {
  return new OtlpJsonExporter(options);
}
