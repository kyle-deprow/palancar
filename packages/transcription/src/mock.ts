import type { TargetLanguage } from '@palancar/language-registry';

import type {
  MockLanguageEvidenceCategory,
  NormalizedLanguageEvidence,
  TranscriptionCapabilities,
  TranscriptionLanguageMode
} from './types.js';

export interface DeterministicMockTranscriptionAdapterConfiguration {
  readonly evidenceCategory: MockLanguageEvidenceCategory;
}

export interface DeterministicMockScriptConfiguration {
  readonly languageMode: TranscriptionLanguageMode;
  readonly manualCommitCadenceMs: number;
  readonly maxUtteranceSamples: number;
}

export interface MockScriptEntry {
  readonly atAcceptedSamples: number;
  readonly text: string;
}

export interface DeterministicMockScript {
  readonly selectedTargetLanguage: TargetLanguage;
  readonly evidenceCategory: MockLanguageEvidenceCategory;
  readonly languageEvidence: Readonly<NormalizedLanguageEvidence>;
  readonly partials: readonly Readonly<MockScriptEntry>[];
  readonly final: Readonly<MockScriptEntry>;
}

export const DETERMINISTIC_MOCK_CAPABILITIES: Readonly<TranscriptionCapabilities> =
  Object.freeze({
    identity: Object.freeze({
      provider: 'deterministic-mock',
      model: 'symmetric-language-script',
      version: '1.0.0'
    }),
    acceptedInput: Object.freeze({
      sampleRateHz: 16_000,
      sampleFormat: 's16le',
      channels: 1
    }),
    providerInput: Object.freeze({
      sampleRateHz: 16_000,
      sampleFormat: 's16le',
      channels: 1
    }),
    resampling: Object.freeze({ mode: 'native', stateful: false }),
    serverVad: Object.freeze({
      supported: true,
      modes: Object.freeze(['enabled', 'disabled'] as const)
    }),
    manualCommit: Object.freeze({
      supported: true,
      cadencesMs: Object.freeze([600, 800, 1_000, 3_000])
    }),
    languageModes: Object.freeze([
      'automatic',
      'selected-target-hint'
    ] as const),
    partialResults: Object.freeze({ supported: true }),
    providerRetention: Object.freeze({
      status: 'not-applicable-synthetic',
      evidenceVersion: '1.0.0'
    })
  });

export const MOCK_LANGUAGE_EVIDENCE_CATEGORIES = Object.freeze([
  'selected-target',
  'english',
  'supported-unselected',
  'mixed',
  'unsupported',
  'uncertain'
] as const);

const EVIDENCE_CATEGORY_SET = new Set<string>(MOCK_LANGUAGE_EVIDENCE_CATEGORIES);

export function validateDeterministicMockAdapterConfiguration(
  input: DeterministicMockTranscriptionAdapterConfiguration
): Readonly<DeterministicMockTranscriptionAdapterConfiguration> {
  if (
    typeof input !== 'object' ||
    input === null ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, 'evidenceCategory') ||
    !EVIDENCE_CATEGORY_SET.has(input.evidenceCategory)
  ) {
    throw new TypeError('Invalid deterministic mock evidence category');
  }
  return Object.freeze({ evidenceCategory: input.evidenceCategory });
}

function oppositeTarget(selectedTargetLanguage: TargetLanguage): TargetLanguage {
  return selectedTargetLanguage === 'es' ? 'tr' : 'es';
}

function languageEvidence(
  selectedTargetLanguage: TargetLanguage,
  category: MockLanguageEvidenceCategory,
  languageMode: TranscriptionLanguageMode
): Readonly<NormalizedLanguageEvidence> {
  const base = {
    detectorVersion: languageMode === 'automatic'
      ? 'deterministic-mock-automatic-1.0.0'
      : `deterministic-mock-selected-target-hint-${selectedTargetLanguage}-1.0.0`,
    source: languageMode === 'automatic'
      ? 'transcription-metadata' as const
      : 'controlled-fixture' as const
  };

  switch (category) {
    case 'selected-target':
      return Object.freeze({
        ...base,
        detectedLanguage: selectedTargetLanguage,
        confidence: 0.95
      });
    case 'english':
      return Object.freeze({ ...base, detectedLanguage: 'en', confidence: 0.95 });
    case 'supported-unselected':
      return Object.freeze({
        ...base,
        detectedLanguage: oppositeTarget(selectedTargetLanguage),
        confidence: 0.95
      });
    case 'mixed':
      return Object.freeze({ ...base, detectedLanguage: 'mixed', confidence: 0.9 });
    case 'unsupported':
      return Object.freeze({ ...base, detectedLanguage: 'fr', confidence: 0.95 });
    case 'uncertain':
      return Object.freeze(base);
  }
}

export function createDeterministicMockScript(
  selectedTargetLanguage: TargetLanguage,
  evidenceCategory: MockLanguageEvidenceCategory,
  configuration: DeterministicMockScriptConfiguration
): Readonly<DeterministicMockScript> {
  if (!EVIDENCE_CATEGORY_SET.has(evidenceCategory)) {
    throw new TypeError('Invalid deterministic mock evidence category');
  }
  if (!DETERMINISTIC_MOCK_CAPABILITIES.languageModes.includes(configuration.languageMode)) {
    throw new RangeError('Unsupported deterministic mock language mode');
  }
  if (
    !Number.isInteger(configuration.manualCommitCadenceMs) ||
    !DETERMINISTIC_MOCK_CAPABILITIES.manualCommit.cadencesMs.includes(
      configuration.manualCommitCadenceMs
    )
  ) {
    throw new RangeError('Unsupported deterministic mock commit cadence');
  }
  if (!Number.isInteger(configuration.maxUtteranceSamples) || configuration.maxUtteranceSamples < 1) {
    throw new RangeError('Invalid deterministic mock utterance sample cap');
  }

  const cadenceSamples = configuration.manualCommitCadenceMs * 16;
  const finalThreshold = Math.min(cadenceSamples * 3, configuration.maxUtteranceSamples);
  const partials: Readonly<MockScriptEntry>[] = [];
  for (
    let threshold = cadenceSamples, revision = 1;
    threshold < finalThreshold;
    threshold += cadenceSamples, revision += 1
  ) {
    partials.push(Object.freeze({
      atAcceptedSamples: threshold,
      text: `${selectedTargetLanguage}-${evidenceCategory}-partial-${revision}`
    }));
  }
  const prefix = `${selectedTargetLanguage}-${evidenceCategory}`;
  return Object.freeze({
    selectedTargetLanguage,
    evidenceCategory,
    languageEvidence: languageEvidence(
      selectedTargetLanguage,
      evidenceCategory,
      configuration.languageMode
    ),
    partials: Object.freeze(partials),
    final: Object.freeze({ atAcceptedSamples: finalThreshold, text: `${prefix}-final` })
  });
}
