import { VERSION_PATTERN } from '@palancar/contracts';
import { isTargetLanguage } from '@palancar/language-registry';

import type {
  GenerationProvider,
  GenerationProviderSuggestInput,
  GenerationProviderTranslateInput,
  GenerationProviderTranslation,
  SuggestionPhrasePair
} from './types.js';

export interface DeterministicMockOperationStep<T> {
  readonly result?: T;
  readonly failure?: unknown;
  readonly delayMs?: number;
}

export type DeterministicMockTranslationStep = DeterministicMockOperationStep<
  GenerationProviderTranslation | string
>;

export type DeterministicMockSuggestionStep = DeterministicMockOperationStep<
  readonly SuggestionPhrasePair[] | { readonly suggestions: readonly SuggestionPhrasePair[] }
>;

export interface DeterministicMockProviderConfiguration {
  readonly id?: string;
  readonly version?: string;
  readonly translate?:
    | DeterministicMockTranslationStep
    | readonly DeterministicMockTranslationStep[];
  readonly suggest?:
    | DeterministicMockSuggestionStep
    | readonly DeterministicMockSuggestionStep[];
}

export interface DeterministicMockCallCounts {
  readonly translate: number;
  readonly suggest: number;
}

const PROVIDER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CANONICAL_V4_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEGMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const VERSION = new RegExp(VERSION_PATTERN);
const MAX_UINT32 = 4_294_967_295;
const MAX_TRANSCRIPT_LENGTH = 4_096;
const MAX_TEXT_LENGTH = 1_024;

const TRANSLATE_INPUT_KEYS = new Set([
  'sessionId',
  'sessionEpoch',
  'utteranceId',
  'segmentId',
  'acceptedFinalRevision',
  'selectedTargetLanguage',
  'gatePolicyVersion',
  'targetTranscript'
]);

const SUGGEST_INPUT_KEYS = new Set([
  ...TRANSLATE_INPUT_KEYS,
  'englishTranslation'
]);

function failConfiguration(): never {
  throw new TypeError('Invalid deterministic generation provider configuration');
}

function failInput(): never {
  throw new TypeError('Invalid deterministic generation provider input');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotInput(
  value: unknown,
  allowedKeys: ReadonlySet<string>
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failInput();
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
    failInput();
  }
  if (prototype !== Object.prototype && prototype !== null) {
    failInput();
  }

  const copy: Record<string, unknown> = {};
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        failInput();
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        failInput();
      }
      copy[key] = descriptor.value;
    }
  } catch {
    failInput();
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(copy, key)) {
      failInput();
    }
  }
  return copy;
}

function isPositiveUint32(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_UINT32
  );
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isValidCorrelation(input: Record<string, unknown>): boolean {
  return (
    typeof input.sessionId === 'string' &&
    CANONICAL_V4_ID.test(input.sessionId) &&
    isPositiveUint32(input.sessionEpoch) &&
    typeof input.utteranceId === 'string' &&
    CANONICAL_V4_ID.test(input.utteranceId) &&
    typeof input.segmentId === 'string' &&
    SEGMENT_ID.test(input.segmentId) &&
    isPositiveUint32(input.acceptedFinalRevision) &&
    typeof input.selectedTargetLanguage === 'string' &&
    isTargetLanguage(input.selectedTargetLanguage) &&
    typeof input.gatePolicyVersion === 'string' &&
    input.gatePolicyVersion.length >= 5 &&
    input.gatePolicyVersion.length <= 32 &&
    VERSION.test(input.gatePolicyVersion)
  );
}

function validateTranslateInput(input: unknown): GenerationProviderTranslateInput {
  const candidate = snapshotInput(input, TRANSLATE_INPUT_KEYS);
  if (
    !isValidCorrelation(candidate) ||
    !isBoundedString(candidate.targetTranscript, MAX_TRANSCRIPT_LENGTH)
  ) {
    failInput();
  }
  return Object.freeze({
    sessionId: candidate.sessionId,
    sessionEpoch: candidate.sessionEpoch,
    utteranceId: candidate.utteranceId,
    segmentId: candidate.segmentId,
    acceptedFinalRevision: candidate.acceptedFinalRevision,
    selectedTargetLanguage: candidate.selectedTargetLanguage,
    gatePolicyVersion: candidate.gatePolicyVersion,
    targetTranscript: candidate.targetTranscript
  }) as unknown as GenerationProviderTranslateInput;
}

function validateSuggestInput(input: unknown): GenerationProviderSuggestInput {
  const candidate = snapshotInput(input, SUGGEST_INPUT_KEYS);
  if (
    !isValidCorrelation(candidate) ||
    !isBoundedString(candidate.targetTranscript, MAX_TRANSCRIPT_LENGTH) ||
    !isBoundedString(candidate.englishTranslation, MAX_TEXT_LENGTH)
  ) {
    failInput();
  }
  return Object.freeze({
    sessionId: candidate.sessionId,
    sessionEpoch: candidate.sessionEpoch,
    utteranceId: candidate.utteranceId,
    segmentId: candidate.segmentId,
    acceptedFinalRevision: candidate.acceptedFinalRevision,
    selectedTargetLanguage: candidate.selectedTargetLanguage,
    gatePolicyVersion: candidate.gatePolicyVersion,
    targetTranscript: candidate.targetTranscript,
    englishTranslation: candidate.englishTranslation
  }) as unknown as GenerationProviderSuggestInput;
}

function copySuggestions(
  value: readonly SuggestionPhrasePair[] | { readonly suggestions: readonly SuggestionPhrasePair[] }
): readonly SuggestionPhrasePair[] | { readonly suggestions: readonly SuggestionPhrasePair[] } {
  if (!('suggestions' in value)) {
    return Object.freeze(value.map((pair) => Object.freeze({ ...pair })));
  }
  return Object.freeze({
    suggestions: Object.freeze(
      value.suggestions.map((pair: SuggestionPhrasePair) => Object.freeze({ ...pair }))
    )
  });
}

function copyTranslation(
  value: GenerationProviderTranslation | string
): GenerationProviderTranslation | string {
  if (typeof value === 'string') {
    return value;
  }
  return Object.freeze({ englishTranslation: value.englishTranslation });
}

function normalizeSteps<T>(
  value: DeterministicMockOperationStep<T> | readonly DeterministicMockOperationStep<T>[] | undefined
): readonly DeterministicMockOperationStep<T>[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  const steps = Array.isArray(value) ? value : [value];
  if (steps.length === 0) {
    failConfiguration();
  }
  for (const step of steps) {
    if (!isRecord(step)) {
      failConfiguration();
    }
    if (
      step.delayMs !== undefined &&
      (typeof step.delayMs !== 'number' ||
        !Number.isSafeInteger(step.delayMs) ||
        step.delayMs < 0)
    ) {
      failConfiguration();
    }
  }
  return Object.freeze(steps.map((step) => Object.freeze({ ...step })));
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function delay(milliseconds: number | undefined): Promise<void> {
  if (milliseconds === undefined || milliseconds === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function throwFailure(failure: unknown): never {
  throw failure;
}

export class DeterministicMockProvider implements GenerationProvider {
  readonly id: string;
  readonly version: string;
  readonly #translateSteps: readonly DeterministicMockTranslationStep[];
  readonly #suggestSteps: readonly DeterministicMockSuggestionStep[];
  readonly #translateInputs: GenerationProviderTranslateInput[] = [];
  readonly #suggestInputs: GenerationProviderSuggestInput[] = [];
  #translateCalls = 0;
  #suggestCalls = 0;

  constructor(configuration: DeterministicMockProviderConfiguration = {}) {
    if (
      typeof configuration !== 'object' ||
      configuration === null ||
      Array.isArray(configuration)
    ) {
      failConfiguration();
    }
    const configured = configuration as DeterministicMockProviderConfiguration;
    const id = configured.id ?? 'deterministic-mock';
    const version = configured.version ?? '1.0.0';
    if (
      typeof id !== 'string' ||
      !PROVIDER_VALUE.test(id) ||
      typeof version !== 'string' ||
      !PROVIDER_VALUE.test(version)
    ) {
      failConfiguration();
    }
    this.id = id;
    this.version = version;
    this.#translateSteps = Object.freeze(
      normalizeSteps(configured.translate).map((step) => {
        if (!hasOwn(step, 'result') || step.result === undefined) {
          return Object.freeze({ ...step });
        }
        return Object.freeze({ ...step, result: copyTranslation(step.result) });
      })
    );
    this.#suggestSteps = Object.freeze(
      normalizeSteps(configured.suggest).map((step) => {
        if (!hasOwn(step, 'result') || step.result === undefined) {
          return Object.freeze({ ...step });
        }
        return Object.freeze({ ...step, result: copySuggestions(step.result) });
      })
    );
  }

  get callCounts(): DeterministicMockCallCounts {
    return Object.freeze({
      translate: this.#translateCalls,
      suggest: this.#suggestCalls
    });
  }

  get translateCalls(): number {
    return this.#translateCalls;
  }

  get suggestCalls(): number {
    return this.#suggestCalls;
  }

  get translateInputs(): readonly GenerationProviderTranslateInput[] {
    return Object.freeze([...this.#translateInputs]);
  }

  get suggestInputs(): readonly GenerationProviderSuggestInput[] {
    return Object.freeze([...this.#suggestInputs]);
  }

  async translate(
    input: GenerationProviderTranslateInput
  ): Promise<GenerationProviderTranslation | string> {
    const validatedInput = validateTranslateInput(input);
    this.#translateInputs.push(validatedInput);
    const index = this.#translateCalls;
    this.#translateCalls += 1;
    const step = this.#translateSteps[index] ?? this.#translateSteps.at(-1);
    if (step === undefined) {
      throw new Error('No deterministic translation script step');
    }
    await delay(step.delayMs);
    if (hasOwn(step, 'failure')) {
      throwFailure(step.failure);
    }
    if (!hasOwn(step, 'result') || step.result === undefined) {
      throw new Error('Missing deterministic translation script result');
    }
    return copyTranslation(step.result);
  }

  async suggest(
    input: GenerationProviderSuggestInput
  ): Promise<readonly SuggestionPhrasePair[] | { readonly suggestions: readonly SuggestionPhrasePair[] }> {
    const validatedInput = validateSuggestInput(input);
    this.#suggestInputs.push(validatedInput);
    const index = this.#suggestCalls;
    this.#suggestCalls += 1;
    const step = this.#suggestSteps[index] ?? this.#suggestSteps.at(-1);
    if (step === undefined) {
      throw new Error('No deterministic suggestion script step');
    }
    await delay(step.delayMs);
    if (hasOwn(step, 'failure')) {
      throwFailure(step.failure);
    }
    if (!hasOwn(step, 'result') || step.result === undefined) {
      throw new Error('Missing deterministic suggestion script result');
    }
    return copySuggestions(step.result);
  }
}

export function createDeterministicMockProvider(
  configuration: DeterministicMockProviderConfiguration = {}
): DeterministicMockProvider {
  return new DeterministicMockProvider(configuration);
}

export const createDeterministicMockGenerationProvider = createDeterministicMockProvider;
