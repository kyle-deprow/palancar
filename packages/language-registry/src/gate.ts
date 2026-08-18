import { validateClassifiedLanguageEvidence } from './classifier.js';
import {
  languageRegistry,
  type LanguageRegistry
} from './registry.js';
import type {
  GateDecision,
  LanguageDefinition,
  LanguageGateInput,
  LanguageGateResult
} from './types.js';

const ENGLISH_LANGUAGE = 'en';
const MIXED_LANGUAGE = 'mixed';

function normalizeLanguageCode(code: string): string {
  return code.trim().toLowerCase();
}

function hasSufficientConfidence(
  confidence: number | undefined,
  threshold: number
): boolean {
  return confidence !== undefined && confidence >= threshold;
}

function partialDisplayAccepted(
  input: LanguageGateInput,
  selectedLanguage: string,
  selectedDefinition: LanguageDefinition<string>
): boolean {
  const profile = selectedDefinition.partialDisplayCalibration;
  const evidence = input.evidence;
  return (
    profile !== undefined &&
    evidence.status === 'calibrated' &&
    evidence.detectedLanguage === selectedLanguage &&
    evidence.detectorVersion === profile.detectorVersion &&
    evidence.calibrationVersion === profile.calibrationVersion &&
    hasSufficientConfidence(evidence.confidence, profile.confidenceThreshold)
  );
}

function finalCalibrationAccepted(
  input: LanguageGateInput,
  selectedDefinition: LanguageDefinition<string>
): boolean {
  const evidence = input.evidence;
  const profile = selectedDefinition.finalCalibration;
  return (
    evidence.status === 'calibrated' &&
    evidence.detectorVersion === profile.detectorVersion &&
    evidence.calibrationVersion === profile.calibrationVersion &&
    hasSufficientConfidence(evidence.confidence, profile.confidenceThreshold)
  );
}

function resultFor(
  decision: GateDecision,
  input: LanguageGateInput,
  selectedLanguage: string,
  displayAllowed: boolean,
  generationAllowed: boolean
): LanguageGateResult {
  return {
    decision,
    displayAllowed,
    generationAllowed,
    selectedLanguage,
    isFinal: input.isFinal,
    ...(input.evidence.detectedLanguage === undefined
      ? {}
      : { detectedLanguage: input.evidence.detectedLanguage }),
    ...(input.evidence.status === 'calibrated'
      ? { confidence: input.evidence.confidence }
      : {})
  };
}

export function evaluateLanguageGate(
  input: LanguageGateInput,
  registry: LanguageRegistry<string> = languageRegistry
): LanguageGateResult {
  const selectedLanguage = normalizeLanguageCode(input.selectedLanguage);
  const selectedDefinition = registry.get(selectedLanguage);

  if (selectedDefinition === undefined) {
    throw new RangeError(`Unsupported selected target language: ${selectedLanguage}`);
  }

  validateClassifiedLanguageEvidence(input.evidence);

  if (!input.isFinal) {
    return resultFor(
      'provisional',
      input,
      selectedLanguage,
      partialDisplayAccepted(input, selectedLanguage, selectedDefinition),
      false
    );
  }

  if (
    input.evidence.status !== 'calibrated' ||
    !finalCalibrationAccepted(input, selectedDefinition)
  ) {
    return resultFor('uncertain', input, selectedLanguage, false, false);
  }

  const detectedLanguage = input.evidence.detectedLanguage;
  if (
    detectedLanguage === MIXED_LANGUAGE &&
    selectedDefinition.mixedPolicy === 'reject'
  ) {
    return resultFor('mixed', input, selectedLanguage, false, false);
  }

  if (detectedLanguage === selectedLanguage) {
    return resultFor('target', input, selectedLanguage, true, true);
  }

  if (detectedLanguage === ENGLISH_LANGUAGE) {
    return resultFor('english', input, selectedLanguage, false, false);
  }

  if (registry.get(detectedLanguage) !== undefined) {
    return resultFor(
      'supported_unselected',
      input,
      selectedLanguage,
      false,
      false
    );
  }

  return resultFor('unsupported', input, selectedLanguage, false, false);
}
