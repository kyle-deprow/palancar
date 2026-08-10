export type TranscriptionSessionErrorReason =
  | 'closed'
  | 'active-utterance'
  | 'no-active-utterance'
  | 'stale-utterance'
  | 'wrong-utterance'
  | 'invalid-identifier'
  | 'invalid-audio'
  | 'gap'
  | 'overlap'
  | 'utterance-overflow'
  | 'stale-revision';

export class TranscriptionSessionError extends Error {
  readonly reason: TranscriptionSessionErrorReason;

  constructor(reason: TranscriptionSessionErrorReason, message: string) {
    super(message);
    this.name = 'TranscriptionSessionError';
    this.reason = reason;
  }
}

export type EvidenceValidationErrorReason =
  | 'record'
  | 'unknown-field'
  | 'forbidden-key'
  | 'binary-value'
  | 'invalid-value'
  | 'cyclic-value';

export class EvidenceValidationError extends TypeError {
  readonly reason: EvidenceValidationErrorReason;

  constructor(reason: EvidenceValidationErrorReason, message: string) {
    super(message);
    this.name = 'EvidenceValidationError';
    this.reason = reason;
  }
}
