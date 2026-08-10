import type {
  BoundedEnglishText,
  BoundedTargetText,
  BoundedTranscriptText,
  PositiveEpoch,
  PositiveRevision,
  SegmentId,
  SessionId,
  UtteranceId,
  Version
} from '@palancar/contracts';
import type { TargetLanguage } from '@palancar/language-registry';

export type GenerationOperation = 'translate' | 'suggest';

export type GenerationErrorCategory =
  | 'invalid-input'
  | 'forged-value'
  | 'correlation-mismatch'
  | 'invalid-provider'
  | 'invalid-provider-result'
  | 'provider-failure'
  | 'invalid-evidence';

export interface AcceptedTargetTurnInput {
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
  readonly segmentId: string;
  readonly acceptedFinalRevision: number;
  readonly selectedTargetLanguage: TargetLanguage;
  readonly decision: 'target';
  readonly targetTranscript: string;
  readonly gatePolicyVersion: string;
}

export interface AcceptedTargetTurn {
  readonly sessionId: SessionId;
  readonly sessionEpoch: PositiveEpoch;
  readonly utteranceId: UtteranceId;
  readonly segmentId: SegmentId;
  readonly acceptedFinalRevision: PositiveRevision;
  readonly selectedTargetLanguage: TargetLanguage;
  readonly decision: 'target';
  readonly targetTranscript: BoundedTranscriptText;
  readonly gatePolicyVersion: Version;
}

export interface GenerationCorrelation {
  readonly sessionId: SessionId;
  readonly sessionEpoch: PositiveEpoch;
  readonly utteranceId: UtteranceId;
  readonly segmentId: SegmentId;
  readonly acceptedFinalRevision: PositiveRevision;
  readonly selectedTargetLanguage: TargetLanguage;
  readonly gatePolicyVersion: Version;
}

export interface GenerationProviderIdentity {
  readonly id: string;
  readonly version: string;
}

export interface GenerationProviderTranslateInput extends GenerationCorrelation {
  readonly targetTranscript: BoundedTranscriptText;
}

export interface GenerationProviderSuggestInput extends GenerationCorrelation {
  readonly targetTranscript: BoundedTranscriptText;
  readonly englishTranslation: BoundedEnglishText;
}

export interface GenerationProviderTranslation {
  readonly englishTranslation: string;
}

export interface SuggestionPhrasePair {
  readonly englishText: BoundedEnglishText;
  readonly selectedTargetText: BoundedTargetText;
}

export interface GenerationProvider {
  readonly id: string;
  readonly version: string;
  translate(
    input: GenerationProviderTranslateInput
  ): Promise<GenerationProviderTranslation | string>;
  suggest(
    input: GenerationProviderSuggestInput
  ): Promise<readonly SuggestionPhrasePair[] | { readonly suggestions: readonly SuggestionPhrasePair[] }>;
}

export interface GenerationTranslation extends GenerationCorrelation {
  readonly englishTranslation: BoundedEnglishText;
}

export interface GenerationSuggestions extends GenerationCorrelation {
  readonly suggestions: readonly [SuggestionPhrasePair, SuggestionPhrasePair] | readonly [
    SuggestionPhrasePair,
    SuggestionPhrasePair,
    SuggestionPhrasePair
  ];
}

export type GenerationOutput = GenerationTranslation | GenerationSuggestions;

export interface GenerationEvidenceRecord extends GenerationCorrelation {
  readonly operation: GenerationOperation;
  readonly status: 'success' | 'failure';
  readonly failureCategory?: GenerationErrorCategory;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly startMonotonicMs: number;
  readonly endMonotonicMs: number;
  readonly latencyMs: number;
}

export interface GenerationServiceOptions {
  readonly provider: GenerationProvider;
  readonly evidenceCollector?: MetadataOnlyEvidenceCollectorLike;
  readonly evidence?: MetadataOnlyEvidenceCollectorLike;
}

export interface MetadataOnlyEvidenceCollectorLike {
  add(record: GenerationEvidenceRecord): GenerationEvidenceRecord;
  readonly records: readonly GenerationEvidenceRecord[];
}
