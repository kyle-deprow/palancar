import type { LanguageDefinition, TargetLanguage } from './types.js';

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
      'partialDisplayCalibration'
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
    fixtureSuiteIds: ['language-foundation-es']
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
    fixtureSuiteIds: ['language-foundation-tr']
  }
] as const satisfies readonly LanguageDefinition<TargetLanguage>[];

export const LANGUAGE_REGISTRY_VERSION = '2.0.0';

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
