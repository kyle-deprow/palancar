import {
  CONTROLLED_FIXTURE_CALIBRATION_VERSION,
  CONTROLLED_FIXTURE_DETECTOR_VERSION
} from '@palancar/language-registry';
import { describe, expect, it } from 'vitest';

import * as relayRoot from '../src/index.js';
import {
  createFailClosedDeployedTextLanguageClassifier,
  isControlledFixtureTextLanguageClassifier,
  isFailClosedDeployedTextLanguageClassifier
} from '../src/language-classifier.js';
import { createTestOptions } from '../src/testing.js';

function controlledClassifier() {
  return createTestOptions().languageClassifier;
}

const calibrated = (
  detectedLanguage: string
): Readonly<Record<string, unknown>> => ({
  status: 'calibrated',
  detectorVersion: CONTROLLED_FIXTURE_DETECTOR_VERSION,
  calibrationVersion: CONTROLLED_FIXTURE_CALIBRATION_VERSION,
  detectedLanguage,
  confidence: 0.95
});

describe('controlled fixture text classifier', () => {
  it('does not expose the controlled classifier class or factory from the relay root', () => {
    expect('ControlledFixtureTextLanguageClassifier' in relayRoot).toBe(false);
    expect('createControlledFixtureTextLanguageClassifier' in relayRoot).toBe(false);
  });

  it.each([
    ['es-selected-target-final', 'es'],
    ['tr-selected-target-final', 'tr'],
    ['es-english-final', 'en'],
    ['tr-english-final', 'en'],
    ['es-supported-unselected-final', 'tr'],
    ['tr-supported-unselected-final', 'es'],
    ['es-mixed-final', 'mixed'],
    ['tr-mixed-final', 'mixed'],
    ['es-unsupported-final', 'fr'],
    ['tr-unsupported-final', 'fr'],
    ['es-selected-target-partial-1', 'es'],
    ['tr-selected-target-partial-999999', 'tr']
  ] as const)('classifies exact encoded fixture text %s independently', async (text, language) => {
    const classifier = controlledClassifier();
    await expect(classifier.classify(text)).resolves.toEqual(calibrated(language));
  });

  it('returns uncalibrated evidence for exact uncertain fixtures', async () => {
    const classifier = controlledClassifier();
    await expect(classifier.classify('es-uncertain-final')).resolves.toEqual({
      status: 'uncalibrated',
      detectorVersion: CONTROLLED_FIXTURE_DETECTOR_VERSION
    });
  });

  it.each([
    'hola',
    'es-selected-target-partial-0',
    'es-selected-target-partial-0001',
    'es-selected-target-partial-1000000',
    'ES-selected-target-final',
    'es-selected-target-final ',
    'es-target-final',
    'fr-selected-target-final',
    `es-selected-target-final${'x'.repeat(100)}`
  ])('fails closed for non-fixture text without guessing: %s', async (text) => {
    const classifier = controlledClassifier();
    await expect(classifier.classify(text)).resolves.toEqual({
      status: 'unavailable',
      detectorVersion: CONTROLLED_FIXTURE_DETECTOR_VERSION
    });
  });
});

describe('deployed language boundary classifier', () => {
  it('is branded separately from the controlled fixture and never calibrates', async () => {
    const classifier = createFailClosedDeployedTextLanguageClassifier();

    expect(isFailClosedDeployedTextLanguageClassifier(classifier)).toBe(true);
    expect(isControlledFixtureTextLanguageClassifier(classifier)).toBe(false);
    await expect(classifier.classify('private transcript')).resolves.toEqual({
      status: 'uncalibrated',
      detectorVersion: 'deployed-language-boundary-unavailable-1'
    });
  });

  it('does not expose the controlled fixture factory from the relay root', () => {
    expect('createControlledFixtureTextLanguageClassifier' in relayRoot).toBe(false);
    expect('createFailClosedDeployedTextLanguageClassifier' in relayRoot).toBe(true);
  });
});
