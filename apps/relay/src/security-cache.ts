import type {
  CredentialPromotionResult,
  InstallationRevocationResult,
  SessionLease
} from '@palancar/security-state';

export const RELAY_SECURITY_CACHE_CAPACITY = 4_096;

/**
 * A bounded LRU cache whose misses become unsafe after the first eviction.
 *
 * These caches hold security denials, so an evicted entry cannot be treated as
 * an ordinary cache miss: doing so would turn an old denial into an allow.
 */
export class BoundedSecurityCache<K, V> {
  readonly #capacity: number;
  readonly #entries = new Map<K, V>();
  #evicted = false;

  constructor(capacity = RELAY_SECURITY_CACHE_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Security cache capacity is invalid');
    }
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#entries.size;
  }

  get evicted(): boolean {
    return this.#evicted;
  }

  has(key: K): boolean {
    if (!this.#entries.has(key)) return false;
    this.#touch(key);
    return true;
  }

  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined && !this.#entries.has(key)) return undefined;
    this.#touch(key);
    return value;
  }

  set(key: K, value: V): void {
    if (this.#entries.has(key)) this.#entries.delete(key);
    else if (this.#entries.size >= this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
      this.#evicted = true;
    }
    this.#entries.set(key, value);
  }

  clear(): void {
    this.#entries.clear();
    this.#evicted = false;
  }

  #touch(key: K): void {
    const value = this.#entries.get(key);
    this.#entries.delete(key);
    this.#entries.set(key, value as V);
  }
}

export class RelaySecurityCache {
  readonly #revokedInstallations: BoundedSecurityCache<string, true>;
  readonly #minimumCredentialVersions: BoundedSecurityCache<string, number>;

  constructor(capacity = RELAY_SECURITY_CACHE_CAPACITY) {
    this.#revokedInstallations = new BoundedSecurityCache(capacity);
    this.#minimumCredentialVersions = new BoundedSecurityCache(capacity);
  }

  get revokedInstallationCount(): number {
    return this.#revokedInstallations.size;
  }

  get minimumCredentialVersionCount(): number {
    return this.#minimumCredentialVersions.size;
  }

  get revocationCacheEvicted(): boolean {
    return this.#revokedInstallations.evicted;
  }

  get credentialVersionCacheEvicted(): boolean {
    return this.#minimumCredentialVersions.evicted;
  }

  leaseAllowed(lease: SessionLease): boolean {
    const revoked = this.#revokedInstallations.has(lease.installationId);
    if (revoked || this.#revokedInstallations.evicted) return false;
    const minimumVersion = this.#minimumCredentialVersions.get(lease.installationId);
    if (minimumVersion !== undefined) {
      return lease.credentialVersion >= minimumVersion;
    }
    return !this.#minimumCredentialVersions.evicted;
  }

  applyPromotionResult(result: CredentialPromotionResult): void {
    const currentMinimum = this.#minimumCredentialVersions.get(result.installationId);
    if (currentMinimum === undefined && this.#minimumCredentialVersions.evicted) return;
    const minimum = currentMinimum ?? 0;
    if (result.credentialVersion > minimum) {
      this.#minimumCredentialVersions.set(result.installationId, result.credentialVersion);
    }
  }

  applyRevocationResult(result: InstallationRevocationResult): void {
    this.#revokedInstallations.set(result.installationId, true);
  }

  clear(): void {
    this.#revokedInstallations.clear();
    this.#minimumCredentialVersions.clear();
  }
}
