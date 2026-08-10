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
  GenerationEvidenceRecord,
  GenerationProvider,
  GenerationProviderSuggestInput,
  GenerationProviderTranslateInput,
  GenerationProviderTranslation,
  SuggestionPhrasePair
} from '../src/index.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';

function turn(target: 'es' | 'tr' = 'es', revision = 1): AcceptedTargetTurn {
  return createAcceptedTargetTurn({
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    utteranceId: UTTERANCE_ID,
    segmentId: 'segment-1',
    acceptedFinalRevision: revision,
    selectedTargetLanguage: target,
    decision: 'target',
    targetTranscript: target === 'es' ? '¿Dónde está la estación?' : 'İstasyon nerede?',
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

function validTranslateInput(): GenerationProviderTranslateInput {
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

function validSuggestInput(): GenerationProviderSuggestInput {
  return {
    ...validTranslateInput(),
    englishTranslation: 'English translation'
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

describe('separate translation and suggestions', () => {
  it('translates once, returns correlation metadata, and does not suggest', async () => {
    const provider = new DeterministicMockProvider({
      translate: { result: { englishTranslation: 'Where is the station?' } },
      suggest: { result: suggestions(2) }
    });
    const service = new GenerationService(provider);
    const result = await service.translate(turn('es'));

    expect(result).toEqual({
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'es',
      gatePolicyVersion: '1.0.0',
      englishTranslation: 'Where is the station?'
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(provider.callCounts).toEqual({ translate: 1, suggest: 0 });
    expect(provider.translateInputs).toEqual([{
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
      translate: { result: 'Where is the station?' },
      suggest: { result: suggestions(count) }
    });
    const service = new GenerationService(provider);
    const accepted = turn('tr');
    const translation = await service.translate(accepted);
    const result = await service.suggest(accepted, translation);

    expect(result.suggestions).toHaveLength(count);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.suggestions)).toBe(true);
    expect(result.suggestions.every((item) => Object.isFrozen(item))).toBe(true);
    expect(provider.suggestInputs).toEqual([{
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'tr',
      gatePolicyVersion: '1.0.0',
      targetTranscript: 'İstasyon nerede?',
      englishTranslation: 'Where is the station?'
    }]);
  });

  it('rejects forged values and mismatched correlation before provider calls', async () => {
    const provider = new DeterministicMockProvider({
      translate: { result: 'English' },
      suggest: { result: suggestions(2) }
    });
    const service = new GenerationService(provider);
    const accepted = turn();
    const translation = await service.translate(accepted);
    const forgedTurn = { ...accepted } as AcceptedTargetTurn;
    const forgedTranslation = { ...translation } as typeof translation;

    expect(() => service.translate(forgedTurn)).toThrow(GenerationError);
    expect(() => service.suggest(forgedTurn, translation)).toThrow(GenerationError);
    expect(() => service.suggest(accepted, forgedTranslation)).toThrow(GenerationError);

    const otherTurn = createAcceptedTargetTurn({
      ...accepted,
      segmentId: 'segment-2'
    });
    expect(() => service.suggest(otherTurn, translation)).toThrow(/correlation mismatch/i);
    expect(provider.callCounts).toEqual({ translate: 1, suggest: 0 });
  });
});

describe('provider failures, validation, retry, and deduplication', () => {
  it('redacts provider failures without retaining a cause and permits retry', async () => {
    const providerFailure = new Error('secret conversation: provider payload');
    const provider = new DeterministicMockProvider({
      translate: [
        { failure: providerFailure },
        { result: 'Recovered English' }
      ]
    });
    const service = new GenerationService(provider);
    const accepted = turn();

    try {
      await service.translate(accepted);
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

    await expect(service.translate(accepted)).resolves.toMatchObject({
      englishTranslation: 'Recovered English'
    });
    expect(provider.translateCalls).toBe(2);
  });

  it.each([0, 1, 4] as const)('rejects %d suggestions without partial output', async (count) => {
    const malformedSuggestions = count === 4
      ? [
        ...suggestions(3),
        { englishText: 'One more', selectedTargetText: 'Bir tane daha' }
      ]
      : suggestions(2).slice(0, count);
    const provider = new DeterministicMockProvider({
      translate: { result: 'English' },
      suggest: { result: malformedSuggestions }
    });
    const service = new GenerationService(provider);
    const accepted = turn();
    const translation = await service.translate(accepted);

    await expect(service.suggest(accepted, translation)).rejects.toMatchObject({
      category: 'invalid-provider-result'
    });
    expect(provider.suggestCalls).toBe(1);
  });

  it('rejects overlength translation and phrase fields', async () => {
    const longText = 'x'.repeat(1_025);
    const provider = new DeterministicMockProvider({
      translate: [
        { result: longText },
        { result: 'English' },
        { result: 'English' }
      ],
      suggest: { result: [
        { englishText: longText, selectedTargetText: 'ok' },
        { englishText: 'ok', selectedTargetText: 'ok' }
      ] }
    });
    const service = new GenerationService(provider);
    const accepted = turn();

    await expect(service.translate(accepted)).rejects.toMatchObject({
      category: 'invalid-provider-result'
    });
    const translation = await service.translate(accepted);
    await expect(service.suggest(accepted, translation)).rejects.toMatchObject({
      category: 'invalid-provider-result'
    });
  });

  it('deduplicates concurrent calls per accepted turn and keeps turns independent', async () => {
    const provider = new DeterministicMockProvider({
      translate: { result: 'English', delayMs: 10 },
      suggest: { result: suggestions(2), delayMs: 10 }
    });
    const service = new GenerationService(provider);
    const first = turn('es');
    const second = turn('tr', 2);

    const translations = await Promise.all([
      service.translate(first),
      service.translate(first),
      service.translate(second)
    ]);
    expect(provider.translateCalls).toBe(2);
    expect(translations[0]).toBe(translations[1]);

    await Promise.all([
      service.suggest(first, translations[0]),
      service.suggest(first, translations[1]),
      service.suggest(second, translations[2])
    ]);
    expect(provider.suggestCalls).toBe(2);
  });

  it('evicts completed promises while retaining concurrent in-flight deduplication', async () => {
    const provider = new DeterministicMockProvider({
      translate: { result: 'English' },
      suggest: { result: suggestions(2), delayMs: 10 }
    });
    const service = new GenerationService(provider);
    const accepted = turn();

    const firstTranslation = await service.translate(accepted);
    const secondTranslation = await service.translate(accepted);
    expect(firstTranslation).not.toBe(secondTranslation);
    expect(provider.translateCalls).toBe(2);

    const firstSuggestion = service.suggest(accepted, firstTranslation);
    const concurrentSuggestion = service.suggest(accepted, firstTranslation);
    expect(concurrentSuggestion).toBe(firstSuggestion);
    await Promise.all([firstSuggestion, concurrentSuggestion]);
    expect(provider.suggestCalls).toBe(1);

    await service.suggest(accepted, firstTranslation);
    expect(provider.suggestCalls).toBe(2);
  });

  it('keys suggestions by the consumed translation for the same accepted turn', async () => {
    const firstEnglish = 'English translation one';
    const secondEnglish = 'English translation two';
    const provider = new DeterministicMockProvider({
      translate: [
        { result: firstEnglish },
        { result: secondEnglish }
      ],
      suggest: [
        {
          result: [
            { englishText: firstEnglish, selectedTargetText: 'target one' },
            { englishText: firstEnglish, selectedTargetText: 'target two' }
          ],
          delayMs: 10
        },
        {
          result: [
            { englishText: secondEnglish, selectedTargetText: 'target one' },
            { englishText: secondEnglish, selectedTargetText: 'target two' }
          ],
          delayMs: 10
        }
      ]
    });
    const service = new GenerationService(provider);
    const accepted = turn();
    const firstTranslation = await service.translate(accepted);
    const secondTranslation = await service.translate(accepted);

    const [firstSuggestions, secondSuggestions] = await Promise.all([
      service.suggest(accepted, firstTranslation),
      service.suggest(accepted, secondTranslation)
    ]);

    expect(provider.suggestCalls).toBe(2);
    expect(provider.suggestInputs.map((input) => input.englishTranslation)).toEqual([
      firstEnglish,
      secondEnglish
    ]);
    expect(firstSuggestions.suggestions[0]?.englishText).toBe(
      firstTranslation.englishTranslation
    );
    expect(secondSuggestions.suggestions[0]?.englishText).toBe(
      secondTranslation.englishTranslation
    );
  });

  it('distinguishes transcript, session epoch, and gate policy in cache keys', async () => {
    const provider = new DeterministicMockProvider({
      translate: { result: 'English' },
      suggest: { result: suggestions(2) }
    });
    const service = new GenerationService(provider);
    const first = turn();
    const differentTranscript = createAcceptedTargetTurn({
      ...first,
      targetTranscript: 'A different target transcript.'
    });
    const differentEpoch = createAcceptedTargetTurn({
      ...first,
      sessionEpoch: 2
    });
    const differentGatePolicy = createAcceptedTargetTurn({
      ...first,
      gatePolicyVersion: '2.0.0'
    });

    const translations = await Promise.all([
      service.translate(first),
      service.translate(differentTranscript),
      service.translate(differentEpoch),
      service.translate(differentGatePolicy)
    ]);
    expect(provider.translateCalls).toBe(4);

    await Promise.all([
      service.suggest(first, translations[0]),
      service.suggest(differentTranscript, translations[1]),
      service.suggest(differentEpoch, translations[2]),
      service.suggest(differentGatePolicy, translations[3])
    ]);
    expect(provider.suggestCalls).toBe(4);
  });
});

describe('deterministic mock provider input validation', () => {
  it('rejects invalid translation inputs before recording them', async () => {
    const provider = new DeterministicMockProvider({
      translate: { result: 'English' }
    });
    const valid = validTranslateInput();
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
      await expect(provider.translate(input as never)).rejects.toMatchObject({
        name: 'TypeError',
        message: 'Invalid deterministic generation provider input'
      });
    }
    expect(provider.callCounts).toEqual({ translate: 0, suggest: 0 });
    expect(provider.translateInputs).toEqual([]);

    await provider.translate(valid);
    expect(provider.translateCalls).toBe(1);
    expect(provider.translateInputs).toEqual([valid]);
  });

  it('rejects invalid suggestion inputs before recording them', async () => {
    const provider = new DeterministicMockProvider({
      suggest: { result: suggestions(2) }
    });
    const valid = validSuggestInput();
    const missingEnglishTranslation = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== 'englishTranslation')
    );
    const invalidInputs: readonly Record<string, unknown>[] = [
      { ...valid, sessionId: 'not-a-v4-uuid' },
      { ...valid, sessionEpoch: 0 },
      { ...valid, segmentId: '' },
      { ...valid, acceptedFinalRevision: 0 },
      { ...valid, selectedTargetLanguage: 'fr' },
      { ...valid, targetTranscript: '' },
      { ...valid, englishTranslation: '' },
      { ...valid, gatePolicyVersion: 'invalid' },
      missingEnglishTranslation
    ];

    for (const input of invalidInputs) {
      await expect(provider.suggest(input as never)).rejects.toMatchObject({
        name: 'TypeError',
        message: 'Invalid deterministic generation provider input'
      });
    }
    expect(provider.callCounts).toEqual({ translate: 0, suggest: 0 });
    expect(provider.suggestInputs).toEqual([]);

    await provider.suggest(valid);
    expect(provider.suggestCalls).toBe(1);
    expect(provider.suggestInputs).toEqual([valid]);
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
      translate: { value: async () => 'English' },
      suggest: { value: async () => suggestions(2) }
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
    const provider = new DeterministicMockProvider({ translate: { result: 'English' } });
    const service = new GenerationService(provider);
    (provider as { id: string }).id = 'changed-provider';
    (provider as { version: string }).version = '2.0.0';

    expect(service.provider).toEqual({ id: 'deterministic-mock', version: '1.0.0' });
    await service.translate(turn());
    expect(service.evidence[0]).toMatchObject({
      providerId: 'deterministic-mock',
      providerVersion: '1.0.0'
    });
  });

  it('redacts accessor and throwing-proxy provider results as typed errors', async () => {
    let translationGetterCalls = 0;
    const accessorResult = Object.defineProperty({}, 'englishTranslation', {
      enumerable: true,
      get: () => {
        translationGetterCalls += 1;
        throw new Error('raw conversation from translation');
      }
    });
    const proxyResult = new Proxy(
      { englishTranslation: 'raw conversation from proxy' },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('raw conversation from proxy trap');
        }
      }
    );
    const translationResults: unknown[] = [accessorResult, proxyResult];
    const provider: GenerationProvider = {
      id: 'hostile-result-provider',
      version: '1.0.0',
      translate: async () => translationResults.shift() as GenerationProviderTranslation,
      suggest: async () => suggestions(2)
    };
    const service = new GenerationService(provider);
    const errors: unknown[] = [];
    for (let index = 0; index < 2; index += 1) {
      try {
        await service.translate(turn());
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
      translate: async () => 'English',
      suggest: async () => pairResults.shift() as readonly SuggestionPhrasePair[]
    };
    const service = new GenerationService(provider);
    const accepted = turn();
    const translation = await service.translate(accepted);
    const errors: unknown[] = [];
    for (let index = 0; index < 2; index += 1) {
      try {
        await service.suggest(accepted, translation);
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
  it('stores immutable metadata and no conversation content', async () => {
    const collector = new MetadataOnlyEvidenceCollector();
    const provider = new DeterministicMockProvider({
      translate: { result: 'English suggestion text' },
      suggest: { result: suggestions(2) }
    });
    const service = new GenerationService(provider, collector);
    const accepted = turn('tr');
    const translation = await service.translate(accepted);
    await service.suggest(accepted, translation);

    expect(collector.records).toHaveLength(2);
    expect(collector.records.every((record) => Object.isFrozen(record))).toBe(true);
    expect(collector.records[0]).toMatchObject({
      operation: 'translate',
      status: 'success',
      selectedTargetLanguage: 'tr',
      providerId: 'deterministic-mock'
    });
    const serialized = collector.toJsonLines();
    expect(serialized).not.toContain(accepted.targetTranscript);
    expect(serialized).not.toContain(translation.englishTranslation);
    expect(serialized).not.toContain('¿Dónde');
    expect(serialized).not.toContain('suggestions');
  });

  it('does not allow forbidden evidence keys', () => {
    const collector = new MetadataOnlyEvidenceCollector();
    expect(() => collector.add({
      sourceText: 'must not be retained'
    } as never)).toThrow(GenerationError);
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
      operation: 'translate',
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

  it('swallows evidence sink failures for both success and primary failure', async () => {
    const sink = {
      records: [] as GenerationEvidenceRecord[],
      add: () => {
        throw new Error('raw provider message from evidence sink');
      }
    };
    const successService = new GenerationService(
      new DeterministicMockProvider({ translate: { result: 'English' } }),
      sink
    );
    await expect(successService.translate(turn())).resolves.toMatchObject({
      englishTranslation: 'English'
    });

    const failureService = new GenerationService(
      new DeterministicMockProvider({ translate: { failure: new Error('raw provider failure') } }),
      sink
    );
    await expect(failureService.translate(turn())).rejects.toMatchObject({
      category: 'provider-failure'
    });
  });
});

describe('provider-neutral contract', () => {
  it('accepts a provider implementing only the provider interface', async () => {
    const translate = vi.fn(
      async (input: GenerationProviderTranslateInput): Promise<GenerationProviderTranslation> => {
        void input;
        return { englishTranslation: 'English' };
      }
    );
    const suggest = vi.fn(
      async (input: GenerationProviderSuggestInput): Promise<readonly SuggestionPhrasePair[]> => {
        void input;
        return suggestions(2);
      }
    );
    const provider: GenerationProvider = {
      id: 'test-provider',
      version: '1.0.0',
      translate,
      suggest
    };
    const service = new GenerationService(provider);
    const accepted = turn();
    const translation = await service.translate(accepted);
    await service.suggest(accepted, translation);

    expect(translate).toHaveBeenCalledTimes(1);
    expect(suggest).toHaveBeenCalledTimes(1);
  });
});
