import { types as utilTypes } from 'node:util';

import {
  assertCanonical256BitToken,
  assertCanonicalPairingCode,
  assertCanonicalSha256,
  assertCanonicalUuid,
  hashCorrelationKey,
  hashCredential,
  hashPairingCode,
  hashTicket,
  type CanonicalSha256,
  type CanonicalUuid
} from './crypto.js';
import { createSystemClock, createSystemIdFactory, createSystemTokenFactory } from './clock.js';
import {
  createAzureCliOperatorClients,
  createProductionAzureClients
} from './azure-table-client.js';
import {
  AZURE_CAS_ATTEMPTS,
  AzureTableBoundaryError,
  decodeWindowEvents,
  encodeWindowEvents,
  exactAzureProperties,
  intField,
  newAzureEntity,
  optionalIntField,
  optionalStringField,
  positiveIntField,
  pruneEvents,
  requireEntityKey,
  stringField,
  sumEvents,
  type AzureNewEntity,
  type AzureStoredEntity,
  type AzureTableClientLike,
  type AzureTableMutation,
  type WindowEvent
} from './azure-schema.js';
import { SecurityStateError, type SecurityErrorCategory } from './errors.js';
import { boundedString, exactDataObject, nonNegativeSafeInteger, positiveSafeInteger } from './schema.js';
import {
  ACTIVE_LEASE_MS,
  ATTEMPTS_PER_MINUTE,
  ATTEMPTS_PER_SESSION,
  AUDIO_GRANT_TTL_MS,
  AUDIO_RESERVATION_WINDOW_MS,
  COLLISION_RETRY_LIMIT,
  CREDENTIAL_ABSOLUTE_TTL_MS,
  CREDENTIAL_IDLE_TTL_MS,
  DURABLE_SECURITY_STATE_STORE,
  GENERATIONS_PER_MINUTE,
  GENERATIONS_PER_SESSION,
  MAX_AUDIO_GRANT_SAMPLES,
  MAX_AUDIO_GRANTS_PER_WINDOW,
  MAX_AUDIO_SAMPLES_PER_WINDOW,
  MIN_AUDIO_GRANT_HANDOFF_MS,
  OPENING_LEASE_MS,
  PAIRING_TTL_MS,
  PENDING_CREDENTIAL_TTL_MS,
  RECONNECTS_PER_MINUTE,
  RECONNECTS_PER_TEN_MINUTES,
  REVOCATION_TOMBSTONE_TTL_MS,
  TICKET_TTL_MS,
  type ActivateSessionInput,
  type AudioGrant,
  type AuthenticateCredentialInput,
  type AuthorizeGenerationInput,
  type BeginCredentialRotationInput,
  type CleanupInput,
  type CleanupResult,
  type CompleteGenerationInput,
  type ConsumeTicketInput,
  type CredentialAuthentication,
  type CredentialPromotionResult,
  type DurableSecurityStateStore,
  type GenerationAuthorizationResult,
  type GenerationClaim,
  type GenerationClaimInput,
  type GenerationProviderStartResult,
  type HostTrustedOpaqueSource,
  type InstallationMutationResult,
  type InstallationRevocationResult,
  type IssuePairingInput,
  type PairingIssueResult,
  type PairingOperatorStore,
  type PairingRedemptionResult,
  type PendingCredentialResult,
  type PromoteCredentialInput,
  type RedeemPairingInput,
  type ReserveAudioInput,
  type RevokeInstallationInput,
  type RevokeCurrentInstallationInput,
  type RevokePairingInput,
  type SecurityAudience,
  type SecurityClock,
  type SecurityIdFactory,
  type SecurityStateMaintenanceStore,
  type SecurityTokenFactory,
  type SessionLease,
  type SessionLeaseInput,
  type SessionStartMessage,
  type SessionTicketResult,
  type TicketBinding,
  type TicketOperationInput
} from './types.js';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const TEN_MINUTES_MS = 600_000;
const HOUR_MS = 3_600_000;
const PAIR_ISSUES_PER_DAY = 20;
const PAIR_ATTEMPTS_PER_FIFTEEN_MINUTES = 5;
const PAIR_ATTEMPTS_PER_DAY = 20;
const TICKETS_PER_MINUTE = 6;
const TICKETS_PER_HOUR = 30;
const TERMINAL_GENERATION_TTL_MS = REVOCATION_TOMBSTONE_TTL_MS;

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUS = /^[a-z-]+$/;
const OPAQUE = /^[A-Za-z0-9._:@/-]+$/;

const DURABLE_CAPABILITIES = Object.freeze({
  durableAcrossProcesses: true,
  paidProvidersAllowed: true
} as const);

interface PairingRow {
  readonly entity: AzureStoredEntity;
  readonly hash: CanonicalSha256;
  readonly issueOperationId: CanonicalSha256;
  readonly operatorHash: CanonicalSha256;
  readonly audienceOrigin: string;
  readonly audiencePath: '/v1/stream';
  readonly audienceProtocol: 'palancar.v1';
  readonly status: 'issued' | 'consumed' | 'revoked' | 'expired';
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly consumedAt?: number | undefined;
  readonly revokedAt?: number | undefined;
  readonly consumedInstallationId?: CanonicalUuid | undefined;
}

interface CredentialRow {
  readonly entity: AzureStoredEntity;
  readonly hash: CanonicalSha256;
  readonly installationId: CanonicalUuid;
  readonly version: number;
  readonly audienceOrigin: string;
  readonly audiencePath: '/v1/stream';
  readonly audienceProtocol: 'palancar.v1';
  readonly status: 'current' | 'pending' | 'retired' | 'revoked' | 'expired';
  readonly issuedAt: number;
  readonly lastUsedAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly pendingExpiresAt?: number | undefined;
}

interface InstallationRow {
  readonly entity: AzureStoredEntity;
  readonly installationId: CanonicalUuid;
  readonly status: 'active' | 'revoked' | 'expired';
  readonly issuedAt: number;
  readonly lastActivityAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly currentCredentialHash: CanonicalSha256;
  readonly currentCredentialVersion: number;
  readonly pendingCredentialHash?: CanonicalSha256 | undefined;
  readonly pendingCredentialVersion?: number | undefined;
  readonly pendingExpiresAt?: number | undefined;
  readonly sessionEpoch: number;
  readonly activeSessionId?: CanonicalUuid | undefined;
  readonly activeSessionEpoch: number;
  readonly activeSessionLockVersion: number;
  readonly activeSessionLeaseVersion: number;
  readonly activeSessionLeaseExpiresAt: number;
  readonly tombstoneVersion: number;
  readonly revokedAt?: number | undefined;
  readonly expiredAt?: number | undefined;
}

interface TicketRow {
  readonly entity: AzureStoredEntity;
  readonly hash: CanonicalSha256;
  readonly issueOperationId: CanonicalSha256;
  readonly installationId: CanonicalUuid;
  readonly tombstoneVersion: number;
  readonly credentialVersion: number;
  readonly bindingHash: CanonicalSha256;
  readonly audienceOrigin: string;
  readonly audiencePath: '/v1/stream';
  readonly audienceProtocol: 'palancar.v1';
  readonly intent: 'new';
  readonly status: 'issued' | 'consumed' | 'expired';
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly consumedAt?: number | undefined;
  readonly consumedSessionId?: CanonicalUuid | undefined;
}

interface SessionRow {
  readonly entity: AzureStoredEntity;
  readonly installationId: CanonicalUuid;
  readonly status: 'none' | 'opening' | 'active' | 'ended' | 'expired' | 'revoked';
  readonly sessionId?: CanonicalUuid | undefined;
  readonly sessionEpoch: number;
  readonly credentialVersion: number;
  readonly tombstoneVersion: number;
  readonly leaseVersion: number;
  readonly leaseExpiresAt: number;
  readonly lastHeartbeatAt: number;
  readonly lastActivityAt: number;
  readonly ticketHash?: CanonicalSha256 | undefined;
  readonly ticketIssuedAt?: number | undefined;
  readonly activatedAt?: number | undefined;
  readonly lastOperationId?: string | undefined;
}

interface WindowRow {
  readonly entity?: AzureStoredEntity;
  readonly scope: string;
  readonly window: string;
  readonly events: readonly WindowEvent[];
  readonly retainUntil: number;
}

interface AudioWindowRow extends WindowRow {
  readonly installationId: CanonicalUuid;
  readonly sessionId?: CanonicalUuid | undefined;
  readonly sessionEpoch: number;
  readonly activeUtteranceId?: CanonicalUuid | undefined;
  readonly nextOriginalSampleOffset: number;
  readonly activeGrantExpiresAt: number;
}

interface AudioGrantRow {
  readonly entity: AzureStoredEntity;
  readonly grantId: CanonicalUuid;
  readonly utteranceId: CanonicalUuid;
  readonly installationId: CanonicalUuid;
  readonly sessionId: CanonicalUuid;
  readonly sessionEpoch: number;
  readonly sessionLeaseVersion: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly fromOriginalSampleOffset: number;
  readonly throughOriginalSampleOffset: number;
  readonly reservedOriginalSamples: number;
}

interface GenerationCounterRow {
  readonly entity?: AzureStoredEntity;
  readonly installationId: CanonicalUuid;
  readonly sessionId: CanonicalUuid;
  readonly sessionEpoch: number;
  readonly generatedEvents: readonly WindowEvent[];
  readonly attemptEvents: readonly WindowEvent[];
  readonly generatedTotal: number;
  readonly attemptTotal: number;
}

interface GenerationRow {
  readonly entity: AzureStoredEntity;
  readonly authorizationId: CanonicalSha256;
  readonly installationId: CanonicalUuid;
  readonly sessionId: CanonicalUuid;
  readonly sessionEpoch: number;
  readonly tombstoneVersion: number;
  readonly credentialVersion: number;
  readonly decision: 'target';
  readonly utteranceId: CanonicalUuid;
  readonly acceptedFinalRevision: number;
  readonly selectedTargetLanguage: string;
  readonly gatePolicyVersion: string;
  readonly transcriptHash: CanonicalSha256;
  readonly claimId: CanonicalUuid;
  readonly claimVersion: number;
  readonly leaseVersion: number;
  readonly leaseExpiresAt: number;
  readonly status: 'claimed' | 'started' | 'completed' | 'released';
  readonly startedConsumed: boolean;
  readonly authorizedAt: number;
  readonly providerStartedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly completionOutcome?: 'completed' | 'failed' | undefined;
  readonly providerStartOperationId?: string | undefined;
  readonly releasedFromClaimVersion?: number | undefined;
  readonly releasedFromLeaseVersion?: number | undefined;
  readonly releasedFromLeaseExpiresAt?: number | undefined;
  readonly retainUntil: number;
}

interface CoreOptions {
  readonly environment: string;
  readonly audience: SecurityAudience;
  readonly security: AzureTableClientLike;
  readonly rate: AzureTableClientLike;
  readonly clock: SecurityClock;
  readonly ids: SecurityIdFactory;
  readonly tokens: SecurityTokenFactory;
}

export interface AzureTableRuntimeStoreOptions {
  readonly endpoint: string;
  readonly securityTableName: string;
  readonly rateTableName: string;
  readonly environment: string;
  readonly audience: SecurityAudience;
  readonly managedIdentityClientId: string;
}

export interface AzureCliTableOperationsOptions {
  readonly endpoint: string;
  readonly securityTableName: string;
  readonly rateTableName: string;
  readonly environment: string;
  readonly audience: SecurityAudience;
}

export interface AzureTableTestingOptions {
  readonly environment: string;
  readonly audience: SecurityAudience;
  readonly securityTable: AzureTableClientLike;
  readonly rateTable: AzureTableClientLike;
  readonly clock?: SecurityClock;
  readonly ids?: SecurityIdFactory;
  readonly tokens?: SecurityTokenFactory;
}

export interface AzureTableBootstrapStore {
  readonly initializeState: (signal?: AbortSignal) => Promise<void>;
}

function fail(category: SecurityErrorCategory): never {
  throw new SecurityStateError(category);
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function checkedAdd(left: number, right: number, category: SecurityErrorCategory): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) fail(category);
  return value;
}

function checkedIncrement(value: number, category: SecurityErrorCategory): number {
  return checkedAdd(value, 1, category);
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function opaque(value: unknown, maximum = 128): string {
  if (!boundedString(value, maximum) || !OPAQUE.test(value)) fail('invalid-input');
  return value;
}

function operationId(value: string): CanonicalSha256 {
  return hashCorrelationKey(value);
}

function matchingHash(
  input: Readonly<Record<string, unknown>>,
  key: string,
  expected: CanonicalSha256
): CanonicalSha256 {
  const value = assertCanonicalSha256(stringField(input, key, HASH, 64));
  if (value !== expected) fail('state-unavailable');
  return value;
}

function matchingUuid(
  input: Readonly<Record<string, unknown>>,
  key: string,
  expected: CanonicalUuid
): CanonicalUuid {
  const value = assertCanonicalUuid(stringField(input, key, UUID, 36));
  if (value !== expected) fail('state-unavailable');
  return value;
}

function isBoundary(error: unknown, ...kinds: readonly string[]): boolean {
  return error instanceof AzureTableBoundaryError && kinds.includes(error.kind);
}

function mapBoundary(error: unknown): never {
  if (error instanceof SecurityStateError) throw error;
  fail('state-unavailable');
}

function canonicalAudience(value: unknown): SecurityAudience {
  const input = exactDataObject(value, ['origin', 'path', 'protocol']);
  if (input.path !== '/v1/stream' || input.protocol !== 'palancar.v1' || !boundedString(input.origin, 255)) {
    fail('invalid-input');
  }
  try {
    const url = new URL(input.origin);
    if (
      url.protocol !== 'wss:' || url.username !== '' || url.password !== '' ||
      url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.origin !== input.origin
    ) fail('invalid-input');
  } catch (error) {
    if (error instanceof SecurityStateError) throw error;
    fail('invalid-input');
  }
  return freeze({ origin: input.origin, path: '/v1/stream' as const, protocol: 'palancar.v1' as const });
}

function parseEnvironment(value: unknown): string {
  if (!boundedString(value, 64) || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) fail('invalid-input');
  return value;
}

function parseProductionOptions(value: unknown): AzureTableRuntimeStoreOptions {
  const input = exactDataObject(value, [
    'endpoint', 'securityTableName', 'rateTableName', 'environment', 'audience',
    'managedIdentityClientId'
  ]);
  if (!boundedString(input.endpoint, 255)) fail('invalid-input');
  try {
    const endpoint = new URL(input.endpoint);
    if (
      endpoint.protocol !== 'https:' ||
      (endpoint.origin !== input.endpoint && `${endpoint.origin}/` !== input.endpoint) ||
      endpoint.username !== '' || endpoint.password !== '' || endpoint.port !== '' ||
      endpoint.pathname !== '/' || endpoint.search !== '' || endpoint.hash !== '' ||
      !/^[a-z0-9]{3,24}\.table\.core\.windows\.net$/.test(endpoint.hostname)
    ) fail('invalid-input');
  } catch (error) {
    if (error instanceof SecurityStateError) throw error;
    fail('invalid-input');
  }
  for (const name of [input.securityTableName, input.rateTableName]) {
    if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(name)) fail('invalid-input');
  }
  if (input.securityTableName === input.rateTableName) fail('invalid-input');
  if (
    typeof input.managedIdentityClientId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.managedIdentityClientId)
  ) fail('invalid-input');
  return freeze({
    endpoint: new URL(input.endpoint).origin,
    securityTableName: input.securityTableName as string,
    rateTableName: input.rateTableName as string,
    environment: parseEnvironment(input.environment),
    audience: canonicalAudience(input.audience),
    managedIdentityClientId: input.managedIdentityClientId
  });
}

function parseAzureCliOperationsOptions(value: unknown): AzureCliTableOperationsOptions {
  const input = exactDataObject(value, [
    'endpoint', 'securityTableName', 'rateTableName', 'environment', 'audience'
  ]);
  const parsed = parseProductionOptions({
    ...input,
    managedIdentityClientId: '00000000-0000-4000-8000-000000000000'
  });
  return freeze({
    endpoint: parsed.endpoint,
    securityTableName: parsed.securityTableName,
    rateTableName: parsed.rateTableName,
    environment: parsed.environment,
    audience: parsed.audience
  });
}

function parseDependency(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) fail('invalid-input');
    const methods: Record<string, (...arguments_: readonly unknown[]) => unknown> = {};
    for (const key of keys) {
      let owner: object | null = value;
      let method: unknown;
      while (owner !== null) {
        if (utilTypes.isProxy(owner)) fail('invalid-input');
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (descriptor !== undefined) {
          if (!Object.hasOwn(descriptor, 'value')) fail('invalid-input');
          method = descriptor.value;
          break;
        }
        owner = Object.getPrototypeOf(owner) as object | null;
      }
      if (typeof method !== 'function' || utilTypes.isProxy(method)) fail('invalid-input');
      methods[key] = method.bind(value) as (...arguments_: readonly unknown[]) => unknown;
    }
    return Object.freeze(methods);
  } catch (error) {
    if (error instanceof SecurityStateError) throw error;
    fail('invalid-input');
  }
}

function parseTestingOptions(value: unknown): CoreOptions {
  const input = exactDataObject(
    value,
    ['environment', 'audience', 'securityTable', 'rateTable'],
    ['clock', 'ids', 'tokens']
  );
  const tableKeys = ['pointRead', 'create', 'replace', 'delete', 'transaction', 'listPage'] as const;
  const security = parseDependency(input.securityTable, tableKeys) as unknown as AzureTableClientLike;
  const rate = parseDependency(input.rateTable, tableKeys) as unknown as AzureTableClientLike;
  const clock = parseDependency(input.clock ?? createSystemClock(), ['now']) as unknown as SecurityClock;
  const ids = parseDependency(
    input.ids ?? createSystemIdFactory(),
    ['installationId', 'sessionId', 'grantId', 'generationClaimId']
  ) as unknown as SecurityIdFactory;
  const tokens = parseDependency(
    input.tokens ?? createSystemTokenFactory(),
    ['pairingCode', 'credential', 'ticket']
  ) as unknown as SecurityTokenFactory;
  return {
    environment: parseEnvironment(input.environment),
    audience: canonicalAudience(input.audience),
    security,
    rate,
    clock,
    ids,
    tokens
  };
}

function parseSessionLease(value: unknown): SessionLease {
  const input = exactDataObject(value, [
    'installationId', 'sessionId', 'sessionEpoch', 'credentialVersion',
    'leaseVersion', 'phase', 'leaseExpiresAt'
  ]);
  if (
    !positiveSafeInteger(input.sessionEpoch) || !positiveSafeInteger(input.credentialVersion) ||
    !positiveSafeInteger(input.leaseVersion) || !nonNegativeSafeInteger(input.leaseExpiresAt) ||
    (input.phase !== 'opening' && input.phase !== 'active')
  ) fail('invalid-input');
  return freeze({
    installationId: assertCanonicalUuid(input.installationId),
    sessionId: assertCanonicalUuid(input.sessionId),
    sessionEpoch: input.sessionEpoch,
    credentialVersion: input.credentialVersion,
    leaseVersion: input.leaseVersion,
    phase: input.phase,
    leaseExpiresAt: input.leaseExpiresAt
  });
}

function parseGenerationClaim(value: unknown): GenerationClaim {
  const input = exactDataObject(value, [
    'authorizationId', 'claimId', 'installationId', 'sessionId', 'sessionEpoch',
    'claimVersion', 'leaseVersion', 'phase', 'leaseExpiresAt'
  ]);
  if (
    !positiveSafeInteger(input.sessionEpoch) || !positiveSafeInteger(input.claimVersion) ||
    !positiveSafeInteger(input.leaseVersion) || !nonNegativeSafeInteger(input.leaseExpiresAt) ||
    !['claimed', 'started', 'completed', 'released'].includes(String(input.phase))
  ) fail('invalid-input');
  return freeze({
    authorizationId: assertCanonicalSha256(input.authorizationId),
    claimId: assertCanonicalUuid(input.claimId),
    installationId: assertCanonicalUuid(input.installationId),
    sessionId: assertCanonicalUuid(input.sessionId),
    sessionEpoch: input.sessionEpoch,
    claimVersion: input.claimVersion,
    leaseVersion: input.leaseVersion,
    phase: input.phase as GenerationClaim['phase'],
    leaseExpiresAt: input.leaseExpiresAt
  });
}

function securityKey(environment: string, rowKey: string): Readonly<{ partitionKey: string; rowKey: string }> {
  return { partitionKey: environment, rowKey };
}

function ratePartition(scope: string, value: string): string {
  return `${scope}:${hashCorrelationKey(value)}`;
}

function pairKey(hash: CanonicalSha256): string { return `pair:${hash}`; }
function credentialKey(hash: CanonicalSha256): string { return `credential:${hash}`; }
function installationKey(id: CanonicalUuid): string { return `installation:${id}`; }
function ticketKey(hash: CanonicalSha256): string { return `ticket:${hash}`; }
function sessionKey(id: CanonicalUuid): string { return `session:${id}`; }
function audioGrantKey(id: CanonicalUuid): string { return `audio-grant:${id}`; }
function generationKey(id: CanonicalSha256): string { return `generation:${id}`; }
function generationCounterKey(sessionId: CanonicalUuid, epoch: number): string {
  return `generation-counter:${sessionId}:${epoch}`;
}

function parsePairing(entity: AzureStoredEntity, environment: string, hash: CanonicalSha256): PairingRow {
  const key = securityKey(environment, pairKey(hash));
  requireEntityKey(entity, key.partitionKey, key.rowKey);
  const input = exactAzureProperties(entity.properties, environment, 'pairing', [
    'hash', 'issueOperationId', 'operatorHash', 'audienceOrigin', 'audiencePath',
    'audienceProtocol', 'status', 'issuedAt', 'expiresAt'
  ], ['consumedAt', 'revokedAt', 'consumedInstallationId']);
  const status = stringField(input, 'status', STATUS) as PairingRow['status'];
  if (!['issued', 'consumed', 'revoked', 'expired'].includes(status)) fail('state-unavailable');
  const row: PairingRow = {
    entity,
    hash: matchingHash(input, 'hash', hash),
    issueOperationId: assertCanonicalSha256(stringField(input, 'issueOperationId', HASH, 64)),
    operatorHash: assertCanonicalSha256(stringField(input, 'operatorHash', HASH, 64)),
    audienceOrigin: stringField(input, 'audienceOrigin', OPAQUE, 255),
    audiencePath: input.audiencePath === '/v1/stream' ? '/v1/stream' : fail('state-unavailable'),
    audienceProtocol: input.audienceProtocol === 'palancar.v1' ? 'palancar.v1' : fail('state-unavailable'),
    status,
    issuedAt: intField(input, 'issuedAt'),
    expiresAt: intField(input, 'expiresAt'),
    ...(optionalIntField(input, 'consumedAt') === undefined ? {} : { consumedAt: optionalIntField(input, 'consumedAt') }),
    ...(optionalIntField(input, 'revokedAt') === undefined ? {} : { revokedAt: optionalIntField(input, 'revokedAt') }),
    ...(optionalStringField(input, 'consumedInstallationId', UUID, 36) === undefined
      ? {}
      : { consumedInstallationId: assertCanonicalUuid(optionalStringField(input, 'consumedInstallationId', UUID, 36)) })
  };
  if (
    (row.status === 'consumed' && (row.consumedAt === undefined || row.consumedInstallationId === undefined)) ||
    (row.status === 'revoked' && row.revokedAt === undefined)
  ) fail('state-unavailable');
  return row;
}

function pairingEntity(environment: string, row: Omit<PairingRow, 'entity'>): AzureNewEntity {
  return newAzureEntity(environment, pairKey(row.hash), environment, 'pairing', {
    hash: row.hash,
    issueOperationId: row.issueOperationId,
    operatorHash: row.operatorHash,
    audienceOrigin: row.audienceOrigin,
    audiencePath: row.audiencePath,
    audienceProtocol: row.audienceProtocol,
    status: row.status,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    ...(row.consumedAt === undefined ? {} : { consumedAt: row.consumedAt }),
    ...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt }),
    ...(row.consumedInstallationId === undefined ? {} : { consumedInstallationId: row.consumedInstallationId })
  });
}

function parseCredential(
  entity: AzureStoredEntity,
  environment: string,
  hash: CanonicalSha256
): CredentialRow {
  const key = securityKey(environment, credentialKey(hash));
  requireEntityKey(entity, key.partitionKey, key.rowKey);
  const input = exactAzureProperties(entity.properties, environment, 'credential', [
    'hash', 'installationId', 'version', 'audienceOrigin', 'audiencePath',
    'audienceProtocol', 'status', 'issuedAt', 'lastUsedAt', 'idleExpiresAt',
    'absoluteExpiresAt'
  ], ['pendingExpiresAt']);
  const status = stringField(input, 'status', STATUS) as CredentialRow['status'];
  if (!['current', 'pending', 'retired', 'revoked', 'expired'].includes(status)) fail('state-unavailable');
  const row: CredentialRow = {
    entity,
    hash: matchingHash(input, 'hash', hash),
    installationId: assertCanonicalUuid(stringField(input, 'installationId', UUID, 36)),
    version: positiveIntField(input, 'version'),
    audienceOrigin: stringField(input, 'audienceOrigin', OPAQUE, 255),
    audiencePath: input.audiencePath === '/v1/stream' ? '/v1/stream' : fail('state-unavailable'),
    audienceProtocol: input.audienceProtocol === 'palancar.v1' ? 'palancar.v1' : fail('state-unavailable'),
    status,
    issuedAt: intField(input, 'issuedAt'),
    lastUsedAt: intField(input, 'lastUsedAt'),
    idleExpiresAt: intField(input, 'idleExpiresAt'),
    absoluteExpiresAt: intField(input, 'absoluteExpiresAt'),
    ...(optionalIntField(input, 'pendingExpiresAt') === undefined
      ? {}
      : { pendingExpiresAt: optionalIntField(input, 'pendingExpiresAt') })
  };
  if (
    row.lastUsedAt < row.issuedAt || row.idleExpiresAt < row.lastUsedAt ||
    row.idleExpiresAt > row.absoluteExpiresAt ||
    (row.status === 'pending' && row.pendingExpiresAt === undefined)
  ) fail('state-unavailable');
  return row;
}

function credentialEntity(environment: string, row: Omit<CredentialRow, 'entity'>): AzureNewEntity {
  return newAzureEntity(environment, credentialKey(row.hash), environment, 'credential', {
    hash: row.hash,
    installationId: row.installationId,
    version: row.version,
    audienceOrigin: row.audienceOrigin,
    audiencePath: row.audiencePath,
    audienceProtocol: row.audienceProtocol,
    status: row.status,
    issuedAt: row.issuedAt,
    lastUsedAt: row.lastUsedAt,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    ...(row.pendingExpiresAt === undefined ? {} : { pendingExpiresAt: row.pendingExpiresAt })
  });
}

function parseInstallation(
  entity: AzureStoredEntity,
  environment: string,
  installationId: CanonicalUuid
): InstallationRow {
  const key = securityKey(environment, installationKey(installationId));
  requireEntityKey(entity, key.partitionKey, key.rowKey);
  const input = exactAzureProperties(entity.properties, environment, 'installation', [
    'installationId', 'status', 'issuedAt', 'lastActivityAt', 'idleExpiresAt',
    'absoluteExpiresAt', 'currentCredentialHash', 'currentCredentialVersion', 'sessionEpoch',
    'activeSessionEpoch', 'activeSessionLockVersion', 'activeSessionLeaseVersion',
    'activeSessionLeaseExpiresAt', 'tombstoneVersion'
  ], [
    'activeSessionId', 'pendingCredentialHash', 'pendingCredentialVersion', 'pendingExpiresAt',
    'revokedAt', 'expiredAt'
  ]);
  const status = stringField(input, 'status', STATUS) as InstallationRow['status'];
  if (!['active', 'revoked', 'expired'].includes(status)) fail('state-unavailable');
  const row: InstallationRow = {
    entity,
    installationId: matchingUuid(input, 'installationId', installationId),
    status,
    issuedAt: intField(input, 'issuedAt'),
    lastActivityAt: intField(input, 'lastActivityAt'),
    idleExpiresAt: intField(input, 'idleExpiresAt'),
    absoluteExpiresAt: intField(input, 'absoluteExpiresAt'),
    currentCredentialHash: assertCanonicalSha256(stringField(input, 'currentCredentialHash', HASH, 64)),
    currentCredentialVersion: positiveIntField(input, 'currentCredentialVersion'),
    ...(optionalStringField(input, 'pendingCredentialHash', HASH, 64) === undefined
      ? {}
      : { pendingCredentialHash: assertCanonicalSha256(optionalStringField(input, 'pendingCredentialHash', HASH, 64)) }),
    ...(optionalIntField(input, 'pendingCredentialVersion') === undefined
      ? {}
      : { pendingCredentialVersion: optionalIntField(input, 'pendingCredentialVersion') }),
    ...(optionalIntField(input, 'pendingExpiresAt') === undefined ? {} : { pendingExpiresAt: optionalIntField(input, 'pendingExpiresAt') }),
    sessionEpoch: intField(input, 'sessionEpoch'),
    ...(optionalStringField(input, 'activeSessionId', UUID, 36) === undefined
      ? {}
      : { activeSessionId: assertCanonicalUuid(optionalStringField(input, 'activeSessionId', UUID, 36)) }),
    activeSessionEpoch: intField(input, 'activeSessionEpoch'),
    activeSessionLockVersion: intField(input, 'activeSessionLockVersion'),
    activeSessionLeaseVersion: intField(input, 'activeSessionLeaseVersion'),
    activeSessionLeaseExpiresAt: intField(input, 'activeSessionLeaseExpiresAt'),
    tombstoneVersion: positiveIntField(input, 'tombstoneVersion'),
    ...(optionalIntField(input, 'revokedAt') === undefined ? {} : { revokedAt: optionalIntField(input, 'revokedAt') }),
    ...(optionalIntField(input, 'expiredAt') === undefined ? {} : { expiredAt: optionalIntField(input, 'expiredAt') })
  };
  if (
    row.lastActivityAt < row.issuedAt || row.idleExpiresAt < row.lastActivityAt ||
    row.idleExpiresAt > row.absoluteExpiresAt || row.activeSessionEpoch > row.sessionEpoch ||
    (row.status === 'revoked' && row.revokedAt === undefined) ||
    (row.status === 'expired' && row.expiredAt === undefined)
  ) fail('state-unavailable');
  return row;
}

function installationEntity(environment: string, row: Omit<InstallationRow, 'entity'>): AzureNewEntity {
  return newAzureEntity(environment, installationKey(row.installationId), environment, 'installation', {
    installationId: row.installationId,
    status: row.status,
    issuedAt: row.issuedAt,
    lastActivityAt: row.lastActivityAt,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    currentCredentialHash: row.currentCredentialHash,
    currentCredentialVersion: row.currentCredentialVersion,
    ...(row.pendingCredentialHash === undefined ? {} : { pendingCredentialHash: row.pendingCredentialHash }),
    ...(row.pendingCredentialVersion === undefined ? {} : { pendingCredentialVersion: row.pendingCredentialVersion }),
    ...(row.pendingExpiresAt === undefined ? {} : { pendingExpiresAt: row.pendingExpiresAt }),
    sessionEpoch: row.sessionEpoch,
    ...(row.activeSessionId === undefined ? {} : { activeSessionId: row.activeSessionId }),
    activeSessionEpoch: row.activeSessionEpoch,
    activeSessionLockVersion: row.activeSessionLockVersion,
    activeSessionLeaseVersion: row.activeSessionLeaseVersion,
    activeSessionLeaseExpiresAt: row.activeSessionLeaseExpiresAt,
    tombstoneVersion: row.tombstoneVersion,
    ...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt }),
    ...(row.expiredAt === undefined ? {} : { expiredAt: row.expiredAt })
  });
}

function parseTicket(entity: AzureStoredEntity, environment: string, hash: CanonicalSha256): TicketRow {
  const key = securityKey(environment, ticketKey(hash));
  requireEntityKey(entity, key.partitionKey, key.rowKey);
  const input = exactAzureProperties(entity.properties, environment, 'ticket', [
    'hash', 'issueOperationId', 'installationId', 'tombstoneVersion', 'credentialVersion',
    'bindingHash', 'audienceOrigin', 'audiencePath', 'audienceProtocol', 'intent', 'status',
    'issuedAt', 'expiresAt'
  ], ['consumedAt', 'consumedSessionId']);
  const status = stringField(input, 'status', STATUS) as TicketRow['status'];
  if (!['issued', 'consumed', 'expired'].includes(status)) fail('state-unavailable');
  const row: TicketRow = {
    entity,
    hash: matchingHash(input, 'hash', hash),
    issueOperationId: assertCanonicalSha256(stringField(input, 'issueOperationId', HASH, 64)),
    installationId: assertCanonicalUuid(stringField(input, 'installationId', UUID, 36)),
    tombstoneVersion: positiveIntField(input, 'tombstoneVersion'),
    credentialVersion: positiveIntField(input, 'credentialVersion'),
    bindingHash: assertCanonicalSha256(stringField(input, 'bindingHash', HASH, 64)),
    audienceOrigin: stringField(input, 'audienceOrigin', OPAQUE, 255),
    audiencePath: input.audiencePath === '/v1/stream' ? '/v1/stream' : fail('state-unavailable'),
    audienceProtocol: input.audienceProtocol === 'palancar.v1' ? 'palancar.v1' : fail('state-unavailable'),
    intent: input.intent === 'new' ? 'new' : fail('state-unavailable'),
    status,
    issuedAt: intField(input, 'issuedAt'),
    expiresAt: intField(input, 'expiresAt'),
    ...(optionalIntField(input, 'consumedAt') === undefined ? {} : { consumedAt: optionalIntField(input, 'consumedAt') }),
    ...(optionalStringField(input, 'consumedSessionId', UUID, 36) === undefined
      ? {}
      : { consumedSessionId: assertCanonicalUuid(optionalStringField(input, 'consumedSessionId', UUID, 36)) })
  };
  if (
    (row.status === 'consumed' && (row.consumedAt === undefined || row.consumedSessionId === undefined)) ||
    row.expiresAt < row.issuedAt || row.bindingHash !== hashCorrelationKey(JSON.stringify([
      environment,
      row.audienceOrigin,
      row.audiencePath,
      row.audienceProtocol,
      row.intent
    ]))
  ) fail('state-unavailable');
  return row;
}

function ticketEntity(environment: string, row: Omit<TicketRow, 'entity'>): AzureNewEntity {
  return newAzureEntity(environment, ticketKey(row.hash), environment, 'ticket', {
    hash: row.hash,
    issueOperationId: row.issueOperationId,
    installationId: row.installationId,
    tombstoneVersion: row.tombstoneVersion,
    credentialVersion: row.credentialVersion,
    bindingHash: row.bindingHash,
    audienceOrigin: row.audienceOrigin,
    audiencePath: row.audiencePath,
    audienceProtocol: row.audienceProtocol,
    intent: row.intent,
    status: row.status,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    ...(row.consumedAt === undefined ? {} : { consumedAt: row.consumedAt }),
    ...(row.consumedSessionId === undefined ? {} : { consumedSessionId: row.consumedSessionId })
  });
}

function parseSession(
  entity: AzureStoredEntity,
  environment: string,
  installationId: CanonicalUuid
): SessionRow {
  const key = securityKey(environment, sessionKey(installationId));
  requireEntityKey(entity, key.partitionKey, key.rowKey);
  const input = exactAzureProperties(entity.properties, environment, 'session', [
    'installationId', 'status', 'sessionEpoch', 'credentialVersion', 'tombstoneVersion',
    'leaseVersion', 'leaseExpiresAt', 'lastHeartbeatAt', 'lastActivityAt'
  ], ['sessionId', 'ticketHash', 'ticketIssuedAt', 'activatedAt', 'lastOperationId']);
  const status = stringField(input, 'status', STATUS) as SessionRow['status'];
  if (!['none', 'opening', 'active', 'ended', 'expired', 'revoked'].includes(status)) fail('state-unavailable');
  const sessionIdValue = optionalStringField(input, 'sessionId', UUID, 36);
  if (status !== 'none' && sessionIdValue === undefined) fail('state-unavailable');
  const row: SessionRow = {
    entity,
    installationId: matchingUuid(input, 'installationId', installationId),
    status,
    ...(sessionIdValue === undefined ? {} : { sessionId: assertCanonicalUuid(sessionIdValue) }),
    sessionEpoch: intField(input, 'sessionEpoch'),
    credentialVersion: positiveIntField(input, 'credentialVersion'),
    tombstoneVersion: positiveIntField(input, 'tombstoneVersion'),
    leaseVersion: intField(input, 'leaseVersion'),
    leaseExpiresAt: intField(input, 'leaseExpiresAt'),
    lastHeartbeatAt: intField(input, 'lastHeartbeatAt'),
    lastActivityAt: intField(input, 'lastActivityAt'),
    ...(optionalStringField(input, 'ticketHash', HASH, 64) === undefined
      ? {}
      : { ticketHash: assertCanonicalSha256(optionalStringField(input, 'ticketHash', HASH, 64)) }),
    ...(optionalIntField(input, 'ticketIssuedAt') === undefined
      ? {}
      : { ticketIssuedAt: optionalIntField(input, 'ticketIssuedAt') }),
    ...(optionalIntField(input, 'activatedAt') === undefined
      ? {}
      : { activatedAt: optionalIntField(input, 'activatedAt') }),
    ...(optionalStringField(input, 'lastOperationId', HASH, 64) === undefined
      ? {}
      : { lastOperationId: optionalStringField(input, 'lastOperationId', HASH, 64) })
  };
  if (
    (status === 'none' && (row.sessionId !== undefined || row.ticketHash !== undefined)) ||
    ((status === 'opening' || status === 'active') &&
      (row.ticketHash === undefined || row.ticketIssuedAt === undefined)) ||
    (status === 'active' && row.activatedAt === undefined)
  ) fail('state-unavailable');
  return row;
}

function sessionEntity(environment: string, row: Omit<SessionRow, 'entity'>): AzureNewEntity {
  return newAzureEntity(environment, sessionKey(row.installationId), environment, 'session', {
    installationId: row.installationId,
    status: row.status,
    ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
    sessionEpoch: row.sessionEpoch,
    credentialVersion: row.credentialVersion,
    tombstoneVersion: row.tombstoneVersion,
    leaseVersion: row.leaseVersion,
    leaseExpiresAt: row.leaseExpiresAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    lastActivityAt: row.lastActivityAt,
    ...(row.ticketHash === undefined ? {} : { ticketHash: row.ticketHash }),
    ...(row.ticketIssuedAt === undefined ? {} : { ticketIssuedAt: row.ticketIssuedAt }),
    ...(row.activatedAt === undefined ? {} : { activatedAt: row.activatedAt }),
    ...(row.lastOperationId === undefined ? {} : { lastOperationId: row.lastOperationId })
  });
}

function sessionStateMatches(
  row: SessionRow,
  expected: Omit<SessionRow, 'entity'>
): boolean {
  return row.installationId === expected.installationId &&
    row.status === expected.status &&
    row.sessionId === expected.sessionId &&
    row.sessionEpoch === expected.sessionEpoch &&
    row.credentialVersion === expected.credentialVersion &&
    row.tombstoneVersion === expected.tombstoneVersion &&
    row.leaseVersion === expected.leaseVersion &&
    row.leaseExpiresAt === expected.leaseExpiresAt &&
    row.lastHeartbeatAt === expected.lastHeartbeatAt &&
    row.lastActivityAt === expected.lastActivityAt &&
    row.ticketHash === expected.ticketHash &&
    row.ticketIssuedAt === expected.ticketIssuedAt &&
    row.activatedAt === expected.activatedAt &&
    row.lastOperationId === expected.lastOperationId;
}

function parseWindow(
  entity: AzureStoredEntity | undefined,
  environment: string,
  partitionKey: string,
  rowKey: string,
  scope: string,
  window: string
): WindowRow {
  if (entity === undefined) return { scope, window, events: Object.freeze([]), retainUntil: 0 };
  requireEntityKey(entity, partitionKey, rowKey);
  const input = exactAzureProperties(entity.properties, environment, 'rate', [
    'scope', 'window', 'events', 'retainUntil'
  ]);
  if (input.scope !== scope || input.window !== window) fail('state-unavailable');
  return {
    entity,
    scope,
    window,
    events: decodeWindowEvents(input.events),
    retainUntil: intField(input, 'retainUntil')
  };
}

function windowEntity(
  environment: string,
  partitionKey: string,
  rowKey: string,
  row: Omit<WindowRow, 'entity'>
): AzureNewEntity {
  return newAzureEntity(partitionKey, rowKey, environment, 'rate', {
    scope: row.scope,
    window: row.window,
    events: encodeWindowEvents(row.events),
    retainUntil: row.retainUntil
  });
}

function parseAudioWindow(
  entity: AzureStoredEntity | undefined,
  environment: string,
  partitionKey: string,
  rowKey: string,
  scope: string,
  window: string,
  installationId: CanonicalUuid,
  sessionId: CanonicalUuid | undefined,
  sessionEpoch: number
): AudioWindowRow {
  if (entity === undefined) {
    return {
      scope,
      window,
      events: Object.freeze([]),
      retainUntil: 0,
      installationId,
      ...(sessionId === undefined ? {} : { sessionId }),
      sessionEpoch,
      nextOriginalSampleOffset: 0,
      activeGrantExpiresAt: 0
    };
  }
  requireEntityKey(entity, partitionKey, rowKey);
  const input = exactAzureProperties(entity.properties, environment, 'audio-window', [
    'scope', 'window', 'events', 'retainUntil', 'installationId', 'sessionEpoch',
    'nextOriginalSampleOffset', 'activeGrantExpiresAt'
  ], ['sessionId', 'activeUtteranceId']);
  if (input.scope !== scope || input.window !== window) fail('state-unavailable');
  const activeUtteranceId = optionalStringField(input, 'activeUtteranceId', UUID, 36);
  const parsedInstallationId = assertCanonicalUuid(stringField(input, 'installationId', UUID, 36));
  const parsedSessionIdValue = optionalStringField(input, 'sessionId', UUID, 36);
  const parsedSessionId = parsedSessionIdValue === undefined
    ? undefined
    : assertCanonicalUuid(parsedSessionIdValue);
  if (
    parsedInstallationId !== installationId || parsedSessionId !== sessionId ||
    intField(input, 'sessionEpoch') !== sessionEpoch
  ) fail('state-unavailable');
  return {
    entity,
    scope,
    window,
    events: decodeWindowEvents(input.events),
    retainUntil: intField(input, 'retainUntil'),
    installationId: parsedInstallationId,
    ...(parsedSessionId === undefined ? {} : { sessionId: parsedSessionId }),
    sessionEpoch,
    ...(activeUtteranceId === undefined
      ? {}
      : { activeUtteranceId: assertCanonicalUuid(activeUtteranceId) }),
    nextOriginalSampleOffset: intField(input, 'nextOriginalSampleOffset'),
    activeGrantExpiresAt: intField(input, 'activeGrantExpiresAt')
  };
}

function audioWindowEntity(
  environment: string,
  partitionKey: string,
  rowKey: string,
  row: Omit<AudioWindowRow, 'entity'>
): AzureNewEntity {
  return newAzureEntity(partitionKey, rowKey, environment, 'audio-window', {
    scope: row.scope,
    window: row.window,
    events: encodeWindowEvents(row.events),
    retainUntil: row.retainUntil,
    installationId: row.installationId,
    ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
    sessionEpoch: row.sessionEpoch,
    ...(row.activeUtteranceId === undefined ? {} : { activeUtteranceId: row.activeUtteranceId }),
    nextOriginalSampleOffset: row.nextOriginalSampleOffset,
    activeGrantExpiresAt: row.activeGrantExpiresAt
  });
}

function parseAudioGrant(
  entity: AzureStoredEntity,
  environment: string,
  partitionKey: string,
  grantId: CanonicalUuid
): AudioGrantRow {
  requireEntityKey(entity, partitionKey, audioGrantKey(grantId));
  const input = exactAzureProperties(entity.properties, environment, 'audio-grant', [
    'grantId', 'utteranceId', 'installationId', 'sessionId', 'sessionEpoch',
    'sessionLeaseVersion', 'issuedAt', 'expiresAt', 'fromOriginalSampleOffset',
    'throughOriginalSampleOffset', 'reservedOriginalSamples'
  ]);
  const row: AudioGrantRow = {
    entity,
    grantId: assertCanonicalUuid(stringField(input, 'grantId', UUID, 36)),
    utteranceId: assertCanonicalUuid(stringField(input, 'utteranceId', UUID, 36)),
    installationId: assertCanonicalUuid(stringField(input, 'installationId', UUID, 36)),
    sessionId: assertCanonicalUuid(stringField(input, 'sessionId', UUID, 36)),
    sessionEpoch: positiveIntField(input, 'sessionEpoch'),
    sessionLeaseVersion: positiveIntField(input, 'sessionLeaseVersion'),
    issuedAt: intField(input, 'issuedAt'),
    expiresAt: intField(input, 'expiresAt'),
    fromOriginalSampleOffset: intField(input, 'fromOriginalSampleOffset'),
    throughOriginalSampleOffset: positiveIntField(input, 'throughOriginalSampleOffset'),
    reservedOriginalSamples: positiveIntField(input, 'reservedOriginalSamples')
  };
  if (
    row.grantId !== grantId ||
    row.throughOriginalSampleOffset - row.fromOriginalSampleOffset !== row.reservedOriginalSamples
  ) fail('state-unavailable');
  return row;
}

function audioGrantEntity(
  environment: string,
  partitionKey: string,
  row: Omit<AudioGrantRow, 'entity'>
): AzureNewEntity {
  return newAzureEntity(partitionKey, audioGrantKey(row.grantId), environment, 'audio-grant', {
    grantId: row.grantId,
    utteranceId: row.utteranceId,
    installationId: row.installationId,
    sessionId: row.sessionId,
    sessionEpoch: row.sessionEpoch,
    sessionLeaseVersion: row.sessionLeaseVersion,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    fromOriginalSampleOffset: row.fromOriginalSampleOffset,
    throughOriginalSampleOffset: row.throughOriginalSampleOffset,
    reservedOriginalSamples: row.reservedOriginalSamples
  });
}

function parseGenerationCounter(
  entity: AzureStoredEntity | undefined,
  environment: string,
  partitionKey: string,
  installationId: CanonicalUuid,
  sessionId: CanonicalUuid,
  sessionEpoch: number
): GenerationCounterRow {
  if (entity === undefined) {
    return {
      installationId,
      sessionId,
      sessionEpoch,
      generatedEvents: Object.freeze([]),
      attemptEvents: Object.freeze([]),
      generatedTotal: 0,
      attemptTotal: 0
    };
  }
  const rowKey = generationCounterKey(sessionId, sessionEpoch);
  requireEntityKey(entity, partitionKey, rowKey);
  const input = exactAzureProperties(entity.properties, environment, 'generation-counter', [
    'installationId', 'sessionId', 'sessionEpoch', 'generatedEvents', 'attemptEvents',
    'generatedTotal', 'attemptTotal'
  ]);
  const row: GenerationCounterRow = {
    entity,
    installationId: assertCanonicalUuid(stringField(input, 'installationId', UUID, 36)),
    sessionId: assertCanonicalUuid(stringField(input, 'sessionId', UUID, 36)),
    sessionEpoch: positiveIntField(input, 'sessionEpoch'),
    generatedEvents: decodeWindowEvents(input.generatedEvents),
    attemptEvents: decodeWindowEvents(input.attemptEvents),
    generatedTotal: intField(input, 'generatedTotal'),
    attemptTotal: intField(input, 'attemptTotal')
  };
  if (
    row.installationId !== installationId || row.sessionId !== sessionId ||
    row.sessionEpoch !== sessionEpoch
  ) fail('state-unavailable');
  return row;
}

function generationCounterEntity(
  environment: string,
  partitionKey: string,
  row: Omit<GenerationCounterRow, 'entity'>
): AzureNewEntity {
  return newAzureEntity(
    partitionKey,
    generationCounterKey(row.sessionId, row.sessionEpoch),
    environment,
    'generation-counter',
    {
      installationId: row.installationId,
      sessionId: row.sessionId,
      sessionEpoch: row.sessionEpoch,
      generatedEvents: encodeWindowEvents(row.generatedEvents),
      attemptEvents: encodeWindowEvents(row.attemptEvents),
      generatedTotal: row.generatedTotal,
      attemptTotal: row.attemptTotal
    }
  );
}

function parseGeneration(
  entity: AzureStoredEntity,
  environment: string,
  partitionKey: string,
  authorizationId: CanonicalSha256
): GenerationRow {
  requireEntityKey(entity, partitionKey, generationKey(authorizationId));
  const input = exactAzureProperties(entity.properties, environment, 'generation', [
    'authorizationId', 'installationId', 'sessionId', 'sessionEpoch', 'tombstoneVersion',
    'credentialVersion', 'decision', 'utteranceId', 'acceptedFinalRevision',
    'selectedTargetLanguage', 'gatePolicyVersion', 'transcriptHash', 'claimId', 'claimVersion',
    'leaseVersion', 'leaseExpiresAt', 'status', 'startedConsumed', 'authorizedAt', 'retainUntil'
  ], [
    'providerStartedAt', 'completedAt', 'completionOutcome', 'providerStartOperationId',
    'releasedFromClaimVersion', 'releasedFromLeaseVersion', 'releasedFromLeaseExpiresAt'
  ]);
  const status = stringField(input, 'status', STATUS) as GenerationRow['status'];
  if (!['claimed', 'started', 'completed', 'released'].includes(status) || typeof input.startedConsumed !== 'boolean') {
    fail('state-unavailable');
  }
  const completionOutcome = optionalStringField(input, 'completionOutcome', STATUS, 16);
  if (completionOutcome !== undefined && completionOutcome !== 'completed' && completionOutcome !== 'failed') {
    fail('state-unavailable');
  }
  const row: GenerationRow = {
    entity,
    authorizationId: assertCanonicalSha256(stringField(input, 'authorizationId', HASH, 64)),
    installationId: assertCanonicalUuid(stringField(input, 'installationId', UUID, 36)),
    sessionId: assertCanonicalUuid(stringField(input, 'sessionId', UUID, 36)),
    sessionEpoch: positiveIntField(input, 'sessionEpoch'),
    tombstoneVersion: positiveIntField(input, 'tombstoneVersion'),
    credentialVersion: positiveIntField(input, 'credentialVersion'),
    decision: input.decision === 'target' ? 'target' : fail('state-unavailable'),
    utteranceId: assertCanonicalUuid(stringField(input, 'utteranceId', UUID, 36)),
    acceptedFinalRevision: positiveIntField(input, 'acceptedFinalRevision'),
    selectedTargetLanguage: stringField(input, 'selectedTargetLanguage', /^[a-z0-9-]+$/, 32),
    gatePolicyVersion: stringField(input, 'gatePolicyVersion', /^[A-Za-z0-9._-]+$/, 64),
    transcriptHash: assertCanonicalSha256(stringField(input, 'transcriptHash', HASH, 64)),
    claimId: assertCanonicalUuid(stringField(input, 'claimId', UUID, 36)),
    claimVersion: positiveIntField(input, 'claimVersion'),
    leaseVersion: positiveIntField(input, 'leaseVersion'),
    leaseExpiresAt: intField(input, 'leaseExpiresAt'),
    status,
    startedConsumed: input.startedConsumed,
    authorizedAt: intField(input, 'authorizedAt'),
    ...(optionalIntField(input, 'providerStartedAt') === undefined ? {} : { providerStartedAt: optionalIntField(input, 'providerStartedAt') }),
    ...(optionalIntField(input, 'completedAt') === undefined ? {} : { completedAt: optionalIntField(input, 'completedAt') }),
    ...(completionOutcome === undefined ? {} : { completionOutcome }),
    ...(optionalStringField(input, 'providerStartOperationId', HASH, 64) === undefined
      ? {}
      : { providerStartOperationId: optionalStringField(input, 'providerStartOperationId', HASH, 64) }),
    ...(optionalIntField(input, 'releasedFromClaimVersion') === undefined
      ? {}
      : { releasedFromClaimVersion: optionalIntField(input, 'releasedFromClaimVersion') }),
    ...(optionalIntField(input, 'releasedFromLeaseVersion') === undefined
      ? {}
      : { releasedFromLeaseVersion: optionalIntField(input, 'releasedFromLeaseVersion') }),
    ...(optionalIntField(input, 'releasedFromLeaseExpiresAt') === undefined
      ? {}
      : { releasedFromLeaseExpiresAt: optionalIntField(input, 'releasedFromLeaseExpiresAt') }),
    retainUntil: intField(input, 'retainUntil')
  };
  const expectedAuthorizationId = hashCorrelationKey(JSON.stringify([
    row.installationId,
    row.sessionId,
    row.sessionEpoch,
    row.credentialVersion,
    row.decision,
    row.utteranceId,
    row.acceptedFinalRevision,
    row.selectedTargetLanguage,
    row.gatePolicyVersion,
    row.transcriptHash
  ]));
  if (row.authorizationId !== authorizationId || row.authorizationId !== expectedAuthorizationId) {
    fail('state-unavailable');
  }
  return row;
}

function generationEntity(
  environment: string,
  partitionKey: string,
  row: Omit<GenerationRow, 'entity'>
): AzureNewEntity {
  return newAzureEntity(partitionKey, generationKey(row.authorizationId), environment, 'generation', {
    authorizationId: row.authorizationId,
    installationId: row.installationId,
    sessionId: row.sessionId,
    sessionEpoch: row.sessionEpoch,
    tombstoneVersion: row.tombstoneVersion,
    credentialVersion: row.credentialVersion,
    decision: row.decision,
    utteranceId: row.utteranceId,
    acceptedFinalRevision: row.acceptedFinalRevision,
    selectedTargetLanguage: row.selectedTargetLanguage,
    gatePolicyVersion: row.gatePolicyVersion,
    transcriptHash: row.transcriptHash,
    claimId: row.claimId,
    claimVersion: row.claimVersion,
    leaseVersion: row.leaseVersion,
    leaseExpiresAt: row.leaseExpiresAt,
    status: row.status,
    startedConsumed: row.startedConsumed,
    authorizedAt: row.authorizedAt,
    ...(row.providerStartedAt === undefined ? {} : { providerStartedAt: row.providerStartedAt }),
    ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
    ...(row.completionOutcome === undefined ? {} : { completionOutcome: row.completionOutcome }),
    ...(row.providerStartOperationId === undefined ? {} : { providerStartOperationId: row.providerStartOperationId }),
    ...(row.releasedFromClaimVersion === undefined ? {} : { releasedFromClaimVersion: row.releasedFromClaimVersion }),
    ...(row.releasedFromLeaseVersion === undefined ? {} : { releasedFromLeaseVersion: row.releasedFromLeaseVersion }),
    ...(row.releasedFromLeaseExpiresAt === undefined ? {} : { releasedFromLeaseExpiresAt: row.releasedFromLeaseExpiresAt }),
    retainUntil: row.retainUntil
  });
}

class AzureSecurityStateCore {
  readonly environment: string;
  readonly audience: SecurityAudience;
  readonly #security: AzureTableClientLike;
  readonly #rate: AzureTableClientLike;
  readonly #clock: SecurityClock;
  readonly #ids: SecurityIdFactory;
  readonly #tokens: SecurityTokenFactory;
  #lastNow = 0;
  #externalActive = false;
  #cleanupSecurityToken: string | undefined;
  #cleanupRateToken: string | undefined;
  #cleanupTable: 'security' | 'rate' = 'security';
  #cleanupSecurityExhausted = false;
  #cleanupRateExhausted = false;

  constructor(options: CoreOptions) {
    this.environment = options.environment;
    this.audience = options.audience;
    this.#security = options.security;
    this.#rate = options.rate;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#tokens = options.tokens;
    Object.freeze(this);
  }

  #external<T>(callback: () => T): T {
    if (this.#externalActive) fail('state-unavailable');
    this.#externalActive = true;
    try {
      return callback();
    } catch (error) {
      if (error instanceof SecurityStateError) throw error;
      fail('state-unavailable');
    } finally {
      this.#externalActive = false;
    }
  }

  #now(minimum = this.#lastNow): number {
    const now = this.#external(() => this.#clock.now());
    if (!nonNegativeSafeInteger(now) || now < minimum || now < this.#lastNow) fail('state-unavailable');
    this.#lastNow = now;
    return now;
  }

  #candidate<T extends string>(
    factory: () => string,
    validate: (value: unknown) => T
  ): T {
    try {
      return validate(this.#external(factory));
    } catch (error) {
      if (error instanceof SecurityStateError) fail('state-unavailable');
      throw error;
    }
  }

  async #point(
    table: AzureTableClientLike,
    partitionKey: string,
    rowKey: string,
    signal?: AbortSignal
  ): Promise<AzureStoredEntity | undefined> {
    try {
      return await table.pointRead(partitionKey, rowKey, signal);
    } catch (error) {
      mapBoundary(error);
    }
  }

  async #chargeWindow(
    partitionKey: string,
    rowKey: string,
    scope: string,
    window: string,
    operation: string,
    now: number,
    maximumPeriod: number,
    limits: readonly Readonly<{ period: number; maximum: number }>[],
    amount = 1
  ): Promise<void> {
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const entity = await this.#point(this.#rate, partitionKey, rowKey);
      const current = parseWindow(entity, this.environment, partitionKey, rowKey, scope, window);
      const events = pruneEvents(current.events, now, maximumPeriod);
      if (events.some((event) => event.operationId === operation)) return;
      for (const limit of limits) {
        if (sumEvents(events, now, limit.period) + amount > limit.maximum) fail('quota-exceeded');
      }
      const nextEvents = Object.freeze([...events, Object.freeze({ at: now, amount, operationId: operation })]);
      const next = windowEntity(this.environment, partitionKey, rowKey, {
        scope,
        window,
        events: nextEvents,
        retainUntil: checkedAdd(now, maximumPeriod, 'state-unavailable')
      });
      try {
        if (entity === undefined) await this.#rate.create(next);
        else await this.#rate.replace(next, entity.etag);
        return;
      } catch (error) {
        if (isBoundary(error, 'conflict', 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciledEntity = await this.#point(this.#rate, partitionKey, rowKey);
          const reconciled = parseWindow(
            reconciledEntity,
            this.environment,
            partitionKey,
            rowKey,
            scope,
            window
          );
          if (reconciled.events.some((event) => event.operationId === operation)) return;
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  #binding(input: Readonly<Record<string, unknown>>, category: SecurityErrorCategory): TicketBinding {
    let audience: SecurityAudience;
    try { audience = canonicalAudience(input.audience); } catch { fail(category); }
    if (input.environment !== this.environment || input.intent !== 'new') fail(category);
    if (
      audience.origin !== this.audience.origin || audience.path !== this.audience.path ||
      audience.protocol !== this.audience.protocol
    ) fail(category);
    return freeze({ environment: this.environment, audience: this.audience, intent: 'new' as const });
  }

  #bindingHash(binding: TicketBinding): CanonicalSha256 {
    return hashCorrelationKey(JSON.stringify([
      binding.environment,
      binding.audience.origin,
      binding.audience.path,
      binding.audience.protocol,
      binding.intent
    ]));
  }

  #credentialValid(row: CredentialRow, installation: InstallationRow, now: number, pending: boolean): boolean {
    if (
      !this.#credentialAudienceMatches(row) ||
      installation.status !== 'active' || now >= installation.idleExpiresAt ||
      now >= installation.absoluteExpiresAt ||
      now >= row.absoluteExpiresAt || now >= row.idleExpiresAt
    ) return false;
    if (pending) {
      return row.status === 'pending' && row.pendingExpiresAt !== undefined && now < row.pendingExpiresAt &&
        installation.pendingCredentialHash === row.hash && installation.pendingCredentialVersion === row.version &&
        installation.pendingExpiresAt !== undefined && now < installation.pendingExpiresAt;
    }
    return row.status === 'current' && installation.currentCredentialHash === row.hash &&
      installation.currentCredentialVersion === row.version;
  }

  #sessionActive(session: SessionRow, installation: InstallationRow, now: number): boolean {
    return session.status === 'active' && session.sessionId !== undefined && now < session.leaseExpiresAt &&
      installation.status === 'active' && now < installation.idleExpiresAt &&
      now < installation.absoluteExpiresAt &&
      session.tombstoneVersion === installation.tombstoneVersion &&
      session.credentialVersion === installation.currentCredentialVersion &&
      installation.activeSessionId === session.sessionId &&
      installation.activeSessionEpoch === session.sessionEpoch &&
      installation.activeSessionLeaseVersion === session.leaseVersion &&
      installation.activeSessionLeaseExpiresAt === session.leaseExpiresAt;
  }

  #audioGrant(row: Omit<AudioGrantRow, 'entity'> | AudioGrantRow): AudioGrant {
    return freeze({
      grantId: row.grantId,
      utteranceId: row.utteranceId,
      installationId: row.installationId,
      sessionId: row.sessionId,
      sessionEpoch: row.sessionEpoch,
      sessionLeaseVersion: row.sessionLeaseVersion,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      fromOriginalSampleOffset: row.fromOriginalSampleOffset,
      throughOriginalSampleOffset: row.throughOriginalSampleOffset,
      reservedOriginalSamples: row.reservedOriginalSamples
    });
  }

  #touchInstallation(row: InstallationRow, now: number): Omit<InstallationRow, 'entity'> {
    return {
      ...row,
      lastActivityAt: now,
      idleExpiresAt: Math.min(
        checkedAdd(now, CREDENTIAL_IDLE_TTL_MS, 'state-unavailable'),
        row.absoluteExpiresAt
      )
    };
  }

  #pairingAudienceMatches(row: PairingRow): boolean {
    return row.audienceOrigin === this.audience.origin && row.audiencePath === this.audience.path &&
      row.audienceProtocol === this.audience.protocol;
  }

  #credentialAudienceMatches(row: CredentialRow): boolean {
    return row.audienceOrigin === this.audience.origin && row.audiencePath === this.audience.path &&
      row.audienceProtocol === this.audience.protocol;
  }

  #ticketBindingMatches(row: TicketRow, binding: TicketBinding, bindingHash: CanonicalSha256): boolean {
    return row.bindingHash === bindingHash && row.audienceOrigin === binding.audience.origin &&
      row.audiencePath === binding.audience.path && row.audienceProtocol === binding.audience.protocol &&
      row.intent === binding.intent;
  }

  #lease(row: SessionRow): SessionLease {
    if (row.sessionId === undefined || row.status === 'none') fail('state-unavailable');
    return freeze({
      installationId: row.installationId,
      sessionId: row.sessionId,
      sessionEpoch: row.sessionEpoch,
      credentialVersion: row.credentialVersion,
      leaseVersion: row.leaseVersion,
      phase: row.status === 'opening' ? 'opening' as const : 'active' as const,
      leaseExpiresAt: row.leaseExpiresAt
    });
  }

  #leaseMatches(lease: SessionLease, row: SessionRow): boolean {
    return row.sessionId !== undefined && lease.installationId === row.installationId &&
      lease.sessionId === row.sessionId && lease.sessionEpoch === row.sessionEpoch &&
      lease.credentialVersion === row.credentialVersion && lease.leaseVersion === row.leaseVersion &&
      lease.leaseExpiresAt === row.leaseExpiresAt &&
      lease.phase === (row.status === 'opening' ? 'opening' : 'active');
  }

  #claim(row: Omit<GenerationRow, 'entity'> | GenerationRow): GenerationClaim {
    return freeze({
      authorizationId: row.authorizationId,
      claimId: row.claimId,
      installationId: row.installationId,
      sessionId: row.sessionId,
      sessionEpoch: row.sessionEpoch,
      claimVersion: row.claimVersion,
      leaseVersion: row.leaseVersion,
      phase: row.status,
      leaseExpiresAt: row.leaseExpiresAt
    });
  }

  #claimMatches(claim: GenerationClaim, row: GenerationRow): boolean {
    return claim.authorizationId === row.authorizationId && claim.claimId === row.claimId &&
      claim.installationId === row.installationId && claim.sessionId === row.sessionId &&
      claim.sessionEpoch === row.sessionEpoch && claim.claimVersion === row.claimVersion &&
      claim.leaseVersion === row.leaseVersion && claim.phase === row.status &&
      claim.leaseExpiresAt === row.leaseExpiresAt;
  }

  async #generationSessionValid(row: GenerationRow | Omit<GenerationRow, 'entity'>, now: number): Promise<boolean> {
    const sessionEntityValue = await this.#point(
      this.#security,
      this.environment,
      sessionKey(row.installationId)
    );
    const installationEntityValue = await this.#point(
      this.#security,
      this.environment,
      installationKey(row.installationId)
    );
    if (sessionEntityValue === undefined || installationEntityValue === undefined) return false;
    const session = parseSession(sessionEntityValue, this.environment, row.installationId);
    const installation = parseInstallation(installationEntityValue, this.environment, row.installationId);
    return this.#sessionActive(session, installation, now) && session.sessionId === row.sessionId &&
      session.sessionEpoch === row.sessionEpoch && session.credentialVersion === row.credentialVersion &&
      row.tombstoneVersion === installation.tombstoneVersion;
  }

  async issuePairing(value: IssuePairingInput): Promise<PairingIssueResult> {
    const input = exactDataObject(value, ['operatorScope']);
    const operatorScope = opaque(input.operatorScope);
    const operatorPartition = ratePartition('operator', operatorScope);
    const operatorHash = hashCorrelationKey(operatorScope);
    const issueOperationId = operationId(this.#candidate(this.#ids.generationClaimId, assertCanonicalUuid));
    for (let attempt = 0; attempt < COLLISION_RETRY_LIMIT; attempt += 1) {
      const pairingCode = this.#candidate(this.#tokens.pairingCode, assertCanonicalPairingCode);
      const hash = hashPairingCode(pairingCode);
      const now = this.#now();
      const expiresAt = checkedAdd(now, PAIRING_TTL_MS, 'state-unavailable');
      await this.#chargeWindow(
        operatorPartition,
        'rate:pair-issue',
        operatorHash,
        'pair-issue',
        issueOperationId,
        now,
        DAY_MS,
        [{ period: DAY_MS, maximum: PAIR_ISSUES_PER_DAY }]
      );
      const row: Omit<PairingRow, 'entity'> = {
        hash,
        issueOperationId,
        operatorHash,
        audienceOrigin: this.audience.origin,
        audiencePath: this.audience.path,
        audienceProtocol: this.audience.protocol,
        status: 'issued',
        issuedAt: now,
        expiresAt
      };
      try {
        await this.#security.create(pairingEntity(this.environment, row));
        return freeze({ pairingCode, issuedAt: now, expiresAt });
      } catch (error) {
        if (isBoundary(error, 'conflict')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const existing = await this.#point(this.#security, this.environment, pairKey(hash));
          if (existing !== undefined) {
            const parsed = parsePairing(existing, this.environment, hash);
            if (
              parsed.status === 'issued' && parsed.issueOperationId === issueOperationId &&
              parsed.issuedAt === now && parsed.expiresAt === expiresAt
            ) {
              return freeze({ pairingCode, issuedAt: now, expiresAt });
            }
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async revokePairing(value: RevokePairingInput): Promise<void> {
    const input = exactDataObject(value, ['pairingHash']);
    const hash = assertCanonicalSha256(input.pairingHash);
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const entity = await this.#point(this.#security, this.environment, pairKey(hash));
      if (entity === undefined) fail('invalid-pairing');
      const row = parsePairing(entity, this.environment, hash);
      const now = this.#now();
      if (row.status !== 'issued' || now >= row.expiresAt) fail('invalid-pairing');
      const next: Omit<PairingRow, 'entity'> = { ...row, status: 'revoked', revokedAt: now };
      try {
        await this.#security.replace(pairingEntity(this.environment, next), entity.etag);
        return;
      } catch (error) {
        if (isBoundary(error, 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciled = await this.#point(this.#security, this.environment, pairKey(hash));
          if (reconciled !== undefined && parsePairing(reconciled, this.environment, hash).status === 'revoked') return;
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async redeemPairing(value: RedeemPairingInput): Promise<PairingRedemptionResult> {
    const input = exactDataObject(value, ['pairingCode', 'trustedSource']);
    const trustedSource = opaque(input.trustedSource as HostTrustedOpaqueSource);
    const sourcePartition = ratePartition('source', trustedSource);
    const attemptUuid = this.#candidate(this.#ids.generationClaimId, assertCanonicalUuid);
    const now = this.#now();
    await this.#chargeWindow(
      sourcePartition,
      'rate:pair-attempt',
      hashCorrelationKey(trustedSource),
      'pair-attempt',
      operationId(attemptUuid),
      now,
      DAY_MS,
      [
        { period: 15 * MINUTE_MS, maximum: PAIR_ATTEMPTS_PER_FIFTEEN_MINUTES },
        { period: DAY_MS, maximum: PAIR_ATTEMPTS_PER_DAY }
      ]
    );
    let hash: CanonicalSha256;
    try { hash = hashPairingCode(input.pairingCode); } catch { fail('invalid-pairing'); }
    for (let attempt = 0; attempt < COLLISION_RETRY_LIMIT; attempt += 1) {
      const pairEntityValue = await this.#point(this.#security, this.environment, pairKey(hash));
      if (pairEntityValue === undefined) fail('invalid-pairing');
      const pair = parsePairing(pairEntityValue, this.environment, hash);
      if (pair.status !== 'issued' || now >= pair.expiresAt || !this.#pairingAudienceMatches(pair)) {
        fail('invalid-pairing');
      }
      const installationId = this.#candidate(this.#ids.installationId, assertCanonicalUuid);
      const credential = this.#candidate(this.#tokens.credential, assertCanonical256BitToken);
      const credentialHash = hashCredential(credential);
      const absoluteExpiresAt = checkedAdd(now, CREDENTIAL_ABSOLUTE_TTL_MS, 'state-unavailable');
      const idleExpiresAt = Math.min(
        checkedAdd(now, CREDENTIAL_IDLE_TTL_MS, 'state-unavailable'),
        absoluteExpiresAt
      );
      const installation: Omit<InstallationRow, 'entity'> = {
        installationId,
        status: 'active',
        issuedAt: now,
        lastActivityAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
        currentCredentialHash: credentialHash,
        currentCredentialVersion: 1,
        sessionEpoch: 0,
        activeSessionEpoch: 0,
        activeSessionLockVersion: 0,
        activeSessionLeaseVersion: 0,
        activeSessionLeaseExpiresAt: 0,
        tombstoneVersion: 1
      };
      const credentialRow: Omit<CredentialRow, 'entity'> = {
        hash: credentialHash,
        installationId,
        version: 1,
        audienceOrigin: this.audience.origin,
        audiencePath: this.audience.path,
        audienceProtocol: this.audience.protocol,
        status: 'current',
        issuedAt: now,
        lastUsedAt: now,
        idleExpiresAt,
        absoluteExpiresAt
      };
      const session: Omit<SessionRow, 'entity'> = {
        installationId,
        status: 'none',
        sessionEpoch: 0,
        credentialVersion: 1,
        tombstoneVersion: 1,
        leaseVersion: 0,
        leaseExpiresAt: 0,
        lastHeartbeatAt: 0,
        lastActivityAt: now
      };
      const consumedPair: Omit<PairingRow, 'entity'> = {
        ...pair,
        status: 'consumed',
        consumedAt: now,
        consumedInstallationId: installationId
      };
      const mutations: readonly AzureTableMutation[] = [
        { type: 'replace', entity: pairingEntity(this.environment, consumedPair), etag: pair.entity.etag },
        { type: 'create', entity: installationEntity(this.environment, installation) },
        { type: 'create', entity: credentialEntity(this.environment, credentialRow) },
        { type: 'create', entity: sessionEntity(this.environment, session) }
      ];
      try {
        await this.#security.transaction(mutations);
        return freeze({
          installationId,
          credential,
          credentialVersion: 1 as const,
          idleExpiresAt,
          absoluteExpiresAt
        });
      } catch (error) {
        if (isBoundary(error, 'conflict', 'precondition-failed')) {
          const currentPairEntity = await this.#point(this.#security, this.environment, pairKey(hash));
          if (currentPairEntity === undefined || parsePairing(currentPairEntity, this.environment, hash).status !== 'issued') {
            fail('invalid-pairing');
          }
          continue;
        }
        if (isBoundary(error, 'ambiguous')) {
          const currentPairEntity = await this.#point(this.#security, this.environment, pairKey(hash));
          if (currentPairEntity !== undefined) {
            const currentPair = parsePairing(currentPairEntity, this.environment, hash);
            if (currentPair.status === 'consumed' && currentPair.consumedInstallationId === installationId) {
              return freeze({
                installationId,
                credential,
                credentialVersion: 1 as const,
                idleExpiresAt,
                absoluteExpiresAt
              });
            }
            if (currentPair.status !== 'issued') fail('invalid-pairing');
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async #readAuthentication(
    credentialValue: unknown,
    now: number,
    allowPending: boolean
  ): Promise<Readonly<{ credential: CredentialRow; installation: InstallationRow; pending: boolean }> | undefined> {
    let hash: CanonicalSha256;
    try { hash = hashCredential(credentialValue); } catch { return undefined; }
    const credentialEntityValue = await this.#point(this.#security, this.environment, credentialKey(hash));
    if (credentialEntityValue === undefined) return undefined;
    const credential = parseCredential(credentialEntityValue, this.environment, hash);
    const installationEntityValue = await this.#point(
      this.#security,
      this.environment,
      installationKey(credential.installationId)
    );
    if (installationEntityValue === undefined) return undefined;
    const installation = parseInstallation(
      installationEntityValue,
      this.environment,
      credential.installationId
    );
    const pending = credential.status === 'pending';
    if ((!allowPending && pending) || !this.#credentialValid(credential, installation, now, pending)) return undefined;
    return { credential, installation, pending };
  }

  async authenticateCredential(value: AuthenticateCredentialInput): Promise<CredentialAuthentication> {
    const input = exactDataObject(value, ['credential']);
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const now = this.#now();
      const authentication = await this.#readAuthentication(input.credential, now, false);
      if (authentication === undefined) fail('invalid-credential');
      const idleExpiresAt = Math.min(
        checkedAdd(now, CREDENTIAL_IDLE_TTL_MS, 'state-unavailable'),
        authentication.installation.absoluteExpiresAt
      );
      const nextCredential: Omit<CredentialRow, 'entity'> = {
        ...authentication.credential,
        lastUsedAt: now,
        idleExpiresAt
      };
      const nextInstallation = this.#touchInstallation(authentication.installation, now);
      const mutations: readonly AzureTableMutation[] = [
        {
          type: 'replace',
          entity: credentialEntity(this.environment, nextCredential),
          etag: authentication.credential.entity.etag
        },
        {
          type: 'replace',
          entity: installationEntity(this.environment, nextInstallation),
          etag: authentication.installation.entity.etag
        }
      ];
      try {
        await this.#security.transaction(mutations);
        return freeze({
          installationId: authentication.installation.installationId,
          credentialVersion: authentication.credential.version,
          authenticatedAt: now,
          idleExpiresAt,
          absoluteExpiresAt: authentication.installation.absoluteExpiresAt,
          promoted: false
        });
      } catch (error) {
        if (isBoundary(error, 'conflict', 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciled = await this.#readAuthentication(input.credential, now, false);
          if (
            reconciled !== undefined && reconciled.credential.lastUsedAt === now &&
            reconciled.credential.idleExpiresAt === idleExpiresAt
          ) {
            return freeze({
              installationId: reconciled.installation.installationId,
              credentialVersion: reconciled.credential.version,
              authenticatedAt: now,
              idleExpiresAt,
              absoluteExpiresAt: reconciled.installation.absoluteExpiresAt,
              promoted: false
            });
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async beginCredentialRotation(value: BeginCredentialRotationInput): Promise<PendingCredentialResult> {
    const input = exactDataObject(value, ['credential']);
    for (let attempt = 0; attempt < COLLISION_RETRY_LIMIT; attempt += 1) {
      const now = this.#now();
      const authentication = await this.#readAuthentication(input.credential, now, false);
      if (authentication === undefined) fail('invalid-credential');
      if (
        authentication.installation.pendingCredentialHash !== undefined &&
        authentication.installation.pendingExpiresAt !== undefined &&
        now < authentication.installation.pendingExpiresAt
      ) fail('credential-conflict');
      const pendingCredential = this.#candidate(this.#tokens.credential, assertCanonical256BitToken);
      const pendingHash = hashCredential(pendingCredential);
      const version = checkedIncrement(authentication.installation.currentCredentialVersion, 'invalid-credential');
      const pendingExpiresAt = Math.min(
        checkedAdd(now, PENDING_CREDENTIAL_TTL_MS, 'state-unavailable'),
        authentication.installation.absoluteExpiresAt
      );
      const idleExpiresAt = Math.min(
        checkedAdd(now, CREDENTIAL_IDLE_TTL_MS, 'state-unavailable'),
        authentication.installation.absoluteExpiresAt
      );
      const current: Omit<CredentialRow, 'entity'> = {
        ...authentication.credential,
        lastUsedAt: now,
        idleExpiresAt
      };
      const installation: Omit<InstallationRow, 'entity'> = {
        ...this.#touchInstallation(authentication.installation, now),
        pendingCredentialHash: pendingHash,
        pendingCredentialVersion: version,
        pendingExpiresAt
      };
      const pending: Omit<CredentialRow, 'entity'> = {
        hash: pendingHash,
        installationId: authentication.installation.installationId,
        version,
        audienceOrigin: this.audience.origin,
        audiencePath: this.audience.path,
        audienceProtocol: this.audience.protocol,
        status: 'pending',
        issuedAt: now,
        lastUsedAt: now,
        idleExpiresAt: pendingExpiresAt,
        absoluteExpiresAt: authentication.installation.absoluteExpiresAt,
        pendingExpiresAt
      };
      const mutations: AzureTableMutation[] = [
        { type: 'replace', entity: credentialEntity(this.environment, current), etag: authentication.credential.entity.etag },
        { type: 'replace', entity: installationEntity(this.environment, installation), etag: authentication.installation.entity.etag },
        { type: 'create', entity: credentialEntity(this.environment, pending) }
      ];
      if (authentication.installation.pendingCredentialHash !== undefined) {
        const oldPendingEntity = await this.#point(
          this.#security,
          this.environment,
          credentialKey(authentication.installation.pendingCredentialHash)
        );
        if (oldPendingEntity !== undefined) {
          const oldPending = parseCredential(
            oldPendingEntity,
            this.environment,
            authentication.installation.pendingCredentialHash
          );
          if (!this.#credentialAudienceMatches(oldPending)) fail('invalid-credential');
          mutations.push({
            type: 'replace',
            entity: credentialEntity(this.environment, { ...oldPending, status: 'expired' }),
            etag: oldPending.entity.etag
          });
        }
      }
      try {
        await this.#security.transaction(mutations);
        return freeze({
          installationId: installation.installationId,
          pendingCredential,
          pendingCredentialVersion: version,
          pendingExpiresAt,
          absoluteExpiresAt: installation.absoluteExpiresAt
        });
      } catch (error) {
        if (isBoundary(error, 'conflict', 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciledEntity = await this.#point(this.#security, this.environment, credentialKey(pendingHash));
          if (reconciledEntity !== undefined) {
            const reconciled = parseCredential(reconciledEntity, this.environment, pendingHash);
            if (reconciled.status === 'pending' && reconciled.version === version) {
              return freeze({
                installationId: installation.installationId,
                pendingCredential,
                pendingCredentialVersion: version,
                pendingExpiresAt,
                absoluteExpiresAt: installation.absoluteExpiresAt
              });
            }
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async promoteCredential(value: PromoteCredentialInput): Promise<CredentialPromotionResult> {
    const input = exactDataObject(value, ['pendingCredential']);
    try { hashCredential(input.pendingCredential); } catch { fail('invalid-credential'); }
    const operation = operationId(this.#candidate(this.#ids.generationClaimId, assertCanonicalUuid));
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const now = this.#now();
      const authentication = await this.#readAuthentication(input.pendingCredential, now, true);
      if (authentication === undefined) fail('invalid-credential');
      if (!authentication.pending) {
        if (authentication.credential.version <= 1) fail('invalid-credential');
        const idleExpiresAt = Math.min(
          checkedAdd(now, CREDENTIAL_IDLE_TTL_MS, 'state-unavailable'),
          authentication.installation.absoluteExpiresAt
        );
        if (
          authentication.credential.lastUsedAt === now &&
          authentication.credential.idleExpiresAt === idleExpiresAt &&
          authentication.installation.lastActivityAt === now &&
          authentication.installation.idleExpiresAt === idleExpiresAt
        ) {
          return freeze({
            installationId: authentication.installation.installationId,
            credentialVersion: authentication.credential.version,
            tombstoneVersion: authentication.installation.tombstoneVersion,
            status: 'already-promoted' as const,
            confirmedAt: now,
            idleExpiresAt,
            absoluteExpiresAt: authentication.installation.absoluteExpiresAt
          });
        }
        const credential: Omit<CredentialRow, 'entity'> = {
          ...authentication.credential,
          lastUsedAt: now,
          idleExpiresAt
        };
        const installation = this.#touchInstallation(authentication.installation, now);
        const mutations: readonly AzureTableMutation[] = [
          {
            type: 'replace',
            entity: credentialEntity(this.environment, credential),
            etag: authentication.credential.entity.etag
          },
          {
            type: 'replace',
            entity: installationEntity(this.environment, installation),
            etag: authentication.installation.entity.etag
          }
        ];
        try {
          await this.#security.transaction(mutations);
          return freeze({
            installationId: installation.installationId,
            credentialVersion: credential.version,
            tombstoneVersion: installation.tombstoneVersion,
            status: 'already-promoted' as const,
            confirmedAt: now,
            idleExpiresAt,
            absoluteExpiresAt: installation.absoluteExpiresAt
          });
        } catch (error) {
          if (isBoundary(error, 'conflict', 'precondition-failed')) continue;
          if (isBoundary(error, 'ambiguous')) {
            const reconciled = await this.#readAuthentication(input.pendingCredential, now, false);
            if (
              reconciled !== undefined && !reconciled.pending &&
              reconciled.credential.version === credential.version &&
              reconciled.credential.lastUsedAt === now &&
              reconciled.credential.idleExpiresAt === idleExpiresAt &&
              reconciled.installation.currentCredentialHash === credential.hash
            ) {
              return freeze({
                installationId: reconciled.installation.installationId,
                credentialVersion: reconciled.credential.version,
                tombstoneVersion: reconciled.installation.tombstoneVersion,
                status: 'already-promoted' as const,
                confirmedAt: now,
                idleExpiresAt,
                absoluteExpiresAt: reconciled.installation.absoluteExpiresAt
              });
            }
            continue;
          }
          mapBoundary(error);
        }
      }
      const currentEntity = await this.#point(
        this.#security,
        this.environment,
        credentialKey(authentication.installation.currentCredentialHash)
      );
      const sessionEntityValue = await this.#point(
        this.#security,
        this.environment,
        sessionKey(authentication.installation.installationId)
      );
      if (currentEntity === undefined || sessionEntityValue === undefined) fail('state-unavailable');
      const current = parseCredential(
        currentEntity,
        this.environment,
        authentication.installation.currentCredentialHash
      );
      const session = parseSession(
        sessionEntityValue,
        this.environment,
        authentication.installation.installationId
      );
      if (current.status !== 'current' || !this.#credentialAudienceMatches(current)) fail('invalid-credential');
      const invalidates = (session.status === 'opening' || session.status === 'active') &&
        session.credentialVersion !== authentication.credential.version;
      const idleExpiresAt = Math.min(
        checkedAdd(now, CREDENTIAL_IDLE_TTL_MS, 'state-unavailable'),
        authentication.installation.absoluteExpiresAt
      );
      const pending: Omit<CredentialRow, 'entity'> = {
        ...authentication.credential,
        status: 'current',
        lastUsedAt: now,
        idleExpiresAt,
        pendingExpiresAt: undefined
      };
      const installation: Omit<InstallationRow, 'entity'> = {
        ...this.#touchInstallation(authentication.installation, now),
        currentCredentialHash: pending.hash,
        currentCredentialVersion: pending.version,
        pendingCredentialHash: undefined,
        pendingCredentialVersion: undefined,
        pendingExpiresAt: undefined,
        ...(invalidates
          ? {
              activeSessionId: undefined,
              activeSessionEpoch: session.sessionEpoch,
              activeSessionLockVersion: checkedIncrement(
                authentication.installation.activeSessionLockVersion,
                'state-unavailable'
              ),
              activeSessionLeaseVersion: checkedIncrement(session.leaseVersion, 'state-unavailable'),
              activeSessionLeaseExpiresAt: now
            }
          : {})
      };
      const nextSession: Omit<SessionRow, 'entity'> = {
        ...session,
        lastOperationId: operation,
        ...(invalidates ? {
          status: 'ended' as const,
          leaseVersion: checkedIncrement(session.leaseVersion, 'state-unavailable'),
          leaseExpiresAt: now,
          lastActivityAt: now
        } : {})
      };
      const mutations: readonly AzureTableMutation[] = [
        { type: 'replace', entity: credentialEntity(this.environment, { ...current, status: 'retired' }), etag: current.entity.etag },
        { type: 'replace', entity: credentialEntity(this.environment, pending), etag: authentication.credential.entity.etag },
        { type: 'replace', entity: installationEntity(this.environment, installation), etag: authentication.installation.entity.etag },
        { type: 'replace', entity: sessionEntity(this.environment, nextSession), etag: session.entity.etag }
      ];
      try {
        await this.#security.transaction(mutations);
        return freeze({
          installationId: installation.installationId,
          credentialVersion: installation.currentCredentialVersion,
          tombstoneVersion: installation.tombstoneVersion,
          status: 'promoted' as const,
          confirmedAt: now,
          idleExpiresAt,
          absoluteExpiresAt: installation.absoluteExpiresAt,
          ...(invalidates && session.sessionId !== undefined ? {
            invalidatedSession: freeze({
              installationId: session.installationId,
              sessionId: session.sessionId,
              sessionEpoch: session.sessionEpoch
            })
          } : {})
        });
      } catch (error) {
        if (isBoundary(error, 'conflict', 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciled = await this.#readAuthentication(input.pendingCredential, now, false);
          const reconciledSessionEntity = await this.#point(
            this.#security,
            this.environment,
            sessionKey(authentication.installation.installationId)
          );
          const reconciledSession = reconciledSessionEntity === undefined
            ? undefined
            : parseSession(
                reconciledSessionEntity,
                this.environment,
                authentication.installation.installationId
              );
          if (
            reconciled !== undefined && !reconciled.pending &&
            reconciled.credential.version === pending.version &&
            reconciled.credential.lastUsedAt === now &&
            reconciled.credential.idleExpiresAt === idleExpiresAt &&
            reconciled.installation.lastActivityAt === installation.lastActivityAt &&
            reconciled.installation.idleExpiresAt === installation.idleExpiresAt &&
            reconciled.installation.currentCredentialHash === pending.hash &&
            reconciled.installation.currentCredentialVersion === pending.version &&
            reconciled.installation.pendingCredentialHash === undefined &&
            reconciledSession !== undefined &&
            sessionStateMatches(reconciledSession, nextSession)
          ) {
            return freeze({
              installationId: installation.installationId,
              credentialVersion: pending.version,
              tombstoneVersion: installation.tombstoneVersion,
              status: 'promoted' as const,
              confirmedAt: now,
              idleExpiresAt,
              absoluteExpiresAt: installation.absoluteExpiresAt,
              ...(invalidates && session.sessionId !== undefined ? {
                invalidatedSession: freeze({
                  installationId: session.installationId,
                  sessionId: session.sessionId,
                  sessionEpoch: session.sessionEpoch
                })
              } : {})
            });
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async revokeCurrentInstallation(value: RevokeCurrentInstallationInput): Promise<InstallationRevocationResult> {
    const input = exactDataObject(value, ['credential']);
    let credentialHash: CanonicalSha256;
    try { credentialHash = hashCredential(input.credential); } catch { fail('invalid-credential'); }
    const operation = operationId(this.#candidate(this.#ids.generationClaimId, assertCanonicalUuid));
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const now = this.#now();
      const credentialEntityValue = await this.#point(
        this.#security,
        this.environment,
        credentialKey(credentialHash)
      );
      if (credentialEntityValue === undefined) fail('invalid-credential');
      const credential = parseCredential(credentialEntityValue, this.environment, credentialHash);
      const installationEntityValue = await this.#point(
        this.#security,
        this.environment,
        installationKey(credential.installationId)
      );
      if (installationEntityValue === undefined) fail('invalid-credential');
      const installation = parseInstallation(
        installationEntityValue,
        this.environment,
        credential.installationId
      );
      if (
        credential.status === 'revoked' && installation.status === 'revoked' &&
        credential.hash === installation.currentCredentialHash &&
        credential.version === installation.currentCredentialVersion &&
        installation.revokedAt !== undefined &&
        this.#credentialAudienceMatches(credential)
      ) {
        const sessionEntityValue = await this.#point(
          this.#security,
          this.environment,
          sessionKey(installation.installationId)
        );
        const session = sessionEntityValue === undefined
          ? undefined
          : parseSession(sessionEntityValue, this.environment, installation.installationId);
        const invalidatedSession = session?.status === 'revoked' && session.sessionId !== undefined
          ? freeze({
              installationId: installation.installationId,
              sessionId: session.sessionId,
              sessionEpoch: session.sessionEpoch
            })
          : undefined;
        return freeze({
          installationId: installation.installationId,
          credentialVersion: installation.currentCredentialVersion,
          tombstoneVersion: installation.tombstoneVersion,
          status: 'already-revoked' as const,
          revokedAt: installation.revokedAt,
          ...(invalidatedSession === undefined ? {} : { invalidatedSession })
        });
      }
      if (
        credential.status !== 'current' ||
        !this.#credentialValid(credential, installation, now, false)
      ) fail('invalid-credential');
      const pendingEntity = installation.pendingCredentialHash === undefined
        ? undefined
        : await this.#point(this.#security, this.environment, credentialKey(installation.pendingCredentialHash));
      if (installation.pendingCredentialHash !== undefined && pendingEntity === undefined) fail('state-unavailable');
      const sessionEntityValue = await this.#point(
        this.#security,
        this.environment,
        sessionKey(installation.installationId)
      );
      if (sessionEntityValue === undefined) fail('state-unavailable');
      const pending = pendingEntity === undefined || installation.pendingCredentialHash === undefined
        ? undefined
        : parseCredential(pendingEntity, this.environment, installation.pendingCredentialHash);
      if (pending !== undefined && !this.#credentialAudienceMatches(pending)) fail('invalid-credential');
      const session = parseSession(sessionEntityValue, this.environment, installation.installationId);
      const invalidates = (session.status === 'opening' || session.status === 'active') &&
        session.sessionId !== undefined;
      const nextInstallation: Omit<InstallationRow, 'entity'> = {
        ...installation,
        status: 'revoked',
        tombstoneVersion: checkedIncrement(installation.tombstoneVersion, 'state-unavailable'),
        revokedAt: now,
        lastActivityAt: now,
        activeSessionId: undefined,
        activeSessionEpoch: session.sessionEpoch,
        activeSessionLockVersion: checkedIncrement(installation.activeSessionLockVersion, 'state-unavailable'),
        activeSessionLeaseVersion: invalidates
          ? checkedIncrement(session.leaseVersion, 'state-unavailable')
          : session.leaseVersion,
        activeSessionLeaseExpiresAt: now
      };
      const nextSession: Omit<SessionRow, 'entity'> = {
        ...session,
        lastOperationId: operation,
        ...(invalidates ? {
          status: 'revoked' as const,
          leaseVersion: checkedIncrement(session.leaseVersion, 'state-unavailable'),
          leaseExpiresAt: now,
          lastActivityAt: now
        } : {})
      };
      const mutations: AzureTableMutation[] = [
        {
          type: 'replace',
          entity: installationEntity(this.environment, nextInstallation),
          etag: installation.entity.etag
        },
        {
          type: 'replace',
          entity: credentialEntity(this.environment, { ...credential, status: 'revoked' }),
          etag: credential.entity.etag
        },
        {
          type: 'replace',
          entity: sessionEntity(this.environment, nextSession),
          etag: session.entity.etag
        }
      ];
      if (pending !== undefined) {
        mutations.push({
          type: 'replace',
          entity: credentialEntity(this.environment, { ...pending, status: 'revoked' }),
          etag: pending.entity.etag
        });
      }
      try {
        await this.#security.transaction(mutations);
        return freeze({
          installationId: installation.installationId,
          credentialVersion: installation.currentCredentialVersion,
          tombstoneVersion: nextInstallation.tombstoneVersion,
          status: 'revoked' as const,
          revokedAt: now,
          ...(invalidates && session.sessionId !== undefined ? {
            invalidatedSession: freeze({
              installationId: session.installationId,
              sessionId: session.sessionId,
              sessionEpoch: session.sessionEpoch
            })
          } : {})
        });
      } catch (error) {
        if (isBoundary(error, 'conflict', 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciledEntity = await this.#point(
            this.#security,
            this.environment,
            installationKey(installation.installationId)
          );
          const reconciledCredentialEntity = await this.#point(
            this.#security,
            this.environment,
            credentialKey(credential.hash)
          );
          const reconciledSessionEntity = await this.#point(
            this.#security,
            this.environment,
            sessionKey(installation.installationId)
          );
          if (
            reconciledEntity !== undefined &&
            reconciledCredentialEntity !== undefined &&
            reconciledSessionEntity !== undefined
          ) {
            const reconciled = parseInstallation(
              reconciledEntity,
              this.environment,
              installation.installationId
            );
            const reconciledCredential = parseCredential(
              reconciledCredentialEntity,
              this.environment,
              credential.hash
            );
            const reconciledSession = parseSession(
              reconciledSessionEntity,
              this.environment,
              installation.installationId
            );
            const reconciledPending = pending === undefined
              ? undefined
              : await this.#point(
                  this.#security,
                  this.environment,
                  credentialKey(pending.hash)
                );
            if (
              reconciled.status === 'revoked' &&
              reconciled.tombstoneVersion === nextInstallation.tombstoneVersion &&
              reconciled.revokedAt === now &&
              reconciled.currentCredentialHash === credential.hash &&
              reconciled.currentCredentialVersion === credential.version &&
              reconciled.lastActivityAt === nextInstallation.lastActivityAt &&
              reconciled.activeSessionId === undefined &&
              reconciledCredential.status === 'revoked' &&
              reconciledCredential.installationId === credential.installationId &&
              reconciledCredential.version === credential.version &&
              reconciledCredential.hash === credential.hash &&
              (pending === undefined || (
                reconciledPending !== undefined &&
                parseCredential(reconciledPending, this.environment, pending.hash).status === 'revoked'
              )) &&
              sessionStateMatches(reconciledSession, nextSession)
            ) {
              return freeze({
                installationId: reconciled.installationId,
                credentialVersion: reconciled.currentCredentialVersion,
                tombstoneVersion: reconciled.tombstoneVersion,
                status: 'revoked' as const,
                revokedAt: reconciled.revokedAt,
                ...(invalidates && session.sessionId !== undefined ? {
                  invalidatedSession: freeze({
                    installationId: session.installationId,
                    sessionId: session.sessionId,
                    sessionEpoch: session.sessionEpoch
                  })
                } : {})
              });
            }
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async revokeInstallation(value: RevokeInstallationInput): Promise<InstallationMutationResult> {
    const input = exactDataObject(value, ['installationId']);
    const installationId = assertCanonicalUuid(input.installationId);
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const now = this.#now();
      const installationEntityValue = await this.#point(
        this.#security,
        this.environment,
        installationKey(installationId)
      );
      if (installationEntityValue === undefined) fail('invalid-credential');
      const installation = parseInstallation(installationEntityValue, this.environment, installationId);
      if (installation.status !== 'active') fail('invalid-credential');
      const currentEntity = await this.#point(
        this.#security,
        this.environment,
        credentialKey(installation.currentCredentialHash)
      );
      const pendingEntity = installation.pendingCredentialHash === undefined
        ? undefined
        : await this.#point(this.#security, this.environment, credentialKey(installation.pendingCredentialHash));
      const sessionEntityValue = await this.#point(this.#security, this.environment, sessionKey(installationId));
      if (currentEntity === undefined || sessionEntityValue === undefined) fail('state-unavailable');
      const current = parseCredential(currentEntity, this.environment, installation.currentCredentialHash);
      const pending = pendingEntity === undefined || installation.pendingCredentialHash === undefined
        ? undefined : parseCredential(pendingEntity, this.environment, installation.pendingCredentialHash);
      if (
        !this.#credentialAudienceMatches(current) ||
        (pending !== undefined && !this.#credentialAudienceMatches(pending))
      ) fail('invalid-credential');
      const session = parseSession(sessionEntityValue, this.environment, installationId);
      const invalidates = (session.status === 'opening' || session.status === 'active') && session.sessionId !== undefined;
      const nextInstallation: Omit<InstallationRow, 'entity'> = {
        ...installation,
        status: 'revoked',
        tombstoneVersion: checkedIncrement(installation.tombstoneVersion, 'state-unavailable'),
        revokedAt: now,
        lastActivityAt: now,
        activeSessionId: undefined,
        activeSessionEpoch: session.sessionEpoch,
        activeSessionLockVersion: checkedIncrement(
          installation.activeSessionLockVersion,
          'state-unavailable'
        ),
        activeSessionLeaseVersion: invalidates
          ? checkedIncrement(session.leaseVersion, 'state-unavailable')
          : session.leaseVersion,
        activeSessionLeaseExpiresAt: now
      };
      const nextSession: Omit<SessionRow, 'entity'> = invalidates
        ? {
            ...session,
            status: 'revoked',
            leaseVersion: checkedIncrement(session.leaseVersion, 'state-unavailable'),
            leaseExpiresAt: now,
            lastActivityAt: now
          }
        : session;
      const mutations: AzureTableMutation[] = [
        { type: 'replace', entity: installationEntity(this.environment, nextInstallation), etag: installation.entity.etag },
        { type: 'replace', entity: credentialEntity(this.environment, { ...current, status: 'revoked' }), etag: current.entity.etag },
        { type: 'replace', entity: sessionEntity(this.environment, nextSession), etag: session.entity.etag }
      ];
      if (pending !== undefined) {
        mutations.push({
          type: 'replace',
          entity: credentialEntity(this.environment, { ...pending, status: 'revoked' }),
          etag: pending.entity.etag
        });
      }
      try {
        await this.#security.transaction(mutations);
        return freeze({
          installationId,
          credentialVersion: installation.currentCredentialVersion,
          tombstoneVersion: nextInstallation.tombstoneVersion,
          ...(invalidates && session.sessionId !== undefined ? {
            invalidatedSession: freeze({ installationId, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch })
          } : {})
        });
      } catch (error) {
        if (isBoundary(error, 'conflict', 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciledEntity = await this.#point(this.#security, this.environment, installationKey(installationId));
          if (reconciledEntity !== undefined) {
            const reconciled = parseInstallation(reconciledEntity, this.environment, installationId);
            if (reconciled.status === 'revoked' && reconciled.tombstoneVersion === nextInstallation.tombstoneVersion) {
              return freeze({
                installationId,
                credentialVersion: reconciled.currentCredentialVersion,
                tombstoneVersion: reconciled.tombstoneVersion,
                ...(invalidates && session.sessionId !== undefined ? {
                  invalidatedSession: freeze({ installationId, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch })
                } : {})
              });
            }
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async issueSessionTicket(value: TicketOperationInput): Promise<SessionTicketResult> {
    let input: Readonly<Record<string, unknown>>;
    let binding: TicketBinding;
    try {
      input = exactDataObject(value, ['credential', 'environment', 'audience', 'intent'], [], 'invalid-ticket');
      binding = this.#binding(input, 'invalid-ticket');
    } catch { fail('invalid-ticket'); }
    const bindingHash = this.#bindingHash(binding);
    const issueOperationId = operationId(this.#candidate(this.#ids.generationClaimId, assertCanonicalUuid));
    for (let attempt = 0; attempt < COLLISION_RETRY_LIMIT; attempt += 1) {
      const now = this.#now();
      const authentication = await this.#readAuthentication(input.credential, now, false);
      if (authentication === undefined) fail('invalid-ticket');
      const ticket = this.#candidate(this.#tokens.ticket, assertCanonical256BitToken);
      const hash = hashTicket(ticket);
      const installationPartition = ratePartition(
        'installation',
        authentication.installation.installationId
      );
      await this.#chargeWindow(
        installationPartition,
        'rate:ticket-issue',
        authentication.installation.installationId,
        'ticket-issue',
        issueOperationId,
        now,
        HOUR_MS,
        [
          { period: MINUTE_MS, maximum: TICKETS_PER_MINUTE },
          { period: HOUR_MS, maximum: TICKETS_PER_HOUR }
        ]
      );
      const expiresAt = checkedAdd(now, TICKET_TTL_MS, 'state-unavailable');
      const idleExpiresAt = Math.min(
        checkedAdd(now, CREDENTIAL_IDLE_TTL_MS, 'state-unavailable'),
        authentication.installation.absoluteExpiresAt
      );
      const ticketRow: Omit<TicketRow, 'entity'> = {
        hash,
        issueOperationId,
        installationId: authentication.installation.installationId,
        tombstoneVersion: authentication.installation.tombstoneVersion,
        credentialVersion: authentication.credential.version,
        bindingHash,
        audienceOrigin: binding.audience.origin,
        audiencePath: binding.audience.path,
        audienceProtocol: binding.audience.protocol,
        intent: binding.intent,
        status: 'issued',
        issuedAt: now,
        expiresAt
      };
      const nextCredential: Omit<CredentialRow, 'entity'> = {
        ...authentication.credential,
        lastUsedAt: now,
        idleExpiresAt
      };
      const nextInstallation = this.#touchInstallation(authentication.installation, now);
      const mutations: readonly AzureTableMutation[] = [
        { type: 'create', entity: ticketEntity(this.environment, ticketRow) },
        { type: 'replace', entity: credentialEntity(this.environment, nextCredential), etag: authentication.credential.entity.etag },
        {
          type: 'replace',
          entity: installationEntity(this.environment, nextInstallation),
          etag: authentication.installation.entity.etag
        }
      ];
      try {
        await this.#security.transaction(mutations);
        return freeze({
          ticket,
          installationId: ticketRow.installationId,
          credentialVersion: ticketRow.credentialVersion,
          environment: binding.environment,
          audience: binding.audience,
          intent: 'new' as const,
          issuedAt: now,
          expiresAt
        });
      } catch (error) {
        if (isBoundary(error, 'conflict', 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciled = await this.#point(this.#security, this.environment, ticketKey(hash));
          if (reconciled !== undefined) {
            const parsed = parseTicket(reconciled, this.environment, hash);
            if (
              parsed.status === 'issued' && parsed.issueOperationId === issueOperationId &&
              this.#ticketBindingMatches(parsed, binding, bindingHash)
            ) {
              return freeze({
                ticket,
                installationId: parsed.installationId,
                credentialVersion: parsed.credentialVersion,
                environment: binding.environment,
                audience: binding.audience,
                intent: 'new' as const,
                issuedAt: parsed.issuedAt,
                expiresAt: parsed.expiresAt
              });
            }
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    const finalNow = this.#now();
    const finalAuthentication = await this.#readAuthentication(input.credential, finalNow, false);
    if (finalAuthentication === undefined) fail('invalid-ticket');
    fail('state-unavailable');
  }

  async consumeSessionTicket(value: ConsumeTicketInput): Promise<SessionLease> {
    let input: Readonly<Record<string, unknown>>;
    let binding: TicketBinding;
    try {
      input = exactDataObject(value, ['ticket', 'environment', 'audience', 'intent'], [], 'invalid-ticket');
      binding = this.#binding(input, 'invalid-ticket');
    } catch { fail('invalid-ticket'); }
    let hash: CanonicalSha256;
    try { hash = hashTicket(input.ticket); } catch { fail('invalid-ticket'); }
    const bindingHash = this.#bindingHash(binding);
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const now = this.#now();
      const ticketEntityValue = await this.#point(this.#security, this.environment, ticketKey(hash));
      if (ticketEntityValue === undefined) fail('invalid-ticket');
      const ticket = parseTicket(ticketEntityValue, this.environment, hash);
      if (
        ticket.status !== 'issued' || now >= ticket.expiresAt ||
        !this.#ticketBindingMatches(ticket, binding, bindingHash)
      ) fail('invalid-ticket');
      const installationEntityValue = await this.#point(
        this.#security,
        this.environment,
        installationKey(ticket.installationId)
      );
      const sessionEntityValue = await this.#point(
        this.#security,
        this.environment,
        sessionKey(ticket.installationId)
      );
      if (installationEntityValue === undefined || sessionEntityValue === undefined) fail('invalid-ticket');
      const installation = parseInstallation(
        installationEntityValue,
        this.environment,
        ticket.installationId
      );
      const session = parseSession(sessionEntityValue, this.environment, ticket.installationId);
      if (
        installation.status !== 'active' || now >= installation.idleExpiresAt ||
        now >= installation.absoluteExpiresAt ||
        installation.tombstoneVersion !== ticket.tombstoneVersion ||
        installation.currentCredentialVersion !== ticket.credentialVersion ||
        ((session.status === 'opening' || session.status === 'active') && now < session.leaseExpiresAt)
      ) fail('invalid-ticket');
      const supersedesExpired = session.sessionId !== undefined &&
        ['opening', 'active', 'expired'].includes(session.status) && now >= session.leaseExpiresAt;
      if (supersedesExpired) {
        const installationPartition = ratePartition('installation', ticket.installationId);
        await this.#chargeWindow(
          installationPartition,
          'rate:reconnect',
          ticket.installationId,
          'reconnect',
          hash,
          now,
          TEN_MINUTES_MS,
          [
            { period: MINUTE_MS, maximum: RECONNECTS_PER_MINUTE },
            { period: TEN_MINUTES_MS, maximum: RECONNECTS_PER_TEN_MINUTES }
          ]
        );
      }
      const sessionId = this.#candidate(this.#ids.sessionId, assertCanonicalUuid);
      const epoch = checkedIncrement(installation.sessionEpoch, 'invalid-ticket');
      const leaseVersion = checkedIncrement(session.leaseVersion, 'invalid-ticket');
      const leaseExpiresAt = checkedAdd(now, OPENING_LEASE_MS, 'state-unavailable');
      const touchedInstallation = this.#touchInstallation(installation, now);
      const nextInstallation: Omit<InstallationRow, 'entity'> = {
        ...touchedInstallation,
        sessionEpoch: epoch,
        activeSessionId: sessionId,
        activeSessionEpoch: epoch,
        activeSessionLockVersion: checkedIncrement(
          installation.activeSessionLockVersion,
          'invalid-ticket'
        ),
        activeSessionLeaseVersion: leaseVersion,
        activeSessionLeaseExpiresAt: leaseExpiresAt
      };
      const nextSession: Omit<SessionRow, 'entity'> = {
        installationId: ticket.installationId,
        status: 'opening',
        sessionId,
        sessionEpoch: epoch,
        credentialVersion: ticket.credentialVersion,
        tombstoneVersion: ticket.tombstoneVersion,
        leaseVersion,
        leaseExpiresAt,
        lastHeartbeatAt: now,
        lastActivityAt: now,
        ticketHash: hash,
        ticketIssuedAt: ticket.issuedAt
      };
      const consumedTicket: Omit<TicketRow, 'entity'> = {
        ...ticket,
        status: 'consumed',
        consumedAt: now,
        consumedSessionId: sessionId
      };
      const mutations: readonly AzureTableMutation[] = [
        { type: 'replace', entity: ticketEntity(this.environment, consumedTicket), etag: ticket.entity.etag },
        { type: 'replace', entity: installationEntity(this.environment, nextInstallation), etag: installation.entity.etag },
        { type: 'replace', entity: sessionEntity(this.environment, nextSession), etag: session.entity.etag }
      ];
      try {
        await this.#security.transaction(mutations);
        return this.#lease({ ...nextSession, entity: session.entity });
      } catch (error) {
        if (isBoundary(error, 'conflict', 'precondition-failed')) {
          const reconciledTicketEntity = await this.#point(this.#security, this.environment, ticketKey(hash));
          if (reconciledTicketEntity !== undefined &&
            parseTicket(reconciledTicketEntity, this.environment, hash).status !== 'issued') fail('invalid-ticket');
          continue;
        }
        if (isBoundary(error, 'ambiguous')) {
          const reconciledTicketEntity = await this.#point(this.#security, this.environment, ticketKey(hash));
          const reconciledSessionEntity = await this.#point(this.#security, this.environment, sessionKey(ticket.installationId));
          if (reconciledTicketEntity !== undefined && reconciledSessionEntity !== undefined) {
            const reconciledTicket = parseTicket(reconciledTicketEntity, this.environment, hash);
            const reconciledSession = parseSession(
              reconciledSessionEntity,
              this.environment,
              ticket.installationId
            );
            if (
              reconciledTicket.status === 'consumed' && reconciledTicket.consumedSessionId === sessionId &&
              reconciledSession.sessionId === sessionId && reconciledSession.sessionEpoch === epoch
            ) return this.#lease(reconciledSession);
            if (reconciledTicket.status !== 'issued') fail('invalid-ticket');
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    const finalNow = this.#now();
    const finalTicketEntity = await this.#point(this.#security, this.environment, ticketKey(hash));
    if (finalTicketEntity === undefined) fail('invalid-ticket');
    const finalTicket = parseTicket(finalTicketEntity, this.environment, hash);
    if (
      finalTicket.status !== 'issued' || finalNow >= finalTicket.expiresAt ||
      !this.#ticketBindingMatches(finalTicket, binding, bindingHash)
    ) fail('invalid-ticket');
    const finalInstallationEntity = await this.#point(
      this.#security,
      this.environment,
      installationKey(finalTicket.installationId)
    );
    const finalSessionEntity = await this.#point(
      this.#security,
      this.environment,
      sessionKey(finalTicket.installationId)
    );
    if (finalInstallationEntity === undefined || finalSessionEntity === undefined) fail('invalid-ticket');
    const finalInstallation = parseInstallation(
      finalInstallationEntity,
      this.environment,
      finalTicket.installationId
    );
    const finalSession = parseSession(
      finalSessionEntity,
      this.environment,
      finalTicket.installationId
    );
    if (
      finalInstallation.status !== 'active' || finalNow >= finalInstallation.idleExpiresAt ||
      finalNow >= finalInstallation.absoluteExpiresAt ||
      finalInstallation.tombstoneVersion !== finalTicket.tombstoneVersion ||
      finalInstallation.currentCredentialVersion !== finalTicket.credentialVersion ||
      ((finalSession.status === 'opening' || finalSession.status === 'active') &&
        finalNow < finalSession.leaseExpiresAt)
    ) fail('invalid-ticket');
    const finalCredentialEntity = await this.#point(
      this.#security,
      this.environment,
      credentialKey(finalInstallation.currentCredentialHash)
    );
    if (finalCredentialEntity === undefined) fail('state-unavailable');
    const finalCredential = parseCredential(
      finalCredentialEntity,
      this.environment,
      finalInstallation.currentCredentialHash
    );
    if (
      !this.#credentialValid(finalCredential, finalInstallation, finalNow, false) ||
      finalCredential.version !== finalTicket.credentialVersion
    ) fail('invalid-ticket');
    fail('state-unavailable');
  }

  async #sessionMutation(
    lease: SessionLease,
    operation: string,
    update: (
      session: SessionRow,
      installation: InstallationRow,
      now: number
    ) => Omit<SessionRow, 'entity'> | undefined,
    category: SecurityErrorCategory
  ): Promise<SessionRow> {
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const now = this.#now();
      const installationEntityValue = await this.#point(
        this.#security,
        this.environment,
        installationKey(lease.installationId)
      );
      const sessionEntityValue = await this.#point(
        this.#security,
        this.environment,
        sessionKey(lease.installationId)
      );
      if (installationEntityValue === undefined || sessionEntityValue === undefined) fail(category);
      const installation = parseInstallation(
        installationEntityValue,
        this.environment,
        lease.installationId
      );
      const session = parseSession(sessionEntityValue, this.environment, lease.installationId);
      const next = update(session, installation, now);
      if (next === undefined) fail(category);
      const touchedInstallation = this.#touchInstallation(installation, now);
      const nextInstallation: Omit<InstallationRow, 'entity'> = {
        ...touchedInstallation,
        activeSessionLockVersion: checkedIncrement(
          installation.activeSessionLockVersion,
          category
        ),
        ...(next.status === 'opening' || next.status === 'active'
          ? {
              activeSessionId: next.sessionId,
              activeSessionEpoch: next.sessionEpoch,
              activeSessionLeaseVersion: next.leaseVersion,
              activeSessionLeaseExpiresAt: next.leaseExpiresAt
            }
          : {
              activeSessionId: undefined,
              activeSessionEpoch: next.sessionEpoch,
              activeSessionLeaseVersion: next.leaseVersion,
              activeSessionLeaseExpiresAt: next.leaseExpiresAt
            })
      };
      const mutations: readonly AzureTableMutation[] = [
        { type: 'replace', entity: sessionEntity(this.environment, next), etag: session.entity.etag },
        {
          type: 'replace',
          entity: installationEntity(this.environment, nextInstallation),
          etag: installation.entity.etag
        }
      ];
      try {
        await this.#security.transaction(mutations);
        return { ...next, entity: session.entity };
      } catch (error) {
        if (isBoundary(error, 'conflict', 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciledEntity = await this.#point(
            this.#security,
            this.environment,
            sessionKey(lease.installationId)
          );
          if (reconciledEntity !== undefined) {
            const reconciled = parseSession(reconciledEntity, this.environment, lease.installationId);
            if (reconciled.lastOperationId === operation) return reconciled;
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async activateSession(value: ActivateSessionInput): Promise<SessionLease> {
    const input = exactDataObject(value, ['lease', 'message']);
    const lease = parseSessionLease(input.lease);
    const messageInput = exactDataObject(input.message, ['type', 'protocolVersion']);
    const message: SessionStartMessage = {
      type: messageInput.type as 'session.start',
      protocolVersion: messageInput.protocolVersion as 1
    };
    const operation = operationId(this.#candidate(this.#ids.generationClaimId, assertCanonicalUuid));
    const row = await this.#sessionMutation(lease, operation, (session, installation, now) => {
      if (
        message.type !== 'session.start' || message.protocolVersion !== 1 ||
        session.status !== 'opening' || !this.#leaseMatches(lease, session) ||
        now >= session.leaseExpiresAt || installation.status !== 'active' ||
        now >= installation.idleExpiresAt || now >= installation.absoluteExpiresAt ||
        session.tombstoneVersion !== installation.tombstoneVersion ||
        session.credentialVersion !== installation.currentCredentialVersion ||
        installation.activeSessionId !== session.sessionId ||
        installation.activeSessionEpoch !== session.sessionEpoch ||
        installation.activeSessionLeaseVersion !== session.leaseVersion ||
        installation.activeSessionLeaseExpiresAt !== session.leaseExpiresAt
      ) return undefined;
      return {
        ...session,
        status: 'active',
        leaseVersion: checkedIncrement(session.leaseVersion, 'stale-lease'),
        leaseExpiresAt: checkedAdd(now, ACTIVE_LEASE_MS, 'state-unavailable'),
        lastHeartbeatAt: now,
        lastActivityAt: now,
        activatedAt: now,
        lastOperationId: operation
      };
    }, 'stale-lease');
    return this.#lease(row);
  }

  async heartbeatSession(value: SessionLeaseInput): Promise<SessionLease> {
    const input = exactDataObject(value, ['lease']);
    const lease = parseSessionLease(input.lease);
    const operation = operationId(this.#candidate(this.#ids.generationClaimId, assertCanonicalUuid));
    const row = await this.#sessionMutation(lease, operation, (session, installation, now) => {
      if (
        !this.#sessionActive(session, installation, now) || !this.#leaseMatches(lease, session)
      ) return undefined;
      return {
        ...session,
        leaseVersion: checkedIncrement(session.leaseVersion, 'stale-lease'),
        leaseExpiresAt: checkedAdd(now, ACTIVE_LEASE_MS, 'state-unavailable'),
        lastHeartbeatAt: now,
        lastActivityAt: now,
        lastOperationId: operation
      };
    }, 'stale-lease');
    return this.#lease(row);
  }

  async endSession(value: SessionLeaseInput): Promise<void> {
    const input = exactDataObject(value, ['lease']);
    const lease = parseSessionLease(input.lease);
    const operation = operationId(this.#candidate(this.#ids.generationClaimId, assertCanonicalUuid));
    await this.#sessionMutation(lease, operation, (session, installation, now) => {
      if (
        (session.status !== 'opening' && session.status !== 'active') ||
        now >= session.leaseExpiresAt || !this.#leaseMatches(lease, session) ||
        installation.status !== 'active' || session.tombstoneVersion !== installation.tombstoneVersion ||
        session.credentialVersion !== installation.currentCredentialVersion
      ) return undefined;
      return {
        ...session,
        status: 'ended',
        leaseVersion: checkedIncrement(session.leaseVersion, 'stale-lease'),
        leaseExpiresAt: now,
        lastActivityAt: now,
        lastOperationId: operation
      };
    }, 'stale-lease');
  }

  async #readSessionState(
    lease: SessionLease
  ): Promise<Readonly<{ session: SessionRow; installation: InstallationRow }> | undefined> {
    const installationEntityValue = await this.#point(
      this.#security,
      this.environment,
      installationKey(lease.installationId)
    );
    const sessionEntityValue = await this.#point(
      this.#security,
      this.environment,
      sessionKey(lease.installationId)
    );
    if (installationEntityValue === undefined || sessionEntityValue === undefined) return undefined;
    const installation = parseInstallation(
      installationEntityValue,
      this.environment,
      lease.installationId
    );
    const session = parseSession(sessionEntityValue, this.environment, lease.installationId);
    return { session, installation };
  }

  async #readActiveSession(
    lease: SessionLease,
    now: number
  ): Promise<Readonly<{ session: SessionRow; installation: InstallationRow }> | undefined> {
    const state = await this.#readSessionState(lease);
    if (state === undefined) return undefined;
    const { session, installation } = state;
    if (!this.#sessionActive(session, installation, now) || !this.#leaseMatches(lease, session)) return undefined;
    return state;
  }

  async #validateAudioGrantHandoff(lease: SessionLease, expiresAt: number): Promise<void> {
    const state = await this.#readSessionState(lease);
    const handoffNow = this.#now();
    if (
      state === undefined ||
      !this.#sessionActive(state.session, state.installation, handoffNow) ||
      !this.#leaseMatches(lease, state.session)
    ) fail('stale-lease');
    if (expiresAt - handoffNow < MIN_AUDIO_GRANT_HANDOFF_MS) fail('state-unavailable');
  }

  #audioGrantOperationMatches(
    expected: Omit<AudioGrantRow, 'entity'>,
    actual: AudioGrantRow
  ): boolean {
    return actual.grantId === expected.grantId &&
      actual.utteranceId === expected.utteranceId &&
      actual.installationId === expected.installationId &&
      actual.sessionId === expected.sessionId &&
      actual.sessionEpoch === expected.sessionEpoch &&
      actual.sessionLeaseVersion === expected.sessionLeaseVersion &&
      actual.issuedAt === expected.issuedAt &&
      actual.expiresAt === expected.expiresAt &&
      actual.fromOriginalSampleOffset === expected.fromOriginalSampleOffset &&
      actual.throughOriginalSampleOffset === expected.throughOriginalSampleOffset &&
      actual.reservedOriginalSamples === expected.reservedOriginalSamples;
  }

  async reserveAudio(value: ReserveAudioInput): Promise<AudioGrant> {
    const input = exactDataObject(value, [
      'lease', 'utteranceId', 'fromOriginalSampleOffset', 'originalSamples'
    ]);
    const lease = parseSessionLease(input.lease);
    const utteranceId = assertCanonicalUuid(input.utteranceId);
    if (
      !nonNegativeSafeInteger(input.fromOriginalSampleOffset) ||
      !positiveSafeInteger(input.originalSamples) || input.originalSamples > MAX_AUDIO_GRANT_SAMPLES
    ) fail('invalid-input');
    const throughOriginalSampleOffset = checkedAdd(
      input.fromOriginalSampleOffset,
      input.originalSamples,
      'invalid-input'
    );
    const grantId = this.#candidate(this.#ids.grantId, assertCanonicalUuid);
    const partitionKey = ratePartition('installation', lease.installationId);
    const installWindowKey = 'audio-window:installation';
    const sessionWindowKey = `audio-window:session:${lease.sessionId}:${lease.sessionEpoch}`;
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const preflightNow = this.#now();
      const active = await this.#readSessionState(lease);
      const [installWindowEntity, sessionWindowEntity, existingGrant] = await Promise.all([
        this.#point(this.#rate, partitionKey, installWindowKey),
        this.#point(this.#rate, partitionKey, sessionWindowKey),
        this.#point(this.#rate, partitionKey, audioGrantKey(grantId))
      ]);
      if (existingGrant !== undefined) fail('state-unavailable');
      const issuedAt = this.#now(preflightNow);
      if (
        active === undefined ||
        !this.#sessionActive(active.session, active.installation, issuedAt) ||
        !this.#leaseMatches(lease, active.session)
      ) fail('stale-lease');
      const installWindow = parseAudioWindow(
        installWindowEntity,
        this.environment,
        partitionKey,
        installWindowKey,
        lease.installationId,
        'audio-installation',
        lease.installationId,
        undefined,
        0
      );
      const sessionWindow = parseAudioWindow(
        sessionWindowEntity,
        this.environment,
        partitionKey,
        sessionWindowKey,
        `${lease.sessionId}:${lease.sessionEpoch}`,
        'audio-session',
        lease.installationId,
        lease.sessionId,
        lease.sessionEpoch
      );
      const installEvents = pruneEvents(installWindow.events, issuedAt, AUDIO_RESERVATION_WINDOW_MS);
      const sessionEvents = pruneEvents(sessionWindow.events, issuedAt, AUDIO_RESERVATION_WINDOW_MS);
      if (sessionWindow.activeUtteranceId === undefined) {
        if (input.fromOriginalSampleOffset !== 0) fail('invalid-input');
      } else if (sessionWindow.activeUtteranceId === utteranceId) {
        if (input.fromOriginalSampleOffset !== sessionWindow.nextOriginalSampleOffset) {
          fail('invalid-input');
        }
      } else {
        if (issuedAt < sessionWindow.activeGrantExpiresAt || input.fromOriginalSampleOffset !== 0) {
          fail('invalid-input');
        }
      }
      if (
        installEvents.length >= MAX_AUDIO_GRANTS_PER_WINDOW ||
        sessionEvents.length >= MAX_AUDIO_GRANTS_PER_WINDOW ||
        sumEvents(installEvents, issuedAt, AUDIO_RESERVATION_WINDOW_MS) + input.originalSamples > MAX_AUDIO_SAMPLES_PER_WINDOW ||
        sumEvents(sessionEvents, issuedAt, AUDIO_RESERVATION_WINDOW_MS) + input.originalSamples > MAX_AUDIO_SAMPLES_PER_WINDOW
      ) fail('quota-exceeded');
      const event = Object.freeze({
        at: issuedAt,
        amount: input.originalSamples as number,
        operationId: grantId
      });
      const expiresAt = checkedAdd(issuedAt, AUDIO_GRANT_TTL_MS, 'state-unavailable');
      const grant: Omit<AudioGrantRow, 'entity'> = {
        grantId,
        utteranceId,
        installationId: lease.installationId,
        sessionId: lease.sessionId,
        sessionEpoch: lease.sessionEpoch,
        sessionLeaseVersion: lease.leaseVersion,
        issuedAt,
        expiresAt,
        fromOriginalSampleOffset: input.fromOriginalSampleOffset as number,
        throughOriginalSampleOffset,
        reservedOriginalSamples: input.originalSamples as number
      };
      const installNext = audioWindowEntity(
        this.environment,
        partitionKey,
        installWindowKey,
        {
          scope: installWindow.scope,
          window: installWindow.window,
          events: Object.freeze([...installEvents, event]),
          retainUntil: expiresAt,
          installationId: lease.installationId,
          sessionEpoch: 0,
          activeUtteranceId: utteranceId,
          nextOriginalSampleOffset: throughOriginalSampleOffset,
          activeGrantExpiresAt: expiresAt
        }
      );
      const sessionNext = audioWindowEntity(
        this.environment,
        partitionKey,
        sessionWindowKey,
        {
          scope: sessionWindow.scope,
          window: sessionWindow.window,
          events: Object.freeze([...sessionEvents, event]),
          retainUntil: expiresAt,
          installationId: lease.installationId,
          sessionId: lease.sessionId,
          sessionEpoch: lease.sessionEpoch,
          activeUtteranceId: utteranceId,
          nextOriginalSampleOffset: throughOriginalSampleOffset,
          activeGrantExpiresAt: expiresAt
        }
      );
      const mutations: AzureTableMutation[] = [
        installWindowEntity === undefined
          ? { type: 'create', entity: installNext }
          : { type: 'replace', entity: installNext, etag: installWindowEntity.etag },
        sessionWindowEntity === undefined
          ? { type: 'create', entity: sessionNext }
          : { type: 'replace', entity: sessionNext, etag: sessionWindowEntity.etag },
        { type: 'create', entity: audioGrantEntity(this.environment, partitionKey, grant) }
      ];
      try {
        await this.#rate.transaction(mutations);
        await this.#validateAudioGrantHandoff(lease, expiresAt);
        return this.#audioGrant(grant);
      } catch (error) {
        if (error instanceof SecurityStateError) throw error;
        if (isBoundary(error, 'conflict', 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciled = await this.#point(this.#rate, partitionKey, audioGrantKey(grantId));
          if (reconciled !== undefined) {
            const parsed = parseAudioGrant(reconciled, this.environment, partitionKey, grantId);
            if (!this.#audioGrantOperationMatches(grant, parsed)) fail('state-unavailable');
            await this.#validateAudioGrantHandoff(lease, parsed.expiresAt);
            return this.#audioGrant(parsed);
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  #parseGeneration(value: AuthorizeGenerationInput): Readonly<{
    lease: SessionLease;
    utteranceId: CanonicalUuid;
    acceptedFinalRevision: number;
    selectedTargetLanguage: string;
    gatePolicyVersion: string;
    transcriptHash: CanonicalSha256;
  }> {
    const input = exactDataObject(value, [
      'lease', 'decision', 'utteranceId', 'acceptedFinalRevision',
      'selectedTargetLanguage', 'gatePolicyVersion', 'transcriptHash'
    ]);
    if (
      input.decision !== 'target' || !positiveSafeInteger(input.acceptedFinalRevision) ||
      !boundedString(input.selectedTargetLanguage, 32) || !/^[a-z]{2,8}$/.test(input.selectedTargetLanguage) ||
      !boundedString(input.gatePolicyVersion, 64) || !/^[0-9A-Za-z.+-]+$/.test(input.gatePolicyVersion)
    ) fail('invalid-input');
    return {
      lease: parseSessionLease(input.lease),
      utteranceId: assertCanonicalUuid(input.utteranceId),
      acceptedFinalRevision: input.acceptedFinalRevision,
      selectedTargetLanguage: input.selectedTargetLanguage,
      gatePolicyVersion: input.gatePolicyVersion,
      transcriptHash: assertCanonicalSha256(input.transcriptHash)
    };
  }

  #authorizationResult(row: GenerationRow, now: number): GenerationAuthorizationResult | undefined {
    if (row.status === 'completed') {
      return freeze({ status: 'duplicate-completed' as const, claim: this.#claim(row) });
    }
    if (row.status === 'started' || (row.status === 'released' && row.startedConsumed)) {
      return freeze({ status: 'duplicate-consumed' as const, claim: this.#claim(row) });
    }
    if (row.status === 'claimed' && now < row.leaseExpiresAt) {
      return freeze({ status: 'duplicate-in-flight' as const, claim: this.#claim(row) });
    }
    return undefined;
  }

  async authorizeGeneration(value: AuthorizeGenerationInput): Promise<GenerationAuthorizationResult> {
    const input = this.#parseGeneration(value);
    const authorizationId = hashCorrelationKey(JSON.stringify([
      input.lease.installationId,
      input.lease.sessionId,
      input.lease.sessionEpoch,
      input.lease.credentialVersion,
      'target',
      input.utteranceId,
      input.acceptedFinalRevision,
      input.selectedTargetLanguage,
      input.gatePolicyVersion,
      input.transcriptHash
    ]));
    const partitionKey = ratePartition('installation', input.lease.installationId);
    const rowKey = generationKey(authorizationId);
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const now = this.#now();
      const active = await this.#readActiveSession(input.lease, now);
      if (active === undefined) fail('generation-rejected');
      const existingEntity = await this.#point(this.#rate, partitionKey, rowKey);
      if (existingEntity !== undefined) {
        const existing = parseGeneration(existingEntity, this.environment, partitionKey, authorizationId);
        const duplicate = this.#authorizationResult(existing, now);
        if (duplicate !== undefined) return duplicate;
        if (existing.startedConsumed) {
          return freeze({ status: 'duplicate-consumed' as const, claim: this.#claim(existing) });
        }
        const claimId = this.#candidate(this.#ids.generationClaimId, assertCanonicalUuid);
        const next: Omit<GenerationRow, 'entity'> = {
          ...existing,
          claimId,
          claimVersion: checkedIncrement(existing.claimVersion, 'generation-rejected'),
          leaseVersion: 1,
          leaseExpiresAt: checkedAdd(now, OPENING_LEASE_MS, 'state-unavailable'),
          status: 'claimed',
          providerStartOperationId: undefined,
          releasedFromClaimVersion: undefined,
          releasedFromLeaseVersion: undefined,
          releasedFromLeaseExpiresAt: undefined,
          retainUntil: checkedAdd(now, TERMINAL_GENERATION_TTL_MS, 'state-unavailable')
        };
        try {
          await this.#rate.replace(generationEntity(this.environment, partitionKey, next), existing.entity.etag);
          return freeze({ status: 'acquired' as const, claim: this.#claim({ ...next, entity: existing.entity }) });
        } catch (error) {
          if (isBoundary(error, 'precondition-failed', 'ambiguous')) continue;
          mapBoundary(error);
        }
      }
      const claimId = this.#candidate(this.#ids.generationClaimId, assertCanonicalUuid);
      const counterKey = generationCounterKey(input.lease.sessionId, input.lease.sessionEpoch);
      const counterEntity = await this.#point(this.#rate, partitionKey, counterKey);
      const counter = parseGenerationCounter(
        counterEntity,
        this.environment,
        partitionKey,
        input.lease.installationId,
        input.lease.sessionId,
        input.lease.sessionEpoch
      );
      const generatedEvents = pruneEvents(counter.generatedEvents, now, MINUTE_MS);
      if (
        generatedEvents.length >= GENERATIONS_PER_MINUTE ||
        counter.generatedTotal >= GENERATIONS_PER_SESSION
      ) fail('quota-exceeded');
      const nextCounter: Omit<GenerationCounterRow, 'entity'> = {
        installationId: counter.installationId,
        sessionId: counter.sessionId,
        sessionEpoch: counter.sessionEpoch,
        generatedEvents: Object.freeze([
          ...generatedEvents,
          Object.freeze({ at: now, amount: 1, operationId: authorizationId })
        ]),
        attemptEvents: counter.attemptEvents,
        generatedTotal: checkedIncrement(counter.generatedTotal, 'quota-exceeded'),
        attemptTotal: counter.attemptTotal
      };
      const generation: Omit<GenerationRow, 'entity'> = {
        authorizationId,
        installationId: input.lease.installationId,
        sessionId: input.lease.sessionId,
        sessionEpoch: input.lease.sessionEpoch,
        tombstoneVersion: active.installation.tombstoneVersion,
        credentialVersion: input.lease.credentialVersion,
        decision: 'target',
        utteranceId: input.utteranceId,
        acceptedFinalRevision: input.acceptedFinalRevision,
        selectedTargetLanguage: input.selectedTargetLanguage,
        gatePolicyVersion: input.gatePolicyVersion,
        transcriptHash: input.transcriptHash,
        claimId,
        claimVersion: 1,
        leaseVersion: 1,
        leaseExpiresAt: checkedAdd(now, OPENING_LEASE_MS, 'state-unavailable'),
        status: 'claimed',
        startedConsumed: false,
        authorizedAt: now,
        retainUntil: checkedAdd(now, TERMINAL_GENERATION_TTL_MS, 'state-unavailable')
      };
      const mutations: readonly AzureTableMutation[] = [
        { type: 'create', entity: generationEntity(this.environment, partitionKey, generation) },
        counterEntity === undefined
          ? { type: 'create', entity: generationCounterEntity(this.environment, partitionKey, nextCounter) }
          : {
              type: 'replace',
              entity: generationCounterEntity(this.environment, partitionKey, nextCounter),
              etag: counterEntity.etag
            }
      ];
      try {
        await this.#rate.transaction(mutations);
        const postNow = this.#now(now);
        if (await this.#readActiveSession(input.lease, postNow) === undefined) fail('generation-rejected');
        return freeze({
          status: 'acquired' as const,
          claim: this.#claim(generation)
        });
      } catch (error) {
        if (error instanceof SecurityStateError) throw error;
        if (isBoundary(error, 'conflict', 'precondition-failed', 'ambiguous')) {
          const reconciledEntity = await this.#point(this.#rate, partitionKey, rowKey);
          if (reconciledEntity !== undefined) {
            const reconciled = parseGeneration(reconciledEntity, this.environment, partitionKey, authorizationId);
            if (reconciled.claimId === claimId) {
              const postNow = this.#now(now);
              if (await this.#readActiveSession(input.lease, postNow) === undefined) fail('generation-rejected');
              return freeze({ status: 'acquired' as const, claim: this.#claim(reconciled) });
            }
            const duplicate = this.#authorizationResult(reconciled, now);
            if (duplicate !== undefined) return duplicate;
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async providerStart(value: GenerationClaimInput): Promise<GenerationProviderStartResult> {
    const input = exactDataObject(value, ['claim']);
    const claim = parseGenerationClaim(input.claim);
    const partitionKey = ratePartition('installation', claim.installationId);
    const operation = operationId(this.#candidate(this.#ids.generationClaimId, assertCanonicalUuid));
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const now = this.#now();
      const entity = await this.#point(this.#rate, partitionKey, generationKey(claim.authorizationId));
      if (entity === undefined) fail('generation-rejected');
      const row = parseGeneration(entity, this.environment, partitionKey, claim.authorizationId);
      if (
        row.authorizationId !== claim.authorizationId || row.claimId !== claim.claimId ||
        row.installationId !== claim.installationId || row.sessionId !== claim.sessionId ||
        row.sessionEpoch !== claim.sessionEpoch
      ) fail('generation-rejected');
      if (row.startedConsumed) {
        return freeze({ status: 'already-consumed' as const, claim: this.#claim(row) });
      }
      if (row.status !== 'claimed' || !this.#claimMatches(claim, row) || now >= row.leaseExpiresAt) {
        fail('generation-rejected');
      }
      if (!await this.#generationSessionValid(row, now)) fail('generation-rejected');
      const counterKey = generationCounterKey(claim.sessionId, claim.sessionEpoch);
      const counterEntity = await this.#point(this.#rate, partitionKey, counterKey);
      const counter = parseGenerationCounter(
        counterEntity,
        this.environment,
        partitionKey,
        claim.installationId,
        claim.sessionId,
        claim.sessionEpoch
      );
      const attemptEvents = pruneEvents(counter.attemptEvents, now, MINUTE_MS);
      if (attemptEvents.length >= ATTEMPTS_PER_MINUTE || counter.attemptTotal >= ATTEMPTS_PER_SESSION) {
        fail('quota-exceeded');
      }
      const nextCounter: Omit<GenerationCounterRow, 'entity'> = {
        installationId: counter.installationId,
        sessionId: counter.sessionId,
        sessionEpoch: counter.sessionEpoch,
        generatedEvents: counter.generatedEvents,
        attemptEvents: Object.freeze([
          ...attemptEvents,
          Object.freeze({ at: now, amount: 1, operationId: operation })
        ]),
        generatedTotal: counter.generatedTotal,
        attemptTotal: checkedIncrement(counter.attemptTotal, 'quota-exceeded')
      };
      const next: Omit<GenerationRow, 'entity'> = {
        ...row,
        status: 'started',
        startedConsumed: true,
        providerStartedAt: now,
        providerStartOperationId: operation,
        leaseVersion: checkedIncrement(row.leaseVersion, 'generation-rejected'),
        leaseExpiresAt: checkedAdd(now, ACTIVE_LEASE_MS, 'state-unavailable'),
        retainUntil: checkedAdd(now, TERMINAL_GENERATION_TTL_MS, 'state-unavailable')
      };
      const mutations: readonly AzureTableMutation[] = [
        { type: 'replace', entity: generationEntity(this.environment, partitionKey, next), etag: row.entity.etag },
        counterEntity === undefined
          ? { type: 'create', entity: generationCounterEntity(this.environment, partitionKey, nextCounter) }
          : {
              type: 'replace',
              entity: generationCounterEntity(this.environment, partitionKey, nextCounter),
              etag: counterEntity.etag
            }
      ];
      try {
        await this.#rate.transaction(mutations);
        const postNow = this.#now(now);
        if (!await this.#generationSessionValid(next, postNow)) {
          return freeze({
            status: 'already-consumed' as const,
            claim: this.#claim({ ...next, entity: row.entity })
          });
        }
        return freeze({
          status: 'start-permitted' as const,
          claim: this.#claim({ ...next, entity: row.entity })
        });
      } catch (error) {
        if (isBoundary(error, 'conflict', 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciledEntity = await this.#point(this.#rate, partitionKey, generationKey(claim.authorizationId));
          if (reconciledEntity !== undefined) {
            const reconciled = parseGeneration(
              reconciledEntity,
              this.environment,
              partitionKey,
              claim.authorizationId
            );
            if (reconciled.startedConsumed && reconciled.providerStartOperationId === operation) {
              const postNow = this.#now(now);
              return freeze({
                status: await this.#generationSessionValid(reconciled, postNow)
                  ? 'start-permitted' as const
                  : 'already-consumed' as const,
                claim: this.#claim(reconciled)
              });
            }
            if (reconciled.startedConsumed) {
              return freeze({ status: 'already-consumed' as const, claim: this.#claim(reconciled) });
            }
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async heartbeatGeneration(value: GenerationClaimInput): Promise<GenerationClaim> {
    const input = exactDataObject(value, ['claim']);
    const claim = parseGenerationClaim(input.claim);
    const partitionKey = ratePartition('installation', claim.installationId);
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const now = this.#now();
      const entity = await this.#point(this.#rate, partitionKey, generationKey(claim.authorizationId));
      if (entity === undefined) fail('generation-rejected');
      const row = parseGeneration(entity, this.environment, partitionKey, claim.authorizationId);
      if (row.status !== 'started' || !this.#claimMatches(claim, row) || now >= row.leaseExpiresAt) {
        fail('generation-rejected');
      }
      const sessionEntityValue = await this.#point(this.#security, this.environment, sessionKey(claim.installationId));
      const installationEntityValue = await this.#point(this.#security, this.environment, installationKey(claim.installationId));
      if (sessionEntityValue === undefined || installationEntityValue === undefined) fail('generation-rejected');
      const session = parseSession(sessionEntityValue, this.environment, claim.installationId);
      const installation = parseInstallation(installationEntityValue, this.environment, claim.installationId);
      if (
        !this.#sessionActive(session, installation, now) || session.sessionId !== claim.sessionId ||
        session.sessionEpoch !== claim.sessionEpoch
      ) fail('generation-rejected');
      const next: Omit<GenerationRow, 'entity'> = {
        ...row,
        leaseVersion: checkedIncrement(row.leaseVersion, 'generation-rejected'),
        leaseExpiresAt: checkedAdd(now, ACTIVE_LEASE_MS, 'state-unavailable')
      };
      try {
        await this.#rate.replace(generationEntity(this.environment, partitionKey, next), row.entity.etag);
        return this.#claim(next);
      } catch (error) {
        if (isBoundary(error, 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciledEntity = await this.#point(this.#rate, partitionKey, generationKey(claim.authorizationId));
          if (reconciledEntity !== undefined) {
            const reconciled = parseGeneration(reconciledEntity, this.environment, partitionKey, claim.authorizationId);
            if (
              reconciled.status === 'started' && reconciled.claimId === claim.claimId &&
              reconciled.leaseVersion === next.leaseVersion && reconciled.leaseExpiresAt === next.leaseExpiresAt
            ) return this.#claim(reconciled);
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async completeGeneration(value: CompleteGenerationInput): Promise<GenerationClaim> {
    const input = exactDataObject(value, ['claim', 'outcome']);
    const claim = parseGenerationClaim(input.claim);
    if (input.outcome !== 'completed' && input.outcome !== 'failed') fail('invalid-input');
    const outcome = input.outcome;
    const partitionKey = ratePartition('installation', claim.installationId);
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const now = this.#now();
      const entity = await this.#point(this.#rate, partitionKey, generationKey(claim.authorizationId));
      if (entity === undefined) fail('generation-rejected');
      const row = parseGeneration(entity, this.environment, partitionKey, claim.authorizationId);
      if (row.status !== 'started' || !this.#claimMatches(claim, row) || now >= row.leaseExpiresAt) {
        fail('generation-rejected');
      }
      const sessionEntityValue = await this.#point(this.#security, this.environment, sessionKey(claim.installationId));
      const installationEntityValue = await this.#point(this.#security, this.environment, installationKey(claim.installationId));
      if (sessionEntityValue === undefined || installationEntityValue === undefined) fail('generation-rejected');
      const session = parseSession(sessionEntityValue, this.environment, claim.installationId);
      const installation = parseInstallation(installationEntityValue, this.environment, claim.installationId);
      if (
        !this.#sessionActive(session, installation, now) || session.sessionId !== row.sessionId ||
        session.sessionEpoch !== row.sessionEpoch || session.credentialVersion !== row.credentialVersion ||
        row.tombstoneVersion !== installation.tombstoneVersion
      ) fail('generation-rejected');
      const next: Omit<GenerationRow, 'entity'> = {
        ...row,
        status: 'completed',
        completedAt: now,
        completionOutcome: outcome,
        leaseVersion: checkedIncrement(row.leaseVersion, 'generation-rejected'),
        leaseExpiresAt: now,
        retainUntil: checkedAdd(now, TERMINAL_GENERATION_TTL_MS, 'state-unavailable')
      };
      try {
        await this.#rate.replace(generationEntity(this.environment, partitionKey, next), row.entity.etag);
        return this.#claim(next);
      } catch (error) {
        if (isBoundary(error, 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciledEntity = await this.#point(this.#rate, partitionKey, generationKey(claim.authorizationId));
          if (reconciledEntity !== undefined) {
            const reconciled = parseGeneration(reconciledEntity, this.environment, partitionKey, claim.authorizationId);
            if (
              reconciled.status === 'completed' && reconciled.claimId === claim.claimId &&
              reconciled.completionOutcome === outcome && reconciled.completedAt === now
            ) return this.#claim(reconciled);
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async releaseGeneration(value: GenerationClaimInput): Promise<GenerationClaim> {
    const input = exactDataObject(value, ['claim']);
    const claim = parseGenerationClaim(input.claim);
    const partitionKey = ratePartition('installation', claim.installationId);
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const now = this.#now();
      const entity = await this.#point(this.#rate, partitionKey, generationKey(claim.authorizationId));
      if (entity === undefined) fail('generation-rejected');
      const row = parseGeneration(entity, this.environment, partitionKey, claim.authorizationId);
      if (row.status === 'released') {
        const sourceMatches = (claim.phase === 'claimed' || claim.phase === 'started') &&
          claim.authorizationId === row.authorizationId && claim.claimId === row.claimId &&
          claim.installationId === row.installationId && claim.sessionId === row.sessionId &&
          claim.sessionEpoch === row.sessionEpoch && claim.claimVersion === row.releasedFromClaimVersion &&
          claim.leaseVersion === row.releasedFromLeaseVersion &&
          claim.leaseExpiresAt === row.releasedFromLeaseExpiresAt;
        if (this.#claimMatches(claim, row) || sourceMatches) return this.#claim(row);
        fail('generation-rejected');
      }
      if ((row.status !== 'claimed' && row.status !== 'started') || !this.#claimMatches(claim, row)) {
        fail('generation-rejected');
      }
      const sessionEntityValue = await this.#point(
        this.#security,
        this.environment,
        sessionKey(claim.installationId)
      );
      if (sessionEntityValue !== undefined) {
        const session = parseSession(sessionEntityValue, this.environment, claim.installationId);
        if (
          session.sessionEpoch === claim.sessionEpoch && session.sessionId !== claim.sessionId
        ) fail('generation-rejected');
      }
      const next: Omit<GenerationRow, 'entity'> = {
        ...row,
        status: 'released',
        leaseVersion: checkedIncrement(row.leaseVersion, 'generation-rejected'),
        leaseExpiresAt: now,
        releasedFromClaimVersion: row.claimVersion,
        releasedFromLeaseVersion: row.leaseVersion,
        releasedFromLeaseExpiresAt: row.leaseExpiresAt,
        retainUntil: checkedAdd(now, TERMINAL_GENERATION_TTL_MS, 'state-unavailable')
      };
      try {
        await this.#rate.replace(generationEntity(this.environment, partitionKey, next), row.entity.etag);
        return this.#claim(next);
      } catch (error) {
        if (isBoundary(error, 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciledEntity = await this.#point(this.#rate, partitionKey, generationKey(claim.authorizationId));
          if (reconciledEntity !== undefined) {
            const reconciled = parseGeneration(reconciledEntity, this.environment, partitionKey, claim.authorizationId);
            if (reconciled.status === 'released' && reconciled.claimId === claim.claimId) return this.#claim(reconciled);
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async #probe(
    table: AzureTableClientLike,
    partitionKey: string,
    rowKey: string,
    tableName: 'security' | 'rate',
    now: number,
    signal?: AbortSignal
  ): Promise<void> {
    for (let attempt = 0; attempt < AZURE_CAS_ATTEMPTS; attempt += 1) {
      const entity = await this.#point(table, partitionKey, rowKey, signal);
      if (entity === undefined) fail('state-unavailable');
      requireEntityKey(entity, partitionKey, rowKey);
      const input = exactAzureProperties(entity.properties, this.environment, 'readiness', [
        'table', 'probe', 'updatedAt'
      ]);
      if (input.table !== tableName) fail('state-unavailable');
      const probe = checkedIncrement(intField(input, 'probe'), 'state-unavailable');
      const next = newAzureEntity(partitionKey, rowKey, this.environment, 'readiness', {
        table: tableName,
        probe,
        updatedAt: now
      });
      try {
        await table.replace(next, entity.etag, signal);
        return;
      } catch (error) {
        if (isBoundary(error, 'conflict', 'precondition-failed')) continue;
        if (isBoundary(error, 'ambiguous')) {
          const reconciled = await this.#point(table, partitionKey, rowKey, signal);
          if (reconciled !== undefined) {
            const input = exactAzureProperties(reconciled.properties, this.environment, 'readiness', [
              'table', 'probe', 'updatedAt'
            ]);
            if (input.table === tableName && intField(input, 'probe') === probe && intField(input, 'updatedAt') === now) {
              return;
            }
          }
          continue;
        }
        mapBoundary(error);
      }
    }
    fail('state-unavailable');
  }

  async #initializeProbe(
    table: AzureTableClientLike,
    partitionKey: string,
    rowKey: string,
    tableName: 'security' | 'rate',
    now: number,
    signal?: AbortSignal
  ): Promise<void> {
    const existing = await this.#point(table, partitionKey, rowKey, signal);
    if (existing !== undefined) {
      requireEntityKey(existing, partitionKey, rowKey);
      const input = exactAzureProperties(existing.properties, this.environment, 'readiness', [
        'table', 'probe', 'updatedAt'
      ]);
      if (input.table !== tableName) fail('state-unavailable');
      intField(input, 'probe');
      intField(input, 'updatedAt');
      return;
    }
    const sentinel = newAzureEntity(partitionKey, rowKey, this.environment, 'readiness', {
      table: tableName,
      probe: 0,
      updatedAt: now
    });
    try {
      await table.create(sentinel, signal);
    } catch (error) {
      if (!isBoundary(error, 'conflict', 'ambiguous')) mapBoundary(error);
      const reconciled = await this.#point(table, partitionKey, rowKey, signal);
      if (reconciled === undefined) fail('state-unavailable');
      requireEntityKey(reconciled, partitionKey, rowKey);
      const input = exactAzureProperties(reconciled.properties, this.environment, 'readiness', [
        'table', 'probe', 'updatedAt'
      ]);
      if (input.table !== tableName) fail('state-unavailable');
      intField(input, 'probe');
      intField(input, 'updatedAt');
    }
  }

  async initializeState(signal?: AbortSignal): Promise<void> {
    if (
      signal !== undefined &&
      (utilTypes.isProxy(signal) || !(signal instanceof AbortSignal) ||
        Object.getPrototypeOf(signal) !== AbortSignal.prototype || aborted(signal))
    ) fail('state-unavailable');
    const now = this.#now();
    await this.#initializeProbe(this.#security, this.environment, 'readiness', 'security', now, signal);
    if (aborted(signal)) fail('state-unavailable');
    await this.#initializeProbe(
      this.#rate,
      ratePartition('meta', this.environment),
      'readiness',
      'rate',
      now,
      signal
    );
    if (aborted(signal)) fail('state-unavailable');
  }

  async checkReadiness(signal?: AbortSignal): Promise<void> {
    if (
      signal !== undefined &&
      (utilTypes.isProxy(signal) || !(signal instanceof AbortSignal) ||
        Object.getPrototypeOf(signal) !== AbortSignal.prototype || aborted(signal))
    ) fail('state-unavailable');
    const now = this.#now();
    await this.#probe(this.#security, this.environment, 'readiness', 'security', now, signal);
    if (aborted(signal)) fail('state-unavailable');
    await this.#probe(
      this.#rate,
      ratePartition('meta', this.environment),
      'readiness',
      'rate',
      now,
      signal
    );
    if (aborted(signal)) fail('state-unavailable');
  }

  async #securityRemovable(entity: AzureStoredEntity, now: number): Promise<boolean> {
    if (entity.partitionKey !== this.environment) fail('state-unavailable');
    const kind = Object.getOwnPropertyDescriptor(entity.properties, 'kind')?.value;
    if (kind === 'readiness') return false;
    if (kind === 'session') {
      if (!entity.rowKey.startsWith('session:')) fail('state-unavailable');
      const installationId = assertCanonicalUuid(entity.rowKey.slice(8));
      const session = parseSession(entity, this.environment, installationId);
      const installationEntityValue = await this.#point(
        this.#security,
        this.environment,
        installationKey(installationId)
      );
      if (installationEntityValue === undefined) return true;
      const installation = parseInstallation(
        installationEntityValue,
        this.environment,
        installationId
      );
      const terminalAt = installation.revokedAt ?? installation.expiredAt;
      const tombstoneReady = installation.status !== 'active' && terminalAt !== undefined &&
        now - terminalAt >= REVOCATION_TOMBSTONE_TTL_MS;
      if (installation.status !== 'active' && session.status === 'none') return tombstoneReady;
      const installationExpired = installation.status === 'active' &&
        (now >= installation.idleExpiresAt || now >= installation.absoluteExpiresAt);
      const leaseExpired = (session.status === 'opening' || session.status === 'active') &&
        now >= session.leaseExpiresAt;
      if (
        installationExpired || leaseExpired ||
        (installation.status !== 'active' && !['expired', 'revoked'].includes(session.status))
      ) {
        const nextSession: Omit<SessionRow, 'entity'> = {
          ...session,
          status: session.sessionId === undefined
            ? 'none'
            : installation.status === 'revoked' ? 'revoked' : 'expired',
          leaseVersion: checkedIncrement(session.leaseVersion, 'state-unavailable'),
          leaseExpiresAt: now,
          lastActivityAt: now
        };
        const nextInstallation: Omit<InstallationRow, 'entity'> = {
          ...installation,
          ...(installationExpired
            ? {
                status: 'expired' as const,
                tombstoneVersion: checkedIncrement(
                  installation.tombstoneVersion,
                  'state-unavailable'
                ),
                expiredAt: now
              }
            : {}),
          activeSessionId: undefined,
          activeSessionEpoch: session.sessionEpoch,
          activeSessionLockVersion: checkedIncrement(
            installation.activeSessionLockVersion,
            'state-unavailable'
          ),
          activeSessionLeaseVersion: nextSession.leaseVersion,
          activeSessionLeaseExpiresAt: now
        };
        try {
          await this.#security.transaction([
            {
              type: 'replace',
              entity: sessionEntity(this.environment, nextSession),
              etag: session.entity.etag
            },
            {
              type: 'replace',
              entity: installationEntity(this.environment, nextInstallation),
              etag: installation.entity.etag
            }
          ]);
        } catch (error) {
          if (!isBoundary(error, 'precondition-failed', 'conflict', 'ambiguous')) mapBoundary(error);
        }
        return false;
      }
      return tombstoneReady;
    }
    if (kind === 'pairing') {
      if (!entity.rowKey.startsWith('pair:')) fail('state-unavailable');
      const hash = assertCanonicalSha256(entity.rowKey.slice(5));
      const row = parsePairing(entity, this.environment, hash);
      return row.status !== 'issued' || now >= row.expiresAt;
    }
    if (kind === 'ticket') {
      if (!entity.rowKey.startsWith('ticket:')) fail('state-unavailable');
      const hash = assertCanonicalSha256(entity.rowKey.slice(7));
      const row = parseTicket(entity, this.environment, hash);
      return row.status !== 'issued' || now >= row.expiresAt;
    }
    if (kind === 'credential') {
      if (!entity.rowKey.startsWith('credential:')) fail('state-unavailable');
      const hash = assertCanonicalSha256(entity.rowKey.slice(11));
      const row = parseCredential(entity, this.environment, hash);
      return ['retired', 'revoked', 'expired'].includes(row.status) ||
        now >= row.absoluteExpiresAt || now >= row.idleExpiresAt ||
        (row.pendingExpiresAt !== undefined && now >= row.pendingExpiresAt);
    }
    if (kind === 'installation') {
      if (!entity.rowKey.startsWith('installation:')) fail('state-unavailable');
      const id = assertCanonicalUuid(entity.rowKey.slice(13));
      const row = parseInstallation(entity, this.environment, id);
      const sessionEntityValue = await this.#point(
        this.#security,
        this.environment,
        sessionKey(id)
      );
      if (sessionEntityValue !== undefined) {
        parseSession(sessionEntityValue, this.environment, id);
        return false;
      }
      if (row.status === 'revoked' && row.revokedAt !== undefined) {
        return now - row.revokedAt >= REVOCATION_TOMBSTONE_TTL_MS;
      }
      const expiredAt = row.expiredAt ?? row.absoluteExpiresAt;
      return (row.status === 'expired' || now >= row.absoluteExpiresAt) &&
        now - expiredAt >= REVOCATION_TOMBSTONE_TTL_MS;
    }
    fail('state-unavailable');
  }

  async #rateRemovable(entity: AzureStoredEntity, now: number): Promise<boolean> {
    const kind = Object.getOwnPropertyDescriptor(entity.properties, 'kind')?.value;
    if (kind === 'readiness') return false;
    if (kind === 'rate' || kind === 'audio-window') {
      const input = exactAzureProperties(
        entity.properties,
        this.environment,
        kind,
        kind === 'rate'
          ? ['scope', 'window', 'events', 'retainUntil']
          : [
              'scope', 'window', 'events', 'retainUntil', 'installationId', 'sessionEpoch',
              'nextOriginalSampleOffset', 'activeGrantExpiresAt'
            ],
        kind === 'audio-window' ? ['sessionId', 'activeUtteranceId'] : []
      );
      decodeWindowEvents(input.events);
      if (kind === 'audio-window') {
        intField(input, 'nextOriginalSampleOffset');
        intField(input, 'activeGrantExpiresAt');
        const installationId = assertCanonicalUuid(stringField(input, 'installationId', UUID, 36));
        const sessionEpoch = intField(input, 'sessionEpoch');
        const sessionIdValue = optionalStringField(input, 'sessionId', UUID, 36);
        const utterance = optionalStringField(input, 'activeUtteranceId', UUID, 36);
        if (utterance !== undefined) assertCanonicalUuid(utterance);
        if (input.window === 'audio-session') {
          if (sessionIdValue === undefined || sessionEpoch <= 0) fail('state-unavailable');
          const sessionId = assertCanonicalUuid(sessionIdValue);
          const sessionEntityValue = await this.#point(
            this.#security,
            this.environment,
            sessionKey(installationId)
          );
          if (sessionEntityValue !== undefined) {
            const session = parseSession(sessionEntityValue, this.environment, installationId);
            if (
              session.sessionId === sessionId && session.sessionEpoch === sessionEpoch &&
              (session.status === 'opening' || session.status === 'active') && now < session.leaseExpiresAt
            ) return false;
          }
        } else if (input.window !== 'audio-installation' || sessionIdValue !== undefined || sessionEpoch !== 0) {
          fail('state-unavailable');
        }
      }
      return now >= intField(input, 'retainUntil');
    }
    if (kind === 'audio-grant') {
      if (!entity.rowKey.startsWith('audio-grant:')) fail('state-unavailable');
      const grantId = assertCanonicalUuid(entity.rowKey.slice(12));
      const row = parseAudioGrant(entity, this.environment, entity.partitionKey, grantId);
      return now >= row.expiresAt;
    }
    if (kind === 'generation') {
      if (!entity.rowKey.startsWith('generation:')) fail('state-unavailable');
      const authorizationId = assertCanonicalSha256(entity.rowKey.slice(11));
      const row = parseGeneration(entity, this.environment, entity.partitionKey, authorizationId);
      return now >= row.retainUntil;
    }
    if (kind === 'generation-counter') {
      const input = exactAzureProperties(entity.properties, this.environment, 'generation-counter', [
        'installationId', 'sessionId', 'sessionEpoch', 'generatedEvents', 'attemptEvents',
        'generatedTotal', 'attemptTotal'
      ]);
      decodeWindowEvents(input.generatedEvents);
      decodeWindowEvents(input.attemptEvents);
      const installationId = assertCanonicalUuid(stringField(input, 'installationId', UUID, 36));
      const sessionId = assertCanonicalUuid(stringField(input, 'sessionId', UUID, 36));
      const epoch = positiveIntField(input, 'sessionEpoch');
      const sessionEntityValue = await this.#point(this.#security, this.environment, sessionKey(installationId));
      if (sessionEntityValue === undefined) return true;
      const session = parseSession(sessionEntityValue, this.environment, installationId);
      return session.sessionId !== sessionId || session.sessionEpoch !== epoch ||
        ['ended', 'expired', 'revoked', 'none'].includes(session.status);
    }
    fail('state-unavailable');
  }

  async cleanupExpired(value: CleanupInput): Promise<CleanupResult> {
    const input = exactDataObject(value, ['limit']);
    if (!positiveSafeInteger(input.limit) || input.limit > 10_000) fail('invalid-input');
    if (this.#cleanupSecurityExhausted && this.#cleanupRateExhausted) {
      this.#cleanupSecurityToken = undefined;
      this.#cleanupRateToken = undefined;
      this.#cleanupTable = 'security';
      this.#cleanupSecurityExhausted = false;
      this.#cleanupRateExhausted = false;
    }
    const now = this.#now();
    let visited = 0;
    let pagesVisited = 0;
    let removed = 0;
    let securityRemoved = 0;
    let rateRemoved = 0;
    let securityStoppedForRun = false;
    let rateStoppedForRun = false;
    while (visited < input.limit && pagesVisited < input.limit) {
      const securityAvailable = !this.#cleanupSecurityExhausted && !securityStoppedForRun;
      const rateAvailable = !this.#cleanupRateExhausted && !rateStoppedForRun;
      if (!securityAvailable && !rateAvailable) break;
      if (
        (this.#cleanupTable === 'security' && !securityAvailable) ||
        (this.#cleanupTable === 'rate' && !rateAvailable)
      ) {
        this.#cleanupTable = this.#cleanupTable === 'security' ? 'rate' : 'security';
      }
      const tableName = this.#cleanupTable;
      const table = tableName === 'security' ? this.#security : this.#rate;
      const token = tableName === 'security' ? this.#cleanupSecurityToken : this.#cleanupRateToken;
      const activeTables = Number(securityAvailable) + Number(rateAvailable);
      const rowBudget = Math.max(1, Math.ceil((input.limit - visited) / activeTables));
      const page = await table.listPage({
        limit: Math.min(100, rowBudget),
        ...(tableName === 'security' ? { partitionKey: this.environment } : {}),
        ...(token === undefined ? {} : { continuationToken: token })
      }).catch((error: unknown) => mapBoundary(error));
      pagesVisited += 1;
      if (tableName === 'security') this.#cleanupSecurityToken = page.continuationToken;
      else this.#cleanupRateToken = page.continuationToken;
      for (const entity of page.entities) {
        if (visited >= input.limit) break;
        visited += 1;
        const removable = tableName === 'security'
          ? await this.#securityRemovable(entity, now)
          : await this.#rateRemovable(entity, now);
        if (!removable) continue;
        try {
          await table.delete(entity.partitionKey, entity.rowKey, entity.etag);
          removed += 1;
          if (tableName === 'security') securityRemoved += 1;
          else rateRemoved += 1;
        } catch (error) {
          if (!isBoundary(error, 'not-found', 'precondition-failed', 'ambiguous')) mapBoundary(error);
        }
      }
      const exhausted = page.continuationToken === undefined;
      const stalled = !exhausted && page.entities.length === 0 && token !== undefined &&
        page.continuationToken === token;
      if (exhausted) {
        if (tableName === 'security') this.#cleanupSecurityToken = undefined;
        else this.#cleanupRateToken = undefined;
        if (tableName === 'security') this.#cleanupSecurityExhausted = true;
        else this.#cleanupRateExhausted = true;
      } else if (stalled) {
        if (tableName === 'security') securityStoppedForRun = true;
        else rateStoppedForRun = true;
      }
      this.#cleanupTable = tableName === 'security' ? 'rate' : 'security';
    }
    return freeze({
      visited,
      removed,
      removedByTable: freeze({ security: securityRemoved, rate: rateRemoved }),
      exhausted: this.#cleanupSecurityExhausted && this.#cleanupRateExhausted
    });
  }
}

class AzureRuntimeStore implements DurableSecurityStateStore, SecurityStateMaintenanceStore {
  readonly [DURABLE_SECURITY_STATE_STORE] = true as const;
  readonly deploymentBoundary = 'DURABLE_PROVIDER' as const;
  readonly capabilities = DURABLE_CAPABILITIES;
  readonly #core: AzureSecurityStateCore;

  constructor(core: AzureSecurityStateCore) {
    this.#core = core;
    Object.freeze(this);
  }

  redeemPairing = (input: RedeemPairingInput): Promise<PairingRedemptionResult> => this.#core.redeemPairing(input);
  authenticateCredential = (input: AuthenticateCredentialInput): Promise<CredentialAuthentication> =>
    this.#core.authenticateCredential(input);
  beginCredentialRotation = (input: BeginCredentialRotationInput): Promise<PendingCredentialResult> =>
    this.#core.beginCredentialRotation(input);
  promoteCredential = (input: PromoteCredentialInput): Promise<CredentialPromotionResult> =>
    this.#core.promoteCredential(input);
  revokeInstallation = (input: RevokeInstallationInput): Promise<InstallationMutationResult> =>
    this.#core.revokeInstallation(input);
  revokeCurrentInstallation = (input: RevokeCurrentInstallationInput): Promise<InstallationRevocationResult> =>
    this.#core.revokeCurrentInstallation(input);
  issueSessionTicket = (input: TicketOperationInput): Promise<SessionTicketResult> => this.#core.issueSessionTicket(input);
  consumeSessionTicket = (input: ConsumeTicketInput): Promise<SessionLease> => this.#core.consumeSessionTicket(input);
  activateSession = (input: ActivateSessionInput): Promise<SessionLease> => this.#core.activateSession(input);
  heartbeatSession = (input: SessionLeaseInput): Promise<SessionLease> => this.#core.heartbeatSession(input);
  endSession = (input: SessionLeaseInput): Promise<void> => this.#core.endSession(input);
  reserveAudio = (input: ReserveAudioInput): Promise<AudioGrant> => this.#core.reserveAudio(input);
  authorizeGeneration = (input: AuthorizeGenerationInput): Promise<GenerationAuthorizationResult> =>
    this.#core.authorizeGeneration(input);
  providerStart = (input: GenerationClaimInput): Promise<GenerationProviderStartResult> => this.#core.providerStart(input);
  heartbeatGeneration = (input: GenerationClaimInput): Promise<GenerationClaim> => this.#core.heartbeatGeneration(input);
  completeGeneration = (input: CompleteGenerationInput): Promise<GenerationClaim> => this.#core.completeGeneration(input);
  releaseGeneration = (input: GenerationClaimInput): Promise<GenerationClaim> => this.#core.releaseGeneration(input);
  checkReadiness = (signal?: AbortSignal): Promise<void> => this.#core.checkReadiness(signal);
  cleanupExpired = (input: CleanupInput): Promise<CleanupResult> => this.#core.cleanupExpired(input);
}

class AzureOperatorStore implements PairingOperatorStore, SecurityStateMaintenanceStore {
  readonly #core: AzureSecurityStateCore;

  constructor(core: AzureSecurityStateCore) {
    this.#core = core;
    Object.freeze(this);
  }

  issuePairing = (input: IssuePairingInput): Promise<PairingIssueResult> => this.#core.issuePairing(input);
  revokePairing = (input: RevokePairingInput): Promise<void> => this.#core.revokePairing(input);
  checkReadiness = (signal?: AbortSignal): Promise<void> => this.#core.checkReadiness(signal);
  cleanupExpired = (input: CleanupInput): Promise<CleanupResult> => this.#core.cleanupExpired(input);
}

class AzureBootstrapStore implements AzureTableBootstrapStore {
  readonly #core: AzureSecurityStateCore;

  constructor(core: AzureSecurityStateCore) {
    this.#core = core;
    Object.freeze(this);
  }

  initializeState = (signal?: AbortSignal): Promise<void> => this.#core.initializeState(signal);
}

class AzurePairingOnlyStore implements PairingOperatorStore {
  readonly #core: AzureSecurityStateCore;

  constructor(core: AzureSecurityStateCore) {
    this.#core = core;
    Object.freeze(this);
  }

  issuePairing = (input: IssuePairingInput): Promise<PairingIssueResult> => this.#core.issuePairing(input);
  revokePairing = (input: RevokePairingInput): Promise<void> => this.#core.revokePairing(input);
}

class AzureMaintenanceStore implements SecurityStateMaintenanceStore {
  readonly #core: AzureSecurityStateCore;

  constructor(core: AzureSecurityStateCore) {
    this.#core = core;
    Object.freeze(this);
  }

  checkReadiness = (signal?: AbortSignal): Promise<void> => this.#core.checkReadiness(signal);
  cleanupExpired = (input: CleanupInput): Promise<CleanupResult> => this.#core.cleanupExpired(input);
}

function productionCore(value: AzureTableRuntimeStoreOptions): AzureSecurityStateCore {
  const options = parseProductionOptions(value);
  const clients = createProductionAzureClients(options);
  return new AzureSecurityStateCore({
    environment: options.environment,
    audience: options.audience,
    security: clients.security,
    rate: clients.rate,
    clock: createSystemClock(),
    ids: createSystemIdFactory(),
    tokens: createSystemTokenFactory()
  });
}

function azureCliOperatorCore(value: AzureCliTableOperationsOptions): AzureSecurityStateCore {
  const options = parseAzureCliOperationsOptions(value);
  const clients = createAzureCliOperatorClients(options);
  return new AzureSecurityStateCore({
    environment: options.environment,
    audience: options.audience,
    security: clients.security,
    rate: clients.rate,
    clock: createSystemClock(),
    ids: createSystemIdFactory(),
    tokens: createSystemTokenFactory()
  });
}

export function createAzureTableRuntimeStore(
  options: AzureTableRuntimeStoreOptions
): DurableSecurityStateStore & SecurityStateMaintenanceStore {
  return new AzureRuntimeStore(productionCore(options));
}

export function createAzureTableOperatorStore(
  options: AzureTableRuntimeStoreOptions
): PairingOperatorStore & SecurityStateMaintenanceStore {
  return new AzureOperatorStore(productionCore(options));
}

export function createAzureTableBootstrapStore(
  options: AzureTableRuntimeStoreOptions
): AzureTableBootstrapStore {
  return new AzureBootstrapStore(productionCore(options));
}

export function createAzureCliTableOperations(
  options: AzureCliTableOperationsOptions
): Readonly<{
  bootstrap: AzureTableBootstrapStore;
  operator: PairingOperatorStore;
  maintenance: SecurityStateMaintenanceStore;
}> {
  const core = azureCliOperatorCore(options);
  return freeze({
    bootstrap: new AzureBootstrapStore(core),
    operator: new AzurePairingOnlyStore(core),
    maintenance: new AzureMaintenanceStore(core)
  });
}

export function createAzureTableStoresForTesting(options: AzureTableTestingOptions): Readonly<{
  runtime: DurableSecurityStateStore & SecurityStateMaintenanceStore;
  operator: PairingOperatorStore & SecurityStateMaintenanceStore;
  bootstrap: AzureTableBootstrapStore;
}> {
  const core = new AzureSecurityStateCore(parseTestingOptions(options));
  return freeze({
    runtime: new AzureRuntimeStore(core),
    operator: new AzureOperatorStore(core),
    bootstrap: new AzureBootstrapStore(core)
  });
}
