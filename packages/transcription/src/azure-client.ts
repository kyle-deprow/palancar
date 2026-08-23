import {
  isIso6391LanguageCode,
  snapshotOwnDataProperties
} from './types.js';
import type { TranscriptionLanguageConfiguration } from './types.js';

export const AZURE_REALTIME_INPUT_AUDIO_FORMAT = 'audio/pcm' as const;
/** One 100 ms 16 kHz relay frame after 16->24 kHz conversion. */
export const DEFAULT_AZURE_REALTIME_APPEND_MAX_BYTES = 4_800 as const;
export const MAX_AZURE_REALTIME_APPEND_BYTES = 4_800 as const;

const DEPLOYMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/;

export type AzureRealtimeClientMessageErrorReason =
  | 'invalid-deployment'
  | 'invalid-audio'
  | 'invalid-options';

export type AzureRealtimeClientErrorReason = AzureRealtimeClientMessageErrorReason;

export class AzureRealtimeClientMessageError extends TypeError {
  readonly reason: AzureRealtimeClientMessageErrorReason;

  constructor(reason: AzureRealtimeClientMessageErrorReason) {
    super(
      reason === 'invalid-deployment'
        ? 'Invalid Azure Realtime deployment'
        : reason === 'invalid-audio'
          ? 'Invalid Azure Realtime audio'
          : 'Invalid Azure Realtime message options'
    );
    this.name = 'AzureRealtimeClientMessageError';
    this.reason = reason;
  }
}

export { AzureRealtimeClientMessageError as AzureRealtimeClientError };

export interface AzureRealtimeSessionUpdateMessage {
  readonly type: 'session.update';
  readonly session: Readonly<{
    readonly type: 'transcription';
    readonly audio: Readonly<{
      readonly input: Readonly<{
        readonly format: Readonly<{
          readonly type: typeof AZURE_REALTIME_INPUT_AUDIO_FORMAT;
          readonly rate: 24000;
        }>;
        readonly turn_detection: null;
        readonly transcription: Readonly<{
          readonly model: string;
          readonly language?: string;
        }>;
      }>;
    }>;
  }>;
}

export type AzureRealtimeSessionUpdateOptions = TranscriptionLanguageConfiguration;

export interface AzureRealtimeInputAudioAppendMessage {
  readonly type: 'input_audio_buffer.append';
  readonly audio: string;
}

export interface AzureRealtimeInputAudioCommitMessage {
  readonly type: 'input_audio_buffer.commit';
}

export interface AzureRealtimeInputAudioClearMessage {
  readonly type: 'input_audio_buffer.clear';
}

export type AzureRealtimeClientMessage =
  | AzureRealtimeSessionUpdateMessage
  | AzureRealtimeInputAudioAppendMessage
  | AzureRealtimeInputAudioCommitMessage
  | AzureRealtimeInputAudioClearMessage;

export interface AzureRealtimeInputAudioAppendOptions {
  readonly maxBytes?: number;
}

function fail(reason: AzureRealtimeClientMessageErrorReason): never {
  throw new AzureRealtimeClientMessageError(reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateDeployment(deployment: unknown): asserts deployment is string {
  if (typeof deployment !== 'string' || !DEPLOYMENT_PATTERN.test(deployment)) {
    fail('invalid-deployment');
  }
}

function validateSessionUpdateOptions(
  options: unknown
): TranscriptionLanguageConfiguration {
  if (options === undefined) {
    return Object.freeze({ languageMode: 'automatic' });
  }
  const snapshot = snapshotOwnDataProperties(options);
  if (snapshot === undefined) {
    fail('invalid-options');
  }
  const languageMode = snapshot.languageMode;
  const keys = Object.keys(snapshot);
  if (languageMode === 'automatic') {
    if (keys.length !== 1 || keys[0] !== 'languageMode') {
      fail('invalid-options');
    }
    return Object.freeze({ languageMode: 'automatic' });
  }
  if (
    languageMode !== 'selected-target' ||
    keys.length !== 2 ||
    !keys.includes('languageMode') ||
    !keys.includes('languageHint') ||
    !isIso6391LanguageCode(snapshot.languageHint)
  ) {
    fail('invalid-options');
  }
  return Object.freeze({
    languageMode: 'selected-target',
    languageHint: snapshot.languageHint
  });
}

function validateAppendOptions(
  options: unknown
): number {
  if (options === undefined) {
    return DEFAULT_AZURE_REALTIME_APPEND_MAX_BYTES;
  }
  if (!isPlainObject(options)) {
    fail('invalid-options');
  }

  const keys = Object.keys(options);
  if (keys.some((key) => key !== 'maxBytes')) {
    fail('invalid-options');
  }

  const maxBytes = options.maxBytes ?? DEFAULT_AZURE_REALTIME_APPEND_MAX_BYTES;
  if (
    typeof maxBytes !== 'number' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes % 2 !== 0 ||
    maxBytes < 1 ||
    maxBytes > MAX_AZURE_REALTIME_APPEND_BYTES
  ) {
    fail('invalid-options');
  }
  return maxBytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function buildAzureRealtimeSessionUpdateMessage(
  deployment: string,
  options?: AzureRealtimeSessionUpdateOptions
): AzureRealtimeSessionUpdateMessage {
  validateDeployment(deployment);
  const languageConfiguration = validateSessionUpdateOptions(options);
  const transcription = languageConfiguration.languageMode === 'automatic'
    ? { model: deployment }
    : { model: deployment, language: languageConfiguration.languageHint };
  return Object.freeze({
    type: 'session.update',
    session: Object.freeze({
      type: 'transcription',
      audio: Object.freeze({
        input: Object.freeze({
          format: Object.freeze({
            type: AZURE_REALTIME_INPUT_AUDIO_FORMAT,
            rate: 24000
          }),
          turn_detection: null,
          transcription: Object.freeze(transcription)
        })
      })
    })
  });
}

export function buildAzureRealtimeInputAudioAppendMessage(
  pcm: Uint8Array,
  options?: AzureRealtimeInputAudioAppendOptions
): AzureRealtimeInputAudioAppendMessage {
  const maxBytes = validateAppendOptions(options);
  if (
    !(pcm instanceof Uint8Array) ||
    pcm.byteLength === 0 ||
    pcm.byteLength % 2 !== 0 ||
    pcm.byteLength > maxBytes
  ) {
    fail('invalid-audio');
  }

  const ownedPcm = new Uint8Array(pcm);
  return Object.freeze({
    type: 'input_audio_buffer.append',
    audio: encodeBase64(ownedPcm)
  });
}

export function buildAzureRealtimeInputAudioCommitMessage():
  AzureRealtimeInputAudioCommitMessage {
  return Object.freeze({ type: 'input_audio_buffer.commit' });
}

export function buildAzureRealtimeInputAudioClearMessage():
  AzureRealtimeInputAudioClearMessage {
  return Object.freeze({ type: 'input_audio_buffer.clear' });
}

export const buildAzureRealtimeSessionUpdate = buildAzureRealtimeSessionUpdateMessage;
export const buildAzureRealtimeInputAudioAppend = buildAzureRealtimeInputAudioAppendMessage;
export const buildAzureRealtimeInputAudioCommit = buildAzureRealtimeInputAudioCommitMessage;
export const buildAzureRealtimeInputAudioClear = buildAzureRealtimeInputAudioClearMessage;
