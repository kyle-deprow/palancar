import {
  assertInstallationCredentialResponse,
  assertRotationBeginResponse,
  assertRotationConfirmationResponse,
  isBase64UrlSecret,
  isCanonicalPairingCode,
  type InstallationCredentialResponse,
  type RotationBeginResponse,
  type RotationConfirmationResponse,
} from "@palancar/contracts";

export const AUTH_HTTP_MAX_BODY_BYTES = 16 * 1024;
export const AUTH_HTTP_DEADLINE_MS = 30_000;
export const AUTH_HTTP_HEALTH_CACHE_MS = 30_000;

export type AuthHttpClientErrorCategory =
  | "configuration"
  | "rejected"
  | "conflict"
  | "unavailable"
  | "protocol"
  | "timeout"
  | "disposed";

const ERROR_MESSAGES: Readonly<Record<AuthHttpClientErrorCategory, string>> = Object.freeze({
  configuration: "Invalid authentication relay configuration.",
  rejected: "Authentication request rejected.",
  conflict: "Authentication request conflicted.",
  unavailable: "Authentication relay unavailable.",
  protocol: "Authentication relay protocol error.",
  timeout: "Authentication relay request timed out.",
  disposed: "Authentication HTTP client disposed.",
});

export class AuthHttpClientError extends Error {
  readonly category: AuthHttpClientErrorCategory;
  readonly status?: number;

  constructor(category: AuthHttpClientErrorCategory, status?: number) {
    super(ERROR_MESSAGES[category]);
    this.name = "AuthHttpClientError";
    this.category = category;
    if (status !== undefined) this.status = status;
    Object.freeze(this);
  }
}

export interface AuthHttpClient {
  ensureRelayAwake(): Promise<void>;
  redeemPairing(code: string): Promise<InstallationCredentialResponse>;
  beginRotation(credential: string): Promise<RotationBeginResponse>;
  confirmRotation(credential: string): Promise<RotationConfirmationResponse>;
  revokeCurrent(credential: string): Promise<"confirmed">;
  dispose(): void;
}

export interface AuthHttpClientClock {
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

type AuthFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface AuthHttpClientOptions {
  readonly relayOrigin: string;
  readonly fetch?: AuthFetch;
  readonly fetchImpl?: AuthFetch;
  readonly clock?: AuthHttpClientClock | (() => number);
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

type RequestKind = "health" | "pairing" | "rotation-begin" | "rotation-confirmation" | "revoke";
type CancelTimer = () => void;

interface ActiveRequest {
  readonly stop: (category: "timeout" | "disposed") => void;
}

function fixedError(category: AuthHttpClientErrorCategory, status?: number): AuthHttpClientError {
  return new AuthHttpClientError(category, status);
}

function normalizeError(error: unknown): AuthHttpClientError {
  return error instanceof AuthHttpClientError ? error : fixedError("unavailable");
}

function fixedBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return operation().catch((error: unknown) => Promise.reject(normalizeError(error)));
  } catch (error: unknown) {
    return Promise.reject(normalizeError(error));
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function isExactHealth(value: unknown): boolean {
  return isPlainObject(value) && Reflect.ownKeys(value).length === 1 && value.ok === true;
}

function validRelayOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.endsWith("/")) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function nowFrom(options: AuthHttpClientOptions): number {
  const clock = options.clock;
  const value = typeof clock === "function" ? clock() : clock?.now?.();
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function scheduleFrom(options: AuthHttpClientOptions, callback: () => void, delayMs: number): CancelTimer {
  if (options.schedule !== undefined) return options.schedule(callback, delayMs);
  if (typeof options.clock !== "function" && options.clock?.schedule !== undefined) {
    return options.clock.schedule(callback, delayMs);
  }
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timer);
}

function statusError(kind: RequestKind, status: number): AuthHttpClientError {
  if (status >= 500 && status <= 599) return fixedError("unavailable", status);
  if (kind === "pairing" && status >= 400 && status <= 499) {
    return fixedError("rejected", status);
  }
  if (kind === "rotation-begin" && status === 409) {
    return fixedError("conflict", status);
  }
  if (kind !== "health" && kind !== "pairing" && status === 401) {
    return fixedError("rejected", status);
  }
  return fixedError("protocol", status);
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body === null) return;
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best effort; the fixed outer failure is authoritative.
  }
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > AUTH_HTTP_MAX_BODY_BYTES) {
      cancelBody(response.body);
      throw fixedError("protocol", response.status);
    }
  }

  if (response.body === null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > AUTH_HTTP_MAX_BODY_BYTES) {
      throw fixedError("protocol", response.status);
    }
    return text;
  }

  const reader = response.body.getReader();
  const cancelReader = (): void => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cancellation is best effort; the raced fixed failure is authoritative.
    }
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  if (signal.aborted) cancelReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > AUTH_HTTP_MAX_BODY_BYTES) {
        cancelReader();
        throw fixedError("protocol", response.status);
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fixedError("protocol", response.status);
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const text = await readBoundedBody(response, signal);
  if (text.length === 0) throw fixedError("protocol", response.status);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw fixedError("protocol", response.status);
  }
}

function freezeResponse<T extends object>(value: T): T {
  return Object.freeze({ ...value });
}

export function createAuthHttpClient(options: AuthHttpClientOptions): AuthHttpClient {
  if (!validRelayOrigin(options.relayOrigin)) throw fixedError("configuration");

  const fetchImpl = options.fetch ?? options.fetchImpl ?? (
    (input: string, init: RequestInit) => globalThis.fetch(input, init)
  );
  const origin = options.relayOrigin;
  const activeRequests = new Set<ActiveRequest>();
  let disposed = false;
  let healthCheckedAt: number | undefined;
  let healthFlight: Promise<void> | undefined;
  let healthGeneration = 0;

  const ensureNotDisposed = (): void => {
    if (disposed) throw fixedError("disposed");
  };

  const request = async <T>(
    kind: RequestKind,
    path: string,
    init: RequestInit,
    handle: (response: Response, signal: AbortSignal) => Promise<T>,
    acceptedStatus: (status: number) => boolean,
  ): Promise<T> => {
    let cancelTimer: CancelTimer | undefined;
    let registration: ActiveRequest | undefined;
    try {
      ensureNotDisposed();
      const controller = new AbortController();
      let stoppedAs: "timeout" | "disposed" | undefined;
      let responseBody: ReadableStream<Uint8Array> | null | undefined;
      let rejectStop!: (error: AuthHttpClientError) => void;
      const stopped = new Promise<never>((_resolve, reject) => {
        rejectStop = reject;
      });
      void stopped.catch(() => undefined);
      registration = {
        stop: (category) => {
          if (stoppedAs !== undefined) return;
          stoppedAs = category;
          rejectStop(fixedError(category));
          try {
            controller.abort();
          } catch {
            // The raced fixed failure does not depend on AbortController cooperation.
          }
          if (responseBody !== undefined) cancelBody(responseBody);
        },
      };
      activeRequests.add(registration);
      cancelTimer = scheduleFrom(
        options,
        () => registration?.stop("timeout"),
        AUTH_HTTP_DEADLINE_MS,
      );
      if (stoppedAs !== undefined) throw fixedError(stoppedAs);

      const operation = (async (): Promise<T> => {
        const response = await fetchImpl(`${origin}${path}`, {
          ...init,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
        responseBody = response.body;
        if (stoppedAs !== undefined) {
          cancelBody(response.body);
          throw fixedError(stoppedAs);
        }
        const status = response.status;
        if (!acceptedStatus(status)) {
          cancelBody(response.body);
          throw statusError(kind, status);
        }
        const result = await handle(response, controller.signal);
        if (stoppedAs !== undefined) throw fixedError(stoppedAs);
        return result;
      })();

      const result = await Promise.race([operation, stopped]);
      if (disposed) throw fixedError("disposed");
      if (stoppedAs !== undefined) throw fixedError(stoppedAs);
      return result;
    } catch (error: unknown) {
      throw normalizeError(error);
    } finally {
      try {
        const cleanupResult = (cancelTimer as (() => unknown) | undefined)?.();
        void Promise.resolve(cleanupResult).catch(() => undefined);
      } catch {
        // Injected/platform cleanup failures never override the operation result.
      }
      if (registration !== undefined) activeRequests.delete(registration);
    }
  };

  const jsonRequest = <T>(
    kind: RequestKind,
    path: string,
    body: unknown,
    handle: (value: unknown, status: number) => T,
    credential?: string,
  ): Promise<T> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (credential !== undefined) headers.Authorization = `Bearer ${credential}`;
    return request(
      kind,
      path,
      { method: "POST", headers, body: JSON.stringify(body) },
      async (response, signal) => handle(await readJson(response, signal), response.status),
      (status) => status === 200,
    );
  };

  const ensureRelayAwake = (): Promise<void> => {
    try {
      ensureNotDisposed();
      const checkedAt = healthCheckedAt;
      if (checkedAt !== undefined) {
        const age = nowFrom(options) - checkedAt;
        if (age >= 0 && age <= AUTH_HTTP_HEALTH_CACHE_MS) return Promise.resolve();
      }
      if (healthFlight !== undefined) return healthFlight;
      healthCheckedAt = undefined;
      const flightGeneration = ++healthGeneration;
      const flight = fixedBoundary(async (): Promise<void> => {
        await request(
          "health",
          "/healthz",
          { method: "GET" },
          async (response, signal) => {
            const value = await readJson(response, signal);
            if (!isExactHealth(value)) throw fixedError("protocol", response.status);
          },
          (status) => status === 200,
        );
        ensureNotDisposed();
        if (flightGeneration !== healthGeneration) throw fixedError("disposed");
        healthCheckedAt = nowFrom(options);
      });
      healthFlight = flight;
      const clearFlight = (): void => {
        if (healthFlight === flight) healthFlight = undefined;
      };
      void flight.then(clearFlight, clearFlight);
      return flight;
    } catch (error: unknown) {
      return Promise.reject(normalizeError(error));
    }
  };

  const redeemPairing = (code: string): Promise<InstallationCredentialResponse> => fixedBoundary(async () => {
    ensureNotDisposed();
    if (!isCanonicalPairingCode(code)) throw fixedError("rejected");
    return jsonRequest(
      "pairing",
      "/v1/pairing-redemptions",
      { pairingCode: code },
      (value, status) => {
        try {
          return freezeResponse(assertInstallationCredentialResponse(value));
        } catch {
          throw fixedError("protocol", status);
        }
      },
    );
  });

  const beginRotation = (credential: string): Promise<RotationBeginResponse> => fixedBoundary(async () => {
    ensureNotDisposed();
    if (!isBase64UrlSecret(credential)) throw fixedError("rejected");
    return jsonRequest(
      "rotation-begin",
      "/v1/credential-rotations",
      {},
      (value, status) => {
        try {
          return freezeResponse(assertRotationBeginResponse(value));
        } catch {
          throw fixedError("protocol", status);
        }
      },
      credential,
    );
  });

  const confirmRotation = (credential: string): Promise<RotationConfirmationResponse> => fixedBoundary(async () => {
    ensureNotDisposed();
    if (!isBase64UrlSecret(credential)) throw fixedError("rejected");
    return jsonRequest(
      "rotation-confirmation",
      "/v1/credential-rotation-confirmations",
      {},
      (value, status) => {
        try {
          return freezeResponse(assertRotationConfirmationResponse(value));
        } catch {
          throw fixedError("protocol", status);
        }
      },
      credential,
    );
  });

  const revokeCurrent = (credential: string): Promise<"confirmed"> => fixedBoundary(async () => {
    ensureNotDisposed();
    if (!isBase64UrlSecret(credential)) throw fixedError("rejected");
    return request(
      "revoke",
      "/v1/installations/current",
      { method: "DELETE", headers: { Authorization: `Bearer ${credential}` } },
      async (): Promise<"confirmed"> => "confirmed",
      (status) => status === 204,
    );
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    healthGeneration += 1;
    healthCheckedAt = undefined;
    for (const requestRegistration of [...activeRequests]) {
      try {
        requestRegistration.stop("disposed");
      } catch {
        // Disposal is a no-throw fail-closed boundary.
      }
    }
  };

  return Object.freeze({
    ensureRelayAwake,
    redeemPairing,
    beginRotation,
    confirmRotation,
    revokeCurrent,
    dispose,
  });
}
