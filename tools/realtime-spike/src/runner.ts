import { randomUUID } from 'node:crypto';

import {
  NormalizedEventSequence,
  type MetadataEvidenceRecord,
  type NormalizedTranscriptionEvent,
  type NormalizedTranscriptionFinal,
  type TranscriptionAdapter,
  type TranscriptionSession,
  type TranscriptionSessionConfiguration
} from '@palancar/transcription';

import {
  createMonotonicNanosecondClock,
  nanosecondsToMilliseconds,
  SYSTEM_SPIKE_SCHEDULER,
  type MonotonicNanosecondClock,
  type SpikeScheduler
} from './clock.js';
import { type MetadataEvidenceSink, type SpikeEvidenceEvent } from './evidence.js';
import { spikeFailure } from './errors.js';
import {
  computeWordErrorRate,
  tokenizeForWordErrorRate,
  type SpikeTargetLanguage,
  type WordErrorRateResult
} from './wer.js';

export const DEFAULT_TRIAL_TIMEOUT_MS = 30_000;
export const MIN_TRIAL_TIMEOUT_MS = 1_000;
export const MAX_TRIAL_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_UTTERANCE_SAMPLES = 480_000;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const SESSION_EPOCH = 1;

export type SpikeGateDisposition = 'accept' | 'reject';

export interface SpikeReference {
  readonly text: string;
  readonly expectedGate: SpikeGateDisposition;
}

export type SpikeReferenceProvider = (
  referenceId: string,
  signal: AbortSignal
) => SpikeReference | Promise<SpikeReference>;

export type SpikeGateEvaluator = (
  finalEvent: Readonly<NormalizedTranscriptionFinal>,
  targetLanguage: SpikeTargetLanguage,
  signal: AbortSignal
) => SpikeGateDisposition | Promise<SpikeGateDisposition>;

export interface SpikeTrialInput {
  readonly runId: string;
  readonly trialId: string;
  readonly targetLanguage: SpikeTargetLanguage;
  readonly referenceId: string;
  readonly audio: AsyncIterable<Uint8Array>;
  readonly referenceProvider: SpikeReferenceProvider;
  readonly timeoutMs?: number;
}

export type SpikeTrialStatus = 'completed' | 'failed' | 'timed-out' | 'cancelled';

export interface SpikeTrialResult {
  readonly status: SpikeTrialStatus;
  readonly targetLanguage: SpikeTargetLanguage;
  readonly latencyMs?: number;
  readonly wer?: Readonly<WordErrorRateResult>;
  readonly expectedGate?: SpikeGateDisposition;
  readonly observedGate?: SpikeGateDisposition;
}

export interface SpikeTrialExecution {
  readonly result: Promise<Readonly<SpikeTrialResult>>;
  markSpeechEnd(): void;
  cancel(): void;
}

export interface RealtimeSpikeTrialRunnerOptions {
  readonly adapter: TranscriptionAdapter;
  readonly configuration: TranscriptionSessionConfiguration;
  readonly configurationVersion: string;
  readonly gateEvaluator: SpikeGateEvaluator;
  readonly evidence: MetadataEvidenceSink;
  readonly maxUtteranceSamples?: number;
  readonly clock?: MonotonicNanosecondClock;
  readonly scheduler?: SpikeScheduler;
  readonly idGenerator?: () => string;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value);
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

function validateTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TRIAL_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < MIN_TRIAL_TIMEOUT_MS ||
    timeout > MAX_TRIAL_TIMEOUT_MS) {
    spikeFailure('invalid-input');
  }
  return timeout;
}

function validateReference(value: unknown): SpikeReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    spikeFailure('invalid-input');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 || keys[0] !== 'expectedGate' || keys[1] !== 'text' ||
    typeof record.text !== 'string' ||
    (record.expectedGate !== 'accept' && record.expectedGate !== 'reject')
  ) {
    spikeFailure('invalid-input');
  }
  return Object.freeze({ text: record.text, expectedGate: record.expectedGate });
}

function validateGate(value: unknown): SpikeGateDisposition {
  if (value !== 'accept' && value !== 'reject') spikeFailure('invalid-input');
  return value;
}

function safeScore(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export class RealtimeSpikeTrialRunner {
  readonly #adapter: TranscriptionAdapter;
  readonly #configuration: TranscriptionSessionConfiguration;
  readonly #gateEvaluator: SpikeGateEvaluator;
  readonly #evidence: MetadataEvidenceSink;
  readonly #maxUtteranceSamples: number;
  readonly #clock: MonotonicNanosecondClock;
  readonly #scheduler: SpikeScheduler;
  readonly #idGenerator: () => string;

  constructor(options: RealtimeSpikeTrialRunnerOptions) {
    if (typeof options !== 'object' || options === null) spikeFailure('invalid-input');
    const maximum = options.maxUtteranceSamples ?? DEFAULT_MAX_UTTERANCE_SAMPLES;
    if (
      typeof options.adapter?.createSession !== 'function' ||
      typeof options.gateEvaluator !== 'function' ||
      typeof options.evidence?.add !== 'function' ||
      !validVersion(options.configurationVersion) ||
      !Number.isSafeInteger(maximum) || maximum < 1 ||
      maximum > DEFAULT_MAX_UTTERANCE_SAMPLES
    ) {
      spikeFailure('invalid-input');
    }
    this.#adapter = options.adapter;
    this.#configuration = Object.freeze({ ...options.configuration });
    this.#gateEvaluator = options.gateEvaluator;
    this.#evidence = options.evidence;
    this.#maxUtteranceSamples = maximum;
    this.#clock = options.clock ?? createMonotonicNanosecondClock();
    this.#scheduler = options.scheduler ?? SYSTEM_SPIKE_SCHEDULER;
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  start(input: SpikeTrialInput): SpikeTrialExecution {
    if (
      typeof input !== 'object' || input === null || !validOpaqueId(input.runId) ||
      !validOpaqueId(input.trialId) || !validOpaqueId(input.referenceId) ||
      (input.targetLanguage !== 'es' && input.targetLanguage !== 'tr') ||
      typeof input.referenceProvider !== 'function' || typeof input.audio !== 'object' ||
      input.audio === null || typeof input.audio[Symbol.asyncIterator] !== 'function'
    ) {
      spikeFailure('invalid-input');
    }
    const timeoutMs = validateTimeout(input.timeoutMs);
    const sessionId = this.#idGenerator();
    const utteranceId = this.#idGenerator();
    if (!UUID_V4_PATTERN.test(sessionId) || !UUID_V4_PATTERN.test(utteranceId)) {
      spikeFailure('invalid-input');
    }

    const sequence = new NormalizedEventSequence(sessionId, SESSION_EPOCH, utteranceId);
    const abortController = new AbortController();
    let session: TranscriptionSession | undefined;
    let iterator: AsyncIterator<Uint8Array> | undefined;
    let stopTimeout: (() => void) | undefined;
    let timeoutInstalled = false;
    let timeoutStopAttempted = false;
    let terminal = false;
    let terminalNeedsCancel = false;
    let started = false;
    let cancelAttempted = false;
    let closeAttempted = false;
    let iteratorReturnAttempted = false;
    let abortAttempted = false;
    let finalClaimed = false;
    let speechEndNs: bigint | undefined;
    let offset = 0;
    let vadStarted = false;
    let resolveResult!: (result: Readonly<SpikeTrialResult>) => void;
    const result = new Promise<Readonly<SpikeTrialResult>>((resolve) => {
      resolveResult = resolve;
    });

    const emit = (
      event: SpikeEvidenceEvent,
      nowNs: bigint,
      fields: Readonly<Record<string, unknown>> = {}
    ): MetadataEvidenceRecord => this.#evidence.add({
      event,
      timestamp: this.#clock.toUtcTimestamp(nowNs),
      ...fields
    });
    const safeEmit = (
      event: SpikeEvidenceEvent,
      nowNs: bigint,
      fields: Readonly<Record<string, unknown>> = {}
    ): void => {
      try {
        emit(event, nowNs, fields);
      } catch {
        // Terminal reporting never changes or exposes the fixed result.
      }
    };
    const stopTimerOnce = (): void => {
      if (!timeoutInstalled || timeoutStopAttempted || stopTimeout === undefined) return;
      timeoutStopAttempted = true;
      try {
        stopTimeout();
      } catch {
        // Teardown steps are isolated from one another.
      }
    };
    const cleanup = (): void => {
      if (!abortAttempted) {
        abortAttempted = true;
        try {
          abortController.abort();
        } catch {
          // Teardown steps are isolated from one another.
        }
      }
      stopTimerOnce();
      if (!iteratorReturnAttempted && iterator !== undefined) {
        iteratorReturnAttempted = true;
        let returnMethod: unknown;
        try {
          returnMethod = Reflect.get(iterator, 'return');
        } catch {
          // Teardown steps are isolated from one another.
        }
        if (typeof returnMethod === 'function') {
          try {
            const returned = Reflect.apply(returnMethod, iterator, []) as unknown;
            void Promise.resolve(returned).catch(() => undefined);
          } catch {
            // Teardown steps are isolated from one another.
          }
        }
      }
      if (terminalNeedsCancel && started && !cancelAttempted && session !== undefined) {
        cancelAttempted = true;
        try {
          session.cancel(utteranceId);
        } catch {
          // Teardown steps are isolated from one another.
        }
      }
      if (session !== undefined && !closeAttempted) {
        closeAttempted = true;
        try {
          session.close();
        } catch {
          // Teardown steps are isolated from one another.
        }
      }
    };
    const settle = (
      status: SpikeTrialStatus,
      evidenceEvent: SpikeEvidenceEvent | undefined,
      completed?: Omit<SpikeTrialResult, 'status' | 'targetLanguage'>
    ): void => {
      if (terminal) return;
      const terminalResult = Object.freeze({
        status,
        targetLanguage: input.targetLanguage,
        ...completed
      });
      terminal = true;
      terminalNeedsCancel = status !== 'completed';
      try {
        let settledAt: bigint | undefined;
        try {
          settledAt = this.#clock.nowNs();
        } catch {
          // Timing failure cannot prevent terminal settlement.
        }
        try {
          cleanup();
        } catch {
          // Cleanup faults cannot prevent terminal settlement.
        }
        if (evidenceEvent !== undefined && settledAt !== undefined) {
          safeEmit(evidenceEvent, settledAt, { status });
        }
      } finally {
        resolveResult(terminalResult);
      }
    };

    const completeFinal = async (
      event: Readonly<NormalizedTranscriptionFinal>,
      receivedAt: bigint,
      markedSpeechEndNs: bigint
    ): Promise<void> => {
      let tokenCount: number;
      try {
        tokenCount = tokenizeForWordErrorRate(event.text, input.targetLanguage).length;
        emit('spike.transcript.final', receivedAt, {
          status: input.targetLanguage,
          tokenCount,
          sampleCount: event.acceptedThroughOriginalSampleOffset
        });
      } catch {
        settle('failed', 'spike.session.failed');
        return;
      }
      let referencePromise: Promise<SpikeReference>;
      let gatePromise: Promise<SpikeGateDisposition>;
      try {
        referencePromise = Promise.resolve(input.referenceProvider(
          input.referenceId,
          abortController.signal
        )).then(validateReference);
        gatePromise = Promise.resolve(this.#gateEvaluator(
          event,
          input.targetLanguage,
          abortController.signal
        )).then(validateGate);
      } catch {
        settle('failed', 'spike.session.failed');
        return;
      }
      let reference: SpikeReference;
      let observedGate: SpikeGateDisposition;
      try {
        [reference, observedGate] = await Promise.all([referencePromise, gatePromise]);
      } catch {
        if (!terminal) settle('failed', 'spike.session.failed');
        return;
      }
      if (terminal) return;
      let wer: Readonly<WordErrorRateResult>;
      let latencyMs: number;
      try {
        wer = computeWordErrorRate(reference.text, event.text, input.targetLanguage);
        latencyMs = nanosecondsToMilliseconds(receivedAt - markedSpeechEndNs);
        const componentEvents = [
          ['spike.wer.substitutions', wer.substitutions],
          ['spike.wer.deletions', wer.deletions],
          ['spike.wer.insertions', wer.insertions],
          ['spike.wer.numerator', wer.numerator],
          ['spike.wer.denominator', wer.denominator]
        ] as const;
        for (const [componentEvent, count] of componentEvents) {
          emit(componentEvent, receivedAt, { status: input.targetLanguage, tokenCount: count });
        }
        emit('spike.trial.completed', receivedAt, {
          status: input.targetLanguage,
          latencyMs,
          tokenCount,
          scores: {
            wordErrorRate: safeScore(wer.wordErrorRate),
            ...(reference.expectedGate === 'accept'
              ? { gateAcceptanceRate: observedGate === 'accept' ? 1 : 0 }
              : { gateRejectionRate: observedGate === 'reject' ? 1 : 0 })
          }
        });
      } catch {
        settle('failed', 'spike.session.failed');
        return;
      }
      settle('completed', undefined, {
        latencyMs,
        wer,
        expectedGate: reference.expectedGate,
        observedGate
      });
    };

    const onEvent = (untrustedEvent: NormalizedTranscriptionEvent): void => {
      if (terminal || finalClaimed) return;
      let event: NormalizedTranscriptionEvent;
      try {
        event = sequence.accept(untrustedEvent);
      } catch {
        settle('failed', 'spike.session.failed');
        return;
      }
      if (event.type === 'transcript.final') {
        finalClaimed = true;
        let receivedAt: bigint;
        try {
          receivedAt = this.#clock.nowNs();
        } catch {
          settle('failed', 'spike.session.failed');
          return;
        }
        const marker = speechEndNs;
        if (marker === undefined || receivedAt < marker) {
          settle('failed', 'spike.session.failed');
          return;
        }
        void completeFinal(event, receivedAt, marker);
        return;
      }
      try {
        emit('spike.transcript.partial', this.#clock.nowNs(), {
          status: input.targetLanguage,
          tokenCount: tokenizeForWordErrorRate(event.text, input.targetLanguage).length,
          sampleCount: event.acceptedThroughOriginalSampleOffset
        });
      } catch {
        settle('failed', 'spike.session.failed');
      }
    };
    const onFailure = (): void => {
      if (terminal || finalClaimed) return;
      settle('failed', 'spike.session.failed');
    };

    const pumpAudio = async (): Promise<void> => {
      try {
        iterator = input.audio[Symbol.asyncIterator]();
        while (!terminal && !finalClaimed) {
          const next = await iterator.next();
          if (terminal || finalClaimed) break;
          if (next.done === true) break;
          const chunk = next.value;
          if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 ||
            chunk.byteLength % 2 !== 0) {
            spikeFailure('invalid-input');
          }
          const acceptedSamples = chunk.byteLength / 2;
          const expectedOffset = offset + acceptedSamples;
          if (!Number.isSafeInteger(expectedOffset) || expectedOffset > this.#maxUtteranceSamples) {
            spikeFailure('invalid-input');
          }
          sequence.advanceAcceptedHighWaterMark(expectedOffset);
          const nowNs = this.#clock.nowNs();
          if (!vadStarted) {
            vadStarted = true;
            emit('spike.vad.started', nowNs, { status: input.targetLanguage });
          }
          const pushed = session!.pushAudio({
            utteranceId,
            originalSampleOffset: offset,
            pcm: chunk
          });
          if (terminal || finalClaimed) break;
          if (
            pushed.status !== 'accepted' || pushed.acceptedSamples !== acceptedSamples ||
            pushed.acceptedThroughOriginalSampleOffset !== expectedOffset
          ) {
            spikeFailure('invalid-input');
          }
          offset = expectedOffset;
          emit('spike.audio.appended', nowNs, {
            status: input.targetLanguage,
            byteCount: chunk.byteLength,
            sampleCount: acceptedSamples
          });
        }
        if (terminal || finalClaimed) return;
        if (vadStarted) {
          emit('spike.vad.stopped', this.#clock.nowNs(), {
            status: input.targetLanguage,
            sampleCount: offset
          });
        }
        session!.finalize(utteranceId);
      } catch {
        if (!finalClaimed) settle('failed', 'spike.session.failed');
      }
    };

    try {
      emit('spike.trial.started', this.#clock.nowNs(), { status: input.targetLanguage });
      stopTimeout = this.#scheduler.schedule(() => {
        settle('timed-out', 'spike.session.timed-out');
      }, timeoutMs);
      if (typeof stopTimeout !== 'function') spikeFailure('invalid-input');
      timeoutInstalled = true;
      if (terminal) {
        stopTimerOnce();
      } else {
        const created = this.#adapter.createSession({
          sessionId,
          sessionEpoch: SESSION_EPOCH,
          configuration: this.#configuration,
          onEvent,
          onFailure,
          maxUtteranceSamples: this.#maxUtteranceSamples
        });
        session = created;
        if (terminal) {
          cleanup();
        } else {
          started = true;
          session.start({ utteranceId });
          if (terminal) {
            cleanup();
          } else {
            emit('spike.session.started', this.#clock.nowNs(), {
              status: input.targetLanguage
            });
            if (!terminal) void pumpAudio();
          }
        }
      }
    } catch {
      settle('failed', 'spike.session.failed');
      cleanup();
    }

    return Object.freeze({
      result,
      markSpeechEnd: () => {
        if (terminal || finalClaimed || speechEndNs !== undefined) spikeFailure('invalid-input');
        let marker: bigint;
        try {
          marker = this.#clock.nowNs();
        } catch {
          spikeFailure('invalid-input');
        }
        if (typeof marker !== 'bigint' || marker < 0n) spikeFailure('invalid-input');
        speechEndNs = marker;
      },
      cancel: () => settle('cancelled', 'spike.session.cancelled')
    });
  }
}

export function recordSpikeRunStarted(options: {
  readonly evidence: MetadataEvidenceSink;
  readonly clock: MonotonicNanosecondClock;
  readonly runId: string;
  readonly configurationVersion: string;
}): MetadataEvidenceRecord {
  if (!validOpaqueId(options.runId) || !validVersion(options.configurationVersion)) {
    spikeFailure('invalid-input');
  }
  return options.evidence.add({
    event: 'spike.run.started',
    timestamp: options.clock.toUtcTimestamp(options.clock.nowNs()),
    status: 'started'
  });
}
