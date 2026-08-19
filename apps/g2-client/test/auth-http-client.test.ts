import { describe, expect, it } from "vitest";

import {
  AUTH_HTTP_HEALTH_CACHE_MS,
  AUTH_HTTP_MAX_BODY_BYTES,
  AuthHttpClientError,
  createAuthHttpClient,
  type AuthHttpClientClock,
} from "../src/auth/http-client.js";

const ORIGIN = "https://relay.example.test";
const PAIRING = `0${"A".repeat(25)}`;
const CREDENTIAL = `${"A".repeat(42)}E`;
const PENDING = `${"B".repeat(42)}I`;
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const ABSOLUTE = "2026-11-01T00:00:00.000Z";

class FakeClock implements AuthHttpClientClock {
  value = 1_000;
  readonly timers: Array<{ readonly callback: () => void; cancelled: boolean }> = [];

  now = (): number => this.value;

  schedule = (callback: () => void): (() => void) => {
    const timer = { callback, cancelled: false };
    this.timers.push(timer);
    return () => { timer.cancelled = true; };
  };

  fireNextActive(): void {
    for (;;) {
      const timer = this.timers.shift();
      if (timer === undefined) return;
      if (!timer.cancelled) {
        timer.callback();
        return;
      }
    }
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

function installationBody(): string {
  return JSON.stringify({
    installationId: INSTALLATION_ID,
    credential: CREDENTIAL,
    credentialVersion: 1,
    idleExpiresAt: "2026-09-01T00:00:00.000Z",
    absoluteExpiresAt: ABSOLUTE,
  });
}

function beginBody(): string {
  return JSON.stringify({
    pendingCredential: PENDING,
    pendingCredentialVersion: 2,
    pendingCredentialExpiresAt: "2026-08-05T00:00:00.000Z",
  });
}

function confirmationBody(): string {
  return JSON.stringify({
    credentialVersion: 2,
    promoted: true,
    confirmedAt: "2026-08-01T00:00:01.000Z",
    expiresAt: ABSOLUTE,
  });
}

function expectSecretFree(error: unknown, ...secrets: readonly string[]): void {
  const value = error as Error;
  const rendered = `${JSON.stringify(error)}${value.stack ?? ""}${Object.keys(value).join("\u0000")}`;
  for (const secret of secrets) expect(rendered).not.toContain(secret);
}

describe("auth HTTP client", () => {
  it("accepts only an exact credential-free HTTPS origin", () => {
    for (const origin of [
      `${ORIGIN}/`,
      `${ORIGIN}/path`,
      `${ORIGIN}?x=1`,
      "https://user@relay.example.test",
      ` ${ORIGIN}`,
      "http://relay.example.test",
      "https://relay.example.test:443",
    ]) {
      expect(() => createAuthHttpClient({ relayOrigin: origin })).toThrow(
        "Invalid authentication relay configuration.",
      );
    }
    expect(createAuthHttpClient({ relayOrigin: ORIGIN })).toBeDefined();
  });

  it("uses exact URLs, metadata, bodies, and bearer placement", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const responses = [
      new Response('{"ok":true}', { status: 200 }),
      new Response(installationBody(), { status: 200 }),
      new Response(beginBody(), { status: 200 }),
      new Response(confirmationBody(), { status: 200 }),
      new Response(null, { status: 204 }),
    ];
    const client = createAuthHttpClient({
      relayOrigin: ORIGIN,
      fetch: async (url, init) => {
        calls.push({ url, init });
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected fetch");
        return response;
      },
    });

    await client.ensureRelayAwake();
    await client.redeemPairing(PAIRING);
    await client.beginRotation(CREDENTIAL);
    await client.confirmRotation(PENDING);
    await expect(client.revokeCurrent(PENDING)).resolves.toBe("confirmed");

    expect(calls.map(({ url }) => url)).toEqual([
      `${ORIGIN}/healthz`,
      `${ORIGIN}/v1/pairing-redemptions`,
      `${ORIGIN}/v1/credential-rotations`,
      `${ORIGIN}/v1/credential-rotation-confirmations`,
      `${ORIGIN}/v1/installations/current`,
    ]);
    for (const { init } of calls) {
      expect(init).toMatchObject({
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls[0]?.init).toMatchObject({ method: "GET" });
    expect(calls[1]?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: PAIRING }),
    });
    expect(calls[2]?.init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${CREDENTIAL}`,
      },
      body: "{}",
    });
    expect(calls[3]?.init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${PENDING}`,
      },
      body: "{}",
    });
    expect(calls[4]?.init).toMatchObject({
      method: "DELETE",
      headers: { Authorization: `Bearer ${PENDING}` },
    });
    expect(calls[4]?.init.body).toBeUndefined();
  });

  it("classifies status per operation, including revocation 401 as unconfirmed input", async () => {
    const invoke = async (
      status: number,
      operation: "health" | "pairing" | "begin" | "confirm" | "revoke",
    ): Promise<unknown> => {
      const client = createAuthHttpClient({
        relayOrigin: ORIGIN,
        fetch: async () => new Response(null, { status }),
      });
      if (operation === "health") return client.ensureRelayAwake();
      if (operation === "pairing") return client.redeemPairing(PAIRING);
      if (operation === "begin") return client.beginRotation(CREDENTIAL);
      if (operation === "confirm") return client.confirmRotation(PENDING);
      return client.revokeCurrent(CREDENTIAL);
    };

    await expect(invoke(401, "health")).rejects.toMatchObject({ category: "protocol", status: 401 });
    await expect(invoke(403, "pairing")).rejects.toMatchObject({ category: "rejected", status: 403 });
    await expect(invoke(429, "pairing")).rejects.toMatchObject({ category: "rejected", status: 429 });
    await expect(invoke(401, "begin")).rejects.toMatchObject({ category: "rejected", status: 401 });
    await expect(invoke(409, "begin")).rejects.toMatchObject({ category: "conflict", status: 409 });
    await expect(invoke(403, "begin")).rejects.toMatchObject({ category: "protocol", status: 403 });
    await expect(invoke(429, "confirm")).rejects.toMatchObject({ category: "protocol", status: 429 });
    await expect(invoke(401, "confirm")).rejects.toMatchObject({ category: "rejected", status: 401 });
    await expect(invoke(401, "revoke")).rejects.toMatchObject({ category: "rejected", status: 401 });
    await expect(invoke(503, "revoke")).rejects.toMatchObject({ category: "unavailable", status: 503 });
  });

  it("accepts exactly 16 KiB and cancels fixed and chunked overflow", async () => {
    const prefix = '{"ok":true}';
    const exact = `${prefix}${" ".repeat(AUTH_HTTP_MAX_BODY_BYTES - prefix.length)}`;
    const exactClient = createAuthHttpClient({
      relayOrigin: ORIGIN,
      fetch: async () => new Response(exact, {
        status: 200,
        headers: { "content-length": String(AUTH_HTTP_MAX_BODY_BYTES) },
      }),
    });
    await expect(exactClient.ensureRelayAwake()).resolves.toBeUndefined();

    let fixedCancelled = 0;
    const fixedClient = createAuthHttpClient({
      relayOrigin: ORIGIN,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        cancel() { fixedCancelled += 1; },
      }), {
        status: 200,
        headers: { "content-length": String(AUTH_HTTP_MAX_BODY_BYTES + 1) },
      }),
    });
    await expect(fixedClient.ensureRelayAwake()).rejects.toMatchObject({ category: "protocol" });
    expect(fixedCancelled).toBe(1);

    let chunkedCancelled = 0;
    const chunkedClient = createAuthHttpClient({
      relayOrigin: ORIGIN,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(AUTH_HTTP_MAX_BODY_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel() { chunkedCancelled += 1; },
      }), { status: 200 }),
    });
    await expect(chunkedClient.ensureRelayAwake()).rejects.toMatchObject({ category: "protocol" });
    expect(chunkedCancelled).toBe(1);
  });

  it("races noncooperative fetch and body reads against timeout and disposal", async () => {
    const fetchClock = new FakeClock();
    let fetchSignal: AbortSignal | undefined;
    const fetchClient = createAuthHttpClient({
      relayOrigin: ORIGIN,
      clock: fetchClock,
      fetch: async (_url, init) => {
        fetchSignal = init.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      },
    });
    const fetchOperation = fetchClient.ensureRelayAwake();
    fetchClock.fireNextActive();
    await expect(fetchOperation).rejects.toMatchObject({ category: "timeout" });
    expect(fetchSignal?.aborted).toBe(true);

    const bodyClock = new FakeClock();
    let bodyCancelled = 0;
    const bodyClient = createAuthHttpClient({
      relayOrigin: ORIGIN,
      clock: bodyClock,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull: async () => new Promise<void>(() => undefined),
        cancel() { bodyCancelled += 1; },
      }), { status: 200 }),
    });
    const bodyOperation = bodyClient.ensureRelayAwake();
    await Promise.resolve();
    bodyClock.fireNextActive();
    await expect(bodyOperation).rejects.toMatchObject({ category: "timeout" });
    expect(bodyCancelled).toBe(1);

    const disposalClient = createAuthHttpClient({
      relayOrigin: ORIGIN,
      fetch: async () => new Promise<Response>(() => undefined),
    });
    const disposalOperation = disposalClient.ensureRelayAwake();
    disposalClient.dispose();
    await expect(disposalOperation).rejects.toMatchObject({ category: "disposed" });
    await expect(disposalClient.ensureRelayAwake()).rejects.toMatchObject({ category: "disposed" });
  });

  it("normalizes stream, timer scheduling, and timer cleanup failures", async () => {
    const streamCanary = "stream-read-canary";
    const streamClient = createAuthHttpClient({
      relayOrigin: ORIGIN,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error(`${streamCanary}:${CREDENTIAL}`));
        },
      }), { status: 200 }),
    });
    const streamError = await streamClient.ensureRelayAwake().catch((error: unknown) => error);
    expect(streamError).toBeInstanceOf(AuthHttpClientError);
    expect(streamError).toMatchObject({ category: "unavailable" });
    expectSecretFree(streamError, streamCanary, CREDENTIAL);

    const scheduleCanary = "timer-schedule-canary";
    const scheduleClient = createAuthHttpClient({
      relayOrigin: ORIGIN,
      schedule: (callback) => {
        callback();
        throw new Error(`${scheduleCanary}:${PAIRING}`);
      },
      fetch: async () => new Response('{"ok":true}', { status: 200 }),
    });
    const scheduleError = await scheduleClient.ensureRelayAwake().catch((error: unknown) => error);
    expect(scheduleError).toBeInstanceOf(AuthHttpClientError);
    expect(scheduleError).toMatchObject({ category: "unavailable" });
    expectSecretFree(scheduleError, scheduleCanary, PAIRING);

    const cleanupCanary = "timer-cleanup-canary";
    const cleanupClient = createAuthHttpClient({
      relayOrigin: ORIGIN,
      schedule: () => async () => {
        throw new Error(`${cleanupCanary}:${CREDENTIAL}`);
      },
      fetch: async () => new Response('{"ok":true}', { status: 200 }),
    });
    await expect(cleanupClient.ensureRelayAwake()).resolves.toBeUndefined();

    const classifiedClient = createAuthHttpClient({
      relayOrigin: ORIGIN,
      schedule: () => () => { throw new Error(cleanupCanary); },
      fetch: async () => new Response(null, { status: 503 }),
    });
    const classifiedError = await classifiedClient.revokeCurrent(CREDENTIAL)
      .catch((error: unknown) => error);
    expect(classifiedError).toBeInstanceOf(AuthHttpClientError);
    expect(classifiedError).toMatchObject({ category: "unavailable", status: 503 });
    expectSecretFree(classifiedError, cleanupCanary, CREDENTIAL);
  });

  it("uses a nonnegative 30-second health cache and one in-flight check", async () => {
    const clock = new FakeClock();
    const first = deferred<Response>();
    let count = 0;
    const client = createAuthHttpClient({
      relayOrigin: ORIGIN,
      clock,
      fetch: async () => {
        count += 1;
        return count === 1 ? first.promise : new Response('{"ok":true}', { status: 200 });
      },
    });
    const one = client.ensureRelayAwake();
    const two = client.ensureRelayAwake();
    expect(one).toBe(two);
    expect(count).toBe(1);
    first.resolve(new Response('{"ok":true}', { status: 200 }));
    await Promise.all([one, two]);

    clock.value += AUTH_HTTP_HEALTH_CACHE_MS;
    await client.ensureRelayAwake();
    expect(count).toBe(1);
    clock.value += 1;
    await client.ensureRelayAwake();
    expect(count).toBe(2);
    clock.value -= AUTH_HTTP_HEALTH_CACHE_MS + 2;
    await client.ensureRelayAwake();
    expect(count).toBe(3);
  });

  it("does not let a timed-out stale health success overwrite a newer failure", async () => {
    const clock = new FakeClock();
    const stale = deferred<Response>();
    let count = 0;
    const client = createAuthHttpClient({
      relayOrigin: ORIGIN,
      clock,
      fetch: async () => {
        count += 1;
        if (count === 1) return stale.promise;
        if (count === 2) return new Response(null, { status: 503 });
        return new Response('{"ok":true}', { status: 200 });
      },
    });

    const timedOut = client.ensureRelayAwake();
    clock.fireNextActive();
    await expect(timedOut).rejects.toMatchObject({ category: "timeout" });
    await expect(client.ensureRelayAwake()).rejects.toMatchObject({ category: "unavailable" });
    stale.resolve(new Response('{"ok":true}', { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    await client.ensureRelayAwake();
    expect(count).toBe(3);
  });

  it("does not retry pairing, rejects redirects, and validates successful bodies", async () => {
    let count = 0;
    const failed = createAuthHttpClient({
      relayOrigin: ORIGIN,
      fetch: async () => {
        count += 1;
        throw new Error("network-canary");
      },
    });
    await expect(failed.redeemPairing(PAIRING)).rejects.toMatchObject({ category: "unavailable" });
    expect(count).toBe(1);

    const redirected = createAuthHttpClient({
      relayOrigin: ORIGIN,
      fetch: async (_url, init) => {
        expect(init.redirect).toBe("error");
        return new Response(null, { status: 302 });
      },
    });
    await expect(redirected.redeemPairing(PAIRING)).rejects.toMatchObject({ category: "protocol" });

    const malformed = createAuthHttpClient({
      relayOrigin: ORIGIN,
      fetch: async () => new Response('{"credential":"bad"}', { status: 200 }),
    });
    await expect(malformed.redeemPairing(PAIRING)).rejects.toMatchObject({ category: "protocol" });
  });

  it("keeps all errors fixed, frozen, and free of canaries and secrets", async () => {
    const canary = "network-stack-canary";
    const client = createAuthHttpClient({
      relayOrigin: ORIGIN,
      fetch: async () => { throw new Error(`${canary}:${PAIRING}:${CREDENTIAL}`); },
    });
    const error = await client.redeemPairing(PAIRING).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AuthHttpClientError);
    expect(Object.isFrozen(error)).toBe(true);
    expect(error).toMatchObject({
      category: "unavailable",
      message: "Authentication relay unavailable.",
    });
    expectSecretFree(error, canary, PAIRING, CREDENTIAL);
  });
});
