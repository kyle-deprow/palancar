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
}

export interface RelayIdGenerator {
  sessionId(): string;
  errorId(): string;
}

export interface RelaySessionCoreOptions {
  readonly sessionLease: SessionLease;
  readonly securityRuntime: SecurityRuntimeStore;
  readonly clock: RelayClock;
  readonly ids: RelayIdGenerator;
  readonly transcriptionAdapter: TranscriptionAdapter;
  readonly transcriptionAdapterForTarget?: (target: TargetLanguage) => TranscriptionAdapter;
  readonly languageClassifier: TextLanguageClassifier;
  readonly generationService: GenerationService;
  readonly gatePolicyVersion: string;
  readonly serverLimits?: NegotiatedLimits;
  readonly onAsyncEventsAvailable?: () => void;
}

export interface FinalProcessingToken {
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
  readonly segmentId: string;
  readonly acceptedFinalRevision: number;
  readonly selectedTargetLanguage: string;
  readonly gatePolicyVersion: string;
  readonly targetTranscript: string;
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
