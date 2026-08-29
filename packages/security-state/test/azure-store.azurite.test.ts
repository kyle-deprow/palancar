import { TableClient } from '@azure/data-tables';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUDIO_GRANT_TTL_MS,
  REVOCATION_TOMBSTONE_TTL_MS,
  hashCorrelationKey,
  hashPairingCode,
  type HostTrustedOpaqueSource,
  type SecurityAudience,
  type SessionLease
} from '../src/index.js';
import {
  createAzureTableClientBoundaryForTesting,
  createAzureTableStoresForTesting,
  createDeterministicIdFactory,
  createDeterministicTokenFactory,
  createFakeClock
} from '../src/testing.js';

const endpoint = process.env.AZURITE_TABLE_ENDPOINT;
const oauthToken = process.env.AZURITE_OAUTH_TOKEN;
if (endpoint === undefined || oauthToken === undefined) {
  throw new Error('Azurite HTTPS/OAuth prerequisites were not supplied; run npm run test:azurite');
}

const ENVIRONMENT = 'azurite';
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
  return String(index + 100_000).padStart(6, '0');
}

function token(index: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(index, 28);
  return bytes.toString('base64url');
}

const values = (count: number, make: (index: number) => string, start: number): readonly string[] =>
  Array.from({ length: count }, (_, index) => make(index + start));

const credential = Object.freeze({
  getToken: async (): Promise<{ token: string; expiresOnTimestamp: number }> => ({
    token: oauthToken,
    expiresOnTimestamp: Date.now() + 600_000
  })
});
const suffix = `${process.pid}${Date.now().toString(36)}`.slice(-24);
const securityClient = new TableClient(endpoint, `SecurityState${suffix}`, credential, {
  retryOptions: { maxRetries: 0 }
});
const rateClient = new TableClient(endpoint, `RateState${suffix}`, credential, {
  retryOptions: { maxRetries: 0 }
});

const securityBoundary = createAzureTableClientBoundaryForTesting(securityClient);
const rateBoundary = createAzureTableClientBoundaryForTesting(rateClient);
const fakeClock = createFakeClock(Date.now());
const stores = createAzureTableStoresForTesting({
  environment: ENVIRONMENT,
  audience: AUDIENCE,
  securityTable: securityBoundary,
  rateTable: rateBoundary,
  clock: fakeClock.clock,
  ids: createDeterministicIdFactory({
    installationIds: values(1_000, uuid, 1),
    sessionIds: values(1_000, uuid, 2_000),
    grantIds: values(1_000, uuid, 4_000),
    generationClaimIds: values(1_000, uuid, 6_000)
  }),
  tokens: createDeterministicTokenFactory({
    pairingCodes: values(1_000, pairing, 1),
    credentials: values(1_000, token, 2_000),
    tickets: values(1_000, token, 4_000)
  })
});
const otherAudienceStores = createAzureTableStoresForTesting({
  environment: ENVIRONMENT,
  audience: OTHER_AUDIENCE,
  securityTable: securityBoundary,
  rateTable: rateBoundary,
  clock: fakeClock.clock,
  ids: createDeterministicIdFactory({
    installationIds: values(1_000, uuid, 20_000),
    sessionIds: values(1_000, uuid, 22_000),
    grantIds: values(1_000, uuid, 24_000),
    generationClaimIds: values(1_000, uuid, 26_000)
  }),
  tokens: createDeterministicTokenFactory({
    pairingCodes: values(1_000, pairing, 20_000),
    credentials: values(1_000, token, 22_000),
    tickets: values(1_000, token, 24_000)
  })
});

beforeAll(async () => {
  await securityClient.createTable();
  await rateClient.createTable();
});

afterAll(async () => {
  await Promise.allSettled([securityClient.deleteTable(), rateClient.deleteTable()]);
});

describe('Azure Table durable adapter against Azurite HTTPS/OAuth', () => {
  it('executes readiness, exact-once concurrency, leases, audio, and generation', async () => {
    await expect(stores.runtime.checkReadiness())
      .rejects.toMatchObject({ category: 'state-unavailable' });
    await stores.bootstrap.initializeState();
    await expect(stores.runtime.checkReadiness()).resolves.toBeUndefined();

    await securityBoundary.transaction([
      {
        type: 'create',
        entity: { partitionKey: ENVIRONMENT, rowKey: 'diagnostic-a', properties: { marker: 'a' } }
      },
      {
        type: 'create',
        entity: { partitionKey: ENVIRONMENT, rowKey: 'diagnostic-b', properties: { marker: 'b' } }
      }
    ]);
    const diagnosticA = await securityBoundary.pointRead(ENVIRONMENT, 'diagnostic-a');
    const diagnosticB = await securityBoundary.pointRead(ENVIRONMENT, 'diagnostic-b');
    if (diagnosticA === undefined || diagnosticB === undefined) throw new Error('diagnostic rows missing');
    await securityBoundary.replace(
      { partitionKey: ENVIRONMENT, rowKey: 'diagnostic-b', properties: { marker: 'b-current' } },
      diagnosticB.etag
    );
    const currentDiagnosticB = await securityBoundary.pointRead(ENVIRONMENT, 'diagnostic-b');
    if (currentDiagnosticB === undefined) throw new Error('current diagnostic row missing');
    await expect(securityBoundary.transaction([
      {
        type: 'replace',
        entity: { partitionKey: ENVIRONMENT, rowKey: 'diagnostic-a', properties: { marker: 'changed' } },
        etag: diagnosticA.etag
      },
      {
        type: 'replace',
        entity: { partitionKey: ENVIRONMENT, rowKey: 'diagnostic-b', properties: { marker: 'changed' } },
        etag: diagnosticB.etag
      }
    ])).rejects.toMatchObject({ kind: 'precondition-failed' });
    await expect(securityBoundary.pointRead(ENVIRONMENT, 'diagnostic-a'))
      .resolves.toMatchObject({ properties: { marker: 'a' } });
    await expect(securityBoundary.transaction([
      {
        type: 'create',
        entity: { partitionKey: ENVIRONMENT, rowKey: 'diagnostic-a', properties: { marker: 'duplicate' } }
      },
      {
        type: 'create',
        entity: { partitionKey: ENVIRONMENT, rowKey: 'diagnostic-c', properties: { marker: 'c' } }
      }
    ])).rejects.toMatchObject({ kind: 'conflict' });
    await expect(securityBoundary.pointRead(ENVIRONMENT, 'diagnostic-c')).resolves.toBeUndefined();
    await securityBoundary.delete(ENVIRONMENT, 'diagnostic-a', diagnosticA.etag);
    await securityBoundary.delete(ENVIRONMENT, 'diagnostic-b', currentDiagnosticB.etag);

    const issued = await stores.operator.issuePairing({ operatorScope: 'operator-azurite' });
    const pairingEntity = await securityBoundary.pointRead(
      ENVIRONMENT,
      `pair:${hashPairingCode(issued.pairingCode)}`
    );
    if (pairingEntity === undefined) throw new Error('Azurite pairing metadata row missing');
    expect(Object.keys(pairingEntity.properties).sort()).toEqual([
      'audienceOrigin', 'audiencePath', 'audienceProtocol', 'environment', 'expiresAt', 'hash',
      'issueOperationId', 'issuedAt', 'kind', 'operatorHash', 'schemaVersion', 'status'
    ]);
    const redemptions = await Promise.allSettled(Array.from({ length: 100 }, (_, index) =>
      stores.runtime.redeemPairing({
        pairingCode: issued.pairingCode,
        trustedSource: `trusted-${index}` as HostTrustedOpaqueSource
      })));
    const redeemed = redemptions.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof stores.runtime.redeemPairing>>> =>
        result.status === 'fulfilled'
    );
    const redemptionFailures = redemptions
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .reduce<Record<string, number>>((counts, result) => {
        const reason = result.reason as { readonly category?: unknown };
        const category = typeof reason?.category === 'string' ? reason.category : 'non-security-error';
        counts[category] = (counts[category] ?? 0) + 1;
        return counts;
      }, {});
    expect(
      redemptions.filter((result) => result.status === 'fulfilled'),
      `content-safe rejection categories: ${JSON.stringify(redemptionFailures)}`
    ).toHaveLength(1);
    if (redeemed === undefined) throw new Error('Azurite redemption winner missing');

    await expect(otherAudienceStores.runtime.authenticateCredential({
      credential: redeemed.value.credential
    })).rejects.toMatchObject({ category: 'invalid-credential' });
    await expect(otherAudienceStores.runtime.beginCredentialRotation({
      credential: redeemed.value.credential
    })).rejects.toMatchObject({ category: 'invalid-credential' });
    await expect(otherAudienceStores.runtime.issueSessionTicket({
      credential: redeemed.value.credential,
      environment: ENVIRONMENT,
      audience: OTHER_AUDIENCE,
      intent: 'new'
    })).rejects.toMatchObject({ category: 'invalid-ticket' });
    const pending = await stores.runtime.beginCredentialRotation({
      credential: redeemed.value.credential
    });
    await expect(otherAudienceStores.runtime.promoteCredential({
      pendingCredential: pending.pendingCredential
    })).rejects.toMatchObject({ category: 'invalid-credential' });

    const ticket = await stores.runtime.issueSessionTicket({
      credential: redeemed.value.credential,
      environment: ENVIRONMENT,
      audience: AUDIENCE,
      intent: 'new'
    });
    const consumptions = await Promise.allSettled(Array.from({ length: 100 }, () =>
      stores.runtime.consumeSessionTicket({
        ticket: ticket.ticket,
        environment: ENVIRONMENT,
        audience: AUDIENCE,
        intent: 'new'
      })));
    const consumed = consumptions.find(
      (result): result is PromiseFulfilledResult<SessionLease> => result.status === 'fulfilled'
    );
    expect(consumptions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    if (consumed === undefined) throw new Error('Azurite ticket winner missing');

    const active = await stores.runtime.activateSession({
      lease: consumed.value,
      message: { type: 'session.start', protocolVersion: 1 }
    });
    await expect(stores.runtime.reserveAudio({
      lease: active,
      utteranceId: uuid(9_000) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 8_000
    })).resolves.toMatchObject({ fromOriginalSampleOffset: 0, throughOriginalSampleOffset: 8_000 });
    await expect(stores.runtime.reserveAudio({
      lease: active,
      utteranceId: uuid(9_000) as never,
      fromOriginalSampleOffset: 7_999,
      originalSamples: 1
    })).rejects.toMatchObject({ category: 'invalid-input' });
    await expect(stores.runtime.reserveAudio({
      lease: active,
      utteranceId: uuid(9_001) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 1
    })).rejects.toMatchObject({ category: 'invalid-input' });
    await stores.runtime.reserveAudio({
      lease: active,
      utteranceId: uuid(9_000) as never,
      fromOriginalSampleOffset: 8_000,
      originalSamples: 8_000
    });
    fakeClock.advance(AUDIO_GRANT_TTL_MS);
    await expect(stores.runtime.reserveAudio({
      lease: active,
      utteranceId: uuid(9_001) as never,
      fromOriginalSampleOffset: 0,
      originalSamples: 1
    })).resolves.toMatchObject({ throughOriginalSampleOffset: 1 });

    const authorized = await stores.runtime.authorizeGeneration({
      lease: active,
      decision: 'target',
      utteranceId: uuid(9_000),
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'es',
      gatePolicyVersion: '1.0.0',
      transcriptHash: hashCorrelationKey('azurite-transcript')
    });
    expect(authorized.status).toBe('acquired');
    const started = await stores.runtime.providerStart({ claim: authorized.claim });
    expect(started.status).toBe('start-permitted');
    const completed = await stores.runtime.completeGeneration({
      claim: started.claim,
      outcome: 'completed'
    });
    expect(completed.phase).toBe('completed');

    const racingAuthorization = await stores.runtime.authorizeGeneration({
      lease: active,
      decision: 'target',
      utteranceId: uuid(9_001),
      acceptedFinalRevision: 2,
      selectedTargetLanguage: 'es',
      gatePolicyVersion: '1.0.0',
      transcriptHash: hashCorrelationKey('azurite-transcript-2')
    });
    const race = await Promise.allSettled([
      ...Array.from({ length: 100 }, () =>
        stores.runtime.providerStart({ claim: racingAuthorization.claim })),
      stores.runtime.revokeInstallation({ installationId: redeemed.value.installationId })
    ]);
    const starts = race.slice(0, 100)
      .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof stores.runtime.providerStart>>> =>
        result.status === 'fulfilled');
    expect(starts.filter((result) => result.value.status === 'start-permitted').length).toBeLessThanOrEqual(1);
    await expect(stores.runtime.releaseGeneration({
      claim: starts[0]?.value.claim ?? racingAuthorization.claim
    })).resolves.toMatchObject({ phase: 'released' });

    fakeClock.advance(REVOCATION_TOMBSTONE_TTL_MS);
    for (let pass = 0; pass < 4; pass += 1) {
      await stores.runtime.cleanupExpired({ limit: 10_000 });
    }
    await expect(securityBoundary.pointRead(
      ENVIRONMENT,
      `installation:${redeemed.value.installationId}`
    )).resolves.toBeUndefined();
    await expect(securityBoundary.pointRead(
      ENVIRONMENT,
      `session:${redeemed.value.installationId}`
    )).resolves.toBeUndefined();
  }, 60_000);

  it('exercises durable promotion and credential-authenticated revocation replay paths', async () => {
    const issued = await stores.operator.issuePairing({ operatorScope: 'operator-azurite-rotation' });
    const redeemed = await stores.runtime.redeemPairing({
      pairingCode: issued.pairingCode,
      trustedSource: 'azurite-rotation-source' as HostTrustedOpaqueSource
    });
    const pending = await stores.runtime.beginCredentialRotation({ credential: redeemed.credential });
    await expect(stores.runtime.beginCredentialRotation({ credential: redeemed.credential }))
      .rejects.toMatchObject({ category: 'credential-conflict' });
    const promoted = await stores.runtime.promoteCredential({ pendingCredential: pending.pendingCredential });
    expect(promoted).toMatchObject({ status: 'promoted', credentialVersion: 2 });
    const replayedPromotion = await stores.runtime.promoteCredential({
      pendingCredential: pending.pendingCredential
    });
    expect(replayedPromotion).toMatchObject({ status: 'already-promoted', credentialVersion: 2 });

    const revokePairing = await stores.operator.issuePairing({ operatorScope: 'operator-azurite-revocation' });
    const revokeEnrollment = await stores.runtime.redeemPairing({
      pairingCode: revokePairing.pairingCode,
      trustedSource: 'azurite-revocation-source' as HostTrustedOpaqueSource
    });
    const ticket = await stores.runtime.issueSessionTicket({
      credential: revokeEnrollment.credential,
      environment: ENVIRONMENT,
      audience: AUDIENCE,
      intent: 'new'
    });
    const opening = await stores.runtime.consumeSessionTicket({
      ticket: ticket.ticket,
      environment: ENVIRONMENT,
      audience: AUDIENCE,
      intent: 'new'
    });
    const active = await stores.runtime.activateSession({
      lease: opening,
      message: { type: 'session.start', protocolVersion: 1 }
    });
    const revoked = await stores.runtime.revokeCurrentInstallation({ credential: revokeEnrollment.credential });
    expect(revoked).toMatchObject({
      status: 'revoked',
      invalidatedSession: { sessionId: active.sessionId, sessionEpoch: active.sessionEpoch }
    });
    const replayedRevocation = await stores.runtime.revokeCurrentInstallation({
      credential: revokeEnrollment.credential
    });
    expect(replayedRevocation).toMatchObject({
      status: 'already-revoked',
      revokedAt: revoked.revokedAt,
      tombstoneVersion: revoked.tombstoneVersion,
      invalidatedSession: revoked.invalidatedSession
    });
    await expect(stores.runtime.heartbeatSession({ lease: active }))
      .rejects.toMatchObject({ category: 'stale-lease' });
  }, 60_000);
});
