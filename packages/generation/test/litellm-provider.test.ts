import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LiteLLMChatGenerationProvider,
  type LiteLLMGenerationProviderConfig
} from '../src/index.js';
import type {
  GenerationProviderSuggestInput,
  GenerationProviderTranslateInput
} from '../src/index.js';

const BASE_URL = 'https://litellm.example.test/';
const API_KEY = 'canary-api-key-do-not-leak';
const TRANSCRIPT = 'canary transcript do not leak';
const TRANSLATION = 'canary translation do not leak';
const SUGGESTION = 'canary suggestion do not leak';
const PROVIDER_BODY = 'canary provider response body do not leak';

const CONFIG: LiteLLMGenerationProviderConfig = {
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  model: 'palancar-generation'
};

const TRANSLATE_INPUT = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  sessionEpoch: 1,
  utteranceId: '22222222-2222-4222-8222-222222222222',
  segmentId: 'segment-1',
  acceptedFinalRevision: 1,
  selectedTargetLanguage: 'es',
  gatePolicyVersion: '1.0.0',
  targetTranscript: TRANSCRIPT
} as GenerationProviderTranslateInput;

const SUGGEST_INPUT = {
  ...TRANSLATE_INPUT,
  englishTranslation: TRANSLATION
} as GenerationProviderSuggestInput;

function completionResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content }
      }]
    }),
    { status }
  );
}

function rawResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

async function expectRedactedFailure(operation: Promise<unknown>): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe('LiteLLM generation provider failed.');
  const rendered = `${String(error)} ${JSON.stringify(error) ?? ''}`;
  for (const canary of [API_KEY, TRANSCRIPT, TRANSLATION, SUGGESTION, PROVIDER_BODY]) {
    expect(rendered).not.toContain(canary);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LiteLLMChatGenerationProvider configuration', () => {
  it('rejects invalid configuration without leaking values', () => {
    const invalidConfigurations: readonly LiteLLMGenerationProviderConfig[] = [
      { ...CONFIG, baseUrl: 'ftp://example.test' },
      { ...CONFIG, baseUrl: 'https://example.test/path?secret=query' },
      { ...CONFIG, apiKey: '' },
      { ...CONFIG, model: '' },
      { ...CONFIG, model: 'x'.repeat(129) },
      { ...CONFIG, timeoutMs: 0 },
      { ...CONFIG, timeoutMs: 60_001 },
      { ...CONFIG, maxResponseBytes: 16_385 },
      { ...CONFIG, maxTokens: 1_025 },
      { ...CONFIG, id: 'not safe id!' },
      { ...CONFIG, version: 'not safe version!' }
    ];

    for (const config of invalidConfigurations) {
      let error: unknown;
      try {
        new LiteLLMChatGenerationProvider(config);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TypeError);
      const rendered = `${String(error)} ${JSON.stringify(error) ?? ''}`;
      expect(rendered).not.toContain(API_KEY);
      expect(rendered).not.toContain('secret=query');
    }
  });

  it('normalizes a trailing slash and exposes provider-safe defaults', () => {
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    expect(provider.id).toBe('litellm-chat');
    expect(provider.version).toBe('1.0.0');
  });
});

describe('LiteLLMChatGenerationProvider requests', () => {
  it('translates with the strict non-streaming schema', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(completionResponse(JSON.stringify({ englishTranslation: 'Where is it?' })));
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expect(provider.translate(TRANSLATE_INPUT)).resolves.toEqual({
      englishTranslation: 'Where is it?'
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://litellm.example.test/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json'
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.model).toBe('palancar-generation');
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(1_024);
    expect(body).not.toHaveProperty('temperature');
    expect(body.messages).toEqual([
      {
        role: 'system',
        content: 'Translate from the selected target language to English. Output JSON only.'
      },
      {
        role: 'user',
        content: `Selected target language: es\nText to translate: ${TRANSCRIPT}`
      }
    ]);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'palancar_translation',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['englishTranslation'],
          properties: {
            englishTranslation: {
              type: 'string',
              minLength: 1,
              maxLength: 1_024
            }
          }
        }
      }
    });
  });

  it('suggests with the strict schema and returns suggestion pairs', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(completionResponse(JSON.stringify({
        suggestions: [
          { englishText: 'Sure.', selectedTargetText: 'Claro.' },
          { englishText: 'Of course.', selectedTargetText: 'Por supuesto.' }
        ]
      })));
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expect(provider.suggest(SUGGEST_INPUT)).resolves.toEqual({
      suggestions: [
        { englishText: 'Sure.', selectedTargetText: 'Claro.' },
        { englishText: 'Of course.', selectedTargetText: 'Por supuesto.' }
      ]
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'palancar_suggestions',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['suggestions'],
          properties: {
            suggestions: {
              type: 'array',
              minItems: 2,
              maxItems: 3,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['englishText', 'selectedTargetText'],
                properties: {
                  englishText: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 1_024
                  },
                  selectedTargetText: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 1_024
                  }
                }
              }
            }
          }
        }
      }
    });
  });
});

describe('LiteLLMChatGenerationProvider failures and defensive parsing', () => {
  it('redacts non-2xx provider responses', async () => {
    let requestSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      requestSignal = init?.signal;
      return Promise.resolve(rawResponse(PROVIDER_BODY, 502));
    });
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expectRedactedFailure(provider.translate(TRANSLATE_INPUT));
    expect(requestSignal?.aborted).toBe(true);
  });

  it('aborts an in-flight request when the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null | undefined;
      vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
        requestSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      });
      const provider = new LiteLLMChatGenerationProvider({ ...CONFIG, timeoutMs: 1 });
      const operation = provider.translate(TRANSLATE_INPUT);
      const failure = expectRedactedFailure(operation);

      await vi.advanceTimersByTimeAsync(1);
      await failure;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts network failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error(`${PROVIDER_BODY}: ${API_KEY}: ${TRANSCRIPT}`)
    );
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expectRedactedFailure(provider.suggest(SUGGEST_INPUT));
  });

  it.each([
    ['missing choices', { choices: [] }],
    ['missing message', { choices: [{ finish_reason: 'stop' }] }],
    ['missing content', { choices: [{ finish_reason: 'stop', message: {} }] }],
    ['non-stop finish reason', { choices: [{ finish_reason: 'length', message: { content: '{}' } }] }],
    ['refusal', { choices: [{ finish_reason: 'stop', message: { content: '{}', refusal: 'no' } }] }],
    ['tool calls', { choices: [{ finish_reason: 'stop', message: { content: '{}', tool_calls: [] } }] }],
    ['null envelope', null],
    ['array envelope', []],
    ['string envelope', 'not-an-object']
  ])('rejects %s envelopes generically', async (_name, envelope) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(rawResponse(JSON.stringify(envelope)));
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expectRedactedFailure(provider.translate(TRANSLATE_INPUT));
  });

  it('accepts null refusal and tool calls fields', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const provider = new LiteLLMChatGenerationProvider(CONFIG);
    const envelope = (message: Record<string, unknown>) => rawResponse(JSON.stringify({
      choices: [{ finish_reason: 'stop', message }]
    }));

    fetchMock.mockResolvedValue(envelope({
      content: JSON.stringify({ englishTranslation: 'Where is it?' }),
      refusal: null
    }));
    await expect(provider.translate(TRANSLATE_INPUT)).resolves.toEqual({
      englishTranslation: 'Where is it?'
    });

    fetchMock.mockResolvedValue(envelope({
      content: JSON.stringify({ englishTranslation: 'Where is it?' }),
      tool_calls: null
    }));
    await expect(provider.translate(TRANSLATE_INPUT)).resolves.toEqual({
      englishTranslation: 'Where is it?'
    });

    fetchMock.mockResolvedValue(envelope({
      content: JSON.stringify({ englishTranslation: 'Where is it?' }),
      refusal: null,
      tool_calls: null
    }));
    await expect(provider.translate(TRANSLATE_INPUT)).resolves.toEqual({
      englishTranslation: 'Where is it?'
    });
  });

  it('rejects overlarge content before parsing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      completionResponse('x'.repeat(16_385))
    );
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expectRedactedFailure(provider.translate(TRANSLATE_INPUT));
  });

  it('rejects malformed generated JSON generically', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(completionResponse('{not-json'));
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expectRedactedFailure(provider.translate(TRANSLATE_INPUT));
  });

  it('rejects malformed translation and suggestion objects generically', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    fetchMock.mockResolvedValue(completionResponse(JSON.stringify({ englishTranslation: '' })));
    await expectRedactedFailure(provider.translate(TRANSLATE_INPUT));

    fetchMock.mockResolvedValue(completionResponse(JSON.stringify({
      suggestions: [{ englishText: 'Only one', selectedTargetText: 'Uno' }]
    })));
    await expectRedactedFailure(provider.suggest(SUGGEST_INPUT));
  });
});
