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
    fixtureSuiteIds
  });
}

export function createLanguageRegistry<TCode extends string>(
  definitions: readonly LanguageDefinition<TCode>[]
): LanguageRegistry<TCode> {
  const frozenDefinitions = Object.freeze(definitions.map(freezeDefinition));
  const byCode = new Map<string, LanguageDefinition<TCode>>();

  for (const definition of frozenDefinitions) {
    if (byCode.has(definition.code)) {
      throw new Error(`Duplicate language registry code: ${definition.code}`);
    }

    if (
      !Number.isFinite(definition.confidenceThreshold) ||
      definition.confidenceThreshold < 0 ||
      definition.confidenceThreshold > 1
    ) {
      throw new RangeError(
        `Language confidence threshold must be between 0 and 1: ${definition.code}`
      );
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

const initialDefinitions = [
  {
    code: 'es',
    displayName: 'Spanish',
    transcriptionHint: 'es',
    confidenceThreshold: 0.8,
    mixedPolicy: 'reject',
    fixtureSuiteIds: ['language-foundation-es']
  },
  {
    code: 'tr',
    displayName: 'Turkish',
    transcriptionHint: 'tr',
    confidenceThreshold: 0.8,
    mixedPolicy: 'reject',
    fixtureSuiteIds: ['language-foundation-tr']
  }
] as const satisfies readonly LanguageDefinition<TargetLanguage>[];

export const LANGUAGE_REGISTRY_VERSION = '1.0.0';

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
