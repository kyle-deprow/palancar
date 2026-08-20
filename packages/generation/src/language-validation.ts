import type { TargetLanguage } from '@palancar/language-registry';

import { GenerationError } from './errors.js';
import type { GenerationProviderCompletion } from './types.js';

export const DEFAULT_LANGUAGE_VALIDATION_TIMEOUT_MS = 3_000;
export const MIN_LANGUAGE_VALIDATION_TIMEOUT_MS = 1;
export const MAX_LANGUAGE_VALIDATION_TIMEOUT_MS = 10_000;

export type GeneratedLanguage = 'en' | TargetLanguage;

export type DetectedGeneratedLanguage =
  | GeneratedLanguage
  | 'mixed'
  | 'other'
  | 'undetermined';
export type GeneratedLanguageValidationMode =
  | 'production-calibrated'
  | 'development-provisional';
export type GeneratedLanguageEvidenceType =
  | 'calibrated'
  | 'development-provisional';
export type GeneratedLanguageValidationVerdict = 'match' | 'mismatch' | 'indeterminate';
export type GeneratedLanguageValidationStatus =
  | 'not-run'
  | 'accepted'
  | 'rejected'
  | 'failed'
  | 'cancelled';

export type GeneratedLanguageSlot =
  | 'translation.english'
  | 'suggestion[0].english'
  | 'suggestion[0].target'
  | 'suggestion[1].english'
  | 'suggestion[1].target'
  | 'suggestion[2].english'
  | 'suggestion[2].target';

export interface GeneratedLanguageValidationCheck {
  readonly slot: GeneratedLanguageSlot;
  readonly text: string;
  readonly expectedLanguage: GeneratedLanguage;
}

export interface GeneratedLanguageValidationEvidenceCheck {
  readonly slot: GeneratedLanguageSlot;
  readonly expectedLanguage: GeneratedLanguage;
  readonly detectedLanguage: DetectedGeneratedLanguage;
  readonly verdict: GeneratedLanguageValidationVerdict;
  readonly evidenceType: GeneratedLanguageEvidenceType;
  readonly confidenceBasisPoints: number | null;
  readonly provisionalScoreBasisPoints: number | null;
}

type FiveChecks<T> = readonly [T, T, T, T, T];
type SevenChecks<T> = readonly [T, T, T, T, T, T, T];

export interface GeneratedLanguageValidationInput {
  readonly checks:
    | FiveChecks<GeneratedLanguageValidationCheck>
    | SevenChecks<GeneratedLanguageValidationCheck>;
}

export interface GeneratedLanguageValidationEvidence {
  readonly checks:
    | FiveChecks<GeneratedLanguageValidationEvidenceCheck>
    | SevenChecks<GeneratedLanguageValidationEvidenceCheck>;
}

export interface GeneratedLanguageValidator {
  readonly id: string;
  readonly version: string;
  validate(
    input: GeneratedLanguageValidationInput,
    context: { readonly signal: AbortSignal }
  ): Promise<GeneratedLanguageValidationEvidence>;
}

const INPUT_KEYS = new Set(['checks']);
const EVIDENCE_CHECK_KEYS = new Set([
  'slot',
  'expectedLanguage',
  'detectedLanguage',
  'verdict',
  'evidenceType',
  'confidenceBasisPoints',
  'provisionalScoreBasisPoints'
]);
const DETECTED_LANGUAGES: ReadonlySet<DetectedGeneratedLanguage> = new Set([
  'en',
  'es',
  'tr',
  'mixed',
  'other',
  'undetermined'
]);
const VERDICTS: ReadonlySet<GeneratedLanguageValidationVerdict> = new Set([
  'match',
  'mismatch',
  'indeterminate'
]);
const EVIDENCE_TYPES: ReadonlySet<GeneratedLanguageEvidenceType> = new Set([
  'calibrated',
  'development-provisional'
]);

function isBasisPoints(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 10_000)
  );
}

function validationFailure(): never {
  throw new GenerationError('language-validation-failure');
}

function snapshotExactObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    validationFailure();
  }
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    validationFailure();
  }
  if (prototype !== Object.prototype && prototype !== null) {
    validationFailure();
  }
  const copy: Record<string, unknown> = {};
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        validationFailure();
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        validationFailure();
      }
      copy[key] = descriptor.value;
    }
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    validationFailure();
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(copy, key)) {
      validationFailure();
    }
  }
  return copy;
}

function snapshotExactArray(value: unknown, expectedLength: 5 | 7): readonly unknown[] {
  if (!Array.isArray(value)) {
    validationFailure();
  }
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    validationFailure();
  }
  const lengthDescriptor = descriptors.length;
  if (
    prototype !== Array.prototype ||
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    lengthDescriptor.value !== expectedLength
  ) {
    validationFailure();
  }
  const copy: unknown[] = [];
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === 'length') {
        continue;
      }
      if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= expectedLength) {
        validationFailure();
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        validationFailure();
      }
    }
    for (let index = 0; index < expectedLength; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        validationFailure();
      }
      copy.push(descriptor.value);
    }
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    validationFailure();
  }
  return Object.freeze(copy);
}

function check(
  slot: GeneratedLanguageSlot,
  text: string,
  expectedLanguage: GeneratedLanguage
): GeneratedLanguageValidationCheck {
  return Object.freeze({ slot, text, expectedLanguage });
}

export function createGeneratedLanguageValidationInput(
  completion: GenerationProviderCompletion,
  selectedTargetLanguage: TargetLanguage
): GeneratedLanguageValidationInput {
  const checks: GeneratedLanguageValidationCheck[] = [
    check('translation.english', completion.englishTranslation, 'en')
  ];
  completion.suggestions.forEach((suggestion, index) => {
    const suggestionIndex = index as 0 | 1 | 2;
    checks.push(check(`suggestion[${suggestionIndex}].english`, suggestion.englishText, 'en'));
    checks.push(check(
      `suggestion[${suggestionIndex}].target`,
      suggestion.selectedTargetText,
      selectedTargetLanguage
    ));
  });
  return Object.freeze({
    checks: Object.freeze(checks) as GeneratedLanguageValidationInput['checks']
  });
}

function validateGeneratedLanguageEvidenceUnchecked(
  value: unknown,
  input: GeneratedLanguageValidationInput
): GeneratedLanguageValidationEvidence {
  const evidence = snapshotExactObject(value, INPUT_KEYS);
  const expectedLength = input.checks.length;
  const rawChecks = snapshotExactArray(evidence.checks, expectedLength);
  const checks: GeneratedLanguageValidationEvidenceCheck[] = [];
  for (let index = 0; index < expectedLength; index += 1) {
    const expected = input.checks[index];
    const raw = snapshotExactObject(rawChecks[index], EVIDENCE_CHECK_KEYS);
    if (
      expected === undefined ||
      raw.slot !== expected.slot ||
      raw.expectedLanguage !== expected.expectedLanguage ||
      typeof raw.detectedLanguage !== 'string' ||
      !DETECTED_LANGUAGES.has(raw.detectedLanguage as DetectedGeneratedLanguage) ||
      typeof raw.verdict !== 'string' ||
      !VERDICTS.has(raw.verdict as GeneratedLanguageValidationVerdict) ||
      typeof raw.evidenceType !== 'string' ||
      !EVIDENCE_TYPES.has(raw.evidenceType as GeneratedLanguageEvidenceType) ||
      !isBasisPoints(raw.confidenceBasisPoints) ||
      !isBasisPoints(raw.provisionalScoreBasisPoints) ||
      (raw.evidenceType === 'calibrated' &&
        raw.provisionalScoreBasisPoints !== null) ||
      (raw.evidenceType === 'development-provisional' &&
        raw.confidenceBasisPoints !== null)
    ) {
      validationFailure();
    }
    checks.push(Object.freeze({
      slot: expected.slot,
      expectedLanguage: expected.expectedLanguage,
      detectedLanguage: raw.detectedLanguage as DetectedGeneratedLanguage,
      verdict: raw.verdict as GeneratedLanguageValidationVerdict,
      evidenceType: raw.evidenceType as GeneratedLanguageEvidenceType,
      confidenceBasisPoints: raw.confidenceBasisPoints as number | null,
      provisionalScoreBasisPoints: raw.provisionalScoreBasisPoints as number | null
    }));
  }
  const result = Object.freeze({
    checks: Object.freeze(checks) as GeneratedLanguageValidationEvidence['checks']
  });
  return result;
}

export function validateGeneratedLanguageEvidence(
  value: unknown,
  input: GeneratedLanguageValidationInput
): GeneratedLanguageValidationEvidence {
  try {
    return validateGeneratedLanguageEvidenceUnchecked(value, input);
  } catch {
    throw new GenerationError('language-validation-failure');
  }
}

export function isAcceptedGeneratedLanguageEvidence(
  evidence: GeneratedLanguageValidationEvidence,
  mode: GeneratedLanguageValidationMode = 'production-calibrated'
): boolean {
  return evidence.checks.every((item) =>
    item.verdict === 'match' &&
    item.detectedLanguage === item.expectedLanguage &&
    (mode === 'production-calibrated'
      ? item.evidenceType === 'calibrated' &&
        item.confidenceBasisPoints !== null &&
        item.provisionalScoreBasisPoints === null
      : item.evidenceType === 'development-provisional' &&
        item.confidenceBasisPoints === null &&
        item.provisionalScoreBasisPoints !== null)
  );
}
