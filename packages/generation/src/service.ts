import { isAcceptedTargetTurn } from './accepted.js';
import { GenerationError } from './errors.js';
import { MetadataOnlyEvidenceCollector } from './evidence.js';
import type {
  AcceptedTargetTurn,
  GenerationCorrelation,
  GenerationEvidenceRecord,
  GenerationProvider,
  GenerationProviderSuggestInput,
  GenerationProviderTranslateInput,
  GenerationProviderTranslation,
  GenerationServiceOptions,
  GenerationSuggestions,
  GenerationTranslation,
  MetadataOnlyEvidenceCollectorLike,
  SuggestionPhrasePair
} from './types.js';

const TEXT_LIMIT = 1_024;
const PROVIDER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const translationResults = new WeakSet<object>();

type ProviderTranslate = GenerationProvider['translate'];
type ProviderSuggest = GenerationProvider['suggest'];

interface ProviderSnapshot {
  readonly id: string;
  readonly version: string;
  readonly translate: ProviderTranslate;
  readonly suggest: ProviderSuggest;
}

function invalid(category: 'forged-value' | 'correlation-mismatch' | 'invalid-provider'): never {
  throw new GenerationError(category);
}

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= TEXT_LIMIT;
}

function descriptorFor(value: object, key: string): PropertyDescriptor | undefined {
  const visited = new Set<object>();
  let current: object | null = value;
  while (current !== null) {
    if (visited.has(current)) {
      throw new GenerationError('invalid-provider');
    }
    visited.add(current);

    let descriptors: Record<PropertyKey, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current) as Record<
        PropertyKey,
        PropertyDescriptor
      >;
    } catch {
      throw new GenerationError('invalid-provider');
    }
    if (Object.hasOwn(descriptors, key)) {
      return descriptors[key];
    }
    try {
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      throw new GenerationError('invalid-provider');
    }
  }
  return undefined;
}

function providerSnapshot(value: unknown): ProviderSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('invalid-provider');
  }

  let idDescriptor: PropertyDescriptor | undefined;
  let versionDescriptor: PropertyDescriptor | undefined;
  let translateDescriptor: PropertyDescriptor | undefined;
  let suggestDescriptor: PropertyDescriptor | undefined;
  try {
    idDescriptor = descriptorFor(value, 'id');
    versionDescriptor = descriptorFor(value, 'version');
    translateDescriptor = descriptorFor(value, 'translate');
    suggestDescriptor = descriptorFor(value, 'suggest');
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    throw new GenerationError('invalid-provider');
  }

  if (
    idDescriptor === undefined ||
    !Object.hasOwn(idDescriptor, 'value') ||
    versionDescriptor === undefined ||
    !Object.hasOwn(versionDescriptor, 'value') ||
    translateDescriptor === undefined ||
    !Object.hasOwn(translateDescriptor, 'value') ||
    suggestDescriptor === undefined ||
    !Object.hasOwn(suggestDescriptor, 'value')
  ) {
    invalid('invalid-provider');
  }

  const id = idDescriptor.value;
  const version = versionDescriptor.value;
  const translate = translateDescriptor.value;
  const suggest = suggestDescriptor.value;
  if (
    typeof id !== 'string' ||
    !PROVIDER_VALUE.test(id) ||
    typeof version !== 'string' ||
    !PROVIDER_VALUE.test(version) ||
    typeof translate !== 'function' ||
    typeof suggest !== 'function'
  ) {
    invalid('invalid-provider');
  }

  try {
    return Object.freeze({
      id,
      version,
      translate: Function.prototype.bind.call(translate, value) as ProviderTranslate,
      suggest: Function.prototype.bind.call(suggest, value) as ProviderSuggest
    });
  } catch {
    throw new GenerationError('invalid-provider');
  }
}

function keyFor(
  correlation: GenerationCorrelation,
  targetTranscript: string,
  englishTranslation?: string
): string {
  const key = [
    correlation.sessionId,
    correlation.sessionEpoch,
    correlation.utteranceId,
    correlation.segmentId,
    correlation.acceptedFinalRevision,
    correlation.selectedTargetLanguage,
    targetTranscript,
    correlation.gatePolicyVersion
  ];
  if (englishTranslation !== undefined) {
    key.push(englishTranslation);
  }
  return JSON.stringify(key);
}

function correlationFromTurn(turn: AcceptedTargetTurn): GenerationCorrelation {
  return {
    sessionId: turn.sessionId,
    sessionEpoch: turn.sessionEpoch,
    utteranceId: turn.utteranceId,
    segmentId: turn.segmentId,
    acceptedFinalRevision: turn.acceptedFinalRevision,
    selectedTargetLanguage: turn.selectedTargetLanguage,
    gatePolicyVersion: turn.gatePolicyVersion
  };
}

function sameCorrelation(
  left: GenerationCorrelation,
  right: GenerationCorrelation
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch &&
    left.utteranceId === right.utteranceId &&
    left.segmentId === right.segmentId &&
    left.acceptedFinalRevision === right.acceptedFinalRevision &&
    left.selectedTargetLanguage === right.selectedTargetLanguage &&
    left.gatePolicyVersion === right.gatePolicyVersion
  );
}

function invalidProviderResult(): never {
  throw new GenerationError('invalid-provider-result');
}

function snapshotPlainObject(
  value: object,
  allowedKeys: ReadonlySet<string>
): Record<string, unknown> {
  if (Array.isArray(value)) {
    invalidProviderResult();
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
    invalidProviderResult();
  }
  if (prototype !== Object.prototype && prototype !== null) {
    invalidProviderResult();
  }

  const copy: Record<string, unknown> = {};
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        invalidProviderResult();
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        invalidProviderResult();
      }
      copy[key] = descriptor.value;
    }
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    invalidProviderResult();
  }
  return copy;
}

function snapshotArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalidProviderResult();
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
    invalidProviderResult();
  }
  if (prototype !== Array.prototype) {
    invalidProviderResult();
  }

  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > 3
  ) {
    invalidProviderResult();
  }
  const length = lengthDescriptor.value;
  const copy: unknown[] = [];
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === 'length') {
        continue;
      }
      if (
        typeof key !== 'string' ||
        !/^(?:0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= length
      ) {
        invalidProviderResult();
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        invalidProviderResult();
      }
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        invalidProviderResult();
      }
      copy.push(descriptor.value);
    }
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    invalidProviderResult();
  }
  return Object.freeze(copy);
}

const TRANSLATION_KEYS = new Set(['englishTranslation']);
const SUGGESTIONS_KEYS = new Set(['suggestions']);
const PHRASE_KEYS = new Set(['englishText', 'selectedTargetText']);

function providerTranslation(value: unknown): string {
  if (typeof value === 'string') {
    if (!isBoundedText(value)) {
      invalidProviderResult();
    }
    return value;
  }
  if (typeof value !== 'object' || value === null) {
    invalidProviderResult();
  }
  const snapshot = snapshotPlainObject(value, TRANSLATION_KEYS);
  const candidate = snapshot.englishTranslation;
  if (!isBoundedText(candidate)) {
    invalidProviderResult();
  }
  return candidate;
}

function providerSuggestions(value: unknown): readonly SuggestionPhrasePair[] {
  let candidate: readonly unknown[];
  if (Array.isArray(value)) {
    candidate = snapshotArray(value);
  } else {
    if (typeof value !== 'object' || value === null) {
      invalidProviderResult();
    }
    const wrapper = snapshotPlainObject(value, SUGGESTIONS_KEYS);
    candidate = snapshotArray(wrapper.suggestions);
  }
  if (candidate.length !== 2 && candidate.length !== 3) {
    invalidProviderResult();
  }

  const copy: SuggestionPhrasePair[] = [];
  for (const pair of candidate) {
    if (typeof pair !== 'object' || pair === null) {
      invalidProviderResult();
    }
    const valuePair = snapshotPlainObject(pair, PHRASE_KEYS);
    const englishText = valuePair.englishText;
    const selectedTargetText = valuePair.selectedTargetText;
    if (!isBoundedText(englishText) || !isBoundedText(selectedTargetText)) {
      invalidProviderResult();
    }
    copy.push(Object.freeze({ englishText, selectedTargetText }));
  }
  return Object.freeze(copy);
}

function now(): number {
  return performance.now();
}

export class GenerationService {
  readonly #provider: ProviderSnapshot;
  readonly #evidence: MetadataOnlyEvidenceCollectorLike;
  readonly #translations = new WeakSet<object>();
  readonly #translationPromises = new Map<string, Promise<GenerationTranslation>>();
  readonly #suggestionPromises = new Map<string, Promise<GenerationSuggestions>>();

  constructor(provider: GenerationProvider, evidenceCollector?: MetadataOnlyEvidenceCollectorLike);
  constructor(options: GenerationServiceOptions);
  constructor(
    providerOrOptions: GenerationProvider | GenerationServiceOptions,
    evidenceCollector: MetadataOnlyEvidenceCollectorLike = new MetadataOnlyEvidenceCollector()
  ) {
    const isOptions =
      typeof providerOrOptions === 'object' &&
      providerOrOptions !== null &&
      Object.hasOwn(providerOrOptions, 'provider');
    const provider = isOptions
      ? (providerOrOptions as GenerationServiceOptions).provider
      : providerOrOptions as GenerationProvider;
    const configuredEvidence = isOptions
      ? (providerOrOptions as GenerationServiceOptions).evidenceCollector ??
        (providerOrOptions as GenerationServiceOptions).evidence
      : evidenceCollector;
    this.#provider = providerSnapshot(provider);
    this.#evidence = configuredEvidence ?? new MetadataOnlyEvidenceCollector();
    if (
      typeof this.#evidence.add !== 'function' ||
      !Array.isArray(this.#evidence.records)
    ) {
      invalid('invalid-provider');
    }
  }

  get provider(): Readonly<{ readonly id: string; readonly version: string }> {
    return Object.freeze({ id: this.#provider.id, version: this.#provider.version });
  }

  get evidence(): readonly GenerationEvidenceRecord[] {
    return this.#evidence.records;
  }

  translate(turn: AcceptedTargetTurn): Promise<GenerationTranslation> {
    if (!isAcceptedTargetTurn(turn)) {
      throw new GenerationError('forged-value');
    }
    const correlation = correlationFromTurn(turn);
    const key = keyFor(correlation, turn.targetTranscript);
    const existing = this.#translationPromises.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const promise = this.#executeTranslate(turn, correlation);
    this.#translationPromises.set(key, promise);
    void promise.then(
      () => {
        if (this.#translationPromises.get(key) === promise) {
          this.#translationPromises.delete(key);
        }
      },
      () => {
        if (this.#translationPromises.get(key) === promise) {
          this.#translationPromises.delete(key);
        }
      }
    );
    return promise;
  }

  suggest(
    turn: AcceptedTargetTurn,
    translation: GenerationTranslation
  ): Promise<GenerationSuggestions> {
    if (!isAcceptedTargetTurn(turn)) {
      throw new GenerationError('forged-value');
    }
    if (
      typeof translation !== 'object' ||
      translation === null ||
      !this.#translations.has(translation) ||
      !translationResults.has(translation)
    ) {
      throw new GenerationError('forged-value');
    }
    const turnCorrelation = correlationFromTurn(turn);
    if (!sameCorrelation(turnCorrelation, translation)) {
      throw new GenerationError('correlation-mismatch');
    }
    const key = keyFor(
      turnCorrelation,
      turn.targetTranscript,
      translation.englishTranslation
    );
    const existing = this.#suggestionPromises.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const promise = this.#executeSuggest(
      turn.targetTranscript,
      turnCorrelation,
      translation
    );
    this.#suggestionPromises.set(key, promise);
    void promise.then(
      () => {
        if (this.#suggestionPromises.get(key) === promise) {
          this.#suggestionPromises.delete(key);
        }
      },
      () => {
        if (this.#suggestionPromises.get(key) === promise) {
          this.#suggestionPromises.delete(key);
        }
      }
    );
    return promise;
  }

  async #executeTranslate(
    turn: AcceptedTargetTurn,
    correlation: GenerationCorrelation
  ): Promise<GenerationTranslation> {
    const start = now();
    let status: 'success' | 'failure' = 'failure';
    let failureCategory: GenerationEvidenceRecord['failureCategory'];
    try {
      const providerInput: GenerationProviderTranslateInput = Object.freeze({
        ...correlation,
        targetTranscript: turn.targetTranscript
      });
      let raw: GenerationProviderTranslation | string;
      try {
        raw = await this.#provider.translate(providerInput);
      } catch {
        throw new GenerationError('provider-failure');
      }
      const result = Object.freeze({
        ...correlation,
        englishTranslation: providerTranslation(raw)
      });
      this.#translations.add(result);
      translationResults.add(result);
      status = 'success';
      return result;
    } catch (error) {
      const publicError = error instanceof GenerationError
        ? error
        : new GenerationError('provider-failure');
      failureCategory = publicError.category;
      throw publicError;
    } finally {
      const end = now();
      this.#recordEvidence({
        ...correlation,
        operation: 'translate',
        status,
        ...(failureCategory === undefined ? {} : { failureCategory }),
        providerId: this.#provider.id,
        providerVersion: this.#provider.version,
        startMonotonicMs: start,
        endMonotonicMs: end,
        latencyMs: Math.max(0, end - start)
      });
    }
  }

  async #executeSuggest(
    targetTranscript: AcceptedTargetTurn['targetTranscript'],
    correlation: GenerationCorrelation,
    translation: GenerationTranslation
  ): Promise<GenerationSuggestions> {
    const start = now();
    let status: 'success' | 'failure' = 'failure';
    let failureCategory: GenerationEvidenceRecord['failureCategory'];
    try {
      const providerInput: GenerationProviderSuggestInput = Object.freeze({
        ...correlation,
        targetTranscript,
        englishTranslation: translation.englishTranslation
      });
      let raw: readonly SuggestionPhrasePair[] | { readonly suggestions: readonly SuggestionPhrasePair[] };
      try {
        raw = await this.#provider.suggest(providerInput);
      } catch {
        throw new GenerationError('provider-failure');
      }
      const suggestions = providerSuggestions(raw);
      const result = Object.freeze({
        ...correlation,
        suggestions
      });
      status = 'success';
      return result as GenerationSuggestions;
    } catch (error) {
      const publicError = error instanceof GenerationError
        ? error
        : new GenerationError('provider-failure');
      failureCategory = publicError.category;
      throw publicError;
    } finally {
      const end = now();
      this.#recordEvidence({
        ...correlation,
        operation: 'suggest',
        status,
        ...(failureCategory === undefined ? {} : { failureCategory }),
        providerId: this.#provider.id,
        providerVersion: this.#provider.version,
        startMonotonicMs: start,
        endMonotonicMs: end,
        latencyMs: Math.max(0, end - start)
      });
    }
  }

  #recordEvidence(record: GenerationEvidenceRecord): void {
    try {
      this.#evidence.add(record);
    } catch {
      // Evidence is diagnostic only. It must never replace the operation result.
    }
  }
}
