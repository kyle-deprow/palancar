export type LanguageClassificationStatus =
  | 'calibrated'
  | 'insufficient-text'
  | 'uncalibrated'
  | 'conflicting'
  | 'unavailable';

interface ClassifiedLanguageEvidenceBase {
  readonly detectorVersion: string;
}

export interface CalibratedLanguageEvidence
  extends ClassifiedLanguageEvidenceBase {
  readonly status: 'calibrated';
  readonly detectedLanguage: string;
  readonly confidence: number;
  readonly calibrationVersion: string;
}

export interface NonCalibratedLanguageEvidence
  extends ClassifiedLanguageEvidenceBase {
  readonly status: Exclude<LanguageClassificationStatus, 'calibrated'>;
  readonly detectedLanguage?: string;
  readonly confidence?: never;
  readonly calibrationVersion?: never;
}

/**
 * Authoritative text-classifier evidence accepted by the language gate.
 * Confidence is available only on calibrated evidence.
 */
export type ClassifiedLanguageEvidence =
  | CalibratedLanguageEvidence
  | NonCalibratedLanguageEvidence;

/** A detector-native score. It is not a calibrated probability or confidence. */
export interface RawLanguageDetectorScore {
  readonly language: string;
  readonly score: number;
}

/** Raw detector output must pass through a separately versioned calibration. */
export interface RawLanguageDetectorOutput {
  readonly detectorVersion: string;
  readonly scores: readonly RawLanguageDetectorScore[];
}

export interface TextLanguageClassifier {
  readonly ready: Promise<void>;
  readonly classify: (text: string) => Promise<ClassifiedLanguageEvidence>;
}

const CLASSIFICATION_STATUSES = new Set<LanguageClassificationStatus>([
  'calibrated',
  'insufficient-text',
  'uncalibrated',
  'conflicting',
  'unavailable'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported field: ${key}`);
    }
  }
}

function requireExactNonemptyString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${label} must be an exact nonempty string`);
  }
  return value;
}

function requireLanguageCode(value: unknown, label: string): string {
  const code = requireExactNonemptyString(value, label);
  if (code.toLowerCase() !== code) {
    throw new TypeError(`${label} must be lowercase`);
  }
  return code;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

export function validateClassifiedLanguageEvidence(
  value: unknown
): asserts value is ClassifiedLanguageEvidence {
  if (!isRecord(value)) {
    throw new TypeError('Classified language evidence must be an object');
  }

  if (
    typeof value.status !== 'string' ||
    !CLASSIFICATION_STATUSES.has(value.status as LanguageClassificationStatus)
  ) {
    throw new TypeError('Classified language evidence has an invalid status');
  }

  requireExactNonemptyString(value.detectorVersion, 'detectorVersion');
  if (value.status === 'calibrated') {
    requireExactKeys(
      value,
      [
        'status',
        'detectorVersion',
        'detectedLanguage',
        'confidence',
        'calibrationVersion'
      ],
      'Calibrated language evidence'
    );
    requireLanguageCode(value.detectedLanguage, 'detectedLanguage');
    requireExactNonemptyString(value.calibrationVersion, 'calibrationVersion');
    const confidence = requireFiniteNumber(value.confidence, 'confidence');
    if (confidence < 0 || confidence > 1) {
      throw new RangeError('confidence must be between 0 and 1');
    }
    return;
  }

  requireExactKeys(
    value,
    ['status', 'detectorVersion', 'detectedLanguage'],
    'Non-calibrated language evidence'
  );
  if (value.detectedLanguage !== undefined) {
    requireLanguageCode(value.detectedLanguage, 'detectedLanguage');
  }
}

export function validateRawLanguageDetectorOutput(
  value: unknown
): asserts value is RawLanguageDetectorOutput {
  if (!isRecord(value)) {
    throw new TypeError('Raw language detector output must be an object');
  }
  requireExactKeys(value, ['detectorVersion', 'scores'], 'Raw detector output');
  requireExactNonemptyString(value.detectorVersion, 'detectorVersion');
  if (!Array.isArray(value.scores)) {
    throw new TypeError('Raw detector scores must be an array');
  }

  const languages = new Set<string>();
  for (const rawScore of value.scores) {
    if (!isRecord(rawScore)) {
      throw new TypeError('Raw detector score must be an object');
    }
    requireExactKeys(rawScore, ['language', 'score'], 'Raw detector score');
    const language = requireLanguageCode(rawScore.language, 'raw score language');
    requireFiniteNumber(rawScore.score, 'raw detector score');
    if (languages.has(language)) {
      throw new Error(`Duplicate raw detector language: ${language}`);
    }
    languages.add(language);
  }
}
