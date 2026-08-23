import { describe, expect, it } from 'vitest';

import {
  ACTIVE_LEASE_MS,
  AUDIO_GRANT_TTL_MS,
  AUDIO_RESERVATION_WINDOW_MS,
  AZURE_SECURITY_SCHEMA_VERSION,
  CLOCK_BACKWARDS_TOLERANCE_MS,
  CREDENTIAL_ABSOLUTE_TTL_MS,
  CREDENTIAL_IDLE_TTL_MS,
  LOCAL_MOCK_ENVIRONMENT,
  MAX_AUDIO_GRANTS_PER_WINDOW,
  MIN_AUDIO_GRANT_HANDOFF_MS,
  OPENING_LEASE_MS,
  REVOCATION_TOMBSTONE_TTL_MS,
  SecurityStateError,
  createAzureCliTableOperations,
  createAzureTableRuntimeStore,
  hashCorrelationKey,
  hashPairingCode,
  type HostTrustedOpaqueSource,
  type SecurityAudience,
  type SessionLease
} from '../src/index.js';
import {
  AzureTableBoundaryError,
  AZURE_CAS_ATTEMPTS,
  createAzureTableStoresForTesting,
  createAudioGrantMeter,
  createDeterministicIdFactory,
  createDeterministicTokenFactory,
  createFakeClock,
  createTestSecurityStateStore,
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

const AZURE_CLI_OPTIONS = Object.freeze({
  endpoint: 'https://palancarunit.table.core.windows.net',
  securityTableName: 'SecurityState',
  rateTableName: 'RateState',
  environment: ENVIRONMENT,
  audience: AUDIENCE
});

describe('Azure CLI operator capability boundary', () => {
  it('exposes only separated bootstrap, pairing, and maintenance capabilities', () => {
    const operations = createAzureCliTableOperations(AZURE_CLI_OPTIONS);
    expect(Object.keys(operations)).toEqual(['bootstrap', 'operator', 'maintenance']);
    expect(Object.keys(operations.bootstrap)).toEqual(['initializeState']);
    expect(Object.keys(operations.operator)).toEqual(['issuePairing', 'revokePairing']);
    expect(Object.keys(operations.maintenance)).toEqual(['checkReadiness', 'cleanupExpired']);
    expect('redeemPairing' in operations.operator).toBe(false);
    expect('issueSessionTicket' in operations.operator).toBe(false);
    expect('reserveAudio' in operations.maintenance).toBe(false);
    expect(Object.isFrozen(operations)).toBe(true);
  });

  it('accepts and normalizes the standard Azure endpoint trailing slash', () => {
    expect(() => createAzureCliTableOperations({
      ...AZURE_CLI_OPTIONS,
      endpoint: `${AZURE_CLI_OPTIONS.endpoint}/`
    })).not.toThrow();
  });

  it.each([
    {},
    { ...AZURE_CLI_OPTIONS, unexpected: true },
    { ...AZURE_CLI_OPTIONS, endpoint: 'http://palancarunit.table.core.windows.net' },
    { ...AZURE_CLI_OPTIONS, securityTableName: 'RateState' },
    { ...AZURE_CLI_OPTIONS, environment: 'INVALID' }
  ])('rejects invalid or expanded operator options', (options) => {
    expect(() => createAzureCliTableOperations(options as typeof AZURE_CLI_OPTIONS)).toThrow(
      new SecurityStateError('invalid-input')
    );
  });
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

function requiredRow(
  rows: readonly AzureStoredEntity[],
  kind: string,
  status?: string
): AzureStoredEntity {
  const row = rows.find((item) => item.properties.kind === kind &&
    (status === undefined || item.properties.status === status));
  if (row === undefined) throw new Error(`missing ${status === undefined ? kind : `${status} ${kind}`} row`);
  return row;
}

function expectExactReplacementTransaction(
  mutations: readonly AzureTableMutation[],
  beforeRows: readonly AzureStoredEntity[],
  expectedRows: readonly AzureStoredEntity[]
): void {
  expect(mutations).toHaveLength(expectedRows.length);
  expect(mutations.map((mutation) => mutation.entity.rowKey).sort())
    .toEqual(expectedRows.map((row) => row.rowKey).sort());
  for (const mutation of mutations) {
    expect(mutation.type).toBe('replace');
    expect(mutation.entity.partitionKey).toBe(ENVIRONMENT);
    const before = beforeRows.find((row) => row.partitionKey === mutation.entity.partitionKey &&
      row.rowKey === mutation.entity.rowKey);
    if (before === undefined || mutation.type !== 'replace') throw new Error('unexpected transaction mutation');
    expect(mutation.etag).toBe(before.etag);
  }
}

function requiredReplacement(
  mutations: readonly AzureTableMutation[],
  rowKey: string
): Extract<AzureTableMutation, { readonly type: 'replace' }> {
  const mutation = mutations.find((item) => item.type === 'replace' && item.entity.rowKey === rowKey);
  if (mutation === undefined || mutation.type !== 'replace') throw new Error(`missing replacement for ${rowKey}`);
  return mutation;
}

function fakeTable() {
  let rows = new Map<string, AzureStoredEntity>();
  let version = 0;
  const failures: Failure[] = [];
  let afterTransaction: (() => Promise<void>) | undefined;
  let beforeTransaction: (() => Promise<void>) | undefined;
  let afterPointRead: (() => Promise<void>) | undefined;
  const transactions: AzureTableMutation[][] = [];
  const key = (partitionKey: string, rowKey: string): string => `${partitionKey}\u0000${rowKey}`;
  const nextEtag = (): string => `"etag-${++version}"`;
  const takeFailure = (operation: Operation, after: boolean): void => {
    const index = failures.findIndex((item) => item.operation === operation && item.after === after);
    if (index >= 0) {
      const current = failures.splice(index, 1)[0];
      if (current === undefined) throw new Error('missing scheduled failure');
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
      const callback = afterPointRead;
      afterPointRead = undefined;
      if (callback !== undefined) await callback();
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
      const beforeCallback = beforeTransaction;
      beforeTransaction = undefined;
      if (beforeCallback !== undefined) await beforeCallback();
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
      transactions.push([...mutations]);
      const callback = afterTransaction;
      afterTransaction = undefined;
      if (callback !== undefined) await callback();
      takeFailure('transaction', true);
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
      failures.push({ operation, kind, after });
    },
    afterNextPointRead: (callback: () => Promise<void>): void => { afterPointRead = callback; },
    beforeNextTransaction: (callback: () => Promise<void>): void => { beforeTransaction = callback; },
    afterNextTransaction: (callback: () => Promise<void>): void => { afterTransaction = callback; },
    insertRaw: (entity: AzureNewEntity): void => { rows.set(key(entity.partitionKey, entity.rowKey), store(entity)); },
    deleteRaw: (partitionKey: string, rowKey: string): void => { rows.delete(key(partitionKey, rowKey)); },
    snapshot: (): readonly AzureStoredEntity[] => Object.freeze([...rows.values()].map(cloneEntity)),
    transactions: (): readonly (readonly AzureTableMutation[])[] => Object.freeze(transactions.map((item) => Object.freeze([...item])))
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

function keepSecurityRowContended(
  base: ReturnType<typeof fixture>,
  kind: string,
  status?: string
): void {
  const refresh = async (): Promise<void> => {
    const row = requiredRow(base.security.snapshot(), kind, status);
    base.security.insertRaw({
      partitionKey: row.partitionKey,
      rowKey: row.rowKey,
      properties: row.properties
    });
    base.security.beforeNextTransaction(refresh);
  };
  base.security.beforeNextTransaction(refresh);
}

function forceSecurityTransactionConflicts(
  base: ReturnType<typeof fixture>,
  callback: (attempt: number) => void | Promise<void>
): void {
  let attempt = 0;
  const prepare = async (): Promise<void> => {
    attempt += 1;
    await callback(attempt);
    base.security.failNext('transaction', 'precondition-failed');
    if (attempt < AZURE_CAS_ATTEMPTS) base.security.beforeNextTransaction(prepare);
  };
  base.security.beforeNextTransaction(prepare);
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

async function activeFixture(initialNow = 1_000) {
  const base = fixture(initialNow);
  const { redeemed } = await enroll(base);
  const opened = await open(base, redeemed.credential);
  return { ...base, redeemed, ...opened };
}

function audioRows(base: ReturnType<typeof fixture>): readonly AzureStoredEntity[] {
  return base.rate.snapshot().filter((row) =>
    row.properties.kind === 'audio-grant' || row.properties.kind === 'audio-window'
  );
}

function expectSingleAudioCharge(base: ReturnType<typeof fixture>): AzureStoredEntity {
  const rows = audioRows(base);
  const grants = rows.filter((row) => row.properties.kind === 'audio-grant');
  expect(grants).toHaveLength(1);
  const windows = rows.filter((row) => row.properties.kind === 'audio-window');
  expect(windows).toHaveLength(2);
  for (const window of windows) {
    const events = JSON.parse(String(window.properties.events)) as readonly {
      readonly at: number;
      readonly amount: number;
      readonly operationId: string;
    }[];
    expect(events).toHaveLength(1);
    expect(events[0]?.amount).toBe(100);
    expect(events[0]?.operationId).toBe(grants[0]?.properties.grantId);
  }
  return grants[0] as AzureStoredEntity;
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
  it('clamps small clock rollback without un-expiring state and fails closed beyond the tolerance', async () => {
    const base = await activeFixture(CLOCK_BACKWARDS_TOLERANCE_MS + 1_000);
    base.fake.advance(ACTIVE_LEASE_MS);
    const highWater = base.fake.now();
    await base.runtime.cleanupExpired({ limit: 100 });
    expect(requiredRow(base.security.snapshot(), 'session').properties).toMatchObject({ status: 'expired' });

    base.fake.set(highWater - CLOCK_BACKWARDS_TOLERANCE_MS + 1);
    await expect(base.runtime.cleanupExpired({ limit: 100 })).resolves.toBeDefined();
    expect(requiredRow(base.security.snapshot(), 'session').properties).toMatchObject({ status: 'expired' });
    const clamped = await base.operator.issuePairing({ operatorScope: 'operator' });
    expect(clamped.issuedAt).toBe(highWater);

    base.fake.set(highWater - CLOCK_BACKWARDS_TOLERANCE_MS - 1);
    await expect(base.runtime.cleanupExpired({ limit: 100 }))
      .rejects.toMatchObject({ category: 'state-unavailable' });

    base.fake.set(highWater);
    expect(requiredRow(base.security.snapshot(), 'session').properties).toMatchObject({ status: 'expired' });
    base.fake.advance(1);
    const advanced = await base.operator.issuePairing({ operatorScope: 'operator' });
    expect(advanced.issuedAt).toBe(highWater + 1);
  });

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

  it('reports state-unavailable after persistent ticket issue ETag contention', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    keepSecurityRowContended(base, 'credential', 'current');

    await expect(base.runtime.issueSessionTicket(ticketRequest(redeemed.credential)))
      .rejects.toMatchObject({ category: 'state-unavailable' });
  });

  it('reports state-unavailable after persistent ticket consume ETag contention while invalid tickets stay invalid', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    const ticket = await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));

    await expect(base.runtime.consumeSessionTicket(ticketConsume(token(9_999))))
      .rejects.toMatchObject({ category: 'invalid-ticket' });

    keepSecurityRowContended(base, 'ticket', 'issued');
    await expect(base.runtime.consumeSessionTicket(ticketConsume(ticket.ticket)))
      .rejects.toMatchObject({ category: 'state-unavailable' });
  });

  it('reports invalid-ticket when ticket issuance authentication becomes invalid during retries', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    forceSecurityTransactionConflicts(base, (attempt) => {
      const row = requiredRow(base.security.snapshot(), 'credential', 'current');
      base.security.insertRaw({
        partitionKey: row.partitionKey,
        rowKey: row.rowKey,
        properties: attempt === 2 ? { ...row.properties, status: 'revoked' } : row.properties
      });
    });

    await expect(base.runtime.issueSessionTicket(ticketRequest(redeemed.credential)))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
  });

  it('reports invalid-ticket when the final ticket-issue conflict observes a revoked installation', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    forceSecurityTransactionConflicts(base, (attempt) => {
      const row = requiredRow(base.security.snapshot(), 'installation', 'active');
      base.security.insertRaw({
        partitionKey: row.partitionKey,
        rowKey: row.rowKey,
        properties: attempt === AZURE_CAS_ATTEMPTS
          ? { ...row.properties, status: 'revoked', revokedAt: base.fake.now() }
          : row.properties
      });
    });

    await expect(base.runtime.issueSessionTicket(ticketRequest(redeemed.credential)))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
  });

  it('reports invalid-ticket when the final ticket-consume conflict observes an invalidated installation', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    const ticket = await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));
    forceSecurityTransactionConflicts(base, (attempt) => {
      const row = requiredRow(base.security.snapshot(), 'installation', 'active');
      base.security.insertRaw({
        partitionKey: row.partitionKey,
        rowKey: row.rowKey,
        properties: attempt === AZURE_CAS_ATTEMPTS
          ? { ...row.properties, status: 'revoked', revokedAt: base.fake.now() }
          : row.properties
      });
    });

    await expect(base.runtime.consumeSessionTicket(ticketConsume(ticket.ticket)))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
  });

  it('reports invalid-ticket when the final ticket-consume conflict observes a deleted ticket', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    const ticket = await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));
    forceSecurityTransactionConflicts(base, (attempt) => {
      if (attempt !== AZURE_CAS_ATTEMPTS) return;
      const row = requiredRow(base.security.snapshot(), 'ticket', 'issued');
      base.security.deleteRaw(row.partitionKey, row.rowKey);
    });

    await expect(base.runtime.consumeSessionTicket(ticketConsume(ticket.ticket)))
      .rejects.toMatchObject({ category: 'invalid-ticket' });
  });

  it('reports state-unavailable when ticket-issue final reconciliation cannot be read', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    forceSecurityTransactionConflicts(base, (attempt) => {
      const row = requiredRow(base.security.snapshot(), 'credential', 'current');
      base.security.insertRaw({
        partitionKey: row.partitionKey,
        rowKey: row.rowKey,
        properties: row.properties
      });
      if (attempt === AZURE_CAS_ATTEMPTS) base.security.failNext('pointRead', 'unavailable');
    });

    await expect(base.runtime.issueSessionTicket(ticketRequest(redeemed.credential)))
      .rejects.toMatchObject({ category: 'state-unavailable' });
  });

  it('reports state-unavailable when ticket-consume final reconciliation cannot be read', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    const ticket = await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));
    forceSecurityTransactionConflicts(base, (attempt) => {
      const row = requiredRow(base.security.snapshot(), 'installation', 'active');
      base.security.insertRaw({
        partitionKey: row.partitionKey,
        rowKey: row.rowKey,
        properties: row.properties
      });
      if (attempt === AZURE_CAS_ATTEMPTS) base.security.failNext('pointRead', 'unavailable');
    });

    await expect(base.runtime.consumeSessionTicket(ticketConsume(ticket.ticket)))
      .rejects.toMatchObject({ category: 'state-unavailable' });
  });

  it('reports state-unavailable when ticket-consume exhaustion re-read cannot be read', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    const ticket = await base.runtime.issueSessionTicket(ticketRequest(redeemed.credential));
    forceSecurityTransactionConflicts(base, (attempt) => {
      const row = requiredRow(base.security.snapshot(), 'installation', 'active');
      base.security.insertRaw({
        partitionKey: row.partitionKey,
        rowKey: row.rowKey,
        properties: row.properties
      });
      if (attempt === AZURE_CAS_ATTEMPTS) {
        base.security.afterNextPointRead(async () => {
          base.security.failNext('pointRead', 'unavailable');
        });
      }
    });

    await expect(base.runtime.consumeSessionTicket(ticketConsume(ticket.ticket)))
      .rejects.toMatchObject({ category: 'state-unavailable' });
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

  it('provides retry-safe promotion and credential-authenticated revocation semantics', async () => {
    const base = await activeFixture();
    const pending = await base.runtime.beginCredentialRotation({ credential: base.redeemed.credential });
    await expect(base.runtime.beginCredentialRotation({ credential: base.redeemed.credential }))
      .rejects.toMatchObject({ category: 'credential-conflict' });
    const promoted = await base.runtime.promoteCredential({ pendingCredential: pending.pendingCredential });
    expect(promoted).toMatchObject({
      status: 'promoted',
      confirmedAt: base.fake.now(),
      idleExpiresAt: base.fake.now() + CREDENTIAL_IDLE_TTL_MS,
      absoluteExpiresAt: base.redeemed.absoluteExpiresAt,
      invalidatedSession: {
        installationId: base.active.installationId,
        sessionId: base.active.sessionId,
        sessionEpoch: base.active.sessionEpoch
      }
    });
    expect(Object.isFrozen(promoted)).toBe(true);
    expect(Object.isFrozen(promoted.invalidatedSession)).toBe(true);
    base.fake.advance(1);
    const replay = await base.runtime.promoteCredential({ pendingCredential: pending.pendingCredential });
    expect(replay).toMatchObject({
      status: 'already-promoted',
      confirmedAt: base.fake.now(),
      idleExpiresAt: base.fake.now() + CREDENTIAL_IDLE_TTL_MS,
      absoluteExpiresAt: base.redeemed.absoluteExpiresAt
    });
    expect(replay.invalidatedSession).toBeUndefined();

    const revokedBase = await activeFixture();
    const firstRevocation = await revokedBase.runtime.revokeCurrentInstallation({
      credential: revokedBase.redeemed.credential
    });
    expect(firstRevocation).toMatchObject({
      status: 'revoked',
      revokedAt: revokedBase.fake.now(),
      tombstoneVersion: 2,
      invalidatedSession: { sessionId: revokedBase.active.sessionId }
    });
    const replayRevocation = await revokedBase.runtime.revokeCurrentInstallation({
      credential: revokedBase.redeemed.credential
    });
    expect(replayRevocation).toMatchObject({
      status: 'already-revoked',
      revokedAt: firstRevocation.revokedAt,
      tombstoneVersion: firstRevocation.tombstoneVersion,
      invalidatedSession: firstRevocation.invalidatedSession
    });
    const other = storesForAudience(revokedBase, OTHER_AUDIENCE);
    await expect(other.runtime.revokeCurrentInstallation({ credential: revokedBase.redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });

    const ambiguousPromotion = fixture();
    const ambiguousEnrollment = await enroll(ambiguousPromotion);
    const ambiguousPending = await ambiguousPromotion.runtime.beginCredentialRotation({
      credential: ambiguousEnrollment.redeemed.credential
    });
    ambiguousPromotion.security.failNext('transaction', 'ambiguous', true);
    await expect(ambiguousPromotion.runtime.promoteCredential({
      pendingCredential: ambiguousPending.pendingCredential
    })).resolves.toMatchObject({ status: 'promoted', credentialVersion: 2 });

    const ambiguousRevocation = fixture();
    const ambiguousRevocationEnrollment = await enroll(ambiguousRevocation);
    ambiguousRevocation.security.failNext('transaction', 'ambiguous', true);
    await expect(ambiguousRevocation.runtime.revokeCurrentInstallation({
      credential: ambiguousRevocationEnrollment.redeemed.credential
    })).resolves.toMatchObject({ status: 'revoked', tombstoneVersion: 2 });
  });

  it('replaces an expired pending credential at the exact fake-Azure boundary', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    const first = await base.runtime.beginCredentialRotation({ credential: redeemed.credential });
    base.fake.advance(first.pendingExpiresAt - base.fake.now() - 1);
    await expect(base.runtime.beginCredentialRotation({ credential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'credential-conflict' });
    expect(base.security.snapshot().filter((row) =>
      row.properties.kind === 'credential' && row.properties.status === 'pending')).toHaveLength(1);
    base.fake.advance(1);
    const second = await base.runtime.beginCredentialRotation({ credential: redeemed.credential });
    expect(second.pendingCredentialVersion).toBe(first.pendingCredentialVersion);
    const credentials = base.security.snapshot().filter((row) => row.properties.kind === 'credential');
    expect(credentials.filter((row) => row.properties.status === 'pending')).toHaveLength(1);
    expect(credentials.some((row) => row.properties.status === 'expired')).toBe(true);
    expect(credentials.filter((row) => row.properties.status === 'pending')[0]?.properties.pendingExpiresAt)
      .toBe(second.pendingExpiresAt);
  });

  it('rejects invalid lifecycle credentials and keeps canaries out of public errors', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    const pending = await base.runtime.beginCredentialRotation({ credential: redeemed.credential });
    await expect(base.runtime.promoteCredential({ pendingCredential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    await expect(base.runtime.revokeCurrentInstallation({ credential: pending.pendingCredential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    await expect(base.runtime.promoteCredential({ pendingCredential: token(99_999) }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    try {
      await base.runtime.promoteCredential({ pendingCredential: 'CANARY-credential-value' });
      expect.fail('expected malformed credential rejection');
    } catch (error) {
      expect(error).toMatchObject({ category: 'invalid-credential' });
      expect(String(error)).not.toContain('CANARY-credential-value');
      expect(error instanceof Error ? error.stack : '').not.toContain('CANARY-credential-value');
      expect(JSON.stringify(error)).not.toContain('CANARY-credential-value');
    }
    await base.runtime.promoteCredential({ pendingCredential: pending.pendingCredential });
    await expect(base.runtime.revokeCurrentInstallation({ credential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });

    const expired = fixture();
    const expiredEnrollment = await enroll(expired);
    const expiredPending = await expired.runtime.beginCredentialRotation({ credential: expiredEnrollment.redeemed.credential });
    expired.fake.advance(expiredPending.pendingExpiresAt - expired.fake.now());
    await expect(expired.runtime.promoteCredential({ pendingCredential: expiredPending.pendingCredential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });

    const revoked = fixture();
    const revokedEnrollment = await enroll(revoked);
    await revoked.runtime.revokeCurrentInstallation({ credential: revokedEnrollment.redeemed.credential });
    await expect(revoked.runtime.promoteCredential({ pendingCredential: revokedEnrollment.redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
    expect(JSON.stringify(base.security.snapshot())).not.toContain('CANARY-credential-value');
  });

  it.each([
    {
      name: 'malformed revocation',
      exercise: async (): Promise<unknown> => fixture().runtime.revokeCurrentInstallation({
        credential: 'not-a-credential'
      })
    },
    {
      name: 'expired-current revocation',
      exercise: async (): Promise<unknown> => {
        const base = fixture();
        const { redeemed } = await enroll(base);
        base.fake.advance(CREDENTIAL_IDLE_TTL_MS);
        return base.runtime.revokeCurrentInstallation({ credential: redeemed.credential });
      }
    },
    {
      name: 'retired promotion',
      exercise: async (): Promise<unknown> => {
        const base = fixture();
        const { redeemed } = await enroll(base);
        const pending = await base.runtime.beginCredentialRotation({ credential: redeemed.credential });
        await base.runtime.promoteCredential({ pendingCredential: pending.pendingCredential });
        expect(base.security.snapshot().find((row) =>
          row.properties.kind === 'credential' && row.properties.version === 1)?.properties.status).toBe('retired');
        return base.runtime.promoteCredential({ pendingCredential: redeemed.credential });
      }
    },
    {
      name: 'unrelated-revoked revocation',
      exercise: async (): Promise<unknown> => {
        const base = fixture();
        const { redeemed } = await enroll(base);
        const pending = await base.runtime.beginCredentialRotation({ credential: redeemed.credential });
        await base.runtime.revokeCurrentInstallation({ credential: redeemed.credential });
        const rows = base.security.snapshot();
        const revokedPending = rows.find((row) => row.properties.kind === 'credential' &&
          row.properties.version === pending.pendingCredentialVersion);
        expect(revokedPending?.properties.status).toBe('revoked');
        expect(requiredRow(rows, 'installation').properties.currentCredentialHash)
          .not.toBe(revokedPending?.properties.hash);
        return base.runtime.revokeCurrentInstallation({ credential: pending.pendingCredential });
      }
    },
    {
      name: 'active wrong-audience revocation',
      exercise: async (): Promise<unknown> => {
        const base = fixture();
        const { redeemed } = await enroll(base);
        return storesForAudience(base, OTHER_AUDIENCE).runtime.revokeCurrentInstallation({
          credential: redeemed.credential
        }).finally(() => {
          expect(requiredRow(base.security.snapshot(), 'installation').properties.status).toBe('active');
        });
      }
    }
  ])('rejects $name with invalid-credential', async ({ exercise }) => {
    await expect(exercise()).rejects.toMatchObject({ category: 'invalid-credential' });
  });

  it('keeps revocation credential canaries out of errors and fake-boundary diagnostics', async () => {
    const base = fixture();
    const beforeRows = base.security.snapshot();
    const beforeTransactions = base.security.transactions();
    const canary = 'CANARY-revocation-credential';
    try {
      await base.runtime.revokeCurrentInstallation({ credential: canary });
      expect.fail('expected malformed revocation rejection');
    } catch (error) {
      expect(error).toMatchObject({ category: 'invalid-credential' });
      expect(String(error)).not.toContain(canary);
      expect(error instanceof Error ? error.stack : '').not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
    }
    expect(base.security.snapshot()).toEqual(beforeRows);
    expect(base.security.transactions()).toEqual(beforeTransactions);
    expect(JSON.stringify([base.security.snapshot(), base.security.transactions()])).not.toContain(canary);
  });

  it('caps refreshed fake-Azure idle expiry at absolute expiry', async () => {
    const base = fixture();
    const { redeemed } = await enroll(base);
    while (base.fake.now() + CREDENTIAL_IDLE_TTL_MS < redeemed.absoluteExpiresAt) {
      const remaining = redeemed.absoluteExpiresAt - base.fake.now();
      base.fake.advance(Math.min(CREDENTIAL_IDLE_TTL_MS - 1, remaining - CREDENTIAL_IDLE_TTL_MS));
      await base.runtime.authenticateCredential({ credential: redeemed.credential });
    }
    base.fake.advance(redeemed.absoluteExpiresAt - base.fake.now() - 1);
    await expect(base.runtime.authenticateCredential({ credential: redeemed.credential }))
      .resolves.toMatchObject({ idleExpiresAt: redeemed.absoluteExpiresAt });
    base.fake.advance(1);
    await expect(base.runtime.authenticateCredential({ credential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'invalid-credential' });
  });

  it('uses the exact promotion mutation set and original ETags', async () => {
    const promotion = await activeFixture();
    const pending = await promotion.runtime.beginCredentialRotation({ credential: promotion.redeemed.credential });
    const beforeRows = promotion.security.snapshot();
    const installationRow = requiredRow(beforeRows, 'installation');
    const currentRow = requiredRow(beforeRows, 'credential', 'current');
    const pendingRow = requiredRow(beforeRows, 'credential', 'pending');
    const sessionRow = requiredRow(beforeRows, 'session');
    expect(installationRow.rowKey).toBe(`installation:${promotion.redeemed.installationId}`);
    expect(sessionRow.rowKey).toBe(`session:${promotion.redeemed.installationId}`);
    expect(currentRow.rowKey).toBe(`credential:${String(currentRow.properties.hash)}`);
    expect(pendingRow.rowKey).toBe(`credential:${String(pendingRow.properties.hash)}`);
    const beforeTransactionCount = promotion.security.transactions().length;
    await promotion.runtime.promoteCredential({ pendingCredential: pending.pendingCredential });
    const operationTransactions = promotion.security.transactions().slice(beforeTransactionCount);
    expect(operationTransactions).toHaveLength(1);
    const mutations = operationTransactions[0];
    if (mutations === undefined) throw new Error('promotion transaction missing');
    expectExactReplacementTransaction(
      mutations,
      beforeRows,
      [installationRow, currentRow, pendingRow, sessionRow]
    );
    const promotionOperation = hashCorrelationKey(uuid(6_004));
    expect(requiredReplacement(mutations, currentRow.rowKey).entity.properties.status).toBe('retired');
    expect(requiredReplacement(mutations, pendingRow.rowKey).entity.properties.status).toBe('current');
    expect(requiredReplacement(mutations, installationRow.rowKey).entity.properties).toMatchObject({
      status: 'active',
      currentCredentialHash: pendingRow.properties.hash,
      currentCredentialVersion: pendingRow.properties.version
    });
    expect(requiredReplacement(mutations, installationRow.rowKey).entity.properties)
      .not.toHaveProperty('pendingCredentialHash');
    expect(requiredReplacement(mutations, sessionRow.rowKey).entity.properties)
      .toMatchObject({ lastOperationId: promotionOperation });
  });

  it('uses the exact revocation mutation set and original ETags without a pending credential', async () => {
    const revocation = await activeFixture();
    const beforeRows = revocation.security.snapshot();
    const installationRow = requiredRow(beforeRows, 'installation');
    const currentRow = requiredRow(beforeRows, 'credential', 'current');
    const sessionRow = requiredRow(beforeRows, 'session');
    expect(installationRow.rowKey).toBe(`installation:${revocation.redeemed.installationId}`);
    expect(sessionRow.rowKey).toBe(`session:${revocation.redeemed.installationId}`);
    expect(currentRow.rowKey).toBe(`credential:${String(currentRow.properties.hash)}`);
    const beforeTransactionCount = revocation.security.transactions().length;
    await revocation.runtime.revokeCurrentInstallation({ credential: revocation.redeemed.credential });
    const operationTransactions = revocation.security.transactions().slice(beforeTransactionCount);
    expect(operationTransactions).toHaveLength(1);
    const mutations = operationTransactions[0];
    if (mutations === undefined) throw new Error('revocation transaction missing');
    expectExactReplacementTransaction(mutations, beforeRows, [installationRow, currentRow, sessionRow]);
    const revocationOperation = hashCorrelationKey(uuid(6_004));
    expect(requiredReplacement(mutations, installationRow.rowKey).entity.properties).toMatchObject({
      status: 'revoked',
      currentCredentialHash: currentRow.properties.hash
    });
    expect(requiredReplacement(mutations, currentRow.rowKey).entity.properties.status).toBe('revoked');
    expect(requiredReplacement(mutations, sessionRow.rowKey).entity.properties)
      .toMatchObject({ status: 'revoked', lastOperationId: revocationOperation });
  });

  it('uses the exact revocation mutation set and original ETags with a pending credential', async () => {
    const revocation = await activeFixture();
    await revocation.runtime.beginCredentialRotation({ credential: revocation.redeemed.credential });
    const beforeRows = revocation.security.snapshot();
    const installationRow = requiredRow(beforeRows, 'installation');
    const currentRow = requiredRow(beforeRows, 'credential', 'current');
    const pendingRow = requiredRow(beforeRows, 'credential', 'pending');
    const sessionRow = requiredRow(beforeRows, 'session');
    expect(installationRow.rowKey).toBe(`installation:${revocation.redeemed.installationId}`);
    expect(sessionRow.rowKey).toBe(`session:${revocation.redeemed.installationId}`);
    expect(currentRow.rowKey).toBe(`credential:${String(currentRow.properties.hash)}`);
    expect(pendingRow.rowKey).toBe(`credential:${String(pendingRow.properties.hash)}`);
    const beforeTransactionCount = revocation.security.transactions().length;
    await revocation.runtime.revokeCurrentInstallation({ credential: revocation.redeemed.credential });
    const operationTransactions = revocation.security.transactions().slice(beforeTransactionCount);
    expect(operationTransactions).toHaveLength(1);
    const mutations = operationTransactions[0];
    if (mutations === undefined) throw new Error('pending revocation transaction missing');
    expectExactReplacementTransaction(
      mutations,
      beforeRows,
      [installationRow, currentRow, pendingRow, sessionRow]
    );
    const revocationOperation = hashCorrelationKey(uuid(6_004));
    expect(requiredReplacement(mutations, installationRow.rowKey).entity.properties.status).toBe('revoked');
    expect(requiredReplacement(mutations, currentRow.rowKey).entity.properties.status).toBe('revoked');
    expect(requiredReplacement(mutations, pendingRow.rowKey).entity.properties.status).toBe('revoked');
    expect(requiredReplacement(mutations, sessionRow.rowKey).entity.properties)
      .toMatchObject({ status: 'revoked', lastOperationId: revocationOperation });
  });

  it('returns replay status when contention commits before the tested transaction is ambiguous', async () => {
    const promotion = await activeFixture();
    const pending = await promotion.runtime.beginCredentialRotation({ credential: promotion.redeemed.credential });
    let competingPromotion: Awaited<ReturnType<typeof promotion.runtime.promoteCredential>> | undefined;
    promotion.security.beforeNextTransaction(async () => {
      competingPromotion = await promotion.runtime.promoteCredential({ pendingCredential: pending.pendingCredential });
      promotion.security.failNext('transaction', 'ambiguous');
    });
    const testedPromotion = await promotion.runtime.promoteCredential({ pendingCredential: pending.pendingCredential });
    expect(competingPromotion).toMatchObject({ status: 'promoted' });
    expect(testedPromotion).toMatchObject({ status: 'already-promoted' });

    const revocation = await activeFixture();
    let competingRevocation: Awaited<ReturnType<typeof revocation.runtime.revokeCurrentInstallation>> | undefined;
    revocation.security.beforeNextTransaction(async () => {
      competingRevocation = await revocation.runtime.revokeCurrentInstallation({
        credential: revocation.redeemed.credential
      });
      revocation.security.failNext('transaction', 'ambiguous');
    });
    const testedRevocation = await revocation.runtime.revokeCurrentInstallation({
      credential: revocation.redeemed.credential
    });
    expect(competingRevocation).toMatchObject({ status: 'revoked' });
    expect(testedRevocation).toMatchObject({ status: 'already-revoked' });
  });

  it('serializes 100 fake-Azure rotation and credential-revocation contenders', async () => {
    const rotation = fixture();
    const { redeemed } = await enroll(rotation);
    const beginnings = await Promise.allSettled(Array.from({ length: 100 }, () =>
      rotation.runtime.beginCredentialRotation({ credential: redeemed.credential })));
    expect(beginnings.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(beginnings.filter((item) => item.status === 'rejected' &&
      (item.reason as SecurityStateError).category === 'credential-conflict')).toHaveLength(99);
    const winner = beginnings.find((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof rotation.runtime.beginCredentialRotation>>> =>
      item.status === 'fulfilled');
    if (winner === undefined) throw new Error('fake-Azure rotation winner missing');
    const promotions = await Promise.allSettled(Array.from({ length: 100 }, () =>
      rotation.runtime.promoteCredential({ pendingCredential: winner.value.pendingCredential })));
    expect(promotions.filter((item) => item.status === 'fulfilled')).toHaveLength(100);
    expect(promotions.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof rotation.runtime.promoteCredential>>> =>
      item.status === 'fulfilled' && item.value.status === 'promoted')).toHaveLength(1);
    expect(promotions.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof rotation.runtime.promoteCredential>>> =>
      item.status === 'fulfilled' && item.value.status === 'already-promoted')).toHaveLength(99);

    const revocation = fixture();
    const enrolled = await enroll(revocation);
    const revocations = await Promise.allSettled(Array.from({ length: 100 }, () =>
      revocation.runtime.revokeCurrentInstallation({ credential: enrolled.redeemed.credential })));
    expect(revocations.filter((item) => item.status === 'fulfilled')).toHaveLength(100);
    expect(revocations.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof revocation.runtime.revokeCurrentInstallation>>> =>
      item.status === 'fulfilled' && item.value.status === 'revoked')).toHaveLength(1);
    expect(revocations.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof revocation.runtime.revokeCurrentInstallation>>> =>
      item.status === 'fulfilled' && item.value.status === 'already-revoked')).toHaveLength(99);
    expect(revocation.security.snapshot().find((row) => row.properties.kind === 'installation')?.properties.tombstoneVersion)
      .toBe(2);
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

  it.each([
    { winner: 'promotion' as const },
    { winner: 'revocation' as const }
  ])('serializes the fake-Azure promotion/revocation race when $winner commits first', async ({ winner }) => {
    const base = await activeFixture();
    const pending = await base.runtime.beginCredentialRotation({ credential: base.redeemed.credential });
    let winningStatus: 'promoted' | 'revoked' | undefined;
    if (winner === 'promotion') {
      base.security.beforeNextTransaction(async () => {
        winningStatus = (await base.runtime.promoteCredential({
          pendingCredential: pending.pendingCredential
        })).status as 'promoted';
      });
      await expect(base.runtime.revokeCurrentInstallation({ credential: base.redeemed.credential }))
        .rejects.toMatchObject({ category: 'invalid-credential' });
    } else {
      base.security.beforeNextTransaction(async () => {
        winningStatus = (await base.runtime.revokeCurrentInstallation({
          credential: base.redeemed.credential
        })).status as 'revoked';
      });
      await expect(base.runtime.promoteCredential({ pendingCredential: pending.pendingCredential }))
        .rejects.toMatchObject({ category: 'invalid-credential' });
    }
    expect(winningStatus).toBe(winner === 'promotion' ? 'promoted' : 'revoked');
    expect(base.security.snapshot().find((row) => row.properties.kind === 'installation')?.properties.activeSessionId)
      .toBeUndefined();
    expect(base.security.snapshot().find((row) => row.properties.kind === 'installation')?.properties.status)
      .toBe(winner === 'promotion' ? 'active' : 'revoked');
    expect(base.security.snapshot()
      .filter((row) => row.properties.kind === 'session')
      .every((row) => !['opening', 'active'].includes(String(row.properties.status)))).toBe(true);
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

  it.each(['conflict', 'precondition-failed'] as const)(
    'retries the same Azure audio grant operation after a noncommit %s boundary',
    async (boundaryKind) => {
      const base = await activeFixture();
      base.rate.failNext('transaction', boundaryKind);

      const grant = await base.runtime.reserveAudio({
        lease: base.active,
        utteranceId: uuid(9_499) as never,
        fromOriginalSampleOffset: 0,
        originalSamples: 100
      });

      expect(base.rate.transactions()).toHaveLength(1);
      const grantRow = expectSingleAudioCharge(base);
      expect(grantRow.rowKey).toBe(`audio-grant:${grant.grantId}`);
      expect(grantRow.properties.grantId).toBe(grant.grantId);
      expect(grant).toMatchObject({
        utteranceId: uuid(9_499),
        issuedAt: 1_000,
        expiresAt: 2_000,
        reservedOriginalSamples: 100
      });
    }
  );

  it('anchors Azure audio grants after preflight reads and accepts exactly 500ms of handoff', async () => {
    const base = await activeFixture();
    base.security.afterNextPointRead(async () => { base.fake.advance(300); });
    base.rate.afterNextPointRead(async () => { base.fake.advance(300); });
    base.rate.afterNextTransaction(async () => { base.fake.advance(500); });

    const grant = await base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: uuid(9_500) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 100
    });
    expect(MIN_AUDIO_GRANT_HANDOFF_MS).toBe(500);
    expect(base.fake.now()).toBe(2_100);
    expect(grant).toMatchObject({ issuedAt: 1_600, expiresAt: 2_600 });
    expect(grant.expiresAt - base.fake.now()).toBe(MIN_AUDIO_GRANT_HANDOFF_MS);

    const preFixMeter = createAudioGrantMeter({
      grant: { ...grant, issuedAt: 1_000, expiresAt: 2_000 },
      clock: base.fake.clock
    });
    let preFixError: unknown;
    try {
      preFixMeter.accept({ fromOriginalSampleOffset: 0, throughOriginalSampleOffset: 100 });
    } catch (error) {
      preFixError = error;
    }
    expect(preFixError).toMatchObject({ category: 'stale-lease' });

    const fixedMeter = createAudioGrantMeter({ grant, clock: base.fake.clock });
    expect(fixedMeter.accept({ fromOriginalSampleOffset: 0, throughOriginalSampleOffset: 100 }))
      .toMatchObject({ acceptedThroughOriginalSampleOffset: 100, complete: true });

    expect(base.rate.transactions()).toHaveLength(1);
    const grantRow = base.rate.snapshot().find((row) => row.properties.kind === 'audio-grant');
    expect(grantRow).toMatchObject({
      properties: { issuedAt: 1_600, expiresAt: 2_600, throughOriginalSampleOffset: 100 }
    });
    const windows = base.rate.snapshot().filter((row) => row.properties.kind === 'audio-window');
    expect(windows).toHaveLength(2);
    expect(windows.every((row) =>
      row.properties.retainUntil === 2_600 &&
      row.properties.activeGrantExpiresAt === 2_600 &&
      row.properties.nextOriginalSampleOffset === 100
    )).toBe(true);
    expect(windows.every((row) => JSON.parse(String(row.properties.events)).length === 1)).toBe(true);
    expect(windows.every((row) => JSON.parse(String(row.properties.events))[0].at === 1_600)).toBe(true);
  });

  it('retains the committed Azure reservation and cursor when handoff has only 499ms left', async () => {
    const base = await activeFixture();
    base.security.afterNextPointRead(async () => { base.fake.advance(300); });
    base.rate.afterNextPointRead(async () => { base.fake.advance(300); });
    base.rate.afterNextTransaction(async () => { base.fake.advance(501); });

    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: uuid(9_501) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 100
    })).rejects.toMatchObject({ category: 'state-unavailable' });
    expect(base.fake.now()).toBe(2_101);
    expect(base.rate.transactions()).toHaveLength(1);
    const rows = audioRows(base);
    expect(rows.filter((row) => row.properties.kind === 'audio-grant')).toHaveLength(1);
    const windows = rows.filter((row) => row.properties.kind === 'audio-window');
    expect(windows).toHaveLength(2);
    expect(windows.every((row) =>
      row.properties.retainUntil === 2_600 &&
      row.properties.activeGrantExpiresAt === 2_600 &&
      row.properties.nextOriginalSampleOffset === 100
    )).toBe(true);
    expect(windows.every((row) => {
      const events = JSON.parse(String(row.properties.events));
      return events.length === 1 && events[0].at === 1_600 && events[0].amount === 100;
    })).toBe(true);
  });

  it('leaves one ambiguous committed Azure reservation when handoff has only 499ms left', async () => {
    const base = await activeFixture();
    base.security.afterNextPointRead(async () => { base.fake.advance(300); });
    base.rate.afterNextPointRead(async () => { base.fake.advance(300); });
    base.rate.afterNextTransaction(async () => { base.fake.advance(501); });
    base.rate.failNext('transaction', 'ambiguous', true);

    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: uuid(9_505) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 100
    })).rejects.toMatchObject({ category: 'state-unavailable' });
    expect(base.fake.now()).toBe(2_101);
    expect(base.rate.transactions()).toHaveLength(1);
    const rows = audioRows(base);
    const grants = rows.filter((row) => row.properties.kind === 'audio-grant');
    expect(grants).toHaveLength(1);
    const windows = rows.filter((row) => row.properties.kind === 'audio-window');
    expect(windows).toHaveLength(2);
    expect(windows.every((row) =>
      row.properties.retainUntil === 2_600 &&
      row.properties.activeGrantExpiresAt === 2_600 &&
      row.properties.nextOriginalSampleOffset === 100
    )).toBe(true);
    expect(windows.every((row) => {
      const events = JSON.parse(String(row.properties.events));
      return events.length === 1 &&
        events[0].at === 1_600 &&
        events[0].amount === 100 &&
        events[0].operationId === grants[0]?.properties.grantId;
    })).toBe(true);
  });

  it('retries an ambiguous Azure audio transaction only when no grant row committed', async () => {
    const base = await activeFixture();
    base.rate.failNext('transaction', 'ambiguous');
    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: uuid(9_502) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 100
    })).resolves.toMatchObject({ throughOriginalSampleOffset: 100 });
    expect(base.rate.transactions()).toHaveLength(1);
    expect(audioRows(base).filter((row) => row.properties.kind === 'audio-grant')).toHaveLength(1);
    expect(audioRows(base)
      .filter((row) => row.properties.kind === 'audio-window')
      .every((row) => JSON.parse(String(row.properties.events)).length === 1)).toBe(true);
  });

  it('reconciles a fresh ambiguous committed Azure audio transaction exactly once', async () => {
    const base = await activeFixture();
    base.rate.failNext('transaction', 'ambiguous', true);
    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: uuid(9_503) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 100
    })).resolves.toMatchObject({ throughOriginalSampleOffset: 100 });
    expect(base.rate.transactions()).toHaveLength(1);
    expect(audioRows(base).filter((row) => row.properties.kind === 'audio-grant')).toHaveLength(1);
    expect(audioRows(base)
      .filter((row) => row.properties.kind === 'audio-window')
      .every((row) => JSON.parse(String(row.properties.events)).length === 1)).toBe(true);
  });

  it('fails an ambiguous committed Azure audio grant with a stale final lease without compensation', async () => {
    const base = await activeFixture();
    base.rate.beforeNextTransaction(async () => {
      await base.runtime.revokeInstallation({ installationId: base.redeemed.installationId });
    });
    base.rate.failNext('transaction', 'ambiguous', true);
    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: uuid(9_504) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 100
    })).rejects.toMatchObject({ category: 'stale-lease' });
    expect(base.rate.transactions()).toHaveLength(1);
    expect(audioRows(base).filter((row) => row.properties.kind === 'audio-grant')).toHaveLength(1);
    expect(audioRows(base)
      .filter((row) => row.properties.kind === 'audio-window')
      .every((row) => JSON.parse(String(row.properties.events)).length === 1)).toBe(true);
  });

  it.each([
    {
      label: 'binding mismatch (utterance ID)',
      mutate: (properties: AzureStoredEntity['properties']) => ({
        ...properties,
        utteranceId: uuid(9_505)
      })
    },
    {
      label: 'structurally valid offset mismatch',
      mutate: (properties: AzureStoredEntity['properties']) => ({
        ...properties,
        fromOriginalSampleOffset: Number(properties.fromOriginalSampleOffset) + 1,
        throughOriginalSampleOffset: Number(properties.throughOriginalSampleOffset) + 1
      })
    },
    {
      label: 'structurally valid timestamp mismatch',
      mutate: (properties: AzureStoredEntity['properties']) => ({
        ...properties,
        issuedAt: Number(properties.issuedAt) + 1,
        expiresAt: Number(properties.expiresAt) + 1
      })
    },
    {
      label: 'malformed row',
      mutate: (properties: AzureStoredEntity['properties']) => ({
        ...properties,
        expiresAt: 'malformed'
      })
    }
  ] as const)('fails ambiguous committed audio reconciliation for $label without retry or compensation', async ({ mutate }) => {
    const base = await activeFixture();
    base.rate.afterNextTransaction(async () => {
      const row = base.rate.snapshot().find((item) => item.properties.kind === 'audio-grant');
      if (row === undefined) throw new Error('audio grant row missing');
      base.rate.insertRaw({
        partitionKey: row.partitionKey,
        rowKey: row.rowKey,
        properties: Object.freeze(mutate(row.properties))
      });
    });
    base.rate.failNext('transaction', 'ambiguous', true);

    await expect(base.runtime.reserveAudio({
      lease: base.active,
      utteranceId: uuid(9_506) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 100
    })).rejects.toMatchObject({ category: 'state-unavailable' });

    expect(base.rate.transactions()).toHaveLength(1);
    expectSingleAudioCharge(base);
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

  it('continues past the first security page and then cleans the rate table', async () => {
    const base = fixture();
    for (let index = 0; index < 100; index += 1) {
      base.security.insertRaw(Object.freeze({
        partitionKey: ENVIRONMENT,
        rowKey: `a-readiness:${String(index).padStart(3, '0')}`,
        properties: Object.freeze({
          schemaVersion: AZURE_SECURITY_SCHEMA_VERSION,
          kind: 'readiness',
          environment: ENVIRONMENT,
          table: 'security',
          probe: 0,
          updatedAt: 0
        })
      }));
    }
    const pairingCode = pairing(1);
    const pairingHash = hashPairingCode(pairingCode);
    base.security.insertRaw(Object.freeze({
      partitionKey: ENVIRONMENT,
      rowKey: `pair:${pairingHash}`,
      properties: Object.freeze({
        schemaVersion: AZURE_SECURITY_SCHEMA_VERSION,
        kind: 'pairing',
        environment: ENVIRONMENT,
        hash: pairingHash,
        issueOperationId: hashCorrelationKey('cleanup-issue-operation'),
        operatorHash: hashCorrelationKey('cleanup-operator'),
        audienceOrigin: AUDIENCE.origin,
        audiencePath: AUDIENCE.path,
        audienceProtocol: AUDIENCE.protocol,
        status: 'issued',
        issuedAt: 0,
        expiresAt: 1
      })
    }));
    base.rate.insertRaw(Object.freeze({
      partitionKey: 'rate:cleanup',
      rowKey: 'expired-window',
      properties: Object.freeze({
        schemaVersion: AZURE_SECURITY_SCHEMA_VERSION,
        kind: 'rate',
        environment: ENVIRONMENT,
        scope: 'cleanup',
        window: 'test',
        events: '[]',
        retainUntil: 0
      })
    }));

    await expect(base.runtime.cleanupExpired({ limit: 100 })).resolves.toMatchObject({
      visited: 100,
      removed: 1,
      removedByTable: { security: 0, rate: 1 },
      exhausted: false
    });
    await expect(base.runtime.cleanupExpired({ limit: 100 })).resolves.toMatchObject({
      visited: 2,
      removed: 1,
      removedByTable: { security: 1, rate: 0 },
      exhausted: true
    });
    expect(base.security.snapshot().some((entity) => entity.rowKey === `pair:${pairingHash}`)).toBe(false);
    expect(base.rate.snapshot().some((entity) => entity.rowKey === 'expired-window')).toBe(false);
  });

  it('bounds a stalled empty continuation page and reports the traversal as unfinished', async () => {
    const security = fakeTable();
    const rate = fakeTable();
    let securityListCalls = 0;
    const stalledSecurity: AzureTableClientLike = Object.freeze({
      ...security.client,
      listPage: async (input: Parameters<AzureTableClientLike['listPage']>[0]) => {
        securityListCalls += 1;
        return Object.freeze({
          entities: Object.freeze([]),
          continuationToken: input.continuationToken ?? 'stale-token'
        });
      }
    });
    const stores = createAzureTableStoresForTesting({
      environment: ENVIRONMENT,
      audience: AUDIENCE,
      securityTable: stalledSecurity,
      rateTable: rate.client,
      clock: createFakeClock(1_000).clock,
      ids: ids(),
      tokens: tokens()
    });

    await expect(stores.runtime.cleanupExpired({ limit: 3 })).resolves.toMatchObject({
      visited: 0,
      removed: 0,
      exhausted: false
    });
    expect(securityListCalls).toBe(2);
  });

  it('aligns durable and in-memory exhaustion for equivalent live datasets', async () => {
    const local = createTestSecurityStateStore({
      audience: Object.freeze({
        origin: 'wss://localhost:7443',
        path: '/v1/stream',
        protocol: 'palancar.v1'
      }),
      generationProvider: 'mock',
      transcriptionProvider: 'mock',
      clock: createFakeClock(1_000).clock,
      ids: ids(),
      tokens: tokens()
    });
    await local.issuePairing({ operatorScope: 'operator-1' });

    const durable = fixture();
    await durable.operator.issuePairing({ operatorScope: 'operator-1' });

    const [localResult, durableResult] = await Promise.all([
      local.cleanupExpired({ limit: 100 }),
      durable.runtime.cleanupExpired({ limit: 100 })
    ]);
    expect(localResult.exhausted).toBe(true);
    expect(durableResult.exhausted).toBe(localResult.exhausted);
    expect(local.snapshot().pairings).toHaveLength(1);
    expect(durable.security.snapshot().some((row) => row.properties.kind === 'pairing')).toBe(true);
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
