import { describe, expect, it } from 'vitest';

import * as production from '../src/index.js';
import {
  ACTIVE_LEASE_MS,
  AUDIO_GRANT_TTL_MS,
  CREDENTIAL_ABSOLUTE_TTL_MS,
  CREDENTIAL_IDLE_TTL_MS,
  DURABLE_SECURITY_STATE_STORE,
  AUDIO_RESERVATION_WINDOW_MS,
  LOCAL_MOCK_ONLY,
  LOCAL_MOCK_ENVIRONMENT,
  MAX_AUDIO_GRANT_SAMPLES,
  MAX_AUDIO_GRANTS_PER_WINDOW,
  MAX_AUDIO_SAMPLES_PER_WINDOW,
  OPENING_LEASE_MS,
  PAIRING_TTL_MS,
  PENDING_CREDENTIAL_TTL_MS,
  REVOCATION_TOMBSTONE_TTL_MS,
  TICKET_TTL_MS,
  SecurityStateError,
  assertCanonicalUuid,
  hashCorrelationKey,
  hashPairingCode,
  type GenerationClaim,
  type HostTrustedOpaqueSource,
  type DurableSecurityStateStore,
  type PairingOperatorStore,
  type SecurityRuntimeStore,
  type SecurityStateMaintenanceStore,
  type SecurityAudience,
  type SessionLease
} from '../src/index.js';
import {
  createAudioGrantMeter,
  createDeterministicIdFactory,
  createDeterministicTokenFactory,
  createFakeClock,
  createMutableAvailability,
  createTestSecurityStateStore,
  type SecurityIdFactory,
  type SecurityClock,
  type SecurityTokenFactory,
  InMemorySecurityStateStore
} from '../src/testing.js';

const AUDIENCE: SecurityAudience = Object.freeze({
  origin: 'wss://localhost:7443',
  path: '/v1/stream',
  protocol: 'palancar.v1'
});
const MOCK_PROVIDERS = Object.freeze({
  generationProvider: 'mock' as const,
  transcriptionProvider: 'mock' as const
});

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function pairing(index: number): string {
  return `0${String(index).padStart(25, '0')}`;
}

function token(index: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(index, 28);
  return bytes.toString('base64url');
}

function trusted(value: string): HostTrustedOpaqueSource {
  return value as HostTrustedOpaqueSource;
}

function sequence(count: number, make: (index: number) => string, start = 1): readonly string[] {
  return Array.from({ length: count }, (_, index) => make(index + start));
}

function deterministicIds(count = 200): SecurityIdFactory {
  return createDeterministicIdFactory({
    installationIds: sequence(count, uuid, 1),
    sessionIds: sequence(count, uuid, 1_000),
    grantIds: sequence(count, uuid, 2_000),
    generationClaimIds: sequence(count, uuid, 3_000)
  });
}

function deterministicTokens(count = 200): SecurityTokenFactory {
  return createDeterministicTokenFactory({
    pairingCodes: sequence(count, pairing, 1),
    credentials: sequence(count, token, 1_000),
    tickets: sequence(count, token, 2_000)
  });
}

function fixture(initialNow = 1_000) {
  const fake = createFakeClock(initialNow);
  const availability = createMutableAvailability();
  const store = createTestSecurityStateStore({
    ...MOCK_PROVIDERS,
    audience: AUDIENCE,
    clock: fake.clock,
    ids: deterministicIds(),
    tokens: deterministicTokens(),
    availability: availability.availability
  });
  return { store, fake, availability };
}

function ticketRequest(credential: string, changes: Partial<{
  environment: string;
  audience: SecurityAudience;
}> = {}) {
  return {
    credential,
    environment: changes.environment ?? LOCAL_MOCK_ENVIRONMENT,
    audience: changes.audience ?? AUDIENCE,
    intent: 'new'
  } as const;
}

function ticketConsume(ticketValue: string, changes: Partial<{
  environment: string;
  audience: SecurityAudience;
}> = {}) {
  return {
    ticket: ticketValue,
    environment: changes.environment ?? LOCAL_MOCK_ENVIRONMENT,
    audience: changes.audience ?? AUDIENCE,
    intent: 'new'
  } as const;
}

async function enroll(store: InMemorySecurityStateStore, source = 'host-source-1') {
  const issued = await store.issuePairing({ operatorScope: 'operator-1' });
  const redeemed = await store.redeemPairing({ pairingCode: issued.pairingCode, trustedSource: trusted(source) });
  return { issued, redeemed };
}

async function open(store: InMemorySecurityStateStore, credential: string) {
  const ticket = await store.issueSessionTicket(ticketRequest(credential));
  const opening = await store.consumeSessionTicket(ticketConsume(ticket.ticket));
  const active = await store.activateSession({
    lease: opening,
    message: { type: 'session.start', protocolVersion: 1 }
  });
  return { ticket, opening, active };
}

async function activeFixture() {
  const base = fixture();
  const { redeemed } = await enroll(base.store);
  const opened = await open(base.store, redeemed.credential);
  return { ...base, ...opened, redeemed };
}

function correlation(lease: SessionLease, revision = 1) {
  return {
    lease,
    decision: 'target' as const,
    utteranceId: uuid(9_000),
    acceptedFinalRevision: revision,
    selectedTargetLanguage: 'es',
    gatePolicyVersion: '1.0.0',
    transcriptHash: hashCorrelationKey(`transcript-${revision}`)
  };
}

function audioRequest(lease: SessionLease, samples: number, utterance = 9_500, from = 0) {
  return {
    lease,
    utteranceId: assertCanonicalUuid(uuid(utterance)),
    fromOriginalSampleOffset: from,
    originalSamples: samples
  };
}

function expectCategory(error: unknown, category: SecurityStateError['category']): boolean {
  return error instanceof SecurityStateError && error.category === category;
}

describe('deployment boundary and exact schemas', () => {
  it('keeps all in-memory constructors and factories isolated from the root export', () => {
    expect(production.SECURITY_STATE_DEPLOYMENT_BOUNDARY).toBe('LOCAL_MOCK_ONLY');
    expect(production.SECURITY_STATE_CAPABILITIES).toEqual({
      deploymentBoundary: 'LOCAL_MOCK_ONLY',
      durableAcrossProcesses: false,
      azureTables: false,
      paidProvidersAllowed: false
    });
    expect('createFakeClock' in production).toBe(false);
    expect('createSystemTokenFactory' in production).toBe(false);
    expect('InMemorySecurityStateStore' in production).toBe(false);
    expect('createLocalMockSecurityStateStore' in production).toBe(false);
    expect('AudioGrantMeter' in production).toBe(false);
    const store = fixture().store;
    expect(store.deploymentBoundary).toBe(LOCAL_MOCK_ONLY);
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.isFrozen(store.audience)).toBe(true);

    expect(DURABLE_SECURITY_STATE_STORE in store).toBe(false);
    const compileTimeBoundary = (): void => {
      // @ts-expect-error In-memory local mock lacks the durable paid-store brand and capabilities.
      const paid: DurableSecurityStateStore = store;
      void paid;
      const runtime: SecurityRuntimeStore = store;
      const operator: PairingOperatorStore = store;
      const maintenance: SecurityStateMaintenanceStore = store;
      // @ts-expect-error Runtime/relay contract cannot issue plaintext pairing codes.
      void runtime.issuePairing;
      // @ts-expect-error Runtime/relay contract cannot run maintenance.
      void runtime.cleanupExpired;
      // @ts-expect-error Durable/runtime state persists reservation, never frame consumption.
      void runtime.consumeAudioGrant;
      // @ts-expect-error Durable runtime also excludes connection-local frame consumption.
      void paid.consumeAudioGrant;
      // @ts-expect-error Durable runtime does not expose maintenance to request handling.
      void paid.cleanupExpired;
      void maintenance;
      void operator;
    };
    void compileTimeBoundary;
  });

  it('requires exact local-mock/provider configuration and canonical loopback-only wss origins', () => {
    const create = (environment: unknown, origin: string, providers: object = MOCK_PROVIDERS): unknown =>
      createTestSecurityStateStore({
        environment,
        audience: { ...AUDIENCE, origin },
        ...providers
      } as never);
    expect(() => create('test', AUDIENCE.origin)).toThrowError(SecurityStateError);
    expect(() => create(LOCAL_MOCK_ENVIRONMENT, 'wss://relay.test')).toThrowError(SecurityStateError);
    expect(() => create(LOCAL_MOCK_ENVIRONMENT, 'https://localhost:7443')).toThrowError(SecurityStateError);
    expect(() => create(LOCAL_MOCK_ENVIRONMENT, 'wss://localhost:443')).toThrowError(SecurityStateError);
    expect(() => create(LOCAL_MOCK_ENVIRONMENT, AUDIENCE.origin, {
      generationProvider: 'paid', transcriptionProvider: 'mock'
    })).toThrowError(SecurityStateError);
    expect(() => create(LOCAL_MOCK_ENVIRONMENT, AUDIENCE.origin, {
      generationProvider: 'mock', transcriptionProvider: 'azure'
    })).toThrowError(SecurityStateError);
    expect(() => create(LOCAL_MOCK_ENVIRONMENT, AUDIENCE.origin, {
      ...MOCK_PROVIDERS, paidProvidersAllowed: false
    }))
      .toThrowError(SecurityStateError);
    expect(() => create(LOCAL_MOCK_ENVIRONMENT, 'wss://127.0.0.1:7443')).not.toThrow();
  });

  it('exposes readiness only through maintenance and fails closed on outage or cancellation', async () => {
    const { store, availability } = fixture();
    await expect(store.checkReadiness()).resolves.toBeUndefined();
    availability.set(false);
    await expect(store.checkReadiness()).rejects.toMatchObject({ category: 'state-unavailable' });
    availability.set(true);
    const controller = new AbortController();
    controller.abort();
    await expect(store.checkReadiness(controller.signal))
      .rejects.toMatchObject({ category: 'state-unavailable' });
    await expect(store.checkReadiness(new Proxy(new AbortController().signal, {})))
      .rejects.toMatchObject({ category: 'state-unavailable' });
  });

  it('rejects extras, symbols, accessors, inheritance, custom/null prototypes, and proxies without getters', async () => {
    const { store } = fixture();
    const invalid: unknown[] = [
      { operatorScope: 'operator', extra: true },
      Object.assign(Object.create({ inherited: true }) as object, { operatorScope: 'operator' }),
      Object.assign(Object.create(null) as object, { operatorScope: 'operator' }),
      Object.assign(Object.create({}) as object, { operatorScope: 'operator' }),
      new Proxy({ operatorScope: 'operator' }, {})
    ];
    const symbolInput = { operatorScope: 'operator', [Symbol('hidden')]: true };
    invalid.push(symbolInput);
    let getterInvoked = false;
    const accessor = {};
    Object.defineProperty(accessor, 'operatorScope', {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return 'operator';
      }
    });
    invalid.push(accessor);

    for (const value of invalid) {
      await expect(store.issuePairing(value as never)).rejects.toBeInstanceOf(SecurityStateError);
    }
    expect(getterInvoked).toBe(false);
    expect(store.snapshot().pairings).toHaveLength(0);
  });

  it('returns frozen own-data plain objects and generic content-free errors', async () => {
    const { store } = fixture();
    const issued = await store.issuePairing({ operatorScope: 'operator' });
    expect(Object.getPrototypeOf(issued)).toBe(Object.prototype);
    expect(Object.isFrozen(issued)).toBe(true);
    expect(Object.values(Object.getOwnPropertyDescriptors(issued)).every((item) => 'value' in item)).toBe(true);
    const canary = 'CANARY-secret-value';
    try {
      await store.issuePairing({ operatorScope: canary, extra: true } as never);
      expect.fail('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SecurityStateError);
      expect(String(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it('rejects extra own properties across the complete mutation API surface', async () => {
    const { store, active, redeemed } = await activeFixture();
    const issued = await store.issuePairing({ operatorScope: 'operator-extra-schema' });
    const ticket = await store.issueSessionTicket(ticketRequest(redeemed.credential));
    await store.reserveAudio(audioRequest(active, 10));
    const authorization = await store.authorizeGeneration(correlation(active));
    const extra = { extra: true } as const;
    const cases: readonly (() => Promise<unknown>)[] = [
      () => store.revokePairing({ pairingHash: hashPairingCode(issued.pairingCode), ...extra } as never),
      () => store.redeemPairing({ pairingCode: issued.pairingCode, trustedSource: 'source', ...extra } as never),
      () => store.authenticateCredential({ credential: redeemed.credential, ...extra } as never),
      () => store.beginCredentialRotation({ credential: redeemed.credential, ...extra } as never),
      () => store.promoteCredential({ pendingCredential: token(99), ...extra } as never),
      () => store.revokeInstallation({ installationId: redeemed.installationId, ...extra } as never),
      () => store.revokeCurrentInstallation({ credential: redeemed.credential, ...extra } as never),
      () => store.issueSessionTicket({ ...ticketRequest(redeemed.credential), ...extra } as never),
      () => store.consumeSessionTicket({ ...ticketConsume(ticket.ticket), ...extra } as never),
      () => store.activateSession({
        lease: active, message: { type: 'session.start', protocolVersion: 1 }, ...extra
      } as never),
      () => store.heartbeatSession({ lease: active, ...extra } as never),
      () => store.endSession({ lease: active, ...extra } as never),
      () => store.reserveAudio({ ...audioRequest(active, 1), ...extra } as never),
      () => store.authorizeGeneration({ ...correlation(active, 2), ...extra } as never),
      () => store.providerStart({ claim: authorization.claim, ...extra } as never),
      () => store.heartbeatGeneration({ claim: authorization.claim, ...extra } as never),
      () => store.completeGeneration({ claim: authorization.claim, outcome: 'completed', ...extra } as never),
      () => store.releaseGeneration({ claim: authorization.claim, ...extra } as never),
      () => store.cleanupExpired({ limit: 1, ...extra } as never)
    ];
    for (const operation of cases) await expect(operation()).rejects.toBeInstanceOf(SecurityStateError);
    expect(store.snapshot().sessions[0]).toMatchObject({
      status: 'active', audioReservedOriginalSamples: 10, attemptCount: 0, generatedCount: 1
    });
  });
});

describe('pairing, source rates, and factory isolation', () => {
  it('redeems exactly once across 100 calls while every attempt consumes trusted-source capacity', async () => {
    const { store } = fixture();
    const issued = await store.issuePairing({ operatorScope: 'operator' });
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => store.redeemPairing({
      pairingCode: issued.pairingCode,
      trustedSource: trusted('host-source')
    })));
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(99);
    expect(results.some((item) => item.status === 'rejected' && expectCategory(item.reason, 'rate-limited'))).toBe(true);
    expect(store.snapshot().installations).toHaveLength(1);
  });

  it('charges wrong pairing attempts and requires a host-trusted opaque source', async () => {
    const { store } = fixture();
    const valid = await store.issuePairing({ operatorScope: 'operator' });
    for (let index = 20; index < 25; index += 1) {
      await expect(store.redeemPairing({ pairingCode: pairing(index), trustedSource: trusted('trusted-a') }))
        .rejects.toMatchObject({ category: 'invalid-pairing' });
    }
    await expect(store.redeemPairing({ pairingCode: valid.pairingCode, trustedSource: trusted('trusted-a') }))
      .rejects.toMatchObject({ category: 'rate-limited' });
    await expect(store.redeemPairing({ pairingCode: valid.pairingCode, trustedSource: trusted('trusted-b') }))
      .resolves.toMatchObject({ credentialVersion: 1 });
    await expect(store.redeemPairing({ pairingCode: valid.pairingCode } as never))
      .rejects.toMatchObject({ category: 'invalid-input' });
  });

  it('enforces operator issue and trusted-source daily attempt windows', async () => {
    const issueFixture = fixture();
    for (let index = 0; index < 20; index += 1) {
      await issueFixture.store.issuePairing({ operatorScope: 'same-operator' });
    }
    await expect(issueFixture.store.issuePairing({ operatorScope: 'same-operator' }))
      .rejects.toBeInstanceOf(SecurityStateError);
    expect(issueFixture.store.snapshot().pairings).toHaveLength(20);

    const attemptFixture = fixture();
    for (let batch = 0; batch < 4; batch += 1) {
      for (let index = 0; index < 5; index += 1) {
        await expect(attemptFixture.store.redeemPairing({
          pairingCode: pairing(50 + batch * 5 + index), trustedSource: trusted('same-source')
        })).rejects.toMatchObject({ category: 'invalid-pairing' });
      }
      attemptFixture.fake.advance(15 * 60_000);
    }
    const valid = await attemptFixture.store.issuePairing({ operatorScope: 'operator' });
    await expect(attemptFixture.store.redeemPairing({
      pairingCode: valid.pairingCode, trustedSource: trusted('same-source')
    })).rejects.toMatchObject({ category: 'rate-limited' });
  });

  it('revokes pairing hashes in O(1) and rejects redemption generically', async () => {
    const { store } = fixture();
    const issued = await store.issuePairing({ operatorScope: 'operator' });
    await store.revokePairing({ pairingHash: hashPairingCode(issued.pairingCode) });
    await expect(store.redeemPairing({ pairingCode: issued.pairingCode, trustedSource: trusted('source') }))
      .rejects.toMatchObject({ category: 'invalid-pairing' });
    expect(store.snapshot().pairings[0]?.status).toBe('revoked');
  });

  it('aborts recursive factories and availability callbacks without mutation', async () => {
    const fake = createFakeClock(1_000);
    const ids = deterministicIds();
    const baseTokens = deterministicTokens();
    const holder: { store?: InMemorySecurityStateStore } = {};
    let recursiveError: unknown;
    const tokens: SecurityTokenFactory = Object.freeze({
      pairingCode: (): string => {
        try { holder.store?.snapshot(); } catch (error) { recursiveError = error; }
        return pairing(1);
      },
      credential: baseTokens.credential,
      ticket: baseTokens.ticket
    });
    const store = createTestSecurityStateStore({
      ...MOCK_PROVIDERS,
      audience: AUDIENCE, clock: fake.clock, ids, tokens
    });
    holder.store = store;
    await expect(store.issuePairing({ operatorScope: 'operator' }))
      .rejects.toBeInstanceOf(SecurityStateError);
    expect(recursiveError).toBeInstanceOf(SecurityStateError);
    expect(store.snapshot().pairings).toHaveLength(0);

    const baseIds = deterministicIds();
    const idHolder: { store?: InMemorySecurityStateStore } = {};
    const recursiveIds: SecurityIdFactory = Object.freeze({
      installationId: (): string => {
        try { idHolder.store?.snapshot(); } catch { /* expected recursive rejection */ }
        return baseIds.installationId();
      },
      sessionId: baseIds.sessionId,
      grantId: baseIds.grantId,
      generationClaimId: baseIds.generationClaimId
    });
    const idStore = createTestSecurityStateStore({
      ...MOCK_PROVIDERS,
      audience: AUDIENCE, clock: fake.clock,
      ids: recursiveIds, tokens: deterministicTokens()
    });
    idHolder.store = idStore;
    const issued = await idStore.issuePairing({ operatorScope: 'operator' });
    await expect(idStore.redeemPairing({ pairingCode: issued.pairingCode, trustedSource: trusted('source') }))
      .rejects.toMatchObject({ category: 'state-unavailable' });
    expect(idStore.snapshot().pairings[0]?.status).toBe('issued');
    expect(idStore.snapshot().installations).toHaveLength(0);

    const availabilityHolder: { store?: InMemorySecurityStateStore } = {};
    const availability = Object.freeze({
      isAvailable: (): boolean => {
        try { availabilityHolder.store?.snapshot(); } catch { /* expected recursive rejection */ }
        return true;
      }
    });
    const availabilityStore = createTestSecurityStateStore({
      ...MOCK_PROVIDERS,
      audience: AUDIENCE, clock: fake.clock,
      ids: deterministicIds(), tokens: deterministicTokens(), availability
    });
    availabilityHolder.store = availabilityStore;
    await expect(availabilityStore.issuePairing({ operatorScope: 'operator' }))
      .rejects.toBeInstanceOf(SecurityStateError);
  });

  it('bounds collisions and revalidates availability immediately before commit', async () => {
    const fake = createFakeClock(1_000);
    let calls = 0;
    const base = deterministicTokens();
    const tokens: SecurityTokenFactory = Object.freeze({
      pairingCode: (): string => { calls += 1; return pairing(1); },
      credential: base.credential,
      ticket: base.ticket
    });
    const collisionStore = createTestSecurityStateStore({
      ...MOCK_PROVIDERS,
      audience: AUDIENCE, clock: fake.clock,
      ids: deterministicIds(), tokens
    });
    await collisionStore.issuePairing({ operatorScope: 'one' });
    await expect(collisionStore.issuePairing({ operatorScope: 'two' }))
      .rejects.toBeInstanceOf(SecurityStateError);
    expect(calls).toBe(9);
    expect(collisionStore.snapshot().pairings).toHaveLength(1);

    const availability = createMutableAvailability();
    const base2 = deterministicTokens();
    const outageTokens: SecurityTokenFactory = Object.freeze({
      pairingCode: base2.pairingCode,
      credential: (): string => {
        availability.set(false);
        return base2.credential();
      },
      ticket: base2.ticket
    });
    const outageStore = createTestSecurityStateStore({
      ...MOCK_PROVIDERS,
      audience: AUDIENCE, clock: fake.clock,
      ids: deterministicIds(), tokens: outageTokens, availability: availability.availability
    });
    const issued = await outageStore.issuePairing({ operatorScope: 'operator' });
    await expect(outageStore.redeemPairing({ pairingCode: issued.pairingCode, trustedSource: trusted('source') }))
      .rejects.toMatchObject({ category: 'state-unavailable' });
    availability.set(true);
    expect(outageStore.snapshot().pairings[0]?.status).toBe('issued');
    expect(outageStore.snapshot().installations).toHaveLength(0);
  });

  it('rechecks availability after the clock callback and leaves state identical on a flipped outage', async () => {
    const fake = createFakeClock(1_000);
    const availability = createMutableAvailability();
    let flipOutage = false;
    const clock: SecurityClock = Object.freeze({
      now: (): number => {
        if (flipOutage) availability.set(false);
        return fake.now();
      }
    });
    const store = createTestSecurityStateStore({
      ...MOCK_PROVIDERS,
      audience: AUDIENCE,
      clock,
      ids: deterministicIds(),
      tokens: deterministicTokens(),
      availability: availability.availability
    });
    const { redeemed } = await enroll(store);
    const before = store.snapshot();
    flipOutage = true;
    await expect(store.authenticateCredential({ credential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'state-unavailable' });
    flipOutage = false;
    availability.set(true);
    expect(store.snapshot()).toEqual(before);
  });
});

describe('credential rotation, tickets, and session leases', () => {
  it('enforces credential idle, absolute, and revocation boundaries', async () => {
    const idle = fixture();
    const idleEnrollment = await enroll(idle.store);
    idle.fake.advance(CREDENTIAL_IDLE_TTL_MS);
    await expect(idle.store.authenticateCredential({ credential: idleEnrollment.redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });

    const absolute = fixture();
    const absoluteEnrollment = await enroll(absolute.store);
    for (let index = 0; index < 3; index += 1) {
      absolute.fake.advance(CREDENTIAL_IDLE_TTL_MS - 1);
      await absolute.store.authenticateCredential({ credential: absoluteEnrollment.redeemed.credential });
    }
    absolute.fake.advance(CREDENTIAL_ABSOLUTE_TTL_MS - 3 * (CREDENTIAL_IDLE_TTL_MS - 1));
    await expect(absolute.store.authenticateCredential({ credential: absoluteEnrollment.redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });

    const capped = fixture();
    const cappedEnrollment = await enroll(capped.store);
    while (capped.fake.now() + CREDENTIAL_IDLE_TTL_MS < cappedEnrollment.redeemed.absoluteExpiresAt) {
      const remaining = cappedEnrollment.redeemed.absoluteExpiresAt - capped.fake.now();
      capped.fake.advance(Math.min(CREDENTIAL_IDLE_TTL_MS - 1, remaining - CREDENTIAL_IDLE_TTL_MS));
      await capped.store.authenticateCredential({ credential: cappedEnrollment.redeemed.credential });
    }
    capped.fake.advance(cappedEnrollment.redeemed.absoluteExpiresAt - capped.fake.now() - 1);
    await expect(capped.store.authenticateCredential({ credential: cappedEnrollment.redeemed.credential }))
      .resolves.toMatchObject({ idleExpiresAt: cappedEnrollment.redeemed.absoluteExpiresAt });
    capped.fake.advance(1);
    await expect(capped.store.authenticateCredential({ credential: cappedEnrollment.redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });

    const revoked = fixture();
    const revokedEnrollment = await enroll(revoked.store);
    await revoked.store.revokeInstallation({ installationId: revokedEnrollment.redeemed.installationId });
    await expect(revoked.store.authenticateCredential({ credential: revokedEnrollment.redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
  });

  it('promotes pending v+1 within five minutes and preserves the absolute expiry', async () => {
    const { store } = fixture();
    const { redeemed } = await enroll(store);
    const pending = await store.beginCredentialRotation({ credential: redeemed.credential });
    expect(pending.pendingCredentialVersion).toBe(2);
    expect(pending.absoluteExpiresAt).toBe(redeemed.absoluteExpiresAt);
    await expect(store.authenticateCredential({ credential: pending.pendingCredential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    await expect(store.issueSessionTicket(ticketRequest(pending.pendingCredential)))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
    const oldAuth = await store.authenticateCredential({ credential: redeemed.credential });
    expect(oldAuth.promoted).toBe(false);
    const promoted = await store.promoteCredential({ pendingCredential: pending.pendingCredential });
    expect(promoted).toMatchObject({
      installationId: redeemed.installationId,
      credentialVersion: 2,
      tombstoneVersion: 1
    });
    expect(promoted.invalidatedSession).toBeUndefined();
    await expect(store.authenticateCredential({ credential: pending.pendingCredential }))
      .resolves.toMatchObject({ absoluteExpiresAt: redeemed.absoluteExpiresAt, promoted: false });
    await expect(store.authenticateCredential({ credential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
  });

  it('reports pending rotation conflicts and returns frozen promotion replay metadata', async () => {
    const { store, fake, redeemed, active } = await activeFixture();
    const pending = await store.beginCredentialRotation({ credential: redeemed.credential });
    await expect(store.beginCredentialRotation({ credential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'credential-conflict' });
    const promoted = await store.promoteCredential({ pendingCredential: pending.pendingCredential });
    expect(promoted).toMatchObject({
      status: 'promoted',
      confirmedAt: fake.now(),
      idleExpiresAt: fake.now() + CREDENTIAL_IDLE_TTL_MS,
      absoluteExpiresAt: redeemed.absoluteExpiresAt,
      invalidatedSession: {
        installationId: active.installationId,
        sessionId: active.sessionId,
        sessionEpoch: active.sessionEpoch
      }
    });
    expect(Object.isFrozen(promoted)).toBe(true);
    expect(Object.isFrozen(promoted.invalidatedSession)).toBe(true);
    fake.advance(1);
    const replay = await store.promoteCredential({ pendingCredential: pending.pendingCredential });
    expect(replay).toMatchObject({
      status: 'already-promoted',
      confirmedAt: fake.now(),
      idleExpiresAt: fake.now() + CREDENTIAL_IDLE_TTL_MS,
      absoluteExpiresAt: redeemed.absoluteExpiresAt
    });
    expect(replay.invalidatedSession).toBeUndefined();
  });

  it('detects a pending conflict before consuming candidate-token randomness', async () => {
    let credentialCalls = 0;
    const tokens: SecurityTokenFactory = Object.freeze({
      pairingCode: () => pairing(1),
      credential: () => {
        credentialCalls += 1;
        if (credentialCalls === 1) return token(1_000);
        if (credentialCalls === 2) return token(1_001);
        throw new Error('credential source failed');
      },
      ticket: () => token(2_000)
    });
    const fake = createFakeClock();
    const store = createTestSecurityStateStore({
      ...MOCK_PROVIDERS,
      audience: AUDIENCE,
      clock: fake.clock,
      ids: deterministicIds(),
      tokens
    });
    const { redeemed } = await enroll(store);
    const pending = await store.beginCredentialRotation({ credential: redeemed.credential });
    expect(pending.pendingCredential).toBe(token(1_001));
    expect(credentialCalls).toBe(2);
    await expect(store.beginCredentialRotation({ credential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'credential-conflict' });
    expect(credentialCalls).toBe(2);
  });

  it('replaces an expired pending credential exactly at its boundary', async () => {
    const { store, fake } = fixture();
    const { redeemed } = await enroll(store);
    const first = await store.beginCredentialRotation({ credential: redeemed.credential });
    fake.advance(PENDING_CREDENTIAL_TTL_MS - 1);
    await expect(store.beginCredentialRotation({ credential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'credential-conflict' });
    expect(store.snapshot().credentials.filter((item) => item.status === 'pending')).toHaveLength(1);
    fake.advance(1);
    const second = await store.beginCredentialRotation({ credential: redeemed.credential });
    expect(second.pendingCredentialVersion).toBe(first.pendingCredentialVersion);
    expect(second.pendingExpiresAt).toBe(fake.now() + PENDING_CREDENTIAL_TTL_MS);
    expect(store.snapshot().credentials).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: first.pendingCredentialVersion, status: 'expired' }),
      expect.objectContaining({ version: second.pendingCredentialVersion, status: 'pending' })
    ]));
    expect(store.snapshot().credentials.filter((item) => item.status === 'pending')).toHaveLength(1);
  });

  it('revokes with the current credential and makes the former credential replay-safe', async () => {
    const { store, fake, redeemed, active } = await activeFixture();
    const first = await store.revokeCurrentInstallation({ credential: redeemed.credential });
    expect(first).toMatchObject({
      status: 'revoked',
      revokedAt: fake.now(),
      tombstoneVersion: 2,
      invalidatedSession: {
        installationId: active.installationId,
        sessionId: active.sessionId,
        sessionEpoch: active.sessionEpoch
      }
    });
    const snapshot = store.snapshot();
    const replay = await store.revokeCurrentInstallation({ credential: redeemed.credential });
    expect(replay).toMatchObject({
      ...first,
      status: 'already-revoked'
    });
    expect(store.snapshot()).toEqual(snapshot);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.invalidatedSession)).toBe(true);
    await expect(store.revokeCurrentInstallation({ credential: token(999) }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
  });

  it('serializes 100 rotation and credential-revocation contenders', async () => {
    const rotation = fixture();
    const { redeemed } = await enroll(rotation.store);
    const beginnings = await Promise.allSettled(Array.from({ length: 100 }, () =>
      rotation.store.beginCredentialRotation({ credential: redeemed.credential })));
    expect(beginnings.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(beginnings.filter((item) => item.status === 'rejected' &&
      expectCategory(item.reason, 'credential-conflict'))).toHaveLength(99);
    const winner = beginnings.find((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof rotation.store.beginCredentialRotation>>> =>
      item.status === 'fulfilled');
    if (winner === undefined) throw new Error('rotation winner missing');
    const promotions = await Promise.allSettled(Array.from({ length: 100 }, () =>
      rotation.store.promoteCredential({ pendingCredential: winner.value.pendingCredential })));
    expect(promotions.filter((item) => item.status === 'fulfilled')).toHaveLength(100);
    expect(promotions.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof rotation.store.promoteCredential>>> =>
      item.status === 'fulfilled' && item.value.status === 'promoted')).toHaveLength(1);
    expect(promotions.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof rotation.store.promoteCredential>>> =>
      item.status === 'fulfilled' && item.value.status === 'already-promoted')).toHaveLength(99);

    const revocation = fixture();
    const enrolled = await enroll(revocation.store);
    const revocations = await Promise.allSettled(Array.from({ length: 100 }, () =>
      revocation.store.revokeCurrentInstallation({ credential: enrolled.redeemed.credential })));
    expect(revocations.filter((item) => item.status === 'fulfilled')).toHaveLength(100);
    expect(revocations.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof revocation.store.revokeCurrentInstallation>>> =>
      item.status === 'fulfilled' && item.value.status === 'revoked')).toHaveLength(1);
    expect(revocations.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof revocation.store.revokeCurrentInstallation>>> =>
      item.status === 'fulfilled' && item.value.status === 'already-revoked')).toHaveLength(99);
    expect(revocation.store.snapshot().installations[0]?.tombstoneVersion).toBe(2);
  });

  it('promotion immediately ends prior-version sessions and invalidates their work', async () => {
    const { store, active, redeemed } = await activeFixture();
    await store.reserveAudio(audioRequest(active, 100));
    const authorization = await store.authorizeGeneration(correlation(active));
    const pending = await store.beginCredentialRotation({ credential: redeemed.credential });
    const promoted = await store.promoteCredential({ pendingCredential: pending.pendingCredential });

    expect(promoted.invalidatedSession).toEqual({
      installationId: active.installationId,
      sessionId: active.sessionId,
      sessionEpoch: active.sessionEpoch
    });

    expect(store.snapshot().sessions[0]?.status).toBe('ended');
    expect(store.snapshot().installations[0]?.activeSessionId).toBeUndefined();
    await expect(store.heartbeatSession({ lease: active }))
      .rejects.toMatchObject({ category: 'stale-lease' });
    await expect(store.authorizeGeneration(correlation(active, 2)))
      .rejects.toMatchObject({ category: 'generation-rejected' });
    await expect(store.providerStart({ claim: authorization.claim }))
      .rejects.toMatchObject({ category: 'generation-rejected' });
  });

  it.each([
    { winner: 'promotion' as const },
    { winner: 'revocation' as const }
  ])('serializes promotion against credential-authenticated revocation when $winner wins', async ({ winner }) => {
    const { store, redeemed } = await activeFixture();
    const pending = await store.beginCredentialRotation({ credential: redeemed.credential });
    const promotion = (): ReturnType<typeof store.promoteCredential> =>
      store.promoteCredential({ pendingCredential: pending.pendingCredential });
    const revocation = (): ReturnType<typeof store.revokeCurrentInstallation> =>
      store.revokeCurrentInstallation({ credential: redeemed.credential });
    const outcomes = await Promise.allSettled(winner === 'promotion'
      ? [promotion(), revocation()]
      : [revocation(), promotion()]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const fulfilled = outcomes.find((item) => item.status === 'fulfilled');
    expect(fulfilled?.value).toMatchObject({ status: winner === 'promotion' ? 'promoted' : 'revoked' });
    const installation = store.snapshot().installations[0];
    expect(installation?.activeSessionId).toBeUndefined();
    expect(installation?.status).toBe(winner === 'promotion' ? 'active' : 'revoked');
    expect(store.snapshot().sessions.every((session) => !['opening', 'active'].includes(session.status))).toBe(true);
    expect(outcomes.filter((item) => item.status === 'rejected').every((item) =>
      (item.reason as SecurityStateError).category === 'invalid-credential'
    )).toBe(true);
  });

  it.each([
    { order: 'promotion-first' as const },
    { order: 'revocation-first' as const }
  ])('serializes promotion against ID-based revokeInstallation in $order order', async ({ order }) => {
    const { store, redeemed } = await activeFixture();
    const pending = await store.beginCredentialRotation({ credential: redeemed.credential });
    const promotion = (): ReturnType<typeof store.promoteCredential> =>
      store.promoteCredential({ pendingCredential: pending.pendingCredential });
    const revocation = (): ReturnType<typeof store.revokeInstallation> =>
      store.revokeInstallation({ installationId: redeemed.installationId });
    const outcomes = await Promise.allSettled(order === 'promotion-first'
      ? [promotion(), revocation()]
      : [revocation(), promotion()]);
    if (order === 'promotion-first') {
      expect(outcomes[0]).toMatchObject({ status: 'fulfilled', value: { status: 'promoted' } });
      expect(outcomes[1]?.status).toBe('fulfilled');
    } else {
      expect(outcomes[0]?.status).toBe('fulfilled');
      expect(outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: { category: 'invalid-credential' }
      });
    }
    expect(store.snapshot().installations[0]).toMatchObject({
      status: 'revoked',
      tombstoneVersion: 2
    });
    expect(store.snapshot().installations[0]?.activeSessionId).toBeUndefined();
    expect(store.snapshot().sessions.every((session) => !['opening', 'active'].includes(session.status))).toBe(true);
  });

  it('rejects malformed, unrelated, pending, retired, expired, and revoked credentials generically', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base.store);
    const pending = await base.store.beginCredentialRotation({ credential: redeemed.credential });
    await expect(base.store.promoteCredential({ pendingCredential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    await expect(base.store.revokeCurrentInstallation({ credential: pending.pendingCredential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    await expect(base.store.promoteCredential({ pendingCredential: 'not-a-credential' }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    await expect(base.store.promoteCredential({ pendingCredential: token(99_999) }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    const canary = 'CANARY-credential-value';
    await base.store.promoteCredential({ pendingCredential: pending.pendingCredential });
    await expect(base.store.revokeCurrentInstallation({ credential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });

    const expired = fixture();
    const expiredEnrollment = await enroll(expired.store);
    const expiredPending = await expired.store.beginCredentialRotation({ credential: expiredEnrollment.redeemed.credential });
    expired.fake.advance(PENDING_CREDENTIAL_TTL_MS);
    await expect(expired.store.promoteCredential({ pendingCredential: expiredPending.pendingCredential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    try {
      await expired.store.promoteCredential({ pendingCredential: canary });
      expect.fail('expected expired credential rejection');
    } catch (error) {
      expect(error).toMatchObject({ category: 'invalid-credential' });
      expect(String(error)).not.toContain(canary);
      expect(error instanceof Error ? error.stack : '').not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
    }
    expect(JSON.stringify(expired.store.snapshot())).not.toContain(canary);

    const revoked = fixture();
    const revokedEnrollment = await enroll(revoked.store);
    await revoked.store.revokeCurrentInstallation({ credential: revokedEnrollment.redeemed.credential });
    await expect(revoked.store.promoteCredential({ pendingCredential: revokedEnrollment.redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
  });

  it.each([
    {
      name: 'malformed revocation',
      exercise: async (): Promise<unknown> => {
        const { store } = fixture();
        return store.revokeCurrentInstallation({ credential: 'not-a-credential' });
      }
    },
    {
      name: 'expired-current revocation',
      exercise: async (): Promise<unknown> => {
        const { store, fake } = fixture();
        const { redeemed } = await enroll(store);
        fake.advance(CREDENTIAL_IDLE_TTL_MS);
        return store.revokeCurrentInstallation({ credential: redeemed.credential });
      }
    },
    {
      name: 'retired promotion',
      exercise: async (): Promise<unknown> => {
        const { store } = fixture();
        const { redeemed } = await enroll(store);
        const pending = await store.beginCredentialRotation({ credential: redeemed.credential });
        await store.promoteCredential({ pendingCredential: pending.pendingCredential });
        expect(store.snapshot().credentials.find((item) => item.version === 1)?.status).toBe('retired');
        return store.promoteCredential({ pendingCredential: redeemed.credential });
      }
    },
    {
      name: 'unrelated-revoked revocation',
      exercise: async (): Promise<unknown> => {
        const { store } = fixture();
        const { redeemed } = await enroll(store);
        const pending = await store.beginCredentialRotation({ credential: redeemed.credential });
        await store.revokeCurrentInstallation({ credential: redeemed.credential });
        expect(store.snapshot().credentials.find((item) =>
          item.version === pending.pendingCredentialVersion)?.status).toBe('revoked');
        expect(store.snapshot().installations[0]?.credentialVersion).not.toBe(pending.pendingCredentialVersion);
        return store.revokeCurrentInstallation({ credential: pending.pendingCredential });
      }
    }
  ])('rejects $name with invalid-credential', async ({ exercise }) => {
    await expect(exercise()).rejects.toMatchObject({ category: 'invalid-credential' });
  });

  it('keeps revocation credential canaries out of errors and state', async () => {
    const { store } = fixture();
    const before = store.snapshot();
    const canary = 'CANARY-revocation-credential';
    try {
      await store.revokeCurrentInstallation({ credential: canary });
      expect.fail('expected malformed revocation rejection');
    } catch (error) {
      expect(error).toMatchObject({ category: 'invalid-credential' });
      expect(String(error)).not.toContain(canary);
      expect(error instanceof Error ? error.stack : '').not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
    }
    expect(store.snapshot()).toEqual(before);
    expect(JSON.stringify(store.snapshot())).not.toContain(canary);
  });

  it('expires an unpromoted pending credential after exactly five minutes without retiring v1', async () => {
    const { store, fake } = fixture();
    const { redeemed } = await enroll(store);
    const pending = await store.beginCredentialRotation({ credential: redeemed.credential });
    fake.advance(PENDING_CREDENTIAL_TTL_MS);
    await expect(store.promoteCredential({ pendingCredential: pending.pendingCredential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    await expect(store.authenticateCredential({ credential: redeemed.credential }))
      .resolves.toMatchObject({ credentialVersion: 1 });
    expect(store.snapshot().credentials.some((item) => item.status === 'expired')).toBe(true);
  });

  it('uses immutable environment/audience/new intent and makes public ticket failures generic', async () => {
    const { store } = fixture();
    const { redeemed } = await enroll(store);
    const otherAudience = Object.freeze({ ...AUDIENCE, origin: 'wss://127.0.0.1:7443' });
    await expect(store.issueSessionTicket(ticketRequest(redeemed.credential, { environment: 'other' })))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
    await expect(store.issueSessionTicket(ticketRequest(redeemed.credential, { audience: otherAudience })))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
    await expect(store.issueSessionTicket({
      credential: redeemed.credential,
      environment: LOCAL_MOCK_ENVIRONMENT,
      audience: AUDIENCE,
      intent: 'resume'
    } as never))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
    await expect(store.issueSessionTicket({ ...ticketRequest(redeemed.credential), extra: true } as never))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
    await expect(store.consumeSessionTicket({ ticket: 'not-a-ticket' } as never))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
    const ticket = await store.issueSessionTicket(ticketRequest(redeemed.credential));
    await expect(store.consumeSessionTicket(ticketConsume(ticket.ticket, { audience: otherAudience })))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
    const opening = await store.consumeSessionTicket(ticketConsume(ticket.ticket));
    await expect(store.consumeSessionTicket(ticketConsume(ticket.ticket)))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
    expect(opening.phase).toBe('opening');
  });

  it('uses exact ADR pairing, ticket, opening, and active durations', async () => {
    const { store } = fixture();
    const issued = await store.issuePairing({ operatorScope: 'operator' });
    expect(issued.expiresAt - issued.issuedAt).toBe(PAIRING_TTL_MS);
    const redeemed = await store.redeemPairing({ pairingCode: issued.pairingCode, trustedSource: trusted('source') });
    const ticket = await store.issueSessionTicket(ticketRequest(redeemed.credential));
    expect(ticket.expiresAt - ticket.issuedAt).toBe(TICKET_TTL_MS);
    const opening = await store.consumeSessionTicket(ticketConsume(ticket.ticket));
    expect(opening.leaseExpiresAt - ticket.issuedAt).toBe(OPENING_LEASE_MS);
    const active = await store.activateSession({
      lease: opening, message: { type: 'session.start', protocolVersion: 1 }
    });
    expect(active.leaseExpiresAt - ticket.issuedAt).toBe(ACTIVE_LEASE_MS);
  });

  it('enforces rolling ticket limits and reports them only as invalid-ticket', async () => {
    const { store, fake } = fixture();
    const { redeemed } = await enroll(store);
    for (let batch = 0; batch < 5; batch += 1) {
      await Promise.all(Array.from({ length: 6 }, () =>
        store.issueSessionTicket(ticketRequest(redeemed.credential))));
      fake.advance(60_000);
    }
    await expect(store.issueSessionTicket(ticketRequest(redeemed.credential)))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
    expect(store.snapshot().tickets).toHaveLength(30);
  });

  it('enforces reconnect limits at 5/60s and 12/10m', async () => {
    const { store, fake } = fixture();
    const { redeemed } = await enroll(store);
    const initial = await open(store, redeemed.credential);
    await store.endSession({ lease: initial.active });

    let elapsedReconnects = 0;
    for (let batch = 0; batch < 3; batch += 1) {
      fake.advance(60_000);
      const tickets = await Promise.all(Array.from({ length: 5 }, () =>
        store.issueSessionTicket(ticketRequest(redeemed.credential))));
      const allowed = batch < 2 ? 5 : 2;
      for (let index = 0; index < allowed; index += 1) {
        const opening = await store.consumeSessionTicket(ticketConsume(tickets[index]?.ticket as string));
        const active = await store.activateSession({
          lease: opening, message: { type: 'session.start', protocolVersion: 1 }
        });
        await store.endSession({ lease: active });
        elapsedReconnects += 1;
      }
      if (batch === 2) {
        await expect(store.consumeSessionTicket(ticketConsume(tickets[allowed]?.ticket as string)))
          .rejects.toMatchObject({ category: 'invalid-ticket' });
      }
    }
    expect(elapsedReconnects).toBe(12);

    fake.advance(10 * 60_000);
    const ticket = await store.issueSessionTicket(ticketRequest(redeemed.credential));
    await expect(store.consumeSessionTicket(ticketConsume(ticket.ticket)))
      .resolves.toMatchObject({ sessionEpoch: 14 });
  });

  it('consumes one ticket exactly once across 100 concurrent calls', async () => {
    const { store } = fixture();
    const { redeemed } = await enroll(store);
    const ticket = await store.issueSessionTicket(ticketRequest(redeemed.credential));
    const results = await Promise.allSettled(Array.from({ length: 100 }, () =>
      store.consumeSessionTicket(ticketConsume(ticket.ticket))));
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected').every((item) =>
      expectCategory(item.reason, 'invalid-ticket'))).toBe(true);
  });

  it('expires the opening claim at 10s and lazily releases the installation lock', async () => {
    const { store, fake } = fixture();
    const { redeemed } = await enroll(store);
    const firstTicket = await store.issueSessionTicket(ticketRequest(redeemed.credential));
    const staleOpening = await store.consumeSessionTicket(ticketConsume(firstTicket.ticket));
    fake.advance(OPENING_LEASE_MS);
    const secondTicket = await store.issueSessionTicket(ticketRequest(redeemed.credential));
    const secondOpening = await store.consumeSessionTicket(ticketConsume(secondTicket.ticket));
    expect(secondOpening.sessionEpoch).toBe(staleOpening.sessionEpoch + 1);
    await expect(store.activateSession({
      lease: staleOpening, message: { type: 'session.start', protocolVersion: 1 }
    })).rejects.toMatchObject({ category: 'stale-lease' });
  });

  it('requires exact session.start and rejects stale lease versions on activate/heartbeat/end', async () => {
    const { store, active, opening } = await activeFixture();
    expect(active.leaseVersion).toBe(opening.leaseVersion + 1);
    await expect(store.activateSession({ lease: opening, message: { type: 'session.start', protocolVersion: 1 } }))
      .rejects.toMatchObject({ category: 'stale-lease' });
    await expect(store.heartbeatSession({ lease: opening }))
      .rejects.toMatchObject({ category: 'stale-lease' });
    const renewed = await store.heartbeatSession({ lease: active });
    expect(renewed.leaseVersion).toBe(active.leaseVersion + 1);
    await expect(store.endSession({ lease: active })).rejects.toMatchObject({ category: 'stale-lease' });
    await expect(store.endSession({ lease: renewed })).resolves.toBeUndefined();
  });

  it('rejects malformed session.start without consuming the opening lease', async () => {
    const { store } = fixture();
    const { redeemed } = await enroll(store);
    const ticket = await store.issueSessionTicket(ticketRequest(redeemed.credential));
    const opening = await store.consumeSessionTicket(ticketConsume(ticket.ticket));
    await expect(store.activateSession({
      lease: opening,
      message: { type: 'session.start', protocolVersion: 1, extra: true }
    } as never)).rejects.toMatchObject({ category: 'invalid-input' });
    await expect(store.activateSession({
      lease: opening,
      message: { type: 'session.start', protocolVersion: 1 }
    })).resolves.toMatchObject({ phase: 'active' });
  });

  it('invalidates outstanding tickets through the installation tombstone without scanning them', async () => {
    const { store } = fixture();
    const { redeemed } = await enroll(store);
    const ticket = await store.issueSessionTicket(ticketRequest(redeemed.credential));
    await store.revokeInstallation({ installationId: redeemed.installationId });
    const snapshot = store.snapshot();
    expect(snapshot.tickets[0]?.status).toBe('issued');
    expect(snapshot.installations[0]?.status).toBe('revoked');
    await expect(store.consumeSessionTicket(ticketConsume(ticket.ticket)))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
  });
});

describe('audio grants and generation claims', () => {
  it('enforces utterance-bound 1..8000 grants and exact 16000/1000ms rolling boundaries', async () => {
    const { store, active, fake } = await activeFixture();
    await expect(store.reserveAudio(audioRequest(active, 0)))
      .rejects.toMatchObject({ category: 'invalid-input' });
    await expect(store.reserveAudio(audioRequest(active, MAX_AUDIO_GRANT_SAMPLES + 1)))
      .rejects.toMatchObject({ category: 'invalid-input' });
    await expect(store.reserveAudio(audioRequest(active, 1, 9_500, Number.MAX_SAFE_INTEGER)))
      .rejects.toMatchObject({ category: 'invalid-input' });
    const first = await store.reserveAudio(audioRequest(active, MAX_AUDIO_GRANT_SAMPLES));
    expect(first.utteranceId).toBe(assertCanonicalUuid(uuid(9_500)));
    expect(first).toMatchObject({
      fromOriginalSampleOffset: 0,
      throughOriginalSampleOffset: MAX_AUDIO_GRANT_SAMPLES
    });
    await store.reserveAudio(audioRequest(active, MAX_AUDIO_GRANT_SAMPLES, 9_501, MAX_AUDIO_GRANT_SAMPLES));
    await expect(store.reserveAudio(audioRequest(active, 1, 9_501)))
      .rejects.toMatchObject({ category: 'quota-exceeded' });
    fake.advance(AUDIO_RESERVATION_WINDOW_MS - 1);
    await expect(store.reserveAudio(audioRequest(active, 1, 9_502)))
      .rejects.toMatchObject({ category: 'quota-exceeded' });
    fake.advance(1);
    await expect(store.reserveAudio(audioRequest(active, MAX_AUDIO_GRANT_SAMPLES, 9_502)))
      .resolves.toMatchObject({ reservedOriginalSamples: MAX_AUDIO_GRANT_SAMPLES });
    expect(store.snapshot().sessions[0]?.audioReservedOriginalSamples)
      .toBe(MAX_AUDIO_SAMPLES_PER_WINDOW + MAX_AUDIO_GRANT_SAMPLES);
  });

  it('limits outstanding grants to 100 per rolling window and expires their storage at the exact boundary', async () => {
    const { store, active, fake } = await activeFixture();
    for (let window = 0; window < 3; window += 1) {
      const grants = await Promise.all(Array.from({ length: MAX_AUDIO_GRANTS_PER_WINDOW }, (_, index) =>
        store.reserveAudio(audioRequest(active, 1, 11_000 + index))));
      expect(grants).toHaveLength(MAX_AUDIO_GRANTS_PER_WINDOW);
      await expect(store.reserveAudio(audioRequest(active, 1, 12_000)))
        .rejects.toMatchObject({ category: 'quota-exceeded' });
      expect(store.snapshot().grants).toHaveLength(MAX_AUDIO_GRANTS_PER_WINDOW);

      fake.advance(AUDIO_GRANT_TTL_MS - 1);
      expect(store.snapshot().grants).toHaveLength(MAX_AUDIO_GRANTS_PER_WINDOW);
      fake.advance(1);
      expect(store.snapshot().grants).toHaveLength(0);
    }
  });

  it('meters only unique contiguous frame ranges locally and leaves durable reservation state unchanged', async () => {
    const { store, active, fake } = await activeFixture();
    const grant = await store.reserveAudio(audioRequest(active, MAX_AUDIO_GRANT_SAMPLES, 9_501, 100));
    const meter = createAudioGrantMeter({ grant, clock: fake.clock });
    await expect(Promise.resolve().then(() => meter.accept({
      fromOriginalSampleOffset: 101,
      throughOriginalSampleOffset: 421
    }))).rejects.toMatchObject({ category: 'stale-lease' });
    let cursor = 100;
    for (let frame = 0; frame < 25; frame += 1) {
      const next = cursor + 320;
      const accepted = meter.accept({
        fromOriginalSampleOffset: cursor,
        throughOriginalSampleOffset: next
      });
      if (frame === 0) {
        expect(() => meter.accept({
          fromOriginalSampleOffset: cursor,
          throughOriginalSampleOffset: next
        })).toThrowError(SecurityStateError);
        expect(() => meter.accept({
          fromOriginalSampleOffset: cursor + 1,
          throughOriginalSampleOffset: next + 1
        })).toThrowError(SecurityStateError);
      }
      cursor = next;
      expect(accepted.acceptedThroughOriginalSampleOffset).toBe(cursor);
    }
    expect(meter.snapshot()).toMatchObject({
      acceptedOriginalSamples: MAX_AUDIO_GRANT_SAMPLES,
      remainingOriginalSamples: 0,
      complete: true
    });
    expect(() => meter.accept({
      fromOriginalSampleOffset: cursor,
      throughOriginalSampleOffset: cursor + 1
    })).toThrowError(SecurityStateError);
    expect(store.snapshot().grants[0]).toMatchObject({
      fromOriginalSampleOffset: 100,
      throughOriginalSampleOffset: 8_100,
      reservedOriginalSamples: MAX_AUDIO_GRANT_SAMPLES
    });
  });

  it('applies exact plain-object schemas to meter construction and frame acceptance', async () => {
    const { store, active, fake } = await activeFixture();
    const grant = await store.reserveAudio(audioRequest(active, 10));
    expect(() => createAudioGrantMeter({ grant, clock: fake.clock, extra: true } as never))
      .toThrowError(SecurityStateError);
    expect(() => createAudioGrantMeter({ grant: { ...grant, extra: true }, clock: fake.clock } as never))
      .toThrowError(SecurityStateError);
    const meter = createAudioGrantMeter({ grant, clock: fake.clock });
    let invoked = false;
    const accessor = { throughOriginalSampleOffset: 1 };
    Object.defineProperty(accessor, 'fromOriginalSampleOffset', {
      enumerable: true,
      get: () => {
        invoked = true;
        return 0;
      }
    });
    expect(() => meter.accept(accessor as never)).toThrowError(SecurityStateError);
    expect(invoked).toBe(false);
    expect(() => meter.accept(new Proxy({
      fromOriginalSampleOffset: 0,
      throughOriginalSampleOffset: 1
    }, {}))).toThrowError(SecurityStateError);
  });

  it('expires the connection-local meter at the exact grant boundary', async () => {
    const { store, active, fake } = await activeFixture();
    const grant = await store.reserveAudio(audioRequest(active, 10));
    const meter = createAudioGrantMeter({ grant, clock: fake.clock });
    fake.advance(AUDIO_GRANT_TTL_MS - 1);
    expect(() => meter.accept({
      fromOriginalSampleOffset: 0,
      throughOriginalSampleOffset: 5
    })).not.toThrow();
    fake.advance(1);
    expect(() => meter.accept({
      fromOriginalSampleOffset: 5,
      throughOriginalSampleOffset: 10
    })).toThrowError(SecurityStateError);
  });

  it('supports a 30-second utterance as the durable audio window refills', async () => {
    const { store, active, fake } = await activeFixture();
    let lease = active;
    for (let turn = 0; turn < 30; turn += 1) {
      const from = turn * MAX_AUDIO_SAMPLES_PER_WINDOW;
      await store.reserveAudio(audioRequest(lease, MAX_AUDIO_GRANT_SAMPLES, 10_000, from));
      await store.reserveAudio(audioRequest(
        lease,
        MAX_AUDIO_GRANT_SAMPLES,
        10_000,
        from + MAX_AUDIO_GRANT_SAMPLES
      ));
      fake.advance(AUDIO_RESERVATION_WINDOW_MS);
      if ((turn + 1) % 20 === 0) lease = await store.heartbeatSession({ lease });
    }
    expect(store.snapshot().sessions[0]?.audioReservedOriginalSamples)
      .toBe(30 * MAX_AUDIO_SAMPLES_PER_WINDOW);
  });

  it('keeps the rolling audio reservation charged across reconnects for the installation', async () => {
    const { store, active, fake, redeemed } = await activeFixture();
    await store.reserveAudio(audioRequest(active, MAX_AUDIO_GRANT_SAMPLES));
    await store.reserveAudio(audioRequest(active, MAX_AUDIO_GRANT_SAMPLES, 9_501));
    await store.endSession({ lease: active });
    const reconnected = await open(store, redeemed.credential);
    await expect(store.reserveAudio(audioRequest(reconnected.active, 1, 9_502)))
      .rejects.toMatchObject({ category: 'quota-exceeded' });
    fake.advance(AUDIO_RESERVATION_WINDOW_MS);
    await expect(store.reserveAudio(audioRequest(reconnected.active, 1, 9_502)))
      .resolves.toMatchObject({ reservedOriginalSamples: 1 });
  });

  it('requires explicit target plus precomputed sha256 and rejects content fields', async () => {
    const { store, active } = await activeFixture();
    await expect(store.authorizeGeneration({ ...correlation(active), decision: 'english' } as never))
      .rejects.toMatchObject({ category: 'invalid-input' });
    await expect(store.authorizeGeneration({ ...correlation(active), targetTranscript: 'content' } as never))
      .rejects.toMatchObject({ category: 'invalid-input' });
    await expect(store.authorizeGeneration({ ...correlation(active), transcriptHash: 'bad' } as never))
      .rejects.toMatchObject({ category: 'invalid-input' });
  });

  it('reuses one authorization across 100 calls and increments attempts only at provider start', async () => {
    const { store, active } = await activeFixture();
    const request = correlation(active);
    const results = await Promise.all(Array.from({ length: 100 }, () => store.authorizeGeneration(request)));
    expect(results.filter((item) => item.status === 'acquired')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'duplicate-in-flight')).toHaveLength(99);
    expect(new Set(results.map((item) => item.claim.authorizationId)).size).toBe(1);
    expect(results[0]?.claim.authorizationId).toBe(hashCorrelationKey(JSON.stringify([
      active.installationId,
      active.sessionId,
      active.sessionEpoch,
      request.utteranceId,
      request.acceptedFinalRevision,
      request.selectedTargetLanguage,
      request.gatePolicyVersion,
      request.transcriptHash
    ])));
    expect(store.snapshot().sessions[0]).toMatchObject({ generatedCount: 1, attemptCount: 0 });
    const claim = results[0]?.claim as GenerationClaim;
    const starts = await Promise.all(Array.from({ length: 100 }, () => store.providerStart({ claim })));
    expect(starts.filter((item) => item.status === 'start-permitted')).toHaveLength(1);
    expect(starts.filter((item) => item.status === 'already-consumed')).toHaveLength(99);
    expect(store.snapshot().sessions[0]).toMatchObject({ generatedCount: 1, attemptCount: 1 });
  });

  it('enforces 6/minute and 60/session generation authorization counters', async () => {
    const minute = await activeFixture();
    for (let revision = 1; revision <= 6; revision += 1) {
      await minute.store.authorizeGeneration(correlation(minute.active, revision));
    }
    await expect(minute.store.authorizeGeneration(correlation(minute.active, 7)))
      .rejects.toMatchObject({ category: 'rate-limited' });

    const session = await activeFixture();
    let lease = session.active;
    for (let batch = 0; batch < 10; batch += 1) {
      for (let offset = 1; offset <= 6; offset += 1) {
        await session.store.authorizeGeneration(correlation(lease, batch * 6 + offset));
      }
      if (batch < 9) {
        for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) {
          session.fake.advance(20_000);
          lease = await session.store.heartbeatSession({ lease });
        }
      }
    }
    await expect(session.store.authorizeGeneration(correlation(lease, 61)))
      .rejects.toMatchObject({ category: 'quota-exceeded' });
    expect(session.store.snapshot().sessions[0]).toMatchObject({ generatedCount: 60, attemptCount: 0 });
  });

  it('versions provider start/heartbeat/complete and rejects stale operations', async () => {
    const { store, active, fake } = await activeFixture();
    const authorization = await store.authorizeGeneration(correlation(active));
    expect(authorization.status).toBe('acquired');
    const start = await store.providerStart({ claim: authorization.claim });
    expect(start.status).toBe('start-permitted');
    const started = start.claim;
    expect(started.phase).toBe('started');
    fake.advance(20_000);
    const renewed = await store.heartbeatGeneration({ claim: started });
    expect(renewed.leaseVersion).toBe(started.leaseVersion + 1);
    await expect(store.completeGeneration({ claim: started, outcome: 'completed' }))
      .rejects.toMatchObject({ category: 'generation-rejected' });
    const completed = await store.completeGeneration({ claim: renewed, outcome: 'completed' });
    expect(completed.phase).toBe('completed');
    const duplicate = await store.authorizeGeneration(correlation(active));
    expect(duplicate).toMatchObject({ status: 'duplicate-completed', claim: { phase: 'completed' } });
    await expect(store.providerStart({ claim: authorization.claim }))
      .resolves.toMatchObject({ status: 'already-consumed', claim: { phase: 'completed' } });
    expect(store.snapshot().sessions[0]?.attemptCount).toBe(1);
  });

  it('reclaims only unstarted releases and never refunds or retries after provider start', async () => {
    const firstFixture = await activeFixture();
    const first = await firstFixture.store.authorizeGeneration(correlation(firstFixture.active));
    await firstFixture.store.releaseGeneration({ claim: first.claim });
    const reclaimed = await firstFixture.store.authorizeGeneration(correlation(firstFixture.active));
    expect(reclaimed.status).toBe('acquired');
    expect(reclaimed.claim.claimVersion).toBe(2);
    expect(firstFixture.store.snapshot().sessions[0]).toMatchObject({ generatedCount: 1, attemptCount: 0 });

    const secondFixture = await activeFixture();
    const second = await secondFixture.store.authorizeGeneration(correlation(secondFixture.active));
    const start = await secondFixture.store.providerStart({ claim: second.claim });
    expect(start.status).toBe('start-permitted');
    const released = await secondFixture.store.releaseGeneration({ claim: start.claim });
    const duplicate = await secondFixture.store.authorizeGeneration(correlation(secondFixture.active));
    expect(duplicate).toMatchObject({ status: 'duplicate-consumed', claim: { phase: 'released' } });
    expect(duplicate.claim.claimVersion).toBe(released.claimVersion);
    expect(secondFixture.store.snapshot().sessions[0]?.attemptCount).toBe(1);
  });

  it('idempotently releases exact unstarted claims after session end or installation revoke', async () => {
    const ended = await activeFixture();
    const endedAuthorization = await ended.store.authorizeGeneration(correlation(ended.active));
    await ended.store.endSession({ lease: ended.active });
    const released = await ended.store.releaseGeneration({ claim: endedAuthorization.claim });
    expect(released.phase).toBe('released');
    await expect(ended.store.releaseGeneration({ claim: endedAuthorization.claim }))
      .resolves.toEqual(released);
    await expect(ended.store.releaseGeneration({ claim: released }))
      .resolves.toEqual(released);
    await expect(ended.store.releaseGeneration({
      claim: { ...endedAuthorization.claim, leaseVersion: endedAuthorization.claim.leaseVersion + 1 }
    })).rejects.toMatchObject({ category: 'generation-rejected' });

    const revoked = await activeFixture();
    const revokedAuthorization = await revoked.store.authorizeGeneration(correlation(revoked.active));
    const revokedResult = await revoked.store.revokeInstallation({
      installationId: revoked.redeemed.installationId
    });
    expect(revokedResult.invalidatedSession).toEqual({
      installationId: revoked.active.installationId,
      sessionId: revoked.active.sessionId,
      sessionEpoch: revoked.active.sessionEpoch
    });
    await expect(revoked.store.releaseGeneration({ claim: revokedAuthorization.claim }))
      .resolves.toMatchObject({ phase: 'released' });

    const started = await activeFixture();
    const startedAuthorization = await started.store.authorizeGeneration(correlation(started.active));
    const providerStart = await started.store.providerStart({ claim: startedAuthorization.claim });
    await started.store.endSession({ lease: started.active });
    await expect(started.store.releaseGeneration({ claim: providerStart.claim }))
      .rejects.toMatchObject({ category: 'generation-rejected' });
    expect(started.store.snapshot().sessions[0]?.attemptCount).toBe(1);
  });
});

describe('expiry, cleanup, snapshots, and safe time', () => {
  it('refreshes expiry in frozen metadata-only snapshots and exposes no hashes or secrets', async () => {
    const { store, fake } = fixture();
    const { issued, redeemed } = await enroll(store);
    const opened = await open(store, redeemed.credential);
    fake.advance(ACTIVE_LEASE_MS);
    const snapshot = store.snapshot();
    expect(snapshot.sessions[0]?.status).toBe('expired');
    expect(snapshot.installations[0]?.activeSessionId).toBeUndefined();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sessions)).toBe(true);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(issued.pairingCode);
    expect(serialized).not.toContain(redeemed.credential);
    expect(serialized).not.toContain(opened.ticket.ticket);
    expect(serialized).not.toContain(hashPairingCode(issued.pairingCode));
  });

  it('retains revoked installation tombstones for 30 days and removes them at the exact boundary', async () => {
    const { store, fake } = fixture();
    const { redeemed } = await enroll(store);
    await store.revokeInstallation({ installationId: redeemed.installationId });
    expect(store.snapshot().installations[0]).toMatchObject({ status: 'revoked', revokedAt: fake.now() });

    fake.advance(REVOCATION_TOMBSTONE_TTL_MS - 1);
    await store.cleanupExpired({ limit: 1_000 });
    expect(store.snapshot().installations).toHaveLength(1);

    fake.advance(1);
    await store.cleanupExpired({ limit: 1_000 });
    expect(store.snapshot().installations).toHaveLength(0);
  });

  it('retains naturally expired installation tombstones for the same safe cleanup period', async () => {
    const { store, fake } = fixture();
    await enroll(store);
    fake.advance(CREDENTIAL_ABSOLUTE_TTL_MS);
    expect(store.snapshot().installations[0]).toMatchObject({
      status: 'expired', expiredAt: fake.now()
    });

    fake.advance(REVOCATION_TOMBSTONE_TTL_MS - 1);
    await store.cleanupExpired({ limit: 1_000 });
    expect(store.snapshot().installations).toHaveLength(1);
    fake.advance(1);
    await store.cleanupExpired({ limit: 1_000 });
    expect(store.snapshot().installations).toHaveLength(0);
  });

  it('bounds lazy cleanup work and uses no timers', async () => {
    const { store, fake } = fixture();
    await store.issuePairing({ operatorScope: 'operator' });
    fake.advance(600_000);
    const result = await store.cleanupExpired({ limit: 3 });
    expect(result.visited).toBeLessThanOrEqual(3);
    expect(result.removed).toBe(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(store.snapshot().pairings).toHaveLength(0);
  });

  it('detects clock rollback and timestamp overflow without partial mutation', async () => {
    const { store, fake } = fixture(1_000);
    await store.issuePairing({ operatorScope: 'operator' });
    const before = store.snapshot();
    fake.set(999);
    expect(() => store.snapshot()).toThrowError(SecurityStateError);
    fake.set(1_000);
    expect(store.snapshot()).toEqual(before);

    const nearMax = fixture(Number.MAX_SAFE_INTEGER - 599_999);
    await expect(nearMax.store.issuePairing({ operatorScope: 'operator' }))
      .rejects.toBeInstanceOf(SecurityStateError);
    expect(nearMax.store.snapshot().pairings).toHaveLength(0);
  });

  it('makes FakeClock overflow atomic', () => {
    const fake = createFakeClock(Number.MAX_SAFE_INTEGER - 1);
    expect(() => fake.advance(2)).toThrowError(RangeError);
    expect(fake.now()).toBe(Number.MAX_SAFE_INTEGER - 1);
  });
});
