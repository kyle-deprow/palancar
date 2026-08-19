import { execFile } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  createMetadataEvidenceRecord,
  type CreateTranscriptionSessionInput,
  type NormalizedTranscriptionEvent,
  type TranscriptionAdapter,
  type TranscriptionCapabilities,
  type TranscriptionSession
} from '@palancar/transcription';
import { describe, expect, it } from 'vitest';

import {
  CONFIRMATION_MINIMUM_TRIALS,
  EXPLORATORY_MINIMUM_TRIALS,
  MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_LINE_BYTES,
  MAX_EVIDENCE_RECORDS,
  MAX_TRIAL_TIMEOUT_MS,
  MAX_WER_INPUT_BYTES,
  MAX_WER_TOKEN_BYTES,
  MAX_WER_TOKENS,
  MetadataEvidenceJsonlWriter,
  RealtimeSpikeError,
  RealtimeSpikeTrialRunner,
  WER_TIE_POLICY,
  aggregateSpikeTrials,
  computeWordErrorRate,
  nanosecondsToMilliseconds,
  recordSpikeRunStarted,
  runRealtimeSpikeCli,
  serializeSpikeEvidenceRecord,
  tokenizeForWordErrorRate,
  validateSpikeEvidenceJsonLines,
  type MonotonicNanosecondClock,
  type RealtimeSpikeInputHandle,
  type SpikeGateDisposition,
  type SpikeScheduler,
  type SpikeTargetLanguage,
  type SpikeTrialResult
} from '../src/index.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';
const SEGMENT_ID = '33333333-3333-4333-8333-333333333333';
const TEMP_ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEMP_ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CANARY = 'PRIVATE-CONTENT-CANARY';
const execFileAsync = promisify(execFile);

class FakeClock implements MonotonicNanosecondClock {
  now = 2_000_000_000n;
  nowCalls = 0;
  throwNow = false;

  nowNs(): bigint {
    this.nowCalls += 1;
    if (this.throwNow) throw new Error(CANARY);
    return this.now;
  }

  toUtcTimestamp(monotonicNs: bigint): string {
    if (monotonicNs < 0n) throw new Error(CANARY);
    return new Date(Date.parse('2026-08-19T00:00:00.000Z') +
      Number(monotonicNs) / 1_000_000).toISOString();
  }
}

class FakeScheduler implements SpikeScheduler {
  callback: (() => void) | undefined;
  delayMs: number | undefined;
  stopCount = 0;
  immediate = false;
  stopThrows = false;
  onStop: (() => void) | undefined;

  schedule(callback: () => void, delayMs: number): () => void {
    this.callback = callback;
    this.delayMs = delayMs;
    if (this.immediate) callback();
    return () => {
      this.stopCount += 1;
      this.onStop?.();
      if (this.stopThrows) throw new Error(CANARY);
    };
  }

  fire(): void {
    this.callback?.();
  }
}

const CAPABILITIES: Readonly<TranscriptionCapabilities> = Object.freeze({
  identity: Object.freeze({ provider: CANARY, model: CANARY, version: CANARY }),
  acceptedInput: Object.freeze({ sampleRateHz: 16_000, sampleFormat: 's16le', channels: 1 }),
  providerInput: Object.freeze({ sampleRateHz: 16_000, sampleFormat: 's16le', channels: 1 }),
  resampling: Object.freeze({ mode: 'native', stateful: false }),
  serverVad: Object.freeze({
    supported: true,
    modes: Object.freeze(['enabled', 'disabled'] as const)
  }),
  manualCommit: Object.freeze({ supported: true, cadencesMs: Object.freeze([600]) }),
  languageModes: Object.freeze(['automatic'] as const),
  partialResults: Object.freeze({ supported: true }),
  providerRetention: Object.freeze({ status: 'not-applicable-synthetic', evidenceVersion: CANARY })
});

interface SessionBehavior {
  readonly onStart?: (session: FakeSession) => void;
  readonly onPush?: (session: FakeSession) => void;
  readonly onFinalize?: (session: FakeSession) => void;
  readonly startThrows?: boolean;
  readonly pushThrows?: boolean;
  readonly finalizeThrows?: boolean;
  readonly cancelThrows?: boolean;
  readonly closeThrows?: boolean;
  readonly emitFinalOnFinalize?: boolean;
  readonly onCancel?: (session: FakeSession) => void;
  readonly onClose?: (session: FakeSession) => void;
}

class FakeSession implements TranscriptionSession {
  readonly capabilities = CAPABILITIES;
  readonly configuration = Object.freeze({
    serverVadMode: 'disabled' as const,
    languageMode: 'automatic' as const,
    manualCommitCadenceMs: 600
  });
  readonly deliveryFailures = Object.freeze({ failureCount: 0 });
  readonly #input: CreateTranscriptionSessionInput;
  readonly #behavior: SessionBehavior;
  acceptedOffset = 0;
  cancelCount = 0;
  closeCount = 0;
  startCount = 0;
  finalizeCount = 0;
  revision = 0;

  constructor(input: CreateTranscriptionSessionInput, behavior: SessionBehavior) {
    this.#input = input;
    this.#behavior = behavior;
  }

  get state() {
    return Object.freeze({
      closed: this.closeCount > 0,
      acceptedThroughOriginalSampleOffset: this.acceptedOffset,
      audioStateEpoch: 1
    });
  }

  start() {
    this.startCount += 1;
    this.#behavior.onStart?.(this);
    if (this.#behavior.startThrows) throw new Error(CANARY);
    return Object.freeze({ status: 'started' as const });
  }

  pushAudio(input: { readonly pcm: Uint8Array }) {
    const acceptedSamples = input.pcm.byteLength / 2;
    this.acceptedOffset += acceptedSamples;
    this.#behavior.onPush?.(this);
    if (this.#behavior.pushThrows) throw new Error(CANARY);
    return Object.freeze({
      status: 'accepted' as const,
      acceptedSamples,
      acceptedThroughOriginalSampleOffset: this.acceptedOffset
    });
  }

  finalize() {
    this.finalizeCount += 1;
    if (this.#behavior.onFinalize !== undefined) this.#behavior.onFinalize(this);
    else if (this.#behavior.emitFinalOnFinalize !== false) this.emitFinal();
    if (this.#behavior.finalizeThrows) throw new Error(CANARY);
    return Object.freeze({ status: 'finalization-requested' as const });
  }

  cancel() {
    this.cancelCount += 1;
    this.#behavior.onCancel?.(this);
    if (this.#behavior.cancelThrows) throw new Error(CANARY);
    return Object.freeze({ status: 'cancelled' as const });
  }

  close() {
    this.closeCount += 1;
    this.#behavior.onClose?.(this);
    if (this.#behavior.closeThrows) throw new Error(CANARY);
    return Object.freeze({ status: 'closed' as const });
  }

  fail(): void {
    this.#input.onFailure({ reason: 'provider', audioStateEpoch: 1 });
  }

  emitPartial(overrides: Partial<NormalizedTranscriptionEvent> = {}): void {
    this.revision += 1;
    this.#input.onEvent(this.#event('transcript.partial', overrides));
  }

  emitFinal(overrides: Partial<NormalizedTranscriptionEvent> = {}): void {
    this.revision += 1;
    this.#input.onEvent({
      ...this.#event('transcript.final', overrides),
      type: 'transcript.final',
      finalizationReason: 'explicit'
    });
  }

  #event(
    type: 'transcript.partial' | 'transcript.final',
    overrides: Partial<NormalizedTranscriptionEvent>
  ): NormalizedTranscriptionEvent {
    const base = {
      type,
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      revision: this.revision,
      text: CANARY,
      providerEventTime: '2026-08-19T00:00:00.000Z',
      languageEvidence: Object.freeze({ detectorVersion: 'test-1', source: 'controlled-fixture' as const }),
      acceptedThroughOriginalSampleOffset: this.acceptedOffset,
      ...overrides
    };
    return type === 'transcript.partial'
      ? base as NormalizedTranscriptionEvent
      : { ...base, finalizationReason: 'explicit' } as NormalizedTranscriptionEvent;
  }
}

interface AdapterBehavior {
  readonly createThrows?: boolean;
  readonly onCreate?: (session: FakeSession) => void;
  readonly session?: SessionBehavior;
}

class FakeAdapter implements TranscriptionAdapter {
  readonly capabilities = CAPABILITIES;
  readonly #behavior: AdapterBehavior;
  session: FakeSession | undefined;
  createCount = 0;

  constructor(behavior: AdapterBehavior = {}) {
    this.#behavior = behavior;
  }

  createSession(input: CreateTranscriptionSessionInput): TranscriptionSession {
    this.createCount += 1;
    if (this.#behavior.createThrows) throw new Error(CANARY);
    const session = new FakeSession(input, this.#behavior.session ?? {});
    this.session = session;
    this.#behavior.onCreate?.(session);
    return session;
  }

  async checkReadiness() {
    return Object.freeze({ ready: true, provider: CANARY, model: CANARY });
  }
}

function ids(): () => string {
  const values = [SESSION_ID, UTTERANCE_ID];
  return () => values.shift() ?? '44444444-4444-4444-8444-444444444444';
}

function finiteAudio(chunks: readonly Uint8Array[], returned = { count: 0 }) {
  return {
    returned,
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let index = 0;
      return {
        next: async () => index < chunks.length
          ? { done: false, value: chunks[index++]! }
          : { done: true, value: undefined },
        return: async () => {
          returned.count += 1;
          return { done: true, value: undefined };
        }
      };
    }
  };
}

function pendingAudio(options: { readonly returnThrows?: boolean } = {}) {
  const state = { returnCount: 0 };
  return {
    state,
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let first = true;
      return {
        next: async () => {
          if (first) {
            first = false;
            return { done: false, value: new Uint8Array([0, 0]) };
          }
          return new Promise(() => undefined);
        },
        return: () => {
          state.returnCount += 1;
          if (options.returnThrows) throw new Error(CANARY);
          return new Promise(() => undefined);
        }
      };
    }
  };
}

function pendingAudioWithThrowingReturnGetter(onGet?: () => void) {
  const state = { getterCount: 0 };
  return {
    state,
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let first = true;
      const iterator: Record<PropertyKey, unknown> = {
        next: async () => {
          if (first) {
            first = false;
            return { done: false, value: new Uint8Array([0, 0]) };
          }
          return new Promise(() => undefined);
        }
      };
      Object.defineProperty(iterator, 'return', {
        enumerable: false,
        get: () => {
          state.getterCount += 1;
          onGet?.();
          throw new Error(CANARY);
        }
      });
      return iterator as unknown as AsyncIterator<Uint8Array>;
    }
  };
}

function controlledAudio() {
  let release!: () => void;
  const released = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  const source = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let step = 0;
      return {
        next: async () => {
          step += 1;
          if (step === 1) return { done: false, value: new Uint8Array([0, 0]) };
          await released;
          return { done: true, value: undefined };
        },
        return: async () => ({ done: true, value: undefined })
      };
    }
  };
  return { source, release };
}

interface HarnessOptions {
  readonly adapterBehavior?: AdapterBehavior;
  readonly scheduler?: FakeScheduler;
  readonly gateEvaluator?: (
    event: Parameters<NonNullable<ConstructorParameters<typeof RealtimeSpikeTrialRunner>[0]['gateEvaluator']>>[0],
    language: SpikeTargetLanguage,
    signal: AbortSignal
  ) => SpikeGateDisposition | Promise<SpikeGateDisposition>;
  readonly maxUtteranceSamples?: number;
}

function runnerHarness(options: HarnessOptions = {}) {
  const adapter = new FakeAdapter(options.adapterBehavior);
  const evidence = new MetadataEvidenceJsonlWriter();
  const clock = new FakeClock();
  const scheduler = options.scheduler ?? new FakeScheduler();
  let gateCalls = 0;
  const runner = new RealtimeSpikeTrialRunner({
    adapter,
    configuration: {
      serverVadMode: 'disabled', languageMode: 'automatic', manualCommitCadenceMs: 600
    },
    configurationVersion: CANARY,
    gateEvaluator: async (event, language, signal) => {
      gateCalls += 1;
      return options.gateEvaluator?.(event, language, signal) ?? 'accept';
    },
    evidence,
    ...(options.maxUtteranceSamples === undefined
      ? {}
      : { maxUtteranceSamples: options.maxUtteranceSamples }),
    clock,
    scheduler,
    idGenerator: ids()
  });
  return { adapter, evidence, clock, scheduler, runner, gateCalls: () => gateCalls };
}

function trialInput(
  overrides: Partial<Parameters<RealtimeSpikeTrialRunner['start']>[0]> = {}
) {
  return {
    runId: CANARY,
    trialId: `${CANARY}-TRIAL`,
    targetLanguage: 'es' as const,
    referenceId: `${CANARY}-REFERENCE`,
    audio: finiteAudio([new Uint8Array([0, 0]), new Uint8Array([1, 0])]),
    referenceProvider: async () => ({ text: CANARY, expectedGate: 'accept' as const }),
    ...overrides
  };
}

async function flush(count = 5): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('bounded completion failed')); }, 250);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('word error rate', () => {
  it('normalizes NFKC and locale-aware Spanish/Turkish tokens', () => {
    expect(computeWordErrorRate('¡HOLA, MuＮdo １２!', 'hola mundo 12', 'es')).toMatchObject({
      numerator: 0, denominator: 3, wordErrorRate: 0
    });
    expect(tokenizeForWordErrorRate('I İ ı i', 'tr')).toEqual(['ı', 'i', 'ı', 'i']);
  });

  it('uses and documents a deterministic edit tie policy', () => {
    expect(WER_TIE_POLICY).toBe('distance,substitutions,deletions,insertions');
    expect(computeWordErrorRate('a b', 'b a', 'es')).toEqual({
      substitutions: 0, deletions: 1, insertions: 1,
      numerator: 2, denominator: 2, wordErrorRate: 1
    });
    expect(computeWordErrorRate('uno dos tres', 'uno cuatro cinco', 'es'))
      .toMatchObject({ substitutions: 2, deletions: 0, insertions: 0, numerator: 2 });
  });

  it('enforces byte, token-count, and token-byte boundaries', () => {
    expect(tokenizeForWordErrorRate('!'.repeat(MAX_WER_INPUT_BYTES), 'es')).toEqual([]);
    expect(() => tokenizeForWordErrorRate('!'.repeat(MAX_WER_INPUT_BYTES + 1), 'es'))
      .toThrow(RealtimeSpikeError);
    expect(tokenizeForWordErrorRate(Array(MAX_WER_TOKENS).fill('a').join(' '), 'es'))
      .toHaveLength(MAX_WER_TOKENS);
    expect(() => tokenizeForWordErrorRate(Array(MAX_WER_TOKENS + 1).fill('a').join(' '), 'es'))
      .toThrow(RealtimeSpikeError);
    expect(tokenizeForWordErrorRate('a'.repeat(MAX_WER_TOKEN_BYTES), 'es')).toHaveLength(1);
    expect(() => tokenizeForWordErrorRate('a'.repeat(MAX_WER_TOKEN_BYTES + 1), 'es'))
      .toThrow(RealtimeSpikeError);
  });
});

function runRecord(timestamp = '2026-08-19T00:00:00.000Z') {
  return { event: 'spike.run.started', timestamp, status: 'started' };
}

describe('closed metadata evidence and atomic files', () => {
  it('accepts only event-specific closed records and rejects every prior string field', () => {
    const writer = new MetadataEvidenceJsonlWriter({ maxRecords: 1 });
    const record = writer.add(runRecord());
    expect(createMetadataEvidenceRecord(record)).toEqual(record);
    expect(() => writer.add(runRecord())).toThrow(RealtimeSpikeError);
    const stringFields = [
      'eventId', 'sessionId', 'utteranceId', 'segmentId', 'correlationId',
      'operationId', 'requestId', 'configurationVersion', 'modelVersion', 'providerVersion'
    ];
    for (const field of stringFields) {
      expect(() => new MetadataEvidenceJsonlWriter().add({ ...runRecord(), [field]: CANARY }))
        .toThrow(new RealtimeSpikeError('invalid-evidence'));
    }
    expect(() => new MetadataEvidenceJsonlWriter().add({ ...runRecord(), status: CANARY }))
      .toThrow(new RealtimeSpikeError('invalid-evidence'));
    expect(() => new MetadataEvidenceJsonlWriter().add({ ...runRecord(), timestamp: CANARY }))
      .toThrow(new RealtimeSpikeError('invalid-evidence'));
    expect(MAX_EVIDENCE_RECORDS).toBe(250_000);
    expect(MAX_EVIDENCE_FILE_BYTES).toBe(256 * 1024 * 1024);
  });

  it('enforces line and file bytes including LF exactly', () => {
    const probe = new MetadataEvidenceJsonlWriter();
    probe.add(runRecord());
    const exact = Buffer.byteLength(probe.toJsonLines(), 'utf8');
    expect(exact).toBeLessThanOrEqual(MAX_EVIDENCE_LINE_BYTES);
    expect(() => new MetadataEvidenceJsonlWriter({ maxLineBytes: exact, maxBytes: exact })
      .add(runRecord())).not.toThrow();
    expect(() => new MetadataEvidenceJsonlWriter({ maxLineBytes: exact - 1, maxBytes: exact })
      .add(runRecord())).toThrow(RealtimeSpikeError);
    expect(() => new MetadataEvidenceJsonlWriter({ maxLineBytes: exact, maxBytes: exact - 1 })
      .add(runRecord())).toThrow(RealtimeSpikeError);
  });

  it('rejects accessors, proxies, symbol extras, and trap failures without invocation or leakage', () => {
    let getterCalls = 0;
    const accessor = { event: 'spike.run.started', timestamp: '2026-08-19T00:00:00.000Z' };
    Object.defineProperty(accessor, 'status', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error(CANARY);
      }
    });
    const symbolRecord = { ...runRecord(), [Symbol(CANARY)]: CANARY };
    let trapCalls = 0;
    const trapped = new Proxy(runRecord(), {
      ownKeys: () => {
        trapCalls += 1;
        throw new Error(CANARY);
      },
      getOwnPropertyDescriptor: () => {
        trapCalls += 1;
        throw new Error(CANARY);
      },
      getPrototypeOf: () => {
        trapCalls += 1;
        throw new Error(CANARY);
      }
    });
    for (const input of [accessor, symbolRecord, trapped]) {
      let failure: unknown;
      try {
        new MetadataEvidenceJsonlWriter().add(input);
      } catch (error) {
        failure = error;
      }
      expect(failure).toEqual(new RealtimeSpikeError('invalid-evidence'));
      expect(String(failure)).not.toContain(CANARY);
    }
    expect(getterCalls).toBe(0);
    expect(trapCalls).toBe(0);

    let scoreGetterCalls = 0;
    const scores = { wordErrorRate: 0 } as Record<string, unknown>;
    Object.defineProperty(scores, 'gateAcceptanceRate', {
      enumerable: true,
      get: () => {
        scoreGetterCalls += 1;
        throw new Error(CANARY);
      }
    });
    expect(() => new MetadataEvidenceJsonlWriter().add({
      event: 'spike.trial.completed',
      timestamp: '2026-08-19T00:00:00.000Z',
      status: 'es',
      latencyMs: 1,
      tokenCount: 1,
      scores
    })).toThrow(new RealtimeSpikeError('invalid-evidence'));
    expect(scoreGetterCalls).toBe(0);
  });

  it('rejects nonplain and non-enumerable records and revalidates prior snapshots on serialization', () => {
    const nonplain = Object.assign(Object.create({ inherited: CANARY }), runRecord());
    const nonEnumerable = runRecord() as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, 'status', {
      value: 'started', enumerable: false, configurable: true, writable: true
    });
    for (const input of [nonplain, nonEnumerable]) {
      let failure: unknown;
      try {
        serializeSpikeEvidenceRecord(input);
      } catch (error) {
        failure = error;
      }
      expect(failure).toEqual(new RealtimeSpikeError('invalid-evidence'));
      expect(String(failure)).not.toContain(CANARY);
    }

    const writer = new MetadataEvidenceJsonlWriter();
    const priorSnapshot = writer.add(runRecord());
    expect(serializeSpikeEvidenceRecord(priorSnapshot)).toBe(writer.toJsonLines());
    const hostilePriorWrapper = new Proxy(priorSnapshot, {});
    expect(() => serializeSpikeEvidenceRecord(hostilePriorWrapper))
      .toThrow(new RealtimeSpikeError('invalid-evidence'));
    expect(() => serializeSpikeEvidenceRecord({
      ...priorSnapshot,
      [Symbol(CANARY)]: CANARY
    })).toThrow(new RealtimeSpikeError('invalid-evidence'));
  });

  it('writes mode 0600 atomically and supports concurrent exclusive temp files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'palancar-spike-'));
    const file = join(directory, 'evidence.jsonl');
    try {
      const first = new MetadataEvidenceJsonlWriter({ temporaryIdGenerator: () => TEMP_ID_A });
      const second = new MetadataEvidenceJsonlWriter({ temporaryIdGenerator: () => TEMP_ID_B });
      first.add(runRecord('2026-08-19T00:00:00.000Z'));
      second.add(runRecord('2026-08-19T00:00:01.000Z'));
      await Promise.all([first.writeAtomic(file), second.writeAtomic(file)]);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(validateSpikeEvidenceJsonLines(await readFile(file, 'utf8'))).toBe(1);
      expect((await readdir(directory)).filter((name) => name.endsWith('.pending'))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not unlink an unowned collision or alter an existing destination on failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'palancar-spike-collision-'));
    const file = join(directory, 'evidence.jsonl');
    const collision = join(directory, `.evidence.jsonl.${TEMP_ID_A}.pending`);
    try {
      await writeFile(file, 'original', { mode: 0o600 });
      await writeFile(collision, CANARY, { mode: 0o600 });
      const writer = new MetadataEvidenceJsonlWriter({ temporaryIdGenerator: () => TEMP_ID_A });
      writer.add(runRecord());
      await expect(writer.writeAtomic(file)).rejects.toEqual(
        new RealtimeSpikeError('evidence-write')
      );
      expect(await readFile(file, 'utf8')).toBe('original');
      expect(await readFile(collision, 'utf8')).toBe(CANARY);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('trial runner live marker and authoritative scoring', () => {
  it('streams before speech end, marks once, scores via gate evaluator, and emits no IDs/content', async () => {
    const controlled = controlledAudio();
    const harness = runnerHarness({ gateEvaluator: async () => 'reject' as const });
    const execution = harness.runner.start(trialInput({ audio: controlled.source }));
    await flush();
    expect(harness.evidence.records.some((record) => record.event === 'spike.audio.appended'))
      .toBe(true);
    const beforeMarkerCalls = harness.clock.nowCalls;
    execution.markSpeechEnd();
    expect(harness.clock.nowCalls).toBe(beforeMarkerCalls + 1);
    expect(() => execution.markSpeechEnd()).toThrow(new RealtimeSpikeError('invalid-input'));
    harness.clock.now = 2_500_000_000n;
    controlled.release();
    const result = await execution.result;
    expect(result).toMatchObject({
      status: 'completed', latencyMs: 500, expectedGate: 'accept', observedGate: 'reject'
    });
    expect(harness.gateCalls()).toBe(1);
    expect(harness.adapter.session).toMatchObject({ cancelCount: 0, closeCount: 1 });
    const json = harness.evidence.toJsonLines();
    expect(json).not.toContain(CANARY);
    for (const forbidden of [
      'sessionId', 'utteranceId', 'segmentId', 'correlationId', 'operationId',
      'requestId', 'configurationVersion', 'modelVersion', 'providerVersion'
    ]) expect(json).not.toContain(forbidden);
  });

  it('does not allow the reference provider to forge the observed gate', async () => {
    const forged = { text: CANARY, expectedGate: 'accept' as const };
    Object.defineProperty(forged, 'observedGate', { value: 'reject', enumerable: false });
    const harness = runnerHarness({ gateEvaluator: async () => 'accept' as const });
    const execution = harness.runner.start(trialInput({ referenceProvider: async () => forged }));
    execution.markSpeechEnd();
    expect(await execution.result).toMatchObject({ status: 'completed', observedGate: 'accept' });
    expect(harness.gateCalls()).toBe(1);
  });

  it('fails final without a marker and permits cancellation before a marker', async () => {
    const noMarker = runnerHarness();
    const unmarked = noMarker.runner.start(trialInput());
    expect(await unmarked.result).toMatchObject({ status: 'failed' });
    expect(noMarker.gateCalls()).toBe(0);
    expect(noMarker.adapter.session).toMatchObject({ cancelCount: 1, closeCount: 1 });

    const cancelledHarness = runnerHarness();
    const cancelled = cancelledHarness.runner.start(trialInput({ audio: pendingAudio() }));
    cancelled.cancel();
    expect(await cancelled.result).toMatchObject({ status: 'cancelled' });
    expect(() => cancelled.markSpeechEnd()).toThrow(new RealtimeSpikeError('invalid-input'));
    expect(cancelledHarness.adapter.session).toMatchObject({ cancelCount: 1, closeCount: 1 });
  });

  it('ignores failure and events after an authoritative final while scoring is pending', async () => {
    let resolveGate!: (gate: SpikeGateDisposition) => void;
    const gate = new Promise<SpikeGateDisposition>((resolveValue) => { resolveGate = resolveValue; });
    const harness = runnerHarness({ gateEvaluator: () => gate });
    const execution = harness.runner.start(trialInput());
    execution.markSpeechEnd();
    await flush(10);
    expect(harness.gateCalls()).toBe(1);
    const evidenceCount = harness.evidence.records.length;
    harness.adapter.session?.fail();
    harness.adapter.session?.emitPartial({ revision: 99 });
    expect(harness.evidence.records).toHaveLength(evidenceCount);
    resolveGate('accept');
    expect(await execution.result).toMatchObject({ status: 'completed' });
  });
});

describe('trial runner reentrancy and teardown', () => {
  it('preserves a valid final synchronously claimed by pushAudio or finalize before they throw', async () => {
    const pushHarness = runnerHarness({
      adapterBehavior: {
        session: {
          onPush: (session) => { session.emitFinal(); },
          pushThrows: true
        }
      }
    });
    const pushed = pushHarness.runner.start(trialInput());
    pushed.markSpeechEnd();
    expect(await bounded(pushed.result)).toMatchObject({ status: 'completed' });
    expect(pushHarness.adapter.session).toMatchObject({ cancelCount: 0, closeCount: 1 });

    const finalizeHarness = runnerHarness({
      adapterBehavior: { session: { finalizeThrows: true } }
    });
    const finalized = finalizeHarness.runner.start(trialInput());
    finalized.markSpeechEnd();
    expect(await bounded(finalized.result)).toMatchObject({ status: 'completed' });
    expect(finalizeHarness.adapter.session).toMatchObject({ cancelCount: 0, closeCount: 1 });
  });

  it('fails closed when pushAudio or finalize throws before any valid final', async () => {
    const pushHarness = runnerHarness({
      adapterBehavior: { session: { pushThrows: true } }
    });
    const pushed = pushHarness.runner.start(trialInput());
    pushed.markSpeechEnd();
    expect(await bounded(pushed.result)).toMatchObject({ status: 'failed' });
    expect(pushHarness.adapter.session).toMatchObject({ cancelCount: 1, closeCount: 1 });

    const finalizeHarness = runnerHarness({
      adapterBehavior: {
        session: { emitFinalOnFinalize: false, finalizeThrows: true }
      }
    });
    const finalized = finalizeHarness.runner.start(trialInput());
    finalized.markSpeechEnd();
    expect(await bounded(finalized.result)).toMatchObject({ status: 'failed' });
    expect(finalizeHarness.adapter.session).toMatchObject({ cancelCount: 1, closeCount: 1 });
  });

  it('preserves pushAudio/finalize finals across reentrant failure callbacks and later throws', async () => {
    const reentrantFinal = (session: FakeSession): void => {
      session.emitFinal();
      session.fail();
      session.emitPartial({ revision: 99 });
    };
    const pushHarness = runnerHarness({
      adapterBehavior: { session: { onPush: reentrantFinal, pushThrows: true } }
    });
    const pushed = pushHarness.runner.start(trialInput());
    pushed.markSpeechEnd();
    expect(await bounded(pushed.result)).toMatchObject({ status: 'completed' });
    expect(pushHarness.gateCalls()).toBe(1);

    const finalizeHarness = runnerHarness({
      adapterBehavior: { session: { onFinalize: reentrantFinal, finalizeThrows: true } }
    });
    const finalized = finalizeHarness.runner.start(trialInput());
    finalized.markSpeechEnd();
    expect(await bounded(finalized.result)).toMatchObject({ status: 'completed' });
    expect(finalizeHarness.gateCalls()).toBe(1);
  });

  it('handles synchronous create/start failures and callbacks exactly once', async () => {
    const createThrow = runnerHarness({ adapterBehavior: { createThrows: true } });
    expect(await createThrow.runner.start(trialInput()).result).toMatchObject({ status: 'failed' });
    expect(createThrow.scheduler.stopCount).toBe(1);

    const createCallback = runnerHarness({
      adapterBehavior: { onCreate: (session) => { session.fail(); } }
    });
    expect(await createCallback.runner.start(trialInput()).result).toMatchObject({ status: 'failed' });
    expect(createCallback.adapter.session).toMatchObject({
      startCount: 0, cancelCount: 0, closeCount: 1
    });

    const startCallback = runnerHarness({
      adapterBehavior: { session: { onStart: (session) => { session.fail(); } } }
    });
    expect(await startCallback.runner.start(trialInput()).result).toMatchObject({ status: 'failed' });
    expect(startCallback.adapter.session).toMatchObject({
      startCount: 1, cancelCount: 1, closeCount: 1
    });
    expect(startCallback.evidence.records.some((record) => record.event === 'spike.session.started'))
      .toBe(false);

    const startThrow = runnerHarness({ adapterBehavior: { session: { startThrows: true } } });
    expect(await startThrow.runner.start(trialInput()).result).toMatchObject({ status: 'failed' });
    expect(startThrow.adapter.session).toMatchObject({ cancelCount: 1, closeCount: 1 });
  });

  it('handles an immediate scheduler callback without post-terminal work', async () => {
    const scheduler = new FakeScheduler();
    scheduler.immediate = true;
    const harness = runnerHarness({ scheduler });
    expect(await harness.runner.start(trialInput()).result).toMatchObject({ status: 'timed-out' });
    expect(harness.adapter.createCount).toBe(0);
    expect(scheduler.stopCount).toBe(1);
    expect(harness.evidence.records.map((record) => record.event)).toEqual([
      'spike.trial.started', 'spike.session.timed-out'
    ]);
  });

  it('isolates throwing timer, iterator, cancel, and close cleanup', async () => {
    const scheduler = new FakeScheduler();
    scheduler.stopThrows = true;
    const source = pendingAudio({ returnThrows: true });
    const harness = runnerHarness({
      scheduler,
      adapterBehavior: { session: { cancelThrows: true, closeThrows: true } }
    });
    const execution = harness.runner.start(trialInput({ audio: source }));
    await flush();
    scheduler.fire();
    expect(await execution.result).toMatchObject({ status: 'timed-out' });
    expect(scheduler.stopCount).toBe(1);
    expect(source.state.returnCount).toBe(1);
    expect(harness.adapter.session).toMatchObject({ cancelCount: 1, closeCount: 1 });
  });

  it('uses the configured timeout boundary and ignores all late callbacks', async () => {
    const harness = runnerHarness();
    const source = pendingAudio();
    const execution = harness.runner.start(trialInput({
      audio: source, timeoutMs: MAX_TRIAL_TIMEOUT_MS
    }));
    await flush();
    harness.scheduler.fire();
    expect(await execution.result).toMatchObject({ status: 'timed-out' });
    const count = harness.evidence.records.length;
    harness.adapter.session?.fail();
    harness.adapter.session?.emitFinal();
    expect(harness.evidence.records).toHaveLength(count);
    expect(source.state.returnCount).toBe(1);
    expect(() => runnerHarness().runner.start(trialInput({ timeoutMs: 999 })))
      .toThrow(new RealtimeSpikeError('invalid-input'));
    expect(() => runnerHarness().runner.start(trialInput({ timeoutMs: 120_001 })))
      .toThrow(new RealtimeSpikeError('invalid-input'));
  });

  it('resolves once within a bound when terminal timing and iterator reflection throw/reenter', async () => {
    const scheduler = new FakeScheduler();
    let reenterCancel = (): void => undefined;
    const source = pendingAudioWithThrowingReturnGetter(() => { reenterCancel(); });
    const harness = runnerHarness({
      scheduler,
      adapterBehavior: {
        session: {
          onCancel: () => { reenterCancel(); },
          onClose: (session) => { session.fail(); }
        }
      }
    });
    const execution = harness.runner.start(trialInput({ audio: source }));
    reenterCancel = () => { execution.cancel(); };
    let resolutions = 0;
    void execution.result.then(() => { resolutions += 1; });
    await flush();
    scheduler.onStop = () => { scheduler.fire(); };
    harness.clock.throwNow = true;
    scheduler.fire();
    expect(await bounded(execution.result)).toMatchObject({ status: 'timed-out' });
    execution.cancel();
    scheduler.fire();
    harness.adapter.session?.fail();
    await flush();
    expect(resolutions).toBe(1);
    expect(scheduler.stopCount).toBe(1);
    expect(source.state.getterCount).toBe(1);
    expect(harness.adapter.session).toMatchObject({ cancelCount: 1, closeCount: 1 });
  });
});

describe('event sequence defenses', () => {
  async function expectEventFailure(
    emit: (session: FakeSession) => void,
    maxUtteranceSamples = 480_000
  ): Promise<void> {
    const source = pendingAudio();
    const harness = runnerHarness({ maxUtteranceSamples });
    const execution = harness.runner.start(trialInput({ audio: source }));
    await flush();
    emit(harness.adapter.session!);
    expect(await execution.result).toMatchObject({ status: 'failed' });
    expect(harness.adapter.session).toMatchObject({ cancelCount: 1, closeCount: 1 });
    expect(source.state.returnCount).toBe(1);
  }

  it('rejects foreign or stale identities', async () => {
    await expectEventFailure((session) => { session.emitPartial({ sessionId: UTTERANCE_ID }); });
    await expectEventFailure((session) => { session.emitPartial({ sessionEpoch: 2 }); });
    await expectEventFailure((session) => { session.emitPartial({ utteranceId: SESSION_ID }); });
  });

  it('rejects regressed revisions, offsets, conflicting segments, and configured-max excess', async () => {
    await expectEventFailure((session) => {
      session.emitPartial();
      session.emitPartial({ revision: 1 });
    });
    await expectEventFailure((session) => {
      session.emitPartial();
      session.emitPartial({ revision: 2, acceptedThroughOriginalSampleOffset: 0 });
    });
    await expectEventFailure((session) => {
      session.emitPartial();
      session.emitPartial({ revision: 2, segmentId: UTTERANCE_ID });
    });
    await expectEventFailure((session) => {
      session.emitPartial({ acceptedThroughOriginalSampleOffset: 2 });
    }, 1);
  });
});

function completedTrial(
  targetLanguage: SpikeTargetLanguage,
  latencyMs: number,
  expectedGate: 'accept' | 'reject',
  observedGate: 'accept' | 'reject',
  numerator = 1,
  denominator = 10
): SpikeTrialResult {
  return Object.freeze({
    status: 'completed', targetLanguage, latencyMs, expectedGate, observedGate,
    wer: Object.freeze({
      substitutions: numerator, deletions: 0, insertions: 0, numerator, denominator,
      wordErrorRate: denominator === 0 ? numerator === 0 ? 0 : 1 : numerator / denominator
    })
  });
}

function qualifiedTrials(count: number): SpikeTrialResult[] {
  const trials: SpikeTrialResult[] = [];
  for (let index = 1; index <= count; index += 1) {
    const expected = index % 2 === 0 ? 'accept' as const : 'reject' as const;
    trials.push(completedTrial('es', index, expected, expected));
    trials.push(completedTrial('tr', 99 + index, expected, expected, 2, 20));
  }
  return trials;
}

describe('aggregation qualification', () => {
  it('aggregates ES/TR independently with nearest-rank percentiles and no IDs', () => {
    const trials = qualifiedTrials(EXPLORATORY_MINIMUM_TRIALS);
    trials[0] = completedTrial('es', 1, 'reject', 'accept');
    trials[3] = completedTrial('tr', 101, 'accept', 'reject', 2, 20);
    const evidence = new MetadataEvidenceJsonlWriter();
    const aggregate = aggregateSpikeTrials({
      runId: CANARY, phase: 'exploratory', trials, evidence,
      clock: new FakeClock(), startedNs: 1_000_000_000n
    });
    expect(aggregate.es).toMatchObject({
      trialCount: 30, p50LatencyMs: 15, p95LatencyMs: 29,
      wer: { numerator: 30, denominator: 300 }, gate: { falseAccept: 1 }
    });
    expect(aggregate.tr).toMatchObject({
      trialCount: 30, p50LatencyMs: 114, p95LatencyMs: 128,
      wer: { numerator: 60, denominator: 600 }, gate: { falseReject: 1 }
    });
    expect(evidence.toJsonLines()).not.toContain(CANARY);
    expect(evidence.records.filter((record) => record.event === 'spike.aggregate.completed')
      .every((record) => record.status?.startsWith('es.') || record.status?.startsWith('tr.')))
      .toBe(true);
  });

  it('enforces exploratory/confirmation counts, both gate cells, and no survivor bias', () => {
    expect(() => aggregateSpikeTrials({
      runId: 'run', phase: 'exploratory',
      trials: qualifiedTrials(EXPLORATORY_MINIMUM_TRIALS - 1),
      evidence: new MetadataEvidenceJsonlWriter(), clock: new FakeClock()
    })).toThrow(new RealtimeSpikeError('insufficient-trials'));

    const failed = qualifiedTrials(EXPLORATORY_MINIMUM_TRIALS);
    failed[0] = { status: 'timed-out', targetLanguage: 'es' };
    expect(() => aggregateSpikeTrials({
      runId: 'run', phase: 'exploratory', trials: failed,
      evidence: new MetadataEvidenceJsonlWriter(), clock: new FakeClock()
    })).toThrow(new RealtimeSpikeError('insufficient-trials'));

    const oneCell = qualifiedTrials(EXPLORATORY_MINIMUM_TRIALS).map((trial) =>
      completedTrial(trial.targetLanguage, trial.latencyMs!, 'accept', 'accept'));
    expect(() => aggregateSpikeTrials({
      runId: 'run', phase: 'exploratory', trials: oneCell,
      evidence: new MetadataEvidenceJsonlWriter(), clock: new FakeClock()
    })).toThrow(new RealtimeSpikeError('insufficient-trials'));

    expect(aggregateSpikeTrials({
      runId: 'run', phase: 'confirmation', trials: qualifiedTrials(CONFIRMATION_MINIMUM_TRIALS),
      evidence: new MetadataEvidenceJsonlWriter(), clock: new FakeClock()
    })).toMatchObject({ es: { trialCount: 200 }, tr: { trialCount: 200 } });
  });

  it('rejects inconsistent WER rates and safe-integer sum overflow', () => {
    const invalidRate = qualifiedTrials(EXPLORATORY_MINIMUM_TRIALS);
    invalidRate[0] = {
      ...invalidRate[0]!, wer: { ...invalidRate[0]!.wer!, wordErrorRate: 0.2 }
    };
    expect(() => aggregateSpikeTrials({
      runId: 'run', phase: 'exploratory', trials: invalidRate,
      evidence: new MetadataEvidenceJsonlWriter(), clock: new FakeClock()
    })).toThrow(new RealtimeSpikeError('invalid-input'));

    const overflow = qualifiedTrials(EXPLORATORY_MINIMUM_TRIALS);
    overflow[0] = completedTrial('es', 1, 'reject', 'reject', Number.MAX_SAFE_INTEGER, 1);
    overflow[2] = completedTrial('es', 2, 'accept', 'accept', 1, 1);
    expect(() => aggregateSpikeTrials({
      runId: 'run', phase: 'exploratory', trials: overflow,
      evidence: new MetadataEvidenceJsonlWriter(), clock: new FakeClock()
    })).toThrow(new RealtimeSpikeError('invalid-input'));
  });
});

function memoryHandle(contents: Uint8Array, reportedSize = contents.byteLength) {
  let offset = 0;
  let closeCount = 0;
  const handle: RealtimeSpikeInputHandle = {
    stat: async () => ({ size: reportedSize }),
    read: async (buffer) => {
      const count = Math.min(buffer.byteLength, contents.byteLength - offset);
      buffer.set(contents.subarray(offset, offset + count));
      offset += count;
      return { bytesRead: count };
    },
    close: async () => { closeCount += 1; }
  };
  return { handle, closeCount: () => closeCount };
}

describe('bounded CLI and installed entry', () => {
  it('opens once, validates through the closed schema, and returns fixed output', async () => {
    const writer = new MetadataEvidenceJsonlWriter();
    writer.add(runRecord());
    const source = memoryHandle(Buffer.from(writer.toJsonLines()));
    const stdout: string[] = [];
    const stderr: string[] = [];
    let opens = 0;
    expect(await runRealtimeSpikeCli(['validate', CANARY], {
      openFile: async () => { opens += 1; return source.handle; },
      writeStdout: (value) => { stdout.push(value); },
      writeStderr: (value) => { stderr.push(value); }
    })).toBe(0);
    expect(opens).toBe(1);
    expect(source.closeCount()).toBe(1);
    expect(stdout).toEqual(['{"status":"valid"}\n']);
    expect(stderr).toEqual([]);
  });

  it('detects descriptor growth with a max+1 capped read and ignores path replacement', async () => {
    const growth = memoryHandle(Buffer.from('12345678901'), 5);
    const errors: string[] = [];
    expect(await runRealtimeSpikeCli(['validate', CANARY], {
      openFile: async () => growth.handle,
      writeStdout: () => undefined,
      writeStderr: (value) => { errors.push(value); },
      maxInputBytes: 10
    })).toBe(1);
    expect(growth.closeCount()).toBe(1);
    expect(errors).toEqual(['{"status":"failed"}\n']);

    const writer = new MetadataEvidenceJsonlWriter();
    writer.add(runRecord());
    const openedDescriptor = memoryHandle(Buffer.from(writer.toJsonLines()));
    let pathVersion = 'before-open';
    expect(await runRealtimeSpikeCli(['validate', 'replaced-after-open'], {
      openFile: async () => {
        pathVersion = 'replaced';
        return openedDescriptor.handle;
      },
      writeStdout: () => undefined,
      writeStderr: () => undefined
    })).toBe(0);
    expect(pathVersion).toBe('replaced');
  });

  it('retains the shebang and runs with exact output through an installed-bin symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'palancar-spike-bin-'));
    const evidenceFile = join(directory, 'evidence.jsonl');
    const bin = join(directory, 'palancar-realtime-spike');
    const builtMain = fileURLToPath(new URL('../dist/main.js', import.meta.url));
    const originalMode = (await stat(builtMain)).mode & 0o777;
    try {
      expect((await readFile(builtMain, 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true);
      await writeFile(evidenceFile, `${JSON.stringify(runRecord())}\n`, { mode: 0o600 });
      await chmod(builtMain, 0o755);
      await symlink(builtMain, bin);
      const result = await execFileAsync(bin, ['validate', evidenceFile]);
      expect(result.stdout).toBe('{"status":"valid"}\n');
      expect(result.stderr).toBe('');
    } finally {
      await chmod(builtMain, originalMode);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('records run start without any caller IDs or versions', () => {
    const evidence = new MetadataEvidenceJsonlWriter();
    const record = recordSpikeRunStarted({
      evidence, clock: new FakeClock(), runId: CANARY, configurationVersion: CANARY
    });
    expect(record).toEqual(expect.objectContaining({ event: 'spike.run.started', status: 'started' }));
    expect(JSON.stringify(record)).not.toContain(CANARY);
    expect(nanosecondsToMilliseconds(1_500_000n)).toBe(1.5);
  });
});
