import type { ClassifiedLanguageEvidence } from './classifier.js';

export type TargetLanguage = 'es' | 'tr';

export type MixedPolicy = 'reject';

export interface LanguageCalibrationProfile {
  readonly detectorVersion: string;
  readonly calibrationVersion: string;
  readonly confidenceThreshold: number;
}

export type PartialDisplayCalibrationProfile = LanguageCalibrationProfile;

export interface LanguageDefinition<TCode extends string = TargetLanguage> {
  readonly code: TCode;
  readonly displayName: string;
  readonly transcriptionHint?: string;
  readonly finalCalibration: LanguageCalibrationProfile;
  readonly mixedPolicy: MixedPolicy;
  readonly fixtureSuiteIds: readonly string[];
  readonly partialDisplayCalibration?: PartialDisplayCalibrationProfile;
}

/** Advisory provenance only; it is not accepted by evaluateLanguageGate. */
export type LanguageEvidenceSource =
  | 'transcription-metadata'
  | 'text-classifier'
  | 'controlled-fixture';

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
  readonly evidence: ClassifiedLanguageEvidence;
  readonly isFinal: boolean;
}

export interface LanguageGateResult {
  readonly decision: GateDecision;
  readonly displayAllowed: boolean;
  readonly generationAllowed: boolean;
  readonly selectedLanguage: string;
  readonly isFinal: boolean;
  readonly detectedLanguage?: string;
  readonly confidence?: number;
}
