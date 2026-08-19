import type {
  TranscriptFinal,
  TranscriptPartial
} from '@palancar/contracts';
import type { LanguageEvidenceSource } from '@palancar/language-registry';

export type TranscriptionLanguageMode = 'automatic';

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

export interface TranscriptionSessionConfiguration {
  readonly serverVadMode: ServerVadMode;
  readonly languageMode: TranscriptionLanguageMode;
  readonly manualCommitCadenceMs: number;
}

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
