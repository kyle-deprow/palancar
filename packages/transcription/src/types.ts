import { types as utilTypes } from 'node:util';

import type {
  TranscriptFinal,
  TranscriptPartial
} from '@palancar/contracts';
import type { LanguageEvidenceSource } from '@palancar/language-registry';

// Kept private so callers cannot mutate the admission set. The exported
// predicate is the only language-code boundary shared by all adapters.
const ISO_639_1_LANGUAGE_CODES: ReadonlySet<string> = new Set([
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

export function isIso6391LanguageCode(value: unknown): value is string {
  return typeof value === 'string' && ISO_639_1_LANGUAGE_CODES.has(value);
}

/** Snapshot a non-proxy, own-data-only record without invoking caller code. */
export function snapshotOwnDataProperties(
  value: unknown
): Readonly<Record<string, unknown>> | undefined {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      utilTypes.isProxy(value)
    ) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys) {
      const descriptor = descriptors[key as string];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return undefined;
      }
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value: descriptor.value,
        writable: false
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

export type TranscriptionLanguageConfiguration =
  | {
      readonly languageMode: 'automatic';
    }
  | {
      readonly languageMode: 'selected-target';
      readonly languageHint: string;
    };

export type TranscriptionLanguageMode =
  TranscriptionLanguageConfiguration['languageMode'];

export type ServerVadMode = 'enabled' | 'disabled';

export type ProviderRetentionStatus =
  | 'unverified'
  | 'verified-no-content-retention'
  | 'provider-managed'
  | 'not-applicable-synthetic';

export interface TranscriptionProviderIdentity {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
}

export interface TranscriptionAudioFormat {
  readonly sampleRateHz: number;
  readonly sampleFormat: 's16le';
  readonly channels: 1;
}

export interface TranscriptionCapabilities {
  readonly identity: Readonly<TranscriptionProviderIdentity>;
  readonly acceptedInput: Readonly<TranscriptionAudioFormat>;
  readonly providerInput: Readonly<TranscriptionAudioFormat>;
  readonly resampling: Readonly<{
    readonly mode: 'native' | 'required';
    readonly stateful: boolean;
  }>;
  readonly serverVad: Readonly<{
    readonly supported: boolean;
    readonly modes: readonly ServerVadMode[];
  }>;
  readonly manualCommit: Readonly<{
    readonly supported: boolean;
    readonly cadencesMs: readonly number[];
  }>;
  readonly languageModes: readonly TranscriptionLanguageMode[];
  readonly partialResults: Readonly<{ readonly supported: boolean }>;
  readonly providerRetention: Readonly<{
    readonly status: ProviderRetentionStatus;
    readonly evidenceVersion: string;
  }>;
}

export type TranscriptionSessionConfiguration = {
  readonly serverVadMode: ServerVadMode;
  readonly manualCommitCadenceMs: number;
} & TranscriptionLanguageConfiguration;

export interface NormalizedLanguageEvidence {
  readonly detectedLanguage?: string;
  readonly confidence?: number;
  readonly detectorVersion: string;
  readonly source: LanguageEvidenceSource;
}

interface NormalizedTranscriptionFields {
  readonly languageEvidence: Readonly<NormalizedLanguageEvidence>;
  /** Highest contiguous exclusive offset in original 16 kHz input samples. */
  readonly acceptedThroughOriginalSampleOffset: number;
}

export type NormalizedTranscriptionPartial = TranscriptPartial &
  NormalizedTranscriptionFields;

export type TranscriptionFinalizationReason =
  | 'explicit'
  | 'script-threshold';

export type NormalizedTranscriptionFinal = TranscriptFinal &
  NormalizedTranscriptionFields & {
    readonly finalizationReason: TranscriptionFinalizationReason;
  };

export type NormalizedTranscriptionEvent =
  | NormalizedTranscriptionPartial
  | NormalizedTranscriptionFinal;

export type MockLanguageEvidenceCategory =
  | 'selected-target'
  | 'english'
  | 'supported-unselected'
  | 'mixed'
  | 'unsupported'
  | 'uncertain';

export interface StartUtteranceInput {
  readonly utteranceId: string;
}

export interface PushAudioInput {
  readonly utteranceId: string;
  readonly originalSampleOffset: number;
  /** Original 16 kHz mono S16LE bytes. The session always copies this input. */
  readonly pcm: Uint8Array;
}

export type StartUtteranceResult =
  | { readonly status: 'started' }
  | { readonly status: 'already-active' };

export interface PushAudioResult {
  readonly status: 'accepted';
  readonly acceptedSamples: number;
  readonly acceptedThroughOriginalSampleOffset: number;
}

export type FinalizeResult =
  | { readonly status: 'finalization-requested' }
  | { readonly status: 'already-requested' }
  | { readonly status: 'already-finalized' }
  | { readonly status: 'already-cancelled' };

export type CancelResult =
  | { readonly status: 'cancelled' }
  | { readonly status: 'already-cancelled' }
  | { readonly status: 'already-finalized' };

export type CloseResult =
  | { readonly status: 'closed' }
  | { readonly status: 'already-closed' };

export interface TranscriptionSessionState {
  readonly closed: boolean;
  readonly connectionState?: TranscriptionConnectionState;
  readonly finalizationRequested?: boolean;
  readonly activeUtteranceId?: string;
  readonly acceptedThroughOriginalSampleOffset: number;
  /** Increments whenever the adapter resets utterance-local audio state. */
  readonly audioStateEpoch: number;
}

export type TranscriptionConnectionState =
  | 'idle'
  | 'acquiring-token'
  | 'connecting'
  | 'configuring'
  | 'ready'
  | 'finalizing'
  | 'failed'
  | 'closed';

export type TranscriptionFailureReason =
  | 'authentication'
  | 'connect-timeout'
  | 'configuration'
  | 'protocol'
  | 'provider'
  | 'socket'
  | 'backpressure'
  | 'finalization-timeout';

/** Deliberately content-free so provider details never cross the relay boundary. */
export interface TranscriptionFailure {
  readonly reason: TranscriptionFailureReason;
  readonly audioStateEpoch: number;
}

export interface EventDeliveryFailureStatus {
  readonly failureCount: number;
  readonly lastFailure?: Readonly<{
    readonly eventType: NormalizedTranscriptionEvent['type'];
    readonly revision: number;
  }>;
}

export interface TranscriptionSession {
  readonly capabilities: Readonly<TranscriptionCapabilities>;
  readonly configuration: Readonly<TranscriptionSessionConfiguration>;
  readonly state: Readonly<TranscriptionSessionState>;
  readonly deliveryFailures: Readonly<EventDeliveryFailureStatus>;
  start(input: StartUtteranceInput): StartUtteranceResult;
  pushAudio(input: PushAudioInput): PushAudioResult;
  finalize(utteranceId: string): FinalizeResult;
  cancel(utteranceId: string): CancelResult;
  close(): CloseResult;
}

export interface CreateTranscriptionSessionInput {
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly configuration: TranscriptionSessionConfiguration;
  readonly onEvent: (event: NormalizedTranscriptionEvent) => void;
  readonly onDeliveryFailure?: (status: Readonly<EventDeliveryFailureStatus>) => void;
  readonly onFailure: (failure: Readonly<TranscriptionFailure>) => void;
  readonly maxUtteranceSamples?: number;
}

export interface TranscriptionAdapter {
  readonly capabilities: Readonly<TranscriptionCapabilities>;
  createSession(input: CreateTranscriptionSessionInput): TranscriptionSession;
  checkReadiness(signal?: AbortSignal): Promise<TranscriptionReadiness>;
}

export interface TranscriptionReadiness {
  readonly ready: boolean;
  readonly provider: string;
  readonly model: string;
}
