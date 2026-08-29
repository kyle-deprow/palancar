export const PROTOCOL_VERSION = 1 as const;
export const BINARY_MAGIC = 0x5041 as const;
export const AUDIO_HEADER_BYTES = 30 as const;
export const MAX_AUDIO_PAYLOAD_BYTES = 3_200 as const;
export const MAX_BINARY_MESSAGE_BYTES = 3_230 as const;
export const MAX_CONTROL_MESSAGE_BYTES = 16_384 as const;
export const MAX_UNACKNOWLEDGED_SAMPLES = 8_000 as const;
export const ACK_INTERVAL_MS = 100 as const;
export const MAX_UTTERANCE_SAMPLES = 480_000 as const;
export const MAX_UTTERANCE_MS = 30_000 as const;
export const NO_NEW_TURN_AFTER_MS = 1_770_000 as const;
export const SESSION_DURATION_MS = 1_800_000 as const;
export const INACTIVITY_TIMEOUT_MS = 300_000 as const;
export const HEARTBEAT_INTERVAL_MS = 20_000 as const;
export const HEARTBEAT_GRACE_MS = 10_000 as const;
export const AUDIO_RATE_REFILL_SAMPLES_PER_SECOND = 16_000 as const;
export const AUDIO_RATE_BUCKET_CAPACITY_SAMPLES = 8_000 as const;
export const TICKET_LIFETIME_MS = 60_000 as const;
export const PAIRING_LIFETIME_MS = 1_800_000 as const;

export const HEADER_BYTES = AUDIO_HEADER_BYTES;
export const BINARY_HEADER_BYTES = AUDIO_HEADER_BYTES;

export const PROTOCOL_CONSTANTS = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  binaryMagic: BINARY_MAGIC,
  audioHeaderBytes: AUDIO_HEADER_BYTES,
  maxAudioPayloadBytes: MAX_AUDIO_PAYLOAD_BYTES,
  maxBinaryMessageBytes: MAX_BINARY_MESSAGE_BYTES,
  maxControlMessageBytes: MAX_CONTROL_MESSAGE_BYTES,
  maxUnacknowledgedSamples: MAX_UNACKNOWLEDGED_SAMPLES,
  ackIntervalMs: ACK_INTERVAL_MS,
  maxUtteranceSamples: MAX_UTTERANCE_SAMPLES,
  maxUtteranceMs: MAX_UTTERANCE_MS,
  noNewTurnAfterMs: NO_NEW_TURN_AFTER_MS,
  sessionDurationMs: SESSION_DURATION_MS,
  inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  heartbeatGraceMs: HEARTBEAT_GRACE_MS,
  audioRateRefillSamplesPerSecond: AUDIO_RATE_REFILL_SAMPLES_PER_SECOND,
  audioRateBucketCapacitySamples: AUDIO_RATE_BUCKET_CAPACITY_SAMPLES,
  ticketLifetimeMs: TICKET_LIFETIME_MS,
  pairingLifetimeMs: PAIRING_LIFETIME_MS
} as const);

export type ProtocolConstants = typeof PROTOCOL_CONSTANTS;

export const PROTOCOL_LIMITS = PROTOCOL_CONSTANTS;
