import type { AzureTableRuntimeStoreOptions } from '@palancar/security-state';

const FAILURE_OUTPUT = 'expiry-cleanup: failed\n';
const CLEANUP_ENV_PREFIX = 'PALANCAR_EXPIRY_CLEANUP_';

const REQUIRED_ENVIRONMENT_KEYS = Object.freeze([
  'AZURE_CLIENT_ID',
  'PALANCAR_WORKLOAD_TABLE_ENDPOINT',
  'PALANCAR_SECURITY_STATE_TABLE',
  'PALANCAR_RATE_STATE_TABLE',
  'PALANCAR_RELAY_ENVIRONMENT',
  'PALANCAR_RELAY_ORIGIN',
  'PALANCAR_EXPIRY_CLEANUP_LIMIT',
  'PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS'
] as const);

type RequiredEnvironmentKey = (typeof REQUIRED_ENVIRONMENT_KEYS)[number];

export interface ExpiryCleanupConfiguration {
  readonly storeOptions: AzureTableRuntimeStoreOptions;
  readonly limit: number;
  readonly timeoutMs: number;
}

export interface ExpiryCleanupStore {
  readonly cleanupExpired: (input: Readonly<{ limit: number }>) => Promise<unknown>;
}

export interface ExpiryCleanupProcess {
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
  readonly exit: (code: number) => void;
}

export interface ExpiryCleanupRuntime<TimerHandle> {
  readonly createStore: (options: AzureTableRuntimeStoreOptions) => ExpiryCleanupStore;
  readonly setTimeout: (callback: () => void, timeoutMs: number) => TimerHandle;
  readonly clearTimeout: (handle: TimerHandle) => void;
}

function invalidConfiguration(): never {
  throw new TypeError('Invalid expiry-cleanup configuration.');
}

function requiredValue(
  environment: Readonly<Record<string, string | undefined>>,
  key: RequiredEnvironmentKey
): string {
  const value = environment[key];
  if (typeof value !== 'string') invalidConfiguration();
  return value;
}

function canonicalClientId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    invalidConfiguration();
  }
  return value;
}

function canonicalTableEndpoint(value: string): string {
  if (value.length === 0 || value.length > 255) invalidConfiguration();
  try {
    const endpoint = new URL(value);
    if (
      endpoint.protocol !== 'https:' || endpoint.origin !== value || endpoint.username !== '' ||
      endpoint.password !== '' || endpoint.port !== '' || endpoint.pathname !== '/' ||
      endpoint.search !== '' || endpoint.hash !== '' ||
      !/^[a-z0-9]{3,24}\.table\.core\.windows\.net$/.test(endpoint.hostname)
    ) {
      invalidConfiguration();
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === 'Invalid expiry-cleanup configuration.') throw error;
    invalidConfiguration();
  }
  return value;
}

function canonicalTableName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(value)) invalidConfiguration();
  return value;
}

function canonicalEnvironment(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) invalidConfiguration();
  return value;
}

function canonicalRelayOrigin(value: string): string {
  if (value.length === 0 || value.length > 255) invalidConfiguration();
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== 'wss:' || origin.origin !== value || origin.username !== '' ||
      origin.password !== '' || origin.pathname !== '/' || origin.search !== '' || origin.hash !== ''
    ) {
      invalidConfiguration();
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === 'Invalid expiry-cleanup configuration.') throw error;
    invalidConfiguration();
  }
  return value;
}

function canonicalDecimal(value: string, minimum: number, maximum: number): number {
  if (!/^[1-9][0-9]*$/.test(value)) invalidConfiguration();
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value
  ) {
    invalidConfiguration();
  }
  return parsed;
}

function rejectUnknownCleanupEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): void {
  const allowed = new Set<string>(REQUIRED_ENVIRONMENT_KEYS);
  for (const key of Object.keys(environment).sort()) {
    if (key.startsWith(CLEANUP_ENV_PREFIX) && !allowed.has(key)) invalidConfiguration();
  }
}

export function parseExpiryCleanupConfiguration(
  environment: Readonly<Record<string, string | undefined>>
): ExpiryCleanupConfiguration {
  const managedIdentityClientId = canonicalClientId(requiredValue(environment, 'AZURE_CLIENT_ID'));
  const endpoint = canonicalTableEndpoint(requiredValue(environment, 'PALANCAR_WORKLOAD_TABLE_ENDPOINT'));
  const securityTableName = canonicalTableName(requiredValue(environment, 'PALANCAR_SECURITY_STATE_TABLE'));
  const rateTableName = canonicalTableName(requiredValue(environment, 'PALANCAR_RATE_STATE_TABLE'));
  if (securityTableName === rateTableName) invalidConfiguration();
  const relayEnvironment = canonicalEnvironment(requiredValue(environment, 'PALANCAR_RELAY_ENVIRONMENT'));
  const relayOrigin = canonicalRelayOrigin(requiredValue(environment, 'PALANCAR_RELAY_ORIGIN'));
  const limit = canonicalDecimal(requiredValue(environment, 'PALANCAR_EXPIRY_CLEANUP_LIMIT'), 1, 10_000);
  const timeoutMs = canonicalDecimal(
    requiredValue(environment, 'PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS'),
    30_000,
    240_000
  );
  rejectUnknownCleanupEnvironment(environment);

  return Object.freeze({
    storeOptions: Object.freeze({
      endpoint,
      securityTableName,
      rateTableName,
      environment: relayEnvironment,
      audience: Object.freeze({
        origin: relayOrigin,
        path: '/v1/stream' as const,
        protocol: 'palancar.v1' as const
      }),
      managedIdentityClientId
    }),
    limit,
    timeoutMs
  });
}

function parseCleanupResult(value: unknown, limit: number): Readonly<{ visited: number; removed: number }> {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Invalid cleanup result.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('visited') || !keys.includes('removed')) {
    throw new TypeError('Invalid cleanup result.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const visitedDescriptor = descriptors.visited;
  const removedDescriptor = descriptors.removed;
  if (
    visitedDescriptor === undefined || removedDescriptor === undefined ||
    !Object.hasOwn(visitedDescriptor, 'value') || !Object.hasOwn(removedDescriptor, 'value')
  ) {
    throw new TypeError('Invalid cleanup result.');
  }
  const visited: unknown = visitedDescriptor.value;
  const removed: unknown = removedDescriptor.value;
  if (
    typeof visited !== 'number' || typeof removed !== 'number' ||
    !Number.isSafeInteger(visited) || !Number.isSafeInteger(removed) ||
    visited < 0 || removed < 0 || removed > visited || visited > limit
  ) {
    throw new TypeError('Invalid cleanup result.');
  }
  return Object.freeze({ visited, removed });
}

export function runExpiryCleanup<TimerHandle>(
  environment: Readonly<Record<string, string | undefined>>,
  runtimeProcess: ExpiryCleanupProcess,
  runtime: ExpiryCleanupRuntime<TimerHandle>
): Promise<void> {
  let terminal = false;
  let watchdogActive = false;
  let watchdog: TimerHandle | undefined;
  let resolveTerminal: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });

  const claimTerminal = (): boolean => {
    if (terminal) return false;
    terminal = true;
    return true;
  };

  const settleTerminal = (writer: () => void, exitCode: 0 | 1): void => {
    if (!claimTerminal()) return;
    try {
      writer();
    } catch {
      // A hostile output sink cannot change the terminal outcome or expose its error.
    }
    try {
      runtimeProcess.exit(exitCode);
    } catch {
      // The real process exit does not return; injected failures remain content-free.
    }
    resolveTerminal();
  };

  const clearWatchdog = (): void => {
    if (!watchdogActive) return;
    watchdogActive = false;
    runtime.clearTimeout(watchdog as TimerHandle);
  };

  const emitFailure = (clearActiveWatchdog: boolean): void => {
    if (terminal) return;
    if (clearActiveWatchdog) {
      try {
        clearWatchdog();
      } catch {
        // Output remains generic even if timer cleanup fails.
      }
    }
    settleTerminal(() => {
      runtimeProcess.writeStderr(FAILURE_OUTPUT);
    }, 1);
  };

  const emitSuccess = (visited: number, removed: number): void => {
    if (terminal) return;
    try {
      clearWatchdog();
    } catch {
      emitFailure(false);
      return;
    }
    settleTerminal(() => {
      runtimeProcess.writeStdout(`expiry-cleanup: pass visited=${visited} removed=${removed}\n`);
    }, 0);
  };

  try {
    const configuration = parseExpiryCleanupConfiguration(environment);
    watchdog = runtime.setTimeout(() => {
      emitFailure(false);
    }, configuration.timeoutMs);
    watchdogActive = true;
    if (terminal) return completion;

    const store = runtime.createStore(configuration.storeOptions);
    if (terminal) return completion;

    let cleanupExpired: ExpiryCleanupStore['cleanupExpired'];
    try {
      cleanupExpired = store.cleanupExpired;
    } catch {
      emitFailure(true);
      return completion;
    }
    if (terminal) return completion;

    let cleanup: Promise<unknown>;
    try {
      cleanup = cleanupExpired(Object.freeze({ limit: configuration.limit }));
    } catch {
      emitFailure(true);
      return completion;
    }
    void Promise.resolve(cleanup).then(
      (value: unknown) => {
        if (terminal) return;
        try {
          const result = parseCleanupResult(value, configuration.limit);
          emitSuccess(result.visited, result.removed);
        } catch {
          emitFailure(true);
        }
      },
      () => {
        emitFailure(true);
      }
    );
  } catch {
    emitFailure(true);
  }

  return completion;
}

export function main<TimerHandle>(
  environment: Readonly<Record<string, string | undefined>>,
  runtimeProcess: ExpiryCleanupProcess,
  runtime: ExpiryCleanupRuntime<TimerHandle>
): Promise<void> {
  return runExpiryCleanup(environment, runtimeProcess, runtime);
}
