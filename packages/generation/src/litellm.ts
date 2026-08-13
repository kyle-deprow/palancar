import type {
  GenerationProvider,
  GenerationProviderCompletion,
  GenerationProviderCompletionInput,
  SuggestionPhrasePair
} from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8_192;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 8_192;
const MAX_MODEL_LENGTH = 128;
const MAX_TRANSLATION_LENGTH = 256;
const MAX_SUGGESTION_LENGTH = 160;
const MAX_TOKENS = 384;
const PROVIDER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PROVIDER_CONFIGURATION_ERROR = 'Invalid LiteLLM generation provider configuration.';
const PROVIDER_FAILURE_ERROR = 'LiteLLM generation provider failed.';

const COMPLETION_RESPONSE_FORMAT = {
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
          maxLength: MAX_TRANSLATION_LENGTH
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
                maxLength: MAX_SUGGESTION_LENGTH
              },
              selectedTargetText: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_SUGGESTION_LENGTH
              }
            }
          }
        }
      }
    }
  }
} as const;

export interface LiteLLMChatGenerationProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxTokens?: number;
  readonly id?: string;
  readonly version?: string;
}

interface ChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

interface ChatCompletionRequest {
  readonly model: string;
  readonly stream: false;
  readonly max_tokens: 384;
  readonly messages: readonly ChatMessage[];
  readonly response_format: typeof COMPLETION_RESPONSE_FORMAT;
}

function providerFailure(): Error {
  return new Error(PROVIDER_FAILURE_ERROR);
}

function invalidConfiguration(): never {
  throw new TypeError(PROVIDER_CONFIGURATION_ERROR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function normalizedBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    invalidConfiguration();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidConfiguration();
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    value.includes('?') ||
    value.includes('#') ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    invalidConfiguration();
  }
  const normalized = url.toString().replace(/\/+$/, '');
  if (normalized.length === 0) {
    invalidConfiguration();
  }
  return normalized;
}

function nonemptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalidConfiguration();
  }
  return value;
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const resolved = value === undefined ? fallback : value;
  if (
    typeof resolved !== 'number' ||
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > maximum
  ) {
    invalidConfiguration();
  }
  return resolved;
}

function providerValue(value: unknown, fallback: string): string {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== 'string' || !PROVIDER_VALUE.test(resolved)) {
    invalidConfiguration();
  }
  return resolved;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseCompletion(value: unknown): GenerationProviderCompletion {
  if (!isRecord(value) || !hasExactlyKeys(value, ['englishTranslation', 'suggestions'])) {
    throw providerFailure();
  }
  if (!isBoundedText(value.englishTranslation, MAX_TRANSLATION_LENGTH)) {
    throw providerFailure();
  }
  if (!Array.isArray(value.suggestions) || value.suggestions.length < 2 || value.suggestions.length > 3) {
    throw providerFailure();
  }
  const suggestions: SuggestionPhrasePair[] = [];
  for (const item of value.suggestions) {
    if (
      !isRecord(item) ||
      !hasExactlyKeys(item, ['englishText', 'selectedTargetText']) ||
      !isBoundedText(item.englishText, MAX_SUGGESTION_LENGTH) ||
      !isBoundedText(item.selectedTargetText, MAX_SUGGESTION_LENGTH)
    ) {
      throw providerFailure();
    }
    suggestions.push(Object.freeze({
      englishText: item.englishText,
      selectedTargetText: item.selectedTargetText
    }));
  }
  return Object.freeze({
    englishTranslation: value.englishTranslation,
    suggestions: Object.freeze(suggestions) as GenerationProviderCompletion['suggestions']
  });
}

async function readResponseText(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted) {
    try {
      await response.body?.cancel();
    } catch {
      // Cancellation is represented by the generic provider error.
    }
    throw providerFailure();
  }
  if (response.body == null) {
    try {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
        throw providerFailure();
      }
      return text;
    } catch {
      throw providerFailure();
    }
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const onAbort = (): void => {
    if (reader !== undefined) {
      void reader.cancel();
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw providerFailure();
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maxResponseBytes) {
        throw providerFailure();
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw providerFailure();
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (reader !== undefined) {
      try {
        await reader.cancel();
      } catch {
        // The body is already settled or cancelled.
      }
    }
  }
}

function responseContent(envelope: unknown, maxResponseBytes: number): string {
  if (!isRecord(envelope)) {
    throw providerFailure();
  }
  const choices = envelope.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw providerFailure();
  }
  const choice = choices[0];
  if (choice.finish_reason !== 'stop' || !isRecord(choice.message)) {
    throw providerFailure();
  }
  const message = choice.message;
  if (
    (Object.hasOwn(message, 'tool_calls') && message.tool_calls !== null) ||
    (Object.hasOwn(message, 'refusal') && message.refusal !== null) ||
    !Object.hasOwn(message, 'content') ||
    typeof message.content !== 'string'
  ) {
    throw providerFailure();
  }
  const content = message.content;
  if (new TextEncoder().encode(content).byteLength > maxResponseBytes) {
    throw providerFailure();
  }
  return content;
}

export class LiteLLMChatGenerationProvider implements GenerationProvider {
  readonly id: string;
  readonly version: string;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(config: LiteLLMChatGenerationProviderConfig) {
    try {
      if (!isRecord(config)) {
        invalidConfiguration();
      }
      this.#baseUrl = normalizedBaseUrl(config.baseUrl);
      this.#apiKey = nonemptyString(config.apiKey);
      const model = nonemptyString(config.model);
      if (model.length > MAX_MODEL_LENGTH) {
        invalidConfiguration();
      }
      this.#model = model;
      this.#timeoutMs = boundedInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      this.#maxResponseBytes = boundedInteger(
        config.maxResponseBytes,
        DEFAULT_MAX_RESPONSE_BYTES,
        MAX_RESPONSE_BYTES
      );
      if (config.maxTokens !== undefined && config.maxTokens !== MAX_TOKENS) {
        invalidConfiguration();
      }
      this.id = providerValue(config.id, 'litellm-chat');
      this.version = providerValue(config.version, '1.0.0');
    } catch {
      throw new TypeError(PROVIDER_CONFIGURATION_ERROR);
    }
  }

  async complete(
    input: GenerationProviderCompletionInput,
    context: { readonly signal: AbortSignal }
  ): Promise<GenerationProviderCompletion> {
    try {
      const request: ChatCompletionRequest = {
        model: this.#model,
        stream: false,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: 'system',
            content: 'Translate the target-language text to concise English and suggest 2-3 likely replies with target-language equivalents. Output JSON only.'
          },
          {
            role: 'user',
            content: `Selected target language: ${input.selectedTargetLanguage}\nTarget-language transcript: ${input.targetTranscript}`
          }
        ],
        response_format: COMPLETION_RESPONSE_FORMAT
      };
      const content = await this.#request(request, context.signal);
      return parseCompletion(JSON.parse(content) as unknown);
    } catch {
      throw providerFailure();
    }
  }

  async #request(request: ChatCompletionRequest, externalSignal: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const onExternalAbort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    if (externalSignal.aborted) {
      onExternalAbort();
    }
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      if (controller.signal.aborted) {
        throw providerFailure();
      }
      const response = await globalThis.fetch(`${this.#baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });
      if (!response.ok) {
        controller.abort();
        try {
          await response.body?.cancel();
        } catch {
          // The response is intentionally not surfaced.
        }
        throw providerFailure();
      }
      const text = await readResponseText(response, this.#maxResponseBytes, controller.signal);
      return responseContent(JSON.parse(text) as unknown, this.#maxResponseBytes);
    } catch {
      throw providerFailure();
    } finally {
      clearTimeout(timeout);
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export type LiteLLMGenerationProviderConfig = LiteLLMChatGenerationProviderConfig;
