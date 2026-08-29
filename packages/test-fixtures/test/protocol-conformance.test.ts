import { Value } from '@sinclair/typebox/value';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_HEADER_BYTES,
  AUDIO_RATE_BUCKET_CAPACITY_SAMPLES,
  AUDIO_RATE_REFILL_SAMPLES_PER_SECOND,
  AudioFrameError,
  BINARY_MAGIC,
  ClientControlMessageSchema,
  ControlMessageSchema,
  CredentialRotationConfirmationRequestSchema,
  CredentialRotationRequestSchema,
  DEFAULT_NEGOTIATED_LIMITS,
  ErrorEnvelopeSchema,
  HttpErrorResponseSchema,
  InstallationCredentialResponseSchema,
  LanguageDecisionSchema,
  MAX_AUDIO_PAYLOAD_BYTES,
  MAX_BINARY_MESSAGE_BYTES,
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_UNACKNOWLEDGED_SAMPLES,
  MAX_UTTERANCE_MS,
  MAX_UTTERANCE_SAMPLES,
  OriginalSampleOffsetSchema,
  PAIRING_LIFETIME_MS,
  PairingRedemptionRequestSchema,
  PROTOCOL_CONSTANTS,
  PROTOCOL_VERSION,
  RotationBeginResponseSchema,
  RotationConfirmationResponseSchema,
  ServerControlMessageSchema,
  SessionStartSchema,
  SessionTicketRequestSchema,
  SessionTicketResponseSchema,
  SuggestionsReadySchema,
  TranscriptFinalSchema,
  TranscriptPartialSchema,
  TranslationReadySchema,
  UtteranceAbortedSchema,
  WEBSOCKET_SUBPROTOCOL,
  assertClientControlMessage,
  assertControlMessage,
  assertCredentialRotationConfirmationRequest,
  assertCredentialRotationRequest,
  assertInstallationCredentialResponse,
  assertRotationConfirmationResponse,
  assertServerControlMessage,
  assertErrorEnvelope,
  assertSessionTicketRequest,
  assertUtteranceAborted,
  createWebSocketSubprotocols,
  decodeAudioFrame,
  encodeAudioFrame,
  isAudioAck,
  isBase64UrlSecret,
  isCanonicalPairingCode,
  isClientControlMessage,
  isControlMessage,
  isCredentialRotationConfirmationRequest,
  isCredentialRotationRequest,
  isErrorEnvelope,
  isInstallationCredentialResponse,
  isRotationBeginResponse,
  isRotationConfirmationResponse,
  isServerControlMessage,
  isSessionReady,
  isSessionTicketRequest,
  isSessionTicketResponse,
  isTranscriptFinal,
  isTranscriptPartial,
  isUtteranceAborted,
  type AudioFrameInput
} from '@palancar/contracts';
import {
  AUDIO_ACK_FIXTURE,
  CONTROLLED_FIXTURE_NOTICE,
  CONTROLLED_INSTALLATION_CREDENTIAL,
  CONTROLLED_PAIRING_CODE,
  CONTROLLED_SESSION_TICKET,
  CREDENTIAL_ROTATION_CONFIRMATION_REQUEST,
  CREDENTIAL_ROTATION_REQUEST,
  ERROR_CODES,
  ERROR_ENVELOPE_FIXTURES,
  GOLDEN_MINIMUM_AUDIO_FRAME_HEX,
  GOLDEN_MINIMUM_AUDIO_FRAME_INPUT,
  HTTP_ERROR_RESPONSE,
  INSTALLATION_CREDENTIAL_RESPONSE,
  LANGUAGE_DECISION_FIXTURES,
  LANGUAGE_DECISION_VALUES,
  MAXIMUM_AUDIO_FRAME_INPUT,
  NEW_SESSION_JOURNEY,
  NEW_SESSION_READY,
  NEW_SESSION_START,
  NEW_SESSION_TICKET_REQUEST,
  NEW_SESSION_UTTERANCE_COMMIT,
  PAIRING_REDEMPTION_REQUEST,
  PROTOCOL_CLIENT_FIXTURES,
  PROTOCOL_SERVER_FIXTURES,
  ROTATION_BEGIN_RESPONSE,
  ROTATION_CONFIRMATION_RESPONSE,
  SESSION_REJECTED_FIXTURES,
  SESSION_REJECTION_CODES,
  SESSION_TICKET_RESPONSE,
  SPANISH_PROTOCOL_JOURNEY,
  TURKISH_PROTOCOL_JOURNEY,
  UTTERANCE_ABORTED_FIXTURES,
  UTTERANCE_ABORT_CATEGORIES,
  UTTERANCE_CANCEL_FIXTURE,
  getGoldenMinimumAudioFrame,
  getMaximumAudioFrame
} from '../src/index.js';

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

function expectAudioReason(action: () => unknown, reason: AudioFrameError['reason']): void {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(AudioFrameError);
  if (captured instanceof AudioFrameError) {
    expect(captured.reason).toBe(reason);
  }
}

describe('complete controlled message matrix', () => {
  it('accepts every client family and rejects it from the opposite union', () => {
    expect(new Set(PROTOCOL_CLIENT_FIXTURES.map((message) => message.type))).toEqual(
      new Set([
        'session.start',
        'utterance.start',
        'utterance.commit',
        'utterance.cancel',
        'session.end'
      ])
    );
    for (const message of PROTOCOL_CLIENT_FIXTURES) {
      expect(Value.Check(ClientControlMessageSchema, message), message.type).toBe(true);
      expect(isClientControlMessage(message), message.type).toBe(true);
      expect(isServerControlMessage(message), message.type).toBe(false);
      expect(isControlMessage(message), message.type).toBe(true);
      expect(assertClientControlMessage(message)).toBe(message);
      expect(assertControlMessage(message)).toBe(message);
    }
  });

  it('accepts every server family and rejects it from the opposite union', () => {
    expect(new Set(PROTOCOL_SERVER_FIXTURES.map((message) => message.type))).toEqual(
      new Set([
        'session.ready',
        'session.rejected',
        'utterance.aborted',
        'audio.ack',
        'transcript.partial',
        'transcript.final',
        'language.decision',
        'translation.ready',
        'suggestions.ready',
        'error'
      ])
    );
    for (const message of PROTOCOL_SERVER_FIXTURES) {
      expect(Value.Check(ServerControlMessageSchema, message), message.type).toBe(true);
      expect(isServerControlMessage(message), message.type).toBe(true);
      expect(isClientControlMessage(message), message.type).toBe(false);
      expect(isControlMessage(message), message.type).toBe(true);
      expect(assertServerControlMessage(message)).toBe(message);
      expect(assertControlMessage(message)).toBe(message);
    }
  });

  it('covers every rejection, abort, error, and language-decision category', () => {
    expect(SESSION_REJECTED_FIXTURES.map((fixture) => fixture.code)).toEqual(
      SESSION_REJECTION_CODES
    );
    expect(UTTERANCE_ABORTED_FIXTURES.map((fixture) => fixture.category)).toEqual(
      UTTERANCE_ABORT_CATEGORIES
    );
    expect(ERROR_ENVELOPE_FIXTURES.map((fixture) => fixture.code)).toEqual(ERROR_CODES);
    expect(LANGUAGE_DECISION_FIXTURES.map((fixture) => fixture.decision)).toEqual(
      LANGUAGE_DECISION_VALUES
    );
    expect(LANGUAGE_DECISION_VALUES).toEqual([
      'target',
      'mixed',
      'english',
      'supported_unselected',
      'unsupported',
      'uncertain'
    ]);
    for (const fixture of LANGUAGE_DECISION_FIXTURES) {
      expect(Value.Check(LanguageDecisionSchema, fixture)).toBe(true);
    }
    for (const fixture of ERROR_ENVELOPE_FIXTURES) {
      expect(Value.Check(ErrorEnvelopeSchema, fixture)).toBe(true);
      expect(isErrorEnvelope(fixture)).toBe(true);
    }
  });

  it('includes the valid new-only journey', () => {
    expect(NEW_SESSION_JOURNEY.request).toBe(NEW_SESSION_START);
    expect(NEW_SESSION_JOURNEY.ready).toBe(NEW_SESSION_READY);
    expect(isClientControlMessage(NEW_SESSION_JOURNEY.request)).toBe(true);
    expect(isSessionReady(NEW_SESSION_JOURNEY.ready)).toBe(true);
  });
});

describe('accepted-final result binding and symmetry', () => {
  it('binds every accepted result to session, epoch, utterance, segment, and final revision', () => {
    for (const journey of [SPANISH_PROTOCOL_JOURNEY, TURKISH_PROTOCOL_JOURNEY]) {
      const final = journey.transcriptFinal;
      for (const accepted of [
        journey.languageDecision,
        journey.translationReady,
        journey.suggestionsReady
      ]) {
        expect(accepted.sessionId).toBe(final.sessionId);
        expect(accepted.sessionEpoch).toBe(final.sessionEpoch);
        expect(accepted.utteranceId).toBe(final.utteranceId);
        expect(accepted.segmentId).toBe(final.segmentId);
      }
      expect(journey.languageDecision.revision).toBe(final.revision);
      expect(journey.translationReady.acceptedFinalRevision).toBe(final.revision);
      expect(journey.suggestionsReady.acceptedFinalRevision).toBe(final.revision);
      expect(Value.Check(TranslationReadySchema, journey.translationReady)).toBe(true);
      expect(Value.Check(SuggestionsReadySchema, journey.suggestionsReady)).toBe(true);
    }
  });

  it('keeps Spanish and Turkish accepted results structurally symmetric', () => {
    const spanish = SPANISH_PROTOCOL_JOURNEY;
    const turkish = TURKISH_PROTOCOL_JOURNEY;
    expect(Object.keys(spanish).sort()).toEqual(Object.keys(turkish).sort());
    expect(Object.keys(spanish.translationReady).sort()).toEqual(
      Object.keys(turkish.translationReady).sort()
    );
    expect(Object.keys(spanish.suggestionsReady).sort()).toEqual(
      Object.keys(turkish.suggestionsReady).sort()
    );
    expect(spanish.suggestionsReady.suggestions).toHaveLength(
      turkish.suggestionsReady.suggestions.length
    );
    expect(spanish.languageDecision.selectedTargetLanguage).toBe('es');
    expect(turkish.languageDecision.selectedTargetLanguage).toBe('tr');
  });
});

describe('strict schema and semantic boundaries', () => {
  it('rejects unknown fields, unsupported values, invalid ranges, and oversized values', () => {
    expect(isControlMessage({ ...NEW_SESSION_START, unexpected: true })).toBe(false);
    expect(Value.Check(SessionStartSchema, { ...NEW_SESSION_START, protocolVersion: 2 })).toBe(false);
    expect(Value.Check(SessionStartSchema, { ...NEW_SESSION_START, targetLanguage: 'fr' })).toBe(false);
    expect(Value.Check(LanguageDecisionSchema, {
      ...SPANISH_PROTOCOL_JOURNEY.languageDecision,
      confidence: 1.01
    })).toBe(false);
    expect(Value.Check(TranscriptFinalSchema, {
      ...SPANISH_PROTOCOL_JOURNEY.transcriptFinal,
      revision: 0
    })).toBe(false);
    expect(Value.Check(TranscriptPartialSchema, {
      ...SPANISH_PROTOCOL_JOURNEY.transcriptPartial,
      text: 'x'.repeat(4_097)
    })).toBe(false);
    expect(Value.Check(SuggestionsReadySchema, {
      ...SPANISH_PROTOCOL_JOURNEY.suggestionsReady,
      suggestions: [SPANISH_PROTOCOL_JOURNEY.suggestionsReady.suggestions[0]!]
    })).toBe(false);
    expect(Value.Check(SuggestionsReadySchema, {
      ...SPANISH_PROTOCOL_JOURNEY.suggestionsReady,
      suggestions: [
        ...SPANISH_PROTOCOL_JOURNEY.suggestionsReady.suggestions,
        ...SPANISH_PROTOCOL_JOURNEY.suggestionsReady.suggestions
      ]
    })).toBe(false);
  });

  it('enforces 0/480,000 original offsets and 8,000 retained samples everywhere', () => {
    expect(Value.Check(OriginalSampleOffsetSchema, 0)).toBe(true);
    expect(Value.Check(OriginalSampleOffsetSchema, 480_000)).toBe(true);
    expect(Value.Check(OriginalSampleOffsetSchema, 480_001)).toBe(false);

    for (const boundary of [0, 480_000]) {
      expect(isClientControlMessage({
        ...NEW_SESSION_UTTERANCE_COMMIT,
        finalOriginalSampleOffset: boundary
      })).toBe(true);
      expect(isClientControlMessage({
        ...UTTERANCE_CANCEL_FIXTURE,
        finalOriginalSampleOffset: boundary
      })).toBe(true);
      expect(isAudioAck({
        ...AUDIO_ACK_FIXTURE,
        highestContiguousExclusiveOffset: boundary,
        requestedReplayOffset: boundary
      })).toBe(true);
      expect(isSessionReady(NEW_SESSION_READY)).toBe(true);
      expect(isSessionReady({
        ...NEW_SESSION_READY,
        requestedReplayOffset: boundary
      })).toBe(false);
    }

    expect(isClientControlMessage({
      ...NEW_SESSION_UTTERANCE_COMMIT,
      finalOriginalSampleOffset: 480_001
    })).toBe(false);
    expect(isClientControlMessage({
      ...UTTERANCE_CANCEL_FIXTURE,
      finalOriginalSampleOffset: 480_001
    })).toBe(false);
    expect(isAudioAck({
      ...AUDIO_ACK_FIXTURE,
      highestContiguousExclusiveOffset: 480_001
    })).toBe(false);
    expect(isAudioAck({
      ...AUDIO_ACK_FIXTURE,
      highestContiguousExclusiveOffset: 10_000,
      requestedReplayOffset: 10_001
    })).toBe(false);
    expect(isSessionReady({
      ...NEW_SESSION_READY,
      requestedReplayOffset: 480_001
    })).toBe(false);
    expect(isSessionReady({
      ...NEW_SESSION_READY,
      result: 'resumed',
      requestedReplayOffset: 0
    })).toBe(false);
  });

  it('includes and semantically validates all negotiated v1 limits', () => {
    expect(DEFAULT_NEGOTIATED_LIMITS).toMatchObject({
      maxRetainedReplaySamples: 8_000,
      maxUtteranceMs: 30_000
    });
    expect(DEFAULT_NEGOTIATED_LIMITS.maxRetainedReplaySamples).toBeLessThanOrEqual(
      DEFAULT_NEGOTIATED_LIMITS.maxUnacknowledgedSamples
    );
    expect(DEFAULT_NEGOTIATED_LIMITS.maxAudioPayloadBytes % 2).toBe(0);
    expect(DEFAULT_NEGOTIATED_LIMITS.maxBinaryMessageBytes).toBeGreaterThanOrEqual(
      AUDIO_HEADER_BYTES + DEFAULT_NEGOTIATED_LIMITS.maxAudioPayloadBytes
    );
    expect(MAX_UTTERANCE_MS).toBe(30_000);
  });
});

describe('authentication and semantic timestamps', () => {
  it('accepts only the symmetric deeply frozen empty credential rotation fixtures', () => {
    const canary = 'ROTATION-CREDENTIAL-CANARY';
    const contracts = [
      {
        fixture: CREDENTIAL_ROTATION_REQUEST,
        schema: CredentialRotationRequestSchema,
        isValid: isCredentialRotationRequest,
        assertValid: assertCredentialRotationRequest
      },
      {
        fixture: CREDENTIAL_ROTATION_CONFIRMATION_REQUEST,
        schema: CredentialRotationConfirmationRequestSchema,
        isValid: isCredentialRotationConfirmationRequest,
        assertValid: assertCredentialRotationConfirmationRequest
      }
    ] as const;

    for (const { fixture, schema, isValid, assertValid } of contracts) {
      expect(fixture).toEqual({});
      expect(Object.keys(fixture)).toEqual([]);
      expect(Object.isFrozen(fixture)).toBe(true);
      expect(Value.Check(schema, fixture)).toBe(true);
      expect(isValid(fixture)).toBe(true);
      expect(assertValid(fixture)).toBe(fixture);

      for (const invalid of [
        null,
        [],
        'rotation request',
        1,
        Symbol('rotation request'),
        { credential: canary },
        { secret: canary },
        { password: canary },
        { credentialVersion: 1 }
      ] as unknown[]) {
        expect(Value.Check(schema, invalid)).toBe(false);
        expect(isValid(invalid)).toBe(false);
        expect(() => assertValid(invalid)).toThrow();
      }

      for (const invalid of [{ credential: canary }, { secret: canary }]) {
        let captured: unknown;
        try {
          assertValid(invalid);
        } catch (error) {
          captured = error;
        }
        expect(captured).toBeInstanceOf(Error);
        if (captured instanceof Error) {
          expect(JSON.stringify(captured) ?? '').not.toContain(canary);
          expect(captured.stack ?? '').not.toContain(canary);
        }
      }
    }
  });

  it('accepts every controlled auth fixture with its intended runtime validator', () => {
    expect(Value.Check(PairingRedemptionRequestSchema, PAIRING_REDEMPTION_REQUEST)).toBe(true);
    expect(Value.Check(InstallationCredentialResponseSchema, INSTALLATION_CREDENTIAL_RESPONSE)).toBe(
      true
    );
    expect(isInstallationCredentialResponse(INSTALLATION_CREDENTIAL_RESPONSE)).toBe(true);
    expect(Value.Check(SessionTicketRequestSchema, NEW_SESSION_TICKET_REQUEST)).toBe(true);
    expect(Value.Check(SessionTicketRequestSchema, {
      protocolVersion: 1,
      intent: 'resume',
      sessionId: '11111111-1111-4111-8111-111111111111'
    })).toBe(false);
    const legacyResumeTicket = {
      protocolVersion: 1,
      intent: 'resume',
      sessionId: '11111111-1111-4111-8111-111111111111'
    } as const;
    expect(isSessionTicketRequest(legacyResumeTicket)).toBe(false);
    expect(() => assertSessionTicketRequest(legacyResumeTicket)).toThrow();
    expect(isSessionTicketRequest(NEW_SESSION_TICKET_REQUEST)).toBe(true);
    expect(isSessionTicketResponse(SESSION_TICKET_RESPONSE)).toBe(true);
    expect(Value.Check(SessionTicketResponseSchema, SESSION_TICKET_RESPONSE)).toBe(true);
    expect(isRotationBeginResponse(ROTATION_BEGIN_RESPONSE)).toBe(true);
    expect(isRotationConfirmationResponse(ROTATION_CONFIRMATION_RESPONSE)).toBe(true);
    expect(Value.Check(RotationBeginResponseSchema, ROTATION_BEGIN_RESPONSE)).toBe(true);
    expect(Value.Check(RotationConfirmationResponseSchema, ROTATION_CONFIRMATION_RESPONSE)).toBe(
      true
    );
    expect(Value.Check(HttpErrorResponseSchema, HTTP_ERROR_RESPONSE)).toBe(true);
  });

  it('rejects legacy non-resumable error and abort envelopes from leaf and aggregate validators', () => {
    const legacyError = {
      ...ERROR_ENVELOPE_FIXTURES[0]!,
      code: 'non_resumable'
    } as const;
    const legacyAbort = {
      ...UTTERANCE_ABORTED_FIXTURES[0]!,
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

  it('rejects impossible timestamps in every timestamp-bearing validator and aggregate', () => {
    const impossible = '2026-02-30T12:00:00Z';
    const serverTimestampCases = [
      {
        message: { ...NEW_SESSION_READY, serverTime: impossible },
        validate: isSessionReady
      },
      {
        message: {
        ...SPANISH_PROTOCOL_JOURNEY.transcriptPartial,
        providerEventTime: impossible
        },
        validate: isTranscriptPartial
      },
      {
        message: {
        ...SPANISH_PROTOCOL_JOURNEY.transcriptFinal,
        providerEventTime: impossible
        },
        validate: isTranscriptFinal
      },
      {
        message: { ...ERROR_ENVELOPE_FIXTURES[0]!, time: impossible },
        validate: isErrorEnvelope
      }
    ];
    for (const { message, validate } of serverTimestampCases) {
      expect(validate(message)).toBe(false);
      expect(isServerControlMessage(message)).toBe(false);
      expect(isControlMessage(message)).toBe(false);
      expect(() => assertServerControlMessage(message)).toThrow();
      expect(() => assertControlMessage(message)).toThrow();
    }

    const authTimestampCases = [
      () => isInstallationCredentialResponse({
        ...INSTALLATION_CREDENTIAL_RESPONSE,
        idleExpiresAt: impossible
      }),
      () => isInstallationCredentialResponse({
        ...INSTALLATION_CREDENTIAL_RESPONSE,
        absoluteExpiresAt: impossible
      }),
      () => isSessionTicketResponse({ ...SESSION_TICKET_RESPONSE, expiresAt: impossible }),
      () => isRotationBeginResponse({
        ...ROTATION_BEGIN_RESPONSE,
        pendingCredentialExpiresAt: impossible
      }),
      () => isRotationConfirmationResponse({
        ...ROTATION_CONFIRMATION_RESPONSE,
        confirmedAt: impossible
      }),
      () => isRotationConfirmationResponse({
        ...ROTATION_CONFIRMATION_RESPONSE,
        expiresAt: impossible
      })
    ];
    for (const validate of authTimestampCases) {
      expect(validate()).toBe(false);
    }
  });

  it('enforces credential timestamp ordering and accepts equal expiries', () => {
    const credentialEqual = {
      ...INSTALLATION_CREDENTIAL_RESPONSE,
      idleExpiresAt: INSTALLATION_CREDENTIAL_RESPONSE.absoluteExpiresAt
    };
    const credentialReversed = {
      ...INSTALLATION_CREDENTIAL_RESPONSE,
      idleExpiresAt: '2026-11-07T12:00:00.001Z',
      absoluteExpiresAt: '2026-11-07T12:00:00Z'
    };
    expect(isInstallationCredentialResponse(credentialEqual)).toBe(true);
    expect(assertInstallationCredentialResponse(credentialEqual)).toBe(credentialEqual);
    expect(Value.Check(InstallationCredentialResponseSchema, credentialReversed)).toBe(true);
    expect(isInstallationCredentialResponse(credentialReversed)).toBe(false);
    expect(() => assertInstallationCredentialResponse(credentialReversed)).toThrow();

    const rotationEqual = {
      ...ROTATION_CONFIRMATION_RESPONSE,
      confirmedAt: ROTATION_CONFIRMATION_RESPONSE.expiresAt
    };
    const rotationReversed = {
      ...ROTATION_CONFIRMATION_RESPONSE,
      confirmedAt: '2026-11-07T12:00:00.001Z',
      expiresAt: '2026-11-07T12:00:00Z'
    };
    expect(isRotationConfirmationResponse(rotationEqual)).toBe(true);
    expect(assertRotationConfirmationResponse(rotationEqual)).toBe(rotationEqual);
    expect(Value.Check(RotationConfirmationResponseSchema, rotationReversed)).toBe(true);
    expect(isRotationConfirmationResponse(rotationReversed)).toBe(false);
    expect(() => assertRotationConfirmationResponse(rotationReversed)).toThrow();
  });

  it('enforces canonical pairing, base64url, and ticket-only subprotocol values', () => {
    expect(CONTROLLED_FIXTURE_NOTICE).toContain('synthetic');
    expect(isCanonicalPairingCode(CONTROLLED_PAIRING_CODE)).toBe(true);
    for (const invalid of [
      '12345',
      '1234567',
      '12345A',
      '',
      '00000000000000000000000000',
      CONTROLLED_PAIRING_CODE.replace('0', 'O'),
      CONTROLLED_PAIRING_CODE.replace('1', 'I')
    ]) {
      expect(isCanonicalPairingCode(invalid)).toBe(false);
    }
    expect(isBase64UrlSecret(CONTROLLED_INSTALLATION_CREDENTIAL)).toBe(true);
    expect(isBase64UrlSecret(CONTROLLED_SESSION_TICKET)).toBe(true);
    const protocols = createWebSocketSubprotocols(CONTROLLED_SESSION_TICKET);
    expect(protocols).toEqual([
      WEBSOCKET_SUBPROTOCOL,
      `palancar.ticket.${CONTROLLED_SESSION_TICKET}`
    ]);
    expect(protocols.join('')).not.toContain('?');
    expect(protocols.join('')).not.toContain('://');
  });
});

describe('deeply immutable controlled fixtures', () => {
  it('deep-freezes nested journeys, arrays, and suggestion objects', () => {
    const nestedValues = [
      PROTOCOL_CLIENT_FIXTURES,
      PROTOCOL_SERVER_FIXTURES,
      SESSION_REJECTED_FIXTURES,
      UTTERANCE_ABORTED_FIXTURES,
      ERROR_ENVELOPE_FIXTURES,
      LANGUAGE_DECISION_FIXTURES,
      CREDENTIAL_ROTATION_REQUEST,
      CREDENTIAL_ROTATION_CONFIRMATION_REQUEST,
      SPANISH_PROTOCOL_JOURNEY,
      SPANISH_PROTOCOL_JOURNEY.suggestionsReady.suggestions,
      SPANISH_PROTOCOL_JOURNEY.suggestionsReady.suggestions[0]
    ];
    for (const value of nestedValues) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => Object.assign(
      SPANISH_PROTOCOL_JOURNEY.suggestionsReady.suggestions[0]!,
      { englishText: 'mutated' }
    )).toThrow();
  });

  it('returns defensive binary payload and frame copies', () => {
    const firstInputPayload = GOLDEN_MINIMUM_AUDIO_FRAME_INPUT.payload;
    firstInputPayload[0] = 0xff;
    expect(GOLDEN_MINIMUM_AUDIO_FRAME_INPUT.payload[0]).toBe(0);

    const firstFrame = getGoldenMinimumAudioFrame();
    firstFrame[0] = 0;
    expect(getGoldenMinimumAudioFrame()[0]).toBe(0x50);

    const maximum = getMaximumAudioFrame();
    maximum[AUDIO_HEADER_BYTES] = 0xff;
    expect(getMaximumAudioFrame()[AUDIO_HEADER_BYTES]).toBe(0);
  });
});

describe('binary audio codec', () => {
  it('matches golden bytes and minimum/maximum round trips', () => {
    const golden = getGoldenMinimumAudioFrame();
    expect(AUDIO_HEADER_BYTES).toBe(2 + 1 + 1 + 16 + 4 + 4 + 2);
    expect(MAX_BINARY_MESSAGE_BYTES).toBe(AUDIO_HEADER_BYTES + MAX_AUDIO_PAYLOAD_BYTES);
    expect(hexOf(golden)).toBe(GOLDEN_MINIMUM_AUDIO_FRAME_HEX);
    expect(decodeAudioFrame(golden).payload).toEqual(Uint8Array.from([0, 0]));

    const maximumFrame = getMaximumAudioFrame();
    expect(maximumFrame).toHaveLength(MAX_BINARY_MESSAGE_BYTES);
    const maximum = decodeAudioFrame(maximumFrame);
    expect(maximum.sequence).toBe(MAXIMUM_AUDIO_FRAME_INPUT.sequence);
    expect(maximum.offset).toBe(MAXIMUM_AUDIO_FRAME_INPUT.offset);
    expect(maximum.payloadLength).toBe(MAX_AUDIO_PAYLOAD_BYTES);
    expect(maximum.payload).toEqual(MAXIMUM_AUDIO_FRAME_INPUT.payload);
  });

  it('copies encode inputs and decode outputs', () => {
    const payload = Uint8Array.from([1, 2, 3, 4]);
    const encoded = encodeAudioFrame({
      utteranceId: '55555555-5555-4555-8555-555555555555',
      sequence: 1,
      offset: 10,
      payload
    });
    payload[0] = 99;
    expect(encoded[AUDIO_HEADER_BYTES]).toBe(1);
    const decoded = decodeAudioFrame(encoded);
    encoded[AUDIO_HEADER_BYTES] = 88;
    expect(decoded.payload[0]).toBe(1);
    decoded.payload[1] = 77;
    expect(encoded[AUDIO_HEADER_BYTES + 1]).toBe(2);
  });

  it('reports every stable audio error category including malformed UUID bits', () => {
    const golden = getGoldenMinimumAudioFrame();
    const magic = golden.slice();
    magic[0] = 0;
    expectAudioReason(() => decodeAudioFrame(magic), 'magic');
    const version = golden.slice();
    version[2] = 2;
    expectAudioReason(() => decodeAudioFrame(version), 'version');
    const flags = golden.slice();
    flags[3] = 1;
    expectAudioReason(() => decodeAudioFrame(flags), 'flags');
    const uuid = golden.slice();
    uuid[10] = 0;
    expectAudioReason(() => decodeAudioFrame(uuid), 'uuid');
    expectAudioReason(() => encodeAudioFrame({
      ...GOLDEN_MINIMUM_AUDIO_FRAME_INPUT,
      sequence: 1.5
    }), 'integer');
    expectAudioReason(() => decodeAudioFrame(golden.slice(0, AUDIO_HEADER_BYTES - 1)), 'length');
    const declaredLength = golden.slice();
    new DataView(declaredLength.buffer).setUint16(28, 4, false);
    expectAudioReason(() => decodeAudioFrame(declaredLength), 'length');
    expectAudioReason(() => encodeAudioFrame({
      ...GOLDEN_MINIMUM_AUDIO_FRAME_INPUT,
      payload: Uint8Array.from([0])
    }), 'odd-payload');
    expectAudioReason(() => encodeAudioFrame({
      ...GOLDEN_MINIMUM_AUDIO_FRAME_INPUT,
      payload: new Uint8Array(MAX_AUDIO_PAYLOAD_BYTES + 2)
    }), 'oversize');
    expectAudioReason(() => encodeAudioFrame({
      ...GOLDEN_MINIMUM_AUDIO_FRAME_INPUT,
      offset: MAX_UTTERANCE_SAMPLES
    }), 'utterance-range');
  });

  it('round-trips arbitrary valid UUIDs, uint32 sequences, fitting offsets, and PCM', () => {
    const validFrames = fc.uuid({ version: 4 }).chain((utteranceId) =>
      fc.integer({ min: 0, max: 4_294_967_295 }).chain((sequence) =>
        fc.integer({ min: 1, max: MAX_AUDIO_PAYLOAD_BYTES / 2 }).chain((sampleCount) =>
          fc.integer({ min: 0, max: MAX_UTTERANCE_SAMPLES - sampleCount }).chain((offset) =>
            fc
              .array(fc.integer({ min: 0, max: 255 }), {
                minLength: sampleCount * 2,
                maxLength: sampleCount * 2
              })
              .map((bytes) => ({
                utteranceId,
                sequence,
                offset,
                payload: Uint8Array.from(bytes)
              }))
          )
        )
      )
    );
    fc.assert(
      fc.property(validFrames as fc.Arbitrary<AudioFrameInput>, (frame) => {
        const decoded = decodeAudioFrame(encodeAudioFrame(frame));
        expect(decoded.utteranceId).toBe(frame.utteranceId);
        expect(decoded.sequence).toBe(frame.sequence);
        expect(decoded.offset).toBe(frame.offset);
        expect(decoded.payload).toEqual(frame.payload);
      }),
      { seed: 20260809, numRuns: 220, endOnFailure: true }
    );
  });

  it('retains exact protocol constants and integer boundaries', () => {
    const frame = encodeAudioFrame({
      utteranceId: '66666666-6666-4666-8666-666666666666',
      sequence: 4_294_967_295,
      offset: MAX_UTTERANCE_SAMPLES - 1,
      payload: Uint8Array.from([0xaa, 0xbb])
    });
    expect(decodeAudioFrame(frame).sequence).toBe(4_294_967_295);
    expect(PROTOCOL_VERSION).toBe(1);
    expect(BINARY_MAGIC).toBe(0x5041);
    expect(MAX_CONTROL_MESSAGE_BYTES).toBe(16_384);
    expect(MAX_UNACKNOWLEDGED_SAMPLES).toBe(8_000);
    expect(AUDIO_RATE_REFILL_SAMPLES_PER_SECOND).toBe(16_000);
    expect(AUDIO_RATE_BUCKET_CAPACITY_SAMPLES).toBe(8_000);
    expect(PAIRING_LIFETIME_MS).toBe(1_800_000);
    expect(Object.isFrozen(PROTOCOL_CONSTANTS)).toBe(true);
  });
});
