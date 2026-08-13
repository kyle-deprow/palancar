import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_NEGOTIATED_LIMITS, encodeAudioFrame } from '@palancar/contracts';
import {
  GenerationService,
  type GenerationProvider,
  type GenerationProviderCompletion
} from '@palancar/generation';
import type {
  CancelResult,
  CloseResult,
  EventDeliveryFailureStatus,
  FinalizeResult,
  NormalizedTranscriptionEvent,
  PushAudioResult,
  TranscriptionAdapter,
  TranscriptionSession,
  TranscriptionSessionState,
  StartUtteranceResult
} from '@palancar/transcription';
import { DETERMINISTIC_MOCK_CAPABILITIES } from '@palancar/transcription';
import {
  RelaySessionCore,
  createTestOptions,
  createTestSubprotocols,
  createTestTicketClaim,
  TEST_GATE_POLICY_VERSION,
  TEST_SECOND_UTTERANCE_ID,
  TEST_SESSION_ID,
  TEST_TICKET,
  TEST_UTTERANCE_ID,
  negotiateLimits,
  prepareStreamUpgrade,
  selectStreamSubprotocols
} from '../src/index.js';

const START_LIMITS = DEFAULT_NEGOTIATED_LIMITS;

async function flushAsyncEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function startText(
  targetLanguage: 'es' | 'tr' = 'es',
  requestedLimits = START_LIMITS
): string {
  return JSON.stringify({
    type: 'session.start',
    protocolVersion: 1,
    wearerLanguage: 'en',
    targetLanguage,
    languageRegistryVersion: '1.0.0',
    gatePolicyVersion: TEST_GATE_POLICY_VERSION,
    clientBuild: 'relay-test-1.0.0',
    requestedLimits
  });
}

function resumeText(sessionId: string = TEST_SESSION_ID): string {
  return JSON.stringify({
    type: 'session.resume',
    protocolVersion: 1,
    wearerLanguage: 'en',
    targetLanguage: 'es',
    languageRegistryVersion: '1.0.0',
    gatePolicyVersion: TEST_GATE_POLICY_VERSION,
    clientBuild: 'relay-test-1.0.0',
    requestedLimits: START_LIMITS,
    sessionId,
    sessionEpoch: 1,
    utteranceId: TEST_UTTERANCE_ID,
    clientLastAcknowledgedOffset: 0,
    oldestRetainedOffset: 0,
    nextCapturedOffset: 0
  });
}

function utteranceStartText(utteranceId = TEST_UTTERANCE_ID): string {
  return JSON.stringify({
    type: 'utterance.start',
    sessionId: TEST_SESSION_ID,
    sessionEpoch: 1,
    utteranceId
  });
}

function utteranceCommitText(
  utteranceId = TEST_UTTERANCE_ID,
  finalOriginalSampleOffset = 0
): string {
  return JSON.stringify({
    type: 'utterance.commit',
    sessionId: TEST_SESSION_ID,
    sessionEpoch: 1,
    utteranceId,
    finalOriginalSampleOffset
  });
}

function utteranceCancelText(utteranceId = TEST_UTTERANCE_ID): string {
  return JSON.stringify({
    type: 'utterance.cancel',
    sessionId: TEST_SESSION_ID,
    sessionEpoch: 1,
    utteranceId,
    finalOriginalSampleOffset: 0
  });
}

function sessionEndText(): string {
  return JSON.stringify({
    type: 'session.end',
    sessionId: TEST_SESSION_ID,
    sessionEpoch: 1,
    reason: 'user_requested'
  });
}

function frame(
  utteranceId = TEST_UTTERANCE_ID,
  sequence = 0,
  offset = 0,
  payload = new Uint8Array([1, 2])
): Uint8Array {
  return encodeAudioFrame({ utteranceId, sequence, offset, payload });
}

function finalEvent(
  category: 'target' | 'english' | 'supported-unselected' | 'mixed' | 'unsupported' | 'uncertain' = 'target',
  utteranceId = TEST_UTTERANCE_ID,
  revision = 1
): NormalizedTranscriptionEvent {
  const evidence = {
    detectorVersion: 'test-detector-1.0.0',
    source: 'controlled-fixture' as const,
    ...(category === 'target'
      ? { detectedLanguage: 'es', confidence: 0.95 }
      : category === 'english'
        ? { detectedLanguage: 'en', confidence: 0.95 }
        : category === 'supported-unselected'
          ? { detectedLanguage: 'tr', confidence: 0.95 }
          : category === 'mixed'
            ? { detectedLanguage: 'mixed', confidence: 0.95 }
            : category === 'unsupported'
              ? { detectedLanguage: 'fr', confidence: 0.95 }
              : {})
  };
  return {
    type: 'transcript.final',
    sessionId: TEST_SESSION_ID,
    sessionEpoch: 1,
    utteranceId,
    segmentId: 'segment-1',
    revision,
    text: category === 'target' ? 'hola' : 'hostile transcript',
    providerEventTime: '2026-08-10T12:00:00.000Z',
    languageEvidence: evidence,
    acceptedThroughOriginalSampleOffset: 0,
    finalizationReason: 'explicit'
  };
}

function partialEvent(revision = 1): NormalizedTranscriptionEvent {
  return {
    type: 'transcript.partial',
    sessionId: TEST_SESSION_ID,
    sessionEpoch: 1,
    utteranceId: TEST_UTTERANCE_ID,
    segmentId: 'segment-1',
    revision,
    text: 'partial text',
    providerEventTime: '2026-08-10T12:00:00.000Z',
    languageEvidence: {
      detectorVersion: 'test-detector-1.0.0',
      source: 'controlled-fixture',
      detectedLanguage: 'es',
      confidence: 0.95
    },
    acceptedThroughOriginalSampleOffset: 0
  };
}

interface RecordingSession extends TranscriptionSession {
  readonly emit: (event: NormalizedTranscriptionEvent) => void;
  readonly pushCalls: readonly Readonly<{
    readonly utteranceId: string;
    readonly originalSampleOffset: number;
    readonly pcm: Uint8Array;
  }>[];
  readonly finalizeCalls: readonly string[];
  readonly cancelCalls: readonly string[];
  readonly closeCalls: number;
}

interface RecordingAdapter extends TranscriptionAdapter {
  readonly sessions: RecordingSession[];
}

function recordingAdapter(
  configuration = DETERMINISTIC_MOCK_CAPABILITIES,
  pushResult?: (input: { readonly utteranceId: string; readonly originalSampleOffset: number; readonly pcm: Uint8Array }) => PushAudioResult,
  pushError?: Error
): RecordingAdapter {
  const sessions: RecordingSession[] = [];
  const adapter: RecordingAdapter = {
    capabilities: configuration,
    sessions,
    createSession: (input): RecordingSession => {
      let closed = false;
      const pushCalls: Array<Readonly<{
        readonly utteranceId: string;
        readonly originalSampleOffset: number;
        readonly pcm: Uint8Array;
      }>> = [];
      const finalizeCalls: string[] = [];
      const cancelCalls: string[] = [];
      let closeCalls = 0;
      const session: RecordingSession = {
        capabilities: configuration,
        configuration: input.configuration,
        get state(): TranscriptionSessionState {
          return {
            closed,
            ...(closed ? {} : { activeUtteranceId: TEST_UTTERANCE_ID }),
            acceptedThroughOriginalSampleOffset: 0,
            audioStateEpoch: 1
          };
        },
        deliveryFailures: { failureCount: 0 } as EventDeliveryFailureStatus,
        start: (): StartUtteranceResult => ({ status: 'started' }),
        pushAudio: (audio): PushAudioResult => {
          if (pushError !== undefined) {
            throw pushError;
          }
          pushCalls.push({
            utteranceId: audio.utteranceId,
            originalSampleOffset: audio.originalSampleOffset,
            pcm: new Uint8Array(audio.pcm)
          });
          return pushResult?.(audio) ?? {
            status: 'accepted',
            acceptedSamples: audio.pcm.length / 2,
            acceptedThroughOriginalSampleOffset: audio.originalSampleOffset + audio.pcm.length / 2
          };
        },
        finalize: (utteranceId): FinalizeResult => {
          finalizeCalls.push(utteranceId);
          return { status: 'already-cancelled' };
        },
        cancel: (utteranceId): CancelResult => {
          cancelCalls.push(utteranceId);
          return { status: 'cancelled' };
        },
        close: (): CloseResult => {
          closeCalls += 1;
          closed = true;
          return { status: 'closed' };
        },
        emit: (event): void => {
          input.onEvent(event);
        },
        pushCalls,
        finalizeCalls,
        cancelCalls,
        get closeCalls(): number {
          return closeCalls;
        }
      };
      sessions.push(session);
      return session;
    }
  };
  return adapter;
}

function openNew(
  adapter = recordingAdapter(),
  targetLanguage: 'es' | 'tr' = 'es',
  options: Parameters<typeof createTestOptions>[0] = {}
): { readonly core: RelaySessionCore; readonly adapter: RecordingAdapter } {
  const core = new RelaySessionCore(createTestOptions({
    transcriptionAdapter: adapter,
    ...options
  }));
  const ready = core.openWithFirstText(startText(targetLanguage));
  expect(ready.outgoing[0]?.type).toBe('session.ready');
  return { core, adapter };
}

function pendingGenerationProvider(onSignal: (signal: AbortSignal) => void): GenerationProvider {
  return {
    id: 'pending-generation-provider',
    version: '1.0.0',
    complete: async (_input, context) => new Promise<GenerationProviderCompletion>((_resolve, reject) => {
      onSignal(context.signal);
      context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  };
}

describe('relay protocol helpers', () => {
  it('accepts exactly one base protocol and one valid ticket and selects only the base', () => {
    const selection = selectStreamSubprotocols(createTestSubprotocols());
    expect(selection).toEqual({
      status: 'accepted',
      ticket: TEST_TICKET,
      selectedProtocol: 'palancar.v1'
    });
  });

  it('rejects missing, malformed, duplicate, wrong, and extra subprotocols generically', () => {
    expect(selectStreamSubprotocols([])).toEqual({ status: 'rejected', httpStatus: 400 });
    expect(selectStreamSubprotocols(['palancar.v1', 'palancar.ticket.bad'])).toEqual({
      status: 'rejected',
      httpStatus: 401
    });
    expect(selectStreamSubprotocols(['palancar.v1', 'palancar.v1'])).toEqual({
      status: 'rejected',
      httpStatus: 400
    });
    expect(selectStreamSubprotocols(['palancar.v1', 'palancar.ticket.bad', 'other'])).toEqual({
      status: 'rejected',
      httpStatus: 400
    });
    expect(selectStreamSubprotocols(['palancar.ticket.bad', 'palancar.ticket.bad'])).toEqual({
      status: 'rejected',
      httpStatus: 400
    });
    expect(selectStreamSubprotocols(['other', 'palancar.ticket.bad'])).toEqual({
      status: 'rejected',
      httpStatus: 400
    });
  });

  it('burns a valid ticket only after validation and maps consumption failures', async () => {
    const consume = vi.fn(async () => ({ status: 'accepted' as const, claim: createTestTicketClaim() }));
    const audience = {
      environment: 'test',
      origin: 'wss://relay.test',
      path: '/v1/stream' as const,
      protocol: 'palancar.v1' as const
    };
    const accepted = await prepareStreamUpgrade({
      offeredSubprotocols: createTestSubprotocols(),
      audience,
      ticketConsumer: { consume }
    });
    expect(accepted.status).toBe('accepted');
    expect(consume).toHaveBeenCalledWith(TEST_TICKET, audience);
    consume.mockClear();
    await prepareStreamUpgrade({
      offeredSubprotocols: ['palancar.v1', 'bad'],
      audience,
      ticketConsumer: { consume }
    });
    expect(consume).not.toHaveBeenCalled();

    for (const [reason, httpStatus] of [
      ['authentication_failed', 401],
      ['ticket_expired', 401],
      ['origin_rejected', 403],
      ['session_conflict', 409],
      ['rate_limited', 429],
      ['state_unavailable', 503]
    ] as const) {
      const result = await prepareStreamUpgrade({
        offeredSubprotocols: createTestSubprotocols(),
        audience,
        ticketConsumer: {
          consume: async () => ({ status: 'rejected' as const, reason })
        }
      });
      expect(result).toEqual({ status: 'rejected', httpStatus });
    }
  });
});

describe('relay session core', () => {
  it('rejects ticket intent mismatches before creating a session', () => {
    const newCore = new RelaySessionCore(createTestOptions({
      transcriptionAdapter: recordingAdapter()
    }));
    const newResult = newCore.openWithFirstText('{"type":"session.resume"}');
    expect(newResult.outgoing).toMatchObject([{ type: 'session.rejected', code: 'authentication_failed' }]);
    expect(newResult.close).toEqual({ code: 4401, reason: 'authentication_failed' });

    const resumeAdapter = recordingAdapter();
    const resumeCore = new RelaySessionCore(createTestOptions({
      ticketClaim: createTestTicketClaim({ intent: 'resume', sessionId: TEST_SESSION_ID }),
      transcriptionAdapter: resumeAdapter
    }));
    const resumeResult = resumeCore.openWithFirstText('{"type":"session.start"}');
    expect(resumeResult.outgoing).toMatchObject([{ type: 'session.rejected', code: 'authentication_failed' }]);
    expect(resumeResult.close).toEqual({ code: 4401, reason: 'authentication_failed' });
    expect(resumeAdapter.sessions).toHaveLength(0);
  });

  it('opens Spanish and Turkish sessions with field-wise minimum limits', () => {
    const lowerLimits = {
      ...DEFAULT_NEGOTIATED_LIMITS,
      maxControlMessageBytes: 128,
      maxAudioPayloadBytes: 2,
      maxBinaryMessageBytes: 32,
      maxUtteranceSamples: 4
    };
    for (const language of ['es', 'tr'] as const) {
      const core = new RelaySessionCore(createTestOptions({ serverLimits: lowerLimits }));
      const result = core.openWithFirstText(startText(language));
      expect(result.outgoing[0]).toMatchObject({
        type: 'session.ready',
        result: 'new',
        targetLanguage: language,
        languageRegistryVersion: '1.0.0',
        gatePolicyVersion: TEST_GATE_POLICY_VERSION,
        effectiveLimits: lowerLimits
      });
    }
  });

  it('rejects registry and policy mismatches without creating transcription sessions', () => {
    const adapter = recordingAdapter();
    const core = new RelaySessionCore(createTestOptions({ transcriptionAdapter: adapter }));
    const registryMismatch = core.openWithFirstText(startText().replace('"1.0.0"', '"2.0.0"'));
    expect(registryMismatch.outgoing).toMatchObject([{ type: 'session.rejected', code: 'state_unavailable' }]);
    expect(adapter.sessions).toHaveLength(0);

    const policyAdapter = recordingAdapter();
    const policyCore = new RelaySessionCore(createTestOptions({ transcriptionAdapter: policyAdapter }));
    const policyMismatch = policyCore.openWithFirstText(startText().replace(TEST_GATE_POLICY_VERSION, '2.0.0'));
    expect(policyMismatch.outgoing).toMatchObject([{ type: 'session.rejected', code: 'state_unavailable' }]);
    expect(policyAdapter.sessions).toHaveLength(0);
  });

  it('uses the specified pre-ready rejection precedence and rejects a second open', () => {
    const unsupportedProtocol = new RelaySessionCore(createTestOptions());
    const protocolResult = unsupportedProtocol.openWithFirstText(
      startText().replace('"protocolVersion":1', '"protocolVersion":99')
    );
    expect(protocolResult.outgoing).toMatchObject([{ type: 'session.rejected', code: 'unsupported_protocol_version' }]);
    expect(protocolResult.close).toEqual({ code: 1002, reason: 'unsupported_protocol' });

    const unsupportedTarget = new RelaySessionCore(createTestOptions());
    const targetResult = unsupportedTarget.openWithFirstText(
      startText().replace('"targetLanguage":"es"', '"targetLanguage":"fr"')
    );
    expect(targetResult.outgoing).toMatchObject([{ type: 'session.rejected', code: 'unsupported_target_language' }]);
    expect(targetResult.close).toEqual({ code: 1008, reason: 'unsupported_target' });

    const wrongProtocolType = new RelaySessionCore(createTestOptions());
    const wrongProtocolTypeResult = wrongProtocolType.openWithFirstText(
      startText().replace('"protocolVersion":1', '"protocolVersion":"1"')
    );
    expect(wrongProtocolTypeResult.outgoing).toMatchObject([{ type: 'session.rejected', code: 'malformed_message' }]);
    expect(wrongProtocolTypeResult.close).toEqual({ code: 1002, reason: 'protocol_error' });

    const wrongTargetType = new RelaySessionCore(createTestOptions());
    const wrongTargetTypeResult = wrongTargetType.openWithFirstText(
      startText().replace('"targetLanguage":"es"', '"targetLanguage":7')
    );
    expect(wrongTargetTypeResult.outgoing).toMatchObject([{ type: 'session.rejected', code: 'malformed_message' }]);
    expect(wrongTargetTypeResult.close).toEqual({ code: 1002, reason: 'protocol_error' });

    const opened = new RelaySessionCore(createTestOptions());
    expect(opened.openWithFirstText(startText()).outgoing[0]?.type).toBe('session.ready');
    const secondOpen = opened.openWithFirstText(startText());
    expect(secondOpen.outgoing).toMatchObject([{ type: 'error', code: 'session_conflict' }]);
    expect(secondOpen.close).toEqual({ code: 4409, reason: 'session_conflict' });
  });

  it('fails valid resume closed as non-resumable without replacement creation', () => {
    const adapter = recordingAdapter();
    const core = new RelaySessionCore(createTestOptions({
      ticketClaim: createTestTicketClaim({ intent: 'resume', sessionId: TEST_SESSION_ID }),
      transcriptionAdapter: adapter
    }));
    const result = core.openWithFirstText(resumeText());
    expect(result.outgoing.map((message) => message.type)).toEqual([
      'utterance.aborted',
      'session.rejected'
    ]);
    expect(result.outgoing[1]).toMatchObject({ code: 'invalid_session' });
    expect(result.close).toEqual({ code: 4409, reason: 'session_conflict' });
    expect(adapter.sessions).toHaveLength(0);
  });

  it('starts one utterance idempotently and conflicts on a different active utterance', () => {
    const { core, adapter } = openNew();
    expect(core.handleText(utteranceStartText())).toEqual({ outgoing: [] });
    expect(core.handleText(utteranceStartText())).toEqual({ outgoing: [] });
    expect(adapter.sessions).toHaveLength(1);
    const conflict = core.handleText(utteranceStartText(TEST_SECOND_UTTERANCE_ID));
    expect(conflict.outgoing).toMatchObject([{ type: 'error', code: 'utterance_conflict' }]);
    expect(conflict.close).toEqual({ code: 4409, reason: 'utterance_conflict' });
  });

  it('rejects binary before readiness and before an utterance with protocol close', () => {
    const preReady = new RelaySessionCore(createTestOptions({ transcriptionAdapter: recordingAdapter() }));
    expect(preReady.handleBinary(frame()).close).toEqual({ code: 1002, reason: 'protocol_error' });
    const { core } = openNew();
    expect(core.handleBinary(frame()).close).toEqual({ code: 1002, reason: 'protocol_error' });
  });

  it('forwards accepted audio once and acknowledges duplicates', () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    const first = core.handleBinary(frame());
    const accepted = core.handleBinary(frame(TEST_UTTERANCE_ID, 1, 1, new Uint8Array([3, 4])));
    const duplicate = core.handleBinary(frame());
    expect(first.outgoing).toMatchObject([{ type: 'audio.ack', highestContiguousExclusiveOffset: 1 }]);
    expect(accepted.outgoing).toMatchObject([{ type: 'audio.ack', highestContiguousExclusiveOffset: 2 }]);
    expect(duplicate.outgoing).toMatchObject([{ type: 'audio.ack', highestContiguousExclusiveOffset: 2 }]);
    expect(adapter.sessions[0]?.pushCalls).toHaveLength(2);
    expect(adapter.sessions[0]?.pushCalls[1]?.originalSampleOffset).toBe(1);
    expect(Array.from(adapter.sessions[0]?.pushCalls[0]?.pcm ?? [])).toEqual([1, 2]);
  });

  it('maps ordered-frame failures to the required abort/error closes', () => {
    const cases: readonly Readonly<{
      readonly frame: Uint8Array;
      readonly category?: string;
      readonly error?: string;
      readonly close: number;
    }>[] = [
      { frame: frame(TEST_UTTERANCE_ID, 1, 0), category: 'stale_conflict', close: 1002 },
      { frame: new Uint8Array([1]), error: 'flow_control', close: 1002 }
    ];
    for (const testCase of cases) {
      const limits = {
        ...DEFAULT_NEGOTIATED_LIMITS,
        maxAudioPayloadBytes: 2,
        maxBinaryMessageBytes: 32
      };
      const { core } = openNew(recordingAdapter(), 'es', { serverLimits: limits });
      core.handleText(utteranceStartText());
      const result = core.handleBinary(testCase.frame);
      expect(result.close?.code).toBe(testCase.close);
      if (testCase.category !== undefined) {
        expect(result.outgoing).toMatchObject([{ type: 'utterance.aborted', category: testCase.category }]);
      }
      if (testCase.error !== undefined) {
        expect(result.outgoing).toMatchObject([{ type: 'error', code: testCase.error }]);
      }
    }

    const payloadLimits = {
      ...DEFAULT_NEGOTIATED_LIMITS,
      maxAudioPayloadBytes: 2,
      maxBinaryMessageBytes: 32
    };
    const payloadCase = openNew(recordingAdapter(), 'es', { serverLimits: payloadLimits });
    payloadCase.core.handleText(utteranceStartText());
    const payloadResult = payloadCase.core.handleBinary(frame(TEST_UTTERANCE_ID, 0, 0, new Uint8Array([1, 2, 3, 4])));
    expect(payloadResult.outgoing).toMatchObject([{ type: 'error', code: 'flow_control' }]);
    expect(payloadResult.close?.code).toBe(1002);
  });

  it('covers wrong-utterance, overlap, conflict, stale, and utterance-limit frame paths', () => {
    const run = (
      inputFrame: Uint8Array,
      limits = DEFAULT_NEGOTIATED_LIMITS,
      before: readonly Uint8Array[] = []
    ) => {
      const opened = openNew(recordingAdapter(), 'es', { serverLimits: limits });
      opened.core.handleText(utteranceStartText());
      for (const prior of before) {
        opened.core.handleBinary(prior);
      }
      return opened.core.handleBinary(inputFrame);
    };

    expect(run(frame(TEST_SECOND_UTTERANCE_ID))).toMatchObject({
      outgoing: [{ type: 'utterance.aborted', category: 'stale_conflict' }],
      close: { code: 1002 }
    });
    expect(run(frame(TEST_UTTERANCE_ID, 1, 0))).toMatchObject({
      outgoing: [{ type: 'utterance.aborted', category: 'stale_conflict' }],
      close: { code: 1002 }
    });
    expect(run(
      frame(TEST_UTTERANCE_ID, 0, 0, new Uint8Array([3, 4])),
      DEFAULT_NEGOTIATED_LIMITS,
      [frame()]
    )).toMatchObject({
      outgoing: [{ type: 'utterance.aborted', category: 'stale_conflict' }],
      close: { code: 1002 }
    });
    expect(run(frame(TEST_UTTERANCE_ID, 1, 0), DEFAULT_NEGOTIATED_LIMITS, [frame()])).toMatchObject({
      outgoing: [{ type: 'utterance.aborted', category: 'stale_conflict' }],
      close: { code: 1002 }
    });
    const replayLimits = {
      ...DEFAULT_NEGOTIATED_LIMITS,
      maxUnacknowledgedSamples: 1,
      maxRetainedReplaySamples: 1
    };
    expect(run(frame(), replayLimits, [frame(), frame(TEST_UTTERANCE_ID, 1, 1)])).toMatchObject({
      outgoing: [{ type: 'utterance.aborted', category: 'stale_conflict' }],
      close: { code: 1002 }
    });
    const durationLimits = {
      ...DEFAULT_NEGOTIATED_LIMITS,
      maxUtteranceSamples: 2
    };
    expect(run(frame(TEST_UTTERANCE_ID, 2, 2), durationLimits, [frame(), frame(TEST_UTTERANCE_ID, 1, 1)])).toMatchObject({
      outgoing: [{ type: 'utterance.aborted', category: 'duration' }],
      close: { code: 4408 }
    });
  });

  it('requires exact commit high-water and does not process finalize output', () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    core.handleBinary(frame());
    const mismatch = core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 0));
    expect(mismatch.outgoing).toMatchObject([{ type: 'error', code: 'flow_control' }]);
    expect(mismatch.close?.code).toBe(1002);

    const second = openNew();
    second.core.handleText(utteranceStartText());
    second.core.handleBinary(frame());
    expect(second.core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1))).toEqual({ outgoing: [] });
    expect(second.adapter.sessions[0]?.finalizeCalls).toEqual([TEST_UTTERANCE_ID]);
    expect(second.core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1))).toEqual({ outgoing: [] });
    expect(second.adapter.sessions[0]?.finalizeCalls).toEqual([TEST_UTTERANCE_ID]);
    expect(adapter.sessions[0]?.finalizeCalls).toHaveLength(0);

    const conflict = openNew();
    conflict.core.handleText(utteranceStartText());
    conflict.core.handleBinary(frame());
    expect(conflict.core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1))).toEqual({ outgoing: [] });
    const conflictResult = conflict.core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 2));
    expect(conflictResult.outgoing).toMatchObject([
      { type: 'error', code: 'flow_control', scope: 'audio', recoverable: false }
    ]);
    expect(conflictResult.close).toEqual({ code: 1002, reason: 'protocol_error' });
    expect(conflict.adapter.sessions[0]?.closeCalls).toBe(1);
  });

  it('rejects audio after commit without forwarding or acknowledging it', () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    core.handleBinary(frame());
    expect(core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1))).toEqual({ outgoing: [] });

    const result = core.handleBinary(frame(TEST_UTTERANCE_ID, 1, 1));
    expect(result.outgoing).toMatchObject([
      { type: 'error', code: 'flow_control', scope: 'audio', recoverable: false }
    ]);
    expect(result.close).toEqual({ code: 1002, reason: 'protocol_error' });
    expect(adapter.sessions[0]?.pushCalls).toHaveLength(1);
    expect(result.outgoing.some((message) => message.type === 'audio.ack')).toBe(false);
    expect(adapter.sessions[0]?.closeCalls).toBe(1);
  });

  it('cancels idempotently and ends the session normally', () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    const cancel = core.handleText(utteranceCancelText());
    expect(cancel.outgoing).toMatchObject([{ type: 'utterance.aborted', category: 'cancellation' }]);
    expect(cancel.close).toBeUndefined();
    expect(core.handleText(utteranceCancelText())).toEqual({ outgoing: [] });
    expect(adapter.sessions[0]?.cancelCalls).toEqual([TEST_UTTERANCE_ID]);

    const { core: endedCore, adapter: endedAdapter } = openNew();
    endedCore.handleText(utteranceStartText());
    const endResult = endedCore.handleText(sessionEndText());
    expect(endResult).toEqual({ outgoing: [], close: { code: 1000, reason: 'closed' } });
    expect(endedAdapter.sessions[0]?.closeCalls).toBe(1);
    expect(endedCore.close()).toEqual({ outgoing: [], close: { code: 1000, reason: 'closed' } });
  });

  it('cancels pending generation when the utterance is cancelled', async () => {
    let providerSignal: AbortSignal | undefined;
    const { core } = openNew(recordingAdapter(), 'es', {
      generationService: new GenerationService(pendingGenerationProvider((signal) => {
        providerSignal = signal;
      }))
    });
    core.handleText(utteranceStartText());
    await core.handleTranscriptionEvent(finalEvent());
    await flushAsyncEvents();

    expect(providerSignal).toBeDefined();
    expect(core.handleText(utteranceCancelText())).toMatchObject({
      outgoing: [{ type: 'utterance.aborted', category: 'cancellation' }]
    });
    expect(providerSignal?.aborted).toBe(true);
  });

  it('cancels pending generation when the session ends', async () => {
    let providerSignal: AbortSignal | undefined;
    const { core } = openNew(recordingAdapter(), 'es', {
      generationService: new GenerationService(pendingGenerationProvider((signal) => {
        providerSignal = signal;
      }))
    });
    core.handleText(utteranceStartText());
    await core.handleTranscriptionEvent(finalEvent());
    await flushAsyncEvents();

    expect(providerSignal).toBeDefined();
    expect(core.handleText(sessionEndText())).toEqual({
      outgoing: [],
      close: { code: 1000, reason: 'closed' }
    });
    expect(providerSignal?.aborted).toBe(true);
  });

  it('cancels pending generation on a terminal utterance conflict', async () => {
    let providerSignal: AbortSignal | undefined;
    const { core } = openNew(recordingAdapter(), 'es', {
      generationService: new GenerationService(pendingGenerationProvider((signal) => {
        providerSignal = signal;
      }))
    });
    core.handleText(utteranceStartText());
    await core.handleTranscriptionEvent(finalEvent());
    await flushAsyncEvents();

    expect(providerSignal).toBeDefined();
    expect(core.handleText(utteranceStartText(TEST_SECOND_UTTERANCE_ID))).toMatchObject({
      outgoing: [{ type: 'error', code: 'utterance_conflict' }],
      close: { code: 4409, reason: 'utterance_conflict' }
    });
    expect(providerSignal?.aborted).toBe(true);
  });

  it('forwards partials only and orders target final generation output', async () => {
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'hello',
      suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
      ]
    }));
    const { core } = openNew(recordingAdapter(), 'es', {
      generationService: new GenerationService({
        id: 'one-call-provider',
        version: '1.0.0',
        complete
      })
    });
    core.handleText(utteranceStartText());
    const partial = await core.handleTranscriptionEvent(partialEvent());
    expect(partial.outgoing.map((message) => message.type)).toEqual(['transcript.partial']);
    const final = await core.handleTranscriptionEvent(finalEvent('target', TEST_UTTERANCE_ID, 2));
    expect(final.outgoing.map((message) => message.type)).toEqual([
      'transcript.final',
      'language.decision'
    ]);
    await flushAsyncEvents();
    const generated = await core.drainAsyncEvents();
    expect(generated.outgoing.map((message) => message.type)).toEqual([
      'translation.ready',
      'suggestions.ready'
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('preserves final ordering when a late same-segment partial replaces a queued partial', async () => {
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'hello',
      suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
      ]
    }));
    const { core, adapter } = openNew(recordingAdapter(), 'es', {
      generationService: new GenerationService({
        id: 'ordered-queue-provider',
        version: '1.0.0',
        complete
      })
    });
    core.handleText(utteranceStartText());
    const session = adapter.sessions[0];
    expect(session).toBeDefined();
    session?.emit(partialEvent(1));
    session?.emit(finalEvent('target', TEST_UTTERANCE_ID, 2));
    session?.emit(partialEvent(3));

    const firstDrain = await core.drainAsyncEvents();
    expect(firstDrain.outgoing.slice(0, 2).map((message) => message.type)).toEqual([
      'transcript.final',
      'language.decision'
    ]);
    expect(firstDrain.outgoing.some((message) => message.type === 'transcript.partial')).toBe(false);
    await flushAsyncEvents();
    const secondDrain = await core.drainAsyncEvents();
    const generatedTypes = [...firstDrain.outgoing, ...secondDrain.outgoing]
      .map((message) => message.type)
      .filter((type) => type === 'translation.ready' || type === 'suggestions.ready');
    expect(generatedTypes).toEqual(['translation.ready', 'suggestions.ready']);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('keeps a target final active until generation completes', async () => {
    const { core } = openNew();
    core.handleText(utteranceStartText());
    await core.handleTranscriptionEvent(finalEvent());
    expect(core.handleText(utteranceStartText(TEST_SECOND_UTTERANCE_ID))).toMatchObject({
      outgoing: [{ type: 'error', code: 'utterance_conflict' }],
      close: { code: 4409, reason: 'utterance_conflict' }
    });
  });

  it('clears target finals after generation and permits the next utterance', async () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    await core.handleTranscriptionEvent(finalEvent());
    await flushAsyncEvents();
    await core.drainAsyncEvents();
    expect(core.handleText(utteranceStartText(TEST_SECOND_UTTERANCE_ID))).toEqual({ outgoing: [] });
    expect(adapter.sessions).toHaveLength(2);
  });

  it('suppresses generated output when the final processing token becomes stale', async () => {
    let resolveCompletion: ((value: {
      readonly englishTranslation: string;
      readonly suggestions: readonly [
        { readonly englishText: string; readonly selectedTargetText: string },
        { readonly englishText: string; readonly selectedTargetText: string }
      ];
    }) => void) | undefined;
    const completion = new Promise<GenerationProviderCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    let providerSignal: AbortSignal | undefined;
    const provider: GenerationProvider = {
      id: 'provider',
      version: '1.0.0',
      complete: async (_input, context) => {
        providerSignal = context.signal;
        return completion;
      }
    };
    const { core } = openNew(recordingAdapter(), 'es', {
      generationService: new GenerationService(provider)
    });
    core.handleText(utteranceStartText());
    const finalPromise = core.handleTranscriptionEvent(finalEvent());
    await flushAsyncEvents();
    expect(core.close()).toEqual({ outgoing: [], close: { code: 1000, reason: 'closed' } });
    expect(providerSignal?.aborted).toBe(true);
    resolveCompletion?.({
      englishTranslation: 'hello',
      suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
      ]
    });
    const result = await finalPromise;
    expect(result.outgoing.map((message) => message.type)).toEqual([
      'transcript.final',
      'language.decision'
    ]);
    expect(result.outgoing.some((message) => message.type === 'translation.ready')).toBe(false);
  });

  it('does not generate for every non-target final decision', async () => {
    for (const category of ['english', 'supported-unselected', 'unsupported', 'mixed', 'uncertain'] as const) {
      const complete = vi.fn(async () => ({
        englishTranslation: 'hello',
        suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
        ] as const
      }));
      const provider: GenerationProvider = { id: 'provider', version: '1.0.0', complete };
      const { core } = openNew(recordingAdapter(), 'es', {
        generationService: new GenerationService(provider)
      });
      core.handleText(utteranceStartText());
      const result = await core.handleTranscriptionEvent(finalEvent(category));
      expect(result.outgoing.map((message) => message.type)).toEqual([
        'transcript.final',
        'language.decision'
      ]);
      expect(result.outgoing[1]).toMatchObject({ decision: category === 'uncertain' ? 'uncertain' : category === 'supported-unselected' ? 'supported_unselected' : category });
      expect(complete).not.toHaveBeenCalled();
    }
  });

  it('ignores stale, duplicate, and post-final events', async () => {
    const { core } = openNew();
    core.handleText(utteranceStartText());
    const stale = await core.handleTranscriptionEvent({ ...partialEvent(), sessionId: '99999999-9999-4999-8999-999999999999' });
    expect(stale).toEqual({ outgoing: [] });
    expect((await core.handleTranscriptionEvent(partialEvent(2))).outgoing).toHaveLength(1);
    expect((await core.handleTranscriptionEvent(partialEvent(1))).outgoing).toHaveLength(0);
    expect((await core.handleTranscriptionEvent(finalEvent('target', TEST_UTTERANCE_ID, 3))).outgoing).toHaveLength(2);
    expect((await core.handleTranscriptionEvent(finalEvent('target', TEST_UTTERANCE_ID, 4))).outgoing).toHaveLength(0);
  });

  it('rejects unsupported transcription capabilities generically', () => {
    const unsupported = {
      ...DETERMINISTIC_MOCK_CAPABILITIES,
      serverVad: { ...DETERMINISTIC_MOCK_CAPABILITIES.serverVad, modes: ['enabled'] as const }
    };
    const { core, adapter } = openNew(recordingAdapter(unsupported));
    const result = core.handleText(utteranceStartText());
    expect(result.outgoing.some((message) => message.type === 'error' && message.code === 'provider_unavailable')).toBe(true);
    expect(result.close).toEqual({ code: 4503, reason: 'provider_unavailable' });
    expect(adapter.sessions).toHaveLength(0);
  });

  it('maps push failure and high-water mismatch to provider loss without ACK', () => {
    const throwing = openNew(recordingAdapter(DETERMINISTIC_MOCK_CAPABILITIES, undefined, new Error('raw provider secret')));
    throwing.core.handleText(utteranceStartText());
    const thrown = throwing.core.handleBinary(frame());
    expect(thrown.outgoing.map((message) => message.type)).toEqual(['utterance.aborted', 'error']);
    expect(thrown.outgoing[0]).toMatchObject({ category: 'provider_loss' });
    expect(thrown.outgoing[1]).toMatchObject({ code: 'provider_unavailable' });
    expect(thrown.close?.code).toBe(4503);
    expect(JSON.stringify(thrown)).not.toContain('raw provider secret');
    expect(throwing.adapter.sessions[0]?.closeCalls).toBe(1);

    const mismatch = openNew(recordingAdapter(DETERMINISTIC_MOCK_CAPABILITIES, (input) => ({
      status: 'accepted',
      acceptedSamples: input.pcm.length / 2,
      acceptedThroughOriginalSampleOffset: 999
    })));
    mismatch.core.handleText(utteranceStartText());
    const mismatchResult = mismatch.core.handleBinary(frame());
    expect(mismatchResult.outgoing[0]).toMatchObject({ type: 'utterance.aborted', category: 'provider_loss' });
    expect(mismatchResult.outgoing.some((message) => message.type === 'audio.ack')).toBe(false);
    expect(mismatch.adapter.sessions[0]?.closeCalls).toBe(1);
  });

  it('returns deterministic terminal results and enforces lowered control limits', () => {
    const lowerLimits = { ...DEFAULT_NEGOTIATED_LIMITS, maxControlMessageBytes: 64 };
    const { core } = openNew(recordingAdapter(), 'es', { serverLimits: lowerLimits });
    const tooLarge = core.handleText(utteranceStartText());
    expect(tooLarge.outgoing).toMatchObject([{ type: 'error', code: 'malformed_message' }]);
    expect(tooLarge.close?.code).toBe(1002);
    expect(core.handleText(utteranceStartText())).toEqual({ outgoing: [], close: { code: 1000, reason: 'closed' } });
  });

  it('rejects a resume session ID that differs from the ticket binding', () => {
    const core = new RelaySessionCore(createTestOptions({
      ticketClaim: createTestTicketClaim({ intent: 'resume', sessionId: TEST_SESSION_ID })
    }));
    const result = core.openWithFirstText(resumeText('55555555-5555-4555-8555-555555555555'));
    expect(result.outgoing).toMatchObject([{ type: 'session.rejected', code: 'authentication_failed' }]);
    expect(result.close?.code).toBe(4401);
  });

  it('returns a generic provider error when generation completion fails', async () => {
    const provider: GenerationProvider = {
      id: 'provider',
      version: '1.0.0',
      complete: async () => {
        throw new Error('suggestion secret');
      }
    };
    const { core } = openNew(recordingAdapter(), 'es', {
      generationService: new GenerationService(provider)
    });
    core.handleText(utteranceStartText());
    const staged = await core.handleTranscriptionEvent(finalEvent());
    expect(staged.outgoing.map((message) => message.type)).toEqual([
      'transcript.final',
      'language.decision'
    ]);
    await flushAsyncEvents();
    const result = await core.drainAsyncEvents();
    expect(result.outgoing.map((message) => message.type)).toEqual(['error']);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('drains adapter callback events through the same event path', async () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    const session = adapter.sessions[0];
    session?.emit(partialEvent());
    const result = await core.drainAsyncEvents();
    expect(result.outgoing.map((message) => message.type)).toEqual(['transcript.partial']);
  });

  it('partially evicts distinct-segment partials to admit a final at queue capacity', async () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    for (let revision = 1; revision <= 64; revision += 1) {
      adapter.sessions[0]?.emit({
        ...partialEvent(revision),
        segmentId: `segment-${revision}`
      });
    }
    adapter.sessions[0]?.emit(finalEvent('target', TEST_UTTERANCE_ID, 65));

    const drained = await core.drainAsyncEvents();
    expect(drained.close).toBeUndefined();
    expect(drained.outgoing.some((message) => message.type === 'transcript.final')).toBe(true);
    expect(drained.outgoing.some((message) => message.type === 'language.decision')).toBe(true);
    expect(drained.outgoing.some((message) => message.type === 'error' && message.code === 'state_unavailable')).toBe(false);
  });

  it('emits one terminal state error when non-partials overflow the bounded queue', async () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    for (let revision = 1; revision <= 65; revision += 1) {
      adapter.sessions[0]?.emit({
        ...finalEvent('english', TEST_UTTERANCE_ID, revision),
        segmentId: `segment-${revision}`
      });
    }

    expect(core.hasPendingAsyncEvents()).toBe(true);
    const drained = await core.drainAsyncEvents();
    expect(drained.outgoing).toMatchObject([{ type: 'error', code: 'state_unavailable' }]);
    expect(drained.close).toEqual({ code: 1011, reason: 'server_error' });
    expect((await core.drainAsyncEvents()).close).toEqual({ code: 1000, reason: 'closed' });
  });

  it('admits a generation result when partials fill the queue', async () => {
    let resolveCompletion: ((value: GenerationProviderCompletion) => void) | undefined;
    const completion = new Promise<GenerationProviderCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    const provider: GenerationProvider = {
      id: 'deferred-provider',
      version: '1.0.0',
      complete: async () => completion
    };
    const { core, adapter } = openNew(recordingAdapter(), 'es', {
      generationService: new GenerationService(provider)
    });
    core.handleText(utteranceStartText());
    await core.handleTranscriptionEvent(finalEvent());
    for (let revision = 1; revision <= 64; revision += 1) {
      adapter.sessions[0]?.emit({
        ...partialEvent(revision),
        segmentId: `segment-${revision}`
      });
    }
    resolveCompletion?.({
      englishTranslation: 'hello',
      suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
      ]
    });
    await flushAsyncEvents();

    const drained = await core.drainAsyncEvents();
    expect(drained.outgoing.map((message) => message.type)).toContain('translation.ready');
    expect(drained.outgoing.map((message) => message.type)).toContain('suggestions.ready');
    expect(drained.close).toBeUndefined();
  });

  it('redacts hostile inbound and provider error values', async () => {
    const hostile = 'HOSTILE-CANARY-<script>ticket-secret</script>';
    const provider: GenerationProvider = {
      id: 'provider',
      version: '1.0.0',
      complete: async () => {
        throw new Error(hostile);
      }
    };
    const malformedCore = openNew().core;
    const malformed = malformedCore.handleText(JSON.stringify({ type: 'utterance.start', hostile }));
    expect(JSON.stringify(malformed)).not.toContain(hostile);

    const { core } = openNew(recordingAdapter(), 'es', {
      generationService: new GenerationService(provider)
    });
    const event = finalEvent();
    core.handleText(utteranceStartText());
    const staged = await core.handleTranscriptionEvent(event);
    expect(JSON.stringify(staged)).not.toContain(hostile);
    await flushAsyncEvents();
    const result = await core.drainAsyncEvents();
    expect(JSON.stringify(result)).not.toContain(hostile);
    expect(result.outgoing.some((message) => message.type === 'error' && message.code === 'provider_unavailable')).toBe(true);
  });

  it('negotiates fresh frozen limits', () => {
    const limits = negotiateLimits({ ...DEFAULT_NEGOTIATED_LIMITS, maxControlMessageBytes: 128 });
    expect(limits).not.toBe(DEFAULT_NEGOTIATED_LIMITS);
    expect(Object.isFrozen(limits)).toBe(true);
    expect(limits.maxControlMessageBytes).toBe(128);
  });
});
