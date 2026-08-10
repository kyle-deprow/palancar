import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_NEGOTIATED_LIMITS,
  WEBSOCKET_SUBPROTOCOL,
  WEBSOCKET_TICKET_PREFIX,
  createWebSocketSubprotocols,
  encodeAudioFrame
} from '@palancar/contracts';
import { LANGUAGE_REGISTRY_VERSION } from '@palancar/language-registry';
import { DeterministicMockProvider, GenerationService } from '@palancar/generation';
import {
  DETERMINISTIC_MOCK_CAPABILITIES,
  type NormalizedTranscriptionEvent,
  type TranscriptionAdapter,
  type TranscriptionSession
} from '@palancar/transcription';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import {
  DevelopmentTicketStore,
  createRelayHost,
  type RelayHost,
  type RelayUpgradeAudience
} from '../src/index.js';

const ORIGIN = 'wss://127.0.0.1';
const ENVIRONMENT = 'relay-host-test';
const GATE_POLICY_VERSION = '1.0.0';
const UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';
const CANARY = 'relay-host-canary-ticket-body-provider-error';
const CONFIG_CANARY = 'relay-host-config-canary-invalid-origin';
const RELAY_MAIN_PATH = fileURLToPath(new URL('../dist/main.js', import.meta.url));

interface JsonObject {
  readonly [key: string]: unknown;
}

function asObject(value: unknown): JsonObject {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  return value as JsonObject;
}

async function responseJson(response: Response): Promise<JsonObject> {
  return asObject(await response.json());
}

function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return Buffer.concat(data).toString('utf8');
}

function nextMessage(
  socket: WebSocket,
  predicate: (message: JsonObject) => boolean,
  timeoutMs = 5_000
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener('message', onMessage);
      reject(new Error('timed out waiting for relay message'));
    }, timeoutMs);
    const onMessage = (data: RawData): void => {
      let message: JsonObject;
      try {
        message = asObject(JSON.parse(rawDataText(data)) as unknown);
      } catch {
        return;
      }
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve(1000);
  }
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

function waitForUnexpectedResponse(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    socket.once('unexpected-response', (_request, response) => {
      settled = true;
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => {
      if (!settled) {
        settled = true;
        socket.close();
        reject(new Error('unexpected WebSocket acceptance'));
      }
    });
    socket.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function waitForCloseOrUnexpectedResponse(
  socket: WebSocket
): Promise<'close' | 'unexpected-response'> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finishReject(new Error('timed out waiting for upgrade rejection'));
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeListener('close', onClose);
      socket.removeListener('unexpected-response', onUnexpectedResponse);
      socket.removeListener('open', onOpen);
    };
    const finishResolve = (result: 'close' | 'unexpected-response'): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const finishReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onClose = (): void => finishResolve('close');
    const onUnexpectedResponse = (_request: unknown, response: { resume(): void }): void => {
      response.resume();
      finishResolve('unexpected-response');
    };
    const onOpen = (): void => {
      socket.close();
      finishReject(new Error('unexpected WebSocket acceptance'));
    };
    socket.once('close', onClose);
    socket.once('unexpected-response', onUnexpectedResponse);
    socket.once('open', onOpen);
  });
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise() };
}

class DelayedTicketStore extends DevelopmentTicketStore {
  readonly consumeStarted = createDeferred();
  readonly consumeRelease = createDeferred();

  override async consume(ticket: string, audience: RelayUpgradeAudience) {
    this.consumeStarted.resolve();
    await this.consumeRelease.promise;
    return super.consume(ticket, audience);
  }
}

function runRelayMain(env: NodeJS.ProcessEnv): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, [RELAY_MAIN_PATH], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function rawUpgradeStatus(port: number, protocolHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for upgrade rejection'));
    }, 5_000);
    socket.on('connect', () => {
      socket.write([
        'GET /v1/stream HTTP/1.1',
        'Host: 127.0.0.1',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGVzdC1yZWxheS1ob3N0LWtleQ==',
        `Sec-WebSocket-Protocol: ${protocolHeader}`,
        '',
        ''
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      const match = /^HTTP\/1\.1 (\d+)/.exec(response);
      if (match !== null) {
        clearTimeout(timer);
        socket.destroy();
        resolve(Number(match[1]));
      }
    });
    socket.on('error', (error) => {
      if (response === '') {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

function sessionStartText(): string {
  return JSON.stringify({
    type: 'session.start',
    protocolVersion: 1,
    wearerLanguage: 'en',
    targetLanguage: 'es',
    languageRegistryVersion: LANGUAGE_REGISTRY_VERSION,
    gatePolicyVersion: GATE_POLICY_VERSION,
    clientBuild: 'relay-host-test-1.0.0',
    requestedLimits: DEFAULT_NEGOTIATED_LIMITS
  });
}

function frame(sequence: number, offset: number, payload = new Uint8Array(3_200)): Uint8Array {
  return encodeAudioFrame({
    utteranceId: UTTERANCE_ID,
    sequence,
    offset,
    payload
  });
}

async function issueTicket(host: RelayHost, body: unknown = { protocolVersion: 1, intent: 'new' }): Promise<JsonObject> {
  const address = host.server.address();
  expect(address).not.toBeNull();
  expect(typeof address).toBe('object');
  const port = (address as { readonly port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/v1/session-tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(200);
  return responseJson(response);
}

async function openSocket(host: RelayHost, ticket: string, protocols?: readonly string[]): Promise<WebSocket> {
  const address = host.server.address();
  expect(address).not.toBeNull();
  const port = (address as { readonly port: number }).port;
  const offered = [...(protocols ?? createWebSocketSubprotocols(ticket))];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, offered);
  await waitForOpen(socket);
  return socket;
}

function audience(origin = ORIGIN): RelayUpgradeAudience {
  return {
    environment: ENVIRONMENT,
    origin,
    path: '/v1/stream',
    protocol: WEBSOCKET_SUBPROTOCOL
  };
}

function createAsyncCallbackAdapter(): TranscriptionAdapter {
  return {
    capabilities: DETERMINISTIC_MOCK_CAPABILITIES,
    createSession(input): TranscriptionSession {
      let closed = false;
      const session: TranscriptionSession = {
        capabilities: DETERMINISTIC_MOCK_CAPABILITIES,
        configuration: input.configuration,
        state: {
          closed: false,
          acceptedThroughOriginalSampleOffset: 0,
          audioStateEpoch: 0
        },
        deliveryFailures: { failureCount: 0 },
        start: ({ utteranceId }) => {
          setTimeout(() => {
            if (!closed) {
              const event: NormalizedTranscriptionEvent = {
                type: 'transcript.partial',
                sessionId: input.sessionId,
                sessionEpoch: input.sessionEpoch,
                utteranceId,
                segmentId: `${utteranceId}:0`,
                revision: 1,
                text: 'asynchronous partial',
                providerEventTime: '2026-08-10T12:00:00.000Z',
                languageEvidence: {
                  detectorVersion: 'async-test-1.0.0',
                  source: 'controlled-fixture',
                  detectedLanguage: 'es',
                  confidence: 0.95
                },
                acceptedThroughOriginalSampleOffset: 0
              };
              input.onEvent(event);
            }
          }, 0);
          return { status: 'started' };
        },
        pushAudio: ({ pcm, originalSampleOffset }) => ({
          status: 'accepted',
          acceptedSamples: pcm.byteLength / 2,
          acceptedThroughOriginalSampleOffset: originalSampleOffset + pcm.byteLength / 2
        }),
        finalize: () => ({ status: 'already-cancelled' }),
        cancel: () => ({ status: 'cancelled' }),
        close: () => {
          closed = true;
          return { status: 'closed' };
        }
      };
      return session;
    }
  };
}

describe('relay HTTP/WebSocket host', () => {
  let host: RelayHost;

  beforeEach(async () => {
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION
    });
    await host.start();
  });

  afterEach(async () => {
    await host.stop();
  });

  it('serves health and readiness JSON', async () => {
    const port = (host.server.address() as { readonly port: number }).port;
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

    expect(health.status).toBe(200);
    expect(await responseJson(health)).toEqual({ ok: true });
    expect(ready.status).toBe(200);
    expect(await responseJson(ready)).toEqual({ ready: true });
  });

  it('issues a contract-valid development ticket and rejects malformed requests generically', async () => {
    const issued = await issueTicket(host);
    expect(typeof issued.ticket).toBe('string');
    expect(issued).toMatchObject({
      wssOrigin: ORIGIN,
      wssPath: '/v1/stream',
      protocolVersion: 1
    });

    const port = (host.server.address() as { readonly port: number }).port;
    const malformed = await fetch(`http://127.0.0.1:${port}/v1/session-tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2, body: CANARY })
    });
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(await responseJson(malformed))).not.toContain(CANARY);

    const oversized = await fetch(`http://127.0.0.1:${port}/v1/session-tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, intent: 'new', body: 'x'.repeat(4_100) })
    });
    expect(oversized.status).toBe(413);

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/v1/session-tickets`);
    expect(wrongMethod.status).toBe(405);
  });

  it('does not open an upgrade that is still consuming a ticket when stopping', async () => {
    await host.stop();
    const ticketStore = new DelayedTicketStore();
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      ticketStore
    });
    await host.start();

    const issued = await issueTicket(host);
    const address = host.server.address() as { readonly port: number };
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/stream`,
      [...createWebSocketSubprotocols(String(issued.ticket))]
    );
    const rejected = waitForCloseOrUnexpectedResponse(socket);
    await ticketStore.consumeStarted.promise;

    const stopping = host.stop();
    ticketStore.consumeRelease.resolve();
    await expect(stopping).resolves.toBeUndefined();
    await expect(rejected).resolves.toMatch(/close|unexpected-response/);
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
  });

  it('fails startup with a generic message for invalid configuration', async () => {
    const result = await runRelayMain({ PALANCAR_RELAY_ORIGIN: CONFIG_CANARY });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toBe('relay failed to start\n');
    expect(result.stdout).not.toContain(CONFIG_CANARY);
    expect(result.stderr).not.toContain(CONFIG_CANARY);
  });

  it('consumes development tickets once and burns expired or mismatched tickets', async () => {
    let now = 1_000;
    const store = new DevelopmentTicketStore({ clock: () => now, ticketLifetimeMs: 10 });
    const targetAudience = audience();
    const issued = store.issue({ intent: { intent: 'new' }, audience: targetAudience });

    expect(await store.consume(issued.ticket, targetAudience)).toMatchObject({ status: 'accepted' });
    expect(await store.consume(issued.ticket, targetAudience)).toEqual({
      status: 'rejected',
      reason: 'authentication_failed'
    });

    const expired = store.issue({ intent: { intent: 'new' }, audience: targetAudience });
    now += 11;
    expect(await store.consume(expired.ticket, targetAudience)).toEqual({
      status: 'rejected',
      reason: 'ticket_expired'
    });

    const mismatched = store.issue({ intent: { intent: 'new' }, audience: targetAudience });
    expect(await store.consume(mismatched.ticket, audience('wss://other.example'))).toEqual({
      status: 'rejected',
      reason: 'origin_rejected'
    });
    expect(await store.consume(mismatched.ticket, targetAudience)).toEqual({
      status: 'rejected',
      reason: 'authentication_failed'
    });
  });

  it('rejects missing, malformed, and duplicate protocol offers before consuming valid tickets', async () => {
    const issued = await issueTicket(host);
    const ticket = String(issued.ticket);
    const address = host.server.address() as { readonly port: number };
    const url = `ws://127.0.0.1:${address.port}/v1/stream`;

    const missing = new WebSocket(url);
    await expect(waitForUnexpectedResponse(missing)).resolves.toBe(400);
    const malformed = new WebSocket(url, [`${WEBSOCKET_TICKET_PREFIX}bad`]);
    await expect(waitForUnexpectedResponse(malformed)).resolves.toBe(400);
    await expect(rawUpgradeStatus(address.port, `${WEBSOCKET_SUBPROTOCOL}, ${WEBSOCKET_SUBPROTOCOL}`)).resolves.toBe(400);
    expect(host.ticketStore.size).toBe(1);

    const socket = await openSocket(host, ticket);
    expect(socket.protocol).toBe(WEBSOCKET_SUBPROTOCOL);
    const closed = waitForClose(socket);
    socket.close(1000, 'test_done');
    await closed;
  });

  it('selects only palancar.v1 and drives text and contiguous binary audio through the core', async () => {
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket), [
      `${WEBSOCKET_TICKET_PREFIX}${String(issued.ticket)}`,
      WEBSOCKET_SUBPROTOCOL
    ]);
    expect(socket.protocol).toBe(WEBSOCKET_SUBPROTOCOL);

    const readyPromise = nextMessage(socket, (message) => message.type === 'session.ready');
    socket.send(sessionStartText());
    const ready = await readyPromise;
    const sessionId = String(ready.sessionId);
    const sessionEpoch = Number(ready.sessionEpoch);
    socket.send(JSON.stringify({
      type: 'utterance.start',
      sessionId,
      sessionEpoch,
      utteranceId: UTTERANCE_ID
    }));

    for (let sequence = 0; sequence < 18; sequence += 1) {
      const ack = nextMessage(
        socket,
        (message) => message.type === 'audio.ack' && message.highestContiguousExclusiveOffset === (sequence + 1) * 1_600
      );
      socket.send(frame(sequence, sequence * 1_600), { binary: true });
      await ack;
    }

    const transcript = nextMessage(socket, (message) => message.type === 'transcript.final');
    const language = nextMessage(socket, (message) => message.type === 'language.decision');
    const translation = nextMessage(socket, (message) => message.type === 'translation.ready');
    const suggestions = nextMessage(socket, (message) => message.type === 'suggestions.ready');
    socket.send(JSON.stringify({
      type: 'utterance.commit',
      sessionId,
      sessionEpoch,
      utteranceId: UTTERANCE_ID,
      finalOriginalSampleOffset: 28_800
    }));
    await expect(Promise.all([transcript, language, translation, suggestions])).resolves.toHaveLength(4);
    const closed = waitForClose(socket);
    socket.close(1000, 'test_done');
    await closed;
  });

  it('does not reuse a consumed ticket and keeps errors content-free', async () => {
    const issued = await issueTicket(host);
    const ticket = String(issued.ticket);
    const first = await openSocket(host, ticket);
    const firstClose = waitForClose(first);
    first.close(1000, 'test_done');
    await firstClose;

    const address = host.server.address() as { readonly port: number };
    const second = new WebSocket(`ws://127.0.0.1:${address.port}/v1/stream`, [...createWebSocketSubprotocols(ticket)]);
    await expect(waitForUnexpectedResponse(second)).resolves.toBe(401);

    const malformed = new WebSocket(`ws://127.0.0.1:${address.port}/v1/stream`, [...createWebSocketSubprotocols(
      String((await issueTicket(host)).ticket)
    )]);
    const closePromise = new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
      malformed.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await waitForOpen(malformed);
    malformed.send(CANARY);
    const closeDetails = await closePromise;
    expect(closeDetails.code).toBe(1002);
    expect(closeDetails.reason).not.toContain(CANARY);
    expect(malformed.protocol).not.toContain(CANARY);
  });

  it('keeps provider failures content-free', async () => {
    await host.stop();
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      generationService: new GenerationService(new DeterministicMockProvider({
        translate: { failure: new Error(CANARY) }
      }))
    });
    await host.start();
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const readyPromise = nextMessage(socket, (message) => message.type === 'session.ready');
    socket.send(sessionStartText());
    const ready = await readyPromise;
    const sessionId = String(ready.sessionId);
    const sessionEpoch = Number(ready.sessionEpoch);
    socket.send(JSON.stringify({ type: 'utterance.start', sessionId, sessionEpoch, utteranceId: UTTERANCE_ID }));
    for (let sequence = 0; sequence < 18; sequence += 1) {
      const ack = nextMessage(
        socket,
        (message) => message.type === 'audio.ack' && message.highestContiguousExclusiveOffset === (sequence + 1) * 1_600
      );
      socket.send(frame(sequence, sequence * 1_600), { binary: true });
      await ack;
    }
    const failure = nextMessage(socket, (message) => message.type === 'error');
    socket.send(JSON.stringify({
      type: 'utterance.commit',
      sessionId,
      sessionEpoch,
      utteranceId: UTTERANCE_ID,
      finalOriginalSampleOffset: 28_800
    }));
    const errorMessage = await failure;
    expect(JSON.stringify(errorMessage)).not.toContain(CANARY);
    const closed = waitForClose(socket);
    socket.close(1000, 'test_done');
    await closed;
  });

  it('drains asynchronous adapter events without another inbound message', async () => {
    await host.stop();
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapter: createAsyncCallbackAdapter()
    });
    await host.start();
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const readyPromise = nextMessage(socket, (message) => message.type === 'session.ready');
    socket.send(sessionStartText());
    const ready = await readyPromise;
    const partial = nextMessage(socket, (message) => message.type === 'transcript.partial');
    socket.send(JSON.stringify({
      type: 'utterance.start',
      sessionId: String(ready.sessionId),
      sessionEpoch: Number(ready.sessionEpoch),
      utteranceId: UTTERANCE_ID
    }));
    await expect(partial).resolves.toMatchObject({ text: 'asynchronous partial' });
    const closed = waitForClose(socket);
    socket.close(1000, 'test_done');
    await closed;
  });

  it('stops the HTTP server and closes active sockets', async () => {
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const closed = waitForClose(socket);
    await host.stop();
    await expect(closed).resolves.toBe(1001);
    expect(host.server.listening).toBe(false);
  });
});
