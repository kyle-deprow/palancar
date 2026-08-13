import {
  DEFAULT_NEGOTIATED_LIMITS,
  MAX_CONTROL_MESSAGE_BYTES,
  assertServerControlMessage,
  assertSessionResume,
  assertSessionStart,
  assertSessionEnd,
  assertUtteranceCancel,
  assertUtteranceCommit,
  assertUtteranceStart,
  decodeAudioFrame,
  type ErrorCode,
  type ErrorScope,
  type LanguageDecisionValue,
  type NegotiatedLimits,
  type ServerControlMessage,
  type SessionRejectionCode,
  type SessionRejected,
  type SessionResume,
  type SessionStart,
} from '@palancar/contracts';
import { RelayOrderedFrameAcceptor } from '@palancar/audio';
import {
  createAcceptedTargetTurn,
  type GenerationService,
  type GenerationCompletion
} from '@palancar/generation';
import {
  LANGUAGE_REGISTRY_VERSION,
  evaluateLanguageGate,
  type TargetLanguage
} from '@palancar/language-registry';
import type {
  NormalizedTranscriptionEvent,
  TranscriptionSession,
  TranscriptionAdapter
} from '@palancar/transcription';

import { negotiateLimits } from './protocol.js';
import type {
  ConsumedRelayTicket,
  RelayClock,
  RelayIdGenerator,
  RelaySessionCoreOptions,
  RelayStepResult,
  RelayCloseCode,
  FinalProcessingToken,
  RelayAsyncEvent
} from './types.js';

const SESSION_EPOCH = 1;
const MANUAL_COMMIT_CADENCE_MS = 600;
const CONFIGURED_SERVER_VAD = 'disabled' as const;
const CONFIGURED_LANGUAGE_MODE = 'selected-target-hint' as const;

const SAFE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  malformed_message: 'Malformed control message.',
  unsupported_protocol_version: 'Unsupported protocol version.',
  unsupported_target_language: 'Unsupported target language.',
  invalid_session: 'Session is not resumable.',
  authentication_failed: 'Authentication failed.',
  state_unavailable: 'Session state unavailable.',
  provider_unavailable: 'Provider unavailable.',
  session_conflict: 'Session conflict.',
  utterance_conflict: 'Utterance conflict.',
  flow_control: 'Audio flow control error.'
});

interface ActiveUtterance {
  readonly utteranceId: string;
  readonly acceptor: RelayOrderedFrameAcceptor;
  readonly transcription: TranscriptionSession;
  lastAcknowledgedOriginalSampleOffset: number;
  committed: boolean;
  committedFinalOriginalSampleOffset: number | undefined;
  finalAccepted: boolean;
  lastRevision: number;
}

interface UtteranceIdentity {
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      length += 1;
    } else if (code <= 0x7ff) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
      } else {
        length += 3;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      length += 3;
    } else {
      length += 3;
    }
  }
  return length;
}

function controlType(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = value.type;
  return typeof type === 'string' ? type : undefined;
}

function safeMessage(code: string): string {
  return SAFE_MESSAGES[code] ?? 'Protocol operation failed.';
}

function sameIdentity(left: UtteranceIdentity, right: UtteranceIdentity): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch &&
    left.utteranceId === right.utteranceId
  );
}

function sameFinalToken(left: FinalProcessingToken, right: FinalProcessingToken): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch &&
    left.utteranceId === right.utteranceId &&
    left.segmentId === right.segmentId &&
    left.acceptedFinalRevision === right.acceptedFinalRevision &&
    left.selectedTargetLanguage === right.selectedTargetLanguage &&
    left.gatePolicyVersion === right.gatePolicyVersion &&
    left.targetTranscript === right.targetTranscript
  );
}

export class RelaySessionCore {
  readonly #ticketClaim: ConsumedRelayTicket;
  readonly #clock: RelayClock;
  readonly #ids: RelayIdGenerator;
  readonly #transcriptionAdapter: TranscriptionAdapter;
  readonly #generationService: GenerationService;
  readonly #gatePolicyVersion: string;
  readonly #serverLimits: NegotiatedLimits;
  readonly #onAsyncEventsAvailable: () => void;
  #opened = false;
  #ready = false;
  #terminal = false;
  #sessionId: string | undefined;
  #sessionEpoch: number | undefined;
  #selectedTargetLanguage: TargetLanguage | undefined;
  #effectiveLimits: NegotiatedLimits | undefined;
  #active: ActiveUtterance | undefined;
  #eventQueue: RelayAsyncEvent[] = [];
  #queueHead = 0;
  #terminalOverflow = false;
  #finalToken: FinalProcessingToken | undefined;
  #finalController: AbortController | undefined;
  #lastCancelled: UtteranceIdentity | undefined;

  constructor(options: RelaySessionCoreOptions) {
    this.#ticketClaim = options.ticketClaim;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#transcriptionAdapter = options.transcriptionAdapter;
    this.#generationService = options.generationService;
    this.#gatePolicyVersion = options.gatePolicyVersion;
    this.#onAsyncEventsAvailable = options.onAsyncEventsAvailable ?? (() => undefined);
    this.#serverLimits = negotiateLimits(
      options.serverLimits ?? DEFAULT_NEGOTIATED_LIMITS
    );
  }

  openWithFirstText(text: string): RelayStepResult {
    if (this.#terminal) {
      return this.#terminalResult();
    }
    if (this.#opened) {
      return this.#terminate(
        [this.#error('session_conflict', 'session', false)],
        4409,
        'session_conflict'
      );
    }
    this.#opened = true;

    const parsed = this.#parsePreReady(text);
    if ('failure' in parsed) {
      return this.#terminate(
        [this.#sessionRejected(parsed.failure.code)],
        parsed.failure.closeCode,
        parsed.failure.reason
      );
    }

    if (parsed.message.type === 'session.start') {
      return this.#openNewSession(parsed.message);
    }
    return this.#openResumeSession(parsed.message);
  }

  handleText(text: string): RelayStepResult {
    if (this.#terminal) {
      return this.#terminalResult();
    }
    if (!this.#opened) {
      return this.openWithFirstText(text);
    }
    if (!this.#ready || this.#effectiveLimits === undefined) {
      return this.#terminalResult();
    }
    if (utf8ByteLength(text) > this.#effectiveLimits.maxControlMessageBytes) {
      return this.#malformedAfterReady();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return this.#malformedAfterReady();
    }

    switch (controlType(parsed)) {
      case 'utterance.start':
        try {
          return this.#handleUtteranceStart(assertUtteranceStart(parsed));
        } catch {
          return this.#malformedAfterReady();
        }
      case 'utterance.commit':
        try {
          return this.#handleUtteranceCommit(assertUtteranceCommit(parsed));
        } catch {
          return this.#malformedAfterReady();
        }
      case 'utterance.cancel':
        try {
          return this.#handleUtteranceCancel(assertUtteranceCancel(parsed));
        } catch {
          return this.#malformedAfterReady();
        }
      case 'session.end':
        try {
          return this.#handleSessionEnd(assertSessionEnd(parsed));
        } catch {
          return this.#malformedAfterReady();
        }
      default:
        return this.#malformedAfterReady();
    }
  }

  handleBinary(bytes: Uint8Array): RelayStepResult {
    if (this.#terminal) {
      return this.#terminalResult();
    }
    const active = this.#active;
    if (!this.#ready || active === undefined) {
      return this.#terminate(
        [this.#error('flow_control', 'audio', false)],
        1002,
        'protocol_error'
      );
    }
    if (
      this.#effectiveLimits !== undefined &&
      bytes.length > this.#effectiveLimits.maxBinaryMessageBytes
    ) {
      return this.#terminate(
        [this.#error('flow_control', 'audio', false)],
        1002,
        'protocol_error'
      );
    }
    if (active.committed) {
      return this.#terminate(
        [this.#error('flow_control', 'audio', false)],
        1002,
        'protocol_error'
      );
    }

    let frame: ReturnType<typeof decodeAudioFrame>;
    try {
      frame = decodeAudioFrame(bytes);
    } catch {
      return this.#terminate(
        [this.#error('flow_control', 'audio', false)],
        1002,
        'protocol_error'
      );
    }

    const accepted = active.acceptor.accept(frame);
    if (accepted.status === 'duplicate') {
      return this.#result([
        this.#audioAck(active, accepted.highestContiguousExclusiveOffset)
      ]);
    }
    if (accepted.status === 'rejected') {
      switch (accepted.reason) {
        case 'utterance-limit':
          return this.#terminate(
            [this.#aborted(this.#identity(active), 'duration')],
            4408,
            'duration_limit'
          );
        case 'payload-limit':
        case 'malformed-frame':
          return this.#terminate(
            [this.#error('flow_control', 'audio', false)],
            1002,
            'protocol_error'
          );
        case 'wrong-utterance':
        case 'conflicting-duplicate':
        case 'gap':
        case 'overlap':
        case 'stale-frame':
          return this.#terminate(
            [this.#aborted(this.#identity(active), 'stale_conflict')],
            1002,
            'protocol_error'
          );
      }
    }

    try {
      const pushed = active.transcription.pushAudio({
        utteranceId: frame.utteranceId,
        originalSampleOffset: frame.offset,
        pcm: accepted.forwardPayload
      });
      if (
        pushed.status !== 'accepted' ||
        pushed.acceptedThroughOriginalSampleOffset !==
          accepted.highestContiguousExclusiveOffset
      ) {
        return this.#providerLoss(active);
      }
    } catch {
      return this.#providerLoss(active);
    }

    if (
      accepted.highestContiguousExclusiveOffset -
        active.lastAcknowledgedOriginalSampleOffset <
      this.#ackThreshold()
    ) {
      return this.#result([]);
    }
    return this.#result([
      this.#audioAck(active, accepted.highestContiguousExclusiveOffset)
    ]);
  }

  async handleTranscriptionEvent(event: NormalizedTranscriptionEvent): Promise<RelayStepResult> {
    if (this.#terminal) {
      return this.#terminalResult();
    }
    const active = this.#active;
    const sessionId = this.#sessionId;
    const sessionEpoch = this.#sessionEpoch;
    if (
      active === undefined ||
      sessionId === undefined ||
      sessionEpoch === undefined ||
      event.sessionId !== sessionId ||
      event.sessionEpoch !== sessionEpoch ||
      event.utteranceId !== active.utteranceId ||
      active.finalAccepted ||
      !Number.isInteger(event.revision) ||
      event.revision <= active.lastRevision
    ) {
      return this.#result([]);
    }

    if (event.type === 'transcript.partial') {
      let partial: ServerControlMessage;
      try {
        partial = assertServerControlMessage({
          type: 'transcript.partial',
          sessionId: event.sessionId,
          sessionEpoch: event.sessionEpoch,
          utteranceId: event.utteranceId,
          segmentId: event.segmentId,
          revision: event.revision,
          text: event.text,
          providerEventTime: event.providerEventTime
        });
      } catch {
        return this.#result([]);
      }
      active.lastRevision = event.revision;
      return this.#result([partial]);
    }

    let transcriptFinal: ServerControlMessage;
    try {
      transcriptFinal = assertServerControlMessage({
        type: 'transcript.final',
        sessionId: event.sessionId,
        sessionEpoch: event.sessionEpoch,
        utteranceId: event.utteranceId,
        segmentId: event.segmentId,
        revision: event.revision,
        text: event.text,
        providerEventTime: event.providerEventTime
      });
    } catch {
      return this.#result([]);
    }

    active.lastRevision = event.revision;
    active.finalAccepted = true;
    let gateResult: ReturnType<typeof evaluateLanguageGate>;
    try {
      gateResult = evaluateLanguageGate({
        selectedLanguage: this.#selectedTargetLanguage ?? 'es',
        evidence: {
          text: event.text,
          detectorVersion: event.languageEvidence.detectorVersion,
          source: event.languageEvidence.source,
          ...(event.languageEvidence.detectedLanguage === undefined
            ? {}
            : { detectedLanguage: event.languageEvidence.detectedLanguage }),
          ...(event.languageEvidence.confidence === undefined
            ? {}
            : { confidence: event.languageEvidence.confidence })
        },
        isFinal: true
      });
    } catch {
      this.#finishActive(false);
      return this.#result([
        transcriptFinal,
        this.#error('provider_unavailable', 'server', true)
      ]);
    }

    const finalDecision: Exclude<LanguageDecisionValue, 'provisional'> =
      gateResult.decision === 'provisional' ? 'uncertain' : gateResult.decision;
    const languageDecision = this.#languageDecision(event, finalDecision);
    const outgoing: ServerControlMessage[] = [transcriptFinal, languageDecision];
    if (finalDecision !== 'target') {
      this.#finishActive(false);
      return this.#result(outgoing);
    }

    const token: FinalProcessingToken = {
      sessionId: event.sessionId,
      sessionEpoch: event.sessionEpoch,
      utteranceId: event.utteranceId,
      segmentId: event.segmentId,
      acceptedFinalRevision: event.revision,
      selectedTargetLanguage: this.#selectedTargetLanguage ?? 'es',
      gatePolicyVersion: this.#gatePolicyVersion,
      targetTranscript: event.text
    };

    let turn: ReturnType<typeof createAcceptedTargetTurn>;
    try {
      turn = createAcceptedTargetTurn({
        sessionId: event.sessionId,
        sessionEpoch: event.sessionEpoch,
        utteranceId: event.utteranceId,
        segmentId: event.segmentId,
        acceptedFinalRevision: event.revision,
        selectedTargetLanguage: this.#selectedTargetLanguage ?? 'es',
        decision: 'target',
        targetTranscript: event.text,
        gatePolicyVersion: this.#gatePolicyVersion
      });
    } catch {
      if (!this.#isCurrent(active, token)) {
        return this.#result(outgoing);
      }
      outgoing.push(this.#error('provider_unavailable', 'server', true));
      this.#finishActive(false);
      return this.#result(outgoing);
    }

    try {
      active.transcription.close();
    } catch {
      // Transcription has ended at the accepted final boundary. Generation is independent.
    }

    const controller = new AbortController();
    this.#finalToken = token;
    this.#finalController = controller;
    let completion: Promise<GenerationCompletion>;
    try {
      completion = this.#generationService.complete(turn, { signal: controller.signal });
    } catch {
      if (!this.#isCurrent(active, token)) {
        return this.#result(outgoing);
      }
      completion = Promise.reject(new Error('generation_start_failed'));
    }

    void completion.then(
      (result) => {
        if (this.#isCurrent(active, token) && !controller.signal.aborted) {
          this.#appendAsyncEvent({ kind: 'generation.completed', token, result });
        }
      },
      () => {
        if (this.#isCurrent(active, token) && !controller.signal.aborted) {
          this.#appendAsyncEvent({ kind: 'generation.failed', token });
        }
      }
    );
    return this.#result(outgoing);
  }

  hasPendingAsyncEvents(): boolean {
    return this.#terminalOverflow || this.#queueHead < this.#eventQueue.length;
  }

  async drainAsyncEvents(): Promise<RelayStepResult> {
    if (this.#terminal) {
      return this.#terminalResult();
    }
    if (this.#terminalOverflow) {
      this.#terminalOverflow = false;
      return this.#terminate(
        [this.#error('state_unavailable', 'server', false)],
        1011,
        'server_error'
      );
    }
    const outgoing: ServerControlMessage[] = [];
    const batchEnd = this.#eventQueue.length;
    while (this.#queueHead < batchEnd && !this.#terminal) {
      const event = this.#eventQueue[this.#queueHead];
      this.#queueHead += 1;
      if (event === undefined) {
        continue;
      }
      const result = await this.#handleAsyncEvent(event);
      outgoing.push(...result.outgoing);
      if (result.close !== undefined) {
        return this.#result(outgoing, result.close);
      }
    }
    this.#compactEventQueue();
    return this.#result(outgoing);
  }

  close(): RelayStepResult {
    if (this.#terminal) {
      return this.#terminalResult();
    }
    return this.#terminate([], 1000, 'closed');
  }

  #parsePreReady(text: string):
    | { readonly message: SessionStart | SessionResume }
    | {
        readonly failure: {
          readonly code: SessionRejectionCode;
          readonly closeCode: RelayCloseCode;
          readonly reason: string;
        };
      } {
    if (utf8ByteLength(text) > MAX_CONTROL_MESSAGE_BYTES) {
      return {
        failure: {
          code: 'malformed_message',
          closeCode: 1002,
          reason: 'protocol_error'
        }
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return {
        failure: {
          code: 'malformed_message',
          closeCode: 1002,
          reason: 'protocol_error'
        }
      };
    }

    const type = controlType(parsed);
    const expectedType =
      this.#ticketClaim.intent.intent === 'new' ? 'session.start' : 'session.resume';
    const knownClientControl =
      type === 'session.start' ||
      type === 'session.resume' ||
      type === 'utterance.start' ||
      type === 'utterance.commit' ||
      type === 'utterance.cancel' ||
      type === 'session.end';
    if (knownClientControl && type !== expectedType) {
      return {
        failure: {
          code: 'authentication_failed',
          closeCode: 4401,
          reason: 'authentication_failed'
        }
      };
    }
    if (type !== expectedType) {
      return {
        failure: {
          code: 'malformed_message',
          closeCode: 1002,
          reason: 'protocol_error'
        }
      };
    }

    if (
      isRecord(parsed) &&
      Object.hasOwn(parsed, 'protocolVersion') &&
      typeof parsed.protocolVersion === 'number' &&
      parsed.protocolVersion !== 1
    ) {
      return {
        failure: {
          code: 'unsupported_protocol_version',
          closeCode: 1002,
          reason: 'unsupported_protocol'
        }
      };
    }
    if (
      isRecord(parsed) &&
      Object.hasOwn(parsed, 'targetLanguage') &&
      typeof parsed.targetLanguage === 'string' &&
      parsed.targetLanguage !== 'es' &&
      parsed.targetLanguage !== 'tr'
    ) {
      return {
        failure: {
          code: 'unsupported_target_language',
          closeCode: 1008,
          reason: 'unsupported_target'
        }
      };
    }

    try {
      if (expectedType === 'session.start') {
        return { message: assertSessionStart(parsed) };
      }
      return { message: assertSessionResume(parsed) };
    } catch {
      return {
        failure: {
          code: 'malformed_message',
          closeCode: 1002,
          reason: 'protocol_error'
        }
      };
    }
  }

  #openNewSession(message: SessionStart): RelayStepResult {
    if (this.#ticketClaim.intent.intent !== 'new') {
      return this.#terminate(
        [this.#sessionRejected('authentication_failed')],
        4401,
        'authentication_failed'
      );
    }
    const commonFailure = this.#validateNegotiation(message);
    if (commonFailure !== undefined) {
      return this.#terminate(
        [this.#sessionRejected(commonFailure.code)],
        commonFailure.closeCode,
        commonFailure.reason
      );
    }

    this.#sessionId = this.#ids.sessionId();
    this.#sessionEpoch = SESSION_EPOCH;
    this.#selectedTargetLanguage = message.targetLanguage;
    this.#effectiveLimits = negotiateLimits(message.requestedLimits, this.#serverLimits);
    this.#ready = true;
    return this.#result([
      assertServerControlMessage({
        type: 'session.ready',
        result: 'new',
        sessionId: this.#sessionId,
        sessionEpoch: SESSION_EPOCH,
        targetLanguage: message.targetLanguage,
        languageRegistryVersion: LANGUAGE_REGISTRY_VERSION,
        gatePolicyVersion: this.#gatePolicyVersion,
        effectiveLimits: this.#effectiveLimits,
        serverTime: this.#clock.nowIso()
      })
    ]);
  }

  #openResumeSession(message: SessionResume): RelayStepResult {
    if (
      this.#ticketClaim.intent.intent !== 'resume' ||
      message.sessionId !== this.#ticketClaim.intent.sessionId
    ) {
      return this.#terminate(
        [this.#sessionRejected('authentication_failed')],
        4401,
        'authentication_failed'
      );
    }
    const commonFailure = this.#validateNegotiation(message);
    if (commonFailure !== undefined) {
      return this.#terminate(
        [this.#sessionRejected(commonFailure.code)],
        commonFailure.closeCode,
        commonFailure.reason
      );
    }

    const identity = {
      sessionId: message.sessionId,
      sessionEpoch: message.sessionEpoch,
      utteranceId: message.utteranceId
    };
    return this.#terminate(
      [this.#aborted(identity, 'non_resumable'), this.#sessionRejected('invalid_session')],
      4409,
      'session_conflict'
    );
  }

  #validateNegotiation(message: SessionStart | SessionResume):
    | {
        readonly code: 'state_unavailable';
        readonly closeCode: 4503;
        readonly reason: 'state_unavailable';
      }
    | undefined {
    if (message.languageRegistryVersion !== LANGUAGE_REGISTRY_VERSION) {
      return { code: 'state_unavailable', closeCode: 4503, reason: 'state_unavailable' };
    }
    if (message.gatePolicyVersion !== this.#gatePolicyVersion) {
      return { code: 'state_unavailable', closeCode: 4503, reason: 'state_unavailable' };
    }
    return undefined;
  }

  #handleUtteranceStart(message: ReturnType<typeof assertUtteranceStart>): RelayStepResult {
    const boundaryFailure = this.#validateBoundary(message.sessionId, message.sessionEpoch);
    if (boundaryFailure !== undefined) {
      return boundaryFailure;
    }
    const active = this.#active;
    if (active !== undefined) {
      if (active.utteranceId === message.utteranceId) {
        return this.#result([]);
      }
      return this.#terminate(
        [this.#error('utterance_conflict', 'utterance', false)],
        4409,
        'utterance_conflict'
      );
    }

    if (!this.#supportsConfiguredTranscription()) {
      return this.#terminate(
        [this.#error('provider_unavailable', 'server', true)],
        4503,
        'provider_unavailable'
      );
    }

    const sessionId = this.#sessionId;
    const sessionEpoch = this.#sessionEpoch;
    const targetLanguage = this.#selectedTargetLanguage;
    const limits = this.#effectiveLimits;
    if (
      sessionId === undefined ||
      sessionEpoch === undefined ||
      targetLanguage === undefined ||
      limits === undefined
    ) {
      return this.#terminate(
        [this.#error('state_unavailable', 'server', true)],
        4503,
        'state_unavailable'
      );
    }

    let ownedSession: TranscriptionSession | undefined;
    const onEvent = (event: NormalizedTranscriptionEvent): void => {
      if (
        !this.#terminal &&
        ownedSession !== undefined &&
        this.#active?.transcription === ownedSession &&
        this.#active.utteranceId === message.utteranceId
      ) {
        this.#appendAsyncEvent({ kind: 'transcription', event });
      }
    };
    let transcription: TranscriptionSession;
    try {
      transcription = this.#transcriptionAdapter.createSession({
        sessionId,
        sessionEpoch,
        configuration: {
          serverVadMode: CONFIGURED_SERVER_VAD,
          languageMode: CONFIGURED_LANGUAGE_MODE,
          manualCommitCadenceMs: MANUAL_COMMIT_CADENCE_MS
        },
        onEvent,
        maxUtteranceSamples: limits.maxUtteranceSamples
      });
      ownedSession = transcription;
      this.#active = {
        utteranceId: message.utteranceId,
        acceptor: new RelayOrderedFrameAcceptor(message.utteranceId, {
          maxAudioPayloadBytes: limits.maxAudioPayloadBytes,
          maxRetainedReplaySamples: limits.maxRetainedReplaySamples,
          maxUtteranceSamples: limits.maxUtteranceSamples
        }),
        transcription,
        lastAcknowledgedOriginalSampleOffset: 0,
        committed: false,
        committedFinalOriginalSampleOffset: undefined,
        finalAccepted: false,
        lastRevision: 0
      };
      const started = transcription.start({
        utteranceId: message.utteranceId,
        selectedTargetLanguage: targetLanguage
      });
      if (started.status !== 'started') {
        this.#finishActive(false);
        return this.#terminate(
          [this.#error('provider_unavailable', 'server', true)],
          4503,
          'provider_unavailable'
        );
      }
    } catch {
      this.#finishActive(false);
      return this.#terminate(
        [this.#error('provider_unavailable', 'server', true)],
        4503,
        'provider_unavailable'
      );
    }
    return this.#result([]);
  }

  #handleUtteranceCommit(message: ReturnType<typeof assertUtteranceCommit>): RelayStepResult {
    const boundaryFailure = this.#validateBoundary(message.sessionId, message.sessionEpoch);
    if (boundaryFailure !== undefined) {
      return boundaryFailure;
    }
    const active = this.#active;
    if (active === undefined || active.utteranceId !== message.utteranceId) {
      return this.#protocolBoundaryFailure();
    }
    if (active.committed) {
      if (active.committedFinalOriginalSampleOffset !== message.finalOriginalSampleOffset) {
        return this.#terminate(
          [this.#error('flow_control', 'audio', false)],
          1002,
          'protocol_error'
        );
      }
      return this.#result([
        this.#audioAck(active, message.finalOriginalSampleOffset)
      ]);
    }
    if (
      active.acceptor.state.highestContiguousExclusiveOffset !==
      message.finalOriginalSampleOffset
    ) {
      return this.#terminate(
        [this.#error('flow_control', 'audio', false)],
        1002,
        'protocol_error'
      );
    }
    let finalized: ReturnType<TranscriptionSession['finalize']>;
    try {
      finalized = active.transcription.finalize(message.utteranceId);
    } catch {
      return this.#providerLoss(active);
    }
    if (finalized.status !== 'finalized' && finalized.status !== 'already-finalized') {
      return this.#providerLoss(active);
    }
    active.committed = true;
    active.committedFinalOriginalSampleOffset = message.finalOriginalSampleOffset;
    if (
      message.finalOriginalSampleOffset <=
      active.lastAcknowledgedOriginalSampleOffset
    ) {
      return this.#result([]);
    }
    return this.#result([
      this.#audioAck(active, message.finalOriginalSampleOffset)
    ]);
  }

  #handleUtteranceCancel(message: ReturnType<typeof assertUtteranceCancel>): RelayStepResult {
    const boundaryFailure = this.#validateBoundary(message.sessionId, message.sessionEpoch);
    if (boundaryFailure !== undefined) {
      return boundaryFailure;
    }
    const active = this.#active;
    const identity = {
      sessionId: message.sessionId,
      sessionEpoch: message.sessionEpoch,
      utteranceId: message.utteranceId
    };
    if (active === undefined) {
      if (this.#lastCancelled !== undefined && sameIdentity(this.#lastCancelled, identity)) {
        return this.#result([]);
      }
      return this.#protocolBoundaryFailure();
    }
    if (active.utteranceId !== message.utteranceId) {
      return this.#protocolBoundaryFailure();
    }
    const aborted = this.#aborted(this.#identity(active), 'cancellation');
    this.#lastCancelled = identity;
    this.#finishActive(true);
    return this.#result([aborted]);
  }

  #handleSessionEnd(message: ReturnType<typeof assertSessionEnd>): RelayStepResult {
    const boundaryFailure = this.#validateBoundary(message.sessionId, message.sessionEpoch);
    if (boundaryFailure !== undefined) {
      return boundaryFailure;
    }
    this.#terminal = true;
    this.#finishActive(true);
    return this.#result([], { code: 1000, reason: 'closed' });
  }

  #validateBoundary(sessionId: string, sessionEpoch: number): RelayStepResult | undefined {
    if (sessionId !== this.#sessionId || sessionEpoch !== this.#sessionEpoch) {
      return this.#protocolBoundaryFailure();
    }
    return undefined;
  }

  #protocolBoundaryFailure(): RelayStepResult {
    return this.#terminate(
      [this.#error('malformed_message', 'message', false)],
      1002,
      'protocol_error'
    );
  }

  #malformedAfterReady(): RelayStepResult {
    return this.#terminate(
      [this.#error('malformed_message', 'message', false)],
      1002,
      'protocol_error'
    );
  }

  #supportsConfiguredTranscription(): boolean {
    try {
      const capabilities = this.#transcriptionAdapter.capabilities;
      return (
        capabilities.serverVad.supported &&
        capabilities.serverVad.modes.includes(CONFIGURED_SERVER_VAD) &&
        capabilities.languageModes.includes(CONFIGURED_LANGUAGE_MODE) &&
        capabilities.manualCommit.supported &&
        capabilities.manualCommit.cadencesMs.includes(MANUAL_COMMIT_CADENCE_MS)
      );
    } catch {
      return false;
    }
  }

  #providerLoss(active: ActiveUtterance): RelayStepResult {
    const outgoing: ServerControlMessage[] = [
      this.#aborted(this.#identity(active), 'provider_loss'),
      this.#error('provider_unavailable', 'server', true)
    ];
    return this.#terminate(outgoing, 4503, 'provider_unavailable');
  }

  #audioAck(active: ActiveUtterance, offset: number): ServerControlMessage {
    const ack = assertServerControlMessage({
      type: 'audio.ack',
      sessionId: this.#sessionId,
      sessionEpoch: this.#sessionEpoch,
      utteranceId: active.utteranceId,
      highestContiguousExclusiveOffset: offset,
      flowState: 'normal'
    });
    active.lastAcknowledgedOriginalSampleOffset = offset;
    return ack;
  }

  #ackThreshold(): number {
    const limits = this.#effectiveLimits;
    if (limits === undefined) {
      return 1;
    }
    return Math.max(
      1,
      Math.min(
        16 * limits.ackIntervalMs,
        limits.maxRetainedReplaySamples,
        limits.maxUnacknowledgedSamples
      )
    );
  }

  #identity(active: ActiveUtterance): UtteranceIdentity {
    return {
      sessionId: this.#sessionId ?? '',
      sessionEpoch: this.#sessionEpoch ?? SESSION_EPOCH,
      utteranceId: active.utteranceId
    };
  }

  #aborted(
    identity: UtteranceIdentity,
    category: 'non_resumable' | 'duration' | 'cancellation' | 'stale_conflict' | 'provider_loss'
  ): ServerControlMessage {
    return assertServerControlMessage({
      type: 'utterance.aborted',
      sessionId: identity.sessionId,
      sessionEpoch: identity.sessionEpoch,
      utteranceId: identity.utteranceId,
      category
    });
  }

  #sessionRejected(code: SessionRejected['code']): ServerControlMessage {
    return assertServerControlMessage({
      type: 'session.rejected',
      code,
      displaySafeMessage: safeMessage(code)
    });
  }

  #error(code: ErrorCode, scope: ErrorScope, recoverable: boolean): ServerControlMessage {
    return assertServerControlMessage({
      type: 'error',
      code,
      scope,
      recoverable,
      displaySafeMessage: safeMessage(code),
      errorId: this.#ids.errorId(),
      time: this.#clock.nowIso()
    });
  }

  #languageDecision(
    event: Extract<NormalizedTranscriptionEvent, { readonly type: 'transcript.final' }>,
    decision: LanguageDecisionValue
  ): ServerControlMessage {
    const detectedLanguage = event.languageEvidence.detectedLanguage;
    const confidence = event.languageEvidence.confidence;
    return assertServerControlMessage({
      type: 'language.decision',
      sessionId: event.sessionId,
      sessionEpoch: event.sessionEpoch,
      utteranceId: event.utteranceId,
      segmentId: event.segmentId,
      revision: event.revision,
      decision,
      selectedTargetLanguage: this.#selectedTargetLanguage,
      ...(detectedLanguage === undefined ? {} : { detectedLanguage }),
      ...(confidence === undefined ? {} : { confidence }),
      gatePolicyVersion: this.#gatePolicyVersion
    });
  }

  #translationReady(translation: GenerationCompletion): ServerControlMessage {
    return assertServerControlMessage({
      type: 'translation.ready',
      sessionId: translation.sessionId,
      sessionEpoch: translation.sessionEpoch,
      utteranceId: translation.utteranceId,
      segmentId: translation.segmentId,
      acceptedFinalRevision: translation.acceptedFinalRevision,
      englishTranslation: translation.englishTranslation
    });
  }

  #suggestionsReady(suggestions: GenerationCompletion): ServerControlMessage {
    return assertServerControlMessage({
      type: 'suggestions.ready',
      sessionId: suggestions.sessionId,
      sessionEpoch: suggestions.sessionEpoch,
      utteranceId: suggestions.utteranceId,
      segmentId: suggestions.segmentId,
      acceptedFinalRevision: suggestions.acceptedFinalRevision,
      suggestions: suggestions.suggestions
    });
  }

  async #handleAsyncEvent(event: RelayAsyncEvent): Promise<RelayStepResult> {
    if (event.kind === 'transcription') {
      return this.handleTranscriptionEvent(event.event);
    }
    if (!this.#isCurrent(this.#active, event.token)) {
      return this.#result([]);
    }
    if (event.kind === 'generation.failed') {
      const outgoing = [this.#error('provider_unavailable', 'server', true)];
      this.#finishActive(false);
      return this.#result(outgoing);
    }

    let translation: ServerControlMessage;
    let suggestions: ServerControlMessage;
    try {
      translation = this.#translationReady(event.result);
      suggestions = this.#suggestionsReady(event.result);
    } catch {
      // The result is all-or-nothing: do not emit either generated event.
      const outgoing = [this.#error('provider_unavailable', 'server', true)];
      this.#finishActive(false);
      return this.#result(outgoing);
    }
    this.#finishActive(false);
    return this.#result([translation, suggestions]);
  }

  #queueLength(): number {
    return this.#eventQueue.length - this.#queueHead;
  }

  #appendAsyncEvent(event: RelayAsyncEvent): void {
    if (this.#terminal || this.#terminalOverflow) {
      return;
    }
    this.#compactEventQueue();
    if (event.kind === 'transcription' && event.event.type === 'transcript.partial') {
      for (let index = this.#queueHead; index < this.#eventQueue.length; index += 1) {
        const queued = this.#eventQueue[index];
        if (
          queued?.kind === 'transcription' &&
          queued.event.type === 'transcript.partial' &&
          queued.event.sessionId === event.event.sessionId &&
          queued.event.sessionEpoch === event.event.sessionEpoch &&
          queued.event.utteranceId === event.event.utteranceId &&
          queued.event.segmentId === event.event.segmentId
        ) {
          this.#eventQueue.splice(index, 1);
          this.#eventQueue.push(event);
          this.#onAsyncEventsAvailable();
          return;
        }
      }
    }

    if (this.#queueLength() >= 64) {
      let partialIndex = -1;
      for (let index = this.#queueHead; index < this.#eventQueue.length; index += 1) {
        const queued = this.#eventQueue[index];
        if (queued?.kind === 'transcription' && queued.event.type === 'transcript.partial') {
          partialIndex = index;
          break;
        }
      }
      if (partialIndex >= 0) {
        this.#eventQueue.splice(partialIndex, 1);
      } else if (event.kind === 'transcription' && event.event.type === 'transcript.partial') {
        return;
      } else {
        this.#terminalOverflow = true;
        this.#abortPendingGeneration();
        this.#onAsyncEventsAvailable();
        return;
      }
    }
    this.#eventQueue.push(event);
    this.#onAsyncEventsAvailable();
  }

  #compactEventQueue(): void {
    if (this.#queueHead === 0) {
      return;
    }
    if (this.#queueHead >= this.#eventQueue.length) {
      this.#eventQueue = [];
      this.#queueHead = 0;
      return;
    }
    if (this.#queueHead >= 32 || this.#queueHead * 2 >= this.#eventQueue.length) {
      this.#eventQueue = this.#eventQueue.slice(this.#queueHead);
      this.#queueHead = 0;
    }
  }

  #abortPendingGeneration(): void {
    const controller = this.#finalController;
    if (controller !== undefined && !controller.signal.aborted) {
      controller.abort();
    }
  }

  #isCurrent(active: ActiveUtterance | undefined, token: FinalProcessingToken): boolean {
    return (
      !this.#terminal &&
      active !== undefined &&
      this.#active === active &&
      this.#finalToken !== undefined &&
      sameFinalToken(this.#finalToken, token)
    );
  }

  #finishActive(cancel: boolean): void {
    const active = this.#active;
    this.#abortPendingGeneration();
    this.#active = undefined;
    this.#finalToken = undefined;
    this.#finalController = undefined;
    this.#eventQueue = [];
    this.#queueHead = 0;
    if (active === undefined) {
      return;
    }
    if (cancel) {
      try {
        active.transcription.cancel(active.utteranceId);
      } catch {
        // Provider cleanup is best effort and public errors are intentionally generic.
      }
    }
    try {
      active.transcription.close();
    } catch {
      // Provider cleanup is best effort and public errors are intentionally generic.
    }
  }

  #terminate(
    outgoing: readonly ServerControlMessage[],
    code: RelayCloseCode,
    reason: string
  ): RelayStepResult {
    this.#terminal = true;
    this.#finishActive(true);
    return this.#result(outgoing, { code, reason });
  }

  #result(
    outgoing: readonly ServerControlMessage[],
    close?: Readonly<{ readonly code: RelayCloseCode; readonly reason: string }>
  ): RelayStepResult {
    const validated = Object.freeze(outgoing.map((message) => assertServerControlMessage(message)));
    if (close === undefined) {
      return { outgoing: validated };
    }
    return { outgoing: validated, close };
  }

  #terminalResult(): RelayStepResult {
    return { outgoing: [], close: { code: 1000, reason: 'closed' } };
  }
}

export type { ConsumedRelayTicket, RelaySessionCoreOptions };
