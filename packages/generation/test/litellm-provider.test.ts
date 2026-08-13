import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LiteLLMChatGenerationProvider,
  type LiteLLMGenerationProviderConfig
} from '../src/index.js';
import type {
  GenerationProviderCompletion,
  GenerationProviderCompletionInput
} from '../src/index.js';

const BASE_URL = 'https://litellm.example.test/';
const API_KEY = 'canary-api-key-do-not-leak';
const TRANSCRIPT = 'canary transcript do not leak';
const PROVIDER_BODY = 'canary provider response body do not leak';

const CONFIG: LiteLLMGenerationProviderConfig = {
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  model: 'palancar-generation'
};

const INPUT: GenerationProviderCompletionInput = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  sessionEpoch: 1,
  utteranceId: '22222222-2222-4222-8222-222222222222',
  segmentId: 'segment-1',
  acceptedFinalRevision: 1,
  selectedTargetLanguage: 'es',
  gatePolicyVersion: '1.0.0',
  targetTranscript: TRANSCRIPT
};

function completionResponse(
  completion: GenerationProviderCompletion,
  status = 200
): Response {
  return new Response(
    JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify(completion) }
      }]
    }),
    { status }
  );
}

function rawResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function validCompletion(count: 2 | 3 = 2): GenerationProviderCompletion {
  const values = [
    { englishText: 'Sure.', selectedTargetText: 'Claro.' },
    { englishText: 'Of course.', selectedTargetText: 'Por supuesto.' },
    { englishText: 'Absolutely.', selectedTargetText: 'Por supuesto que sí.' }
  ];
  return {
    englishTranslation: 'Where is it?',
    suggestions: values.slice(0, count) as unknown as GenerationProviderCompletion['suggestions']
  };
}

function responseBodyAtBytes(byteLength: number): string {
  const content = JSON.stringify(validCompletion());
  const template = JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content } }],
    padding: ''
  });
  const marker = '"padding":""';
  const markerIndex = template.lastIndexOf(marker);
  const prefix = template.slice(0, markerIndex) + '"padding":"';
  const suffix = '"' + template.slice(markerIndex + marker.length);
  const remainingBytes = byteLength - new TextEncoder().encode(prefix + suffix).byteLength;
  if (remainingBytes < 0) {
    throw new Error('response fixture is larger than the requested byte length');
  }
  const emojiCount = Math.floor(remainingBytes / 4);
  const asciiCount = remainingBytes % 4;
  return prefix + '😀'.repeat(emojiCount) + 'x'.repeat(asciiCount) + suffix;
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
  const rendered = String(error) + ' ' + (JSON.stringify(error) ?? '');
  for (const canary of [API_KEY, TRANSCRIPT, PROVIDER_BODY]) {
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
      { ...CONFIG, maxResponseBytes: 8_193 },
      { ...CONFIG, maxTokens: 385 },
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
      const rendered = String(error) + ' ' + (JSON.stringify(error) ?? '');
      expect(rendered).not.toContain(API_KEY);
      expect(rendered).not.toContain('secret=query');
    }
  });

  it('normalizes a trailing slash and exposes provider-safe defaults', () => {
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    expect(provider.id).toBe('litellm-chat');
    expect(provider.version).toBe('1.0.0');
  });

  it('accepts exact response-byte and token boundaries and rejects the next values', () => {
    expect(() => new LiteLLMChatGenerationProvider({
      ...CONFIG,
      maxResponseBytes: 8_192,
      maxTokens: 384
    })).not.toThrow();
    expect(() => new LiteLLMChatGenerationProvider({ ...CONFIG, maxResponseBytes: 8_193 }))
      .toThrow(TypeError);
    expect(() => new LiteLLMChatGenerationProvider({ ...CONFIG, maxTokens: 385 }))
      .toThrow(TypeError);
  });
});

describe('LiteLLMChatGenerationProvider requests', () => {
  it('completes with the strict single-call schema', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(completionResponse(validCompletion()));
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expect(provider.complete(INPUT, { signal: new AbortController().signal })).resolves.toEqual(validCompletion());

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://litellm.example.test/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer ' + API_KEY,
      'content-type': 'application/json'
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.model).toBe('palancar-generation');
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(384);
    expect(body).not.toHaveProperty('temperature');
    expect(body.messages).toEqual([
      {
        role: 'system',
        content: 'Translate the target-language text to concise English and suggest 2-3 likely replies with target-language equivalents. Output JSON only.'
      },
      {
        role: 'user',
        content: 'Selected target language: es\nTarget-language transcript: ' + TRANSCRIPT
      }
    ]);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'palancar_completion',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['englishTranslation', 'suggestions'],
          properties: {
            englishTranslation: {
              type: 'string',
              minLength: 1,
              maxLength: 256
            },
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
                    maxLength: 160
                  },
                  selectedTargetText: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 160
                  }
                }
              }
            }
          }
        }
      }
    });
  });

  it('returns two or three complete suggestion pairs without a second request', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(completionResponse(validCompletion(3)));
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expect(provider.complete(INPUT, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ suggestions: [{ englishText: 'Sure.' }, { englishText: 'Of course.' }, { englishText: 'Absolutely.' }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('LiteLLMChatGenerationProvider failures and defensive parsing', () => {
  it('redacts non-2xx provider responses', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return Promise.resolve(rawResponse(PROVIDER_BODY, 502));
    });
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expectRedactedFailure(provider.complete(INPUT, { signal: new AbortController().signal }));
    expect(requestSignal?.aborted).toBe(true);
  });

  it('aborts an in-flight request when the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      });
      const provider = new LiteLLMChatGenerationProvider({ ...CONFIG, timeoutMs: 1 });
      const operation = provider.complete(INPUT, { signal: new AbortController().signal });
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
      new Error(PROVIDER_BODY + ': ' + API_KEY + ': ' + TRANSCRIPT)
    );
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expectRedactedFailure(provider.complete(INPUT, { signal: new AbortController().signal }));
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

    await expectRedactedFailure(provider.complete(INPUT, { signal: new AbortController().signal }));
  });

  it('accepts null refusal and tool calls fields', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const provider = new LiteLLMChatGenerationProvider(CONFIG);
    const envelope = (message: Record<string, unknown>) => rawResponse(JSON.stringify({
      choices: [{ finish_reason: 'stop', message }]
    }));

    fetchMock.mockResolvedValue(envelope({
      content: JSON.stringify(validCompletion()),
      refusal: null
    }));
    await expect(provider.complete(INPUT, { signal: new AbortController().signal })).resolves.toEqual(validCompletion());

    fetchMock.mockResolvedValue(envelope({
      content: JSON.stringify(validCompletion()),
      tool_calls: null
    }));
    await expect(provider.complete(INPUT, { signal: new AbortController().signal })).resolves.toEqual(validCompletion());

    fetchMock.mockResolvedValue(envelope({
      content: JSON.stringify(validCompletion()),
      refusal: null,
      tool_calls: null
    }));
    await expect(provider.complete(INPUT, { signal: new AbortController().signal })).resolves.toEqual(validCompletion());
  });

  it('cancels an in-flight response body when the external signal aborts', async () => {
    const controller = new AbortController();
    let bodyCancelled = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          bodyCancelled += 1;
        }
      });
      void init;
      return Promise.resolve(new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })).then((response) => Object.defineProperty(response, 'body', { value: body }));
    });
    const provider = new LiteLLMChatGenerationProvider(CONFIG);
    const operation = provider.complete(INPUT, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(operation).rejects.toThrow('LiteLLM generation provider failed.');
    expect(bodyCancelled).toBe(1);
  });

  it('rejects an overlength translation field even when the response body is small', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      completionResponse({
        englishTranslation: 'x'.repeat(257),
        suggestions: validCompletion().suggestions
      })
    );
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expectRedactedFailure(provider.complete(INPUT, { signal: new AbortController().signal }));
  });

  it('rejects a response body larger than the 8192-byte limit before parsing', async () => {
    const body = JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify(validCompletion()) }
      }],
      padding: 'x'.repeat(8_193)
    });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(8_192);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(rawResponse(body));
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expectRedactedFailure(provider.complete(INPUT, { signal: new AbortController().signal }));
  });

  it('accepts exactly 8192 response bytes and rejects 8193 bytes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const provider = new LiteLLMChatGenerationProvider(CONFIG);
    const exactBody = responseBodyAtBytes(8_192);
    expect(new TextEncoder().encode(exactBody).byteLength).toBe(8_192);
    fetchMock.mockResolvedValue(rawResponse(exactBody));
    await expect(provider.complete(INPUT, { signal: new AbortController().signal }))
      .resolves.toEqual(validCompletion());

    const overlengthBody = responseBodyAtBytes(8_193);
    expect(new TextEncoder().encode(overlengthBody).byteLength).toBe(8_193);
    fetchMock.mockResolvedValue(rawResponse(overlengthBody));
    await expectRedactedFailure(provider.complete(INPUT, { signal: new AbortController().signal }));
  });

  it('rejects malformed generated JSON generically', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: '{not-json' } }]
      }))
    );
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    await expectRedactedFailure(provider.complete(INPUT, { signal: new AbortController().signal }));
  });

  it('rejects malformed translation and suggestion objects generically', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const provider = new LiteLLMChatGenerationProvider(CONFIG);

    fetchMock.mockResolvedValue(completionResponse({
      englishTranslation: '',
      suggestions: validCompletion().suggestions
    }));
    await expectRedactedFailure(provider.complete(INPUT, { signal: new AbortController().signal }));

    fetchMock.mockResolvedValue(completionResponse({
      englishTranslation: 'English',
      suggestions: [{ englishText: 'Only one', selectedTargetText: 'Uno' }]
    } as unknown as GenerationProviderCompletion));
    await expectRedactedFailure(provider.complete(INPUT, { signal: new AbortController().signal }));
  });
});
