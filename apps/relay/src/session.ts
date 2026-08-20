import { types as utilTypes } from 'node:util';

import {
  DEFAULT_NEGOTIATED_LIMITS,
  MAX_CONTROL_MESSAGE_BYTES,
  assertServerControlMessage,
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
  snapshotClassifiedLanguageEvidence,
  type ClassifiedLanguageEvidence,
  type LanguageGateResult,
  type TextLanguageClassifier,
  type TargetLanguage
} from '@palancar/language-registry';
import type {
  NormalizedTranscriptionEvent,
  TranscriptionSession,
  TranscriptionAdapter
} from '@palancar/transcription';
import {
  hashCorrelationKey,
  type GenerationClaim,
  type SecurityRuntimeStore,
  type SessionLease
} from '@palancar/security-state';

import { negotiateLimits } from './protocol.js';
import type {
  RelayClock,
  RelayIdGenerator,
  RelaySessionCoreOptions,
  RelayStepResult,
  RelayCloseCode,
  FinalProcessingToken,
  RelayAsyncEvent,
  RelayLanguageBoundaryMode,
  RelayMetricSink,
  RelayProductionMetricInput
} from './types.js';

function snapshotRelayClassifierEvidence(
  value: unknown
): ClassifiedLanguageEvidence {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
    throw new TypeError('Invalid classifier evidence');
  }
  return snapshotClassifiedLanguageEvidence(value);
}

const SESSION_EPOCH = 1;
const MANUAL_COMMIT_CADENCE_MS = 600;
const CONFIGURED_SERVER_VAD = 'disabled' as const;
const CONFIGURED_LANGUAGE_MODE = 'automatic' as const;
const LANGUAGE_BOUNDARY_CONFIGURATION_ERROR =
  'Invalid relay language boundary mode.';

const SAFE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  malformed_message: 'Malformed control message.',
  unsupported_protocol_version: 'Unsupported protocol version.',
  unsupported_target_language: 'Unsupported target language.',
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
  providerFailureQueued: boolean;
  lastRevision: number;
  readonly startedMonotonicMs: number | undefined;
  firstPartialLatencyRecorded: boolean;
  finalLatencyRecorded: boolean;
  languageDecisionMetricRecorded: boolean;
  terminalMetricRecorded: boolean;
  generationMetricsRecorded: boolean;
  generationStateFailure: boolean;
  providerFailureMetricRecorded: boolean;
}

interface UtteranceIdentity {
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
}

interface GenerationSecurityOperation {
  claim: GenerationClaim;
  queue: Promise<void>;
}

const TRANSCRIPTION_ADAPTER_CONFIGURATION_ERROR =
  'Invalid relay transcription adapter configuration.';

function invalidTranscriptionAdapterConfiguration(): never {
  throw new TypeError(TRANSCRIPTION_ADAPTER_CONFIGURATION_ERROR);
}

function exactLanguageBoundaryMode(value: unknown): RelayLanguageBoundaryMode {
  if (
    value === 'fixture' ||
    value === 'deny-all' ||
    value === 'production-approved' ||
    value === 'development-provisional'
  ) {
    return value;
  }
  throw new TypeError(LANGUAGE_BOUNDARY_CONFIGURATION_ERROR);
}

function isAdapterObject(value: unknown): value is TranscriptionAdapter {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactTranscriptionAdapterMap(
  value: unknown
): Readonly<Record<TargetLanguage, TranscriptionAdapter>> {
  if (!isRecord(value)) {
    return invalidTranscriptionAdapterConfiguration();
  }
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidTranscriptionAdapterConfiguration();
    }
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    return invalidTranscriptionAdapterConfiguration();
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !keys.includes('es') || !keys.includes('tr')) {
    return invalidTranscriptionAdapterConfiguration();
  }
  const spanish = descriptors.es;
  const turkish = descriptors.tr;
  if (
    spanish === undefined ||
    turkish === undefined ||
    !Object.hasOwn(spanish, 'value') ||
    !Object.hasOwn(turkish, 'value') ||
    !isAdapterObject(spanish.value) ||
    !isAdapterObject(turkish.value)
  ) {
    return invalidTranscriptionAdapterConfiguration();
  }
  return Object.freeze({ es: spanish.value, tr: turkish.value });
}

function transcriptionAdapterResolver(
  options: RelaySessionCoreOptions
): (target: TargetLanguage) => TranscriptionAdapter {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const configured = [
      ['map', descriptors.transcriptionAdapters],
      ['callback', descriptors.transcriptionAdapterForTarget],
      ['single', descriptors.transcriptionAdapter]
    ] as const;
    const present = configured.filter(([, descriptor]) => descriptor !== undefined);
    if (present.length !== 1) {
      return invalidTranscriptionAdapterConfiguration();
    }
    const selected = present[0];
    if (selected === undefined) {
      return invalidTranscriptionAdapterConfiguration();
    }
    const [kind, descriptor] = selected;
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.value === undefined
    ) {
      return invalidTranscriptionAdapterConfiguration();
    }
    const value = descriptor.value;
    if (kind === 'map') {
      const adapters = exactTranscriptionAdapterMap(value);
      return (target) => adapters[target];
    }
    if (kind === 'callback') {
      if (typeof value !== 'function') {
        return invalidTranscriptionAdapterConfiguration();
      }
      const callback = value as (target: TargetLanguage) => TranscriptionAdapter;
      return (target) => callback(target);
    }
    if (!isAdapterObject(value)) {
      return invalidTranscriptionAdapterConfiguration();
    }
    return () => value;
  } catch (error: unknown) {
    if (
      error instanceof TypeError &&
      error.message === TRANSCRIPTION_ADAPTER_CONFIGURATION_ERROR
    ) {
      throw error;
    }
    return invalidTranscriptionAdapterConfiguration();
  }
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
    left.targetTranscript === right.targetTranscript &&
    left.generationStartedMonotonicMs === right.generationStartedMonotonicMs &&
    left.generationClaim.authorizationId === right.generationClaim.authorizationId &&
    left.generationClaim.claimId === right.generationClaim.claimId &&
    left.generationClaim.claimVersion === right.generationClaim.claimVersion
  );
}

export class RelaySessionCore {
  #sessionLease: SessionLease;
  readonly #securityRuntime: SecurityRuntimeStore;
  readonly #clock: RelayClock;
  readonly #ids: RelayIdGenerator;
  readonly #transcriptionAdapterForTarget: (target: TargetLanguage) => TranscriptionAdapter;
  readonly #languageClassifier: TextLanguageClassifier;
  readonly #generationService: GenerationService;
  readonly #languageBoundaryMode: RelayLanguageBoundaryMode;
  readonly #metricSink: RelayMetricSink;
  readonly #gatePolicyVersion: string;
  readonly #serverLimits: NegotiatedLimits;
  readonly #onAsyncEventsAvailable: () => unknown;
  #opened = false;
  #ready = false;
  #terminal = false;
  #sessionId: string | undefined;
  #sessionEpoch: number | undefined;
  #selectedTargetLanguage: TargetLanguage | undefined;
  #selectedTranscriptionAdapter: TranscriptionAdapter | undefined;
  #effectiveLimits: NegotiatedLimits | undefined;
  #active: ActiveUtterance | undefined;
  #eventQueue: RelayAsyncEvent[] = [];
  #queueHead = 0;
  #terminalOverflow = false;
  #finalToken: FinalProcessingToken | undefined;
  #finalController: AbortController | undefined;
  #generationOperation: GenerationSecurityOperation | undefined;
  #generationStarted = false;
  #lastCancelled: UtteranceIdentity | undefined;
  #sessionStartMetricRecorded = false;
  #sessionRejectMetricRecorded = false;
  #sessionEndMetricRecorded = false;
  #samplingMonotonicClock = false;
  #recordingMetric = false;

  constructor(options: RelaySessionCoreOptions) {
    const languageBoundaryMode = exactLanguageBoundaryMode(options.languageBoundaryMode);
    this.#sessionLease = options.sessionLease;
    this.#securityRuntime = options.securityRuntime;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#transcriptionAdapterForTarget = transcriptionAdapterResolver(options);
    this.#languageClassifier = options.languageClassifier;
    this.#generationService = options.generationService;
    this.#languageBoundaryMode = languageBoundaryMode;
    this.#metricSink = options.metricSink;
    this.#gatePolicyVersion = options.gatePolicyVersion;
    this.#onAsyncEventsAvailable = options.onAsyncEventsAvailable ?? (() => undefined);
    this.#serverLimits = negotiateLimits(
      options.serverLimits ?? DEFAULT_NEGOTIATED_LIMITS
    );
  }

  openWithFirstText(text: string): RelayStepResult {
    if (this.#telemetryObservationActive()) {
      return this.#result([]);
    }
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

    return this.#openNewSession(parsed.message);
  }

  handleText(text: string): RelayStepResult {
    if (this.#telemetryObservationActive()) {
      return this.#result([]);
    }
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
    if (this.#telemetryObservationActive()) {
      return this.#result([]);
    }
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
      this.#recordMetric({
        name: 'audio.samples.duplicate',
        sampleCount: frame.payload.length / 2,
        operation: 'audio',
        outcome: 'duplicate'
      });
      return this.#result([
        this.#audioAck(active, accepted.highestContiguousExclusiveOffset)
      ]);
    }
    if (accepted.status === 'rejected') {
      this.#recordMetric({
        name: 'audio.samples.rejected',
        sampleCount: frame.payload.length / 2,
        operation: 'audio',
        outcome: 'rejected'
      });
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

    this.#recordMetric({
      name: 'audio.samples.accepted',
      sampleCount: accepted.chargeSamples,
      operation: 'audio',
      outcome: 'accepted'
    });

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
    if (this.#telemetryObservationActive()) {
      return this.#result([]);
    }
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

    active.lastRevision = event.revision;
    if (event.type === 'transcript.partial') {
      this.#recordFirstPartialLatency(active);
      // No target has an approved partial-display profile. Keep the provider
      // latency producer point, but do not expose text or invoke classification.
      return this.#result([]);
    }

    active.finalAccepted = true;
    this.#recordFinalLatency(active);

    if (this.#languageBoundaryMode === 'deny-all') {
      this.#recordLanguageDecision(active, 'uncertain');
      let languageDecision: ServerControlMessage;
      try {
        languageDecision = this.#languageDecision(event, 'uncertain');
      } catch {
        this.#recordUtteranceTerminal(active, 'completed');
        this.#finishActive(false);
        return this.#protocolBoundaryFailure();
      }
      this.#recordUtteranceTerminal(active, 'completed');
      this.#finishActive(false);
      return this.#result([languageDecision]);
    }

    let evidence: ClassifiedLanguageEvidence;
    try {
      evidence = snapshotRelayClassifierEvidence(
        await this.#languageClassifier.classify(
          event.text,
          this.#selectedTargetLanguage
        )
      );
    } catch {
      return this.#classifierFailure(active, event);
    }
    if (!this.#isCurrentTranscriptionEvent(active, event)) {
      return this.#result([]);
    }

    let gateResult: LanguageGateResult;
    try {
      gateResult = evaluateLanguageGate({
        selectedLanguage: this.#selectedTargetLanguage ?? 'es',
        evidence,
        isFinal: true,
        boundaryMode:
          this.#languageBoundaryMode === 'development-provisional'
            ? 'development-provisional'
            : 'production-calibrated'
      });
    } catch {
      return this.#classifierFailure(active, event);
    }
    if (!this.#isCurrentTranscriptionEvent(active, event)) {
      return this.#result([]);
    }

    const finalDecision: Exclude<LanguageDecisionValue, 'provisional'> =
      gateResult.decision === 'provisional' ? 'uncertain' : gateResult.decision;
    this.#recordLanguageDecision(active, finalDecision, evidence);
    let languageDecision: ServerControlMessage;
    try {
      languageDecision = this.#languageDecision(event, finalDecision, gateResult);
    } catch {
      this.#recordUtteranceTerminal(active, 'completed');
      this.#finishActive(false);
      return this.#protocolBoundaryFailure();
    }
    this.#recordUtteranceTerminal(active, 'completed');
    if (
      finalDecision !== 'target' ||
      !gateResult.displayAllowed ||
      !gateResult.generationAllowed
    ) {
      this.#finishActive(false);
      return this.#result([languageDecision]);
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
      this.#finishActive(false);
      return this.#result([]);
    }
    const outgoing: ServerControlMessage[] = [transcriptFinal, languageDecision];

    let generationClaim: GenerationClaim;
    try {
      const authorization = await this.#securityRuntime.authorizeGeneration({
        lease: this.#sessionLease,
        decision: 'target',
        utteranceId: event.utteranceId,
        acceptedFinalRevision: event.revision,
        selectedTargetLanguage: this.#selectedTargetLanguage ?? 'es',
        gatePolicyVersion: this.#gatePolicyVersion,
        transcriptHash: hashCorrelationKey(event.text)
      });
      if (!this.#isCurrentTranscriptionEvent(active, event)) {
        if (authorization.status === 'acquired') {
          await this.#releaseClaim(authorization.claim);
        }
        return this.#result([]);
      }
      if (authorization.status !== 'acquired') {
        this.#finishActive(false);
        return this.#result(outgoing);
      }
      const operation: GenerationSecurityOperation = {
        claim: authorization.claim,
        queue: Promise.resolve()
      };
      this.#generationOperation = operation;
      const started = await this.#runGenerationSecurityOperation(
        operation,
        (claim) => this.#securityRuntime.providerStart({ claim })
      );
      if (started.status !== 'start-permitted') {
        this.#assertMatchingGenerationClaim(operation.claim, started.claim);
        operation.claim = started.claim;
        this.#finishActive(false);
        return this.#result(outgoing);
      }
      generationClaim = started.claim;
      this.#assertMatchingGenerationClaim(operation.claim, generationClaim);
      operation.claim = generationClaim;
      this.#generationStarted = true;
    } catch {
      if (!this.#isCurrentTranscriptionEvent(active, event)) {
        return this.#result([]);
      }
      this.#recordStateStoreFailure();
      this.#finishActive(false);
      return this.#result([this.#error('state_unavailable', 'server', false)]);
    }

    const generationOperation = this.#generationOperation;
    if (generationOperation === undefined) {
      this.#recordStateStoreFailure();
      this.#finishActive(false);
      return this.#result([this.#error('state_unavailable', 'server', false)]);
    }

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
      void this.#completeGenerationSecurityOperation(
        generationOperation,
        generationClaim,
        'failed'
      ).catch(() => this.#recordStateStoreFailure());
      this.#recordProviderFailure(active, 'provider');
      outgoing.push(this.#error('provider_unavailable', 'server', true));
      this.#finishActive(false);
      return this.#result(outgoing);
    }

    try {
      active.transcription.close();
    } catch {
      // Transcription has ended at the accepted final boundary. Generation is independent.
    }

    const generationStartedMonotonicMs = this.#safeMonotonicMs();
    const token: FinalProcessingToken = {
      sessionId: event.sessionId,
      sessionEpoch: event.sessionEpoch,
      utteranceId: event.utteranceId,
      segmentId: event.segmentId,
      acceptedFinalRevision: event.revision,
      selectedTargetLanguage: this.#selectedTargetLanguage ?? 'es',
      gatePolicyVersion: this.#gatePolicyVersion,
      targetTranscript: event.text,
      generationStartedMonotonicMs,
      generationClaim
    };
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
      async (result) => {
        if (!controller.signal.aborted) {
          this.#recordGenerationOutcome(active, token, 'success');
        }
        try {
          await this.#completeGenerationSecurityOperation(
            generationOperation,
            token.generationClaim,
            'completed'
          );
          if (this.#isCurrent(active, token) && !controller.signal.aborted) {
            this.#appendAsyncEvent({ kind: 'generation.completed', token, result });
          }
        } catch {
          active.generationStateFailure = true;
          this.#recordStateStoreFailure();
          if (this.#isCurrent(active, token) && !controller.signal.aborted) {
            this.#appendAsyncEvent({ kind: 'generation.failed', token });
          }
        }
      },
      async () => {
        if (!controller.signal.aborted) {
          this.#recordGenerationOutcome(active, token, 'failure');
        }
        try {
          await this.#completeGenerationSecurityOperation(
            generationOperation,
            token.generationClaim,
            'failed'
          );
        } catch {
          active.generationStateFailure = true;
          this.#recordStateStoreFailure();
          // The public result is the same for provider and durable-state loss.
        }
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
    if (this.#telemetryObservationActive()) {
      return this.#result([]);
    }
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
    if (this.#telemetryObservationActive()) {
      return this.#result([]);
    }
    if (this.#terminal) {
      return this.#terminalResult();
    }
    return this.#terminate([], 1000, 'closed');
  }

  updateSessionLease(lease: SessionLease): void {
    if (this.#telemetryObservationActive()) {
      return;
    }
    if (
      lease.sessionId !== this.#sessionLease.sessionId ||
      lease.sessionEpoch !== this.#sessionLease.sessionEpoch ||
      lease.installationId !== this.#sessionLease.installationId
    ) {
      throw new Error('stale_session_lease');
    }
    this.#sessionLease = lease;
  }

  async heartbeatGeneration(): Promise<void> {
    if (this.#telemetryObservationActive()) {
      return;
    }
    const operation = this.#generationOperation;
    if (operation === undefined || !this.#generationStarted) {
      return;
    }
    try {
      await this.#runGenerationSecurityOperation(operation, async (claim) => {
        if (claim.phase !== 'started') return claim;
        const renewed = await this.#securityRuntime.heartbeatGeneration({ claim });
        this.#assertMatchingGenerationClaim(claim, renewed);
        operation.claim = renewed;
        return renewed;
      });
    } catch (error: unknown) {
      this.#recordStateStoreFailure();
      throw error;
    }
  }

  handleSecurityFailure(kind: 'quota' | 'state'): RelayStepResult {
    if (this.#telemetryObservationActive()) {
      return this.#result([]);
    }
    if (this.#terminal) {
      return this.#terminalResult();
    }
    const active = this.#active;
    if (kind === 'quota') {
      const outgoing = active === undefined
        ? [this.#error('flow_control', 'audio', false)]
        : [this.#aborted(this.#identity(active), 'duration')];
      return this.#terminate(outgoing, 4408, 'flow_control');
    }
    this.#recordStateStoreFailure();
    if (active !== undefined) {
      active.providerFailureMetricRecorded = true;
      return this.#providerLoss(active);
    }
    return this.#terminate(
      [this.#error('state_unavailable', 'server', false)],
      4503,
      'state_unavailable'
    );
  }

  #parsePreReady(text: string):
    | { readonly message: SessionStart }
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
    const knownClientControl =
      type === 'session.start' ||
      type === 'utterance.start' ||
      type === 'utterance.commit' ||
      type === 'utterance.cancel' ||
      type === 'session.end';
    if (knownClientControl && type !== 'session.start') {
      return {
        failure: {
          code: 'authentication_failed',
          closeCode: 4401,
          reason: 'authentication_failed'
        }
      };
    }
    if (type !== 'session.start') {
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
      return { message: assertSessionStart(parsed) };
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
    const commonFailure = this.#validateNegotiation(message);
    if (commonFailure !== undefined) {
      return this.#terminate(
        [this.#sessionRejected(commonFailure.code)],
        commonFailure.closeCode,
        commonFailure.reason
      );
    }

    this.#sessionId = this.#sessionLease.sessionId;
    this.#sessionEpoch = this.#sessionLease.sessionEpoch;
    this.#selectedTargetLanguage = message.targetLanguage;
    this.#effectiveLimits = negotiateLimits(message.requestedLimits, this.#serverLimits);
    this.#ready = true;
    const ready = assertServerControlMessage({
      type: 'session.ready',
      result: 'new',
      sessionId: this.#sessionId,
      sessionEpoch: this.#sessionLease.sessionEpoch,
      targetLanguage: message.targetLanguage,
      languageRegistryVersion: LANGUAGE_REGISTRY_VERSION,
      gatePolicyVersion: this.#gatePolicyVersion,
      effectiveLimits: this.#effectiveLimits,
      serverTime: this.#clock.nowIso()
    });
    this.#recordSessionStart();
    if (this.#sessionEpoch > SESSION_EPOCH) {
      this.#recordMetric({
        name: 'transport.reconnect',
        count: 1,
        operation: 'transport',
        outcome: 'reconnected',
        reconnectReason: 'unknown'
      });
    }
    return this.#result([ready]);
  }

  #validateNegotiation(message: SessionStart):
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
      this.#recordProviderFailure(undefined, 'transcription');
      return this.#terminate(
        [this.#error('provider_unavailable', 'server', true)],
        4503,
        'provider_unavailable'
      );
    }

    const sessionId = this.#sessionId;
    const sessionEpoch = this.#sessionEpoch;
    const limits = this.#effectiveLimits;
    if (
      sessionId === undefined ||
      sessionEpoch === undefined ||
      this.#selectedTargetLanguage === undefined ||
      limits === undefined
    ) {
      return this.#terminate(
        [this.#error('state_unavailable', 'server', true)],
        4503,
        'state_unavailable'
      );
    }

    let ownedSession: TranscriptionSession | undefined;
    let callbacksActivated = false;
    const stagedCallbacks: Array<
      | { readonly kind: 'event'; readonly event: NormalizedTranscriptionEvent }
      | { readonly kind: 'failure' }
    > = [];
    const appendEvent = (event: NormalizedTranscriptionEvent): void => {
      const active = this.#active;
      if (
        !this.#terminal &&
        ownedSession !== undefined &&
        active?.transcription === ownedSession &&
        active.utteranceId === message.utteranceId &&
        !active.providerFailureQueued
      ) {
        this.#appendAsyncEvent({ kind: 'transcription', event });
      }
    };
    const appendFailure = (): void => {
      const active = this.#active;
      if (
        !this.#terminal &&
        ownedSession !== undefined &&
        active?.transcription === ownedSession &&
        active.utteranceId === message.utteranceId &&
        !active.finalAccepted &&
        !active.providerFailureQueued
      ) {
        active.providerFailureQueued = true;
        this.#appendAsyncEvent({
          kind: 'transcription.failed',
          sessionId,
          sessionEpoch,
          utteranceId: message.utteranceId
        });
      }
    };
    const onEvent = (event: NormalizedTranscriptionEvent): void => {
      if (!callbacksActivated) {
        stagedCallbacks.push({ kind: 'event', event });
        return;
      }
      appendEvent(event);
    };
    const onFailure = (): void => {
      if (!callbacksActivated) {
        stagedCallbacks.push({ kind: 'failure' });
        return;
      }
      appendFailure();
    };
    let transcription: TranscriptionSession;
    try {
      transcription = this.#adapterForSelectedTarget().createSession({
        sessionId,
        sessionEpoch,
        configuration: {
          serverVadMode: CONFIGURED_SERVER_VAD,
          languageMode: CONFIGURED_LANGUAGE_MODE,
          manualCommitCadenceMs: MANUAL_COMMIT_CADENCE_MS
        },
        onEvent,
        onFailure,
        maxUtteranceSamples: limits.maxUtteranceSamples
      });
      ownedSession = transcription;
      const startedMonotonicMs = this.#safeMonotonicMs();
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
        providerFailureQueued: false,
        lastRevision: 0,
        startedMonotonicMs,
        firstPartialLatencyRecorded: false,
        finalLatencyRecorded: false,
        languageDecisionMetricRecorded: false,
        terminalMetricRecorded: false,
        generationMetricsRecorded: false,
        generationStateFailure: false,
        providerFailureMetricRecorded: false
      };
      callbacksActivated = true;
      for (const callback of stagedCallbacks) {
        if (callback.kind === 'event') {
          appendEvent(callback.event);
        } else {
          appendFailure();
        }
      }
      stagedCallbacks.length = 0;
      const started = transcription.start({ utteranceId: message.utteranceId });
      if (started.status !== 'started') {
        this.#recordProviderFailure(this.#active, 'transcription');
        this.#finishActive(false);
        return this.#terminate(
          [this.#error('provider_unavailable', 'server', true)],
          4503,
          'provider_unavailable'
        );
      }
      this.#recordMetric({
        name: 'utterance.start',
        count: 1,
        operation: 'utterance',
        outcome: 'success'
      });
    } catch {
      this.#recordProviderFailure(this.#active, 'transcription');
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
    switch (finalized.status) {
      case 'finalization-requested':
      case 'already-requested':
      case 'already-finalized':
        break;
      case 'already-cancelled':
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
    return this.#terminate([], 1000, 'closed');
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
      const capabilities = this.#adapterForSelectedTarget().capabilities;
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

  #adapterForSelectedTarget(): TranscriptionAdapter {
    if (this.#selectedTranscriptionAdapter !== undefined) {
      return this.#selectedTranscriptionAdapter;
    }
    if (this.#selectedTargetLanguage === undefined) {
      throw new Error('missing_selected_target');
    }
    const adapter = this.#transcriptionAdapterForTarget(this.#selectedTargetLanguage);
    this.#selectedTranscriptionAdapter = adapter;
    return adapter;
  }

  #recordMetric(
    input: Omit<RelayProductionMetricInput, 'timestamp' | 'targetLanguage'> & {
      readonly targetLanguage?: TargetLanguage;
    }
  ): void {
    if (this.#recordingMetric) return;
    this.#recordingMetric = true;
    try {
      const targetLanguage = input.targetLanguage ?? this.#selectedTargetLanguage;
      const record: RelayProductionMetricInput = Object.freeze({
        ...input,
        timestamp: this.#clock.nowIso(),
        ...(targetLanguage === undefined ? {} : { targetLanguage })
      });
      this.#metricSink.record(record);
    } catch {
      // Telemetry is observational and must never affect protocol behavior.
    } finally {
      this.#recordingMetric = false;
    }
  }

  #telemetryObservationActive(): boolean {
    return this.#samplingMonotonicClock || this.#recordingMetric;
  }

  #safeMonotonicMs(): number | undefined {
    if (this.#samplingMonotonicClock) return undefined;
    this.#samplingMonotonicClock = true;
    try {
      const value = this.#clock.nowMonotonicMs();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    } finally {
      this.#samplingMonotonicClock = false;
    }
  }

  #elapsedSince(startMonotonicMs: number | undefined): number | undefined {
    if (startMonotonicMs === undefined) return undefined;
    const endMonotonicMs = this.#safeMonotonicMs();
    if (endMonotonicMs === undefined) return undefined;
    return Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(0, Math.round(endMonotonicMs - startMonotonicMs))
    );
  }

  #recordSessionStart(): void {
    if (this.#sessionStartMetricRecorded) return;
    this.#sessionStartMetricRecorded = true;
    this.#recordMetric({
      name: 'session.start',
      count: 1,
      protocolVersion: 1,
      operation: 'session',
      outcome: 'success'
    });
  }

  #recordSessionReject(): void {
    if (this.#sessionRejectMetricRecorded) return;
    this.#sessionRejectMetricRecorded = true;
    this.#recordMetric({
      name: 'session.reject',
      count: 1,
      protocolVersion: 1,
      operation: 'session',
      outcome: 'rejected'
    });
  }

  #recordSessionEnd(): void {
    if (!this.#sessionStartMetricRecorded || this.#sessionEndMetricRecorded) return;
    this.#sessionEndMetricRecorded = true;
    this.#recordMetric({
      name: 'session.end',
      count: 1,
      protocolVersion: 1,
      operation: 'session',
      outcome: 'completed'
    });
  }

  #recordFirstPartialLatency(active: ActiveUtterance): void {
    if (active.firstPartialLatencyRecorded) return;
    active.firstPartialLatencyRecorded = true;
    const durationMs = this.#elapsedSince(active.startedMonotonicMs);
    if (durationMs === undefined) return;
    this.#recordMetric({
      name: 'transcription.first_partial_latency',
      durationMs,
      operation: 'transcription',
      outcome: 'success'
    });
  }

  #recordFinalLatency(active: ActiveUtterance): void {
    if (active.finalLatencyRecorded) return;
    active.finalLatencyRecorded = true;
    const durationMs = this.#elapsedSince(active.startedMonotonicMs);
    if (durationMs === undefined) return;
    this.#recordMetric({
      name: 'transcription.final_latency',
      durationMs,
      operation: 'transcription',
      outcome: 'success'
    });
  }

  #recordLanguageDecision(
    active: ActiveUtterance,
    gateDecision: Exclude<LanguageDecisionValue, 'provisional'>,
    evidence?: ClassifiedLanguageEvidence,
    classifierFailed = false
  ): void {
    if (active.languageDecisionMetricRecorded) return;
    active.languageDecisionMetricRecorded = true;
    const detectorError =
      classifierFailed ||
      evidence?.status === 'unavailable' ||
      (evidence?.status === 'provisional' && evidence.reason === 'DETECTOR_ERROR');
    this.#recordMetric({
      name: 'language.decision',
      count: 1,
      gateDecision,
      languageBoundaryMode: this.#languageBoundaryMode,
      ...(detectorError
        ? { languageReason: 'DETECTOR_ERROR' as const }
        : evidence?.status === 'provisional'
        ? {
            languageReason: evidence.reason,
            detectedLanguage:
              evidence.detectedLanguage === 'en' ||
              evidence.detectedLanguage === 'es' ||
              evidence.detectedLanguage === 'tr' ||
              evidence.detectedLanguage === 'mixed' ||
              evidence.detectedLanguage === 'unknown'
                ? evidence.detectedLanguage
                : 'other',
            provisionalScoreBasisPoints: Math.round(
              evidence.provisionalScore * 10_000
            )
          }
        : {}),
      operation: 'language',
      outcome: gateDecision === 'target' ? 'accepted' : 'rejected'
    });
  }

  #recordUtteranceTerminal(
    active: ActiveUtterance,
    outcome: 'completed' | 'aborted'
  ): void {
    if (active.terminalMetricRecorded) return;
    active.terminalMetricRecorded = true;
    this.#recordMetric({
      name: outcome === 'completed' ? 'utterance.complete' : 'utterance.abort',
      count: 1,
      operation: 'utterance',
      outcome
    });
  }

  #recordGenerationOutcome(
    active: ActiveUtterance,
    token: FinalProcessingToken,
    outcome: 'success' | 'failure'
  ): void {
    if (active.generationMetricsRecorded) return;
    active.generationMetricsRecorded = true;
    const durationMs = this.#elapsedSince(token.generationStartedMonotonicMs);
    if (durationMs !== undefined) {
      this.#recordMetric({
        name: 'translation.latency',
        durationMs,
        operation: 'translation',
        outcome
      });
    }
    this.#recordMetric({
      name: 'translation.result',
      count: 1,
      operation: 'translation',
      outcome
    });
    if (durationMs !== undefined) {
      this.#recordMetric({
        name: 'suggestion.latency',
        durationMs,
        operation: 'suggestion',
        outcome
      });
    }
    this.#recordMetric({
      name: 'suggestion.result',
      count: 1,
      operation: 'suggestion',
      outcome
    });
    if (outcome === 'failure') {
      this.#recordProviderFailure(active, 'provider');
    }
  }

  #recordProviderFailure(
    active: ActiveUtterance | undefined,
    operation: 'transcription' | 'provider'
  ): void {
    if (active?.providerFailureMetricRecorded) return;
    if (active !== undefined) {
      active.providerFailureMetricRecorded = true;
    }
    let provider: Readonly<{ readonly id: string; readonly version: string }> | undefined;
    try {
      if (operation === 'provider') {
        provider = this.#generationService.provider;
      } else {
        const identity = this.#selectedTranscriptionAdapter?.capabilities.identity;
        if (identity !== undefined) {
          provider = { id: identity.provider, version: identity.version };
        }
      }
    } catch {
      return;
    }
    if (provider === undefined) return;
    this.#recordMetric({
      name: 'provider.failure',
      count: 1,
      operation,
      outcome: 'failure',
      providerId: provider.id,
      providerVersion: provider.version
    });
  }

  #recordStateStoreFailure(): void {
    this.#recordMetric({
      name: 'state_store.failure',
      count: 1,
      operation: 'state_store',
      outcome: 'failure'
    });
  }

  #providerLoss(active: ActiveUtterance): RelayStepResult {
    this.#recordProviderFailure(active, 'transcription');
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
    category: 'duration' | 'cancellation' | 'stale_conflict' | 'provider_loss'
  ): ServerControlMessage {
    const active = this.#active;
    if (active !== undefined && sameIdentity(this.#identity(active), identity)) {
      this.#recordUtteranceTerminal(active, 'aborted');
    }
    return assertServerControlMessage({
      type: 'utterance.aborted',
      sessionId: identity.sessionId,
      sessionEpoch: identity.sessionEpoch,
      utteranceId: identity.utteranceId,
      category
    });
  }

  #sessionRejected(code: SessionRejected['code']): ServerControlMessage {
    this.#recordSessionReject();
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
    decision: LanguageDecisionValue,
    gateResult?: LanguageGateResult
  ): ServerControlMessage {
    const detectedLanguage = gateResult?.detectedLanguage;
    const confidence = gateResult?.confidence;
    return assertServerControlMessage({
      type: 'language.decision',
      sessionId: event.sessionId,
      sessionEpoch: event.sessionEpoch,
      utteranceId: event.utteranceId,
      segmentId: event.segmentId,
      revision: event.revision,
      decision,
      selectedTargetLanguage: this.#selectedTargetLanguage,
      ...(detectedLanguage === undefined || detectedLanguage === 'unknown'
        ? {}
        : { detectedLanguage }),
      ...(confidence === undefined ? {} : { confidence }),
      gatePolicyVersion: this.#gatePolicyVersion
    });
  }

  #classifierFailure(
    active: ActiveUtterance,
    event: NormalizedTranscriptionEvent
  ): RelayStepResult {
    if (!this.#isCurrentTranscriptionEvent(active, event)) {
      return this.#result([]);
    }
    if (event.type === 'transcript.partial') {
      return this.#result([]);
    }
    this.#recordLanguageDecision(active, 'uncertain', undefined, true);
    let decision: ServerControlMessage;
    try {
      decision = this.#languageDecision(event, 'uncertain');
    } catch {
      this.#recordUtteranceTerminal(active, 'completed');
      this.#finishActive(false);
      return this.#protocolBoundaryFailure();
    }
    this.#recordUtteranceTerminal(active, 'completed');
    this.#finishActive(false);
    return this.#result([decision]);
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
    if (event.kind === 'transcription.failed') {
      const active = this.#active;
      if (
        active === undefined ||
        active.utteranceId !== event.utteranceId ||
        this.#sessionId !== event.sessionId ||
        this.#sessionEpoch !== event.sessionEpoch ||
        !active.providerFailureQueued ||
        active.finalAccepted
      ) {
        return this.#result([]);
      }
      return this.#providerLoss(active);
    }
    if (event.kind === 'transcription') {
      return this.handleTranscriptionEvent(event.event);
    }
    const active = this.#active;
    if (!this.#isCurrent(active, event.token) || active === undefined) {
      return this.#result([]);
    }
    if (event.kind === 'generation.failed') {
      if (!active.generationStateFailure) {
        this.#recordProviderFailure(active, 'provider');
      }
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
      this.#recordProviderFailure(active, 'provider');
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
    if (this.#terminal || (this.#terminalOverflow && event.kind !== 'transcription.failed')) {
      return;
    }
    if (event.kind === 'transcription.failed') {
      this.#terminalOverflow = false;
    }
    this.#compactEventQueue();
    if (event.kind === 'transcription.failed') {
      for (let index = this.#eventQueue.length - 1; index >= this.#queueHead; index -= 1) {
        const queued = this.#eventQueue[index];
        if (
          queued?.kind === 'transcription.failed' &&
          queued.sessionId === event.sessionId &&
          queued.sessionEpoch === event.sessionEpoch &&
          queued.utteranceId === event.utteranceId
        ) {
          return;
        }
        const queuedIdentity = queued?.kind === 'transcription'
          ? queued.event
          : queued?.kind === 'generation.completed' || queued?.kind === 'generation.failed'
            ? queued.token
            : undefined;
        if (
          queuedIdentity?.sessionId === event.sessionId &&
          queuedIdentity.sessionEpoch === event.sessionEpoch &&
          queuedIdentity.utteranceId === event.utteranceId
        ) {
          this.#eventQueue.splice(index, 1);
        }
      }
    }
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
          this.#notifyAsyncEventsAvailable();
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
        this.#notifyAsyncEventsAvailable();
        return;
      }
    }
    this.#eventQueue.push(event);
    this.#notifyAsyncEventsAvailable();
  }

  #notifyAsyncEventsAvailable(): void {
    try {
      const notification = this.#onAsyncEventsAvailable();
      void Promise.resolve(notification).catch(() => undefined);
    } catch {
      // Invocation and promise assimilation are observational. Queued work
      // remains available to drain even for hostile callbacks and thenables.
    }
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

  #isCurrentTranscriptionEvent(
    active: ActiveUtterance,
    event: NormalizedTranscriptionEvent
  ): boolean {
    return (
      !this.#terminal &&
      this.#active === active &&
      this.#sessionId === event.sessionId &&
      this.#sessionEpoch === event.sessionEpoch &&
      active.utteranceId === event.utteranceId
    );
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
    const operation = this.#generationOperation;
    const claim = operation?.claim;
    const generationStarted = this.#generationStarted;
    this.#active = undefined;
    this.#finalToken = undefined;
    this.#finalController = undefined;
    this.#generationOperation = undefined;
    this.#generationStarted = false;
    this.#eventQueue = [];
    this.#queueHead = 0;
    if (active === undefined) {
      return;
    }
    if (cancel) {
      this.#recordUtteranceTerminal(active, 'aborted');
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
    if (claim !== undefined && !generationStarted && claim.phase === 'claimed') {
      if (operation !== undefined) {
        void this.#runGenerationSecurityOperation(
          operation,
          (current) => this.#releaseClaim(current)
        );
      }
    }
  }

  #sameGenerationClaimIdentity(left: GenerationClaim, right: GenerationClaim): boolean {
    return (
      left.authorizationId === right.authorizationId &&
      left.claimId === right.claimId &&
      left.installationId === right.installationId &&
      left.sessionId === right.sessionId &&
      left.sessionEpoch === right.sessionEpoch
    );
  }

  #assertMatchingGenerationClaim(expected: GenerationClaim, actual: GenerationClaim): void {
    if (!this.#sameGenerationClaimIdentity(expected, actual)) {
      throw new Error('generation_claim_identity_mismatch');
    }
  }

  #runGenerationSecurityOperation<T>(
    operation: GenerationSecurityOperation,
    action: (claim: GenerationClaim) => Promise<T>
  ): Promise<T> {
    const result = operation.queue.then(
      () => action(operation.claim),
      () => action(operation.claim)
    );
    operation.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #completeGenerationSecurityOperation(
    operation: GenerationSecurityOperation,
    expectedIdentity: GenerationClaim,
    outcome: 'completed' | 'failed'
  ): Promise<GenerationClaim> {
    return this.#runGenerationSecurityOperation(operation, async (claim) => {
      this.#assertMatchingGenerationClaim(expectedIdentity, claim);
      if (claim.phase === 'completed') return claim;
      if (claim.phase !== 'started') throw new Error('generation_claim_not_started');
      const completed = await this.#securityRuntime.completeGeneration({ claim, outcome });
      this.#assertMatchingGenerationClaim(claim, completed);
      operation.claim = completed;
      return completed;
    });
  }

  async #releaseClaim(claim: GenerationClaim): Promise<void> {
    try {
      await this.#securityRuntime.releaseGeneration({ claim });
    } catch {
      this.#recordStateStoreFailure();
      // Release is best effort; an unstarted durable claim is reclaimable by design.
    }
  }

  #terminate(
    outgoing: readonly ServerControlMessage[],
    code: RelayCloseCode,
    reason: string
  ): RelayStepResult {
    this.#terminal = true;
    this.#finishActive(true);
    this.#recordSessionEnd();
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

export type { RelaySessionCoreOptions };
