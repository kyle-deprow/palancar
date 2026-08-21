import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({ writeSync: vi.fn() }));

import {
  GenerationProviderError,
  type GenerationProvider,
  type GenerationProviderCompletion
} from '@palancar/generation';

import {
  AZURE_GENERATION_DIAGNOSTIC_FAILURE_STAGES as ROOT_AZURE_GENERATION_DIAGNOSTIC_FAILURE_STAGES,
  AZURE_GENERATION_DIAGNOSTIC_STAGES as ROOT_AZURE_GENERATION_DIAGNOSTIC_STAGES,
} from '../src/index.js';

import {
  AZURE_GENERATION_DIAGNOSTIC_FAILURE_STAGES,
  AZURE_GENERATION_DIAGNOSTIC_STAGES,
  runAzureGenerationDiagnostic,
  type AzureGenerationDiagnosticDependencies,
  type AzureGenerationDiagnosticEnvironment,
  type AzureGenerationDiagnosticTokenSource
} from '../src/azure-generation-diagnostic.js';

const ENVIRONMENT: AzureGenerationDiagnosticEnvironment = Object.freeze({
  AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
  PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://diagnostic.openai.azure.com',
  PALANCAR_AZURE_GENERATION_DEPLOYMENT: 'gpt-5.6-luna'
});
const TIMEOUT_LINE = 'azure-generation-diagnostic: failed stage=timeout\n';
const UNKNOWN_LINE = 'azure-generation-diagnostic: failed stage=unknown\n';
const DIAGNOSTIC_PATH = fileURLToPath(
  new URL('../dist/azure-generation-diagnostic.js', import.meta.url)
);
const DIAGNOSTIC_URL = pathToFileURL(DIAGNOSTIC_PATH).href;

const COMPLETION: GenerationProviderCompletion = Object.freeze({
  englishTranslation: 'Where is the train station?',
  suggestions: Object.freeze([
    Object.freeze({
      englishText: 'Could you help me, please?',
      selectedTargetText: '¿Podrías ayudarme, por favor?'
    }),
    Object.freeze({
      englishText: 'Can you show me the way?',
      selectedTargetText: '¿Puedes mostrarme el camino?'
    })
  ]) as GenerationProviderCompletion['suggestions']
});

const TRUSTED_STAGES = [
  'identity',
  'timeout',
  'transport',
  'auth',
  'rate_limit',
  'http',
  'response_size',
  'response_envelope',
  'finish_length',
  'finish_other',
  'completion_json',
  'completion_schema',
  'unknown'
] as const;

interface TimerHarness {
  readonly timer: NonNullable<AzureGenerationDiagnosticDependencies['timer']>;
  readonly delayMs: () => number | undefined;
  readonly clearCount: () => number;
  readonly fire: () => void;
  readonly events: string[];
}

function timerHarness(): TimerHarness {
  let callback: (() => void) | undefined;
  let delay: number | undefined;
  let clearCount = 0;
  const events: string[] = [];
  const timer = {
    setTimeout: vi.fn((next: () => void, delayMs: number): object => {
      callback = next;
      delay = delayMs;
      events.push('timer.set');
      return {};
    }),
    clearTimeout: vi.fn(() => {
      clearCount += 1;
      events.push('timer.clear');
    })
  };
  return {
    timer,
    delayMs: () => delay,
    clearCount: () => clearCount,
    fire: () => {
      if (callback === undefined) throw new Error('watchdog was not installed');
      callback();
    },
    events
  };
}

function sourceHarness(
  overrides: Partial<AzureGenerationDiagnosticTokenSource> = {}
): Readonly<{
  readonly source: AzureGenerationDiagnosticTokenSource;
  readonly close: ReturnType<typeof vi.fn>;
}> {
  const close = vi.fn();
  const source: AzureGenerationDiagnosticTokenSource = {
    tokenProvider: async () => ({
      token: 'diagnostic-token',
      expiresOnTimestamp: Date.now() + 300_000
    }),
    close,
    ...overrides
  };
  return { source, close };
}

function providerHarness(
  complete: GenerationProvider['complete']
): Readonly<{
  readonly provider: GenerationProvider;
  readonly complete: ReturnType<typeof vi.fn>;
}> {
  const completeSpy = vi.fn(complete);
  const provider = {
    id: 'diagnostic-provider',
    version: '1.0.0',
    complete: completeSpy
  } satisfies GenerationProvider;
  return { provider, complete: completeSpy };
}

function dependencies(
  timer: TimerHarness,
  source: AzureGenerationDiagnosticTokenSource,
  provider: GenerationProvider,
  overrides: Partial<AzureGenerationDiagnosticDependencies> = {}
): Readonly<{
  readonly options: AzureGenerationDiagnosticDependencies;
  readonly lines: string[];
  readonly terminated: number[];
}> {
  const lines: string[] = [];
  const terminated: number[] = [];
  return {
    options: {
      environment: ENVIRONMENT,
      timer: timer.timer,
      output: { writeStdout: (line) => lines.push(line) },
      terminate: (code) => terminated.push(code),
      tokenSourceFactory: () => source,
      providerFactory: () => provider,
      ...overrides
    },
    lines,
    terminated
  };
}

function pending<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function flushOneTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function runDiagnosticChild(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {}
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(process.execPath, [...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function captureDefaultWrites(): {
  readonly chunks: string[];
  readonly restore: () => void;
} {
  const chunks: string[] = [];
  const writeSync = vi.mocked(fs.writeSync);
  writeSync.mockClear();
  writeSync.mockImplementation((_fd, buffer, offset, length) => {
    const bytes = typeof buffer === 'string'
      ? Buffer.from(buffer)
      : Buffer.from(buffer as unknown as Uint8Array);
    const start = typeof offset === 'number' ? offset : 0;
    const requested = typeof length === 'number' ? length : bytes.byteLength - start;
    const count = Math.min(2, requested);
    chunks.push(bytes.subarray(start, start + count).toString('utf8'));
    return count;
  });
  return { chunks, restore: () => writeSync.mockReset() };
}

interface HostilePrototype {
  readonly prototype: object;
  readonly trapCount: () => number;
}

function hostilePrototype(revoked: boolean): HostilePrototype {
  let trapCount = 0;
  const handler: ProxyHandler<object> = {
    get: () => {
      trapCount += 1;
      throw new Error('prototype get trap');
    },
    getOwnPropertyDescriptor: () => {
      trapCount += 1;
      throw new Error('prototype descriptor trap');
    },
    getPrototypeOf: () => {
      trapCount += 1;
      throw new Error('prototype getPrototypeOf trap');
    },
    has: () => {
      trapCount += 1;
      throw new Error('prototype has trap');
    },
    ownKeys: () => {
      trapCount += 1;
      throw new Error('prototype ownKeys trap');
    }
  };
  const revocable = Proxy.revocable({}, handler);
  if (revoked) revocable.revoke();
  return { prototype: revocable.proxy, trapCount: () => trapCount };
}

function objectWithPrototype(
  prototype: object,
  properties: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  const value = Object.create(prototype) as Record<string, unknown>;
  for (const [key, propertyValue] of Object.entries(properties)) {
    Object.defineProperty(value, key, {
      enumerable: true,
      value: propertyValue
    });
  }
  return value;
}

describe('azure generation diagnostic', () => {
  it('exports exactly the trusted provider stages plus validation_failure', () => {
    expect(ROOT_AZURE_GENERATION_DIAGNOSTIC_STAGES).toBe(AZURE_GENERATION_DIAGNOSTIC_STAGES);
    expect(ROOT_AZURE_GENERATION_DIAGNOSTIC_FAILURE_STAGES)
      .toBe(AZURE_GENERATION_DIAGNOSTIC_FAILURE_STAGES);
    expect(AZURE_GENERATION_DIAGNOSTIC_STAGES).toEqual([
      ...TRUSTED_STAGES,
      'validation_failure'
    ]);
    expect(new Set(AZURE_GENERATION_DIAGNOSTIC_STAGES)).toEqual(
      new Set([...TRUSTED_STAGES, 'validation_failure'])
    );
    expect(AZURE_GENERATION_DIAGNOSTIC_STAGES).toHaveLength(14);
    expect(AZURE_GENERATION_DIAGNOSTIC_FAILURE_STAGES).toEqual(
      AZURE_GENERATION_DIAGNOSTIC_STAGES
    );
  });

  it('is import-safe and performs one fixed Spanish provider request', async () => {
    const timer = timerHarness();
    const source = sourceHarness();
    let observedInput: unknown;
    let observedConfig: Readonly<{ endpoint: string; deployment: string }> | undefined;
    const provider = providerHarness(async (input) => {
      observedInput = input;
      return COMPLETION;
    });
    const setup = dependencies(timer, source.source, provider.provider, {
      providerFactory: (config) => {
        observedConfig = { endpoint: config.endpoint, deployment: config.deployment };
        return provider.provider;
      }
    });

    await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(0);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(observedInput).toEqual({
      sessionId: '11111111-1111-4111-8111-111111111111',
      sessionEpoch: 1,
      utteranceId: '22222222-2222-4222-8222-222222222222',
      segmentId: 'azure-diagnostic-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'es',
      targetTranscript: '¿Podrías ayudarme a encontrar la estación de tren, por favor?',
      gatePolicyVersion: '1.0.0'
    });
    expect(observedConfig).toEqual({
      endpoint: ENVIRONMENT.PALANCAR_AZURE_GENERATION_ENDPOINT,
      deployment: ENVIRONMENT.PALANCAR_AZURE_GENERATION_DEPLOYMENT
    });
    expect(setup.lines).toEqual(['azure-generation-diagnostic: passed\n']);
    expect(setup.terminated).toEqual([]);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(timer.clearCount()).toBe(1);
  });

  it('maps wrong-language generated output to validation_failure and never passes', async () => {
    const timer = timerHarness();
    const source = sourceHarness();
    const provider = providerHarness(async () => ({
      englishTranslation: '¿Dónde está la estación de tren?',
      suggestions: [
        { englishText: '¿Podrías ayudarme?', selectedTargetText: 'Where is the train station?' },
        { englishText: '¿Puedes mostrarme el camino?', selectedTargetText: 'Go to the station.' }
      ]
    }));
    const setup = dependencies(timer, source.source, provider.provider);

    await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
    expect(setup.lines).toEqual(['azure-generation-diagnostic: failed stage=validation_failure\n']);
    expect(setup.lines).not.toContain('azure-generation-diagnostic: passed\n');
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('maps a validator throw to validation_failure and never passes', async () => {
    vi.doMock('../src/provisional-language-boundary.js', () => ({
      createDevelopmentProvisionalLanguageBoundary: () => ({
        generatedLanguageValidator: {
          id: 'throwing-diagnostic-validator',
          version: '1.0.0',
          validate: async () => {
            throw new Error('validator canary');
          }
        }
      })
    }));
    vi.resetModules();
    try {
      const diagnostic = await import('../src/azure-generation-diagnostic.js');
      const timer = timerHarness();
      const source = sourceHarness();
      const provider = providerHarness(async () => COMPLETION);
      const setup = dependencies(timer, source.source, provider.provider);

      await expect(diagnostic.runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
      expect(setup.lines).toEqual(['azure-generation-diagnostic: failed stage=validation_failure\n']);
      expect(setup.lines).not.toContain('azure-generation-diagnostic: passed\n');
      expect(provider.complete).toHaveBeenCalledTimes(1);
      expect(source.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('../src/provisional-language-boundary.js');
      vi.resetModules();
    }
  });

  it.each(TRUSTED_STAGES)('emits trusted provider stage %s', async (stage) => {
    const timer = timerHarness();
    const source = sourceHarness();
    const provider = providerHarness(async () => {
      throw new GenerationProviderError(stage);
    });
    const setup = dependencies(timer, source.source, provider.provider);

    await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
    expect(setup.lines).toEqual([`azure-generation-diagnostic: failed stage=${stage}\n`]);
    expect(setup.terminated).toEqual([]);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(timer.clearCount()).toBe(1);
  });

  it('maps forged, hostile, and revoked errors to unknown without leaking content', async () => {
    const errors: unknown[] = [
      new Error('HOSTILE-ERROR-CONTENT'),
      new Proxy({}, { get: () => { throw new Error('HOSTILE-PROPERTY'); } }),
      Object.create(GenerationProviderError.prototype)
    ];
    for (const error of errors) {
      const timer = timerHarness();
      const source = sourceHarness();
      const provider = providerHarness(async () => {
        throw error;
      });
      const setup = dependencies(timer, source.source, provider.provider);

      await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
      expect(setup.lines).toEqual(['azure-generation-diagnostic: failed stage=unknown\n']);
      expect(setup.lines.join('')).not.toContain('HOSTILE');
      expect(source.close).toHaveBeenCalledTimes(1);
    }
  });

  it('returns content-free unknown for config, source, and provider construction failures', async () => {
    const cases: ReadonlyArray<{
      readonly options: Partial<AzureGenerationDiagnosticDependencies>;
      readonly expectedCloseCount: number;
    }> = [
      { options: { environment: { AZURE_CLIENT_ID: 'SECRET-CLIENT-ID' } }, expectedCloseCount: 0 },
      {
        options: {
          tokenSourceFactory: () => {
            throw new Error('SOURCE-SECRET');
          }
        },
        expectedCloseCount: 0
      }
    ];
    for (const testCase of cases) {
      const timer = timerHarness();
      const source = sourceHarness();
      const provider = providerHarness(async () => COMPLETION);
      const setup = dependencies(timer, source.source, provider.provider, testCase.options);

      await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
      expect(setup.lines).toEqual(['azure-generation-diagnostic: failed stage=unknown\n']);
      expect(setup.lines.join('')).not.toContain('SECRET');
      expect(source.close).toHaveBeenCalledTimes(testCase.expectedCloseCount);
    }

    const timer = timerHarness();
    const source = sourceHarness();
    const setup = dependencies(timer, source.source, providerHarness(async () => COMPLETION).provider, {
      providerFactory: () => {
        throw new Error('PROVIDER-SECRET');
      }
    });
    await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
    expect(setup.lines).toEqual(['azure-generation-diagnostic: failed stage=unknown\n']);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(setup.lines.join('')).not.toContain('PROVIDER');
  });

  it('rejects dependency input proxies, revoked proxies, and accessors without getters or live output fallback', async () => {
    const getterCount = { value: 0 };
    const liveOutput = vi.fn();
    const inputProxy = new Proxy({}, {
      get: () => {
        getterCount.value += 1;
        throw new Error('input proxy getter');
      }
    });
    const revokedInput = Proxy.revocable({}, {});
    revokedInput.revoke();
    const accessorInput = Object.defineProperty(
      { output: { writeStdout: liveOutput } },
      'environment',
      {
        enumerable: true,
        get: () => {
          getterCount.value += 1;
          throw new Error('input accessor getter');
        }
      }
    );

    for (const input of [inputProxy, revokedInput.proxy, accessorInput]) {
      const captured = captureDefaultWrites();
      try {
        await expect(runAzureGenerationDiagnostic(
          input as unknown as AzureGenerationDiagnosticDependencies
        )).resolves.toBe(20);
      } finally {
        captured.restore();
      }
      expect(captured.chunks.join('')).toBe(UNKNOWN_LINE);
    }
    expect(getterCount.value).toBe(0);
    expect(liveOutput).not.toHaveBeenCalled();
  });

  it('rejects environment proxies, revoked proxies, and accessors before source construction', async () => {
    const getterCount = { value: 0 };
    const cases: readonly unknown[] = [
      new Proxy(ENVIRONMENT, {
        get: () => {
          getterCount.value += 1;
          throw new Error('environment proxy getter');
        }
      }),
      (() => {
        const revoked = Proxy.revocable(ENVIRONMENT, {});
        revoked.revoke();
        return revoked.proxy;
      })(),
      Object.defineProperty({ ...ENVIRONMENT }, 'AZURE_CLIENT_ID', {
        enumerable: true,
        get: () => {
          getterCount.value += 1;
          throw new Error('environment accessor getter');
        }
      })
    ];

    for (const environment of cases) {
      const timer = timerHarness();
      const source = sourceHarness();
      const provider = providerHarness(async () => COMPLETION);
      const sourceFactory = vi.fn(() => source.source);
      const setup = dependencies(timer, source.source, provider.provider, {
        environment: environment as AzureGenerationDiagnosticEnvironment,
        tokenSourceFactory: sourceFactory
      });

      await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
      expect(setup.lines).toEqual([UNKNOWN_LINE]);
      expect(sourceFactory).not.toHaveBeenCalled();
      expect(provider.complete).not.toHaveBeenCalled();
    }
    expect(getterCount.value).toBe(0);
  });

  it('rejects source proxies and revoked proxies without invoking proxy getters', async () => {
    const getterCount = { value: 0 };
    const sourceProxy = new Proxy({}, {
      get: () => {
        getterCount.value += 1;
        throw new Error('source proxy getter');
      }
    });
    const revokedSource = Proxy.revocable({}, {});
    revokedSource.revoke();

    for (const candidate of [sourceProxy, revokedSource.proxy]) {
      const timer = timerHarness();
      const source = sourceHarness();
      const provider = providerHarness(async () => COMPLETION);
      const setup = dependencies(timer, source.source, provider.provider, {
        tokenSourceFactory: () => candidate as unknown as AzureGenerationDiagnosticTokenSource
      });

      await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
      expect(setup.lines).toEqual([UNKNOWN_LINE]);
      expect(provider.complete).not.toHaveBeenCalled();
      expect(source.close).not.toHaveBeenCalled();
    }
    expect(getterCount.value).toBe(0);
  });

  it('rejects provider proxies and revoked proxies while closing the real source once', async () => {
    const getterCount = { value: 0 };
    const providerProxy = new Proxy({}, {
      get: () => {
        getterCount.value += 1;
        throw new Error('provider proxy getter');
      }
    });
    const revokedProvider = Proxy.revocable({}, {});
    revokedProvider.revoke();

    for (const candidate of [providerProxy, revokedProvider.proxy]) {
      const timer = timerHarness();
      const source = sourceHarness();
      const provider = providerHarness(async () => COMPLETION);
      const setup = dependencies(timer, source.source, provider.provider, {
        providerFactory: () => candidate as unknown as GenerationProvider
      });

      await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
      expect(setup.lines).toEqual([UNKNOWN_LINE]);
      expect(provider.complete).not.toHaveBeenCalled();
      expect(source.close).toHaveBeenCalledTimes(1);
    }
    expect(getterCount.value).toBe(0);
  });

  it.each(['timer', 'output', 'source', 'provider'] as const)(
    'rejects a %s inherited proxy or revoked-proxy prototype without traps or fallback work',
    async (target) => {
      for (const revoked of [false, true]) {
        const attack = hostilePrototype(revoked);
        const timer = timerHarness();
        const source = sourceHarness();
        const provider = providerHarness(async () => COMPLETION);
        const liveOutput = vi.fn();
        let sourceFactoryCount = 0;
        let providerFactoryCount = 0;
        const sourceFactory = () => {
          sourceFactoryCount += 1;
          return source.source;
        };
        const providerFactory = () => {
          providerFactoryCount += 1;
          return provider.provider;
        };
        const overrides: Partial<AzureGenerationDiagnosticDependencies> = {
          output: { writeStdout: liveOutput },
          tokenSourceFactory: sourceFactory,
          providerFactory
        };
        let partialSourceClose: ReturnType<typeof vi.fn> | undefined;

        if (target === 'timer') {
          Object.assign(overrides, {
            timer: objectWithPrototype(attack.prototype) as unknown as NonNullable<
              AzureGenerationDiagnosticDependencies['timer']
            >
          });
        } else if (target === 'output') {
          Object.assign(overrides, {
            output: objectWithPrototype(attack.prototype) as unknown as NonNullable<
              AzureGenerationDiagnosticDependencies['output']
            >
          });
        } else if (target === 'source') {
          partialSourceClose = vi.fn();
          const candidate = objectWithPrototype(attack.prototype, {
            close: partialSourceClose
          });
          Object.assign(overrides, {
            tokenSourceFactory: () => {
              sourceFactoryCount += 1;
              return candidate as unknown as AzureGenerationDiagnosticTokenSource;
            }
          });
        } else {
          const candidate = objectWithPrototype(attack.prototype, {
            id: 'diagnostic-provider',
            version: '1.0.0'
          });
          Object.assign(overrides, {
            providerFactory: () => {
              providerFactoryCount += 1;
              return candidate as unknown as GenerationProvider;
            }
          });
        }

        const setup = dependencies(timer, source.source, provider.provider, overrides);
        const fallbackCapture = target === 'timer' || target === 'output'
          ? captureDefaultWrites()
          : undefined;
        try {
          await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
        } finally {
          fallbackCapture?.restore();
        }

        if (fallbackCapture === undefined) {
          expect(liveOutput).toHaveBeenCalledWith(UNKNOWN_LINE);
          expect(liveOutput).toHaveBeenCalledTimes(1);
        } else {
          expect(fallbackCapture.chunks.join('')).toBe(UNKNOWN_LINE);
          expect(liveOutput).not.toHaveBeenCalled();
        }
        expect(attack.trapCount(), `${target} revoked=${revoked}`).toBe(0);
        expect(provider.complete).not.toHaveBeenCalled();
        expect(sourceFactoryCount).toBe(target === 'source' || target === 'provider' ? 1 : 0);
        expect(providerFactoryCount).toBe(target === 'provider' ? 1 : 0);
        if (target === 'source') {
          expect(partialSourceClose).toHaveBeenCalledTimes(1);
          expect(source.close).not.toHaveBeenCalled();
        } else {
          expect(source.close).toHaveBeenCalledTimes(target === 'provider' ? 1 : 0);
        }
      }
    }
  );

  it.each([
    ['tokenProvider', true],
    ['close', false]
  ] as const)('does not invoke an inherited source %s accessor', async (member, closes) => {
    let getterCount = 0;
    const inherited = Object.defineProperty({}, member, {
      get: () => {
        getterCount += 1;
        throw new Error(`source ${member} getter`);
      }
    });
    const close = vi.fn();
    const candidate = objectWithPrototype(inherited, closes ? { close } : {
      tokenProvider: async () => ({
        token: 'diagnostic-token',
        expiresOnTimestamp: Date.now() + 300_000
      })
    });
    const timer = timerHarness();
    const source = sourceHarness();
    const provider = providerHarness(async () => COMPLETION);
    const providerFactory = vi.fn(() => provider.provider);
    const setup = dependencies(timer, source.source, provider.provider, {
      tokenSourceFactory: () => candidate as unknown as AzureGenerationDiagnosticTokenSource,
      providerFactory
    });

    await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
    expect(setup.lines).toEqual([UNKNOWN_LINE]);
    expect(getterCount).toBe(0);
    expect(providerFactory).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(closes ? 1 : 0);
    expect(source.close).not.toHaveBeenCalled();
  });

  it.each(['id', 'version', 'complete'] as const)(
    'does not invoke an inherited provider %s accessor',
    async (member) => {
      let getterCount = 0;
      const inherited = Object.defineProperty({}, member, {
        get: () => {
          getterCount += 1;
          throw new Error(`provider ${member} getter`);
        }
      });
      const candidate = objectWithPrototype(inherited, {
        ...(member === 'id' ? {} : { id: 'diagnostic-provider' }),
        ...(member === 'version' ? {} : { version: '1.0.0' }),
        ...(member === 'complete' ? {} : { complete: async () => COMPLETION })
      });
      const timer = timerHarness();
      const source = sourceHarness();
      const provider = providerHarness(async () => COMPLETION);
      const providerFactory = vi.fn(() => candidate as unknown as GenerationProvider);
      const setup = dependencies(timer, source.source, provider.provider, {
        providerFactory
      });

      await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
      expect(setup.lines).toEqual([UNKNOWN_LINE]);
      expect(getterCount).toBe(0);
      expect(providerFactory).toHaveBeenCalledTimes(1);
      expect(provider.complete).not.toHaveBeenCalled();
      expect(source.close).toHaveBeenCalledTimes(1);
    }
  );

  it('closes partial source and provider candidates exactly once', async () => {
    const partialSourceClose = vi.fn();
    const partialSources: readonly unknown[] = [
      { tokenProvider: 'not-a-function', close: partialSourceClose },
      { close: partialSourceClose }
    ];
    for (const candidate of partialSources) {
      const timer = timerHarness();
      const source = sourceHarness();
      const provider = providerHarness(async () => COMPLETION);
      const setup = dependencies(timer, source.source, provider.provider, {
        tokenSourceFactory: () => candidate as unknown as AzureGenerationDiagnosticTokenSource
      });

      await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
      expect(setup.lines).toEqual([UNKNOWN_LINE]);
      expect(partialSourceClose).toHaveBeenCalledTimes(partialSources.indexOf(candidate) + 1);
      expect(provider.complete).not.toHaveBeenCalled();
    }

    const timer = timerHarness();
    const source = sourceHarness();
    const provider = providerHarness(async () => COMPLETION);
    const providerCandidate = { id: 'diagnostic-provider', version: '1.0.0' };
    const setup = dependencies(timer, source.source, provider.provider, {
      providerFactory: () => providerCandidate as GenerationProvider
    });
    await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
    expect(setup.lines).toEqual([UNKNOWN_LINE]);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  const forbiddenEnvironmentNames = [
    'OPENAI_API_KEY',
    'AZURE_APIKEY',
    'OPENROUTER_API_KEY',
    'LITELLM_API_KEY',
    'PALANCAR_LITELLM_API_KEY',
    'OPENAI_SCOPE',
    'AZURE_FOUNDRY_TOKEN_SCOPE',
    'CUSTOM_SCOPE',
    'AZURE_API_VERSION',
    'PALANCAR_AZURE_GENERATION_VERSION',
    'OPENAI_VERSION',
    'LITELLM_VERSION',
    'OPENROUTER_VERSION',
    'AZURE_LOG_LEVEL',
    'PALANCAR_LOG_LEVEL',
    'PALANCAR_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_ENDPOINT'
  ] as const;

  it.each(forbiddenEnvironmentNames)(
    'rejects forbidden environment name %s before source construction',
    async (name) => {
      const timer = timerHarness();
      const source = sourceHarness();
      const provider = providerHarness(async () => COMPLETION);
      const sourceFactory = vi.fn(() => source.source);
      const setup = dependencies(timer, source.source, provider.provider, {
        environment: { ...ENVIRONMENT, [name]: 'FORBIDDEN-CONFIG-CANARY' },
        tokenSourceFactory: sourceFactory
      });

      await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
      expect(setup.lines).toEqual([UNKNOWN_LINE]);
      expect(setup.lines.join('')).not.toContain('FORBIDDEN-CONFIG-CANARY');
      expect(sourceFactory).not.toHaveBeenCalled();
      expect(provider.complete).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['bad UUID', { AZURE_CLIENT_ID: 'not-a-canonical-uuid' }],
    ['bad endpoint', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://evil.example.com/' }],
    ['bad deployment', { PALANCAR_AZURE_GENERATION_DEPLOYMENT: 'gpt-4o' }]
  ] as const)('rejects %s before source construction', async (_description, change) => {
    const timer = timerHarness();
    const source = sourceHarness();
    const provider = providerHarness(async () => COMPLETION);
    const sourceFactory = vi.fn(() => source.source);
    const setup = dependencies(timer, source.source, provider.provider, {
      environment: { ...ENVIRONMENT, ...change },
      tokenSourceFactory: sourceFactory
    });

    await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
    expect(setup.lines).toEqual([UNKNOWN_LINE]);
    expect(sourceFactory).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('passes the injected clock to the one token-source construction', async () => {
    const timer = timerHarness();
    const source = sourceHarness();
    const clock = vi.fn(() => 123_456);
    const sourceFactory = vi.fn(() => source.source);
    const provider = providerHarness(async () => COMPLETION);
    const setup = dependencies(timer, source.source, provider.provider, {
      clock,
      tokenSourceFactory: sourceFactory
    });

    await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(0);
    expect(sourceFactory).toHaveBeenCalledTimes(1);
    expect(sourceFactory).toHaveBeenCalledWith({
      clientId: ENVIRONMENT.AZURE_CLIENT_ID,
      now: clock
    });
  });

  it('uses no retry and clears the watchdog before its single normal output line', async () => {
    const timer = timerHarness();
    const source = sourceHarness();
    const provider = providerHarness(async () => {
      throw new GenerationProviderError('transport');
    });
    const events: string[] = [];
    const setup = dependencies(timer, source.source, provider.provider, {
      output: { writeStdout: (line) => { events.push(`stdout:${line}`); } }
    });
    await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(timer.clearCount()).toBe(1);
    expect(events).toEqual(['stdout:azure-generation-diagnostic: failed stage=transport\n']);
  });

  it('loops until the complete diagnostic line is written through synchronous fd output', async () => {
    const captured = captureDefaultWrites();
    try {
      await expect(runAzureGenerationDiagnostic({
        environment: {},
        timer: timerHarness().timer
      })).resolves.toBe(20);
    } finally {
      captured.restore();
    }

    expect(captured.chunks.length).toBeGreaterThan(1);
    expect(captured.chunks.join('')).toBe(UNKNOWN_LINE);
  });

  it.each([
    ['fires inline and returns', false],
    ['fires inline and throws', true]
  ] as const)('latches one timeout when setTimeout %s', async (_description, throwAfterFire) => {
    const source = sourceHarness();
    const provider = providerHarness(async () => COMPLETION);
    const sourceFactory = vi.fn(() => source.source);
    const providerFactory = vi.fn(() => provider.provider);
    const setTimeout = vi.fn((callback: () => void): object => {
      callback();
      if (throwAfterFire) throw new Error('inline timer canary');
      return {};
    });
    const setup = dependencies(
      {
        timer: { setTimeout, clearTimeout: vi.fn() },
        delayMs: () => undefined,
        clearCount: () => 0,
        fire: () => undefined,
        events: []
      },
      source.source,
      provider.provider,
      { tokenSourceFactory: sourceFactory, providerFactory }
    );

    await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
    expect(setup.lines).toEqual([TIMEOUT_LINE]);
    expect(setup.terminated).toEqual([20]);
    expect(sourceFactory).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it.each([
    ['source factory', 'source'],
    ['provider factory', 'provider']
  ] as const)('stops downstream work when the %s fires the stored watchdog before returning', async (
    _description,
    point
  ) => {
    const timer = timerHarness();
    const source = sourceHarness();
    const provider = providerHarness(async () => COMPLETION);
    const sourceFactory = vi.fn(() => {
      if (point === 'source') timer.fire();
      return source.source;
    });
    const providerFactory = vi.fn(() => {
      if (point === 'provider') timer.fire();
      return provider.provider;
    });
    const setup = dependencies(timer, source.source, provider.provider, {
      tokenSourceFactory: sourceFactory,
      providerFactory
    });

    await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
    expect(setup.lines).toEqual([TIMEOUT_LINE]);
    expect(setup.terminated).toEqual([20]);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(timer.clearCount()).toBe(0);
    if (point === 'source') {
      expect(providerFactory).not.toHaveBeenCalled();
    } else {
      expect(providerFactory).toHaveBeenCalledTimes(1);
    }
  });

  it('contains hostile timer, clear, output, and terminate throws without a second result', async () => {
    {
      const source = sourceHarness();
      const provider = providerHarness(async () => COMPLETION);
      const lines: string[] = [];
      const setup = dependencies(
        {
          timer: { setTimeout: vi.fn(() => { throw new Error('timer canary'); }), clearTimeout: vi.fn() },
          delayMs: () => undefined,
          clearCount: () => 0,
          fire: () => undefined,
          events: []
        },
        source.source,
        provider.provider,
        { output: { writeStdout: (line) => lines.push(line) } }
      );
      await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
      expect(lines).toEqual([UNKNOWN_LINE]);
      expect(setup.terminated).toEqual([]);
      expect(provider.complete).not.toHaveBeenCalled();
    }

    {
      const timer = timerHarness();
      const source = sourceHarness();
      const provider = providerHarness(async () => {
        throw new GenerationProviderError('transport');
      });
      const lines: string[] = [];
      const setup = dependencies(timer, source.source, provider.provider, {
        output: { writeStdout: (line) => { lines.push(line); throw new Error('output canary'); } },
        timer: { setTimeout: timer.timer.setTimeout, clearTimeout: () => { throw new Error('clear canary'); } }
      });
      await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(20);
      expect(lines).toEqual([`azure-generation-diagnostic: failed stage=transport\n`]);
      expect(setup.terminated).toEqual([]);
      expect(source.close).toHaveBeenCalledTimes(1);
      expect(timer.events.filter((event) => event === 'timer.clear')).toHaveLength(0);
    }

    {
      const timer = timerHarness();
      const source = sourceHarness();
      const provider = providerHarness(async () => pending<GenerationProviderCompletion>());
      const lines: string[] = [];
      const terminate = vi.fn(() => { throw new Error('terminate canary'); });
      const setup = dependencies(timer, source.source, provider.provider, {
        output: { writeStdout: (line) => lines.push(line) },
        terminate
      });
      const operation = runAzureGenerationDiagnostic(setup.options);
      await Promise.resolve();
      timer.fire();
      await expect(operation).resolves.toBe(20);
      expect(lines).toEqual([TIMEOUT_LINE]);
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(setup.terminated).toEqual([]);
      expect(source.close).toHaveBeenCalledTimes(1);
    }
  });

  it('installs the 90-second watchdog before source construction', async () => {
    const timer = timerHarness();
    const order: string[] = [];
    const source = sourceHarness();
    const provider = providerHarness(async () => pending<GenerationProviderCompletion>());
    const setup = dependencies(timer, source.source, provider.provider, {
      timer: {
        setTimeout: (callback, delayMs) => {
          order.push(`timer:${delayMs}`);
          return timer.timer.setTimeout(callback, delayMs);
        },
        clearTimeout: timer.timer.clearTimeout
      },
      tokenSourceFactory: () => {
        order.push('source');
        return source.source;
      }
    });
    const operation = runAzureGenerationDiagnostic(setup.options);
    expect(order[0]).toBe('timer:90000');
    timer.fire();

    await expect(operation).resolves.toBe(20);
    expect(setup.lines).toEqual([TIMEOUT_LINE]);
    expect(setup.terminated).toEqual([20]);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(timer.clearCount()).toBe(0);
  });

  it('uses the watchdog for a hanging token acquisition and closes once', async () => {
    const timer = timerHarness();
    const source = sourceHarness({
      tokenProvider: () => pending()
    });
    const provider = providerHarness(async () => {
      await source.source.tokenProvider(new AbortController().signal);
      return COMPLETION;
    });
    const setup = dependencies(timer, source.source, provider.provider);
    const operation = runAzureGenerationDiagnostic(setup.options);
    await Promise.resolve();
    timer.fire();

    await expect(operation).resolves.toBe(20);
    expect(setup.lines).toEqual([TIMEOUT_LINE]);
    expect(setup.terminated).toEqual([20]);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(timer.clearCount()).toBe(0);
  });

  it('aborts the exact provider token signal and contains a late token rejection', async () => {
    let rejectToken: (reason?: unknown) => void = () => undefined;
    let observedTokenSignal: AbortSignal | undefined;
    let observedProviderSignal: AbortSignal | undefined;
    let configuredTokenProvider: AzureGenerationDiagnosticTokenSource['tokenProvider'] | undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const timer = timerHarness();
      const source = sourceHarness({
        tokenProvider: (signal) => {
          observedTokenSignal = signal;
          return new Promise((_, reject) => {
            rejectToken = reject;
          });
        }
      });
      const provider = providerHarness(async (_input, context) => {
        observedProviderSignal = context.signal;
        if (configuredTokenProvider === undefined) throw new Error('token provider missing');
        await configuredTokenProvider(context.signal);
        return COMPLETION;
      });
      const setup = dependencies(timer, source.source, provider.provider, {
        providerFactory: (config) => {
          configuredTokenProvider = config.tokenProvider;
          return provider.provider;
        }
      });
      const operation = runAzureGenerationDiagnostic(setup.options);
      await Promise.resolve();
      expect(provider.complete).toHaveBeenCalledTimes(1);
      timer.fire();

      await expect(operation).resolves.toBe(20);
      expect(observedTokenSignal).toBe(observedProviderSignal);
      expect(observedTokenSignal?.aborted).toBe(true);
      expect(setup.lines).toEqual([TIMEOUT_LINE]);
      expect(setup.terminated).toEqual([20]);
      expect(source.close).toHaveBeenCalledTimes(1);

      rejectToken(new Error('late token rejection canary'));
      await flushOneTurn();
      expect(unhandled).toEqual([]);
      expect(setup.lines).toEqual([TIMEOUT_LINE]);
      expect(setup.terminated).toEqual([20]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('uses the watchdog for a hanging provider request without a second request', async () => {
    const timer = timerHarness();
    const source = sourceHarness();
    const provider = providerHarness(async () => pending<GenerationProviderCompletion>());
    const setup = dependencies(timer, source.source, provider.provider);
    const operation = runAzureGenerationDiagnostic(setup.options);
    await Promise.resolve();
    timer.fire();

    await expect(operation).resolves.toBe(20);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(setup.lines).toEqual([TIMEOUT_LINE]);
    expect(setup.terminated).toEqual([20]);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(timer.clearCount()).toBe(0);
  });

  it('contains a late provider rejection without an unhandled rejection or second result', async () => {
    let rejectProvider: (reason?: unknown) => void = () => undefined;
    let observedSignal: AbortSignal | undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const timer = timerHarness();
      const source = sourceHarness();
      const provider = providerHarness((_input, context) => {
        observedSignal = context.signal;
        return new Promise<GenerationProviderCompletion>((_, reject) => {
          rejectProvider = reject;
        });
      });
      const setup = dependencies(timer, source.source, provider.provider);
      const operation = runAzureGenerationDiagnostic(setup.options);
      await Promise.resolve();
      expect(provider.complete).toHaveBeenCalledTimes(1);
      timer.fire();

      await expect(operation).resolves.toBe(20);
      expect(observedSignal?.aborted).toBe(true);
      expect(setup.lines).toEqual([TIMEOUT_LINE]);
      expect(setup.terminated).toEqual([20]);
      expect(source.close).toHaveBeenCalledTimes(1);

      rejectProvider(new Error('late provider rejection canary'));
      await flushOneTurn();
      expect(unhandled).toEqual([]);
      expect(setup.lines).toEqual([TIMEOUT_LINE]);
      expect(setup.terminated).toEqual([20]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps stderr empty because the runner only writes one bounded stdout line', async () => {
    const timer = timerHarness();
    const source = sourceHarness();
    const provider = providerHarness(async () => COMPLETION);
    const stderr = vi.spyOn(process.stderr, 'write');
    const setup = dependencies(timer, source.source, provider.provider);

    await expect(runAzureGenerationDiagnostic(setup.options)).resolves.toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(setup.lines).toHaveLength(1);
    expect(setup.lines[0]?.length).toBeLessThan(80);
    stderr.mockRestore();
  });

  it('is silent in a fresh child import', async () => {
    const result = await runDiagnosticChild([
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(DIAGNOSTIC_URL)})`
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('uses the direct entry once for invalid child configuration with the exact protocol line', async () => {
    const result = await runDiagnosticChild([DIAGNOSTIC_PATH]);

    expect(result.code).toBe(20);
    expect(result.stdout).toBe(UNKNOWN_LINE);
    expect(result.stderr).toBe('');
  });
});
