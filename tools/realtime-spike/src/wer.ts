import { Buffer } from 'node:buffer';

import { spikeFailure } from './errors.js';

export const MAX_WER_INPUT_BYTES = 65_536;
export const MAX_WER_TOKENS = 512;
export const MAX_WER_TOKEN_BYTES = 128;
/** Equal-distance alignments prefer fewer substitutions, then deletions, then insertions. */
export const WER_TIE_POLICY = 'distance,substitutions,deletions,insertions' as const;

export type SpikeTargetLanguage = 'es' | 'tr';

export interface WordErrorRateResult {
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
  readonly numerator: number;
  readonly denominator: number;
  readonly wordErrorRate: number;
}

interface EditCell {
  readonly distance: number;
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
}

function validateLanguage(language: unknown): asserts language is SpikeTargetLanguage {
  if (language !== 'es' && language !== 'tr') spikeFailure('invalid-wer-input');
}

function normalizeTokens(input: string, language: SpikeTargetLanguage): readonly string[] {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_WER_INPUT_BYTES) {
    spikeFailure('invalid-wer-input');
  }
  let normalized: string;
  try {
    normalized = input.normalize('NFKC').toLocaleLowerCase(language);
  } catch {
    spikeFailure('invalid-wer-input');
  }
  let tokenSource = '';
  for (const character of normalized) {
    tokenSource += /[\p{L}\p{M}\p{N}]/u.test(character) ? character : ' ';
  }
  const tokens = tokenSource.trim() === '' ? [] : tokenSource.trim().split(/\s+/u);
  if (tokens.length > MAX_WER_TOKENS) spikeFailure('invalid-wer-input');
  for (const token of tokens) {
    if (Buffer.byteLength(token, 'utf8') > MAX_WER_TOKEN_BYTES) {
      spikeFailure('invalid-wer-input');
    }
  }
  return Object.freeze(tokens);
}

function preferredCell(candidates: readonly EditCell[]): EditCell {
  const ordered = [...candidates].sort((left, right) =>
    left.distance - right.distance ||
    left.substitutions - right.substitutions ||
    left.deletions - right.deletions ||
    left.insertions - right.insertions);
  const selected = ordered[0];
  if (selected === undefined) spikeFailure('invalid-wer-input');
  return selected;
}

export function tokenizeForWordErrorRate(
  input: string,
  language: SpikeTargetLanguage
): readonly string[] {
  validateLanguage(language);
  return normalizeTokens(input, language);
}

export function computeWordErrorRate(
  reference: string,
  hypothesis: string,
  language: SpikeTargetLanguage
): Readonly<WordErrorRateResult> {
  validateLanguage(language);
  const expected = normalizeTokens(reference, language);
  const actual = normalizeTokens(hypothesis, language);
  let previous: EditCell[] = actual.map((_, index) => Object.freeze({
    distance: index + 1,
    substitutions: 0,
    deletions: 0,
    insertions: index + 1
  }));
  previous.unshift(Object.freeze({
    distance: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0
  }));

  for (let row = 1; row <= expected.length; row += 1) {
    const current: EditCell[] = [Object.freeze({
      distance: row,
      substitutions: 0,
      deletions: row,
      insertions: 0
    })];
    for (let column = 1; column <= actual.length; column += 1) {
      const diagonal = previous[column - 1];
      const above = previous[column];
      const left = current[column - 1];
      if (diagonal === undefined || above === undefined || left === undefined) {
        spikeFailure('invalid-wer-input');
      }
      if (expected[row - 1] === actual[column - 1]) {
        current.push(diagonal);
      } else {
        current.push(Object.freeze(preferredCell([
          {
            distance: diagonal.distance + 1,
            substitutions: diagonal.substitutions + 1,
            deletions: diagonal.deletions,
            insertions: diagonal.insertions
          },
          {
            distance: above.distance + 1,
            substitutions: above.substitutions,
            deletions: above.deletions + 1,
            insertions: above.insertions
          },
          {
            distance: left.distance + 1,
            substitutions: left.substitutions,
            deletions: left.deletions,
            insertions: left.insertions + 1
          }
        ])));
      }
    }
    previous = current;
  }
  const final = previous[actual.length];
  if (final === undefined) spikeFailure('invalid-wer-input');
  const denominator = expected.length;
  const wordErrorRate = denominator === 0
    ? final.distance === 0 ? 0 : 1
    : final.distance / denominator;
  return Object.freeze({
    substitutions: final.substitutions,
    deletions: final.deletions,
    insertions: final.insertions,
    numerator: final.distance,
    denominator,
    wordErrorRate
  });
}
