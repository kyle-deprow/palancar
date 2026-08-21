import { ManagedIdentityCredential } from '@azure/identity';
import { types as utilTypes } from 'node:util';

export const AZURE_FOUNDRY_TOKEN_SCOPE = 'https://ai.azure.com/.default' as const;

const TOKEN_REFRESH_WINDOW_MS = 120_000 as const;
const MAX_TOKEN_BYTES = 16 * 1024;
const CANONICAL_LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_ENCODER = new TextEncoder();

export interface AzureAccessToken {
  readonly token: string;
  readonly expiresOnTimestamp: number;
}

export type AzureTokenProvider = (
  signal: AbortSignal
) => Promise<Readonly<AzureAccessToken>>;

export type AzureManagedIdentityTokenSourceErrorReason =
  | 'invalid-options'
  | 'unavailable'
  | 'aborted'
  | 'closed';

export class AzureManagedIdentityTokenSourceError extends Error {
  readonly reason: AzureManagedIdentityTokenSourceErrorReason;

  constructor(reason: AzureManagedIdentityTokenSourceErrorReason) {
    super(`Azure managed identity token source ${reason.replaceAll('-', ' ')}.`);
    this.name = 'AzureManagedIdentityTokenSourceError';
    this.reason = reason;
  }
}

export interface CreateAzureManagedIdentityTokenSourceOptions {
  readonly clientId: string;
  readonly now?: () => number;
}

interface RefreshState {
  readonly controller: AbortController;
  readonly promise: Promise<Readonly<AzureAccessToken>>;
  waiterCount: number;
  settled: boolean;
}

function sourceError(reason: AzureManagedIdentityTokenSourceErrorReason): AzureManagedIdentityTokenSourceError {
  return new AzureManagedIdentityTokenSourceError(reason);
}

function invalidOptions(): never {
  throw sourceError('invalid-options');
}

function validateOptions(
  input: CreateAzureManagedIdentityTokenSourceOptions
): Readonly<Required<Pick<CreateAzureManagedIdentityTokenSourceOptions, 'clientId'>> & {
  readonly now: () => number;
}> {
  try {
    if (
      typeof input !== 'object' ||
      input === null ||
      utilTypes.isProxy(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      invalidOptions();
    }
    const keys = Reflect.ownKeys(input);
    if (
      keys.length < 1 ||
      keys.length > 2 ||
      keys.some((key) => key !== 'clientId' && key !== 'now')
    ) {
      invalidOptions();
    }
    const clientIdDescriptor = Object.getOwnPropertyDescriptor(input, 'clientId');
    const nowDescriptor = Object.getOwnPropertyDescriptor(input, 'now');
    if (
      clientIdDescriptor === undefined ||
      !Object.hasOwn(clientIdDescriptor, 'value') ||
      typeof clientIdDescriptor.value !== 'string' ||
      !CANONICAL_LOWERCASE_UUID.test(clientIdDescriptor.value) ||
      (nowDescriptor !== undefined &&
        (!Object.hasOwn(nowDescriptor, 'value') || typeof nowDescriptor.value !== 'function'))
    ) {
      invalidOptions();
    }
    return Object.freeze({
      clientId: clientIdDescriptor.value,
      now: nowDescriptor?.value ?? Date.now
    });
  } catch (error) {
    if (error instanceof AzureManagedIdentityTokenSourceError) throw error;
    invalidOptions();
  }
}

function validateSignal(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    if (
      utilTypes.isProxy(signal) ||
      !(signal instanceof AbortSignal) ||
      Object.getPrototypeOf(signal) !== AbortSignal.prototype
    ) {
      throw sourceError('aborted');
    }
    return signal.aborted;
  } catch (error) {
    if (error instanceof AzureManagedIdentityTokenSourceError) throw error;
    throw sourceError('aborted');
  }
}

export class AzureManagedIdentityTokenSource {
  readonly #credential: ManagedIdentityCredential;
  readonly #now: () => number;
  readonly #closeController = new AbortController();
  #cachedToken: Readonly<AzureAccessToken> | undefined;
  #refresh: RefreshState | undefined;
  #closed = false;

  readonly tokenProvider: AzureTokenProvider = (signal) => this.#getToken(signal);

  constructor(options: CreateAzureManagedIdentityTokenSourceOptions) {
    const validated = validateOptions(options);
    this.#now = validated.now;
    try {
      this.#credential = new ManagedIdentityCredential({ clientId: validated.clientId });
    } catch {
      throw sourceError('unavailable');
    }
  }

  async checkReadiness(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.#getToken(signal);
      return true;
    } catch (error) {
      if (error instanceof AzureManagedIdentityTokenSourceError && error.reason === 'closed') {
        throw sourceError('closed');
      }
      return false;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cachedToken = undefined;
    this.#closeController.abort();
    this.#refresh?.controller.abort();
    this.#refresh = undefined;
  }

  #currentTime(): number {
    let value: number;
    try {
      value = this.#now();
    } catch {
      throw sourceError('unavailable');
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw sourceError('unavailable');
    }
    return value;
  }

  #getToken(signal?: AbortSignal): Promise<Readonly<AzureAccessToken>> {
    if (this.#closed) return Promise.reject(sourceError('closed'));
    let callerAborted: boolean;
    try {
      callerAborted = validateSignal(signal);
    } catch {
      return Promise.reject(sourceError('aborted'));
    }
    if (callerAborted) return Promise.reject(sourceError('aborted'));

    let now: number;
    try {
      now = this.#currentTime();
    } catch {
      return Promise.reject(sourceError('unavailable'));
    }
    const cached = this.#cachedToken;
    if (cached !== undefined && now < cached.expiresOnTimestamp - TOKEN_REFRESH_WINDOW_MS) {
      return Promise.resolve(cached);
    }

    const refresh = this.#refresh ?? this.#startRefresh();
    return this.#waitForRefresh(refresh, signal);
  }

  #startRefresh(): RefreshState {
    const controller = new AbortController();
    const holder: { value?: RefreshState } = {};
    const promise = Promise.resolve()
      .then(async () => {
        if (this.#closed || controller.signal.aborted) throw sourceError('unavailable');
        let rawToken: unknown;
        try {
          rawToken = await this.#credential.getToken(AZURE_FOUNDRY_TOKEN_SCOPE, {
            abortSignal: controller.signal
          });
        } catch {
          throw sourceError('unavailable');
        }
        if (this.#closed || controller.signal.aborted) throw sourceError('unavailable');
        const token = this.#validateToken(rawToken);
        if (this.#closed || controller.signal.aborted) throw sourceError('unavailable');
        this.#cachedToken = token;
        return token;
      })
      .catch(() => {
        throw sourceError('unavailable');
      })
      .finally(() => {
        const refresh = holder.value;
        if (refresh === undefined) return;
        refresh.settled = true;
        if (this.#refresh === refresh) this.#refresh = undefined;
      });
    const refresh: RefreshState = {
      controller,
      promise,
      waiterCount: 0,
      settled: false
    };
    holder.value = refresh;
    this.#refresh = refresh;
    return refresh;
  }

  #validateToken(rawToken: unknown): Readonly<AzureAccessToken> {
    try {
      if (typeof rawToken !== 'object' || rawToken === null || utilTypes.isProxy(rawToken)) {
        throw sourceError('unavailable');
      }
      const tokenDescriptor = Object.getOwnPropertyDescriptor(rawToken, 'token');
      const expiryDescriptor = Object.getOwnPropertyDescriptor(rawToken, 'expiresOnTimestamp');
      if (
        tokenDescriptor === undefined ||
        expiryDescriptor === undefined ||
        !Object.hasOwn(tokenDescriptor, 'value') ||
        !Object.hasOwn(expiryDescriptor, 'value') ||
        typeof tokenDescriptor.value !== 'string' ||
        tokenDescriptor.value.length === 0 ||
        tokenDescriptor.value.length > MAX_TOKEN_BYTES ||
        TOKEN_ENCODER.encode(tokenDescriptor.value).byteLength > MAX_TOKEN_BYTES ||
        !Number.isSafeInteger(expiryDescriptor.value)
      ) {
        throw sourceError('unavailable');
      }
      const now = this.#currentTime();
      if (expiryDescriptor.value - now <= TOKEN_REFRESH_WINDOW_MS) {
        throw sourceError('unavailable');
      }
      return Object.freeze({
        token: tokenDescriptor.value,
        expiresOnTimestamp: expiryDescriptor.value
      });
    } catch {
      throw sourceError('unavailable');
    }
  }

  #waitForRefresh(
    refresh: RefreshState,
    signal: AbortSignal | undefined
  ): Promise<Readonly<AzureAccessToken>> {
    refresh.waiterCount += 1;
    return new Promise((resolve, reject) => {
      let settled = false;

      const settle = (
        outcome: 'resolve' | 'reject',
        value: Readonly<AzureAccessToken> | AzureManagedIdentityTokenSourceError
      ): void => {
        if (settled) return;
        settled = true;
        refresh.waiterCount -= 1;
        try { signal?.removeEventListener('abort', onCallerAbort); } catch { /* content-free */ }
        this.#closeController.signal.removeEventListener('abort', onClose);
        if (refresh.waiterCount === 0 && !refresh.settled) {
          refresh.controller.abort();
          if (this.#refresh === refresh) this.#refresh = undefined;
        }
        if (outcome === 'resolve') {
          resolve(value as Readonly<AzureAccessToken>);
        } else {
          reject(value);
        }
      };

      const onCallerAbort = (): void => settle('reject', sourceError('aborted'));
      const onClose = (): void => settle('reject', sourceError('closed'));

      try {
        signal?.addEventListener('abort', onCallerAbort, { once: true });
        this.#closeController.signal.addEventListener('abort', onClose, { once: true });
      } catch {
        settle('reject', sourceError('aborted'));
        return;
      }
      try {
        if (this.#closed || this.#closeController.signal.aborted) {
          onClose();
          return;
        }
        if (validateSignal(signal)) {
          onCallerAbort();
          return;
        }
      } catch {
        onCallerAbort();
        return;
      }

      void refresh.promise.then(
        (token) => settle('resolve', token),
        () => settle('reject', sourceError('unavailable'))
      );
    });
  }
}

export function createAzureManagedIdentityTokenSource(
  options: CreateAzureManagedIdentityTokenSourceOptions
): AzureManagedIdentityTokenSource {
  return new AzureManagedIdentityTokenSource(options);
}
