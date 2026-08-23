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
  type CanonicalToken,
  type CanonicalUuid
} from './crypto.js';
import { types as utilTypes } from 'node:util';
import { createAvailableState, createSystemClock, createSystemIdFactory, createSystemTokenFactory } from './clock.js';
import { SecurityStateError, type SecurityErrorCategory } from './errors.js';
import { boundedString, exactDataObject, nonNegativeSafeInteger, positiveSafeInteger, type DataSnapshot } from './schema.js';
import {
  ACTIVE_LEASE_MS,
  AUDIO_GRANT_TTL_MS,
  AUDIO_RESERVATION_WINDOW_MS,
  ATTEMPTS_PER_MINUTE,
  ATTEMPTS_PER_SESSION,
  COLLISION_RETRY_LIMIT,
  CREDENTIAL_ABSOLUTE_TTL_MS,
  CREDENTIAL_IDLE_TTL_MS,
  GENERATIONS_PER_MINUTE,
  GENERATIONS_PER_SESSION,
  LOCAL_MOCK_ONLY,
  LOCAL_MOCK_ENVIRONMENT,
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
  SECURITY_STATE_CAPABILITIES,
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
  type CredentialStatus,
  type GenerationAuthorizationResult,
  type GenerationClaim,
  type GenerationClaimInput,
  type GenerationProviderStartResult,
  type GenerationStatus,
  type InstallationMutationResult,
  type InstallationRevocationResult,
  type IssuePairingInput,
  type LocalMockSecurityStateStore,
  type LocalMockSecurityStateOptions,
  type PairingIssueResult,
  type PairingRedemptionResult,
  type PairingStatus,
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
  type SecurityStateSnapshot,
  type SecurityTokenFactory,
  type SessionLease,
  type SessionLeaseInput,
  type SessionStartMessage,
  type SessionStatus,
  type SessionTicketResult,
  type StateAvailability,
  type TicketBinding,
  type TicketOperationInput,
  type TicketStatus
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

interface PairingRow {
  readonly hash: CanonicalSha256;
  readonly operatorScopeHash: CanonicalSha256;
  readonly issuedAt: number;
  readonly expiresAt: number;
  status: PairingStatus;
  consumedAt?: number;
  revokedAt?: number;
}

interface CredentialRow {
  readonly hash: CanonicalSha256;
  readonly installationId: CanonicalUuid;
  readonly version: number;
  readonly issuedAt: number;
  readonly absoluteExpiresAt: number;
  status: CredentialStatus;
  lastUsedAt: number;
  idleExpiresAt: number;
  pendingExpiresAt?: number;
}

interface InstallationRow {
  readonly id: CanonicalUuid;
  readonly issuedAt: number;
  readonly absoluteExpiresAt: number;
  status: 'active' | 'revoked' | 'expired';
  revokedAt?: number;
  expiredAt?: number;
  tombstoneVersion: number;
  currentCredentialHash: CanonicalSha256;
  currentCredentialVersion: number;
  pendingCredentialHash?: CanonicalSha256;
  pendingCredentialVersion?: number;
  pendingExpiresAt?: number;
  sessionEpoch: number;
  activeSessionId?: CanonicalUuid;
  readonly audioWindow: RollingAmountWindow;
  readonly grantWindow: RollingWindow;
}

interface TicketRow {
  readonly hash: CanonicalSha256;
  readonly installationId: CanonicalUuid;
  readonly tombstoneVersion: number;
  readonly credentialVersion: number;
  readonly binding: TicketBinding;
  readonly issuedAt: number;
  readonly expiresAt: number;
  status: TicketStatus;
  consumedAt?: number;
}

interface SessionRow {
  readonly installationId: CanonicalUuid;
  readonly id: CanonicalUuid;
  readonly epoch: number;
  readonly credentialVersion: number;
  readonly tombstoneVersion: number;
  status: SessionStatus;
  leaseVersion: number;
  leaseExpiresAt: number;
  lastHeartbeatAt: number;
  audioReservedOriginalSamples: number;
  readonly audioWindow: RollingAmountWindow;
  readonly grantWindow: RollingWindow;
  readonly grantIds: Set<CanonicalUuid>;
  generatedCount: number;
  attemptCount: number;
  readonly generatedWindow: RollingWindow;
  readonly attemptWindow: RollingWindow;
}

interface GrantRow {
  readonly id: CanonicalUuid;
  readonly utteranceId: CanonicalUuid;
  readonly installationId: CanonicalUuid;
  readonly sessionId: CanonicalUuid;
  readonly sessionEpoch: number;
  readonly tombstoneVersion: number;
  readonly sessionLeaseVersion: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly fromOriginalSampleOffset: number;
  readonly throughOriginalSampleOffset: number;
  readonly reservedOriginalSamples: number;
}

interface GenerationRow {
  readonly authorizationId: CanonicalSha256;
  readonly installationId: CanonicalUuid;
  readonly sessionId: CanonicalUuid;
  readonly sessionEpoch: number;
  readonly tombstoneVersion: number;
  claimId: CanonicalUuid;
  claimVersion: number;
  leaseVersion: number;
  leaseExpiresAt: number;
  status: GenerationStatus;
  startedConsumed: boolean;
  readonly authorizedAt: number;
  providerStartedAt?: number;
  completedAt?: number;
  completionOutcome?: 'completed' | 'failed';
  releasedFromClaimVersion?: number;
  releasedFromLeaseVersion?: number;
  releasedFromLeaseExpiresAt?: number;
}

interface AuthenticationPlan {
  readonly credential: CredentialRow;
  readonly installation: InstallationRow;
  readonly pending: boolean;
  readonly idleExpiresAt: number;
}

interface RevokedSessionIdentity {
  readonly sessionId: CanonicalUuid;
  readonly sessionEpoch: number;
}

type CleanupEntry = readonly [Map<unknown, unknown>, unknown];

class RollingWindow {
  readonly timestamps: number[] = [];
  head = 0;

  count(now: number, period: number): number {
    const cutoff = now - period;
    let index = this.head;
    while (index < this.timestamps.length && (this.timestamps[index] ?? Number.MAX_SAFE_INTEGER) <= cutoff) {
      index += 1;
    }
    return this.timestamps.length - index;
  }

  add(now: number, period: number): void {
    const cutoff = now - period;
    while (this.head < this.timestamps.length && (this.timestamps[this.head] ?? Number.MAX_SAFE_INTEGER) <= cutoff) {
      this.head += 1;
    }
    if (this.head > 64 && this.head * 2 > this.timestamps.length) {
      this.timestamps.splice(0, this.head);
      this.head = 0;
    }
    this.timestamps.push(now);
  }
}

class RollingAmountWindow {
  readonly entries: { readonly at: number; readonly amount: number }[] = [];
  head = 0;
  total = 0;

  amount(now: number, period: number): number {
    const cutoff = now - period;
    let index = this.head;
    let result = this.total;
    while (index < this.entries.length && (this.entries[index]?.at ?? Number.MAX_SAFE_INTEGER) <= cutoff) {
      result -= this.entries[index]?.amount ?? 0;
      index += 1;
    }
    return result;
  }

  add(now: number, period: number, amount: number): void {
    const cutoff = now - period;
    while (this.head < this.entries.length && (this.entries[this.head]?.at ?? Number.MAX_SAFE_INTEGER) <= cutoff) {
      this.total -= this.entries[this.head]?.amount ?? 0;
      this.head += 1;
    }
    if (this.head > 64 && this.head * 2 > this.entries.length) {
      this.entries.splice(0, this.head);
      this.head = 0;
    }
    this.entries.push({ at: now, amount });
    this.total += amount;
  }
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function fail(category: SecurityErrorCategory): never {
  throw new SecurityStateError(category);
}

function checkedAdd(left: number, right: number, category: SecurityErrorCategory = 'state-unavailable'): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) fail(category);
  return result;
}

function checkedIncrement(value: number, category: SecurityErrorCategory): number {
  return checkedAdd(value, 1, category);
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function opaque(value: unknown, maximum = 128): string {
  if (!boundedString(value, maximum) || !/^[A-Za-z0-9._:@/-]+$/.test(value)) fail('invalid-input');
  return value;
}

function canonicalOrigin(value: unknown): string {
  if (!boundedString(value, 255)) fail('invalid-input');
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'wss:' || url.username !== '' || url.password !== '' ||
      url.pathname !== '/' || url.search !== '' || url.hash !== '' || value !== url.origin ||
      (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')
    ) fail('invalid-input');
    return value;
  } catch (error) {
    if (error instanceof SecurityStateError) throw error;
    fail('invalid-input');
  }
}

function parseAudience(
  value: unknown,
  category: SecurityErrorCategory = 'invalid-input'
): SecurityAudience {
  let input: DataSnapshot;
  try {
    input = exactDataObject(value, ['origin', 'path', 'protocol'], [], category);
  } catch {
    fail(category);
  }
  let origin: string;
  try {
    origin = canonicalOrigin(input.origin);
  } catch {
    fail(category);
  }
  if (input.path !== '/v1/stream' || input.protocol !== 'palancar.v1') fail(category);
  return freeze({ origin, path: '/v1/stream' as const, protocol: 'palancar.v1' as const });
}

function sameAudience(left: SecurityAudience, right: SecurityAudience): boolean {
  return left.origin === right.origin && left.path === right.path && left.protocol === right.protocol;
}

function parseBinding(input: DataSnapshot, category: SecurityErrorCategory = 'invalid-input'): TicketBinding {
  if (!boundedString(input.environment, 64) || !/^[A-Za-z0-9._-]+$/.test(input.environment)) fail(category);
  if (typeof input.intent !== 'string') fail(category);
  return freeze({
    environment: input.environment,
    audience: parseAudience(input.audience, category),
    intent: input.intent as 'new'
  });
}

function parseLease(value: unknown): SessionLease {
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

function parseClaim(value: unknown): GenerationClaim {
  const input = exactDataObject(value, [
    'authorizationId', 'claimId', 'installationId', 'sessionId', 'sessionEpoch', 'claimVersion',
    'leaseVersion', 'phase', 'leaseExpiresAt'
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

function parseDependency(value: unknown, keys: readonly string[]): DataSnapshot {
  const result = exactDataObject(value, keys);
  for (const key of keys) if (typeof result[key] !== 'function') fail('invalid-input');
  return result;
}

function parseOptions(value: unknown): {
  readonly environment: typeof LOCAL_MOCK_ENVIRONMENT;
  readonly audience: SecurityAudience;
  readonly clock: SecurityClock;
  readonly ids: SecurityIdFactory;
  readonly tokens: SecurityTokenFactory;
  readonly availability: StateAvailability;
  readonly generationProvider: 'mock';
  readonly transcriptionProvider: 'mock';
} {
  const input = exactDataObject(
    value,
    ['deploymentBoundary', 'environment', 'audience', 'generationProvider', 'transcriptionProvider'],
    ['clock', 'ids', 'tokens', 'availability']
  );
  if (input.deploymentBoundary !== LOCAL_MOCK_ONLY || input.environment !== LOCAL_MOCK_ENVIRONMENT) {
    fail('invalid-input');
  }
  if (input.generationProvider !== 'mock' || input.transcriptionProvider !== 'mock') fail('invalid-input');
  const environment = LOCAL_MOCK_ENVIRONMENT;
  const audience = parseAudience(input.audience);
  const rawClock = input.clock ?? createSystemClock();
  const rawIds = input.ids ?? createSystemIdFactory();
  const rawTokens = input.tokens ?? createSystemTokenFactory();
  const rawAvailability = input.availability ?? createAvailableState();
  const clock = parseDependency(rawClock, ['now']);
  const ids = parseDependency(rawIds, ['installationId', 'sessionId', 'grantId', 'generationClaimId']);
  const tokens = parseDependency(rawTokens, ['pairingCode', 'credential', 'ticket']);
  const availability = parseDependency(rawAvailability, ['isAvailable']);
  return {
    environment,
    audience,
    clock: clock as unknown as SecurityClock,
    ids: ids as unknown as SecurityIdFactory,
    tokens: tokens as unknown as SecurityTokenFactory,
    availability: availability as unknown as StateAvailability,
    generationProvider: 'mock',
    transcriptionProvider: 'mock'
  };
}

export class InMemorySecurityStateStore implements LocalMockSecurityStateStore {
  readonly deploymentBoundary = LOCAL_MOCK_ONLY;
  readonly capabilities = SECURITY_STATE_CAPABILITIES;
  readonly environment: typeof LOCAL_MOCK_ENVIRONMENT;
  readonly audience: SecurityAudience;
  readonly generationProvider: 'mock';
  readonly transcriptionProvider: 'mock';

  readonly #clock: SecurityClock;
  readonly #ids: SecurityIdFactory;
  readonly #tokens: SecurityTokenFactory;
  readonly #availability: StateAvailability;
  #externalActive = false;
  #commitActive = false;
  #reentryDetected = false;
  #latestAcceptedObservation = 0;

  readonly #pairings = new Map<CanonicalSha256, PairingRow>();
  readonly #credentials = new Map<CanonicalSha256, CredentialRow>();
  readonly #installations = new Map<CanonicalUuid, InstallationRow>();
  readonly #tickets = new Map<CanonicalSha256, TicketRow>();
  readonly #sessions = new Map<CanonicalUuid, SessionRow>();
  readonly #revokedSessionIdentities = new Map<CanonicalUuid, RevokedSessionIdentity>();
  readonly #grants = new Map<CanonicalUuid, GrantRow>();
  readonly #generations = new Map<CanonicalSha256, GenerationRow>();
  readonly #generationClaims = new Map<CanonicalUuid, GenerationRow>();
  readonly #operatorIssueRates = new Map<CanonicalSha256, RollingWindow>();
  readonly #pairAttemptShortRates = new Map<CanonicalSha256, RollingWindow>();
  readonly #pairAttemptDayRates = new Map<CanonicalSha256, RollingWindow>();
  readonly #ticketMinuteRates = new Map<CanonicalUuid, RollingWindow>();
  readonly #ticketHourRates = new Map<CanonicalUuid, RollingWindow>();
  readonly #reconnectMinuteRates = new Map<CanonicalUuid, RollingWindow>();
  readonly #reconnectTenMinuteRates = new Map<CanonicalUuid, RollingWindow>();
  #cleanupTable: 'security' | 'rate' = 'security';
  #cleanupSecurityEntries: readonly CleanupEntry[] | undefined;
  #cleanupRateEntries: readonly CleanupEntry[] | undefined;
  #cleanupSecurityIndex = 0;
  #cleanupRateIndex = 0;
  #cleanupSecurityExhausted = false;
  #cleanupRateExhausted = false;

  constructor(options: LocalMockSecurityStateOptions) {
    const parsed = parseOptions(options);
    this.environment = parsed.environment;
    this.audience = parsed.audience;
    this.generationProvider = parsed.generationProvider;
    this.transcriptionProvider = parsed.transcriptionProvider;
    this.#clock = parsed.clock;
    this.#ids = parsed.ids;
    this.#tokens = parsed.tokens;
    this.#availability = parsed.availability;
    Object.freeze(this);
  }

  #entry(): void {
    if (this.#externalActive || this.#commitActive) {
      this.#reentryDetected = true;
      fail('state-unavailable');
    }
  }

  #external<T>(callback: () => T): T {
    if (this.#externalActive || this.#commitActive) fail('state-unavailable');
    this.#externalActive = true;
    this.#reentryDetected = false;
    try {
      const result = callback();
      if (this.#reentryDetected) fail('state-unavailable');
      return result;
    } catch (error) {
      if (error instanceof SecurityStateError) throw error;
      fail('state-unavailable');
    } finally {
      this.#externalActive = false;
    }
  }

  #context(minimum = this.#latestAcceptedObservation): number {
    const available = this.#external(() => this.#availability.isAvailable());
    if (available !== true) fail('state-unavailable');
    const now = this.#external(() => this.#clock.now());
    if (!nonNegativeSafeInteger(now) || now < this.#latestAcceptedObservation || now < minimum) {
      fail('state-unavailable');
    }
    this.#latestAcceptedObservation = now;
    return now;
  }

  #commit<T>(now: number, transaction: () => T): T {
    if (this.#externalActive || this.#commitActive || now < this.#latestAcceptedObservation) {
      fail('state-unavailable');
    }
    const available = this.#external(() => this.#availability.isAvailable());
    if (available !== true || now < this.#latestAcceptedObservation) fail('state-unavailable');
    this.#commitActive = true;
    try {
      const result = transaction();
      return result;
    } finally {
      this.#commitActive = false;
    }
  }

  #candidate<T extends string>(
    factory: () => string,
    validate: (value: unknown) => T,
    exists: (value: T) => boolean
  ): T {
    for (let attempt = 0; attempt < COLLISION_RETRY_LIMIT; attempt += 1) {
      let value: T;
      try {
        value = validate(this.#external(factory));
      } catch (error) {
        if (error instanceof SecurityStateError && error.category === 'invalid-input') {
          fail('state-unavailable');
        }
        throw error;
      }
      if (!exists(value)) return value;
    }
    fail('state-unavailable');
  }

  #window<K>(map: Map<K, RollingWindow>, key: K): RollingWindow {
    return map.get(key) ?? new RollingWindow();
  }

  #installWindow<K>(map: Map<K, RollingWindow>, key: K, window: RollingWindow): void {
    if (!map.has(key)) map.set(key, window);
  }

  #bindingMatches(binding: TicketBinding): boolean {
    return binding.environment === this.environment && binding.intent === 'new' && sameAudience(binding.audience, this.audience);
  }

  #installationActive(row: InstallationRow, now: number): boolean {
    return row.status === 'active' && now < row.absoluteExpiresAt;
  }

  #credentialActive(row: CredentialRow, now: number): boolean {
    return (row.status === 'current' || row.status === 'pending') &&
      now < row.absoluteExpiresAt && now < row.idleExpiresAt &&
      (row.pendingExpiresAt === undefined || now < row.pendingExpiresAt);
  }

  #sessionActive(row: SessionRow, installation: InstallationRow, now: number): boolean {
    return row.status === 'active' && now < row.leaseExpiresAt &&
      installation.status === 'active' && now < installation.absoluteExpiresAt &&
      installation.tombstoneVersion === row.tombstoneVersion && installation.activeSessionId === row.id &&
      installation.currentCredentialVersion === row.credentialVersion;
  }

  #lease(row: SessionRow): SessionLease {
    return freeze({
      installationId: row.installationId,
      sessionId: row.id,
      sessionEpoch: row.epoch,
      credentialVersion: row.credentialVersion,
      leaseVersion: row.leaseVersion,
      phase: row.status === 'opening' ? 'opening' as const : 'active' as const,
      leaseExpiresAt: row.leaseExpiresAt
    });
  }

  #grant(row: GrantRow): AudioGrant {
    return freeze({
      grantId: row.id,
      installationId: row.installationId,
      sessionId: row.sessionId,
      sessionEpoch: row.sessionEpoch,
      sessionLeaseVersion: row.sessionLeaseVersion,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      fromOriginalSampleOffset: row.fromOriginalSampleOffset,
      throughOriginalSampleOffset: row.throughOriginalSampleOffset,
      reservedOriginalSamples: row.reservedOriginalSamples,
      utteranceId: row.utteranceId
    });
  }

  #deleteGrant(row: GrantRow): void {
    this.#grants.delete(row.id);
    this.#sessions.get(row.sessionId)?.grantIds.delete(row.id);
  }

  #cleanupSessionGrants(session: SessionRow, now: number): void {
    for (const grantId of session.grantIds) {
      const grant = this.#grants.get(grantId);
      if (grant === undefined) session.grantIds.delete(grantId);
      else if (now >= grant.expiresAt) this.#deleteGrant(grant);
    }
  }

  #deleteSessionGrants(session: SessionRow): void {
    for (const grantId of session.grantIds) this.#grants.delete(grantId);
    session.grantIds.clear();
  }

  #claim(row: GenerationRow): GenerationClaim {
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

  #leaseMatches(input: SessionLease, row: SessionRow): boolean {
    return input.installationId === row.installationId && input.sessionId === row.id &&
      input.sessionEpoch === row.epoch && input.credentialVersion === row.credentialVersion &&
      input.leaseVersion === row.leaseVersion && input.leaseExpiresAt === row.leaseExpiresAt &&
      input.phase === (row.status === 'opening' ? 'opening' : 'active');
  }

  #claimMatches(input: GenerationClaim, row: GenerationRow): boolean {
    return input.authorizationId === row.authorizationId && input.claimId === row.claimId &&
      input.installationId === row.installationId &&
      input.sessionId === row.sessionId && input.sessionEpoch === row.sessionEpoch &&
      input.claimVersion === row.claimVersion && input.leaseVersion === row.leaseVersion &&
      input.phase === row.status && input.leaseExpiresAt === row.leaseExpiresAt;
  }

  #claimIdentityMatches(input: GenerationClaim, row: GenerationRow): boolean {
    return input.authorizationId === row.authorizationId && input.claimId === row.claimId &&
      input.installationId === row.installationId && input.sessionId === row.sessionId &&
      input.sessionEpoch === row.sessionEpoch;
  }

  #releaseSourceMatches(input: GenerationClaim, row: GenerationRow): boolean {
    return input.authorizationId === row.authorizationId && input.claimId === row.claimId &&
      input.installationId === row.installationId &&
      input.sessionId === row.sessionId && input.sessionEpoch === row.sessionEpoch &&
      input.phase === 'claimed' && input.claimVersion === row.releasedFromClaimVersion &&
      input.leaseVersion === row.releasedFromLeaseVersion &&
      input.leaseExpiresAt === row.releasedFromLeaseExpiresAt;
  }

  #expireGeneration(row: GenerationRow, now: number): void {
    if (row.status === 'claimed' && !row.startedConsumed) {
      row.releasedFromClaimVersion = row.claimVersion;
      row.releasedFromLeaseVersion = row.leaseVersion;
      row.releasedFromLeaseExpiresAt = row.leaseExpiresAt;
    }
    row.status = 'released';
    row.leaseExpiresAt = now;
  }

  async issuePairing(value: IssuePairingInput): Promise<PairingIssueResult> {
    this.#entry();
    const input = exactDataObject(value, ['operatorScope']);
    const operatorScope = opaque(input.operatorScope);
    const operatorHash = hashCorrelationKey(operatorScope);
    const before = this.#context();
    const code = this.#candidate(this.#tokens.pairingCode, assertCanonicalPairingCode, (item) => this.#pairings.has(hashPairingCode(item)));
    const hash = hashPairingCode(code);
    const now = this.#context(before);
    const expiresAt = checkedAdd(now, PAIRING_TTL_MS);
    const rate = this.#window(this.#operatorIssueRates, operatorHash);
    return this.#commit(now, () => {
      if (rate.count(now, DAY_MS) >= PAIR_ISSUES_PER_DAY) fail('rate-limited');
      if (this.#pairings.has(hash)) fail('state-unavailable');
      rate.add(now, DAY_MS);
      this.#installWindow(this.#operatorIssueRates, operatorHash, rate);
      this.#pairings.set(hash, { hash, operatorScopeHash: operatorHash, issuedAt: now, expiresAt, status: 'issued' });
      return freeze({ pairingCode: code, issuedAt: now, expiresAt });
    });
  }

  async revokePairing(value: RevokePairingInput): Promise<void> {
    this.#entry();
    const input = exactDataObject(value, ['pairingHash']);
    const hash = assertCanonicalSha256(input.pairingHash);
    const now = this.#context();
    const result = this.#commit(now, () => {
      const row = this.#pairings.get(hash);
      if (row === undefined || row.status !== 'issued' || now >= row.expiresAt) return false;
      row.status = 'revoked';
      row.revokedAt = now;
      return true;
    });
    if (!result) fail('invalid-pairing');
  }

  async redeemPairing(value: RedeemPairingInput): Promise<PairingRedemptionResult> {
    this.#entry();
    const input = exactDataObject(value, ['pairingCode', 'trustedSource']);
    const trustedSource = opaque(input.trustedSource);
    const sourceHash = hashCorrelationKey(trustedSource);
    let pairHash: CanonicalSha256 | undefined;
    try { pairHash = hashPairingCode(input.pairingCode); } catch { pairHash = undefined; }
    const before = this.#context();
    const preflightPair = pairHash === undefined ? undefined : this.#pairings.get(pairHash);
    const preflightValid = preflightPair !== undefined && preflightPair.status === 'issued' && before < preflightPair.expiresAt;
    const installationId = preflightValid
      ? this.#candidate(this.#ids.installationId, assertCanonicalUuid, (id) => this.#installations.has(id))
      : undefined;
    const credential = preflightValid
      ? this.#candidate(this.#tokens.credential, assertCanonical256BitToken, (token) => this.#credentials.has(hashCredential(token)))
      : undefined;
    const credentialHash = credential === undefined ? undefined : hashCredential(credential);
    const now = this.#context(before);
    const shortRate = this.#window(this.#pairAttemptShortRates, sourceHash);
    const dayRate = this.#window(this.#pairAttemptDayRates, sourceHash);
    const outcome = this.#commit(now, () => {
      if (
        shortRate.count(now, 15 * MINUTE_MS) >= PAIR_ATTEMPTS_PER_FIFTEEN_MINUTES ||
        dayRate.count(now, DAY_MS) >= PAIR_ATTEMPTS_PER_DAY
      ) return { kind: 'rate' as const };
      const pair = pairHash === undefined ? undefined : this.#pairings.get(pairHash);
      const valid = pair !== undefined && pair.status === 'issued' && now < pair.expiresAt;
      if (valid && (installationId === undefined || credential === undefined || credentialHash === undefined)) {
        return { kind: 'state' as const };
      }
      if (valid && (this.#installations.has(installationId as CanonicalUuid) || this.#credentials.has(credentialHash as CanonicalSha256))) {
        return { kind: 'state' as const };
      }
      const absoluteExpiresAt = valid ? checkedAdd(now, CREDENTIAL_ABSOLUTE_TTL_MS) : undefined;
      const idleExpiresAt = valid
        ? Math.min(checkedAdd(now, CREDENTIAL_IDLE_TTL_MS), absoluteExpiresAt as number)
        : undefined;
      shortRate.add(now, 15 * MINUTE_MS);
      dayRate.add(now, DAY_MS);
      this.#installWindow(this.#pairAttemptShortRates, sourceHash, shortRate);
      this.#installWindow(this.#pairAttemptDayRates, sourceHash, dayRate);
      if (!valid) return { kind: 'invalid' as const };
      pair.status = 'consumed';
      pair.consumedAt = now;
      const credentialRow: CredentialRow = {
        hash: credentialHash as CanonicalSha256,
        installationId: installationId as CanonicalUuid,
        version: 1,
        issuedAt: now,
        absoluteExpiresAt: absoluteExpiresAt as number,
        status: 'current',
        lastUsedAt: now,
        idleExpiresAt: idleExpiresAt as number
      };
      this.#credentials.set(credentialRow.hash, credentialRow);
      this.#installations.set(installationId as CanonicalUuid, {
        id: installationId as CanonicalUuid,
        issuedAt: now,
        absoluteExpiresAt: absoluteExpiresAt as number,
        status: 'active',
        tombstoneVersion: 1,
        currentCredentialHash: credentialRow.hash,
        currentCredentialVersion: 1,
        sessionEpoch: 0,
        audioWindow: new RollingAmountWindow(),
        grantWindow: new RollingWindow()
      });
      return {
        kind: 'ok' as const,
        absoluteExpiresAt: absoluteExpiresAt as number,
        idleExpiresAt: idleExpiresAt as number
      };
    });
    if (outcome.kind === 'rate') fail('rate-limited');
    if (outcome.kind === 'state') fail('state-unavailable');
    if (outcome.kind === 'invalid') fail('invalid-pairing');
    return freeze({
      installationId: installationId as CanonicalUuid,
      credential: credential as CanonicalToken,
      credentialVersion: 1 as const,
      idleExpiresAt: outcome.idleExpiresAt,
      absoluteExpiresAt: outcome.absoluteExpiresAt
    });
  }

  #authenticatePlan(token: unknown, now: number): AuthenticationPlan | undefined {
    let hash: CanonicalSha256;
    try { hash = hashCredential(token); } catch { return undefined; }
    const credential = this.#credentials.get(hash);
    if (credential === undefined || !this.#credentialActive(credential, now)) return undefined;
    const installation = this.#installations.get(credential.installationId);
    if (installation === undefined || !this.#installationActive(installation, now)) return undefined;
    const pending = credential.status === 'pending';
    if (pending) {
      if (
        installation.pendingCredentialHash !== hash || installation.pendingCredentialVersion !== credential.version ||
        installation.pendingExpiresAt === undefined || now >= installation.pendingExpiresAt
      ) return undefined;
    } else if (
      credential.status !== 'current' || installation.currentCredentialHash !== hash ||
      installation.currentCredentialVersion !== credential.version
    ) return undefined;
    return {
      credential,
      installation,
      pending,
      idleExpiresAt: Math.min(checkedAdd(now, CREDENTIAL_IDLE_TTL_MS), installation.absoluteExpiresAt)
    };
  }

  #commitAuthentication(plan: AuthenticationPlan, now: number): CredentialAuthentication {
    if (plan.pending) {
      const current = this.#credentials.get(plan.installation.currentCredentialHash);
      if (current === undefined || current.status !== 'current') fail('invalid-credential');
      const activeSession = plan.installation.activeSessionId === undefined
        ? undefined : this.#sessions.get(plan.installation.activeSessionId);
      const endsPriorSession = activeSession !== undefined &&
        (activeSession.status === 'opening' || activeSession.status === 'active') &&
        activeSession.credentialVersion !== plan.credential.version;
      const endedLeaseVersion = endsPriorSession
        ? checkedIncrement(activeSession.leaseVersion, 'state-unavailable')
        : undefined;
      current.status = 'retired';
      plan.credential.status = 'current';
      delete plan.credential.pendingExpiresAt;
      plan.installation.currentCredentialHash = plan.credential.hash;
      plan.installation.currentCredentialVersion = plan.credential.version;
      delete plan.installation.pendingCredentialHash;
      delete plan.installation.pendingCredentialVersion;
      delete plan.installation.pendingExpiresAt;
      if (endsPriorSession) {
        activeSession.status = 'ended';
        activeSession.leaseVersion = endedLeaseVersion as number;
        activeSession.leaseExpiresAt = now;
        this.#deleteSessionGrants(activeSession);
        delete plan.installation.activeSessionId;
      }
    }
    plan.credential.lastUsedAt = now;
    plan.credential.idleExpiresAt = plan.idleExpiresAt;
    return freeze({
      installationId: plan.installation.id,
      credentialVersion: plan.credential.version,
      authenticatedAt: now,
      idleExpiresAt: plan.idleExpiresAt,
      absoluteExpiresAt: plan.installation.absoluteExpiresAt,
      promoted: plan.pending
    });
  }

  async authenticateCredential(value: AuthenticateCredentialInput): Promise<CredentialAuthentication> {
    this.#entry();
    const input = exactDataObject(value, ['credential']);
    const now = this.#context();
    const result = this.#commit(now, () => {
      const plan = this.#authenticatePlan(input.credential, now);
      return plan === undefined || plan.pending ? undefined : this.#commitAuthentication(plan, now);
    });
    if (result === undefined) fail('invalid-credential');
    return result;
  }

  async beginCredentialRotation(value: BeginCredentialRotationInput): Promise<PendingCredentialResult> {
    this.#entry();
    const input = exactDataObject(value, ['credential']);
    const before = this.#context();
    const preflight = this.#authenticatePlan(input.credential, before);
    if (preflight === undefined || preflight.pending) fail('invalid-credential');
    if (
      preflight.installation.pendingCredentialHash !== undefined &&
      preflight.installation.pendingExpiresAt !== undefined &&
      before < preflight.installation.pendingExpiresAt
    ) fail('credential-conflict');
    const pendingCredential = this.#candidate(
      this.#tokens.credential,
      assertCanonical256BitToken,
      (token) => this.#credentials.has(hashCredential(token))
    );
    const pendingHash = hashCredential(pendingCredential);
    const now = this.#context(before);
    const result = this.#commit(now, () => {
      const current = this.#authenticatePlan(input.credential, now);
      if (current === undefined || current.pending) return undefined;
      const installation = current.installation;
      const existingPending = installation.pendingCredentialHash === undefined
        ? undefined : this.#credentials.get(installation.pendingCredentialHash);
      if (existingPending !== undefined && installation.pendingExpiresAt !== undefined && now < installation.pendingExpiresAt) {
        fail('credential-conflict');
      }
      if (this.#credentials.has(pendingHash)) fail('state-unavailable');
      const version = checkedIncrement(installation.currentCredentialVersion, 'invalid-credential');
      const pendingExpiresAt = Math.min(checkedAdd(now, PENDING_CREDENTIAL_TTL_MS), installation.absoluteExpiresAt);
      if (existingPending !== undefined && existingPending.status === 'pending') existingPending.status = 'expired';
      const row: CredentialRow = {
        hash: pendingHash,
        installationId: installation.id,
        version,
        issuedAt: now,
        absoluteExpiresAt: installation.absoluteExpiresAt,
        status: 'pending',
        lastUsedAt: now,
        idleExpiresAt: pendingExpiresAt,
        pendingExpiresAt
      };
      this.#credentials.set(pendingHash, row);
      installation.pendingCredentialHash = pendingHash;
      installation.pendingCredentialVersion = version;
      installation.pendingExpiresAt = pendingExpiresAt;
      return freeze({
        installationId: installation.id,
        pendingCredential,
        pendingCredentialVersion: version,
        pendingExpiresAt,
        absoluteExpiresAt: installation.absoluteExpiresAt
      });
    });
    if (result === undefined) fail('invalid-credential');
    return result;
  }

  async promoteCredential(value: PromoteCredentialInput): Promise<CredentialPromotionResult> {
    this.#entry();
    const input = exactDataObject(value, ['pendingCredential']);
    const now = this.#context();
    const result = this.#commit(now, () => {
      const plan = this.#authenticatePlan(input.pendingCredential, now);
      if (plan === undefined) return undefined;
      if (!plan.pending) {
        if (plan.credential.version <= 1) return undefined;
        plan.credential.lastUsedAt = now;
        plan.credential.idleExpiresAt = plan.idleExpiresAt;
        return freeze({
          installationId: plan.installation.id,
          credentialVersion: plan.credential.version,
          tombstoneVersion: plan.installation.tombstoneVersion,
          status: 'already-promoted' as const,
          confirmedAt: now,
          idleExpiresAt: plan.idleExpiresAt,
          absoluteExpiresAt: plan.installation.absoluteExpiresAt
        });
      }
      const activeSession = plan.installation.activeSessionId === undefined
        ? undefined : this.#sessions.get(plan.installation.activeSessionId);
      const invalidatedSession = activeSession !== undefined &&
        (activeSession.status === 'opening' || activeSession.status === 'active') &&
        activeSession.credentialVersion !== plan.credential.version
        ? freeze({
            installationId: activeSession.installationId,
            sessionId: activeSession.id,
            sessionEpoch: activeSession.epoch
          })
        : undefined;
      const authentication = this.#commitAuthentication(plan, now);
      return freeze({
        installationId: authentication.installationId,
        credentialVersion: authentication.credentialVersion,
        tombstoneVersion: plan.installation.tombstoneVersion,
        status: 'promoted' as const,
        confirmedAt: now,
        idleExpiresAt: authentication.idleExpiresAt,
        absoluteExpiresAt: authentication.absoluteExpiresAt,
        ...(invalidatedSession === undefined ? {} : { invalidatedSession })
      });
    });
    if (result === undefined) fail('invalid-credential');
    return result;
  }

  async revokeCurrentInstallation(value: RevokeCurrentInstallationInput): Promise<InstallationRevocationResult> {
    this.#entry();
    const input = exactDataObject(value, ['credential']);
    const now = this.#context();
    const result = this.#commit(now, () => {
      let hash: CanonicalSha256;
      try { hash = hashCredential(input.credential); } catch { return undefined; }
      const credential = this.#credentials.get(hash);
      const installation = credential === undefined ? undefined : this.#installations.get(credential.installationId);
      if (
        credential !== undefined && installation !== undefined &&
        credential.status === 'revoked' && installation.status === 'revoked' &&
        installation.currentCredentialHash === credential.hash &&
        installation.currentCredentialVersion === credential.version &&
        installation.revokedAt !== undefined
      ) {
        const revokedSession = this.#revokedSessionIdentities.get(installation.id);
        const invalidatedSession = revokedSession === undefined
          ? undefined
          : freeze({
              installationId: installation.id,
              sessionId: revokedSession.sessionId,
              sessionEpoch: revokedSession.sessionEpoch
            });
        return freeze({
          installationId: installation.id,
          credentialVersion: installation.currentCredentialVersion,
          tombstoneVersion: installation.tombstoneVersion,
          status: 'already-revoked' as const,
          revokedAt: installation.revokedAt,
          ...(invalidatedSession === undefined ? {} : { invalidatedSession })
        });
      }
      const plan = this.#authenticatePlan(input.credential, now);
      if (plan === undefined || plan.pending) return undefined;
      const pending = plan.installation.pendingCredentialHash === undefined
        ? undefined : this.#credentials.get(plan.installation.pendingCredentialHash);
      const session = plan.installation.activeSessionId === undefined
        ? undefined : this.#sessions.get(plan.installation.activeSessionId);
      const nextTombstone = checkedIncrement(plan.installation.tombstoneVersion, 'state-unavailable');
      const invalidatedSession = session !== undefined &&
        (session.status === 'opening' || session.status === 'active')
        ? freeze({ installationId: session.installationId, sessionId: session.id, sessionEpoch: session.epoch })
        : undefined;
      if (invalidatedSession !== undefined) {
        this.#revokedSessionIdentities.set(plan.installation.id, {
          sessionId: invalidatedSession.sessionId,
          sessionEpoch: invalidatedSession.sessionEpoch
        });
      }
      plan.installation.tombstoneVersion = nextTombstone;
      plan.installation.status = 'revoked';
      plan.installation.revokedAt = now;
      plan.credential.status = 'revoked';
      if (pending !== undefined) pending.status = 'revoked';
      if (session !== undefined) {
        session.status = 'revoked';
        this.#deleteSessionGrants(session);
      }
      delete plan.installation.activeSessionId;
      return freeze({
        installationId: plan.installation.id,
        credentialVersion: plan.installation.currentCredentialVersion,
        tombstoneVersion: plan.installation.tombstoneVersion,
        status: 'revoked' as const,
        revokedAt: now,
        ...(invalidatedSession === undefined ? {} : { invalidatedSession })
      });
    });
    if (result === undefined) fail('invalid-credential');
    return result;
  }

  async revokeInstallation(value: RevokeInstallationInput): Promise<InstallationMutationResult> {
    this.#entry();
    const input = exactDataObject(value, ['installationId']);
    const installationId = assertCanonicalUuid(input.installationId);
    const now = this.#context();
    const result = this.#commit(now, () => {
      const row = this.#installations.get(installationId);
      if (row === undefined || row.status !== 'active') return undefined;
      const nextTombstone = checkedIncrement(row.tombstoneVersion, 'state-unavailable');
      const current = this.#credentials.get(row.currentCredentialHash);
      const pending = row.pendingCredentialHash === undefined ? undefined : this.#credentials.get(row.pendingCredentialHash);
      const session = row.activeSessionId === undefined ? undefined : this.#sessions.get(row.activeSessionId);
      const invalidatedSession = session !== undefined &&
        (session.status === 'opening' || session.status === 'active')
        ? freeze({ installationId: session.installationId, sessionId: session.id, sessionEpoch: session.epoch })
        : undefined;
      if (invalidatedSession !== undefined) {
        this.#revokedSessionIdentities.set(row.id, {
          sessionId: invalidatedSession.sessionId,
          sessionEpoch: invalidatedSession.sessionEpoch
        });
      }
      row.tombstoneVersion = nextTombstone;
      row.status = 'revoked';
      row.revokedAt = now;
      if (current !== undefined) current.status = 'revoked';
      if (pending !== undefined) pending.status = 'revoked';
      if (session !== undefined) {
        session.status = 'revoked';
        this.#deleteSessionGrants(session);
      }
      delete row.activeSessionId;
      return freeze({
        installationId: row.id,
        credentialVersion: row.currentCredentialVersion,
        tombstoneVersion: row.tombstoneVersion,
        ...(invalidatedSession === undefined ? {} : { invalidatedSession })
      });
    });
    if (!result) fail('invalid-credential');
    return result;
  }

  async issueSessionTicket(value: TicketOperationInput): Promise<SessionTicketResult> {
    this.#entry();
    const input = exactDataObject(value, ['credential', 'environment', 'audience', 'intent'], [], 'invalid-ticket');
    const binding = parseBinding(input, 'invalid-ticket');
    const before = this.#context();
    const preflightAuth = this.#authenticatePlan(input.credential, before);
    const eligible = this.#bindingMatches(binding) && preflightAuth !== undefined && !preflightAuth.pending;
    const ticket = eligible
      ? this.#candidate(this.#tokens.ticket, assertCanonical256BitToken, (token) => this.#tickets.has(hashTicket(token)))
      : undefined;
    const ticketHash = ticket === undefined ? undefined : hashTicket(ticket);
    const now = this.#context(before);
    const result = this.#commit(now, () => {
      if (!this.#bindingMatches(binding)) return undefined;
      const authentication = this.#authenticatePlan(input.credential, now);
      if (
        authentication === undefined || authentication.pending ||
        ticket === undefined || ticketHash === undefined
      ) return undefined;
      const minute = this.#window(this.#ticketMinuteRates, authentication.installation.id);
      const hour = this.#window(this.#ticketHourRates, authentication.installation.id);
      if (minute.count(now, MINUTE_MS) >= TICKETS_PER_MINUTE || hour.count(now, HOUR_MS) >= TICKETS_PER_HOUR) {
        return undefined;
      }
      if (this.#tickets.has(ticketHash)) fail('state-unavailable');
      const expiresAt = checkedAdd(now, TICKET_TTL_MS);
      const authResult = this.#commitAuthentication(authentication, now);
      minute.add(now, MINUTE_MS);
      hour.add(now, HOUR_MS);
      this.#installWindow(this.#ticketMinuteRates, authResult.installationId, minute);
      this.#installWindow(this.#ticketHourRates, authResult.installationId, hour);
      this.#tickets.set(ticketHash, {
        hash: ticketHash,
        installationId: authResult.installationId,
        tombstoneVersion: authentication.installation.tombstoneVersion,
        credentialVersion: authResult.credentialVersion,
        binding,
        issuedAt: now,
        expiresAt,
        status: 'issued'
      });
      return freeze({
        ticket,
        installationId: authResult.installationId,
        credentialVersion: authResult.credentialVersion,
        environment: binding.environment,
        audience: binding.audience,
        intent: 'new' as const,
        issuedAt: now,
        expiresAt
      });
    });
    if (result === undefined) fail('invalid-ticket');
    return result;
  }

  async consumeSessionTicket(value: ConsumeTicketInput): Promise<SessionLease> {
    this.#entry();
    const input = exactDataObject(value, ['ticket', 'environment', 'audience', 'intent'], [], 'invalid-ticket');
    const binding = parseBinding(input, 'invalid-ticket');
    let ticketHash: CanonicalSha256 | undefined;
    try { ticketHash = hashTicket(input.ticket); } catch { ticketHash = undefined; }
    const before = this.#context();
    const preflightTicket = ticketHash === undefined ? undefined : this.#tickets.get(ticketHash);
    const preflightEligible = this.#bindingMatches(binding) && preflightTicket !== undefined &&
      preflightTicket.status === 'issued' && before < preflightTicket.expiresAt;
    const sessionId = preflightEligible
      ? this.#candidate(this.#ids.sessionId, assertCanonicalUuid, (id) => this.#sessions.has(id))
      : undefined;
    const now = this.#context(before);
    const result = this.#commit(now, () => {
      if (!this.#bindingMatches(binding) || ticketHash === undefined || sessionId === undefined) return undefined;
      const ticket = this.#tickets.get(ticketHash);
      if (
        ticket === undefined || ticket.status !== 'issued' || now >= ticket.expiresAt ||
        !this.#bindingMatches(ticket.binding) || !sameAudience(ticket.binding.audience, binding.audience) ||
        ticket.binding.environment !== binding.environment || ticket.binding.intent !== binding.intent
      ) return undefined;
      const installation = this.#installations.get(ticket.installationId);
      if (
        installation === undefined || !this.#installationActive(installation, now) ||
        installation.tombstoneVersion !== ticket.tombstoneVersion ||
        installation.currentCredentialVersion !== ticket.credentialVersion
      ) return undefined;
      const oldSession = installation.activeSessionId === undefined ? undefined : this.#sessions.get(installation.activeSessionId);
      const oldExpired = oldSession !== undefined &&
        (oldSession.status === 'ended' || oldSession.status === 'expired' || oldSession.status === 'revoked' || now >= oldSession.leaseExpiresAt);
      if (oldSession !== undefined && !oldExpired) return undefined;
      const reconnect = installation.sessionEpoch > 0;
      const reconnectMinute = this.#window(this.#reconnectMinuteRates, installation.id);
      const reconnectTen = this.#window(this.#reconnectTenMinuteRates, installation.id);
      if (reconnect && (
        reconnectMinute.count(now, MINUTE_MS) >= RECONNECTS_PER_MINUTE ||
        reconnectTen.count(now, TEN_MINUTES_MS) >= RECONNECTS_PER_TEN_MINUTES
      )) return undefined;
      if (this.#sessions.has(sessionId)) fail('state-unavailable');
      const epoch = checkedIncrement(installation.sessionEpoch, 'invalid-ticket');
      const leaseExpiresAt = checkedAdd(now, OPENING_LEASE_MS);
      if (oldSession !== undefined && oldExpired) oldSession.status = 'expired';
      if (reconnect) {
        reconnectMinute.add(now, MINUTE_MS);
        reconnectTen.add(now, TEN_MINUTES_MS);
        this.#installWindow(this.#reconnectMinuteRates, installation.id, reconnectMinute);
        this.#installWindow(this.#reconnectTenMinuteRates, installation.id, reconnectTen);
      }
      ticket.status = 'consumed';
      ticket.consumedAt = now;
      const session: SessionRow = {
        installationId: installation.id,
        id: sessionId,
        epoch,
        credentialVersion: ticket.credentialVersion,
        tombstoneVersion: installation.tombstoneVersion,
        status: 'opening',
        leaseVersion: 1,
        leaseExpiresAt,
        lastHeartbeatAt: now,
        audioReservedOriginalSamples: 0,
        audioWindow: new RollingAmountWindow(),
        grantWindow: new RollingWindow(),
        grantIds: new Set<CanonicalUuid>(),
        generatedCount: 0,
        attemptCount: 0,
        generatedWindow: new RollingWindow(),
        attemptWindow: new RollingWindow()
      };
      this.#sessions.set(sessionId, session);
      installation.sessionEpoch = epoch;
      installation.activeSessionId = sessionId;
      return this.#lease(session);
    });
    if (result === undefined) fail('invalid-ticket');
    return result;
  }

  async activateSession(value: ActivateSessionInput): Promise<SessionLease> {
    this.#entry();
    const input = exactDataObject(value, ['lease', 'message']);
    const lease = parseLease(input.lease);
    const messageInput = exactDataObject(input.message, ['type', 'protocolVersion']);
    const message: SessionStartMessage = { type: messageInput.type as 'session.start', protocolVersion: messageInput.protocolVersion as 1 };
    const now = this.#context();
    const result = this.#commit(now, () => {
      if (message.type !== 'session.start' || message.protocolVersion !== 1) return undefined;
      const row = this.#sessions.get(lease.sessionId);
      const installation = this.#installations.get(lease.installationId);
      if (
        row === undefined || installation === undefined || row.status !== 'opening' ||
        !this.#leaseMatches(lease, row) || now >= row.leaseExpiresAt ||
        !this.#installationActive(installation, now) || installation.activeSessionId !== row.id ||
        installation.tombstoneVersion !== row.tombstoneVersion ||
        installation.currentCredentialVersion !== row.credentialVersion
      ) return undefined;
      const version = checkedIncrement(row.leaseVersion, 'stale-lease');
      const expiresAt = checkedAdd(now, ACTIVE_LEASE_MS);
      row.status = 'active';
      row.leaseVersion = version;
      row.leaseExpiresAt = expiresAt;
      row.lastHeartbeatAt = now;
      return this.#lease(row);
    });
    if (result === undefined) fail('stale-lease');
    return result;
  }

  async heartbeatSession(value: SessionLeaseInput): Promise<SessionLease> {
    this.#entry();
    const input = exactDataObject(value, ['lease']);
    const lease = parseLease(input.lease);
    const now = this.#context();
    const result = this.#commit(now, () => {
      const row = this.#sessions.get(lease.sessionId);
      const installation = this.#installations.get(lease.installationId);
      if (
        row === undefined || installation === undefined || !this.#sessionActive(row, installation, now) ||
        !this.#leaseMatches(lease, row)
      ) return undefined;
      const version = checkedIncrement(row.leaseVersion, 'stale-lease');
      const expiresAt = checkedAdd(now, ACTIVE_LEASE_MS);
      row.leaseVersion = version;
      row.leaseExpiresAt = expiresAt;
      row.lastHeartbeatAt = now;
      return this.#lease(row);
    });
    if (result === undefined) fail('stale-lease');
    return result;
  }

  async endSession(value: SessionLeaseInput): Promise<void> {
    this.#entry();
    const input = exactDataObject(value, ['lease']);
    const lease = parseLease(input.lease);
    const now = this.#context();
    const result = this.#commit(now, () => {
      const row = this.#sessions.get(lease.sessionId);
      const installation = this.#installations.get(lease.installationId);
      if (
        row === undefined || installation === undefined ||
        (row.status !== 'opening' && row.status !== 'active') || now >= row.leaseExpiresAt ||
        !this.#leaseMatches(lease, row) || installation.activeSessionId !== row.id ||
        installation.tombstoneVersion !== row.tombstoneVersion ||
        installation.currentCredentialVersion !== row.credentialVersion
      ) return false;
      const leaseVersion = checkedIncrement(row.leaseVersion, 'stale-lease');
      row.status = 'ended';
      row.leaseVersion = leaseVersion;
      row.leaseExpiresAt = now;
      this.#deleteSessionGrants(row);
      delete installation.activeSessionId;
      return true;
    });
    if (!result) fail('stale-lease');
  }

  async reserveAudio(value: ReserveAudioInput): Promise<AudioGrant> {
    this.#entry();
    const input = exactDataObject(value, [
      'lease', 'utteranceId', 'fromOriginalSampleOffset', 'originalSamples'
    ]);
    const lease = parseLease(input.lease);
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
    const before = this.#context();
    const grantId = this.#candidate(this.#ids.grantId, assertCanonicalUuid, (id) => this.#grants.has(id));
    const issuedAt = this.#context(before);
    const result = this.#commit(issuedAt, () => {
      const row = this.#sessions.get(lease.sessionId);
      const installation = this.#installations.get(lease.installationId);
      if (
        row === undefined || installation === undefined || !this.#sessionActive(row, installation, issuedAt) ||
        !this.#leaseMatches(lease, row)
      ) return undefined;
      this.#cleanupSessionGrants(row, issuedAt);
      if (
        row.grantWindow.count(issuedAt, AUDIO_RESERVATION_WINDOW_MS) >= MAX_AUDIO_GRANTS_PER_WINDOW ||
        installation.grantWindow.count(issuedAt, AUDIO_RESERVATION_WINDOW_MS) >= MAX_AUDIO_GRANTS_PER_WINDOW
      ) fail('quota-exceeded');
      const sessionWindowTotal = checkedAdd(
        row.audioWindow.amount(issuedAt, AUDIO_RESERVATION_WINDOW_MS),
        input.originalSamples as number,
        'quota-exceeded'
      );
      const installationWindowTotal = checkedAdd(
        installation.audioWindow.amount(issuedAt, AUDIO_RESERVATION_WINDOW_MS),
        input.originalSamples as number,
        'quota-exceeded'
      );
      if (
        sessionWindowTotal > MAX_AUDIO_SAMPLES_PER_WINDOW ||
        installationWindowTotal > MAX_AUDIO_SAMPLES_PER_WINDOW
      ) fail('quota-exceeded');
      const total = checkedAdd(row.audioReservedOriginalSamples, input.originalSamples as number, 'quota-exceeded');
      const expiresAt = checkedAdd(issuedAt, AUDIO_GRANT_TTL_MS);
      if (this.#grants.has(grantId)) fail('state-unavailable');
      const grant: GrantRow = {
        id: grantId,
        utteranceId,
        installationId: row.installationId,
        sessionId: row.id,
        sessionEpoch: row.epoch,
        tombstoneVersion: row.tombstoneVersion,
        sessionLeaseVersion: row.leaseVersion,
        issuedAt,
        expiresAt,
        fromOriginalSampleOffset: input.fromOriginalSampleOffset as number,
        throughOriginalSampleOffset,
        reservedOriginalSamples: input.originalSamples as number,
      };
      row.audioWindow.add(issuedAt, AUDIO_RESERVATION_WINDOW_MS, input.originalSamples as number);
      installation.audioWindow.add(issuedAt, AUDIO_RESERVATION_WINDOW_MS, input.originalSamples as number);
      row.grantWindow.add(issuedAt, AUDIO_RESERVATION_WINDOW_MS);
      installation.grantWindow.add(issuedAt, AUDIO_RESERVATION_WINDOW_MS);
      row.audioReservedOriginalSamples = total;
      this.#grants.set(grantId, grant);
      row.grantIds.add(grantId);
      return this.#grant(grant);
    });
    if (result === undefined) fail('stale-lease');
    const handoffNow = this.#context(issuedAt);
    const row = this.#sessions.get(lease.sessionId);
    const installation = this.#installations.get(lease.installationId);
    if (
      row === undefined || installation === undefined ||
      !this.#sessionActive(row, installation, handoffNow) ||
      !this.#leaseMatches(lease, row)
    ) fail('stale-lease');
    if (result.expiresAt - handoffNow < MIN_AUDIO_GRANT_HANDOFF_MS) fail('state-unavailable');
    return result;
  }

  #parseGeneration(value: AuthorizeGenerationInput): {
    readonly lease: SessionLease;
    readonly utteranceId: CanonicalUuid;
    readonly acceptedFinalRevision: number;
    readonly selectedTargetLanguage: string;
    readonly gatePolicyVersion: string;
    readonly transcriptHash: CanonicalSha256;
  } {
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
      lease: parseLease(input.lease),
      utteranceId: assertCanonicalUuid(input.utteranceId),
      acceptedFinalRevision: input.acceptedFinalRevision,
      selectedTargetLanguage: input.selectedTargetLanguage,
      gatePolicyVersion: input.gatePolicyVersion,
      transcriptHash: assertCanonicalSha256(input.transcriptHash)
    };
  }

  async authorizeGeneration(value: AuthorizeGenerationInput): Promise<GenerationAuthorizationResult> {
    this.#entry();
    const input = this.#parseGeneration(value);
    const authorizationId = hashCorrelationKey(JSON.stringify([
      input.lease.installationId, input.lease.sessionId, input.lease.sessionEpoch,
      input.utteranceId, input.acceptedFinalRevision, input.selectedTargetLanguage,
      input.gatePolicyVersion, input.transcriptHash
    ]));
    const before = this.#context();
    const preflight = this.#generations.get(authorizationId);
    const needsClaim = preflight === undefined ||
      ((preflight.status === 'claimed' && before >= preflight.leaseExpiresAt) ||
        (preflight.status === 'released' && !preflight.startedConsumed));
    const claimId = needsClaim
      ? this.#candidate(this.#ids.generationClaimId, assertCanonicalUuid, (id) => this.#generationClaims.has(id))
      : undefined;
    const now = this.#context(before);
    const result = this.#commit(now, () => {
      const session = this.#sessions.get(input.lease.sessionId);
      const installation = this.#installations.get(input.lease.installationId);
      if (
        session === undefined || installation === undefined || !this.#sessionActive(session, installation, now) ||
        !this.#leaseMatches(input.lease, session)
      ) return undefined;
      const existing = this.#generations.get(authorizationId);
      if (existing !== undefined) {
        if (existing.status === 'completed') {
          return freeze({ status: 'duplicate-completed' as const, claim: this.#claim(existing) });
        }
        if (existing.status === 'started' || (existing.status === 'released' && existing.startedConsumed)) {
          return freeze({ status: 'duplicate-consumed' as const, claim: this.#claim(existing) });
        }
        if (existing.status === 'claimed' && now < existing.leaseExpiresAt) {
          return freeze({ status: 'duplicate-in-flight' as const, claim: this.#claim(existing) });
        }
      }
      if (claimId === undefined || this.#generationClaims.has(claimId)) fail('state-unavailable');
      const leaseExpiresAt = checkedAdd(now, OPENING_LEASE_MS);
      if (existing === undefined) {
        if (
          session.generatedWindow.count(now, MINUTE_MS) >= GENERATIONS_PER_MINUTE ||
          session.generatedCount >= GENERATIONS_PER_SESSION
        ) fail(session.generatedCount >= GENERATIONS_PER_SESSION ? 'quota-exceeded' : 'rate-limited');
        const generatedCount = checkedIncrement(session.generatedCount, 'quota-exceeded');
        const row: GenerationRow = {
          authorizationId,
          installationId: session.installationId,
          sessionId: session.id,
          sessionEpoch: session.epoch,
          tombstoneVersion: session.tombstoneVersion,
          claimId,
          claimVersion: 1,
          leaseVersion: 1,
          leaseExpiresAt,
          status: 'claimed',
          startedConsumed: false,
          authorizedAt: now
        };
        session.generatedWindow.add(now, MINUTE_MS);
        session.generatedCount = generatedCount;
        this.#generations.set(authorizationId, row);
        this.#generationClaims.set(claimId, row);
        return freeze({ status: 'acquired' as const, claim: this.#claim(row) });
      }
      if (existing.startedConsumed) {
        return freeze({ status: 'duplicate-consumed' as const, claim: this.#claim(existing) });
      }
      const claimVersion = checkedIncrement(existing.claimVersion, 'generation-rejected');
      this.#generationClaims.delete(existing.claimId);
      existing.claimId = claimId;
      existing.claimVersion = claimVersion;
      existing.leaseVersion = 1;
      existing.leaseExpiresAt = leaseExpiresAt;
      existing.status = 'claimed';
      delete existing.releasedFromClaimVersion;
      delete existing.releasedFromLeaseVersion;
      delete existing.releasedFromLeaseExpiresAt;
      this.#generationClaims.set(claimId, existing);
      return freeze({ status: 'acquired' as const, claim: this.#claim(existing) });
    });
    if (result === undefined) fail('generation-rejected');
    return result;
  }

  async providerStart(value: GenerationClaimInput): Promise<GenerationProviderStartResult> {
    this.#entry();
    const input = exactDataObject(value, ['claim']);
    const claim = parseClaim(input.claim);
    const now = this.#context();
    const result = this.#commit(now, () => {
      const row = this.#generations.get(claim.authorizationId);
      if (row === undefined || !this.#claimIdentityMatches(claim, row)) return undefined;
      if (row.startedConsumed) {
        return freeze({ status: 'already-consumed' as const, claim: this.#claim(row) });
      }
      if (row.status !== 'claimed' || !this.#claimMatches(claim, row) || now >= row.leaseExpiresAt) return undefined;
      const session = this.#sessions.get(row.sessionId);
      const installation = this.#installations.get(row.installationId);
      if (session === undefined || installation === undefined || !this.#sessionActive(session, installation, now)) return undefined;
      if (session.attemptWindow.count(now, MINUTE_MS) >= ATTEMPTS_PER_MINUTE || session.attemptCount >= ATTEMPTS_PER_SESSION) {
        fail(session.attemptCount >= ATTEMPTS_PER_SESSION ? 'quota-exceeded' : 'rate-limited');
      }
      const attemptCount = checkedIncrement(session.attemptCount, 'quota-exceeded');
      const leaseVersion = checkedIncrement(row.leaseVersion, 'generation-rejected');
      const leaseExpiresAt = checkedAdd(now, ACTIVE_LEASE_MS);
      session.attemptWindow.add(now, MINUTE_MS);
      session.attemptCount = attemptCount;
      row.status = 'started';
      row.startedConsumed = true;
      row.providerStartedAt = now;
      row.leaseVersion = leaseVersion;
      row.leaseExpiresAt = leaseExpiresAt;
      return freeze({ status: 'start-permitted' as const, claim: this.#claim(row) });
    });
    if (result === undefined) fail('generation-rejected');
    return result;
  }

  async heartbeatGeneration(value: GenerationClaimInput): Promise<GenerationClaim> {
    this.#entry();
    const input = exactDataObject(value, ['claim']);
    const claim = parseClaim(input.claim);
    const now = this.#context();
    const result = this.#commit(now, () => {
      const row = this.#generations.get(claim.authorizationId);
      if (row === undefined || row.status !== 'started' || !this.#claimMatches(claim, row) || now >= row.leaseExpiresAt) return undefined;
      const session = this.#sessions.get(row.sessionId);
      const installation = this.#installations.get(row.installationId);
      if (session === undefined || installation === undefined || !this.#sessionActive(session, installation, now)) return undefined;
      const leaseVersion = checkedIncrement(row.leaseVersion, 'generation-rejected');
      const leaseExpiresAt = checkedAdd(now, ACTIVE_LEASE_MS);
      row.leaseVersion = leaseVersion;
      row.leaseExpiresAt = leaseExpiresAt;
      return this.#claim(row);
    });
    if (result === undefined) fail('generation-rejected');
    return result;
  }

  async completeGeneration(value: CompleteGenerationInput): Promise<GenerationClaim> {
    this.#entry();
    const input = exactDataObject(value, ['claim', 'outcome']);
    const claim = parseClaim(input.claim);
    if (input.outcome !== 'completed' && input.outcome !== 'failed') fail('invalid-input');
    const outcome = input.outcome;
    const now = this.#context();
    const result = this.#commit(now, () => {
      const row = this.#generations.get(claim.authorizationId);
      if (row === undefined || row.status !== 'started' || !this.#claimMatches(claim, row) || now >= row.leaseExpiresAt) return undefined;
      const session = this.#sessions.get(row.sessionId);
      const installation = this.#installations.get(row.installationId);
      if (session === undefined || installation === undefined || !this.#sessionActive(session, installation, now)) return undefined;
      const leaseVersion = checkedIncrement(row.leaseVersion, 'generation-rejected');
      row.status = 'completed';
      row.completedAt = now;
      row.completionOutcome = outcome;
      row.leaseVersion = leaseVersion;
      row.leaseExpiresAt = now;
      return this.#claim(row);
    });
    if (result === undefined) fail('generation-rejected');
    return result;
  }

  async releaseGeneration(value: GenerationClaimInput): Promise<GenerationClaim> {
    this.#entry();
    const input = exactDataObject(value, ['claim']);
    const claim = parseClaim(input.claim);
    const now = this.#context();
    const result = this.#commit(now, () => {
      const row = this.#generations.get(claim.authorizationId);
      if (row === undefined) return undefined;
      if (row.status === 'released') {
        if (this.#claimMatches(claim, row) || (!row.startedConsumed && this.#releaseSourceMatches(claim, row))) {
          return this.#claim(row);
        }
        return undefined;
      }
      if ((row.status !== 'claimed' && row.status !== 'started') || !this.#claimMatches(claim, row)) return undefined;
      if (row.status === 'started') {
        if (now >= row.leaseExpiresAt) return undefined;
        const session = this.#sessions.get(row.sessionId);
        const installation = this.#installations.get(row.installationId);
        if (session === undefined || installation === undefined || !this.#sessionActive(session, installation, now)) {
          return undefined;
        }
      }
      const leaseVersion = checkedIncrement(row.leaseVersion, 'generation-rejected');
      if (!row.startedConsumed) {
        row.releasedFromClaimVersion = row.claimVersion;
        row.releasedFromLeaseVersion = row.leaseVersion;
        row.releasedFromLeaseExpiresAt = row.leaseExpiresAt;
      }
      row.status = 'released';
      row.leaseVersion = leaseVersion;
      row.leaseExpiresAt = now;
      return this.#claim(row);
    });
    if (result === undefined) fail('generation-rejected');
    return result;
  }

  #refreshExpiry(now: number): void {
    for (const row of this.#pairings.values()) if (row.status === 'issued' && now >= row.expiresAt) row.status = 'expired';
    for (const installation of this.#installations.values()) {
      if (installation.status === 'active' && now >= installation.absoluteExpiresAt) {
        installation.status = 'expired';
        installation.expiredAt = installation.absoluteExpiresAt;
      }
      if (installation.pendingCredentialHash !== undefined && installation.pendingExpiresAt !== undefined && now >= installation.pendingExpiresAt) {
        const pending = this.#credentials.get(installation.pendingCredentialHash);
        if (pending !== undefined && pending.status === 'pending') pending.status = 'expired';
        delete installation.pendingCredentialHash;
        delete installation.pendingCredentialVersion;
        delete installation.pendingExpiresAt;
      }
      if (installation.activeSessionId !== undefined) {
        const session = this.#sessions.get(installation.activeSessionId);
        if (session === undefined || session.status === 'ended' || session.status === 'revoked' || now >= session.leaseExpiresAt || installation.status !== 'active') {
          if (session !== undefined && session.status !== 'ended' && session.status !== 'revoked') {
            session.status = 'expired';
            this.#deleteSessionGrants(session);
          }
          delete installation.activeSessionId;
        }
      }
    }
    for (const credential of this.#credentials.values()) {
      if ((credential.status === 'current' || credential.status === 'pending') &&
        (now >= credential.absoluteExpiresAt || now >= credential.idleExpiresAt ||
          (credential.pendingExpiresAt !== undefined && now >= credential.pendingExpiresAt))) credential.status = 'expired';
    }
    for (const ticket of this.#tickets.values()) if (ticket.status === 'issued' && now >= ticket.expiresAt) ticket.status = 'expired';
    for (const grant of this.#grants.values()) if (now >= grant.expiresAt) this.#deleteGrant(grant);
    for (const row of this.#generations.values()) {
      if (row.status === 'claimed' && now >= row.leaseExpiresAt) {
        this.#expireGeneration(row, now);
      } else if (row.status === 'started' && now >= row.leaseExpiresAt) {
        this.#expireGeneration(row, now);
      }
    }
  }

  async checkReadiness(signal?: AbortSignal): Promise<void> {
    this.#entry();
    if (
      signal !== undefined &&
      (utilTypes.isProxy(signal) || !(signal instanceof AbortSignal) ||
        Object.getPrototypeOf(signal) !== AbortSignal.prototype)
    ) fail('state-unavailable');
    if (aborted(signal)) fail('state-unavailable');
    const available = this.#external(() => this.#availability.isAvailable());
    if (aborted(signal) || available !== true) fail('state-unavailable');
  }

  async cleanupExpired(value: CleanupInput): Promise<CleanupResult> {
    this.#entry();
    const input = exactDataObject(value, ['limit']);
    if (!positiveSafeInteger(input.limit) || input.limit > 10_000) fail('invalid-input');
    const now = this.#context();
    return this.#commit(now, () => {
      const tables: readonly Map<unknown, unknown>[] = [
        this.#pairings, this.#tickets, this.#credentials, this.#installations,
        this.#sessions, this.#grants, this.#generations, this.#operatorIssueRates,
        this.#pairAttemptShortRates, this.#pairAttemptDayRates, this.#ticketMinuteRates,
        this.#ticketHourRates, this.#reconnectMinuteRates, this.#reconnectTenMinuteRates
      ];
      const securityTables = tables.slice(0, 5);
      const rateTables = tables.slice(5);
      if (this.#cleanupSecurityExhausted && this.#cleanupRateExhausted) {
        this.#cleanupTable = 'security';
        this.#cleanupSecurityEntries = undefined;
        this.#cleanupRateEntries = undefined;
        this.#cleanupSecurityIndex = 0;
        this.#cleanupRateIndex = 0;
        this.#cleanupSecurityExhausted = false;
        this.#cleanupRateExhausted = false;
      }
      this.#cleanupSecurityEntries ??= securityTables.flatMap((table) =>
        [...table.keys()].map((key): CleanupEntry => [table, key])
      );
      this.#cleanupRateEntries ??= rateTables.flatMap((table) =>
        [...table.keys()].map((key): CleanupEntry => [table, key])
      );
      let visited = 0;
      let removed = 0;
      let securityRemoved = 0;
      let rateRemoved = 0;
      while (
        visited < (input.limit as number) &&
        (!this.#cleanupSecurityExhausted || !this.#cleanupRateExhausted)
      ) {
        const securityAvailable = !this.#cleanupSecurityExhausted;
        const rateAvailable = !this.#cleanupRateExhausted;
        if (
          (this.#cleanupTable === 'security' && !securityAvailable) ||
          (this.#cleanupTable === 'rate' && !rateAvailable)
        ) {
          this.#cleanupTable = this.#cleanupTable === 'security' ? 'rate' : 'security';
        }
        const securityEntries = this.#cleanupSecurityEntries;
        const rateEntries = this.#cleanupRateEntries;
        const entries = this.#cleanupTable === 'security' ? securityEntries : rateEntries;
        if (entries === undefined) break;
        const index = this.#cleanupTable === 'security'
          ? this.#cleanupSecurityIndex
          : this.#cleanupRateIndex;
        if (index >= entries.length) {
          if (this.#cleanupTable === 'security') this.#cleanupSecurityExhausted = true;
          else this.#cleanupRateExhausted = true;
          continue;
        }
        const entry = entries[index];
        if (this.#cleanupTable === 'security') this.#cleanupSecurityIndex += 1;
        else this.#cleanupRateIndex += 1;
        if (entry === undefined) break;
        const [table, key] = entry;
        visited += 1;
        const row = table.get(key);
        if (row === undefined) {
          if (
            (this.#cleanupTable === 'security' && this.#cleanupSecurityIndex >= (this.#cleanupSecurityEntries?.length ?? 0)) ||
            (this.#cleanupTable === 'rate' && this.#cleanupRateIndex >= (this.#cleanupRateEntries?.length ?? 0))
          ) {
            if (this.#cleanupTable === 'security') this.#cleanupSecurityExhausted = true;
            else this.#cleanupRateExhausted = true;
          }
          this.#cleanupTable = this.#cleanupTable === 'security' ? 'rate' : 'security';
          continue;
        }
        let removable = false;
        if (table === this.#pairings) {
          const pairing = row as PairingRow;
          if (pairing.status === 'issued' && now >= pairing.expiresAt) pairing.status = 'expired';
          removable = pairing.status !== 'issued';
        } else if (table === this.#tickets) {
          const ticket = row as TicketRow;
          if (ticket.status === 'issued' && now >= ticket.expiresAt) ticket.status = 'expired';
          removable = ticket.status !== 'issued';
        } else if (table === this.#credentials) {
          const credential = row as CredentialRow;
          if (
            (credential.status === 'current' || credential.status === 'pending') &&
            (now >= credential.absoluteExpiresAt || now >= credential.idleExpiresAt ||
              (credential.pendingExpiresAt !== undefined && now >= credential.pendingExpiresAt))
          ) credential.status = 'expired';
          removable = ['expired', 'retired', 'revoked'].includes(credential.status);
          if (removable && credential.status === 'expired') {
            const installation = this.#installations.get(credential.installationId);
            if (installation?.pendingCredentialHash === credential.hash) {
              delete installation.pendingCredentialHash;
              delete installation.pendingCredentialVersion;
              delete installation.pendingExpiresAt;
            }
          }
        } else if (table === this.#installations) {
          const installation = row as InstallationRow;
          if (installation.status === 'active' && now >= installation.absoluteExpiresAt) {
            installation.status = 'expired';
            installation.expiredAt = installation.absoluteExpiresAt;
            const current = this.#credentials.get(installation.currentCredentialHash);
            if (current?.status === 'current') current.status = 'expired';
            const pending = installation.pendingCredentialHash === undefined
              ? undefined : this.#credentials.get(installation.pendingCredentialHash);
            if (pending?.status === 'pending') pending.status = 'expired';
            const session = installation.activeSessionId === undefined
              ? undefined : this.#sessions.get(installation.activeSessionId);
            if (session !== undefined && (session.status === 'opening' || session.status === 'active')) {
              session.status = 'expired';
              this.#deleteSessionGrants(session);
            }
            delete installation.activeSessionId;
          }
          removable = installation.status === 'revoked'
            ? installation.revokedAt !== undefined && now - installation.revokedAt >= REVOCATION_TOMBSTONE_TTL_MS
            : installation.status === 'expired' && installation.expiredAt !== undefined &&
              now - installation.expiredAt >= REVOCATION_TOMBSTONE_TTL_MS;
          if (removable) this.#revokedSessionIdentities.delete(installation.id);
        } else if (table === this.#sessions) {
          const session = row as SessionRow;
          if ((session.status === 'opening' || session.status === 'active') && now >= session.leaseExpiresAt) {
            session.status = 'expired';
            this.#deleteSessionGrants(session);
            const installation = this.#installations.get(session.installationId);
            if (installation?.activeSessionId === session.id) delete installation.activeSessionId;
          }
          removable = ['expired', 'ended', 'revoked'].includes(session.status);
          if (removable) this.#deleteSessionGrants(session);
        }
        else if (table === this.#grants) {
          const grant = row as GrantRow;
          const session = this.#sessions.get(grant.sessionId);
          const installation = this.#installations.get(grant.installationId);
          removable = now >= grant.expiresAt || session === undefined || installation === undefined ||
            !this.#sessionActive(session, installation, now);
          if (removable) session?.grantIds.delete(grant.id);
        } else if (table === this.#generations) {
          const generation = row as GenerationRow;
          if ((generation.status === 'claimed' || generation.status === 'started') && now >= generation.leaseExpiresAt) {
            this.#expireGeneration(generation, now);
          }
          const session = this.#sessions.get(generation.sessionId);
          removable = session === undefined || ['expired', 'ended', 'revoked'].includes(session.status);
          if (removable && this.#generationClaims.get(generation.claimId) === generation) {
            this.#generationClaims.delete(generation.claimId);
          }
        } else {
          const window = row as RollingWindow;
          let period = MINUTE_MS;
          if (table === this.#operatorIssueRates || table === this.#pairAttemptDayRates) period = DAY_MS;
          else if (table === this.#pairAttemptShortRates) period = 15 * MINUTE_MS;
          else if (table === this.#ticketHourRates) period = HOUR_MS;
          else if (table === this.#reconnectTenMinuteRates) period = TEN_MINUTES_MS;
          removable = window.count(now, period) === 0;
        }
        if (removable && table.delete(key)) {
          removed += 1;
          if (
            table === this.#grants || table === this.#generations ||
            table === this.#operatorIssueRates || table === this.#pairAttemptShortRates ||
            table === this.#pairAttemptDayRates || table === this.#ticketMinuteRates ||
            table === this.#ticketHourRates || table === this.#reconnectMinuteRates ||
            table === this.#reconnectTenMinuteRates
          ) rateRemoved += 1;
          else securityRemoved += 1;
        }
        if (
          (this.#cleanupTable === 'security' && this.#cleanupSecurityIndex >= (this.#cleanupSecurityEntries?.length ?? 0)) ||
          (this.#cleanupTable === 'rate' && this.#cleanupRateIndex >= (this.#cleanupRateEntries?.length ?? 0))
        ) {
          if (this.#cleanupTable === 'security') this.#cleanupSecurityExhausted = true;
          else this.#cleanupRateExhausted = true;
        }
        this.#cleanupTable = this.#cleanupTable === 'security' ? 'rate' : 'security';
      }
      return freeze({
        visited,
        removed,
        removedByTable: freeze({ security: securityRemoved, rate: rateRemoved }),
        exhausted: this.#cleanupSecurityExhausted && this.#cleanupRateExhausted
      });
    });
  }

  snapshot(): SecurityStateSnapshot {
    this.#entry();
    const now = this.#context();
    return this.#commit(now, () => {
      this.#refreshExpiry(now);
      const pairings = [...this.#pairings.values()].map((row) => freeze({
        status: row.status,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
        ...(row.consumedAt === undefined ? {} : { consumedAt: row.consumedAt }),
        ...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt })
      }));
      const credentials = [...this.#credentials.values()].map((row) => freeze({
        installationId: row.installationId,
        version: row.version,
        status: row.status,
        issuedAt: row.issuedAt,
        lastUsedAt: row.lastUsedAt,
        idleExpiresAt: row.idleExpiresAt,
        absoluteExpiresAt: row.absoluteExpiresAt,
        ...(row.pendingExpiresAt === undefined ? {} : { pendingExpiresAt: row.pendingExpiresAt })
      }));
      const installations = [...this.#installations.values()].map((row) => {
        const session = row.activeSessionId === undefined ? undefined : this.#sessions.get(row.activeSessionId);
        return freeze({
          installationId: row.id,
          status: row.status,
          credentialVersion: row.currentCredentialVersion,
          ...(row.pendingCredentialVersion === undefined ? {} : { pendingCredentialVersion: row.pendingCredentialVersion }),
          sessionEpoch: row.sessionEpoch,
          tombstoneVersion: row.tombstoneVersion,
          ...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt }),
          ...(row.expiredAt === undefined ? {} : { expiredAt: row.expiredAt }),
          ...(row.activeSessionId === undefined ? {} : { activeSessionId: row.activeSessionId }),
          ...(session === undefined ? {} : {
            activeSessionStatus: session.status,
            sessionLeaseVersion: session.leaseVersion,
            sessionLeaseExpiresAt: session.leaseExpiresAt
          })
        });
      });
      const tickets = [...this.#tickets.values()].map((row) => freeze({
        installationId: row.installationId,
        credentialVersion: row.credentialVersion,
        status: row.status,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
        ...(row.consumedAt === undefined ? {} : { consumedAt: row.consumedAt })
      }));
      const sessions = [...this.#sessions.values()].map((row) => freeze({
        installationId: row.installationId,
        sessionId: row.id,
        sessionEpoch: row.epoch,
        status: row.status,
        leaseVersion: row.leaseVersion,
        leaseExpiresAt: row.leaseExpiresAt,
        audioReservedOriginalSamples: row.audioReservedOriginalSamples,
        generatedCount: row.generatedCount,
        attemptCount: row.attemptCount
      }));
      const generations = [...this.#generations.values()].map((row) => freeze({
        installationId: row.installationId,
        sessionId: row.sessionId,
        sessionEpoch: row.sessionEpoch,
        claimVersion: row.claimVersion,
        leaseVersion: row.leaseVersion,
        status: row.status,
        authorizedAt: row.authorizedAt,
        ...(row.providerStartedAt === undefined ? {} : { providerStartedAt: row.providerStartedAt }),
        ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
        ...(row.completionOutcome === undefined ? {} : { completionOutcome: row.completionOutcome })
      }));
      const grants = [...this.#grants.values()].map((row) => freeze({
        installationId: row.installationId,
        sessionId: row.sessionId,
        sessionEpoch: row.sessionEpoch,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
        fromOriginalSampleOffset: row.fromOriginalSampleOffset,
        throughOriginalSampleOffset: row.throughOriginalSampleOffset,
        reservedOriginalSamples: row.reservedOriginalSamples,
      }));
      return freeze({
        deploymentBoundary: LOCAL_MOCK_ONLY,
        environment: this.environment,
        audience: this.audience,
        pairings: Object.freeze(pairings),
        credentials: Object.freeze(credentials),
        installations: Object.freeze(installations),
        tickets: Object.freeze(tickets),
        sessions: Object.freeze(sessions),
        generations: Object.freeze(generations),
        grants: Object.freeze(grants)
      });
    });
  }
}
