import {
  GenerationError,
  GenerationService,
  createAcceptedTargetTurn,
  isAcceptedGeneratedLanguageEvidence,
  type GeneratedLanguage,
  type GeneratedLanguageValidationInput
} from '@palancar/generation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDevelopmentProvisionalLanguageBoundary,
  isDevelopmentProvisionalGeneratedLanguageValidator,
  isDevelopmentProvisionalTextLanguageClassifier
} from '../src/provisional-language-boundary.js';
import {
  countSubstantiveCharacters,
  DEVELOPMENT_PROVISIONAL_MINIMUM_SUBSTANTIVE_CHARACTERS
} from '@palancar/language-registry';

const TEXT = Object.freeze({
  en: 'Good morning. Where is the train station?',
  es: 'Buenos días. ¿Dónde está la estación?',
  tr: 'Merhaba. Tren istasyonu nerede?'
});

interface DetectorSelection {
  readonly language: string;
  readonly score: number;
  readonly secondLanguage: string;
  readonly secondScore: number;
  readonly reliable: boolean;
}

function detectorFor(
  languageFor: (text: string) => string | DetectorSelection
): Readonly<{ detect(text: string): unknown }> {
  return Object.freeze({
    detect: (text: string) => {
      const selected = languageFor(text);
      const detection = typeof selected === 'string'
        ? {
            language: selected,
            score: 0.92,
            secondLanguage: selected === 'en' ? 'es' : 'en',
            secondScore: 0.02,
            reliable: true
          }
        : selected;
      return {
        language: detection.language,
        getScores: () => ({
          [detection.language]: detection.score,
          [detection.secondLanguage]: detection.secondScore
        }),
        isReliable: () => detection.reliable
      };
    }
  });
}

function canonicalEmptyDetection(): Readonly<{
  readonly language: '';
  readonly getScores: () => Readonly<Record<string, number>>;
  readonly isReliable: () => false;
}> {
  return Object.freeze({
    language: '',
    getScores: () => Object.freeze({}),
    isReliable: () => false
  });
}

function detectorWithExactResult(
  exactText: string,
  exactResult: unknown
): Readonly<{ detect(text: string): unknown }> {
  const baseline = detectorFor(tokenLanguage);
  return Object.freeze({
    detect: (text: string) =>
      text === exactText ? exactResult : baseline.detect(text)
  });
}

function detectorWithExactLanguages(
  fallbackTarget: 'es' | 'tr',
  overrides: Readonly<Record<string, string>>
): Readonly<{ detect(text: string): unknown }> {
  const exact = new Map(Object.entries(overrides));
  return detectorFor((text) => {
    const override = exact.get(text);
    if (override !== undefined) return override;
    const detected = tokenLanguage(text);
    return detected === 'zz' ? fallbackTarget : detected;
  });
}

function tokenLanguage(text: string): string {
  for (const [language, fixture] of Object.entries(TEXT)) {
    if (text === fixture) return language;
  }
  const labels = [
    ['es', text.indexOf('castellano')],
    ['tr', text.indexOf('türkçe')],
    ['fr', text.indexOf('francophone')],
    ['en', text.indexOf('english')]
  ] as const;
  const labeled = labels
    .filter((entry) => entry[1] >= 0)
    .sort((left, right) => left[1] - right[1])[0]?.[0];
  if (labeled !== undefined) return labeled;
  const words = new Set(text.toLocaleLowerCase('en-US').match(/\p{L}+/gu) ?? []);
  for (const [language, fixtureWords] of [
    ['es', ['buenos', 'días', 'dónde', 'está', 'la', 'estación']],
    ['tr', ['merhaba', 'tren', 'istasyonu', 'nerede']],
    ['en', ['good', 'morning', 'where', 'is', 'the', 'train', 'station']]
  ] as const) {
    if (fixtureWords.some((word) => words.has(word))) return language;
  }
  return 'zz';
}

function selectedMarker(target: 'es' | 'tr'): string {
  return target === 'es'
    ? 'castellano sustantivo completo'
    : 'türkçe anlamlı metin';
}

function embeddedPhrase(base: string, conflicting: string): string {
  return `${base} ${base} ${conflicting} ${base} ${base}`;
}

function exactCodePointLength(
  text: string,
  length: number,
  padding: string
): string {
  const values = Array.from(text);
  const pad = Array.from(padding);
  let index = 0;
  while (values.length < length) {
    values.push(pad[index % pad.length] as string);
    index += 1;
  }
  return values.slice(0, length).join('');
}

function generatedInput(
  target: 'es' | 'tr',
  count: 5 | 7,
  override?: Readonly<{ index: number; text: string }>
): GeneratedLanguageValidationInput {
  const languages: GeneratedLanguage[] =
    count === 5
      ? ['en', 'en', target, 'en', target]
      : ['en', 'en', target, 'en', target, 'en', target];
  const slots = [
    'translation.english',
    'suggestion[0].english',
    'suggestion[0].target',
    'suggestion[1].english',
    'suggestion[1].target',
    'suggestion[2].english',
    'suggestion[2].target'
  ] as const;
  return Object.freeze({
    checks: Object.freeze(languages.map((expectedLanguage, index) => Object.freeze({
      slot: slots[index] as (typeof slots)[number],
      text:
        override?.index === index
          ? override.text
          : TEXT[expectedLanguage],
      expectedLanguage
    }))) as GeneratedLanguageValidationInput['checks']
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('development provisional ELD-small boundary', () => {
  it.each([
    ['es', 'ñáéíóúÑÁÉÍÓÚ'],
    ['tr', 'çğıİöşüÇĞÖŞÜ']
  ] as const)(
    'uses the shared substantive-character invariant for %s Unicode text',
    async (target, text) => {
      const oneShort = Array.from(text).slice(0, -1).join('');
      expect(countSubstantiveCharacters(text)).toBe(
        DEVELOPMENT_PROVISIONAL_MINIMUM_SUBSTANTIVE_CHARACTERS
      );
      expect(countSubstantiveCharacters(oneShort)).toBe(
        DEVELOPMENT_PROVISIONAL_MINIMUM_SUBSTANTIVE_CHARACTERS - 1
      );
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => detectorFor((candidate) => {
          const substantive = candidate.match(/[\p{L}\p{N}]/gu)?.join('') ?? '';
          return substantive === text || substantive === oneShort
            ? target
            : tokenLanguage(candidate);
        })
      });

      await expect(
        boundary.classifier.classify(`  ${text} !!!  `, target)
      ).resolves.toMatchObject({
        decision: 'accept',
        reason: 'MATCH'
      });
      await expect(
        boundary.classifier.classify(`  ${oneShort} !!!  `, target)
      ).resolves.toMatchObject({
        decision: 'uncertain',
        reason: 'TOO_SHORT'
      });
    }
  );

  it.each([
    ['es', TEXT.es],
    ['tr', TEXT.tr]
  ] as const)('accepts substantive symmetric %s source text', async (target, text) => {
    const boundary = createDevelopmentProvisionalLanguageBoundary();
    expect(isDevelopmentProvisionalTextLanguageClassifier(boundary.classifier)).toBe(true);
    expect(
      isDevelopmentProvisionalGeneratedLanguageValidator(
        boundary.generatedLanguageValidator
      )
    ).toBe(true);
    await expect(boundary.classifier.classify(text, target)).resolves.toMatchObject({
      status: 'provisional',
      detectedLanguage: target,
      decision: 'accept',
      reason: 'MATCH'
    });
  });

  it.each([
    ['es', 0.8462327011788826],
    ['tr', 0.726775956284153]
  ] as const)(
    'accepts pinned real-ELD %s source evidence with an isolated canonical-empty numeric window',
    async (target, expectedScore) => {
      const eld = (await import('eld/small')).default;
      const detector = eld.newInstance();
      let canonicalEmptyWindows = 0;
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => Object.freeze({
          detect: (text: string) => {
            const result = detector.detect(text);
            if (
              text === '2026' &&
              result.language === '' &&
              Reflect.ownKeys(result.getScores()).length === 0 &&
              result.isReliable() === false
            ) {
              canonicalEmptyWindows += 1;
            }
            return result;
          }
        })
      });

      const result = await boundary.classifier.classify(
        `${TEXT[target]} 2026`,
        target
      );

      expect(result).toMatchObject({
        status: 'provisional',
        detectedLanguage: target,
        decision: 'accept',
        reason: 'MATCH'
      });
      if (result.status !== 'provisional') {
        throw new Error('expected provisional source evidence');
      }
      expect(result.provisionalScore).toBeCloseTo(expectedScore, 12);
      expect(canonicalEmptyWindows).toBeGreaterThan(0);
    }
  );

  it.each(['es', 'tr'] as const)(
    'maps a canonical-empty full %s detection to unknown uncertain evidence',
    async (target) => {
      const fullText = 'canonical empty detector result';
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => detectorWithExactResult(
          fullText,
          canonicalEmptyDetection()
        )
      });

      await expect(boundary.classifier.classify(fullText, target)).resolves.toEqual({
        status: 'provisional',
        detectorVersion: 'eld-small-2.1.0',
        profileVersion: 'eld-small-dev-5',
        detectedLanguage: 'unknown',
        provisionalScore: 0,
        decision: 'uncertain',
        reason: 'UNKNOWN'
      });
    }
  );

  it.each([
    ['es', 5],
    ['es', 7],
    ['tr', 5],
    ['tr', 7]
  ] as const)(
    'tolerates canonical-empty subwindows but rejects canonical-empty and wrong full %s %i-check results',
    async (target, count) => {
      const baseline = generatedInput(target, count);
      const expected = baseline.checks[2]?.expectedLanguage;
      if (expected === undefined) throw new Error('missing generated check');
      const fullEmpty = 'canonical empty generated result';
      const detector = detectorFor(tokenLanguage);
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => Object.freeze({
          detect: (text: string) => {
            if (text === '2026' || text === fullEmpty) {
              return canonicalEmptyDetection();
            }
            return detector.detect(text);
          }
        })
      });
      const withEmptyWindow = Object.freeze({
        checks: Object.freeze(baseline.checks.map((check) => Object.freeze({
          ...check,
          text: `${check.text} 2026`
        })))
      }) as GeneratedLanguageValidationInput;
      const accepted = await boundary.generatedLanguageValidator.validate(
        withEmptyWindow,
        { signal: new AbortController().signal }
      );
      expect(isAcceptedGeneratedLanguageEvidence(
        accepted,
        'development-provisional'
      )).toBe(true);

      const emptyEvidence = await boundary.generatedLanguageValidator.validate(
        generatedInput(target, count, { index: 2, text: fullEmpty }),
        { signal: new AbortController().signal }
      );
      expect(emptyEvidence.checks[2]).toMatchObject({
        expectedLanguage: expected,
        detectedLanguage: 'undetermined',
        verdict: 'indeterminate',
        provisionalScoreBasisPoints: 0
      });
      expect(isAcceptedGeneratedLanguageEvidence(
        emptyEvidence,
        'development-provisional'
      )).toBe(false);

      const wrongEvidence = await boundary.generatedLanguageValidator.validate(
        generatedInput(target, count, {
          index: 2,
          text: target === 'es' ? TEXT.tr : TEXT.es
        }),
        { signal: new AbortController().signal }
      );
      expect(wrongEvidence.checks[2]).toMatchObject({
        verdict: 'mismatch'
      });
      expect(isAcceptedGeneratedLanguageEvidence(
        wrongEvidence,
        'development-provisional'
      )).toBe(false);
    }
  );

  it.each([
    ['es', 5],
    ['es', 7],
    ['tr', 5],
    ['tr', 7]
  ] as const)(
    'accepts pinned real-ELD %s %i-check output with canonical-empty numeric subwindows',
    async (target, count) => {
      const eld = (await import('eld/small')).default;
      const detector = eld.newInstance();
      let canonicalEmptyWindows = 0;
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => Object.freeze({
          detect: (text: string) => {
            const result = detector.detect(text);
            if (
              text === '2026' &&
              result.language === '' &&
              Reflect.ownKeys(result.getScores()).length === 0 &&
              result.isReliable() === false
            ) {
              canonicalEmptyWindows += 1;
            }
            return result;
          }
        })
      });
      const baseline = generatedInput(target, count);
      const input = Object.freeze({
        checks: Object.freeze(baseline.checks.map((check) => Object.freeze({
          ...check,
          text: `${check.text} 2026`
        })))
      }) as GeneratedLanguageValidationInput;

      const evidence = await boundary.generatedLanguageValidator.validate(input, {
        signal: new AbortController().signal
      });

      expect(isAcceptedGeneratedLanguageEvidence(
        evidence,
        'development-provisional'
      )).toBe(true);
      expect(canonicalEmptyWindows).toBeGreaterThanOrEqual(count);
    }
  );

  it.each([
    ['English', 'es', TEXT.en, 'ENGLISH'],
    ['other target', 'es', TEXT.tr, 'UNSELECTED_LANGUAGE'],
    ['unsupported', 'es', 'Bonjour. Où se trouve la gare ferroviaire?', 'UNSELECTED_LANGUAGE'],
    ['too short', 'es', 'hola', 'TOO_SHORT'],
    ['mixed English/Spanish', 'es', `${TEXT.en} ${TEXT.es}`, 'UNKNOWN'],
    ['mixed Spanish/Turkish', 'tr', `${TEXT.es} ${TEXT.tr}`, 'UNSELECTED_LANGUAGE']
  ] as const)('rejects or marks %s source evidence fail-closed', async (
    _name,
    target,
    text,
    reason
  ) => {
    const { classifier } = createDevelopmentProvisionalLanguageBoundary();
    const result = await classifier.classify(text, target);
    expect(result).toMatchObject({ status: 'provisional', reason });
    expect(result.status === 'provisional' && result.decision).not.toBe('accept');
    expect(result).not.toHaveProperty('confidence');
    expect(result).not.toHaveProperty('calibrationVersion');
  });

  it.each([
    ['es', 5],
    ['es', 7],
    ['tr', 5],
    ['tr', 7]
  ] as const)('accepts an exact %s %i-check generated-language set', async (target, count) => {
    const { generatedLanguageValidator } =
      createDevelopmentProvisionalLanguageBoundary();
    const input = generatedInput(target, count);
    const evidence = await generatedLanguageValidator.validate(input, {
      signal: new AbortController().signal
    });
    expect(
      isAcceptedGeneratedLanguageEvidence(evidence, 'development-provisional')
    ).toBe(true);
    expect(evidence.checks.every((check) =>
      check.evidenceType === 'development-provisional' &&
      check.confidenceBasisPoints === null &&
      check.provisionalScoreBasisPoints !== null
    )).toBe(true);
    expect(isAcceptedGeneratedLanguageEvidence(evidence)).toBe(false);
  });

  it.each([
    ['wrong', TEXT.tr],
    ['mixed', `${TEXT.en} ${TEXT.es}`],
    ['unknown', 'zxqv zxqv zxqv zxqv'],
    ['short', 'hola'],
    ['empty', '']
  ] as const)('rejects %s generated target text', async (_name, text) => {
    const { generatedLanguageValidator } =
      createDevelopmentProvisionalLanguageBoundary();
    const input = generatedInput('es', 5, { index: 2, text });
    const evidence = await generatedLanguageValidator.validate(input, {
      signal: new AbortController().signal
    });
    expect(
      isAcceptedGeneratedLanguageEvidence(evidence, 'development-provisional')
    ).toBe(false);
  });

  it('fails source and generated validation closed when the detector throws', async () => {
    const boundary = createDevelopmentProvisionalLanguageBoundary({
      loadDetector: () => Object.freeze({
        detect: () => {
          throw new Error('detector failed');
        }
      })
    });
    await expect(boundary.classifier.classify(TEXT.es, 'es')).resolves.toMatchObject({
      status: 'provisional',
      decision: 'reject',
      reason: 'DETECTOR_ERROR'
    });
    const input = generatedInput('es', 5);
    const evidence = await boundary.generatedLanguageValidator.validate(input, {
      signal: new AbortController().signal
    });
    expect(
      isAcceptedGeneratedLanguageEvidence(evidence, 'development-provisional')
    ).toBe(false);
  });

  it('reduces embedded conflicting clauses to minimal source cores in both orders and targets', async () => {
    for (const target of ['es', 'tr'] as const) {
      const targetToken = target === 'es' ? 'castellano sustantivo' : 'türkçe anlamlı metin';
      for (const text of [
        `${targetToken}. francophone substantive language.`,
        `francophone substantive language. ${targetToken}.`
      ]) {
        const boundary = createDevelopmentProvisionalLanguageBoundary({
          loadDetector: () => detectorFor((candidate) => {
            const language = tokenLanguage(candidate);
            return language === 'zz' ? target : language;
          })
        });
        await expect(boundary.classifier.classify(text, target)).resolves.toMatchObject(
          text.startsWith(targetToken)
            ? {
                status: 'provisional',
                detectedLanguage: target,
                decision: 'accept',
                reason: 'MATCH_IGNORED_SINGLETON'
              }
            : {
                status: 'provisional',
                detectedLanguage: 'fr',
                decision: 'reject',
                reason: 'UNSELECTED_LANGUAGE'
              }
        );

        const evidence = await boundary.generatedLanguageValidator.validate(
          generatedInput(target, 5, { index: 2, text }),
          { signal: new AbortController().signal }
        );
        expect(isAcceptedGeneratedLanguageEvidence(
          evidence,
          'development-provisional'
        )).toBe(false);
        expect(evidence.checks[2]).toMatchObject({
          detectedLanguage: 'mixed',
          verdict: 'mismatch'
        });
      }
    }
  });

  it('tracks source containment, overlap, position, Unicode, punctuation, and long-clause intervals', async () => {
    for (const target of ['es', 'tr'] as const) {
      const cases = [
        {
          text: `${selectedMarker(target)}. outer alpha beta gamma.`,
          overrides: {
            'outer alpha beta gamma': 'fr',
            'alpha beta gamma': 'fr',
            beta: 'fr'
          },
          expected: 'MATCH_IGNORED_SINGLETON'
        },
        {
          text: `${selectedMarker(target)}. left right middle.`,
          overrides: {
            'left right': 'fr',
            'right middle': 'fr'
          },
          expected: 'MIXED'
        },
        {
          text: `${selectedMarker(target)}. alpha,beta.`,
          overrides: {
            'alpha,beta': 'fr',
            'alpha beta': 'de'
          },
          expected: 'MIXED'
        },
        {
          text: `${selectedMarker(target)}. repeat. gap. repeat.`,
          overrides: { repeat: 'fr' },
          expected: 'MIXED'
        },
        {
          text: `${selectedMarker(target)}. café. 東京.`,
          overrides: { café: 'fr', 東京: 'de' },
          expected: 'MIXED'
        },
        {
          text: `${selectedMarker(target)}. one two three four five six seven eight nine.`,
          overrides: {
            'one two three four five six seven eight nine': 'fr'
          },
          expected: 'MIXED'
        }
      ] as const;

      for (const testCase of cases) {
        const boundary = createDevelopmentProvisionalLanguageBoundary({
          loadDetector: () => detectorWithExactLanguages(target, testCase.overrides)
        });
        await expect(boundary.classifier.classify(testCase.text, target)).resolves.toMatchObject({
          reason: testCase.expected,
          ...(testCase.expected === 'MIXED'
            ? { detectedLanguage: 'mixed', decision: 'reject' }
            : { detectedLanguage: target, decision: 'accept' })
        });
      }
    }
  });

  it.each(['es', 'tr'] as const)(
    'counts conflicting detector strings at one lexical singleton position once for %s',
    async (target) => {
      const observed = new Set<string>();
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => detectorFor((candidate) => {
          if (
            candidate === 'sameposition,' ||
            candidate === 'sameposition' ||
            candidate === 'secondposition,' ||
            candidate === 'secondposition'
          ) {
            observed.add(candidate);
          }
          if (candidate === 'sameposition,') return 'fr';
          if (candidate === 'sameposition') return 'de';
          if (candidate === 'secondposition,') return 'fr';
          if (candidate === 'secondposition') return 'de';
          const detected = tokenLanguage(candidate);
          return detected === 'zz' ? target : detected;
        })
      });

      await expect(boundary.classifier.classify(
        `${selectedMarker(target)}. sameposition,`,
        target
      )).resolves.toMatchObject({
        detectedLanguage: target,
        decision: 'accept',
        reason: 'MATCH_IGNORED_SINGLETON'
      });
      expect(observed).toEqual(new Set(['sameposition,', 'sameposition']));

      await expect(boundary.classifier.classify(
        `${selectedMarker(target)}. sameposition,; secondposition,`,
        target
      )).resolves.toMatchObject({
        detectedLanguage: 'mixed',
        decision: 'reject',
        reason: 'MIXED'
      });
      expect(observed).toEqual(new Set([
        'sameposition,',
        'sameposition',
        'secondposition,',
        'secondposition'
      ]));
    }
  );

  it.each(['tr', 'es'] as const)(
    'detects standalone and embedded one-word English and unsupported conflicts in %s source',
    async (target) => {
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => detectorFor((text) => {
          const language = tokenLanguage(text);
          return language === 'zz' ? target : language;
        })
      });
      for (const [conflicting, standaloneReason] of [
        ['englishlanguage', 'ENGLISH'],
        ['francophoneword', 'UNSELECTED_LANGUAGE']
      ] as const) {
        await expect(
          boundary.classifier.classify(conflicting, target)
        ).resolves.toMatchObject({
          decision: 'reject',
          reason: standaloneReason
        });
        await expect(
          boundary.classifier.classify(
            embeddedPhrase(selectedMarker(target), conflicting),
            target
          )
        ).resolves.toMatchObject({
          detectedLanguage: target,
          decision: 'accept',
          reason: 'MATCH_IGNORED_SINGLETON'
        });
      }
    }
  );

  it.each(['es', 'tr'] as const)(
    'applies minimal source conflict cores symmetrically for %s',
    async (target) => {
      const singletonCalls: string[] = [];
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => detectorFor((text) => {
          const known = tokenLanguage(text);
          if (known !== 'zz') return known;
          if (text === 'isolatedword') {
            singletonCalls.push(text);
            return 'fr';
          }
          if (text === 'isolatedone' || text === 'isolatedtwo') return 'fr';
          if (text === 'coreleft coreright') return 'fr';
          return target;
        })
      });

      await expect(boundary.classifier.classify(
        `${selectedMarker(target)}. isolatedword.`,
        target
      )).resolves.toMatchObject({
        detectedLanguage: target,
        decision: 'accept',
        reason: 'MATCH_IGNORED_SINGLETON'
      });
      expect(singletonCalls).toHaveLength(1);

      await expect(boundary.classifier.classify(
        `${selectedMarker(target)}. isolatedone. isolatedtwo.`,
        target
      )).resolves.toMatchObject({
        detectedLanguage: 'mixed',
        decision: 'reject',
        reason: 'MIXED'
      });

      await expect(boundary.classifier.classify(
        `${selectedMarker(target)}. coreleft coreright.`,
        target
      )).resolves.toMatchObject({
        detectedLanguage: 'mixed',
        decision: 'reject',
        reason: 'MIXED'
      });
    }
  );

  it.each(['es', 'tr'] as const)(
    'deduplicates source detector calls by exact string while preserving %s interval semantics',
    async (target) => {
      const singleClause = target === 'es'
        ? 'castellano sustantivo'
        : 'türkçe anlamlı';
      const repeatedInterval = 'repeatedsourceword';
      const repeatedSource = `${selectedMarker(target)}. ${repeatedInterval} ${repeatedInterval}.`;
      const seen: string[] = [];
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => detectorFor((text) => {
          seen.push(text);
          if (text === repeatedInterval) return 'fr';
          const detected = tokenLanguage(text);
          return detected === 'zz' ? target : detected;
        })
      });

      await boundary.classifier.ready;
      seen.length = 0;
      await expect(boundary.classifier.classify(singleClause, target)).resolves.toMatchObject({
        detectedLanguage: target,
        decision: 'accept',
        reason: 'MATCH'
      });
      expect(seen[0]).toBe(singleClause);
      expect(seen.filter((text) => text === singleClause)).toHaveLength(1);

      seen.length = 0;
      await expect(boundary.classifier.classify(repeatedSource, target)).resolves.toMatchObject({
        detectedLanguage: 'mixed',
        decision: 'reject',
        reason: 'MIXED'
      });
      expect(seen[0]).toBe(repeatedSource);
      expect(seen.filter((text) => text === repeatedInterval)).toHaveLength(1);
      expect(seen).toContain(`${repeatedInterval} ${repeatedInterval}`);
    }
  );

  it.each(['tr', 'es'] as const)(
    'ignores reliable weak one-word conflicts in %s source',
    async (target) => {
      const targetLanguage = target;
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => detectorFor((text) => {
          const readinessOrMarked = tokenLanguage(text);
          if (readinessOrMarked !== 'zz') return readinessOrMarked;
          if (text === 'weakzeromargin') {
            return {
              language: 'ca',
              score: 0.58,
              secondLanguage: targetLanguage,
              secondScore: 0.58,
              reliable: true
            };
          }
          if (text === 'weaklowscore') {
            return {
              language: 'fr',
              score: 0.6,
              secondLanguage: targetLanguage,
              secondScore: 0.1,
              reliable: true
            };
          }
          return targetLanguage;
        })
      });
      for (const weakConflict of ['weakzeromargin', 'weaklowscore']) {
        await expect(boundary.classifier.classify(
          embeddedPhrase(selectedMarker(target), weakConflict),
          target
        )).resolves.toMatchObject({
          detectedLanguage: target,
          decision: 'accept',
          reason: 'MATCH'
        });
      }
    }
  );

  it.each([
    ['tr', 5],
    ['tr', 7],
    ['es', 5],
    ['es', 7]
  ] as const)(
    'detects embedded one-word conflicts in every %s generated %i-check output direction',
    async (target, count) => {
      const baseline = generatedInput(target, count);
      for (let index = 0; index < count; index += 1) {
        const expected = baseline.checks[index]?.expectedLanguage;
        if (expected === undefined) throw new Error('missing generated check');
        const base = expected === 'en'
          ? 'english substantive baseline'
          : selectedMarker(target);
        const conflicts = expected === 'en'
          ? [target === 'es' ? 'castellano' : 'türkçe', 'francophoneword']
          : ['englishlanguage', 'francophoneword'];
        for (const conflicting of conflicts) {
          const boundary = createDevelopmentProvisionalLanguageBoundary({
            loadDetector: () => detectorFor(tokenLanguage)
          });
          const evidence = await boundary.generatedLanguageValidator.validate(
            generatedInput(target, count, {
              index,
              text: embeddedPhrase(base, conflicting)
            }),
            { signal: new AbortController().signal }
          );
          expect(evidence.checks[index]).toMatchObject({
            detectedLanguage: 'mixed',
            verdict: 'mismatch'
          });
          expect(evidence.checks.every((check, checkIndex) =>
            checkIndex === index || check.verdict === 'match'
          )).toBe(true);
          expect(isAcceptedGeneratedLanguageEvidence(
            evidence,
            'development-provisional'
          )).toBe(false);
        }
      }
    }
  );

  it('keeps generated punctuation, apostrophe, hyphen, and whitespace collisions strict in every slot', async () => {
    const collisions = [
      {
        clause: 'alpha,beta gamma delta epsilon zeta eta theta',
        canonical: 'alpha beta gamma delta epsilon zeta eta theta'
      },
      {
        clause: "l'amour gamma delta epsilon zeta eta theta",
        canonical: 'l amour gamma delta epsilon zeta eta theta'
      },
      {
        clause: 'bien-être gamma delta epsilon zeta eta theta',
        canonical: 'bien être gamma delta epsilon zeta eta theta'
      },
      {
        clause: 'alpha  beta gamma delta epsilon zeta eta theta',
        canonical: 'alpha beta gamma delta epsilon zeta eta theta'
      }
    ] as const;

    for (const target of ['es', 'tr'] as const) {
      for (const count of [5, 7] as const) {
        const baseline = generatedInput(target, count);
        for (let index = 0; index < count; index += 1) {
          const expected = baseline.checks[index]?.expectedLanguage;
          if (expected === undefined) throw new Error('missing generated check');
          for (const collision of collisions) {
            const boundary = createDevelopmentProvisionalLanguageBoundary({
              loadDetector: () => detectorFor((text) => {
                if (text === collision.canonical) {
                  return expected === 'en' ? target : 'en';
                }
                const detected = tokenLanguage(text);
                return detected === 'zz' ? expected : detected;
              })
            });
            const evidence = await boundary.generatedLanguageValidator.validate(
              generatedInput(target, count, { index, text: collision.clause }),
              { signal: new AbortController().signal }
            );
            expect(evidence.checks[index]).toMatchObject({
              detectedLanguage: 'mixed',
              verdict: 'mismatch'
            });
            expect(isAcceptedGeneratedLanguageEvidence(
              evidence,
              'development-provisional'
            )).toBe(false);
          }
        }
      }
    }
  });

  it.each(['es', 'tr'] as const)(
    'preserves generated clause-then-canonical detector order for %s',
    async (target) => {
      const text = 'alpha,beta gamma delta epsilon zeta eta theta';
      const canonical = [
        'alpha',
        'beta',
        'gamma',
        'delta',
        'epsilon',
        'zeta',
        'eta',
        'theta'
      ];
      const seen: string[] = [];
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => detectorFor((candidate) => {
          seen.push(candidate);
          const detected = tokenLanguage(candidate);
          return detected === 'zz' ? target : detected;
        })
      });
      await boundary.generatedLanguageValidator.validate(
        generatedInput(target, 5, { index: 2, text }),
        { signal: new AbortController().signal }
      );
      const fullIndex = seen.indexOf(text);
      expect(fullIndex).toBeGreaterThanOrEqual(0);
      expect(seen.slice(fullIndex, fullIndex + 10)).toEqual([
        text,
        text,
        ...canonical
      ]);
    }
  );

  it('inspects every overlapping profile window from one through eight words', async () => {
    const seen: string[] = [];
    const boundary = createDevelopmentProvisionalLanguageBoundary({
      loadDetector: () => detectorFor((text) => {
        seen.push(text);
        const language = tokenLanguage(text);
        return language === 'zz' ? 'es' : language;
      })
    });
    await boundary.classifier.ready;
    seen.length = 0;
    const words = [
      'uno',
      'dos',
      'tres',
      'cuatro',
      'cinco',
      'seis',
      'siete',
      'ocho',
      'nueve',
      'diez'
    ];
    await boundary.classifier.classify(words.join(' '), 'es');
    for (let length = 1; length <= 8; length += 1) {
      for (let start = 0; start + length <= words.length; start += 1) {
        expect(seen).toContain(words.slice(start, start + length).join(' '));
      }
    }
  });

  it('inspects every qualifying clause, including the tail', async () => {
    const head = Array.from(
      { length: 12 },
      (_, index) => `castellano sustantivo numero ${index}`
    ).join('. ');
    const text = `${head}. francophone substantive language tail.`;
    for (const target of ['es', 'tr'] as const) {
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => detectorFor(tokenLanguage)
      });
      const sourceText = target === 'es'
        ? text
        : text.replaceAll('castellano', 'türkçe');
      await expect(boundary.classifier.classify(sourceText, target)).resolves.toMatchObject({
        decision: 'reject',
        reason: 'MIXED'
      });
    }
  });

  it('fails the prior 4032-code-point interior-conflict probe closed', async () => {
    for (const target of ['es', 'tr'] as const) {
      const selected = target === 'es'
        ? 'castellano sustantivo '
        : 'türkçe anlamlı metin ';
      const probe = exactCodePointLength(
        `${selected.repeat(70)}. francophone substantive interior. ${selected.repeat(70)}`,
        4_032,
        selected
      );
      expect(Array.from(probe)).toHaveLength(4_032);
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => detectorFor(tokenLanguage)
      });
      await expect(boundary.classifier.classify(probe, target)).resolves.toMatchObject({
        status: 'provisional',
        detectedLanguage: 'unknown',
        decision: 'uncertain',
        reason: 'UNKNOWN'
      });
    }
  });

  it('finds max-sized interior conflicts in both source and generated target output', async () => {
    for (const target of ['es', 'tr'] as const) {
      const selected = target === 'es'
        ? 'castellano sustantivo '
        : 'türkçe anlamlı metin ';
      const source = exactCodePointLength(
        `${selected.repeat(9)}. francophone substantive interior conflict. ${selected.repeat(9)}`,
        512,
        selected
      );
      const output = exactCodePointLength(
        `${selected.repeat(2)}. francophone substantive interior. ${selected.repeat(2)}`,
        160,
        selected
      );
      expect(Array.from(source)).toHaveLength(512);
      expect(Array.from(output)).toHaveLength(160);
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => detectorFor(tokenLanguage)
      });
      await expect(boundary.classifier.classify(source, target)).resolves.toMatchObject({
        decision: 'reject',
        reason: 'MIXED'
      });
      const generated = await boundary.generatedLanguageValidator.validate(
        generatedInput(target, 5, { index: 2, text: output }),
        { signal: new AbortController().signal }
      );
      expect(generated.checks[2]).toMatchObject({
        detectedLanguage: 'mixed',
        verdict: 'mismatch'
      });
      expect(isAcceptedGeneratedLanguageEvidence(
        generated,
        'development-provisional'
      )).toBe(false);
    }
  });

  it('rejects every wrong generated slot in both directions for 5 and 7 checks', async () => {
    for (const target of ['es', 'tr'] as const) {
      for (const count of [5, 7] as const) {
        const baseline = generatedInput(target, count);
        for (let index = 0; index < count; index += 1) {
          const expected = baseline.checks[index]?.expectedLanguage;
          const text = expected === 'en' ? TEXT[target] : TEXT.en;
          const boundary = createDevelopmentProvisionalLanguageBoundary();
          const evidence = await boundary.generatedLanguageValidator.validate(
            generatedInput(target, count, { index, text }),
            { signal: new AbortController().signal }
          );
          expect(isAcceptedGeneratedLanguageEvidence(
            evidence,
            'development-provisional'
          )).toBe(false);
        }
      }
    }
  });

  it('normalizes NFKC and fails oversized, short, and malformed detector results closed', async () => {
    const observed: string[] = [];
    const normalizing = createDevelopmentProvisionalLanguageBoundary({
      loadDetector: () => detectorFor((text) => {
        observed.push(text);
        const language = tokenLanguage(text);
        return language === 'zz' ? 'es' : language;
      })
    });
    await normalizing.classifier.classify(
      'Ｂｕｅｎｏｓ ｄｉａｓ ｅｎ ｃａｓｔｅｌｌａｎｏ',
      'es'
    );
    expect(observed).toContain('Buenos dias en castellano');

    await expect(
      normalizing.classifier.classify('x'.repeat(513), 'es')
    ).resolves.toMatchObject({ decision: 'uncertain', reason: 'UNKNOWN' });
    await expect(
      normalizing.classifier.classify('hola', 'es')
    ).resolves.toMatchObject({ decision: 'uncertain', reason: 'TOO_SHORT' });

    for (const malformed of [
      {
        language: '',
        getScores: () => ({ es: 0 }),
        isReliable: () => false
      },
      {
        language: '',
        getScores: () => ({}),
        isReliable: () => true
      },
      {
        language: 'es',
        getScores: () => ({}),
        isReliable: () => false
      },
      {
        language: 'es',
        getScores: () => ({ tr: 0.9, es: 0.1 }),
        isReliable: () => true
      },
      {
        language: 'es',
        getScores: () => ({ es: Number.NaN }),
        isReliable: () => true
      },
      {
        language: 'es',
        getScores: null,
        isReliable: () => true
      }
    ]) {
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => Object.freeze({ detect: () => malformed })
      });
      await expect(boundary.classifier.classify(TEXT.es, 'es')).resolves.toMatchObject({
        decision: 'reject',
        reason: 'DETECTOR_ERROR'
      });
    }
  });

  it('rejects proxy and accessor detector results without invoking accessors', async () => {
    const probe = 'hostile detector result probe';
    let resultAccessorCalls = 0;
    let scoreAccessorCalls = 0;
    const accessorResult = {
      getScores: () => ({}),
      isReliable: () => false
    } as Record<string, unknown>;
    Object.defineProperty(accessorResult, 'language', {
      enumerable: true,
      configurable: true,
      get: () => {
        resultAccessorCalls += 1;
        return '';
      }
    });
    const accessorScores = {} as Record<string, unknown>;
    Object.defineProperty(accessorScores, 'es', {
      enumerable: true,
      configurable: true,
      get: () => {
        scoreAccessorCalls += 1;
        return 0.9;
      }
    });
    const scoreAccessorResult = {
      language: 'es',
      getScores: () => accessorScores,
      isReliable: () => true
    };
    for (const hostile of [
      new Proxy(canonicalEmptyDetection(), {}),
      {
        language: '',
        getScores: () => new Proxy({}, {}),
        isReliable: () => false
      },
      accessorResult,
      scoreAccessorResult
    ]) {
      const boundary = createDevelopmentProvisionalLanguageBoundary({
        loadDetector: () => detectorWithExactResult(probe, hostile)
      });
      await expect(boundary.classifier.classify(probe, 'es')).resolves.toMatchObject({
        detectedLanguage: 'unknown',
        decision: 'reject',
        reason: 'DETECTOR_ERROR'
      });
    }
    expect(resultAccessorCalls).toBe(0);
    expect(scoreAccessorCalls).toBe(0);
  });

  it('initializes one detector lazily through readiness and contains loader failure', async () => {
    let loads = 0;
    let detections = 0;
    const boundary = createDevelopmentProvisionalLanguageBoundary({
      loadDetector: () => {
        loads += 1;
        return detectorFor((text) => {
          detections += 1;
          const language = tokenLanguage(text);
          return language === 'zz' ? 'es' : language;
        });
      }
    });
    expect(loads).toBe(0);
    const ready = boundary.classifier.ready;
    expect(loads).toBe(0);
    await ready;
    expect(loads).toBe(1);
    expect(detections).toBe(3);
    await boundary.classifier.ready;
    expect(loads).toBe(1);
    expect(detections).toBe(3);
    await boundary.classifier.classify(TEXT.es, 'es');
    expect(loads).toBe(1);
    expect(detections).toBeGreaterThan(3);
    await boundary.generatedLanguageValidator.validate(generatedInput('es', 5), {
      signal: new AbortController().signal
    });
    expect(loads).toBe(1);

    let failedLoads = 0;
    const unavailable = createDevelopmentProvisionalLanguageBoundary({
      loadDetector: () => {
        failedLoads += 1;
        throw new Error('load failed');
      }
    });
    await expect(unavailable.classifier.ready).rejects.toThrow();
    await expect(unavailable.classifier.classify(TEXT.es, 'es')).resolves.toMatchObject({
      decision: 'reject',
      reason: 'DETECTOR_ERROR'
    });
    const evidence = await unavailable.generatedLanguageValidator.validate(
      generatedInput('es', 5),
      { signal: new AbortController().signal }
    );
    expect(isAcceptedGeneratedLanguageEvidence(
      evidence,
      'development-provisional'
    )).toBe(false);
    expect(failedLoads).toBe(1);
  });

  it('rejects readiness for missing or malformed detector behavior', async () => {
    const missing = createDevelopmentProvisionalLanguageBoundary({
      loadDetector: () => Object.freeze({})
    });
    await expect(missing.classifier.ready).rejects.toThrow();

    const malformed = createDevelopmentProvisionalLanguageBoundary({
      loadDetector: () => Object.freeze({
        detect: () => ({
          language: 'en',
          getScores: () => ({ en: Number.NaN }),
          isReliable: () => true
        })
      })
    });
    await expect(malformed.classifier.ready).rejects.toThrow();
    await expect(malformed.classifier.classify(TEXT.es, 'es')).resolves.toMatchObject({
      decision: 'reject',
      reason: 'DETECTOR_ERROR'
    });

    const alwaysSpanish = createDevelopmentProvisionalLanguageBoundary({
      loadDetector: () => detectorFor(() => 'es')
    });
    await expect(alwaysSpanish.classifier.ready).rejects.toThrow();
    await expect(alwaysSpanish.classifier.classify(TEXT.es, 'es')).resolves.toMatchObject({
      decision: 'reject',
      reason: 'DETECTOR_ERROR'
    });

    const alwaysEmpty = createDevelopmentProvisionalLanguageBoundary({
      loadDetector: () => Object.freeze({
        detect: () => canonicalEmptyDetection()
      })
    });
    await expect(alwaysEmpty.classifier.ready).rejects.toThrow();
    await expect(alwaysEmpty.classifier.classify(TEXT.es, 'es')).resolves.toMatchObject({
      detectedLanguage: 'unknown',
      decision: 'reject',
      reason: 'DETECTOR_ERROR'
    });
  });

  it('rejects hostile generated-validation input snapshots without invoking accessors', async () => {
    const validator = createDevelopmentProvisionalLanguageBoundary({
      loadDetector: () => detectorFor((text) => {
        const language = tokenLanguage(text);
        return language === 'zz' ? 'es' : language;
      })
    }).generatedLanguageValidator;
    const ordinary = {
      checks: generatedInput('es', 5).checks.map((check) => ({ ...check }))
    } as unknown as GeneratedLanguageValidationInput;
    await expect(validator.validate(ordinary, {
      signal: new AbortController().signal
    })).resolves.toBeDefined();

    const hostile: unknown[] = [];
    hostile.push(new Proxy(ordinary, {}));
    hostile.push({ checks: new Proxy([...ordinary.checks], {}) });
    const wrongPrototype = [...ordinary.checks];
    Object.setPrototypeOf(wrongPrototype, Object.prototype);
    hostile.push({ checks: wrongPrototype });
    const symbolArray = [...ordinary.checks] as unknown[] & Record<PropertyKey, unknown>;
    symbolArray[Symbol('extra')] = true;
    hostile.push({ checks: symbolArray });
    const missingIndex = [...ordinary.checks];
    delete missingIndex[2];
    hostile.push({ checks: missingIndex });
    let accessorCalls = 0;
    const accessorArray = [...ordinary.checks];
    Object.defineProperty(accessorArray, '2', {
      enumerable: true,
      configurable: true,
      get: () => {
        accessorCalls += 1;
        return ordinary.checks[2];
      }
    });
    hostile.push({ checks: accessorArray });
    const symbolCheck = { ...ordinary.checks[0] } as Record<PropertyKey, unknown>;
    symbolCheck[Symbol('extra')] = true;
    hostile.push({ checks: [symbolCheck, ...ordinary.checks.slice(1)] });
    const nonEnumerableCheck = { ...ordinary.checks[0] };
    Object.defineProperty(nonEnumerableCheck, 'extra', { value: true });
    hostile.push({ checks: [nonEnumerableCheck, ...ordinary.checks.slice(1)] });
    const accessorCheck = { ...ordinary.checks[0] } as Record<string, unknown>;
    Object.defineProperty(accessorCheck, 'text', {
      enumerable: true,
      configurable: true,
      get: () => {
        accessorCalls += 1;
        return TEXT.en;
      }
    });
    hostile.push({ checks: [accessorCheck, ...ordinary.checks.slice(1)] });

    for (const input of hostile) {
      await expect(validator.validate(
        input as GeneratedLanguageValidationInput,
        { signal: new AbortController().signal }
      )).rejects.toEqual(expect.objectContaining<Partial<GenerationError>>({
        category: 'language-validation-failure'
      }));
    }
    expect(accessorCalls).toBe(0);
  });

  it('never releases generated content when provisional validation fails closed', async () => {
    const outputCanary = 'generated-output-canary';
    const boundary = createDevelopmentProvisionalLanguageBoundary({
      loadDetector: () => detectorFor(tokenLanguage)
    });
    const service = new GenerationService({
      provider: Object.freeze({
        id: 'provisional-no-release-provider',
        version: '1.0.0',
        complete: async () => ({
          englishTranslation: `english substantive ${outputCanary}`,
          suggestions: [
            {
              englishText: 'english substantive phrase',
              selectedTargetText:
                'castellano sustantivo. francophone substantive language.'
            },
            {
              englishText: 'english substantive response',
              selectedTargetText: 'castellano sustantivo adicional'
            }
          ] as const
        })
      }),
      validator: boundary.generatedLanguageValidator,
      languageValidationMode: 'development-provisional'
    });
    const turn = createAcceptedTargetTurn({
      sessionId: '11111111-1111-4111-8111-111111111111',
      sessionEpoch: 1,
      utteranceId: '22222222-2222-4222-8222-222222222222',
      segmentId: 'segment-1',
      acceptedFinalRevision: 1,
      selectedTargetLanguage: 'es',
      decision: 'target',
      targetTranscript: 'castellano sustantivo de entrada',
      gatePolicyVersion: '1.0.0'
    });
    let failure: unknown;
    try {
      await service.complete(turn);
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(expect.objectContaining({
      category: 'invalid-generated-language'
    }));
    expect(String(failure) + JSON.stringify(failure)).not.toContain(outputCanary);
    expect(service.evidence).toEqual([
      expect.objectContaining({
        status: 'failure',
        failureCategory: 'invalid-generated-language',
        languageValidationStatus: 'rejected'
      })
    ]);
  });
});
