import { spawn } from 'node:child_process';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_NEGOTIATED_LIMITS,
  WEBSOCKET_SUBPROTOCOL,
  WEBSOCKET_TICKET_PREFIX,
  createWebSocketSubprotocols,
  encodeAudioFrame
} from '@palancar/contracts';
import {
  LANGUAGE_REGISTRY_VERSION,
  type ClassifiedLanguageEvidence,
  type TextLanguageClassifier
} from '@palancar/language-registry';
import {
  DeterministicMockProvider,
  GenerationService,
  type GenerationProvider,
  type GenerationProviderCompletion,
} from '@palancar/generation';
import {
  DETERMINISTIC_MOCK_CAPABILITIES,
  DeterministicMockTranscriptionAdapter,
  type NormalizedTranscriptionEvent,
  type TranscriptionAdapter,
  type TranscriptionSession
} from '@palancar/transcription';
import type {
  SecurityRuntimeStore,
  SecurityStateMaintenanceStore
} from '@palancar/security-state';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import {
  DevelopmentTicketStore,
  TEST_CREDENTIAL,
  createTestHostSecurityComposition,
  createTestOptions,
  createRelayHost as createRelayHostProduction,
  parseRelayHostConfig,
  type RelayHost,
  type RelayHostConfig,
  type RelayUpgradeAudience
} from '../src/index.js';

const ORIGIN = 'wss://127.0.0.1';
const ENVIRONMENT = 'relay-host-test';
const GATE_POLICY_VERSION = '1.0.0';
const UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';
const CANARY = 'relay-host-canary-ticket-body-provider-error';
const CONFIG_CANARY = 'relay-host-config-canary-invalid-origin';
const RELAY_MAIN_PATH = fileURLToPath(new URL('../dist/main.js', import.meta.url));

function createRelayHost(config: RelayHostConfig): RelayHost {
  return createRelayHostProduction({
    ...config,
    security: createTestHostSecurityComposition()
  });
}

function testSecurityWith(input: {
  readonly runtime?: Partial<SecurityRuntimeStore>;
  readonly maintenance?: Partial<SecurityStateMaintenanceStore>;
} = {}) {
  const base = createTestHostSecurityComposition();
  const runtime = Object.assign(Object.create(base.runtime) as SecurityRuntimeStore, input.runtime);
  const maintenance = Object.assign(
    Object.create(base.maintenance) as SecurityStateMaintenanceStore,
    input.maintenance
  );
  return { mode: 'azure-table' as const, runtime, maintenance };
}

interface JsonObject {
  readonly [key: string]: unknown;
}

function asObject(value: unknown): JsonObject {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  return value as JsonObject;
}

function observingControlledClassifier(
  observe: (text: string) => void | Promise<void>
): TextLanguageClassifier {
  const delegate = createTestOptions().languageClassifier;
  return {
    ready: delegate.ready,
    classify: async (text: string): Promise<ClassifiedLanguageEvidence> => {
      await observe(text);
      return delegate.classify(text);
    }
  };
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

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise() };
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
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TEST_CREDENTIAL}`
    },
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
    origin,
    path: '/v1/stream',
    protocol: WEBSOCKET_SUBPROTOCOL
  };
}

function createAsyncCallbackAdapter(): TranscriptionAdapter {
  return {
    capabilities: DETERMINISTIC_MOCK_CAPABILITIES,
    checkReadiness: async () => ({ ready: true, provider: 'test', model: 'test' }),
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
                text: 'es-selected-target-partial-1',
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

function createSynchronousFinalEventAdapter(): TranscriptionAdapter {
  return {
    capabilities: DETERMINISTIC_MOCK_CAPABILITIES,
    checkReadiness: async () => ({ ready: true, provider: 'test', model: 'test' }),
    createSession(input): TranscriptionSession {
      let activeUtteranceId: string | undefined;
      return {
        capabilities: DETERMINISTIC_MOCK_CAPABILITIES,
        configuration: input.configuration,
        state: {
          closed: false,
          acceptedThroughOriginalSampleOffset: 0,
          audioStateEpoch: 0
        },
        deliveryFailures: { failureCount: 0 },
        start: ({ utteranceId }) => {
          activeUtteranceId = utteranceId;
          return { status: 'started' };
        },
        pushAudio: ({ pcm, originalSampleOffset }) => ({
          status: 'accepted',
          acceptedSamples: pcm.byteLength / 2,
          acceptedThroughOriginalSampleOffset: originalSampleOffset + pcm.byteLength / 2
        }),
        finalize: () => {
          const utteranceId = activeUtteranceId;
          if (utteranceId === undefined) {
            return { status: 'already-cancelled' };
          }
          input.onEvent({
            type: 'transcript.final',
            sessionId: input.sessionId,
            sessionEpoch: input.sessionEpoch,
            utteranceId,
            segmentId: `${utteranceId}:0`,
            revision: 1,
            text: 'es-selected-target-final',
            providerEventTime: '2026-08-10T12:00:00.000Z',
            languageEvidence: {
              detectorVersion: 'synchronous-final-test-1.0.0',
              source: 'controlled-fixture',
              detectedLanguage: 'es',
              confidence: 0.95
            },
            acceptedThroughOriginalSampleOffset: 0,
            finalizationReason: 'explicit'
          });
          return { status: 'finalization-requested' };
        },
        cancel: () => ({ status: 'cancelled' }),
        close: () => ({ status: 'closed' })
      };
    }
  };
}

function createSynchronousFailureAdapter(): TranscriptionAdapter {
  return {
    capabilities: DETERMINISTIC_MOCK_CAPABILITIES,
    checkReadiness: async () => ({ ready: true, provider: 'test', model: 'test' }),
    createSession(input): TranscriptionSession {
      input.onFailure({ reason: 'provider', audioStateEpoch: 0 });
      input.onFailure({ reason: 'socket', audioStateEpoch: 0 });
      return {
        capabilities: DETERMINISTIC_MOCK_CAPABILITIES,
        configuration: input.configuration,
        state: {
          closed: false,
          acceptedThroughOriginalSampleOffset: 0,
          audioStateEpoch: 0
        },
        deliveryFailures: { failureCount: 0 },
        start: () => ({ status: 'started' }),
        pushAudio: ({ pcm, originalSampleOffset }) => ({
          status: 'accepted',
          acceptedSamples: pcm.byteLength / 2,
          acceptedThroughOriginalSampleOffset: originalSampleOffset + pcm.byteLength / 2
        }),
        finalize: () => ({ status: 'finalization-requested' }),
        cancel: () => ({ status: 'cancelled' }),
        close: () => ({ status: 'closed' })
      };
    }
  };
}

function createTwoAsyncEventAdapter(mode: 'microtask' | 'immediate'): TranscriptionAdapter {
  return {
    capabilities: DETERMINISTIC_MOCK_CAPABILITIES,
    checkReadiness: async () => ({ ready: true, provider: 'test', model: 'test' }),
    createSession(input): TranscriptionSession {
      let closed = false;
      const event = (utteranceId: string, revision: number): NormalizedTranscriptionEvent => ({
        type: 'transcript.partial',
        sessionId: input.sessionId,
        sessionEpoch: input.sessionEpoch,
        utteranceId,
        segmentId: `${utteranceId}:0`,
        revision,
        text: `es-selected-target-partial-${revision}`,
        providerEventTime: '2026-08-10T12:00:00.000Z',
        languageEvidence: {
          detectorVersion: 'async-wakeup-test-1.0.0',
          source: 'controlled-fixture',
          detectedLanguage: 'es',
          confidence: 0.95
        },
        acceptedThroughOriginalSampleOffset: 0
      });
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
          input.onEvent(event(utteranceId, 1));
          const emitSecond = (): void => {
            if (!closed) {
              input.onEvent(event(utteranceId, 2));
            }
          };
          if (mode === 'microtask') {
            queueMicrotask(emitSecond);
          } else {
            setImmediate(emitSecond);
          }
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

function createBlockedDeliveryAdapter(): {
  readonly adapter: TranscriptionAdapter;
  readonly sessionStarted: Promise<void>;
  readonly emitFirstEvent: () => void;
  readonly emitSecondEvent: () => void;
} {
  const sessionStarted = createDeferred();
  let emitFirstEvent: (() => void) | undefined;
  let emitSecondEvent: (() => void) | undefined;
  let closed = false;
  const adapter: TranscriptionAdapter = {
    capabilities: DETERMINISTIC_MOCK_CAPABILITIES,
    checkReadiness: async () => ({ ready: true, provider: 'test', model: 'test' }),
    createSession(input): TranscriptionSession {
      const event = (utteranceId: string, revision: number): NormalizedTranscriptionEvent => ({
        type: 'transcript.partial',
        sessionId: input.sessionId,
        sessionEpoch: input.sessionEpoch,
        utteranceId,
        segmentId: `${utteranceId}:0`,
        revision,
        text: `es-selected-target-partial-${revision}`,
        providerEventTime: '2026-08-10T12:00:00.000Z',
        languageEvidence: {
          detectorVersion: 'blocked-delivery-test-1.0.0',
          source: 'controlled-fixture',
          detectedLanguage: 'es',
          confidence: 0.95
        },
        acceptedThroughOriginalSampleOffset: 0
      });
      return {
        capabilities: DETERMINISTIC_MOCK_CAPABILITIES,
        configuration: input.configuration,
        state: {
          closed: false,
          acceptedThroughOriginalSampleOffset: 0,
          audioStateEpoch: 0
        },
        deliveryFailures: { failureCount: 0 },
        start: ({ utteranceId }) => {
          emitFirstEvent = (): void => {
            if (!closed) {
              input.onEvent(event(utteranceId, 1));
            }
          };
          emitSecondEvent = (): void => {
            if (!closed) {
              input.onEvent(event(utteranceId, 2));
            }
          };
          sessionStarted.resolve();
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
    }
  };
  return {
    adapter,
    sessionStarted: sessionStarted.promise,
    emitFirstEvent: () => emitFirstEvent?.(),
    emitSecondEvent: () => emitSecondEvent?.()
  };
}

const LITELLM_API_KEY = 'relay-host-test-litellm-key';
const LITELLM_MODEL = 'palancar-generation';
const READINESS_CANARY = 'relay-host-readiness-provider-canary';

interface ReadinessFixtureOptions {
  readonly catalogStatus?: number;
  readonly catalogBody?: unknown;
  readonly hangCatalog?: boolean;
  readonly redirectCatalog?: boolean;
}

interface ReadinessFixture {
  readonly server: HttpServer;
  readonly baseUrl: string;
  readonly getCatalogAuthorization: () => string | undefined;
  readonly getCatalogRedirectAuthorization: () => string | undefined;
  readonly getCatalogRedirectRequests: () => number;
  close(): Promise<void>;
}

async function startReadinessFixture(options: ReadinessFixtureOptions = {}): Promise<ReadinessFixture> {
  let catalogAuthorization: string | undefined;
  let catalogRedirectAuthorization: string | undefined;
  let catalogRedirectRequests = 0;
  const server = createHttpServer((request, response) => {
    if (request.url === '/v1/models') {
      catalogAuthorization = request.headers.authorization;
      if (options.hangCatalog === true) {
        return;
      }
      if (options.redirectCatalog === true) {
        response.statusCode = 302;
        response.setHeader('location', '/v1/models-redirect-target');
        response.end(READINESS_CANARY);
        return;
      }
      const body = options.catalogBody ?? { data: [{ id: LITELLM_MODEL }] };
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      response.statusCode = options.catalogStatus ?? 200;
      response.setHeader('content-type', 'application/json');
      response.end(text);
      return;
    }
    if (request.url === '/v1/models-redirect-target') {
      catalogRedirectRequests += 1;
      catalogRedirectAuthorization = request.headers.authorization;
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: LITELLM_MODEL }] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  expect(address).not.toBeNull();
  expect(typeof address).toBe('object');
  const port = (address as { readonly port: number }).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    getCatalogAuthorization: () => catalogAuthorization,
    getCatalogRedirectAuthorization: () => catalogRedirectAuthorization,
    getCatalogRedirectRequests: () => catalogRedirectRequests,
    close: () => new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => error === undefined ? resolve() : reject(error));
    })
  };
}

function mockEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PALANCAR_SECURITY_MODE: 'local-mock',
    PALANCAR_GENERATION_PROVIDER: 'mock',
    PALANCAR_TRANSCRIPTION_PROVIDER: 'mock',
    ...overrides
  };
}

function litellmEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PALANCAR_SECURITY_MODE: 'azure-table',
    PALANCAR_RELAY_ENVIRONMENT: ENVIRONMENT,
    PALANCAR_WORKLOAD_TABLE_ENDPOINT: 'https://palancartest.table.core.windows.net',
    PALANCAR_SECURITY_STATE_TABLE: 'SecurityState',
    PALANCAR_RATE_STATE_TABLE: 'RateState',
    AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
    PALANCAR_GENERATION_PROVIDER: 'litellm',
    PALANCAR_LITELLM_BASE_URL: 'http://127.0.0.1:4000',
    PALANCAR_LITELLM_API_KEY: LITELLM_API_KEY,
    PALANCAR_LITELLM_MODEL: LITELLM_MODEL,
    ...overrides
  };
}

function hostPort(host: RelayHost): number {
  return (host.server.address() as { readonly port: number }).port;
}

function expectedLiteLLMReadiness(upstreamReady: boolean): JsonObject {
  return { ready: upstreamReady };
}

function createReadinessAdapter(
  checkReadiness: TranscriptionAdapter['checkReadiness']
): TranscriptionAdapter {
  const delegate = createAsyncCallbackAdapter();
  return {
    capabilities: delegate.capabilities,
    createSession: (input) => delegate.createSession(input),
    checkReadiness
  };
}

async function expectFailedLiteLLMReadiness(host: RelayHost): Promise<void> {
  const ready = await fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
  expect(ready.status).toBe(503);
  const readyBody = await responseJson(ready);
  expect(readyBody).toEqual(expectedLiteLLMReadiness(false));
  expect(JSON.stringify(readyBody)).not.toContain(READINESS_CANARY);
  expect(JSON.stringify(readyBody)).not.toContain(LITELLM_API_KEY);
}

describe('relay host configuration and readiness', () => {
  it('parses an explicit mock generation provider', () => {
    const config = parseRelayHostConfig(mockEnvironment());

    expect(config.generationService?.provider).toEqual({
      id: 'deterministic-mock-generation',
      version: '1.0.0'
    });
    expect(config.generationReadiness).toMatchObject({
      provider: 'mock',
      providerId: 'deterministic-mock-generation',
      model: 'mock'
    });
  });

  it('accepts only the privately branded built-in generation service in local-mock mode', async () => {
    const builtInConfig = parseRelayHostConfig(mockEnvironment({ PORT: '0' }));
    const localHost = createRelayHostProduction(builtInConfig);
    await localHost.stop();

    const customService = new GenerationService(new DeterministicMockProvider({
      id: 'custom-deterministic-provider',
      complete: {
        result: {
          englishTranslation: 'custom',
          suggestions: [
            { englishText: 'one', selectedTargetText: 'uno' },
            { englishText: 'two', selectedTargetText: 'dos' }
          ]
        }
      }
    }));
    expect(() => createRelayHostProduction({
      ...builtInConfig,
      generationService: customService,
      generationReadiness: {
        provider: 'mock',
        providerId: customService.provider.id,
        model: 'mock'
      }
    })).toThrow('Invalid relay host configuration.');
  });

  it('rejects executable configuration without an explicit generation provider generically', () => {
    expect(() => parseRelayHostConfig({})).toThrow('Invalid relay host configuration.');
    expect(() => parseRelayHostConfig({})).not.toThrow(LITELLM_API_KEY);
  });

  it.each([
    ['non-loopback bind', { PALANCAR_RELAY_BIND_HOST: '0.0.0.0' }],
    ['non-loopback origin', { PALANCAR_RELAY_ORIGIN: 'wss://relay.example' }],
    ['LiteLLM setting', { PALANCAR_LITELLM_API_KEY: LITELLM_API_KEY }],
    ['Azure setting', { AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111' }]
  ])('rejects local-mock composition with %s', (_name, override) => {
    expect(() => parseRelayHostConfig(mockEnvironment(override))).toThrow(
      'Invalid relay host configuration.'
    );
  });

  it.each([
    ['endpoint', { PALANCAR_WORKLOAD_TABLE_ENDPOINT: undefined }],
    ['SecurityState name', { PALANCAR_SECURITY_STATE_TABLE: 'Wrong' }],
    ['RateState name', { PALANCAR_RATE_STATE_TABLE: 'Wrong' }],
    ['runtime UAMI', { AZURE_CLIENT_ID: undefined }]
  ])('rejects azure-table composition with invalid %s', (_name, override) => {
    expect(() => parseRelayHostConfig(litellmEnvironment(override))).toThrow(
      'Invalid relay host configuration.'
    );
  });

  it('creates LiteLLM provider identity without exposing its API key', () => {
    const config = parseRelayHostConfig(litellmEnvironment());

    expect(config.generationService?.provider).toEqual({ id: 'litellm-chat', version: '1.0.0' });
    expect(JSON.stringify(config)).not.toContain(LITELLM_API_KEY);
  });

  it.each([
    ['missing base URL', { PALANCAR_LITELLM_BASE_URL: undefined }],
    ['missing API key', { PALANCAR_LITELLM_API_KEY: undefined }],
    ['missing model', { PALANCAR_LITELLM_MODEL: undefined }],
    ['malformed base URL', { PALANCAR_LITELLM_BASE_URL: 'not-a-url' }],
    ['malformed timeout', { PALANCAR_LITELLM_TIMEOUT_MS: 'not-a-number' }]
  ])('rejects %s with a generic config error', (_name, override) => {
    expect(() => parseRelayHostConfig(litellmEnvironment(override))).toThrow(
      'Invalid relay host configuration.'
    );
  });

  it('keeps health process-only while LiteLLM readiness is failing', async () => {
    const fixture = await startReadinessFixture({
      catalogStatus: 503,
      catalogBody: JSON.stringify({ error: READINESS_CANARY })
    });
    let host: RelayHost | undefined;
    try {
      host = createRelayHost(parseRelayHostConfig(litellmEnvironment({
        PORT: '0',
        PALANCAR_LITELLM_BASE_URL: fixture.baseUrl
      })));
      await host.start();
      const health = await fetch(`http://127.0.0.1:${hostPort(host)}/healthz`);
      const ready = await fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);

      expect(health.status).toBe(200);
      expect(await responseJson(health)).toEqual({ ok: true });
      expect(ready.status).toBe(503);
      const readyBody = await responseJson(ready);
      expect(readyBody).toEqual(expectedLiteLLMReadiness(false));
      expect(JSON.stringify(readyBody)).not.toContain(READINESS_CANARY);
      expect(JSON.stringify(readyBody)).not.toContain(LITELLM_API_KEY);
    } finally {
      await host?.stop();
      await fixture.close();
    }
  });

  it('returns content-free ready status for one authenticated LiteLLM alias', async () => {
    const fixture = await startReadinessFixture();
    let host: RelayHost | undefined;
    try {
      host = createRelayHost(parseRelayHostConfig(litellmEnvironment({
        PORT: '0',
        PALANCAR_LITELLM_BASE_URL: fixture.baseUrl
      })));
      await host.start();
      const ready = await fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);

      expect(ready.status).toBe(200);
      expect(await responseJson(ready)).toEqual(expectedLiteLLMReadiness(true));
      expect(fixture.getCatalogAuthorization()).toBe(`Bearer ${LITELLM_API_KEY}`);
    } finally {
      await host?.stop();
      await fixture.close();
    }
  });

  it.each([
    ['catalog non-2xx', {
      catalogStatus: 503,
      catalogBody: { data: [{ id: LITELLM_MODEL }] }
    }],
    ['catalog timeout', { hangCatalog: true }],
    ['catalog malformed JSON', { catalogBody: `{not-json:${READINESS_CANARY}` }],
    ['catalog body over 16 KiB', {
      catalogBody: JSON.stringify({
        data: [{ id: LITELLM_MODEL }],
        padding: `${READINESS_CANARY}${'x'.repeat(16_384)}`
      })
    }],
    ['duplicate alias', {
      catalogBody: {
        data: [{ id: LITELLM_MODEL }, { id: LITELLM_MODEL }],
        error: READINESS_CANARY
      }
    }],
    ['missing alias', {
      catalogBody: { data: [{ id: 'other-model' }], error: READINESS_CANARY }
    }]
  ])('returns exact content-free 503 for LiteLLM readiness failure: %s', async (_name, options) => {
    const fixture = await startReadinessFixture(options);
    let host: RelayHost | undefined;
    try {
      host = createRelayHost(parseRelayHostConfig(litellmEnvironment({
        PORT: '0',
        PALANCAR_LITELLM_BASE_URL: fixture.baseUrl
      })));
      await host.start();
      await expectFailedLiteLLMReadiness(host);
    } finally {
      await host?.stop();
      await fixture.close();
    }
  });

  it('rejects a redirect from the LiteLLM models endpoint without forwarding the bearer key', async () => {
    const fixture = await startReadinessFixture({ redirectCatalog: true });
    let host: RelayHost | undefined;
    try {
      host = createRelayHost(parseRelayHostConfig(litellmEnvironment({
        PORT: '0',
        PALANCAR_LITELLM_BASE_URL: fixture.baseUrl
      })));
      await host.start();
      await expectFailedLiteLLMReadiness(host);
      expect(fixture.getCatalogRedirectRequests()).toBe(0);
      expect(fixture.getCatalogRedirectAuthorization()).toBeUndefined();
    } finally {
      await host?.stop();
      await fixture.close();
    }
  });

  it('returns content-free ready status for mock generation', async () => {
    const generationService = parseRelayHostConfig(mockEnvironment()).generationService;
    expect(generationService).toBeDefined();
    const host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      generationService: generationService as NonNullable<typeof generationService>
    });
    await host.start();
    try {
      const ready = await fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
      expect(ready.status).toBe(200);
      expect(await responseJson(ready)).toEqual({ ready: true });
    } finally {
      await host.stop();
    }
  });

  it('fails readiness closed when durable security maintenance is unavailable', async () => {
    const security = testSecurityWith({
      maintenance: { checkReadiness: async () => { throw new Error(READINESS_CANARY); } }
    });
    const securedHost = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security
    });
    try {
      await securedHost.start();
      const response = await fetch(`http://127.0.0.1:${hostPort(securedHost)}/readyz`);
      expect(response.status).toBe(503);
      const body = await responseJson(response);
      expect(body).toEqual({ ready: false });
      expect(JSON.stringify(body)).not.toContain(READINESS_CANARY);
    } finally {
      await securedHost.stop();
    }
  });

  it.each([
    ['not ready', async () => ({
      ready: false,
      provider: 'secret-transcription-provider',
      model: 'secret-transcription-model'
    })],
    ['exception', async () => {
      throw new Error('secret transcription readiness detail');
    }]
  ] as const)('fails readiness content-free when transcription reports %s', async (_label, check) => {
    const host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapter: createReadinessAdapter(check),
      languageClassifier: observingControlledClassifier(() => undefined)
    });
    await host.start();
    try {
      const ready = await fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
      expect(ready.status).toBe(503);
      const body = await responseJson(ready);
      expect(body).toEqual({ ready: false });
      expect(JSON.stringify(body)).not.toContain('secret');
    } finally {
      await host.stop();
    }
  });

  it('bounds a hanging transcription readiness check and leaves health unchanged', async () => {
    const host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapter: createReadinessAdapter(
        () => new Promise(() => undefined)
      ),
      languageClassifier: observingControlledClassifier(() => undefined)
    });
    await host.start();
    try {
      const startedAt = Date.now();
      const ready = await fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(ready.status).toBe(503);
      expect(await responseJson(ready)).toEqual({ ready: false });
      const health = await fetch(`http://127.0.0.1:${hostPort(host)}/healthz`);
      expect(health.status).toBe(200);
      expect(await responseJson(health)).toEqual({ ok: true });
    } finally {
      await host.stop();
    }
  }, 5_000);

  it.each(['rejected', 'timeout'] as const)(
    'fails readiness content-free when classifier readiness is %s',
    async (mode) => {
      const classifierReady = mode === 'rejected'
        ? Promise.reject(new Error('secret classifier readiness detail'))
        : new Promise<void>(() => undefined);
      if (mode === 'rejected') void classifierReady.catch(() => undefined);
      const languageClassifier: TextLanguageClassifier = {
        ready: classifierReady,
        classify: async () => ({
          status: 'unavailable',
          detectorVersion: 'unused-test-classifier'
        })
      };
      const host = createRelayHost({
        environment: ENVIRONMENT,
        origin: ORIGIN,
        port: 0,
        gatePolicyVersion: GATE_POLICY_VERSION,
        languageClassifier
      });
      await host.start();
      try {
        const ready = await fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
        expect(ready.status).toBe(503);
        const body = await responseJson(ready);
        expect(body).toEqual({ ready: false });
        expect(JSON.stringify(body)).not.toContain('secret');
      } finally {
        await host.stop();
      }
    },
    5_000
  );

  it('requires an explicit classifier for non-default transcription adapters', () => {
    expect(() => createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapter: createAsyncCallbackAdapter()
    })).toThrow('Invalid relay host configuration.');
  });

  it('rejects a branded controlled classifier paired with a non-mock adapter', () => {
    expect(() => createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapter: createAsyncCallbackAdapter(),
      languageClassifier: createTestOptions().languageClassifier
    })).toThrow('Invalid relay host configuration.');
  });

  it('allows the branded controlled classifier with an actual deterministic mock adapter', async () => {
    const host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapter: new DeterministicMockTranscriptionAdapter({
        evidenceCategory: 'selected-target'
      }),
      languageClassifier: createTestOptions().languageClassifier
    });
    await host.stop();
  });
});

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

    const legacyResume = await fetch(`http://127.0.0.1:${port}/v1/session-tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        intent: 'resume',
        sessionId: '11111111-1111-4111-8111-111111111111'
      })
    });
    expect(legacyResume.status).toBe(400);

    const oversized = await fetch(`http://127.0.0.1:${port}/v1/session-tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, intent: 'new', body: 'x'.repeat(4_100) })
    });
    expect(oversized.status).toBe(413);

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/v1/session-tickets`);
    expect(wrongMethod.status).toBe(405);
  });

  it('requires bearer credentials for tickets and marks credential responses no-store', async () => {
    const port = hostPort(host);
    const denied = await fetch(`http://127.0.0.1:${port}/v1/session-tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, intent: 'new' })
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(await responseJson(denied)).toEqual({ error: 'request_rejected' });

    const accepted = await fetch(`http://127.0.0.1:${port}/v1/session-tickets`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_CREDENTIAL}`
      },
      body: JSON.stringify({ protocolVersion: 1, intent: 'new' })
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
  });

  it('redeems pairing through the runtime and ignores forwarded identity headers', async () => {
    const response = await fetch(`http://127.0.0.1:${hostPort(host)}/v1/pairing-redemptions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.99',
        forwarded: 'for=203.0.113.100'
      },
      body: JSON.stringify({ pairingCode: '00000000000000000000000001' })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await responseJson(response);
    expect(body.credential).toBe(TEST_CREDENTIAL);
    expect(JSON.stringify(body)).not.toContain('203.0.113');
  });

  it('closes an upgraded connection when stopping', async () => {
    const issued = await issueTicket(host);
    const address = host.server.address() as { readonly port: number };
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/stream`,
      [...createWebSocketSubprotocols(String(issued.ticket))]
    );
    await waitForOpen(socket);
    const closed = waitForClose(socket);
    await expect(host.stop()).resolves.toBeUndefined();
    await expect(closed).resolves.toBeGreaterThan(0);
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

  it('delivers final transcript and language before deferred generation output', async () => {
    await host.stop();
    let resolveCompletion: ((value: GenerationProviderCompletion) => void) | undefined;
    const completion = new Promise<GenerationProviderCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    const provider: GenerationProvider = {
      id: 'deferred-host-provider',
      version: '1.0.0',
      complete: async () => completion
    };
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      generationService: new GenerationService(provider)
    });
    await host.start();

    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const seenTypes: string[] = [];
    const seenListener = (data: RawData): void => {
      try {
        const message = asObject(JSON.parse(rawDataText(data)) as unknown);
        if (typeof message.type === 'string') {
          seenTypes.push(message.type);
        }
      } catch {
        // Ignore non-JSON frames; the protocol test only tracks control messages.
      }
    };
    socket.on('message', seenListener);
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

    await Promise.all([transcript, language]);
    expect(seenTypes).toContain('transcript.final');
    expect(seenTypes).toContain('language.decision');
    expect(seenTypes).not.toContain('translation.ready');
    expect(seenTypes).not.toContain('suggestions.ready');

    resolveCompletion?.({
      englishTranslation: 'hello',
      suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
      ]
    });
    await Promise.all([translation, suggestions]);
    const transcriptIndex = seenTypes.indexOf('transcript.final');
    const languageIndex = seenTypes.indexOf('language.decision');
    const translationIndex = seenTypes.indexOf('translation.ready');
    const suggestionsIndex = seenTypes.indexOf('suggestions.ready');
    expect(transcriptIndex).toBeGreaterThanOrEqual(0);
    expect(languageIndex).toBeGreaterThan(transcriptIndex);
    expect(translationIndex).toBeGreaterThan(languageIndex);
    expect(suggestionsIndex).toBeGreaterThan(translationIndex);
    socket.off('message', seenListener);
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
        complete: { failure: new Error(CANARY) }
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

  it('classifies and suppresses an asynchronous partial without another inbound message', async () => {
    await host.stop();
    const classified = createDeferred();
    const receivedTypes: string[] = [];
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapter: createAsyncCallbackAdapter(),
      languageClassifier: observingControlledClassifier((text) => {
        expect(text).toBe('es-selected-target-partial-1');
        classified.resolve();
      })
    });
    await host.start();
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const readyPromise = nextMessage(socket, (message) => message.type === 'session.ready');
    socket.on('message', (data) => {
      try {
        const message = asObject(JSON.parse(rawDataText(data)) as unknown);
        if (typeof message.type === 'string') receivedTypes.push(message.type);
      } catch {
        // Observation only.
      }
    });
    socket.send(sessionStartText());
    const ready = await readyPromise;
    socket.send(JSON.stringify({
      type: 'utterance.start',
      sessionId: String(ready.sessionId),
      sessionEpoch: Number(ready.sessionEpoch),
      utteranceId: UTTERANCE_ID
    }));
    await classified.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(receivedTypes).not.toContain('transcript.partial');
    const closed = waitForClose(socket);
    socket.close(1000, 'test_done');
    await closed;
  });

  it.each(['microtask', 'immediate'] as const)(
    'classifies a %s partial arriving while an async drain is already scheduled',
    async (mode) => {
    await host.stop();
    const classifiedTexts: string[] = [];
    const secondClassified = createDeferred();
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapter: createTwoAsyncEventAdapter(mode),
      languageClassifier: observingControlledClassifier((text) => {
        classifiedTexts.push(text);
        if (text === 'es-selected-target-partial-2') secondClassified.resolve();
      })
    });
    await host.start();
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const readyPromise = nextMessage(socket, (message) => message.type === 'session.ready');
    socket.send(sessionStartText());
    const ready = await readyPromise;
    socket.send(JSON.stringify({
      type: 'utterance.start',
      sessionId: String(ready.sessionId),
      sessionEpoch: Number(ready.sessionEpoch),
      utteranceId: UTTERANCE_ID
    }));

    await secondClassified.promise;
    expect(classifiedTexts).toContain('es-selected-target-partial-2');
    socket.close(1000, 'test_done');
    await waitForClose(socket);
    }
  );

  it('serializes and coalesces a synchronous create-session failure content-free', async () => {
    await host.stop();
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapter: createSynchronousFailureAdapter(),
      languageClassifier: observingControlledClassifier(() => undefined)
    });
    await host.start();
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const received: JsonObject[] = [];
    socket.on('message', (data) => {
      try {
        received.push(asObject(JSON.parse(rawDataText(data)) as unknown));
      } catch {
        // Test observation ignores malformed unrelated frames.
      }
    });
    const readyPromise = nextMessage(socket, (message) => message.type === 'session.ready');
    socket.send(sessionStartText());
    const ready = await readyPromise;
    const closed = waitForClose(socket);
    socket.send(JSON.stringify({
      type: 'utterance.start',
      sessionId: String(ready.sessionId),
      sessionEpoch: Number(ready.sessionEpoch),
      utteranceId: UTTERANCE_ID
    }));

    await expect(closed).resolves.toBe(4503);
    expect(received.filter((message) => message.type === 'utterance.aborted')).toHaveLength(1);
    expect(received.filter((message) => message.type === 'error')).toHaveLength(1);
    expect(JSON.stringify(received)).not.toContain('audioStateEpoch');
  });

  it('keeps consecutive production sends synchronous when delivery hook is omitted', async () => {
    await host.stop();
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapter: createSynchronousFinalEventAdapter(),
      languageClassifier: observingControlledClassifier(() => undefined)
    });
    await host.start();
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const originalSend = WebSocket.prototype.send;
    let observingServerSends = false;
    let serverSendCount = 0;
    let microtaskRan = false;
    let microtaskRanBetweenConsecutiveSends = false;
    const sendSpy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<typeof originalSend>
    ) {
      let relevantServerMessage = false;
      if (this !== socket && observingServerSends && typeof args[0] === 'string') {
        try {
          const message = asObject(JSON.parse(args[0]) as unknown);
          relevantServerMessage = message.type === 'transcript.final' ||
            message.type === 'language.decision';
        } catch {
          relevantServerMessage = false;
        }
      }
      if (relevantServerMessage) {
        if (serverSendCount === 0) {
          queueMicrotask(() => {
            microtaskRan = true;
          });
        }
        serverSendCount += 1;
        if (serverSendCount === 2) {
          microtaskRanBetweenConsecutiveSends = microtaskRan;
          observingServerSends = false;
        }
      }
      return Reflect.apply(originalSend, this, args);
    });
    try {
      const readyPromise = nextMessage(socket, (message) => message.type === 'session.ready');
      socket.send(sessionStartText());
      const ready = await readyPromise;
      observingServerSends = true;
      const transcript = nextMessage(socket, (message) => message.type === 'transcript.final');
      const language = nextMessage(socket, (message) => message.type === 'language.decision');
      socket.send(JSON.stringify({
        type: 'utterance.start',
        sessionId: String(ready.sessionId),
        sessionEpoch: Number(ready.sessionEpoch),
        utteranceId: UTTERANCE_ID
      }));
      socket.send(JSON.stringify({
        type: 'utterance.commit',
        sessionId: String(ready.sessionId),
        sessionEpoch: Number(ready.sessionEpoch),
        utteranceId: UTTERANCE_ID,
        finalOriginalSampleOffset: 0
      }));

      await Promise.all([transcript, language]);
      expect(serverSendCount).toBe(2);
      expect(microtaskRanBetweenConsecutiveSends).toBe(false);
    } finally {
      sendSpy.mockRestore();
      const closed = waitForClose(socket);
      socket.close(1000, 'test_done');
      await closed;
    }
  });

  it('reschedules a partial enqueued while the first async classification is blocked', async () => {
    await host.stop();
    const fixture = createBlockedDeliveryAdapter();
    const classificationReleased = createDeferred();
    const firstClassificationStarted = createDeferred();
    const secondClassificationFinished = createDeferred();
    const classifiedTexts: string[] = [];
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapter: fixture.adapter,
      languageClassifier: observingControlledClassifier(async (text) => {
        classifiedTexts.push(text);
        if (text === 'es-selected-target-partial-1') {
          firstClassificationStarted.resolve();
          await classificationReleased.promise;
        } else if (text === 'es-selected-target-partial-2') {
          secondClassificationFinished.resolve();
        }
      })
    });
    await host.start();
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const readyPromise = nextMessage(socket, (message) => message.type === 'session.ready');
    socket.send(sessionStartText());
    const ready = await readyPromise;
    socket.send(JSON.stringify({
      type: 'utterance.start',
      sessionId: String(ready.sessionId),
      sessionEpoch: Number(ready.sessionEpoch),
      utteranceId: UTTERANCE_ID
    }));
    await fixture.sessionStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.emitFirstEvent();

    await firstClassificationStarted.promise;
    fixture.emitSecondEvent();
    classificationReleased.resolve();
    await secondClassificationFinished.promise;
    expect(classifiedTexts).toEqual([
      'es-selected-target-partial-1',
      'es-selected-target-partial-2'
    ]);
    socket.close(1000, 'test_done');
    await waitForClose(socket);
  });

  it('stops the HTTP server and closes active sockets', async () => {
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const closed = waitForClose(socket);
    await host.stop();
    await expect(closed).resolves.toBe(1001);
    expect(host.server.listening).toBe(false);
  });

  it.each([
    ['es', 'es-selected-target-final', 'A Spanish phrase translated to English.',
      ['Sí, por favor.', 'No, gracias.']],
    ['tr', 'tr-selected-target-final', 'A Turkish phrase translated to English.',
      ['Evet, lütfen.', 'Hayır, teşekkürler.']]
  ] as const)(
    'keeps built-in %s transcription and suggestions language-consistent',
    async (targetLanguage, expectedTranscript, expectedEnglish, expectedTargets) => {
      const issued = await issueTicket(host);
      const socket = await openSocket(host, String(issued.ticket));
      const readyPromise = nextMessage(socket, (message) => message.type === 'session.ready');
      socket.send(sessionStartText().replace('"targetLanguage":"es"',
        `"targetLanguage":"${targetLanguage}"`));
      const ready = await readyPromise;
      const transcript = nextMessage(socket, (message) => message.type === 'transcript.final');
      const translation = nextMessage(socket, (message) => message.type === 'translation.ready');
      const suggestions = nextMessage(socket, (message) => message.type === 'suggestions.ready');
      socket.send(JSON.stringify({
        type: 'utterance.start',
        sessionId: String(ready.sessionId),
        sessionEpoch: Number(ready.sessionEpoch),
        utteranceId: UTTERANCE_ID
      }));
      socket.send(JSON.stringify({
        type: 'utterance.commit',
        sessionId: String(ready.sessionId),
        sessionEpoch: Number(ready.sessionEpoch),
        utteranceId: UTTERANCE_ID,
        finalOriginalSampleOffset: 0
      }));

      await expect(transcript).resolves.toMatchObject({ text: expectedTranscript });
      await expect(translation).resolves.toMatchObject({ englishTranslation: expectedEnglish });
      const suggestionMessage = await suggestions;
      expect(suggestionMessage.suggestions).toEqual([
        { englishText: 'Yes, please.', selectedTargetText: expectedTargets[0] },
        { englishText: 'No, thank you.', selectedTargetText: expectedTargets[1] }
      ]);
      socket.close(1000, 'test_done');
      await waitForClose(socket);
    }
  );

  it('reserves audio in exact 8,000-sample ranges rather than writing per frame', async () => {
    await host.stop();
    const security = testSecurityWith();
    const reserve = vi.spyOn(security.runtime, 'reserveAudio');
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security
    });
    await host.start();
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const readyMessage = nextMessage(socket, (message) => message.type === 'session.ready');
    socket.send(sessionStartText());
    const ready = await readyMessage;
    socket.send(JSON.stringify({
      type: 'utterance.start',
      sessionId: String(ready.sessionId),
      sessionEpoch: Number(ready.sessionEpoch),
      utteranceId: UTTERANCE_ID
    }));
    const grantBoundaryAck = nextMessage(socket, (message) =>
      message.type === 'audio.ack' && message.highestContiguousExclusiveOffset === 8_000
    );
    for (let sequence = 0; sequence < 5; sequence += 1) {
      socket.send(frame(sequence, sequence * 1_600));
    }
    socket.send(frame(5, 8_000, new Uint8Array(2)));
    await grantBoundaryAck;
    const finalAck = nextMessage(socket, (message) =>
      message.type === 'audio.ack' && message.highestContiguousExclusiveOffset === 8_001
    );
    socket.send(JSON.stringify({
      type: 'utterance.commit',
      sessionId: String(ready.sessionId),
      sessionEpoch: Number(ready.sessionEpoch),
      utteranceId: UTTERANCE_ID,
      finalOriginalSampleOffset: 8_001
    }));
    await finalAck;

    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve.mock.calls.map(([input]) => ({
      from: input.fromOriginalSampleOffset,
      samples: input.originalSamples
    }))).toEqual([
      { from: 0, samples: 8_000 },
      { from: 8_000, samples: 8_000 }
    ]);
    socket.close(1000, 'test_done');
    await waitForClose(socket);
  });
});
