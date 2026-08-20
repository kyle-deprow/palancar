import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_NEGOTIATED_LIMITS } from '@palancar/contracts';
import {
  GenerationService,
  LiteLLMChatGenerationProvider,
  type GeneratedLanguageValidator,
  type GenerationProviderCompletion
} from '@palancar/generation';
import { LANGUAGE_REGISTRY_VERSION } from '@palancar/language-registry';
import type { NormalizedTranscriptionFinal } from '@palancar/transcription';

import {
  createDevelopmentProvisionalLanguageBoundary,
  createTestOptions,
  createTestSecurityRuntime,
  TEST_GATE_POLICY_VERSION,
  TEST_SESSION_ID,
  TEST_UTTERANCE_ID,
  RelaySessionCore,
  type RelayMetricSink,
  type RelayProductionMetricInput
} from '../src/index.js';

const TEXT = Object.freeze({
  en: 'Good morning. Where is the train station?',
  es: 'Buenos días. ¿Dónde está la estación?',
  tr: 'Merhaba. Tren istasyonu nerede?'
});

function startText(targetLanguage: 'es' | 'tr'): string {
  return JSON.stringify({
    type: 'session.start',
    protocolVersion: 1,
    wearerLanguage: 'en',
    targetLanguage,
    languageRegistryVersion: LANGUAGE_REGISTRY_VERSION,
    gatePolicyVersion: TEST_GATE_POLICY_VERSION,
    clientBuild: 'relay-composition-test-1.0.0',
    requestedLimits: DEFAULT_NEGOTIATED_LIMITS
  });
}

function utteranceStartText(): string {
  return JSON.stringify({
    type: 'utterance.start',
    sessionId: TEST_SESSION_ID,
    sessionEpoch: 1,
    utteranceId: TEST_UTTERANCE_ID
  });
}

function finalEvent(target: 'es' | 'tr'): NormalizedTranscriptionFinal {
  return {
    type: 'transcript.final',
    sessionId: TEST_SESSION_ID,
    sessionEpoch: 1,
    utteranceId: TEST_UTTERANCE_ID,
    segmentId: 'segment-1',
    revision: 1,
    text: TEXT[target],
    providerEventTime: '2026-08-20T12:00:00.000Z',
    languageEvidence: {
      detectorVersion: 'ignored-transcription-metadata',
      source: 'transcription-metadata',
      detectedLanguage: 'en',
      confidence: 0
    },
    acceptedThroughOriginalSampleOffset: 0,
    finalizationReason: 'explicit'
  };
}

function completionResponse(completion: GenerationProviderCompletion): Response {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: { content: JSON.stringify(completion) }
    }]
  }), { status: 200 });
}

function completionFor(
  target: 'es' | 'tr',
  count: 2 | 3
): GenerationProviderCompletion {
  const suggestions = [0, 1, 2].slice(0, count).map(() => ({
    englishText: TEXT.en,
    selectedTargetText: TEXT[target]
  }));
  return {
    englishTranslation: TEXT.en,
    suggestions: suggestions as unknown as GenerationProviderCompletion['suggestions']
  };
}

function completionWithWrongLanguageSlot(
  target: 'es' | 'tr',
  count: 2 | 3,
  slot: number
): GenerationProviderCompletion {
  const completion = completionFor(target, count);
  const otherTarget = target === 'es' ? 'tr' : 'es';
  if (slot === 0) {
    return { ...completion, englishTranslation: TEXT[target] };
  }
  const suggestionIndex = Math.floor((slot - 1) / 2);
  const suggestions = completion.suggestions.map((suggestion, index) => {
    if (index !== suggestionIndex) return suggestion;
    return slot % 2 === 1
      ? { ...suggestion, englishText: TEXT[target] }
      : { ...suggestion, selectedTargetText: TEXT[otherTarget] };
  });
  return {
    ...completion,
    suggestions: suggestions as unknown as GenerationProviderCompletion['suggestions']
  };
}

function metricSink(): Readonly<{
  readonly sink: RelayMetricSink;
  readonly records: RelayProductionMetricInput[];
}> {
  const records: RelayProductionMetricInput[] = [];
  return { sink: { record: (input) => records.push(input) }, records };
}

async function flushAsyncEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createComposition(
  target: 'es' | 'tr',
  response: GenerationProviderCompletion,
  records: RelayProductionMetricInput[],
  options: Readonly<{
    readonly validator?: GeneratedLanguageValidator;
    readonly languageValidationTimeoutMs?: number;
  }> = {}
): Readonly<{
  readonly core: RelaySessionCore;
  readonly service: GenerationService;
  readonly fetch: typeof globalThis.fetch;
}> {
  const boundary = createDevelopmentProvisionalLanguageBoundary();
  const provider = new LiteLLMChatGenerationProvider({
    baseUrl: 'https://litellm.offline.test',
    apiKey: 'offline-test-key',
    model: 'offline-test-model'
  });
  const service = new GenerationService({
    provider,
    validator: options.validator ?? boundary.generatedLanguageValidator,
    languageValidationMode: 'development-provisional',
    ...(options.languageValidationTimeoutMs === undefined
      ? {}
      : { languageValidationTimeoutMs: options.languageValidationTimeoutMs })
  });
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(completionResponse(response));
  const core = new RelaySessionCore(createTestOptions({
    languageBoundaryMode: 'development-provisional',
    languageClassifier: boundary.classifier,
    generationService: service,
    securityRuntime: createTestSecurityRuntime(),
    metricSink: { record: (input) => records.push(input) }
  }));
  expect(core.openWithFirstText(startText(target)).outgoing[0]?.type).toBe('session.ready');
  expect(core.handleText(utteranceStartText()).outgoing).toEqual([]);
  return { core, service, fetch };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('offline production generation composition', () => {
  it.each([
    ['es', 2, 5],
    ['es', 3, 7],
    ['tr', 2, 5],
    ['tr', 3, 7]
  ] as const)('releases %s with %i reply pairs and %i validation checks', async (
    target,
    count,
    checkCount
  ) => {
    const metrics = metricSink();
    const { core, service, fetch } = createComposition(
      target,
      completionFor(target, count),
      metrics.records
    );

    const accepted = await core.handleTranscriptionEvent(finalEvent(target));
    expect(accepted.outgoing.map((message) => message.type)).toEqual([
      'transcript.final',
      'language.decision'
    ]);
    await flushAsyncEvents();

    const released = await core.drainAsyncEvents();
    expect(released.outgoing.map((message) => message.type)).toEqual([
      'translation.ready',
      'suggestions.ready'
    ]);
    expect(released.outgoing).toContainEqual(expect.objectContaining({
      type: 'translation.ready',
      englishTranslation: TEXT.en
    }));
    expect(released.outgoing).toContainEqual(expect.objectContaining({
      type: 'suggestions.ready',
      suggestions: expect.arrayContaining([
        expect.objectContaining({ selectedTargetText: TEXT[target] })
      ])
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.evidence).toHaveLength(1);
    expect(service.evidence[0]).toMatchObject({
      status: 'success',
      languageValidationCheckCount: checkCount,
      languageValidationNonmatchCount: 0
    });
    expect(metrics.records.some((record) => record.name.startsWith('generation.failure.')))
      .toBe(false);
  });

  it('rejects an 11-substantive-character field before ELD', async () => {
    const metrics = metricSink();
    const response = {
      ...completionFor('es', 2),
      englishTranslation: 'a'.repeat(11)
    };
    const { core, service, fetch } = createComposition('es', response, metrics.records);

    await core.handleTranscriptionEvent(finalEvent('es'));
    await flushAsyncEvents();
    const rejected = await core.drainAsyncEvents();

    expect(rejected.outgoing).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'provider_unavailable',
        recoverable: true
      })
    ]);
    expect(rejected.outgoing.some((message) =>
      message.type === 'translation.ready' || message.type === 'suggestions.ready'
    )).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.evidence).toHaveLength(1);
    expect(service.evidence[0]).toMatchObject({
      status: 'failure',
      failureCategory: 'provider-failure',
      languageValidationCheckCount: 0
    });
    expect(metrics.records.filter(
      (record) => record.name === 'generation.failure.provider_response'
    )).toHaveLength(1);
    expect(metrics.records.filter((record) => record.name === 'provider.failure'))
      .toHaveLength(1);
  });

  it.each([
    ['validator throw', async (): Promise<never> => { throw new Error('validator canary'); }],
    ['validator timeout', (): Promise<never> => new Promise(() => undefined)],
    ['malformed evidence', async (): Promise<unknown> => ({ checks: [] })]
  ] as const)('maps real GenerationService %s to language-validation failure', async (
    _description,
    validate
  ) => {
    const validator = {
      id: 'composition-validator',
      version: '1.0.0',
      validate
    } as unknown as GeneratedLanguageValidator;
    const metrics = metricSink();
    const { core, service, fetch } = createComposition(
      'es',
      completionFor('es', 2),
      metrics.records,
      {
        validator,
        ...(_description === 'validator timeout'
          ? { languageValidationTimeoutMs: 1 }
          : {})
      }
    );

    await core.handleTranscriptionEvent(finalEvent('es'));
    await flushAsyncEvents();
    await flushAsyncEvents();
    const rejected = await core.drainAsyncEvents();

    expect(rejected.outgoing).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'provider_unavailable',
        recoverable: true
      })
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.evidence).toHaveLength(1);
    expect(service.evidence[0]).toMatchObject({
      status: 'failure',
      failureCategory: 'language-validation-failure',
      languageValidationCheckCount: 5
    });
    expect(metrics.records.filter(
      (record) => record.name === 'generation.failure.language_validation'
    )).toHaveLength(1);
    expect(metrics.records.filter((record) => record.name === 'provider.failure'))
      .toHaveLength(0);
  });

  const wrongLanguageCases = (['es', 'tr'] as const).flatMap((target) =>
    ([2, 3] as const).flatMap((count) =>
      Array.from({ length: count === 2 ? 5 : 7 }, (_, slot) => [target, count, slot] as const)
    )
  );

  it.each(wrongLanguageCases)(
    'rejects wrong-language fields for %s with %i reply pairs at slot %i',
    async (target, count, slot) => {
      const metrics = metricSink();
      const { core, service, fetch } = createComposition(
        target,
        completionWithWrongLanguageSlot(target, count, slot),
        metrics.records
      );

      await core.handleTranscriptionEvent(finalEvent(target));
      await flushAsyncEvents();
      const rejected = await core.drainAsyncEvents();

      expect(rejected.outgoing).toEqual([
        expect.objectContaining({
          type: 'error',
          code: 'provider_unavailable',
          recoverable: true
        })
      ]);
      expect(rejected.outgoing.some((message) =>
        message.type === 'translation.ready' || message.type === 'suggestions.ready'
      )).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(service.evidence).toHaveLength(1);
      expect(service.evidence[0]).toMatchObject({
        status: 'failure',
        failureCategory: 'invalid-generated-language',
        languageValidationCheckCount: count === 2 ? 5 : 7
      });
      expect(metrics.records.filter(
        (record) => record.name === 'generation.failure.invalid_generated_language'
      )).toHaveLength(1);
      expect(metrics.records.filter((record) => record.name.startsWith('generation.failure.')))
        .toHaveLength(1);
      expect(metrics.records.filter((record) => record.name === 'provider.failure'))
        .toHaveLength(0);
    }
  );
});
