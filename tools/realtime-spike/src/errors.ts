export type RealtimeSpikeErrorReason =
  | 'invalid-input'
  | 'invalid-wer-input'
  | 'invalid-evidence'
  | 'evidence-limit'
  | 'evidence-write'
  | 'insufficient-trials'
  | 'cli';

const MESSAGES: Readonly<Record<RealtimeSpikeErrorReason, string>> = Object.freeze({
  'invalid-input': 'Invalid realtime spike input.',
  'invalid-wer-input': 'Invalid word-error-rate input.',
  'invalid-evidence': 'Invalid realtime spike evidence.',
  'evidence-limit': 'Realtime spike evidence limit exceeded.',
  'evidence-write': 'Realtime spike evidence write failed.',
  'insufficient-trials': 'Insufficient realtime spike trials.',
  cli: 'Realtime spike command failed.'
});

export class RealtimeSpikeError extends Error {
  readonly reason: RealtimeSpikeErrorReason;

  constructor(reason: RealtimeSpikeErrorReason) {
    super(MESSAGES[reason]);
    this.name = 'RealtimeSpikeError';
    this.reason = reason;
    Object.freeze(this);
  }
}

export function spikeFailure(reason: RealtimeSpikeErrorReason): never {
  throw new RealtimeSpikeError(reason);
}
