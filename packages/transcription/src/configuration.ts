import {
  isIso6391LanguageCode,
  snapshotOwnDataProperties
} from './types.js';
import type { TranscriptionSessionConfiguration } from './types.js';

const MAX_PROVIDER_NEUTRAL_MANUAL_COMMIT_CADENCE_MS = 60_000;

/**
 * Validate only the provider-neutral session contract. Adapter capability
 * admission belongs to each adapter and must not be imported here.
 */
export function validateTranscriptionSessionConfiguration(
  input: unknown
): Readonly<TranscriptionSessionConfiguration> {
  const snapshot = snapshotOwnDataProperties(input);
  if (snapshot === undefined) {
    throw new TypeError('Invalid transcription session configuration');
  }
  const languageMode = snapshot.languageMode;
  if (languageMode !== 'automatic' && languageMode !== 'selected-target') {
    throw new RangeError('Unsupported transcription language mode');
  }
  const expectedKeys = languageMode === 'automatic'
    ? ['serverVadMode', 'languageMode', 'manualCommitCadenceMs']
    : ['serverVadMode', 'languageMode', 'manualCommitCadenceMs', 'languageHint'];
  const keys = Object.keys(snapshot);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
    throw new TypeError('Invalid transcription session configuration');
  }
  const serverVadMode = snapshot.serverVadMode;
  if (serverVadMode !== 'enabled' && serverVadMode !== 'disabled') {
    throw new RangeError('Unsupported server VAD mode');
  }
  const manualCommitCadenceMs = snapshot.manualCommitCadenceMs;
  if (
    typeof manualCommitCadenceMs !== 'number' ||
    !Number.isSafeInteger(manualCommitCadenceMs) ||
    manualCommitCadenceMs < 1 ||
    manualCommitCadenceMs > MAX_PROVIDER_NEUTRAL_MANUAL_COMMIT_CADENCE_MS
  ) {
    throw new RangeError('Unsupported manual commit cadence');
  }
  const languageHint = snapshot.languageHint;
  if (
    languageMode === 'selected-target' &&
    !isIso6391LanguageCode(languageHint)
  ) {
    throw new TypeError('Invalid transcription language hint');
  }
  if (languageMode === 'selected-target') {
    const normalizedLanguageHint = languageHint as string;
    return Object.freeze({
      serverVadMode,
      languageMode,
      manualCommitCadenceMs,
      languageHint: normalizedLanguageHint
    });
  }
  return Object.freeze({ serverVadMode, languageMode, manualCommitCadenceMs });
}
