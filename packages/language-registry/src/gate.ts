import { snapshotClassifiedLanguageEvidence } from './classifier.js';
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

function developmentProvisionalAccepted(
  input: LanguageGateInput,
  selectedLanguage: string,
  selectedDefinition: LanguageDefinition<string>
): boolean {
  const evidence = input.evidence;
  const profile = selectedDefinition.developmentProvisional;
  return (
    profile !== undefined &&
    evidence.status === 'provisional' &&
    evidence.decision === 'accept' &&
    evidence.reason === 'MATCH' &&
    evidence.detectedLanguage === selectedLanguage &&
    evidence.detectorVersion === profile.detectorVersion &&
    evidence.profileVersion === profile.profileVersion &&
    evidence.provisionalScore >= profile.provisionalScoreThreshold
  );
}

function provisionalRejectionDecision(
  input: LanguageGateInput,
  registry: LanguageRegistry<string>
): GateDecision {
  const evidence = input.evidence;
  if (evidence.status !== 'provisional') return 'uncertain';
  switch (evidence.reason) {
    case 'ENGLISH':
      return 'english';
    case 'MIXED':
      return 'mixed';
    case 'UNSELECTED_LANGUAGE':
      return registry.get(evidence.detectedLanguage) === undefined
        ? 'unsupported'
        : 'supported_unselected';
    case 'MATCH':
    case 'TOO_SHORT':
    case 'UNKNOWN':
    case 'DETECTOR_ERROR':
      return 'uncertain';
  }
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

  const safeInput: LanguageGateInput = Object.freeze({
    selectedLanguage: input.selectedLanguage,
    evidence: snapshotClassifiedLanguageEvidence(input.evidence),
    isFinal: input.isFinal,
    boundaryMode: input.boundaryMode
  });

  if (
    safeInput.boundaryMode !== 'production-calibrated' &&
    safeInput.boundaryMode !== 'development-provisional'
  ) {
    throw new TypeError('Language boundary mode is invalid');
  }

  if (!safeInput.isFinal) {
    return resultFor(
      'provisional',
      safeInput,
      selectedLanguage,
      safeInput.boundaryMode === 'production-calibrated' &&
        partialDisplayAccepted(safeInput, selectedLanguage, selectedDefinition),
      false
    );
  }


  if (safeInput.boundaryMode === 'development-provisional') {
    if (
      developmentProvisionalAccepted(safeInput, selectedLanguage, selectedDefinition)
    ) {
      return resultFor('target', safeInput, selectedLanguage, true, true);
    }
    return resultFor(
      provisionalRejectionDecision(safeInput, registry),
      safeInput,
      selectedLanguage,
      false,
      false
    );
  }

  if (
    safeInput.evidence.status !== 'calibrated' ||
    !finalCalibrationAccepted(safeInput, selectedDefinition)
  ) {
    return resultFor('uncertain', safeInput, selectedLanguage, false, false);
  }

  const detectedLanguage = safeInput.evidence.detectedLanguage;
  if (
    detectedLanguage === MIXED_LANGUAGE &&
    selectedDefinition.mixedPolicy === 'reject'
  ) {
    return resultFor('mixed', safeInput, selectedLanguage, false, false);
  }

  if (detectedLanguage === selectedLanguage) {
    return resultFor('target', safeInput, selectedLanguage, true, true);
  }

  if (detectedLanguage === ENGLISH_LANGUAGE) {
    return resultFor('english', safeInput, selectedLanguage, false, false);
  }

  if (registry.get(detectedLanguage) !== undefined) {
    return resultFor(
      'supported_unselected',
      safeInput,
      selectedLanguage,
      false,
      false
    );
  }

  return resultFor('unsupported', safeInput, selectedLanguage, false, false);
}
