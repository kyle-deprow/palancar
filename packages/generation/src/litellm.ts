import type {
  GenerationProvider,
  GenerationProviderSuggestInput,
  GenerationProviderTranslateInput,
  GenerationProviderTranslation,
  SuggestionPhrasePair
} from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16_384;
const DEFAULT_MAX_TOKENS = 1_024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 16_384;
const MAX_TOKENS = 1_024;
const MAX_MODEL_LENGTH = 128;
const MAX_TEXT_LENGTH = 1_024;
const PROVIDER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PROVIDER_CONFIGURATION_ERROR = 'Invalid LiteLLM generation provider configuration.';
const PROVIDER_FAILURE_ERROR = 'LiteLLM generation provider failed.';

const TRANSLATION_RESPONSE_FORMAT = {
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
          maxLength: MAX_TEXT_LENGTH
        }
      }
    }
  }
} as const;

const SUGGESTION_RESPONSE_FORMAT = {
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
                maxLength: MAX_TEXT_LENGTH
              },
              selectedTargetText: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_TEXT_LENGTH
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
  readonly max_tokens: number;
  readonly messages: readonly ChatMessage[];
  readonly response_format:
    | typeof TRANSLATION_RESPONSE_FORMAT
    | typeof SUGGESTION_RESPONSE_FORMAT;
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

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseTranslation(value: unknown): GenerationProviderTranslation {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ['englishTranslation']) ||
    !isBoundedText(value.englishTranslation)
  ) {
    throw providerFailure();
  }

  return { englishTranslation: value.englishTranslation };
}

function parseSuggestions(
  value: unknown
): { readonly suggestions: readonly SuggestionPhrasePair[] } {
  if (!isRecord(value) || !hasExactlyKeys(value, ['suggestions'])) {
    throw providerFailure();
  }
  const suggestions = value.suggestions;
  if (!Array.isArray(suggestions) || suggestions.length < 2 || suggestions.length > 3) {
    throw providerFailure();
  }

  const parsed: SuggestionPhrasePair[] = [];
  for (const item of suggestions) {
    if (
      !isRecord(item) ||
      !hasExactlyKeys(item, ['englishText', 'selectedTargetText']) ||
      !isBoundedText(item.englishText) ||
      !isBoundedText(item.selectedTargetText)
    ) {
      throw providerFailure();
    }
    parsed.push({
      englishText: item.englishText,
      selectedTargetText: item.selectedTargetText
    });
  }

  return { suggestions: parsed };
}

async function readResponseText(response: Response, maxResponseBytes: number): Promise<string> {
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
    if (reader !== undefined) {
      try {
        await reader.cancel();
      } catch {
        // The response has already failed; preserve the generic provider error.
      }
    }
    throw providerFailure();
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
    (Object.hasOwn(message, 'refusal') && message.refusal !== null)
  ) {
    throw providerFailure();
  }
  if (!Object.hasOwn(message, 'content') || typeof message.content !== 'string') {
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
  readonly #maxTokens: number;

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
      this.#maxTokens = boundedInteger(config.maxTokens, DEFAULT_MAX_TOKENS, MAX_TOKENS);
      this.id = providerValue(config.id, 'litellm-chat');
      this.version = providerValue(config.version, '1.0.0');
    } catch {
      throw new TypeError(PROVIDER_CONFIGURATION_ERROR);
    }
  }

  async translate(
    input: GenerationProviderTranslateInput
  ): Promise<GenerationProviderTranslation> {
    try {
      const request: ChatCompletionRequest = {
        model: this.#model,
        stream: false,
        max_tokens: this.#maxTokens,
        messages: [
          {
            role: 'system',
            content: 'Translate from the selected target language to English. Output JSON only.'
          },
          {
            role: 'user',
            content: `Selected target language: ${input.selectedTargetLanguage}\nText to translate: ${input.targetTranscript}`
          }
        ],
        response_format: TRANSLATION_RESPONSE_FORMAT
      };
      const content = await this.#request(request);
      return parseTranslation(JSON.parse(content) as unknown);
    } catch {
      throw providerFailure();
    }
  }

  async suggest(
    input: GenerationProviderSuggestInput
  ): Promise<{ readonly suggestions: readonly SuggestionPhrasePair[] }> {
    try {
      const request: ChatCompletionRequest = {
        model: this.#model,
        stream: false,
        max_tokens: this.#maxTokens,
        messages: [
          {
            role: 'system',
            content: 'Suggest 2-3 concise likely English responses and their selected-target-language equivalents. Output JSON only.'
          },
          {
            role: 'user',
            content: `Selected target language: ${input.selectedTargetLanguage}\nTarget-language transcript: ${input.targetTranscript}\nEnglish translation: ${input.englishTranslation}`
          }
        ],
        response_format: SUGGESTION_RESPONSE_FORMAT
      };
      const content = await this.#request(request);
      return parseSuggestions(JSON.parse(content) as unknown);
    } catch {
      throw providerFailure();
    }
  }

  async #request(request: ChatCompletionRequest): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
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
          // The response has already failed; preserve the generic provider error.
        }
        throw providerFailure();
      }
      const text = await readResponseText(response, this.#maxResponseBytes);
      const envelope = JSON.parse(text) as unknown;
      return responseContent(envelope, this.#maxResponseBytes);
    } catch {
      throw providerFailure();
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type LiteLLMGenerationProviderConfig = LiteLLMChatGenerationProviderConfig;
