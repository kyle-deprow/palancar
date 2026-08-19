import { VERSION_PATTERN } from '@palancar/contracts';
import { isTargetLanguage } from '@palancar/language-registry';

import type {
  GeneratedLanguageValidationEvidence,
  GeneratedLanguageValidationInput,
  GeneratedLanguageValidator
} from './language-validation.js';
import type {
  GenerationProvider,
  GenerationProviderCompletion,
  GenerationProviderCompletionInput,
  SuggestionPhrasePair
} from './types.js';

export interface DeterministicMockOperationStep<T> {
  readonly result?: T;
  readonly failure?: unknown;
  readonly delayMs?: number;
}

export type DeterministicMockCompletionStep =
  DeterministicMockOperationStep<GenerationProviderCompletion>;

export interface DeterministicMockProviderConfiguration {
  readonly id?: string;
  readonly version?: string;
  readonly complete?:
    | DeterministicMockCompletionStep
    | readonly DeterministicMockCompletionStep[];
}

export interface DeterministicMockCallCounts {
  readonly complete: number;
}

export interface DeterministicFixtureLanguageValidatorConfiguration {
  readonly id?: string;
  readonly version?: string;
  readonly delayMs?: number;
}

const DETERMINISTIC_FIXTURE_VALIDATORS = new WeakSet<object>();

const PROVIDER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CANONICAL_V4_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEGMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const VERSION = new RegExp(VERSION_PATTERN);
const MAX_UINT32 = 4_294_967_295;
const MAX_TRANSCRIPT_LENGTH = 4_096;

const INPUT_KEYS = new Set([
  'sessionId',
  'sessionEpoch',
  'utteranceId',
  'segmentId',
  'acceptedFinalRevision',
  'selectedTargetLanguage',
  'gatePolicyVersion',
  'targetTranscript'
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
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function snapshotInput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    failInput();
  }
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    failInput();
  }
  const copy: Record<string, unknown> = {};
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !INPUT_KEYS.has(key)) {
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
  for (const key of INPUT_KEYS) {
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

function validateInput(value: unknown): GenerationProviderCompletionInput {
  const input = snapshotInput(value);
  if (
    typeof input.sessionId !== 'string' ||
    !CANONICAL_V4_ID.test(input.sessionId) ||
    !isPositiveUint32(input.sessionEpoch) ||
    typeof input.utteranceId !== 'string' ||
    !CANONICAL_V4_ID.test(input.utteranceId) ||
    typeof input.segmentId !== 'string' ||
    !SEGMENT_ID.test(input.segmentId) ||
    !isPositiveUint32(input.acceptedFinalRevision) ||
    typeof input.selectedTargetLanguage !== 'string' ||
    !isTargetLanguage(input.selectedTargetLanguage) ||
    typeof input.gatePolicyVersion !== 'string' ||
    input.gatePolicyVersion.length < 5 ||
    input.gatePolicyVersion.length > 32 ||
    !VERSION.test(input.gatePolicyVersion) ||
    typeof input.targetTranscript !== 'string' ||
    input.targetTranscript.length === 0 ||
    input.targetTranscript.length > MAX_TRANSCRIPT_LENGTH
  ) {
    failInput();
  }
  return Object.freeze({
    sessionId: input.sessionId,
    sessionEpoch: input.sessionEpoch,
    utteranceId: input.utteranceId,
    segmentId: input.segmentId,
    acceptedFinalRevision: input.acceptedFinalRevision,
    selectedTargetLanguage: input.selectedTargetLanguage,
    gatePolicyVersion: input.gatePolicyVersion,
    targetTranscript: input.targetTranscript
  }) as GenerationProviderCompletionInput;
}

function copyCompletion(value: GenerationProviderCompletion): GenerationProviderCompletion {
  if (!isRecord(value)) {
    failConfiguration();
  }
  return Object.freeze({
    englishTranslation: value.englishTranslation,
    suggestions: Object.freeze(value.suggestions.map((pair: SuggestionPhrasePair) => Object.freeze({
      englishText: pair.englishText,
      selectedTargetText: pair.selectedTargetText
    }))) as GenerationProviderCompletion['suggestions']
  });
}

function normalizeSteps(
  value: DeterministicMockCompletionStep | readonly DeterministicMockCompletionStep[] | undefined
): readonly DeterministicMockCompletionStep[] {
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
  return Object.freeze(steps.map((step) => Object.freeze({
    ...step,
    ...(step.result === undefined ? {} : { result: copyCompletion(step.result) })
  })));
}

function delay(milliseconds: number | undefined, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new Error('aborted'));
  }
  if (milliseconds === undefined || milliseconds === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class DeterministicMockProvider implements GenerationProvider {
  readonly id: string;
  readonly version: string;
  readonly #completeSteps: readonly DeterministicMockCompletionStep[];
  readonly #completeInputs: GenerationProviderCompletionInput[] = [];
  readonly #signals: AbortSignal[] = [];
  #completeCalls = 0;

  constructor(configuration: DeterministicMockProviderConfiguration = {}) {
    if (!isRecord(configuration)) {
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
    this.#completeSteps = normalizeSteps(configured.complete);
  }

  get callCounts(): DeterministicMockCallCounts {
    return Object.freeze({ complete: this.#completeCalls });
  }

  get completeCalls(): number {
    return this.#completeCalls;
  }

  get completeInputs(): readonly GenerationProviderCompletionInput[] {
    return Object.freeze([...this.#completeInputs]);
  }

  get signals(): readonly AbortSignal[] {
    return Object.freeze([...this.#signals]);
  }

  async complete(
    input: GenerationProviderCompletionInput,
    context: { readonly signal: AbortSignal }
  ): Promise<GenerationProviderCompletion> {
    const validatedInput = validateInput(input);
    this.#completeInputs.push(validatedInput);
    this.#signals.push(context.signal);
    const index = this.#completeCalls;
    this.#completeCalls += 1;
    const step = this.#completeSteps[index] ?? this.#completeSteps.at(-1);
    if (step === undefined) {
      throw new Error('No deterministic completion script step');
    }
    await delay(step.delayMs, context.signal);
    if (Object.hasOwn(step, 'failure')) {
      throw step.failure;
    }
    if (!Object.hasOwn(step, 'result') || step.result === undefined) {
      throw new Error('Missing deterministic completion script result');
    }
    return copyCompletion(step.result);
  }
}

/**
 * Deterministic all-match validator for local/test fixtures only. Production
 * composition must provide a real generated-language validator.
 */
export class DeterministicFixtureLanguageValidator implements GeneratedLanguageValidator {
  readonly id: string;
  readonly version: string;
  readonly #delayMs: number | undefined;

  constructor(configuration: DeterministicFixtureLanguageValidatorConfiguration = {}) {
    if (!isRecord(configuration)) {
      failConfiguration();
    }
    const id = configuration.id ?? 'deterministic-language-fixture';
    const version = configuration.version ?? '1.0.0';
    if (
      typeof id !== 'string' ||
      !PROVIDER_VALUE.test(id) ||
      typeof version !== 'string' ||
      !PROVIDER_VALUE.test(version) ||
      (configuration.delayMs !== undefined &&
        (typeof configuration.delayMs !== 'number' ||
          !Number.isSafeInteger(configuration.delayMs) ||
          configuration.delayMs < 0))
    ) {
      failConfiguration();
    }
    this.id = id;
    this.version = version;
    this.#delayMs = configuration.delayMs;
    DETERMINISTIC_FIXTURE_VALIDATORS.add(this);
  }

  async validate(
    input: GeneratedLanguageValidationInput,
    context: { readonly signal: AbortSignal }
  ): Promise<GeneratedLanguageValidationEvidence> {
    await delay(this.#delayMs, context.signal);
    return Object.freeze({
      checks: Object.freeze(input.checks.map((item) => Object.freeze({
        slot: item.slot,
        expectedLanguage: item.expectedLanguage,
        detectedLanguage: item.expectedLanguage,
        verdict: 'match' as const,
        confidenceBasisPoints: 10_000
      }))) as GeneratedLanguageValidationEvidence['checks']
    });
  }
}

export function isDeterministicFixtureLanguageValidator(
  value: unknown
): value is DeterministicFixtureLanguageValidator {
  return typeof value === 'object' &&
    value !== null &&
    DETERMINISTIC_FIXTURE_VALIDATORS.has(value);
}

export function createDeterministicMockProvider(
  configuration: DeterministicMockProviderConfiguration = {}
): DeterministicMockProvider {
  return new DeterministicMockProvider(configuration);
}

export const createDeterministicMockGenerationProvider = createDeterministicMockProvider;
