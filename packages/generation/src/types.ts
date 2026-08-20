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
import type {
  GeneratedLanguageValidationMode,
  GeneratedLanguageValidationStatus,
  GeneratedLanguageValidator
} from './language-validation.js';

export type GenerationOperation = 'complete' | 'translate' | 'suggest';

export type GenerationErrorCategory =
  | 'invalid-input'
  | 'forged-value'
  | 'correlation-mismatch'
  | 'invalid-provider'
  | 'invalid-provider-result'
  | 'provider-failure'
  | 'invalid-validator'
  | 'invalid-generated-language'
  | 'language-validation-failure'
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

export interface GenerationProviderCompletionInput extends GenerationCorrelation {
  readonly targetTranscript: BoundedTranscriptText;
}

export interface SuggestionPhrasePair {
  readonly englishText: BoundedEnglishText;
  readonly selectedTargetText: BoundedTargetText;
}

export interface GenerationProviderCompletion {
  readonly englishTranslation: string;
  readonly suggestions:
    | readonly [SuggestionPhrasePair, SuggestionPhrasePair]
    | readonly [SuggestionPhrasePair, SuggestionPhrasePair, SuggestionPhrasePair];
}

export interface GenerationProvider {
  readonly id: string;
  readonly version: string;
  complete(
    input: GenerationProviderCompletionInput,
    context: { readonly signal: AbortSignal }
  ): Promise<GenerationProviderCompletion>;
}

export interface GenerationCompletion extends GenerationCorrelation {
  readonly englishTranslation: BoundedEnglishText;
  readonly suggestions:
    | readonly [SuggestionPhrasePair, SuggestionPhrasePair]
    | readonly [SuggestionPhrasePair, SuggestionPhrasePair, SuggestionPhrasePair];
}

export interface GenerationCompletionOptions {
  readonly signal?: AbortSignal;
}

export interface GenerationEvidenceRecord extends GenerationCorrelation {
  readonly operation: GenerationOperation;
  readonly status: 'success' | 'failure' | 'cancelled';
  readonly failureCategory?: GenerationErrorCategory;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly validatorId: string;
  readonly validatorVersion: string;
  readonly languageValidationStatus: GeneratedLanguageValidationStatus;
  readonly languageValidationCheckCount: 0 | 5 | 7;
  readonly languageValidationNonmatchCount: number;
  readonly startMonotonicMs: number;
  readonly endMonotonicMs: number;
  readonly latencyMs: number;
}

export interface GenerationServiceOptions {
  readonly provider: GenerationProvider;
  readonly validator: GeneratedLanguageValidator;
  readonly languageValidationMode?: GeneratedLanguageValidationMode;
  readonly languageValidationTimeoutMs?: number;
  readonly evidenceCollector?: MetadataOnlyEvidenceCollectorLike;
  readonly evidence?: MetadataOnlyEvidenceCollectorLike;
}

export interface MetadataOnlyEvidenceCollectorLike {
  add(input: unknown): GenerationEvidenceRecord;
  readonly records: readonly GenerationEvidenceRecord[];
}
