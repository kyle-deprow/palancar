import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_FIXTURE_CALIBRATION_VERSION,
  CONTROLLED_FIXTURE_DETECTOR_VERSION,
  DEVELOPMENT_PROVISIONAL_DETECTOR_VERSION,
  DEVELOPMENT_PROVISIONAL_MINIMUM_SUBSTANTIVE_CHARACTERS,
  DEVELOPMENT_PROVISIONAL_PROFILE_VERSION,
  LANGUAGE_REGISTRY_VERSION,
  countSubstantiveCharacters,
  createLanguageRegistry,
  evaluateLanguageGate,
  getLanguageDefinition,
  listLanguageDefinitions,
  snapshotClassifiedLanguageEvidence,
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
const DEVELOPMENT_PROFILE = {
  approvalClass: 'development-provisional',
  productionApproved: false,
  detectorVersion: DEVELOPMENT_PROVISIONAL_DETECTOR_VERSION,
  profileVersion: DEVELOPMENT_PROVISIONAL_PROFILE_VERSION,
  provisionalScoreThreshold: 0.65,
  provisionalMarginThreshold: 0.08,
  sourceTargetMarginThresholds: {
    es: 0.04,
    tr: 0.08
  },
  generatedOutputTargetMarginThresholds: {
    es: 0.05,
    tr: 0.08
  },
  minimumTextCharacters: DEVELOPMENT_PROVISIONAL_MINIMUM_SUBSTANTIVE_CHARACTERS,
  minimumWindowCharacters: 1,
  maximumInputCodePoints: 512,
  minimumSlidingWindowWords: 1,
  maximumSlidingWindowWords: 8
} as const;

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
  status: Exclude<LanguageClassificationStatus, 'calibrated' | 'provisional'>,
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
  it('exports the shared substantive-character invariant for built-in profiles', () => {
    expect(DEVELOPMENT_PROVISIONAL_MINIMUM_SUBSTANTIVE_CHARACTERS).toBe(12);
    expect(listLanguageDefinitions().map((definition) =>
      definition.developmentProvisional?.minimumTextCharacters
    )).toEqual([12, 12]);
    expect(countSubstantiveCharacters('!? \t\n')).toBe(0);
    expect(countSubstantiveCharacters('ñáéíóúÑÁÉÍÓÚ')).toBe(12);
    expect(countSubstantiveCharacters('çğıİöşüÇĞÖŞÜ')).toBe(12);
  });

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
        fixtureSuiteIds: ['language-foundation-es'],
        developmentProvisional: DEVELOPMENT_PROFILE
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
        fixtureSuiteIds: ['language-foundation-tr'],
        developmentProvisional: DEVELOPMENT_PROFILE
      }
    ]);
  });

  it('exports the exact frozen provisional profile versions and margins', () => {
    expect(DEVELOPMENT_PROVISIONAL_PROFILE_VERSION).toBe('eld-small-dev-7');
    expect(LANGUAGE_REGISTRY_VERSION).toBe('2.5.0');
    for (const definition of listLanguageDefinitions()) {
      expect(definition.developmentProvisional?.sourceTargetMarginThresholds)
        .toEqual({ es: 0.04, tr: 0.08 });
      expect(Object.isFrozen(
        definition.developmentProvisional?.sourceTargetMarginThresholds
      )).toBe(true);
      expect(definition.developmentProvisional?.generatedOutputTargetMarginThresholds)
        .toEqual({ es: 0.05, tr: 0.08 });
      expect(Object.isFrozen(
        definition.developmentProvisional?.generatedOutputTargetMarginThresholds
      )).toBe(true);
    }
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

  it('rejects asymmetric or production-claiming provisional profiles', () => {
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
      developmentProvisional: DEVELOPMENT_PROFILE
    }));
    expect(() => createLanguageRegistry([
      definitions[0] as LanguageDefinition<TargetLanguage>,
      {
        ...definitions[1],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          provisionalScoreThreshold: 0.7
        }
      } as LanguageDefinition<TargetLanguage>
    ])).toThrow(/symmetric/);
    expect(() => createLanguageRegistry([
      definitions[0] as LanguageDefinition<TargetLanguage>,
      {
        ...definitions[1],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          sourceTargetMarginThresholds: {
            ...DEVELOPMENT_PROFILE.sourceTargetMarginThresholds,
            es: 0.03
          }
        }
      } as LanguageDefinition<TargetLanguage>
    ])).toThrow(/symmetric/);
    expect(() => createLanguageRegistry([
      definitions[0] as LanguageDefinition<TargetLanguage>,
      {
        ...definitions[1],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          generatedOutputTargetMarginThresholds: {
            ...DEVELOPMENT_PROFILE.generatedOutputTargetMarginThresholds,
            es: 0.06
          }
        }
      } as LanguageDefinition<TargetLanguage>
    ])).toThrow(/symmetric/);
    expect(() => createLanguageRegistry([
      {
        ...definitions[0],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          productionApproved: true
        }
      } as unknown as LanguageDefinition<TargetLanguage>
    ])).toThrow(/never production approved/);
    expect(() => createLanguageRegistry([
      {
        ...definitions[0],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          calibrationVersion: 'forbidden'
        }
      } as unknown as LanguageDefinition<TargetLanguage>
    ])).toThrow(/unsupported field/);
    expect(() => createLanguageRegistry([
      {
        ...definitions[0],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          maximumInputCodePoints: 513
        }
      } as LanguageDefinition<TargetLanguage>
    ])).toThrow(/cannot exceed 512/);
    expect(() => createLanguageRegistry([
      {
        ...definitions[0],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          minimumSlidingWindowWords: 9
        }
      } as LanguageDefinition<TargetLanguage>
    ])).toThrow(/minimum sliding window words cannot exceed maximum/);
    expect(() => createLanguageRegistry([
      {
        ...definitions[0],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          sourceTargetMarginThresholds: {
            ...DEVELOPMENT_PROFILE.sourceTargetMarginThresholds,
            es: 1.01
          }
        }
      } as LanguageDefinition<TargetLanguage>
    ])).toThrow(/between 0 and 1/);
    expect(() => createLanguageRegistry([
      {
        ...definitions[0],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          sourceTargetMarginThresholds: {
            es: 0.04,
            tr: 0.08,
            ca: 0.04
          }
        }
      } as unknown as LanguageDefinition<TargetLanguage>
    ])).toThrow(/unsupported field/);
    expect(() => createLanguageRegistry([
      {
        ...definitions[0],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          sourceTargetMarginThresholds: {
            es: 0.04
          }
        }
      } as unknown as LanguageDefinition<TargetLanguage>
    ])).toThrow(/between 0 and 1/);
    expect(() => createLanguageRegistry([
      {
        ...definitions[0],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          sourceTargetMarginThresholds: {
            tr: 0.08
          }
        }
      } as unknown as LanguageDefinition<TargetLanguage>
    ])).toThrow(/between 0 and 1/);
    expect(() => createLanguageRegistry([
      {
        ...definitions[0],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          generatedOutputTargetMarginThresholds: {
            ...DEVELOPMENT_PROFILE.generatedOutputTargetMarginThresholds,
            es: 1.01
          }
        }
      } as LanguageDefinition<TargetLanguage>
    ])).toThrow(/between 0 and 1/);
    expect(() => createLanguageRegistry([
      {
        ...definitions[0],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          generatedOutputTargetMarginThresholds: {
            es: 0.05,
            tr: 0.08,
            ca: 0.05
          }
        }
      } as unknown as LanguageDefinition<TargetLanguage>
    ])).toThrow(/unsupported field/);
    expect(() => createLanguageRegistry([
      {
        ...definitions[0],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          generatedOutputTargetMarginThresholds: {
            es: 0.05
          }
        }
      } as unknown as LanguageDefinition<TargetLanguage>
    ])).toThrow(/between 0 and 1/);
    expect(() => createLanguageRegistry([
      {
        ...definitions[0],
        developmentProvisional: {
          ...DEVELOPMENT_PROFILE,
          generatedOutputTargetMarginThresholds: {
            tr: 0.08
          }
        }
      } as unknown as LanguageDefinition<TargetLanguage>
    ])).toThrow(/between 0 and 1/);
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
        isFinal: true,
        boundaryMode: 'production-calibrated'
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
        isFinal: true,
        boundaryMode: 'production-calibrated'
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

  it('validates provisional evidence with exact raw-score semantics', () => {
    const evidence = {
      status: 'provisional',
      detectorVersion: DEVELOPMENT_PROVISIONAL_DETECTOR_VERSION,
      profileVersion: DEVELOPMENT_PROVISIONAL_PROFILE_VERSION,
      detectedLanguage: 'es',
      provisionalScore: 0.8,
      decision: 'accept',
      reason: 'MATCH'
    } as const;
    expect(() => validateClassifiedLanguageEvidence(evidence)).not.toThrow();
    for (const forbidden of [
      { confidence: 0.8 },
      { calibrationVersion: 'not-calibrated' }
    ]) {
      expect(() => validateClassifiedLanguageEvidence({
        ...evidence,
        ...forbidden
      })).toThrow(/unsupported field/);
    }
    expect(() => validateClassifiedLanguageEvidence({
      ...evidence,
      provisionalScore: Number.NaN
    })).toThrow(/finite/);
  });

  it('snapshots only exact ordinary or frozen plain provisional evidence', () => {
    const evidence = {
      status: 'provisional',
      detectorVersion: DEVELOPMENT_PROVISIONAL_DETECTOR_VERSION,
      profileVersion: DEVELOPMENT_PROVISIONAL_PROFILE_VERSION,
      detectedLanguage: 'es',
      provisionalScore: 0.8,
      decision: 'accept',
      reason: 'MATCH'
    } as const;
    const ordinary = snapshotClassifiedLanguageEvidence(evidence);
    const frozen = snapshotClassifiedLanguageEvidence(Object.freeze({ ...evidence }));
    expect(ordinary).toEqual(evidence);
    expect(Object.isFrozen(ordinary)).toBe(true);
    expect(frozen).toEqual(evidence);

    const nonEnumerable = { ...evidence };
    Object.defineProperty(nonEnumerable, 'extra', { value: true });
    const symbolExtra = { ...evidence } as Record<PropertyKey, unknown>;
    symbolExtra[Symbol('extra')] = true;
    let accessorCalls = 0;
    const accessor = { ...evidence } as Record<string, unknown>;
    Object.defineProperty(accessor, 'reason', {
      enumerable: true,
      configurable: true,
      get: () => {
        accessorCalls += 1;
        return 'MATCH';
      }
    });
    for (const hostile of [nonEnumerable, symbolExtra, accessor]) {
      expect(() => validateClassifiedLanguageEvidence(hostile)).toThrow();
      expect(() => evaluateLanguageGate({
        selectedLanguage: 'es',
        evidence: hostile as ClassifiedLanguageEvidence,
        isFinal: true,
        boundaryMode: 'development-provisional'
      })).toThrow();
    }
    expect(accessorCalls).toBe(0);
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
        isFinal: true,
        boundaryMode: 'production-calibrated'
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
          isFinal: true,
          boundaryMode: 'production-calibrated'
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
  it('authorizes exact selected-target provisional evidence only in development mode', () => {
    for (const selectedLanguage of TARGETS) {
      for (const reason of ['MATCH', 'MATCH_IGNORED_SINGLETON'] as const) {
        const evidence = {
          status: 'provisional',
          detectorVersion: DEVELOPMENT_PROVISIONAL_DETECTOR_VERSION,
          profileVersion: DEVELOPMENT_PROVISIONAL_PROFILE_VERSION,
          detectedLanguage: selectedLanguage,
          provisionalScore: 0.65,
          decision: 'accept',
          reason
        } as const;
        expect(evaluateLanguageGate({
          selectedLanguage,
          evidence,
          isFinal: true,
          boundaryMode: 'development-provisional'
        })).toMatchObject({
          decision: 'target',
          displayAllowed: true,
          generationAllowed: true
        });
        expect(evaluateLanguageGate({
          selectedLanguage,
          evidence,
          isFinal: true,
          boundaryMode: 'production-calibrated'
        })).toMatchObject({
          decision: 'uncertain',
          generationAllowed: false
        });
      }
    }
  });

  it('keeps provisional target authorization closed across the full mutation matrix', () => {
    for (const selectedLanguage of TARGETS) {
      const opposite = oppositeTarget(selectedLanguage);
      for (const reason of ['MATCH', 'MATCH_IGNORED_SINGLETON'] as const) {
        const evidence = {
          status: 'provisional',
          detectorVersion: DEVELOPMENT_PROVISIONAL_DETECTOR_VERSION,
          profileVersion: DEVELOPMENT_PROVISIONAL_PROFILE_VERSION,
          detectedLanguage: selectedLanguage,
          provisionalScore: DEVELOPMENT_PROFILE.provisionalScoreThreshold,
          decision: 'accept',
          reason
        } as const;
        const acceptedInput = {
          selectedLanguage,
          evidence,
          isFinal: true,
          boundaryMode: 'development-provisional' as const
        };
        expect(evaluateLanguageGate(acceptedInput)).toMatchObject({
          decision: 'target',
          displayAllowed: true,
          generationAllowed: true
        });

        for (const mutatedEvidence of [
          { ...evidence, detectorVersion: 'wrong-detector' },
          { ...evidence, profileVersion: 'wrong-profile' },
          { ...evidence, provisionalScore: DEVELOPMENT_PROFILE.provisionalScoreThreshold - 0.01 },
          { ...evidence, detectedLanguage: opposite },
          { ...evidence, decision: 'reject' as const },
          { ...evidence, decision: 'uncertain' as const }
        ]) {
          expect(evaluateLanguageGate({
            ...acceptedInput,
            evidence: mutatedEvidence
          })).toMatchObject({
            decision: 'uncertain',
            displayAllowed: false,
            generationAllowed: false
          });
        }

        for (const boundaryMode of ['production-calibrated', 'development-provisional'] as const) {
          expect(evaluateLanguageGate({
            ...acceptedInput,
            boundaryMode,
            isFinal: false
          })).toMatchObject({
            decision: 'provisional',
            displayAllowed: false,
            generationAllowed: false
          });
        }

        expect(evaluateLanguageGate({
          ...acceptedInput,
          boundaryMode: 'production-calibrated'
        })).toMatchObject({
          decision: 'uncertain',
          displayAllowed: false,
          generationAllowed: false
        });
        expect(() => evaluateLanguageGate({
          ...acceptedInput,
          boundaryMode: 'invalid-mode' as never
        })).toThrow(/boundary mode is invalid/);
      }
    }
  });

  it('allows transcript display and generation only for a calibrated selected target', () => {
    for (const selectedLanguage of TARGETS) {
      expect(
        evaluateLanguageGate({
          selectedLanguage,
          evidence: calibrated(selectedLanguage, 0.8),
          isFinal: true,
          boundaryMode: 'production-calibrated'
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
            isFinal: true,
            boundaryMode: 'production-calibrated'
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
          isFinal: true,
          boundaryMode: 'production-calibrated'
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
            isFinal: true,
            boundaryMode: 'production-calibrated'
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
          isFinal: false,
          boundaryMode: 'production-calibrated'
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
            isFinal: false,
            boundaryMode: 'production-calibrated'
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
              isFinal: false,
              boundaryMode: 'production-calibrated'
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
          isFinal: false,
          boundaryMode: 'production-calibrated'
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
            isFinal: true,
            boundaryMode: 'production-calibrated'
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
            isFinal: true,
            boundaryMode: 'production-calibrated'
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
          isFinal: false,
          boundaryMode: 'production-calibrated'
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
