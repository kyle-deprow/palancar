import {
  languageRegistry,
  type LanguageRegistry
} from './registry.js';
import type {
  GateDecision,
  LanguageEvidence,
  LanguageGateInput,
  LanguageGateResult
} from './types.js';

const ENGLISH_LANGUAGE = 'en';
const MIXED_LANGUAGE = 'mixed';

function normalizeLanguageCode(code: string): string {
  return code.trim().toLowerCase();
}

function hasSufficientConfidence(
  evidence: LanguageEvidence,
  threshold: number
): boolean {
  return (
    typeof evidence.confidence === 'number' &&
    Number.isFinite(evidence.confidence) &&
    evidence.confidence >= 0 &&
    evidence.confidence <= 1 &&
    evidence.confidence >= threshold
  );
}

function resultFor(
  decision: GateDecision,
  input: LanguageGateInput,
  detectedLanguage: string | undefined
): LanguageGateResult {
  return {
    decision,
    generationAllowed: decision === 'target' && input.isFinal,
    selectedLanguage: normalizeLanguageCode(input.selectedLanguage),
    isFinal: input.isFinal,
    ...(detectedLanguage === undefined ? {} : { detectedLanguage }),
    ...(input.evidence.confidence === undefined
      ? {}
      : { confidence: input.evidence.confidence })
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

  const detectedLanguage = input.evidence.detectedLanguage === undefined
    ? undefined
    : normalizeLanguageCode(input.evidence.detectedLanguage);

  if (!input.isFinal) {
    return resultFor('provisional', input, detectedLanguage);
  }

  if (detectedLanguage === MIXED_LANGUAGE && selectedDefinition.mixedPolicy === 'reject') {
    return resultFor('mixed', input, detectedLanguage);
  }

  if (
    detectedLanguage === undefined ||
    !hasSufficientConfidence(input.evidence, selectedDefinition.confidenceThreshold)
  ) {
    return resultFor('uncertain', input, detectedLanguage);
  }

  if (detectedLanguage === selectedLanguage) {
    return resultFor('target', input, detectedLanguage);
  }

  if (detectedLanguage === ENGLISH_LANGUAGE) {
    return resultFor('english', input, detectedLanguage);
  }

  if (registry.get(detectedLanguage) !== undefined) {
    return resultFor('supported_unselected', input, detectedLanguage);
  }

  return resultFor('unsupported', input, detectedLanguage);
}
