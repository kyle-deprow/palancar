import { types as utilTypes } from 'node:util';

import { SecurityStateError } from './errors.js';
import { exactDataObject, nonNegativeSafeInteger, positiveSafeInteger } from './schema.js';

export const AZURE_SECURITY_SCHEMA_VERSION = 2;
export const AZURE_CAS_ATTEMPTS = 8;
export const AZURE_TRANSACTION_LIMIT = 100;

export type AzureScalar = string | number | boolean;
export type AzureProperties = Readonly<Record<string, AzureScalar>>;

export interface AzureStoredEntity {
  readonly partitionKey: string;
  readonly rowKey: string;
  readonly etag: string;
  readonly properties: AzureProperties;
}

export interface AzureNewEntity {
  readonly partitionKey: string;
  readonly rowKey: string;
  readonly properties: AzureProperties;
}

export type AzureTableMutation =
  | Readonly<{ readonly type: 'create'; readonly entity: AzureNewEntity }>
  | Readonly<{ readonly type: 'replace'; readonly entity: AzureNewEntity; readonly etag: string }>;

export interface AzureListPageInput {
  readonly partitionKey?: string;
  readonly continuationToken?: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface AzureListPageResult {
  readonly entities: readonly AzureStoredEntity[];
  readonly continuationToken?: string;
}

export interface AzureTableClientLike {
  readonly pointRead: (
    partitionKey: string,
    rowKey: string,
    signal?: AbortSignal
  ) => Promise<AzureStoredEntity | undefined>;
  readonly create: (entity: AzureNewEntity, signal?: AbortSignal) => Promise<void>;
  readonly replace: (entity: AzureNewEntity, etag: string, signal?: AbortSignal) => Promise<void>;
  readonly delete: (
    partitionKey: string,
    rowKey: string,
    etag: string,
    signal?: AbortSignal
  ) => Promise<void>;
  readonly transaction: (
    mutations: readonly AzureTableMutation[],
    signal?: AbortSignal
  ) => Promise<void>;
  readonly listPage: (input: AzureListPageInput) => Promise<AzureListPageResult>;
}

export type AzureBoundaryErrorKind =
  | 'not-found'
  | 'conflict'
  | 'precondition-failed'
  | 'ambiguous'
  | 'unavailable';

/** Content-free error used only across the injected table boundary. */
export class AzureTableBoundaryError extends Error {
  readonly kind!: AzureBoundaryErrorKind;

  constructor(kind: AzureBoundaryErrorKind) {
    super('Azure table operation failed.');
    Object.defineProperties(this, {
      name: { value: 'AzureTableBoundaryError' },
      kind: { enumerable: true, value: kind }
    });
  }
}

export interface WindowEvent {
  readonly at: number;
  readonly amount: number;
  readonly operationId: string;
}

export type SecurityRowKind =
  | 'readiness'
  | 'pairing'
  | 'credential'
  | 'installation'
  | 'ticket'
  | 'session';

export type RateRowKind =
  | 'readiness'
  | 'rate'
  | 'audio-window'
  | 'audio-grant'
  | 'generation-counter'
  | 'generation';

function fail(): never {
  throw new SecurityStateError('state-unavailable');
}

export function safeInt64(value: unknown): number {
  if (nonNegativeSafeInteger(value)) return value;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) fail();
  const parsed = Number(value);
  if (!nonNegativeSafeInteger(parsed) || String(parsed) !== value) fail();
  return parsed;
}

export function exactEtag(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value === '*') fail();
  return value;
}

export function exactAzureProperties(
  value: unknown,
  environment: string,
  kind: SecurityRowKind | RateRowKind,
  required: readonly string[],
  optional: readonly string[] = []
): Readonly<Record<string, unknown>> {
  const input = exactDataObject(
    value,
    ['schemaVersion', 'kind', 'environment', ...required],
    optional,
    'state-unavailable'
  );
  if (
    safeInt64(input.schemaVersion) !== AZURE_SECURITY_SCHEMA_VERSION ||
    input.kind !== kind || input.environment !== environment
  ) fail();
  return input;
}

export function newAzureEntity(
  partitionKey: string,
  rowKey: string,
  environment: string,
  kind: SecurityRowKind | RateRowKind,
  properties: Readonly<Record<string, AzureScalar>>
): AzureNewEntity {
  if (
    typeof partitionKey !== 'string' || partitionKey.length === 0 ||
    typeof rowKey !== 'string' || rowKey.length === 0 ||
    utilTypes.isProxy(properties) || Object.getPrototypeOf(properties) !== Object.prototype
  ) fail();
  return Object.freeze({
    partitionKey,
    rowKey,
    properties: Object.freeze({
      schemaVersion: AZURE_SECURITY_SCHEMA_VERSION,
      kind,
      environment,
      ...properties
    })
  });
}

export function requireEntityKey(
  entity: AzureStoredEntity,
  partitionKey: string,
  rowKey: string
): void {
  if (
    entity.partitionKey !== partitionKey || entity.rowKey !== rowKey ||
    exactEtag(entity.etag) !== entity.etag
  ) fail();
}

export function stringField(
  input: Readonly<Record<string, unknown>>,
  key: string,
  pattern: RegExp,
  maximum = 256
): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || !pattern.test(value)) fail();
  return value;
}

export function optionalStringField(
  input: Readonly<Record<string, unknown>>,
  key: string,
  pattern: RegExp,
  maximum = 256
): string | undefined {
  return input[key] === undefined ? undefined : stringField(input, key, pattern, maximum);
}

export function intField(input: Readonly<Record<string, unknown>>, key: string): number {
  return safeInt64(input[key]);
}

export function positiveIntField(input: Readonly<Record<string, unknown>>, key: string): number {
  const value = safeInt64(input[key]);
  if (!positiveSafeInteger(value)) fail();
  return value;
}

export function optionalIntField(
  input: Readonly<Record<string, unknown>>,
  key: string
): number | undefined {
  return input[key] === undefined ? undefined : safeInt64(input[key]);
}

export function encodeWindowEvents(events: readonly WindowEvent[]): string {
  if (!Array.isArray(events) || events.length > 512) fail();
  return JSON.stringify(events);
}

export function decodeWindowEvents(value: unknown): readonly WindowEvent[] {
  if (typeof value !== 'string' || value.length === 0 || value.length > 131_072) fail();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 512 || utilTypes.isProxy(parsed)) fail();
    const events = parsed.map((item) => {
      const input = exactDataObject(item, ['at', 'amount', 'operationId'], [], 'state-unavailable');
      const at = safeInt64(input.at);
      const amount = positiveIntField(input, 'amount');
      const operationId = stringField(input, 'operationId', /^[0-9a-f-]{32,64}$/, 64);
      return Object.freeze({ at, amount, operationId });
    });
    for (let index = 1; index < events.length; index += 1) {
      if ((events[index]?.at ?? 0) < (events[index - 1]?.at ?? 0)) fail();
    }
    return Object.freeze(events);
  } catch (error) {
    if (error instanceof SecurityStateError) throw error;
    fail();
  }
}

export function pruneEvents(
  events: readonly WindowEvent[],
  now: number,
  period: number
): readonly WindowEvent[] {
  const cutoff = now - period;
  return events.filter((event) => event.at > cutoff);
}

export function sumEvents(events: readonly WindowEvent[], now: number, period: number): number {
  const cutoff = now - period;
  let total = 0;
  for (const event of events) {
    if (event.at > cutoff) {
      total += event.amount;
      if (!Number.isSafeInteger(total)) fail();
    }
  }
  return total;
}
