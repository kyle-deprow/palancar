import { describe, expect, it } from 'vitest';
import {
  evaluateLanguageGate,
  getLanguageDefinition,
  listLanguageDefinitions,
  type LanguageEvidence,
  type TargetLanguage
} from '../src/index.js';

const evidence = (
  detectedLanguage: string | undefined,
  confidence: number | undefined
): LanguageEvidence => ({
  ...(detectedLanguage === undefined ? {} : { detectedLanguage }),
  ...(confidence === undefined ? {} : { confidence }),
  text: 'controlled fixture text',
  detectorVersion: 'fixture-detector-1',
  source: 'controlled-fixture'
});

describe('language registry', () => {
  it('contains equal Spanish and Turkish target definitions', () => {
    expect(listLanguageDefinitions()).toEqual([
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
    ]);
  });

  it('looks up entries generically by registry code', () => {
    const selectedCodes: TargetLanguage[] = ['es', 'tr'];

    for (const code of selectedCodes) {
      expect(getLanguageDefinition(code)?.code).toBe(code);
    }

    expect(getLanguageDefinition('fr')).toBeUndefined();
  });
});

describe('language gate', () => {
  it('accepts a final selected target at its threshold', () => {
    for (const selectedLanguage of ['es', 'tr'] as const) {
      const result = evaluateLanguageGate({
        selectedLanguage,
        evidence: evidence(selectedLanguage, 0.8),
        isFinal: true
      });

      expect(result).toMatchObject({
        decision: 'target',
        generationAllowed: true
      });
    }
  });

  it('never allows a provisional revision to generate', () => {
    for (const selectedLanguage of ['es', 'tr'] as const) {
      const result = evaluateLanguageGate({
        selectedLanguage,
        evidence: evidence(selectedLanguage, 0.99),
        isFinal: false
      });

      expect(result).toMatchObject({
        decision: 'provisional',
        generationAllowed: false
      });
    }
  });

  it('returns uncertain for missing or insufficient evidence', () => {
    for (const selectedLanguage of ['es', 'tr'] as const) {
      expect(
        evaluateLanguageGate({
          selectedLanguage,
          evidence: evidence(selectedLanguage, 0.79),
          isFinal: true
        })
      ).toMatchObject({ decision: 'uncertain', generationAllowed: false });

      expect(
        evaluateLanguageGate({
          selectedLanguage,
          evidence: evidence(undefined, undefined),
          isFinal: true
        })
      ).toMatchObject({ decision: 'uncertain', generationAllowed: false });
    }
  });

  it.each([
    ['above one', 1.01],
    ['below zero', -0.01],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY]
  ])('returns uncertain for %s confidence', (_label, confidence) => {
    for (const { code: selectedLanguage } of listLanguageDefinitions()) {
      expect(
        evaluateLanguageGate({
          selectedLanguage,
          evidence: evidence(selectedLanguage, confidence),
          isFinal: true
        })
      ).toMatchObject({
        decision: 'uncertain',
        generationAllowed: false
      });
    }
  });

  it('rejects unsupported target selection', () => {
    expect(() =>
      evaluateLanguageGate({
        selectedLanguage: 'fr',
        evidence: evidence('fr', 0.99),
        isFinal: true
      })
    ).toThrowError(/Unsupported selected target language/);
  });

  it('does not inspect or mutate evidence text', () => {
    const original = 'text that must remain untouched';
    const inputEvidence: LanguageEvidence = {
      detectedLanguage: 'es',
      confidence: 0.9,
      text: original,
      detectorVersion: 'fixture-detector-1',
      source: 'controlled-fixture'
    };

    evaluateLanguageGate({
      selectedLanguage: 'es',
      evidence: inputEvidence,
      isFinal: true
    });

    expect(inputEvidence.text).toBe(original);
  });
});
