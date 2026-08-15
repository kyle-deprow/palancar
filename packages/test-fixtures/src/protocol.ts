import {
  DEFAULT_NEGOTIATED_LIMITS,
  encodeAudioFrame,
  type AudioAck,
  type AudioFrameInput,
  type ClientControlMessage,
  type ErrorCode,
  type ErrorEnvelope,
  type HttpErrorResponse,
  type InstallationCredentialResponse,
  type LanguageDecision,
  type LanguageDecisionValue,
  type PairingRedemptionRequest,
  type RotationBeginResponse,
  type RotationConfirmationResponse,
  type ServerControlMessage,
  type SessionEnd,
  type SessionReady,
  type SessionRejected,
  type SessionRejectionCode,
  type SessionStart,
  type SessionTicketRequest,
  type SessionTicketResponse,
  type SuggestionsReady,
  type TranscriptFinal,
  type TranscriptPartial,
  type TranslationReady,
  type UtteranceAbortCategory,
  type UtteranceAborted,
  type UtteranceCancel,
  type UtteranceCommit,
  type UtteranceStart
} from '@palancar/contracts';

function deepFreeze<T>(value: T): T {
  if (
    typeof value === 'object' &&
    value !== null &&
    !ArrayBuffer.isView(value) &&
    !Object.isFrozen(value)
  ) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }

  return value;
}

export const CONTROLLED_FIXTURE_NOTICE =
  'Controlled synthetic fixture only; credential-like values are deterministic and non-reusable.';

export const CONTROLLED_INSTALLATION_CREDENTIAL = 'A'.repeat(43);
export const CONTROLLED_SESSION_TICKET = `${'B'.repeat(42)}A`;
export const CONTROLLED_PENDING_CREDENTIAL = `${'C'.repeat(42)}A`;
export const CONTROLLED_PAIRING_CODE = '0123456789ABCDEFGHJKMNPQRS';

export const FIXTURE_SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_ERROR_ID = '44444444-4444-4444-8444-444444444444';

export const FIXTURE_NEGOTIATION = deepFreeze({
  protocolVersion: 1,
  wearerLanguage: 'en',
  languageRegistryVersion: '1.0.0',
  gatePolicyVersion: '1.0.0',
  clientBuild: 'fixture-client-0.1.0',
  requestedLimits: DEFAULT_NEGOTIATED_LIMITS
} as const);

export const NEW_SESSION_START: SessionStart = deepFreeze({
  type: 'session.start',
  ...FIXTURE_NEGOTIATION,
  targetLanguage: 'es'
});

export const NEW_SESSION_UTTERANCE_START: UtteranceStart = deepFreeze({
  type: 'utterance.start',
  sessionId: FIXTURE_SESSION_ID,
  sessionEpoch: 1,
  utteranceId: FIXTURE_UTTERANCE_ID
});

export const NEW_SESSION_UTTERANCE_COMMIT: UtteranceCommit = deepFreeze({
  type: 'utterance.commit',
  sessionId: FIXTURE_SESSION_ID,
  sessionEpoch: 1,
  utteranceId: FIXTURE_UTTERANCE_ID,
  finalOriginalSampleOffset: 12_800
});

export const UTTERANCE_CANCEL_FIXTURE: UtteranceCancel = deepFreeze({
  type: 'utterance.cancel',
  sessionId: FIXTURE_SESSION_ID,
  sessionEpoch: 1,
  utteranceId: FIXTURE_UTTERANCE_ID,
  finalOriginalSampleOffset: 12_800
});

export const SESSION_END_FIXTURE: SessionEnd = deepFreeze({
  type: 'session.end',
  sessionId: FIXTURE_SESSION_ID,
  sessionEpoch: 1,
  reason: 'user_requested'
});

export const NEW_SESSION_READY: SessionReady = deepFreeze({
  type: 'session.ready',
  result: 'new',
  sessionId: FIXTURE_SESSION_ID,
  sessionEpoch: 1,
  targetLanguage: 'es',
  languageRegistryVersion: '1.0.0',
  gatePolicyVersion: '1.0.0',
  effectiveLimits: DEFAULT_NEGOTIATED_LIMITS,
  serverTime: '2026-08-09T12:00:00Z'
});

export const PAIRING_REDEMPTION_REQUEST: PairingRedemptionRequest = deepFreeze({
  pairingCode: CONTROLLED_PAIRING_CODE
});
export const INSTALLATION_CREDENTIAL_RESPONSE: InstallationCredentialResponse = deepFreeze({
  installationId: FIXTURE_ERROR_ID,
  credential: CONTROLLED_INSTALLATION_CREDENTIAL,
  credentialVersion: 1,
  idleExpiresAt: '2026-09-08T12:00:00Z',
  absoluteExpiresAt: '2026-11-07T12:00:00Z'
});
export const NEW_SESSION_TICKET_REQUEST: SessionTicketRequest = deepFreeze({
  protocolVersion: 1,
  intent: 'new'
});
export const SESSION_TICKET_RESPONSE: SessionTicketResponse = deepFreeze({
  ticket: CONTROLLED_SESSION_TICKET,
  wssOrigin: 'wss://relay.fixture.invalid',
  wssPath: '/v1/stream',
  protocolVersion: 1,
  expiresAt: '2026-08-09T12:01:00Z'
});
export const ROTATION_BEGIN_RESPONSE: RotationBeginResponse = deepFreeze({
  pendingCredential: CONTROLLED_PENDING_CREDENTIAL,
  pendingCredentialVersion: 2,
  pendingCredentialExpiresAt: '2026-08-09T12:05:00Z'
});
export const ROTATION_CONFIRMATION_RESPONSE: RotationConfirmationResponse = deepFreeze({
  credentialVersion: 2,
  promoted: true,
  confirmedAt: '2026-08-09T12:00:03Z',
  expiresAt: '2026-11-07T12:00:00Z'
});
export const HTTP_ERROR_RESPONSE: HttpErrorResponse = deepFreeze({
  status: 401,
  code: 'authentication_failed',
  message: 'Authentication failed.'
});

export const SESSION_REJECTION_CODES: readonly SessionRejectionCode[] = deepFreeze([
  'unsupported_protocol_version',
  'unsupported_target_language',
  'invalid_session',
  'session_conflict',
  'authentication_failed',
  'ticket_expired',
  'rate_limited',
  'state_unavailable',
  'malformed_message',
  'origin_rejected'
]);
export const SESSION_REJECTED_FIXTURES: readonly SessionRejected[] = deepFreeze(
  SESSION_REJECTION_CODES.map((code) => ({
    type: 'session.rejected' as const,
    code,
    displaySafeMessage: 'The session could not be started.'
  }))
);

export const UTTERANCE_ABORT_CATEGORIES: readonly UtteranceAbortCategory[] = deepFreeze([
  'flow',
  'duration',
  'rate',
  'cancellation',
  'stale_conflict',
  'provider_loss'
]);
export const UTTERANCE_ABORTED_FIXTURES: readonly UtteranceAborted[] = deepFreeze(
  UTTERANCE_ABORT_CATEGORIES.map((category) => ({
    type: 'utterance.aborted' as const,
    sessionId: FIXTURE_SESSION_ID,
    sessionEpoch: 1,
    utteranceId: FIXTURE_UTTERANCE_ID,
    category
  }))
);

export const AUDIO_ACK_FIXTURE: AudioAck = deepFreeze({
  type: 'audio.ack',
  sessionId: FIXTURE_SESSION_ID,
  sessionEpoch: 1,
  utteranceId: FIXTURE_UTTERANCE_ID,
  highestContiguousExclusiveOffset: 12_800,
  flowState: 'normal'
});

export const ERROR_CODES: readonly ErrorCode[] = deepFreeze([
  'malformed_message',
  'unsupported_protocol',
  'unsupported_target',
  'authentication_failed',
  'session_conflict',
  'utterance_conflict',
  'stale_result',
  'flow_control',
  'duration_limit',
  'rate_limit',
  'provider_unavailable',
  'state_unavailable',
  'internal_failure'
]);
export const ERROR_ENVELOPE_FIXTURES: readonly ErrorEnvelope[] = deepFreeze(
  ERROR_CODES.map((code) => ({
    type: 'error' as const,
    code,
    scope: 'session' as const,
    recoverable: code !== 'authentication_failed',
    displaySafeMessage: 'The request could not be completed.',
    errorId: FIXTURE_ERROR_ID,
    time: '2026-08-09T12:00:04Z'
  }))
);

export const LANGUAGE_DECISION_VALUES: readonly LanguageDecisionValue[] = deepFreeze([
  'target',
  'mixed',
  'english',
  'supported_unselected',
  'unsupported',
  'uncertain'
]);
export const LANGUAGE_DECISION_FIXTURES: readonly LanguageDecision[] = deepFreeze(
  LANGUAGE_DECISION_VALUES.map((decision) => {
    const detectedLanguage =
      decision === 'mixed'
        ? 'mixed'
        : decision === 'english'
          ? 'en'
          : decision === 'supported_unselected'
            ? 'tr'
            : decision === 'unsupported'
              ? 'fr'
              : 'es';
    return {
      type: 'language.decision' as const,
      sessionId: FIXTURE_SESSION_ID,
      sessionEpoch: 1,
      utteranceId: FIXTURE_UTTERANCE_ID,
      segmentId: `decision-${decision}`,
      revision: 1,
      decision,
      selectedTargetLanguage: 'es' as const,
      ...(decision === 'uncertain' ? {} : { detectedLanguage }),
      ...(decision === 'uncertain' ? {} : { confidence: 0.99 }),
      gatePolicyVersion: '1.0.0'
    };
  })
);

export interface ProtocolLanguageJourney {
  readonly targetLanguage: 'es' | 'tr';
  readonly transcriptPartial: TranscriptPartial;
  readonly transcriptFinal: TranscriptFinal;
  readonly languageDecision: LanguageDecision;
  readonly translationReady: TranslationReady;
  readonly suggestionsReady: SuggestionsReady;
}

const JOURNEY_TEXT = deepFreeze({
  es: {
    partial: '¿Dónde está la estación?',
    final: '¿Dónde está la estación?',
    english: 'Where is the station?',
    suggestions: [
      ['Where is the station?', '¿Dónde está la estación?'],
      ['Could you show me the station?', '¿Podría mostrarme la estación?'],
      ['How do I get to the station?', '¿Cómo llego a la estación?']
    ]
  },
  tr: {
    partial: 'İstasyon nerede?',
    final: 'İstasyon nerede?',
    english: 'Where is the station?',
    suggestions: [
      ['Where is the station?', 'İstasyon nerede?'],
      ['Could you show me the station?', 'İstasyona giden yolu gösterebilir misiniz?'],
      ['How do I get to the station?', 'İstasyona nasıl giderim?']
    ]
  }
} as const);

function createLanguageJourney(targetLanguage: 'es' | 'tr'): ProtocolLanguageJourney {
  const text = JOURNEY_TEXT[targetLanguage];
  const segmentId = `${targetLanguage}-segment-1`;
  const transcriptProperties = {
    sessionId: FIXTURE_SESSION_ID,
    sessionEpoch: 1,
    utteranceId: FIXTURE_UTTERANCE_ID,
    segmentId,
    revision: 1,
    providerEventTime: '2026-08-09T12:00:02Z'
  } as const;

  const transcriptPartial: TranscriptPartial = deepFreeze({
    type: 'transcript.partial',
    ...transcriptProperties,
    text: text.partial
  });
  const transcriptFinal: TranscriptFinal = deepFreeze({
    type: 'transcript.final',
    ...transcriptProperties,
    text: text.final
  });
  const languageDecision: LanguageDecision = deepFreeze({
    type: 'language.decision',
    sessionId: FIXTURE_SESSION_ID,
    sessionEpoch: 1,
    utteranceId: FIXTURE_UTTERANCE_ID,
    segmentId,
    revision: 1,
    decision: 'target',
    selectedTargetLanguage: targetLanguage,
    detectedLanguage: targetLanguage,
    confidence: 0.99,
    gatePolicyVersion: '1.0.0'
  });
  const translationReady: TranslationReady = deepFreeze({
    type: 'translation.ready',
    sessionId: FIXTURE_SESSION_ID,
    sessionEpoch: 1,
    utteranceId: FIXTURE_UTTERANCE_ID,
    segmentId,
    acceptedFinalRevision: 1,
    englishTranslation: text.english
  });
  const suggestionsReady: SuggestionsReady = deepFreeze({
    type: 'suggestions.ready',
    sessionId: FIXTURE_SESSION_ID,
    sessionEpoch: 1,
    utteranceId: FIXTURE_UTTERANCE_ID,
    segmentId,
    acceptedFinalRevision: 1,
    suggestions: text.suggestions.map(([englishText, selectedTargetText]) => ({
      englishText,
      selectedTargetText
    }))
  });

  return deepFreeze({
    targetLanguage,
    transcriptPartial,
    transcriptFinal,
    languageDecision,
    translationReady,
    suggestionsReady
  });
}

export const SPANISH_PROTOCOL_JOURNEY = createLanguageJourney('es');
export const TURKISH_PROTOCOL_JOURNEY = createLanguageJourney('tr');

export const PROTOCOL_CLIENT_FIXTURES: readonly ClientControlMessage[] = deepFreeze([
  NEW_SESSION_START,
  NEW_SESSION_UTTERANCE_START,
  NEW_SESSION_UTTERANCE_COMMIT,
  UTTERANCE_CANCEL_FIXTURE,
  SESSION_END_FIXTURE
]);
export const PROTOCOL_SERVER_FIXTURES: readonly ServerControlMessage[] = deepFreeze([
  NEW_SESSION_READY,
  ...SESSION_REJECTED_FIXTURES,
  ...UTTERANCE_ABORTED_FIXTURES,
  AUDIO_ACK_FIXTURE,
  SPANISH_PROTOCOL_JOURNEY.transcriptPartial,
  SPANISH_PROTOCOL_JOURNEY.transcriptFinal,
  ...LANGUAGE_DECISION_FIXTURES,
  SPANISH_PROTOCOL_JOURNEY.translationReady,
  SPANISH_PROTOCOL_JOURNEY.suggestionsReady,
  ...ERROR_ENVELOPE_FIXTURES
]);
export const PROTOCOL_SERVER_EVENTS = PROTOCOL_SERVER_FIXTURES;

export const NEW_SESSION_JOURNEY = deepFreeze({
  request: NEW_SESSION_START,
  ready: NEW_SESSION_READY,
  utteranceStart: NEW_SESSION_UTTERANCE_START,
  utteranceCommit: NEW_SESSION_UTTERANCE_COMMIT,
  results: SPANISH_PROTOCOL_JOURNEY
});

export const GOLDEN_MINIMUM_AUDIO_FRAME_INPUT: AudioFrameInput = Object.freeze({
  utteranceId: '00000000-0000-4000-8000-000000000001',
  sequence: 0,
  offset: 0,
  get payload(): Uint8Array {
    return Uint8Array.from([0x00, 0x00]);
  }
});
export const GOLDEN_MINIMUM_AUDIO_FRAME_HEX =
  '5041010000000000000040008000000000000001000000000000000000020000';
export function getGoldenMinimumAudioFrame(): Uint8Array {
  return encodeAudioFrame(GOLDEN_MINIMUM_AUDIO_FRAME_INPUT);
}

export const MAXIMUM_AUDIO_FRAME_INPUT: AudioFrameInput = Object.freeze({
  utteranceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  sequence: 4_294_967_295,
  offset: 478_400,
  get payload(): Uint8Array {
    return Uint8Array.from({ length: 3_200 }, (_unused, index) => index % 256);
  }
});
export function getMaximumAudioFrame(): Uint8Array {
  return encodeAudioFrame(MAXIMUM_AUDIO_FRAME_INPUT);
}
