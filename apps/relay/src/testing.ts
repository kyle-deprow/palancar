import {
  DEFAULT_NEGOTIATED_LIMITS,
  createWebSocketSubprotocols,
  type NegotiatedLimits
} from '@palancar/contracts';
import {
  GenerationService,
  type GenerationProvider,
  type GenerationProviderCompletion
} from '@palancar/generation';
import { DeterministicMockTranscriptionAdapter } from '@palancar/transcription';
import {
  DURABLE_SECURITY_STATE_STORE,
  SecurityStateError,
  assertCanonical256BitToken,
  assertCanonicalUuid,
  hashCorrelationKey,
  type DurableSecurityStateStore,
  type GenerationClaim,
  type InstallationRevocationResult,
  type SecurityRuntimeStore,
  type SessionLease
} from '@palancar/security-state';

import { createControlledFixtureTextLanguageClassifier } from './language-classifier.js';
import type { RelaySecurityComposition } from './security.js';
import type {
  RelayClock,
  RelayIdGenerator,
  RelaySessionCoreOptions
} from './types.js';

export const TEST_SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';
export const TEST_SECOND_UTTERANCE_ID = '33333333-3333-4333-8333-333333333333';
export const TEST_ERROR_ID = '44444444-4444-4444-8444-444444444444';
export const TEST_GATE_POLICY_VERSION = '1.0.0';
export const TEST_TICKET = 'A'.repeat(42) + 'E';
export const TEST_CREDENTIAL = 'B'.repeat(42) + 'E';
const TEST_REVOCATION_AT = Date.parse('2026-08-10T12:02:00.000Z');

interface TestRevocationState {
  activeLease: SessionLease | undefined;
  invalidatedSession: InstallationRevocationResult['invalidatedSession'];
  revokedAt: number | undefined;
  tombstoneVersion: number;
}

function createTestRevocationState(): TestRevocationState {
  return {
    activeLease: undefined,
    invalidatedSession: undefined,
    revokedAt: undefined,
    tombstoneVersion: 0
  };
}

function revokeTestInstallation(
  state: TestRevocationState,
  credential: string
): InstallationRevocationResult {
  if (credential !== TEST_CREDENTIAL) throw new SecurityStateError('invalid-credential');
  if (state.revokedAt !== undefined) {
    return Object.freeze({
      installationId: assertCanonicalUuid(TEST_SESSION_ID),
      credentialVersion: 1,
      tombstoneVersion: state.tombstoneVersion,
      status: 'already-revoked' as const,
      revokedAt: state.revokedAt,
      ...(state.invalidatedSession === undefined
        ? {}
        : { invalidatedSession: state.invalidatedSession })
    });
  }
  state.revokedAt = TEST_REVOCATION_AT;
  state.tombstoneVersion += 1;
  state.invalidatedSession = state.activeLease === undefined
    ? undefined
    : Object.freeze({
        installationId: state.activeLease.installationId,
        sessionId: state.activeLease.sessionId,
        sessionEpoch: state.activeLease.sessionEpoch
      });
  state.activeLease = undefined;
  return Object.freeze({
    installationId: assertCanonicalUuid(TEST_SESSION_ID),
    credentialVersion: 1,
    tombstoneVersion: state.tombstoneVersion,
    status: 'revoked' as const,
    revokedAt: state.revokedAt,
    ...(state.invalidatedSession === undefined
      ? {}
      : { invalidatedSession: state.invalidatedSession })
  });
}

export function createTestSessionLease(): SessionLease {
  return Object.freeze({
    installationId: assertCanonicalUuid(TEST_SESSION_ID),
    sessionId: assertCanonicalUuid(TEST_SESSION_ID),
    sessionEpoch: 1,
    credentialVersion: 1,
    leaseVersion: 1,
    phase: 'active',
    leaseExpiresAt: Date.parse('2026-08-10T13:00:00.000Z')
  });
}

export const createTestTicketClaim = createTestSessionLease;

function testGenerationClaim(phase: GenerationClaim['phase']): GenerationClaim {
  return Object.freeze({
    authorizationId: hashCorrelationKey('test-generation'),
    claimId: assertCanonicalUuid(TEST_ERROR_ID),
    installationId: assertCanonicalUuid(TEST_SESSION_ID),
    sessionId: assertCanonicalUuid(TEST_SESSION_ID),
    sessionEpoch: 1,
    claimVersion: 1,
    leaseVersion: 1,
    phase,
    leaseExpiresAt: Date.parse('2026-08-10T13:00:00.000Z')
  });
}

export function createTestSecurityRuntime(
  overrides: Partial<SecurityRuntimeStore> = {}
): SecurityRuntimeStore {
  const revocation = createTestRevocationState();
  const unsupported = async (): Promise<never> => {
    throw new Error('unsupported_test_security_operation');
  };
  return {
    redeemPairing: unsupported,
    authenticateCredential: unsupported,
    beginCredentialRotation: unsupported,
    promoteCredential: unsupported,
    revokeInstallation: unsupported,
    revokeCurrentInstallation: async ({ credential }) =>
      revokeTestInstallation(revocation, credential),
    issueSessionTicket: unsupported,
    consumeSessionTicket: unsupported,
    activateSession: async ({ lease }) => {
      const activeLease = Object.freeze({ ...lease, phase: 'active' as const });
      revocation.activeLease = activeLease;
      return activeLease;
    },
    heartbeatSession: async ({ lease }) => {
      const activeLease = Object.freeze({ ...lease, leaseVersion: lease.leaseVersion + 1 });
      revocation.activeLease = activeLease;
      return activeLease;
    },
    endSession: async ({ lease }) => {
      const activeLease = revocation.activeLease;
      if (
        activeLease?.sessionId === lease.sessionId &&
        activeLease.sessionEpoch === lease.sessionEpoch
      ) {
        revocation.activeLease = undefined;
      }
    },
    reserveAudio: unsupported,
    authorizeGeneration: async () => ({
      status: 'acquired',
      claim: testGenerationClaim('claimed')
    }),
    providerStart: async () => ({
      status: 'start-permitted',
      claim: testGenerationClaim('started')
    }),
    heartbeatGeneration: async ({ claim }) => claim,
    completeGeneration: async ({ outcome }) => ({
      ...testGenerationClaim('completed'),
      phase: 'completed' as const,
      claimVersion: outcome === 'completed' ? 2 : 3
    }),
    releaseGeneration: async () => testGenerationClaim('released'),
    ...overrides
  };
}

export function createTestHostSecurityComposition(): RelaySecurityComposition {
  let ticketCounter = 0;
  let leaseVersion = 1;
  let grantCounter = 0;
  const tickets = new Set<string>();
  const revocation = createTestRevocationState();
  const baseRuntime = createTestSecurityRuntime({
    redeemPairing: async () => ({
      installationId: assertCanonicalUuid(TEST_SESSION_ID),
      credential: assertCanonical256BitToken(TEST_CREDENTIAL),
      credentialVersion: 1,
      idleExpiresAt: Date.parse('2026-09-01T00:00:00.000Z'),
      absoluteExpiresAt: Date.parse('2026-10-01T00:00:00.000Z')
    }),
    issueSessionTicket: async ({ credential, environment, audience, intent }) => {
      if (credential !== TEST_CREDENTIAL || revocation.revokedAt !== undefined) {
        throw new SecurityStateError('invalid-credential');
      }
      ticketCounter += 1;
      const ticket = `${String(ticketCounter).padStart(42, 'A')}E`;
      tickets.add(ticket);
      return {
        ticket: assertCanonical256BitToken(ticket),
        installationId: assertCanonicalUuid(TEST_SESSION_ID),
        credentialVersion: 1,
        issuedAt: Date.parse('2026-08-10T12:00:00.000Z'),
        expiresAt: Date.parse('2026-08-10T13:00:00.000Z'),
        environment,
        audience,
        intent
      };
    },
    consumeSessionTicket: async ({ ticket }) => {
      if (revocation.revokedAt !== undefined || !tickets.delete(ticket)) {
        throw new SecurityStateError('invalid-ticket');
      }
      const lease = Object.freeze({ ...createTestSessionLease(), phase: 'opening' as const });
      revocation.activeLease = lease;
      return lease;
    },
    activateSession: async ({ lease }) => {
      leaseVersion += 1;
      const activeLease = Object.freeze({ ...lease, phase: 'active' as const, leaseVersion });
      revocation.activeLease = activeLease;
      return activeLease;
    },
    heartbeatSession: async ({ lease }) => {
      leaseVersion += 1;
      const activeLease = Object.freeze({ ...lease, leaseVersion });
      revocation.activeLease = activeLease;
      return activeLease;
    },
    endSession: async ({ lease }) => {
      const activeLease = revocation.activeLease;
      if (
        activeLease?.sessionId === lease.sessionId &&
        activeLease.sessionEpoch === lease.sessionEpoch
      ) {
        revocation.activeLease = undefined;
      }
    },
    revokeCurrentInstallation: async ({ credential }) =>
      revokeTestInstallation(revocation, credential),
    reserveAudio: async ({ lease, utteranceId, fromOriginalSampleOffset, originalSamples }) => {
      grantCounter += 1;
      return {
        grantId: assertCanonicalUuid(
          `55555555-5555-4555-8555-${String(grantCounter).padStart(12, '0')}`
        ),
        utteranceId,
        installationId: lease.installationId,
        sessionId: lease.sessionId,
        sessionEpoch: lease.sessionEpoch,
        sessionLeaseVersion: lease.leaseVersion,
        issuedAt: 0,
        expiresAt: 4_102_444_800_000,
        fromOriginalSampleOffset,
        throughOriginalSampleOffset: fromOriginalSampleOffset + originalSamples,
        reservedOriginalSamples: originalSamples
      };
    }
  });
  const runtime: DurableSecurityStateStore = Object.freeze({
    ...baseRuntime,
    [DURABLE_SECURITY_STATE_STORE]: true as const,
    deploymentBoundary: 'DURABLE_PROVIDER',
    capabilities: Object.freeze({
      durableAcrossProcesses: true,
      paidProvidersAllowed: true
    })
  });
  const maintenance = {
    checkReadiness: async (): Promise<void> => undefined,
    cleanupExpired: async () => ({ visited: 0, removed: 0 })
  };
  return Object.freeze({ mode: 'azure-table', runtime, maintenance });
}

export function createTestClock(): RelayClock {
  return { nowIso: () => '2026-08-10T12:00:00.000Z' };
}

export function createTestIds(): RelayIdGenerator {
  let errorCounter = 0;
  return {
    sessionId: () => TEST_SESSION_ID,
    errorId: () => {
      errorCounter += 1;
      return errorCounter === 1
        ? TEST_ERROR_ID
        : `44444444-4444-4444-8444-${String(errorCounter).padStart(12, '0')}`;
    }
  };
}

export function createTestGenerationService(
  provider: GenerationProvider = {
    id: 'test-provider',
    version: '1.0.0',
    complete: async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'hello',
      suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
      ]
    })
  }
): GenerationService {
  return new GenerationService(provider);
}

export function createTestOptions(
  overrides: Partial<RelaySessionCoreOptions> = {},
  limits: NegotiatedLimits = DEFAULT_NEGOTIATED_LIMITS
): RelaySessionCoreOptions {
  return {
    sessionLease: createTestSessionLease(),
    securityRuntime: createTestSecurityRuntime(),
    clock: createTestClock(),
    ids: createTestIds(),
    transcriptionAdapter: new DeterministicMockTranscriptionAdapter({
      evidenceCategory: 'selected-target'
    }),
    languageClassifier: createControlledFixtureTextLanguageClassifier(),
    generationService: createTestGenerationService(),
    gatePolicyVersion: TEST_GATE_POLICY_VERSION,
    serverLimits: limits,
    ...overrides
  };
}

export function createTestSubprotocols(): readonly [string, string] {
  return createWebSocketSubprotocols(TEST_TICKET);
}
