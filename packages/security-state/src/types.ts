import type { CanonicalPairingCode, CanonicalSha256, CanonicalToken, CanonicalUuid } from './crypto.js';

export const LOCAL_MOCK_ONLY = 'LOCAL_MOCK_ONLY' as const;
export const LOCAL_MOCK_ENVIRONMENT = 'local-mock' as const;
export const SECURITY_STATE_DEPLOYMENT_BOUNDARY = LOCAL_MOCK_ONLY;
export const SECURITY_STATE_CAPABILITIES = Object.freeze({
  deploymentBoundary: LOCAL_MOCK_ONLY,
  durableAcrossProcesses: false,
  azureTables: false,
  paidProvidersAllowed: false
} as const);

export const PAIRING_TTL_MS = 1_800_000;
export const CREDENTIAL_IDLE_TTL_MS = 2_592_000_000;
export const CREDENTIAL_ABSOLUTE_TTL_MS = 7_776_000_000;
export const PENDING_CREDENTIAL_TTL_MS = 300_000;
export const TICKET_TTL_MS = 60_000;
export const OPENING_LEASE_MS = 10_000;
export const ACTIVE_LEASE_MS = 35_000;
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const MAX_AUDIO_GRANT_SAMPLES = 8_000;
export const MAX_AUDIO_SAMPLES_PER_WINDOW = 16_000;
export const AUDIO_RESERVATION_WINDOW_MS = 1_000;
export const AUDIO_GRANT_TTL_MS = 1_000;
export const MIN_AUDIO_GRANT_HANDOFF_MS = 500;
export const MAX_AUDIO_GRANTS_PER_WINDOW = 100;
export const REVOCATION_TOMBSTONE_TTL_MS = 2_592_000_000;
export const GENERATIONS_PER_MINUTE = 6;
export const GENERATIONS_PER_SESSION = 60;
export const ATTEMPTS_PER_MINUTE = 12;
export const ATTEMPTS_PER_SESSION = 120;
export const RECONNECTS_PER_MINUTE = 5;
export const RECONNECTS_PER_TEN_MINUTES = 12;
export const COLLISION_RETRY_LIMIT = 8;
/**
 * Backwards wall-clock corrections within this window use the recorded
 * high-water mark as effective "now" for expiry/TTL, replay-window, and
 * rate-limit comparisons and new timestamps, so state cannot un-expire or
 * move a window backwards. Larger corrections fail closed.
 */
export const CLOCK_BACKWARDS_TOLERANCE_MS = 5 * 60_000;

export interface SecurityClock {
  readonly now: () => number;
}

export interface SecurityIdFactory {
  readonly installationId: () => string;
  readonly sessionId: () => string;
  readonly grantId: () => string;
  readonly generationClaimId: () => string;
}

export interface SecurityTokenFactory {
  readonly pairingCode: () => string;
  readonly credential: () => string;
  readonly ticket: () => string;
}

export interface StateAvailability {
  readonly isAvailable: () => boolean;
}

export interface SecurityAudience {
  readonly origin: string;
  readonly path: '/v1/stream';
  readonly protocol: 'palancar.v1';
}

export interface LocalMockSecurityStateOptions {
  readonly deploymentBoundary: typeof LOCAL_MOCK_ONLY;
  readonly environment: typeof LOCAL_MOCK_ENVIRONMENT;
  readonly audience: SecurityAudience;
  readonly generationProvider: 'mock';
  readonly transcriptionProvider: 'mock';
  readonly clock?: SecurityClock;
  readonly ids?: SecurityIdFactory;
  readonly tokens?: SecurityTokenFactory;
  readonly availability?: StateAvailability;
}

export interface LocalMockSecurityStateConfig {
  readonly deploymentBoundary: typeof LOCAL_MOCK_ONLY;
  readonly environment: typeof LOCAL_MOCK_ENVIRONMENT;
  readonly audience: SecurityAudience;
  readonly generationProvider: 'mock';
  readonly transcriptionProvider: 'mock';
  readonly availability?: StateAvailability;
}

export interface TicketBinding {
  readonly environment: string;
  readonly audience: SecurityAudience;
  readonly intent: 'new';
}

declare const hostTrustedOpaqueSource: unique symbol;
/** Branded only by the host adapter after deriving a non-user-controlled rate-limit key. */
export type HostTrustedOpaqueSource = string & { readonly [hostTrustedOpaqueSource]: true };

export interface IssuePairingInput { readonly operatorScope: string; }
export interface RevokePairingInput { readonly pairingHash: CanonicalSha256; }
export interface RedeemPairingInput {
  readonly pairingCode: string;
  readonly trustedSource: HostTrustedOpaqueSource;
}
export interface AuthenticateCredentialInput { readonly credential: string; }
export interface BeginCredentialRotationInput { readonly credential: string; }
export interface PromoteCredentialInput { readonly pendingCredential: string; }
export interface RevokeInstallationInput { readonly installationId: string; }
export interface RevokeCurrentInstallationInput { readonly credential: string; }
export interface TicketOperationInput extends TicketBinding { readonly credential: string; }
export interface ConsumeTicketInput extends TicketBinding { readonly ticket: string; }
export interface SessionStartMessage { readonly type: 'session.start'; readonly protocolVersion: 1; }
export interface ActivateSessionInput { readonly lease: SessionLease; readonly message: SessionStartMessage; }
export interface SessionLeaseInput { readonly lease: SessionLease; }
export interface ReserveAudioInput {
  readonly lease: SessionLease;
  readonly utteranceId: CanonicalUuid;
  readonly fromOriginalSampleOffset: number;
  readonly originalSamples: number;
}
export interface AuthorizeGenerationInput {
  readonly lease: SessionLease;
  readonly decision: 'target';
  readonly utteranceId: string;
  readonly acceptedFinalRevision: number;
  readonly selectedTargetLanguage: string;
  readonly gatePolicyVersion: string;
  readonly transcriptHash: CanonicalSha256;
}
export interface GenerationClaimInput { readonly claim: GenerationClaim; }
export interface CompleteGenerationInput { readonly claim: GenerationClaim; readonly outcome: 'completed' | 'failed'; }
export interface CleanupInput { readonly limit: number; }

export interface PairingIssueResult {
  readonly pairingCode: CanonicalPairingCode;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface PairingRedemptionResult {
  readonly installationId: CanonicalUuid;
  readonly credential: CanonicalToken;
  readonly credentialVersion: 1;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface CredentialAuthentication {
  readonly installationId: CanonicalUuid;
  readonly credentialVersion: number;
  readonly authenticatedAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly promoted: boolean;
}

export interface PendingCredentialResult {
  readonly installationId: CanonicalUuid;
  readonly pendingCredential: CanonicalToken;
  readonly pendingCredentialVersion: number;
  readonly pendingExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface InvalidatedSessionIdentity {
  readonly installationId: CanonicalUuid;
  readonly sessionId: CanonicalUuid;
  readonly sessionEpoch: number;
}

export interface InstallationMutationResult {
  readonly installationId: CanonicalUuid;
  readonly credentialVersion: number;
  readonly tombstoneVersion: number;
  readonly invalidatedSession?: InvalidatedSessionIdentity;
}

export interface CredentialPromotionResult extends InstallationMutationResult {
  readonly status: 'promoted' | 'already-promoted';
  readonly confirmedAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface InstallationRevocationResult extends InstallationMutationResult {
  readonly status: 'revoked' | 'already-revoked';
  readonly revokedAt: number;
}

export interface SessionTicketResult extends TicketBinding {
  readonly ticket: CanonicalToken;
  readonly installationId: CanonicalUuid;
  readonly credentialVersion: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type SessionPhase = 'opening' | 'active';

export interface SessionLease {
  readonly installationId: CanonicalUuid;
  readonly sessionId: CanonicalUuid;
  readonly sessionEpoch: number;
  readonly credentialVersion: number;
  readonly leaseVersion: number;
  readonly phase: SessionPhase;
  readonly leaseExpiresAt: number;
}

export interface AudioGrant {
  readonly grantId: CanonicalUuid;
  readonly utteranceId: CanonicalUuid;
  readonly installationId: CanonicalUuid;
  readonly sessionId: CanonicalUuid;
  readonly sessionEpoch: number;
  readonly sessionLeaseVersion: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Inclusive start in the utterance's original-sample coordinate space. */
  readonly fromOriginalSampleOffset: number;
  /** Exclusive end; the next contiguous range starts at this value. */
  readonly throughOriginalSampleOffset: number;
  readonly reservedOriginalSamples: number;
}

export interface GenerationClaim {
  /** Deterministic durable point-read identity for the canonical correlation tuple. */
  readonly authorizationId: CanonicalSha256;
  readonly claimId: CanonicalUuid;
  readonly installationId: CanonicalUuid;
  readonly sessionId: CanonicalUuid;
  readonly sessionEpoch: number;
  readonly claimVersion: number;
  readonly leaseVersion: number;
  readonly phase: 'claimed' | 'started' | 'completed' | 'released';
  readonly leaseExpiresAt: number;
}

export type GenerationAuthorizationStatus =
  | 'acquired'
  | 'duplicate-in-flight'
  | 'duplicate-consumed'
  | 'duplicate-completed';

export interface GenerationAuthorizationResult {
  readonly status: GenerationAuthorizationStatus;
  readonly claim: GenerationClaim;
}

export type GenerationProviderStartStatus = 'start-permitted' | 'already-consumed';
export interface GenerationProviderStartResult {
  readonly status: GenerationProviderStartStatus;
  readonly claim: GenerationClaim;
}

export type PairingStatus = 'issued' | 'consumed' | 'revoked' | 'expired';
export type CredentialStatus = 'current' | 'pending' | 'retired' | 'revoked' | 'expired';
export type InstallationStatus = 'active' | 'revoked' | 'expired';
export type TicketStatus = 'issued' | 'consumed' | 'expired';
export type SessionStatus = 'opening' | 'active' | 'ended' | 'expired' | 'revoked';
export type GenerationStatus = 'claimed' | 'started' | 'completed' | 'released';

export interface SecurityStateSnapshot {
  readonly deploymentBoundary: typeof LOCAL_MOCK_ONLY;
  readonly environment: string;
  readonly audience: SecurityAudience;
  readonly pairings: readonly Readonly<{
    status: PairingStatus;
    issuedAt: number;
    expiresAt: number;
    consumedAt?: number;
    revokedAt?: number;
  }>[];
  readonly credentials: readonly Readonly<{
    installationId: CanonicalUuid;
    version: number;
    status: CredentialStatus;
    issuedAt: number;
    lastUsedAt: number;
    idleExpiresAt: number;
    absoluteExpiresAt: number;
    pendingExpiresAt?: number;
  }>[];
  readonly installations: readonly Readonly<{
    installationId: CanonicalUuid;
    status: InstallationStatus;
    credentialVersion: number;
    pendingCredentialVersion?: number;
    sessionEpoch: number;
    tombstoneVersion: number;
    revokedAt?: number;
    expiredAt?: number;
    activeSessionId?: CanonicalUuid;
    activeSessionStatus?: SessionStatus;
    sessionLeaseVersion?: number;
    sessionLeaseExpiresAt?: number;
  }>[];
  readonly tickets: readonly Readonly<{
    installationId: CanonicalUuid;
    credentialVersion: number;
    status: TicketStatus;
    issuedAt: number;
    expiresAt: number;
    consumedAt?: number;
  }>[];
  readonly sessions: readonly Readonly<{
    installationId: CanonicalUuid;
    sessionId: CanonicalUuid;
    sessionEpoch: number;
    status: SessionStatus;
    leaseVersion: number;
    leaseExpiresAt: number;
    audioReservedOriginalSamples: number;
    generatedCount: number;
    attemptCount: number;
  }>[];
  readonly generations: readonly Readonly<{
    installationId: CanonicalUuid;
    sessionId: CanonicalUuid;
    sessionEpoch: number;
    claimVersion: number;
    leaseVersion: number;
    status: GenerationStatus;
    authorizedAt: number;
    providerStartedAt?: number;
    completedAt?: number;
    completionOutcome?: 'completed' | 'failed';
  }>[];
  readonly grants: readonly Readonly<{
    installationId: CanonicalUuid;
    sessionId: CanonicalUuid;
    sessionEpoch: number;
    issuedAt: number;
    expiresAt: number;
    fromOriginalSampleOffset: number;
    throughOriginalSampleOffset: number;
    reservedOriginalSamples: number;
  }>[];
}

export interface CleanupResult {
  readonly visited: number;
  readonly removed: number;
  readonly removedByTable: Readonly<{
    readonly security: number;
    readonly rate: number;
  }>;
  readonly exhausted: boolean;
}

export interface SecurityRuntimeStore {
  readonly redeemPairing: (input: RedeemPairingInput) => Promise<PairingRedemptionResult>;
  readonly authenticateCredential: (input: AuthenticateCredentialInput) => Promise<CredentialAuthentication>;
  readonly beginCredentialRotation: (input: BeginCredentialRotationInput) => Promise<PendingCredentialResult>;
  readonly promoteCredential: (input: PromoteCredentialInput) => Promise<CredentialPromotionResult>;
  readonly revokeInstallation: (input: RevokeInstallationInput) => Promise<InstallationMutationResult>;
  readonly revokeCurrentInstallation: (
    input: RevokeCurrentInstallationInput,
  ) => Promise<InstallationRevocationResult>;
  readonly issueSessionTicket: (input: TicketOperationInput) => Promise<SessionTicketResult>;
  readonly consumeSessionTicket: (input: ConsumeTicketInput) => Promise<SessionLease>;
  readonly activateSession: (input: ActivateSessionInput) => Promise<SessionLease>;
  readonly heartbeatSession: (input: SessionLeaseInput) => Promise<SessionLease>;
  readonly endSession: (input: SessionLeaseInput) => Promise<void>;
  readonly reserveAudio: (input: ReserveAudioInput) => Promise<AudioGrant>;
  readonly authorizeGeneration: (input: AuthorizeGenerationInput) => Promise<GenerationAuthorizationResult>;
  readonly providerStart: (input: GenerationClaimInput) => Promise<GenerationProviderStartResult>;
  readonly heartbeatGeneration: (input: GenerationClaimInput) => Promise<GenerationClaim>;
  readonly completeGeneration: (input: CompleteGenerationInput) => Promise<GenerationClaim>;
  readonly releaseGeneration: (input: GenerationClaimInput) => Promise<GenerationClaim>;
}

export interface SecurityStateMaintenanceStore {
  readonly checkReadiness: (signal?: AbortSignal) => Promise<void>;
  readonly cleanupExpired: (input: CleanupInput) => Promise<CleanupResult>;
}

export interface PairingOperatorStore {
  readonly issuePairing: (input: IssuePairingInput) => Promise<PairingIssueResult>;
  readonly revokePairing: (input: RevokePairingInput) => Promise<void>;
}

export interface LocalMockSecurityStateStore extends
  SecurityRuntimeStore,
  PairingOperatorStore,
  SecurityStateMaintenanceStore {
  readonly deploymentBoundary: typeof LOCAL_MOCK_ONLY;
  readonly environment: typeof LOCAL_MOCK_ENVIRONMENT;
  readonly audience: SecurityAudience;
  readonly generationProvider: 'mock';
  readonly transcriptionProvider: 'mock';
  readonly capabilities: typeof SECURITY_STATE_CAPABILITIES;
}

export const DURABLE_SECURITY_STATE_STORE: unique symbol = Symbol('palancar.durable-security-state-store');
export interface DurableSecurityStateStore extends SecurityRuntimeStore {
  readonly [DURABLE_SECURITY_STATE_STORE]: true;
  readonly deploymentBoundary: 'DURABLE_PROVIDER';
  readonly capabilities: Readonly<{
    durableAcrossProcesses: true;
    paidProvidersAllowed: true;
  }>;
}

export type { CanonicalPairingCode, CanonicalSha256, CanonicalToken, CanonicalUuid };
