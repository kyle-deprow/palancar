import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AzureTableRuntimeStoreOptions } from '@palancar/security-state';
import { describe, expect, it, vi } from 'vitest';
import {
  main,
  parseExpiryCleanupConfiguration,
  runExpiryCleanup,
  EXPIRY_CLEANUP_MAX_ITERATIONS,
  type ExpiryCleanupProcess,
  type ExpiryCleanupRuntime,
  type ExpiryCleanupStore
} from '../src/index.js';

const VALID_ENVIRONMENT = Object.freeze({
  AZURE_CLIENT_ID: '12345678-1234-4abc-8def-1234567890ab',
  PALANCAR_WORKLOAD_TABLE_ENDPOINT: 'https://account.table.core.windows.net',
  PALANCAR_SECURITY_STATE_TABLE: 'SecurityState',
  PALANCAR_RATE_STATE_TABLE: 'RateState',
  PALANCAR_RELAY_ENVIRONMENT: 'production-1',
  PALANCAR_RELAY_ORIGIN: 'wss://relay.example.com',
  PALANCAR_EXPIRY_CLEANUP_LIMIT: '1000',
  PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS: '240000'
});

interface TimerRecord {
  readonly callback: () => void;
  readonly timeoutMs: number;
  cleared: boolean;
}

class FakeTimers {
  readonly records: TimerRecord[] = [];

  readonly setTimeout = (callback: () => void, timeoutMs: number): TimerRecord => {
    const record = { callback, timeoutMs, cleared: false };
    this.records.push(record);
    return record;
  };

  readonly clearTimeout = (record: TimerRecord): void => {
    record.cleared = true;
  };

  fire(record: TimerRecord, includingCleared = false): void {
    if (!record.cleared || includingCleared) record.callback();
  }
}

interface ProcessCapture extends ExpiryCleanupProcess {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly exitCodes: number[];
}

function processCapture(): ProcessCapture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  return {
    stdout,
    stderr,
    exitCodes,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
    exit: (code) => exitCodes.push(code)
  };
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function cleanupResult(
  visited: number,
  removed: number,
  options: Readonly<{
    readonly securityRemoved?: number;
    readonly rateRemoved?: number;
    readonly exhausted?: boolean;
  }> = {}
): Readonly<{
  readonly visited: number;
  readonly removed: number;
  readonly removedByTable: Readonly<{ readonly security: number; readonly rate: number }>;
  readonly exhausted: boolean;
}> {
  return {
    visited,
    removed,
    removedByTable: {
      security: options.securityRemoved ?? removed,
      rate: options.rateRemoved ?? 0
    },
    exhausted: options.exhausted ?? true
  };
}

function harness(
  cleanupExpired: ExpiryCleanupStore['cleanupExpired'] = async () => cleanupResult(4, 2)
): Readonly<{
  process: ProcessCapture;
  timers: FakeTimers;
  createStore: ReturnType<typeof vi.fn<(options: AzureTableRuntimeStoreOptions) => ExpiryCleanupStore>>;
  runtime: ExpiryCleanupRuntime<TimerRecord>;
}> {
  const runtimeProcess = processCapture();
  const timers = new FakeTimers();
  const createStore = vi.fn<(options: AzureTableRuntimeStoreOptions) => ExpiryCleanupStore>(
    () => ({ cleanupExpired })
  );
  return {
    process: runtimeProcess,
    timers,
    createStore,
    runtime: {
      createStore,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    }
  };
}

function changedEnvironment(
  key: keyof typeof VALID_ENVIRONMENT,
  value: string | undefined
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...VALID_ENVIRONMENT };
  if (value === undefined) delete environment[key];
  else environment[key] = value;
  return environment;
}

async function expectGenericFailure(
  environment: Readonly<Record<string, string | undefined>>,
  cleanupExpired?: ExpiryCleanupStore['cleanupExpired']
): Promise<ReturnType<typeof harness>> {
  const testHarness = harness(cleanupExpired);
  await runExpiryCleanup(environment, testHarness.process, testHarness.runtime);
  expect(testHarness.process.stdout).toEqual([]);
  expect(testHarness.process.stderr).toEqual(['expiry-cleanup: failed\n']);
  expect(testHarness.process.exitCodes).toEqual([1]);
  return testHarness;
}

describe('configuration', () => {
  it('produces the exact fixed store configuration', () => {
    expect(parseExpiryCleanupConfiguration(VALID_ENVIRONMENT)).toEqual({
      storeOptions: {
        endpoint: 'https://account.table.core.windows.net',
        securityTableName: 'SecurityState',
        rateTableName: 'RateState',
        environment: 'production-1',
        audience: {
          origin: 'wss://relay.example.com',
          path: '/v1/stream',
          protocol: 'palancar.v1'
        },
        managedIdentityClientId: '12345678-1234-4abc-8def-1234567890ab'
      },
      limit: 1000,
      timeoutMs: 240000
    });
  });

  it('reads required values in the reviewed stable order', () => {
    const reads: string[] = [];
    const environment = new Proxy({ ...VALID_ENVIRONMENT }, {
      get: (target, property, receiver) => {
        if (typeof property === 'string') reads.push(property);
        return Reflect.get(target, property, receiver) as unknown;
      }
    });
    parseExpiryCleanupConfiguration(environment);
    expect(reads).toEqual([
      'AZURE_CLIENT_ID',
      'PALANCAR_WORKLOAD_TABLE_ENDPOINT',
      'PALANCAR_SECURITY_STATE_TABLE',
      'PALANCAR_RATE_STATE_TABLE',
      'PALANCAR_RELAY_ENVIRONMENT',
      'PALANCAR_RELAY_ORIGIN',
      'PALANCAR_EXPIRY_CLEANUP_LIMIT',
      'PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS'
    ]);
  });

  it.each(Object.keys(VALID_ENVIRONMENT))('rejects missing %s without a runtime default', async (key) => {
    const testHarness = await expectGenericFailure(
      changedEnvironment(key as keyof typeof VALID_ENVIRONMENT, undefined)
    );
    expect(testHarness.createStore).not.toHaveBeenCalled();
    expect(testHarness.timers.records).toHaveLength(0);
  });

  it.each([
    '',
    '12345678-1234-4ABC-8def-1234567890ab',
    '1234567812344abc8def1234567890ab',
    '12345678-1234-4abc-8def-1234567890a',
    'g2345678-1234-4abc-8def-1234567890ab',
    ' 12345678-1234-4abc-8def-1234567890ab'
  ])('rejects noncanonical AZURE_CLIENT_ID %j', (value) => {
    expect(() => parseExpiryCleanupConfiguration(changedEnvironment('AZURE_CLIENT_ID', value))).toThrow();
  });

  it.each([
    '',
    'https://aa.table.core.windows.net',
    `https://${'a'.repeat(25)}.table.core.windows.net`,
    'http://account.table.core.windows.net',
    'https://ACCOUNT.table.core.windows.net',
    'https://account.table.core.windows.net/',
    'https://account.table.core.windows.net/path',
    'https://account.table.core.windows.net?query=1',
    'https://account.table.core.windows.net#fragment',
    'https://account.table.core.windows.net:443',
    'https://user@account.table.core.windows.net',
    ' https://account.table.core.windows.net'
  ])('rejects noncanonical workload endpoint %j', (value) => {
    expect(() => parseExpiryCleanupConfiguration(
      changedEnvironment('PALANCAR_WORKLOAD_TABLE_ENDPOINT', value)
    )).toThrow();
  });

  it('accepts Azure Table account-name length boundaries', () => {
    expect(parseExpiryCleanupConfiguration({
      ...VALID_ENVIRONMENT,
      PALANCAR_WORKLOAD_TABLE_ENDPOINT: 'https://abc.table.core.windows.net'
    }).storeOptions.endpoint).toBe('https://abc.table.core.windows.net');
    expect(parseExpiryCleanupConfiguration({
      ...VALID_ENVIRONMENT,
      PALANCAR_WORKLOAD_TABLE_ENDPOINT: `https://${'a'.repeat(24)}.table.core.windows.net`
    }).storeOptions.endpoint).toBe(`https://${'a'.repeat(24)}.table.core.windows.net`);
  });

  it.each([
    ['PALANCAR_SECURITY_STATE_TABLE', ''],
    ['PALANCAR_SECURITY_STATE_TABLE', 'Ab'],
    ['PALANCAR_SECURITY_STATE_TABLE', `A${'b'.repeat(63)}`],
    ['PALANCAR_SECURITY_STATE_TABLE', '1Table'],
    ['PALANCAR_SECURITY_STATE_TABLE', 'A_Table'],
    ['PALANCAR_RATE_STATE_TABLE', 'A-Table'],
    ['PALANCAR_RATE_STATE_TABLE', ' Table']
  ] as const)('rejects invalid table syntax for %s', (key, value) => {
    expect(() => parseExpiryCleanupConfiguration(changedEnvironment(key, value))).toThrow();
  });

  it('accepts the Azure Table name length boundaries', () => {
    expect(parseExpiryCleanupConfiguration({
      ...VALID_ENVIRONMENT,
      PALANCAR_SECURITY_STATE_TABLE: 'Abc',
      PALANCAR_RATE_STATE_TABLE: `A${'b'.repeat(62)}`
    }).storeOptions).toMatchObject({
      securityTableName: 'Abc',
      rateTableName: `A${'b'.repeat(62)}`
    });
  });

  it('rejects equal security and rate table names', () => {
    expect(() => parseExpiryCleanupConfiguration({
      ...VALID_ENVIRONMENT,
      PALANCAR_RATE_STATE_TABLE: VALID_ENVIRONMENT.PALANCAR_SECURITY_STATE_TABLE
    })).toThrow();
  });

  it.each(['', 'Production', '1production', 'production_1', `a${'b'.repeat(64)}`])(
    'rejects invalid relay environment %j',
    (value) => {
      expect(() => parseExpiryCleanupConfiguration(
        changedEnvironment('PALANCAR_RELAY_ENVIRONMENT', value)
      )).toThrow();
    }
  );

  it('accepts relay environment length boundaries', () => {
    expect(parseExpiryCleanupConfiguration({
      ...VALID_ENVIRONMENT,
      PALANCAR_RELAY_ENVIRONMENT: 'a'
    }).storeOptions.environment).toBe('a');
    expect(parseExpiryCleanupConfiguration({
      ...VALID_ENVIRONMENT,
      PALANCAR_RELAY_ENVIRONMENT: `a${'b'.repeat(63)}`
    }).storeOptions.environment).toHaveLength(64);
  });

  it.each([
    '',
    'ws://relay.example.com',
    'WSS://relay.example.com',
    'wss://RELAY.example.com',
    'wss://relay.example.com/',
    'wss://relay.example.com/v1/stream',
    'wss://relay.example.com?query=1',
    'wss://relay.example.com#fragment',
    'wss://relay.example.com:443',
    'wss://user@relay.example.com',
    `wss://${`${'a'.repeat(60)}.`.repeat(5)}example.com`
  ])('rejects noncanonical relay origin %j', (value) => {
    expect(() => parseExpiryCleanupConfiguration(
      changedEnvironment('PALANCAR_RELAY_ORIGIN', value)
    )).toThrow();
  });

  it('accepts a 255-character relay origin and rejects 256 characters', () => {
    const origin255 = `wss://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}`;
    const origin256 = `wss://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}`;
    expect(origin255).toHaveLength(255);
    expect(origin256).toHaveLength(256);
    expect(parseExpiryCleanupConfiguration({
      ...VALID_ENVIRONMENT,
      PALANCAR_RELAY_ORIGIN: origin255
    }).storeOptions.audience.origin).toBe(origin255);
    expect(() => parseExpiryCleanupConfiguration({
      ...VALID_ENVIRONMENT,
      PALANCAR_RELAY_ORIGIN: origin256
    })).toThrow();
  });

  it.each(['1', '1000', '10000'])('accepts cleanup limit %s', (value) => {
    expect(parseExpiryCleanupConfiguration(
      changedEnvironment('PALANCAR_EXPIRY_CLEANUP_LIMIT', value)
    ).limit).toBe(Number(value));
  });

  it.each(['', '0', '10001', '+1', '-1', ' 1', '1 ', '01', '1.0', '1e3', 'NaN', '999999999999999999999']) (
    'rejects noncanonical cleanup limit %j',
    (value) => {
      expect(() => parseExpiryCleanupConfiguration(
        changedEnvironment('PALANCAR_EXPIRY_CLEANUP_LIMIT', value)
      )).toThrow();
    }
  );

  it.each(['30000', '240000'])('accepts cleanup timeout %s', (value) => {
    expect(parseExpiryCleanupConfiguration(
      changedEnvironment('PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS', value)
    ).timeoutMs).toBe(Number(value));
  });

  it.each(['', '0', '29999', '240001', '+30000', '-30000', ' 30000', '30000 ', '030000', '30000.0', '3e4']) (
    'rejects noncanonical cleanup timeout %j',
    (value) => {
      expect(() => parseExpiryCleanupConfiguration(
        changedEnvironment('PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS', value)
      )).toThrow();
    }
  );

  it('rejects unknown cleanup-prefixed variables and ignores unrelated platform variables', () => {
    expect(() => parseExpiryCleanupConfiguration({
      ...VALID_ENVIRONMENT,
      PALANCAR_EXPIRY_CLEANUP_RETRIES: '3'
    })).toThrow();
    expect(parseExpiryCleanupConfiguration({
      ...VALID_ENVIRONMENT,
      HOME: '/unrelated',
      WEBSITE_INSTANCE_ID: 'platform-value'
    }).limit).toBe(1000);
  });
});

describe('one-shot runtime', () => {
  it('constructs once, cleans once, passes only the limit, and emits cleanup details', async () => {
    const cleanupExpired = vi.fn(async () => cleanupResult(1000, 17));
    const testHarness = harness(cleanupExpired);

    await runExpiryCleanup(VALID_ENVIRONMENT, testHarness.process, testHarness.runtime);

    expect(testHarness.createStore).toHaveBeenCalledTimes(1);
    expect(testHarness.createStore).toHaveBeenCalledWith({
      endpoint: 'https://account.table.core.windows.net',
      securityTableName: 'SecurityState',
      rateTableName: 'RateState',
      environment: 'production-1',
      audience: {
        origin: 'wss://relay.example.com',
        path: '/v1/stream',
        protocol: 'palancar.v1'
      },
      managedIdentityClientId: '12345678-1234-4abc-8def-1234567890ab'
    });
    expect(cleanupExpired).toHaveBeenCalledTimes(1);
    expect(cleanupExpired).toHaveBeenCalledWith({ limit: 1000 });
    expect(testHarness.timers.records).toHaveLength(1);
    expect(testHarness.timers.records[0]).toMatchObject({ timeoutMs: 240000, cleared: true });
    expect(testHarness.process.stdout).toEqual([
      'expiry-cleanup: pass visited=1000 removed=17 securityRemoved=17 rateRemoved=0 exhausted=true\n'
    ]);
    expect(testHarness.process.stderr).toEqual([]);
    expect(testHarness.process.exitCodes).toEqual([0]);
  });

  it('loops until the store reports both tables exhausted and aggregates removals', async () => {
    const results = [
      cleanupResult(1000, 17, { securityRemoved: 17, rateRemoved: 0, exhausted: false }),
      cleanupResult(23, 8, { securityRemoved: 3, rateRemoved: 5, exhausted: true })
    ];
    const cleanupExpired = vi.fn(async () => {
      const result = results.shift();
      if (result === undefined) throw new Error('cleanup called after exhaustion');
      return result;
    });
    const testHarness = harness(cleanupExpired);

    await runExpiryCleanup(VALID_ENVIRONMENT, testHarness.process, testHarness.runtime);

    expect(cleanupExpired).toHaveBeenCalledTimes(2);
    expect(testHarness.process.stdout).toEqual([
      'expiry-cleanup: pass visited=1023 removed=25 securityRemoved=20 rateRemoved=5 exhausted=true\n'
    ]);
    expect(testHarness.process.exitCodes).toEqual([0]);
  });

  it('stops at the cleanup iteration safety bound when exhaustion is never reported', async () => {
    const cleanupExpired = vi.fn(async () => cleanupResult(1, 0, {
      securityRemoved: 0,
      rateRemoved: 0,
      exhausted: false
    }));
    const testHarness = harness(cleanupExpired);

    await runExpiryCleanup(VALID_ENVIRONMENT, testHarness.process, testHarness.runtime);

    expect(cleanupExpired).toHaveBeenCalledTimes(EXPIRY_CLEANUP_MAX_ITERATIONS);
    expect(testHarness.process.stdout).toEqual([
      `expiry-cleanup: pass visited=${EXPIRY_CLEANUP_MAX_ITERATIONS} removed=0 ` +
      'securityRemoved=0 rateRemoved=0 exhausted=false\n'
    ]);
    expect(testHarness.process.exitCodes).toEqual([0]);
  });

  it('accesses only cleanupExpired on the returned store', async () => {
    const propertyReads: PropertyKey[] = [];
    const timers = new FakeTimers();
    const runtimeProcess = processCapture();
    const cleanupExpired = vi.fn(async () => cleanupResult(0, 0));
    const store = new Proxy(Object.create(null) as ExpiryCleanupStore, {
      get: (_target, property) => {
        propertyReads.push(property);
        return property === 'cleanupExpired' ? cleanupExpired : undefined;
      }
    });

    await runExpiryCleanup(VALID_ENVIRONMENT, runtimeProcess, {
      createStore: () => store,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });

    expect(propertyReads).toEqual(['cleanupExpired']);
    expect(cleanupExpired).toHaveBeenCalledOnce();
  });

  it('does not invoke cleanup when its getter reentrantly fires the watchdog', async () => {
    const timers = new FakeTimers();
    const runtimeProcess = processCapture();
    const cleanupExpired = vi.fn(async () => cleanupResult(0, 0));
    const getter = vi.fn(() => {
      const timer = timers.records[0];
      if (timer === undefined) throw new Error('watchdog was not installed');
      timer.callback();
      return cleanupExpired;
    });
    const store = Object.defineProperty({}, 'cleanupExpired', {
      enumerable: true,
      get: getter
    }) as ExpiryCleanupStore;

    await runExpiryCleanup(VALID_ENVIRONMENT, runtimeProcess, {
      createStore: () => store,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });

    expect(getter).toHaveBeenCalledOnce();
    expect(cleanupExpired).not.toHaveBeenCalled();
    expect(runtimeProcess).toMatchObject({
      stdout: [],
      stderr: ['expiry-cleanup: failed\n'],
      exitCodes: [1]
    });
  });

  it.each([
    null,
    undefined,
    {},
    [],
    { visited: 0 },
    { removed: 0 },
    { visited: 0, removed: 0, extra: 0 },
    { visited: -1, removed: 0 },
    { visited: 1.5, removed: 0 },
    { visited: Number.NaN, removed: 0 },
    { visited: Number.POSITIVE_INFINITY, removed: 0 },
    { visited: 1001, removed: 0 },
    { visited: 1, removed: -1 },
    { visited: 1, removed: 2 },
    { visited: '1', removed: 0 },
    { visited: 1, removed: 0n },
    Object.create({ visited: 0, removed: 0 })
  ])('rejects malformed cleanup result %#', async (result) => {
    await expectGenericFailure(VALID_ENVIRONMENT, async () => result);
  });

  it('rejects accessor and symbol-bearing cleanup results without evaluating the accessor', async () => {
    const getter = vi.fn(() => 0);
    const accessor = Object.defineProperties({}, {
      visited: { enumerable: true, get: getter },
      removed: { enumerable: true, value: 0 }
    });
    await expectGenericFailure(VALID_ENVIRONMENT, async () => accessor);
    expect(getter).not.toHaveBeenCalled();

    const symbolBearing = { visited: 0, removed: 0, [Symbol('secret')]: 'credential' };
    await expectGenericFailure(VALID_ENVIRONMENT, async () => symbolBearing);
  });

  it('contains synchronous constructor and cleanup failures', async () => {
    const constructorHarness = harness();
    constructorHarness.createStore.mockImplementation(() => {
      throw new Error('credential-and-azure-detail');
    });
    await runExpiryCleanup(VALID_ENVIRONMENT, constructorHarness.process, constructorHarness.runtime);
    expect(constructorHarness.process).toMatchObject({
      stdout: [],
      stderr: ['expiry-cleanup: failed\n'],
      exitCodes: [1]
    });

    await expectGenericFailure(VALID_ENVIRONMENT, () => {
      throw new Error('entity-and-token-detail');
    });
  });

  it('contains asynchronous cleanup failures without leaking their value', async () => {
    await expectGenericFailure(
      VALID_ENVIRONMENT,
      async () => Promise.reject(new Error('secret credential azure entity'))
    );
  });

  it('attempts stdout before exit even when stdout throws', async () => {
    const testHarness = harness(async () => cleanupResult(3, 1));
    const events: string[] = [];
    const completion = runExpiryCleanup(VALID_ENVIRONMENT, {
      writeStdout: (value) => {
        events.push(`stdout:${value}`);
        throw new Error('hostile stdout credential text');
      },
      writeStderr: (value) => events.push(`stderr:${value}`),
      exit: (code) => events.push(`exit:${code}`)
    }, testHarness.runtime);

    await expect(completion).resolves.toBeUndefined();
    expect(events).toEqual([
      'stdout:expiry-cleanup: pass visited=3 removed=1 securityRemoved=1 rateRemoved=0 exhausted=true\n',
      'exit:0'
    ]);
  });

  it('attempts stderr before exit even when stderr throws', async () => {
    const testHarness = harness(async () => Promise.reject(new Error('provider secret')));
    const events: string[] = [];
    const completion = runExpiryCleanup(VALID_ENVIRONMENT, {
      writeStdout: (value) => events.push(`stdout:${value}`),
      writeStderr: (value) => {
        events.push(`stderr:${value}`);
        throw new Error('hostile stderr token text');
      },
      exit: (code) => events.push(`exit:${code}`)
    }, testHarness.runtime);

    await expect(completion).resolves.toBeUndefined();
    expect(events).toEqual([
      'stderr:expiry-cleanup: failed\n',
      'exit:1'
    ]);
  });

  it('normalizes a throwing success exit without rejecting terminal settlement', async () => {
    const testHarness = harness(async () => cleanupResult(1, 1));
    const events: string[] = [];
    const completion = runExpiryCleanup(VALID_ENVIRONMENT, {
      writeStdout: (value) => events.push(`stdout:${value}`),
      writeStderr: (value) => events.push(`stderr:${value}`),
      exit: (code) => {
        events.push(`exit:${code}`);
        throw new Error('hostile exit token text');
      }
    }, testHarness.runtime);

    await expect(completion).resolves.toBeUndefined();
    expect(events).toEqual([
      'stdout:expiry-cleanup: pass visited=1 removed=1 securityRemoved=1 rateRemoved=0 exhausted=true\n',
      'exit:0'
    ]);
  });

  it('normalizes a throwing failure exit without rejecting terminal settlement', async () => {
    const testHarness = harness(async () => Promise.reject(new Error('azure secret')));
    const events: string[] = [];
    const completion = runExpiryCleanup(VALID_ENVIRONMENT, {
      writeStdout: (value) => events.push(`stdout:${value}`),
      writeStderr: (value) => events.push(`stderr:${value}`),
      exit: (code) => {
        events.push(`exit:${code}`);
        throw new Error('hostile exit credential text');
      }
    }, testHarness.runtime);

    await expect(completion).resolves.toBeUndefined();
    expect(events).toEqual([
      'stderr:expiry-cleanup: failed\n',
      'exit:1'
    ]);
  });

  it('claims success before a reentrant stdout writer can fire the watchdog', async () => {
    const testHarness = harness(async () => cleanupResult(2, 0));
    const events: string[] = [];
    await runExpiryCleanup(VALID_ENVIRONMENT, {
      writeStdout: (value) => {
        events.push(`stdout:${value}`);
        const timer = testHarness.timers.records[0];
        if (timer === undefined) throw new Error('watchdog was not installed');
        timer.callback();
      },
      writeStderr: (value) => events.push(`stderr:${value}`),
      exit: (code) => events.push(`exit:${code}`)
    }, testHarness.runtime);

    expect(events).toEqual([
      'stdout:expiry-cleanup: pass visited=2 removed=0 securityRemoved=0 rateRemoved=0 exhausted=true\n',
      'exit:0'
    ]);
  });

  it('claims failure before a reentrant stderr writer can fire the watchdog', async () => {
    const testHarness = harness(async () => Promise.reject(new Error('store detail')));
    const events: string[] = [];
    await runExpiryCleanup(VALID_ENVIRONMENT, {
      writeStdout: (value) => events.push(`stdout:${value}`),
      writeStderr: (value) => {
        events.push(`stderr:${value}`);
        const timer = testHarness.timers.records[0];
        if (timer === undefined) throw new Error('watchdog was not installed');
        timer.callback();
      },
      exit: (code) => events.push(`exit:${code}`)
    }, testHarness.runtime);

    expect(events).toEqual([
      'stderr:expiry-cleanup: failed\n',
      'exit:1'
    ]);
  });

  it.each([
    {
      name: 'success',
      cleanup: async () => cleanupResult(5, 4),
      expected: [
        'stdout:expiry-cleanup: pass visited=5 removed=4 securityRemoved=4 rateRemoved=0 exhausted=true\n',
        'exit:0'
      ]
    },
    {
      name: 'failure',
      cleanup: async () => Promise.reject(new Error('hostile provider detail')),
      expected: ['stderr:expiry-cleanup: failed\n', 'exit:1']
    }
  ])('blocks a reentrant watchdog from the $name exit method', async ({ cleanup, expected }) => {
    const testHarness = harness(cleanup);
    const events: string[] = [];
    await runExpiryCleanup(VALID_ENVIRONMENT, {
      writeStdout: (value) => events.push(`stdout:${value}`),
      writeStderr: (value) => events.push(`stderr:${value}`),
      exit: (code) => {
        events.push(`exit:${code}`);
        const timer = testHarness.timers.records[0];
        if (timer === undefined) throw new Error('watchdog was not installed');
        timer.callback();
      }
    }, testHarness.runtime);

    expect(events).toEqual(expected);
  });

  it('preserves cross-stream output-before-exit ordering for both outcomes', async () => {
    const successHarness = harness(async () => cleanupResult(0, 0));
    const successEvents: string[] = [];
    await runExpiryCleanup(VALID_ENVIRONMENT, {
      writeStdout: (value) => successEvents.push(`stdout:${value}`),
      writeStderr: (value) => successEvents.push(`stderr:${value}`),
      exit: (code) => successEvents.push(`exit:${code}`)
    }, successHarness.runtime);

    const failureHarness = harness(async () => Promise.reject(new Error('secret')));
    const failureEvents: string[] = [];
    await runExpiryCleanup(VALID_ENVIRONMENT, {
      writeStdout: (value) => failureEvents.push(`stdout:${value}`),
      writeStderr: (value) => failureEvents.push(`stderr:${value}`),
      exit: (code) => failureEvents.push(`exit:${code}`)
    }, failureHarness.runtime);

    expect(successEvents).toEqual([
      'stdout:expiry-cleanup: pass visited=0 removed=0 securityRemoved=0 rateRemoved=0 exhausted=true\n',
      'exit:0'
    ]);
    expect(failureEvents).toEqual([
      'stderr:expiry-cleanup: failed\n',
      'exit:1'
    ]);
  });

  it('normalizes a throwing timer installer without constructing the store', async () => {
    const runtimeProcess = processCapture();
    const createStore = vi.fn(() => ({ cleanupExpired: vi.fn() }));
    await runExpiryCleanup(VALID_ENVIRONMENT, runtimeProcess, {
      createStore,
      setTimeout: () => {
        throw new Error('hostile timer credential text');
      },
      clearTimeout: () => undefined
    });

    expect(createStore).not.toHaveBeenCalled();
    expect(runtimeProcess).toMatchObject({
      stdout: [],
      stderr: ['expiry-cleanup: failed\n'],
      exitCodes: [1]
    });
  });

  it('settles once when the timer installer reentrantly fires and then throws', async () => {
    const runtimeProcess = processCapture();
    const createStore = vi.fn(() => ({ cleanupExpired: vi.fn() }));
    await runExpiryCleanup(VALID_ENVIRONMENT, runtimeProcess, {
      createStore,
      setTimeout: (callback) => {
        callback();
        throw new Error('late timer installer secret');
      },
      clearTimeout: () => undefined
    });

    expect(createStore).not.toHaveBeenCalled();
    expect(runtimeProcess).toMatchObject({
      stdout: [],
      stderr: ['expiry-cleanup: failed\n'],
      exitCodes: [1]
    });
  });

  it('converts a throwing timer clearer into one generic failure', async () => {
    const runtimeProcess = processCapture();
    const cleanupExpired = vi.fn(async () => cleanupResult(1, 0));
    await runExpiryCleanup(VALID_ENVIRONMENT, runtimeProcess, {
      createStore: () => ({ cleanupExpired }),
      setTimeout: (callback, timeoutMs) => ({ callback, timeoutMs }),
      clearTimeout: () => {
        throw new Error('hostile timer clearer credential text');
      }
    });

    expect(cleanupExpired).toHaveBeenCalledOnce();
    expect(runtimeProcess).toMatchObject({
      stdout: [],
      stderr: ['expiry-cleanup: failed\n'],
      exitCodes: [1]
    });
  });

  it('settles once when the timer clearer reentrantly fires the watchdog', async () => {
    const runtimeProcess = processCapture();
    const cleanupExpired = vi.fn(async () => cleanupResult(1, 0));
    await runExpiryCleanup(VALID_ENVIRONMENT, runtimeProcess, {
      createStore: () => ({ cleanupExpired }),
      setTimeout: (callback, timeoutMs) => ({ callback, timeoutMs }),
      clearTimeout: (timer) => timer.callback()
    });

    expect(cleanupExpired).toHaveBeenCalledOnce();
    expect(runtimeProcess).toMatchObject({
      stdout: [],
      stderr: ['expiry-cleanup: failed\n'],
      exitCodes: [1]
    });
  });

  it('times out with exact failure output and suppresses late success', async () => {
    const pending = deferred<unknown>();
    const testHarness = harness(() => pending.promise);
    const completion = runExpiryCleanup(VALID_ENVIRONMENT, testHarness.process, testHarness.runtime);
    const timer = testHarness.timers.records[0];
    expect(timer?.timeoutMs).toBe(240000);

    if (timer === undefined) throw new Error('watchdog was not installed');
    testHarness.timers.fire(timer);
    await completion;
    expect(testHarness.process).toMatchObject({
      stdout: [],
      stderr: ['expiry-cleanup: failed\n'],
      exitCodes: [1]
    });

    pending.resolve(cleanupResult(1, 1));
    await Promise.resolve();
    expect(testHarness.process).toMatchObject({
      stdout: [],
      stderr: ['expiry-cleanup: failed\n'],
      exitCodes: [1]
    });
  });

  it('suppresses late rejection after timeout', async () => {
    const pending = deferred<unknown>();
    const testHarness = harness(() => pending.promise);
    const completion = runExpiryCleanup(VALID_ENVIRONMENT, testHarness.process, testHarness.runtime);
    const timer = testHarness.timers.records[0];
    if (timer === undefined) throw new Error('watchdog was not installed');
    testHarness.timers.fire(timer);
    await completion;
    pending.reject(new Error('late secret'));
    await Promise.resolve();
    expect(testHarness.process.stderr).toEqual(['expiry-cleanup: failed\n']);
    expect(testHarness.process.exitCodes).toEqual([1]);
  });

  it('lets settlement win the deadline race and ignores a captured late watchdog callback', async () => {
    const pending = deferred<unknown>();
    const testHarness = harness(() => pending.promise);
    const completion = runExpiryCleanup(VALID_ENVIRONMENT, testHarness.process, testHarness.runtime);
    const timer = testHarness.timers.records[0];
    if (timer === undefined) throw new Error('watchdog was not installed');

    pending.resolve(cleanupResult(2, 1));
    await completion;
    expect(timer.cleared).toBe(true);
    testHarness.timers.fire(timer, true);
    expect(testHarness.process).toMatchObject({
      stdout: [
        'expiry-cleanup: pass visited=2 removed=1 securityRemoved=1 rateRemoved=0 exhausted=true\n'
      ],
      stderr: [],
      exitCodes: [0]
    });
  });

  it('lets the watchdog win when it fires after settlement queues but before its microtask runs', async () => {
    const pending = deferred<unknown>();
    const testHarness = harness(() => pending.promise);
    const completion = runExpiryCleanup(VALID_ENVIRONMENT, testHarness.process, testHarness.runtime);
    const timer = testHarness.timers.records[0];
    if (timer === undefined) throw new Error('watchdog was not installed');

    pending.resolve(cleanupResult(2, 1));
    testHarness.timers.fire(timer);
    await completion;
    await Promise.resolve();
    expect(testHarness.process).toMatchObject({
      stdout: [],
      stderr: ['expiry-cleanup: failed\n'],
      exitCodes: [1]
    });
  });

  it('reports missing main configuration as one generic failure', async () => {
    const testHarness = harness();
    await main({}, testHarness.process, testHarness.runtime);
    expect(testHarness.process).toMatchObject({
      stdout: [],
      stderr: ['expiry-cleanup: failed\n'],
      exitCodes: [1]
    });
    expect(testHarness.createStore).not.toHaveBeenCalled();
  });
});

describe('compiled entrypoint', () => {
  it('exits with only the generic failure line for hostile configuration text', () => {
    const entrypoint = fileURLToPath(new URL('../dist/main.js', import.meta.url));
    const result = spawnSync(process.execPath, [entrypoint], {
      encoding: 'utf8',
      env: {
        ...VALID_ENVIRONMENT,
        PALANCAR_EXPIRY_CLEANUP_LIMIT: 'hostile-credential-secret-text'
      },
      timeout: 5_000
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('expiry-cleanup: failed\n');
  });
});
