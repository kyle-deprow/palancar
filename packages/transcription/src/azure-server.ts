import { MAX_CONTROL_MESSAGE_BYTES } from '@palancar/contracts';

export const MAX_AZURE_REALTIME_SERVER_EVENT_JSON_BYTES = MAX_CONTROL_MESSAGE_BYTES;
export const DEFAULT_AZURE_REALTIME_SERVER_EVENT_MAX_BYTES =
  MAX_AZURE_REALTIME_SERVER_EVENT_JSON_BYTES;
export const MAX_AZURE_REALTIME_SERVER_JSON_BYTES =
  MAX_AZURE_REALTIME_SERVER_EVENT_JSON_BYTES;
export const MAX_AZURE_REALTIME_SERVER_EVENT_BYTES =
  MAX_AZURE_REALTIME_SERVER_EVENT_JSON_BYTES;

export const MAX_AZURE_REALTIME_SERVER_TEXT_BYTES = 4_096 as const;
export const MAX_AZURE_REALTIME_SERVER_TRANSCRIPT_BYTES =
  MAX_AZURE_REALTIME_SERVER_TEXT_BYTES;
export const MAX_AZURE_REALTIME_SERVER_CONTENT_INDEX = 255 as const;
export const MAX_AZURE_REALTIME_SERVER_LOGPROBS = 128 as const;
export const MAX_AZURE_REALTIME_SERVER_LOGPROB_TOKEN_BYTES = 256 as const;
export const MAX_AZURE_REALTIME_SERVER_LOGPROB_BYTES = 256 as const;
export const MAX_AZURE_REALTIME_SERVER_EVENT_ID_BYTES = 128 as const;
export const MAX_AZURE_REALTIME_SERVER_OBFUSCATION_BYTES = 256 as const;
export const MAX_AZURE_REALTIME_SERVER_PROVIDER_STRING_BYTES = 256 as const;
export const MAX_AZURE_REALTIME_SERVER_LANGUAGE_CODE_BYTES = 2 as const;
export const MAX_AZURE_REALTIME_SERVER_LANGUAGES = 16 as const;
export const MAX_AZURE_REALTIME_SERVER_KEYWORDS = 64 as const;
export const MAX_AZURE_REALTIME_SERVER_KEYWORD_BYTES = 256 as const;
export const MAX_AZURE_REALTIME_SERVER_USAGE_COUNT = 1_000_000 as const;
export const MAX_AZURE_REALTIME_SERVER_DEPLOYMENT_BYTES = 64 as const;
export const MAX_AZURE_REALTIME_SERVER_TURN_DETECTION_MS = 60_000 as const;
export const MAX_AZURE_REALTIME_SERVER_AUDIO_OFFSET_MS = 86_400_000 as const;
export const MAX_AZURE_REALTIME_SERVER_SEGMENT_SECONDS = 86_400 as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEPLOYMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
// Dedicated transcription streams plus the VAD and item lifecycle events
// documented as companions to automatic/manual input-audio commits.
const EVENT_TYPES = new Set([
  'session.created',
  'session.updated',
  'rate_limits.updated',
  'input_audio_buffer.committed',
  'input_audio_buffer.cleared',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.timeout_triggered',
  'conversation.item.created',
  'conversation.item.added',
  'conversation.item.done',
  'conversation.item.input_audio_transcription.delta',
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.input_audio_transcription.segment',
  'conversation.item.input_audio_transcription.failed',
  'error'
] as const);
const AUDIO_FORMAT_TYPES = new Set([
  'audio/pcm',
  'audio/pcmu',
  'audio/pcma'
] as const);
const INCLUDE_VALUES = new Set([
  'item.input_audio_transcription.logprobs'
] as const);
const LANGUAGE_CODE = /^[a-z]{2}$/;
const ISO_639_1_LANGUAGE_CODES = new Set<string>([
  'aa', 'ab', 'ae', 'af', 'ak', 'am', 'an', 'ar', 'as', 'av', 'ay', 'az',
  'ba', 'be', 'bg', 'bh', 'bi', 'bm', 'bn', 'bo', 'br', 'bs',
  'ca', 'ce', 'ch', 'co', 'cr', 'cs', 'cu', 'cv', 'cy',
  'da', 'de', 'dv', 'dz',
  'ee', 'el', 'en', 'eo', 'es', 'et', 'eu',
  'fa', 'ff', 'fi', 'fj', 'fo', 'fr', 'fy',
  'ga', 'gd', 'gl', 'gn', 'gu', 'gv',
  'ha', 'he', 'hi', 'ho', 'hr', 'ht', 'hu', 'hy', 'hz',
  'ia', 'id', 'ie', 'ig', 'ii', 'ik', 'io', 'is', 'it', 'iu',
  'ja', 'jv',
  'ka', 'kg', 'ki', 'kj', 'kk', 'kl', 'km', 'kn', 'ko', 'kr', 'ks', 'ku',
  'kv', 'kw', 'ky',
  'la', 'lb', 'lg', 'li', 'ln', 'lo', 'lt', 'lu', 'lv',
  'mg', 'mh', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my',
  'na', 'nb', 'nd', 'ne', 'ng', 'nl', 'nn', 'no', 'nr', 'nv', 'ny',
  'oc', 'oj', 'om', 'or', 'os',
  'pa', 'pi', 'pl', 'ps', 'pt',
  'qu',
  'rm', 'rn', 'ro', 'ru', 'rw',
  'sa', 'sc', 'sd', 'se', 'sg', 'si', 'sk', 'sl', 'sm', 'sn', 'so', 'sq',
  'sr', 'ss', 'st', 'su', 'sv', 'sw',
  'ta', 'te', 'tg', 'th', 'ti', 'tk', 'tl', 'tn', 'to', 'tr', 'ts', 'tt',
  'tw', 'ty',
  'ug', 'uk', 'ur', 'uz',
  've', 'vi', 'vo',
  'wa', 'wo',
  'xh',
  'yi', 'yo',
  'za', 'zh', 'zu'
]);
const TRANSCRIPTION_DELAYS = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
] as const);
const SEMANTIC_VAD_EAGERNESS = new Set([
  'auto',
  'low',
  'medium',
  'high'
] as const);

export type AzureRealtimeServerEventType =
  | 'session.created'
  | 'session.updated'
  | 'rate_limits.updated'
  | 'input_audio_buffer.committed'
  | 'input_audio_buffer.cleared'
  | 'input_audio_buffer.speech_started'
  | 'input_audio_buffer.speech_stopped'
  | 'input_audio_buffer.timeout_triggered'
  | 'conversation.item.created'
  | 'conversation.item.added'
  | 'conversation.item.done'
  | 'conversation.item.input_audio_transcription.delta'
  | 'conversation.item.input_audio_transcription.completed'
  | 'conversation.item.input_audio_transcription.segment'
  | 'conversation.item.input_audio_transcription.failed'
  | 'error';

export type AzureRealtimeServerFailureCategory =
  | 'provider-failure'
  | 'protocol-failure';

export interface AzureRealtimeLogprobsSummary {
  readonly count: number;
  readonly present: boolean;
}

export interface AzureRealtimeSessionSummary {
  readonly type: 'transcription';
  readonly id: string;
  readonly phase: 'basic' | 'configured';
  readonly configured: boolean;
}

export interface AzureRealtimeSessionEvent {
  readonly type: 'session.created' | 'session.updated';
  readonly session: AzureRealtimeSessionSummary;
}

export interface AzureRealtimeRateLimitsUpdatedEvent {
  readonly type: 'rate_limits.updated';
  readonly category: 'advisory';
}

export interface AzureRealtimeInputAudioCommittedEvent {
  readonly type: 'input_audio_buffer.committed';
  readonly item_id: string;
  readonly previous_item_id: string | null;
}

export interface AzureRealtimeInputAudioClearedEvent {
  readonly type: 'input_audio_buffer.cleared';
}

export interface AzureRealtimeIgnoredTranscriptionStreamEvent {
  readonly type:
    | 'input_audio_buffer.speech_started'
    | 'input_audio_buffer.speech_stopped'
    | 'input_audio_buffer.timeout_triggered';
  readonly category: 'ignored';
}

export interface AzureRealtimeConversationItemCreatedEvent {
  readonly type: 'conversation.item.created';
  readonly category: 'ignored';
  readonly item_id: string;
  readonly previous_item_id: string | null;
}

export interface AzureRealtimeConversationItemAddedEvent {
  readonly type: 'conversation.item.added';
  readonly category: 'ignored';
  readonly item_id: string;
  readonly previous_item_id: string | null;
}

export interface AzureRealtimeConversationItemDoneEvent {
  readonly type: 'conversation.item.done';
  readonly category: 'ignored';
  readonly item_id: string;
  readonly previous_item_id: string | null;
}

export type AzureRealtimeConversationItemLifecycleEvent =
  | AzureRealtimeConversationItemCreatedEvent
  | AzureRealtimeConversationItemAddedEvent
  | AzureRealtimeConversationItemDoneEvent;

export interface AzureRealtimeInputAudioTranscriptionDeltaEvent {
  readonly type: 'conversation.item.input_audio_transcription.delta';
  readonly item_id: string;
  readonly content_index: number;
  readonly delta: string;
  readonly obfuscation?: string;
  readonly logprobs?: AzureRealtimeLogprobsSummary;
}

export interface AzureRealtimeTranscriptionTokenUsage {
  readonly type: 'tokens';
  readonly total_tokens: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly input_token_details?: Readonly<{
    readonly text_tokens?: number;
    readonly audio_tokens?: number;
  }>;
}

export interface AzureRealtimeTranscriptionDurationUsage {
  readonly type: 'duration';
  readonly seconds: number;
}

export type AzureRealtimeTranscriptionUsage =
  | AzureRealtimeTranscriptionTokenUsage
  | AzureRealtimeTranscriptionDurationUsage;

export interface AzureRealtimeLanguageSummary {
  readonly count: number;
  readonly codes: readonly string[];
}

export interface AzureRealtimeInputAudioTranscriptionCompletedEvent {
  readonly type: 'conversation.item.input_audio_transcription.completed';
  readonly item_id: string;
  readonly content_index: number;
  readonly transcript: string;
  readonly languages?: AzureRealtimeLanguageSummary;
  readonly usage: AzureRealtimeTranscriptionUsage;
  readonly logprobs?: AzureRealtimeLogprobsSummary;
}

export interface AzureRealtimeInputAudioTranscriptionSegmentEvent {
  readonly type: 'conversation.item.input_audio_transcription.segment';
  readonly id: string;
  readonly item_id: string;
  readonly content_index: number;
  readonly text: string;
  readonly speaker: string;
  readonly start: number;
  readonly end: number;
}

export interface AzureRealtimeInputAudioTranscriptionFailedEvent {
  readonly type: 'conversation.item.input_audio_transcription.failed';
  readonly item_id: string;
  readonly content_index: number;
  readonly category: 'provider-failure';
}

export interface AzureRealtimeErrorEvent {
  readonly type: 'error';
  readonly category: 'protocol-failure';
}

export type AzureRealtimeServerEvent =
  | AzureRealtimeSessionEvent
  | AzureRealtimeRateLimitsUpdatedEvent
  | AzureRealtimeInputAudioCommittedEvent
  | AzureRealtimeInputAudioClearedEvent
  | AzureRealtimeIgnoredTranscriptionStreamEvent
  | AzureRealtimeConversationItemLifecycleEvent
  | AzureRealtimeInputAudioTranscriptionDeltaEvent
  | AzureRealtimeInputAudioTranscriptionCompletedEvent
  | AzureRealtimeInputAudioTranscriptionSegmentEvent
  | AzureRealtimeInputAudioTranscriptionFailedEvent
  | AzureRealtimeErrorEvent;

export type AzureRealtimeServerEventResult = AzureRealtimeServerEvent;

export type AzureRealtimeServerEventErrorReason =
  | 'invalid-input'
  | 'oversize'
  | 'invalid-json'
  | 'invalid-event'
  | 'invalid-field';

const ERROR_MESSAGES: Readonly<Record<AzureRealtimeServerEventErrorReason, string>> =
  Object.freeze({
    'invalid-input': 'Invalid Azure Realtime server event input.',
    oversize: 'Azure Realtime server event exceeds the maximum size.',
    'invalid-json': 'Azure Realtime server event is not valid JSON.',
    'invalid-event': 'Invalid Azure Realtime server event.',
    'invalid-field': 'Invalid Azure Realtime server event field.'
  });

export class AzureRealtimeServerEventError extends TypeError {
  readonly reason: AzureRealtimeServerEventErrorReason;

  constructor(reason: AzureRealtimeServerEventErrorReason) {
    super(ERROR_MESSAGES[reason]);
    this.name = 'AzureRealtimeServerEventError';
    this.reason = reason;
  }
}

export { AzureRealtimeServerEventError as AzureRealtimeServerError };

export interface AzureRealtimeServerEventParserOptions {
  /**
   * Azure deployment selected for this WebSocket. A session is ready only when a
   * session.updated event echoes this exact deployment with PCM24k and manual commit.
   */
  readonly expectedDeployment: string;
  readonly maxJsonBytes?: number;
  readonly maxBytes?: number;
}

const TEXT_ENCODER = new TextEncoder();
const FATAL_TEXT_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true
});

function fail(reason: AzureRealtimeServerEventErrorReason): never {
  throw new AzureRealtimeServerEventError(reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownKeys(value: object): readonly string[] {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail('invalid-field');
  }

  const keys = Object.getOwnPropertyNames(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || 'get' in descriptor || 'set' in descriptor) {
      fail('invalid-field');
    }
  }
  return keys;
}

function hasExactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = ownKeys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length) {
    return false;
  }
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function valueOf(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.value;
}

function isValidUnicodeString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function encodeBoundedValidUnicode(
  value: string,
  maxBytes: number
): Uint8Array | undefined {
  const bytes = new Uint8Array(maxBytes);
  const result = TEXT_ENCODER.encodeInto(value, bytes);
  if (result.read !== value.length || result.written > maxBytes) {
    return undefined;
  }
  return bytes.subarray(0, result.written);
}

function isBoundedString(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxBytes ||
    !isValidUnicodeString(value)
  ) {
    return false;
  }
  return encodeBoundedValidUnicode(value, maxBytes) !== undefined;
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return isBoundedString(value, maxBytes);
}

function isIdentifier(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_AZURE_REALTIME_SERVER_EVENT_ID_BYTES) &&
    ID_PATTERN.test(value)
  );
}

function isContentIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_AZURE_REALTIME_SERVER_CONTENT_INDEX
  );
}

function isUsageCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_AZURE_REALTIME_SERVER_USAGE_COUNT
  );
}

function validateEventId(event: object): void {
  if (!Object.hasOwn(event, 'event_id') || !isIdentifier(valueOf(event, 'event_id'))) {
    fail('invalid-field');
  }
}

function validateGeneralErrorDetails(value: unknown): void {
  if (!isPlainObject(value) || !hasExactKeys(
    value,
    ['type', 'message'],
    ['code', 'param', 'event_id']
  )) {
    fail('invalid-field');
  }

  const type = valueOf(value, 'type');
  const code = valueOf(value, 'code');
  const message = valueOf(value, 'message');
  const param = valueOf(value, 'param');
  const eventId = valueOf(value, 'event_id');

  if (!isBoundedString(
    type,
    MAX_AZURE_REALTIME_SERVER_PROVIDER_STRING_BYTES
  )) {
    fail('invalid-field');
  }
  if (code !== undefined && code !== null && !isBoundedString(
    code,
    MAX_AZURE_REALTIME_SERVER_PROVIDER_STRING_BYTES,
    true
  )) {
    fail('invalid-field');
  }
  if (!isBoundedString(
    message,
    MAX_AZURE_REALTIME_SERVER_PROVIDER_STRING_BYTES
  )) {
    fail('invalid-field');
  }
  if (param !== undefined && param !== null && !isBoundedString(
    param,
    MAX_AZURE_REALTIME_SERVER_PROVIDER_STRING_BYTES,
    true
  )) {
    fail('invalid-field');
  }
  if (
    eventId !== undefined &&
    eventId !== null &&
    !isBoundedString(
      eventId,
      MAX_AZURE_REALTIME_SERVER_EVENT_ID_BYTES,
      true
    )
  ) {
    fail('invalid-field');
  }
}

function validateTranscriptionErrorDetails(value: unknown): void {
  if (!isPlainObject(value) || !hasExactKeys(
    value,
    [],
    ['type', 'code', 'message', 'param']
  )) {
    fail('invalid-field');
  }
  const type = valueOf(value, 'type');
  const code = valueOf(value, 'code');
  const message = valueOf(value, 'message');
  const param = valueOf(value, 'param');
  if (
    (type !== undefined && !isBoundedString(
      type,
      MAX_AZURE_REALTIME_SERVER_PROVIDER_STRING_BYTES
    )) ||
    (code !== undefined && !isBoundedString(
      code,
      MAX_AZURE_REALTIME_SERVER_PROVIDER_STRING_BYTES,
      true
    )) ||
    (message !== undefined && !isBoundedString(
      message,
      MAX_AZURE_REALTIME_SERVER_PROVIDER_STRING_BYTES
    )) ||
    (param !== undefined && param !== null && !isBoundedString(
      param,
      MAX_AZURE_REALTIME_SERVER_PROVIDER_STRING_BYTES,
      true
    ))
  ) {
    fail('invalid-field');
  }
}

function validateLogprobBytes(value: unknown): void {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('invalid-field');
  }
  if (value.length > MAX_AZURE_REALTIME_SERVER_LOGPROB_BYTES) {
    fail('invalid-field');
  }
  const keys = ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    !keys.includes('length') ||
    keys.some((key) => key !== 'length' && !/^\d+$/.test(key))
  ) {
    fail('invalid-field');
  }
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      fail('invalid-field');
    }
  }
}

function validateLogprobRecord(value: unknown): void {
  if (!isPlainObject(value) || !hasExactKeys(value, ['token', 'bytes', 'logprob'])) {
    fail('invalid-field');
  }
  const token = valueOf(value, 'token');
  const bytes = valueOf(value, 'bytes');
  const logprob = valueOf(value, 'logprob');
  if (
    !isBoundedText(token, MAX_AZURE_REALTIME_SERVER_LOGPROB_TOKEN_BYTES) ||
    typeof logprob !== 'number' ||
    !Number.isFinite(logprob)
  ) {
    fail('invalid-field');
  }
  validateLogprobBytes(bytes);
}

function parseLogprobs(value: unknown): AzureRealtimeLogprobsSummary {
  if (value === null) {
    return Object.freeze({ count: 0, present: false });
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('invalid-field');
  }
  if (value.length > MAX_AZURE_REALTIME_SERVER_LOGPROBS) {
    fail('invalid-field');
  }
  const keys = ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    !keys.includes('length') ||
    keys.some((key) => key !== 'length' && !/^\d+$/.test(key))
  ) {
    fail('invalid-field');
  }
  for (let index = 0; index < value.length; index += 1) {
    validateLogprobRecord(value[index]);
  }
  return Object.freeze({ count: value.length, present: true });
}

function optionalLogprobs(
  event: object
): AzureRealtimeLogprobsSummary | undefined {
  if (!Object.hasOwn(event, 'logprobs')) {
    return undefined;
  }
  return parseLogprobs(valueOf(event, 'logprobs'));
}

function validateSessionFormat(value: unknown): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, [], ['type', 'rate'])) {
    fail('invalid-field');
  }
  const type = valueOf(value, 'type');
  const rate = valueOf(value, 'rate');
  if (type === undefined) {
    if (rate !== undefined && rate !== 24_000) {
      fail('invalid-field');
    }
    return false;
  }
  if (!AUDIO_FORMAT_TYPES.has(type as 'audio/pcm' | 'audio/pcmu' | 'audio/pcma')) {
    fail('invalid-field');
  }
  if (type === 'audio/pcm') {
    if (rate !== undefined && rate !== 24_000) {
      fail('invalid-field');
    }
  } else if (rate !== undefined) {
    fail('invalid-field');
  }
  return type === 'audio/pcm' && rate === 24_000;
}

function isLanguageCode(value: unknown): value is string {
  return isBoundedString(
    value,
    MAX_AZURE_REALTIME_SERVER_LANGUAGE_CODE_BYTES
  ) && LANGUAGE_CODE.test(value) && ISO_639_1_LANGUAGE_CODES.has(value);
}

function validateSessionLanguageCodes(value: unknown): void {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('invalid-field');
  }
  if (value.length < 1 || value.length > MAX_AZURE_REALTIME_SERVER_LANGUAGES) {
    fail('invalid-field');
  }
  const keys = ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    !keys.includes('length') ||
    keys.some((key) => key !== 'length' && !/^\d+$/.test(key))
  ) {
    fail('invalid-field');
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!isLanguageCode(value[index])) {
      fail('invalid-field');
    }
  }
}

function validateSessionKeywords(value: unknown): void {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('invalid-field');
  }
  if (value.length > MAX_AZURE_REALTIME_SERVER_KEYWORDS) {
    fail('invalid-field');
  }
  const keys = ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    !keys.includes('length') ||
    keys.some((key) => key !== 'length' && !/^\d+$/.test(key))
  ) {
    fail('invalid-field');
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!isBoundedString(
      value[index],
      MAX_AZURE_REALTIME_SERVER_KEYWORD_BYTES,
      true
    )) {
      fail('invalid-field');
    }
  }
}

function validateSessionTranscription(
  value: unknown,
  expectedDeployment: string
): boolean {
  if (!isPlainObject(value) || !hasExactKeys(
    value,
    [],
    ['model', 'language', 'languages', 'keywords', 'prompt', 'delay']
  )) {
    fail('invalid-field');
  }
  const model = valueOf(value, 'model');
  const language = valueOf(value, 'language');
  const languages = valueOf(value, 'languages');
  const keywords = valueOf(value, 'keywords');
  const prompt = valueOf(value, 'prompt');
  const delay = valueOf(value, 'delay');
  if (model !== undefined && !isBoundedString(
    model,
    MAX_AZURE_REALTIME_SERVER_PROVIDER_STRING_BYTES
  )) {
    fail('invalid-field');
  }
  if (language !== undefined && language !== null && !isLanguageCode(language)) {
    fail('invalid-field');
  }
  if (languages !== undefined) {
    validateSessionLanguageCodes(languages);
  }
  if (keywords !== undefined) {
    validateSessionKeywords(keywords);
  }
  if (prompt !== undefined && prompt !== null && !isBoundedString(
    prompt,
    MAX_AZURE_REALTIME_SERVER_TEXT_BYTES,
    true
  )) {
    fail('invalid-field');
  }
  if (delay !== undefined && !TRANSCRIPTION_DELAYS.has(
    delay as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  )) {
    fail('invalid-field');
  }
  return model === expectedDeployment;
}

function validateSessionNoiseReduction(value: unknown): void {
  if (!isPlainObject(value) || !hasExactKeys(value, [], ['type'])) {
    fail('invalid-field');
  }
  const type = valueOf(value, 'type');
  if (type === undefined) {
    return;
  }
  if (type !== 'near_field' && type !== 'far_field') {
    fail('invalid-field');
  }
}

function validateSessionTurnDetection(value: unknown): void {
  if (!isPlainObject(value)) {
    fail('invalid-field');
  }
  const type = valueOf(value, 'type');
  if (type === 'server_vad') {
    if (!hasExactKeys(value, ['type'], [
      'threshold',
      'prefix_padding_ms',
      'silence_duration_ms',
      'create_response',
      'interrupt_response',
      'idle_timeout_ms'
    ])) {
      fail('invalid-field');
    }
    const threshold = valueOf(value, 'threshold');
    const prefixPaddingMs = valueOf(value, 'prefix_padding_ms');
    const silenceDurationMs = valueOf(value, 'silence_duration_ms');
    const createResponse = valueOf(value, 'create_response');
    const interruptResponse = valueOf(value, 'interrupt_response');
    const idleTimeoutMs = valueOf(value, 'idle_timeout_ms');
    if (
      (threshold !== undefined && (
        typeof threshold !== 'number' || !Number.isFinite(threshold) ||
        threshold < 0 || threshold > 1
      )) ||
      (prefixPaddingMs !== undefined && !isBoundedMilliseconds(prefixPaddingMs)) ||
      (silenceDurationMs !== undefined && !isBoundedMilliseconds(silenceDurationMs)) ||
      (createResponse !== undefined && typeof createResponse !== 'boolean') ||
      (interruptResponse !== undefined && typeof interruptResponse !== 'boolean') ||
      (idleTimeoutMs !== undefined && idleTimeoutMs !== null &&
        !isBoundedMilliseconds(idleTimeoutMs))
    ) {
      fail('invalid-field');
    }
    return;
  }
  if (type === 'semantic_vad') {
    if (!hasExactKeys(value, ['type'], [
      'create_response',
      'interrupt_response',
      'eagerness'
    ])) {
      fail('invalid-field');
    }
    const createResponse = valueOf(value, 'create_response');
    const interruptResponse = valueOf(value, 'interrupt_response');
    const eagerness = valueOf(value, 'eagerness');
    if (
      (createResponse !== undefined && typeof createResponse !== 'boolean') ||
      (interruptResponse !== undefined && typeof interruptResponse !== 'boolean') ||
      (eagerness !== undefined && !SEMANTIC_VAD_EAGERNESS.has(
        eagerness as 'auto' | 'low' | 'medium' | 'high'
      ))
    ) {
      fail('invalid-field');
    }
    return;
  }
  fail('invalid-field');
}

function isBoundedMilliseconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_AZURE_REALTIME_SERVER_TURN_DETECTION_MS
  );
}

function isBoundedAudioOffset(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_AZURE_REALTIME_SERVER_AUDIO_OFFSET_MS
  );
}

function isBoundedSegmentSecond(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_AZURE_REALTIME_SERVER_SEGMENT_SECONDS
  );
}

function validateSessionAudio(value: unknown, expectedDeployment: string): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, [], ['input'])) {
    fail('invalid-field');
  }
  if (!Object.hasOwn(value, 'input')) {
    return false;
  }

  const input = valueOf(value, 'input');
  if (!isPlainObject(input) || !hasExactKeys(
    input,
    [],
    ['format', 'transcription', 'noise_reduction', 'turn_detection']
  )) {
    fail('invalid-field');
  }

  const hasFormat = Object.hasOwn(input, 'format');
  const hasTranscription = Object.hasOwn(input, 'transcription');
  const hasTurnDetection = Object.hasOwn(input, 'turn_detection');
  let expectedFormat = false;
  let expectedModel = false;
  if (hasFormat) {
    expectedFormat = validateSessionFormat(valueOf(input, 'format'));
  }
  if (hasTranscription) {
    const transcription = valueOf(input, 'transcription');
    if (transcription !== null) {
      expectedModel = validateSessionTranscription(
        transcription,
        expectedDeployment
      );
    }
  }

  if (Object.hasOwn(input, 'noise_reduction')) {
    const noiseReduction = valueOf(input, 'noise_reduction');
    if (noiseReduction !== null) {
      validateSessionNoiseReduction(noiseReduction);
    }
  }
  if (Object.hasOwn(input, 'turn_detection')) {
    const turnDetection = valueOf(input, 'turn_detection');
    if (turnDetection !== null) {
      validateSessionTurnDetection(turnDetection);
    }
  }
  return (
    hasFormat &&
    hasTranscription &&
    hasTurnDetection &&
    expectedFormat &&
    expectedModel &&
    valueOf(input, 'turn_detection') === null
  );
}

function validateSessionInclude(value: unknown): void {
  if (value === null) {
    return;
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('invalid-field');
  }
  if (value.length > MAX_AZURE_REALTIME_SERVER_LANGUAGES) {
    fail('invalid-field');
  }
  const keys = ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    !keys.includes('length') ||
    keys.some((key) => key !== 'length' && !/^\d+$/.test(key))
  ) {
    fail('invalid-field');
  }
  for (let index = 0; index < value.length; index += 1) {
    const include = value[index];
    if (
      typeof include !== 'string' ||
      !INCLUDE_VALUES.has(include as 'item.input_audio_transcription.logprobs')
    ) {
      fail('invalid-field');
    }
  }
}

function parseSession(
  value: unknown,
  eventType: 'session.created' | 'session.updated',
  expectedDeployment: string
): AzureRealtimeSessionSummary {
  if (!isPlainObject(value) || !hasExactKeys(
    value,
    ['type', 'object', 'id'],
    ['expires_at', 'include', 'audio']
  )) {
    fail('invalid-event');
  }
  const type = valueOf(value, 'type');
  const object = valueOf(value, 'object');
  const id = valueOf(value, 'id');
  const expiresAt = valueOf(value, 'expires_at');
  if (
    type !== 'transcription' ||
    object !== 'realtime.transcription_session' ||
    !isIdentifier(id)
  ) {
    fail('invalid-field');
  }
  if (expiresAt !== undefined && (
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 0
  )) {
    fail('invalid-field');
  }
  const hasAudio = Object.hasOwn(value, 'audio');
  let hasConfiguredAudio = false;
  if (hasAudio) {
    hasConfiguredAudio = validateSessionAudio(
      valueOf(value, 'audio'),
      expectedDeployment
    );
  }
  if (Object.hasOwn(value, 'include')) {
    validateSessionInclude(valueOf(value, 'include'));
  }
  const configured = eventType === 'session.updated' && hasConfiguredAudio;
  return Object.freeze({
    type: 'transcription',
    id,
    phase: configured ? 'configured' : 'basic',
    configured
  });
}

function parseLanguages(value: unknown): AzureRealtimeLanguageSummary {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('invalid-field');
  }
  if (value.length > MAX_AZURE_REALTIME_SERVER_LANGUAGES) {
    fail('invalid-field');
  }
  const keys = ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    !keys.includes('length') ||
    keys.some((key) => key !== 'length' && !/^\d+$/.test(key))
  ) {
    fail('invalid-field');
  }
  const codes: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const language = value[index];
    if (!isPlainObject(language) || !hasExactKeys(language, ['code'])) {
      fail('invalid-field');
    }
    const code = valueOf(language, 'code');
    if (!isLanguageCode(code)) {
      fail('invalid-field');
    }
    codes.push(code);
  }
  return Object.freeze({
    count: codes.length,
    codes: Object.freeze(codes)
  });
}

function parseUsage(value: unknown): AzureRealtimeTranscriptionUsage {
  if (!isPlainObject(value)) {
    fail('invalid-field');
  }
  const type = valueOf(value, 'type');
  if (type === 'tokens') {
    if (!hasExactKeys(value, ['type', 'total_tokens', 'input_tokens', 'output_tokens'], [
      'input_token_details'
    ])) {
      fail('invalid-field');
    }
    const totalTokens = valueOf(value, 'total_tokens');
    const inputTokens = valueOf(value, 'input_tokens');
    const outputTokens = valueOf(value, 'output_tokens');
    const details = valueOf(value, 'input_token_details');
    if (
      !isUsageCount(totalTokens) ||
      !isUsageCount(inputTokens) ||
      !isUsageCount(outputTokens) ||
      totalTokens !== inputTokens + outputTokens
    ) {
      fail('invalid-field');
    }

    let inputTokenDetails: Readonly<{
      readonly text_tokens?: number;
      readonly audio_tokens?: number;
    }> | undefined;
    if (details !== undefined) {
      if (!isPlainObject(details) || !hasExactKeys(
        details,
        [],
        ['text_tokens', 'audio_tokens']
      )) {
        fail('invalid-field');
      }
      const hasTextTokens = Object.hasOwn(details, 'text_tokens');
      const hasAudioTokens = Object.hasOwn(details, 'audio_tokens');
      const textTokens = valueOf(details, 'text_tokens');
      const audioTokens = valueOf(details, 'audio_tokens');
      if (
        (hasTextTokens && !isUsageCount(textTokens)) ||
        (hasAudioTokens && !isUsageCount(audioTokens)) ||
        (hasTextTokens && (textTokens as number) > inputTokens) ||
        (hasAudioTokens && (audioTokens as number) > inputTokens) ||
        (hasTextTokens && hasAudioTokens &&
          (textTokens as number) + (audioTokens as number) !== inputTokens)
      ) {
        fail('invalid-field');
      }
      inputTokenDetails = Object.freeze({
        ...(hasTextTokens ? { text_tokens: textTokens as number } : {}),
        ...(hasAudioTokens ? { audio_tokens: audioTokens as number } : {})
      });
    }
    return Object.freeze({
      type: 'tokens',
      total_tokens: totalTokens,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(inputTokenDetails === undefined ? {} : { input_token_details: inputTokenDetails })
    });
  }

  if (type === 'duration') {
    if (!hasExactKeys(value, ['type', 'seconds'])) {
      fail('invalid-field');
    }
    const seconds = valueOf(value, 'seconds');
    if (
      typeof seconds !== 'number' ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds > MAX_AZURE_REALTIME_SERVER_USAGE_COUNT
    ) {
      fail('invalid-field');
    }
    return Object.freeze({ type: 'duration', seconds });
  }

  fail('invalid-field');
}

function validateInputAudioUserMessageItem(value: unknown): string {
  if (!isPlainObject(value) || !hasExactKeys(
    value,
    ['type', 'role', 'content'],
    ['id', 'object', 'status']
  )) {
    fail('invalid-field');
  }
  const id = valueOf(value, 'id');
  const object = valueOf(value, 'object');
  const status = valueOf(value, 'status');
  if (
    valueOf(value, 'type') !== 'message' ||
    valueOf(value, 'role') !== 'user' ||
    !isIdentifier(id) ||
    (object !== undefined && object !== 'realtime.item') ||
    (status !== undefined && status !== 'completed' &&
      status !== 'incomplete' && status !== 'in_progress')
  ) {
    fail('invalid-field');
  }

  const content = valueOf(value, 'content');
  if (
    !Array.isArray(content) ||
    Object.getPrototypeOf(content) !== Array.prototype ||
    content.length !== 1
  ) {
    fail('invalid-field');
  }
  const keys = ownKeys(content);
  if (
    keys.length !== 2 ||
    !keys.includes('0') ||
    !keys.includes('length')
  ) {
    fail('invalid-field');
  }
  const audio = content[0];
  if (!isPlainObject(audio) || !hasExactKeys(audio, ['type'], ['transcript'])) {
    fail('invalid-field');
  }
  const transcript = valueOf(audio, 'transcript');
  if (
    valueOf(audio, 'type') !== 'input_audio' ||
    (transcript !== undefined && transcript !== null && !isBoundedString(
      transcript,
      MAX_AZURE_REALTIME_SERVER_TEXT_BYTES,
      true
    ))
  ) {
    fail('invalid-field');
  }
  return id;
}

function parseIgnoredTranscriptionStreamEvent(
  value: Record<string, unknown>,
  type: AzureRealtimeIgnoredTranscriptionStreamEvent['type'] |
    AzureRealtimeConversationItemLifecycleEvent['type']
): AzureRealtimeIgnoredTranscriptionStreamEvent | AzureRealtimeConversationItemLifecycleEvent {
  if (type === 'conversation.item.created' ||
      type === 'conversation.item.added' ||
      type === 'conversation.item.done') {
    if (!hasExactKeys(
      value,
      ['type', 'event_id', 'item'],
      ['previous_item_id']
    )) {
      fail('invalid-event');
    }
    const previousItemId = valueOf(value, 'previous_item_id');
    if (previousItemId !== undefined && previousItemId !== null &&
      !isIdentifier(previousItemId)) {
      fail('invalid-field');
    }
    const itemId = validateInputAudioUserMessageItem(valueOf(value, 'item'));
    return Object.freeze({
      type,
      category: 'ignored',
      item_id: itemId,
      previous_item_id: previousItemId ?? null
    });
  }

  const isTimeout = type === 'input_audio_buffer.timeout_triggered';
  if (!hasExactKeys(
    value,
    isTimeout
      ? ['type', 'event_id', 'item_id', 'audio_start_ms', 'audio_end_ms']
      : [
          'type',
          'event_id',
          'item_id',
          type === 'input_audio_buffer.speech_started'
            ? 'audio_start_ms'
            : 'audio_end_ms'
        ]
  )) {
    fail('invalid-event');
  }
  const itemId = valueOf(value, 'item_id');
  const audioStartMs = valueOf(value, 'audio_start_ms');
  const audioEndMs = valueOf(value, 'audio_end_ms');
  if (
    !isIdentifier(itemId) ||
    (audioStartMs !== undefined && !isBoundedAudioOffset(audioStartMs)) ||
    (audioEndMs !== undefined && !isBoundedAudioOffset(audioEndMs)) ||
    (isTimeout && (audioStartMs as number) > (audioEndMs as number))
  ) {
    fail('invalid-field');
  }
  return Object.freeze({ type, category: 'ignored' });
}

function parseObjectEvent(
  value: Record<string, unknown>,
  expectedDeployment: string
): AzureRealtimeServerEvent {
  ownKeys(value);
  const type = valueOf(value, 'type');
  if (typeof type !== 'string' || !EVENT_TYPES.has(type as AzureRealtimeServerEventType)) {
    fail('invalid-event');
  }

  validateEventId(value);

  switch (type) {
    case 'session.created':
    case 'session.updated': {
      if (!hasExactKeys(value, ['type', 'event_id', 'session'])) {
        fail('invalid-event');
      }
      const session = parseSession(
        valueOf(value, 'session'),
        type,
        expectedDeployment
      );
      return Object.freeze({ type, session });
    }
    case 'rate_limits.updated': {
      if (!hasExactKeys(value, ['type', 'event_id', 'rate_limits'])) {
        fail('invalid-event');
      }
      const rateLimits = valueOf(value, 'rate_limits');
      if (!Array.isArray(rateLimits) ||
          Object.getPrototypeOf(rateLimits) !== Array.prototype ||
          rateLimits.length < 1 || rateLimits.length > 16) {
        fail('invalid-field');
      }
      const arrayKeys = ownKeys(rateLimits);
      if (arrayKeys.length !== rateLimits.length + 1 || !arrayKeys.includes('length')) {
        fail('invalid-field');
      }
      const names = new Set<string>();
      for (const rateLimit of rateLimits) {
        if (!isPlainObject(rateLimit) || !hasExactKeys(
          rateLimit,
          ['name', 'limit', 'remaining', 'reset_seconds']
        )) {
          fail('invalid-field');
        }
        const name = valueOf(rateLimit, 'name');
        const limit = valueOf(rateLimit, 'limit');
        const remaining = valueOf(rateLimit, 'remaining');
        const resetSeconds = valueOf(rateLimit, 'reset_seconds');
        if ((name !== 'requests' && name !== 'tokens') || names.has(name) ||
            typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0 ||
            limit > MAX_AZURE_REALTIME_SERVER_USAGE_COUNT ||
            typeof remaining !== 'number' || !Number.isSafeInteger(remaining) || remaining < 0 ||
            remaining > limit ||
            typeof resetSeconds !== 'number' || !Number.isFinite(resetSeconds) ||
            resetSeconds < 0 || resetSeconds > MAX_AZURE_REALTIME_SERVER_USAGE_COUNT) {
          fail('invalid-field');
        }
        names.add(name);
      }
      return Object.freeze({ type, category: 'advisory' });
    }
    case 'input_audio_buffer.committed': {
      if (!hasExactKeys(
        value,
        ['type', 'event_id', 'item_id'],
        ['previous_item_id']
      )) {
        fail('invalid-event');
      }
      const itemId = valueOf(value, 'item_id');
      const previousItemId = valueOf(value, 'previous_item_id');
      if (!isIdentifier(itemId) || (
        previousItemId !== undefined &&
        previousItemId !== null &&
        !isIdentifier(previousItemId)
      )) {
        fail('invalid-field');
      }
      return Object.freeze({
        type,
        item_id: itemId,
        previous_item_id: previousItemId ?? null
      });
    }
    case 'input_audio_buffer.cleared':
      if (!hasExactKeys(value, ['type', 'event_id'])) {
        fail('invalid-event');
      }
      return Object.freeze({ type });
    case 'input_audio_buffer.speech_started':
    case 'input_audio_buffer.speech_stopped':
    case 'input_audio_buffer.timeout_triggered':
    case 'conversation.item.created':
    case 'conversation.item.added':
    case 'conversation.item.done':
      return parseIgnoredTranscriptionStreamEvent(value, type);
    case 'conversation.item.input_audio_transcription.delta': {
      if (!hasExactKeys(
        value,
        ['type', 'event_id', 'item_id', 'content_index', 'delta'],
        ['logprobs', 'obfuscation']
      )) {
        fail('invalid-event');
      }
      const itemId = valueOf(value, 'item_id');
      const contentIndex = valueOf(value, 'content_index');
      const delta = valueOf(value, 'delta');
      const obfuscation = valueOf(value, 'obfuscation');
      if (
        !isIdentifier(itemId) ||
        !isContentIndex(contentIndex) ||
        !isBoundedText(delta, MAX_AZURE_REALTIME_SERVER_TEXT_BYTES) ||
        (obfuscation !== undefined && !isBoundedText(
          obfuscation,
          MAX_AZURE_REALTIME_SERVER_OBFUSCATION_BYTES
        ))
      ) {
        fail('invalid-field');
      }
      const logprobs = optionalLogprobs(value);
      return Object.freeze({
        type,
        item_id: itemId,
        content_index: contentIndex,
        delta,
        ...(obfuscation === undefined ? {} : { obfuscation }),
        ...(logprobs === undefined ? {} : { logprobs })
      });
    }
    case 'conversation.item.input_audio_transcription.completed': {
      if (!hasExactKeys(
        value,
        ['type', 'event_id', 'item_id', 'content_index', 'transcript', 'usage'],
        ['logprobs', 'languages']
      )) {
        fail('invalid-event');
      }
      const itemId = valueOf(value, 'item_id');
      const contentIndex = valueOf(value, 'content_index');
      const transcript = valueOf(value, 'transcript');
      if (
        !isIdentifier(itemId) ||
        !isContentIndex(contentIndex) ||
        !isBoundedString(transcript, MAX_AZURE_REALTIME_SERVER_TEXT_BYTES, true)
      ) {
        fail('invalid-field');
      }
      const logprobs = optionalLogprobs(value);
      const usage = parseUsage(valueOf(value, 'usage'));
      const languages = Object.hasOwn(value, 'languages')
        ? parseLanguages(valueOf(value, 'languages'))
        : undefined;
      return Object.freeze({
        type,
        item_id: itemId,
        content_index: contentIndex,
        transcript,
        ...(languages === undefined ? {} : { languages }),
        usage,
        ...(logprobs === undefined ? {} : { logprobs })
      });
    }
    case 'conversation.item.input_audio_transcription.segment': {
      if (!hasExactKeys(value, [
        'type',
        'event_id',
        'id',
        'item_id',
        'content_index',
        'text',
        'speaker',
        'start',
        'end'
      ])) {
        fail('invalid-event');
      }
      const id = valueOf(value, 'id');
      const itemId = valueOf(value, 'item_id');
      const contentIndex = valueOf(value, 'content_index');
      const text = valueOf(value, 'text');
      const speaker = valueOf(value, 'speaker');
      const start = valueOf(value, 'start');
      const end = valueOf(value, 'end');
      if (
        !isIdentifier(id) ||
        !isIdentifier(itemId) ||
        !isContentIndex(contentIndex) ||
        !isBoundedString(text, MAX_AZURE_REALTIME_SERVER_TEXT_BYTES, true) ||
        !isBoundedString(
          speaker,
          MAX_AZURE_REALTIME_SERVER_PROVIDER_STRING_BYTES,
          true
        ) ||
        !isBoundedSegmentSecond(start) ||
        !isBoundedSegmentSecond(end) ||
        start > end
      ) {
        fail('invalid-field');
      }
      return Object.freeze({
        type,
        id,
        item_id: itemId,
        content_index: contentIndex,
        text,
        speaker,
        start,
        end
      });
    }
    case 'conversation.item.input_audio_transcription.failed': {
      if (!hasExactKeys(
        value,
        ['type', 'event_id', 'item_id', 'content_index', 'error']
      )) {
        fail('invalid-event');
      }
      const itemId = valueOf(value, 'item_id');
      const contentIndex = valueOf(value, 'content_index');
      if (!isIdentifier(itemId) || !isContentIndex(contentIndex)) {
        fail('invalid-field');
      }
      validateTranscriptionErrorDetails(valueOf(value, 'error'));
      return Object.freeze({
        type,
        item_id: itemId,
        content_index: contentIndex,
        category: 'provider-failure'
      });
    }
    case 'error':
      if (!hasExactKeys(value, ['type', 'event_id', 'error'])) {
        fail('invalid-event');
      }
      validateGeneralErrorDetails(valueOf(value, 'error'));
      return Object.freeze({ type, category: 'protocol-failure' });
    default:
      fail('invalid-event');
  }
}

function validateParserOptions(
  options: AzureRealtimeServerEventParserOptions
): Readonly<{ maxJsonBytes: number; expectedDeployment: string }> {
  if (!isPlainObject(options) || !hasExactKeys(
    options,
    ['expectedDeployment'],
    ['maxJsonBytes', 'maxBytes']
  )) {
    fail('invalid-input');
  }
  const expectedDeployment = valueOf(options, 'expectedDeployment');
  if (
    !isBoundedString(
      expectedDeployment,
      MAX_AZURE_REALTIME_SERVER_DEPLOYMENT_BYTES
    ) ||
    !DEPLOYMENT_PATTERN.test(expectedDeployment)
  ) {
    fail('invalid-input');
  }
  const configuredJsonBytes = valueOf(options, 'maxJsonBytes');
  const configuredBytes = valueOf(options, 'maxBytes');
  if (configuredJsonBytes !== undefined && configuredBytes !== undefined) {
    fail('invalid-input');
  }
  const maxJsonBytes = configuredJsonBytes ?? configuredBytes ??
    MAX_AZURE_REALTIME_SERVER_EVENT_JSON_BYTES;
  if (
    typeof maxJsonBytes !== 'number' ||
    !Number.isSafeInteger(maxJsonBytes) ||
    maxJsonBytes < 1 ||
    maxJsonBytes > MAX_AZURE_REALTIME_SERVER_EVENT_JSON_BYTES
  ) {
    fail('invalid-input');
  }
  return Object.freeze({ maxJsonBytes, expectedDeployment });
}

function decodeJsonInput(
  input: string | Uint8Array,
  maxJsonBytes: number
): unknown {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    if (input.length > maxJsonBytes) {
      fail('oversize');
    }
    if (!isValidUnicodeString(input)) {
      fail('invalid-json');
    }
    const encoded = encodeBoundedValidUnicode(input, maxJsonBytes);
    if (encoded === undefined) {
      fail('oversize');
    }
    bytes = encoded;
  } else {
    bytes = input;
  }
  if (bytes.byteLength > maxJsonBytes) {
    fail('oversize');
  }

  let json: string;
  try {
    json = FATAL_TEXT_DECODER.decode(bytes);
  } catch (error) {
    if (error instanceof AzureRealtimeServerEventError) {
      throw error;
    }
    fail('invalid-json');
  }
  if (typeof input === 'string' && json !== input) {
    fail('invalid-json');
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    fail('invalid-json');
  }
}

export function parseAzureRealtimeServerEvent(
  input: string | Uint8Array,
  options: AzureRealtimeServerEventParserOptions
): AzureRealtimeServerEvent {
  const { maxJsonBytes, expectedDeployment } = validateParserOptions(options);
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) {
    fail('invalid-input');
  }
  const value = decodeJsonInput(input, maxJsonBytes);
  if (!isPlainObject(value)) {
    fail('invalid-input');
  }
  return parseObjectEvent(value, expectedDeployment);
}

export const parseAzureServerEvent = parseAzureRealtimeServerEvent;
export const normalizeAzureRealtimeServerEvent = parseAzureRealtimeServerEvent;
