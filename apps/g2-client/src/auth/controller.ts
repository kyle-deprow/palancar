import {
  isBase64UrlSecret,
  isCanonicalPairingCode,
  isInstallationCredentialResponse,
  isRotationBeginResponse,
  isRotationConfirmationResponse,
} from "@palancar/contracts";

import type {
  CredentialStore,
  StoredInstallationCredential,
} from "./credential-store.js";
import type {
  AuthControllerNow,
  AuthHttpClientLike,
  AuthOutcome,
  AuthRequiredReason,
  CredentialAcquisition,
  G2AuthController,
  InstallationCredentialResponseLike,
  RotationBeginResponseLike,
  RotationConfirmationResponseLike,
  SessionCredentialGrantToken,
  SessionCredentialLease,
  SessionCredentialProvider,
} from "./types.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

const READY_OUTCOME: AuthOutcome = Object.freeze({ kind: "ready" });
const UNAVAILABLE_OUTCOME: AuthOutcome = Object.freeze({ kind: "unavailable" });
const STORAGE_ERROR_OUTCOME: AuthOutcome = Object.freeze({ kind: "storage-error" });
const REQUIRED_ACQUISITION: CredentialAcquisition = Object.freeze({ kind: "required" });
const STORAGE_ERROR_ACQUISITION: CredentialAcquisition = Object.freeze({ kind: "storage-error" });
const REQUIRED_OUTCOMES: Readonly<Record<AuthRequiredReason, AuthOutcome>> = Object.freeze({
  missing: Object.freeze({ kind: "required", reason: "missing" }),
  "absolute-expired": Object.freeze({ kind: "required", reason: "absolute-expired" }),
  "credential-rejected": Object.freeze({ kind: "required", reason: "credential-rejected" }),
  "pairing-failed": Object.freeze({ kind: "required", reason: "pairing-failed" }),
  "pairing-uncertain": Object.freeze({ kind: "required", reason: "pairing-uncertain" }),
  revoked: Object.freeze({ kind: "required", reason: "revoked" }),
  "revocation-unconfirmed": Object.freeze({ kind: "required", reason: "revocation-unconfirmed" }),
});

export interface G2AuthControllerOptions {
  readonly store: CredentialStore;
  readonly http: AuthHttpClientLike;
  readonly clock?: AuthControllerNow;
}

type QueueTask<T> = (generation: number) => Promise<T>;

interface HttpFailure {
  readonly category: string;
  readonly status?: number;
}

interface PendingClearIntent {
  readonly reason: AuthRequiredReason;
}

interface PendingRevocationIntent {
  readonly credential: string;
}

interface CallbackGrant {
  readonly credentialVersion: number;
  readonly grantToken: SessionCredentialGrantToken;
  phase: "acquired" | "authenticated";
}

type PersistResult =
  | { readonly kind: "saved" }
  | { readonly kind: "outcome"; readonly outcome: AuthOutcome };

type ClearResult =
  | { readonly kind: "cleared"; readonly reason: AuthRequiredReason }
  | { readonly kind: "failed" }
  | { readonly kind: "stale" };

type ContinueResult =
  | { readonly kind: "continue" }
  | { readonly kind: "outcome"; readonly outcome: AuthOutcome };

type RevocationCredentialResult =
  | { readonly kind: "credential"; readonly credential: string }
  | { readonly kind: "outcome"; readonly outcome: AuthOutcome };

function outcomeRequired(reason: AuthRequiredReason): AuthOutcome {
  return REQUIRED_OUTCOMES[reason];
}

function controllerConfigurationError(): never {
  throw new TypeError("Invalid authentication controller configuration.");
}

function getNow(clock: AuthControllerNow | undefined): number {
  const value = typeof clock === "function" ? clock() : clock?.now();
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function cloneRecord(record: StoredInstallationCredential): StoredInstallationCredential {
  const base = {
    key: record.key,
    schemaVersion: record.schemaVersion,
    installationId: record.installationId,
    idleExpiresAt: record.idleExpiresAt,
    absoluteExpiresAt: record.absoluteExpiresAt,
    currentCredential: record.currentCredential,
    currentCredentialVersion: record.currentCredentialVersion,
    currentRotationDueAt: record.currentRotationDueAt,
  };
  return record.pendingCredential === undefined
    ? Object.freeze(base)
    : Object.freeze({
      ...base,
      pendingCredential: record.pendingCredential,
      pendingCredentialVersion: record.pendingCredentialVersion!,
      pendingCredentialExpiresAt: record.pendingCredentialExpiresAt!,
      pendingRotationDueAt: record.pendingRotationDueAt!,
    });
}

function currentOnly(record: StoredInstallationCredential): StoredInstallationCredential {
  return cloneRecord({
    key: record.key,
    schemaVersion: record.schemaVersion,
    installationId: record.installationId,
    idleExpiresAt: record.idleExpiresAt,
    absoluteExpiresAt: record.absoluteExpiresAt,
    currentCredential: record.currentCredential,
    currentCredentialVersion: record.currentCredentialVersion,
    currentRotationDueAt: record.currentRotationDueAt,
  });
}

function conservativeBoundary(now: number, absoluteExpiresAt: string): string | undefined {
  const absolute = Date.parse(absoluteExpiresAt);
  if (!Number.isFinite(absolute)) return undefined;
  const boundary = Math.min(now + THIRTY_DAYS_MS, absolute);
  if (!Number.isFinite(boundary) || boundary < 0) return undefined;
  return new Date(boundary).toISOString();
}

function failureOf(error: unknown): HttpFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as { readonly category?: unknown; readonly status?: unknown };
  if (typeof value.category !== "string") return undefined;
  return typeof value.status === "number"
    ? { category: value.category, status: value.status }
    : { category: value.category };
}

function isBearerUnauthorized(error: unknown): boolean {
  const failure = failureOf(error);
  return failure?.category === "rejected" && failure.status === 401;
}

function isPairingDefiniteRejection(error: unknown): boolean {
  const failure = failureOf(error);
  return (
    failure?.category === "rejected" &&
    failure.status !== undefined &&
    failure.status >= 400 &&
    failure.status <= 499
  );
}

function isRotationConflict(error: unknown): boolean {
  const failure = failureOf(error);
  return failure?.category === "conflict" && failure.status === 409;
}

function absoluteExpired(record: StoredInstallationCredential, now: number): boolean {
  const absolute = Date.parse(record.absoluteExpiresAt);
  return !Number.isFinite(absolute) || absolute <= now;
}

function pendingExpired(record: StoredInstallationCredential, now: number): boolean {
  if (record.pendingCredentialExpiresAt === undefined) return false;
  const pending = Date.parse(record.pendingCredentialExpiresAt);
  return !Number.isFinite(pending) || pending <= now;
}

function asInstallationRecord(
  response: InstallationCredentialResponseLike,
): StoredInstallationCredential | undefined {
  if (!isInstallationCredentialResponse(response)) return undefined;
  return cloneRecord({
    key: "active",
    schemaVersion: 1,
    installationId: response.installationId,
    idleExpiresAt: response.idleExpiresAt,
    absoluteExpiresAt: response.absoluteExpiresAt,
    currentCredential: response.credential,
    currentCredentialVersion: response.credentialVersion,
    currentRotationDueAt: response.idleExpiresAt,
  });
}

function withPending(
  current: StoredInstallationCredential,
  response: RotationBeginResponseLike,
  pendingRotationDueAt: string,
  now: number,
): StoredInstallationCredential | undefined {
  if (
    !isRotationBeginResponse(response) ||
    response.pendingCredentialVersion !== current.currentCredentialVersion + 1 ||
    Date.parse(response.pendingCredentialExpiresAt) <= now ||
    Date.parse(response.pendingCredentialExpiresAt) > Date.parse(current.absoluteExpiresAt) ||
    Date.parse(response.pendingCredentialExpiresAt) > Date.parse(pendingRotationDueAt)
  ) {
    return undefined;
  }
  return cloneRecord({
    ...currentOnly(current),
    pendingCredential: response.pendingCredential,
    pendingCredentialVersion: response.pendingCredentialVersion,
    pendingCredentialExpiresAt: response.pendingCredentialExpiresAt,
    pendingRotationDueAt,
  });
}

function promotedRecord(
  current: StoredInstallationCredential,
  response: RotationConfirmationResponseLike,
  now: number,
): StoredInstallationCredential | undefined {
  if (
    current.pendingCredential === undefined ||
    current.pendingCredentialVersion === undefined ||
    !isRotationConfirmationResponse(response) ||
    response.credentialVersion !== current.pendingCredentialVersion ||
    response.expiresAt !== current.absoluteExpiresAt
  ) {
    return undefined;
  }
  const boundary = conservativeBoundary(now, current.absoluteExpiresAt);
  if (boundary === undefined) return undefined;
  return cloneRecord({
    key: current.key,
    schemaVersion: current.schemaVersion,
    installationId: current.installationId,
    idleExpiresAt: boundary,
    absoluteExpiresAt: current.absoluteExpiresAt,
    currentCredential: current.pendingCredential,
    currentCredentialVersion: current.pendingCredentialVersion,
    currentRotationDueAt: boundary,
  });
}

function createGrantToken(): SessionCredentialGrantToken {
  return Object.freeze({}) as SessionCredentialGrantToken;
}

export function createG2AuthController(options: G2AuthControllerOptions): G2AuthController {
  const { store, http, clock } = options;
  if (
    typeof store !== "object" || store === null ||
    typeof store.load !== "function" ||
    typeof store.save !== "function" ||
    typeof store.clear !== "function" ||
    typeof store.close !== "function" ||
    typeof http !== "object" || http === null ||
    typeof http.ensureRelayAwake !== "function" ||
    typeof http.redeemPairing !== "function" ||
    typeof http.beginRotation !== "function" ||
    typeof http.confirmRotation !== "function" ||
    typeof http.revokeCurrent !== "function" ||
    typeof http.dispose !== "function"
  ) {
    controllerConfigurationError();
  }

  let disposed = false;
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  let initialized = false;
  let storageError = false;
  let volatileRecord = false;
  let record: StoredInstallationCredential | undefined;
  let pendingClear: PendingClearIntent | undefined;
  let pendingRevocation: PendingRevocationIntent | undefined;
  let grant: SessionCredentialLease | undefined;
  let callbackGrant: CallbackGrant | undefined;

  const active = (taskGeneration: number): boolean => !disposed && generation === taskGeneration;

  const invalidateGrants = (): void => {
    grant = undefined;
    callbackGrant = undefined;
  };

  const enqueue = <T>(fallback: () => T, task: QueueTask<T>): Promise<T> => {
    if (disposed) return Promise.resolve(fallback());
    const taskGeneration = generation;
    const run = queue.then(async () => {
      if (!active(taskGeneration)) return fallback();
      try {
        return await task(taskGeneration);
      } catch {
        return fallback();
      }
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  const beginClear = (reason: AuthRequiredReason): PendingClearIntent => {
    const intent = Object.freeze({ reason });
    pendingClear = intent;
    record = undefined;
    volatileRecord = false;
    initialized = true;
    storageError = true;
    invalidateGrants();
    return intent;
  };

  const performPendingClear = async (taskGeneration: number): Promise<ClearResult> => {
    const intent = pendingClear;
    if (intent === undefined) return { kind: "stale" };
    try {
      await store.clear();
    } catch {
      if (!active(taskGeneration)) return { kind: "stale" };
      storageError = true;
      return { kind: "failed" };
    }
    if (!active(taskGeneration) || pendingClear !== intent) return { kind: "stale" };
    pendingClear = undefined;
    record = undefined;
    volatileRecord = false;
    initialized = true;
    storageError = false;
    invalidateGrants();
    return { kind: "cleared", reason: intent.reason };
  };

  const clearForOutcome = async (
    taskGeneration: number,
    reason: AuthRequiredReason,
  ): Promise<AuthOutcome> => {
    beginClear(reason);
    const result = await performPendingClear(taskGeneration);
    if (result.kind === "stale") return UNAVAILABLE_OUTCOME;
    if (result.kind === "failed") return STORAGE_ERROR_OUTCOME;
    return outcomeRequired(result.reason);
  };

  const continuePendingRevocation = async (taskGeneration: number): Promise<AuthOutcome> => {
    const intent = pendingRevocation;
    if (intent === undefined) return UNAVAILABLE_OUTCOME;
    invalidateGrants();
    try {
      await http.ensureRelayAwake();
    } catch {
      return UNAVAILABLE_OUTCOME;
    }
    if (!active(taskGeneration) || pendingRevocation !== intent) return UNAVAILABLE_OUTCOME;
    if (pendingClear === undefined) beginClear("revocation-unconfirmed");
    const cleared = await performPendingClear(taskGeneration);
    if (cleared.kind === "stale") return UNAVAILABLE_OUTCOME;
    if (cleared.kind === "failed") return STORAGE_ERROR_OUTCOME;
    try {
      const result = await http.revokeCurrent(intent.credential);
      if (!active(taskGeneration) || pendingRevocation !== intent) return UNAVAILABLE_OUTCOME;
      pendingRevocation = undefined;
      return result === "confirmed"
        ? outcomeRequired("revoked")
        : outcomeRequired("revocation-unconfirmed");
    } catch {
      if (!active(taskGeneration) || pendingRevocation !== intent) return UNAVAILABLE_OUTCOME;
      pendingRevocation = undefined;
      return outcomeRequired("revocation-unconfirmed");
    }
  };

  const expireCurrent = async (taskGeneration: number): Promise<AuthOutcome | undefined> => {
    const current = record;
    if (current === undefined || !absoluteExpired(current, getNow(clock))) return undefined;
    return clearForOutcome(taskGeneration, "absolute-expired");
  };

  const persistRecord = async (
    taskGeneration: number,
    nextRecord: StoredInstallationCredential,
  ): Promise<PersistResult> => {
    record = cloneRecord(nextRecord);
    volatileRecord = true;
    storageError = false;
    const beforeSaveExpiry = await expireCurrent(taskGeneration);
    if (beforeSaveExpiry !== undefined) return { kind: "outcome", outcome: beforeSaveExpiry };
    if (!active(taskGeneration) || record === undefined) {
      return { kind: "outcome", outcome: UNAVAILABLE_OUTCOME };
    }
    try {
      await store.save(record);
    } catch {
      if (!active(taskGeneration)) return { kind: "outcome", outcome: UNAVAILABLE_OUTCOME };
      storageError = true;
      return { kind: "outcome", outcome: STORAGE_ERROR_OUTCOME };
    }
    if (!active(taskGeneration)) return { kind: "outcome", outcome: UNAVAILABLE_OUTCOME };
    const afterSaveExpiry = await expireCurrent(taskGeneration);
    if (afterSaveExpiry !== undefined) return { kind: "outcome", outcome: afterSaveExpiry };
    volatileRecord = false;
    storageError = false;
    return { kind: "saved" };
  };

  const initializeCore = async (taskGeneration: number): Promise<AuthOutcome> => {
    if (pendingRevocation !== undefined) return STORAGE_ERROR_OUTCOME;
    if (pendingClear !== undefined) {
      const cleared = await performPendingClear(taskGeneration);
      if (cleared.kind === "stale") return UNAVAILABLE_OUTCOME;
      if (cleared.kind === "failed") return STORAGE_ERROR_OUTCOME;
      return outcomeRequired(cleared.reason);
    }
    let loaded: StoredInstallationCredential | undefined;
    try {
      loaded = await store.load();
    } catch {
      if (!active(taskGeneration)) return UNAVAILABLE_OUTCOME;
      record = undefined;
      volatileRecord = false;
      initialized = true;
      storageError = true;
      invalidateGrants();
      return STORAGE_ERROR_OUTCOME;
    }
    if (!active(taskGeneration)) return UNAVAILABLE_OUTCOME;
    invalidateGrants();
    volatileRecord = false;
    if (loaded === undefined) {
      record = undefined;
      initialized = true;
      storageError = false;
      return outcomeRequired("missing");
    }
    record = cloneRecord(loaded);
    initialized = true;
    storageError = false;
    const expiry = await expireCurrent(taskGeneration);
    return expiry ?? READY_OUTCOME;
  };

  const initialize = (): Promise<AuthOutcome> => enqueue(
    () => UNAVAILABLE_OUTCOME,
    (taskGeneration) => initializeCore(taskGeneration),
  );

  const enroll = (pairingCode: string): Promise<AuthOutcome> => enqueue(
    () => UNAVAILABLE_OUTCOME,
    async (taskGeneration) => {
      invalidateGrants();
      if (pendingRevocation !== undefined) return STORAGE_ERROR_OUTCOME;
      if (pendingClear !== undefined) {
        const cleared = await performPendingClear(taskGeneration);
        if (cleared.kind === "stale") return UNAVAILABLE_OUTCOME;
        if (cleared.kind === "failed") return STORAGE_ERROR_OUTCOME;
      }
      if (storageError && volatileRecord) return STORAGE_ERROR_OUTCOME;
      if (!isCanonicalPairingCode(pairingCode)) return outcomeRequired("pairing-failed");
      try {
        await http.ensureRelayAwake();
      } catch {
        return UNAVAILABLE_OUTCOME;
      }
      if (!active(taskGeneration)) return UNAVAILABLE_OUTCOME;
      const existingExpiry = await expireCurrent(taskGeneration);
      if (existingExpiry?.kind === "storage-error") return existingExpiry;
      let response: InstallationCredentialResponseLike;
      try {
        response = await http.redeemPairing(pairingCode);
      } catch (error: unknown) {
        if (!active(taskGeneration)) return UNAVAILABLE_OUTCOME;
        return isPairingDefiniteRejection(error)
          ? outcomeRequired("pairing-failed")
          : outcomeRequired("pairing-uncertain");
      }
      if (!active(taskGeneration)) return UNAVAILABLE_OUTCOME;
      const next = asInstallationRecord(response);
      if (next === undefined || absoluteExpired(next, getNow(clock))) {
        return outcomeRequired("pairing-uncertain");
      }
      initialized = true;
      const persisted = await persistRecord(taskGeneration, next);
      return persisted.kind === "saved" ? READY_OUTCOME : persisted.outcome;
    },
  );

  const retryPersistence = (): Promise<AuthOutcome> => enqueue(
    () => UNAVAILABLE_OUTCOME,
    async (taskGeneration) => {
      if (pendingRevocation !== undefined) {
        return continuePendingRevocation(taskGeneration);
      }
      if (pendingClear !== undefined) {
        const cleared = await performPendingClear(taskGeneration);
        if (cleared.kind === "stale") return UNAVAILABLE_OUTCOME;
        if (cleared.kind === "failed") return STORAGE_ERROR_OUTCOME;
        return outcomeRequired(cleared.reason);
      }
      if (volatileRecord && record !== undefined) {
        const persisted = await persistRecord(taskGeneration, record);
        return persisted.kind === "saved" ? READY_OUTCOME : persisted.outcome;
      }
      return initializeCore(taskGeneration);
    },
  );

  const resetEnrollment = (): Promise<AuthOutcome> => enqueue(
    () => UNAVAILABLE_OUTCOME,
    async (taskGeneration) => {
      if (pendingRevocation !== undefined) return STORAGE_ERROR_OUTCOME;
      beginClear("missing");
      const cleared = await performPendingClear(taskGeneration);
      if (cleared.kind === "stale") return UNAVAILABLE_OUTCOME;
      if (cleared.kind === "failed") return STORAGE_ERROR_OUTCOME;
      return outcomeRequired("missing");
    },
  );

  const dropPending = async (taskGeneration: number): Promise<ContinueResult> => {
    const current = record;
    if (current === undefined) return { kind: "outcome", outcome: UNAVAILABLE_OUTCOME };
    const persisted = await persistRecord(taskGeneration, currentOnly(current));
    return persisted.kind === "saved"
      ? { kind: "continue" }
      : { kind: "outcome", outcome: persisted.outcome };
  };

  const resolvePendingForBoundary = async (taskGeneration: number): Promise<ContinueResult> => {
    const current = record;
    if (current?.pendingCredential === undefined) return { kind: "continue" };
    if (pendingExpired(current, getNow(clock))) return dropPending(taskGeneration);

    let response: RotationConfirmationResponseLike;
    try {
      response = await http.confirmRotation(current.pendingCredential);
    } catch (error: unknown) {
      if (!active(taskGeneration)) return { kind: "outcome", outcome: UNAVAILABLE_OUTCOME };
      const expiry = await expireCurrent(taskGeneration);
      if (expiry !== undefined) return { kind: "outcome", outcome: expiry };
      if (record !== undefined && pendingExpired(record, getNow(clock))) {
        return dropPending(taskGeneration);
      }
      if (isBearerUnauthorized(error)) return dropPending(taskGeneration);
      return { kind: "outcome", outcome: UNAVAILABLE_OUTCOME };
    }
    if (!active(taskGeneration)) return { kind: "outcome", outcome: UNAVAILABLE_OUTCOME };
    const expiry = await expireCurrent(taskGeneration);
    if (expiry !== undefined) return { kind: "outcome", outcome: expiry };
    const activeRecord = record;
    if (activeRecord === undefined) return { kind: "outcome", outcome: UNAVAILABLE_OUTCOME };
    const promoted = promotedRecord(activeRecord, response, getNow(clock));
    if (promoted === undefined) return { kind: "outcome", outcome: UNAVAILABLE_OUTCOME };
    const persisted = await persistRecord(taskGeneration, promoted);
    return persisted.kind === "saved"
      ? { kind: "continue" }
      : { kind: "outcome", outcome: persisted.outcome };
  };

  const prepareSessionBoundary = (
    boundaryOptions: { readonly allowRotation: boolean },
  ): Promise<AuthOutcome> => enqueue(
    () => UNAVAILABLE_OUTCOME,
    async (taskGeneration) => {
      invalidateGrants();
      if (pendingRevocation !== undefined) return STORAGE_ERROR_OUTCOME;
      if (pendingClear !== undefined) {
        const cleared = await performPendingClear(taskGeneration);
        if (cleared.kind === "stale") return UNAVAILABLE_OUTCOME;
        if (cleared.kind === "failed") return STORAGE_ERROR_OUTCOME;
        return outcomeRequired(cleared.reason);
      }
      if (storageError) return STORAGE_ERROR_OUTCOME;
      if (!initialized) return UNAVAILABLE_OUTCOME;
      if (record === undefined) return outcomeRequired("missing");
      const initialExpiry = await expireCurrent(taskGeneration);
      if (initialExpiry !== undefined) return initialExpiry;

      const pending = await resolvePendingForBoundary(taskGeneration);
      if (pending.kind === "outcome") return pending.outcome;
      if (!active(taskGeneration) || record === undefined) return UNAVAILABLE_OUTCOME;
      const postPendingExpiry = await expireCurrent(taskGeneration);
      if (postPendingExpiry !== undefined) return postPendingExpiry;
      if (!active(taskGeneration) || record === undefined) return UNAVAILABLE_OUTCOME;

      const now = getNow(clock);
      if (boundaryOptions.allowRotation && now >= Date.parse(record.currentRotationDueAt)) {
        const currentCredential = record.currentCredential;
        let response: RotationBeginResponseLike | undefined;
        try {
          response = await http.beginRotation(currentCredential);
        } catch (error: unknown) {
          if (!active(taskGeneration)) return UNAVAILABLE_OUTCOME;
          const expiry = await expireCurrent(taskGeneration);
          if (expiry !== undefined) return expiry;
          if (isBearerUnauthorized(error)) {
            return clearForOutcome(taskGeneration, "credential-rejected");
          }
          if (!isRotationConflict(error)) return UNAVAILABLE_OUTCOME;
        }
        if (response !== undefined) {
          if (!active(taskGeneration) || record === undefined) return UNAVAILABLE_OUTCOME;
          const expiry = await expireCurrent(taskGeneration);
          if (expiry !== undefined) return expiry;
          const pendingNow = getNow(clock);
          const pendingDue = conservativeBoundary(pendingNow, record.absoluteExpiresAt);
          if (pendingDue === undefined) return UNAVAILABLE_OUTCOME;
          const next = withPending(record, response, pendingDue, pendingNow);
          if (next === undefined) return UNAVAILABLE_OUTCOME;
          const persistedPending = await persistRecord(taskGeneration, next);
          if (persistedPending.kind === "outcome") return persistedPending.outcome;
          const confirmation = await resolvePendingForBoundary(taskGeneration);
          if (confirmation.kind === "outcome") return confirmation.outcome;
        }
      }

      const beforeGrantExpiry = await expireCurrent(taskGeneration);
      if (beforeGrantExpiry !== undefined) return beforeGrantExpiry;
      const current = record;
      if (current === undefined || current.pendingCredential !== undefined) return UNAVAILABLE_OUTCOME;
      const grantNow = getNow(clock);
      if (absoluteExpired(current, grantNow)) {
        return clearForOutcome(taskGeneration, "absolute-expired");
      }
      if (!isBase64UrlSecret(current.currentCredential)) return UNAVAILABLE_OUTCOME;
      const lease: SessionCredentialLease = Object.freeze({
        credential: current.currentCredential,
        credentialVersion: current.currentCredentialVersion,
        grantToken: createGrantToken(),
      });
      grant = lease;
      return READY_OUTCOME;
    },
  );

  const acquire = (): Promise<CredentialAcquisition> => enqueue(
    () => REQUIRED_ACQUISITION,
    async (taskGeneration) => {
      if (pendingRevocation !== undefined || pendingClear !== undefined || storageError) {
        return STORAGE_ERROR_ACQUISITION;
      }
      if (grant === undefined) return REQUIRED_ACQUISITION;
      const expiry = await expireCurrent(taskGeneration);
      if (expiry !== undefined) {
        return expiry.kind === "storage-error" ? STORAGE_ERROR_ACQUISITION : REQUIRED_ACQUISITION;
      }
      if (!active(taskGeneration) || record === undefined || grant === undefined) {
        return REQUIRED_ACQUISITION;
      }
      if (absoluteExpired(record, getNow(clock))) {
        const finalExpiry = await clearForOutcome(taskGeneration, "absolute-expired");
        return finalExpiry.kind === "storage-error"
          ? STORAGE_ERROR_ACQUISITION
          : REQUIRED_ACQUISITION;
      }
      const lease = grant;
      grant = undefined;
      callbackGrant = {
        credentialVersion: lease.credentialVersion,
        grantToken: lease.grantToken,
        phase: "acquired",
      };
      return Object.freeze({ kind: "ready", lease });
    },
  );

  const recordAuthenticated = (
    version: number,
    grantToken: SessionCredentialGrantToken,
  ): Promise<"recorded" | "stale" | "storage-error"> => enqueue(
    () => "stale",
    async (taskGeneration) => {
      const activeGrant = callbackGrant;
      if (
        activeGrant === undefined ||
        activeGrant.phase !== "acquired" ||
        activeGrant.credentialVersion !== version ||
        activeGrant.grantToken !== grantToken ||
        record === undefined ||
        record.currentCredentialVersion !== version
      ) {
        return "stale";
      }
      if (pendingClear !== undefined || storageError) return "storage-error";
      const expiry = await expireCurrent(taskGeneration);
      if (expiry !== undefined) return expiry.kind === "storage-error" ? "storage-error" : "stale";
      if (record === undefined) return "stale";
      const boundary = conservativeBoundary(getNow(clock), record.absoluteExpiresAt);
      if (boundary === undefined) return "storage-error";
      const persisted = await persistRecord(
        taskGeneration,
        cloneRecord({ ...record, idleExpiresAt: boundary }),
      );
      if (persisted.kind === "outcome") {
        invalidateGrants();
        return persisted.outcome.kind === "storage-error" ? "storage-error" : "stale";
      }
      if (
        callbackGrant !== activeGrant ||
        record === undefined ||
        absoluteExpired(record, getNow(clock))
      ) {
        const finalExpiry = await expireCurrent(taskGeneration);
        return finalExpiry?.kind === "storage-error" ? "storage-error" : "stale";
      }
      activeGrant.phase = "authenticated";
      return "recorded";
    },
  );

  const reject = (
    version: number,
    grantToken: SessionCredentialGrantToken,
  ): Promise<"required" | "stale" | "storage-error"> => enqueue(
    () => "stale",
    async (taskGeneration) => {
      const activeGrant = callbackGrant;
      if (
        activeGrant === undefined ||
        activeGrant.credentialVersion !== version ||
        activeGrant.grantToken !== grantToken ||
        record === undefined ||
        record.currentCredentialVersion !== version
      ) {
        return "stale";
      }
      beginClear("credential-rejected");
      const cleared = await performPendingClear(taskGeneration);
      if (cleared.kind === "stale") return "stale";
      return cleared.kind === "failed" ? "storage-error" : "required";
    },
  );

  const credentialForRevocation = async (
    taskGeneration: number,
  ): Promise<RevocationCredentialResult> => {
    const current = record;
    if (current === undefined) return { kind: "outcome", outcome: outcomeRequired("missing") };
    if (current.pendingCredential === undefined) {
      return { kind: "credential", credential: current.currentCredential };
    }
    if (pendingExpired(current, getNow(clock))) {
      const dropped = await dropPending(taskGeneration);
      if (dropped.kind === "outcome") return dropped;
      return record === undefined
        ? { kind: "outcome", outcome: UNAVAILABLE_OUTCOME }
        : { kind: "credential", credential: record.currentCredential };
    }

    const pendingCredential = current.pendingCredential;
    let response: RotationConfirmationResponseLike;
    try {
      response = await http.confirmRotation(pendingCredential);
    } catch (error: unknown) {
      if (!active(taskGeneration)) return { kind: "outcome", outcome: UNAVAILABLE_OUTCOME };
      const expiry = await expireCurrent(taskGeneration);
      if (expiry !== undefined) return { kind: "outcome", outcome: expiry };
      if (record !== undefined && pendingExpired(record, getNow(clock))) {
        const dropped = await dropPending(taskGeneration);
        if (dropped.kind === "outcome") return dropped;
        return record === undefined
          ? { kind: "outcome", outcome: UNAVAILABLE_OUTCOME }
          : { kind: "credential", credential: record.currentCredential };
      }
      if (isBearerUnauthorized(error)) {
        const dropped = await dropPending(taskGeneration);
        if (dropped.kind === "outcome") return dropped;
        return record === undefined
          ? { kind: "outcome", outcome: UNAVAILABLE_OUTCOME }
          : { kind: "credential", credential: record.currentCredential };
      }
      return { kind: "credential", credential: pendingCredential };
    }
    if (!active(taskGeneration)) return { kind: "outcome", outcome: UNAVAILABLE_OUTCOME };
    const expiry = await expireCurrent(taskGeneration);
    if (expiry !== undefined) return { kind: "outcome", outcome: expiry };
    const activeRecord = record;
    if (activeRecord === undefined) return { kind: "outcome", outcome: UNAVAILABLE_OUTCOME };
    const promoted = promotedRecord(activeRecord, response, getNow(clock));
    if (promoted === undefined) return { kind: "credential", credential: pendingCredential };
    const persisted = await persistRecord(taskGeneration, promoted);
    if (
      persisted.kind === "outcome" &&
      persisted.outcome.kind === "storage-error" &&
      active(taskGeneration)
    ) {
      pendingRevocation = Object.freeze({ credential: pendingCredential });
      invalidateGrants();
    }
    return persisted.kind === "outcome"
      ? { kind: "outcome", outcome: persisted.outcome }
      : { kind: "credential", credential: promoted.currentCredential };
  };

  const revokeCurrent = (): Promise<AuthOutcome> => enqueue(
    () => UNAVAILABLE_OUTCOME,
    async (taskGeneration) => {
      invalidateGrants();
      if (pendingRevocation !== undefined) {
        return continuePendingRevocation(taskGeneration);
      }
      if (pendingClear !== undefined) {
        const cleared = await performPendingClear(taskGeneration);
        if (cleared.kind === "stale") return UNAVAILABLE_OUTCOME;
        if (cleared.kind === "failed") return STORAGE_ERROR_OUTCOME;
        return outcomeRequired(cleared.reason);
      }
      if (storageError) return STORAGE_ERROR_OUTCOME;
      if (!initialized) return UNAVAILABLE_OUTCOME;
      if (record === undefined) return outcomeRequired("missing");
      const initialExpiry = await expireCurrent(taskGeneration);
      if (initialExpiry !== undefined) return initialExpiry;
      try {
        await http.ensureRelayAwake();
      } catch {
        return UNAVAILABLE_OUTCOME;
      }
      if (!active(taskGeneration)) return UNAVAILABLE_OUTCOME;
      const postHealthExpiry = await expireCurrent(taskGeneration);
      if (postHealthExpiry !== undefined) return postHealthExpiry;
      const candidate = await credentialForRevocation(taskGeneration);
      if (candidate.kind === "outcome") return candidate.outcome;
      const candidateExpiry = await expireCurrent(taskGeneration);
      if (candidateExpiry !== undefined) return candidateExpiry;
      if (!active(taskGeneration) || record === undefined) return UNAVAILABLE_OUTCOME;
      beginClear("revocation-unconfirmed");
      const cleared = await performPendingClear(taskGeneration);
      if (cleared.kind === "stale") return UNAVAILABLE_OUTCOME;
      if (cleared.kind === "failed") return STORAGE_ERROR_OUTCOME;
      try {
        const result = await http.revokeCurrent(candidate.credential);
        if (!active(taskGeneration)) return UNAVAILABLE_OUTCOME;
        return result === "confirmed"
          ? outcomeRequired("revoked")
          : outcomeRequired("revocation-unconfirmed");
      } catch {
        return active(taskGeneration)
          ? outcomeRequired("revocation-unconfirmed")
          : UNAVAILABLE_OUTCOME;
      }
    },
  );

  const credentialProvider: SessionCredentialProvider = Object.freeze({
    acquire,
    recordAuthenticated,
    reject,
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    record = undefined;
    volatileRecord = false;
    pendingClear = undefined;
    pendingRevocation = undefined;
    initialized = false;
    storageError = false;
    invalidateGrants();
    try {
      http.dispose();
    } catch {
      // Disposal is fail-closed even if an injected client has a platform failure.
    }
    try {
      store.close();
    } catch {
      // Disposal is fail-closed even if an injected store has a platform failure.
    }
  };

  return Object.freeze({
    initialize,
    enroll,
    retryPersistence,
    resetEnrollment,
    prepareSessionBoundary,
    revokeCurrent,
    credentialProvider,
    dispose,
  });
}
