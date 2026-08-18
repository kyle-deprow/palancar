import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_FIXTURE_CALIBRATION_VERSION,
  CONTROLLED_FIXTURE_DETECTOR_VERSION,
  createLanguageRegistry,
  evaluateLanguageGate,
  getLanguageDefinition,
  listLanguageDefinitions,
  validateClassifiedLanguageEvidence,
  validateRawLanguageDetectorOutput,
  type ClassifiedLanguageEvidence,
  type LanguageClassificationStatus,
  type LanguageDefinition,
  type RawLanguageDetectorOutput,
  type TargetLanguage,
  type TextLanguageClassifier
} from '../src/index.js';

const DETECTOR_VERSION = CONTROLLED_FIXTURE_DETECTOR_VERSION;
const CALIBRATION_VERSION = CONTROLLED_FIXTURE_CALIBRATION_VERSION;

function calibrated(
  detectedLanguage: string,
  confidence: number,
  overrides: Readonly<{
    detectorVersion?: string;
    calibrationVersion?: string;
  }> = {}
): ClassifiedLanguageEvidence {
  return {
    status: 'calibrated',
    detectorVersion: overrides.detectorVersion ?? DETECTOR_VERSION,
    calibrationVersion:
      overrides.calibrationVersion ?? CALIBRATION_VERSION,
    detectedLanguage,
    confidence
  };
}

function unavailable(
  status: Exclude<LanguageClassificationStatus, 'calibrated'>,
  detectedLanguage?: string
): ClassifiedLanguageEvidence {
  return {
    status,
    detectorVersion: DETECTOR_VERSION,
    ...(detectedLanguage === undefined ? {} : { detectedLanguage })
  };
}

function oppositeTarget(selectedLanguage: TargetLanguage): TargetLanguage {
  return selectedLanguage === 'es' ? 'tr' : 'es';
}

const TARGETS = ['es', 'tr'] as const;

describe('language registry', () => {
  it('contains equal Spanish and Turkish target definitions without partial profiles', () => {
    expect(listLanguageDefinitions()).toEqual([
      {
        code: 'es',
        displayName: 'Spanish',
        transcriptionHint: 'es',
        finalCalibration: {
          detectorVersion: DETECTOR_VERSION,
          calibrationVersion: CALIBRATION_VERSION,
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
          detectorVersion: DETECTOR_VERSION,
          calibrationVersion: CALIBRATION_VERSION,
          confidenceThreshold: 0.8
        },
        mixedPolicy: 'reject',
        fixtureSuiteIds: ['language-foundation-tr']
      }
    ]);
  });

  it('looks up entries generically by registry code', () => {
    for (const code of TARGETS) expect(getLanguageDefinition(code)?.code).toBe(code);
    expect(getLanguageDefinition('fr')).toBeUndefined();
  });

  it('validates exact registry and partial-profile data', () => {
    const valid: LanguageDefinition<'xy'> = {
      code: 'xy',
      displayName: 'Fixture',
      finalCalibration: {
        detectorVersion: DETECTOR_VERSION,
        calibrationVersion: CALIBRATION_VERSION,
        confidenceThreshold: 0.75
      },
      mixedPolicy: 'reject',
      fixtureSuiteIds: ['fixture-xy'],
      partialDisplayCalibration: {
        detectorVersion: DETECTOR_VERSION,
        calibrationVersion: CALIBRATION_VERSION,
        confidenceThreshold: 0.9
      }
    };
    const registry = createLanguageRegistry([valid]);
    expect(registry.get('xy')).toEqual(valid);
    expect(Object.isFrozen(registry.get('xy')?.partialDisplayCalibration)).toBe(true);

    expect(() =>
      createLanguageRegistry([
        { ...valid, code: ' XY' } as unknown as LanguageDefinition<'xy'>
      ])
    ).toThrow(/Language code/);
    expect(() =>
      createLanguageRegistry([
        {
          ...valid,
          finalCalibration: {
            ...valid.finalCalibration,
            confidenceThreshold: 1.01
          }
        }
      ])
    ).toThrow(/between 0 and 1/);
    expect(() =>
      createLanguageRegistry([
        {
          ...valid,
          unexpected: true
        } as LanguageDefinition<'xy'>
      ])
    ).toThrow(/unsupported field/);
  });
});

describe('classifier contracts', () => {
  it('exposes a ready/classify pure classifier contract', async () => {
    const classifier: TextLanguageClassifier = {
      ready: Promise.resolve(),
      classify: async () => calibrated('es', 0.91)
    };

    await expect(classifier.ready).resolves.toBeUndefined();
    await expect(classifier.classify('hola')).resolves.toEqual(
      calibrated('es', 0.91)
    );
  });

  it('keeps detector-native scores structurally separate from confidence', () => {
    const raw: RawLanguageDetectorOutput = {
      detectorVersion: DETECTOR_VERSION,
      scores: [
        { language: 'es', score: 8.2 },
        { language: 'tr', score: -1.4 }
      ]
    };

    expect(() => validateRawLanguageDetectorOutput(raw)).not.toThrow();
    expect(raw.scores.every((score) => !('confidence' in score))).toBe(true);
    expect(() =>
      evaluateLanguageGate({
        selectedLanguage: 'es',
        evidence: raw as unknown as ClassifiedLanguageEvidence,
        isFinal: true
      })
    ).toThrow(/invalid status/);

    expect(() =>
      validateClassifiedLanguageEvidence({
        status: 'calibrated',
        detectorVersion: DETECTOR_VERSION,
        calibrationVersion: CALIBRATION_VERSION,
        detectedLanguage: 'es',
        confidence: raw.scores[0]?.score
      })
    ).toThrow(/between 0 and 1/);

    expect(
      evaluateLanguageGate({
        selectedLanguage: 'es',
        evidence: calibrated('es', 0.9, {
          detectorVersion: 'raw-detector-with-relabeled-score'
        }),
        isFinal: true
      })
    ).toMatchObject({
      decision: 'uncertain',
      displayAllowed: false,
      generationAllowed: false
    });
  });

  it('forbids confidence on every non-calibrated status', () => {
    for (const status of [
      'insufficient-text',
      'uncalibrated',
      'conflicting',
      'unavailable'
    ] as const) {
      expect(() =>
        validateClassifiedLanguageEvidence({
          status,
          detectorVersion: DETECTOR_VERSION,
          detectedLanguage: 'es',
          confidence: 0.99
        })
      ).toThrow(/unsupported field: confidence/);
    }
  });

  it('rejects malformed calibrated data exactly', () => {
    for (const evidence of [
      {
        status: 'calibrated',
        calibrationVersion: CALIBRATION_VERSION,
        detectedLanguage: 'es',
        confidence: 0.9
      },
      {
        status: 'calibrated',
        detectorVersion: DETECTOR_VERSION,
        detectedLanguage: 'es',
        confidence: 0.9
      },
      {
        status: 'calibrated',
        detectorVersion: DETECTOR_VERSION,
        calibrationVersion: CALIBRATION_VERSION,
        confidence: 0.9
      },
      {
        status: 'calibrated',
        detectorVersion: DETECTOR_VERSION,
        calibrationVersion: CALIBRATION_VERSION,
        detectedLanguage: 'es'
      }
    ]) {
      expect(() => validateClassifiedLanguageEvidence(evidence)).toThrow();
    }
    expect(() =>
      validateClassifiedLanguageEvidence({
        status: 'calibrated',
        detectorVersion: DETECTOR_VERSION,
        calibrationVersion: CALIBRATION_VERSION,
        detectedLanguage: 'ES',
        confidence: 0.9
      })
    ).toThrow(/lowercase/);
    expect(() =>
      validateClassifiedLanguageEvidence({
        status: 'calibrated',
        detectorVersion: DETECTOR_VERSION,
        calibrationVersion: CALIBRATION_VERSION,
        detectedLanguage: 'es',
        confidence: Number.NaN
      })
    ).toThrow(/finite number/);
  });

  it('rejects provider advisory metadata and logprobs as classifier evidence', () => {
    expect(() =>
      evaluateLanguageGate({
        selectedLanguage: 'es',
        evidence: {
          ...calibrated('es', 0.99),
          source: 'transcription-metadata',
          logprobs: [{ token: 'hola', logprob: -0.1 }]
        } as unknown as ClassifiedLanguageEvidence,
        isFinal: true
      })
    ).toThrow(/unsupported field/);
  });

  it('keeps final authorization closed for wrong detector or calibration versions', () => {
    for (const evidence of [
      calibrated('es', 0.99, { detectorVersion: 'provider-detector' }),
      calibrated('es', 0.99, { calibrationVersion: 'provider-calibration' })
    ]) {
      expect(
        evaluateLanguageGate({
          selectedLanguage: 'es',
          evidence,
          isFinal: true
        })
      ).toMatchObject({
        decision: 'uncertain',
        displayAllowed: false,
        generationAllowed: false
      });
    }
  });
});

describe('final language gate', () => {
  it('allows transcript display and generation only for a calibrated selected target', () => {
    for (const selectedLanguage of TARGETS) {
      expect(
        evaluateLanguageGate({
          selectedLanguage,
          evidence: calibrated(selectedLanguage, 0.8),
          isFinal: true
        })
      ).toMatchObject({
        decision: 'target',
        displayAllowed: true,
        generationAllowed: true,
        selectedLanguage,
        detectedLanguage: selectedLanguage,
        confidence: 0.8
      });
    }
  });

  it('handles English, supported-unselected, mixed, and unsupported symmetrically', () => {
    for (const selectedLanguage of TARGETS) {
      const cases = [
        ['en', 'english'],
        [oppositeTarget(selectedLanguage), 'supported_unselected'],
        ['mixed', 'mixed'],
        ['zz', 'unsupported']
      ] as const;

      for (const [detectedLanguage, decision] of cases) {
        expect(
          evaluateLanguageGate({
            selectedLanguage,
            evidence: calibrated(detectedLanguage, 0.99),
            isFinal: true
          })
        ).toMatchObject({
          decision,
          displayAllowed: false,
          generationAllowed: false
        });
      }
    }
  });

  it('suppresses calibrated evidence below the approved final threshold', () => {
    for (const selectedLanguage of TARGETS) {
      expect(
        evaluateLanguageGate({
          selectedLanguage,
          evidence: calibrated(selectedLanguage, 0.79),
          isFinal: true
        })
      ).toMatchObject({
        decision: 'uncertain',
        displayAllowed: false,
        generationAllowed: false
      });
    }
  });

  it('suppresses every non-calibrated classifier status', () => {
    for (const selectedLanguage of TARGETS) {
      for (const status of [
        'insufficient-text',
        'uncalibrated',
        'conflicting',
        'unavailable'
      ] as const) {
        expect(
          evaluateLanguageGate({
            selectedLanguage,
            evidence: unavailable(status, status === 'conflicting' ? 'mixed' : selectedLanguage),
            isFinal: true
          })
        ).toMatchObject({
          decision: 'uncertain',
          displayAllowed: false,
          generationAllowed: false
        });
      }
    }
  });

});

describe('partial display policy', () => {
  it('suppresses partial display when the selected target has no profile', () => {
    for (const selectedLanguage of TARGETS) {
      expect(
        evaluateLanguageGate({
          selectedLanguage,
          evidence: calibrated(selectedLanguage, 1),
          isFinal: false
        })
      ).toMatchObject({
        decision: 'provisional',
        displayAllowed: false,
        generationAllowed: false
      });
    }
  });

  it('allows only explicitly version-matched calibrated selected-target partials', () => {
    const definitions = TARGETS.map((code): LanguageDefinition<TargetLanguage> => ({
      code,
      displayName: code,
      finalCalibration: {
        detectorVersion: DETECTOR_VERSION,
        calibrationVersion: CALIBRATION_VERSION,
        confidenceThreshold: 0.8
      },
      mixedPolicy: 'reject',
      fixtureSuiteIds: [`fixture-${code}`],
      partialDisplayCalibration: {
        detectorVersion: DETECTOR_VERSION,
        calibrationVersion: CALIBRATION_VERSION,
        confidenceThreshold: 0.9
      }
    }));
    const registry = createLanguageRegistry(definitions);

    for (const selectedLanguage of TARGETS) {
      expect(
        evaluateLanguageGate(
          {
            selectedLanguage,
            evidence: calibrated(selectedLanguage, 0.9),
            isFinal: false
          },
          registry
        )
      ).toMatchObject({
        decision: 'provisional',
        displayAllowed: true,
        generationAllowed: false
      });

      for (const rejectedEvidence of [
        calibrated(selectedLanguage, 0.89),
        calibrated(oppositeTarget(selectedLanguage), 0.99),
        calibrated(selectedLanguage, 0.99, { detectorVersion: 'other-detector' }),
        calibrated(selectedLanguage, 0.99, { calibrationVersion: 'other-calibration' }),
        unavailable('uncalibrated', selectedLanguage)
      ]) {
        expect(
          evaluateLanguageGate(
            {
              selectedLanguage,
              evidence: rejectedEvidence,
              isFinal: false
            },
            registry
          )
        ).toMatchObject({
          decision: 'provisional',
          displayAllowed: false,
          generationAllowed: false
        });
      }
    }
  });

  it('applies the same partial-profile contract to a future target', () => {
    const registry = createLanguageRegistry([
      {
        code: 'fr',
        displayName: 'French',
        finalCalibration: {
          detectorVersion: DETECTOR_VERSION,
          calibrationVersion: CALIBRATION_VERSION,
          confidenceThreshold: 0.8
        },
        mixedPolicy: 'reject',
        fixtureSuiteIds: ['fixture-fr'],
        partialDisplayCalibration: {
          detectorVersion: DETECTOR_VERSION,
          calibrationVersion: CALIBRATION_VERSION,
          confidenceThreshold: 0.9
        }
      }
    ] as const);

    expect(
      evaluateLanguageGate(
        {
          selectedLanguage: 'fr',
          evidence: calibrated('fr', 0.9),
          isFinal: false
        },
        registry
      )
    ).toMatchObject({
      decision: 'provisional',
      displayAllowed: true,
      generationAllowed: false
    });
  });
});

describe('future-language full matrix', () => {
  it('applies every final and partial branch to a future enabled target', () => {
    const enabledCodes = ['es', 'tr', 'fr'] as const;
    const registry = createLanguageRegistry(
      enabledCodes.map((code): LanguageDefinition<(typeof enabledCodes)[number]> => ({
        code,
        displayName: code,
        finalCalibration: {
          detectorVersion: DETECTOR_VERSION,
          calibrationVersion: CALIBRATION_VERSION,
          confidenceThreshold: 0.8
        },
        mixedPolicy: 'reject',
        fixtureSuiteIds: [`future-matrix-${code}`],
        ...(code !== 'fr'
          ? {}
          : {
              partialDisplayCalibration: {
                detectorVersion: DETECTOR_VERSION,
                calibrationVersion: CALIBRATION_VERSION,
                confidenceThreshold: 0.9
              }
            })
      }))
    );

    const finalCases = [
      ['fr', 'target', true, true],
      ['en', 'english', false, false],
      ['mixed', 'mixed', false, false],
      ['es', 'supported_unselected', false, false],
      ['tr', 'supported_unselected', false, false],
      ['zz', 'unsupported', false, false]
    ] as const;
    for (const [detectedLanguage, decision, displayAllowed, generationAllowed] of finalCases) {
      expect(
        evaluateLanguageGate(
          {
            selectedLanguage: 'fr',
            evidence: calibrated(detectedLanguage, 0.99),
            isFinal: true
          },
          registry
        )
      ).toMatchObject({ decision, displayAllowed, generationAllowed });
    }

    for (const status of [
      'insufficient-text',
      'uncalibrated',
      'conflicting',
      'unavailable'
    ] as const) {
      expect(
        evaluateLanguageGate(
          {
            selectedLanguage: 'fr',
            evidence: unavailable(status, status === 'conflicting' ? 'mixed' : 'fr'),
            isFinal: true
          },
          registry
        )
      ).toMatchObject({
        decision: 'uncertain',
        displayAllowed: false,
        generationAllowed: false
      });
    }

    expect(
      evaluateLanguageGate(
        {
          selectedLanguage: 'fr',
          evidence: calibrated('fr', 0.9),
          isFinal: false
        },
        registry
      )
    ).toMatchObject({
      decision: 'provisional',
      displayAllowed: true,
      generationAllowed: false
    });
  });
});
