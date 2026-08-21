import { beforeEach, describe, expect, it, vi } from 'vitest';

const identityMock = vi.hoisted(() => ({
  constructor: vi.fn(),
  getToken: vi.fn()
}));

vi.mock('@azure/identity', () => ({
  ManagedIdentityCredential: class {
    constructor(options: unknown) {
      identityMock.constructor(options);
    }

    getToken(scope: string, options: Readonly<{ abortSignal?: AbortSignal }>): unknown {
      return identityMock.getToken(scope, options);
    }
  }
}));

import {
  AZURE_FOUNDRY_TOKEN_SCOPE,
  AzureManagedIdentityTokenSourceError,
  createAzureManagedIdentityTokenSource
} from '../src/index.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = 2_000_000_000_000;

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function validToken(token = 'managed-identity-token', expiresOnTimestamp = NOW + 300_000): Readonly<{
  token: string;
  expiresOnTimestamp: number;
}> {
  return Object.freeze({ token, expiresOnTimestamp });
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

describe('AzureManagedIdentityTokenSource', () => {
  beforeEach(() => {
    identityMock.constructor.mockReset();
    identityMock.getToken.mockReset();
  });

  it('constructs exactly one managed identity credential and requests the AI scope', async () => {
    identityMock.getToken.mockResolvedValue(validToken());
    const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });

    expect(AZURE_FOUNDRY_TOKEN_SCOPE).toBe('https://ai.azure.com/.default');
    expect(identityMock.constructor).toHaveBeenCalledOnce();
    expect(identityMock.constructor).toHaveBeenCalledWith({ clientId: CLIENT_ID });
    await expect(source.checkReadiness()).resolves.toBe(true);
    expect(identityMock.getToken).toHaveBeenCalledOnce();
    expect(identityMock.getToken.mock.calls[0]?.[0]).toBe(AZURE_FOUNDRY_TOKEN_SCOPE);
    expect(identityMock.getToken.mock.calls[0]?.[1]).toMatchObject({
      abortSignal: expect.any(AbortSignal)
    });
  });

  it('rejects noncanonical or uppercase client IDs without exposing or using them', () => {
    for (const clientId of [
      '11111111-1111-4111-8111-11111111111',
      '11111111-1111-4111-8111-11111111111Z',
      '11111111-1111-1111-8111-111111111111',
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    ]) {
      let error: unknown;
      try {
        createAzureManagedIdentityTokenSource({ clientId });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AzureManagedIdentityTokenSourceError);
      expect(error).toMatchObject({ reason: 'invalid-options' });
      expect(String(error)).not.toContain(clientId);
    }
    expect(identityMock.constructor).not.toHaveBeenCalled();
  });

  it('sanitizes constructor failures with fresh errors that expose no canary or client ID', () => {
    const canary = `constructor-canary:${CLIENT_ID}`;
    identityMock.constructor.mockImplementation(() => {
      throw new Error(canary);
    });
    const errors: unknown[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ reason: 'unavailable' });
    expect(errors[1]).toMatchObject({ reason: 'unavailable' });
    expect(errors[0]).not.toBe(errors[1]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(AzureManagedIdentityTokenSourceError);
      expect(String(error)).not.toContain(canary);
      expect(String(error)).not.toContain(CLIENT_ID);
    }
  });

  it('returns false for an already-aborted readiness signal without credential work', async () => {
    identityMock.getToken.mockResolvedValue(validToken());
    const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
    const controller = new AbortController();
    controller.abort('readiness-abort-canary');

    await expect(source.checkReadiness(controller.signal)).resolves.toBe(false);
    expect(identityMock.getToken).not.toHaveBeenCalled();
  });

  it('returns an in-memory cache hit before the refresh window', async () => {
    identityMock.getToken.mockResolvedValue(validToken());
    const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
    const signal = new AbortController().signal;

    const first = await source.tokenProvider(signal);
    const second = await source.tokenProvider(signal);

    expect(first).toEqual(validToken());
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(identityMock.getToken).toHaveBeenCalledOnce();
  });

  it('refreshes at the exact 120 second boundary', async () => {
    let now = NOW;
    identityMock.getToken
      .mockResolvedValueOnce(validToken('first-token', NOW + 120_001))
      .mockResolvedValueOnce(validToken('second-token', NOW + 600_000));
    const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => now });
    const signal = new AbortController().signal;

    await expect(source.tokenProvider(signal)).resolves.toMatchObject({ token: 'first-token' });
    now += 1;
    await expect(source.tokenProvider(signal)).resolves.toMatchObject({ token: 'second-token' });
    expect(identityMock.getToken).toHaveBeenCalledTimes(2);
  });

  it('returns false for throwing, nonfinite, or unsafe clocks without leaking details', async () => {
    const canary = 'hostile-now-canary';
    const clocks: readonly (() => number)[] = [
      () => { throw new Error(canary); },
      () => Number.NaN,
      () => Number.POSITIVE_INFINITY,
      () => Number.MAX_SAFE_INTEGER + 1
    ];

    for (const now of clocks) {
      const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now });
      await expect(source.checkReadiness()).resolves.toBe(false);
      let error: unknown;
      try {
        await source.tokenProvider(new AbortController().signal);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ reason: 'unavailable' });
      expect(String(error)).not.toContain(canary);
      expect(String(error)).not.toContain(CLIENT_ID);
    }
    expect(identityMock.getToken).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent refreshes', async () => {
    const pending = deferred<Readonly<{ token: string; expiresOnTimestamp: number }>>();
    identityMock.getToken.mockReturnValue(pending.promise);
    const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });

    const first = source.tokenProvider(new AbortController().signal);
    const second = source.tokenProvider(new AbortController().signal);
    await Promise.resolve();
    expect(identityMock.getToken).toHaveBeenCalledOnce();

    pending.resolve(validToken());
    await expect(Promise.all([first, second])).resolves.toEqual([validToken(), validToken()]);
  });

  it('aborts only one waiter while a shared refresh remains live', async () => {
    const pending = deferred<Readonly<{ token: string; expiresOnTimestamp: number }>>();
    identityMock.getToken.mockReturnValue(pending.promise);
    const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = source.tokenProvider(firstController.signal);
    const second = source.tokenProvider(secondController.signal);
    await Promise.resolve();
    const credentialSignal = identityMock.getToken.mock.calls[0]?.[1]?.abortSignal as AbortSignal;
    firstController.abort('caller-one-canary');

    await expect(first).rejects.toMatchObject({ reason: 'aborted' });
    expect(credentialSignal.aborted).toBe(false);
    pending.resolve(validToken());
    await expect(second).resolves.toEqual(validToken());
  });

  it('aborts the credential request when all waiters abort', async () => {
    const pending = deferred<Readonly<{ token: string; expiresOnTimestamp: number }>>();
    identityMock.getToken.mockReturnValue(pending.promise);
    const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = source.tokenProvider(firstController.signal);
    const second = source.tokenProvider(secondController.signal);
    await Promise.resolve();
    const credentialSignal = identityMock.getToken.mock.calls[0]?.[1]?.abortSignal as AbortSignal;

    firstController.abort();
    expect(credentialSignal.aborted).toBe(false);
    secondController.abort();

    await expect(first).rejects.toMatchObject({ reason: 'aborted' });
    await expect(second).rejects.toMatchObject({ reason: 'aborted' });
    expect(credentialSignal.aborted).toBe(true);
  });

  it('ignores a late credential completion after all waiters abort', async () => {
    const pending = deferred<Readonly<{ token: string; expiresOnTimestamp: number }>>();
    identityMock.getToken
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(validToken('fresh-after-abort'));
    const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = source.tokenProvider(firstController.signal);
    const second = source.tokenProvider(secondController.signal);
    await Promise.resolve();

    firstController.abort();
    secondController.abort();
    await expect(first).rejects.toMatchObject({ reason: 'aborted' });
    await expect(second).rejects.toMatchObject({ reason: 'aborted' });
    pending.resolve(validToken('must-not-cache'));
    await flushMicrotasks();

    await expect(source.tokenProvider(new AbortController().signal))
      .resolves.toMatchObject({ token: 'fresh-after-abort' });
    expect(identityMock.getToken).toHaveBeenCalledTimes(2);
  });

  it('close is idempotent, aborts refresh, and permanently fails later calls', async () => {
    const pending = deferred<Readonly<{ token: string; expiresOnTimestamp: number }>>();
    identityMock.getToken.mockReturnValue(pending.promise);
    const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
    const active = source.tokenProvider(new AbortController().signal);
    await Promise.resolve();
    const credentialSignal = identityMock.getToken.mock.calls[0]?.[1]?.abortSignal as AbortSignal;

    source.close();
    source.close();

    await expect(active).rejects.toMatchObject({ reason: 'closed' });
    expect(credentialSignal.aborted).toBe(true);
    pending.resolve(validToken('late-after-close'));
    await flushMicrotasks();
    await expect(source.checkReadiness()).rejects.toMatchObject({ reason: 'closed' });
    await expect(source.tokenProvider(new AbortController().signal))
      .rejects.toMatchObject({ reason: 'closed' });
  });

  it('makes close win same-turn and post-resolution credential races', async () => {
    for (const waitOneTurn of [false, true]) {
      identityMock.getToken.mockReset();
      const pending = deferred<Readonly<{ token: string; expiresOnTimestamp: number }>>();
      identityMock.getToken.mockReturnValue(pending.promise);
      const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
      const active = source.tokenProvider(new AbortController().signal);
      await Promise.resolve();

      pending.resolve(validToken('close-race-token'));
      if (waitOneTurn) await Promise.resolve();
      source.close();

      await expect(active).rejects.toMatchObject({ reason: 'closed' });
      await flushMicrotasks();
      await expect(source.checkReadiness()).rejects.toMatchObject({ reason: 'closed' });
      expect(identityMock.getToken).toHaveBeenCalledOnce();
    }
  });

  it('rejects malformed, oversized, unsafe, and short-lived tokens', async () => {
    const invalidTokens: readonly unknown[] = [
      null,
      { token: '', expiresOnTimestamp: NOW + 300_000 },
      { token: 'x'.repeat(16 * 1024 + 1), expiresOnTimestamp: NOW + 300_000 },
      { token: 'token', expiresOnTimestamp: Number.NaN },
      { token: 'token', expiresOnTimestamp: Number.POSITIVE_INFINITY },
      { token: 'token', expiresOnTimestamp: Number.MAX_SAFE_INTEGER + 1 },
      { token: 'token', expiresOnTimestamp: NOW + 120_000 }
    ];

    for (const invalidToken of invalidTokens) {
      identityMock.getToken.mockReset();
      identityMock.getToken.mockResolvedValue(invalidToken);
      const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
      await expect(source.tokenProvider(new AbortController().signal))
        .rejects.toMatchObject({ reason: 'unavailable' });
    }
  });

  it('accepts exactly 16 KiB of UTF-8 token data and rejects one byte more', async () => {
    const exact = '\u00e9'.repeat(8 * 1024);
    const over = `${exact}a`;
    expect(new TextEncoder().encode(exact)).toHaveLength(16 * 1024);
    expect(new TextEncoder().encode(over)).toHaveLength(16 * 1024 + 1);
    identityMock.getToken
      .mockResolvedValueOnce(validToken(exact))
      .mockResolvedValueOnce(validToken(over));

    const accepted = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
    const rejected = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
    await expect(accepted.checkReadiness()).resolves.toBe(true);
    await expect(rejected.checkReadiness()).resolves.toBe(false);
  });

  it('rejects accessor token fields without invoking them or leaking their canary', async () => {
    const canary = 'accessor-token-body-canary';
    let getterCalls = 0;
    const body = {};
    Object.defineProperties(body, {
      token: {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          throw new Error(canary);
        }
      },
      expiresOnTimestamp: {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          throw new Error(canary);
        }
      }
    });
    identityMock.getToken.mockResolvedValue(body);
    const source = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });

    await expect(source.checkReadiness()).resolves.toBe(false);
    expect(getterCalls).toBe(0);
    let error: unknown;
    try {
      await source.tokenProvider(new AbortController().signal);
    } catch (caught) {
      error = caught;
    }
    expect(getterCalls).toBe(0);
    expect(String(error)).not.toContain(canary);
  });

  it('maps hostile credential failures and proxy bodies to secret-free errors', async () => {
    const canary = 'credential-error-client-endpoint-token-provider-body-canary';
    identityMock.getToken.mockRejectedValue(new Error(canary));
    const rejected = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
    await expect(rejected.checkReadiness()).resolves.toBe(false);
    let credentialError: unknown;
    try {
      await rejected.tokenProvider(new AbortController().signal);
    } catch (error) {
      credentialError = error;
    }
    expect(credentialError).toMatchObject({ reason: 'unavailable' });
    expect(String(credentialError)).not.toContain(canary);
    expect(String(credentialError)).not.toContain(CLIENT_ID);

    identityMock.getToken.mockReset();
    identityMock.getToken.mockResolvedValueOnce(new Proxy(validToken(), {
      get: () => {
        throw new Error(canary);
      }
    }));
    const proxied = createAzureManagedIdentityTokenSource({ clientId: CLIENT_ID, now: () => NOW });
    await expect(proxied.checkReadiness()).resolves.toBe(false);
  });
});
