import { isAcceptedTargetTurn } from './accepted.js';
import { GenerationError } from './errors.js';
import { MetadataOnlyEvidenceCollector } from './evidence.js';
import type {
  AcceptedTargetTurn,
  GenerationCompletion,
  GenerationCompletionOptions,
  GenerationCorrelation,
  GenerationEvidenceRecord,
  GenerationProvider,
  GenerationProviderCompletion,
  GenerationProviderCompletionInput,
  GenerationServiceOptions,
  MetadataOnlyEvidenceCollectorLike,
  SuggestionPhrasePair
} from './types.js';

const ENGLISH_TRANSLATION_LIMIT = 256;
const SUGGESTION_TEXT_LIMIT = 160;
const PROVIDER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

type ProviderComplete = GenerationProvider['complete'];

interface ProviderSnapshot {
  readonly id: string;
  readonly version: string;
  readonly complete: ProviderComplete;
}

interface CompletionEntry {
  readonly promise: Promise<GenerationCompletion>;
  readonly controller: AbortController;
  readonly listeners: Map<AbortSignal, () => void>;
}

function invalid(category: 'forged-value' | 'invalid-provider'): never {
  throw new GenerationError(category);
}

function invalidProviderResult(): never {
  throw new GenerationError('invalid-provider-result');
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
  let completeDescriptor: PropertyDescriptor | undefined;
  try {
    idDescriptor = descriptorFor(value, 'id');
    versionDescriptor = descriptorFor(value, 'version');
    completeDescriptor = descriptorFor(value, 'complete');
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    invalid('invalid-provider');
  }

  if (
    idDescriptor === undefined ||
    !Object.hasOwn(idDescriptor, 'value') ||
    versionDescriptor === undefined ||
    !Object.hasOwn(versionDescriptor, 'value') ||
    completeDescriptor === undefined ||
    !Object.hasOwn(completeDescriptor, 'value')
  ) {
    invalid('invalid-provider');
  }

  const id = idDescriptor.value;
  const version = versionDescriptor.value;
  const complete = completeDescriptor.value;
  if (
    typeof id !== 'string' ||
    !PROVIDER_VALUE.test(id) ||
    typeof version !== 'string' ||
    !PROVIDER_VALUE.test(version) ||
    typeof complete !== 'function'
  ) {
    invalid('invalid-provider');
  }

  try {
    return Object.freeze({
      id,
      version,
      complete: Function.prototype.bind.call(complete, value) as ProviderComplete
    });
  } catch {
    invalid('invalid-provider');
  }
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
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
  for (const key of allowedKeys) {
    if (!Object.hasOwn(copy, key)) {
      invalidProviderResult();
    }
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

function validateCompletion(value: unknown): GenerationProviderCompletion {
  if (typeof value !== 'object' || value === null) {
    invalidProviderResult();
  }
  const completion = snapshotPlainObject(value, new Set(['englishTranslation', 'suggestions']));
  if (!isBoundedText(completion.englishTranslation, ENGLISH_TRANSLATION_LIMIT)) {
    invalidProviderResult();
  }
  const rawSuggestions = snapshotArray(completion.suggestions);
  if (rawSuggestions.length !== 2 && rawSuggestions.length !== 3) {
    invalidProviderResult();
  }
  const suggestions: SuggestionPhrasePair[] = [];
  for (const rawPair of rawSuggestions) {
    if (typeof rawPair !== 'object' || rawPair === null) {
      invalidProviderResult();
    }
    const pair = snapshotPlainObject(rawPair, new Set(['englishText', 'selectedTargetText']));
    if (
      !isBoundedText(pair.englishText, SUGGESTION_TEXT_LIMIT) ||
      !isBoundedText(pair.selectedTargetText, SUGGESTION_TEXT_LIMIT)
    ) {
      invalidProviderResult();
    }
    suggestions.push(Object.freeze({
      englishText: pair.englishText,
      selectedTargetText: pair.selectedTargetText
    }));
  }

  return Object.freeze({
    englishTranslation: completion.englishTranslation,
    suggestions: Object.freeze(suggestions) as GenerationProviderCompletion['suggestions']
  });
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

function keyFor(correlation: GenerationCorrelation, targetTranscript: string): string {
  return JSON.stringify([
    correlation.sessionId,
    correlation.sessionEpoch,
    correlation.utteranceId,
    correlation.segmentId,
    correlation.acceptedFinalRevision,
    correlation.selectedTargetLanguage,
    correlation.gatePolicyVersion,
    targetTranscript
  ]);
}

function sameCorrelation(left: GenerationCorrelation, right: GenerationCorrelation): boolean {
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

function now(): number {
  return performance.now();
}

export class GenerationService {
  readonly #provider: ProviderSnapshot;
  readonly #evidence: MetadataOnlyEvidenceCollectorLike;
  readonly #completionPromises = new Map<string, CompletionEntry>();

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

  complete(
    turn: AcceptedTargetTurn,
    options: GenerationCompletionOptions = {}
  ): Promise<GenerationCompletion> {
    if (!isAcceptedTargetTurn(turn)) {
      throw new GenerationError('forged-value');
    }
    if (
      typeof options !== 'object' ||
      options === null ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    ) {
      throw new GenerationError('forged-value');
    }

    const correlation = correlationFromTurn(turn);
    const key = keyFor(correlation, turn.targetTranscript);
    const existing = this.#completionPromises.get(key);
    if (existing !== undefined) {
      this.#attachSignal(existing, options.signal);
      return existing.promise;
    }

    const controller = new AbortController();
    let resolvePromise!: (value: GenerationCompletion) => void;
    let rejectPromise!: (reason?: unknown) => void;
    const promise = new Promise<GenerationCompletion>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const entry: CompletionEntry = {
      promise,
      controller,
      listeners: new Map()
    };
    this.#completionPromises.set(key, entry);
    this.#attachSignal(entry, options.signal);

    void this.#executeComplete(turn, correlation, controller).then(resolvePromise, rejectPromise);
    void promise.then(
      () => this.#settle(key, entry),
      () => this.#settle(key, entry)
    );
    return promise;
  }

  #attachSignal(entry: CompletionEntry, signal: AbortSignal | undefined): void {
    if (signal === undefined || entry.listeners.has(signal)) {
      return;
    }
    const onAbort = (): void => {
      if (!entry.controller.signal.aborted) {
        entry.controller.abort();
      }
    };
    entry.listeners.set(signal, onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  }

  #settle(key: string, entry: CompletionEntry): void {
    if (this.#completionPromises.get(key) === entry) {
      this.#completionPromises.delete(key);
    }
    for (const [signal, listener] of entry.listeners) {
      signal.removeEventListener('abort', listener);
    }
    entry.listeners.clear();
  }

  async #executeComplete(
    turn: AcceptedTargetTurn,
    correlation: GenerationCorrelation,
    controller: AbortController
  ): Promise<GenerationCompletion> {
    const start = now();
    let status: GenerationEvidenceRecord['status'] = 'failure';
    let failureCategory: GenerationEvidenceRecord['failureCategory'];
    try {
      if (controller.signal.aborted) {
        throw new GenerationError('provider-failure');
      }
      const input: GenerationProviderCompletionInput = Object.freeze({
        ...correlation,
        targetTranscript: turn.targetTranscript
      });
      let raw: GenerationProviderCompletion;
      try {
        raw = await this.#provider.complete(input, { signal: controller.signal });
      } catch {
        throw new GenerationError('provider-failure');
      }
      if (controller.signal.aborted) {
        throw new GenerationError('provider-failure');
      }
      const parsed = validateCompletion(raw);
      const result = Object.freeze({
        ...correlation,
        englishTranslation: parsed.englishTranslation,
        suggestions: parsed.suggestions
      });
      if (!sameCorrelation(correlation, result)) {
        throw new GenerationError('correlation-mismatch');
      }
      status = 'success';
      return result;
    } catch (error) {
      const publicError = error instanceof GenerationError
        ? error
        : new GenerationError('provider-failure');
      if (controller.signal.aborted) {
        status = 'cancelled';
        failureCategory = undefined;
      } else {
        failureCategory = publicError.category;
      }
      throw publicError;
    } finally {
      const end = now();
      try {
        this.#recordEvidence({
          ...correlation,
          operation: 'complete',
          status,
          ...(failureCategory === undefined ? {} : { failureCategory }),
          providerId: this.#provider.id,
          providerVersion: this.#provider.version,
          startMonotonicMs: start,
          endMonotonicMs: end,
          latencyMs: Math.max(0, end - start)
        });
      } catch {
        // Evidence collection is best effort and must not alter the operation result.
      }
    }
  }

  #recordEvidence(record: GenerationEvidenceRecord): void {
    this.#evidence.add(record);
  }
}
