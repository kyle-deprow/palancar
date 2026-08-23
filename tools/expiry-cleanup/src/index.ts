import type { AzureTableRuntimeStoreOptions } from '@palancar/security-state';

const FAILURE_OUTPUT = 'expiry-cleanup: failed\n';
const CLEANUP_ENV_PREFIX = 'PALANCAR_EXPIRY_CLEANUP_';
const CLEANUP_DEADLINE_MARGIN_MS = 5_000;
export const EXPIRY_CLEANUP_MAX_ITERATIONS = 1_000;

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

function parseCleanupResult(value: unknown, limit: number): Readonly<{
  readonly visited: number;
  readonly removed: number;
  readonly securityRemoved: number;
  readonly rateRemoved: number;
  readonly exhausted: boolean;
}> {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Invalid cleanup result.');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 4 || !keys.includes('visited') || !keys.includes('removed') ||
    !keys.includes('removedByTable') || !keys.includes('exhausted')
  ) {
    throw new TypeError('Invalid cleanup result.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const visitedDescriptor = descriptors.visited;
  const removedDescriptor = descriptors.removed;
  const removedByTableDescriptor = descriptors.removedByTable;
  const exhaustedDescriptor = descriptors.exhausted;
  if (
    visitedDescriptor === undefined || removedDescriptor === undefined ||
    removedByTableDescriptor === undefined || exhaustedDescriptor === undefined ||
    !Object.hasOwn(visitedDescriptor, 'value') || !Object.hasOwn(removedDescriptor, 'value')
    || !Object.hasOwn(removedByTableDescriptor, 'value') ||
    !Object.hasOwn(exhaustedDescriptor, 'value')
  ) {
    throw new TypeError('Invalid cleanup result.');
  }
  const visited: unknown = visitedDescriptor.value;
  const removed: unknown = removedDescriptor.value;
  const removedByTable: unknown = removedByTableDescriptor.value;
  const exhausted: unknown = exhaustedDescriptor.value;
  if (
    typeof removedByTable !== 'object' || removedByTable === null ||
    Object.getPrototypeOf(removedByTable) !== Object.prototype
  ) {
    throw new TypeError('Invalid cleanup result.');
  }
  const tableKeys = Reflect.ownKeys(removedByTable);
  if (tableKeys.length !== 2 || !tableKeys.includes('security') || !tableKeys.includes('rate')) {
    throw new TypeError('Invalid cleanup result.');
  }
  const tableDescriptors = Object.getOwnPropertyDescriptors(removedByTable);
  const securityDescriptor = tableDescriptors.security;
  const rateDescriptor = tableDescriptors.rate;
  if (
    securityDescriptor === undefined || rateDescriptor === undefined ||
    !Object.hasOwn(securityDescriptor, 'value') || !Object.hasOwn(rateDescriptor, 'value')
  ) {
    throw new TypeError('Invalid cleanup result.');
  }
  const securityRemoved: unknown = securityDescriptor.value;
  const rateRemoved: unknown = rateDescriptor.value;
  if (
    typeof visited !== 'number' || typeof removed !== 'number' ||
    !Number.isSafeInteger(visited) || !Number.isSafeInteger(removed) ||
    typeof securityRemoved !== 'number' || typeof rateRemoved !== 'number' ||
    !Number.isSafeInteger(securityRemoved) || !Number.isSafeInteger(rateRemoved) ||
    typeof exhausted !== 'boolean' || visited < 0 || removed < 0 ||
    securityRemoved < 0 || rateRemoved < 0 || removed > visited || visited > limit ||
    securityRemoved + rateRemoved !== removed
  ) {
    throw new TypeError('Invalid cleanup result.');
  }
  return Object.freeze({
    visited,
    removed,
    securityRemoved,
    rateRemoved,
    exhausted
  });
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

  const emitSuccess = (
    visited: number,
    removed: number,
    securityRemoved: number,
    rateRemoved: number,
    exhausted: boolean
  ): void => {
    if (terminal) return;
    try {
      clearWatchdog();
    } catch {
      emitFailure(false);
      return;
    }
    settleTerminal(() => {
      runtimeProcess.writeStdout(
        `expiry-cleanup: pass visited=${visited} removed=${removed} ` +
        `securityRemoved=${securityRemoved} rateRemoved=${rateRemoved} exhausted=${exhausted}\n`
      );
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

    const cleanup = async (): Promise<void> => {
      const deadline = Date.now() + Math.max(1, configuration.timeoutMs - CLEANUP_DEADLINE_MARGIN_MS);
      let iterations = 0;
      let visited = 0;
      let removed = 0;
      let securityRemoved = 0;
      let rateRemoved = 0;
      let exhausted = false;
      while (
        !exhausted && iterations < EXPIRY_CLEANUP_MAX_ITERATIONS &&
        (iterations === 0 || Date.now() < deadline)
      ) {
        if (terminal) return;
        iterations += 1;
        const value = await cleanupExpired(Object.freeze({ limit: configuration.limit }));
        if (terminal) return;
        const result = parseCleanupResult(value, configuration.limit);
        visited += result.visited;
        removed += result.removed;
        securityRemoved += result.securityRemoved;
        rateRemoved += result.rateRemoved;
        exhausted = result.exhausted;
      }
      if (terminal) return;
      emitSuccess(visited, removed, securityRemoved, rateRemoved, exhausted);
    };
    void cleanup().catch(() => {
      emitFailure(true);
    });
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
