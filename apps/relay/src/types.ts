import type { WEBSOCKET_SUBPROTOCOL } from '@palancar/contracts';
import type { NegotiatedLimits, ServerControlMessage } from '@palancar/contracts';
import type { GenerationCompletion, GenerationService } from '@palancar/generation';
import type { TargetLanguage, TextLanguageClassifier } from '@palancar/language-registry';
import type {
  GenerationClaim,
  SecurityRuntimeStore,
  SecurityStateMaintenanceStore,
  SessionLease
} from '@palancar/security-state';
import type { NormalizedTranscriptionEvent, TranscriptionAdapter } from '@palancar/transcription';

export interface RelayUpgradeAudience {
  readonly origin: string;
  readonly path: '/v1/stream';
  readonly protocol: typeof WEBSOCKET_SUBPROTOCOL;
}

export type StreamSubprotocolSelection =
  | {
      readonly status: 'accepted';
      readonly ticket: string;
      readonly selectedProtocol: typeof WEBSOCKET_SUBPROTOCOL;
    }
  | { readonly status: 'rejected'; readonly httpStatus: 400 | 401 };

export type PreparedStreamUpgrade =
  | {
      readonly status: 'accepted';
      readonly selectedProtocol: typeof WEBSOCKET_SUBPROTOCOL;
      readonly sessionLease: SessionLease;
    }
  | { readonly status: 'rejected'; readonly httpStatus: 400 | 401 | 403 | 409 | 429 | 503 };

export interface RelayClock {
  nowIso(): string;
  nowMonotonicMs(): number;
}

export interface RelayIdGenerator {
  sessionId(): string;
  errorId(): string;
}

export type RelayLanguageBoundaryMode = 'fixture' | 'deny-all' | 'production-approved';

export const RELAY_METRIC_NAMES = Object.freeze([
  'session.start',
  'session.reject',
  'session.end',
  'utterance.start',
  'utterance.abort',
  'utterance.complete',
  'audio.samples.accepted',
  'audio.samples.duplicate',
  'audio.samples.rejected',
  'transport.reconnect',
  'transcription.first_partial_latency',
  'transcription.final_latency',
  'language.decision',
  'translation.latency',
  'translation.result',
  'suggestion.latency',
  'suggestion.result',
  'provider.failure',
  'state_store.failure'
] as const);

export type RelayMetricName = (typeof RELAY_METRIC_NAMES)[number];

export type RelayMetricOperation =
  | 'session'
  | 'utterance'
  | 'audio'
  | 'transport'
  | 'transcription'
  | 'language'
  | 'translation'
  | 'suggestion'
  | 'provider'
  | 'state_store';

export type RelayMetricOutcome =
  | 'accepted'
  | 'duplicate'
  | 'rejected'
  | 'completed'
  | 'aborted'
  | 'reconnected'
  | 'success'
  | 'failure';

export type RelayMetricGateDecision =
  | 'provisional'
  | 'target'
  | 'mixed'
  | 'english'
  | 'supported_unselected'
  | 'unsupported'
  | 'uncertain';

/**
 * Metadata-only producer input. Correlation identifiers, error identifiers,
 * user/provider content, and audio are structurally excluded at the core
 * boundary; a host adapter may add deployment metadata after this boundary.
 */
export interface RelayProductionMetricInput {
  readonly name: RelayMetricName;
  readonly timestamp: string;
  readonly protocolVersion?: 1;
  readonly durationMs?: number;
  readonly sampleCount?: number;
  readonly count?: number;
  readonly targetLanguage?: TargetLanguage;
  readonly gateDecision?: RelayMetricGateDecision;
  readonly operation?: RelayMetricOperation;
  readonly outcome?: RelayMetricOutcome;
  readonly providerId?: string;
  readonly providerVersion?: string;
  readonly reconnectReason?: 'network' | 'server' | 'heartbeat' | 'abnormal_exit' | 'session_expired' | 'unknown';
  readonly errorCategory?: never;
  readonly correlationId?: never;
  readonly sessionId?: never;
  readonly sessionIdHash?: never;
  readonly utteranceId?: never;
  readonly utteranceIdHash?: never;
  readonly segmentId?: never;
  readonly installationId?: never;
  readonly installationIdHash?: never;
  readonly requestId?: never;
  readonly requestIdHash?: never;
  readonly traceId?: never;
  readonly traceIdHash?: never;
  readonly spanId?: never;
  readonly spanIdHash?: never;
  readonly authorizationId?: never;
  readonly claimId?: never;
  readonly providerRequestId?: never;
  readonly errorId?: never;
  readonly text?: never;
  readonly transcript?: never;
  readonly translation?: never;
  readonly englishTranslation?: never;
  readonly englishText?: never;
  readonly selectedTargetText?: never;
  readonly suggestion?: never;
  readonly suggestions?: never;
  readonly content?: never;
  readonly audio?: never;
  readonly pcm?: never;
  readonly prompt?: never;
  readonly request?: never;
  readonly response?: never;
  readonly providerBody?: never;
  readonly message?: never;
}

export type RelayMetricInput = RelayProductionMetricInput;

/** `record` is a nonthrowing contract. The core still contains hostile sinks. */
export interface RelayMetricSink {
  record(input: RelayProductionMetricInput): void;
}

interface RelaySessionCoreBaseOptions {
  readonly sessionLease: SessionLease;
  readonly securityRuntime: SecurityRuntimeStore;
  readonly clock: RelayClock;
  readonly ids: RelayIdGenerator;
  readonly languageClassifier: TextLanguageClassifier;
  readonly generationService: GenerationService;
  readonly languageBoundaryMode: RelayLanguageBoundaryMode;
  readonly metricSink: RelayMetricSink;
  readonly gatePolicyVersion: string;
  readonly serverLimits?: NegotiatedLimits;
  readonly onAsyncEventsAvailable?: () => unknown;
}

type RelayTranscriptionAdapterOptions =
  | {
      readonly transcriptionAdapters: Readonly<Record<TargetLanguage, TranscriptionAdapter>>;
      readonly transcriptionAdapterForTarget?: never;
      readonly transcriptionAdapter?: never;
    }
  | {
      readonly transcriptionAdapters?: never;
      readonly transcriptionAdapterForTarget: (target: TargetLanguage) => TranscriptionAdapter;
      readonly transcriptionAdapter?: never;
    }
  | {
      readonly transcriptionAdapters?: never;
      readonly transcriptionAdapterForTarget?: never;
      /** Test-only migration shorthand. Production composition selects by target. */
      readonly transcriptionAdapter: TranscriptionAdapter;
    };

export type RelaySessionCoreOptions = RelaySessionCoreBaseOptions &
  RelayTranscriptionAdapterOptions;

export interface FinalProcessingToken {
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
  readonly segmentId: string;
  readonly acceptedFinalRevision: number;
  readonly selectedTargetLanguage: string;
  readonly gatePolicyVersion: string;
  readonly targetTranscript: string;
  readonly generationStartedMonotonicMs: number | undefined;
  readonly generationClaim: GenerationClaim;
}

export type RelayAsyncEvent =
  | { readonly kind: 'transcription'; readonly event: NormalizedTranscriptionEvent }
  | {
      readonly kind: 'transcription.failed';
      readonly sessionId: string;
      readonly sessionEpoch: number;
      readonly utteranceId: string;
    }
  | { readonly kind: 'generation.completed'; readonly token: FinalProcessingToken; readonly result: GenerationCompletion }
  | { readonly kind: 'generation.failed'; readonly token: FinalProcessingToken };

export type RelayCloseCode =
  | 1000
  | 1002
  | 1003
  | 1008
  | 1011
  | 4401
  | 4403
  | 4408
  | 4409
  | 4410
  | 4503;

export interface RelayStepResult {
  readonly outgoing: readonly ServerControlMessage[];
  readonly close?: Readonly<{ readonly code: RelayCloseCode; readonly reason: string }>;
}

export type { NegotiatedLimits, NormalizedTranscriptionEvent, ServerControlMessage };
export type { SecurityRuntimeStore, SecurityStateMaintenanceStore, SessionLease };
