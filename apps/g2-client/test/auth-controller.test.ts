import { describe, expect, it } from "vitest";

import type {
  CredentialStore,
  StoredInstallationCredential,
} from "../src/auth/credential-store.js";
import {
  createG2AuthController,
  type G2AuthControllerOptions,
} from "../src/auth/controller.js";
import type {
  AuthHttpClientLike,
  InstallationCredentialResponseLike,
  RotationBeginResponseLike,
  RotationConfirmationResponseLike,
} from "../src/auth/types.js";

const PAIRING = "012345";
const CURRENT = `${"A".repeat(42)}E`;
const PENDING = `${"B".repeat(42)}I`;
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-08-01T00:00:00.000Z");
const ABSOLUTE = "2026-11-01T00:00:00.000Z";

const INITIAL_RESPONSE: InstallationCredentialResponseLike = Object.freeze({
  installationId: INSTALLATION_ID,
  credential: CURRENT,
  credentialVersion: 1,
  idleExpiresAt: "2026-09-01T00:00:00.000Z",
  absoluteExpiresAt: ABSOLUTE,
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

function record(overrides: Partial<StoredInstallationCredential> = {}): StoredInstallationCredential {
  return Object.freeze({
    key: "active",
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    idleExpiresAt: "2026-07-01T00:00:00.000Z",
    absoluteExpiresAt: ABSOLUTE,
    currentCredential: CURRENT,
    currentCredentialVersion: 1,
    currentRotationDueAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  });
}

function pendingRecord(overrides: Partial<StoredInstallationCredential> = {}): StoredInstallationCredential {
  return record({
    pendingCredential: PENDING,
    pendingCredentialVersion: 2,
    pendingCredentialExpiresAt: "2026-08-05T00:00:00.000Z",
    pendingRotationDueAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  });
}

function httpFailure(category: string, status?: number): Readonly<{ category: string; status?: number }> {
  return Object.freeze(status === undefined ? { category } : { category, status });
}

class FakeClock {
  value = NOW;
  now = (): number => this.value;
}

class FakeStore implements CredentialStore {
  value: StoredInstallationCredential | undefined;
  failLoadCount = 0;
  failSaveCount = 0;
  failClearCount = 0;
  afterLoad: (() => void | Promise<void>) | undefined;
  afterSave: (() => void | Promise<void>) | undefined;
  afterClear: (() => void | Promise<void>) | undefined;
  closed = false;
  readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  async load(): Promise<StoredInstallationCredential | undefined> {
    this.events.push("load");
    await this.afterLoad?.();
    if (this.failLoadCount > 0) {
      this.failLoadCount -= 1;
      throw new Error("storage-load-canary");
    }
    return this.value;
  }

  async save(next: StoredInstallationCredential): Promise<void> {
    this.events.push(next.pendingCredential === undefined ? "save:current" : "save:pending");
    await this.afterSave?.();
    if (this.failSaveCount > 0) {
      this.failSaveCount -= 1;
      throw new Error("storage-save-canary");
    }
    this.value = Object.freeze({ ...next });
  }

  async clear(): Promise<void> {
    this.events.push("clear");
    await this.afterClear?.();
    if (this.failClearCount > 0) {
      this.failClearCount -= 1;
      throw new Error("storage-clear-canary");
    }
    this.value = undefined;
  }

  close(): void {
    this.events.push("close");
    this.closed = true;
  }
}

class FakeHttp implements AuthHttpClientLike {
  ensureError: unknown;
  redeemError: unknown;
  beginError: unknown;
  confirmError: unknown;
  revokeError: unknown;
  afterEnsure: (() => void | Promise<void>) | undefined;
  afterRedeem: (() => void | Promise<void>) | undefined;
  afterBegin: (() => void | Promise<void>) | undefined;
  afterConfirm: (() => void | Promise<void>) | undefined;
  afterRevoke: (() => void | Promise<void>) | undefined;
  onBegin: (() => void) | undefined;
  beginWait: Promise<void> | undefined;
  redemption: InstallationCredentialResponseLike = INITIAL_RESPONSE;
  beginning: RotationBeginResponseLike = Object.freeze({
    pendingCredential: PENDING,
    pendingCredentialVersion: 2,
    pendingCredentialExpiresAt: "2026-08-05T00:00:00.000Z",
  });
  confirmation: RotationConfirmationResponseLike = Object.freeze({
    credentialVersion: 2,
    promoted: true,
    confirmedAt: "2026-08-01T00:00:01.000Z",
    expiresAt: ABSOLUTE,
  });
  disposed = false;
  readonly events: string[];
  readonly beginCredentials: string[] = [];
  readonly redeemedCodes: string[] = [];
  readonly confirmationCredentials: string[] = [];
  readonly revokedCredentials: string[] = [];

  constructor(events: string[] = []) {
    this.events = events;
  }

  async ensureRelayAwake(): Promise<void> {
    this.events.push("health");
    await this.afterEnsure?.();
    if (this.ensureError !== undefined) throw this.ensureError;
  }

  async redeemPairing(code: string): Promise<InstallationCredentialResponseLike> {
    this.events.push("redeem");
    this.redeemedCodes.push(code);
    await this.afterRedeem?.();
    if (this.redeemError !== undefined) throw this.redeemError;
    return this.redemption;
  }

  async beginRotation(credential: string): Promise<RotationBeginResponseLike> {
    this.events.push("begin");
    this.beginCredentials.push(credential);
    this.onBegin?.();
    await this.beginWait;
    await this.afterBegin?.();
    if (this.beginError !== undefined) throw this.beginError;
    return this.beginning;
  }

  async confirmRotation(credential: string): Promise<RotationConfirmationResponseLike> {
    this.events.push("confirm");
    this.confirmationCredentials.push(credential);
    await this.afterConfirm?.();
    if (this.confirmError !== undefined) throw this.confirmError;
    return this.confirmation;
  }

  async revokeCurrent(credential: string): Promise<"confirmed"> {
    this.events.push("revoke");
    this.revokedCredentials.push(credential);
    await this.afterRevoke?.();
    if (this.revokeError !== undefined) throw this.revokeError;
    return "confirmed";
  }

  dispose(): void {
    this.events.push("dispose");
    this.disposed = true;
  }
}

function options(
  store: FakeStore,
  http: FakeHttp,
  clock = new FakeClock(),
): G2AuthControllerOptions {
  return { store, http, clock };
}

describe("G2 auth controller", () => {
  it("initializes missing, ignores idle expiry, and durably clears absolute expiry", async () => {
    const missingStore = new FakeStore();
    const missing = createG2AuthController(options(missingStore, new FakeHttp()));
    await expect(missing.initialize()).resolves.toEqual({ kind: "required", reason: "missing" });

    const idleStore = new FakeStore();
    idleStore.value = record();
    const idle = createG2AuthController(options(idleStore, new FakeHttp()));
    await expect(idle.initialize()).resolves.toEqual({ kind: "ready" });

    const expiredStore = new FakeStore();
    expiredStore.value = record({ absoluteExpiresAt: "2026-07-31T23:59:59.999Z" });
    const expired = createG2AuthController(options(expiredStore, new FakeHttp()));
    await expect(expired.initialize()).resolves.toEqual({
      kind: "required",
      reason: "absolute-expired",
    });
    expect(expiredStore.events).toEqual(["load", "clear"]);
    expect(expiredStore.value).toBeUndefined();
  });

  it("maps only definite redemption rejection to pairing-failed after the POST", async () => {
    const invalidHttp = new FakeHttp();
    const invalid = createG2AuthController(options(new FakeStore(), invalidHttp));
    await expect(invalid.enroll("not-canonical")).resolves.toEqual({
      kind: "required",
      reason: "pairing-failed",
    });
    expect(invalidHttp.events).toEqual([]);

    for (const failure of [
      httpFailure("timeout"),
      httpFailure("unavailable", 503),
      httpFailure("protocol", 403),
      new Error("post-canary"),
    ]) {
      const http = new FakeHttp();
      http.redeemError = failure;
      const auth = createG2AuthController(options(new FakeStore(), http));
      await expect(auth.enroll(PAIRING)).resolves.toEqual({
        kind: "required",
        reason: "pairing-uncertain",
      });
      expect(http.events).toEqual(["health", "redeem"]);
    }

    const rejectedHttp = new FakeHttp();
    rejectedHttp.redeemError = httpFailure("rejected", 403);
    const rejected = createG2AuthController(options(new FakeStore(), rejectedHttp));
    await expect(rejected.enroll(PAIRING)).resolves.toEqual({
      kind: "required",
      reason: "pairing-failed",
    });
  });

  it("retains exactly one volatile enrollment and retries persistence without HTTP", async () => {
    const store = new FakeStore();
    const http = new FakeHttp();
    const auth = createG2AuthController(options(store, http));
    store.failSaveCount = 1;
    await expect(auth.enroll(PAIRING)).resolves.toEqual({ kind: "storage-error" });
    await expect(auth.credentialProvider.acquire()).resolves.toEqual({ kind: "storage-error" });
    await expect(auth.retryPersistence()).resolves.toEqual({ kind: "ready" });
    expect(http.events).toEqual(["health", "redeem"]);
    expect(store.events).toEqual(["save:current", "save:current"]);
    expect(store.value?.currentRotationDueAt).toBe(INITIAL_RESPONSE.idleExpiresAt);
  });

  it("orders rotation begin, pending save, confirmation, promotion save, then grant", async () => {
    const events: string[] = [];
    const store = new FakeStore(events);
    store.value = record();
    const http = new FakeHttp(events);
    const auth = createG2AuthController(options(store, http));
    await auth.initialize();
    events.length = 0;

    await expect(auth.prepareSessionBoundary({ allowRotation: true })).resolves.toEqual({ kind: "ready" });
    expect(events).toEqual(["begin", "save:pending", "confirm", "save:current"]);
    expect(store.value?.currentCredential).toBe(PENDING);
    const acquired = await auth.credentialProvider.acquire();
    expect(acquired).toMatchObject({
      kind: "ready",
      lease: { credential: PENDING, credentialVersion: 2 },
    });
  });

  it("durably drops a locally expired pending credential before continuing rotation", async () => {
    const events: string[] = [];
    const store = new FakeStore(events);
    store.value = pendingRecord({
      pendingCredentialExpiresAt: "2026-07-31T23:59:59.999Z",
    });
    const http = new FakeHttp(events);
    const auth = createG2AuthController(options(store, http));
    await auth.initialize();
    events.length = 0;

    await expect(auth.prepareSessionBoundary({ allowRotation: true })).resolves.toEqual({ kind: "ready" });
    expect(events).toEqual([
      "save:current",
      "begin",
      "save:pending",
      "confirm",
      "save:current",
    ]);
    expect(http.confirmationCredentials).toEqual([PENDING]);
    expect(store.value?.currentCredential).toBe(PENDING);
  });

  it("clears current enrollment only for bearer 401, while 403 and 429 preserve it", async () => {
    const rejectedStore = new FakeStore();
    rejectedStore.value = record();
    const rejectedHttp = new FakeHttp();
    rejectedHttp.beginError = httpFailure("rejected", 401);
    const rejected = createG2AuthController(options(rejectedStore, rejectedHttp));
    await rejected.initialize();
    await expect(rejected.prepareSessionBoundary({ allowRotation: true })).resolves.toEqual({
      kind: "required",
      reason: "credential-rejected",
    });
    expect(rejectedStore.events).toEqual(["load", "clear"]);
    expect(rejectedStore.value).toBeUndefined();

    for (const status of [403, 429]) {
      const store = new FakeStore();
      store.value = record();
      const http = new FakeHttp();
      http.beginError = httpFailure("protocol", status);
      const auth = createG2AuthController(options(store, http));
      await auth.initialize();
      await expect(auth.prepareSessionBoundary({ allowRotation: true })).resolves.toEqual({
        kind: "unavailable",
      });
      expect(store.events).toEqual(["load"]);
      expect(store.value?.currentCredential).toBe(CURRENT);
    }
  });

  it("keeps a failed clear intent private, disables grants, and retries before load", async () => {
    const store = new FakeStore();
    store.value = record();
    store.failClearCount = 2;
    const http = new FakeHttp();
    http.beginError = httpFailure("rejected", 401);
    const auth = createG2AuthController(options(store, http));
    await auth.initialize();

    await expect(auth.prepareSessionBoundary({ allowRotation: true })).resolves.toEqual({
      kind: "storage-error",
    });
    await expect(auth.credentialProvider.acquire()).resolves.toEqual({ kind: "storage-error" });
    await expect(auth.initialize()).resolves.toEqual({ kind: "storage-error" });
    expect(store.events).toEqual(["load", "clear", "clear"]);

    await expect(auth.retryPersistence()).resolves.toEqual({
      kind: "required",
      reason: "credential-rejected",
    });
    expect(store.events).toEqual(["load", "clear", "clear", "clear"]);
    expect(store.value).toBeUndefined();
    expect(http.events).toEqual(["begin"]);
  });

  it("never resurrects reset or revocation state after a failed clear", async () => {
    const resetStore = new FakeStore();
    resetStore.value = record();
    resetStore.failClearCount = 1;
    const reset = createG2AuthController(options(resetStore, new FakeHttp()));
    await reset.initialize();
    await expect(reset.resetEnrollment()).resolves.toEqual({ kind: "storage-error" });
    await expect(reset.initialize()).resolves.toEqual({ kind: "required", reason: "missing" });
    expect(resetStore.events).toEqual(["load", "clear", "clear"]);

    const revokeStore = new FakeStore();
    revokeStore.value = record();
    revokeStore.failClearCount = 1;
    const revokeHttp = new FakeHttp();
    const revoke = createG2AuthController(options(revokeStore, revokeHttp));
    await revoke.initialize();
    await expect(revoke.revokeCurrent()).resolves.toEqual({ kind: "storage-error" });
    expect(revokeHttp.events).toEqual(["health"]);
    await expect(revoke.retryPersistence()).resolves.toEqual({
      kind: "required",
      reason: "revocation-unconfirmed",
    });
    expect(revokeHttp.events).toEqual(["health"]);
    expect(revokeStore.events).toEqual(["load", "clear", "clear"]);
  });

  it("rechecks absolute expiry after awaited HTTP and persistence operations", async () => {
    const beginClock = new FakeClock();
    const beginStore = new FakeStore();
    beginStore.value = record();
    const beginHttp = new FakeHttp();
    beginHttp.afterBegin = () => { beginClock.value = Date.parse(ABSOLUTE); };
    const beginAuth = createG2AuthController(options(beginStore, beginHttp, beginClock));
    await beginAuth.initialize();
    await expect(beginAuth.prepareSessionBoundary({ allowRotation: true })).resolves.toEqual({
      kind: "required",
      reason: "absolute-expired",
    });
    expect(beginStore.events).toEqual(["load", "clear"]);
    expect(beginHttp.events).toEqual(["begin"]);

    const healthClock = new FakeClock();
    const healthStore = new FakeStore();
    healthStore.value = record();
    const healthHttp = new FakeHttp();
    healthHttp.afterEnsure = () => { healthClock.value = Date.parse(ABSOLUTE); };
    const healthAuth = createG2AuthController(options(healthStore, healthHttp, healthClock));
    await healthAuth.initialize();
    await expect(healthAuth.revokeCurrent()).resolves.toEqual({
      kind: "required",
      reason: "absolute-expired",
    });
    expect(healthHttp.events).toEqual(["health"]);
    expect(healthStore.events).toEqual(["load", "clear"]);

    const saveClock = new FakeClock();
    const saveStore = new FakeStore();
    saveStore.value = record();
    const saveAuth = createG2AuthController(options(saveStore, new FakeHttp(), saveClock));
    await saveAuth.initialize();
    await saveAuth.prepareSessionBoundary({ allowRotation: false });
    const acquired = await saveAuth.credentialProvider.acquire();
    if (acquired.kind !== "ready") throw new Error("expected credential lease");
    saveStore.afterSave = () => { saveClock.value = Date.parse(ABSOLUTE); };
    await expect(saveAuth.credentialProvider.recordAuthenticated(
      acquired.lease.credentialVersion,
      acquired.lease.grantToken,
    )).resolves.toBe("stale");
    expect(saveStore.events).toEqual(["load", "save:current", "clear"]);
    expect(saveStore.value).toBeUndefined();
  });

  it("uses an opaque grant token to close same-version ABA callbacks", async () => {
    const store = new FakeStore();
    store.value = record();
    const auth = createG2AuthController(options(store, new FakeHttp()));
    await auth.initialize();
    await auth.prepareSessionBoundary({ allowRotation: false });
    const first = await auth.credentialProvider.acquire();
    if (first.kind !== "ready") throw new Error("expected first credential lease");
    expect(Reflect.ownKeys(first.lease.grantToken)).toHaveLength(0);
    expect(JSON.stringify(first.lease.grantToken)).toBe("{}");

    await auth.resetEnrollment();
    await auth.enroll(PAIRING);
    await auth.prepareSessionBoundary({ allowRotation: false });
    const second = await auth.credentialProvider.acquire();
    if (second.kind !== "ready") throw new Error("expected second credential lease");
    expect(second.lease.credentialVersion).toBe(first.lease.credentialVersion);
    expect(second.lease.grantToken).not.toBe(first.lease.grantToken);

    await expect(auth.credentialProvider.recordAuthenticated(
      first.lease.credentialVersion,
      first.lease.grantToken,
    )).resolves.toBe("stale");
    await expect(auth.credentialProvider.reject(
      first.lease.credentialVersion,
      first.lease.grantToken,
    )).resolves.toBe("stale");
    expect(store.value?.currentCredential).toBe(CURRENT);
    await expect(auth.credentialProvider.recordAuthenticated(
      second.lease.credentialVersion,
      second.lease.grantToken,
    )).resolves.toBe("recorded");
  });

  it("serializes one-use grants and durably rejects only the matching grant", async () => {
    const store = new FakeStore();
    store.value = record();
    const auth = createG2AuthController(options(store, new FakeHttp()));
    await auth.initialize();
    await auth.prepareSessionBoundary({ allowRotation: false });
    const acquired = await auth.credentialProvider.acquire();
    expect(Object.isFrozen(acquired)).toBe(true);
    if (acquired.kind !== "ready") throw new Error("expected credential lease");
    expect(Object.isFrozen(acquired.lease)).toBe(true);
    await expect(auth.credentialProvider.acquire()).resolves.toEqual({ kind: "required" });
    await expect(auth.credentialProvider.reject(
      acquired.lease.credentialVersion + 1,
      acquired.lease.grantToken,
    )).resolves.toBe("stale");
    await expect(auth.credentialProvider.reject(
      acquired.lease.credentialVersion,
      acquired.lease.grantToken,
    )).resolves.toBe("required");
    expect(store.events).toEqual(["load", "clear"]);
  });

  it("promotes pending before revocation and treats 401 as revocation-unconfirmed", async () => {
    const events: string[] = [];
    const store = new FakeStore(events);
    store.value = pendingRecord();
    const http = new FakeHttp(events);
    http.revokeError = httpFailure("rejected", 401);
    const auth = createG2AuthController(options(store, http));
    await auth.initialize();
    events.length = 0;

    await expect(auth.revokeCurrent()).resolves.toEqual({
      kind: "required",
      reason: "revocation-unconfirmed",
    });
    expect(events).toEqual(["health", "confirm", "save:current", "clear", "revoke"]);
    expect(http.revokedCredentials).toEqual([PENDING]);
    expect(store.value).toBeUndefined();
  });

  it("retains revocation intent across promoted-record save failure and retries clear then DELETE", async () => {
    const events: string[] = [];
    const store = new FakeStore(events);
    store.value = pendingRecord();
    store.failSaveCount = 1;
    const http = new FakeHttp(events);
    const auth = createG2AuthController(options(store, http));
    await auth.initialize();
    events.length = 0;

    await expect(auth.revokeCurrent()).resolves.toEqual({ kind: "storage-error" });
    expect(events).toEqual(["health", "confirm", "save:current"]);
    expect(http.revokedCredentials).toEqual([]);
    await expect(auth.credentialProvider.acquire()).resolves.toEqual({ kind: "storage-error" });

    await expect(auth.retryPersistence()).resolves.toEqual({
      kind: "required",
      reason: "revoked",
    });
    expect(events).toEqual([
      "health",
      "confirm",
      "save:current",
      "health",
      "clear",
      "revoke",
    ]);
    expect(http.revokedCredentials).toEqual([PENDING]);
    expect(store.value).toBeUndefined();
    await expect(auth.retryPersistence()).resolves.toEqual({ kind: "required", reason: "missing" });
  });

  it("uses pending for ambiguous-promotion revoke and reports only 204 as revoked", async () => {
    const uncertainStore = new FakeStore();
    uncertainStore.value = pendingRecord();
    const uncertainHttp = new FakeHttp();
    uncertainHttp.confirmError = httpFailure("unavailable", 503);
    uncertainHttp.revokeError = httpFailure("rejected", 401);
    const uncertain = createG2AuthController(options(uncertainStore, uncertainHttp));
    await uncertain.initialize();
    await expect(uncertain.revokeCurrent()).resolves.toEqual({
      kind: "required",
      reason: "revocation-unconfirmed",
    });
    expect(uncertainHttp.revokedCredentials).toEqual([PENDING]);

    const confirmedStore = new FakeStore();
    confirmedStore.value = record();
    const confirmedHttp = new FakeHttp();
    const confirmed = createG2AuthController(options(confirmedStore, confirmedHttp));
    await confirmed.initialize();
    await expect(confirmed.revokeCurrent()).resolves.toEqual({
      kind: "required",
      reason: "revoked",
    });
    expect(confirmedHttp.revokedCredentials).toEqual([CURRENT]);
  });

  it("drops pending on its bearer 401 without rejecting the current credential", async () => {
    const events: string[] = [];
    const store = new FakeStore(events);
    store.value = pendingRecord();
    const http = new FakeHttp(events);
    http.confirmError = httpFailure("rejected", 401);
    const auth = createG2AuthController(options(store, http));
    await auth.initialize();
    events.length = 0;
    await expect(auth.prepareSessionBoundary({ allowRotation: false })).resolves.toEqual({ kind: "ready" });
    expect(events).toEqual(["confirm", "save:current"]);
    expect(store.value?.currentCredential).toBe(CURRENT);
    expect(store.value?.pendingCredential).toBeUndefined();
  });

  it("serializes concurrent lifecycle calls", async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const events: string[] = [];
    const store = new FakeStore(events);
    store.value = record();
    const http = new FakeHttp(events);
    http.beginWait = gate.promise;
    http.onBegin = () => { started.resolve(); };
    const auth = createG2AuthController(options(store, http));
    await auth.initialize();
    events.length = 0;

    const boundary = auth.prepareSessionBoundary({ allowRotation: true });
    const reset = auth.resetEnrollment();
    await started.promise;
    expect(events).toEqual(["begin"]);
    gate.resolve();
    await expect(boundary).resolves.toEqual({ kind: "ready" });
    await expect(reset).resolves.toEqual({ kind: "required", reason: "missing" });
    expect(events).toEqual(["begin", "save:pending", "confirm", "save:current", "clear"]);
  });

  it("keeps outcomes secret-free and fails closed after disposal", async () => {
    const canary = "controller-canary";
    const store = new FakeStore();
    store.value = record({ currentCredential: CURRENT });
    const http = new FakeHttp();
    http.beginError = new Error(`${canary}:${CURRENT}:${PAIRING}`);
    const auth = createG2AuthController(options(store, http));
    await auth.initialize();
    const outcome = await auth.prepareSessionBoundary({ allowRotation: true });
    expect(JSON.stringify(outcome)).not.toContain(canary);
    expect(JSON.stringify(outcome)).not.toContain(CURRENT);
    expect(JSON.stringify(outcome)).not.toContain(PAIRING);

    auth.dispose();
    expect(http.disposed).toBe(true);
    expect(store.closed).toBe(true);
    await expect(auth.credentialProvider.acquire()).resolves.toEqual({ kind: "required" });
    await expect(auth.initialize()).resolves.toEqual({ kind: "unavailable" });
  });
});
