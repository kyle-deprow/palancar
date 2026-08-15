import { Type, type Static, type TSchema } from '@sinclair/typebox';

import {
  ACK_INTERVAL_MS,
  AUDIO_RATE_BUCKET_CAPACITY_SAMPLES,
  AUDIO_RATE_REFILL_SAMPLES_PER_SECOND,
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  INACTIVITY_TIMEOUT_MS,
  MAX_AUDIO_PAYLOAD_BYTES,
  MAX_BINARY_MESSAGE_BYTES,
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_UNACKNOWLEDGED_SAMPLES,
  MAX_UTTERANCE_MS,
  MAX_UTTERANCE_SAMPLES,
  NO_NEW_TURN_AFTER_MS,
  PROTOCOL_VERSION,
  SESSION_DURATION_MS
} from './constants.js';

const CLOSED_OBJECT = { additionalProperties: false } as const;

export const UUID_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const UTC_TIMESTAMP_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$';
export const VERSION_PATTERN =
  '^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$';
export const BUILD_PATTERN =
  '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$';
export const LANGUAGE_CODE_PATTERN =
  '^(?:[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*|mixed)$';

export const UuidSchema = Type.String({
  pattern: UUID_PATTERN,
  minLength: 36,
  maxLength: 36
});
export type Uuid = Static<typeof UuidSchema>;

export const UtcTimestampSchema = Type.String({
  pattern: UTC_TIMESTAMP_PATTERN,
  minLength: 20,
  maxLength: 24
});
export type UtcTimestamp = Static<typeof UtcTimestampSchema>;

export const Unsigned32Schema = Type.Integer({ minimum: 0, maximum: 4_294_967_295 });
export type Unsigned32 = Static<typeof Unsigned32Schema>;

export const OriginalSampleOffsetSchema = Type.Integer({
  minimum: 0,
  maximum: MAX_UTTERANCE_SAMPLES
});
export type OriginalSampleOffset = Static<typeof OriginalSampleOffsetSchema>;

export const PositiveRevisionSchema = Type.Integer({ minimum: 1, maximum: 4_294_967_295 });
export type PositiveRevision = Static<typeof PositiveRevisionSchema>;

export const PositiveEpochSchema = Type.Integer({ minimum: 1, maximum: 4_294_967_295 });
export type PositiveEpoch = Static<typeof PositiveEpochSchema>;

export const ProtocolVersionSchema = Type.Literal(PROTOCOL_VERSION);
export type ProtocolVersion = Static<typeof ProtocolVersionSchema>;

export const WearerLanguageSchema = Type.Literal('en');
export type WearerLanguage = Static<typeof WearerLanguageSchema>;

export const TargetLanguageSchema = Type.Union([Type.Literal('es'), Type.Literal('tr')]);
export type TargetLanguage = Static<typeof TargetLanguageSchema>;

export const DetectedLanguageCodeSchema = Type.String({
  pattern: LANGUAGE_CODE_PATTERN,
  minLength: 2,
  maxLength: 35
});
export type DetectedLanguageCode = Static<typeof DetectedLanguageCodeSchema>;

export const ConfidenceSchema = Type.Number({ minimum: 0, maximum: 1 });
export type Confidence = Static<typeof ConfidenceSchema>;

export const VersionSchema = Type.String({
  pattern: VERSION_PATTERN,
  minLength: 5,
  maxLength: 32
});
export type Version = Static<typeof VersionSchema>;

export const BuildSchema = Type.String({
  pattern: BUILD_PATTERN,
  minLength: 1,
  maxLength: 64
});
export type Build = Static<typeof BuildSchema>;

export const SessionIdSchema = UuidSchema;
export type SessionId = Static<typeof SessionIdSchema>;

export const UtteranceIdSchema = UuidSchema;
export type UtteranceId = Static<typeof UtteranceIdSchema>;

export const SegmentIdSchema = Type.String({
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$',
  minLength: 1,
  maxLength: 64
});
export type SegmentId = Static<typeof SegmentIdSchema>;

export const BoundedDisplayMessageSchema = Type.String({
  minLength: 1,
  maxLength: 256
});
export type BoundedDisplayMessage = Static<typeof BoundedDisplayMessageSchema>;

export const BoundedTranscriptTextSchema = Type.String({
  minLength: 1,
  maxLength: 4_096
});
export type BoundedTranscriptText = Static<typeof BoundedTranscriptTextSchema>;

export const BoundedEnglishTextSchema = Type.String({
  minLength: 1,
  maxLength: 1_024
});
export type BoundedEnglishText = Static<typeof BoundedEnglishTextSchema>;

export const BoundedTargetTextSchema = Type.String({
  minLength: 1,
  maxLength: 1_024
});
export type BoundedTargetText = Static<typeof BoundedTargetTextSchema>;

export const NegotiatedLimitsSchema = Type.Object(
  {
    maxAudioPayloadBytes: Type.Integer({ minimum: 2, maximum: MAX_AUDIO_PAYLOAD_BYTES }),
    maxBinaryMessageBytes: Type.Integer({ minimum: 32, maximum: MAX_BINARY_MESSAGE_BYTES }),
    maxControlMessageBytes: Type.Integer({ minimum: 1, maximum: MAX_CONTROL_MESSAGE_BYTES }),
    maxUnacknowledgedSamples: Type.Integer({ minimum: 1, maximum: MAX_UNACKNOWLEDGED_SAMPLES }),
    maxRetainedReplaySamples: Type.Integer({ minimum: 1, maximum: MAX_UNACKNOWLEDGED_SAMPLES }),
    ackIntervalMs: Type.Integer({ minimum: 1, maximum: ACK_INTERVAL_MS }),
    maxUtteranceSamples: Type.Integer({ minimum: 2, maximum: MAX_UTTERANCE_SAMPLES }),
    maxUtteranceMs: Type.Integer({ minimum: 1, maximum: MAX_UTTERANCE_MS }),
    maxSessionDurationMs: Type.Integer({ minimum: 1, maximum: SESSION_DURATION_MS }),
    noNewTurnAfterMs: Type.Integer({ minimum: 1, maximum: NO_NEW_TURN_AFTER_MS }),
    inactivityTimeoutMs: Type.Integer({ minimum: 1, maximum: INACTIVITY_TIMEOUT_MS }),
    heartbeatIntervalMs: Type.Integer({ minimum: 1, maximum: HEARTBEAT_INTERVAL_MS }),
    heartbeatGraceMs: Type.Integer({ minimum: 1, maximum: HEARTBEAT_GRACE_MS }),
    audioRateRefillSamplesPerSecond: Type.Integer({
      minimum: 1,
      maximum: AUDIO_RATE_REFILL_SAMPLES_PER_SECOND
    }),
    audioRateBucketCapacitySamples: Type.Integer({
      minimum: 1,
      maximum: AUDIO_RATE_BUCKET_CAPACITY_SAMPLES
    })
  },
  CLOSED_OBJECT
);
export type NegotiatedLimits = Static<typeof NegotiatedLimitsSchema>;

export const DEFAULT_NEGOTIATED_LIMITS: Readonly<NegotiatedLimits> = Object.freeze({
  maxAudioPayloadBytes: MAX_AUDIO_PAYLOAD_BYTES,
  maxBinaryMessageBytes: MAX_BINARY_MESSAGE_BYTES,
  maxControlMessageBytes: MAX_CONTROL_MESSAGE_BYTES,
  maxUnacknowledgedSamples: MAX_UNACKNOWLEDGED_SAMPLES,
  maxRetainedReplaySamples: MAX_UNACKNOWLEDGED_SAMPLES,
  ackIntervalMs: ACK_INTERVAL_MS,
  maxUtteranceSamples: MAX_UTTERANCE_SAMPLES,
  maxUtteranceMs: MAX_UTTERANCE_MS,
  maxSessionDurationMs: SESSION_DURATION_MS,
  noNewTurnAfterMs: NO_NEW_TURN_AFTER_MS,
  inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  heartbeatGraceMs: HEARTBEAT_GRACE_MS,
  audioRateRefillSamplesPerSecond: AUDIO_RATE_REFILL_SAMPLES_PER_SECOND,
  audioRateBucketCapacitySamples: AUDIO_RATE_BUCKET_CAPACITY_SAMPLES
});

export const CommonNegotiationSchema = Type.Object(
  {
    protocolVersion: ProtocolVersionSchema,
    wearerLanguage: WearerLanguageSchema,
    targetLanguage: TargetLanguageSchema,
    languageRegistryVersion: VersionSchema,
    gatePolicyVersion: VersionSchema,
    clientBuild: BuildSchema,
    requestedLimits: NegotiatedLimitsSchema
  },
  CLOSED_OBJECT
);
export type CommonNegotiation = Static<typeof CommonNegotiationSchema>;

export const SessionStartSchema = Type.Object(
  { type: Type.Literal('session.start'), ...CommonNegotiationSchema.properties },
  CLOSED_OBJECT
);
export type SessionStart = Static<typeof SessionStartSchema>;

export const UtteranceStartSchema = Type.Object(
  {
    type: Type.Literal('utterance.start'),
    sessionId: SessionIdSchema,
    sessionEpoch: PositiveEpochSchema,
    utteranceId: UtteranceIdSchema
  },
  CLOSED_OBJECT
);
export type UtteranceStart = Static<typeof UtteranceStartSchema>;

const UtteranceBoundaryProperties = {
  sessionId: SessionIdSchema,
  sessionEpoch: PositiveEpochSchema,
  utteranceId: UtteranceIdSchema,
  finalOriginalSampleOffset: OriginalSampleOffsetSchema
};

export const UtteranceCommitSchema = Type.Object(
  { type: Type.Literal('utterance.commit'), ...UtteranceBoundaryProperties },
  CLOSED_OBJECT
);
export type UtteranceCommit = Static<typeof UtteranceCommitSchema>;

export const UtteranceCancelSchema = Type.Object(
  { type: Type.Literal('utterance.cancel'), ...UtteranceBoundaryProperties },
  CLOSED_OBJECT
);
export type UtteranceCancel = Static<typeof UtteranceCancelSchema>;

export const SessionEndReasonSchema = Type.Union([
  Type.Literal('user_requested'),
  Type.Literal('inactivity'),
  Type.Literal('duration'),
  Type.Literal('transport_error'),
  Type.Literal('protocol_error'),
  Type.Literal('app_shutdown')
]);
export type SessionEndReason = Static<typeof SessionEndReasonSchema>;

export const SessionEndSchema = Type.Object(
  {
    type: Type.Literal('session.end'),
    sessionId: SessionIdSchema,
    sessionEpoch: PositiveEpochSchema,
    reason: SessionEndReasonSchema
  },
  CLOSED_OBJECT
);
export type SessionEnd = Static<typeof SessionEndSchema>;

export const ClientControlMessageSchema = Type.Union([
  SessionStartSchema,
  UtteranceStartSchema,
  UtteranceCommitSchema,
  UtteranceCancelSchema,
  SessionEndSchema
]);
export type ClientControlMessage = Static<typeof ClientControlMessageSchema>;
export const ClientControlMessagesSchema = ClientControlMessageSchema;
export type ClientControlMessages = ClientControlMessage;

const SessionReadyProperties = {
  sessionId: SessionIdSchema,
  sessionEpoch: PositiveEpochSchema,
  targetLanguage: TargetLanguageSchema,
  languageRegistryVersion: VersionSchema,
  gatePolicyVersion: VersionSchema,
  effectiveLimits: NegotiatedLimitsSchema,
  serverTime: UtcTimestampSchema
};

export const SessionReadyNewSchema = Type.Object(
  { type: Type.Literal('session.ready'), result: Type.Literal('new'), ...SessionReadyProperties },
  CLOSED_OBJECT
);
export type SessionReadyNew = Static<typeof SessionReadyNewSchema>;
export const SessionReadySchema = SessionReadyNewSchema;
export type SessionReady = Static<typeof SessionReadySchema>;

export const SessionRejectionCodeSchema = Type.Union([
  Type.Literal('unsupported_protocol_version'),
  Type.Literal('unsupported_target_language'),
  Type.Literal('invalid_session'),
  Type.Literal('session_conflict'),
  Type.Literal('authentication_failed'),
  Type.Literal('ticket_expired'),
  Type.Literal('rate_limited'),
  Type.Literal('state_unavailable'),
  Type.Literal('malformed_message'),
  Type.Literal('origin_rejected')
]);
export type SessionRejectionCode = Static<typeof SessionRejectionCodeSchema>;

export const SessionRejectedSchema = Type.Object(
  {
    type: Type.Literal('session.rejected'),
    code: SessionRejectionCodeSchema,
    displaySafeMessage: BoundedDisplayMessageSchema
  },
  CLOSED_OBJECT
);
export type SessionRejected = Static<typeof SessionRejectedSchema>;

export const UtteranceAbortCategorySchema = Type.Union([
  Type.Literal('flow'),
  Type.Literal('duration'),
  Type.Literal('rate'),
  Type.Literal('cancellation'),
  Type.Literal('stale_conflict'),
  Type.Literal('provider_loss')
]);
export type UtteranceAbortCategory = Static<typeof UtteranceAbortCategorySchema>;

export const UtteranceAbortedSchema = Type.Object(
  {
    type: Type.Literal('utterance.aborted'),
    sessionId: SessionIdSchema,
    sessionEpoch: PositiveEpochSchema,
    utteranceId: UtteranceIdSchema,
    category: UtteranceAbortCategorySchema
  },
  CLOSED_OBJECT
);
export type UtteranceAborted = Static<typeof UtteranceAbortedSchema>;

export const FlowStateSchema = Type.Union([
  Type.Literal('normal'),
  Type.Literal('pause'),
  Type.Literal('abort')
]);
export type FlowState = Static<typeof FlowStateSchema>;

export const AudioAckSchema = Type.Object(
  {
    type: Type.Literal('audio.ack'),
    sessionId: SessionIdSchema,
    sessionEpoch: PositiveEpochSchema,
    utteranceId: UtteranceIdSchema,
    highestContiguousExclusiveOffset: OriginalSampleOffsetSchema,
    flowState: FlowStateSchema,
    requestedReplayOffset: Type.Optional(OriginalSampleOffsetSchema)
  },
  CLOSED_OBJECT
);
export type AudioAck = Static<typeof AudioAckSchema>;

const TranscriptProperties = {
  sessionId: SessionIdSchema,
  sessionEpoch: PositiveEpochSchema,
  utteranceId: UtteranceIdSchema,
  segmentId: SegmentIdSchema,
  revision: PositiveRevisionSchema,
  text: BoundedTranscriptTextSchema,
  providerEventTime: UtcTimestampSchema
};

export const TranscriptPartialSchema = Type.Object(
  { type: Type.Literal('transcript.partial'), ...TranscriptProperties },
  CLOSED_OBJECT
);
export type TranscriptPartial = Static<typeof TranscriptPartialSchema>;

export const TranscriptFinalSchema = Type.Object(
  { type: Type.Literal('transcript.final'), ...TranscriptProperties },
  CLOSED_OBJECT
);
export type TranscriptFinal = Static<typeof TranscriptFinalSchema>;

export const LanguageDecisionValueSchema = Type.Union([
  Type.Literal('target'),
  Type.Literal('mixed'),
  Type.Literal('english'),
  Type.Literal('supported_unselected'),
  Type.Literal('unsupported'),
  Type.Literal('uncertain')
]);
export type LanguageDecisionValue = Static<typeof LanguageDecisionValueSchema>;

export const LanguageDecisionSchema = Type.Object(
  {
    type: Type.Literal('language.decision'),
    sessionId: SessionIdSchema,
    sessionEpoch: PositiveEpochSchema,
    utteranceId: UtteranceIdSchema,
    segmentId: SegmentIdSchema,
    revision: PositiveRevisionSchema,
    decision: LanguageDecisionValueSchema,
    selectedTargetLanguage: TargetLanguageSchema,
    detectedLanguage: Type.Optional(DetectedLanguageCodeSchema),
    confidence: Type.Optional(ConfidenceSchema),
    gatePolicyVersion: VersionSchema
  },
  CLOSED_OBJECT
);
export type LanguageDecision = Static<typeof LanguageDecisionSchema>;

const AcceptedFinalProperties = {
  sessionId: SessionIdSchema,
  sessionEpoch: PositiveEpochSchema,
  utteranceId: UtteranceIdSchema,
  segmentId: SegmentIdSchema,
  acceptedFinalRevision: PositiveRevisionSchema
};

export const TranslationReadySchema = Type.Object(
  {
    type: Type.Literal('translation.ready'),
    ...AcceptedFinalProperties,
    englishTranslation: BoundedEnglishTextSchema
  },
  CLOSED_OBJECT
);
export type TranslationReady = Static<typeof TranslationReadySchema>;

export const SuggestionSchema = Type.Object(
  {
    englishText: BoundedEnglishTextSchema,
    selectedTargetText: BoundedTargetTextSchema
  },
  CLOSED_OBJECT
);
export type Suggestion = Static<typeof SuggestionSchema>;

export const SuggestionsSchema = Type.Array(SuggestionSchema, { minItems: 2, maxItems: 3 });
export type Suggestions = Static<typeof SuggestionsSchema>;

export const SuggestionsReadySchema = Type.Object(
  {
    type: Type.Literal('suggestions.ready'),
    ...AcceptedFinalProperties,
    suggestions: SuggestionsSchema
  },
  CLOSED_OBJECT
);
export type SuggestionsReady = Static<typeof SuggestionsReadySchema>;

export const ErrorCodeSchema = Type.Union([
  Type.Literal('malformed_message'),
  Type.Literal('unsupported_protocol'),
  Type.Literal('unsupported_target'),
  Type.Literal('authentication_failed'),
  Type.Literal('session_conflict'),
  Type.Literal('utterance_conflict'),
  Type.Literal('stale_result'),
  Type.Literal('flow_control'),
  Type.Literal('duration_limit'),
  Type.Literal('rate_limit'),
  Type.Literal('provider_unavailable'),
  Type.Literal('state_unavailable'),
  Type.Literal('internal_failure')
]);
export type ErrorCode = Static<typeof ErrorCodeSchema>;

export const ErrorScopeSchema = Type.Union([
  Type.Literal('connection'),
  Type.Literal('session'),
  Type.Literal('utterance'),
  Type.Literal('message'),
  Type.Literal('audio'),
  Type.Literal('auth'),
  Type.Literal('server')
]);
export type ErrorScope = Static<typeof ErrorScopeSchema>;

export const ErrorEnvelopeSchema = Type.Object(
  {
    type: Type.Literal('error'),
    code: ErrorCodeSchema,
    scope: ErrorScopeSchema,
    recoverable: Type.Boolean(),
    displaySafeMessage: BoundedDisplayMessageSchema,
    errorId: UuidSchema,
    time: UtcTimestampSchema
  },
  CLOSED_OBJECT
);
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export const TypedErrorEnvelopeSchema = ErrorEnvelopeSchema;
export type TypedErrorEnvelope = ErrorEnvelope;

export const ServerControlMessageSchema = Type.Union([
  SessionReadySchema,
  SessionRejectedSchema,
  UtteranceAbortedSchema,
  AudioAckSchema,
  TranscriptPartialSchema,
  TranscriptFinalSchema,
  LanguageDecisionSchema,
  TranslationReadySchema,
  SuggestionsReadySchema,
  ErrorEnvelopeSchema
]);
export type ServerControlMessage = Static<typeof ServerControlMessageSchema>;
export const ServerControlMessagesSchema = ServerControlMessageSchema;
export type ServerControlMessages = ServerControlMessage;

export const ControlMessageSchema = Type.Union([
  SessionStartSchema,
  UtteranceStartSchema,
  UtteranceCommitSchema,
  UtteranceCancelSchema,
  SessionEndSchema,
  SessionReadySchema,
  SessionRejectedSchema,
  UtteranceAbortedSchema,
  AudioAckSchema,
  TranscriptPartialSchema,
  TranscriptFinalSchema,
  LanguageDecisionSchema,
  TranslationReadySchema,
  SuggestionsReadySchema,
  ErrorEnvelopeSchema
]);
export type ControlMessage = Static<typeof ControlMessageSchema>;
export const AllControlMessageSchema = ControlMessageSchema;
export const AllControlMessagesSchema = ControlMessageSchema;
export type AllControlMessage = ControlMessage;
export type AllControlMessages = ControlMessage;

export type AnyObjectSchema = TSchema & { additionalProperties: false };
