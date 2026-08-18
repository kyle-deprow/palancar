import {
  TableClient,
  TableTransaction,
  type TableEntity,
  type TableEntityResult
} from '@azure/data-tables';
import { ManagedIdentityCredential } from '@azure/identity';
import { types as utilTypes } from 'node:util';

import {
  AZURE_TRANSACTION_LIMIT,
  AzureTableBoundaryError,
  exactEtag,
  safeInt64,
  type AzureListPageInput,
  type AzureListPageResult,
  type AzureNewEntity,
  type AzureScalar,
  type AzureStoredEntity,
  type AzureTableClientLike,
  type AzureTableMutation
} from './azure-schema.js';
import { SecurityStateError } from './errors.js';
import { exactDataObject, positiveSafeInteger } from './schema.js';

type UnknownEntity = TableEntity<Record<string, unknown>>;

function boundary(kind: ConstructorParameters<typeof AzureTableBoundaryError>[0]): never {
  throw new AzureTableBoundaryError(kind);
}

function classify(error: unknown): never {
  if (error instanceof AzureTableBoundaryError) throw error;
  const statusCode = typeof error === 'object' && error !== null &&
    Object.hasOwn(error, 'statusCode') ? (error as { statusCode?: unknown }).statusCode : undefined;
  const code = typeof error === 'object' && error !== null &&
    Object.hasOwn(error, 'code') ? (error as { code?: unknown }).code : undefined;
  if (statusCode === 404 || code === 'ResourceNotFound') boundary('not-found');
  if (statusCode === 409 || code === 'EntityAlreadyExists') boundary('conflict');
  if (statusCode === 412 || code === 'UpdateConditionNotSatisfied') boundary('precondition-failed');
  if (
    statusCode === 408 || statusCode === 429 ||
    (typeof statusCode === 'number' && statusCode >= 500) ||
    ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(code))
  ) boundary('ambiguous');
  boundary('unavailable');
}

function sdkValue(value: AzureScalar): unknown {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) boundary('unavailable');
    return Object.freeze({ value: String(value), type: 'Int64' as const });
  }
  return value;
}

function toSdkEntity(entity: AzureNewEntity): UnknownEntity {
  const output: Record<string, unknown> = {
    partitionKey: entity.partitionKey,
    rowKey: entity.rowKey
  };
  for (const [key, value] of Object.entries(entity.properties)) output[key] = sdkValue(value);
  return output as UnknownEntity;
}

function plainValue(value: unknown): AzureScalar {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return safeInt64(value);
  if (
    typeof value !== 'object' || value === null || utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) boundary('unavailable');
  const input = exactDataObject(value, ['value', 'type'], [], 'state-unavailable');
  if (input.type === 'Int64' || input.type === 'Int32') return safeInt64(input.value);
  if (input.type === 'String' && typeof input.value === 'string') return input.value;
  if (input.type === 'Boolean') {
    if (typeof input.value === 'boolean') return input.value;
    if (input.value === 'true') return true;
    if (input.value === 'false') return false;
  }
  boundary('unavailable');
}

function fromSdkEntity(value: TableEntityResult<Record<string, unknown>>): AzureStoredEntity {
  try {
    if (utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      boundary('unavailable');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      if (!Object.hasOwn(descriptor, 'value')) boundary('unavailable');
    }
    const partitionKey = descriptors.partitionKey?.value;
    const rowKey = descriptors.rowKey?.value;
    const etag = descriptors.etag?.value;
    if (typeof partitionKey !== 'string' || typeof rowKey !== 'string') boundary('unavailable');
    const parsedEtag = exactEtag(etag);
    const properties: Record<string, AzureScalar> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (['partitionKey', 'rowKey', 'etag', 'timestamp', 'odata.metadata'].includes(key)) continue;
      properties[key] = plainValue(descriptor.value);
    }
    return Object.freeze({
      partitionKey,
      rowKey,
      etag: parsedEtag,
      properties: Object.freeze(properties)
    });
  } catch (error) {
    if (error instanceof AzureTableBoundaryError) throw error;
    if (error instanceof SecurityStateError) boundary('unavailable');
    boundary('unavailable');
  }
}

function signalOptions(signal: AbortSignal | undefined): { readonly abortSignal?: AbortSignal } {
  return signal === undefined ? {} : { abortSignal: signal };
}

class SdkAzureTableClient implements AzureTableClientLike {
  readonly #client: TableClient;

  constructor(client: TableClient) {
    this.#client = client;
    Object.freeze(this);
  }

  async pointRead(
    partitionKey: string,
    rowKey: string,
    signal?: AbortSignal
  ): Promise<AzureStoredEntity | undefined> {
    try {
      const entity = await this.#client.getEntity<Record<string, unknown>>(partitionKey, rowKey, {
        disableTypeConversion: true,
        ...signalOptions(signal)
      });
      return fromSdkEntity(entity);
    } catch (error) {
      try { classify(error); } catch (classified) {
        if (classified instanceof AzureTableBoundaryError && classified.kind === 'not-found') return undefined;
        throw classified;
      }
    }
  }

  async create(entity: AzureNewEntity, signal?: AbortSignal): Promise<void> {
    try {
      await this.#client.createEntity(toSdkEntity(entity), signalOptions(signal));
    } catch (error) {
      classify(error);
    }
  }

  async replace(entity: AzureNewEntity, etag: string, signal?: AbortSignal): Promise<void> {
    exactEtag(etag);
    try {
      await this.#client.updateEntity(toSdkEntity(entity), 'Replace', {
        etag,
        ...signalOptions(signal)
      });
    } catch (error) {
      classify(error);
    }
  }

  async delete(
    partitionKey: string,
    rowKey: string,
    etag: string,
    signal?: AbortSignal
  ): Promise<void> {
    exactEtag(etag);
    try {
      await this.#client.deleteEntity(partitionKey, rowKey, { etag, ...signalOptions(signal) });
    } catch (error) {
      classify(error);
    }
  }

  async transaction(mutations: readonly AzureTableMutation[], signal?: AbortSignal): Promise<void> {
    if (
      !Array.isArray(mutations) || mutations.length === 0 ||
      mutations.length > AZURE_TRANSACTION_LIMIT
    ) boundary('unavailable');
    const partitionKey = mutations[0]?.entity.partitionKey;
    if (partitionKey === undefined) boundary('unavailable');
    const transaction = new TableTransaction();
    for (const mutation of mutations) {
      const mutationPartition = mutation.entity.partitionKey;
      if (mutationPartition !== partitionKey) boundary('unavailable');
      if (mutation.type === 'create') {
        transaction.createEntity(toSdkEntity(mutation.entity));
      } else {
        exactEtag(mutation.etag);
        transaction.updateEntity(toSdkEntity(mutation.entity), 'Replace', { etag: mutation.etag });
      }
    }
    try {
      await this.#client.submitTransaction(transaction.actions, signalOptions(signal));
    } catch (error) {
      classify(error);
    }
  }

  async listPage(value: AzureListPageInput): Promise<AzureListPageResult> {
    const input = exactDataObject(
      value,
      ['limit'],
      ['partitionKey', 'continuationToken', 'signal'],
      'state-unavailable'
    );
    if (!positiveSafeInteger(input.limit) || input.limit > AZURE_TRANSACTION_LIMIT) boundary('unavailable');
    if (input.partitionKey !== undefined && typeof input.partitionKey !== 'string') boundary('unavailable');
    if (input.continuationToken !== undefined && typeof input.continuationToken !== 'string') {
      boundary('unavailable');
    }
    const filter = input.partitionKey === undefined
      ? undefined
      : `PartitionKey eq '${input.partitionKey.replaceAll("'", "''")}'`;
    try {
      const pages = this.#client.listEntities<Record<string, unknown>>({
        ...(filter === undefined ? {} : { queryOptions: { filter } }),
        disableTypeConversion: true,
        ...signalOptions(input.signal as AbortSignal | undefined)
      }).byPage({
        maxPageSize: input.limit,
        ...(input.continuationToken === undefined
          ? {}
          : { continuationToken: input.continuationToken as string })
      });
      const page = await pages.next();
      if (page.done) return Object.freeze({ entities: Object.freeze([]) });
      const entities = Object.freeze(page.value.map(fromSdkEntity));
      return Object.freeze({
        entities,
        ...(page.value.continuationToken === undefined
          ? {}
          : { continuationToken: page.value.continuationToken })
      });
    } catch (error) {
      classify(error);
    }
  }
}

/** Testing-only bridge for Azurite or deterministic SDK boundary tests. */
export function createAzureTableClientBoundaryForTesting(client: TableClient): AzureTableClientLike {
  if (!(client instanceof TableClient)) boundary('unavailable');
  return new SdkAzureTableClient(client);
}

export interface ProductionAzureClientsOptions {
  readonly endpoint: string;
  readonly securityTableName: string;
  readonly rateTableName: string;
  readonly managedIdentityClientId: string;
}

export function createProductionAzureClients(options: ProductionAzureClientsOptions): Readonly<{
  security: AzureTableClientLike;
  rate: AzureTableClientLike;
}> {
  const credential = new ManagedIdentityCredential({ clientId: options.managedIdentityClientId });
  const clientOptions = Object.freeze({ retryOptions: { maxRetries: 0 } });
  return Object.freeze({
    security: new SdkAzureTableClient(new TableClient(
      options.endpoint,
      options.securityTableName,
      credential,
      clientOptions
    )),
    rate: new SdkAzureTableClient(new TableClient(
      options.endpoint,
      options.rateTableName,
      credential,
      clientOptions
    ))
  });
}
