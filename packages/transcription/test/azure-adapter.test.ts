import { describe, expect, it, vi } from 'vitest';

import {
  AZURE_REALTIME_TRANSCRIPTION_APPEND_MAX_BYTES,
  AzureRealtimeTranscriptionAdapter,
  type AzureRealtimeSocket,
  type AzureRealtimeSocketEvent,
  type AzureRealtimeSocketFactory
} from '../src/azure-adapter.js';
import { buildAzureRealtimeSessionUpdateMessage } from '../src/azure-client.js';
import type { NormalizedTranscriptionEvent, TranscriptionSession } from '../src/types.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';
const NEXT_UTTERANCE_ID = '33333333-3333-4333-8333-333333333333';
const AZURE_ENDPOINT =
  'wss://resource.openai.azure.com/openai/v1/realtime?intent=transcription';
let eventSequence = 0;

type Listener = (...args: never[]) => void;

class FakeSocket implements AzureRealtimeSocket {
  readyState = 0;
  bufferedAmount = 0;
  autoCompleteSends = true;
  closeCalls = 0;
  terminateCalls = 0;
  readonly sent: string[] = [];
  readonly pendingSendCallbacks: Array<(error?: Error | null) => void> = [];
  readonly #listeners = new Map<string, Set<Listener>>();

  send(data: string, callback: (error?: Error | null) => void): void {
    this.sent.push(data);
    if (this.autoCompleteSends) {
      callback(null);
    } else {
      this.pendingSendCallbacks.push(callback);
    }
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
    this.#emit('close');
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.readyState = 3;
  }

  on(event: 'open' | 'message' | 'error' | 'close', listener: Listener): void {
    const listeners = this.#listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  }

  off(event: 'open' | 'message' | 'error' | 'close', listener: Listener): void {
    this.#listeners.get(event)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.#emit('open');
  }

  resetForReuse(): void {
    this.readyState = 0;
  }

  completeNextSend(error?: Error | null): void {
    const callback = this.pendingSendCallbacks.shift();
    if (callback === undefined) throw new Error('No pending send callback');
    if (arguments.length === 0) callback(null);
    else callback(error);
  }

  message(value: unknown): void {
    this.#emit('message', value);
  }

  error(): void {
    this.#emit('error');
  }

  listenerCount(event: AzureRealtimeSocketEvent): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...args as never[]);
    }
  }
}

class ReentrantReadySocket extends FakeSocket {
  override on(event: 'open' | 'message' | 'error' | 'close', listener: Listener): void {
    super.on(event, listener);
    if (event === 'open') {
      this.readyState = 1;
      listener();
    } else if (event === 'message') {
      listener(sessionUpdated() as never);
    }
  }
}

class ReentrantTimeoutSocket extends FakeSocket {
  readonly #onMessageRegistration: () => void;

  constructor(onMessageRegistration: () => void) {
    super();
    this.#onMessageRegistration = onMessageRegistration;
  }

  override on(event: 'open' | 'message' | 'error' | 'close', listener: Listener): void {
    super.on(event, listener);
    if (event === 'open') {
      this.readyState = 1;
      listener();
    } else if (event === 'message') {
      this.#onMessageRegistration();
    }
  }
}

function serverEvent(type: string, body: Record<string, unknown>): string {
  eventSequence += 1;
  return JSON.stringify({ type, event_id: `evt-${eventSequence}`, ...body });
}

function sessionCreated(): string {
  return serverEvent('session.created', {
    session: {
      type: 'transcription',
      object: 'realtime.transcription_session',
      id: 'azure-session-1'
    }
  });
}

function sessionUpdated(sessionId = 'azure-session-1'): string {
  return serverEvent('session.updated', {
    session: {
      type: 'transcription',
      object: 'realtime.transcription_session',
      id: sessionId,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          turn_detection: null,
          transcription: { model: 'transcribe-prod' }
        }
      }
    }
  });
}

function committed(itemId: string, previousItemId: string | null): string {
  return serverEvent('input_audio_buffer.committed', {
    item_id: itemId,
    previous_item_id: previousItemId
  });
}

function delta(itemId: string, value: string): string {
  return serverEvent('conversation.item.input_audio_transcription.delta', {
    item_id: itemId,
    content_index: 0,
    delta: value
  });
}

function completed(itemId: string, value: string): string {
  return serverEvent('conversation.item.input_audio_transcription.completed', {
    item_id: itemId,
    content_index: 0,
    transcript: value,
    usage: {
      type: 'tokens',
      total_tokens: 2,
      input_tokens: 1,
      output_tokens: 1
    }
  });
}

function transcriptionFailed(itemId: string): string {
  return serverEvent('conversation.item.input_audio_transcription.failed', {
    item_id: itemId,
    content_index: 0,
    error: {
      type: 'transcription_error',
      code: 'audio_unintelligible',
      message: 'provider detail',
      param: null
    }
  });
}

function rateLimitsUpdated(): string {
  return serverEvent('rate_limits.updated', {
    rate_limits: [{ name: 'requests', limit: 100, remaining: 99, reset_seconds: 1.5 }]
  });
}

function cleared(): string {
  return serverEvent('input_audio_buffer.cleared', {});
}

function speechStarted(): string {
  return serverEvent('input_audio_buffer.speech_started', {
    item_id: 'speech-item',
    audio_start_ms: 0
  });
}

function speechStopped(): string {
  return serverEvent('input_audio_buffer.speech_stopped', {
    item_id: 'speech-item',
    audio_end_ms: 1
  });
}

function timeoutTriggered(): string {
  return serverEvent('input_audio_buffer.timeout_triggered', {
    item_id: 'timeout-item',
    audio_start_ms: 0,
    audio_end_ms: 1
  });
}

function itemLifecycle(
  type: 'conversation.item.created' | 'conversation.item.added' | 'conversation.item.done',
  itemId: string,
  previousItemId: string | null
): string {
  return serverEvent(type, {
    previous_item_id: previousItemId,
    item: {
      id: itemId,
      object: 'realtime.item',
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [{ type: 'input_audio', transcript: null }]
    }
  });
}

function itemCreated(itemId: string, previousItemId: string | null): string {
  return itemLifecycle('conversation.item.created', itemId, previousItemId);
}

function itemAdded(itemId: string, previousItemId: string | null): string {
  return itemLifecycle('conversation.item.added', itemId, previousItemId);
}

function itemDone(itemId: string, previousItemId: string | null): string {
  return itemLifecycle('conversation.item.done', itemId, previousItemId);
}

function segment(itemId: string, segmentId = 'segment-1'): string {
  return serverEvent('conversation.item.input_audio_transcription.segment', {
    id: segmentId,
    item_id: itemId,
    content_index: 0,
    text: 'segment text',
    speaker: 'speaker-1',
    start: 0,
    end: 0.5
  });
}

function providerError(): string {
  return serverEvent('error', {
    error: {
      type: 'server_error',
      code: 'provider_error',
      message: 'provider detail',
      param: null,
      event_id: null
    }
  });
}

function makeSession(
  socket: FakeSocket,
  events: NormalizedTranscriptionEvent[],
  failures: unknown[] = [],
  options: Partial<ConstructorParameters<typeof AzureRealtimeTranscriptionAdapter>[0]> = {}
): TranscriptionSession {
  const factory: AzureRealtimeSocketFactory = () => socket;
  const adapter = new AzureRealtimeTranscriptionAdapter({
    endpoint: AZURE_ENDPOINT,
    deployment: 'transcribe-prod',
    tokenProvider: vi.fn(async () => ({
      token: 'test-token',
      expiresOnTimestamp: Date.now() + 60_000
    })),
    socketFactory: factory,
    ...options
  });
  return adapter.createSession({
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    configuration: {
      serverVadMode: 'disabled',
      languageMode: 'automatic',
      manualCommitCadenceMs: 600
    },
    onEvent: (event) => events.push(event),
    onFailure: (failure) => failures.push(failure)
  });
}

async function openSession(session: TranscriptionSession, socket: FakeSocket): Promise<void> {
  expect(session.start({ utteranceId: UTTERANCE_ID })).toEqual({ status: 'started' });
  await Promise.resolve();
  socket.open();
  expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: { input: { format: { type: 'audio/pcm', rate: 24000 } } }
    }
  });
  expect(JSON.parse(socket.sent[0] ?? '{}').session.audio.input.transcription)
    .not.toHaveProperty('language');
  socket.message(sessionCreated());
  socket.message(sessionUpdated());
}

function appendMessages(socket: FakeSocket): readonly Record<string, unknown>[] {
  return socket.sent
    .map((value) => JSON.parse(value) as Record<string, unknown>)
    .filter((value) => value.type === 'input_audio_buffer.append');
}

function providerBytes(socket: FakeSocket): Uint8Array {
  const values: number[] = [];
  for (const message of appendMessages(socket)) {
    const binary = atob(String(message.audio));
    for (let index = 0; index < binary.length; index += 1) {
      values.push(binary.charCodeAt(index));
    }
  }
  return Uint8Array.from(values);
}

function messageTypes(socket: FakeSocket): string[] {
  return socket.sent.map((value) => String((JSON.parse(value) as { type?: unknown }).type));
}

describe('AzureRealtimeTranscriptionAdapter', () => {
  it('accepts only the canonical public Azure OpenAI transcription websocket', () => {
    const socketFactory: AzureRealtimeSocketFactory = () => new FakeSocket();
    const tokenProvider = async () => ({
      token: 'test-token',
      expiresOnTimestamp: Date.now() + 60_000
    });
    expect(() => new AzureRealtimeTranscriptionAdapter({
      endpoint: AZURE_ENDPOINT,
      deployment: 'transcribe-prod',
      tokenProvider,
      socketFactory
    })).not.toThrow();

    for (const endpoint of [
      'https://resource.openai.azure.com/openai/v1/realtime?intent=transcription',
      'wss://user@resource.openai.azure.com/openai/v1/realtime?intent=transcription',
      'wss://resource.openai.azure.com:443/openai/v1/realtime?intent=transcription',
      'wss://resource.openai.azure.com/openai/v1/realtime/extra?intent=transcription',
      'wss://resource.openai.azure.com/openai/v1/realtime?intent=transcription&extra=1',
      'wss://resource.openai.azure.com/openai/v1/realtime?intent=transcription&intent=transcription',
      'wss://resource.openai.azure.com/openai/v1/realtime?intent=translation',
      'wss://resource.openai.azure.com.evil.test/openai/v1/realtime?intent=transcription',
      'wss://resource_openai.openai.azure.com/openai/v1/realtime?intent=transcription',
      'wss://RESOURCE.openai.azure.com/openai/v1/realtime?intent=transcription',
      `${AZURE_ENDPOINT}#fragment`
    ]) {
      let error: unknown;
      try {
        new AzureRealtimeTranscriptionAdapter({
          endpoint,
          deployment: 'transcribe-prod',
          tokenProvider,
          socketFactory
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain(endpoint);
    }
  });

  it('uses the GA bearer websocket and does not transmit a target-language hint', async () => {
    const socket = new FakeSocket();
    const tokenProvider = vi.fn(async () => ({
      token: 'bearer-secret',
      expiresOnTimestamp: Date.now() + 60_000
    }));
    let createdUrl = '';
    let createdHeaders: Readonly<Record<string, string>> = {};
    const adapter = new AzureRealtimeTranscriptionAdapter({
      endpoint: AZURE_ENDPOINT,
      deployment: 'transcribe-prod',
      tokenProvider,
      socketFactory: (url, headers) => {
        createdUrl = url;
        createdHeaders = headers;
        return socket;
      }
    });
    const session = adapter.createSession({
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      configuration: { serverVadMode: 'disabled', languageMode: 'automatic', manualCommitCadenceMs: 600 },
      onEvent: () => undefined,
      onFailure: () => undefined
    });

    session.start({ utteranceId: UTTERANCE_ID });
    await Promise.resolve();
    expect(createdUrl).toBe(AZURE_ENDPOINT);
    expect(createdHeaders).toEqual({ Authorization: 'Bearer bearer-secret' });
    expect(tokenProvider).toHaveBeenCalledOnce();
    socket.open();
    const update = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(update).not.toHaveProperty('language');
    expect(JSON.stringify(update)).not.toContain('selectedTargetLanguage');
  });

  it('prepends configuration ahead of audio queued before socket readiness', async () => {
    const socket = new FakeSocket();
    const session = makeSession(socket, []);
    session.start({ utteranceId: UTTERANCE_ID });
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(2)
    });
    await Promise.resolve();
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(messageTypes(socket)).toEqual(['session.update']);
    socket.message(sessionCreated());
    socket.message(sessionUpdated());
    expect(messageTypes(socket).slice(0, 2)).toEqual([
      'session.update',
      'input_audio_buffer.append'
    ]);
    session.close();
  });

  it('rejects audio after finalization is requested without changing state or sends', async () => {
    const socket = new FakeSocket();
    const session = makeSession(socket, []);
    await openSession(session, socket);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(2)
    });
    session.finalize(UTTERANCE_ID);
    const beforeState = session.state;
    const beforeSendCount = socket.sent.length;
    expect(() => session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 1,
      pcm: new Uint8Array(2)
    })).toThrowError(/finalization requested/i);
    expect(session.state).toEqual(beforeState);
    expect(socket.sent).toHaveLength(beforeSendCount);
    session.close();
  });

  it('waits for configured session.updated and commits exactly 14,400 provider samples per 9,600 original samples', async () => {
    const socket = new FakeSocket();
    const events: NormalizedTranscriptionEvent[] = [];
    const failures: unknown[] = [];
    const session = makeSession(socket, events, failures);
    await openSession(session, socket);

    const pcm = new Uint8Array(9_600 * 2);
    expect(session.pushAudio({ utteranceId: UTTERANCE_ID, originalSampleOffset: 0, pcm })).toMatchObject({
      acceptedSamples: 9_600,
      acceptedThroughOriginalSampleOffset: 9_600
    });
    expect(session.state).toMatchObject({ activeUtteranceId: UTTERANCE_ID });
    expect(failures).toEqual([]);
    expect(socket.sent.some((value) => JSON.parse(value).type === 'input_audio_buffer.commit')).toBe(false);

    expect(session.finalize(UTTERANCE_ID)).toEqual({ status: 'finalization-requested' });
    const appends = appendMessages(socket);
    const encodedBytes = appends.reduce((total, message) => total + atob(String(message.audio)).length, 0);
    expect(encodedBytes).toBe(14_400 * 2);
    expect(appends.every((message) => atob(String(message.audio)).length <= AZURE_REALTIME_TRANSCRIPTION_APPEND_MAX_BYTES)).toBe(true);
    const commits = socket.sent.filter((value) => JSON.parse(value).type === 'input_audio_buffer.commit');
    expect(commits).toHaveLength(1);

    socket.message(committed('item-1', null));
    socket.message(delta('item-1', 'hola mundo'));
    socket.message(completed('item-1', 'hola mundo'));
    expect(events.at(-1)).toMatchObject({
      type: 'transcript.final',
      text: 'hola mundo',
      acceptedThroughOriginalSampleOffset: 9_600,
      finalizationReason: 'explicit'
    });
    expect(() => session.finalize('not-a-uuid')).toThrowError(/canonical UUID/i);
    expect(session.finalize(UTTERANCE_ID)).toEqual({ status: 'already-finalized' });
    expect(session.close()).toEqual({ status: 'closed' });
    expect(session.state).toMatchObject({
      closed: true,
      acceptedThroughOriginalSampleOffset: 0
    });
    expect(session.state.activeUtteranceId).toBeUndefined();
  });

  it('produces byte-identical provider audio for arbitrary original-frame partitions', async () => {
    const oneShotSocket = new FakeSocket();
    const partitionedSocket = new FakeSocket();
    const oneShot = makeSession(oneShotSocket, []);
    const partitioned = makeSession(partitionedSocket, []);
    await openSession(oneShot, oneShotSocket);
    await openSession(partitioned, partitionedSocket);
    const samples = 20_003;
    const pcm = Uint8Array.from(
      { length: samples * 2 },
      (_, index) => (index * 17 + 29) % 256
    );
    oneShot.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm
    });
    const partitions = [1, 7, 113, 1_599, 2, 3_201, 17, 997];
    let sampleOffset = 0;
    let partitionIndex = 0;
    while (sampleOffset < samples) {
      const count = Math.min(
        partitions[partitionIndex % partitions.length] ?? 1,
        samples - sampleOffset
      );
      partitioned.pushAudio({
        utteranceId: UTTERANCE_ID,
        originalSampleOffset: sampleOffset,
        pcm: pcm.subarray(sampleOffset * 2, (sampleOffset + count) * 2)
      });
      sampleOffset += count;
      partitionIndex += 1;
    }
    oneShot.finalize(UTTERANCE_ID);
    partitioned.finalize(UTTERANCE_ID);
    expect(providerBytes(partitionedSocket)).toEqual(providerBytes(oneShotSocket));
    oneShot.close();
    partitioned.close();
  });

  it('admits the exact serialized queue bound and rejects one byte below it', async () => {
    const appendPayload = JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: 'AAA=',
      event_id: 'palancar-1'
    });
    const updatePayload = JSON.stringify({
      ...buildAzureRealtimeSessionUpdateMessage('transcribe-prod'),
      event_id: 'palancar-2'
    });
    const exactBytes = new TextEncoder().encode(appendPayload).byteLength +
      new TextEncoder().encode(updatePayload).byteLength;

    const exactSocket = new FakeSocket();
    const exactFailures: unknown[] = [];
    const exactSession = makeSession(exactSocket, [], exactFailures, { queueBytes: exactBytes });
    exactSession.start({ utteranceId: UTTERANCE_ID });
    exactSession.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(2)
    });
    await Promise.resolve();
    exactSocket.open();
    expect(exactFailures).toEqual([]);
    expect(messageTypes(exactSocket)).toEqual(['session.update']);
    exactSocket.message(sessionCreated());
    exactSocket.message(sessionUpdated());
    expect(messageTypes(exactSocket).slice(0, 2)).toEqual([
      'session.update',
      'input_audio_buffer.append'
    ]);
    exactSession.close();

    const belowSocket = new FakeSocket();
    const belowFailures: unknown[] = [];
    const belowSession = makeSession(belowSocket, [], belowFailures, {
      queueBytes: exactBytes - 1
    });
    belowSession.start({ utteranceId: UTTERANCE_ID });
    belowSession.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(2)
    });
    await Promise.resolve();
    belowSocket.open();
    expect(belowFailures).toMatchObject([{ reason: 'backpressure' }]);
    expect(belowSession.state.connectionState).toBe('failed');
  });

  it('reconstructs FIFO cumulative text, replaces provisional text authoritatively, and removes only two-token overlaps', async () => {
    const socket = new FakeSocket();
    const events: NormalizedTranscriptionEvent[] = [];
    const session = makeSession(socket, events);
    await openSession(session, socket);
    session.pushAudio({ utteranceId: UTTERANCE_ID, originalSampleOffset: 0, pcm: new Uint8Array(9_601 * 2) });
    session.finalize(UTTERANCE_ID);
    socket.message(committed('item-1', null));
    socket.message(committed('item-2', 'item-1'));
    socket.message(delta('item-1', 'hola mundo'));
    socket.message(completed('item-2', 'mundo final extra'));
    expect(events).toEqual([]);
    socket.message(completed('item-1', 'hola mundo final'));
    expect(events.at(-1)).toMatchObject({ type: 'transcript.final', text: 'hola mundo final extra' });
    expect(new Set(events.map((event) => event.segmentId)).size).toBe(1);
    expect(events.map((event) => event.revision)).toEqual(
      [...events].map((event) => event.revision).sort((left, right) => left - right)
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined]
  ] as const)('accepts a %s send callback and pumps the normal session queue', async (_label, completion) => {
    const socket = new FakeSocket();
    socket.autoCompleteSends = false;
    const session = makeSession(socket, []);
    session.start({ utteranceId: UTTERANCE_ID });
    await Promise.resolve();
    socket.open();
    expect(messageTypes(socket)).toEqual(['session.update']);
    expect(socket.pendingSendCallbacks).toHaveLength(1);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(2)
    });
    socket.message(sessionCreated());
    socket.message(sessionUpdated());
    expect(messageTypes(socket)).toEqual(['session.update']);
    socket.completeNextSend(completion);
    expect(messageTypes(socket)).toEqual([
      'session.update',
      'input_audio_buffer.append'
    ]);
    expect(socket.pendingSendCallbacks).toHaveLength(1);
    session.close();
    while (socket.pendingSendCallbacks.length > 0) socket.completeNextSend();
  });

  it('fails the production session closed when a send callback returns an Error', async () => {
    const socket = new FakeSocket();
    socket.autoCompleteSends = false;
    const failures: unknown[] = [];
    const session = makeSession(socket, [], failures);
    session.start({ utteranceId: UTTERANCE_ID });
    await Promise.resolve();
    socket.open();

    socket.completeNextSend(new Error('send failed'));

    expect(failures).toMatchObject([{ reason: 'socket' }]);
    expect(session.state.connectionState).toBe('failed');
  });

  it.each([false, 0, ''] as const)(
    'rejects a non-nullish falsey production send callback: %j',
    async (completion) => {
      const socket = new FakeSocket();
      socket.autoCompleteSends = false;
      const failures: unknown[] = [];
      const session = makeSession(socket, [], failures);
      session.start({ utteranceId: UTTERANCE_ID });
      await Promise.resolve();
      socket.open();

      socket.completeNextSend(completion as unknown as Error);

      expect(failures).toMatchObject([{ reason: 'socket' }]);
      expect(session.state.connectionState).toBe('failed');
    }
  );

  it('rejects a malicious acknowledgement for a commit still queued behind an unsent append', async () => {
    const socket = new FakeSocket();
    const failures: unknown[] = [];
    const session = makeSession(socket, [], failures);
    await openSession(session, socket);
    socket.autoCompleteSends = false;
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    session.finalize(UTTERANCE_ID);
    expect(socket.pendingSendCallbacks).toHaveLength(1);
    expect(messageTypes(socket)).not.toContain('input_audio_buffer.commit');

    socket.message(committed('malicious-item', null));

    expect(failures).toMatchObject([{ reason: 'protocol' }]);
    expect(session.state.connectionState).toBe('failed');
    while (socket.pendingSendCallbacks.length > 0) socket.completeNextSend();
  });

  it('rejects an acknowledgement while the exact commit send callback is still pending', async () => {
    const socket = new FakeSocket();
    const failures: unknown[] = [];
    const session = makeSession(socket, [], failures);
    await openSession(session, socket);
    socket.autoCompleteSends = false;
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    session.finalize(UTTERANCE_ID);
    while (messageTypes(socket).at(-1) !== 'input_audio_buffer.commit') {
      socket.completeNextSend();
    }
    expect(socket.pendingSendCallbacks).toHaveLength(1);

    socket.message(committed('premature-item', null));

    expect(failures).toMatchObject([{ reason: 'protocol' }]);
    socket.completeNextSend();
  });

  it('does not make a stale successful commit callback ack-eligible after socket reuse', async () => {
    const socket = new FakeSocket();
    const failures: unknown[] = [];
    const session = makeSession(socket, [], failures);
    await openSession(session, socket);
    socket.autoCompleteSends = false;
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    session.finalize(UTTERANCE_ID);
    while (messageTypes(socket).at(-1) !== 'input_audio_buffer.commit') {
      socket.completeNextSend();
    }
    expect(session.cancel(UTTERANCE_ID)).toEqual({ status: 'cancelled' });

    socket.resetForReuse();
    session.start({ utteranceId: NEXT_UTTERANCE_ID });
    await Promise.resolve();
    socket.open();
    socket.message(sessionCreated());
    socket.message(sessionUpdated());
    socket.completeNextSend();
    socket.message(committed('stale-item', null));

    expect(failures).toMatchObject([{ reason: 'protocol' }]);
    while (socket.pendingSendCallbacks.length > 0) socket.completeNextSend();
  });

  it.each([
    ['rate-limit update', rateLimitsUpdated],
    ['commit acknowledgement', () => committed('item-before-config', null)],
    ['clear acknowledgement', cleared],
    ['speech started', speechStarted],
    ['speech stopped', speechStopped],
    ['timeout', timeoutTriggered],
    ['conversation item', () => itemCreated('item-before-config', null)],
    ['conversation item added', () => itemAdded('item-before-config', null)],
    ['conversation item done', () => itemDone('item-before-config', null)],
    ['transcription delta', () => delta('item-before-config', 'premature')],
    ['transcription completion', () => completed('item-before-config', 'premature')],
    ['transcription segment', () => segment('item-before-config')],
    ['transcription failure', () => transcriptionFailed('item-before-config')],
    ['provider error', providerError]
  ])('rejects a %s before the configured handshake', async (_label, eventFactory) => {
    const socket = new FakeSocket();
    const failures: unknown[] = [];
    const session = makeSession(socket, [], failures);
    session.start({ utteranceId: UTTERANCE_ID });
    await Promise.resolve();
    socket.open();

    socket.message(eventFactory());

    expect(failures).toMatchObject([{ reason: 'protocol' }]);
    expect(session.state.connectionState).toBe('failed');
  });

  it('rejects session.created before socket open and rejects an exact duplicate', async () => {
    const preOpenSocket = new FakeSocket();
    const preOpenFailures: unknown[] = [];
    const preOpenSession = makeSession(preOpenSocket, [], preOpenFailures);
    preOpenSession.start({ utteranceId: UTTERANCE_ID });
    await Promise.resolve();
    preOpenSocket.message(sessionCreated());
    expect(preOpenFailures).toMatchObject([{ reason: 'protocol' }]);

    const duplicateSocket = new FakeSocket();
    const duplicateFailures: unknown[] = [];
    const duplicateSession = makeSession(duplicateSocket, [], duplicateFailures);
    duplicateSession.start({ utteranceId: UTTERANCE_ID });
    await Promise.resolve();
    duplicateSocket.open();
    duplicateSocket.message(sessionCreated());
    expect(duplicateFailures).toEqual([]);
    duplicateSocket.message(sessionCreated());
    expect(duplicateFailures).toMatchObject([{ reason: 'protocol' }]);
  });

  it.each([
    ['session.created', sessionCreated, 'protocol'],
    ['session.updated', sessionUpdated, 'configuration'],
    ['rate_limits.updated', rateLimitsUpdated, undefined],
    ['input_audio_buffer.committed', () => committed('missing-item', null), 'protocol'],
    ['input_audio_buffer.cleared', cleared, 'protocol'],
    ['input_audio_buffer.speech_started', speechStarted, 'protocol'],
    ['input_audio_buffer.speech_stopped', speechStopped, 'protocol'],
    ['input_audio_buffer.timeout_triggered', timeoutTriggered, 'protocol'],
    ['conversation.item.created', () => itemCreated('missing-item', null), 'protocol'],
    ['conversation.item.added', () => itemAdded('missing-item', null), 'protocol'],
    ['conversation.item.done', () => itemDone('missing-item', null), 'protocol'],
    ['transcription.delta', () => delta('missing-item', 'missing'), 'protocol'],
    ['transcription.completed', () => completed('missing-item', 'missing'), 'protocol'],
    ['transcription.segment', () => segment('missing-item'), 'protocol'],
    ['transcription.failed', () => transcriptionFailed('missing-item'), 'protocol'],
    ['error', providerError, 'protocol']
  ] as const)(
    'applies the configured-state lifecycle matrix for %s',
    async (_label, eventFactory, expectedFailure) => {
      const socket = new FakeSocket();
      const failures: Array<{ reason?: string }> = [];
      const session = makeSession(socket, [], failures);
      await openSession(session, socket);

      socket.message(eventFactory());

      if (expectedFailure === undefined) {
        expect(failures).toEqual([]);
        expect(session.state.connectionState).toBe('ready');
        session.close();
      } else {
        expect(failures).toMatchObject([{ reason: expectedFailure }]);
        expect(session.state.connectionState).toBe('failed');
      }
    }
  );

  it('accepts known item companions once and validates provider failures against known items', async () => {
    const companionSocket = new FakeSocket();
    const companionFailures: unknown[] = [];
    const companionSession = makeSession(companionSocket, [], companionFailures);
    await openSession(companionSession, companionSocket);
    companionSession.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    companionSession.finalize(UTTERANCE_ID);
    companionSocket.message(committed('item-1', null));
    companionSocket.message(itemCreated('item-1', null));
    companionSocket.message(itemDone('item-1', null));
    companionSocket.message(segment('item-1'));
    expect(companionFailures).toEqual([]);
    companionSocket.message(segment('item-1'));
    expect(companionFailures).toMatchObject([{ reason: 'protocol' }]);

    const duplicateSocket = new FakeSocket();
    const duplicateFailures: unknown[] = [];
    const duplicateSession = makeSession(duplicateSocket, [], duplicateFailures);
    await openSession(duplicateSession, duplicateSocket);
    duplicateSession.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    duplicateSession.finalize(UTTERANCE_ID);
    duplicateSocket.message(committed('item-1', null));
    duplicateSocket.message(itemCreated('item-1', null));
    duplicateSocket.message(itemCreated('item-1', null));
    expect(duplicateFailures).toMatchObject([{ reason: 'protocol' }]);

    const failureSocket = new FakeSocket();
    const providerFailures: unknown[] = [];
    const failureSession = makeSession(failureSocket, [], providerFailures);
    await openSession(failureSession, failureSocket);
    failureSession.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    failureSession.finalize(UTTERANCE_ID);
    failureSocket.message(committed('item-1', null));
    failureSocket.message(transcriptionFailed('item-1'));
    expect(providerFailures).toMatchObject([{ reason: 'provider' }]);
  });

  it('accepts the observed GA added/done sequence without emitting lifecycle output', async () => {
    const socket = new FakeSocket();
    const events: NormalizedTranscriptionEvent[] = [];
    const failures: unknown[] = [];
    const session = makeSession(socket, events, failures);
    await openSession(session, socket);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    session.finalize(UTTERANCE_ID);

    socket.message(committed('item-1', null));
    socket.message(itemAdded('item-1', null));
    socket.message(itemDone('item-1', null));
    expect(events).toEqual([]);
    expect(failures).toEqual([]);

    socket.message(delta('item-1', 'hola mundo'));
    socket.message(completed('item-1', 'hola mundo'));
    expect(failures).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: 'transcript.final',
      text: 'hola mundo'
    });
  });

  it('allows transcription deltas before an optional item done acknowledgement', async () => {
    const socket = new FakeSocket();
    const events: NormalizedTranscriptionEvent[] = [];
    const failures: unknown[] = [];
    const session = makeSession(socket, events, failures);
    await openSession(session, socket);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    session.finalize(UTTERANCE_ID);
    socket.message(committed('item-1', null));
    socket.message(itemAdded('item-1', null));
    socket.message(delta('item-1', 'hola'));
    socket.message(itemDone('item-1', null));
    socket.message(completed('item-1', 'hola mundo'));

    expect(failures).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: 'transcript.final',
      text: 'hola mundo'
    });
  });

  it('accepts item done after transcription completion while later items remain active', async () => {
    const socket = new FakeSocket();
    const events: NormalizedTranscriptionEvent[] = [];
    const failures: unknown[] = [];
    const session = makeSession(socket, events, failures);
    await openSession(session, socket);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_601 * 2)
    });
    session.finalize(UTTERANCE_ID);
    socket.message(committed('item-1', null));
    socket.message(committed('item-2', 'item-1'));
    socket.message(itemAdded('item-1', null));
    socket.message(itemAdded('item-2', 'item-1'));
    socket.message(completed('item-1', 'hola'));
    socket.message(itemDone('item-1', null));
    socket.message(itemDone('item-2', 'item-1'));
    socket.message(completed('item-2', 'mundo'));

    expect(failures).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: 'transcript.final',
      text: 'hola mundo'
    });
  });

  it.each([
    ['done before creation', (socket: FakeSocket) => {
      socket.message(itemDone('item-1', null));
    }],
    ['duplicate added', (socket: FakeSocket) => {
      socket.message(itemAdded('item-1', null));
      socket.message(itemAdded('item-1', null));
    }],
    ['created after added', (socket: FakeSocket) => {
      socket.message(itemAdded('item-1', null));
      socket.message(itemCreated('item-1', null));
    }],
    ['duplicate done', (socket: FakeSocket) => {
      socket.message(itemAdded('item-1', null));
      socket.message(itemDone('item-1', null));
      socket.message(itemDone('item-1', null));
    }],
    ['unknown done item', (socket: FakeSocket) => {
      socket.message(itemDone('unknown-item', null));
    }],
    ['wrong added predecessor', (socket: FakeSocket) => {
      socket.message(itemAdded('item-1', 'wrong-item'));
    }],
    ['wrong done predecessor', (socket: FakeSocket) => {
      socket.message(itemAdded('item-1', null));
      socket.message(itemDone('item-1', 'wrong-item'));
    }]
  ] as const)('rejects %s lifecycle events', async (_label, sendLifecycle) => {
    const socket = new FakeSocket();
    const failures: unknown[] = [];
    const session = makeSession(socket, [], failures);
    await openSession(session, socket);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    session.finalize(UTTERANCE_ID);
    socket.message(committed('item-1', null));

    sendLifecycle(socket);

    expect(failures).toMatchObject([{ reason: 'protocol' }]);
    expect(session.state.connectionState).toBe('failed');
  });

  it('accepts correlated cross-item lifecycle interleavings', async () => {
    const socket = new FakeSocket();
    const failures: unknown[] = [];
    const session = makeSession(socket, [], failures);
    await openSession(session, socket);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_601 * 2)
    });
    session.finalize(UTTERANCE_ID);
    socket.message(committed('item-1', null));
    socket.message(committed('item-2', 'item-1'));
    socket.message(itemAdded('item-2', 'item-1'));
    socket.message(itemAdded('item-1', null));
    socket.message(itemDone('item-2', 'item-1'));
    socket.message(itemDone('item-1', null));

    expect(failures).toEqual([]);
    expect(session.state.connectionState).toBe('finalizing');
    session.close();
  });

  it('rejects configuration and lifecycle events in invalid protocol states', async () => {
    const earlySocket = new FakeSocket();
    const earlyFailures: unknown[] = [];
    const earlySession = makeSession(earlySocket, [], earlyFailures);
    earlySession.start({ utteranceId: UTTERANCE_ID });
    await Promise.resolve();
    earlySocket.message(sessionUpdated());
    expect(earlyFailures).toMatchObject([{ reason: 'configuration' }]);

    const lateSocket = new FakeSocket();
    const lateFailures: unknown[] = [];
    const lateSession = makeSession(lateSocket, [], lateFailures);
    await openSession(lateSession, lateSocket);
    lateSocket.message(sessionCreated());
    expect(lateFailures).toMatchObject([{ reason: 'protocol' }]);

    const mismatchSocket = new FakeSocket();
    const mismatchFailures: unknown[] = [];
    const mismatchSession = makeSession(mismatchSocket, [], mismatchFailures);
    mismatchSession.start({ utteranceId: UTTERANCE_ID });
    await Promise.resolve();
    mismatchSocket.open();
    mismatchSocket.message(sessionCreated());
    mismatchSocket.message(sessionUpdated('different-provider-session'));
    expect(mismatchFailures).toMatchObject([{ reason: 'configuration' }]);
  });

  it('rejects an extra commit acknowledgement after all successfully sent commits are consumed', async () => {
    const socket = new FakeSocket();
    const failures: unknown[] = [];
    const session = makeSession(socket, [], failures);
    await openSession(session, socket);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    session.finalize(UTTERANCE_ID);
    socket.message(committed('item-1', null));
    socket.message(committed('item-2', 'item-1'));
    expect(failures).toMatchObject([{ reason: 'protocol' }]);
  });

  it.each([
    ['duplicate', 'item-1', 'item-1'],
    ['broken predecessor', 'item-2', 'unexpected-item']
  ])('fails closed on a %s commit acknowledgement', async (_label, itemId, previousItemId) => {
    const socket = new FakeSocket();
    const failures: unknown[] = [];
    const session = makeSession(socket, [], failures);
    await openSession(session, socket);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_601 * 2)
    });
    session.finalize(UTTERANCE_ID);
    socket.message(committed('item-1', null));
    socket.message(committed(itemId, previousItemId));
    expect(failures).toMatchObject([{ reason: 'protocol' }]);
    expect(session.state.connectionState).toBe('failed');
  });

  it('ignores old send callbacks when the socket object is reused by a fresh utterance', async () => {
    const socket = new FakeSocket();
    socket.autoCompleteSends = false;
    const failures: unknown[] = [];
    const session = makeSession(socket, [], failures);
    session.start({ utteranceId: UTTERANCE_ID });
    await Promise.resolve();
    socket.open();
    expect(socket.pendingSendCallbacks).toHaveLength(1);
    session.cancel(UTTERANCE_ID);

    socket.resetForReuse();
    session.start({ utteranceId: NEXT_UTTERANCE_ID });
    await Promise.resolve();
    socket.open();
    expect(messageTypes(socket)).toEqual(['session.update', 'session.update']);
    expect(socket.pendingSendCallbacks).toHaveLength(2);
    session.pushAudio({
      utteranceId: NEXT_UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(2)
    });
    socket.message(sessionCreated());
    socket.message(sessionUpdated());
    socket.completeNextSend();
    expect(messageTypes(socket)).toEqual(['session.update', 'session.update']);
    socket.completeNextSend();
    expect(messageTypes(socket)).toEqual([
      'session.update',
      'session.update',
      'input_audio_buffer.append'
    ]);
    expect(failures).toEqual([]);
    session.close();
    while (socket.pendingSendCallbacks.length > 0) socket.completeNextSend();
    expect(failures).toEqual([]);
  });

  it('cancels during connection, configuration, and completion without late output', async () => {
    const connectingSocket = new FakeSocket();
    const connectingSession = makeSession(connectingSocket, []);
    connectingSession.start({ utteranceId: UTTERANCE_ID });
    await Promise.resolve();
    connectingSession.cancel(UTTERANCE_ID);
    connectingSocket.open();
    expect(connectingSocket.sent).toEqual([]);

    const configuringSocket = new FakeSocket();
    const configuringEvents: NormalizedTranscriptionEvent[] = [];
    const configuringSession = makeSession(configuringSocket, configuringEvents);
    configuringSession.start({ utteranceId: UTTERANCE_ID });
    await Promise.resolve();
    configuringSocket.open();
    configuringSession.cancel(UTTERANCE_ID);
    configuringSocket.message(sessionUpdated());
    expect(configuringEvents).toEqual([]);

    const completionSocket = new FakeSocket();
    const completionEvents: NormalizedTranscriptionEvent[] = [];
    const completionSession = makeSession(completionSocket, completionEvents);
    await openSession(completionSession, completionSocket);
    completionSession.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(2)
    });
    completionSession.finalize(UTTERANCE_ID);
    completionSocket.message(committed('item-1', null));
    completionSession.cancel(UTTERANCE_ID);
    completionSocket.message(completed('item-1', 'late transcript'));
    expect(completionEvents).toEqual([]);
  });

  it('validates cancellation IDs before terminal responses and clears cancelled state', async () => {
    const socket = new FakeSocket();
    const session = makeSession(socket, []);
    await openSession(session, socket);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(2)
    });
    expect(() => session.cancel(NEXT_UTTERANCE_ID)).toThrowError(/matching active utterance/i);
    expect(() => session.cancel('not-a-uuid')).toThrowError(/canonical UUID/i);

    expect(session.cancel(UTTERANCE_ID)).toEqual({ status: 'cancelled' });
    expect(session.state).toMatchObject({
      connectionState: 'closed',
      finalizationRequested: false,
      acceptedThroughOriginalSampleOffset: 0
    });
    expect(session.state.activeUtteranceId).toBeUndefined();
    expect(session.cancel(UTTERANCE_ID)).toEqual({ status: 'already-cancelled' });
    expect(() => session.cancel(NEXT_UTTERANCE_ID)).toThrowError(/matching active utterance/i);
  });

  it('returns already-finalized only for the exact terminal utterance ID', async () => {
    const socket = new FakeSocket();
    const session = makeSession(socket, []);
    await openSession(session, socket);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    session.finalize(UTTERANCE_ID);
    socket.message(committed('item-1', null));
    socket.message(completed('item-1', 'finished text'));

    expect(session.cancel(UTTERANCE_ID)).toEqual({ status: 'already-finalized' });
    expect(() => session.cancel(NEXT_UTTERANCE_ID)).toThrowError(/matching active utterance/i);
  });

  it('fails closed on post-final stale server events without restoring content or connection state', async () => {
    const socket = new FakeSocket();
    const events: NormalizedTranscriptionEvent[] = [];
    const failures: unknown[] = [];
    const session = makeSession(socket, events, failures);
    await openSession(session, socket);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    session.finalize(UTTERANCE_ID);
    socket.message(committed('item-1', null));
    socket.message(completed('item-1', 'terminal text'));
    const finalEvents = [...events];

    socket.message(rateLimitsUpdated());
    socket.message(completed('item-1', 'malicious replacement'));
    socket.message(sessionCreated());

    expect(events).toEqual(finalEvents);
    expect(failures).toEqual([]);
    expect(session.state).toMatchObject({
      connectionState: 'idle',
      acceptedThroughOriginalSampleOffset: 0
    });
    expect(session.state.activeUtteranceId).toBeUndefined();
  });

  it('uses the injected Date-or-epoch clock for deterministic emitted event times', async () => {
    const socket = new FakeSocket();
    const events: NormalizedTranscriptionEvent[] = [];
    const values: Array<Date | number> = [
      new Date('2031-02-03T04:05:06.007Z'),
      Date.parse('2031-02-03T04:05:07.008Z')
    ];
    const session = makeSession(socket, events, [], {
      clock: () => values.shift() ?? Date.parse('2031-02-03T04:05:08.009Z')
    });
    await openSession(session, socket);
    session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    });
    session.finalize(UTTERANCE_ID);
    socket.message(committed('item-1', null));
    socket.message(completed('item-1', 'deterministic time'));

    expect(events.map((event) => event.providerEventTime)).toEqual([
      '2031-02-03T04:05:06.007Z',
      '2031-02-03T04:05:07.008Z'
    ]);
  });

  it('fails closed with a content-free failure and invalidates late socket callbacks', async () => {
    const socket = new FakeSocket();
    const events: NormalizedTranscriptionEvent[] = [];
    const failures: unknown[] = [];
    const session = makeSession(socket, events, failures);
    await openSession(session, socket);
    session.pushAudio({ utteranceId: UTTERANCE_ID, originalSampleOffset: 0, pcm: new Uint8Array(2) });
    const epoch = session.state.audioStateEpoch;
    socket.error();
    expect(failures).toEqual([{ reason: 'socket', audioStateEpoch: epoch }]);
    expect(session.state.connectionState).toBe('failed');
    socket.message(sessionUpdated());
    expect(events).toHaveLength(0);
    expect(JSON.stringify(failures)).not.toContain('test-token');
  });

  it('rejects queued content at the exact byte bound and shuts down the utterance', async () => {
    const socket = new FakeSocket();
    const failures: unknown[] = [];
    const session = makeSession(socket, [], failures, { queueBytes: 4_000 });
    await openSession(session, socket);
    expect(() => session.pushAudio({
      utteranceId: UTTERANCE_ID,
      originalSampleOffset: 0,
      pcm: new Uint8Array(9_600 * 2)
    })).toThrowError(/backpressure/i);
    expect(failures).toMatchObject([{ reason: 'backpressure' }]);
    expect(session.state.connectionState).toBe('failed');
  });

  it('sends a best-effort clear for an open uncommitted buffer and ignores stale token completion', async () => {
    const socket = new FakeSocket();
    let resolveToken: ((value: { token: string; expiresOnTimestamp: number }) => void) | undefined;
    const adapter = new AzureRealtimeTranscriptionAdapter({
      endpoint: AZURE_ENDPOINT,
      deployment: 'transcribe-prod',
      tokenProvider: () => new Promise((resolve) => { resolveToken = resolve; }),
      socketFactory: () => socket
    });
    const failures: unknown[] = [];
    const session = adapter.createSession({
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      configuration: { serverVadMode: 'disabled', languageMode: 'automatic', manualCommitCadenceMs: 600 },
      onEvent: () => undefined,
      onFailure: (failure) => failures.push(failure)
    });
    session.start({ utteranceId: UTTERANCE_ID });
    expect(session.cancel(UTTERANCE_ID)).toEqual({ status: 'cancelled' });
    resolveToken?.({ token: 'late', expiresOnTimestamp: Date.now() + 60_000 });
    await Promise.resolve();
    expect(socket.sent).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('accepts a null readiness send callback and waits for configured session.updated', async () => {
    const socket = new FakeSocket();
    const adapter = new AzureRealtimeTranscriptionAdapter({
      endpoint: AZURE_ENDPOINT,
      deployment: 'transcribe-prod',
      tokenProvider: async () => ({
        token: 'readiness-token',
        expiresOnTimestamp: Date.now() + 60_000
      }),
      socketFactory: () => socket
    });
    const resultPromise = adapter.checkReadiness();
    const settled = vi.fn();
    void resultPromise.then(settled);
    await Promise.resolve();
    socket.open();
    expect(messageTypes(socket)).toEqual(['session.update']);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    socket.message(sessionCreated());
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    socket.message(sessionUpdated());
    await expect(resultPromise).resolves.toEqual({
      ready: true,
      provider: 'azure-realtime',
      model: 'transcribe-prod'
    });
    expect(socket.readyState).toBe(3);
  });

  it('accepts an undefined readiness send callback', async () => {
    const socket = new FakeSocket();
    socket.autoCompleteSends = false;
    const adapter = new AzureRealtimeTranscriptionAdapter({
      endpoint: AZURE_ENDPOINT,
      deployment: 'transcribe-prod',
      tokenProvider: async () => ({
        token: 'readiness-token',
        expiresOnTimestamp: Date.now() + 60_000
      }),
      socketFactory: () => socket
    });
    const resultPromise = adapter.checkReadiness();
    await Promise.resolve();
    socket.open();
    expect(socket.pendingSendCallbacks).toHaveLength(1);

    socket.completeNextSend(undefined);
    socket.message(sessionCreated());
    socket.message(sessionUpdated());

    await expect(resultPromise).resolves.toMatchObject({ ready: true });
  });

  it('fails readiness closed when the send callback returns an Error', async () => {
    const socket = new FakeSocket();
    socket.autoCompleteSends = false;
    const adapter = new AzureRealtimeTranscriptionAdapter({
      endpoint: AZURE_ENDPOINT,
      deployment: 'transcribe-prod',
      tokenProvider: async () => ({
        token: 'readiness-token',
        expiresOnTimestamp: Date.now() + 60_000
      }),
      socketFactory: () => socket
    });
    const resultPromise = adapter.checkReadiness();
    await Promise.resolve();
    socket.open();

    socket.completeNextSend(new Error('send failed'));

    await expect(resultPromise).resolves.toMatchObject({ ready: false });
    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(1);
  });

  it.each([false, 0, ''] as const)(
    'rejects a non-nullish falsey readiness send callback: %j',
    async (completion) => {
      const socket = new FakeSocket();
      socket.autoCompleteSends = false;
      const adapter = new AzureRealtimeTranscriptionAdapter({
        endpoint: AZURE_ENDPOINT,
        deployment: 'transcribe-prod',
        tokenProvider: async () => ({
          token: 'readiness-token',
          expiresOnTimestamp: Date.now() + 60_000
        }),
        socketFactory: () => socket
      });
      const resultPromise = adapter.checkReadiness();
      await Promise.resolve();
      socket.open();

      socket.completeNextSend(completion as unknown as Error);

      await expect(resultPromise).resolves.toMatchObject({ ready: false });
    }
  );

  it('fails readiness before token or socket work for an already-aborted signal', async () => {
    const tokenProvider = vi.fn(async () => ({
      token: 'must-not-be-read',
      expiresOnTimestamp: Date.now() + 60_000
    }));
    const socketFactory = vi.fn(() => new FakeSocket());
    const adapter = new AzureRealtimeTranscriptionAdapter({
      endpoint: AZURE_ENDPOINT,
      deployment: 'transcribe-prod',
      tokenProvider,
      socketFactory
    });
    const controller = new AbortController();
    controller.abort('readiness-canary');

    await expect(adapter.checkReadiness(controller.signal)).resolves.toMatchObject({ ready: false });
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it('caller cancellation closes and terminates an active readiness socket', async () => {
    const socket = new FakeSocket();
    const adapter = new AzureRealtimeTranscriptionAdapter({
      endpoint: AZURE_ENDPOINT,
      deployment: 'transcribe-prod',
      tokenProvider: async () => ({
        token: 'readiness-cancellation-secret',
        expiresOnTimestamp: Date.now() + 60_000
      }),
      socketFactory: () => socket
    });
    const controller = new AbortController();
    const result = adapter.checkReadiness(controller.signal);
    await Promise.resolve();

    controller.abort('caller-cancellation-canary');

    await expect(result).resolves.toMatchObject({ ready: false });
    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(1);
    expect(socket.readyState).toBe(3);
  });

  it('closes a socket returned after synchronous cancellation inside the factory', async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const adapter = new AzureRealtimeTranscriptionAdapter({
      endpoint: AZURE_ENDPOINT,
      deployment: 'transcribe-prod',
      tokenProvider: async () => ({
        token: 'factory-cancellation-secret',
        expiresOnTimestamp: Date.now() + 60_000
      }),
      socketFactory: () => {
        controller.abort();
        return socket;
      }
    });

    await expect(adapter.checkReadiness(controller.signal)).resolves.toMatchObject({ ready: false });
    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(1);
  });

  it('settles once and removes listeners when socket registration is reentrant', async () => {
    const socket = new ReentrantReadySocket();
    const adapter = new AzureRealtimeTranscriptionAdapter({
      endpoint: AZURE_ENDPOINT,
      deployment: 'transcribe-prod',
      tokenProvider: async () => ({
        token: 'reentrant-readiness-secret',
        expiresOnTimestamp: Date.now() + 60_000
      }),
      socketFactory: () => socket
    });

    await expect(adapter.checkReadiness()).resolves.toMatchObject({ ready: true });
    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(1);
    for (const event of ['open', 'message', 'error', 'close'] as const) {
      expect(socket.listenerCount(event)).toBe(0);
    }
  });

  it('closes and terminates exactly once when timeout fires during reentrant registration', async () => {
    vi.useFakeTimers();
    try {
      const socket = new ReentrantTimeoutSocket(() => vi.advanceTimersByTime(5_000));
      const adapter = new AzureRealtimeTranscriptionAdapter({
        endpoint: AZURE_ENDPOINT,
        deployment: 'transcribe-prod',
        tokenProvider: async () => ({
          token: 'reentrant-timeout-secret',
          expiresOnTimestamp: Date.now() + 60_000
        }),
        socketFactory: () => socket,
        readyTimeoutMs: 5_000
      });

      await expect(adapter.checkReadiness()).resolves.toMatchObject({ ready: false });
      expect(socket.closeCalls).toBe(1);
      expect(socket.terminateCalls).toBe(1);
      for (const event of ['open', 'message', 'error', 'close'] as const) {
        expect(socket.listenerCount(event)).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails readiness closed on token, connect, and configuration timeouts without details', async () => {
    const tokenFailure = new AzureRealtimeTranscriptionAdapter({
      endpoint: AZURE_ENDPOINT,
      deployment: 'transcribe-prod',
      tokenProvider: async () => { throw new Error('secret provider detail'); },
      socketFactory: () => new FakeSocket()
    });
    const tokenResult = await tokenFailure.checkReadiness();
    expect(tokenResult).toEqual({
      ready: false,
      provider: 'azure-realtime',
      model: 'transcribe-prod'
    });
    expect(JSON.stringify(tokenResult)).not.toContain('secret provider detail');

    vi.useFakeTimers();
    try {
      const connectSocket = new FakeSocket();
      const connectProbe = new AzureRealtimeTranscriptionAdapter({
        endpoint: AZURE_ENDPOINT,
        deployment: 'transcribe-prod',
        tokenProvider: async () => ({
          token: 'connect-secret',
          expiresOnTimestamp: Date.now() + 60_000
        }),
        socketFactory: () => connectSocket,
        readyTimeoutMs: 5_000
      });
      const connectResultPromise = connectProbe.checkReadiness();
      await Promise.resolve();
      vi.advanceTimersByTime(5_000);
      await expect(connectResultPromise).resolves.toMatchObject({ ready: false });
      expect(connectSocket.closeCalls).toBe(1);
      expect(connectSocket.terminateCalls).toBe(1);

      const configSocket = new FakeSocket();
      const configProbe = new AzureRealtimeTranscriptionAdapter({
        endpoint: AZURE_ENDPOINT,
        deployment: 'transcribe-prod',
        tokenProvider: async () => ({
          token: 'config-secret',
          expiresOnTimestamp: Date.now() + 60_000
        }),
        socketFactory: () => configSocket,
        readyTimeoutMs: 5_000
      });
      const configResultPromise = configProbe.checkReadiness();
      await Promise.resolve();
      configSocket.open();
      expect(messageTypes(configSocket)).toEqual(['session.update']);
      vi.advanceTimersByTime(5_000);
      const configResult = await configResultPromise;
      expect(configResult).toMatchObject({ ready: false });
      expect(JSON.stringify(configResult)).not.toContain('config-secret');
      expect(configSocket.closeCalls).toBe(1);
      expect(configSocket.terminateCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out finalization without fabricating a final transcript', async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const failures: unknown[] = [];
      const session = makeSession(socket, [], failures, { finalizationTimeoutMs: 10_000 });
      await openSession(session, socket);
      session.pushAudio({ utteranceId: UTTERANCE_ID, originalSampleOffset: 0, pcm: new Uint8Array(2) });
      session.finalize(UTTERANCE_ID);
      vi.advanceTimersByTime(10_000);
      expect(failures).toMatchObject([{ reason: 'finalization-timeout' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
