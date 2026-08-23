import { describe, expect, it, vi } from 'vitest';

import {
  DeterministicFixtureLanguageValidator,
  DeterministicMockProvider,
  GenerationError,
  GenerationProviderError,
  GenerationService,
  MetadataOnlyEvidenceCollector,
  createGenerationEvidenceRecord,
  createAcceptedTargetTurn,
  isDeterministicFixtureLanguageValidator,
  isAcceptedTargetTurn,
  trustedGenerationProviderFailureStage
} from '../src/index.js';
import type {
  AcceptedTargetTurn,
  GenerationProvider,
  GenerationProviderCompletion,
  GenerationProviderCompletionInput,
  GeneratedLanguageValidationEvidence,
  GeneratedLanguageValidationInput,
  GeneratedLanguageValidator,
  MetadataOnlyEvidenceCollectorLike,
  SuggestionPhrasePair
} from '../src/index.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';
const PROVIDER_FAILURE_STAGES = [
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

function turn(target: 'es' | 'tr' = 'es', revision = 1, targetTranscript?: string): AcceptedTargetTurn {
  return createAcceptedTargetTurn({
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    utteranceId: UTTERANCE_ID,
    segmentId: 'segment-1',
    acceptedFinalRevision: revision,
    selectedTargetLanguage: target,
    decision: 'target',
    targetTranscript: targetTranscript ?? (target === 'es' ? '¿Dónde está la estación?' : 'İstasyon nerede?'),
    gatePolicyVersion: '1.0.0'
  });
}

function suggestions(count: 2 | 3): SuggestionPhrasePair[] {
  const values: SuggestionPhrasePair[] = [
    { englishText: 'Where is the station?', selectedTargetText: '¿Dónde está la estación?' },
    { englishText: 'Can you show me the way?', selectedTargetText: '¿Puedes mostrarme el camino?' },
    { englishText: 'Thank you.', selectedTargetText: 'Gracias.' }
  ];
  return values.slice(0, count);
}

function completion(
  englishTranslation = 'English',
  suggestionPairs: SuggestionPhrasePair[] = suggestions(2)
): GenerationProviderCompletion {
  return { englishTranslation, suggestions: suggestionPairs as unknown as GenerationProviderCompletion['suggestions'] };
}

function validCompletionInput(): GenerationProviderCompletionInput {
  return {
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    utteranceId: UTTERANCE_ID,
    segmentId: 'segment-1',
    acceptedFinalRevision: 1,
    selectedTargetLanguage: 'es',
    gatePolicyVersion: '1.0.0',
    targetTranscript: 'source text'
  };
}

function serviceWithValidator(
  provider: GenerationProvider,
  evidenceCollector?: MetadataOnlyEvidenceCollectorLike
): GenerationService {
  return new GenerationService(
    provider,
    new DeterministicFixtureLanguageValidator(),
    evidenceCollector
  );
}

function validLanguageEvidence(
  input: GeneratedLanguageValidationInput,
  invalidIndex?: number
): GeneratedLanguageValidationEvidence {
  return {
    checks: input.checks.map((item, index) => ({
      slot: item.slot,
      expectedLanguage: item.expectedLanguage,
      detectedLanguage: index === invalidIndex ? 'other' : item.expectedLanguage,
      verdict: index === invalidIndex ? 'mismatch' : 'match',
      evidenceType: 'calibrated',
      confidenceBasisPoints: 10_000,
      provisionalScoreBasisPoints: null
    })) as unknown as GeneratedLanguageValidationEvidence['checks']
  };
}

function validProvisionalLanguageEvidence(
  input: GeneratedLanguageValidationInput,
  invalidIndex?: number
): GeneratedLanguageValidationEvidence {
  return {
    checks: input.checks.map((item, index) => ({
      slot: item.slot,
      expectedLanguage: item.expectedLanguage,
      detectedLanguage: index === invalidIndex ? 'other' : item.expectedLanguage,
      verdict: index === invalidIndex ? 'mismatch' : 'match',
      evidenceType: 'development-provisional',
      confidenceBasisPoints: null,
      provisionalScoreBasisPoints: 8_500
    })) as unknown as GeneratedLanguageValidationEvidence['checks']
  };
}

function languageValidator(
  validate: GeneratedLanguageValidator['validate'],
  id = 'test-language-validator'
): GeneratedLanguageValidator {
  return { id, version: '1.0.0', validate };
}

describe('accepted target boundary', () => {
  it.each(['es', 'tr'] as const)('accepts and freezes %s turns', (target) => {
    const input = {
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: target,
      decision: 'target' as const,
      targetTranscript: 'source text',
      gatePolicyVersion: '1.0.0'
    };
    const accepted = createAcceptedTargetTurn(input);
    input.targetTranscript = 'changed';

    expect(accepted.targetTranscript).toBe('source text');
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(isAcceptedTargetTurn(accepted)).toBe(true);
  });

  it.each([
    ['sessionId', { sessionId: 'not-a-v4-uuid' }],
    ['utteranceId', { utteranceId: 'not-a-v4-uuid' }],
    ['segmentId', { segmentId: '' }],
    ['revision', { acceptedFinalRevision: 0 }],
    ['target', { selectedTargetLanguage: 'fr' }],
    ['decision', { decision: 'english' }],
    ['transcript', { targetTranscript: '' }],
    ['gate version', { gatePolicyVersion: '' }]
  ])('rejects invalid %s input as a typed, content-free error', (_name, change) => {
    const input = {
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'es' as const,
      decision: 'target' as const,
      targetTranscript: 'source text',
      gatePolicyVersion: '1.0.0',
      ...change
    };

    try {
      createAcceptedTargetTurn(input as never);
      expect.fail('expected invalid input');
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationError);
      expect((error as GenerationError).category).toBe('invalid-input');
      expect((error as Error).message).not.toContain('source');
    }
  });

  it.each(['1.0', 'v1.0.0', '1.0.0/secret'])('rejects gate policy version %s outside the protocol pattern', (version) => {
    expect(() => createAcceptedTargetTurn({
      ...turn(),
      gatePolicyVersion: version
    })).toThrow(GenerationError);
  });
});

describe('one-call completion', () => {
  it('completes once, returns correlation metadata, and deeply freezes both outputs', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion('Where is the station?', suggestions(2)) }
    });
    const service = serviceWithValidator(provider);
    const result = await service.complete(turn('es'));

    expect(result).toEqual({
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'es',
      gatePolicyVersion: '1.0.0',
      englishTranslation: 'Where is the station?',
      suggestions: suggestions(2)
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.suggestions)).toBe(true);
    expect(result.suggestions.every((item) => Object.isFrozen(item))).toBe(true);
    expect(provider.callCounts).toEqual({ complete: 1 });
    expect(provider.completeInputs).toEqual([{
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'es',
      gatePolicyVersion: '1.0.0',
      targetTranscript: '¿Dónde está la estación?'
    }]);
  });

  it.each([2, 3] as const)('returns exactly %d deeply frozen suggestions', async (count) => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion('Where is the station?', suggestions(count)) }
    });
    const service = serviceWithValidator(provider);
    const result = await service.complete(turn('tr'));

    expect(result.suggestions).toHaveLength(count);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.suggestions)).toBe(true);
    expect(result.suggestions.every((item) => Object.isFrozen(item))).toBe(true);
    expect(provider.completeInputs).toEqual([{
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'tr',
      gatePolicyVersion: '1.0.0',
      targetTranscript: 'İstasyon nerede?'
    }]);
  });

  it('rejects forged values before provider calls', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion() }
    });
    const service = serviceWithValidator(provider);
    const accepted = turn();
    const forgedTurn = { ...accepted } as AcceptedTargetTurn;

    expect(() => service.complete(forgedTurn)).toThrow(GenerationError);
    expect(provider.completeCalls).toBe(0);

    await expect(service.complete(accepted)).resolves.toBeDefined();
    expect(provider.completeCalls).toBe(1);
  });
});

describe('provider failures, validation, retry, and deduplication', () => {
  it.each(PROVIDER_FAILURE_STAGES)('propagates the trusted %s provider stage into the typed error and evidence', async (stage) => {
    const provider = {
      id: 'staged-provider',
      version: '1.2.0',
      complete: async () => {
        throw new GenerationProviderError(stage);
      }
    } satisfies GenerationProvider;
    const service = serviceWithValidator(provider);

    await expect(service.complete(turn())).rejects.toMatchObject({
      category: 'provider-failure',
      providerFailureStage: stage,
      message: 'Generation provider failed.'
    });
    expect(service.evidence).toMatchObject([{
      status: 'failure',
      failureCategory: 'provider-failure',
      providerFailureStage: stage
    }]);
  });

  it('propagates a trusted GenerationError stage and rejects forged provider stages', async () => {
    const trustedProviderError = new GenerationError('provider-failure', 'identity');
    const trustedProvider = {
      id: 'generation-error-provider',
      version: '1.0.0',
      complete: async () => {
        throw trustedProviderError;
      }
    } satisfies GenerationProvider;
    const trustedService = serviceWithValidator(trustedProvider);

    await expect(trustedService.complete(turn())).rejects.toMatchObject({
      category: 'provider-failure',
      providerFailureStage: 'identity'
    });

    const getterCanary = 'getter-provider-stage-canary';
    let getterCalls = 0;
    const accessorError = {};
    Object.defineProperty(accessorError, 'providerFailureStage', {
      get: () => {
        getterCalls += 1;
        throw new Error(getterCanary);
      }
    });
    class SubclassProviderError extends GenerationProviderError {}
    const trustedError = new GenerationProviderError('auth');
    const hostileErrors: unknown[] = [
      { providerFailureStage: 'http', message: 'provider payload canary' },
      new Proxy(trustedError, {
        get: () => {
          throw new Error('proxy-provider-stage-canary');
        }
      }),
      new SubclassProviderError('rate_limit'),
      accessorError
    ];
    const provider = {
      id: 'hostile-stage-provider',
      version: '1.0.0',
      complete: async () => {
        throw hostileErrors.shift();
      }
    } satisfies GenerationProvider;
    const service = serviceWithValidator(provider);

    const hostileErrorCount = hostileErrors.length;
    for (let index = 0; index < hostileErrorCount; index += 1) {
      await expect(service.complete(turn())).rejects.toMatchObject({
        category: 'provider-failure',
        providerFailureStage: 'unknown',
        message: 'Generation provider failed.'
      });
    }
    expect(getterCalls).toBe(0);
    expect(service.evidence).toHaveLength(4);
    expect(service.evidence.every((record) => record.providerFailureStage === 'unknown')).toBe(true);
  });

  it('rejects a prototype-normalizing GenerationProviderError subclass as untrusted', async () => {
    class PrototypeNormalizingProviderError extends GenerationProviderError {
      constructor(stage: unknown) {
        super(stage);
        Object.setPrototypeOf(this, GenerationProviderError.prototype);
      }
    }
    const provider: GenerationProvider = {
      id: 'prototype-normalizing-provider-error',
      version: '1.0.0',
      complete: async () => {
        throw new PrototypeNormalizingProviderError('auth');
      }
    };
    const service = serviceWithValidator(provider);

    await expect(service.complete(turn())).rejects.toMatchObject({
      category: 'provider-failure',
      providerFailureStage: 'unknown'
    });
    expect(service.evidence).toMatchObject([{
      failureCategory: 'provider-failure',
      providerFailureStage: 'unknown'
    }]);
  });

  it('rejects a prototype-normalizing provider-failure GenerationError subclass as untrusted', async () => {
    class PrototypeNormalizingGenerationError extends GenerationError {
      constructor(stage: unknown) {
        super('provider-failure', stage);
        Object.setPrototypeOf(this, GenerationError.prototype);
      }
    }
    const provider: GenerationProvider = {
      id: 'prototype-normalizing-generation-error',
      version: '1.0.0',
      complete: async () => {
        throw new PrototypeNormalizingGenerationError('http');
      }
    };
    const service = serviceWithValidator(provider);

    await expect(service.complete(turn())).rejects.toMatchObject({
      category: 'provider-failure',
      providerFailureStage: 'unknown'
    });
    expect(service.evidence).toMatchObject([{
      failureCategory: 'provider-failure',
      providerFailureStage: 'unknown'
    }]);
  });

  it('normalizes trusted malformed provider stages to unknown', async () => {
    const providerErrors: unknown[] = [
      new GenerationProviderError('forged-provider-stage'),
      new GenerationError('provider-failure', 'forged-generation-stage')
    ];
    const provider: GenerationProvider = {
      id: 'malformed-stage-provider',
      version: '1.0.0',
      complete: async () => {
        throw providerErrors.shift();
      }
    };
    const service = serviceWithValidator(provider);

    await expect(service.complete(turn())).rejects.toMatchObject({
      category: 'provider-failure',
      providerFailureStage: 'unknown'
    });
    await expect(service.complete(turn())).rejects.toMatchObject({
      category: 'provider-failure',
      providerFailureStage: 'unknown'
    });
    expect(service.evidence).toMatchObject([
      { failureCategory: 'provider-failure', providerFailureStage: 'unknown' },
      { failureCategory: 'provider-failure', providerFailureStage: 'unknown' }
    ]);
  });

  it('returns undefined for revoked object and array proxies', () => {
    const revokedObject = Proxy.revocable({ secret: 'revoked object secret' }, {});
    const revokedArray = Proxy.revocable(['revoked array secret'], {});
    revokedObject.revoke();
    revokedArray.revoke();

    expect(() => trustedGenerationProviderFailureStage(revokedObject.proxy)).not.toThrow();
    expect(() => trustedGenerationProviderFailureStage(revokedArray.proxy)).not.toThrow();
    expect(trustedGenerationProviderFailureStage(revokedObject.proxy)).toBeUndefined();
    expect(trustedGenerationProviderFailureStage(revokedArray.proxy)).toBeUndefined();
  });

  it('normalizes revoked object and array proxies to unknown without leaking content', async () => {
    const revokedObject = Proxy.revocable({ secret: 'revoked object secret' }, {});
    const revokedArray = Proxy.revocable(['revoked array secret'], {});
    revokedObject.revoke();
    revokedArray.revoke();
    const hostileErrors: unknown[] = [revokedObject.proxy, revokedArray.proxy];
    const provider: GenerationProvider = {
      id: 'revoked-proxy-provider',
      version: '1.0.0',
      complete: async () => {
        throw hostileErrors.shift();
      }
    };
    const service = serviceWithValidator(provider);

    for (let index = 0; index < 2; index += 1) {
      await expect(service.complete(turn())).rejects.toMatchObject({
        category: 'provider-failure',
        providerFailureStage: 'unknown',
        message: 'Generation provider failed.'
      });
    }

    const serializedEvidence = JSON.stringify(service.evidence);
    expect(service.evidence).toHaveLength(2);
    expect(service.evidence.every((record) => record.providerFailureStage === 'unknown')).toBe(true);
    expect(serializedEvidence).not.toContain('revoked object secret');
    expect(serializedEvidence).not.toContain('revoked array secret');
  });

  it('redacts provider failures without retaining a cause and permits retry', async () => {
    const providerFailure = new Error('secret conversation: provider payload');
    const provider = new DeterministicMockProvider({
      complete: [
        { failure: providerFailure },
        { result: completion('Recovered English') }
      ]
    });
    const service = serviceWithValidator(provider);
    const accepted = turn();

    try {
      await service.complete(accepted);
      expect.fail('expected provider failure');
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationError);
      expect((error as GenerationError).category).toBe('provider-failure');
      expect((error as GenerationError).providerFailureStage).toBe('unknown');
      expect((error as Error).message).toBe('Generation provider failed.');
      expect((error as Error).message).not.toContain('secret');
      expect(String(error)).not.toContain('secret conversation');
      expect(JSON.stringify(error)).not.toContain('secret conversation');
      expect(Object.keys(error as object)).not.toContain('cause');
      expect((error as { readonly cause?: unknown }).cause).toBeUndefined();
    }

    await expect(service.complete(accepted)).resolves.toMatchObject({
      englishTranslation: 'Recovered English'
    });
    expect(provider.completeCalls).toBe(2);
    expect(service.evidence[0]).toMatchObject({
      failureCategory: 'provider-failure',
      providerFailureStage: 'unknown'
    });
  });

  it.each([0, 1, 4] as const)('rejects %d suggestions without partial output', async (count) => {
    const malformedSuggestions = count === 4
      ? [
        ...suggestions(3),
        { englishText: 'One more', selectedTargetText: 'Bir tane daha' }
      ]
      : suggestions(2).slice(0, count);
    const provider = new DeterministicMockProvider({
      complete: { result: completion('English', malformedSuggestions) }
    });
    const service = serviceWithValidator(provider);

    await expect(service.complete(turn())).rejects.toMatchObject({
      category: 'invalid-provider-result'
    });
    expect(provider.completeCalls).toBe(1);
  });

  it('rejects overlength translation and phrase fields', async () => {
    const longText = 'x'.repeat(1_025);
    const provider = new DeterministicMockProvider({
      complete: [
        { result: completion(longText) },
        { result: completion('English', [
          { englishText: longText, selectedTargetText: 'ok' },
          { englishText: 'ok', selectedTargetText: 'ok' }
        ]) }
      ]
    });
    const service = serviceWithValidator(provider);
    const accepted = turn();

    await expect(service.complete(accepted)).rejects.toMatchObject({
      category: 'invalid-provider-result'
    });
    await expect(service.complete(accepted)).rejects.toMatchObject({
      category: 'invalid-provider-result'
    });
    expect(provider.completeCalls).toBe(2);
  });

  it('accepts a translation at the 256-character boundary and rejects 257 characters', async () => {
    const provider = new DeterministicMockProvider({
      complete: [
        { result: completion('x'.repeat(256)) },
        { result: completion('x'.repeat(257)) }
      ]
    });
    const service = serviceWithValidator(provider);

    await expect(service.complete(turn())).resolves.toMatchObject({
      englishTranslation: 'x'.repeat(256)
    });
    await expect(service.complete(turn())).rejects.toMatchObject({
      category: 'invalid-provider-result'
    });
  });

  it.each(['englishText', 'selectedTargetText'] as const)(
    'accepts a suggestion %s at 160 characters and rejects 161 characters',
    async (field) => {
      const exactPair = {
        englishText: field === 'englishText' ? 'x'.repeat(160) : 'ok',
        selectedTargetText: field === 'selectedTargetText' ? 'x'.repeat(160) : 'ok'
      };
      const overlengthPair = {
        englishText: field === 'englishText' ? 'x'.repeat(161) : 'ok',
        selectedTargetText: field === 'selectedTargetText' ? 'x'.repeat(161) : 'ok'
      };
      const provider = new DeterministicMockProvider({
        complete: [
          { result: completion('English', [exactPair, suggestions(2)[1] as SuggestionPhrasePair]) },
          { result: completion('English', [overlengthPair, suggestions(2)[1] as SuggestionPhrasePair]) }
        ]
      });
      const service = serviceWithValidator(provider);

      const exactResult = await service.complete(turn());
      expect(exactResult.suggestions[0]?.[field]).toBe('x'.repeat(160));
      await expect(service.complete(turn())).rejects.toMatchObject({
        category: 'invalid-provider-result'
      });
    }
  );

  it('deduplicates concurrent calls per accepted turn and keeps turns independent', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion(), delayMs: 10 }
    });
    const service = serviceWithValidator(provider);
    const first = turn('es');
    const second = turn('tr', 2);

    const firstPromise = service.complete(first);
    const duplicatePromise = service.complete(first);
    expect(duplicatePromise).toBe(firstPromise);
    const results = await Promise.all([
      firstPromise,
      duplicatePromise,
      service.complete(second)
    ]);
    expect(provider.completeCalls).toBe(2);
    expect(results[0]).toBe(results[1]);
  });

  it('evicts completed promises while retaining concurrent in-flight deduplication', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion(), delayMs: 10 }
    });
    const service = serviceWithValidator(provider);
    const accepted = turn();

    await service.complete(accepted);
    await service.complete(accepted);
    expect(provider.completeCalls).toBe(2);

    const firstInFlight = service.complete(accepted);
    const concurrentInFlight = service.complete(accepted);
    expect(concurrentInFlight).toBe(firstInFlight);
    await Promise.all([firstInFlight, concurrentInFlight]);
    expect(provider.completeCalls).toBe(3);

    await service.complete(accepted);
    expect(provider.completeCalls).toBe(4);
  });

  it('keys completions by transcript, session epoch, and gate policy', async () => {
    const provider = new DeterministicMockProvider({
      complete: [
        { result: completion('English one') },
        { result: completion('English two') }
      ]
    });
    const service = serviceWithValidator(provider);
    const first = turn('es', 1, 'first transcript');
    const second = turn('es', 1, 'second transcript');

    const [firstResult, secondResult] = await Promise.all([
      service.complete(first),
      service.complete(second)
    ]);
    expect(provider.completeCalls).toBe(2);
    expect(firstResult.englishTranslation).toBe('English one');
    expect(secondResult.englishTranslation).toBe('English two');

    const differentEpoch = createAcceptedTargetTurn({ ...first, sessionEpoch: 2 });
    const differentGatePolicy = createAcceptedTargetTurn({ ...first, gatePolicyVersion: '2.0.0' });
    await Promise.all([
      service.complete(first),
      service.complete(differentEpoch),
      service.complete(differentGatePolicy)
    ]);
    expect(provider.completeCalls).toBe(5);
  });

  it('gives deduped callers independent cancellation while preserving the shared result', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion(), delayMs: 50 }
    });
    const service = serviceWithValidator(provider);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstPromise = service.complete(turn(), { signal: firstController.signal });
    const secondPromise = service.complete(turn(), { signal: secondController.signal });

    expect(secondPromise).not.toBe(firstPromise);
    await Promise.resolve();
    expect(provider.completeCalls).toBe(1);
    firstController.abort();
    await expect(firstPromise).rejects.toMatchObject({
      category: 'provider-failure',
      providerFailureStage: undefined
    });
    await expect(secondPromise).resolves.toMatchObject({
      englishTranslation: 'English'
    });
    expect(provider.signals[0]?.aborted).toBe(false);
    expect(service.evidence).toMatchObject([{ operation: 'complete', status: 'success' }]);
  });

  it('aborts the shared operation only after every signal-bearing caller aborts', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion(), delayMs: 50 }
    });
    const service = serviceWithValidator(provider);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstPromise = service.complete(turn(), { signal: firstController.signal });
    const secondPromise = service.complete(turn(), { signal: secondController.signal });

    firstController.abort();
    await expect(firstPromise).rejects.toMatchObject({ category: 'provider-failure' });
    expect(provider.signals[0]?.aborted).toBe(false);

    secondController.abort();
    await expect(secondPromise).rejects.toMatchObject({ category: 'provider-failure' });
    expect(provider.signals[0]?.aborted).toBe(true);
    expect(service.evidence).toMatchObject([{ operation: 'complete', status: 'cancelled' }]);
    expect(service.evidence[0]).not.toHaveProperty('providerFailureStage');
  });

  it('detaches an abandoned operation so a later caller can complete and late settlement is harmless', async () => {
    let firstResolve: ((value: GenerationProviderCompletion) => void) | undefined;
    let calls = 0;
    const provider: GenerationProvider = {
      id: 'noncooperative-provider',
      version: '1.0.0',
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<GenerationProviderCompletion>((resolve) => {
            firstResolve = resolve;
          });
        }
        return completion('Fresh English');
      }
    };
    const service = serviceWithValidator(provider);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = service.complete(turn(), { signal: firstController.signal });
    const second = service.complete(turn(), { signal: secondController.signal });
    await vi.waitFor(() => expect(calls).toBe(1));

    firstController.abort();
    secondController.abort();
    await Promise.all([
      expect(first).rejects.toMatchObject({ category: 'provider-failure' }),
      expect(second).rejects.toMatchObject({ category: 'provider-failure' })
    ]);

    await expect(service.complete(turn())).resolves.toMatchObject({
      englishTranslation: 'Fresh English'
    });
    expect(calls).toBe(2);

    firstResolve?.(completion('Stale English'));
    await vi.waitFor(() => expect(service.evidence).toHaveLength(2));
    expect(service.evidence.map((item) => item.status)).toEqual(['success', 'cancelled']);
  });

  it('does not wedge the deduplication map when signal is an accessor', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion() }
    });
    const service = serviceWithValidator(provider);
    let reads = 0;
    const hostileOptions = {};
    Object.defineProperty(hostileOptions, 'signal', {
      get: () => {
        reads += 1;
        return reads === 1 ? new AbortController().signal : {};
      }
    });

    expect(() => service.complete(turn(), hostileOptions as never)).toThrow(
      expect.objectContaining({ category: 'forged-value' })
    );
    expect(reads).toBe(0);
    await expect(service.complete(turn())).resolves.toMatchObject({
      englishTranslation: 'English'
    });
    expect(provider.completeCalls).toBe(1);
  });

  it('settles the deduplication entry when listener attachment throws', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion() }
    });
    const service = serviceWithValidator(provider);
    const signal = new AbortController().signal;
    Object.defineProperty(signal, 'addEventListener', {
      value: () => {
        throw new Error('listener attachment failed');
      }
    });

    expect(() => service.complete(turn(), { signal })).toThrow('listener attachment failed');
    await expect(service.complete(turn())).resolves.toMatchObject({
      englishTranslation: 'English'
    });
    expect(provider.completeCalls).toBe(1);
  });

  it('deduplicates a repeated signal listener, cleans it up, and aborts once', async () => {
    let providerSignal: AbortSignal | undefined;
    let providerAbortCount = 0;
    const provider: GenerationProvider = {
      id: 'listener-provider',
      version: '1.0.0',
      complete: async (_input, context) => new Promise<GenerationProviderCompletion>((_resolve, reject) => {
        providerSignal = context.signal;
        context.signal.addEventListener('abort', () => {
          providerAbortCount += 1;
          reject(new Error('aborted'));
        }, { once: true });
      })
    };
    const service = serviceWithValidator(provider);
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

    const first = service.complete(turn(), { signal: controller.signal });
    const duplicate = service.complete(turn(), { signal: controller.signal });
    expect(duplicate).toBe(first);
    expect(addListener).toHaveBeenCalledTimes(1);

    controller.abort();
    await expect(first).rejects.toMatchObject({ category: 'provider-failure' });
    expect(providerSignal?.aborted).toBe(true);
    expect(providerAbortCount).toBe(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('makes zero provider calls for a pre-aborted caller', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion() }
    });
    const service = serviceWithValidator(provider);
    const controller = new AbortController();
    controller.abort();

    await expect(service.complete(turn(), { signal: controller.signal })).rejects.toMatchObject({
      category: 'provider-failure',
      providerFailureStage: undefined
    });
    expect(provider.completeCalls).toBe(0);
    expect(service.evidence).toMatchObject([{ operation: 'complete', status: 'cancelled' }]);
  });
});

describe('deterministic mock provider input validation', () => {
  it('rejects invalid completion inputs before recording them', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion() }
    });
    const valid = validCompletionInput();
    const missingSessionId = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== 'sessionId')
    );
    const invalidInputs: readonly Record<string, unknown>[] = [
      { ...valid, sessionId: 'not-a-v4-uuid' },
      { ...valid, utteranceId: 'not-a-v4-uuid' },
      { ...valid, sessionEpoch: 0 },
      { ...valid, segmentId: '' },
      { ...valid, acceptedFinalRevision: 0 },
      { ...valid, selectedTargetLanguage: 'fr' },
      { ...valid, targetTranscript: '' },
      { ...valid, gatePolicyVersion: '1.0' },
      missingSessionId
    ];

    for (const input of invalidInputs) {
      await expect(provider.complete(input as never, { signal: new AbortController().signal })).rejects.toMatchObject({
        name: 'TypeError',
        message: 'Invalid deterministic generation provider input'
      });
    }
    expect(provider.callCounts).toEqual({ complete: 0 });
    expect(provider.completeInputs).toEqual([]);

    await provider.complete(valid, { signal: new AbortController().signal });
    expect(provider.completeCalls).toBe(1);
    expect(provider.completeInputs).toEqual([valid]);
  });
});

describe('mandatory generated-language validation', () => {
  it('accepts exact provisional evidence only in the trusted development mode', async () => {
    const validator = languageValidator(async (input) =>
      validProvisionalLanguageEvidence(input)
    );
    const service = new GenerationService({
      provider: new DeterministicMockProvider({ complete: { result: completion() } }),
      validator,
      languageValidationMode: 'development-provisional'
    });
    await expect(service.complete(turn())).resolves.toBeDefined();
    expect(service.languageValidationMode).toBe('development-provisional');
    expect(service.usesValidator(validator)).toBe(true);
    expect(service.usesValidator({
      id: validator.id,
      version: validator.version,
      validate: validator.validate
    })).toBe(false);
  });

  it('does not accept provisional evidence in the default calibrated mode', async () => {
    const validator = languageValidator(async (input) =>
      validProvisionalLanguageEvidence(input)
    );
    const service = new GenerationService(
      new DeterministicMockProvider({ complete: { result: completion() } }),
      validator
    );
    await expect(service.complete(turn())).rejects.toMatchObject({
      category: 'invalid-generated-language'
    });
  });

  it('does not accept calibrated evidence in development-provisional mode', async () => {
    const validator = languageValidator(async (input) => validLanguageEvidence(input));
    const service = new GenerationService({
      provider: new DeterministicMockProvider({ complete: { result: completion() } }),
      validator,
      languageValidationMode: 'development-provisional'
    });
    await expect(service.complete(turn())).rejects.toMatchObject({
      category: 'invalid-generated-language'
    });
  });

  it('requires a non-null provisional score on every development check', async () => {
    const validator = languageValidator(async (input) => {
      const evidence = validProvisionalLanguageEvidence(input);
      const checks = [...evidence.checks];
      checks[0] = {
        ...checks[0] as GeneratedLanguageValidationEvidence['checks'][number],
        provisionalScoreBasisPoints: null
      };
      return { checks } as unknown as GeneratedLanguageValidationEvidence;
    });
    const service = new GenerationService({
      provider: new DeterministicMockProvider({ complete: { result: completion() } }),
      validator,
      languageValidationMode: 'development-provisional'
    });
    await expect(service.complete(turn())).rejects.toMatchObject({
      category: 'invalid-generated-language'
    });
  });
  it('requires a valid validator and never falls back to permissive validation', () => {
    const provider = new DeterministicMockProvider({ complete: { result: completion() } });

    expect(() => new GenerationService(provider, undefined as never)).toThrowError(
      expect.objectContaining({ category: 'invalid-validator' })
    );
    expect(() => new GenerationService({ provider } as never)).toThrowError(
      expect.objectContaining({ category: 'invalid-validator' })
    );

    const hostile = Object.create(null) as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperties(hostile, {
      id: {
        get: () => {
          getterCalls += 1;
          throw new Error('validator canary must not leak');
        }
      },
      version: { value: '1.0.0' },
      validate: { value: async () => ({ checks: [] }) }
    });
    let error: unknown;
    try {
      new GenerationService(provider, hostile as unknown as GeneratedLanguageValidator);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ category: 'invalid-validator' });
    expect(getterCalls).toBe(0);
    expect(String(error) + JSON.stringify(error)).not.toContain('canary');
  });

  it('normalizes a revoked validator proxy as content-free invalid-validator', () => {
    const provider = new DeterministicMockProvider({ complete: { result: completion() } });
    const revoked = Proxy.revocable(languageValidator(async (input) =>
      validLanguageEvidence(input)), {});
    revoked.revoke();

    let error: unknown;
    try {
      new GenerationService(provider, revoked.proxy);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      category: 'invalid-validator',
      message: 'Invalid generated-language validator.'
    });
    expect((error as { readonly cause?: unknown }).cause).toBeUndefined();
    expect(String(error) + JSON.stringify(error)).not.toContain('revoked');
  });

  it.each(['validator', 'languageValidationTimeoutMs'] as const)(
    'rejects a throwing options %s accessor without invoking it',
    (field) => {
      const canary = `throwing-options-${field}-canary`;
      let getterCalls = 0;
      const options = {
        provider: new DeterministicMockProvider({ complete: { result: completion() } }),
        validator: new DeterministicFixtureLanguageValidator()
      } as Record<string, unknown>;
      Object.defineProperty(options, field, {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          throw new Error(canary);
        }
      });

      let error: unknown;
      try {
        new GenerationService(options as never);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ category: 'invalid-validator' });
      expect(getterCalls).toBe(0);
      expect((error as { readonly cause?: unknown }).cause).toBeUndefined();
      expect(String(error) + JSON.stringify(error)).not.toContain(canary);
    }
  );

  it('normalizes revoked options and timeout values as invalid-validator', () => {
    const revokedOptions = Proxy.revocable({}, {});
    revokedOptions.revoke();
    expect(() => new GenerationService(revokedOptions.proxy as never)).toThrowError(
      expect.objectContaining({ category: 'invalid-validator' })
    );

    const revokedTimeout = Proxy.revocable({}, {});
    revokedTimeout.revoke();
    let error: unknown;
    try {
      new GenerationService({
        provider: new DeterministicMockProvider({ complete: { result: completion() } }),
        validator: new DeterministicFixtureLanguageValidator(),
        languageValidationTimeoutMs: revokedTimeout.proxy as never
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ category: 'invalid-validator' });
    expect(String(error) + JSON.stringify(error)).not.toContain('revoked');
  });

  it.each([0, 10_001, 1.5, Number.NaN])(
    'rejects invalid validator timeout %s',
    (languageValidationTimeoutMs) => {
      const provider = new DeterministicMockProvider({ complete: { result: completion() } });
      expect(() => new GenerationService({
        provider,
        validator: new DeterministicFixtureLanguageValidator(),
        languageValidationTimeoutMs
      })).toThrowError(expect.objectContaining({ category: 'invalid-validator' }));
    }
  );

  it.each([1, 10_000])('accepts timeout boundary %d', (languageValidationTimeoutMs) => {
    expect(() => new GenerationService({
      provider: new DeterministicMockProvider({ complete: { result: completion() } }),
      validator: new DeterministicFixtureLanguageValidator(),
      languageValidationTimeoutMs
    })).not.toThrow();
  });

  it.each([
    [2, 'es', 5],
    [3, 'tr', 7]
  ] as const)(
    'supplies canonical frozen checks for %d suggestions in %s',
    async (count, target, expectedCount) => {
      const provider = new DeterministicMockProvider({
        complete: { result: completion('Canonical English', suggestions(count)) }
      });
      let inspected = false;
      const validator = languageValidator(async (input) => {
        expect(input.checks.map(({ slot, text, expectedLanguage }) => ({
          slot,
          text,
          expectedLanguage
        }))).toEqual([
          { slot: 'translation.english', text: 'Canonical English', expectedLanguage: 'en' },
          {
            slot: 'suggestion[0].english',
            text: 'Where is the station?',
            expectedLanguage: 'en'
          },
          {
            slot: 'suggestion[0].target',
            text: '¿Dónde está la estación?',
            expectedLanguage: target
          },
          {
            slot: 'suggestion[1].english',
            text: 'Can you show me the way?',
            expectedLanguage: 'en'
          },
          {
            slot: 'suggestion[1].target',
            text: '¿Puedes mostrarme el camino?',
            expectedLanguage: target
          },
          ...(count === 3 ? [
            { slot: 'suggestion[2].english', text: 'Thank you.', expectedLanguage: 'en' },
            { slot: 'suggestion[2].target', text: 'Gracias.', expectedLanguage: target }
          ] : [])
        ]);
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.checks)).toBe(true);
        expect(input.checks.every(Object.isFrozen)).toBe(true);
        inspected = true;
        return validLanguageEvidence(input);
      }, 'canonical-test-validator');
      const service = new GenerationService(provider, validator);

      await service.complete(turn(target));

      expect(inspected).toBe(true);
      expect(service.evidence[0]).toMatchObject({
        validatorId: 'canonical-test-validator',
        validatorVersion: '1.0.0',
        languageValidationStatus: 'accepted',
        languageValidationCheckCount: expectedCount,
        languageValidationNonmatchCount: 0
      });
    }
  );

  it('exposes an unforgeable local-fixture validator brand without retaining inputs', async () => {
    const fixture = new DeterministicFixtureLanguageValidator();
    const lookalike = {
      id: fixture.id,
      version: fixture.version,
      validate: fixture.validate.bind(fixture)
    };

    expect(isDeterministicFixtureLanguageValidator(fixture)).toBe(true);
    expect(isDeterministicFixtureLanguageValidator(lookalike)).toBe(false);
    expect(isDeterministicFixtureLanguageValidator(null)).toBe(false);
    expect(Object.keys(fixture)).not.toContain('inputs');
    expect('inputs' in fixture).toBe(false);

    const service = new GenerationService(
      new DeterministicMockProvider({ complete: { result: completion() } }),
      fixture
    );
    await service.complete(turn());
    expect(Object.keys(fixture)).not.toContain('inputs');
    expect('inputs' in fixture).toBe(false);
  });

  it('runs structural validation before the validator', async () => {
    const validate = vi.fn(async (input: GeneratedLanguageValidationInput) =>
      validLanguageEvidence(input));
    const provider = new DeterministicMockProvider({
      complete: { result: completion('English', suggestions(2).slice(0, 1)) }
    });
    const service = new GenerationService(provider, languageValidator(validate));

    await expect(service.complete(turn())).rejects.toMatchObject({
      category: 'invalid-provider-result'
    });
    expect(validate).not.toHaveBeenCalled();
    expect(service.evidence[0]).toMatchObject({ languageValidationCheckCount: 0 });
  });

  it('does not construct a completion until validation succeeds', async () => {
    let release: ((value: GeneratedLanguageValidationEvidence) => void) | undefined;
    let capturedInput: GeneratedLanguageValidationInput | undefined;
    const validator = languageValidator(async (input) => new Promise((resolve) => {
      capturedInput = input;
      release = resolve;
    }));
    const service = new GenerationService(
      new DeterministicMockProvider({ complete: { result: completion('Validated English') } }),
      validator
    );
    let settled = false;
    const operation = service.complete(turn()).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(capturedInput).toBeDefined());

    expect(settled).toBe(false);
    expect(service.evidence).toEqual([]);
    release?.(validLanguageEvidence(capturedInput as GeneratedLanguageValidationInput));
    await expect(operation).resolves.toMatchObject({ englishTranslation: 'Validated English' });
  });

  it('rejects a definite wrong-language verdict without exposing generated text', async () => {
    const canary = 'wrong-language-generated-canary';
    const validator = languageValidator(async (input) => validLanguageEvidence(input, 2));
    const service = new GenerationService(
      new DeterministicMockProvider({ complete: { result: completion(canary) } }),
      validator
    );

    let error: unknown;
    try {
      await service.complete(turn());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      category: 'invalid-generated-language',
      message: 'Generated text failed language validation.'
    });
    expect(String(error) + JSON.stringify(error)).not.toContain(canary);
    expect(service.evidence[0]).toMatchObject({
      status: 'failure',
      failureCategory: 'invalid-generated-language',
      languageValidationStatus: 'rejected',
      languageValidationCheckCount: 5,
      languageValidationNonmatchCount: 1
    });
  });

  it.each([
    ['mismatch verdict', { verdict: 'mismatch' }],
    ['indeterminate verdict', { verdict: 'indeterminate' }],
    ['different detected language', { detectedLanguage: 'other' }],
    ['undetermined detected language', { detectedLanguage: 'undetermined' }],
    ['null confidence', { confidenceBasisPoints: null }]
  ] as const)('rejects match-incomplete evidence with %s', async (_name, override) => {
    const validator = languageValidator(async (input) => {
      const evidence = validLanguageEvidence(input);
      const checks = [...evidence.checks];
      checks[0] = { ...checks[0] as GeneratedLanguageValidationEvidence['checks'][number], ...override };
      return { checks } as unknown as GeneratedLanguageValidationEvidence;
    });
    const service = new GenerationService(
      new DeterministicMockProvider({ complete: { result: completion() } }),
      validator
    );

    await expect(service.complete(turn())).rejects.toMatchObject({
      category: 'invalid-generated-language'
    });
    expect(service.evidence[0]).toMatchObject({
      languageValidationStatus: 'rejected',
      languageValidationNonmatchCount: 1
    });
  });

  it('accepts exact confidence boundaries including zero', async () => {
    const validator = languageValidator(async (input) => {
      const evidence = validLanguageEvidence(input);
      return {
        checks: evidence.checks.map((item, index) => ({
          ...item,
          confidenceBasisPoints: index === 0 ? 0 : 10_000
        }))
      } as unknown as GeneratedLanguageValidationEvidence;
    });
    const service = new GenerationService(
      new DeterministicMockProvider({ complete: { result: completion() } }),
      validator
    );

    await expect(service.complete(turn())).resolves.toBeDefined();
  });

  it.each([-1, 10_001, 1.5])(
    'rejects malformed confidence evidence %s',
    async (confidenceBasisPoints) => {
      const validator = languageValidator(async (input) => {
        const evidence = validLanguageEvidence(input);
        const checks = [...evidence.checks];
        checks[0] = {
          ...checks[0] as GeneratedLanguageValidationEvidence['checks'][number],
          confidenceBasisPoints
        };
        return { checks } as unknown as GeneratedLanguageValidationEvidence;
      });
      const service = new GenerationService(
        new DeterministicMockProvider({ complete: { result: completion() } }),
        validator
      );

      await expect(service.complete(turn())).rejects.toMatchObject({
        category: 'language-validation-failure'
      });
    }
  );

  it.each(['extra-key', 'reordered', 'short'] as const)(
    'rejects %s validator evidence as a validation failure',
    async (kind) => {
      const validator = languageValidator(async (input) => {
        const valid = validLanguageEvidence(input);
        if (kind === 'extra-key') {
          return { ...valid, content: 'evidence canary' } as unknown as GeneratedLanguageValidationEvidence;
        }
        const checks = [...valid.checks];
        if (kind === 'reordered') {
          [checks[0], checks[1]] = [checks[1] as typeof checks[number], checks[0] as typeof checks[number]];
        } else {
          checks.pop();
        }
        return { checks } as unknown as GeneratedLanguageValidationEvidence;
      });
      const service = new GenerationService(
        new DeterministicMockProvider({ complete: { result: completion() } }),
        validator
      );

      await expect(service.complete(turn())).rejects.toMatchObject({
        category: 'language-validation-failure',
        message: 'Generated-language validation failed.'
      });
    }
  );

  it('normalizes a revoked checks proxy and records valid failed metadata', async () => {
    const validator = languageValidator(async (input) => {
      const revoked = Proxy.revocable(validLanguageEvidence(input).checks, {});
      revoked.revoke();
      return { checks: revoked.proxy } as GeneratedLanguageValidationEvidence;
    });
    const service = new GenerationService(
      new DeterministicMockProvider({ complete: { result: completion() } }),
      validator
    );

    let error: unknown;
    try {
      await service.complete(turn());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      category: 'language-validation-failure',
      message: 'Generated-language validation failed.'
    });
    expect((error as { readonly cause?: unknown }).cause).toBeUndefined();
    expect(String(error) + JSON.stringify(error)).not.toContain('revoked');
    expect(service.evidence).toMatchObject([{
      status: 'failure',
      failureCategory: 'language-validation-failure',
      languageValidationStatus: 'failed',
      languageValidationCheckCount: 5,
      languageValidationNonmatchCount: 0
    }]);
    expect(() => createGenerationEvidenceRecord(service.evidence[0])).not.toThrow();
  });

  it('normalizes validator exceptions and canary-bearing hostile evidence', async () => {
    const canary = 'validator-exception-canary';
    const throwing = new GenerationService(
      new DeterministicMockProvider({ complete: { result: completion() } }),
      languageValidator(async () => {
        throw new Error(canary);
      })
    );
    let throwingError: unknown;
    try {
      await throwing.complete(turn());
    } catch (caught) {
      throwingError = caught;
    }
    expect(throwingError).toMatchObject({ category: 'language-validation-failure' });
    expect(String(throwingError) + JSON.stringify(throwingError)).not.toContain(canary);

    const hostileChecks = new Proxy([], {
      ownKeys: () => {
        throw new Error(canary);
      }
    });
    const hostile = new GenerationService(
      new DeterministicMockProvider({ complete: { result: completion() } }),
      languageValidator(async () => ({ checks: hostileChecks } as unknown as GeneratedLanguageValidationEvidence))
    );
    let hostileError: unknown;
    try {
      await hostile.complete(turn());
    } catch (caught) {
      hostileError = caught;
    }
    expect(hostileError).toMatchObject({ category: 'language-validation-failure' });
    expect(String(hostileError) + JSON.stringify(hostileError)).not.toContain(canary);
  });

  it('uses the 3000ms default and aborts a noncooperative validator on timeout', async () => {
    vi.useFakeTimers();
    try {
      let validatorSignal: AbortSignal | undefined;
      const validator = languageValidator(async (_input, context) => {
        validatorSignal = context.signal;
        return new Promise<GeneratedLanguageValidationEvidence>(() => undefined);
      });
      const service = new GenerationService({
        provider: new DeterministicMockProvider({ complete: { result: completion() } }),
        validator
      });
      const operation = service.complete(turn());
      await vi.advanceTimersByTimeAsync(2_999);
      let settled = false;
      void operation.finally(() => {
        settled = true;
      }).catch(() => undefined);
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(operation).rejects.toMatchObject({ category: 'language-validation-failure' });
      expect(validatorSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps timeout classification when child abort synchronously aborts the caller', async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      let childSignal: AbortSignal | undefined;
      const validator = languageValidator(async (_input, context) => {
        childSignal = context.signal;
        context.signal.addEventListener('abort', () => caller.abort(), { once: true });
        return new Promise<GeneratedLanguageValidationEvidence>(() => undefined);
      });
      const service = new GenerationService({
        provider: new DeterministicMockProvider({ complete: { result: completion() } }),
        validator,
        languageValidationTimeoutMs: 1
      });
      const operation = service.complete(turn(), { signal: caller.signal });

      await vi.advanceTimersByTimeAsync(1);

      await expect(operation).rejects.toMatchObject({
        category: 'language-validation-failure',
        message: 'Generated-language validation failed.'
      });
      expect(childSignal?.aborted).toBe(true);
      expect(caller.signal.aborted).toBe(true);
      expect(service.evidence).toMatchObject([{
        status: 'failure',
        failureCategory: 'language-validation-failure',
        languageValidationStatus: 'failed',
        languageValidationCheckCount: 5,
        languageValidationNonmatchCount: 0
      }]);
      expect(() => createGenerationEvidenceRecord(service.evidence[0])).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles cancellation while a validator ignores its abort signal', async () => {
    let validatorSignal: AbortSignal | undefined;
    const validator = languageValidator(async (_input, context) => {
      validatorSignal = context.signal;
      return new Promise<GeneratedLanguageValidationEvidence>(() => undefined);
    });
    const service = new GenerationService(
      new DeterministicMockProvider({ complete: { result: completion() } }),
      validator
    );
    const controller = new AbortController();
    const operation = service.complete(turn(), { signal: controller.signal });
    await vi.waitFor(() => expect(validatorSignal).toBeDefined());

    controller.abort();
    await expect(operation).rejects.toMatchObject({ category: 'provider-failure' });
    expect(validatorSignal?.aborted).toBe(true);
    expect(service.evidence).toMatchObject([{
      status: 'cancelled',
      languageValidationStatus: 'cancelled',
      languageValidationCheckCount: 5,
      languageValidationNonmatchCount: 0
    }]);
    expect(() => createGenerationEvidenceRecord(service.evidence[0])).not.toThrow();
  });

  it('ignores a late timed-out verdict and lets a retry complete independently', async () => {
    vi.useFakeTimers();
    try {
      let firstInput: GeneratedLanguageValidationInput | undefined;
      let resolveFirst: ((value: GeneratedLanguageValidationEvidence) => void) | undefined;
      let calls = 0;
      const validator = languageValidator(async (input) => {
        calls += 1;
        if (calls === 1) {
          firstInput = input;
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return validLanguageEvidence(input);
      });
      const service = new GenerationService({
        provider: new DeterministicMockProvider({ complete: { result: completion('Retry English') } }),
        validator,
        languageValidationTimeoutMs: 1
      });

      const first = service.complete(turn());
      await vi.advanceTimersByTimeAsync(1);
      await expect(first).rejects.toMatchObject({ category: 'language-validation-failure' });
      await expect(service.complete(turn())).resolves.toMatchObject({
        englishTranslation: 'Retry English'
      });
      resolveFirst?.(validLanguageEvidence(firstInput as GeneratedLanguageValidationInput));
      await Promise.resolve();

      expect(calls).toBe(2);
      expect(service.evidence).toHaveLength(2);
      expect(service.evidence.map((item) => item.status)).toEqual(['failure', 'success']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('provider snapshots and hostile values', () => {
  it('rejects provider identity accessors without exposing their messages', () => {
    const provider = Object.create(null) as Record<string, unknown>;
    let identityGetterCalls = 0;
    Object.defineProperties(provider, {
      id: {
        get: () => {
          identityGetterCalls += 1;
          throw new Error('conversation identity secret');
        }
      },
      version: { value: '1.0.0' },
      complete: { value: async () => completion() }
    });

    let captured: unknown;
    try {
      serviceWithValidator(provider as unknown as GenerationProvider);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(GenerationError);
    expect((captured as GenerationError).category).toBe('invalid-provider');
    expect(identityGetterCalls).toBe(0);
    expect(JSON.stringify(captured)).not.toContain('conversation identity secret');
  });

  it('copies provider identity once for getters, evidence, and calls', async () => {
    const provider = new DeterministicMockProvider({ complete: { result: completion('English') } });
    const service = serviceWithValidator(provider);
    (provider as { id: string }).id = 'changed-provider';
    (provider as { version: string }).version = '2.0.0';

    expect(service.provider).toEqual({ id: 'deterministic-mock', version: '1.0.0' });
    await service.complete(turn());
    expect(service.evidence[0]).toMatchObject({
      providerId: 'deterministic-mock',
      providerVersion: '1.0.0'
    });
  });

  it('redacts accessor and throwing-proxy provider results as typed errors', async () => {
    let translationGetterCalls = 0;
    const accessorResult = Object.defineProperties({}, {
      englishTranslation: {
        enumerable: true,
        get: () => {
          translationGetterCalls += 1;
          throw new Error('raw conversation from translation');
        }
      },
      suggestions: { enumerable: true, value: suggestions(2) }
    });
    const proxyResult = new Proxy(
      { englishTranslation: 'raw conversation from proxy', suggestions: suggestions(2) },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('raw conversation from proxy trap');
        }
      }
    );
    const completionResults: unknown[] = [accessorResult, proxyResult];
    const provider: GenerationProvider = {
      id: 'hostile-result-provider',
      version: '1.0.0',
      complete: async () => completionResults.shift() as GenerationProviderCompletion
    };
    const service = serviceWithValidator(provider);
    const errors: unknown[] = [];
    for (let index = 0; index < 2; index += 1) {
      try {
        await service.complete(turn());
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error instanceof GenerationError)).toBe(true);
    expect(errors.every((error) => (error as GenerationError).category === 'invalid-provider-result'))
      .toBe(true);
    expect(translationGetterCalls).toBe(0);
    expect(errors.map((error) => JSON.stringify(error)).join()).not.toContain('raw conversation');
  });

  it('rejects accessor and throwing-proxy suggestion pairs as typed errors', async () => {
    const accessorPair = {};
    let suggestionGetterCalls = 0;
    Object.defineProperty(accessorPair, 'englishText', {
      enumerable: true,
      get: () => {
        suggestionGetterCalls += 1;
        throw new Error('raw conversation from suggestion');
      }
    });
    Object.defineProperty(accessorPair, 'selectedTargetText', {
      enumerable: true,
      value: 'target'
    });
    const proxyPair = new Proxy(
      { englishText: 'raw conversation from pair proxy', selectedTargetText: 'target' },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('raw conversation from pair proxy trap');
        }
      }
    );
    const pairResults: unknown[] = [
      [accessorPair, suggestions(2)[1]],
      [proxyPair, suggestions(2)[1]]
    ];
    const provider: GenerationProvider = {
      id: 'hostile-suggestion-provider',
      version: '1.0.0',
      complete: async () => ({
        englishTranslation: 'English',
        suggestions: pairResults.shift() as GenerationProviderCompletion['suggestions']
      })
    };
    const service = serviceWithValidator(provider);
    const errors: unknown[] = [];
    for (let index = 0; index < 2; index += 1) {
      try {
        await service.complete(turn());
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error instanceof GenerationError)).toBe(true);
    expect(errors.every((error) => (error as GenerationError).category === 'invalid-provider-result'))
      .toBe(true);
    expect(suggestionGetterCalls).toBe(0);
    expect(errors.map((error) => JSON.stringify(error)).join()).not.toContain('raw conversation');
  });
});

describe('metadata-only evidence', () => {
  it.each([
    ['success', {}],
    ['failure', { failureCategory: 'provider-failure', providerFailureStage: 'http' }],
    ['cancelled', {}]
  ] as const)('validates and records complete %s evidence as metadata only', (status, extra) => {
    const collector = new MetadataOnlyEvidenceCollector();
    const record = collector.add({
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'es',
      gatePolicyVersion: '1.0.0',
      operation: 'complete',
      status,
      ...extra,
      providerId: 'test-provider',
      providerVersion: '1.0.0',
      validatorId: 'test-validator',
      validatorVersion: '1.0.0',
      languageValidationStatus: status === 'success' ? 'accepted' : 'not-run',
      languageValidationCheckCount: status === 'success' ? 5 : 0,
      languageValidationNonmatchCount: 0,
      startMonotonicMs: 10,
      endMonotonicMs: 20,
      latencyMs: 10
    });

    expect(collector.records).toEqual([record]);
    expect(Object.isFrozen(record)).toBe(true);
    expect(JSON.stringify(record)).not.toContain('transcript');
    expect(Object.keys(record)).not.toContain('sourceText');
  });

  it.each(PROVIDER_FAILURE_STAGES)('accepts only the fixed provider stage %s in provider-failure evidence', (stage) => {
    const record = createGenerationEvidenceRecord({
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'es',
      gatePolicyVersion: '1.0.0',
      operation: 'complete',
      status: 'failure',
      failureCategory: 'provider-failure',
      providerFailureStage: stage,
      providerId: 'test-provider',
      providerVersion: '1.0.0',
      validatorId: 'test-validator',
      validatorVersion: '1.0.0',
      languageValidationStatus: 'not-run',
      languageValidationCheckCount: 0,
      languageValidationNonmatchCount: 0,
      startMonotonicMs: 10,
      endMonotonicMs: 20,
      latencyMs: 10
    });

    expect(record.providerFailureStage).toBe(stage);
  });

  it('stores immutable metadata and no conversation content', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion('English suggestion text', suggestions(2)) }
    });
    const service = serviceWithValidator(provider);
    const accepted = turn('tr');
    await service.complete(accepted);

    expect(service.evidence).toHaveLength(1);
    expect(service.evidence.every((record) => Object.isFrozen(record))).toBe(true);
    expect(service.evidence[0]).toMatchObject({
      operation: 'complete',
      status: 'success',
      selectedTargetLanguage: 'tr',
      providerId: 'deterministic-mock'
    });
    const serialized = JSON.stringify(service.evidence);
    expect(serialized).not.toContain(accepted.targetTranscript);
    expect(serialized).not.toContain('English suggestion text');
    expect(serialized).not.toContain('suggestions');
  });

  it('uses one validated configured collector without duplicate storage', async () => {
    const collector = new MetadataOnlyEvidenceCollector();
    const service = serviceWithValidator(
      new DeterministicMockProvider({ complete: { result: completion('English') } }),
      collector
    );

    await service.complete(turn());

    expect(collector.records).toHaveLength(1);
    expect(service.evidence).toEqual(collector.records);
  });

  it('does not allow forbidden evidence keys', () => {
    const collector = new MetadataOnlyEvidenceCollector();
    expect(() => collector.add({
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'es',
      gatePolicyVersion: '1.0.0',
      operation: 'complete',
      status: 'success',
      providerId: 'test-provider',
      providerVersion: '1.0.0',
      validatorId: 'test-validator',
      validatorVersion: '1.0.0',
      languageValidationStatus: 'accepted',
      languageValidationCheckCount: 5,
      languageValidationNonmatchCount: 0,
      startMonotonicMs: 10,
      endMonotonicMs: 20,
      latencyMs: 10,
      sourceText: 'must not be retained'
    } as never)).toThrow(GenerationError);
  });

  it('keeps collector failures from replacing success and typed provider failure', async () => {
    const throwingCollector = {
      records: [],
      add: (): never => {
        throw new Error('evidence collector secret');
      }
    };
    const successService = serviceWithValidator(
      new DeterministicMockProvider({ complete: { result: completion('Recovered') } }),
      throwingCollector
    );
    await expect(successService.complete(turn())).resolves.toMatchObject({
      englishTranslation: 'Recovered'
    });

    const failureService = new GenerationService({
      provider: {
        id: 'throwing-provider',
        version: '1.0.0',
        complete: async () => {
          throw new Error('provider secret');
        }
      },
      validator: new DeterministicFixtureLanguageValidator(),
      evidenceCollector: throwingCollector
    });
    await expect(failureService.complete(turn())).rejects.toMatchObject({
      category: 'provider-failure',
      message: 'Generation provider failed.'
    });
  });

  it('keeps collector failures from replacing cancellation', async () => {
    const throwingCollector = {
      records: [],
      add: (): never => {
        throw new Error('evidence collector secret');
      }
    };
    const provider: GenerationProvider = {
      id: 'cancellation-provider',
      version: '1.0.0',
      complete: async (_input, context) => new Promise<GenerationProviderCompletion>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })
    };
    const service = new GenerationService({
      provider,
      validator: new DeterministicFixtureLanguageValidator(),
      evidenceCollector: throwingCollector
    });
    const controller = new AbortController();
    const operation = service.complete(turn(), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(operation).rejects.toMatchObject({ category: 'provider-failure' });
  });

  it('rejects invented failure categories and invalid latency', () => {
    const record = {
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'es',
      gatePolicyVersion: '1.0.0',
      operation: 'complete',
      status: 'failure',
      failureCategory: 'invented-category',
      providerId: 'test-provider',
      providerVersion: '1.0.0',
      validatorId: 'test-validator',
      validatorVersion: '1.0.0',
      languageValidationStatus: 'not-run',
      languageValidationCheckCount: 0,
      languageValidationNonmatchCount: 0,
      startMonotonicMs: 10,
      endMonotonicMs: 20,
      latencyMs: 10
    };
    expect(() => createGenerationEvidenceRecord(record as never)).toThrow(GenerationError);
    expect(() => createGenerationEvidenceRecord({
      ...record,
      failureCategory: 'provider-failure',
      latencyMs: 11
    } as never)).toThrow(GenerationError);
    expect(() => createGenerationEvidenceRecord({
      ...record,
      failureCategory: 'invalid-provider-result',
      providerFailureStage: 'http'
    } as never)).toThrow(GenerationError);
    expect(() => createGenerationEvidenceRecord({
      ...record,
      status: 'success',
      failureCategory: undefined,
      providerFailureStage: 'http',
      languageValidationStatus: 'accepted',
      languageValidationCheckCount: 5
    } as never)).toThrow(GenerationError);
    expect(() => createGenerationEvidenceRecord({
      ...record,
      status: 'cancelled',
      failureCategory: undefined,
      providerFailureStage: 'http'
    } as never)).toThrow(GenerationError);
    expect(() => createGenerationEvidenceRecord({
      ...record,
      failureCategory: 'provider-failure',
      providerFailureStage: 'not-a-stage'
    } as never)).toThrow(GenerationError);
    expect(() => createGenerationEvidenceRecord({
      ...record,
      failureCategory: 'provider-failure',
      providerFailureStage: undefined
    } as never)).toThrow(GenerationError);
    expect(() => createGenerationEvidenceRecord({
      ...record,
      status: 'success',
      failureCategory: undefined,
      providerFailureStage: undefined,
      languageValidationStatus: 'accepted',
      languageValidationCheckCount: 5
    } as never)).toThrow(GenerationError);
  });

});

describe('provider-neutral contract', () => {
  it('accepts a provider implementing only the provider interface', async () => {
    const complete = vi.fn(
      async (
        input: GenerationProviderCompletionInput,
        context: { readonly signal: AbortSignal }
      ): Promise<GenerationProviderCompletion> => {
        void input;
        expect(context.signal).toBeInstanceOf(AbortSignal);
        return completion('English');
      }
    );
    const provider: GenerationProvider = {
      id: 'test-provider',
      version: '1.0.0',
      complete
    };
    const service = serviceWithValidator(provider);
    await service.complete(turn());

    expect(complete).toHaveBeenCalledTimes(1);
  });
});
