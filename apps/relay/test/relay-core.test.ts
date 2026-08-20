import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_NEGOTIATED_LIMITS, encodeAudioFrame } from '@palancar/contracts';
import {
  DeterministicFixtureLanguageValidator,
  GenerationService,
  type GenerationProvider,
  type GenerationProviderCompletion
} from '@palancar/generation';
import {
  CONTROLLED_FIXTURE_CALIBRATION_VERSION,
  CONTROLLED_FIXTURE_DETECTOR_VERSION,
  LANGUAGE_REGISTRY_VERSION,
  type ClassifiedLanguageEvidence,
  type TextLanguageClassifier
} from '@palancar/language-registry';
import type {
  CancelResult,
  CloseResult,
  EventDeliveryFailureStatus,
  FinalizeResult,
  NormalizedTranscriptionEvent,
  NormalizedTranscriptionFinal,
  PushAudioResult,
  TranscriptionAdapter,
  TranscriptionSession,
  TranscriptionSessionState,
  StartUtteranceResult
} from '@palancar/transcription';
import { DETERMINISTIC_MOCK_CAPABILITIES } from '@palancar/transcription';
import { sanitizeTelemetryForExport } from '@palancar/telemetry';
import {
  SecurityStateError,
  assertCanonicalUuid,
  type CompleteGenerationInput
} from '@palancar/security-state';
import {
  RelaySessionCore,
  createTestOptions,
  createTestSecurityRuntime,
  createTestSessionLease,
  createTestSubprotocols,
  TEST_GATE_POLICY_VERSION,
  TEST_SECOND_UTTERANCE_ID,
  TEST_SESSION_ID,
  TEST_TICKET,
  TEST_UTTERANCE_ID,
  negotiateLimits,
  prepareStreamUpgrade,
  selectStreamSubprotocols,
  type RelayClock,
  type RelayMetricSink,
  type RelayProductionMetricInput,
  type RelaySessionCoreOptions
} from '../src/index.js';
import { RELAY_METRIC_NAMES } from '../src/types.js';

const START_LIMITS = DEFAULT_NEGOTIATED_LIMITS;

async function flushAsyncEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function deferredValue<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
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
    languageRegistryVersion: LANGUAGE_REGISTRY_VERSION,
    gatePolicyVersion: TEST_GATE_POLICY_VERSION,
    clientBuild: 'relay-test-1.0.0',
    requestedLimits
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

function pcmSamples(sampleCount: number) {
  return new Uint8Array(sampleCount * 2);
}

function finalEvent(
  category: 'target' | 'english' | 'supported-unselected' | 'mixed' | 'unsupported' | 'uncertain' = 'target',
  utteranceId = TEST_UTTERANCE_ID,
  revision = 1,
  fixtureLanguage: 'es' | 'tr' = 'es'
): NormalizedTranscriptionFinal {
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
    text: `${fixtureLanguage}-${category === 'target' ? 'selected-target' : category}-final`,
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
    text: `es-selected-target-partial-${revision}`,
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
  readonly fail: () => void;
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
  pushError?: Error,
  finalizeBehavior: FinalizeResult | Error = { status: 'finalization-requested' }
): RecordingAdapter {
  const sessions: RecordingSession[] = [];
  const adapter: RecordingAdapter = {
    capabilities: configuration,
    sessions,
    checkReadiness: async () => ({
      ready: true,
      provider: 'recording',
      model: 'recording'
    }),
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
          if (finalizeBehavior instanceof Error) {
            throw finalizeBehavior;
          }
          return finalizeBehavior;
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
        fail: (): void => {
          input.onFailure({ reason: 'provider', audioStateEpoch: 1 });
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
  const hasAdapterOption =
    Object.hasOwn(options, 'transcriptionAdapters') ||
    Object.hasOwn(options, 'transcriptionAdapterForTarget') ||
    Object.hasOwn(options, 'transcriptionAdapter');
  const configuredOptions = hasAdapterOption
    ? options
    : { ...options, transcriptionAdapter: adapter } as Parameters<typeof createTestOptions>[0];
  const core = new RelaySessionCore(createTestOptions(configuredOptions));
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

function calibratedEvidence(detectedLanguage: string): ClassifiedLanguageEvidence {
  return {
    status: 'calibrated',
    detectorVersion: CONTROLLED_FIXTURE_DETECTOR_VERSION,
    calibrationVersion: CONTROLLED_FIXTURE_CALIBRATION_VERSION,
    detectedLanguage,
    confidence: 0.95
  };
}

function generationService(provider: GenerationProvider): GenerationService {
  return new GenerationService({
    provider,
    validator: new DeterministicFixtureLanguageValidator()
  });
}

function recordingMetricSink(): {
  readonly sink: RelayMetricSink;
  readonly records: RelayProductionMetricInput[];
} {
  const records: RelayProductionMetricInput[] = [];
  return {
    sink: { record: (input) => records.push(input) },
    records
  };
}

function monotonicClock(...values: number[]): RelayClock {
  let index = 0;
  return {
    nowIso: () => '2026-08-10T12:00:00.000Z',
    nowMonotonicMs: () => values[index++] ?? values.at(-1) ?? 0
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
    const consume = vi.fn(async () => createTestSessionLease());
    const audience = {
      origin: 'wss://relay.test',
      path: '/v1/stream' as const,
      protocol: 'palancar.v1' as const
    };
    const accepted = await prepareStreamUpgrade({
      offeredSubprotocols: createTestSubprotocols(),
      audience,
      environment: 'test',
      securityRuntime: createTestSecurityRuntime({ consumeSessionTicket: consume })
    });
    expect(accepted.status).toBe('accepted');
    expect(consume).toHaveBeenCalledWith({
      ticket: TEST_TICKET,
      environment: 'test',
      audience,
      intent: 'new'
    });
    consume.mockClear();
    await prepareStreamUpgrade({
      offeredSubprotocols: ['palancar.v1', 'bad'],
      audience,
      environment: 'test',
      securityRuntime: createTestSecurityRuntime({ consumeSessionTicket: consume })
    });
    expect(consume).not.toHaveBeenCalled();

    for (const [category, httpStatus] of [
      ['invalid-ticket', 401],
      ['session-rejected', 409],
      ['rate-limited', 429],
      ['state-unavailable', 503]
    ] as const) {
      const result = await prepareStreamUpgrade({
        offeredSubprotocols: createTestSubprotocols(),
        audience,
        environment: 'test',
        securityRuntime: createTestSecurityRuntime({
          consumeSessionTicket: async () => { throw new SecurityStateError(category); }
        })
      });
      expect(result).toEqual({ status: 'rejected', httpStatus });
    }
  });

  it('fails closed when ticket consumption throws an unknown error', async () => {
    const result = await prepareStreamUpgrade({
      offeredSubprotocols: createTestSubprotocols(),
      audience: {
        origin: 'wss://relay.test',
        path: '/v1/stream',
        protocol: 'palancar.v1'
      },
      environment: 'test',
      securityRuntime: createTestSecurityRuntime({
        consumeSessionTicket: async () => { throw new Error('secret'); }
      })
    });

    expect(result).toEqual({ status: 'rejected', httpStatus: 503 });
  });
});

describe('relay session core', () => {
  it('spends durable generation state exactly once only for an accepted target final', async () => {
    const baseSecurity = createTestSecurityRuntime();
    const authorizeGeneration = vi.fn(baseSecurity.authorizeGeneration);
    const providerStart = vi.fn(baseSecurity.providerStart);
    const completeGeneration = vi.fn(baseSecurity.completeGeneration);
    const providerComplete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'hello',
      suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
      ]
    }));
    const securityRuntime = createTestSecurityRuntime({
      authorizeGeneration,
      providerStart,
      completeGeneration
    });
    const { core } = openNew(recordingAdapter(), 'es', {
      securityRuntime,
      generationService: generationService({
        id: 'durable-generation-test',
        version: '1.0.0',
        complete: providerComplete
      })
    });
    core.handleText(utteranceStartText());
    await core.handleTranscriptionEvent(finalEvent('target'));
    await flushAsyncEvents();
    await core.drainAsyncEvents();

    expect(authorizeGeneration).toHaveBeenCalledTimes(1);
    expect(providerStart).toHaveBeenCalledTimes(1);
    expect(providerComplete).toHaveBeenCalledTimes(1);
    expect(completeGeneration).toHaveBeenCalledTimes(1);

    const rejectedSecurity = createTestSecurityRuntime({
      authorizeGeneration: vi.fn(baseSecurity.authorizeGeneration)
    });
    const rejected = openNew(recordingAdapter(), 'es', {
      securityRuntime: rejectedSecurity,
      generationService: generationService({
        id: 'suppressed-generation-test',
        version: '1.0.0',
        complete: providerComplete
      })
    }).core;
    rejected.handleText(utteranceStartText());
    await rejected.handleTranscriptionEvent(finalEvent('english'));
    expect(rejectedSecurity.authorizeGeneration).not.toHaveBeenCalled();
    expect(providerComplete).toHaveBeenCalledTimes(1);
  });

  it('serializes completion behind a heartbeat and completes with the renewed current claim', async () => {
    const base = createTestSecurityRuntime();
    const authorized = await base.authorizeGeneration({} as never);
    const started = { ...authorized.claim, phase: 'started' as const, claimVersion: 2 };
    const renewed = { ...started, claimVersion: 3 };
    const completed = { ...renewed, phase: 'completed' as const, claimVersion: 4 };
    const heartbeatStarted = deferredValue<void>();
    const heartbeatResult = deferredValue<typeof renewed>();
    const providerResult = deferredValue<GenerationProviderCompletion>();
    const completeGeneration = vi.fn(async ({ claim }: CompleteGenerationInput) => {
      expect(claim).toEqual(renewed);
      return completed;
    });
    const securityRuntime = createTestSecurityRuntime({
      authorizeGeneration: async () => authorized,
      providerStart: async () => ({ status: 'start-permitted', claim: started }),
      heartbeatGeneration: async () => {
        heartbeatStarted.resolve(undefined);
        return heartbeatResult.promise;
      },
      completeGeneration
    });
    const { core } = openNew(recordingAdapter(), 'es', {
      securityRuntime,
      generationService: generationService({
        id: 'heartbeat-race-provider',
        version: '1.0.0',
        complete: async () => providerResult.promise
      })
    });
    core.handleText(utteranceStartText());
    await core.handleTranscriptionEvent(finalEvent('target'));
    const heartbeat = core.heartbeatGeneration();
    await heartbeatStarted.promise;
    providerResult.resolve({
      englishTranslation: 'hello',
      suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
      ]
    });
    await flushAsyncEvents();
    expect(completeGeneration).not.toHaveBeenCalled();

    heartbeatResult.resolve(renewed);
    await heartbeat;
    await flushAsyncEvents();
    expect(completeGeneration).toHaveBeenCalledTimes(1);
  });

  it.each(['provider-failure', 'identity-mismatch'] as const)(
    'keeps the last identity-matching claim after heartbeat %s',
    async (mode) => {
      const base = createTestSecurityRuntime();
      const authorized = await base.authorizeGeneration({} as never);
      const started = { ...authorized.claim, phase: 'started' as const, claimVersion: 2 };
      const completed = { ...started, phase: 'completed' as const, claimVersion: 3 };
      const providerResult = deferredValue<GenerationProviderCompletion>();
      const completeGeneration = vi.fn(async ({ claim }: CompleteGenerationInput) => {
        expect(claim).toEqual(started);
        return completed;
      });
      const securityRuntime = createTestSecurityRuntime({
        authorizeGeneration: async () => authorized,
        providerStart: async () => ({ status: 'start-permitted', claim: started }),
        heartbeatGeneration: async () => {
          if (mode === 'provider-failure') throw new SecurityStateError('state-unavailable');
          return {
            ...started,
            claimId: assertCanonicalUuid('99999999-9999-4999-8999-999999999999'),
            claimVersion: 3
          };
        },
        completeGeneration
      });
      const { core } = openNew(recordingAdapter(), 'es', {
        securityRuntime,
        generationService: generationService({
          id: `heartbeat-${mode}`,
          version: '1.0.0',
          complete: async () => providerResult.promise
        })
      });
      core.handleText(utteranceStartText());
      await core.handleTranscriptionEvent(finalEvent('target'));
      await expect(core.heartbeatGeneration()).rejects.toBeDefined();
      providerResult.resolve({
        englishTranslation: 'hello',
        suggestions: [
          { englishText: 'hello', selectedTargetText: 'hola' },
          { englishText: 'hi', selectedTargetText: 'buenas' }
        ]
      });
      await flushAsyncEvents();
      expect(completeGeneration).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects the removed legacy session input before creating a session', () => {
    const adapter = recordingAdapter();
    const core = new RelaySessionCore(createTestOptions({ transcriptionAdapter: adapter }));
    const result = core.openWithFirstText('{"type":"session.resume"}');
    expect(result.outgoing).toMatchObject([{ type: 'session.rejected', code: 'malformed_message' }]);
    expect(result.close).toEqual({ code: 1002, reason: 'protocol_error' });
    expect(adapter.sessions).toHaveLength(0);
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
        languageRegistryVersion: LANGUAGE_REGISTRY_VERSION,
        gatePolicyVersion: TEST_GATE_POLICY_VERSION,
        effectiveLimits: lowerLimits
      });
    }
  });

  it('rejects registry and policy mismatches without creating transcription sessions', () => {
    const adapter = recordingAdapter();
    const core = new RelaySessionCore(createTestOptions({ transcriptionAdapter: adapter }));
    const registryMismatch = core.openWithFirstText(startText().replace(
      `"languageRegistryVersion":"${LANGUAGE_REGISTRY_VERSION}"`,
      '"languageRegistryVersion":"99.0.0"'
    ));
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

  it('throttles normal ACKs by the default sample threshold', () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    const first = core.handleBinary(frame(TEST_UTTERANCE_ID, 0, 0, pcmSamples(960)));
    const accepted = core.handleBinary(frame(TEST_UTTERANCE_ID, 1, 960, pcmSamples(960)));
    const next = core.handleBinary(frame(TEST_UTTERANCE_ID, 2, 1920, pcmSamples(960)));
    expect(first.outgoing).toEqual([]);
    expect(accepted.outgoing).toMatchObject([
      { type: 'audio.ack', highestContiguousExclusiveOffset: 1920 }
    ]);
    expect(next.outgoing).toEqual([]);
    expect(adapter.sessions[0]?.pushCalls).toHaveLength(3);
    expect(adapter.sessions[0]?.pushCalls.map((call) => call.originalSampleOffset)).toEqual([0, 960, 1920]);
  });

  it('does not redundantly ACK the first valid commit after a normal ACK, then re-ACKs repeats', () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    expect(core.handleBinary(frame(TEST_UTTERANCE_ID, 0, 0, pcmSamples(960))).outgoing).toEqual([]);
    expect(core.handleBinary(frame(TEST_UTTERANCE_ID, 1, 960, pcmSamples(960))).outgoing).toMatchObject([
      { type: 'audio.ack', highestContiguousExclusiveOffset: 1920 }
    ]);

    expect(core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1920)).outgoing).toEqual([]);
    expect(core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1920)).outgoing).toMatchObject([
      { type: 'audio.ack', highestContiguousExclusiveOffset: 1920 }
    ]);
    expect(adapter.sessions[0]?.finalizeCalls).toEqual([TEST_UTTERANCE_ID]);
  });

  it('ACKs exact retained duplicates immediately without a second provider push', () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    const firstFrame = frame(TEST_UTTERANCE_ID, 0, 0, pcmSamples(960));
    const secondFrame = frame(TEST_UTTERANCE_ID, 1, 960, pcmSamples(960));

    expect(core.handleBinary(firstFrame).outgoing).toEqual([]);
    expect(core.handleBinary(firstFrame).outgoing).toMatchObject([
      { type: 'audio.ack', highestContiguousExclusiveOffset: 960 }
    ]);
    expect(core.handleBinary(secondFrame).outgoing).toEqual([]);
    expect(core.handleBinary(secondFrame).outgoing).toMatchObject([
      { type: 'audio.ack', highestContiguousExclusiveOffset: 1920 }
    ]);
    expect(core.handleBinary(secondFrame).outgoing).toMatchObject([
      { type: 'audio.ack', highestContiguousExclusiveOffset: 1920 }
    ]);
    expect(adapter.sessions[0]?.pushCalls).toHaveLength(2);
  });

  it('lowers the normal ACK threshold with ack interval and replay limits', () => {
    const cases = [
      {
        limits: { ...DEFAULT_NEGOTIATED_LIMITS, ackIntervalMs: 1 },
        sampleCount: 8,
        expectedOffset: 16
      },
      {
        limits: { ...DEFAULT_NEGOTIATED_LIMITS, maxRetainedReplaySamples: 8 },
        sampleCount: 4,
        expectedOffset: 8
      }
    ] as const;

    for (const testCase of cases) {
      const { core } = openNew(recordingAdapter(), 'es', { serverLimits: testCase.limits });
      core.handleText(utteranceStartText());
      expect(core.handleBinary(frame(TEST_UTTERANCE_ID, 0, 0, pcmSamples(testCase.sampleCount))).outgoing).toEqual([]);
      expect(core.handleBinary(frame(
        TEST_UTTERANCE_ID,
        1,
        testCase.sampleCount,
        pcmSamples(testCase.sampleCount)
      )).outgoing).toMatchObject([
        { type: 'audio.ack', highestContiguousExclusiveOffset: testCase.expectedOffset }
      ]);
    }
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
      expect(result.outgoing.some((message) => message.type === 'audio.ack')).toBe(false);
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
    expect(payloadResult.outgoing.some((message) => message.type === 'audio.ack')).toBe(false);
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
    expect(mismatch.outgoing.some((message) => message.type === 'audio.ack')).toBe(false);
    expect(mismatch.close?.code).toBe(1002);

    const second = openNew();
    second.core.handleText(utteranceStartText());
    second.core.handleBinary(frame());
    expect(second.core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1)).outgoing).toMatchObject([
      { type: 'audio.ack', highestContiguousExclusiveOffset: 1 }
    ]);
    expect(second.adapter.sessions[0]?.finalizeCalls).toEqual([TEST_UTTERANCE_ID]);
    expect(second.core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1)).outgoing).toMatchObject([
      { type: 'audio.ack', highestContiguousExclusiveOffset: 1 }
    ]);
    expect(second.adapter.sessions[0]?.finalizeCalls).toEqual([TEST_UTTERANCE_ID]);
    expect(adapter.sessions[0]?.finalizeCalls).toHaveLength(0);

    const conflict = openNew();
    conflict.core.handleText(utteranceStartText());
    conflict.core.handleBinary(frame());
    expect(conflict.core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1)).outgoing).toMatchObject([
      { type: 'audio.ack', highestContiguousExclusiveOffset: 1 }
    ]);
    const conflictResult = conflict.core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 2));
    expect(conflictResult.outgoing).toMatchObject([
      { type: 'error', code: 'flow_control', scope: 'audio', recoverable: false }
    ]);
    expect(conflictResult.outgoing.some((message) => message.type === 'audio.ack')).toBe(false);
    expect(conflictResult.close).toEqual({ code: 1002, reason: 'protocol_error' });
    expect(conflict.adapter.sessions[0]?.closeCalls).toBe(1);
  });

  it('maps an already-cancelled finalize to provider loss without committing or ACKing', () => {
    const { core, adapter } = openNew(
      recordingAdapter(
        DETERMINISTIC_MOCK_CAPABILITIES,
        undefined,
        undefined,
        { status: 'already-cancelled' }
      )
    );
    core.handleText(utteranceStartText());
    core.handleBinary(frame());

    const result = core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1));
    expect(result.outgoing.map((message) => message.type)).toEqual(['utterance.aborted', 'error']);
    expect(result.outgoing).toMatchObject([
      { type: 'utterance.aborted', category: 'provider_loss' },
      { type: 'error', code: 'provider_unavailable' }
    ]);
    expect(result.outgoing.some((message) => message.type === 'audio.ack')).toBe(false);
    expect(result.close).toEqual({ code: 4503, reason: 'provider_unavailable' });
    expect(adapter.sessions[0]?.finalizeCalls).toEqual([TEST_UTTERANCE_ID]);
    expect(adapter.sessions[0]?.closeCalls).toBe(1);
  });

  it.each([
    'already-requested',
    'already-finalized'
  ] as const)('accepts the %s finalize status idempotently and awaits callback final', async (status) => {
    const { core, adapter } = openNew(recordingAdapter(
      DETERMINISTIC_MOCK_CAPABILITIES,
      undefined,
      undefined,
      { status }
    ));
    core.handleText(utteranceStartText());
    core.handleBinary(frame());

    const committed = core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1));
    expect(committed.outgoing).toMatchObject([
      { type: 'audio.ack', highestContiguousExclusiveOffset: 1 }
    ]);
    expect(await core.drainAsyncEvents()).toEqual({ outgoing: [] });

    adapter.sessions[0]?.emit(finalEvent());
    const final = await core.drainAsyncEvents();
    expect(final.outgoing.slice(0, 2).map((message) => message.type)).toEqual([
      'transcript.final',
      'language.decision'
    ]);
  });

  it('maps a thrown finalize to provider loss without committing or ACKing', () => {
    const finalizeError = new Error('finalize provider secret');
    const { core, adapter } = openNew(
      recordingAdapter(DETERMINISTIC_MOCK_CAPABILITIES, undefined, undefined, finalizeError)
    );
    core.handleText(utteranceStartText());
    core.handleBinary(frame());

    const result = core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1));
    expect(result.outgoing.map((message) => message.type)).toEqual(['utterance.aborted', 'error']);
    expect(result.outgoing).toMatchObject([
      { type: 'utterance.aborted', category: 'provider_loss' },
      { type: 'error', code: 'provider_unavailable' }
    ]);
    expect(result.outgoing.some((message) => message.type === 'audio.ack')).toBe(false);
    expect(result.close).toEqual({ code: 4503, reason: 'provider_unavailable' });
    expect(JSON.stringify(result)).not.toContain('finalize provider secret');
    expect(adapter.sessions[0]?.finalizeCalls).toEqual([TEST_UTTERANCE_ID]);
    expect(adapter.sessions[0]?.closeCalls).toBe(1);
  });

  it('rejects audio after commit without forwarding or acknowledging it', () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    core.handleBinary(frame());
    expect(core.handleText(utteranceCommitText(TEST_UTTERANCE_ID, 1)).outgoing).toMatchObject([
      { type: 'audio.ack', highestContiguousExclusiveOffset: 1 }
    ]);

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
      generationService: generationService(pendingGenerationProvider((signal) => {
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
      generationService: generationService(pendingGenerationProvider((signal) => {
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
      generationService: generationService(pendingGenerationProvider((signal) => {
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

  it('suppresses partial text and orders target final generation output', async () => {
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'hello',
      suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
      ]
    }));
    const { core } = openNew(recordingAdapter(), 'es', {
      generationService: generationService({
        id: 'one-call-provider',
        version: '1.0.0',
        complete
      })
    });
    core.handleText(utteranceStartText());
    const partial = await core.handleTranscriptionEvent(partialEvent());
    expect(partial.outgoing).toEqual([]);
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
      generationService: generationService({
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
      generationService: generationService(provider)
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
        generationService: generationService(provider)
      });
      core.handleText(utteranceStartText());
      const result = await core.handleTranscriptionEvent(finalEvent(category));
      expect(result.outgoing.map((message) => message.type)).toEqual([
        'language.decision'
      ]);
      expect(result.outgoing[0]).toMatchObject({ decision: category === 'uncertain' ? 'uncertain' : category === 'supported-unselected' ? 'supported_unselected' : category });
      expect(complete).not.toHaveBeenCalled();
    }
  });

  it('applies selected-target and supported-unselected decisions symmetrically for es and tr', async () => {
    for (const selectedLanguage of ['es', 'tr'] as const) {
      const oppositeLanguage = selectedLanguage === 'es' ? 'tr' : 'es';
      const selected = openNew(recordingAdapter(), selectedLanguage);
      selected.core.handleText(utteranceStartText());
      const accepted = await selected.core.handleTranscriptionEvent(
        finalEvent('target', TEST_UTTERANCE_ID, 1, selectedLanguage)
      );
      expect(accepted.outgoing.map((message) => message.type)).toEqual([
        'transcript.final',
        'language.decision'
      ]);
      expect(accepted.outgoing[1]).toMatchObject({
        decision: 'target',
        detectedLanguage: selectedLanguage
      });

      const unselected = openNew(recordingAdapter(), selectedLanguage);
      unselected.core.handleText(utteranceStartText());
      const rejected = await unselected.core.handleTranscriptionEvent(
        finalEvent('target', TEST_UTTERANCE_ID, 1, oppositeLanguage)
      );
      expect(rejected.outgoing).toMatchObject([
        {
          type: 'language.decision',
          decision: 'supported_unselected',
          detectedLanguage: oppositeLanguage
        }
      ]);
      expect(rejected.outgoing.some((message) => message.type === 'transcript.final')).toBe(false);
    }
  });

  it('ignores provider language metadata, confidence, logprobs, and raw scores', async () => {
    const { core } = openNew();
    core.handleText(utteranceStartText());
    const spoofed = {
      ...finalEvent(),
      languageEvidence: {
        detectorVersion: 'hostile-provider-detector',
        source: 'transcription-metadata' as const,
        detectedLanguage: 'en',
        confidence: 0
      },
      logprobs: [{ token: 'spoof', logprob: 0 }],
      rawScores: [{ language: 'en', score: 999 }]
    } as NormalizedTranscriptionFinal;

    const result = await core.handleTranscriptionEvent(spoofed);
    expect(result.outgoing).toMatchObject([
      { type: 'transcript.final', text: 'es-selected-target-final' },
      { type: 'language.decision', decision: 'target', detectedLanguage: 'es' }
    ]);
  });

  it.each(['resolved', 'microtask'] as const)(
    'serializes %s classifier completion before accepting a target final',
    async (mode) => {
      const classify = vi.fn((text: string): Promise<ClassifiedLanguageEvidence> => {
        expect(text).toBe('es-selected-target-final');
        if (mode === 'resolved') {
          return Promise.resolve(calibratedEvidence('es'));
        }
        return new Promise((resolve) => {
          queueMicrotask(() => resolve(calibratedEvidence('es')));
        });
      });
      const languageClassifier: TextLanguageClassifier = {
        ready: Promise.resolve(),
        classify
      };
      const { core } = openNew(recordingAdapter(), 'es', { languageClassifier });
      core.handleText(utteranceStartText());

      const result = await core.handleTranscriptionEvent(finalEvent());
      expect(result.outgoing.map((message) => message.type)).toEqual([
        'transcript.final',
        'language.decision'
      ]);
      expect(classify).toHaveBeenCalledTimes(1);
    }
  );

  it('fails classifier errors and unavailable text closed without transcript or generation', async () => {
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'must-not-run',
      suggestions: [
        { englishText: 'one', selectedTargetText: 'uno' },
        { englishText: 'two', selectedTargetText: 'dos' }
      ]
    }));
    for (const languageClassifier of [
      {
        ready: Promise.resolve(),
        classify: async (): Promise<ClassifiedLanguageEvidence> => {
          throw new Error('classifier secret');
        }
      },
      {
        ready: Promise.resolve(),
        classify: async (): Promise<ClassifiedLanguageEvidence> => ({
          status: 'unavailable',
          detectorVersion: CONTROLLED_FIXTURE_DETECTOR_VERSION
        })
      }
    ] satisfies readonly TextLanguageClassifier[]) {
      const { core } = openNew(recordingAdapter(), 'es', {
        languageClassifier,
        generationService: generationService({
          id: 'must-not-run',
          version: '1.0.0',
          complete
        })
      });
      core.handleText(utteranceStartText());
      const event = { ...finalEvent(), text: 'normal user text' };
      const result = await core.handleTranscriptionEvent(event);
      expect(result.outgoing).toMatchObject([
        { type: 'language.decision', decision: 'uncertain' }
      ]);
      expect(result.outgoing.some((message) => message.type.startsWith('transcript.'))).toBe(false);
      expect(JSON.stringify(result)).not.toContain('normal user text');
      expect(JSON.stringify(result)).not.toContain('classifier secret');
      expect(core.handleText(utteranceStartText(TEST_SECOND_UTTERANCE_ID))).toEqual({ outgoing: [] });
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects hostile classifier evidence at the Node boundary without invoking traps or accessors', async () => {
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'must-not-release',
      suggestions: [
        { englishText: 'one', selectedTargetText: 'uno' },
        { englishText: 'two', selectedTargetText: 'dos' }
      ]
    }));
    const base = calibratedEvidence('es');
    let accessorCalls = 0;
    let proxyTrapCalls = 0;
    const accessor = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessor, 'status', {
      enumerable: true,
      configurable: true,
      get: () => {
        accessorCalls += 1;
        throw new Error('classifier-accessor-canary');
      }
    });
    const symbol = { ...base } as Record<PropertyKey, unknown>;
    symbol[Symbol('extra')] = true;
    const proxy = new Proxy(base, {
      getOwnPropertyDescriptor: () => {
        proxyTrapCalls += 1;
        throw new Error('classifier-proxy-canary');
      },
      ownKeys: () => {
        proxyTrapCalls += 1;
        throw new Error('classifier-proxy-canary');
      }
    });
    const revoked = Proxy.revocable(base, {});
    revoked.revoke();

    for (const hostile of [accessor, symbol, proxy, revoked.proxy]) {
      const { core } = openNew(recordingAdapter(), 'es', {
        languageClassifier: {
          ready: Promise.resolve(),
          classify: async () => hostile as ClassifiedLanguageEvidence
        },
        generationService: generationService({
          id: 'hostile-evidence-must-not-run',
          version: '1.0.0',
          complete
        })
      });
      core.handleText(utteranceStartText());
      const result = await core.handleTranscriptionEvent(finalEvent());
      expect(result.outgoing).toEqual([
        expect.objectContaining({
          type: 'language.decision',
          decision: 'uncertain'
        })
      ]);
      expect(JSON.stringify(result)).not.toContain('classifier-');
    }
    expect(accessorCalls).toBe(0);
    expect(proxyTrapCalls).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('never calls generation for rejected development-provisional source evidence', async () => {
    const metrics = recordingMetricSink();
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'must-not-run',
      suggestions: [
        { englishText: 'one', selectedTargetText: 'uno' },
        { englishText: 'two', selectedTargetText: 'dos' }
      ]
    }));
    const languageClassifier: TextLanguageClassifier = {
      ready: Promise.resolve(),
      classify: async () => ({
        status: 'provisional',
        detectorVersion: 'eld-small-2.1.0',
        profileVersion: 'eld-small-dev-4',
        detectedLanguage: 'en',
        provisionalScore: 0.9,
        decision: 'reject',
        reason: 'ENGLISH'
      })
    };
    const { core } = openNew(recordingAdapter(), 'es', {
      languageBoundaryMode: 'development-provisional',
      languageClassifier,
      metricSink: metrics.sink,
      generationService: generationService({
        id: 'must-not-run',
        version: '1.0.0',
        complete
      })
    });
    core.handleText(utteranceStartText());
    const result = await core.handleTranscriptionEvent(finalEvent());
    expect(result.outgoing).toMatchObject([
      { type: 'language.decision', decision: 'english' }
    ]);
    expect(complete).not.toHaveBeenCalled();
    expect(metrics.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'language.decision',
        languageBoundaryMode: 'development-provisional',
        languageReason: 'ENGLISH',
        detectedLanguage: 'en',
        provisionalScoreBasisPoints: 9_000
      })
    ]));
    expect(JSON.stringify(metrics.records)).not.toContain('es-selected-target-final');
  });

  it('suppresses a classifier result that becomes stale during cancellation', async () => {
    let resolveClassification: ((evidence: ClassifiedLanguageEvidence) => void) | undefined;
    const languageClassifier: TextLanguageClassifier = {
      ready: Promise.resolve(),
      classify: () => new Promise((resolve) => {
        resolveClassification = resolve;
      })
    };
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'must-not-run',
      suggestions: [
        { englishText: 'one', selectedTargetText: 'uno' },
        { englishText: 'two', selectedTargetText: 'dos' }
      ]
    }));
    const { core } = openNew(recordingAdapter(), 'es', {
      languageClassifier,
      generationService: generationService({
        id: 'stale-classification-provider',
        version: '1.0.0',
        complete
      })
    });
    core.handleText(utteranceStartText());
    const final = core.handleTranscriptionEvent(finalEvent());
    await flushAsyncEvents();
    expect(core.handleText(utteranceCancelText())).toMatchObject({
      outgoing: [{ type: 'utterance.aborted', category: 'cancellation' }]
    });
    resolveClassification?.(calibratedEvidence('es'));

    await expect(final).resolves.toEqual({ outgoing: [] });
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not classify a hidden partial and keeps the utterance active for its final', async () => {
    let classifyCalls = 0;
    const languageClassifier: TextLanguageClassifier = {
      ready: Promise.resolve(),
      classify: async (text) => {
        classifyCalls += 1;
        if (text.includes('-partial-')) {
          throw new Error('partial classifier must not run');
        }
        return calibratedEvidence('es');
      }
    };
    const { core } = openNew(recordingAdapter(), 'es', { languageClassifier });
    core.handleText(utteranceStartText());

    const partial = await core.handleTranscriptionEvent(partialEvent(1));
    expect(partial).toEqual({ outgoing: [] });
    expect(JSON.stringify(partial)).not.toContain('partial classifier must not run');
    expect(await core.handleTranscriptionEvent(partialEvent(1))).toEqual({ outgoing: [] });
    expect(classifyCalls).toBe(0);

    const final = await core.handleTranscriptionEvent(
      finalEvent('target', TEST_UTTERANCE_ID, 2)
    );
    expect(final.outgoing.map((message) => message.type)).toEqual([
      'transcript.final',
      'language.decision'
    ]);
    expect(classifyCalls).toBe(1);
  });

  it('ignores stale, duplicate, and post-final events', async () => {
    const { core } = openNew();
    core.handleText(utteranceStartText());
    const stale = await core.handleTranscriptionEvent({ ...partialEvent(), sessionId: '99999999-9999-4999-8999-999999999999' });
    expect(stale).toEqual({ outgoing: [] });
    expect((await core.handleTranscriptionEvent(partialEvent(2))).outgoing).toHaveLength(0);
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
    expect(thrown.outgoing.some((message) => message.type === 'audio.ack')).toBe(false);
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

  it('returns a generic provider error when generation completion fails', async () => {
    const provider: GenerationProvider = {
      id: 'provider',
      version: '1.0.0',
      complete: async () => {
        throw new Error('suggestion secret');
      }
    };
    const { core } = openNew(recordingAdapter(), 'es', {
      generationService: generationService(provider)
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
    expect(result.outgoing).toEqual([]);
  });

  it('coalesces content-free transcription failures into one provider-loss terminal result', async () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    const session = adapter.sessions[0];
    session?.emit(partialEvent());
    session?.fail();
    session?.fail();

    const result = await core.drainAsyncEvents();
    expect(result.outgoing).toMatchObject([
      { type: 'utterance.aborted', category: 'provider_loss' },
      { type: 'error', code: 'provider_unavailable' }
    ]);
    expect(result.close).toEqual({ code: 4503, reason: 'provider_unavailable' });
    expect(JSON.stringify(result)).not.toContain('audioStateEpoch');
    expect(session?.cancelCalls).toEqual([TEST_UTTERANCE_ID]);
    expect(session?.closeCalls).toBe(1);
    expect(await core.drainAsyncEvents()).toEqual({
      outgoing: [],
      close: { code: 1000, reason: 'closed' }
    });
  });

  it('prioritizes transcription failure over a full non-partial callback backlog', async () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    const session = adapter.sessions[0];
    for (let revision = 1; revision <= 65; revision += 1) {
      session?.emit({
        ...finalEvent('english', TEST_UTTERANCE_ID, revision),
        segmentId: `failure-backlog-${revision}`
      });
    }
    session?.fail();

    const result = await core.drainAsyncEvents();
    expect(result.outgoing).toMatchObject([
      { type: 'utterance.aborted', category: 'provider_loss' },
      { type: 'error', code: 'provider_unavailable' }
    ]);
    expect(result.close).toEqual({ code: 4503, reason: 'provider_unavailable' });
  });

  it('lets cancellation win before a queued provider failure drains and suppresses stale callbacks', async () => {
    const { core, adapter } = openNew();
    core.handleText(utteranceStartText());
    const session = adapter.sessions[0];
    session?.fail();

    const cancelled = core.handleText(utteranceCancelText());
    expect(cancelled.outgoing).toMatchObject([
      { type: 'utterance.aborted', category: 'cancellation' }
    ]);
    session?.fail();
    session?.emit(partialEvent());
    expect(await core.drainAsyncEvents()).toEqual({ outgoing: [] });
    expect(session?.cancelCalls).toEqual([TEST_UTTERANCE_ID]);
    expect(session?.closeCalls).toBe(1);
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
      generationService: generationService(provider)
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
      generationService: generationService(provider)
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

  it('forces a forged calibrated target final to exact uncertain in deny-all mode', async () => {
    const classify = vi.fn(async () => calibratedEvidence('es'));
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'must-not-run',
      suggestions: [
        { englishText: 'one', selectedTargetText: 'uno' },
        { englishText: 'two', selectedTargetText: 'dos' }
      ]
    }));
    const baseSecurity = createTestSecurityRuntime();
    const authorizeGeneration = vi.fn(baseSecurity.authorizeGeneration);
    const { core } = openNew(recordingAdapter(), 'es', {
      languageBoundaryMode: 'deny-all',
      languageClassifier: { ready: Promise.resolve(), classify },
      securityRuntime: createTestSecurityRuntime({ authorizeGeneration }),
      generationService: generationService({
        id: 'deny-all-must-not-run',
        version: '1.0.0',
        complete
      })
    });
    core.handleText(utteranceStartText());

    const result = await core.handleTranscriptionEvent({
      ...finalEvent(),
      text: 'private target transcript',
      languageEvidence: {
        detectorVersion: CONTROLLED_FIXTURE_DETECTOR_VERSION,
        source: 'controlled-fixture',
        detectedLanguage: 'es',
        confidence: 1
      }
    });

    expect(result.outgoing).toEqual([
      expect.objectContaining({
        type: 'language.decision',
        decision: 'uncertain',
        selectedTargetLanguage: 'es'
      })
    ]);
    expect(JSON.stringify(result)).not.toContain('private target transcript');
    expect(classify).not.toHaveBeenCalled();
    expect(authorizeGeneration).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects an unknown language boundary mode before any provider boundary is reachable', () => {
    const classify = vi.fn(async () => calibratedEvidence('es'));
    const baseSecurity = createTestSecurityRuntime();
    const authorizeGeneration = vi.fn(baseSecurity.authorizeGeneration);
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'must-not-run',
      suggestions: [
        { englishText: 'one', selectedTargetText: 'uno' },
        { englishText: 'two', selectedTargetText: 'dos' }
      ]
    }));
    const adapter = recordingAdapter();
    const invalid = {
      ...createTestOptions({
        transcriptionAdapter: adapter,
        languageClassifier: { ready: Promise.resolve(), classify },
        securityRuntime: createTestSecurityRuntime({ authorizeGeneration }),
        generationService: generationService({
          id: 'invalid-boundary-must-not-run',
          version: '1.0.0',
          complete
        })
      }),
      languageBoundaryMode: 'allow-all'
    };

    expect(() => new RelaySessionCore(
      invalid as unknown as RelaySessionCoreOptions
    )).toThrow('Invalid relay language boundary mode.');
    expect(adapter.sessions).toHaveLength(0);
    expect(classify).not.toHaveBeenCalled();
    expect(authorizeGeneration).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps production-approved target gating reachable only by explicit injection', async () => {
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'hello',
      suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
      ]
    }));
    const { core } = openNew(recordingAdapter(), 'es', {
      languageBoundaryMode: 'production-approved',
      languageClassifier: {
        ready: Promise.resolve(),
        classify: async () => calibratedEvidence('es')
      },
      generationService: generationService({
        id: 'production-approved-injected-provider',
        version: '1.0.0',
        complete
      })
    });
    core.handleText(utteranceStartText());

    const result = await core.handleTranscriptionEvent(finalEvent());

    expect(result.outgoing.map((message) => message.type)).toEqual([
      'transcript.final',
      'language.decision'
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('resolves the transcription adapter for the selected target', () => {
    const spanish = recordingAdapter();
    const turkish = recordingAdapter();
    const { core } = openNew(recordingAdapter(), 'tr', {
      transcriptionAdapters: { es: spanish, tr: turkish }
    });

    expect(core.handleText(utteranceStartText())).toEqual({ outgoing: [] });
    expect(spanish.sessions).toHaveLength(0);
    expect(turkish.sessions).toHaveLength(1);
  });

  it('accepts exactly one callback adapter mechanism', () => {
    const spanish = recordingAdapter();
    const turkish = recordingAdapter();
    const callback = vi.fn((target: 'es' | 'tr') =>
      target === 'es' ? spanish : turkish
    );
    const { core } = openNew(recordingAdapter(), 'tr', {
      transcriptionAdapterForTarget: callback
    });

    expect(core.handleText(utteranceStartText())).toEqual({ outgoing: [] });
    expect(callback).toHaveBeenCalledWith('tr');
    expect(spanish.sessions).toHaveLength(0);
    expect(turkish.sessions).toHaveLength(1);
  });

  it.each(['es', 'tr'] as const)(
    'records one selected %s transcription provider failure for unsupported capabilities',
    (targetLanguage) => {
      const metrics = recordingMetricSink();
      const unsupported = recordingAdapter({
        ...DETERMINISTIC_MOCK_CAPABILITIES,
        manualCommit: {
          ...DETERMINISTIC_MOCK_CAPABILITIES.manualCommit,
          supported: false
        }
      });
      const unselected = recordingAdapter();
      const adapters = targetLanguage === 'es'
        ? { es: unsupported, tr: unselected }
        : { es: unselected, tr: unsupported };
      const { core } = openNew(recordingAdapter(), targetLanguage, {
        transcriptionAdapters: adapters,
        metricSink: metrics.sink
      });

      const first = core.handleText(utteranceStartText());
      const terminalRetry = core.handleText(utteranceStartText());

      expect(first).toMatchObject({
        outgoing: [expect.objectContaining({
          type: 'error',
          code: 'provider_unavailable'
        })],
        close: { code: 4503, reason: 'provider_unavailable' }
      });
      expect(terminalRetry).toEqual({
        outgoing: [],
        close: { code: 1000, reason: 'closed' }
      });
      expect(unsupported.sessions).toHaveLength(0);
      expect(unselected.sessions).toHaveLength(0);
      expect(metrics.records.filter((record) => record.name === 'provider.failure')).toEqual([
        {
          name: 'provider.failure',
          timestamp: '2026-08-10T12:00:00.000Z',
          count: 1,
          targetLanguage,
          operation: 'transcription',
          outcome: 'failure',
          providerId: 'deterministic-mock',
          providerVersion: '1.0.0'
        }
      ]);
    }
  );

  it.each([
    'map+single',
    'callback+single',
    'map+callback',
    'all',
    'missing'
  ] as const)('rejects %s adapter configuration without silent precedence', (kind) => {
    const single = recordingAdapter();
    const adapters = { es: recordingAdapter(), tr: recordingAdapter() };
    const callback = (target: 'es' | 'tr'): TranscriptionAdapter => adapters[target];
    const base = createTestOptions({ transcriptionAdapter: single });
    const withoutAdapters = { ...base } as Record<string, unknown>;
    delete withoutAdapters.transcriptionAdapter;
    delete withoutAdapters.transcriptionAdapters;
    delete withoutAdapters.transcriptionAdapterForTarget;
    const invalid = kind === 'map+single'
      ? { ...withoutAdapters, transcriptionAdapters: adapters, transcriptionAdapter: single }
      : kind === 'callback+single'
        ? { ...withoutAdapters, transcriptionAdapterForTarget: callback, transcriptionAdapter: single }
        : kind === 'map+callback'
          ? { ...withoutAdapters, transcriptionAdapters: adapters, transcriptionAdapterForTarget: callback }
          : kind === 'all'
            ? {
                ...withoutAdapters,
                transcriptionAdapters: adapters,
                transcriptionAdapterForTarget: callback,
                transcriptionAdapter: single
              }
            : withoutAdapters;

    expect(() => new RelaySessionCore(invalid as unknown as RelaySessionCoreOptions)).toThrow(
      'Invalid relay transcription adapter configuration.'
    );
  });

  it('rejects an explicitly undefined second adapter mechanism', () => {
    const invalid = {
      ...createTestOptions({ transcriptionAdapter: recordingAdapter() }),
      transcriptionAdapterForTarget: undefined
    };

    expect(() => new RelaySessionCore(invalid as unknown as RelaySessionCoreOptions)).toThrow(
      'Invalid relay transcription adapter configuration.'
    );
  });

  it.each(['missing-target', 'extra-target', 'accessor'] as const)(
    'rejects a non-exact %s adapter map',
    (kind) => {
      const adapter = recordingAdapter();
      const map: unknown = kind === 'missing-target'
        ? { es: adapter }
        : kind === 'extra-target'
          ? { es: adapter, tr: adapter, fr: adapter }
          : Object.defineProperty({ tr: adapter }, 'es', { get: () => adapter });
      expect(() => new RelaySessionCore(createTestOptions({
        transcriptionAdapters: map as Record<'es' | 'tr', TranscriptionAdapter>
      }))).toThrow('Invalid relay transcription adapter configuration.');
    }
  );

  it('publishes only the closed 19-name metadata vocabulary', () => {
    expect(RELAY_METRIC_NAMES).toEqual([
      'session.start',
      'session.reject',
      'session.end',
      'utterance.start',
      'utterance.abort',
      'utterance.complete',
      'audio.samples.accepted',
      'audio.samples.duplicate',
      'audio.samples.rejected',
      'transport.reconnect',
      'transcription.first_partial_latency',
      'transcription.final_latency',
      'language.decision',
      'translation.latency',
      'translation.result',
      'suggestion.latency',
      'suggestion.result',
      'provider.failure',
      'state_store.failure'
    ]);
    expect(new Set(RELAY_METRIC_NAMES).size).toBe(19);
  });

  it('records exact metadata-only lifecycle values once for a suppressed final', async () => {
    const metrics = recordingMetricSink();
    const { core } = openNew(recordingAdapter(), 'es', {
      metricSink: metrics.sink,
      clock: monotonicClock(100, 175)
    });
    expect(metrics.records[0]).toEqual({
      name: 'session.start',
      timestamp: '2026-08-10T12:00:00.000Z',
      count: 1,
      protocolVersion: 1,
      targetLanguage: 'es',
      operation: 'session',
      outcome: 'success'
    });
    core.handleText(utteranceStartText());

    const first = await core.handleTranscriptionEvent(finalEvent('english'));
    const duplicate = await core.handleTranscriptionEvent(finalEvent('english'));
    core.close();

    expect(first.outgoing).toMatchObject([
      { type: 'language.decision', decision: 'english' }
    ]);
    expect(duplicate).toEqual({ outgoing: [] });
    expect(metrics.records.filter((record) => record.name === 'language.decision')).toEqual([
      {
        name: 'language.decision',
        timestamp: '2026-08-10T12:00:00.000Z',
        count: 1,
        targetLanguage: 'es',
        gateDecision: 'english',
        languageBoundaryMode: 'fixture',
        operation: 'language',
        outcome: 'rejected'
      }
    ]);
    expect(metrics.records.filter((record) => record.name === 'utterance.complete')).toHaveLength(1);
    expect(metrics.records.filter((record) => record.name === 'session.end')).toHaveLength(1);
    const forbiddenKeys = [
      'correlationId',
      'sessionId',
      'utteranceId',
      'installationId',
      'requestId',
      'traceId',
      'spanId',
      'errorId',
      'text',
      'transcript',
      'translation',
      'suggestions',
      'content',
      'audio',
      'pcm',
      'prompt',
      'message'
    ];
    for (const record of metrics.records) {
      expect(Object.keys(record).some((key) => forbiddenKeys.includes(key))).toBe(false);
    }

    const rejectedMetrics = recordingMetricSink();
    const rejected = new RelaySessionCore(createTestOptions({ metricSink: rejectedMetrics.sink }));
    rejected.openWithFirstText('{');
    expect(rejectedMetrics.records).toEqual([
      {
        name: 'session.reject',
        timestamp: '2026-08-10T12:00:00.000Z',
        count: 1,
        protocolVersion: 1,
        operation: 'session',
        outcome: 'rejected'
      }
    ]);
  });

  it('records first partial latency once without classifier or content', async () => {
    const metrics = recordingMetricSink();
    const classify = vi.fn(async () => calibratedEvidence('es'));
    const { core } = openNew(recordingAdapter(), 'es', {
      metricSink: metrics.sink,
      clock: monotonicClock(10, 40),
      languageClassifier: { ready: Promise.resolve(), classify }
    });
    core.handleText(utteranceStartText());

    expect(await core.handleTranscriptionEvent(partialEvent(1))).toEqual({ outgoing: [] });
    expect(await core.handleTranscriptionEvent(partialEvent(2))).toEqual({ outgoing: [] });

    expect(classify).not.toHaveBeenCalled();
    expect(metrics.records.filter(
      (record) => record.name === 'transcription.first_partial_latency'
    )).toEqual([
      expect.objectContaining({ durationMs: 30, outcome: 'success' })
    ]);
  });

  it('uses one combined generation call and the same translation/suggestion latency', async () => {
    const metrics = recordingMetricSink();
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'hello',
      suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
      ]
    }));
    const { core } = openNew(recordingAdapter(), 'es', {
      metricSink: metrics.sink,
      clock: monotonicClock(100, 250, 300, 450),
      generationService: generationService({
        id: 'combined-latency-provider',
        version: '1.0.0',
        complete
      })
    });
    core.handleText(utteranceStartText());
    await core.handleTranscriptionEvent(finalEvent());
    await flushAsyncEvents();
    await core.drainAsyncEvents();

    expect(complete).toHaveBeenCalledTimes(1);
    const translationLatency = metrics.records.find(
      (record) => record.name === 'translation.latency'
    );
    const suggestionLatency = metrics.records.find(
      (record) => record.name === 'suggestion.latency'
    );
    expect(translationLatency).toMatchObject({ durationMs: 150, outcome: 'success' });
    expect(suggestionLatency).toMatchObject({ durationMs: 150, outcome: 'success' });
    expect(metrics.records.filter((record) => record.name === 'translation.result')).toHaveLength(1);
    expect(metrics.records.filter((record) => record.name === 'suggestion.result')).toHaveLength(1);
  });

  it('contains a reentrant monotonic clock at utterance start', async () => {
    const metrics = recordingMetricSink();
    const holder: { core?: RelaySessionCore } = {};
    let calls = 0;
    const clock: RelayClock = {
      nowIso: () => '2026-08-10T12:00:00.000Z',
      nowMonotonicMs: () => {
        calls += 1;
        if (calls === 1) {
          expect(holder.core?.close()).toEqual({ outgoing: [] });
        }
        return calls * 100;
      }
    };
    const { core } = openNew(recordingAdapter(), 'es', { clock, metricSink: metrics.sink });
    holder.core = core;

    expect(core.handleText(utteranceStartText())).toEqual({ outgoing: [] });
    const final = await core.handleTranscriptionEvent(finalEvent());
    expect(final.outgoing.map((message) => message.type)).toEqual([
      'transcript.final',
      'language.decision'
    ]);
    await flushAsyncEvents();
    expect((await core.drainAsyncEvents()).outgoing.map((message) => message.type)).toEqual([
      'translation.ready',
      'suggestions.ready'
    ]);
  });

  it('drops nonfinite partial latency and normalizes a regressive final clock', async () => {
    const metrics = recordingMetricSink();
    const values = [100, Number.NaN, 50, 200, 300];
    const clock: RelayClock = {
      nowIso: () => '2026-08-10T12:00:00.000Z',
      nowMonotonicMs: () => values.shift() ?? 300
    };
    const { core } = openNew(recordingAdapter(), 'es', { clock, metricSink: metrics.sink });
    core.handleText(utteranceStartText());

    expect(await core.handleTranscriptionEvent(partialEvent(1))).toEqual({ outgoing: [] });
    const final = await core.handleTranscriptionEvent(finalEvent('target', TEST_UTTERANCE_ID, 2));

    expect(final.outgoing.map((message) => message.type)).toEqual([
      'transcript.final',
      'language.decision'
    ]);
    expect(metrics.records.some(
      (record) => record.name === 'transcription.first_partial_latency'
    )).toBe(false);
    expect(metrics.records).toContainEqual(expect.objectContaining({
      name: 'transcription.final_latency',
      durationMs: 0
    }));
  });

  it.each(['generation-start', 'generation-result'] as const)(
    'contains a throwing monotonic clock at %s without stranding durable claims',
    async (stage) => {
      const baseSecurity = createTestSecurityRuntime();
      const authorizeGeneration = vi.fn(baseSecurity.authorizeGeneration);
      const providerStart = vi.fn(baseSecurity.providerStart);
      const completeGeneration = vi.fn(baseSecurity.completeGeneration);
      const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
        englishTranslation: 'hello',
        suggestions: [
          { englishText: 'hello', selectedTargetText: 'hola' },
          { englishText: 'hi', selectedTargetText: 'buenas' }
        ]
      }));
      let calls = 0;
      const throwAt = stage === 'generation-start' ? 3 : 4;
      const clock: RelayClock = {
        nowIso: () => '2026-08-10T12:00:00.000Z',
        nowMonotonicMs: () => {
          calls += 1;
          if (calls === throwAt) throw new Error('hostile monotonic clock');
          return calls * 100;
        }
      };
      const { core } = openNew(recordingAdapter(), 'es', {
        clock,
        securityRuntime: createTestSecurityRuntime({
          authorizeGeneration,
          providerStart,
          completeGeneration
        }),
        generationService: generationService({
          id: 'hostile-clock-generation-provider',
          version: '1.0.0',
          complete
        })
      });
      core.handleText(utteranceStartText());
      const final = await core.handleTranscriptionEvent(finalEvent());
      await flushAsyncEvents();
      const generated = await core.drainAsyncEvents();

      expect(final.outgoing.map((message) => message.type)).toEqual([
        'transcript.final',
        'language.decision'
      ]);
      expect(generated.outgoing.map((message) => message.type)).toEqual([
        'translation.ready',
        'suggestions.ready'
      ]);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(authorizeGeneration).toHaveBeenCalledTimes(1);
      expect(providerStart).toHaveBeenCalledTimes(1);
      expect(completeGeneration).toHaveBeenCalledTimes(1);
    }
  );

  it('contains hostile metric sinks without changing protocol behavior', async () => {
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'must-not-run',
      suggestions: [
        { englishText: 'one', selectedTargetText: 'uno' },
        { englishText: 'two', selectedTargetText: 'dos' }
      ]
    }));
    const { core } = openNew(recordingAdapter(), 'es', {
      languageBoundaryMode: 'deny-all',
      metricSink: { record: () => { throw new Error('hostile metric sink'); } },
      generationService: generationService({
        id: 'hostile-sink-must-not-run',
        version: '1.0.0',
        complete
      })
    });

    expect(core.handleText(utteranceStartText())).toEqual({ outgoing: [] });
    await expect(core.handleTranscriptionEvent(finalEvent())).resolves.toMatchObject({
      outgoing: [{ type: 'language.decision', decision: 'uncertain' }]
    });
    expect(core.close()).toEqual({ outgoing: [], close: { code: 1000, reason: 'closed' } });
    expect(complete).not.toHaveBeenCalled();
  });

  it('blocks metric-sink reentrancy while session.start is observed', () => {
    const holder: { core?: RelaySessionCore } = {};
    const records: RelayProductionMetricInput[] = [];
    let nestedClose: ReturnType<RelaySessionCore['close']> | undefined;
    const metricSink: RelayMetricSink = {
      record: (record) => {
        records.push(record);
        if (record.name === 'session.start') {
          nestedClose = holder.core?.close();
        }
      }
    };
    const core = new RelaySessionCore(createTestOptions({ metricSink }));
    holder.core = core;

    const opened = core.openWithFirstText(startText());

    expect(opened.close).toBeUndefined();
    expect(opened.outgoing).toEqual([
      expect.objectContaining({ type: 'session.ready' })
    ]);
    expect(nestedClose).toEqual({ outgoing: [] });
    expect(core.handleText(utteranceStartText())).toEqual({ outgoing: [] });
    expect(records.filter((record) => record.name === 'session.start')).toHaveLength(1);
  });

  it.each([
    ['sync-throw', 'success'],
    ['sync-throw', 'failure'],
    ['async-reject', 'success'],
    ['async-reject', 'failure'],
    ['throwing-then-accessor', 'success'],
    ['throwing-thenable', 'failure']
  ] as const)(
    'contains a %s notifier after %s generation and settles the durable claim',
    async (notifierKind, outcome) => {
      const baseSecurity = createTestSecurityRuntime();
      const completeGeneration = vi.fn(baseSecurity.completeGeneration);
      const notifier = vi.fn((): unknown => {
        if (notifierKind === 'sync-throw') {
          throw new Error('hostile synchronous notifier');
        }
        if (notifierKind === 'async-reject') {
          return (async (): Promise<void> => {
            await Promise.resolve();
            throw new Error('hostile asynchronous notifier');
          })();
        }
        if (notifierKind === 'throwing-then-accessor') {
          return Object.defineProperty({}, 'then', {
            get: () => {
              throw new Error('hostile then accessor');
            }
          });
        }
        return {
          then: (): never => {
            throw new Error('hostile thenable');
          }
        };
      });
      const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => {
        if (outcome === 'failure') {
          throw new Error('generation failed');
        }
        return {
          englishTranslation: 'hello',
          suggestions: [
            { englishText: 'hello', selectedTargetText: 'hola' },
            { englishText: 'hi', selectedTargetText: 'buenas' }
          ]
        };
      });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      let drained: Awaited<ReturnType<RelaySessionCore['drainAsyncEvents']>>;
      try {
        const { core } = openNew(recordingAdapter(), 'es', {
          onAsyncEventsAvailable: notifier,
          securityRuntime: createTestSecurityRuntime({ completeGeneration }),
          generationService: generationService({
            id: 'deterministic-mock-generation',
            version: '1.0.0',
            complete
          })
        });
        core.handleText(utteranceStartText());
        await core.handleTranscriptionEvent(finalEvent());
        await flushAsyncEvents();
        await flushAsyncEvents();
        drained = await core.drainAsyncEvents();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }

      expect(notifier).toHaveBeenCalledTimes(1);
      expect(completeGeneration).toHaveBeenCalledTimes(1);
      expect(completeGeneration.mock.calls[0]?.[0]).toMatchObject({
        outcome: outcome === 'success' ? 'completed' : 'failed'
      });
      expect(unhandled).toEqual([]);
      expect(drained.outgoing.map((message) => message.type)).toEqual(
        outcome === 'success'
          ? ['translation.ready', 'suggestions.ready']
          : ['error']
      );
    }
  );

  it('records accepted, duplicate, and rejected sample counts at exact producer points', () => {
    const metrics = recordingMetricSink();
    const { core } = openNew(recordingAdapter(), 'es', { metricSink: metrics.sink });
    core.handleText(utteranceStartText());

    core.handleBinary(frame(TEST_UTTERANCE_ID, 0, 0, pcmSamples(2)));
    core.handleBinary(frame(TEST_UTTERANCE_ID, 0, 0, pcmSamples(2)));
    core.handleBinary(frame(TEST_UTTERANCE_ID, 2, 2, pcmSamples(2)));

    expect(metrics.records.filter((record) => record.name.startsWith('audio.samples.'))).toEqual([
      expect.objectContaining({ name: 'audio.samples.accepted', sampleCount: 2 }),
      expect.objectContaining({ name: 'audio.samples.duplicate', sampleCount: 2 }),
      expect.objectContaining({ name: 'audio.samples.rejected', sampleCount: 2 })
    ]);
  });

  it('records reconnect, provider, and state-store failures without identifiers', async () => {
    const reconnectMetrics = recordingMetricSink();
    const lease = { ...createTestSessionLease(), sessionEpoch: 2 };
    const reconnectCore = new RelaySessionCore(createTestOptions({
      sessionLease: lease,
      metricSink: reconnectMetrics.sink
    }));
    reconnectCore.openWithFirstText(startText());
    expect(reconnectMetrics.records).toContainEqual(expect.objectContaining({
      name: 'transport.reconnect',
      count: 1,
      outcome: 'reconnected'
    }));

    const providerMetrics = recordingMetricSink();
    const providerFailure = openNew(
      recordingAdapter(DETERMINISTIC_MOCK_CAPABILITIES, undefined, new Error('provider')),
      'es',
      { metricSink: providerMetrics.sink }
    ).core;
    providerFailure.handleText(utteranceStartText());
    providerFailure.handleBinary(frame());
    expect(providerMetrics.records.filter((record) => record.name === 'provider.failure')).toHaveLength(1);

    const stateMetrics = recordingMetricSink();
    const stateFailure = openNew(recordingAdapter(), 'es', {
      metricSink: stateMetrics.sink,
      securityRuntime: createTestSecurityRuntime({
        authorizeGeneration: async () => { throw new SecurityStateError('state-unavailable'); }
      })
    }).core;
    stateFailure.handleText(utteranceStartText());
    await stateFailure.handleTranscriptionEvent(finalEvent());
    expect(stateMetrics.records.filter((record) => record.name === 'state_store.failure')).toHaveLength(1);
    expect([...providerMetrics.records, ...stateMetrics.records].some(
      (record) => Object.hasOwn(record, 'errorId') || Object.hasOwn(record, 'sessionId')
    )).toBe(false);
  });

  it('enriches every core metric for exact production sanitizer acceptance', async () => {
    const metrics = recordingMetricSink();

    const successful = openNew(recordingAdapter(), 'es', {
      metricSink: metrics.sink,
      clock: monotonicClock(0, 10, 20, 30, 40)
    }).core;
    successful.handleText(utteranceStartText());
    successful.handleBinary(frame(TEST_UTTERANCE_ID, 0, 0, pcmSamples(2)));
    successful.handleBinary(frame(TEST_UTTERANCE_ID, 0, 0, pcmSamples(2)));
    await successful.handleTranscriptionEvent(partialEvent(1));
    await successful.handleTranscriptionEvent(finalEvent('target', TEST_UTTERANCE_ID, 2));
    await flushAsyncEvents();
    await successful.drainAsyncEvents();
    successful.close();

    const rejected = new RelaySessionCore(createTestOptions({ metricSink: metrics.sink }));
    rejected.openWithFirstText('{');

    const aborted = openNew(recordingAdapter(), 'es', { metricSink: metrics.sink }).core;
    aborted.handleText(utteranceStartText());
    aborted.handleBinary(frame(TEST_UTTERANCE_ID, 1, 1, pcmSamples(2)));

    const reconnectLease = { ...createTestSessionLease(), sessionEpoch: 2 };
    const reconnected = new RelaySessionCore(createTestOptions({
      sessionLease: reconnectLease,
      metricSink: metrics.sink
    }));
    reconnected.openWithFirstText(startText());
    reconnected.close();

    const transcriptionFailure = openNew(
      recordingAdapter(DETERMINISTIC_MOCK_CAPABILITIES, undefined, new Error('provider')),
      'es',
      { metricSink: metrics.sink }
    ).core;
    transcriptionFailure.handleText(utteranceStartText());
    transcriptionFailure.handleBinary(frame());

    const generationFailure = openNew(recordingAdapter(), 'es', {
      metricSink: metrics.sink,
      generationService: generationService({
        id: 'deterministic-mock-generation',
        version: '1.0.0',
        complete: async () => { throw new Error('provider'); }
      })
    }).core;
    generationFailure.handleText(utteranceStartText());
    await generationFailure.handleTranscriptionEvent(finalEvent());
    await flushAsyncEvents();
    await generationFailure.drainAsyncEvents();
    generationFailure.close();

    const stateFailure = openNew(recordingAdapter(), 'es', {
      metricSink: metrics.sink,
      securityRuntime: createTestSecurityRuntime({
        authorizeGeneration: async () => { throw new SecurityStateError('state-unavailable'); }
      })
    }).core;
    stateFailure.handleText(utteranceStartText());
    await stateFailure.handleTranscriptionEvent(finalEvent());
    stateFailure.close();

    expect(new Set(metrics.records.map((record) => record.name))).toEqual(
      new Set(RELAY_METRIC_NAMES)
    );
    for (const record of metrics.records) {
      const sanitizerRecord = Object.fromEntries(
        Object.entries(record).filter(([key]) => ![
          'languageBoundaryMode',
          'languageReason',
          'detectedLanguage',
          'provisionalScoreBasisPoints'
        ].includes(key))
      );
      const enriched = { ...sanitizerRecord, deploymentSlot: 'dev' as const };
      const sanitized = sanitizeTelemetryForExport(enriched, 'dev');
      expect({ ...sanitized }).toEqual(enriched);
      expect(Object.hasOwn(sanitized, 'errorCategory')).toBe(false);
      expect(Object.hasOwn(sanitized, 'errorId')).toBe(false);
    }
    expect(metrics.records.filter((record) => record.name === 'provider.failure')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'transcription',
          providerId: 'deterministic-mock',
          providerVersion: '1.0.0'
        }),
        expect.objectContaining({
          operation: 'provider',
          providerId: 'deterministic-mock-generation',
          providerVersion: '1.0.0'
        })
      ])
    );
    expect(metrics.records.some((record) => record.name === 'state_store.failure')).toBe(true);
  });

  it('constructs every test generation consumer with its mandatory validator', () => {
    expect(createTestOptions().generationService.validator).toEqual({
      id: 'deterministic-language-fixture',
      version: '1.0.0'
    });
  });

  it('negotiates fresh frozen limits', () => {
    const limits = negotiateLimits({ ...DEFAULT_NEGOTIATED_LIMITS, maxControlMessageBytes: 128 });
    expect(limits).not.toBe(DEFAULT_NEGOTIATED_LIMITS);
    expect(Object.isFrozen(limits)).toBe(true);
    expect(limits.maxControlMessageBytes).toBe(128);
  });
});
