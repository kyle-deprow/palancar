import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  AUDIO_HEADER_BYTES
} from './constants.js';
import {
  AudioAckSchema,
  ErrorEnvelopeSchema,
  LanguageDecisionSchema,
  NegotiatedLimitsSchema,
  SessionEndSchema,
  SessionReadyNewSchema,
  SessionRejectedSchema,
  SessionStartSchema,
  SuggestionsReadySchema,
  TranscriptFinalSchema,
  TranscriptPartialSchema,
  TranslationReadySchema,
  UtteranceAbortedSchema,
  UtteranceCancelSchema,
  UtteranceCommitSchema,
  UtteranceStartSchema,
  UtcTimestampSchema,
  type AudioAck,
  type ClientControlMessage,
  type ControlMessage,
  type ErrorEnvelope,
  type LanguageDecision,
  type NegotiatedLimits,
  type ServerControlMessage,
  type SessionEnd,
  type SessionReady,
  type SessionRejected,
  type SessionStart,
  type SuggestionsReady,
  type TranscriptFinal,
  type TranscriptPartial,
  type TranslationReady,
  type UtteranceAborted,
  type UtteranceCancel,
  type UtteranceCommit,
  type UtteranceStart,
  type UtcTimestamp
} from './schemas.js';
import {
  CredentialRotationConfirmationRequestSchema,
  CredentialRotationRequestSchema,
  HttpErrorResponseSchema,
  InstallationCredentialResponseSchema,
  PairingRedemptionRequestSchema,
  RotationBeginResponseSchema,
  RotationConfirmationResponseSchema,
  SessionTicketRequestSchema,
  SessionTicketResponseSchema,
  isBase64UrlSecret,
  isCanonicalPairingCode,
  isCanonicalWssOrigin,
  type CredentialRotationConfirmationRequest,
  type CredentialRotationRequest,
  type HttpErrorResponse,
  type InstallationCredentialResponse,
  type PairingRedemptionRequest,
  type RotationBeginResponse,
  type RotationConfirmationResponse,
  type SessionTicketRequest,
  type SessionTicketResponse
} from './auth.js';

export class ContractValidationError extends TypeError {
  readonly contract: string;

  constructor(contract: string) {
    super(`Invalid ${contract}`);
    this.name = 'ContractValidationError';
    this.contract = contract;
  }
}

export function isSchema<TSchemaType extends TSchema>(
  schema: TSchemaType,
  value: unknown
): value is Static<TSchemaType> {
  return Value.Check(schema, value);
}

export function assertSchema<TSchemaType extends TSchema>(
  schema: TSchemaType,
  value: unknown,
  contract: string
): Static<TSchemaType> {
  if (!Value.Check(schema, value)) {
    throw new ContractValidationError(contract);
  }

  return value as Static<TSchemaType>;
}

export function isUtcTimestamp(value: unknown): value is UtcTimestamp {
  if (!isSchema(UtcTimestampSchema, value)) {
    return false;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(
    value
  );
  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second &&
    date.getUTCMilliseconds() === millisecond
  );
}

export function assertUtcTimestamp(value: unknown): UtcTimestamp {
  if (!isUtcTimestamp(value)) {
    throw new ContractValidationError('UTC timestamp');
  }

  return value;
}

export function isNegotiatedLimits(value: unknown): value is NegotiatedLimits {
  if (!isSchema(NegotiatedLimitsSchema, value)) {
    return false;
  }

  return (
    value.maxAudioPayloadBytes % 2 === 0 &&
    value.maxBinaryMessageBytes >= AUDIO_HEADER_BYTES + value.maxAudioPayloadBytes &&
    value.noNewTurnAfterMs <= value.maxSessionDurationMs &&
    value.maxRetainedReplaySamples <= value.maxUnacknowledgedSamples
  );
}

export function assertNegotiatedLimits(value: unknown): NegotiatedLimits {
  if (!isNegotiatedLimits(value)) {
    throw new ContractValidationError('negotiated limits');
  }

  return value;
}

export function isSessionStart(value: unknown): value is SessionStart {
  return isSchema(SessionStartSchema, value) && isNegotiatedLimits(value.requestedLimits);
}

export function assertSessionStart(value: unknown): SessionStart {
  if (!isSessionStart(value)) {
    throw new ContractValidationError('session.start');
  }

  return value;
}

export function isUtteranceStart(value: unknown): value is UtteranceStart {
  return isSchema(UtteranceStartSchema, value);
}

export function assertUtteranceStart(value: unknown): UtteranceStart {
  return assertSchema(UtteranceStartSchema, value, 'utterance.start');
}

export function isUtteranceCommit(value: unknown): value is UtteranceCommit {
  return isSchema(UtteranceCommitSchema, value);
}

export function assertUtteranceCommit(value: unknown): UtteranceCommit {
  return assertSchema(UtteranceCommitSchema, value, 'utterance.commit');
}

export function isUtteranceCancel(value: unknown): value is UtteranceCancel {
  return isSchema(UtteranceCancelSchema, value);
}

export function assertUtteranceCancel(value: unknown): UtteranceCancel {
  return assertSchema(UtteranceCancelSchema, value, 'utterance.cancel');
}

export function isSessionEnd(value: unknown): value is SessionEnd {
  return isSchema(SessionEndSchema, value);
}

export function assertSessionEnd(value: unknown): SessionEnd {
  return assertSchema(SessionEndSchema, value, 'session.end');
}

function controlType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const type = (value as { readonly type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

export function isClientControlMessage(value: unknown): value is ClientControlMessage {
  switch (controlType(value)) {
    case 'session.start':
      return isSessionStart(value);
    case 'utterance.start':
      return isUtteranceStart(value);
    case 'utterance.commit':
      return isUtteranceCommit(value);
    case 'utterance.cancel':
      return isUtteranceCancel(value);
    case 'session.end':
      return isSessionEnd(value);
    default:
      return false;
  }
}

export function assertClientControlMessage(value: unknown): ClientControlMessage {
  if (!isClientControlMessage(value)) {
    throw new ContractValidationError('client control message');
  }

  return value;
}

export function isSessionReady(value: unknown): value is SessionReady {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const result = (value as { readonly result?: unknown }).result;
  if (result === 'new' && isSchema(SessionReadyNewSchema, value)) {
    return isNegotiatedLimits(value.effectiveLimits) && isUtcTimestamp(value.serverTime);
  }
  return false;
}

export function assertSessionReady(value: unknown): SessionReady {
  if (!isSessionReady(value)) {
    throw new ContractValidationError('session.ready');
  }

  return value;
}

export function isSessionRejected(value: unknown): value is SessionRejected {
  return isSchema(SessionRejectedSchema, value);
}

export function assertSessionRejected(value: unknown): SessionRejected {
  return assertSchema(SessionRejectedSchema, value, 'session.rejected');
}

export function isUtteranceAborted(value: unknown): value is UtteranceAborted {
  return isSchema(UtteranceAbortedSchema, value);
}

export function assertUtteranceAborted(value: unknown): UtteranceAborted {
  return assertSchema(UtteranceAbortedSchema, value, 'utterance.aborted');
}

export function isAudioAck(value: unknown): value is AudioAck {
  if (!isSchema(AudioAckSchema, value)) {
    return false;
  }

  return (
    value.requestedReplayOffset === undefined ||
    value.requestedReplayOffset <= value.highestContiguousExclusiveOffset
  );
}

export function assertAudioAck(value: unknown): AudioAck {
  if (!isAudioAck(value)) {
    throw new ContractValidationError('audio.ack');
  }

  return value;
}

export function isTranscriptPartial(value: unknown): value is TranscriptPartial {
  return isSchema(TranscriptPartialSchema, value) && isUtcTimestamp(value.providerEventTime);
}

export function assertTranscriptPartial(value: unknown): TranscriptPartial {
  if (!isTranscriptPartial(value)) {
    throw new ContractValidationError('transcript.partial');
  }

  return value;
}

export function isTranscriptFinal(value: unknown): value is TranscriptFinal {
  return isSchema(TranscriptFinalSchema, value) && isUtcTimestamp(value.providerEventTime);
}

export function assertTranscriptFinal(value: unknown): TranscriptFinal {
  if (!isTranscriptFinal(value)) {
    throw new ContractValidationError('transcript.final');
  }

  return value;
}

export function isLanguageDecision(value: unknown): value is LanguageDecision {
  return isSchema(LanguageDecisionSchema, value);
}

export function assertLanguageDecision(value: unknown): LanguageDecision {
  return assertSchema(LanguageDecisionSchema, value, 'language.decision');
}

export function isTranslationReady(value: unknown): value is TranslationReady {
  return isSchema(TranslationReadySchema, value);
}

export function assertTranslationReady(value: unknown): TranslationReady {
  return assertSchema(TranslationReadySchema, value, 'translation.ready');
}

export function isSuggestionsReady(value: unknown): value is SuggestionsReady {
  return isSchema(SuggestionsReadySchema, value);
}

export function assertSuggestionsReady(value: unknown): SuggestionsReady {
  return assertSchema(SuggestionsReadySchema, value, 'suggestions.ready');
}

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return isSchema(ErrorEnvelopeSchema, value) && isUtcTimestamp(value.time);
}

export function assertErrorEnvelope(value: unknown): ErrorEnvelope {
  if (!isErrorEnvelope(value)) {
    throw new ContractValidationError('error envelope');
  }

  return value;
}

export function isServerControlMessage(value: unknown): value is ServerControlMessage {
  switch (controlType(value)) {
    case 'session.ready':
      return isSessionReady(value);
    case 'session.rejected':
      return isSessionRejected(value);
    case 'utterance.aborted':
      return isUtteranceAborted(value);
    case 'audio.ack':
      return isAudioAck(value);
    case 'transcript.partial':
      return isTranscriptPartial(value);
    case 'transcript.final':
      return isTranscriptFinal(value);
    case 'language.decision':
      return isLanguageDecision(value);
    case 'translation.ready':
      return isTranslationReady(value);
    case 'suggestions.ready':
      return isSuggestionsReady(value);
    case 'error':
      return isErrorEnvelope(value);
    default:
      return false;
  }
}

export function assertServerControlMessage(value: unknown): ServerControlMessage {
  if (!isServerControlMessage(value)) {
    throw new ContractValidationError('server control message');
  }

  return value;
}

export function isControlMessage(value: unknown): value is ControlMessage {
  return isClientControlMessage(value) || isServerControlMessage(value);
}

export function assertControlMessage(value: unknown): ControlMessage {
  if (!isControlMessage(value)) {
    throw new ContractValidationError('control message');
  }

  return value;
}

export function isPairingRedemptionRequest(value: unknown): value is PairingRedemptionRequest {
  return isSchema(PairingRedemptionRequestSchema, value) && isCanonicalPairingCode(value.pairingCode);
}

export function assertPairingRedemptionRequest(value: unknown): PairingRedemptionRequest {
  if (!isPairingRedemptionRequest(value)) {
    throw new ContractValidationError('pairing redemption request');
  }

  return value;
}

export function isInstallationCredentialResponse(
  value: unknown
): value is InstallationCredentialResponse {
  return (
    isSchema(InstallationCredentialResponseSchema, value) &&
    isBase64UrlSecret(value.credential) &&
    isUtcTimestamp(value.idleExpiresAt) &&
    isUtcTimestamp(value.absoluteExpiresAt) &&
    Date.parse(value.idleExpiresAt) <= Date.parse(value.absoluteExpiresAt)
  );
}

export function assertInstallationCredentialResponse(
  value: unknown
): InstallationCredentialResponse {
  if (!isInstallationCredentialResponse(value)) {
    throw new ContractValidationError('installation credential response');
  }

  return value;
}

export const isPairingRedemptionResponse = isInstallationCredentialResponse;
export const assertPairingRedemptionResponse = assertInstallationCredentialResponse;

export function isCredentialRotationRequest(
  value: unknown
): value is CredentialRotationRequest {
  return isSchema(CredentialRotationRequestSchema, value);
}

export function assertCredentialRotationRequest(value: unknown): CredentialRotationRequest {
  return assertSchema(
    CredentialRotationRequestSchema,
    value,
    'credential rotation request'
  );
}

export function isCredentialRotationConfirmationRequest(
  value: unknown
): value is CredentialRotationConfirmationRequest {
  return isSchema(CredentialRotationConfirmationRequestSchema, value);
}

export function assertCredentialRotationConfirmationRequest(
  value: unknown
): CredentialRotationConfirmationRequest {
  return assertSchema(
    CredentialRotationConfirmationRequestSchema,
    value,
    'credential rotation confirmation request'
  );
}

export function isSessionTicketRequest(value: unknown): value is SessionTicketRequest {
  return isSchema(SessionTicketRequestSchema, value);
}

export function assertSessionTicketRequest(value: unknown): SessionTicketRequest {
  return assertSchema(SessionTicketRequestSchema, value, 'session-ticket request');
}

export function isSessionTicketResponse(value: unknown): value is SessionTicketResponse {
  return (
    isSchema(SessionTicketResponseSchema, value) &&
    isBase64UrlSecret(value.ticket) &&
    isCanonicalWssOrigin(value.wssOrigin) &&
    isUtcTimestamp(value.expiresAt)
  );
}

export function assertSessionTicketResponse(value: unknown): SessionTicketResponse {
  if (!isSessionTicketResponse(value)) {
    throw new ContractValidationError('session-ticket response');
  }

  return value;
}

export function isRotationBeginResponse(value: unknown): value is RotationBeginResponse {
  return (
    isSchema(RotationBeginResponseSchema, value) &&
    isBase64UrlSecret(value.pendingCredential) &&
    isUtcTimestamp(value.pendingCredentialExpiresAt)
  );
}

export function assertRotationBeginResponse(value: unknown): RotationBeginResponse {
  if (!isRotationBeginResponse(value)) {
    throw new ContractValidationError('rotation begin response');
  }

  return value;
}

export function isRotationConfirmationResponse(
  value: unknown
): value is RotationConfirmationResponse {
  return (
    isSchema(RotationConfirmationResponseSchema, value) &&
    isUtcTimestamp(value.confirmedAt) &&
    isUtcTimestamp(value.expiresAt) &&
    Date.parse(value.confirmedAt) <= Date.parse(value.expiresAt)
  );
}

export function assertRotationConfirmationResponse(
  value: unknown
): RotationConfirmationResponse {
  if (!isRotationConfirmationResponse(value)) {
    throw new ContractValidationError('rotation confirmation response');
  }

  return value;
}

export function isHttpErrorResponse(value: unknown): value is HttpErrorResponse {
  return isSchema(HttpErrorResponseSchema, value);
}

export function assertHttpErrorResponse(value: unknown): HttpErrorResponse {
  return assertSchema(HttpErrorResponseSchema, value, 'HTTP error response');
}
