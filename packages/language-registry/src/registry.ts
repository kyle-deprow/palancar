import type {
  DevelopmentProvisionalProfile,
  LanguageDefinition,
  TargetLanguage
} from './types.js';

export interface LanguageRegistry<TCode extends string> {
  readonly get: (code: string) => LanguageDefinition<TCode> | undefined;
  readonly list: () => readonly LanguageDefinition<TCode>[];
}

function freezeDefinition<TCode extends string>(
  definition: LanguageDefinition<TCode>
): LanguageDefinition<TCode> {
  const fixtureSuiteIds = Object.freeze([...definition.fixtureSuiteIds]);
  return Object.freeze({
    ...definition,
    fixtureSuiteIds,
    finalCalibration: Object.freeze({ ...definition.finalCalibration }),
    ...(definition.developmentProvisional === undefined
      ? {}
      : {
          developmentProvisional: Object.freeze({
            ...definition.developmentProvisional
          })
        }),
    ...(definition.partialDisplayCalibration === undefined
      ? {}
      : {
          partialDisplayCalibration: Object.freeze({
            ...definition.partialDisplayCalibration
          })
        })
  });
}

function requireExactKeys(
  value: object,
  allowedKeys: readonly string[],
  label: string
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported field: ${key}`);
    }
  }
}

function requireExactNonemptyString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${label} must be an exact nonempty string`);
  }
  return value;
}

function requireThreshold(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new RangeError(`${label} must be between 0 and 1`);
  }
  return value;
}

function validateDefinition<TCode extends string>(
  definition: LanguageDefinition<TCode>
): void {
  if (typeof definition !== 'object' || definition === null) {
    throw new TypeError('Language definition must be an object');
  }
  requireExactKeys(
    definition,
    [
      'code',
      'displayName',
      'transcriptionHint',
      'finalCalibration',
      'mixedPolicy',
      'fixtureSuiteIds',
      'partialDisplayCalibration',
      'developmentProvisional'
    ],
    'Language definition'
  );
  const code = requireExactNonemptyString(definition.code, 'Language code');
  if (code.toLowerCase() !== code) {
    throw new TypeError('Language code must be lowercase');
  }
  requireExactNonemptyString(definition.displayName, 'Language display name');
  if (definition.transcriptionHint !== undefined) {
    requireExactNonemptyString(
      definition.transcriptionHint,
      'Language transcription hint'
    );
  }
  if (definition.mixedPolicy !== 'reject') {
    throw new TypeError('Language mixed policy must be reject');
  }
  if (!Array.isArray(definition.fixtureSuiteIds)) {
    throw new TypeError('Language fixture suite ids must be an array');
  }
  const fixtureSuiteIds = new Set<string>();
  for (const fixtureSuiteId of definition.fixtureSuiteIds) {
    const id = requireExactNonemptyString(fixtureSuiteId, 'Fixture suite id');
    if (fixtureSuiteIds.has(id)) {
      throw new Error(`Duplicate fixture suite id: ${id}`);
    }
    fixtureSuiteIds.add(id);
  }

  validateCalibrationProfile(definition.finalCalibration, 'Final');
  if (definition.partialDisplayCalibration !== undefined) {
    validateCalibrationProfile(definition.partialDisplayCalibration, 'Partial');
  }
  if (definition.developmentProvisional !== undefined) {
    validateDevelopmentProvisionalProfile(definition.developmentProvisional);
  }
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function validateDevelopmentProvisionalProfile(profile: unknown): void {
  if (typeof profile !== 'object' || profile === null) {
    throw new TypeError('Development provisional profile must be an object');
  }
  requireExactKeys(
    profile,
    [
      'approvalClass',
      'productionApproved',
      'detectorVersion',
      'profileVersion',
      'provisionalScoreThreshold',
      'provisionalMarginThreshold',
      'minimumTextCharacters',
      'minimumWindowCharacters',
      'maximumInputCodePoints',
      'minimumSlidingWindowWords',
      'maximumSlidingWindowWords'
    ],
    'Development provisional profile'
  );
  const candidate = profile as Record<string, unknown>;
  if (candidate.approvalClass !== 'development-provisional') {
    throw new TypeError('Development provisional approval class is invalid');
  }
  if (candidate.productionApproved !== false) {
    throw new TypeError('Development provisional profiles are never production approved');
  }
  requireExactNonemptyString(candidate.detectorVersion, 'Provisional detector version');
  requireExactNonemptyString(candidate.profileVersion, 'Provisional profile version');
  requireThreshold(candidate.provisionalScoreThreshold, 'Provisional score threshold');
  requireThreshold(candidate.provisionalMarginThreshold, 'Provisional margin threshold');
  const minimumTextCharacters = requirePositiveInteger(
    candidate.minimumTextCharacters,
    'Provisional minimum text characters'
  );
  const minimumWindowCharacters = requirePositiveInteger(
    candidate.minimumWindowCharacters,
    'Provisional minimum window characters'
  );
  const maximumInputCodePoints = requirePositiveInteger(
    candidate.maximumInputCodePoints,
    'Provisional maximum input code points'
  );
  const minimumSlidingWindowWords = requirePositiveInteger(
    candidate.minimumSlidingWindowWords,
    'Provisional minimum sliding window words'
  );
  const maximumSlidingWindowWords = requirePositiveInteger(
    candidate.maximumSlidingWindowWords,
    'Provisional maximum sliding window words'
  );
  if (minimumWindowCharacters > minimumTextCharacters) {
    throw new RangeError('Provisional minimum window characters cannot exceed minimum text characters');
  }
  if (minimumTextCharacters > maximumInputCodePoints) {
    throw new RangeError('Provisional minimum text characters cannot exceed maximum input code points');
  }
  if (maximumInputCodePoints > 512) {
    throw new RangeError('Provisional maximum input code points cannot exceed 512');
  }
  if (minimumSlidingWindowWords > maximumSlidingWindowWords) {
    throw new RangeError(
      'Provisional minimum sliding window words cannot exceed maximum sliding window words'
    );
  }
  if (maximumSlidingWindowWords > maximumInputCodePoints) {
    throw new RangeError(
      'Provisional maximum sliding window words cannot exceed maximum input code points'
    );
  }
}

function provisionalProfilesMatch(
  left: DevelopmentProvisionalProfile,
  right: DevelopmentProvisionalProfile
): boolean {
  return (
    left.approvalClass === right.approvalClass &&
    left.productionApproved === right.productionApproved &&
    left.detectorVersion === right.detectorVersion &&
    left.profileVersion === right.profileVersion &&
    left.provisionalScoreThreshold === right.provisionalScoreThreshold &&
    left.provisionalMarginThreshold === right.provisionalMarginThreshold &&
    left.minimumTextCharacters === right.minimumTextCharacters &&
    left.minimumWindowCharacters === right.minimumWindowCharacters &&
    left.maximumInputCodePoints === right.maximumInputCodePoints &&
    left.minimumSlidingWindowWords === right.minimumSlidingWindowWords &&
    left.maximumSlidingWindowWords === right.maximumSlidingWindowWords
  );
}

function validateCalibrationProfile(
  profile: unknown,
  label: 'Final' | 'Partial'
): void {
  if (typeof profile !== 'object' || profile === null) {
    throw new TypeError(`${label} calibration must be an object`);
  }
  requireExactKeys(
    profile,
    ['detectorVersion', 'calibrationVersion', 'confidenceThreshold'],
    `${label} calibration`
  );
  const calibration = profile as Record<string, unknown>;
  requireExactNonemptyString(
    calibration.detectorVersion,
    `${label} detector version`
  );
  requireExactNonemptyString(
    calibration.calibrationVersion,
    `${label} calibration version`
  );
  requireThreshold(
    calibration.confidenceThreshold,
    `${label} confidence threshold`
  );
}

export function createLanguageRegistry<TCode extends string>(
  definitions: readonly LanguageDefinition<TCode>[]
): LanguageRegistry<TCode> {
  if (!Array.isArray(definitions)) {
    throw new TypeError('Language definitions must be an array');
  }
  for (const definition of definitions) validateDefinition(definition);

  const provisionalProfiles = definitions.map(
    (definition) => definition.developmentProvisional
  );
  const firstProvisionalProfile = provisionalProfiles.find(
    (profile): profile is DevelopmentProvisionalProfile => profile !== undefined
  );
  if (
    firstProvisionalProfile !== undefined &&
    provisionalProfiles.some(
      (profile) =>
        profile === undefined ||
        !provisionalProfilesMatch(firstProvisionalProfile, profile)
    )
  ) {
    throw new Error('Development provisional profiles must be symmetric');
  }

  const frozenDefinitions: readonly LanguageDefinition<TCode>[] = Object.freeze(
    definitions.map((definition) => freezeDefinition<TCode>(definition))
  );
  const byCode = new Map<string, LanguageDefinition<TCode>>();

  for (const definition of frozenDefinitions) {
    if (byCode.has(definition.code)) {
      throw new Error(`Duplicate language registry code: ${definition.code}`);
    }

    byCode.set(definition.code, definition);
  }

  return Object.freeze({
    get: (code: string): LanguageDefinition<TCode> | undefined =>
      byCode.get(code),
    list: (): readonly LanguageDefinition<TCode>[] => frozenDefinitions
  });
}

export function lookupLanguage<TCode extends string>(
  registry: LanguageRegistry<TCode>,
  code: string
): LanguageDefinition<TCode> | undefined {
  return registry.get(code);
}

export function listLanguages<TCode extends string>(
  registry: LanguageRegistry<TCode>
): readonly LanguageDefinition<TCode>[] {
  return registry.list();
}

export const CONTROLLED_FIXTURE_DETECTOR_VERSION =
  'controlled-fixture-detector-1';
export const CONTROLLED_FIXTURE_CALIBRATION_VERSION =
  'controlled-fixture-calibration-1';
export const DEVELOPMENT_PROVISIONAL_DETECTOR_VERSION = 'eld-small-2.1.0';
export const DEVELOPMENT_PROVISIONAL_PROFILE_VERSION = 'eld-small-dev-5';
export const DEVELOPMENT_PROVISIONAL_MINIMUM_SUBSTANTIVE_CHARACTERS = 12;

export function countSubstantiveCharacters(text: string): number {
  return Array.from(text.matchAll(/[\p{L}\p{N}]/gu)).length;
}

const developmentProvisional = {
  approvalClass: 'development-provisional',
  productionApproved: false,
  detectorVersion: DEVELOPMENT_PROVISIONAL_DETECTOR_VERSION,
  profileVersion: DEVELOPMENT_PROVISIONAL_PROFILE_VERSION,
  provisionalScoreThreshold: 0.65,
  provisionalMarginThreshold: 0.08,
  minimumTextCharacters: DEVELOPMENT_PROVISIONAL_MINIMUM_SUBSTANTIVE_CHARACTERS,
  minimumWindowCharacters: 1,
  maximumInputCodePoints: 512,
  minimumSlidingWindowWords: 1,
  maximumSlidingWindowWords: 8
} as const satisfies DevelopmentProvisionalProfile;

const initialDefinitions = [
  {
    code: 'es',
    displayName: 'Spanish',
    transcriptionHint: 'es',
    finalCalibration: {
      detectorVersion: CONTROLLED_FIXTURE_DETECTOR_VERSION,
      calibrationVersion: CONTROLLED_FIXTURE_CALIBRATION_VERSION,
      confidenceThreshold: 0.8
    },
    mixedPolicy: 'reject',
    fixtureSuiteIds: ['language-foundation-es'],
    developmentProvisional
  },
  {
    code: 'tr',
    displayName: 'Turkish',
    transcriptionHint: 'tr',
    finalCalibration: {
      detectorVersion: CONTROLLED_FIXTURE_DETECTOR_VERSION,
      calibrationVersion: CONTROLLED_FIXTURE_CALIBRATION_VERSION,
      confidenceThreshold: 0.8
    },
    mixedPolicy: 'reject',
    fixtureSuiteIds: ['language-foundation-tr'],
    developmentProvisional
  }
] as const satisfies readonly LanguageDefinition<TargetLanguage>[];

export const LANGUAGE_REGISTRY_VERSION = '2.3.0';

export const languageRegistry = createLanguageRegistry(initialDefinitions);

export const LANGUAGE_REGISTRY = languageRegistry.list();

export function getLanguageDefinition(
  code: string
): LanguageDefinition<TargetLanguage> | undefined {
  return lookupLanguage(languageRegistry, code);
}

export function listLanguageDefinitions(): readonly LanguageDefinition<TargetLanguage>[] {
  return listLanguages(languageRegistry);
}

export function isTargetLanguage(code: string): code is TargetLanguage {
  return getLanguageDefinition(code) !== undefined;
}
