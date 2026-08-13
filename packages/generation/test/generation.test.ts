import { describe, expect, it, vi } from 'vitest';

import {
  DeterministicMockProvider,
  GenerationError,
  GenerationService,
  MetadataOnlyEvidenceCollector,
  createGenerationEvidenceRecord,
  createAcceptedTargetTurn,
  isAcceptedTargetTurn
} from '../src/index.js';
import type {
  AcceptedTargetTurn,
  GenerationProvider,
  GenerationProviderCompletion,
  GenerationProviderCompletionInput,
  SuggestionPhrasePair
} from '../src/index.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';

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
    const service = new GenerationService(provider);
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
    const service = new GenerationService(provider);
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
    const service = new GenerationService(provider);
    const accepted = turn();
    const forgedTurn = { ...accepted } as AcceptedTargetTurn;

    expect(() => service.complete(forgedTurn)).toThrow(GenerationError);
    expect(provider.completeCalls).toBe(0);

    await expect(service.complete(accepted)).resolves.toBeDefined();
    expect(provider.completeCalls).toBe(1);
  });
});

describe('provider failures, validation, retry, and deduplication', () => {
  it('redacts provider failures without retaining a cause and permits retry', async () => {
    const providerFailure = new Error('secret conversation: provider payload');
    const provider = new DeterministicMockProvider({
      complete: [
        { failure: providerFailure },
        { result: completion('Recovered English') }
      ]
    });
    const service = new GenerationService(provider);
    const accepted = turn();

    try {
      await service.complete(accepted);
      expect.fail('expected provider failure');
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationError);
      expect((error as GenerationError).category).toBe('provider-failure');
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
    const service = new GenerationService(provider);

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
    const service = new GenerationService(provider);
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
    const service = new GenerationService(provider);

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
      const service = new GenerationService(provider);

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
    const service = new GenerationService(provider);
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
    const service = new GenerationService(provider);
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
    const service = new GenerationService(provider);
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

  it('shares one promise, aborts once for any caller, and records cancellation', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion(), delayMs: 50 }
    });
    const service = new GenerationService(provider);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstPromise = service.complete(turn(), { signal: firstController.signal });
    const secondPromise = service.complete(turn(), { signal: secondController.signal });

    expect(secondPromise).toBe(firstPromise);
    await Promise.resolve();
    expect(provider.completeCalls).toBe(1);
    firstController.abort();
    await expect(firstPromise).rejects.toMatchObject({ category: 'provider-failure' });
    expect(provider.signals[0]?.aborted).toBe(true);
    expect(service.evidence).toMatchObject([{ operation: 'complete', status: 'cancelled' }]);
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
    const service = new GenerationService(provider);
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
    const service = new GenerationService(provider);
    const controller = new AbortController();
    controller.abort();

    await expect(service.complete(turn(), { signal: controller.signal })).rejects.toMatchObject({
      category: 'provider-failure'
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
      new GenerationService(provider as unknown as GenerationProvider);
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
    const service = new GenerationService(provider);
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
    const service = new GenerationService(provider);
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
    const service = new GenerationService(provider);
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
    ['failure', { failureCategory: 'provider-failure' }],
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
      startMonotonicMs: 10,
      endMonotonicMs: 20,
      latencyMs: 10
    });

    expect(collector.records).toEqual([record]);
    expect(Object.isFrozen(record)).toBe(true);
    expect(JSON.stringify(record)).not.toContain('transcript');
    expect(Object.keys(record)).not.toContain('sourceText');
  });

  it('stores immutable metadata and no conversation content', async () => {
    const provider = new DeterministicMockProvider({
      complete: { result: completion('English suggestion text', suggestions(2)) }
    });
    const service = new GenerationService(provider);
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
    const service = new GenerationService(
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
    const successService = new GenerationService(
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
    const service = new GenerationService({ provider, evidenceCollector: throwingCollector });
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
    const service = new GenerationService(provider);
    await service.complete(turn());

    expect(complete).toHaveBeenCalledTimes(1);
  });
});
