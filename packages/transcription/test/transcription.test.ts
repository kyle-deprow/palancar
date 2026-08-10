import { evaluateLanguageGate } from '@palancar/language-registry';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DETERMINISTIC_MOCK_CAPABILITIES,
  DeterministicMockTranscriptionAdapter,
  DeterministicMockTranscriptionSession,
  EvidenceValidationError,
  MetadataEvidenceCollector,
  NormalizedEventSequence,
  TranscriptionSessionError,
  createDeterministicMockScript,
  createMetadataEvidenceRecord,
  isMetadataEvidenceRecord,
  parseMetadataEvidenceJsonLines,
  type MockLanguageEvidenceCategory,
  type NormalizedTranscriptionEvent,
  type NormalizedTranscriptionPartial,
  type TranscriptionSession,
  type TranscriptionSessionConfiguration
} from '../src/index.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';
const NEXT_UTTERANCE_ID = '33333333-3333-4333-8333-333333333333';
const WRONG_UTTERANCE_ID = '44444444-4444-4444-8444-444444444444';
const TIMESTAMP = '2026-08-10T00:00:00.000Z';
const CATEGORIES: readonly MockLanguageEvidenceCategory[] = [
  'selected-target',
  'english',
  'supported-unselected',
  'mixed',
  'unsupported',
  'uncertain'
];

const DEFAULT_CONFIGURATION: TranscriptionSessionConfiguration = {
  serverVadMode: 'enabled',
  languageMode: 'automatic',
  manualCommitCadenceMs: 600
};

function createSession(options: {
  readonly events?: NormalizedTranscriptionEvent[];
  readonly evidenceCategory?: MockLanguageEvidenceCategory;
  readonly configuration?: TranscriptionSessionConfiguration;
  readonly maxUtteranceSamples?: number;
  readonly onEvent?: (event: NormalizedTranscriptionEvent) => void;
  readonly onDeliveryFailure?: (status: {
    readonly failureCount: number;
  }) => void;
} = {}): TranscriptionSession {
  const events = options.events ?? [];
  return new DeterministicMockTranscriptionAdapter({
    evidenceCategory: options.evidenceCategory ?? 'selected-target'
  }).createSession({
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    configuration: options.configuration ?? DEFAULT_CONFIGURATION,
    onEvent: options.onEvent ?? ((event) => events.push(event)),
    ...(options.onDeliveryFailure === undefined
      ? {}
      : { onDeliveryFailure: options.onDeliveryFailure }),
    ...(options.maxUtteranceSamples === undefined
      ? {}
      : { maxUtteranceSamples: options.maxUtteranceSamples })
  });
}

function start(
  session: TranscriptionSession,
  utteranceId = UTTERANCE_ID,
  selectedTargetLanguage: 'es' | 'tr' = 'es'
): void {
  expect(
    session.start({
      utteranceId,
      selectedTargetLanguage
    })
  ).toEqual({ status: 'started' });
}

function pushSamples(
  session: TranscriptionSession,
  sampleOffset: number,
  sampleCount: number,
  utteranceId = UTTERANCE_ID
): void {
  const pcm = Uint8Array.from(
    { length: sampleCount * 2 },
    (_, index) => (sampleOffset * 2 + index) % 251
  );
  expect(
    session.pushAudio({
      utteranceId,
      originalSampleOffset: sampleOffset,
      pcm
    })
  ).toMatchObject({
    status: 'accepted',
    acceptedSamples: sampleCount,
    acceptedThroughOriginalSampleOffset: sampleOffset + sampleCount
  });
}

function expectErrorReason(run: () => unknown, reason: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ reason });
}

describe('provider-neutral capabilities', () => {
  it('declares all provider, audio, segmentation, language, and retention choices', () => {
    expect(DETERMINISTIC_MOCK_CAPABILITIES).toEqual({
      identity: {
        provider: 'deterministic-mock',
        model: 'symmetric-language-script',
        version: '1.0.0'
      },
      acceptedInput: { sampleRateHz: 16_000, sampleFormat: 's16le', channels: 1 },
      providerInput: { sampleRateHz: 16_000, sampleFormat: 's16le', channels: 1 },
      resampling: { mode: 'native', stateful: false },
      serverVad: { supported: true, modes: ['enabled', 'disabled'] },
      manualCommit: { supported: true, cadencesMs: [600, 800, 1_000, 3_000] },
      languageModes: ['automatic', 'selected-target-hint'],
      partialResults: { supported: true },
      providerRetention: {
        status: 'not-applicable-synthetic',
        evidenceVersion: '1.0.0'
      }
    });
    expect(Object.isFrozen(DETERMINISTIC_MOCK_CAPABILITIES)).toBe(true);
  });

  it('validates and exposes executable immutable session modes', () => {
    for (const serverVadMode of ['enabled', 'disabled'] as const) {
      for (const languageMode of ['automatic', 'selected-target-hint'] as const) {
        for (const manualCommitCadenceMs of [600, 800, 1_000, 3_000]) {
          const configuration = {
            serverVadMode,
            languageMode,
            manualCommitCadenceMs
          };
          const session = createSession({ configuration });
          expect(session.configuration).toEqual(configuration);
          expect(Object.isFrozen(session.configuration)).toBe(true);
          configuration.manualCommitCadenceMs = 999;
          expect(session.configuration.manualCommitCadenceMs).toBe(
            manualCommitCadenceMs
          );
        }
      }
    }
  });

  it('executes every cadence and both language metadata paths', () => {
    for (const manualCommitCadenceMs of [600, 800, 1_000, 3_000]) {
      const cadenceSamples = manualCommitCadenceMs * 16;
      for (const languageMode of ['automatic', 'selected-target-hint'] as const) {
        const events: NormalizedTranscriptionEvent[] = [];
        const session = createSession({
          events,
          evidenceCategory: 'selected-target',
          configuration: {
            serverVadMode: 'enabled',
            languageMode,
            manualCommitCadenceMs
          }
        });
        start(session);
        pushSamples(session, 0, cadenceSamples);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: 'transcript.partial',
          acceptedThroughOriginalSampleOffset: cadenceSamples
        });
        pushSamples(session, cadenceSamples, cadenceSamples);
        expect(events).toHaveLength(2);
        pushSamples(session, cadenceSamples * 2, cadenceSamples);
        expect(events).toHaveLength(3);
        expect(events.at(-1)).toMatchObject({
          type: 'transcript.final',
          acceptedThroughOriginalSampleOffset: cadenceSamples * 3,
          finalizationReason: 'script-threshold',
          languageEvidence: {
            detectedLanguage: 'es',
            source: languageMode === 'automatic'
              ? 'transcription-metadata'
              : 'controlled-fixture'
          }
        });
        expect(events.at(-1)?.languageEvidence.detectorVersion).toContain(
          languageMode === 'automatic' ? 'automatic' : 'selected-target-hint-es'
        );
      }
    }
  });

  it.each([
    [{ ...DEFAULT_CONFIGURATION, serverVadMode: 'other' }, 'VAD'],
    [{ ...DEFAULT_CONFIGURATION, languageMode: 'other' }, 'language'],
    [{ ...DEFAULT_CONFIGURATION, manualCommitCadenceMs: 999 }, 'cadence']
  ])('rejects unsupported configuration %# without mutation', (configuration, label) => {
    const snapshot = { ...configuration };
    expect(() => createSession({
      configuration: configuration as TranscriptionSessionConfiguration
    })).toThrow(new RegExp(label, 'i'));
    expect(configuration).toEqual(snapshot);
  });

  it('validates and freezes mock evidence selection before session creation', () => {
    const configuration = {
      evidenceCategory: 'english' as MockLanguageEvidenceCategory
    };
    const adapter = new DeterministicMockTranscriptionAdapter(configuration);
    const snapshot = { ...configuration };
    expect(adapter.configuration).toEqual(snapshot);
    expect(Object.isFrozen(adapter.configuration)).toBe(true);
    configuration.evidenceCategory = 'mixed';
    expect(adapter.configuration).toEqual(snapshot);

    const invalid = { evidenceCategory: 'invalid-runtime-category' };
    const invalidSnapshot = { ...invalid };
    expect(() => new DeterministicMockTranscriptionAdapter(
      invalid as never
    )).toThrow(/evidence category/i);
    expect(invalid).toEqual(invalidSnapshot);
  });

  it('direct constructor rejects invalid mock configuration before input access', () => {
    let inputReads = 0;
    const poisonInput = new Proxy({}, {
      get: () => {
        inputReads += 1;
        throw new Error('session input must not be read');
      }
    });
    const invalid = { evidenceCategory: 'invalid-runtime-category' };
    const snapshot = { ...invalid };
    expect(() => new DeterministicMockTranscriptionSession(
      poisonInput as never,
      invalid as never
    )).toThrow(/evidence category/i);
    expect(inputReads).toBe(0);
    expect(invalid).toEqual(snapshot);
  });

  it('direct constructor defensively retains its validated mock configuration', () => {
    const events: NormalizedTranscriptionEvent[] = [];
    const mockConfiguration = {
      evidenceCategory: 'english' as MockLanguageEvidenceCategory
    };
    const session = new DeterministicMockTranscriptionSession({
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      configuration: DEFAULT_CONFIGURATION,
      onEvent: (event) => events.push(event)
    }, mockConfiguration);
    mockConfiguration.evidenceCategory = 'mixed';
    start(session);
    pushSamples(session, 0, 28_800);
    expect(events.at(-1)?.languageEvidence.detectedLanguage).toBe('en');
  });
});

describe('session lifecycle and offsets', () => {
  it('enforces one active utterance and idempotent start/finalize/cancel/close', () => {
    const events: NormalizedTranscriptionEvent[] = [];
    const session = createSession({ events });
    const input = {
      utteranceId: UTTERANCE_ID,
      selectedTargetLanguage: 'es' as const
    };
    expect(session.start(input)).toEqual({ status: 'started' });
    expect(session.start(input)).toEqual({ status: 'already-active' });
    expectErrorReason(() =>
      session.start({ ...input, utteranceId: NEXT_UTTERANCE_ID })
    , 'active-utterance');

    pushSamples(session, 0, 1);
    const finalized = session.finalize(UTTERANCE_ID);
    expect(finalized).toMatchObject({
      status: 'finalized',
      event: {
        type: 'transcript.final',
        finalizationReason: 'explicit',
        acceptedThroughOriginalSampleOffset: 1
      }
    });
    expect(session.finalize(UTTERANCE_ID)).toMatchObject({
      status: 'already-finalized'
    });
    expect(session.cancel(UTTERANCE_ID)).toEqual({ status: 'already-finalized' });

    start(session, NEXT_UTTERANCE_ID);
    expect(session.cancel(NEXT_UTTERANCE_ID)).toEqual({ status: 'cancelled' });
    expect(session.cancel(NEXT_UTTERANCE_ID)).toEqual({ status: 'already-cancelled' });
    expect(session.finalize(NEXT_UTTERANCE_ID)).toEqual({
      status: 'already-cancelled'
    });
    expect(session.close()).toEqual({ status: 'closed' });
    expect(session.close()).toEqual({ status: 'already-closed' });
    expectErrorReason(() => session.start(input), 'closed');
    expect(events).toHaveLength(1);
  });

  it('accepts copied non-zero views and Buffer subclasses as original-rate PCM', () => {
    const session = createSession();
    start(session);
    const backing = Uint8Array.from([99, 1, 2, 3, 4, 88]);
    const view = backing.subarray(1, 5);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: view
    });
    backing.fill(0);
    expect(session.state.acceptedThroughOriginalSampleOffset).toBe(2);

    const bufferConstructor = (globalThis as unknown as {
      readonly Buffer?: { from(input: readonly number[]): Uint8Array };
    }).Buffer;
    if (bufferConstructor !== undefined) {
      const buffer = bufferConstructor.from([5, 6]);
      session.pushAudio({
        utteranceId: UTTERANCE_ID,
        originalSampleOffset: 2,
        pcm: buffer
      });
      buffer.fill(0);
    }
    expect(session.state.acceptedThroughOriginalSampleOffset).toBe(
      bufferConstructor === undefined ? 2 : 3
    );
  });

  it('keeps original offsets authoritative and resets identity state at terminal/new turn', () => {
    const events: NormalizedTranscriptionEvent[] = [];
    const session = createSession({ events });
    start(session);
    const startEpoch = session.state.audioStateEpoch;
    pushSamples(session, 0, 28_800);
    expect(events.at(-1)).toMatchObject({
      type: 'transcript.final',
      acceptedThroughOriginalSampleOffset: 28_800,
      finalizationReason: 'script-threshold'
    });
    expect(session.state.audioStateEpoch).toBe(startEpoch + 1);

    start(session, NEXT_UTTERANCE_ID, 'tr');
    expect(session.state.acceptedThroughOriginalSampleOffset).toBe(0);
    expect(session.state.audioStateEpoch).toBe(startEpoch + 2);
    pushSamples(session, 0, 1, NEXT_UTTERANCE_ID);
  });

  it('requires explicit finalize when VAD is disabled', () => {
    const events: NormalizedTranscriptionEvent[] = [];
    const session = createSession({
      events,
      configuration: {
        serverVadMode: 'disabled',
        languageMode: 'selected-target-hint',
        manualCommitCadenceMs: 800
      }
    });
    start(session);
    pushSamples(session, 0, 25_600);
    expect(events.map((event) => event.type)).toEqual([
      'transcript.partial',
      'transcript.partial'
    ]);
    expect(session.state.activeUtteranceId).toBe(UTTERANCE_ID);
    expect(session.finalize(UTTERANCE_ID)).toMatchObject({
      status: 'finalized',
      event: { finalizationReason: 'explicit' }
    });
  });

  it('rejects malformed ordering, stale IDs, and one-over overflow without mutation', () => {
    const session = createSession({
      maxUtteranceSamples: 3,
      configuration: {
        serverVadMode: 'disabled',
        languageMode: 'automatic',
        manualCommitCadenceMs: 600
      }
    });
    start(session);

    const invalidCases = [
      {
        expected: 'invalid-audio',
        input: { originalSampleOffset: 0, pcm: new Uint8Array(0) }
      },
      {
        expected: 'invalid-audio',
        input: { originalSampleOffset: 0, pcm: Uint8Array.of(1) }
      },
      {
        expected: 'gap',
        input: { originalSampleOffset: 1, pcm: Uint8Array.of(1, 2) }
      },
      {
        expected: 'wrong-utterance',
        input: {
          utteranceId: WRONG_UTTERANCE_ID,
          originalSampleOffset: 0,
          pcm: Uint8Array.of(1, 2)
        }
      }
    ] as const;

    for (const invalid of invalidCases) {
      const before = session.state;
      expectErrorReason(() =>
        session.pushAudio({
          utteranceId:
            'utteranceId' in invalid.input
              ? invalid.input.utteranceId
              : UTTERANCE_ID,
          originalSampleOffset: invalid.input.originalSampleOffset,
          pcm: invalid.input.pcm
        })
      , invalid.expected);
      expect(session.state).toEqual(before);
    }

    pushSamples(session, 0, 3);
    const exactState = session.state;
    expectErrorReason(() =>
      session.pushAudio({
        utteranceId: UTTERANCE_ID,
        originalSampleOffset: 3,
        pcm: Uint8Array.of(1, 2)
      })
    , 'utterance-overflow');
    expectErrorReason(() =>
      session.pushAudio({
        utteranceId: UTTERANCE_ID,
        originalSampleOffset: 2,
        pcm: Uint8Array.of(1, 2)
      })
    , 'overlap');
    expect(session.state).toEqual(exactState);

    session.cancel(UTTERANCE_ID);
    expectErrorReason(() =>
      session.pushAudio({
        utteranceId: UTTERANCE_ID,
        originalSampleOffset: 3,
        pcm: Uint8Array.of(1, 2)
      })
    , 'stale-utterance');
  });

  it('emits no late event when a partial callback cancels or after close', () => {
    const events: NormalizedTranscriptionEvent[] = [];
    const holder: { session?: TranscriptionSession } = {};
    const session = createSession({
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'transcript.partial') {
          holder.session?.cancel(event.utteranceId);
        }
      }
    });
    holder.session = session;
    start(session);
    pushSamples(session, 0, 9_600);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('transcript.partial');
    expect(session.close()).toEqual({ status: 'closed' });
    expect(() => pushSamples(session, 9_600, 1)).toThrow(TranscriptionSessionError);
    expect(events).toHaveLength(1);
  });

  it('contains event and failure-hook throws after committed mutation', () => {
    let failureHookCalls = 0;
    const session = createSession({
      onEvent: () => {
        throw new Error('content callback failure');
      },
      onDeliveryFailure: (status) => {
        failureHookCalls += 1;
        expect(status.failureCount).toBe(failureHookCalls);
        throw new Error('contained failure hook');
      }
    });
    start(session);
    expect(() => pushSamples(session, 0, 9_600)).not.toThrow();
    expect(session.state.acceptedThroughOriginalSampleOffset).toBe(9_600);
    expect(session.deliveryFailures).toEqual({
      failureCount: 1,
      lastFailure: { eventType: 'transcript.partial', revision: 1 }
    });
    expectErrorReason(() =>
      session.pushAudio({
        utteranceId: UTTERANCE_ID,
        originalSampleOffset: 0,
        pcm: Uint8Array.of(1, 2)
      }), 'overlap');
    const result = session.finalize(UTTERANCE_ID);
    expect(result.status).toBe('finalized');
    expect(session.deliveryFailures.failureCount).toBe(2);
    expect(failureHookCalls).toBe(2);
    expect(session.finalize(UTTERANCE_ID).status).toBe('already-finalized');
    expect(session.deliveryFailures.failureCount).toBe(2);
  });
});

describe('normalized deterministic events', () => {
  it('caps deterministic cadence thresholds at the effective utterance limit', () => {
    const script = createDeterministicMockScript('es', 'selected-target', {
      languageMode: 'automatic',
      manualCommitCadenceMs: 600,
      maxUtteranceSamples: 10_000
    });
    expect(script.partials.map((partial) => partial.atAcceptedSamples)).toEqual([
      9_600
    ]);
    expect(script.final.atAcceptedSamples).toBe(10_000);
  });

  it('uses stable segment IDs, monotonic revisions, timestamps, and final reason', () => {
    const events: NormalizedTranscriptionEvent[] = [];
    const session = createSession({ events });
    start(session);
    pushSamples(session, 0, 9_600);
    pushSamples(session, 9_600, 9_600);
    pushSamples(session, 19_200, 9_600);

    expect(events.map((event) => event.revision)).toEqual([1, 2, 3]);
    expect(new Set(events.map((event) => event.segmentId)).size).toBe(1);
    expect(events.map((event) => event.providerEventTime)).toEqual([
      '2026-08-10T00:00:00.001Z',
      '2026-08-10T00:00:00.002Z',
      '2026-08-10T00:00:00.003Z'
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'transcript.final',
      finalizationReason: 'script-threshold'
    });
  });

  it('rejects stale revisions and changed segment identities', () => {
    const sequence = new NormalizedEventSequence(SESSION_ID, 1, UTTERANCE_ID);
    sequence.advanceAcceptedHighWaterMark(2);
    const base: NormalizedTranscriptionPartial = {
      type: 'transcript.partial',
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      revision: 1,
      text: 'synthetic-partial',
      providerEventTime: TIMESTAMP,
      languageEvidence: {
        detectedLanguage: 'es',
        confidence: 0.9,
        detectorVersion: 'mock-1',
        source: 'controlled-fixture'
      },
      acceptedThroughOriginalSampleOffset: 2
    };
    const accepted = sequence.accept(base);
    expect(accepted).not.toBe(base);
    expect(accepted).toEqual(base);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.languageEvidence)).toBe(true);
    expectErrorReason(() => sequence.accept({ ...base }), 'stale-revision');
    expectErrorReason(() =>
      sequence.accept({ ...base, revision: 2, segmentId: 'segment-2' })
    , 'stale-revision');
  });

  it('rejects invalid extensions and offset regression without sequence mutation', () => {
    const sequence = new NormalizedEventSequence(SESSION_ID, 1, UTTERANCE_ID);
    sequence.advanceAcceptedHighWaterMark(4);
    const base: NormalizedTranscriptionPartial = {
      type: 'transcript.partial',
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      revision: 1,
      text: 'synthetic-partial',
      providerEventTime: TIMESTAMP,
      languageEvidence: {
        detectedLanguage: 'es',
        confidence: 0.9,
        detectorVersion: 'mock-1',
        source: 'controlled-fixture'
      },
      acceptedThroughOriginalSampleOffset: 2
    };
    const invalid = [
      { ...base, acceptedThroughOriginalSampleOffset: 5 },
      { ...base, languageEvidence: { ...base.languageEvidence, confidence: Number.NaN } },
      { ...base, languageEvidence: { ...base.languageEvidence, confidence: 2 } },
      { ...base, languageEvidence: { ...base.languageEvidence, detectedLanguage: '' } },
      { ...base, languageEvidence: { ...base.languageEvidence, detectorVersion: '' } },
      { ...base, languageEvidence: { ...base.languageEvidence, source: 'other' } },
      { ...base, unknown: true }
    ];
    for (const event of invalid) {
      expectErrorReason(
        () => sequence.accept(event as NormalizedTranscriptionPartial),
        'stale-revision'
      );
    }
    expect(sequence.accept(base).revision).toBe(1);
    expectErrorReason(() => sequence.accept({
      ...base,
      revision: 2,
      acceptedThroughOriginalSampleOffset: 1
    }), 'stale-revision');
    expect(sequence.accept({
      ...base,
      revision: 2,
      acceptedThroughOriginalSampleOffset: 4
    }).revision).toBe(2);
  });

  it('defensively copies mutable input and validates finalization reasons', () => {
    const sequence = new NormalizedEventSequence(SESSION_ID, 1, UTTERANCE_ID);
    sequence.advanceAcceptedHighWaterMark(2);
    const evidence = {
      detectedLanguage: 'es',
      confidence: 0.9,
      detectorVersion: 'mock-1',
      source: 'controlled-fixture' as const
    };
    const input: NormalizedTranscriptionPartial = {
      type: 'transcript.partial',
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      segmentId: 'segment-1',
      revision: 1,
      text: 'synthetic-partial',
      providerEventTime: TIMESTAMP,
      languageEvidence: evidence,
      acceptedThroughOriginalSampleOffset: 2
    };
    const accepted = sequence.accept(input);
    evidence.confidence = 0.1;
    (input as unknown as { text: string }).text = 'mutated-after-accept';
    expect(accepted.text).toBe('synthetic-partial');
    expect(accepted.languageEvidence.confidence).toBe(0.9);

    const finalSequence = new NormalizedEventSequence(
      SESSION_ID,
      1,
      NEXT_UTTERANCE_ID
    );
    finalSequence.advanceAcceptedHighWaterMark(2);
    expectErrorReason(() => finalSequence.accept({
      ...input,
      type: 'transcript.final',
      utteranceId: NEXT_UTTERANCE_ID,
      finalizationReason: 'other'
    } as never), 'stale-revision');
  });

  it('scripts every evidence category symmetrically for both selected targets', () => {
    const expectedDetected = {
      es: {
        'selected-target': 'es',
        english: 'en',
        'supported-unselected': 'tr',
        mixed: 'mixed',
        unsupported: 'fr',
        uncertain: undefined
      },
      tr: {
        'selected-target': 'tr',
        english: 'en',
        'supported-unselected': 'es',
        mixed: 'mixed',
        unsupported: 'fr',
        uncertain: undefined
      }
    } as const;
    const expectedDecision = {
      'selected-target': 'target',
      english: 'english',
      'supported-unselected': 'supported_unselected',
      mixed: 'mixed',
      unsupported: 'unsupported',
      uncertain: 'uncertain'
    } as const;

    for (const selectedTargetLanguage of ['es', 'tr'] as const) {
      for (const languageMode of ['automatic', 'selected-target-hint'] as const) {
        for (const category of CATEGORIES) {
          const script = createDeterministicMockScript(
            selectedTargetLanguage,
            category,
            {
              languageMode,
              manualCommitCadenceMs: 600,
              maxUtteranceSamples: 480_000
            }
          );
          expect(script.partials.map((partial) => partial.atAcceptedSamples)).toEqual([
            9_600,
            19_200
          ]);
          expect(script.final.atAcceptedSamples).toBe(28_800);
          expect(script.languageEvidence.detectedLanguage).toBe(
            expectedDetected[selectedTargetLanguage][category]
          );

          const events: NormalizedTranscriptionEvent[] = [];
          const session = createSession({
            events,
            evidenceCategory: category,
            configuration: {
              serverVadMode: 'enabled',
              languageMode,
              manualCommitCadenceMs: 600
            }
          });
          start(session, UTTERANCE_ID, selectedTargetLanguage);
          pushSamples(session, 0, 28_800);
          expect(events).toHaveLength(3);
          expect(events.at(-1)?.languageEvidence).toEqual(script.languageEvidence);
          for (const event of events) {
            const result = evaluateLanguageGate({
              selectedLanguage: selectedTargetLanguage,
              evidence: {
                ...event.languageEvidence,
                text: event.text
              },
              isFinal: event.type === 'transcript.final'
            });
            if (event.type === 'transcript.partial') {
              expect(result).toMatchObject({
                decision: 'provisional',
                generationAllowed: false
              });
            } else {
              expect(result).toMatchObject({
                decision: expectedDecision[category],
                generationAllowed: category === 'selected-target'
              });
            }
          }
        }
      }
    }
  });

  it('preserves arbitrary even partitions with recorded seed 20260810', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.integer({ min: 1, max: 5 }), {
          minLength: 1,
          maxLength: 12
        }),
        (sampleCount, requestedSizes) => {
          const session = createSession();
          start(session);
          let offset = 0;
          let sizeIndex = 0;
          while (offset < sampleCount) {
            const requested = requestedSizes[sizeIndex % requestedSizes.length] ?? 1;
            const count = Math.min(requested, sampleCount - offset);
            pushSamples(session, offset, count);
            offset += count;
            sizeIndex += 1;
          }
          expect(session.state.acceptedThroughOriginalSampleOffset).toBe(sampleCount);
          expect(session.finalize(UTTERANCE_ID).status).toBe('finalized');
        }
      ),
      { seed: 20_260_810, numRuns: 250, endOnFailure: true }
    );
  });

  it('matches a lifecycle reference model with recorded seed 715123420', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(
          'push',
          'gap',
          'overlap',
          'finalize',
          'cancel',
          'start-same',
          'close'
        ), {
          minLength: 1,
          maxLength: 30
        }),
        (actions) => {
          const events: NormalizedTranscriptionEvent[] = [];
          const session = createSession({
            events,
            configuration: {
              serverVadMode: 'disabled',
              languageMode: 'automatic',
              manualCommitCadenceMs: 600
            }
          });
          start(session);
          const model: {
            closed: boolean;
            terminal: 'active' | 'finalized' | 'cancelled';
            offset: number;
          } = { closed: false, terminal: 'active', offset: 0 };
          for (const action of actions) {
            const before = session.state;
            if (action === 'close') {
              expect(session.close().status).toBe(
                model.closed ? 'already-closed' : 'closed'
              );
              model.closed = true;
              if (model.terminal === 'active') {
                model.terminal = 'cancelled';
              }
              model.offset = 0;
            } else if (model.closed) {
              expectErrorReason(() => {
                if (action === 'start-same') {
                  session.start({
                    utteranceId: UTTERANCE_ID,
                    selectedTargetLanguage: 'es'
                  });
                } else if (action === 'finalize') {
                  session.finalize(UTTERANCE_ID);
                } else if (action === 'cancel') {
                  session.cancel(UTTERANCE_ID);
                } else {
                  session.pushAudio({
                    utteranceId: UTTERANCE_ID,
                    originalSampleOffset: model.offset,
                    pcm: Uint8Array.of(1, 2)
                  });
                }
              }, 'closed');
            } else if (action === 'start-same') {
              if (model.terminal === 'active') {
                expect(session.start({
                  utteranceId: UTTERANCE_ID,
                  selectedTargetLanguage: 'es'
                })).toEqual({ status: 'already-active' });
              } else {
                expectErrorReason(() => session.start({
                  utteranceId: UTTERANCE_ID,
                  selectedTargetLanguage: 'es'
                }), 'stale-utterance');
              }
            } else if (action === 'finalize') {
              const result = session.finalize(UTTERANCE_ID);
              expect(result.status).toBe(
                model.terminal === 'active'
                  ? 'finalized'
                  : model.terminal === 'finalized'
                    ? 'already-finalized'
                    : 'already-cancelled'
              );
              if (model.terminal === 'active') {
                model.terminal = 'finalized';
                model.offset = 0;
              }
            } else if (action === 'cancel') {
              const result = session.cancel(UTTERANCE_ID);
              expect(result.status).toBe(
                model.terminal === 'active'
                  ? 'cancelled'
                  : model.terminal === 'cancelled'
                    ? 'already-cancelled'
                    : 'already-finalized'
              );
              if (model.terminal === 'active') {
                model.terminal = 'cancelled';
                model.offset = 0;
              }
            } else if (model.terminal !== 'active') {
              expectErrorReason(() => session.pushAudio({
                utteranceId: UTTERANCE_ID,
                originalSampleOffset: model.offset,
                pcm: Uint8Array.of(1, 2)
              }), 'stale-utterance');
            } else if (action === 'push') {
              pushSamples(session, model.offset, 1);
              model.offset += 1;
            } else {
              expectErrorReason(() => session.pushAudio({
                utteranceId: UTTERANCE_ID,
                originalSampleOffset:
                  action === 'gap' ? model.offset + 1 : model.offset - 1,
                pcm: Uint8Array.of(1, 2)
              }), action === 'gap' ? 'gap' : model.offset === 0 ? 'invalid-audio' : 'overlap');
              expect(session.state).toEqual(before);
            }
            expect(session.state.closed).toBe(model.closed);
            expect(session.state.acceptedThroughOriginalSampleOffset).toBe(model.offset);
            expect(session.state.activeUtteranceId).toBe(
              !model.closed && model.terminal === 'active' ? UTTERANCE_ID : undefined
            );
            expect(events.map((event) => event.revision)).toEqual(
              [...events].map((event) => event.revision).sort((left, right) => left - right)
            );
          }
        }
      ),
      { seed: 715_123_420, numRuns: 250, endOnFailure: true }
    );
  });
});

describe('metadata-only evidence', () => {
  const validRecord = () => ({
    event: 'spike.completed',
    timestamp: TIMESTAMP,
    sessionId: 'opaque-session-1',
    status: 'accepted',
    configurationVersion: '1.0.0',
    modelVersion: 'mock-1.0.0',
    providerVersion: 'mock-provider-1',
    sampleCount: 6,
    byteCount: 12,
    tokenCount: 3,
    latencyMs: 12.5,
    scores: {
      accuracy: 0.95,
      confidenceLowerBound: 0.9,
      confidenceUpperBound: 0.98
    }
  });

  it('accepts only allow-listed finite metadata and deep-freezes a copy', () => {
    const input = validRecord();
    const record = createMetadataEvidenceRecord(input);
    input.scores.accuracy = 0.1;
    expect(record.scores?.accuracy).toBe(0.95);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.scores)).toBe(true);
    expect(isMetadataEvidenceRecord(record)).toBe(true);
  });

  it.each([
    ['PCM', { pcm: 'canary' }],
    ['audio casing', { AuDiOBytes: 'canary' }],
    ['transcript nesting', { metadata: { TranscriptText: 'canary' } }],
    ['translation', { translation: 'canary' }],
    ['suggestions', { suggestions: ['canary'] }],
    ['prompt', { request: { PROMPT: 'canary' } }],
    ['provider response', { providerBody: { value: 'canary' } }],
    ['credential', { Credential: 'canary' }],
    ['token', { accessToken: 'canary' }],
    ['key', { apiKey: 'canary' }]
  ])('rejects forbidden %s keys at any depth', (_label, canary) => {
    expect(() => createMetadataEvidenceRecord({ ...validRecord(), ...canary }))
      .toThrow(EvidenceValidationError);
  });

  it('rejects binary values including views, subclasses, buffers, and Blob-like objects', () => {
    class BinarySubclass extends Uint8Array {}
    const binaries: unknown[] = [
      new ArrayBuffer(2),
      new Uint8Array(2),
      new DataView(new ArrayBuffer(2)),
      new BinarySubclass(2),
      {
        size: 2,
        type: 'application/octet-stream',
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(2)),
        stream: () => ({})
      }
    ];
    const bufferConstructor = (globalThis as unknown as {
      readonly Buffer?: { from(input: readonly number[]): Uint8Array };
    }).Buffer;
    if (bufferConstructor !== undefined) {
      binaries.push(bufferConstructor.from([1, 2]));
    }
    if (typeof Blob !== 'undefined') {
      binaries.push(new Blob([Uint8Array.of(1, 2)]));
    }

    for (const binary of binaries) {
      expectErrorReason(() =>
        createMetadataEvidenceRecord({
          ...validRecord(),
          unknownMetadata: { nested: binary }
        })
      , 'binary-value');
    }
  });

  it('rejects cyclic metadata before collection', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectErrorReason(() => createMetadataEvidenceRecord({
      ...validRecord(),
      metadata: cyclic
    }), 'cyclic-value');
  });

  it.each([
    ['unknown field', { extra: 1 }],
    ['unknown nested score', { scores: { accuracy: 0.9, textScore: 0.8 } }],
    ['NaN', { latencyMs: Number.NaN }],
    ['infinity', { scores: { accuracy: Number.POSITIVE_INFINITY } }],
    ['negative count', { sampleCount: -1 }],
    ['fractional count', { byteCount: 1.5 }],
    ['invalid timestamp', { timestamp: '2026-02-30T00:00:00Z' }]
  ])('rejects %s', (_label, invalid) => {
    expect(() => createMetadataEvidenceRecord({ ...validRecord(), ...invalid }))
      .toThrow(EvidenceValidationError);
  });

  it('collects immutable records and round-trips content-free JSONL', () => {
    const collector = new MetadataEvidenceCollector();
    collector.add(validRecord());
    collector.add({
      event: 'gate.scored',
      timestamp: '2026-08-10T00:00:01Z',
      status: 'rejected',
      scores: { gateRejectionRate: 1 }
    });
    const jsonLines = collector.toJsonLines();
    expect(jsonLines.endsWith('\n')).toBe(true);
    expect(jsonLines).not.toMatch(/conversation|transcript|prompt|audio/i);
    expect(parseMetadataEvidenceJsonLines(jsonLines)).toEqual(collector.records);
    expect(Object.isFrozen(collector.records)).toBe(true);
  });
});
