import { types as utilTypes } from 'node:util';

import {
  GenerationError,
  type DetectedGeneratedLanguage,
  type GeneratedLanguage,
  type GeneratedLanguageValidationCheck,
  type GeneratedLanguageValidationEvidence,
  type GeneratedLanguageValidationEvidenceCheck,
  type GeneratedLanguageValidationInput,
  type GeneratedLanguageValidator
} from '@palancar/generation';
import {
  countSubstantiveCharacters,
  getLanguageDefinition,
  isTargetLanguage,
  type ClassifiedLanguageEvidence,
  type DevelopmentProvisionalProfile,
  type ProvisionalLanguageEvidence,
  type TextLanguageClassifier
} from '@palancar/language-registry';

const UNKNOWN_LANGUAGE = 'unknown';
const MIXED_LANGUAGE = 'mixed';
const ENGLISH_LANGUAGE = 'en';
const SOURCE_MIN_CORE_WORDS = 2;
const SOURCE_MIN_SINGLETON_CORES = 2;
const CLASSIFIER_ID = 'eld-small-development-provisional';
const VALIDATOR_ID = 'eld-small-development-provisional';
const COMPONENT_VERSION = '1.0.0';
const CLASSIFIERS = new WeakSet<object>();
const VALIDATORS = new WeakSet<object>();
const READINESS_SANITY_FIXTURES = Object.freeze([
  Object.freeze({
    expectedLanguage: 'es',
    text: 'Buenos días. ¿Dónde está la estación?'
  }),
  Object.freeze({
    expectedLanguage: 'tr',
    text: 'Merhaba. Tren istasyonu nerede?'
  }),
  Object.freeze({
    expectedLanguage: 'en',
    text: 'Good morning. Where is the train station?'
  })
] as const);
const CHECK_KEYS = new Set(['slot', 'text', 'expectedLanguage']);
const GENERATED_SLOTS = Object.freeze([
  'translation.english',
  'suggestion[0].english',
  'suggestion[0].target',
  'suggestion[1].english',
  'suggestion[1].target',
  'suggestion[2].english',
  'suggestion[2].target'
] as const);

interface EldResult {
  readonly language: string;
  readonly getScores: () => Readonly<Record<string, number>>;
  readonly isReliable: () => boolean;
}

interface EldDetector {
  detect(text: string): EldResult;
}

export interface DevelopmentProvisionalLanguageBoundaryOptions {
  readonly loadDetector?: () => unknown | Promise<unknown>;
}

interface Detection {
  readonly language: string;
  readonly score: number;
  readonly margin: number;
  readonly reliable: boolean;
}

interface AnalysisInterval {
  readonly text: string;
  readonly lexicalStart: number;
  readonly wordLength: number;
}

interface StrongConflictInterval extends AnalysisInterval {
  readonly language: string;
}

type NormalizedText =
  | Readonly<{ readonly status: 'valid'; readonly text: string }>
  | Readonly<{ readonly status: 'empty' }>
  | Readonly<{ readonly status: 'too-long' }>;

class LazyPromise<T> implements Promise<T> {
  readonly [Symbol.toStringTag] = 'Promise';
  readonly #factory: () => Promise<T>;
  #promise: Promise<T> | undefined;

  constructor(factory: () => Promise<T>) {
    this.#factory = factory;
  }

  #get(): Promise<T> {
    this.#promise ??= this.#factory();
    return this.#promise;
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.#get().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T | TResult> {
    return this.#get().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.#get().finally(onfinally);
  }
}

export interface DevelopmentProvisionalLanguageBoundary {
  readonly classifier: TextLanguageClassifier;
  readonly generatedLanguageValidator: GeneratedLanguageValidator;
}

let sharedEldModulePromise: Promise<typeof import('eld/small')> | undefined;

function loadEldModule(): Promise<typeof import('eld/small')> {
  sharedEldModulePromise ??= import('eld/small');
  return sharedEldModulePromise;
}

async function loadIsolatedEldDetector(): Promise<EldDetector> {
  const module = await loadEldModule();
  const api = module.default as unknown;
  if (typeof api !== 'object' || api === null || utilTypes.isProxy(api)) {
    throw new TypeError('Invalid ELD module');
  }
  const descriptors = Object.getOwnPropertyDescriptors(api);
  const factory = descriptors.newInstance;
  if (
    factory === undefined ||
    !Object.hasOwn(factory, 'value') ||
    typeof factory.value !== 'function'
  ) {
    throw new TypeError('Invalid ELD module');
  }
  const detector = Reflect.apply(factory.value, api, []) as EldDetector;
  if (
    typeof detector !== 'object' ||
    detector === null ||
    utilTypes.isProxy(detector)
  ) {
    throw new TypeError('Invalid ELD detector');
  }
  const detectorDescriptors = Object.getOwnPropertyDescriptors(detector);
  const detectDescriptor = detectorDescriptors.detect;
  if (
    detectDescriptor === undefined ||
    !Object.hasOwn(detectDescriptor, 'value') ||
    typeof detectDescriptor.value !== 'function'
  ) {
    throw new TypeError('Invalid ELD detector');
  }
  return Object.freeze({
    detect: Function.prototype.bind.call(
      detectDescriptor.value,
      detector
    ) as EldDetector['detect']
  });
}

function exactDetector(value: unknown): EldDetector {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
    throw new TypeError('Invalid detector');
  }
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    throw new TypeError('Invalid detector');
  }
  if (
    Reflect.ownKeys(descriptors).length !== 1 ||
    descriptors.detect === undefined ||
    !Object.hasOwn(descriptors.detect, 'value') ||
    typeof descriptors.detect.value !== 'function'
  ) {
    throw new TypeError('Invalid detector');
  }
  return Object.freeze({
    detect: Function.prototype.bind.call(
      descriptors.detect.value,
      value
    ) as EldDetector['detect']
  });
}

function profile(): DevelopmentProvisionalProfile {
  const selected = getLanguageDefinition('es')?.developmentProvisional;
  if (selected === undefined) {
    throw new TypeError('Development provisional language profile is unavailable');
  }
  return selected;
}

function normalizedText(
  value: unknown,
  settings: DevelopmentProvisionalProfile
): NormalizedText {
  if (typeof value !== 'string' || value.length === 0) {
    return Object.freeze({ status: 'empty' });
  }
  if (value.length > settings.maximumInputCodePoints * 2) {
    return Object.freeze({ status: 'too-long' });
  }
  try {
    const normalized = value.normalize('NFKC');
    if (normalized.length === 0) {
      return Object.freeze({ status: 'empty' });
    }
    if (Array.from(normalized).length > settings.maximumInputCodePoints) {
      return Object.freeze({ status: 'too-long' });
    }
    return Object.freeze({ status: 'valid', text: normalized });
  } catch {
    return Object.freeze({ status: 'empty' });
  }
}

function detect(detector: EldDetector, text: string): Detection {
  const result = detector.detect(text);
  if (typeof result !== 'object' || result === null || utilTypes.isProxy(result)) {
    throw new TypeError('Invalid detector result');
  }
  const resultDescriptors = Object.getOwnPropertyDescriptors(result);
  if (
    Reflect.ownKeys(resultDescriptors).length !== 3 ||
    Reflect.ownKeys(resultDescriptors).some((key) =>
      typeof key !== 'string' ||
      !new Set(['language', 'getScores', 'isReliable']).has(key)
    )
  ) {
    throw new TypeError('Invalid detector result');
  }
  const languageDescriptor = resultDescriptors.language;
  const getScoresDescriptor = resultDescriptors.getScores;
  const reliableDescriptor = resultDescriptors.isReliable;
  if (
    languageDescriptor === undefined ||
    !Object.hasOwn(languageDescriptor, 'value') ||
    typeof languageDescriptor.value !== 'string' ||
    (languageDescriptor.value !== '' &&
      !/^[a-z]{2,3}$/u.test(languageDescriptor.value)) ||
    getScoresDescriptor === undefined ||
    !Object.hasOwn(getScoresDescriptor, 'value') ||
    typeof getScoresDescriptor.value !== 'function' ||
    reliableDescriptor === undefined ||
    !Object.hasOwn(reliableDescriptor, 'value') ||
    typeof reliableDescriptor.value !== 'function'
  ) {
    throw new TypeError('Invalid detector result');
  }
  const scores = Reflect.apply(getScoresDescriptor.value, result, []) as unknown;
  if (
    typeof scores !== 'object' ||
    scores === null ||
    utilTypes.isProxy(scores) ||
    (Object.getPrototypeOf(scores) !== Object.prototype &&
      Object.getPrototypeOf(scores) !== null)
  ) {
    throw new TypeError('Invalid detector scores');
  }
  const scoreDescriptors = Object.getOwnPropertyDescriptors(scores) as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const entries: [string, number][] = [];
  for (const key of Reflect.ownKeys(scoreDescriptors)) {
    const descriptor = scoreDescriptors[key];
    if (
      typeof key !== 'string' ||
      !/^[a-z]{2,3}$/u.test(key) ||
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'number' ||
      !Number.isFinite(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 1
    ) {
      throw new TypeError('Invalid detector scores');
    }
    entries.push([key, descriptor.value]);
  }
  entries.sort((left, right) => right[1] - left[1]);
  const top = entries[0];
  const reliable = Reflect.apply(reliableDescriptor.value, result, []) as unknown;
  if (typeof reliable !== 'boolean') {
    throw new TypeError('Invalid detector result');
  }
  if (languageDescriptor.value === '') {
    if (entries.length !== 0 || reliable !== false) {
      throw new TypeError('Invalid detector result');
    }
    return Object.freeze({
      language: UNKNOWN_LANGUAGE,
      score: 0,
      margin: 0,
      reliable: false
    });
  }
  if (top === undefined || languageDescriptor.value !== top[0]) {
    throw new TypeError('Invalid detector result');
  }
  return Object.freeze({
    language: top[0],
    score: top[1],
    margin: top[1] - (entries[1]?.[1] ?? 0),
    reliable
  });
}

function analysisWindows(
  text: string,
  settings: DevelopmentProvisionalProfile
): readonly string[] {
  const candidates: string[] = [];
  const addCandidate = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (
      countSubstantiveCharacters(trimmed) >= settings.minimumWindowCharacters
    ) {
      candidates.push(trimmed);
    }
  };
  for (const clause of text.split(/[.!?;:\n]+/u)) {
    addCandidate(clause);
  }
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (
    let windowWords = settings.minimumSlidingWindowWords;
    windowWords <= settings.maximumSlidingWindowWords;
    windowWords += 1
  ) {
    for (let start = 0; start + windowWords <= words.length; start += 1) {
      addCandidate(words.slice(start, start + windowWords).join(' '));
    }
  }
  return Object.freeze(candidates);
}

function analysisIntervals(
  text: string,
  settings: DevelopmentProvisionalProfile
): readonly AnalysisInterval[] {
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    text: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length
  }));
  const candidates = new Map<string, AnalysisInterval>();
  const addCandidate = (
    candidate: string,
    lexicalStart: number,
    wordLength: number
  ): void => {
    const trimmed = candidate.trim();
    if (wordLength < 1) return;
    if (countSubstantiveCharacters(trimmed) < settings.minimumWindowCharacters) {
      return;
    }
    const key = JSON.stringify([lexicalStart, wordLength, trimmed]);
    if (!candidates.has(key)) {
      candidates.set(key, Object.freeze({
        text: trimmed,
        lexicalStart,
        wordLength
      }));
    }
  };
  for (const clause of text.matchAll(/[^.!?;:\n]+/gu)) {
    const clauseStart = clause.index ?? 0;
    const clauseEnd = clauseStart + clause[0].length;
    const firstWord = words.findIndex(
      (word) => word.start >= clauseStart && word.end <= clauseEnd
    );
    if (firstWord < 0) continue;
    let lastWord = firstWord;
    while (
      lastWord + 1 < words.length &&
      (words[lastWord + 1]?.start ?? Number.POSITIVE_INFINITY) < clauseEnd
    ) {
      lastWord += 1;
    }
    addCandidate(
      clause[0],
      firstWord,
      lastWord - firstWord + 1
    );
  }
  for (
    let windowWords = settings.minimumSlidingWindowWords;
    windowWords <= settings.maximumSlidingWindowWords;
    windowWords += 1
  ) {
    for (let start = 0; start + windowWords <= words.length; start += 1) {
      addCandidate(
        words.slice(start, start + windowWords).map((word) => word.text).join(' '),
        start,
        windowWords
      );
    }
  }
  return Object.freeze([...candidates.values()]);
}

function hasSubstantiveMix(
  detector: EldDetector,
  text: string,
  settings: DevelopmentProvisionalProfile,
  fullDetection: Detection
): boolean {
  const strongLanguages = new Set<string>();
  if (
    fullDetection.reliable &&
    fullDetection.score >= settings.provisionalScoreThreshold &&
    fullDetection.margin >= settings.provisionalMarginThreshold
  ) {
    strongLanguages.add(fullDetection.language);
  }
  for (const window of analysisWindows(text, settings)) {
    const windowDetection = detect(detector, window);
    if (
      windowDetection.reliable &&
      windowDetection.score >= settings.provisionalScoreThreshold &&
      windowDetection.margin >= settings.provisionalMarginThreshold
    ) {
      strongLanguages.add(windowDetection.language);
    }
  }
  return strongLanguages.size > 1;
}

function isStrongDetection(
  detection: Detection,
  settings: DevelopmentProvisionalProfile
): boolean {
  return (
    detection.reliable &&
    detection.score >= settings.provisionalScoreThreshold &&
    detection.margin >= settings.provisionalMarginThreshold
  );
}

function strictlyContains(
  outer: AnalysisInterval,
  inner: AnalysisInterval
): boolean {
  const outerEnd = outer.lexicalStart + outer.wordLength;
  const innerEnd = inner.lexicalStart + inner.wordLength;
  return (
    outer.lexicalStart <= inner.lexicalStart &&
    outerEnd >= innerEnd &&
    (outer.lexicalStart !== inner.lexicalStart || outerEnd !== innerEnd)
  );
}

function sourceConflictReason(
  detector: EldDetector,
  text: string,
  settings: DevelopmentProvisionalProfile,
  selectedLanguage: string
): 'MIXED' | 'MATCH_IGNORED_SINGLETON' | undefined {
  const conflicts = new Map<string, StrongConflictInterval>();
  for (const interval of analysisIntervals(text, settings)) {
    const detection = detect(detector, interval.text);
    if (
      isStrongDetection(detection, settings) &&
      detection.language !== selectedLanguage
    ) {
      const key = `${interval.lexicalStart}:${interval.wordLength}:${detection.language}`;
      if (!conflicts.has(key)) {
        conflicts.set(key, Object.freeze({
          ...interval,
          language: detection.language
        }));
      }
    }
  }

  const conflictIntervals = [...conflicts.values()];
  const minimalCores = conflictIntervals.filter((candidate) =>
    !conflictIntervals.some((other) =>
      other.language === candidate.language &&
      strictlyContains(candidate, other)
    )
  );
  if (minimalCores.some((core) => core.wordLength >= SOURCE_MIN_CORE_WORDS)) {
    return 'MIXED';
  }
  const singletonPositions = new Set(
    minimalCores
      .filter((core) => core.wordLength === 1)
      .map((core) => core.lexicalStart)
  );
  if (singletonPositions.size >= SOURCE_MIN_SINGLETON_CORES) {
    return 'MIXED';
  }
  if (singletonPositions.size === 1) {
    return 'MATCH_IGNORED_SINGLETON';
  }
  return undefined;
}

function evidence(
  settings: DevelopmentProvisionalProfile,
  values: Omit<ProvisionalLanguageEvidence, 'status' | 'detectorVersion' | 'profileVersion'>
): ProvisionalLanguageEvidence {
  return Object.freeze({
    status: 'provisional',
    detectorVersion: settings.detectorVersion,
    profileVersion: settings.profileVersion,
    ...values
  });
}

function classifySource(
  detector: EldDetector,
  rawText: unknown,
  expectedLanguage: GeneratedLanguage
): ProvisionalLanguageEvidence {
  const settings = profile();
  const normalized = normalizedText(rawText, settings);
  if (normalized.status === 'too-long') {
    return evidence(settings, {
      detectedLanguage: UNKNOWN_LANGUAGE,
      provisionalScore: 0,
      decision: 'uncertain',
      reason: 'UNKNOWN'
    });
  }
  if (
    normalized.status === 'empty' ||
    countSubstantiveCharacters(normalized.text) < settings.minimumTextCharacters
  ) {
    return evidence(settings, {
      detectedLanguage: UNKNOWN_LANGUAGE,
      provisionalScore: 0,
      decision: 'uncertain',
      reason: 'TOO_SHORT'
    });
  }
  const text = normalized.text;
  try {
    const full = detect(detector, text);
    if (
      !full.reliable ||
      full.score < settings.provisionalScoreThreshold ||
      full.margin < settings.provisionalMarginThreshold
    ) {
      return evidence(settings, {
        detectedLanguage: UNKNOWN_LANGUAGE,
        provisionalScore: full.score,
        decision: 'uncertain',
        reason: 'UNKNOWN'
      });
    }
    if (full.language !== expectedLanguage) {
      return evidence(settings, {
        detectedLanguage: full.language,
        provisionalScore: full.score,
        decision: 'reject',
        reason:
          full.language === ENGLISH_LANGUAGE && expectedLanguage !== ENGLISH_LANGUAGE
            ? 'ENGLISH'
            : 'UNSELECTED_LANGUAGE'
      });
    }
    const conflictReason = sourceConflictReason(
      detector,
      text,
      settings,
      expectedLanguage
    );
    if (conflictReason === 'MIXED') {
      return evidence(settings, {
        detectedLanguage: MIXED_LANGUAGE,
        provisionalScore: full.score,
        decision: 'reject',
        reason: 'MIXED'
      });
    }
    return evidence(settings, {
      detectedLanguage: full.language,
      provisionalScore: full.score,
      decision: 'accept',
      reason: conflictReason ?? 'MATCH'
    });
  } catch {
    return evidence(settings, {
      detectedLanguage: UNKNOWN_LANGUAGE,
      provisionalScore: 0,
      decision: 'reject',
      reason: 'DETECTOR_ERROR'
    });
  }
}

function classifyGenerated(
  detector: EldDetector,
  rawText: unknown,
  expectedLanguage: GeneratedLanguage
): ProvisionalLanguageEvidence {
  const settings = profile();
  const normalized = normalizedText(rawText, settings);
  if (normalized.status === 'too-long') {
    return evidence(settings, {
      detectedLanguage: UNKNOWN_LANGUAGE,
      provisionalScore: 0,
      decision: 'uncertain',
      reason: 'UNKNOWN'
    });
  }
  if (
    normalized.status === 'empty' ||
    countSubstantiveCharacters(normalized.text) < settings.minimumTextCharacters
  ) {
    return evidence(settings, {
      detectedLanguage: UNKNOWN_LANGUAGE,
      provisionalScore: 0,
      decision: 'uncertain',
      reason: 'TOO_SHORT'
    });
  }
  const text = normalized.text;
  try {
    const full = detect(detector, text);
    if (hasSubstantiveMix(detector, text, settings, full)) {
      return evidence(settings, {
        detectedLanguage: MIXED_LANGUAGE,
        provisionalScore: full.score,
        decision: 'reject',
        reason: 'MIXED'
      });
    }
    if (
      !full.reliable ||
      full.score < settings.provisionalScoreThreshold ||
      full.margin < settings.provisionalMarginThreshold
    ) {
      return evidence(settings, {
        detectedLanguage: UNKNOWN_LANGUAGE,
        provisionalScore: full.score,
        decision: 'uncertain',
        reason: 'UNKNOWN'
      });
    }
    if (full.language === expectedLanguage) {
      return evidence(settings, {
        detectedLanguage: full.language,
        provisionalScore: full.score,
        decision: 'accept',
        reason: 'MATCH'
      });
    }
    return evidence(settings, {
      detectedLanguage: full.language,
      provisionalScore: full.score,
      decision: 'reject',
      reason:
        full.language === ENGLISH_LANGUAGE && expectedLanguage !== ENGLISH_LANGUAGE
          ? 'ENGLISH'
          : 'UNSELECTED_LANGUAGE'
    });
  } catch {
    return evidence(settings, {
      detectedLanguage: UNKNOWN_LANGUAGE,
      provisionalScore: 0,
      decision: 'reject',
      reason: 'DETECTOR_ERROR'
    });
  }
}

function validationFailure(): never {
  throw new GenerationError('language-validation-failure');
}

function snapshotValidationInput(
  input: GeneratedLanguageValidationInput
): GeneratedLanguageValidationInput['checks'] {
  if (typeof input !== 'object' || input === null || utilTypes.isProxy(input)) {
    validationFailure();
  }
  try {
    const prototype = Object.getPrototypeOf(input) as object | null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const checksDescriptor = descriptors.checks;
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Reflect.ownKeys(descriptors).length !== 1 ||
      checksDescriptor === undefined ||
      !Object.hasOwn(checksDescriptor, 'value') ||
      checksDescriptor.enumerable !== true ||
      (!(
        checksDescriptor.writable === true && checksDescriptor.configurable === true
      ) && !(
        checksDescriptor.writable === false && checksDescriptor.configurable === false
      ))
    ) {
      validationFailure();
    }
    const rawChecks = checksDescriptor.value;
    if (utilTypes.isProxy(rawChecks) || !Array.isArray(rawChecks)) {
      validationFailure();
    }
    const arrayPrototype = Object.getPrototypeOf(rawChecks) as object | null;
    const arrayDescriptors = Object.getOwnPropertyDescriptors(rawChecks) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const lengthDescriptor = arrayDescriptors.length;
    const length = lengthDescriptor?.value;
    if (
      arrayPrototype !== Array.prototype ||
      (length !== 5 && length !== 7) ||
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      lengthDescriptor.enumerable !== false ||
      lengthDescriptor.configurable !== false ||
      (lengthDescriptor.writable !== true && lengthDescriptor.writable !== false) ||
      Reflect.ownKeys(arrayDescriptors).some((key) =>
        key !== 'length' &&
        (typeof key !== 'string' ||
          !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= length)
      ) ||
      Reflect.ownKeys(arrayDescriptors).length !== length + 1
    ) {
      validationFailure();
    }
    const checks: GeneratedLanguageValidationCheck[] = [];
    for (let index = 0; index < length; index += 1) {
      const itemDescriptor = arrayDescriptors[String(index)];
      if (
        itemDescriptor === undefined ||
        !Object.hasOwn(itemDescriptor, 'value') ||
        itemDescriptor.enumerable !== true ||
        itemDescriptor.writable !== lengthDescriptor.writable ||
        itemDescriptor.configurable !== (lengthDescriptor.writable === true)
      ) {
        validationFailure();
      }
      const candidate = itemDescriptor.value;
      if (typeof candidate !== 'object' || candidate === null || utilTypes.isProxy(candidate)) {
        validationFailure();
      }
      const checkPrototype = Object.getPrototypeOf(candidate) as object | null;
      const checkDescriptors = Object.getOwnPropertyDescriptors(candidate);
      if (
        (checkPrototype !== Object.prototype && checkPrototype !== null) ||
        Reflect.ownKeys(checkDescriptors).length !== CHECK_KEYS.size ||
        Reflect.ownKeys(checkDescriptors).some((key) =>
          typeof key !== 'string' || !CHECK_KEYS.has(key)
        ) ||
        [...CHECK_KEYS].some(
          (key) =>
            checkDescriptors[key] === undefined ||
            !Object.hasOwn(checkDescriptors[key] as PropertyDescriptor, 'value') ||
            checkDescriptors[key]?.enumerable !== true ||
            !(
              (checkDescriptors[key]?.writable === true &&
                checkDescriptors[key]?.configurable === true) ||
              (checkDescriptors[key]?.writable === false &&
                checkDescriptors[key]?.configurable === false)
            )
        )
      ) {
        validationFailure();
      }
      const modes = [...CHECK_KEYS].map((key) =>
        checkDescriptors[key]?.writable === true ? 'ordinary' : 'frozen'
      );
      if (!modes.every((mode) => mode === modes[0])) {
        validationFailure();
      }
      const slot = checkDescriptors.slot?.value;
      const text = checkDescriptors.text?.value;
      const expected = checkDescriptors.expectedLanguage?.value;
      if (
        slot !== GENERATED_SLOTS[index] ||
        typeof text !== 'string' ||
        (expected !== 'en' &&
          (typeof expected !== 'string' || !isTargetLanguage(expected)))
      ) {
        validationFailure();
      }
      checks.push(Object.freeze({ slot, text, expectedLanguage: expected }));
    }
    return Object.freeze(checks) as GeneratedLanguageValidationInput['checks'];
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    validationFailure();
  }
}

export function createDevelopmentProvisionalLanguageBoundary(
  options: DevelopmentProvisionalLanguageBoundaryOptions = {}
): DevelopmentProvisionalLanguageBoundary {
  const detectorLoader = options.loadDetector ?? loadIsolatedEldDetector;
  let detectorPromise: Promise<EldDetector> | undefined;
  const getDetector = (): Promise<EldDetector> => {
    detectorPromise ??= Promise.resolve()
      .then(detectorLoader)
      .then(exactDetector);
    return detectorPromise;
  };
  const ready = Object.freeze(new LazyPromise<void>(async () => {
    const detector = await getDetector();
    for (const fixture of READINESS_SANITY_FIXTURES) {
      const sanity = detect(detector, fixture.text);
      if (!sanity.reliable || sanity.language !== fixture.expectedLanguage) {
        throw new TypeError('Detector readiness failed');
      }
    }
  }));
  const classifier: TextLanguageClassifier = Object.freeze({
    ready,
    classify: async (
      text: string,
      selectedLanguage?: string
    ): Promise<ClassifiedLanguageEvidence> => {
      if (selectedLanguage === undefined || !isTargetLanguage(selectedLanguage)) {
        return evidence(profile(), {
          detectedLanguage: UNKNOWN_LANGUAGE,
          provisionalScore: 0,
          decision: 'reject',
          reason: 'DETECTOR_ERROR'
        });
      }
      try {
        await ready;
        return classifySource(await getDetector(), text, selectedLanguage);
      } catch {
        return evidence(profile(), {
          detectedLanguage: UNKNOWN_LANGUAGE,
          provisionalScore: 0,
          decision: 'reject',
          reason: 'DETECTOR_ERROR'
        });
      }
    }
  });
  CLASSIFIERS.add(classifier);

  const generatedLanguageValidator: GeneratedLanguageValidator = Object.freeze({
    id: VALIDATOR_ID,
    version: COMPONENT_VERSION,
    validate: async (
      input: GeneratedLanguageValidationInput,
      context: { readonly signal: AbortSignal }
    ): Promise<GeneratedLanguageValidationEvidence> => {
      if (context.signal.aborted) validationFailure();
      const checks = snapshotValidationInput(input);
      let detector: EldDetector;
      try {
        await ready;
        detector = await getDetector();
      } catch {
        detector = Object.freeze({
          detect: () => {
            throw new TypeError('Detector unavailable');
          }
        });
      }
      const results: GeneratedLanguageValidationEvidenceCheck[] = checks.map((item) => {
        const result = classifyGenerated(detector, item.text, item.expectedLanguage);
        return Object.freeze({
          slot: item.slot,
          expectedLanguage: item.expectedLanguage,
          detectedLanguage: (
            result.detectedLanguage === 'en' ||
            result.detectedLanguage === 'es' ||
            result.detectedLanguage === 'tr' ||
            result.detectedLanguage === 'mixed'
              ? result.detectedLanguage
              : result.detectedLanguage === 'unknown'
                ? 'undetermined'
                : 'other'
          ) as DetectedGeneratedLanguage,
          verdict:
            result.decision === 'accept'
              ? 'match'
              : result.decision === 'reject'
                ? 'mismatch'
                : 'indeterminate',
          evidenceType: 'development-provisional',
          confidenceBasisPoints: null,
          provisionalScoreBasisPoints: Math.round(result.provisionalScore * 10_000)
        });
      });
      return Object.freeze({
        checks: Object.freeze(results) as GeneratedLanguageValidationEvidence['checks']
      });
    }
  });
  VALIDATORS.add(generatedLanguageValidator);
  return Object.freeze({ classifier, generatedLanguageValidator });
}

export function isDevelopmentProvisionalTextLanguageClassifier(
  value: unknown
): value is TextLanguageClassifier {
  return typeof value === 'object' && value !== null && CLASSIFIERS.has(value);
}

export function isDevelopmentProvisionalGeneratedLanguageValidator(
  value: unknown
): value is GeneratedLanguageValidator {
  return typeof value === 'object' && value !== null && VALIDATORS.has(value);
}

export const DEVELOPMENT_PROVISIONAL_CLASSIFIER_ID = CLASSIFIER_ID;
