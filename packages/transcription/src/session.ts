import { IdentityAudioResampler } from '@palancar/audio';
import {
  LANGUAGE_CODE_PATTERN,
  MAX_UTTERANCE_SAMPLES,
  UUID_PATTERN,
  assertTranscriptFinal,
  assertTranscriptPartial
} from '@palancar/contracts';
import { TranscriptionSessionError } from './errors.js';
import {
  DETERMINISTIC_MOCK_CAPABILITIES,
  createDeterministicMockScript,
  validateDeterministicMockAdapterConfiguration,
  type DeterministicMockScript,
  type DeterministicMockTranscriptionAdapterConfiguration
} from './mock.js';
import {
  validateTranscriptionSessionConfiguration
} from './configuration.js';
export {
  validateTranscriptionSessionConfiguration
} from './configuration.js';
export { isIso6391LanguageCode } from './types.js';
import type {
  CancelResult,
  CloseResult,
  CreateTranscriptionSessionInput,
  EventDeliveryFailureStatus,
  FinalizeResult,
  NormalizedLanguageEvidence,
  NormalizedTranscriptionEvent,
  NormalizedTranscriptionFinal,
  NormalizedTranscriptionPartial,
  PushAudioInput,
  PushAudioResult,
  StartUtteranceInput,
  StartUtteranceResult,
  TranscriptionAdapter,
  TranscriptionFinalizationReason,
  TranscriptionReadiness,
  TranscriptionSession,
  TranscriptionSessionConfiguration,
  TranscriptionSessionState
} from './types.js';

const UUID_V4 = new RegExp(UUID_PATTERN);
const LANGUAGE_CODE = new RegExp(LANGUAGE_CODE_PATTERN);
const DETECTOR_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const BASE_EVENT_TIME_MS = Date.parse('2026-08-10T00:00:00.000Z');
const PARTIAL_EVENT_KEYS = new Set([
  'type',
  'sessionId',
  'sessionEpoch',
  'utteranceId',
  'segmentId',
  'revision',
  'text',
  'providerEventTime',
  'languageEvidence',
  'acceptedThroughOriginalSampleOffset'
]);
const FINAL_EVENT_KEYS = new Set([...PARTIAL_EVENT_KEYS, 'finalizationReason']);
const LANGUAGE_EVIDENCE_KEYS = new Set([
  'detectedLanguage',
  'confidence',
  'detectorVersion',
  'source'
]);
const LANGUAGE_EVIDENCE_SOURCES = new Set([
  'transcription-metadata',
  'text-classifier',
  'controlled-fixture'
]);
const FINALIZATION_REASONS = new Set(['explicit', 'script-threshold']);

function fail(
  reason: ConstructorParameters<typeof TranscriptionSessionError>[0],
  message: string
): never {
  throw new TranscriptionSessionError(reason, message);
}

function assertUuid(value: string, label: string): void {
  if (!UUID_V4.test(value)) {
    fail('invalid-identifier', `${label} must be a canonical UUID`);
  }
}

function assertSessionEpoch(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 4_294_967_295) {
    fail('invalid-identifier', 'Session epoch must be a positive unsigned 32-bit integer');
  }
}

function eventTime(revision: number): string {
  return new Date(BASE_EVENT_TIME_MS + revision).toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function validateDeterministicMockSessionConfiguration(
  configuration: Readonly<TranscriptionSessionConfiguration>
): void {
  if (!DETERMINISTIC_MOCK_CAPABILITIES.serverVad.modes.includes(configuration.serverVadMode)) {
    throw new RangeError('Unsupported deterministic mock server VAD mode');
  }
  if (!DETERMINISTIC_MOCK_CAPABILITIES.languageModes.includes(configuration.languageMode)) {
    throw new RangeError('Unsupported deterministic mock language mode');
  }
  if (!DETERMINISTIC_MOCK_CAPABILITIES.manualCommit.cadencesMs.includes(
    configuration.manualCommitCadenceMs
  )) {
    throw new RangeError('Unsupported deterministic mock commit cadence');
  }
}

function copyLanguageEvidence(input: unknown): Readonly<NormalizedLanguageEvidence> {
  if (!isPlainObject(input)) {
    fail('stale-revision', 'Provider event has invalid language evidence');
  }
  const keys = Object.keys(input);
  if (
    keys.some((key) => !LANGUAGE_EVIDENCE_KEYS.has(key)) ||
    !keys.includes('detectorVersion') ||
    !keys.includes('source')
  ) {
    fail('stale-revision', 'Provider event has invalid language evidence fields');
  }
  const detectorVersion = input.detectorVersion;
  const source = input.source;
  const detectedLanguage = input.detectedLanguage;
  const confidence = input.confidence;
  if (
    typeof detectorVersion !== 'string' ||
    !DETECTOR_VERSION_PATTERN.test(detectorVersion) ||
    typeof source !== 'string' ||
    !LANGUAGE_EVIDENCE_SOURCES.has(source) ||
    (detectedLanguage !== undefined &&
      (typeof detectedLanguage !== 'string' ||
        detectedLanguage.length > 35 ||
        !LANGUAGE_CODE.test(detectedLanguage))) ||
    (confidence !== undefined &&
      (typeof confidence !== 'number' ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1))
  ) {
    fail('stale-revision', 'Provider event has invalid language evidence values');
  }
  return Object.freeze({
    detectorVersion,
    source: source as NormalizedLanguageEvidence['source'],
    ...(detectedLanguage === undefined ? {} : { detectedLanguage }),
    ...(confidence === undefined ? {} : { confidence })
  });
}

export class NormalizedEventSequence {
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
  #segmentId: string | undefined;
  #lastRevision = 0;
  #lastAcceptedOffset = 0;
  #acceptedHighWaterMark = 0;
  #terminal = false;

  constructor(sessionId: string, sessionEpoch: number, utteranceId: string) {
    assertUuid(sessionId, 'Session ID');
    assertSessionEpoch(sessionEpoch);
    assertUuid(utteranceId, 'Utterance ID');
    this.sessionId = sessionId;
    this.sessionEpoch = sessionEpoch;
    this.utteranceId = utteranceId;
  }

  advanceAcceptedHighWaterMark(offset: number): void {
    if (
      !Number.isInteger(offset) ||
      offset < this.#acceptedHighWaterMark ||
      offset > MAX_UTTERANCE_SAMPLES
    ) {
      fail('stale-revision', 'Invalid original-input high-water mark');
    }
    this.#acceptedHighWaterMark = offset;
  }

  accept<T extends NormalizedTranscriptionEvent>(event: T): T {
    if (!isPlainObject(event)) {
      fail('stale-revision', 'Provider event must be a plain object');
    }
    const type = event.type;
    const allowedKeys = type === 'transcript.partial'
      ? PARTIAL_EVENT_KEYS
      : type === 'transcript.final'
        ? FINAL_EVENT_KEYS
        : undefined;
    if (allowedKeys === undefined || !hasExactKeys(event, allowedKeys)) {
      fail('stale-revision', 'Provider event has unknown or missing fields');
    }
    const languageEvidence = copyLanguageEvidence(event.languageEvidence);
    const base = {
      type,
      sessionId: event.sessionId,
      sessionEpoch: event.sessionEpoch,
      utteranceId: event.utteranceId,
      segmentId: event.segmentId,
      revision: event.revision,
      text: event.text,
      providerEventTime: event.providerEventTime
    };
    if (type === 'transcript.partial') {
      assertTranscriptPartial(base);
    } else {
      assertTranscriptFinal(base);
    }

    if (
      event.sessionId !== this.sessionId ||
      event.sessionEpoch !== this.sessionEpoch ||
      event.utteranceId !== this.utteranceId
    ) {
      fail('stale-revision', 'Provider event belongs to another session or utterance');
    }
    const acceptedOffset = event.acceptedThroughOriginalSampleOffset;
    if (
      !Number.isInteger(acceptedOffset) ||
      acceptedOffset < this.#lastAcceptedOffset ||
      acceptedOffset > this.#acceptedHighWaterMark
    ) {
      fail('stale-revision', 'Provider event original sample offset is invalid or regressed');
    }
    if (this.#terminal || event.revision <= this.#lastRevision) {
      fail('stale-revision', 'Provider event revision is stale');
    }
    if (this.#segmentId !== undefined && event.segmentId !== this.#segmentId) {
      fail('stale-revision', 'Provider event changed its stable segment ID');
    }
    if (
      type === 'transcript.final' &&
      !FINALIZATION_REASONS.has(event.finalizationReason)
    ) {
      fail('stale-revision', 'Provider event has an invalid finalization reason');
    }

    const copy = Object.freeze({
      ...base,
      languageEvidence,
      acceptedThroughOriginalSampleOffset: acceptedOffset,
      ...(type === 'transcript.final'
        ? { finalizationReason: event.finalizationReason }
        : {})
    }) as T;
    this.#segmentId = event.segmentId;
    this.#lastRevision = event.revision;
    this.#lastAcceptedOffset = acceptedOffset;
    if (type === 'transcript.final') {
      this.#terminal = true;
    }
    return copy;
  }

  cancel(): void {
    this.#terminal = true;
  }
}

interface ActiveUtterance {
  readonly input: StartUtteranceInput;
  readonly script: Readonly<DeterministicMockScript>;
  readonly segmentId: string;
  readonly sequence: NormalizedEventSequence;
  acceptedThroughOriginalSampleOffset: number;
  nextPartialIndex: number;
  revision: number;
}

type TerminalUtterance =
  | { readonly status: 'cancelled' }
  | { readonly status: 'finalized' };

export class DeterministicMockTranscriptionSession implements TranscriptionSession {
  readonly capabilities: typeof DETERMINISTIC_MOCK_CAPABILITIES;
  readonly configuration: Readonly<TranscriptionSessionConfiguration>;
  readonly #sessionId: string;
  readonly #sessionEpoch: number;
  readonly #onEvent: (event: NormalizedTranscriptionEvent) => void;
  readonly #onDeliveryFailure:
    | ((status: Readonly<EventDeliveryFailureStatus>) => void)
    | undefined;
  readonly #resampler: IdentityAudioResampler;
  readonly #maxUtteranceSamples: number;
  readonly #terminalByUtterance: Map<string, TerminalUtterance>;
  #active: ActiveUtterance | undefined;
  #closed: boolean;
  #audioStateEpoch: number;
  #deliveryFailureCount: number;
  #lastDeliveryFailure:
    | { readonly eventType: NormalizedTranscriptionEvent['type']; readonly revision: number }
    | undefined;
  readonly #mockConfiguration: Readonly<DeterministicMockTranscriptionAdapterConfiguration>;

  constructor(
    input: CreateTranscriptionSessionInput,
    mockConfiguration: Readonly<DeterministicMockTranscriptionAdapterConfiguration>
  ) {
    const validatedMockConfiguration = Object.freeze({
      ...validateDeterministicMockAdapterConfiguration(mockConfiguration)
    });
    assertUuid(input.sessionId, 'Session ID');
    assertSessionEpoch(input.sessionEpoch);
    if (typeof input.onEvent !== 'function') {
      throw new TypeError('Transcription event callback must be a function');
    }
    if (typeof input.onFailure !== 'function') {
      throw new TypeError('Transcription failure callback must be a function');
    }
    if (input.onDeliveryFailure !== undefined && typeof input.onDeliveryFailure !== 'function') {
      throw new TypeError('Delivery-failure callback must be a function');
    }
    const maxUtteranceSamples = input.maxUtteranceSamples ?? MAX_UTTERANCE_SAMPLES;
    if (
      !Number.isInteger(maxUtteranceSamples) ||
      maxUtteranceSamples < 1 ||
      maxUtteranceSamples > MAX_UTTERANCE_SAMPLES
    ) {
      throw new RangeError('Invalid effective utterance sample limit');
    }

    this.capabilities = DETERMINISTIC_MOCK_CAPABILITIES;
    this.#sessionId = input.sessionId;
    this.#sessionEpoch = input.sessionEpoch;
    this.#mockConfiguration = validatedMockConfiguration;
    const configuration = validateTranscriptionSessionConfiguration(input.configuration);
    validateDeterministicMockSessionConfiguration(configuration);
    this.configuration = configuration;
    this.#onEvent = input.onEvent;
    this.#onDeliveryFailure = input.onDeliveryFailure;
    this.#resampler = new IdentityAudioResampler(16_000);
    this.#maxUtteranceSamples = maxUtteranceSamples;
    this.#terminalByUtterance = new Map<string, TerminalUtterance>();
    this.#active = undefined;
    this.#closed = false;
    this.#audioStateEpoch = 0;
    this.#deliveryFailureCount = 0;
    this.#lastDeliveryFailure = undefined;
  }

  get state(): Readonly<TranscriptionSessionState> {
    return Object.freeze({
      closed: this.#closed,
      connectionState: this.#closed
        ? 'closed'
        : this.#active === undefined
          ? 'idle'
          : 'ready',
      finalizationRequested: false,
      ...(this.#active === undefined
        ? {}
        : { activeUtteranceId: this.#active.input.utteranceId }),
      acceptedThroughOriginalSampleOffset:
        this.#active?.acceptedThroughOriginalSampleOffset ?? 0,
      audioStateEpoch: this.#audioStateEpoch
    });
  }

  get deliveryFailures(): Readonly<EventDeliveryFailureStatus> {
    return Object.freeze({
      failureCount: this.#deliveryFailureCount,
      ...(this.#lastDeliveryFailure === undefined
        ? {}
        : { lastFailure: Object.freeze({ ...this.#lastDeliveryFailure }) })
    });
  }

  start(input: StartUtteranceInput): StartUtteranceResult {
    this.#assertOpen();
    assertUuid(input.utteranceId, 'Utterance ID');
    const active = this.#active;
    if (active !== undefined) {
      if (active.input.utteranceId === input.utteranceId) {
        return Object.freeze({ status: 'already-active' });
      }
      fail('active-utterance', 'A different utterance is already active');
    }
    if (this.#terminalByUtterance.has(input.utteranceId)) {
      fail('stale-utterance', 'Utterance IDs cannot be reused');
    }

    this.#resetAudioState();
    this.#active = {
      input: Object.freeze({ ...input }),
      script: createDeterministicMockScript(
        this.#mockConfiguration.fixtureTargetLanguage ?? 'es',
        this.#mockConfiguration.evidenceCategory,
        {
          languageMode: this.configuration.languageMode,
          manualCommitCadenceMs: this.configuration.manualCommitCadenceMs,
          maxUtteranceSamples: this.#maxUtteranceSamples
        }
      ),
      segmentId: `${input.utteranceId}:0`,
      sequence: new NormalizedEventSequence(
        this.#sessionId,
        this.#sessionEpoch,
        input.utteranceId
      ),
      acceptedThroughOriginalSampleOffset: 0,
      nextPartialIndex: 0,
      revision: 0
    };
    return Object.freeze({ status: 'started' });
  }

  pushAudio(input: PushAudioInput): PushAudioResult {
    this.#assertOpen();
    const active = this.#activeFor(input.utteranceId);
    if (
      !(input.pcm instanceof Uint8Array) ||
      input.pcm.byteLength === 0 ||
      input.pcm.byteLength % 2 !== 0
    ) {
      fail('invalid-audio', 'PCM must be a non-empty even-length Uint8Array');
    }
    if (!Number.isInteger(input.originalSampleOffset) || input.originalSampleOffset < 0) {
      fail('invalid-audio', 'Original sample offset must be a non-negative integer');
    }
    if (input.originalSampleOffset < active.acceptedThroughOriginalSampleOffset) {
      fail('overlap', 'PCM overlaps already accepted original samples');
    }
    if (input.originalSampleOffset > active.acceptedThroughOriginalSampleOffset) {
      fail('gap', 'PCM leaves a gap in original samples');
    }

    const acceptedSamples = input.pcm.byteLength / 2;
    const nextOffset = input.originalSampleOffset + acceptedSamples;
    if (nextOffset > this.#maxUtteranceSamples) {
      fail('utterance-overflow', 'PCM exceeds the effective utterance limit');
    }

    this.#resampler.push(new Uint8Array(input.pcm));
    active.acceptedThroughOriginalSampleOffset = nextOffset;
    active.sequence.advanceAcceptedHighWaterMark(nextOffset);
    this.#emitDueEvents(active);
    return Object.freeze({
      status: 'accepted',
      acceptedSamples,
      acceptedThroughOriginalSampleOffset: nextOffset
    });
  }

  finalize(utteranceId: string): FinalizeResult {
    this.#assertOpen();
    assertUuid(utteranceId, 'Utterance ID');
    const terminal = this.#terminalByUtterance.get(utteranceId);
    if (terminal?.status === 'finalized') {
      return Object.freeze({ status: 'already-finalized' });
    }
    if (terminal?.status === 'cancelled') {
      return Object.freeze({ status: 'already-cancelled' });
    }
    this.#finish(this.#activeFor(utteranceId), 'explicit');
    return Object.freeze({ status: 'finalization-requested' });
  }

  cancel(utteranceId: string): CancelResult {
    this.#assertOpen();
    assertUuid(utteranceId, 'Utterance ID');
    const terminal = this.#terminalByUtterance.get(utteranceId);
    if (terminal?.status === 'cancelled') {
      return Object.freeze({ status: 'already-cancelled' });
    }
    if (terminal?.status === 'finalized') {
      return Object.freeze({ status: 'already-finalized' });
    }

    const active = this.#activeFor(utteranceId);
    active.sequence.cancel();
    this.#terminalByUtterance.set(utteranceId, { status: 'cancelled' });
    this.#active = undefined;
    this.#resetAudioState();
    return Object.freeze({ status: 'cancelled' });
  }

  close(): CloseResult {
    if (this.#closed) {
      return Object.freeze({ status: 'already-closed' });
    }
    this.#closed = true;
    if (this.#active !== undefined) {
      this.#active.sequence.cancel();
      this.#terminalByUtterance.set(this.#active.input.utteranceId, {
        status: 'cancelled'
      });
      this.#active = undefined;
    }
    this.#resetAudioState();
    return Object.freeze({ status: 'closed' });
  }

  #assertOpen(): void {
    if (this.#closed) {
      fail('closed', 'Transcription session is closed');
    }
  }

  #activeFor(utteranceId: string): ActiveUtterance {
    assertUuid(utteranceId, 'Utterance ID');
    const active = this.#active;
    if (active === undefined) {
      fail(
        this.#terminalByUtterance.has(utteranceId)
          ? 'stale-utterance'
          : 'no-active-utterance',
        'No matching active utterance'
      );
    }
    if (active.input.utteranceId !== utteranceId) {
      fail('wrong-utterance', 'Operation targets a different utterance');
    }
    return active;
  }

  #emitDueEvents(active: ActiveUtterance): void {
    while (active.nextPartialIndex < active.script.partials.length) {
      const partial = active.script.partials[active.nextPartialIndex];
      if (
        partial === undefined ||
        active.acceptedThroughOriginalSampleOffset < partial.atAcceptedSamples
      ) {
        break;
      }
      active.nextPartialIndex += 1;
      this.#emit(active, this.#partial(active, partial.text));
      if (this.#active !== active || this.#closed) {
        return;
      }
    }
    if (
      this.configuration.serverVadMode === 'enabled' &&
      active.acceptedThroughOriginalSampleOffset >= active.script.final.atAcceptedSamples
    ) {
      this.#finish(active, 'script-threshold');
    }
  }

  #partial(active: ActiveUtterance, text: string): NormalizedTranscriptionPartial {
    active.revision += 1;
    return {
      type: 'transcript.partial',
      sessionId: this.#sessionId,
      sessionEpoch: this.#sessionEpoch,
      utteranceId: active.input.utteranceId,
      segmentId: active.segmentId,
      revision: active.revision,
      text,
      providerEventTime: eventTime(active.revision),
      languageEvidence: { ...active.script.languageEvidence },
      acceptedThroughOriginalSampleOffset:
        active.acceptedThroughOriginalSampleOffset
    };
  }

  #finish(
    active: ActiveUtterance,
    finalizationReason: TranscriptionFinalizationReason
  ): NormalizedTranscriptionFinal {
    active.revision += 1;
    const event = active.sequence.accept({
      type: 'transcript.final',
      sessionId: this.#sessionId,
      sessionEpoch: this.#sessionEpoch,
      utteranceId: active.input.utteranceId,
      segmentId: active.segmentId,
      revision: active.revision,
      text: active.script.final.text,
      providerEventTime: eventTime(active.revision),
      languageEvidence: { ...active.script.languageEvidence },
      acceptedThroughOriginalSampleOffset:
        active.acceptedThroughOriginalSampleOffset,
      finalizationReason
    });
    this.#terminalByUtterance.set(active.input.utteranceId, {
      status: 'finalized'
    });
    this.#active = undefined;
    this.#resampler.flush();
    this.#resetAudioState();
    this.#deliver(event);
    return event;
  }

  #emit(active: ActiveUtterance, event: NormalizedTranscriptionPartial): void {
    const normalized = active.sequence.accept(event);
    if (!this.#closed && this.#active === active) {
      this.#deliver(normalized);
    }
  }

  #resetAudioState(): void {
    this.#resampler.reset();
    this.#audioStateEpoch += 1;
  }

  #deliver(event: NormalizedTranscriptionEvent): void {
    try {
      const result = (this.#onEvent as (value: NormalizedTranscriptionEvent) => unknown)(event);
      if (
        typeof result === 'object' &&
        result !== null &&
        'then' in result &&
        typeof (result as { readonly then?: unknown }).then === 'function'
      ) {
        void Promise.resolve(result).catch(() => this.#recordDeliveryFailure(event));
      }
    } catch {
      this.#recordDeliveryFailure(event);
    }
  }

  #recordDeliveryFailure(event: NormalizedTranscriptionEvent): void {
    this.#deliveryFailureCount += 1;
    this.#lastDeliveryFailure = Object.freeze({
      eventType: event.type,
      revision: event.revision
    });
    if (this.#onDeliveryFailure === undefined) {
      return;
    }
    try {
      const result = (this.#onDeliveryFailure as (
        status: Readonly<EventDeliveryFailureStatus>
      ) => unknown)(this.deliveryFailures);
      if (
        typeof result === 'object' &&
        result !== null &&
        'then' in result &&
        typeof (result as { readonly then?: unknown }).then === 'function'
      ) {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Failure reporting is content-free and cannot destabilize session commands.
    }
  }
}

export class DeterministicMockTranscriptionAdapter implements TranscriptionAdapter {
  readonly capabilities = DETERMINISTIC_MOCK_CAPABILITIES;
  readonly configuration: Readonly<DeterministicMockTranscriptionAdapterConfiguration>;

  constructor(configuration: DeterministicMockTranscriptionAdapterConfiguration) {
    this.configuration = validateDeterministicMockAdapterConfiguration(configuration);
  }

  createSession(
    input: CreateTranscriptionSessionInput
  ): DeterministicMockTranscriptionSession {
    return new DeterministicMockTranscriptionSession(input, this.configuration);
  }

  async checkReadiness(signal?: AbortSignal): Promise<TranscriptionReadiness> {
    let aborted = false;
    try {
      aborted = signal?.aborted === true;
    } catch {
      aborted = true;
    }
    return Object.freeze({
      ready: !aborted,
      provider: DETERMINISTIC_MOCK_CAPABILITIES.identity.provider,
      model: DETERMINISTIC_MOCK_CAPABILITIES.identity.model
    });
  }
}
