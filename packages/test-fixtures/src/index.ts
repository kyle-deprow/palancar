import {
  listLanguageDefinitions,
  type GateDecision,
  type LanguageEvidence,
  type TargetLanguage
} from '@palancar/language-registry';

export type LanguageEvidenceFixtureKind =
  | 'selected-target-final'
  | 'selected-target-provisional'
  | 'selected-target-low-confidence'
  | 'english'
  | 'mixed'
  | 'unsupported'
  | 'missing-evidence'
  | 'supported-unselected';

export interface LanguageEvidenceFixture {
  readonly id: string;
  readonly description: string;
  readonly kind: LanguageEvidenceFixtureKind;
  readonly selectedLanguage: TargetLanguage;
  readonly isFinal: boolean;
  readonly evidence: LanguageEvidence;
  readonly expectedDecision: GateDecision;
  readonly expectedGenerationAllowed: boolean;
}

interface TargetTextEvidence {
  readonly final: string;
  readonly provisional: string;
  readonly lowConfidence: string;
}

interface FixtureInput {
  readonly id: string;
  readonly description: string;
  readonly kind: LanguageEvidenceFixtureKind;
  readonly selectedLanguage: TargetLanguage;
  readonly isFinal: boolean;
  readonly detectedLanguage?: string;
  readonly confidence?: number;
  readonly text: string;
  readonly expectedDecision: GateDecision;
  readonly expectedGenerationAllowed: boolean;
}

const TARGET_TEXT_EVIDENCE: Readonly<Record<TargetLanguage, TargetTextEvidence>> =
  Object.freeze({
    es: Object.freeze({
      final: '¿Dónde está la estación?',
      provisional: '¿Dónde está...',
      lowConfidence: 'Texto breve en español'
    }),
    tr: Object.freeze({
      final: 'İstasyon nerede?',
      provisional: 'İstasyon ner...',
      lowConfidence: 'Kısa Türkçe metin'
    })
  });

function createFixture(input: FixtureInput): LanguageEvidenceFixture {
  const evidence: LanguageEvidence = Object.freeze({
    ...(input.detectedLanguage === undefined
      ? {}
      : { detectedLanguage: input.detectedLanguage }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    text: input.text,
    detectorVersion: 'controlled-fixture-1',
    source: 'controlled-fixture'
  });

  return Object.freeze({
    id: input.id,
    description: input.description,
    kind: input.kind,
    selectedLanguage: input.selectedLanguage,
    isFinal: input.isFinal,
    evidence,
    expectedDecision: input.expectedDecision,
    expectedGenerationAllowed: input.expectedGenerationAllowed
  });
}

const definitions = listLanguageDefinitions();

const fixtures = definitions.flatMap((definition) => {
  const selectedLanguage = definition.code;
  const targetText = TARGET_TEXT_EVIDENCE[selectedLanguage];
  const selectedFixtures: LanguageEvidenceFixture[] = [
    createFixture({
      id: `${selectedLanguage}-final-target`,
      description: `Final controlled evidence for selected target ${selectedLanguage}.`,
      kind: 'selected-target-final',
      selectedLanguage,
      isFinal: true,
      detectedLanguage: selectedLanguage,
      confidence: definition.confidenceThreshold,
      text: targetText.final,
      expectedDecision: 'target',
      expectedGenerationAllowed: true
    }),
    createFixture({
      id: `${selectedLanguage}-provisional-target`,
      description: `Provisional controlled evidence for selected target ${selectedLanguage}.`,
      kind: 'selected-target-provisional',
      selectedLanguage,
      isFinal: false,
      detectedLanguage: selectedLanguage,
      confidence: 1,
      text: targetText.provisional,
      expectedDecision: 'provisional',
      expectedGenerationAllowed: false
    }),
    createFixture({
      id: `${selectedLanguage}-low-confidence-target`,
      description: `Final selected-target evidence below the ${selectedLanguage} threshold.`,
      kind: 'selected-target-low-confidence',
      selectedLanguage,
      isFinal: true,
      detectedLanguage: selectedLanguage,
      confidence: definition.confidenceThreshold - 0.01,
      text: targetText.lowConfidence,
      expectedDecision: 'uncertain',
      expectedGenerationAllowed: false
    }),
    createFixture({
      id: `${selectedLanguage}-english`,
      description: `Final English evidence while ${selectedLanguage} is selected.`,
      kind: 'english',
      selectedLanguage,
      isFinal: true,
      detectedLanguage: 'en',
      confidence: 1,
      text: 'Where is the station?',
      expectedDecision: 'english',
      expectedGenerationAllowed: false
    }),
    createFixture({
      id: `${selectedLanguage}-mixed`,
      description: `Final mixed-language evidence while ${selectedLanguage} is selected.`,
      kind: 'mixed',
      selectedLanguage,
      isFinal: true,
      detectedLanguage: 'mixed',
      confidence: 1,
      text: 'Can you help me, por favor?',
      expectedDecision: 'mixed',
      expectedGenerationAllowed: false
    }),
    createFixture({
      id: `${selectedLanguage}-unsupported`,
      description: `Final unsupported-language evidence while ${selectedLanguage} is selected.`,
      kind: 'unsupported',
      selectedLanguage,
      isFinal: true,
      detectedLanguage: 'fr',
      confidence: 1,
      text: 'Où est la station?',
      expectedDecision: 'unsupported',
      expectedGenerationAllowed: false
    }),
    createFixture({
      id: `${selectedLanguage}-missing-evidence`,
      description: `Final evidence without language or confidence while ${selectedLanguage} is selected.`,
      kind: 'missing-evidence',
      selectedLanguage,
      isFinal: true,
      text: 'Evidence without a language label',
      expectedDecision: 'uncertain',
      expectedGenerationAllowed: false
    })
  ];

  const unselectedFixtures = definitions
    .filter((candidate) => candidate.code !== selectedLanguage)
    .map((candidate) =>
      createFixture({
        id: `${selectedLanguage}-supported-unselected-${candidate.code}`,
        description: `Final ${candidate.code} evidence while ${selectedLanguage} is selected.`,
        kind: 'supported-unselected',
        selectedLanguage,
        isFinal: true,
        detectedLanguage: candidate.code,
        confidence: 1,
        text: TARGET_TEXT_EVIDENCE[candidate.code].final,
        expectedDecision: 'supported_unselected',
        expectedGenerationAllowed: false
      })
    );

  return [...selectedFixtures, ...unselectedFixtures];
});

export const LANGUAGE_EVIDENCE_FIXTURES: readonly LanguageEvidenceFixture[] =
  Object.freeze(fixtures);

const EMPTY_FIXTURES: readonly LanguageEvidenceFixture[] = Object.freeze([]);

const fixturesBySelectedLanguage = new Map<
  TargetLanguage,
  readonly LanguageEvidenceFixture[]
>(
  definitions.map((definition) => [
    definition.code,
    Object.freeze(
      LANGUAGE_EVIDENCE_FIXTURES.filter(
        (fixture) => fixture.selectedLanguage === definition.code
      )
    )
  ])
);

export function listLanguageEvidenceFixtures(
  selectedLanguage: TargetLanguage
): readonly LanguageEvidenceFixture[] {
  return fixturesBySelectedLanguage.get(selectedLanguage) ?? EMPTY_FIXTURES;
}

export function getLanguageEvidenceFixture(
  id: string
): LanguageEvidenceFixture | undefined {
  return LANGUAGE_EVIDENCE_FIXTURES.find((fixture) => fixture.id === id);
}
