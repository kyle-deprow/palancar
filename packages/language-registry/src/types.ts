export type TargetLanguage = 'es' | 'tr';

export type MixedPolicy = 'reject';

export interface LanguageDefinition<TCode extends string = TargetLanguage> {
  readonly code: TCode;
  readonly displayName: string;
  readonly transcriptionHint?: string;
  readonly confidenceThreshold: number;
  readonly mixedPolicy: MixedPolicy;
  readonly fixtureSuiteIds: readonly string[];
}

export type LanguageEvidenceSource =
  | 'transcription-metadata'
  | 'text-classifier'
  | 'controlled-fixture';

export interface LanguageEvidence {
  readonly detectedLanguage?: string;
  readonly confidence?: number;
  readonly text: string;
  readonly detectorVersion: string;
  readonly source: LanguageEvidenceSource;
}

export type GateDecision =
  | 'provisional'
  | 'target'
  | 'mixed'
  | 'english'
  | 'supported_unselected'
  | 'unsupported'
  | 'uncertain';

export interface LanguageGateInput {
  readonly selectedLanguage: string;
  readonly evidence: LanguageEvidence;
  readonly isFinal: boolean;
}

export interface LanguageGateResult {
  readonly decision: GateDecision;
  readonly generationAllowed: boolean;
  readonly selectedLanguage: string;
  readonly isFinal: boolean;
  readonly detectedLanguage?: string;
  readonly confidence?: number;
}
