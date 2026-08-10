import { describe, expect, it } from 'vitest';
import {
  evaluateLanguageGate,
  listLanguageDefinitions,
  type LanguageEvidence
} from '@palancar/language-registry';
import {
  getLanguageEvidenceFixture,
  LANGUAGE_EVIDENCE_FIXTURES,
  listLanguageEvidenceFixtures,
  type LanguageEvidenceFixture,
  type LanguageEvidenceFixtureKind
} from '../src/index.js';

const singleFixture = (
  fixtures: readonly LanguageEvidenceFixture[],
  kind: LanguageEvidenceFixtureKind
): LanguageEvidenceFixture => {
  const matches = fixtures.filter((fixture) => fixture.kind === kind);
  expect(matches).toHaveLength(1);

  const fixture = matches[0];
  if (fixture === undefined) {
    throw new Error(`Missing controlled fixture kind: ${kind}`);
  }

  return fixture;
};

describe('controlled language evidence matrix', () => {
  it('provides the complete aligned policy matrix for every selected target', () => {
    const definitions = listLanguageDefinitions();
    const singletonKinds: readonly LanguageEvidenceFixtureKind[] = [
      'selected-target-final',
      'selected-target-provisional',
      'selected-target-low-confidence',
      'english',
      'mixed',
      'unsupported',
      'missing-evidence'
    ];

    for (const definition of definitions) {
      const fixtures = listLanguageEvidenceFixtures(definition.code);

      expect(fixtures).toHaveLength(singletonKinds.length + definitions.length - 1);
      expect(Object.isFrozen(fixtures)).toBe(true);

      for (const kind of singletonKinds) {
        singleFixture(fixtures, kind);
      }

      const unselectedFixtures = fixtures.filter(
        (fixture) => fixture.kind === 'supported-unselected'
      );
      expect(unselectedFixtures).toHaveLength(definitions.length - 1);
      expect(
        unselectedFixtures.map((fixture) => fixture.evidence.detectedLanguage)
      ).toEqual(
        definitions
          .filter((candidate) => candidate.code !== definition.code)
          .map((candidate) => candidate.code)
      );

      for (const fixture of fixtures) {
        expect(fixture.selectedLanguage).toBe(definition.code);
      }
    }
  });

  it('evaluates each fixture using its stored selection metadata and exact outcome', () => {
    for (const fixture of LANGUAGE_EVIDENCE_FIXTURES) {
      const result = evaluateLanguageGate({
        selectedLanguage: fixture.selectedLanguage,
        evidence: fixture.evidence,
        isFinal: fixture.isFinal
      });

      expect(result.decision, fixture.id).toBe(fixture.expectedDecision);
      expect(result.generationAllowed, fixture.id).toBe(
        fixture.expectedGenerationAllowed
      );
      expect(result.selectedLanguage, fixture.id).toBe(fixture.selectedLanguage);
    }
  });

  it('aligns target, provisional, and low-confidence text evidence per target', () => {
    for (const definition of listLanguageDefinitions()) {
      const fixtures = listLanguageEvidenceFixtures(definition.code);
      const targetFixture = singleFixture(fixtures, 'selected-target-final');
      const provisionalFixture = singleFixture(
        fixtures,
        'selected-target-provisional'
      );
      const lowConfidenceFixture = singleFixture(
        fixtures,
        'selected-target-low-confidence'
      );

      for (const fixture of [
        targetFixture,
        provisionalFixture,
        lowConfidenceFixture
      ]) {
        expect(fixture.selectedLanguage).toBe(definition.code);
        expect(fixture.evidence.detectedLanguage).toBe(definition.code);
        expect(fixture.evidence.text.trim().length).toBeGreaterThan(0);
      }

      expect(targetFixture.evidence.confidence).toBeGreaterThanOrEqual(
        definition.confidenceThreshold
      );
      expect(lowConfidenceFixture.evidence.confidence).toBeLessThan(
        definition.confidenceThreshold
      );
    }
  });

  it('rejects unsupported target selection before evaluating evidence', () => {
    const failOnEvidenceAccess = (): never => {
      throw new Error('Evidence was inspected before target selection was rejected');
    };
    const unreadableEvidence: LanguageEvidence = {
      get detectedLanguage(): string {
        return failOnEvidenceAccess();
      },
      get confidence(): number {
        return failOnEvidenceAccess();
      },
      get text(): string {
        return failOnEvidenceAccess();
      },
      get detectorVersion(): string {
        return failOnEvidenceAccess();
      },
      get source(): LanguageEvidence['source'] {
        return failOnEvidenceAccess();
      }
    };
    const evaluateUnsupportedTarget = () =>
      evaluateLanguageGate({
        selectedLanguage: 'ja',
        evidence: unreadableEvidence,
        isFinal: true
      });

    expect(evaluateUnsupportedTarget).toThrowError(RangeError);
    expect(evaluateUnsupportedTarget).toThrowError(
      'Unsupported selected target language: ja'
    );
  });

  it('does not expose mutable fixture or registry state through public APIs', () => {
    const definitions = listLanguageDefinitions();
    const firstDefinition = definitions[0];
    const firstFixture = LANGUAGE_EVIDENCE_FIXTURES[0];

    if (firstDefinition === undefined || firstFixture === undefined) {
      throw new Error('Expected registry definitions and controlled fixtures');
    }

    expect(Object.isFrozen(definitions)).toBe(true);
    expect(Object.isFrozen(firstDefinition)).toBe(true);
    expect(Object.isFrozen(firstDefinition.fixtureSuiteIds)).toBe(true);
    expect(Object.isFrozen(LANGUAGE_EVIDENCE_FIXTURES)).toBe(true);
    expect(Object.isFrozen(firstFixture)).toBe(true);
    expect(Object.isFrozen(firstFixture.evidence)).toBe(true);

    expect(() => Object.assign(definitions, { length: 0 })).toThrow();
    expect(() => Object.assign(firstDefinition, { displayName: 'Changed' })).toThrow();
    expect(() => Object.assign(firstFixture, { selectedLanguage: 'tr' })).toThrow();

    expect(listLanguageDefinitions()[0]?.displayName).toBe('Spanish');
  });

  it('looks up fixtures by stable public id', () => {
    const fixture = LANGUAGE_EVIDENCE_FIXTURES[0];
    if (fixture === undefined) {
      throw new Error('Expected at least one controlled fixture');
    }

    expect(getLanguageEvidenceFixture(fixture.id)).toBe(fixture);
    expect(getLanguageEvidenceFixture('missing-fixture')).toBeUndefined();
  });
});
