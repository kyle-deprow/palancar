import type {
  CredentialPromotionResult,
  InstallationRevocationResult,
  SessionLease
} from '@palancar/security-state';
import { assertCanonicalUuid } from '@palancar/security-state';
import { describe, expect, it } from 'vitest';

import {
  BoundedSecurityCache,
  RelaySecurityCache
} from '../src/security-cache.js';

function lease(installationId: string, credentialVersion = 1): SessionLease {
  return {
    installationId: assertCanonicalUuid(installationId),
    sessionId: assertCanonicalUuid('11111111-1111-4111-8111-111111111111'),
    sessionEpoch: 1,
    credentialVersion,
    leaseVersion: 1,
    phase: 'opening',
    leaseExpiresAt: 1
  };
}

function promotion(installationId: string, credentialVersion: number): CredentialPromotionResult {
  return {
    installationId: assertCanonicalUuid(installationId),
    credentialVersion,
    tombstoneVersion: 1,
    status: 'promoted',
    confirmedAt: 1,
    idleExpiresAt: 2,
    absoluteExpiresAt: 3
  };
}

function revocation(installationId: string): InstallationRevocationResult {
  return {
    installationId: assertCanonicalUuid(installationId),
    credentialVersion: 1,
    tombstoneVersion: 1,
    status: 'revoked',
    revokedAt: 1
  };
}

describe('relay security cache', () => {
  it('bounds entries and evicts the least recently used entry', () => {
    const cache = new BoundedSecurityCache<string, true>(2);
    cache.set('old', true);
    cache.set('hot', true);
    expect(cache.has('old')).toBe(true);

    cache.set('new', true);

    expect(cache.size).toBe(2);
    expect(cache.evicted).toBe(true);
    expect(cache.has('old')).toBe(true);
    expect(cache.has('hot')).toBe(false);
    expect(cache.has('new')).toBe(true);
  });

  it('evicts an undefined key when the cache reaches capacity', () => {
    const cache = new BoundedSecurityCache<string | undefined, true>(1);
    cache.set(undefined, true);
    cache.set('new', true);

    expect(cache.size).toBe(1);
    expect(cache.has(undefined)).toBe(false);
    expect(cache.has('new')).toBe(true);
  });

  it('rejects an evicted revoked installation instead of failing open', () => {
    const cache = new RelaySecurityCache(2);
    const revokedInstallation = '11111111-1111-4111-8111-111111111111';
    const retainedRevokedInstallation = '22222222-2222-4222-8222-222222222222';
    const newestRevokedInstallation = '33333333-3333-4333-8333-333333333333';

    cache.applyRevocationResult(revocation(revokedInstallation));
    cache.applyRevocationResult(revocation(retainedRevokedInstallation));
    cache.applyRevocationResult(revocation(newestRevokedInstallation));

    expect(cache.revokedInstallationCount).toBe(2);
    expect(cache.revocationCacheEvicted).toBe(true);
    expect(cache.leaseAllowed(lease(retainedRevokedInstallation))).toBe(false);
    expect(cache.leaseAllowed(lease(newestRevokedInstallation))).toBe(false);
    expect(cache.leaseAllowed(lease(revokedInstallation))).toBe(false);
  });

  it('fails closed for an evicted minimum credential version', () => {
    const cache = new RelaySecurityCache(2);
    const firstInstallation = '11111111-1111-4111-8111-111111111111';
    const secondInstallation = '22222222-2222-4222-8222-222222222222';
    const thirdInstallation = '33333333-3333-4333-8333-333333333333';

    cache.applyPromotionResult(promotion(firstInstallation, 2));
    cache.applyPromotionResult(promotion(secondInstallation, 3));
    expect(cache.leaseAllowed(lease(firstInstallation, 2))).toBe(true);

    cache.applyPromotionResult(promotion(thirdInstallation, 4));

    expect(cache.minimumCredentialVersionCount).toBe(2);
    expect(cache.credentialVersionCacheEvicted).toBe(true);
    expect(cache.leaseAllowed(lease(firstInstallation, 2))).toBe(true);
    expect(cache.leaseAllowed(lease(firstInstallation, 1))).toBe(false);
    expect(cache.leaseAllowed(lease(thirdInstallation, 3))).toBe(false);
    expect(cache.leaseAllowed(lease(secondInstallation, 3))).toBe(false);
    expect(cache.leaseAllowed(lease(thirdInstallation, 4))).toBe(true);

    cache.applyPromotionResult(promotion(secondInstallation, 3));
    expect(cache.leaseAllowed(lease(secondInstallation, 3))).toBe(false);
  });
});
