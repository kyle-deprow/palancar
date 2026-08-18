import { describe, expect, it } from 'vitest';

import {
  ACTIVE_LEASE_MS,
  AUDIO_GRANT_TTL_MS,
  AUDIO_RESERVATION_WINDOW_MS,
  AZURE_SECURITY_SCHEMA_VERSION,
  CREDENTIAL_ABSOLUTE_TTL_MS,
  LOCAL_MOCK_ENVIRONMENT,
  MAX_AUDIO_GRANTS_PER_WINDOW,
  OPENING_LEASE_MS,
  REVOCATION_TOMBSTONE_TTL_MS,
  SecurityStateError,
  createAzureTableRuntimeStore,
  hashCorrelationKey,
  hashPairingCode,
  type HostTrustedOpaqueSource,
  type SecurityAudience,
  type SessionLease
} from '../src/index.js';
import {
  AzureTableBoundaryError,
  createAzureTableStoresForTesting,
  createDeterministicIdFactory,
  createDeterministicTokenFactory,
  createFakeClock,
  type AzureBoundaryErrorKind,
  type AzureNewEntity,
  type AzureStoredEntity,
  type AzureTableClientLike,
  type AzureTableMutation,
  type SecurityIdFactory,
  type SecurityTokenFactory
} from '../src/testing.js';

const ENVIRONMENT = 'unit';
const AUDIENCE: SecurityAudience = Object.freeze({
  origin: 'wss://relay.example.test',
  path: '/v1/stream',
  protocol: 'palancar.v1'
});
const OTHER_AUDIENCE: SecurityAudience = Object.freeze({
  origin: 'wss://other-relay.example.test',
  path: '/v1/stream',
  protocol: 'palancar.v1'
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

function sequence(count: number, make: (index: number) => string, start = 1): readonly string[] {
  return Array.from({ length: count }, (_, index) => make(index + start));
}

function ids(count = 1_000): SecurityIdFactory {
  return createDeterministicIdFactory({
    installationIds: sequence(count, uuid, 1),
    sessionIds: sequence(count, uuid, 2_000),
    grantIds: sequence(count, uuid, 4_000),
    generationClaimIds: sequence(count, uuid, 6_000)
  });
}

function tokens(count = 1_000): SecurityTokenFactory {
  return createDeterministicTokenFactory({
    pairingCodes: sequence(count, pairing, 1),
    credentials: sequence(count, token, 2_000),
    tickets: sequence(count, token, 4_000)
  });
}

function trusted(value: string): HostTrustedOpaqueSource {
  return value as HostTrustedOpaqueSource;
}

type Operation = 'pointRead' | 'create' | 'replace' | 'delete' | 'transaction' | 'listPage';
interface Failure { readonly operation: Operation; readonly kind: AzureBoundaryErrorKind; readonly after: boolean; }

function cloneEntity(entity: AzureStoredEntity): AzureStoredEntity {
  return Object.freeze({
    partitionKey: entity.partitionKey,
    rowKey: entity.rowKey,
    etag: entity.etag,
    properties: Object.freeze({ ...entity.properties })
  });
}

function fakeTable() {
  let rows = new Map<string, AzureStoredEntity>();
  let version = 0;
  let failure: Failure | undefined;
  let afterTransaction: (() => Promise<void>) | undefined;
  const key = (partitionKey: string, rowKey: string): string => `${partitionKey}\u0000${rowKey}`;
  const nextEtag = (): string => `"etag-${++version}"`;
  const takeFailure = (operation: Operation, after: boolean): void => {
    if (failure?.operation === operation && failure.after === after) {
      const current = failure;
      failure = undefined;
      throw new AzureTableBoundaryError(current.kind);
    }
  };
  const store = (entity: AzureNewEntity, etag = nextEtag()): AzureStoredEntity => Object.freeze({
    partitionKey: entity.partitionKey,
    rowKey: entity.rowKey,
    etag,
    properties: Object.freeze({ ...entity.properties })
  });
  const client: AzureTableClientLike = Object.freeze({
    pointRead: async (partitionKey: string, rowKey: string) => {
      takeFailure('pointRead', false);
      const result = rows.get(key(partitionKey, rowKey));
      takeFailure('pointRead', true);
      return result === undefined ? undefined : cloneEntity(result);
    },
    create: async (entity: AzureNewEntity) => {
      takeFailure('create', false);
      const entityKey = key(entity.partitionKey, entity.rowKey);
      if (rows.has(entityKey)) throw new AzureTableBoundaryError('conflict');
      rows.set(entityKey, store(entity));
      takeFailure('create', true);
    },
    replace: async (entity: AzureNewEntity, etag: string) => {
      takeFailure('replace', false);
      if (etag === '*') throw new Error('wildcard ETag');
      const entityKey = key(entity.partitionKey, entity.rowKey);
      const current = rows.get(entityKey);
      if (current === undefined) throw new AzureTableBoundaryError('not-found');
      if (current.etag !== etag) throw new AzureTableBoundaryError('precondition-failed');
      rows.set(entityKey, store(entity));
      takeFailure('replace', true);
    },
    delete: async (partitionKey: string, rowKey: string, etag: string) => {
      takeFailure('delete', false);
      if (etag === '*') throw new Error('wildcard ETag');
      const entityKey = key(partitionKey, rowKey);
      const current = rows.get(entityKey);
      if (current === undefined) throw new AzureTableBoundaryError('not-found');
      if (current.etag !== etag) throw new AzureTableBoundaryError('precondition-failed');
      rows.delete(entityKey);
      takeFailure('delete', true);
    },
    transaction: async (mutations: readonly AzureTableMutation[]) => {
      takeFailure('transaction', false);
      if (mutations.length === 0 || mutations.length > 100) throw new Error('transaction size');
      const partition = mutations[0]?.entity.partitionKey;
      const next = new Map(rows);
      for (const mutation of mutations) {
        if (mutation.entity.partitionKey !== partition) throw new Error('cross partition');
        const entityKey = key(mutation.entity.partitionKey, mutation.entity.rowKey);
        const current = next.get(entityKey);
        if (mutation.type === 'create') {
          if (current !== undefined) throw new AzureTableBoundaryError('conflict');
          next.set(entityKey, store(mutation.entity));
        } else {
          if (mutation.etag === '*') throw new Error('wildcard ETag');
          if (current === undefined) throw new AzureTableBoundaryError('not-found');
          if (current.etag !== mutation.etag) throw new AzureTableBoundaryError('precondition-failed');
          next.set(entityKey, store(mutation.entity));
        }
      }
      rows = next;
      takeFailure('transaction', true);
      const callback = afterTransaction;
      afterTransaction = undefined;
      if (callback !== undefined) await callback();
    },
    listPage: async (input: Parameters<AzureTableClientLike['listPage']>[0]) => {
      takeFailure('listPage', false);
      const all = [...rows.values()]
        .filter((entity) => input.partitionKey === undefined || entity.partitionKey === input.partitionKey)
        .sort((left, right) => key(left.partitionKey, left.rowKey).localeCompare(key(right.partitionKey, right.rowKey)));
      const start = input.continuationToken === undefined ? 0 : Number(input.continuationToken);
      const entities = Object.freeze(all.slice(start, start + input.limit).map(cloneEntity));
      const continuationToken = start + entities.length < all.length ? String(start + entities.length) : undefined;
      takeFailure('listPage', true);
      return Object.freeze({ entities, ...(continuationToken === undefined ? {} : { continuationToken }) });
    }
  });
  return Object.freeze({
    client,
    failNext: (operation: Operation, kind: AzureBoundaryErrorKind, after = false): void => {
      failure = { operation, kind, after };
    },
    afterNextTransaction: (callback: () => Promise<void>): void => { afterTransaction = callback; },
    insertRaw: (entity: AzureNewEntity): void => { rows.set(key(entity.partitionKey, entity.rowKey), store(entity)); },
    snapshot: (): readonly AzureStoredEntity[] => Object.freeze([...rows.values()].map(cloneEntity))
  });
}

function fixture(initialNow = 1_000, tokenFactory: SecurityTokenFactory = tokens()) {
  const security = fakeTable();
  const rate = fakeTable();
  const fake = createFakeClock(initialNow);
  const stores = createAzureTableStoresForTesting({
    environment: ENVIRONMENT,
    audience: AUDIENCE,
    securityTable: security.client,
    rateTable: rate.client,
    clock: fake.clock,
    ids: ids(),
    tokens: tokenFactory
  });
  return { ...stores, security, rate, fake };
}

function storesForAudience(base: ReturnType<typeof fixture>, audience: SecurityAudience) {
  return createAzureTableStoresForTesting({
    environment: ENVIRONMENT,
    audience,
    securityTable: base.security.client,
    rateTable: base.rate.client,
    clock: base.fake.clock,
    ids: ids(),
    tokens: tokens()
  });
}

function ticketRequest(credential: string) {
  return { credential, environment: ENVIRONMENT, audience: AUDIENCE, intent: 'new' as const };
}

function ticketConsume(ticketValue: string) {
  return { ticket: ticketValue, environment: ENVIRONMENT, audience: AUDIENCE, intent: 'new' as const };
}

async function enroll(base: ReturnType<typeof fixture>, source = 'source-1') {
  const issued = await base.operator.issuePairing({ operatorScope: 'operator-1' });
  const redeemed = await base.runtime.redeemPairing({ pairingCode: issued.pairingCode, trustedSource: trusted(source) });
  return { issued, redeemed };
}

async function open(base: ReturnType<typeof fixture>, credential: string) {
  const ticket = await base.runtime.issueSessionTicket(ticketRequest(credential));
  const opening = await base.runtime.consumeSessionTicket(ticketConsume(ticket.ticket));
  const active = await base.runtime.activateSession({
    lease: opening,
    message: { type: 'session.start', protocolVersion: 1 }
  });
  return { ticket, opening, active };
}

async function activeFixture() {
  const base = fixture();
  const { redeemed } = await enroll(base);
  const opened = await open(base, redeemed.credential);
  return { ...base, redeemed, ...opened };
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

describe('Azure Table durable adapter', () => {
  it('readiness conditionally probes both tables and fails closed on either outage', async () => {
    const base = fixture();
    await expect(base.runtime.checkReadiness())
      .rejects.toMatchObject({ category: 'state-unavailable' });
    expect(base.security.snapshot()).toHaveLength(0);
    expect(base.rate.snapshot()).toHaveLength(0);
    await base.bootstrap.initializeState();
    await expect(base.runtime.checkReadiness()).resolves.toBeUndefined();
    expect(base.security.snapshot().some((entity) => entity.rowKey === 'readiness')).toBe(true);
    expect(base.rate.snapshot().some((entity) => entity.rowKey === 'readiness')).toBe(true);
    base.rate.failNext('replace', 'unavailable');
    await expect(base.runtime.checkReadiness()).rejects.toMatchObject({ category: 'state-unavailable' });
  });

  it('rejects production endpoint exfiltration variants and identical table names', () => {
    const options = {
      endpoint: 'https://account123.table.core.windows.net',
      securityTableName: 'SecurityState',
      rateTableName: 'RateState',
      environment: 'production',
      audience: AUDIENCE,
      managedIdentityClientId: uuid(1)
    };
    expect(() => createAzureTableRuntimeStore(options)).not.toThrow();
    for (const endpoint of [
      'https://user@account123.table.core.windows.net',
      'https://account123.table.core.windows.net:443',
      'https://account123.table.core.windows.net/path',
      'https://account123.table.core.windows.net?next=https://evil.example',
      'https://account123.table.core.windows.net.evil.example',
      'https://table.core.windows.net'
    ]) {
      expect(() => createAzureTableRuntimeStore({ ...options, endpoint }))
        .toThrowError(expect.objectContaining({ category: 'invalid-input' }));
    }
    expect(() => createAzureTableRuntimeStore({
      ...options,
      rateTableName: options.securityTableName
    })).toThrowError(expect.objectContaining({ category: 'invalid-input' }));
  });

  it('persists schema v2 exact architecture metadata without content fields', async () => {
    const base = await activeFixture();
    const authorized = await base.runtime.authorizeGeneration(correlation(base.active));
    await base.runtime.beginCredentialRotation({ credential: base.redeemed.credential });
    const rows = [...base.security.snapshot(), ...base.rate.snapshot()];
    expect(rows.every((row) => row.properties.schemaVersion === AZURE_SECURITY_SCHEMA_VERSION)).toBe(true);
    const pairingRow = rows.find((row) => row.properties.kind === 'pairing');
    expect(pairingRow?.properties).toMatchObject({
      audienceOrigin: AUDIENCE.origin,
      audiencePath: AUDIENCE.path,
      audienceProtocol: AUDIENCE.protocol
    });
    expect(typeof pairingRow?.properties.operatorHash).toBe('string');
    const credentialRows = rows.filter((row) => row.properties.kind === 'credential');
    expect(credentialRows).toHaveLength(2);
    for (const credentialRow of credentialRows) {
      expect(credentialRow.properties).toMatchObject({
        audienceOrigin: AUDIENCE.origin,
        audiencePath: AUDIENCE.path,
        audienceProtocol: AUDIENCE.protocol
      });
    }
    const installationRow = rows.find((row) => row.properties.kind === 'installation');
    expect(installationRow?.properties).toMatchObject({
      activeSessionId: base.active.sessionId,
      activeSessionEpoch: base.active.sessionEpoch,
      activeSessionLeaseVersion: base.active.leaseVersion
    });
    const ticketRow = rows.find((row) => row.properties.kind === 'ticket');
    expect(ticketRow?.properties).toMatchObject({
      audienceOrigin: AUDIENCE.origin,
      intent: 'new',
      tombstoneVersion: 1,
      credentialVersion: 1
    });
    const sessionRow = rows.find((row) => row.properties.kind === 'session');
    expect(sessionRow?.properties).toMatchObject({
      sessionId: base.active.sessionId,
      ticketHash: expect.any(String),
      activatedAt: expect.any(Number),
      lastActivityAt: expect.any(Number)
    });
    const generationRow = rows.find((row) => row.properties.kind === 'generation');
    expect(generationRow?.properties).toMatchObject({
      authorizationId: authorized.claim.authorizationId,
      credentialVersion: base.active.credentialVersion,
      decision: 'target',
      utteranceId: uuid(9_000),
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'es',
      gatePolicyVersion: '1.0.0',
      transcriptHash: hashCorrelationKey('transcript-1')
    });
    for (const row of rows) {
      expect(Object.keys(row.properties)).not.toEqual(expect.arrayContaining([
        'content', 'transcript', 'pcm', 'credential', 'pairingCode', 'ticket'
      ]));
    }
  });

  it('binds current and pending credentials to the exact configured audience', async () => {
    const base = fixture();
    const other = storesForAudience(base, OTHER_AUDIENCE);
    const { redeemed } = await enroll(base);

    await expect(other.runtime.authenticateCredential({ credential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    await expect(other.runtime.beginCredentialRotation({ credential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    await expect(other.runtime.issueSessionTicket({
      credential: redeemed.credential,
      environment: ENVIRONMENT,
      audience: OTHER_AUDIENCE,
      intent: 'new'
    })).rejects.toMatchObject({ category: 'invalid-ticket' });

    const pending = await base.runtime.beginCredentialRotation({ credential: redeemed.credential });
    await expect(other.runtime.promoteCredential({ pendingCredential: pending.pendingCredential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });

    const pendingRow = base.security.snapshot().find((row) =>
      row.properties.kind === 'credential' && row.properties.status === 'pending');
    if (pendingRow === undefined) throw new Error('pending credential row missing');
    base.security.insertRaw(Object.freeze({
      partitionKey: pendingRow.partitionKey,
      rowKey: pendingRow.rowKey,
      properties: Object.freeze({
        ...pendingRow.properties,
        audienceOrigin: OTHER_AUDIENCE.origin,
        audiencePath: OTHER_AUDIENCE.path,
        audienceProtocol: OTHER_AUDIENCE.protocol
      })
    }));
    await expect(other.runtime.promoteCredential({ pendingCredential: pending.pendingCredential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
  });

  it('fails closed on missing or unknown persisted credential audience metadata', async () => {
    const mutations = [
      (properties: AzureStoredEntity['properties']): AzureStoredEntity['properties'] => {
        const next = { ...properties };
        Reflect.deleteProperty(next, 'audienceOrigin');
        return next;
      },
      (properties: AzureStoredEntity['properties']): AzureStoredEntity['properties'] => ({
        ...properties,
        audienceProtocol: 'unknown-protocol'
      })
    ];
    for (const mutate of mutations) {
      const base = fixture();
      const { redeemed } = await enroll(base);
      const credentialRow = base.security.snapshot().find((row) => row.properties.kind === 'credential');
      if (credentialRow === undefined) throw new Error('credential row missing');
      base.security.insertRaw(Object.freeze({
        partitionKey: credentialRow.partitionKey,
        rowKey: credentialRow.rowKey,
        properties: Object.freeze(mutate({ ...credentialRow.properties }))
      }));
      await expect(base.runtime.authenticateCredential({ credential: redeemed.credential }))
        .rejects.toMatchObject({ category: 'state-unavailable' });
    }
  });

  it('charges one logical pairing and ticket issuance despite token collisions', async () => {
    const collisionTokens = createDeterministicTokenFactory({
      pairingCodes: [pairing(1), pairing(1), pairing(2)],
      credentials: sequence(20, token, 2_000),
      tickets: [token(4_000), token(4_000), token(4_001)]
    });
    const base = fixture(1_000, collisionTokens);
    const firstPairing = await base.operator.issuePairing({ operatorScope: 'operator' });
    await base.operator.issuePairing({ operatorScope: 'operator' });
    const pairRate = base.rate.snapshot().find((row) => row.rowKey === 'rate:pair-issue');
    expect(JSON.parse(String(pairRate?.properties.events))).toHaveLength(2);
    const redeemed = await base.runtime.redeemPairing({
      pairingCode: firstPairing.pairingCode,
      trustedSource: trusted('source')
    });
    await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));
    await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));
    const ticketRate = base.rate.snapshot().find((row) => row.rowKey === 'rate:ticket-issue');
    expect(JSON.parse(String(ticketRate?.properties.events))).toHaveLength(2);
    expect(base.rate.snapshot().some((row) => row.rowKey === 'rate:reconnect')).toBe(false);
  });

  it('preserves quota, outage, and invalid-ticket categories', async () => {
    const outage = fixture();
    const { redeemed } = await enroll(outage);
    outage.rate.failNext('pointRead', 'unavailable');
    await expect(outage.runtime.issueSessionTicket(ticketRequest(redeemed.credential)))
      .rejects.toMatchObject({ category: 'state-unavailable' });
    await expect(outage.runtime.consumeSessionTicket(ticketConsume(token(9_999))))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
  });

  it('redeems one pairing exactly once across 100 concurrent calls', async () => {
    const base = fixture();
    const issued = await base.operator.issuePairing({ operatorScope: 'operator' });
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) =>
      base.runtime.redeemPairing({
        pairingCode: issued.pairingCode,
        trustedSource: trusted(`source-${index}`)
      })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(base.security.snapshot().filter((entity) => entity.properties.kind === 'installation')).toHaveLength(1);
  });

  it('consumes one ticket exactly once across 100 calls and returns the durable opening lease', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    const ticket = await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));
    const results = await Promise.allSettled(Array.from({ length: 100 }, () =>
      base.runtime.consumeSessionTicket(ticketConsume(ticket.ticket))));
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<SessionLease>).value).toMatchObject({
      installationId: redeemed.installationId,
      phase: 'opening',
      sessionEpoch: 1
    });
  });

  it('uses exact lease ETags for activation, heartbeat, expiry release, and end', async () => {
    const base = await activeFixture();
    expect(base.active.leaseVersion).toBe(base.opening.leaseVersion + 1);
    const renewed = await base.runtime.heartbeatSession({ lease: base.active });
    await expect(base.runtime.heartbeatSession({ lease: base.active }))
      .rejects.toMatchObject({ category: 'stale-lease' });
    await base.runtime.endSession({ lease: renewed });
    const next = await open(base, base.redeemed.credential);
    expect(next.opening.sessionEpoch).toBe(2);

    const expiring = await activeFixture();
    expiring.fake.advance(ACTIVE_LEASE_MS);
    const reopened = await open(expiring, expiring.redeemed.credential);
    expect(reopened.opening.sessionEpoch).toBe(2);
  });

  it('accepts heartbeat after the 20s scheduling interval while the 35s lease remains valid', async () => {
    const base = await activeFixture();
    base.fake.advance(20_001);
    await expect(base.runtime.heartbeatSession({ lease: base.active }))
      .resolves.toMatchObject({ phase: 'active' });
  });

  it('reconciles an ambiguous committed stable-session heartbeat by operation identity', async () => {
    const base = await activeFixture();
    base.security.failNext('transaction', 'ambiguous', true);
    await expect(base.runtime.heartbeatSession({ lease: base.active }))
      .resolves.toMatchObject({ leaseVersion: base.active.leaseVersion + 1 });
  });

  it('promotes rotation atomically and revocation returns invalidated stable session identity', async () => {
    const base = await activeFixture();
    const pending = await base.runtime.beginCredentialRotation({ credential: base.redeemed.credential });
    const promoted = await base.runtime.promoteCredential({ pendingCredential: pending.pendingCredential });
    expect(promoted).toMatchObject({
      credentialVersion: 2,
      invalidatedSession: {
        sessionId: base.active.sessionId,
        sessionEpoch: base.active.sessionEpoch
      }
    });
    await expect(base.runtime.heartbeatSession({ lease: base.active }))
      .rejects.toMatchObject({ category: 'stale-lease' });
    const next = await open(base, pending.pendingCredential);
    const revoked = await base.runtime.revokeInstallation({ installationId: base.redeemed.installationId });
    expect(revoked.invalidatedSession).toMatchObject({ sessionId: next.active.sessionId });
    await expect(base.runtime.authenticateCredential({ credential: pending.pendingCredential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
  });

  it('serializes promotion and revocation races without a partially active old session', async () => {
    const base = await activeFixture();
    const pending = await base.runtime.beginCredentialRotation({ credential: base.redeemed.credential });
    const raced = await Promise.allSettled([
      base.runtime.promoteCredential({ pendingCredential: pending.pendingCredential }),
      base.runtime.revokeInstallation({ installationId: base.redeemed.installationId })
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(base.runtime.heartbeatSession({ lease: base.active }))
      .rejects.toMatchObject({ category: 'stale-lease' });
  });

  it('enforces reconnect quotas across session epochs', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    const first = await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));
    await base.runtime.consumeSessionTicket(ticketConsume(first.ticket));
    for (let index = 0; index < 5; index += 1) {
      base.fake.advance(OPENING_LEASE_MS);
      const reconnect = await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));
      await base.runtime.consumeSessionTicket(ticketConsume(reconnect.ticket));
    }
    base.fake.advance(OPENING_LEASE_MS);
    const sixth = await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));
    await expect(base.runtime.consumeSessionTicket(ticketConsume(sixth.ticket)))
      .rejects.toMatchObject({ category: 'quota-exceeded' });
    base.fake.advance(60_000);
    const next = await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));
    const consumed = await base.runtime.consumeSessionTicket(ticketConsume(next.ticket));
    expect(consumed.sessionEpoch).toBe(7);
  });

  it('reserves durable offset grants with exact rolling sample and grant limits', async () => {
    const base = await activeFixture();
    const grants = [];
    const utteranceId = uuid(9_500) as never;
    for (let index = 0; index < MAX_AUDIO_GRANTS_PER_WINDOW; index += 1) {
      grants.push(await base.runtime.reserveAudio({
        lease: base.active,
        utteranceId,
        fromOriginalSampleOffset: index,
        originalSamples: 1
      }));
    }
    expect(grants[0]).toMatchObject({ fromOriginalSampleOffset: 0, throughOriginalSampleOffset: 1 });
    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId,
      fromOriginalSampleOffset: 100,
      originalSamples: 1
    })).rejects.toMatchObject({ category: 'quota-exceeded' });
    base.fake.advance(AUDIO_RESERVATION_WINDOW_MS);
    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId,
      fromOriginalSampleOffset: 100,
      originalSamples: 8_000
    })).resolves.toMatchObject({ throughOriginalSampleOffset: 8_100 });

    const samples = await activeFixture();
    await samples.runtime.reserveAudio({
      lease: samples.active,
      utteranceId: uuid(10_100) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 8_000
    });
    await samples.runtime.reserveAudio({
      lease: samples.active,
      utteranceId: uuid(10_100) as never,
      fromOriginalSampleOffset: 8_000,
      originalSamples: 8_000
    });
    await expect(samples.runtime.reserveAudio({
      lease: samples.active,
      utteranceId: uuid(10_100) as never,
      fromOriginalSampleOffset: 16_000,
      originalSamples: 1
    })).rejects.toMatchObject({ category: 'quota-exceeded' });
  });

  it('enforces one active utterance and exact contiguous durable audio offsets', async () => {
    const base = await activeFixture();
    const firstUtterance = uuid(9_600) as never;
    const secondUtterance = uuid(9_601) as never;
    await base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: firstUtterance,
      fromOriginalSampleOffset: 0,
      originalSamples: 100
    });
    for (const fromOriginalSampleOffset of [0, 99, 101]) {
      await expect(base.runtime.reserveAudio({
        lease: base.active,
        utteranceId: firstUtterance,
        fromOriginalSampleOffset,
        originalSamples: 1
      })).rejects.toMatchObject({ category: 'invalid-input' });
    }
    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: secondUtterance,
      fromOriginalSampleOffset: 0,
      originalSamples: 1
    })).rejects.toMatchObject({ category: 'invalid-input' });
    base.fake.advance(AUDIO_GRANT_TTL_MS);
    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: secondUtterance,
      fromOriginalSampleOffset: 1,
      originalSamples: 1
    })).rejects.toMatchObject({ category: 'invalid-input' });
    const next = await base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: secondUtterance,
      fromOriginalSampleOffset: 0,
      originalSamples: 50
    });
    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: secondUtterance,
      fromOriginalSampleOffset: next.throughOriginalSampleOffset,
      originalSamples: 50
    })).resolves.toMatchObject({ throughOriginalSampleOffset: 100 });
  });

  it('keeps the installation audio window across session epochs', async () => {
    const base = await activeFixture();
    const utterance = uuid(9_700) as never;
    await base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: utterance,
      fromOriginalSampleOffset: 0,
      originalSamples: 8_000
    });
    await base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: utterance,
      fromOriginalSampleOffset: 8_000,
      originalSamples: 8_000
    });
    await base.runtime.endSession({ lease: base.active });
    const next = await open(base, base.redeemed.credential);
    await expect(base.runtime.reserveAudio({
      lease: next.active,
      utteranceId: uuid(9_701) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 1
    })).rejects.toMatchObject({ category: 'quota-exceeded' });
    base.fake.advance(AUDIO_RESERVATION_WINDOW_MS);
    await expect(base.runtime.reserveAudio({
      lease: next.active,
      utteranceId: uuid(9_701) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 1
    })).resolves.toMatchObject({ throughOriginalSampleOffset: 1 });
  });

  it('cleans expired grants without deleting the active session sequence cursor', async () => {
    const base = await activeFixture();
    const utteranceId = uuid(9_800) as never;
    const first = await base.runtime.reserveAudio({
      lease: base.active,
      utteranceId,
      fromOriginalSampleOffset: 0,
      originalSamples: 100
    });
    base.fake.advance(AUDIO_GRANT_TTL_MS);
    await base.runtime.cleanupExpired({ limit: 10_000 });
    expect(base.rate.snapshot().some((row) => row.properties.kind === 'audio-grant')).toBe(false);
    expect(base.rate.snapshot().some((row) =>
      row.properties.kind === 'audio-window' && row.properties.window === 'audio-session')).toBe(true);
    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId,
      fromOriginalSampleOffset: 0,
      originalSamples: 1
    })).rejects.toMatchObject({ category: 'invalid-input' });
    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId,
      fromOriginalSampleOffset: first.throughOriginalSampleOffset,
      originalSamples: 1
    })).resolves.toMatchObject({ throughOriginalSampleOffset: 101 });
  });

  it('authorizes and starts generation at most once across 100 callers', async () => {
    const base = await activeFixture();
    const authorizations = await Promise.all(Array.from({ length: 100 }, () =>
      base.runtime.authorizeGeneration(correlation(base.active))));
    expect(authorizations.filter((result) => result.status === 'acquired')).toHaveLength(1);
    expect(authorizations.filter((result) => result.status === 'duplicate-in-flight')).toHaveLength(99);
    const claim = authorizations[0]?.claim;
    if (claim === undefined) throw new Error('missing claim');
    const starts = await Promise.all(Array.from({ length: 100 }, () => base.runtime.providerStart({ claim })));
    expect(starts.filter((result) => result.status === 'start-permitted')).toHaveLength(1);
    expect(starts.filter((result) => result.status === 'already-consumed')).toHaveLength(99);
    const permitted = starts.find((result) => result.status === 'start-permitted');
    if (permitted === undefined) throw new Error('missing start');
    const completed = await base.runtime.completeGeneration({ claim: permitted.claim, outcome: 'completed' });
    expect(completed.phase).toBe('completed');
    await expect(base.runtime.authorizeGeneration(correlation(base.active)))
      .resolves.toMatchObject({ status: 'duplicate-completed' });
  });

  it('consumes provider start but refuses permission when revocation wins the post-commit check', async () => {
    const base = await activeFixture();
    const authorization = await base.runtime.authorizeGeneration(correlation(base.active));
    base.rate.afterNextTransaction(async () => {
      await base.runtime.revokeInstallation({ installationId: base.redeemed.installationId });
    });
    const result = await base.runtime.providerStart({ claim: authorization.claim });
    expect(result.status).toBe('already-consumed');
    await expect(base.runtime.providerStart({ claim: authorization.claim }))
      .resolves.toMatchObject({ status: 'already-consumed' });
    await expect(base.runtime.releaseGeneration({ claim: result.claim }))
      .resolves.toMatchObject({ phase: 'released' });
  });

  it('idempotently releases an unstarted durable generation after session end', async () => {
    const base = await activeFixture();
    const authorization = await base.runtime.authorizeGeneration(correlation(base.active));
    await base.runtime.endSession({ lease: base.active });
    const released = await base.runtime.releaseGeneration({ claim: authorization.claim });
    expect(released.phase).toBe('released');
    await expect(base.runtime.releaseGeneration({ claim: authorization.claim })).resolves.toEqual(released);
  });

  it('validates durable session identity on completion and releases the old claim after rollover', async () => {
    const base = await activeFixture();
    const authorization = await base.runtime.authorizeGeneration(correlation(base.active));
    const started = await base.runtime.providerStart({ claim: authorization.claim });
    if (started.status !== 'start-permitted') throw new Error('provider start missing');
    await base.runtime.endSession({ lease: base.active });
    await open(base, base.redeemed.credential);
    await expect(base.runtime.completeGeneration({ claim: started.claim, outcome: 'completed' }))
      .rejects.toMatchObject({ category: 'generation-rejected' });
    await expect(base.runtime.releaseGeneration({
      claim: { ...started.claim, sessionId: uuid(9_999) as never }
    })).rejects.toMatchObject({ category: 'generation-rejected' });
    await expect(base.runtime.releaseGeneration({ claim: started.claim }))
      .resolves.toMatchObject({ phase: 'released' });
  });

  it('reconciles ambiguous committed writes and retries exact ETag conflicts without partial rows', async () => {
    const ambiguous = fixture();
    ambiguous.security.failNext('create', 'ambiguous', true);
    const issued = await ambiguous.operator.issuePairing({ operatorScope: 'operator' });
    expect(issued.pairingCode).toBe(pairing(1));

    const conflict = fixture();
    conflict.security.failNext('transaction', 'precondition-failed');
    const conflictIssue = await conflict.operator.issuePairing({ operatorScope: 'operator' });
    const redeemed = await conflict.runtime.redeemPairing({
      pairingCode: conflictIssue.pairingCode,
      trustedSource: trusted('source')
    });
    expect(redeemed.credentialVersion).toBe(1);
    expect(conflict.security.snapshot().filter((entity) => entity.properties.kind === 'installation')).toHaveLength(1);

    const rows = conflict.security.snapshot().slice(0, 2);
    if (rows.length !== 2 || rows[0] === undefined || rows[1] === undefined) throw new Error('missing rows');
    const before = conflict.security.snapshot();
    await expect(conflict.security.client.transaction([
      {
        type: 'replace',
        entity: Object.freeze({
          partitionKey: rows[0].partitionKey,
          rowKey: rows[0].rowKey,
          properties: rows[0].properties
        }),
        etag: rows[0].etag
      },
      {
        type: 'replace',
        entity: Object.freeze({
          partitionKey: rows[1].partitionKey,
          rowKey: rows[1].rowKey,
          properties: rows[1].properties
        }),
        etag: '"wrong-etag"'
      }
    ])).rejects.toMatchObject({ kind: 'precondition-failed' });
    expect(conflict.security.snapshot()).toEqual(before);
  });

  it('honors exact expiry and 30-day tombstone cleanup boundaries', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    await base.runtime.revokeInstallation({ installationId: redeemed.installationId });
    base.fake.advance(REVOCATION_TOMBSTONE_TTL_MS - 1);
    await base.runtime.cleanupExpired({ limit: 1_000 });
    expect(base.security.snapshot().some((entity) => entity.properties.kind === 'installation')).toBe(true);
    base.fake.advance(1);
    await base.runtime.cleanupExpired({ limit: 1_000 });
    expect(base.security.snapshot().some((entity) => entity.properties.kind === 'installation')).toBe(true);
    await base.runtime.cleanupExpired({ limit: 1_000 });
    expect(base.security.snapshot().some((entity) => entity.properties.kind === 'installation')).toBe(false);
    expect(base.security.snapshot().some((entity) => entity.properties.kind === 'session')).toBe(false);

    const expiry = fixture();
    const enrollment = await enroll(expiry);
    expiry.fake.advance(CREDENTIAL_ABSOLUTE_TTL_MS);
    await expect(expiry.runtime.authenticateCredential({ credential: enrollment.redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
  });

  it('rejects malformed schema and never includes row or secret content in errors', async () => {
    const base = fixture();
    const canary = 'CANARY-secret-content';
    base.security.insertRaw(Object.freeze({
      partitionKey: ENVIRONMENT,
      rowKey: `pair:${hashPairingCode(pairing(1))}`,
      properties: Object.freeze({
        schemaVersion: Number.MAX_SAFE_INTEGER,
        kind: 'pairing',
        environment: ENVIRONMENT,
        hash: hashPairingCode(pairing(1)),
        status: 'issued',
        issuedAt: 1_000,
        expiresAt: 2_000,
        content: canary
      })
    }));
    try {
      await base.runtime.redeemPairing({ pairingCode: pairing(1), trustedSource: trusted('source') });
      expect.fail('expected schema rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SecurityStateError);
      expect(String(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
    }
  });

  it('rejects legacy schema versions and extra persisted properties independently', async () => {
    const mutations = [
      (properties: AzureStoredEntity['properties']) => ({ ...properties, schemaVersion: 1 }),
      (properties: AzureStoredEntity['properties']) => ({ ...properties, unexpected: 'metadata' })
    ];
    for (const mutate of mutations) {
      const base = fixture();
      const issued = await base.operator.issuePairing({ operatorScope: 'operator' });
      const row = base.security.snapshot().find((entity) => entity.properties.kind === 'pairing');
      if (row === undefined) throw new Error('pairing row missing');
      base.security.insertRaw(Object.freeze({
        partitionKey: row.partitionKey,
        rowKey: row.rowKey,
        properties: Object.freeze(mutate(row.properties))
      }));
      await expect(base.runtime.redeemPairing({
        pairingCode: issued.pairingCode,
        trustedSource: trusted('source')
      })).rejects.toMatchObject({ category: 'state-unavailable' });
    }
  });

  it('uses generic ticket errors across audience mismatches and opening expiry', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    await expect(base.runtime.issueSessionTicket({
      ...ticketRequest(redeemed.credential),
      environment: LOCAL_MOCK_ENVIRONMENT
    })).rejects.toMatchObject({ category: 'invalid-ticket' });
    const ticket = await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));
    const opening = await base.runtime.consumeSessionTicket(ticketConsume(ticket.ticket));
    base.fake.advance(OPENING_LEASE_MS);
    await expect(base.runtime.activateSession({
      lease: opening,
      message: { type: 'session.start', protocolVersion: 1 }
    })).rejects.toMatchObject({ category: 'stale-lease' });
  });
});
