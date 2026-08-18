import {
  CONTROLLED_FIXTURE_CALIBRATION_VERSION,
  CONTROLLED_FIXTURE_DETECTOR_VERSION,
  type ClassifiedLanguageEvidence,
  type TargetLanguage,
  type TextLanguageClassifier
} from '@palancar/language-registry';

type ControlledFixtureCategory =
  | 'selected-target'
  | 'english'
  | 'supported-unselected'
  | 'mixed'
  | 'unsupported'
  | 'uncertain';

const CONTROLLED_FIXTURE_TEXT =
  /^(es|tr)-(selected-target|english|supported-unselected|mixed|unsupported|uncertain)-(?:final|partial-(?:[1-9]|[1-9][0-9]{1,5}))$/;
const MAX_CONTROLLED_FIXTURE_TEXT_LENGTH = 96;
const controlledFixtureClassifiers = new WeakSet<object>();

function oppositeTarget(language: TargetLanguage): TargetLanguage {
  return language === 'es' ? 'tr' : 'es';
}

function unavailable(): ClassifiedLanguageEvidence {
  return Object.freeze({
    status: 'unavailable',
    detectorVersion: CONTROLLED_FIXTURE_DETECTOR_VERSION
  });
}

function calibrated(detectedLanguage: string): ClassifiedLanguageEvidence {
  return Object.freeze({
    status: 'calibrated',
    detectorVersion: CONTROLLED_FIXTURE_DETECTOR_VERSION,
    calibrationVersion: CONTROLLED_FIXTURE_CALIBRATION_VERSION,
    detectedLanguage,
    confidence: 0.95
  });
}

function classifyControlledFixture(
  encodedLanguage: TargetLanguage,
  category: ControlledFixtureCategory
): ClassifiedLanguageEvidence {
  switch (category) {
    case 'selected-target':
      return calibrated(encodedLanguage);
    case 'english':
      return calibrated('en');
    case 'supported-unselected':
      return calibrated(oppositeTarget(encodedLanguage));
    case 'mixed':
      return calibrated('mixed');
    case 'unsupported':
      return calibrated('fr');
    case 'uncertain':
      return Object.freeze({
        status: 'uncalibrated',
        detectorVersion: CONTROLLED_FIXTURE_DETECTOR_VERSION
      });
  }
}

/**
 * Exact classifier for deterministic mock-transcription strings only.
 * It is intentionally not a runtime language detector.
 */
class ControlledFixtureTextLanguageClassifier
  implements TextLanguageClassifier {
  readonly ready = Promise.resolve();

  async classify(text: string): Promise<ClassifiedLanguageEvidence> {
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > MAX_CONTROLLED_FIXTURE_TEXT_LENGTH
    ) {
      return unavailable();
    }
    const match = CONTROLLED_FIXTURE_TEXT.exec(text);
    if (match === null) {
      return unavailable();
    }
    return classifyControlledFixture(
      match[1] as TargetLanguage,
      match[2] as ControlledFixtureCategory
    );
  }
}

export function createControlledFixtureTextLanguageClassifier(): TextLanguageClassifier {
  const classifier = new ControlledFixtureTextLanguageClassifier();
  controlledFixtureClassifiers.add(classifier);
  return classifier;
}

export function isControlledFixtureTextLanguageClassifier(
  classifier: TextLanguageClassifier
): boolean {
  return controlledFixtureClassifiers.has(classifier);
}
