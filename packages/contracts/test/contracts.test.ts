import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  AudioFrameError,
  ClientControlMessageSchema,
  ControlMessageSchema,
  DEFAULT_NEGOTIATED_LIMITS,
  ErrorEnvelopeSchema,
  InstallationCredentialResponseSchema,
  ServerControlMessageSchema,
  SessionStartSchema,
  SessionTicketRequestSchema,
  UtteranceAbortedSchema,
  UuidSchema,
  assertClientControlMessage,
  assertControlMessage,
  assertErrorEnvelope,
  assertServerControlMessage,
  assertSessionTicketRequest,
  assertSessionTicketResponse,
  assertUtteranceAborted,
  createWebSocketSubprotocols,
  decodeAudioFrame,
  encodeAudioFrame,
  isBase64UrlSecret,
  isCanonicalWssOrigin,
  isClientControlMessage,
  isControlMessage,
  isErrorEnvelope,
  isNegotiatedLimits,
  isServerControlMessage,
  isSessionTicketRequest,
  isSessionTicketResponse,
  isUtcTimestamp,
  isUtteranceAborted
} from '../src/index.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CANONICAL_SECRET = 'A'.repeat(43);

const sessionStart = {
  type: 'session.start',
  protocolVersion: 1,
  wearerLanguage: 'en',
  targetLanguage: 'es',
  languageRegistryVersion: '1.0.0',
  gatePolicyVersion: '1.0.0',
  clientBuild: 'contract-test-0.1.0',
  requestedLimits: DEFAULT_NEGOTIATED_LIMITS
} as const;

const sessionReady = {
  type: 'session.ready',
  result: 'new',
  sessionId: SESSION_ID,
  sessionEpoch: 1,
  targetLanguage: 'es',
  languageRegistryVersion: '1.0.0',
  gatePolicyVersion: '1.0.0',
  effectiveLimits: DEFAULT_NEGOTIATED_LIMITS,
  serverTime: '2026-08-09T12:00:00Z'
} as const;

const ticketResponse = {
  ticket: CANONICAL_SECRET,
  wssOrigin: 'wss://relay.example.com',
  wssPath: '/v1/stream',
  protocolVersion: 1,
  expiresAt: '2026-08-09T12:01:00Z'
} as const;

function decodeBase64Url(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of value) {
    accumulator = accumulator * 64 + alphabet.indexOf(character);
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(bytes);
}

function capturedError(action: () => unknown): Error {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(Error);
  return captured as Error;
}

describe('semantic aggregate validation', () => {
  it('dispatches contradictory negotiated limits through client and all-control validators', () => {
    const contradictoryLimits = [
      { ...DEFAULT_NEGOTIATED_LIMITS, maxAudioPayloadBytes: 3_199 },
      { ...DEFAULT_NEGOTIATED_LIMITS, maxBinaryMessageBytes: 3_229 },
      {
        ...DEFAULT_NEGOTIATED_LIMITS,
        maxSessionDurationMs: 1_000_000,
        noNewTurnAfterMs: 1_000_001
      },
      {
        ...DEFAULT_NEGOTIATED_LIMITS,
        maxUnacknowledgedSamples: 100,
        maxRetainedReplaySamples: 101
      }
    ];

    for (const requestedLimits of contradictoryLimits) {
      const message = { ...sessionStart, requestedLimits };
      expect(Value.Check(SessionStartSchema, message)).toBe(true);
      expect(isNegotiatedLimits(requestedLimits)).toBe(false);
      expect(isClientControlMessage(message)).toBe(false);
      expect(isControlMessage(message)).toBe(false);
      expect(() => assertClientControlMessage(message)).toThrow();
      expect(() => assertControlMessage(message)).toThrow();

      const ready = { ...sessionReady, effectiveLimits: requestedLimits };
      expect(isServerControlMessage(ready)).toBe(false);
      expect(isControlMessage(ready)).toBe(false);
      expect(() => assertServerControlMessage(ready)).toThrow();
      expect(() => assertControlMessage(ready)).toThrow();
    }
  });

  it('rejects removed resume messages from every strict control validator', () => {
    const legacySessionResume = {
      ...sessionStart,
      type: 'session.resume',
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: '22222222-2222-4222-8222-222222222222',
      clientLastAcknowledgedOffset: 0,
      oldestRetainedOffset: 0,
      nextCapturedOffset: 0
    } as const;
    expect(Value.Check(ClientControlMessageSchema, legacySessionResume)).toBe(false);
    expect(Value.Check(ControlMessageSchema, legacySessionResume)).toBe(false);
    expect(isClientControlMessage(legacySessionResume)).toBe(false);
    expect(isControlMessage(legacySessionResume)).toBe(false);
    expect(() => assertClientControlMessage(legacySessionResume)).toThrow();
    expect(() => assertControlMessage(legacySessionResume)).toThrow();

    const legacySessionReady = {
      ...sessionReady,
      result: 'resumed',
      requestedReplayOffset: 0
    } as const;
    expect(Value.Check(ServerControlMessageSchema, legacySessionReady)).toBe(false);
    expect(isServerControlMessage(legacySessionReady)).toBe(false);
    expect(isControlMessage(legacySessionReady)).toBe(false);
    expect(() => assertServerControlMessage(legacySessionReady)).toThrow();
    expect(() => assertControlMessage(legacySessionReady)).toThrow();
  });

  it('rejects legacy non-resumable error and abort envelopes from leaf and aggregate validators', () => {
    const legacyError = {
      type: 'error',
      code: 'non_resumable',
      scope: 'session',
      recoverable: false,
      displaySafeMessage: 'The request could not be completed.',
      errorId: '44444444-4444-4444-8444-444444444444',
      time: '2026-08-09T12:00:04Z'
    } as const;
    const legacyAbort = {
      type: 'utterance.aborted',
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: '22222222-2222-4222-8222-222222222222',
      category: 'non_resumable'
    } as const;

    for (const [schema, runtime, value, assert] of [
      [ErrorEnvelopeSchema, isErrorEnvelope, legacyError, assertErrorEnvelope],
      [UtteranceAbortedSchema, isUtteranceAborted, legacyAbort, assertUtteranceAborted]
    ] as const) {
      expect(Value.Check(schema, value)).toBe(false);
      expect(runtime(value)).toBe(false);
      expect(() => assert(value)).toThrow();
      expect(Value.Check(ServerControlMessageSchema, value)).toBe(false);
      expect(isServerControlMessage(value)).toBe(false);
      expect(() => assertServerControlMessage(value)).toThrow();
      expect(Value.Check(ControlMessageSchema, value)).toBe(false);
      expect(isControlMessage(value)).toBe(false);
      expect(() => assertControlMessage(value)).toThrow();
    }
  });
});

describe('canonical auth values', () => {
  it('rejects terminal base64url aliases that decode to the same bytes', () => {
    const canonical = 'A'.repeat(43);
    for (const aliasTerminal of ['B', 'C', 'D']) {
      const alias = `${canonical.slice(0, -1)}${aliasTerminal}`;
      expect(decodeBase64Url(alias)).toEqual(decodeBase64Url(canonical));
      expect(isBase64UrlSecret(alias)).toBe(false);
      expect(() => createWebSocketSubprotocols(alias)).toThrow();
    }
    expect(isBase64UrlSecret(canonical)).toBe(true);
  });

  it('requires the exact new-only ticket request and separate credential expiries', () => {
    expect(Value.Check(SessionTicketRequestSchema, { protocolVersion: 1, intent: 'new' })).toBe(true);
    expect(Value.Check(SessionTicketRequestSchema, { intent: 'new' })).toBe(false);
    expect(Value.Check(SessionTicketRequestSchema, {
      protocolVersion: 1,
      intent: 'resume',
      sessionId: SESSION_ID
    })).toBe(false);
    const legacyResumeTicket = {
      protocolVersion: 1,
      intent: 'resume',
      sessionId: SESSION_ID
    } as const;
    expect(isSessionTicketRequest(legacyResumeTicket)).toBe(false);
    expect(() => assertSessionTicketRequest(legacyResumeTicket)).toThrow();
    expect(Value.Check(SessionTicketRequestSchema, {
      protocolVersion: 1,
      intent: 'new',
      sessionId: SESSION_ID
    })).toBe(false);
    expect(Value.Check(InstallationCredentialResponseSchema, {
      installationId: SESSION_ID,
      credential: CANONICAL_SECRET,
      credentialVersion: 1,
      idleExpiresAt: '2026-09-08T12:00:00Z',
      absoluteExpiresAt: '2026-11-07T12:00:00Z'
    })).toBe(true);
    expect(Value.Check(InstallationCredentialResponseSchema, {
      installationId: SESSION_ID,
      credential: CANONICAL_SECRET,
      credentialVersion: 1,
      expiresAt: '2026-11-07T12:00:00Z'
    })).toBe(false);
  });

  it('accepts only exact canonical WSS origins in ticket runtime validation', () => {
    for (const valid of ['wss://relay.example.com', 'wss://relay.example.com:8443']) {
      expect(isCanonicalWssOrigin(valid)).toBe(true);
      expect(isSessionTicketResponse({ ...ticketResponse, wssOrigin: valid })).toBe(true);
    }
    for (const invalid of [
      'wss://.',
      'wss://-',
      'wss://relay..example.com',
      'wss://relay.example.com:99999',
      'wss://relay.example.com:443',
      'wss://Relay.Example.com',
      'wss://relay.example.com/',
      'wss://relay.example.com/path',
      'wss://relay.example.com?query=1',
      'wss://relay.example.com#fragment',
      'wss://user:password@relay.example.com'
    ]) {
      const response = { ...ticketResponse, wssOrigin: invalid };
      expect(isCanonicalWssOrigin(invalid), invalid).toBe(false);
      expect(isSessionTicketResponse(response), invalid).toBe(false);
      expect(() => assertSessionTicketResponse(response), invalid).toThrow();
    }
  });
});

describe('canonical timestamps and UUIDs', () => {
  it('validates real UTC calendar and clock values', () => {
    expect(isUtcTimestamp('2024-02-29T23:59:59.999Z')).toBe(true);
    for (const invalid of [
      '2023-02-29T12:00:00Z',
      '2026-00-01T12:00:00Z',
      '2026-13-01T12:00:00Z',
      '2026-04-31T12:00:00Z',
      '2026-08-09T24:00:00Z',
      '2026-08-09T12:60:00Z',
      '2026-08-09T12:00:60Z'
    ]) {
      expect(isUtcTimestamp(invalid), invalid).toBe(false);
      expect(isServerControlMessage({ ...sessionReady, serverTime: invalid }), invalid).toBe(false);
      expect(isControlMessage({ ...sessionReady, serverTime: invalid }), invalid).toBe(false);
      expect(isSessionTicketResponse({ ...ticketResponse, expiresAt: invalid }), invalid).toBe(false);
    }
  });

  it('accepts RFC 4122 v4 UUID boundaries and rejects other versions and variants', () => {
    const baseFrame = {
      utteranceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sequence: 0,
      offset: 0,
      payload: Uint8Array.from([0x34, 0x12])
    };
    expect(Value.Check(UuidSchema, baseFrame.utteranceId)).toBe(true);
    for (const variant of ['8', '9', 'a', 'b']) {
      const variantUuid = `aaaaaaaa-aaaa-4aaa-${variant}aaa-aaaaaaaaaaaa`;
      expect(Value.Check(UuidSchema, variantUuid)).toBe(true);
      expect(decodeAudioFrame(
        encodeAudioFrame({ ...baseFrame, utteranceId: variantUuid })
      ).utteranceId).toBe(variantUuid);
    }
    expect(Value.Check(UuidSchema, baseFrame.utteranceId.toUpperCase())).toBe(false);
    expect(Value.Check(UuidSchema, '22222222-2222-0222-8222-222222222222')).toBe(false);
    expect(() => encodeAudioFrame({
      ...baseFrame,
      utteranceId: baseFrame.utteranceId.toUpperCase()
    })).toThrowError(expect.objectContaining({ reason: 'uuid' }));
    expect(() => encodeAudioFrame({
      ...baseFrame,
      utteranceId: '22222222-2222-0222-8222-222222222222'
    })).toThrowError(expect.objectContaining({ reason: 'uuid' }));
    for (const variant of ['7', 'c']) {
      const variantUuid = `22222222-2222-4222-${variant}222-222222222222`;
      expect(Value.Check(UuidSchema, variantUuid)).toBe(false);
      expect(() => encodeAudioFrame({ ...baseFrame, utteranceId: variantUuid })).toThrowError(
        expect.objectContaining({ reason: 'uuid' })
      );

      const badVariant = encodeAudioFrame(baseFrame);
      badVariant[12] = Number.parseInt(`${variant}2`, 16);
      expect(() => decodeAudioFrame(badVariant)).toThrowError(
        expect.objectContaining({ reason: 'uuid' })
      );
    }

    for (const version of [1, 2, 3, 5, 6, 7, 8]) {
      const versionUuid = `22222222-2222-${version}222-8222-222222222222`;
      expect(Value.Check(UuidSchema, versionUuid)).toBe(false);
      expect(() => encodeAudioFrame({ ...baseFrame, utteranceId: versionUuid })).toThrowError(
        expect.objectContaining({ reason: 'uuid' })
      );

      const badVersion = encodeAudioFrame(baseFrame);
      badVersion[10] = (version << 4) | (badVersion[10]! & 0x0f);
      expect(() => decodeAudioFrame(badVersion)).toThrowError(
        expect.objectContaining({ reason: 'uuid' })
      );
    }
  });
});

describe('safe validation errors', () => {
  it('never reflects PCM, UUID, header, credential, or ticket canaries', () => {
    const canaries = [
      'deadbeefcafe',
      'UUID-CANARY-FFFF',
      '50410100feed',
      'CREDENTIAL-CANARY',
      'TICKET-CANARY'
    ];
    const errors = [
      capturedError(() => encodeAudioFrame({
        utteranceId: canaries[1]!,
        sequence: 0,
        offset: 0,
        payload: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe])
      })),
      capturedError(() => decodeAudioFrame(
        Uint8Array.from([0x50, 0x41, 0x01, 0x00, 0xfe, 0xed])
      )),
      capturedError(() => createWebSocketSubprotocols(canaries[4]!)),
      capturedError(() => assertSessionTicketResponse({
        ...ticketResponse,
        ticket: canaries[4],
        credential: canaries[3],
        header: canaries[2],
        pcm: canaries[0]
      })),
      capturedError(() => assertControlMessage({
        ...sessionStart,
        payloadCanary: canaries[0]
      }))
    ];

    for (const error of errors) {
      const exposed = [error.name, error.message, ...Object.values(error)]
        .filter((value): value is string => typeof value === 'string')
        .join('|');
      for (const canary of canaries) {
        expect(exposed).not.toContain(canary);
      }
      if (error instanceof AudioFrameError) {
        expect(error.reason).not.toContain('CANARY');
      }
    }
  });
});
