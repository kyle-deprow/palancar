import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

import type { AzureTokenProvider } from '@palancar/azure-auth';
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
  DeterministicFixtureLanguageValidator,
  DeterministicMockProvider,
  FailClosedGeneratedLanguageValidator,
  GenerationService,
  type GeneratedLanguageValidationEvidence,
  type GeneratedLanguageValidator,
  type GenerationProvider,
  type GenerationProviderCompletion,
} from '@palancar/generation';
import type { FrameRejectionReason } from '@palancar/audio';
import {
  AzureRealtimeTranscriptionAdapter,
  DETERMINISTIC_MOCK_CAPABILITIES,
  DeterministicMockTranscriptionAdapter,
  type NormalizedTranscriptionEvent,
  type TranscriptionAdapter,
  type TranscriptionSession
} from '@palancar/transcription';
import {
  DURABLE_SECURITY_STATE_STORE,
  SecurityStateError,
  assertCanonical256BitToken,
  assertCanonicalUuid,
  type CredentialPromotionResult,
  type DurableSecurityStateStore,
  type InstallationRevocationResult,
  type PendingCredentialResult,
  type SecurityRuntimeStore,
  type SecurityStateMaintenanceStore,
  type SessionLease
} from '@palancar/security-state';
import { AudioGrantMeter } from '@palancar/security-state/testing';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import {
  DevelopmentTicketStore,
  TEST_CREDENTIAL,
  createTestHostSecurityComposition,
  createTestOptions,
  createRelayHost as createRelayHostImplementation,
  createDevelopmentProvisionalLanguageBoundary,
  createFailClosedDeployedTextLanguageClassifier,
  isDevelopmentProvisionalGeneratedLanguageValidator,
  isDevelopmentProvisionalTextLanguageClassifier,
  parseRelayHostConfig,
  type RelayHost,
  type RelayHostConfig,
  type RelayProductionMetricInput,
  type RelayUpgradeAudience
} from '../src/index.js';
import { createDisabledRelayMetricSink } from '../src/telemetry.js';

const ORIGIN = 'wss://127.0.0.1';
const ENVIRONMENT = 'relay-host-test';
const GATE_POLICY_VERSION = '1.0.0';
const UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_UTTERANCE_ID = '33333333-3333-4333-8333-333333333333';
const CANARY = 'relay-host-canary-ticket-body-provider-error';
const CONFIG_CANARY = 'relay-host-config-canary-invalid-origin';
const PENDING_CREDENTIAL = 'C'.repeat(42) + 'E';
const RELAY_MAIN_PATH = fileURLToPath(new URL('../dist/main.js', import.meta.url));

function createRelayHostProduction(config: RelayHostConfig): RelayHost {
  return createRelayHostImplementation(
    config.generationProvider === undefined
      ? { ...config, generationProvider: 'mock' }
      : config
  );
}

function createRelayHost(config: RelayHostConfig): RelayHost {
  if (
    config.languageBoundaryMode === 'deny-all' ||
    config.generationProvider === 'azure-openai' ||
    config.generationReadiness?.provider === 'azure-openai-chat'
  ) {
    const {
      securityFactory,
      metricSinkFactory,
      ...directConfig
    } = config;
    void securityFactory;
    void metricSinkFactory;
    return createRelayHostProduction({
      ...directConfig,
      security: {
        ...createTestHostSecurityComposition(),
        mode: 'azure-table'
      },
      metricSink: {
        record: () => undefined,
        checkReadiness: async () => true,
        shutdown: async () => undefined
      } as NonNullable<RelayHostConfig['metricSink']>
    });
  }
  return createRelayHostProduction({
    ...config,
    environment: 'local-mock',
    languageBoundaryMode: 'fixture',
    security: {
      ...createTestHostSecurityComposition(),
      mode: 'local-mock'
    }
  });
}

function productionTestMetricSink(): NonNullable<RelayHostConfig['metricSink']> {
  return {
    record: () => undefined,
    checkReadiness: async () => true,
    shutdown: async () => undefined
  } as NonNullable<RelayHostConfig['metricSink']>;
}

function testSecurityWith(input: {
  readonly runtime?: Partial<SecurityRuntimeStore>;
  readonly maintenance?: Partial<SecurityStateMaintenanceStore>;
} = {}) {
  const base = createTestHostSecurityComposition();
  const runtime = {
    ...base.runtime,
    ...input.runtime,
    [DURABLE_SECURITY_STATE_STORE]: true as const,
    deploymentBoundary: 'DURABLE_PROVIDER' as const,
    capabilities: Object.freeze({
      durableAcrossProcesses: true as const,
      paidProvidersAllowed: true as const
    })
  } satisfies DurableSecurityStateStore;
  const maintenance = {
    ...base.maintenance,
    ...input.maintenance
  } satisfies SecurityStateMaintenanceStore;
  return { mode: 'azure-table' as const, runtime, maintenance };
}

function lifecycleSecurityWith() {
  const beginCredentialRotation = vi.fn(async (): Promise<PendingCredentialResult> => ({
    installationId: assertCanonicalUuid('11111111-1111-4111-8111-111111111111'),
    pendingCredential: assertCanonical256BitToken(PENDING_CREDENTIAL),
    pendingCredentialVersion: 2,
    pendingExpiresAt: Date.parse('2026-08-10T12:30:00.000Z'),
    absoluteExpiresAt: Date.parse('2026-10-01T00:00:00.000Z')
  }));
  const promoteCredential = vi.fn(async (): Promise<CredentialPromotionResult> => ({
    installationId: assertCanonicalUuid('11111111-1111-4111-8111-111111111111'),
    credentialVersion: 2,
    tombstoneVersion: 1,
    status: 'promoted' as const,
    confirmedAt: Date.parse('2026-08-10T12:01:00.000Z'),
    idleExpiresAt: Date.parse('2026-09-01T00:00:00.000Z'),
    absoluteExpiresAt: Date.parse('2026-10-01T00:00:00.000Z')
  }));
  const revokeCurrentInstallation = vi.fn(async (): Promise<InstallationRevocationResult> => ({
    installationId: assertCanonicalUuid('11111111-1111-4111-8111-111111111111'),
    credentialVersion: 2,
    tombstoneVersion: 2,
    status: 'revoked' as const,
    revokedAt: Date.parse('2026-08-10T12:02:00.000Z')
  }));
  const security = testSecurityWith({
    runtime: {
      beginCredentialRotation,
      promoteCredential,
      revokeCurrentInstallation
    }
  });
  return {
    composition: security,
    spies: { beginCredentialRotation, promoteCredential, revokeCurrentInstallation }
  };
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

function waitForCloseDetails(socket: WebSocket): Promise<{
  readonly code: number;
  readonly reason: string;
}> {
  return new Promise((resolve) => socket.once('close', (code, reason) => resolve({
    code,
    reason: reason.toString('utf8')
  })));
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

function createValueDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value) };
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

function runRelayMainAndSignal(signal: 'SIGTERM' | 'SIGINT'): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, [RELAY_MAIN_PATH], {
    env: { ...process.env, ...mockEnvironment({ PORT: '0' }) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let signalled = false;
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
    if (!signalled && stdout.includes('relay listening on ')) {
      signalled = true;
      child.kill(signal);
    }
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('relay main did not drain after signal'));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
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

function rawHttpResponse(port: number, request: string): Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for HTTP response'));
    }, 5_000);
    const finish = (): void => {
      const separator = response.indexOf('\r\n\r\n');
      if (separator < 0) return;
      const head = response.subarray(0, separator).toString('latin1');
      const lines = head.split('\r\n');
      const statusMatch = /^HTTP\/1\.1 (\d+)/.exec(lines[0] ?? '');
      if (statusMatch === null) return;
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      const expectedBytes = Number(headers['content-length'] ?? '0');
      const bodyBytes = response.subarray(separator + 4);
      if (bodyBytes.byteLength < expectedBytes) return;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        status: Number(statusMatch[1]),
        headers: Object.freeze(headers),
        body: bodyBytes.subarray(0, expectedBytes).toString('utf8')
      });
    };
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      response = Buffer.concat([response, chunk]);
      finish();
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sessionStartText(
  limitOverrides: Partial<typeof DEFAULT_NEGOTIATED_LIMITS> = {}
): string {
  return JSON.stringify({
    type: 'session.start',
    protocolVersion: 1,
    wearerLanguage: 'en',
    targetLanguage: 'es',
    languageRegistryVersion: LANGUAGE_REGISTRY_VERSION,
    gatePolicyVersion: GATE_POLICY_VERSION,
    clientBuild: 'relay-host-test-1.0.0',
    requestedLimits: { ...DEFAULT_NEGOTIATED_LIMITS, ...limitOverrides }
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

function frameFor(
  utteranceId: string,
  sequence: number,
  offset: number,
  payload = new Uint8Array(3_200)
): Uint8Array {
  return encodeAudioFrame({ utteranceId, sequence, offset, payload });
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

function controlledLease(input: {
  readonly installationId: string;
  readonly sessionId: string;
  readonly credentialVersion: number;
}): SessionLease {
  return Object.freeze({
    installationId: assertCanonicalUuid(input.installationId),
    sessionId: assertCanonicalUuid(input.sessionId),
    sessionEpoch: 1,
    credentialVersion: input.credentialVersion,
    leaseVersion: 1,
    phase: 'opening' as const,
    leaseExpiresAt: Date.parse('2099-01-01T00:00:00.000Z')
  });
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

const READINESS_CANARY = 'relay-host-readiness-provider-canary';

function mockEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PALANCAR_SECURITY_MODE: 'local-mock',
    PALANCAR_GENERATION_PROVIDER: 'mock',
    PALANCAR_TRANSCRIPTION_PROVIDER: 'mock',
    ...overrides
  };
}

function azureEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PALANCAR_SECURITY_MODE: 'azure-table',
    PALANCAR_RELAY_BIND_HOST: '0.0.0.0',
    PALANCAR_RELAY_ORIGIN: 'wss://relay.example',
    PALANCAR_RELAY_ENVIRONMENT: ENVIRONMENT,
    PALANCAR_WORKLOAD_TABLE_ENDPOINT: 'https://palancartest.table.core.windows.net',
    PALANCAR_SECURITY_STATE_TABLE: 'SecurityState',
    PALANCAR_RATE_STATE_TABLE: 'RateState',
    AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
    PALANCAR_GENERATION_PROVIDER: 'azure-openai',
    PALANCAR_TRANSCRIPTION_PROVIDER: 'mock',
    PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://palancar.openai.azure.com',
    PALANCAR_AZURE_GENERATION_DEPLOYMENT: 'gpt-5.6-luna',
    PALANCAR_DEPLOYMENT_SLOT: 'dev',
    APPLICATIONINSIGHTS_CONNECTION_STRING:
      'InstrumentationKey=11111111-1111-4111-8111-111111111111;' +
      'IngestionEndpoint=https://westus-0.in.applicationinsights.azure.com',
    APPLICATIONINSIGHTS_STATSBEAT_DISABLED: 'true',
    APPLICATION_INSIGHTS_NO_STATSBEAT: 'true',
    ...overrides
  };
}

const VALID_AZURE_TRANSCRIPTION_ENDPOINT =
  'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription';

const allowedPalancarEnvironmentCases: ReadonlyArray<{
  readonly name: string;
  readonly environment: NodeJS.ProcessEnv;
}> = [
  { name: 'PALANCAR_RELAY_ORIGIN', environment: mockEnvironment({ PALANCAR_RELAY_ORIGIN: 'wss://127.0.0.1' }) },
  {
    name: 'PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON',
    environment: mockEnvironment({ PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON: '["https://app.example"]' })
  },
  {
    name: 'PALANCAR_ALLOW_NULL_BROWSER_ORIGIN',
    environment: mockEnvironment({ PALANCAR_ALLOW_NULL_BROWSER_ORIGIN: 'true' })
  },
  { name: 'PALANCAR_SECURITY_MODE', environment: mockEnvironment({ PALANCAR_SECURITY_MODE: 'local-mock' }) },
  {
    name: 'PALANCAR_SECURITY_STATE_TABLE',
    environment: azureEnvironment({ PALANCAR_SECURITY_STATE_TABLE: 'SecurityState' })
  },
  {
    name: 'PALANCAR_RATE_STATE_TABLE',
    environment: azureEnvironment({ PALANCAR_RATE_STATE_TABLE: 'RateState' })
  },
  {
    name: 'PALANCAR_GENERATION_PROVIDER',
    environment: mockEnvironment({ PALANCAR_GENERATION_PROVIDER: 'mock' })
  },
  {
    name: 'PALANCAR_TRANSCRIPTION_PROVIDER',
    environment: mockEnvironment({ PALANCAR_TRANSCRIPTION_PROVIDER: 'mock' })
  },
  {
    name: 'PALANCAR_RELAY_ENVIRONMENT',
    environment: azureEnvironment({ PALANCAR_RELAY_ENVIRONMENT: ENVIRONMENT })
  },
  {
    name: 'PALANCAR_RELAY_BIND_HOST',
    environment: mockEnvironment({ PALANCAR_RELAY_BIND_HOST: '127.0.0.1' })
  },
  {
    name: 'PALANCAR_GATE_POLICY_VERSION',
    environment: mockEnvironment({ PALANCAR_GATE_POLICY_VERSION: GATE_POLICY_VERSION })
  },
  {
    name: 'PALANCAR_WORKLOAD_TABLE_ENDPOINT',
    environment: azureEnvironment({
      PALANCAR_WORKLOAD_TABLE_ENDPOINT: 'https://palancartest.table.core.windows.net'
    })
  },
  {
    name: 'PALANCAR_DEPLOYMENT_SLOT',
    environment: azureEnvironment({ PALANCAR_DEPLOYMENT_SLOT: 'dev' })
  },
  {
    name: 'PALANCAR_LANGUAGE_BOUNDARY_MODE',
    environment: azureEnvironment({ PALANCAR_LANGUAGE_BOUNDARY_MODE: 'deny-all' })
  },
  {
    name: 'PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT',
    environment: azureEnvironment({
      PALANCAR_TRANSCRIPTION_PROVIDER: 'azure-realtime',
      PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT: VALID_AZURE_TRANSCRIPTION_ENDPOINT,
      PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT: 'palancar-transcription'
    })
  },
  {
    name: 'PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT',
    environment: azureEnvironment({
      PALANCAR_TRANSCRIPTION_PROVIDER: 'azure-realtime',
      PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT: VALID_AZURE_TRANSCRIPTION_ENDPOINT,
      PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT: 'palancar-transcription'
    })
  },
  {
    name: 'PALANCAR_AZURE_GENERATION_ENDPOINT',
    environment: azureEnvironment({
      PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://palancar.openai.azure.com'
    })
  },
  {
    name: 'PALANCAR_AZURE_GENERATION_DEPLOYMENT',
    environment: azureEnvironment({
      PALANCAR_AZURE_GENERATION_DEPLOYMENT: 'gpt-5.6-luna'
    })
  }
];

const unknownPalancarEnvironmentCases: ReadonlyArray<{
  readonly mode: 'local-mock' | 'deployed';
  readonly name: string;
  readonly value: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
}> = [
  'PALANCAR_TRANSCRIPTION_API_KEY',
  'PALANCAR_TRANSCRIPTION_ENDPOINT',
  'PALANCAR_RELAY_PORT',
  'PALANCAR_OPENAI_API_KEY',
  'PALANCAR_relay_origin',
  'PALANCAR_RÉLAY_ORIGIN',
  'PALANCAR_RELAY_ORIGIN＿',
  'PALANCAR_RELAY_ORIGIN\u200B',
  'PALANCAR_RELAY_ORIG\u0406N',
  'PALANCAR_😀',
  'PALANCAR_RELAY_ORIGIN_EXTRA',
  'PALANCAR_'
].flatMap((name) => [
  {
    mode: 'local-mock' as const,
    name,
    value: 'namespace-secret',
    environment: mockEnvironment({ [name]: 'namespace-secret' })
  },
  {
    mode: 'deployed' as const,
    name,
    value: 'namespace-secret',
    environment: azureEnvironment({ [name]: 'namespace-secret' })
  }
]);

function hostPort(host: RelayHost): number {
  return (host.server.address() as { readonly port: number }).port;
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

describe('relay host configuration and readiness', () => {
  it('selects fixture only for the exact local composition and deny-all for deployment', () => {
    const local = parseRelayHostConfig(mockEnvironment());
    const deployed = parseRelayHostConfig(azureEnvironment());

    expect(local.languageBoundaryMode).toBe('fixture');
    expect(local.generationService?.validator).toEqual({
      id: 'deterministic-language-fixture',
      version: '1.0.0'
    });
    expect(deployed.languageBoundaryMode).toBe('deny-all');
    expect(deployed.generationProvider).toBe('azure-openai');
    expect(deployed.azureGenerationEndpoint).toBe('https://palancar.openai.azure.com');
    expect(deployed.azureGenerationDeployment).toBe('gpt-5.6-luna');
    expect(deployed.generationService).toBeUndefined();
  });

  it('enables the branded provisional boundary only through an explicit dev setting', () => {
    const config = parseRelayHostConfig(azureEnvironment({
      PALANCAR_LANGUAGE_BOUNDARY_MODE: 'development-provisional'
    }));
    expect(config.languageBoundaryMode).toBe('development-provisional');
    expect(config.deploymentSlot).toBe('dev');
    expect(isDevelopmentProvisionalTextLanguageClassifier(config.languageClassifier)).toBe(true);
    expect(
      isDevelopmentProvisionalGeneratedLanguageValidator(
        config.developmentProvisionalGenerationValidator
      )
    ).toBe(true);
    expect(config.generationService).toBeUndefined();
    expect(() => createRelayHost(config)).not.toThrow();
  });

  it.each(['staging', 'production'] as const)(
    'rejects the provisional boundary in the %s deployment slot',
    (deploymentSlot) => {
      expect(() => parseRelayHostConfig(azureEnvironment({
        PALANCAR_DEPLOYMENT_SLOT: deploymentSlot,
        PALANCAR_LANGUAGE_BOUNDARY_MODE: 'development-provisional'
      }))).toThrow('Invalid relay host configuration.');
    }
  );

  it.each(['dev', 'staging', 'production'] as const)(
    'accepts an exact deny-all boundary in the %s deployment slot',
    (deploymentSlot) => {
      const config = parseRelayHostConfig(azureEnvironment({
        PALANCAR_DEPLOYMENT_SLOT: deploymentSlot,
        PALANCAR_LANGUAGE_BOUNDARY_MODE: 'deny-all'
      }));
      expect(config.languageBoundaryMode).toBe('deny-all');
      expect(config.deploymentSlot).toBe(deploymentSlot);
      expect(() => createRelayHost(config)).not.toThrow();
    }
  );

  it.each(['deny-all', 'development-provisional'] as const)(
    'rejects the explicit %s boundary in local-mock mode',
    (languageBoundaryMode) => {
    expect(() => parseRelayHostConfig(mockEnvironment({
      PALANCAR_LANGUAGE_BOUNDARY_MODE: languageBoundaryMode
    }))).toThrow('Invalid relay host configuration.');
    }
  );

  it('does not invoke the provisional boundary or ELD loader for deny-all host composition', async () => {
    vi.resetModules();
    const boundaryFactory = vi.fn(() => {
      throw new Error('ELD loader must remain unreachable');
    });
    vi.doMock('../src/provisional-language-boundary.js', async () => {
      const actual = await vi.importActual<typeof import('../src/provisional-language-boundary.js')>(
        '../src/provisional-language-boundary.js'
      );
      return {
        ...actual,
        createDevelopmentProvisionalLanguageBoundary: boundaryFactory
      };
    });
    try {
      const isolatedHost = await import('../src/host.js');
      const config = isolatedHost.parseRelayHostConfig(azureEnvironment({
        PALANCAR_LANGUAGE_BOUNDARY_MODE: 'deny-all'
      }));
      expect(config.languageBoundaryMode).toBe('deny-all');
      expect(config.generationService).toBeUndefined();
      expect(boundaryFactory).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../src/provisional-language-boundary.js');
      vi.resetModules();
    }
  });

  it('requires the exact branded provisional validator identity used by GenerationService', () => {
    const base = parseRelayHostConfig(azureEnvironment({
      PALANCAR_LANGUAGE_BOUNDARY_MODE: 'development-provisional'
    }));
    const trusted = base.developmentProvisionalGenerationValidator;
    if (trusted === undefined) throw new Error('trusted provisional validator required');
    const counterfeit: GeneratedLanguageValidator = Object.freeze({
      id: trusted.id,
      version: trusted.version,
      validate: trusted.validate
    });
    const complete = vi.fn(async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'must-not-release',
      suggestions: [
        { englishText: 'one', selectedTargetText: 'uno' },
        { englishText: 'two', selectedTargetText: 'dos' }
      ]
    }));
    const service = new GenerationService({
      provider: {
        id: 'azure-openai-chat',
        version: '1.0.0',
        complete
      },
      validator: counterfeit,
      languageValidationMode: 'development-provisional'
    });
    expect(service.usesValidator(counterfeit)).toBe(true);
    expect(service.usesValidator(trusted)).toBe(false);
    expect(() => createRelayHost({ ...base, generationService: service })).toThrow(
      'Invalid relay host configuration.'
    );
    expect(complete).not.toHaveBeenCalled();

    const exactBoundary = createDevelopmentProvisionalLanguageBoundary();
    const exactService = new GenerationService({
      provider: new DeterministicMockProvider({
        id: 'azure-openai-chat',
        complete: { result: {
          englishTranslation: 'unused',
          suggestions: [
            { englishText: 'one', selectedTargetText: 'uno' },
            { englishText: 'two', selectedTargetText: 'dos' }
          ]
        } }
      }),
      validator: exactBoundary.generatedLanguageValidator,
      languageValidationMode: 'development-provisional'
    });
    expect(exactService.usesValidator(exactBoundary.generatedLanguageValidator)).toBe(true);
  });

  it('rejects caller-owned Azure generation service and readiness contracts', () => {
    const base = parseRelayHostConfig(azureEnvironment());
    const service = new GenerationService({
      provider: {
        id: 'azure-openai-chat',
        version: '1.0.0',
        complete: async () => ({
          englishTranslation: 'unused',
          suggestions: [
            { englishText: 'unused', selectedTargetText: 'unused' },
            { englishText: 'unused', selectedTargetText: 'unused' }
          ]
        })
      },
      validator: new FailClosedGeneratedLanguageValidator()
    });
    expect(() => createRelayHostImplementation({
      ...base,
      generationService: service
    })).toThrow('Invalid relay host configuration.');
    expect(() => createRelayHostImplementation({
      ...base,
      generationReadiness: {
        provider: 'azure-openai-chat',
        providerId: 'azure-openai-chat',
        model: 'gpt-5.6-luna',
        check: async () => true
      }
    })).toThrow('Invalid relay host configuration.');
  });

  it('rejects a missing explicit generation mode before executable composition', () => {
    const config = {
      environment: 'local-mock',
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security: {
        ...createTestHostSecurityComposition(),
        mode: 'local-mock' as const
      },
      languageBoundaryMode: 'fixture' as const
    };
    expect(() => createRelayHostImplementation(config)).toThrow(
      'Invalid relay host configuration.'
    );
  });

  it('rejects unsafe Azure factory results without invoking hostile fields or leaking rollback state', () => {
    const base = parseRelayHostConfig(azureEnvironment());
    const complete = async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'unused',
      suggestions: [
        { englishText: 'unused', selectedTargetText: 'unused' },
        { englishText: 'unused', selectedTargetText: 'unused' }
      ]
    });
    const candidates: Array<{
      readonly name: string;
      readonly value: () => unknown;
      readonly invoked: () => boolean;
    }> = [];
    candidates.push({
      name: 'proxy',
      value: () => new Proxy({ id: 'azure-openai-chat', version: '1.0.0', complete }, {}),
      invoked: () => false
    });
    for (const field of ['id', 'version', 'complete'] as const) {
      let invoked = false;
      const candidate: Record<string, unknown> = {
        id: 'azure-openai-chat',
        version: '1.0.0',
        complete
      };
      Object.defineProperty(candidate, field, {
        enumerable: true,
        get: () => {
          invoked = true;
          throw new Error('factory field canary');
        }
      });
      candidates.push({ name: `${field} accessor`, value: () => candidate, invoked: () => invoked });
    }

    for (const candidate of candidates) {
      const tokenClose = vi.fn();
      expect(() => createRelayHostImplementation({
        ...base,
        azureTokenSourceFactory: () => ({
          tokenProvider: async () => ({
            token: 'unused',
            expiresOnTimestamp: Date.now() + 600_000
          }),
          close: tokenClose
        }),
        azureGenerationProviderFactory: () => candidate.value() as GenerationProvider
      })).toThrow('Invalid relay host configuration.');
      expect(candidate.invoked(), candidate.name).toBe(false);
      expect(tokenClose, candidate.name).toHaveBeenCalledTimes(1);
    }
  });

  it('does not perform fetch or token-source work while parsing', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(() => parseRelayHostConfig(azureEnvironment())).not.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each(allowedPalancarEnvironmentCases)(
    'accepts the supported PALANCAR_ namespace key: $name',
    ({ environment }) => {
      expect(() => parseRelayHostConfig(environment)).not.toThrow();
    }
  );

  it.each(unknownPalancarEnvironmentCases)(
    'rejects the unknown $mode PALANCAR_ namespace key: $name',
    ({ environment, name, value }) => {
      let thrown: unknown;
      try {
        parseRelayHostConfig(environment);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect(thrown).toMatchObject({ message: 'Invalid relay host configuration.' });
      if (thrown instanceof Error) {
        expect(thrown.message).not.toContain(name);
        expect(thrown.message).not.toContain(value);
      }
    }
  );

  it.each([
    ['boundary selector', { PALANCAR_LANGUAGE_BOUNDARY_MODE: 'production-approved' }],
    ['OTLP exporter', { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4317' }],
    ['Azure API key', { AZURE_OPENAI_API_KEY: 'secret' }]
  ])('rejects local environment contamination: %s', (_label, override) => {
    expect(() => parseRelayHostConfig(mockEnvironment(override))).toThrow(
      'Invalid relay host configuration.'
    );
  });

  it.each([
    ['missing Statsbeat prerequisite', { APPLICATION_INSIGHTS_NO_STATSBEAT: undefined }],
    ['wrong Statsbeat prerequisite', { APPLICATIONINSIGHTS_STATSBEAT_DISABLED: 'false' }],
    ['raw OTLP exporter', { PALANCAR_OTLP_ENDPOINT: 'http://127.0.0.1:4317' }],
    ['Azure transcription API key', { PALANCAR_AZURE_TRANSCRIPTION_API_KEY: 'secret' }]
  ])('rejects deployed environment contamination: %s', (_label, override) => {
    expect(() => parseRelayHostConfig(azureEnvironment(override))).toThrow(
      'Invalid relay host configuration.'
    );
  });

  it('accepts only the fixed Azure generation environment and defers provider construction', () => {
    const config = parseRelayHostConfig(azureEnvironment());
    expect(config.generationProvider).toBe('azure-openai');
    expect(config.azureGenerationEndpoint).toBe('https://palancar.openai.azure.com');
    expect(config.azureGenerationDeployment).toBe('gpt-5.6-luna');
    expect(config.generationService).toBeUndefined();
    expect(config.generationReadiness).toBeUndefined();
  });

  it.each([
    ['missing endpoint', { PALANCAR_AZURE_GENERATION_ENDPOINT: undefined }],
    ['uppercase scheme', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'HTTPS://palancar.openai.azure.com' }],
    ['uppercase host', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://Palancar.openai.azure.com' }],
    ['trailing slash', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://palancar.openai.azure.com/' }],
    ['port', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://palancar.openai.azure.com:443' }],
    ['path', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://palancar.openai.azure.com/openai' }],
    ['query', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://palancar.openai.azure.com?x=1' }],
    ['fragment', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://palancar.openai.azure.com#x' }],
    ['userinfo', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://user@palancar.openai.azure.com' }],
    ['wrong suffix', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://palancar.openai.azure.net' }],
    ['doubled suffix', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://palancar.openai.azure.com.openai.azure.com' }],
    ['whitespace', { PALANCAR_AZURE_GENERATION_ENDPOINT: ' https://palancar.openai.azure.com' }]
  ])('rejects Azure generation endpoint lookalike: %s', (_label, override) => {
    expect(() => parseRelayHostConfig(azureEnvironment(override))).toThrow(
      'Invalid relay host configuration.'
    );
  });

  it.each([
    ['missing deployment', { PALANCAR_AZURE_GENERATION_DEPLOYMENT: undefined }],
    ['wrong model', { PALANCAR_AZURE_GENERATION_DEPLOYMENT: 'gpt-5.6-luna2' }],
    ['wrong case', { PALANCAR_AZURE_GENERATION_DEPLOYMENT: 'GPT-5.6-LUNA' }],
    ['trailing whitespace', { PALANCAR_AZURE_GENERATION_DEPLOYMENT: 'gpt-5.6-luna ' }],
    ['leading whitespace', { PALANCAR_AZURE_GENERATION_DEPLOYMENT: ' gpt-5.6-luna' }],
    ['version lookalike', { PALANCAR_AZURE_GENERATION_DEPLOYMENT: 'gpt-5.6-luna-2026-07-09' }]
  ])('rejects Azure generation deployment lookalike: %s', (_label, override) => {
    expect(() => parseRelayHostConfig(azureEnvironment(override))).toThrow(
      'Invalid relay host configuration.'
    );
  });

  it.each([
    'PALANCAR_LITELLM_API_KEY',
    'PALANCAR_LITELLM_BASE_URL',
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'LITELLM_MASTER_KEY',
    'OPENAI_API_KEY',
    'OPENAI_API_VERSION',
    'OPENAI_SCOPE',
    'AZURE_FOUNDRY_TOKEN_SCOPE',
    'AZURE_OPENAI_TOKEN_SCOPE',
    'OPENAI_BASE_URL',
    'OPENAI_ORGANIZATION',
    'OPENAI_MODEL',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_API_VERSION',
    'AZURE_OPENAI_SCOPE',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_DEPLOYMENT',
    'AZURE_OPENAI_RESOURCE',
    'AZURE_API_KEY',
    'PALANCAR_GENERATION_ENDPOINT',
    'PALANCAR_GENERATION_DEPLOYMENT',
    'PALANCAR_GENERATION_MODEL',
    'PALANCAR_GENERATION_API_KEY',
    'PALANCAR_AZURE_GENERATION_SCOPE',
    'PALANCAR_AZURE_GENERATION_API_VERSION',
    'PALANCAR_GENERATION_SCOPE',
    'PALANCAR_GENERATION_API_VERSION',
    'PALANCAR_AZURE_GENERATION_API_KEY',
    'PALANCAR_AZURE_GENERATION_MODEL'
  ])('rejects retired keys and configurable Azure generation names in deployed parsing: %s', (name) => {
    expect(() => parseRelayHostConfig(azureEnvironment({ [name]: 'secret' }))).toThrow(
      'Invalid relay host configuration.'
    );
  });

  it.each([
    'PALANCAR_LITELLM_API_KEY',
    'OPENROUTER_API_KEY',
    'OPENROUTER_MODEL',
    'LITELLM_MASTER_KEY',
    'OPENAI_API_KEY',
    'OPENAI_API_VERSION',
    'OPENAI_SCOPE',
    'AZURE_FOUNDRY_TOKEN_SCOPE',
    'AZURE_OPENAI_TOKEN_SCOPE',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_DEPLOYMENT',
    'AZURE_API_KEY',
    'PALANCAR_GENERATION_ENDPOINT',
    'PALANCAR_GENERATION_DEPLOYMENT',
    'PALANCAR_AZURE_GENERATION_SCOPE'
  ])('rejects retired keys and configurable Azure generation names in local parsing: %s', (name) => {
    expect(() => parseRelayHostConfig(mockEnvironment({ [name]: 'secret' }))).toThrow(
      'Invalid relay host configuration.'
    );
  });

  it('permits only the explicit generation provider selector in the generation namespace', () => {
    expect(() => parseRelayHostConfig(mockEnvironment({
      PALANCAR_GENERATION_PROVIDER: 'mock'
    }))).not.toThrow();
    expect(() => parseRelayHostConfig(azureEnvironment({
      PALANCAR_GENERATION_PROVIDER: 'azure-openai'
    }))).not.toThrow();
  });

  it.each([
    'PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT',
    'PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT'
  ])('rejects Azure transcription settings for mock transcription: %s', (name) => {
    expect(() => parseRelayHostConfig(azureEnvironment({
      [name]: name.endsWith('ENDPOINT')
        ? 'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription'
        : 'palancar-transcription'
    }))).toThrow('Invalid relay host configuration.');
  });

  it('permits the exact Azure transcription pair only for azure-realtime', () => {
    const config = parseRelayHostConfig(azureEnvironment({
      PALANCAR_TRANSCRIPTION_PROVIDER: 'azure-realtime',
      PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT: VALID_AZURE_TRANSCRIPTION_ENDPOINT,
      PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT: 'palancar-transcription'
    }));
    expect(config.transcriptionProvider).toBe('azure-realtime');
    expect(config.azureTranscriptionDeployment).toBe('palancar-transcription');
  });

  it('enforces the 63-character Azure transcription DNS label boundary', () => {
    const endpointForLabel = (label: string): string =>
      `wss://${label}.openai.azure.com/openai/v1/realtime?intent=transcription`;
    const acceptedEndpoint = endpointForLabel('a'.repeat(63));
    const rejectedEndpoint = endpointForLabel('a'.repeat(64));
    const base = {
      PALANCAR_TRANSCRIPTION_PROVIDER: 'azure-realtime' as const,
      PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT: 'palancar-transcription'
    };

    const accepted = parseRelayHostConfig(azureEnvironment({
      ...base,
      PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT: acceptedEndpoint
    }));
    expect(accepted.azureTranscriptionEndpoint).toBe(acceptedEndpoint);
    expect(() => parseRelayHostConfig(azureEnvironment({
      ...base,
      PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT: rejectedEndpoint
    }))).toThrow('Invalid relay host configuration.');
  });

  it.each([
    ['uppercase scheme', 'WSS://palancar.openai.azure.com/openai/v1/realtime?intent=transcription'],
    ['uppercase host', 'wss://Palancar.openai.azure.com/openai/v1/realtime?intent=transcription'],
    ['wrong suffix', 'wss://palancar.openai.azure.net/openai/v1/realtime?intent=transcription'],
    ['wrong path', 'wss://palancar.openai.azure.com/openai/v1/realtime'],
    ['wrong query', 'wss://palancar.openai.azure.com/openai/v1/realtime?intent=generation']
  ])('preserves canonical Azure transcription endpoint rules: %s', (_label, endpoint) => {
    expect(() => parseRelayHostConfig(azureEnvironment({
      PALANCAR_TRANSCRIPTION_PROVIDER: 'azure-realtime',
      PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT: endpoint,
      PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT: 'palancar-transcription'
    }))).toThrow('Invalid relay host configuration.');
  });

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

  it('rejects fixture and fail-closed identities from future production-approved injection', () => {
    const base = parseRelayHostConfig(azureEnvironment());
    const fixture = parseRelayHostConfig(mockEnvironment());
    const classifier = createFailClosedDeployedTextLanguageClassifier();
    const fixtureGenerationService = fixture.generationService;
    if (fixtureGenerationService === undefined) {
      throw new Error('fixture generation service is required');
    }
    const failClosedGenerationService = new GenerationService({
      provider: new DeterministicMockProvider({
        id: 'future-production-provider',
        version: '1.0.0',
        complete: {
          result: {
            englishTranslation: 'A phrase translated to English.',
            suggestions: [
              { englishText: 'Yes.', selectedTargetText: 'Sí.' },
              { englishText: 'No.', selectedTargetText: 'No.' }
            ]
          }
        }
      }),
      validator: new FailClosedGeneratedLanguageValidator()
    });
    const disguisedFixtureValidator = new DeterministicFixtureLanguageValidator({
      id: 'approved-generated-language'
    });
    const disguisedFixtureService = new GenerationService({
      provider: new DeterministicMockProvider({
        id: 'future-production-provider',
        complete: {
          result: {
            englishTranslation: 'unused',
            suggestions: [
              { englishText: 'one', selectedTargetText: 'uno' },
              { englishText: 'two', selectedTargetText: 'dos' }
            ]
          }
        }
      }),
      validator: disguisedFixtureValidator
    });

    expect(() => createRelayHostProduction({
      ...base,
      languageBoundaryMode: 'production-approved',
      languageClassifier: classifier,
      generationService: fixtureGenerationService
    })).toThrow('Invalid relay host configuration.');
    expect(() => createRelayHostProduction({
      ...base,
      languageBoundaryMode: 'production-approved',
      languageClassifier: createTestOptions().languageClassifier
    })).toThrow('Invalid relay host configuration.');
    expect(() => createRelayHostProduction({
      ...base,
      languageBoundaryMode: 'production-approved',
      languageClassifier: {
        ready: Promise.resolve(),
        classify: async () => ({
          status: 'unavailable' as const,
          detectorVersion: 'future-calibrated-classifier'
        })
      },
      generationService: failClosedGenerationService
    })).toThrow('Invalid relay host configuration.');
    expect(() => createRelayHostProduction({
      ...base,
      languageBoundaryMode: 'production-approved',
      languageClassifier: {
        ready: Promise.resolve(),
        classify: async () => ({
          status: 'unavailable' as const,
          detectorVersion: 'future-calibrated-classifier'
        })
      },
      generationService: disguisedFixtureService,
      productionApprovedGenerationValidator: disguisedFixtureValidator
    })).toThrow('Invalid relay host configuration.');
  });

  it('parses and freezes the browser origin policy, including fail-closed defaults', () => {
    const defaults = parseRelayHostConfig(mockEnvironment());
    expect(defaults.browserOriginPolicy).toEqual({
      allowedOrigins: [],
      allowNullOrigin: false
    });
    expect(Object.isFrozen(defaults.browserOriginPolicy)).toBe(true);
    expect(Object.isFrozen(defaults.browserOriginPolicy?.allowedOrigins)).toBe(true);

    const configured = parseRelayHostConfig(mockEnvironment({
      PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON: '["https://app.example"]',
      PALANCAR_ALLOW_NULL_BROWSER_ORIGIN: 'true'
    }));
    expect(configured.browserOriginPolicy).toEqual({
      allowedOrigins: ['https://app.example'],
      allowNullOrigin: true
    });
    expect(Object.isFrozen(configured.browserOriginPolicy)).toBe(true);
    expect(Object.isFrozen(configured.browserOriginPolicy?.allowedOrigins)).toBe(true);

    expect(() => parseRelayHostConfig(mockEnvironment({
      PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON: '["http://app.example"]'
    }))).toThrow('Invalid relay host configuration.');
  });

  it('validates and snapshots direct browser origin policy options', async () => {
    const policy = {
      allowedOrigins: ['https://app.example'],
      allowNullOrigin: false
    };
    const host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      browserOriginPolicy: policy
    });
    policy.allowedOrigins[0] = 'https://evil.example';
    policy.allowNullOrigin = true;
    await host.start();
    try {
      const url = `http://127.0.0.1:${hostPort(host)}/healthz`;
      const accepted = await fetch(url, { headers: { origin: 'https://app.example' } });
      const mutated = await fetch(url, { headers: { origin: 'https://evil.example' } });
      const nullOrigin = await fetch(url, { headers: { origin: 'null' } });
      expect(accepted.status).toBe(200);
      expect(mutated.status).toBe(403);
      expect(nullOrigin.status).toBe(403);
    } finally {
      await host.stop();
    }

    expect(() => createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      browserOriginPolicy: {
        allowedOrigins: ['http://app.example'],
        allowNullOrigin: false
      }
    })).toThrow('Invalid relay host configuration.');
  });

  it('accepts only the privately branded built-in generation service in local-mock mode', async () => {
    const builtInConfig = parseRelayHostConfig(mockEnvironment({ PORT: '0' }));
    const localHost = createRelayHostProduction(builtInConfig);
    await localHost.stop();

    const customService = new GenerationService({
      provider: new DeterministicMockProvider({
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
      }),
      validator: new DeterministicFixtureLanguageValidator()
    });
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
    expect(() => parseRelayHostConfig({})).not.toThrow('secret');
  });

  it.each([
    ['non-loopback bind', { PALANCAR_RELAY_BIND_HOST: '0.0.0.0' }],
    ['non-loopback origin', { PALANCAR_RELAY_ORIGIN: 'wss://relay.example' }],
    ['retired provider setting', { PALANCAR_LITELLM_API_KEY: 'secret' }],
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
    expect(() => parseRelayHostConfig(azureEnvironment(override))).toThrow(
      'Invalid relay host configuration.'
    );
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
      metricSink: productionTestMetricSink(),
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
      transcriptionAdapters: {
        es: createReadinessAdapter(check),
        tr: createReadinessAdapter(check)
      },
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
    const readinessStarted = createDeferred();
    const host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapters: {
        es: createReadinessAdapter(
          () => {
            readinessStarted.resolve();
            return new Promise(() => undefined);
          }
        ),
        tr: createReadinessAdapter(
          () => new Promise(() => undefined)
        )
      },
      languageClassifier: observingControlledClassifier(() => undefined)
    });
    await host.start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const readyRequest = fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
      await readinessStarted.promise;
      await vi.advanceTimersByTimeAsync(6_000);
      const ready = await readyRequest;
      expect(ready.status).toBe(503);
      expect(await responseJson(ready)).toEqual({ ready: false });
      vi.useRealTimers();
      const health = await fetch(`http://127.0.0.1:${hostPort(host)}/healthz`);
      expect(health.status).toBe(200);
      expect(await responseJson(health)).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
      await host.stop();
    }
  });

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
        environment: 'local-mock',
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
    10_000
  );

  it('fails readiness when lazy provisional detector initialization is malformed', async () => {
    let loads = 0;
    const boundary = createDevelopmentProvisionalLanguageBoundary({
      loadDetector: () => {
        loads += 1;
        return Object.freeze({
          detect: () => ({
            language: 'en',
            getScores: () => ({ en: Number.NaN }),
            isReliable: () => true
          })
        });
      }
    });
    expect(loads).toBe(0);
    const host = createRelayHost({
      environment: 'local-mock',
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      languageClassifier: boundary.classifier
    });
    expect(loads).toBe(0);
    await host.start();
    try {
      const ready = await fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
      expect(ready.status).toBe(503);
      expect(await responseJson(ready)).toEqual({ ready: false });
      expect(loads).toBe(1);
    } finally {
      await host.stop();
    }
  });

  it('requires an explicit classifier for non-default transcription adapters', () => {
    expect(() => createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapters: {
        es: createAsyncCallbackAdapter(),
        tr: createAsyncCallbackAdapter()
      }
    })).toThrow('Invalid relay host configuration.');
  });

  it('rejects a branded controlled classifier paired with a non-mock adapter', () => {
    expect(() => createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapters: {
        es: createAsyncCallbackAdapter(),
        tr: createAsyncCallbackAdapter()
      },
      languageClassifier: createTestOptions().languageClassifier
    })).toThrow('Invalid relay host configuration.');
  });

  it('allows the branded controlled classifier with an actual deterministic mock adapter', async () => {
    const host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapters: {
        es: new DeterministicMockTranscriptionAdapter({
          evidenceCategory: 'selected-target',
          fixtureTargetLanguage: 'es'
        }),
        tr: new DeterministicMockTranscriptionAdapter({
          evidenceCategory: 'selected-target',
          fixtureTargetLanguage: 'tr'
        })
      },
      languageClassifier: createTestOptions().languageClassifier
    });
    await host.stop();
  });

  it('serializes start and stop lifecycle transitions and permanently rejects restart', async () => {
    const host = createRelayHostProduction(parseRelayHostConfig(mockEnvironment({ PORT: '0' })));
    expect(host.lifecycleState).toBe('created');

    const firstStart = host.start();
    const secondStart = host.start();
    expect(secondStart).toBe(firstStart);
    await expect(firstStart).resolves.toEqual({ port: expect.any(Number) });
    expect(host.lifecycleState).toBe('running');

    const firstStop = host.stop();
    const secondStop = host.stop();
    expect(secondStop).toBe(firstStop);
    expect(host.lifecycleState).toBe('stopping');
    await firstStop;
    expect(host.lifecycleState).toBe('stopped');
    expect(host.server.listening).toBe(false);
    await expect(host.start()).rejects.toThrow('relay_start_rejected');
  });

  it('settles start/stop and stop/start races without leaving a listening handle', async () => {
    const startingHost = createRelayHostProduction(parseRelayHostConfig(mockEnvironment({ PORT: '0' })));
    const starting = startingHost.start();
    const stopping = startingHost.stop();
    await expect(starting).rejects.toThrow('relay_start_failed');
    await expect(stopping).resolves.toBeUndefined();
    expect(startingHost.lifecycleState).toBe('stopped');
    expect(startingHost.server.listening).toBe(false);

    const neverStartedHost = createRelayHostProduction(
      parseRelayHostConfig(mockEnvironment({ PORT: '0' }))
    );
    const stopped = neverStartedHost.stop();
    await expect(neverStartedHost.start()).rejects.toThrow('relay_start_rejected');
    await stopped;
    expect(neverStartedHost.lifecycleState).toBe('stopped');
    expect(neverStartedHost.server.listening).toBe(false);
  });

  it('rolls a listen failure back to terminal stopped state without an open handle', async () => {
    const blocker = createHttpServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => resolve());
    });
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('missing blocker port');
    const host = createRelayHostProduction(parseRelayHostConfig(mockEnvironment({
      PORT: String(address.port),
      PALANCAR_RELAY_ORIGIN: `wss://127.0.0.1:${address.port}`
    })));
    try {
      await expect(host.start()).rejects.toThrow('relay_start_failed');
      expect(host.lifecycleState).toBe('stopped');
      expect(host.server.listening).toBe(false);
      await expect(host.stop()).resolves.toBeUndefined();
      await expect(host.start()).rejects.toThrow('relay_start_rejected');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('rejects hostile discriminants before invoking any composition factory', () => {
    const securityFactory = vi.fn(() => testSecurityWith());
    const tokenFactory = vi.fn(() => ({
      tokenProvider: async () => ({ token: 'unused', expiresOnTimestamp: Date.now() + 600_000 }),
      close: vi.fn()
    }));
    const adapterFactory = vi.fn(() => {
      throw new Error('must not run');
    });
    const metricFactory = vi.fn(() => productionTestMetricSink());
    expect(() => createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      securityMode: 'azure-table',
      securityFactory,
      languageBoundaryMode: 'unknown' as NonNullable<RelayHostConfig['languageBoundaryMode']>,
      transcriptionProvider: 'azure-realtime',
      managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
      azureTranscriptionEndpoint:
        'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription',
      azureTranscriptionDeployment: 'palancar-transcription',
      azureTokenSourceFactory: tokenFactory,
      azureTranscriptionAdapterFactory: adapterFactory,
      metricSinkFactory: metricFactory
    })).toThrow('Invalid relay host configuration.');
    expect(securityFactory).not.toHaveBeenCalled();
    expect(tokenFactory).not.toHaveBeenCalled();
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(metricFactory).not.toHaveBeenCalled();
  });

  it('enforces exact telemetry composition without touching rejected sinks', () => {
    const localShutdown = vi.fn(async () => undefined);
    const localSink = {
      record: () => undefined,
      checkReadiness: async () => true,
      shutdown: localShutdown
    } as NonNullable<RelayHostConfig['metricSink']>;
    expect(() => createRelayHostProduction({
      ...parseRelayHostConfig(mockEnvironment()),
      metricSink: localSink
    })).toThrow('Invalid relay host configuration.');
    expect(localShutdown).not.toHaveBeenCalled();

    const production = {
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security: testSecurityWith()
    } satisfies RelayHostConfig;
    expect(() => createRelayHostProduction(production)).toThrow(
      'Invalid relay host configuration.'
    );
    expect(() => createRelayHostProduction({
      ...production,
      metricSink: productionTestMetricSink(),
      metricSinkFactory: () => productionTestMetricSink()
    })).toThrow('Invalid relay host configuration.');
  });

  it('allows only the exact disabled telemetry singleton for local composition', async () => {
    const inheritedDisabledSink = Object.create(
      createDisabledRelayMetricSink()
    ) as NonNullable<RelayHostConfig['metricSink']>;
    expect(() => createRelayHostProduction({
      ...parseRelayHostConfig(mockEnvironment()),
      metricSink: inheritedDisabledSink
    })).toThrow('Invalid relay host configuration.');

    const host = createRelayHostProduction({
      ...parseRelayHostConfig(mockEnvironment({ PORT: '0' })),
      metricSink: createDisabledRelayMetricSink()
    });
    await host.start();
    try {
      const ready = await fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
      expect(ready.status).toBe(200);
    } finally {
      await host.stop();
    }
  });

  it('rejects a direct disabled sink before any deployed resource or readiness can start', () => {
    const securityFactory = vi.fn(() => testSecurityWith());
    const tokenFactory = vi.fn(() => ({
      tokenProvider: async () => ({ token: 'unused', expiresOnTimestamp: Date.now() + 600_000 }),
      close: vi.fn()
    }));
    const adapterFactory = vi.fn(() => {
      throw new Error('must not run');
    });
    const provider = new DeterministicMockProvider();
    let host: RelayHost | undefined;

    expect(() => {
      host = createRelayHostProduction({
        environment: ENVIRONMENT,
        origin: ORIGIN,
        port: 0,
        gatePolicyVersion: GATE_POLICY_VERSION,
        securityMode: 'azure-table',
        securityFactory,
        languageBoundaryMode: 'deny-all',
        generationService: new GenerationService({
          provider,
          validator: new FailClosedGeneratedLanguageValidator()
        }),
        transcriptionProvider: 'azure-realtime',
        managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
        azureTranscriptionEndpoint:
          'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription',
        azureTranscriptionDeployment: 'palancar-transcription',
        azureTokenSourceFactory: tokenFactory,
        azureTranscriptionAdapterFactory: adapterFactory,
        metricSink: createDisabledRelayMetricSink()
      });
    }).toThrow('Invalid relay host configuration.');

    expect(host).toBeUndefined();
    expect(securityFactory).not.toHaveBeenCalled();
    expect(tokenFactory).not.toHaveBeenCalled();
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(provider.completeCalls).toBe(0);
  });

  it('rejects an inherited disabled sink during pure deployed validation', () => {
    const securityFactory = vi.fn(() => testSecurityWith());
    const tokenFactory = vi.fn(() => ({
      tokenProvider: async () => ({ token: 'unused', expiresOnTimestamp: Date.now() + 600_000 }),
      close: vi.fn()
    }));
    const adapterFactory = vi.fn(() => {
      throw new Error('must not run');
    });
    const provider = new DeterministicMockProvider();
    const inheritedDisabledSink = Object.create(
      createDisabledRelayMetricSink()
    ) as NonNullable<RelayHostConfig['metricSink']>;

    expect(() => createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      securityMode: 'azure-table',
      securityFactory,
      languageBoundaryMode: 'deny-all',
      generationService: new GenerationService({
        provider,
        validator: new FailClosedGeneratedLanguageValidator()
      }),
      transcriptionProvider: 'azure-realtime',
      managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
      azureTranscriptionEndpoint:
        'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription',
      azureTranscriptionDeployment: 'palancar-transcription',
      azureTokenSourceFactory: tokenFactory,
      azureTranscriptionAdapterFactory: adapterFactory,
      metricSink: inheritedDisabledSink
    })).toThrow('Invalid relay host configuration.');

    expect(securityFactory).not.toHaveBeenCalled();
    expect(tokenFactory).not.toHaveBeenCalled();
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(provider.completeCalls).toBe(0);
  });

  it('evaluates a disabled telemetry factory before every deployed resource factory', () => {
    const metricFactory = vi.fn(() => createDisabledRelayMetricSink());
    const securityFactory = vi.fn(() => testSecurityWith());
    const tokenFactory = vi.fn(() => ({
      tokenProvider: async () => ({ token: 'unused', expiresOnTimestamp: Date.now() + 600_000 }),
      close: vi.fn()
    }));
    const adapterFactory = vi.fn(() => {
      throw new Error('must not run');
    });
    const provider = new DeterministicMockProvider();
    let host: RelayHost | undefined;

    expect(() => {
      host = createRelayHostProduction({
        environment: ENVIRONMENT,
        origin: ORIGIN,
        port: 0,
        gatePolicyVersion: GATE_POLICY_VERSION,
        securityMode: 'azure-table',
        securityFactory,
        languageBoundaryMode: 'deny-all',
        generationService: new GenerationService({
          provider,
          validator: new FailClosedGeneratedLanguageValidator()
        }),
        transcriptionProvider: 'azure-realtime',
        managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
        azureTranscriptionEndpoint:
          'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription',
        azureTranscriptionDeployment: 'palancar-transcription',
        azureTokenSourceFactory: tokenFactory,
        azureTranscriptionAdapterFactory: adapterFactory,
        metricSinkFactory: metricFactory
      });
    }).toThrow('Invalid relay host configuration.');

    expect(host).toBeUndefined();
    expect(metricFactory).toHaveBeenCalledTimes(1);
    expect(securityFactory).not.toHaveBeenCalled();
    expect(tokenFactory).not.toHaveBeenCalled();
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(provider.completeCalls).toBe(0);
  });

  it('rejects a deeply inherited disabled factory result before downstream acquisition', () => {
    const inheritedDisabledSink = Object.create(Object.create(
      createDisabledRelayMetricSink()
    )) as NonNullable<RelayHostConfig['metricSink']>;
    const metricFactory = vi.fn(() => inheritedDisabledSink);
    const securityFactory = vi.fn(() => testSecurityWith());
    const tokenFactory = vi.fn(() => ({
      tokenProvider: async () => ({ token: 'unused', expiresOnTimestamp: Date.now() + 600_000 }),
      close: vi.fn()
    }));
    const adapterFactory = vi.fn(() => {
      throw new Error('must not run');
    });
    const provider = new DeterministicMockProvider();

    expect(() => createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      securityMode: 'azure-table',
      securityFactory,
      languageBoundaryMode: 'deny-all',
      generationService: new GenerationService({
        provider,
        validator: new FailClosedGeneratedLanguageValidator()
      }),
      transcriptionProvider: 'azure-realtime',
      managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
      azureTranscriptionEndpoint:
        'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription',
      azureTranscriptionDeployment: 'palancar-transcription',
      azureTokenSourceFactory: tokenFactory,
      azureTranscriptionAdapterFactory: adapterFactory,
      metricSinkFactory: metricFactory
    })).toThrow('Invalid relay host configuration.');

    expect(metricFactory).toHaveBeenCalledTimes(1);
    expect(securityFactory).not.toHaveBeenCalled();
    expect(tokenFactory).not.toHaveBeenCalled();
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(provider.completeCalls).toBe(0);
  });

  it('contains an early telemetry factory throw without acquiring other resources', () => {
    const metricFactory = vi.fn(() => {
      throw new Error('secret telemetry factory failure');
    });
    const securityFactory = vi.fn(() => testSecurityWith());
    const tokenFactory = vi.fn(() => ({
      tokenProvider: async () => ({ token: 'unused', expiresOnTimestamp: Date.now() + 600_000 }),
      close: vi.fn()
    }));
    const adapterFactory = vi.fn(() => {
      throw new Error('must not run');
    });

    expect(() => createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      securityMode: 'azure-table',
      securityFactory,
      languageBoundaryMode: 'deny-all',
      transcriptionProvider: 'azure-realtime',
      managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
      azureTranscriptionEndpoint:
        'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription',
      azureTranscriptionDeployment: 'palancar-transcription',
      azureTokenSourceFactory: tokenFactory,
      azureTranscriptionAdapterFactory: adapterFactory,
      metricSinkFactory: metricFactory
    })).toThrow('Invalid relay host configuration.');

    expect(metricFactory).toHaveBeenCalledTimes(1);
    expect(securityFactory).not.toHaveBeenCalled();
    expect(tokenFactory).not.toHaveBeenCalled();
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it('rolls back early telemetry and later token/adapter acquisition in safe order', async () => {
    const firstOrder: string[] = [];
    const firstTokenClose = vi.fn(() => firstOrder.push('token'));
    const firstMetricShutdown = vi.fn(async () => {
      firstOrder.push('telemetry');
    });
    const metricFactory = vi.fn(() => ({
      ...productionTestMetricSink(),
      shutdown: firstMetricShutdown
    }));
    expect(() => createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security: testSecurityWith(),
      languageBoundaryMode: 'deny-all',
      transcriptionProvider: 'azure-realtime',
      managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
      azureTranscriptionEndpoint:
        'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription',
      azureTranscriptionDeployment: 'palancar-transcription',
      azureTokenSourceFactory: () => ({
        tokenProvider: async () => ({ token: 'unused', expiresOnTimestamp: Date.now() + 600_000 }),
        close: firstTokenClose
      }),
      azureTranscriptionAdapterFactory: () => {
        throw new Error('adapter acquisition failed');
      },
      metricSinkFactory: metricFactory
    })).toThrow('Invalid relay host configuration.');
    expect(firstTokenClose).toHaveBeenCalledTimes(1);
    expect(metricFactory).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(firstMetricShutdown).toHaveBeenCalledTimes(1));
    expect(firstOrder).toEqual(['token', 'telemetry']);

    const order: string[] = [];
    const tokenProvider: AzureTokenProvider = async (signal) => {
      void signal;
      return {
        token: 'unused',
        expiresOnTimestamp: Date.now() + 600_000
      };
    };
    const adapter = new AzureRealtimeTranscriptionAdapter({
      endpoint: 'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription',
      deployment: 'palancar-transcription',
      tokenProvider
    });
    Object.defineProperty(adapter, 'close', {
      value: () => order.push('adapter'),
      enumerable: true
    });
    const partialTelemetryShutdown = vi.fn(async () => {
      order.push('telemetry');
    });
    expect(() => createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security: testSecurityWith(),
      languageBoundaryMode: 'deny-all',
      transcriptionProvider: 'azure-realtime',
      managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
      azureTranscriptionEndpoint:
        'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription',
      azureTranscriptionDeployment: 'palancar-transcription',
      azureTokenSourceFactory: () => ({
        tokenProvider,
        close: () => order.push('token')
      }),
      azureTranscriptionAdapterFactory: () => adapter,
      metricSinkFactory: () => ({
        record: () => undefined,
        shutdown: partialTelemetryShutdown
      } as unknown as NonNullable<RelayHostConfig['metricSink']>)
    })).toThrow('Invalid relay host configuration.');
    await vi.waitFor(() => expect(partialTelemetryShutdown).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['telemetry']);
  });

  it('rolls back the shared token source when Azure generation construction fails', async () => {
    const sensitiveMessage = 'managed identity token and generation endpoint details';
    const tokenClose = vi.fn();
    const tokenProvider: AzureTokenProvider = async (signal) => {
      void signal;
      return {
        token: 'unused',
        expiresOnTimestamp: Date.now() + 600_000
      };
    };
    const tokenFactory = vi.fn(() => ({
      tokenProvider,
      close: tokenClose
    }));
    const generationFactory = vi.fn((options: {
      readonly endpoint: string;
      readonly deployment: 'gpt-5.6-luna';
      readonly tokenProvider: AzureTokenProvider;
    }) => {
      expect(options.endpoint).toBe('https://palancar.openai.azure.com');
      expect(options.deployment).toBe('gpt-5.6-luna');
      expect(options.tokenProvider).toBe(tokenProvider);
      throw new Error(sensitiveMessage);
    });
    const adapterFactory = vi.fn(() => {
      throw new Error('transcription adapter must not be constructed');
    });
    let thrown: unknown;

    try {
      createRelayHostProduction({
        environment: ENVIRONMENT,
        origin: ORIGIN,
        port: 0,
        gatePolicyVersion: GATE_POLICY_VERSION,
        security: testSecurityWith(),
        languageBoundaryMode: 'deny-all',
        generationProvider: 'azure-openai',
        azureGenerationEndpoint: 'https://palancar.openai.azure.com',
        azureGenerationDeployment: 'gpt-5.6-luna',
        transcriptionProvider: 'azure-realtime',
        managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
        azureTranscriptionEndpoint:
          'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription',
        azureTranscriptionDeployment: 'palancar-transcription',
        azureTokenSourceFactory: tokenFactory,
        azureGenerationProviderFactory: generationFactory,
        azureTranscriptionAdapterFactory: adapterFactory,
        metricSinkFactory: () => productionTestMetricSink()
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Invalid relay host configuration.');
    expect((thrown as Error).message).not.toContain(sensitiveMessage);
    expect(tokenFactory).toHaveBeenCalledTimes(1);
    expect(generationFactory).toHaveBeenCalledTimes(1);
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(tokenClose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(tokenClose).toHaveBeenCalledTimes(1));
  });

  it('composes real Azure factories once, deduplicates shared readiness, and shuts telemetry last', async () => {
    const order: string[] = [];
    const tokenProvider: AzureTokenProvider = async (signal) => {
      void signal;
      return {
        token: 'unused',
        expiresOnTimestamp: Date.now() + 600_000
      };
    };
    const adapter = new AzureRealtimeTranscriptionAdapter({
      endpoint: 'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription',
      deployment: 'palancar-transcription',
      tokenProvider
    });
    const adapterReadiness = vi.spyOn(adapter, 'checkReadiness').mockImplementation(async () => {
      order.push('transcription-ready');
      return { ready: true, provider: 'azure-realtime', model: 'palancar-transcription' };
    });
    Object.defineProperty(adapter, 'close', {
      value: () => order.push('adapter-close'),
      enumerable: true
    });
    const tokenClose = vi.fn(() => order.push('token-close'));
    const tokenFactory = vi.fn(() => ({
      tokenProvider,
      close: tokenClose
    }));
    let generationTokenProvider: typeof tokenProvider | undefined;
    const generationComplete = vi.fn(async () => {
      throw new Error('generation must not run during readiness');
    });
    const generationFactory = vi.fn((options: {
      readonly endpoint: string;
      readonly deployment: 'gpt-5.6-luna';
      readonly tokenProvider: AzureTokenProvider;
    }) => {
      generationTokenProvider = options.tokenProvider;
      return {
        id: 'azure-openai-chat',
        version: '1.0.0',
        complete: generationComplete
      };
    });
    let adapterTokenProvider: AzureTokenProvider | undefined;
    const adapterFactory = vi.fn((options: { readonly tokenProvider: AzureTokenProvider }) => {
      adapterTokenProvider = options.tokenProvider;
      return adapter;
    });
    const metricFactory = vi.fn(() => ({
      record: () => undefined,
      checkReadiness: async () => {
        order.push('telemetry-ready');
        return true;
      },
      shutdown: async () => {
        order.push('telemetry-shutdown');
      }
    }));
    const host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security: testSecurityWith(),
      languageBoundaryMode: 'deny-all',
      generationProvider: 'azure-openai',
      azureGenerationEndpoint: 'https://palancar.openai.azure.com',
      azureGenerationDeployment: 'gpt-5.6-luna',
      transcriptionProvider: 'azure-realtime',
      managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
      azureTranscriptionEndpoint:
        'wss://palancar.openai.azure.com/openai/v1/realtime?intent=transcription',
      azureTranscriptionDeployment: 'palancar-transcription',
      azureTokenSourceFactory: tokenFactory,
      azureGenerationProviderFactory: generationFactory,
      azureTranscriptionAdapterFactory: adapterFactory,
      metricSinkFactory: metricFactory
    });
    await host.start();
    const ready = await fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
    expect(ready.status).toBe(200);
    expect(tokenFactory).toHaveBeenCalledTimes(1);
    expect(generationFactory).toHaveBeenCalledTimes(1);
    expect(generationComplete).not.toHaveBeenCalled();
    expect(adapterFactory).toHaveBeenCalledTimes(1);
    expect(generationTokenProvider).toBe(tokenProvider);
    expect(adapterTokenProvider).toBe(tokenProvider);
    expect(metricFactory).toHaveBeenCalledTimes(1);
    expect(adapterReadiness).toHaveBeenCalledTimes(1);
    await host.stop();
    expect(order.slice(-3)).toEqual(['adapter-close', 'token-close', 'telemetry-shutdown']);
    expect(tokenClose).toHaveBeenCalledTimes(1);
  });

  it('aborts hanging Azure token readiness before exactly-once close across repeated concurrent stops', async () => {
    const order: string[] = [];
    let observedSignal: AbortSignal | undefined;
    const tokenClose = vi.fn(() => {
      expect(observedSignal?.aborted).toBe(true);
      order.push('token-close');
    });
    const generationComplete = vi.fn(async () => {
      throw new Error('generation completion must remain unused');
    });
    const host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security: testSecurityWith(),
      languageBoundaryMode: 'deny-all',
      generationProvider: 'azure-openai',
      azureGenerationEndpoint: 'https://palancar.openai.azure.com',
      azureGenerationDeployment: 'gpt-5.6-luna',
      azureGenerationProviderFactory: () => ({
        id: 'azure-openai-chat',
        version: '1.0.0',
        complete: generationComplete
      }),
      managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
      azureTokenSourceFactory: () => ({
        tokenProvider: async (signal) => {
          observedSignal = signal;
          return new Promise(() => undefined);
        },
        close: tokenClose
      }),
      metricSink: {
        record: () => undefined,
        checkReadiness: async () => true,
        shutdown: async () => {
          order.push('telemetry-shutdown');
        }
      } as NonNullable<RelayHostConfig['metricSink']>
    });
    await host.start();
    const readiness = fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    const firstStop = host.stop();
    const secondStop = host.stop();
    const thirdStop = host.stop();
    expect(secondStop).toBe(firstStop);
    expect(thirdStop).toBe(firstStop);
    expect(observedSignal?.aborted).toBe(true);
    expect(tokenClose).not.toHaveBeenCalled();
    await Promise.all([firstStop, secondStop, thirdStop]);
    await expect(readiness).resolves.toMatchObject({ status: 503 });
    expect(generationComplete).not.toHaveBeenCalled();
    expect(tokenClose).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['token-close', 'telemetry-shutdown']);
    expect(host.lifecycleState).toBe('stopped');
  });

  it('invokes all five readiness dependencies concurrently and single-flights callers', async () => {
    const started: string[] = [];
    const generationReady = createValueDeferred<boolean>();
    const spanishReady = createValueDeferred<ReturnType<TranscriptionAdapter['checkReadiness']> extends Promise<infer T> ? T : never>();
    const turkishReady = createValueDeferred<ReturnType<TranscriptionAdapter['checkReadiness']> extends Promise<infer T> ? T : never>();
    const classifierReady = createDeferred();
    const securityReady = createDeferred();
    const telemetryReady = createValueDeferred<boolean>();
    const spanish = new DeterministicMockTranscriptionAdapter({
      evidenceCategory: 'selected-target',
      fixtureTargetLanguage: 'es'
    });
    const turkish = new DeterministicMockTranscriptionAdapter({
      evidenceCategory: 'selected-target',
      fixtureTargetLanguage: 'tr'
    });
    vi.spyOn(spanish, 'checkReadiness').mockImplementation(() => {
      started.push('transcription-es');
      return spanishReady.promise;
    });
    vi.spyOn(turkish, 'checkReadiness').mockImplementation(() => {
      started.push('transcription-tr');
      return turkishReady.promise;
    });
    const validator: GeneratedLanguageValidator = {
      id: 'approved-generated-language',
      version: '1.0.0',
      validate: async (input) => ({
        checks: input.checks.map((check) => ({
          slot: check.slot,
          expectedLanguage: check.expectedLanguage,
          detectedLanguage: check.expectedLanguage,
          verdict: 'match' as const,
          evidenceType: 'calibrated' as const,
          confidenceBasisPoints: 10_000,
          provisionalScoreBasisPoints: null
        })) as unknown as GeneratedLanguageValidationEvidence['checks']
      })
    };
    const generationComplete = vi.fn(async () => {
      throw new Error('generation must not run during readiness');
    });
    const classifierThenable = {
      then(resolve: () => void, reject: (error: unknown) => void): Promise<void> {
        started.push('classifier');
        return classifierReady.promise.then(resolve, reject);
      }
    } as unknown as Promise<void>;
    const security = testSecurityWith({
      maintenance: {
        checkReadiness: async () => {
          started.push('security');
          await securityReady.promise;
        }
      }
    });
    const host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security,
      languageBoundaryMode: 'production-approved',
      transcriptionAdapters: { es: spanish, tr: turkish },
      languageClassifier: {
        ready: classifierThenable,
        classify: async () => ({ status: 'unavailable', detectorVersion: 'approved-future' })
      },
      productionApprovedGenerationValidator: validator,
      generationProvider: 'azure-openai',
      azureGenerationEndpoint: 'https://palancar.openai.azure.com',
      azureGenerationDeployment: 'gpt-5.6-luna',
      azureGenerationProviderFactory: () => ({
        id: 'azure-openai-chat',
        version: '1.0.0',
        complete: generationComplete
      }),
      managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
      azureTokenSourceFactory: () => ({
        tokenProvider: async () => {
          started.push('generation');
          await generationReady.promise;
          return { token: 'unused', expiresOnTimestamp: Date.now() + 600_000 };
        },
        close: () => undefined
      }),
      metricSink: {
        record: () => undefined,
        checkReadiness: async () => {
          started.push('telemetry');
          return telemetryReady.promise;
        },
        shutdown: async () => undefined
      } as NonNullable<RelayHostConfig['metricSink']>
    });
    await host.start();
    const first = fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
    const second = fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
    await vi.waitFor(() => expect(new Set(started)).toEqual(new Set([
      'generation',
      'transcription-es',
      'transcription-tr',
      'classifier',
      'security',
      'telemetry'
    ])));
    expect(started).toHaveLength(6);
    generationReady.resolve(true);
    spanishReady.resolve({ ready: true, provider: 'deterministic-mock', model: 'mock' });
    turkishReady.resolve({ ready: true, provider: 'deterministic-mock', model: 'mock' });
    classifierReady.resolve();
    securityReady.resolve();
    telemetryReady.resolve(true);
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(started).toHaveLength(6);
    expect(generationComplete).not.toHaveBeenCalled();
    await host.stop();
  });

  it('uses exact 30s success and 2s failure readiness caches with a valid clock', async () => {
    const run = async (ready: boolean, expiry: number): Promise<void> => {
      let now = 0;
      const spanish = new DeterministicMockTranscriptionAdapter({
        evidenceCategory: 'selected-target',
        fixtureTargetLanguage: 'es'
      });
      const turkish = new DeterministicMockTranscriptionAdapter({
        evidenceCategory: 'selected-target',
        fixtureTargetLanguage: 'tr'
      });
      const spanishCheck = vi.spyOn(spanish, 'checkReadiness').mockResolvedValue({
        ready,
        provider: 'deterministic-mock',
        model: 'mock'
      });
      const turkishCheck = vi.spyOn(turkish, 'checkReadiness').mockResolvedValue({
        ready,
        provider: 'deterministic-mock',
        model: 'mock'
      });
      const host = createRelayHostProduction({
        environment: 'local-mock',
        origin: ORIGIN,
        port: 0,
        gatePolicyVersion: GATE_POLICY_VERSION,
        security: {
          ...createTestHostSecurityComposition(),
          mode: 'local-mock'
        },
        languageBoundaryMode: 'fixture',
        transcriptionAdapters: { es: spanish, tr: turkish },
        clock: {
          nowIso: () => '2026-08-10T12:00:00.000Z',
          nowMonotonicMs: () => {
            now += 1;
            return now;
          }
        }
      });
      await host.start();
      const url = `http://127.0.0.1:${hostPort(host)}/readyz`;
      expect((await fetch(url)).status).toBe(ready ? 200 : 503);
      expect((await fetch(url)).status).toBe(ready ? 200 : 503);
      expect(spanishCheck).toHaveBeenCalledTimes(1);
      expect(turkishCheck).toHaveBeenCalledTimes(1);
      now = expiry + 1;
      expect((await fetch(url)).status).toBe(ready ? 200 : 503);
      expect(spanishCheck).toHaveBeenCalledTimes(2);
      expect(turkishCheck).toHaveBeenCalledTimes(2);
      await host.stop();
    };
    await run(true, 30_000);
    await run(false, 2_000);
  });

  it.each([
    ['frozen', (): number => 1],
    ['throwing', (): number => { throw new Error('clock failure'); }],
    ['nonfinite', (): number => Number.NaN],
    ['backward', ((): (() => number) => {
      const values = [2, 1];
      return () => values.shift() ?? 1;
    })()]
  ] as const)('fails readiness closed for a %s monotonic clock', async (_name, nowMonotonicMs) => {
    const host = createRelayHostProduction({
      ...parseRelayHostConfig(mockEnvironment({ PORT: '0' })),
      clock: {
        nowIso: () => '2026-08-10T12:00:00.000Z',
        nowMonotonicMs
      }
    });
    await host.start();
    expect((await fetch(`http://127.0.0.1:${hostPort(host)}/readyz`)).status).toBe(503);
    await host.stop();
  });

  it('aborts active readiness on stop and never serves a cached success while stopping', async () => {
    const started = createDeferred();
    let observedSignal: AbortSignal | undefined;
    const spanish = new DeterministicMockTranscriptionAdapter({
      evidenceCategory: 'selected-target',
      fixtureTargetLanguage: 'es'
    });
    vi.spyOn(spanish, 'checkReadiness').mockImplementation((signal) => {
      observedSignal = signal;
      started.resolve();
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve({
          ready: false,
          provider: 'deterministic-mock',
          model: 'mock'
        }), { once: true });
      });
    });
    const host = createRelayHostProduction({
      environment: 'local-mock',
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security: {
        ...createTestHostSecurityComposition(),
        mode: 'local-mock'
      },
      languageBoundaryMode: 'fixture',
      transcriptionAdapters: {
        es: spanish,
        tr: new DeterministicMockTranscriptionAdapter({
          evidenceCategory: 'selected-target',
          fixtureTargetLanguage: 'tr'
        })
      }
    });
    await host.start();
    const ready = fetch(`http://127.0.0.1:${hostPort(host)}/readyz`);
    await started.promise;
    const stopping = host.stop();
    expect(observedSignal?.aborted).toBe(true);
    await expect(ready).resolves.toMatchObject({ status: 503 });
    await stopping;
    expect(host.lifecycleState).toBe('stopped');
  });

  it('fails readiness independently when telemetry is unavailable', async () => {
    const telemetryCheck = vi.fn(async () => false);
    const host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security: testSecurityWith(),
      metricSink: {
        record: () => undefined,
        checkReadiness: telemetryCheck,
        shutdown: async () => undefined
      } as NonNullable<RelayHostConfig['metricSink']>
    });
    await host.start();
    expect((await fetch(`http://127.0.0.1:${hostPort(host)}/readyz`)).status).toBe(503);
    expect(telemetryCheck).toHaveBeenCalledTimes(1);
    await host.stop();
  });

  it('hard-bounds telemetry shutdown to exactly five seconds', async () => {
    const shutdown = vi.fn(() => new Promise<void>(() => undefined));
    const host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security: testSecurityWith(),
      metricSink: {
        record: () => undefined,
        checkReadiness: async () => true,
        shutdown
      } as NonNullable<RelayHostConfig['metricSink']>
    });
    await host.start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const stopping = host.stop().then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(shutdown).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
      await host.stop();
    }
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

  it('applies actual-request origin policy to health without invoking readiness state', async () => {
    await host.stop();
    const checkReadiness = vi.fn(async () => undefined);
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      browserOriginPolicy: Object.freeze({
        allowedOrigins: Object.freeze(['https://app.example']),
        allowNullOrigin: true
      }),
      metricSink: productionTestMetricSink(),
      security: testSecurityWith({ maintenance: { checkReadiness } })
    });
    await host.start();

    const url = `http://127.0.0.1:${hostPort(host)}/healthz`;
    const originless = await fetch(url);
    expect(originless.status).toBe(200);
    expect(originless.headers.get('access-control-allow-origin')).toBeNull();
    expect(originless.headers.get('vary')).toBeNull();
    expect(await responseJson(originless)).toEqual({ ok: true });

    const allowed = await fetch(url, { headers: { origin: 'https://app.example' } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(allowed.headers.get('vary')).toBe('Origin');
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    expect(await responseJson(allowed)).toEqual({ ok: true });

    const nullOrigin = await fetch(url, { headers: { origin: 'null' } });
    expect(nullOrigin.status).toBe(200);
    expect(nullOrigin.headers.get('access-control-allow-origin')).toBe('null');
    expect(nullOrigin.headers.get('vary')).toBe('Origin');

    const rejected = await fetch(url, { headers: { origin: 'https://evil.example' } });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
    expect(rejected.headers.get('cache-control')).toBe('no-store');
    expect(await responseJson(rejected)).toEqual({ error: 'request_rejected' });

    const healthOptions = await fetch(url, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example' }
    });
    expect(healthOptions.status).toBe(405);
    expect(healthOptions.headers.get('allow')).toBe('GET');
    expect(checkReadiness).not.toHaveBeenCalled();
  });

  it('serves lifecycle routes with exact contracts, CORS, and preflight metadata', async () => {
    await host.stop();
    const security = lifecycleSecurityWith();
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      browserOriginPolicy: Object.freeze({
        allowedOrigins: Object.freeze(['https://app.example']),
        allowNullOrigin: false
      }),
      metricSink: productionTestMetricSink(),
      security: security.composition
    });
    await host.start();

    const baseUrl = `http://127.0.0.1:${hostPort(host)}`;
    const origin = 'https://app.example';
    const begin = await fetch(`${baseUrl}/v1/credential-rotations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_CREDENTIAL}`,
        'content-type': 'application/json',
        origin
      },
      body: '{}'
    });
    expect(begin.status).toBe(200);
    expect(begin.headers.get('access-control-allow-origin')).toBe(origin);
    expect(begin.headers.get('vary')).toBe('Origin');
    expect(begin.headers.get('cache-control')).toBe('no-store');
    expect(await responseJson(begin)).toEqual({
      pendingCredential: PENDING_CREDENTIAL,
      pendingCredentialVersion: 2,
      pendingCredentialExpiresAt: '2026-08-10T12:30:00.000Z'
    });

    const preflight = await fetch(`${baseUrl}/v1/credential-rotation-confirmations`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization'
      }
    });
    expect(preflight.status).toBe(204);
    expect(await preflight.text()).toBe('');
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');
    expect(preflight.headers.get('cache-control')).toBe('no-store');
    expect(preflight.headers.get('vary')).toBe(
      'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
    );

    const invalidPreflight = await fetch(`${baseUrl}/v1/credential-rotations`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Authorization, authorization'
      }
    });
    expect(invalidPreflight.status).toBe(400);
    expect(invalidPreflight.headers.get('cache-control')).toBe('no-store');
    expect(invalidPreflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(invalidPreflight.headers.get('vary')).toBe(
      'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
    );

    const confirmation = await fetch(`${baseUrl}/v1/credential-rotation-confirmations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${PENDING_CREDENTIAL}`,
        'content-type': 'application/json',
        origin
      },
      body: '{}'
    });
    expect(confirmation.status).toBe(200);
    expect(await responseJson(confirmation)).toEqual({
      credentialVersion: 2,
      promoted: true,
      confirmedAt: '2026-08-10T12:01:00.000Z',
      expiresAt: '2026-10-01T00:00:00.000Z'
    });

    const deletion = await fetch(`${baseUrl}/v1/installations/current`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TEST_CREDENTIAL}`, origin }
    });
    expect(deletion.status).toBe(204);
    expect(await deletion.text()).toBe('');
    expect(deletion.headers.get('content-type')).toBeNull();
    expect(deletion.headers.get('content-length')).toBeNull();
    expect(deletion.headers.get('cache-control')).toBe('no-store');
    expect(deletion.headers.get('access-control-allow-origin')).toBe(origin);
  });

  it('rejects browser origin and malformed preflight before lifecycle state', async () => {
    await host.stop();
    const security = lifecycleSecurityWith();
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      browserOriginPolicy: Object.freeze({
        allowedOrigins: Object.freeze(['https://app.example']),
        allowNullOrigin: false
      }),
      metricSink: productionTestMetricSink(),
      security: security.composition
    });
    await host.start();
    const baseUrl = `http://127.0.0.1:${hostPort(host)}`;

    const rejected = await fetch(`${baseUrl}/v1/credential-rotations`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        authorization: `Bearer ${TEST_CREDENTIAL}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ canary: CANARY })
    });
    expect(rejected.status).toBe(403);
    expect(await responseJson(rejected)).toEqual({ error: 'request_rejected' });

    const malformed = await fetch(`${baseUrl}/v1/credential-rotations`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'Authorization'
      }
    });
    expect(malformed.status).toBe(400);
    expect(await responseJson(malformed)).toEqual({ error: 'request_rejected' });
    expect(security.spies.beginCredentialRotation).not.toHaveBeenCalled();
  });

  it('rejects disallowed WebSocket Origin before consuming the session ticket', async () => {
    await host.stop();
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      browserOriginPolicy: Object.freeze({
        allowedOrigins: Object.freeze(['https://app.example']),
        allowNullOrigin: false
      }),
      metricSink: productionTestMetricSink(),
      security: createTestHostSecurityComposition()
    });
    await host.start();

    const issued = await issueTicket(host);
    const address = host.server.address() as { readonly port: number };
    const url = `ws://127.0.0.1:${address.port}/v1/stream`;
    const rejected = new WebSocket(
      url,
      [...createWebSocketSubprotocols(String(issued.ticket))],
      { headers: { Origin: 'https://evil.example' } }
    );
    await expect(waitForUnexpectedResponse(rejected)).resolves.toBe(403);

    const retry = await openSocket(host, String(issued.ticket));
    const closed = waitForClose(retry);
    retry.close(1000, 'test_done');
    await closed;
  });

  it.each([
    ['/v1/pairing-redemptions', 'POST'],
    ['/v1/session-tickets', 'POST'],
    ['/v1/credential-rotations', 'POST'],
    ['/v1/credential-rotation-confirmations', 'POST'],
    ['/v1/installations/current', 'DELETE']
  ] as const)('returns exact Allow for recognized %s', async (path, allow) => {
    const response = await fetch(`http://127.0.0.1:${hostPort(host)}${path}`, {
      method: 'GET'
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe(allow);
    expect(await responseJson(response)).toEqual({ error: 'request_rejected' });
  });

  it('maps auth failures generically and enforces canonical singleton bearer and body limits', async () => {
    await host.stop();
    let failure: Error | undefined;
    const beginCredentialRotation = vi.fn(async (): Promise<PendingCredentialResult> => {
      if (failure !== undefined) throw failure;
      return {
        installationId: assertCanonicalUuid('11111111-1111-4111-8111-111111111111'),
        pendingCredential: assertCanonical256BitToken(PENDING_CREDENTIAL),
        pendingCredentialVersion: 2,
        pendingExpiresAt: Date.parse('2026-08-10T12:30:00.000Z'),
        absoluteExpiresAt: Date.parse('2026-10-01T00:00:00.000Z')
      };
    });
    const promoteCredential = vi.fn(async (): Promise<never> => {
      throw new Error(CANARY);
    });
    const security = testSecurityWith({
      runtime: { beginCredentialRotation, promoteCredential }
    });
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      browserOriginPolicy: {
        allowedOrigins: ['https://app.example'],
        allowNullOrigin: false
      },
      metricSink: productionTestMetricSink(),
      security
    });
    await host.start();
    const port = hostPort(host);
    const url = `http://127.0.0.1:${port}/v1/credential-rotations`;
    const request = (body: string, headers: Record<string, string> = {}) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body
    });

    const missing = await request('{}');
    expect(missing.status).toBe(401);
    expect(beginCredentialRotation).not.toHaveBeenCalled();

    const noncanonical = await request('{}', {
      authorization: `Bearer ${'A'.repeat(42)}B`
    });
    expect(noncanonical.status).toBe(401);
    expect(beginCredentialRotation).not.toHaveBeenCalled();

    const duplicate = await rawHttpResponse(port, [
      'POST /v1/credential-rotations HTTP/1.1',
      'Host: 127.0.0.1',
      `Authorization: Bearer ${TEST_CREDENTIAL}`,
      `Authorization: Bearer ${TEST_CREDENTIAL}`,
      'Content-Type: application/json',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}'
    ].join('\r\n'));
    expect(duplicate.status).toBe(401);
    expect(beginCredentialRotation).not.toHaveBeenCalled();

    const rejectedOrigin = await request(JSON.stringify({ canary: CANARY }), {
      authorization: `Bearer ${TEST_CREDENTIAL}`,
      origin: 'https://evil.example'
    });
    expect(rejectedOrigin.status).toBe(403);
    expect(JSON.stringify(await responseJson(rejectedOrigin))).not.toContain(CANARY);
    expect(beginCredentialRotation).not.toHaveBeenCalled();

    const strictBody = await request(JSON.stringify({ canary: CANARY }), {
      authorization: `Bearer ${TEST_CREDENTIAL}`
    });
    expect(strictBody.status).toBe(400);
    expect(JSON.stringify(await responseJson(strictBody))).not.toContain(CANARY);
    expect(beginCredentialRotation).not.toHaveBeenCalled();

    const strictConfirmation = await fetch(
      `http://127.0.0.1:${port}/v1/credential-rotation-confirmations`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${PENDING_CREDENTIAL}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ canary: CANARY })
      }
    );
    expect(strictConfirmation.status).toBe(400);
    expect(JSON.stringify(await responseJson(strictConfirmation))).not.toContain(CANARY);
    expect(promoteCredential).not.toHaveBeenCalled();

    const exactLimit = `${' '.repeat(4_094)}{}`;
    expect(Buffer.byteLength(exactLimit)).toBe(4_096);
    const accepted = await request(exactLimit, {
      authorization: `Bearer ${TEST_CREDENTIAL}`
    });
    expect(accepted.status).toBe(200);
    expect(beginCredentialRotation).toHaveBeenCalledTimes(1);

    const overLimit = `${' '.repeat(4_095)}{}`;
    expect(Buffer.byteLength(overLimit)).toBe(4_097);
    const tooLarge = await request(overLimit, {
      authorization: `Bearer ${TEST_CREDENTIAL}`
    });
    expect(tooLarge.status).toBe(413);
    expect(beginCredentialRotation).toHaveBeenCalledTimes(1);

    for (const [category, expected] of [
      ['invalid-credential', 401],
      ['credential-conflict', 409],
      ['rate-limited', 429],
      ['state-unavailable', 503]
    ] as const) {
      failure = new SecurityStateError(category);
      const response = await request('{}', {
        authorization: `Bearer ${TEST_CREDENTIAL}`,
        origin: 'https://app.example'
      });
      expect(response.status).toBe(expected);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
      expect(response.headers.get('vary')).toBe('Origin');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await responseJson(response)).toEqual({ error: 'request_rejected' });
    }

    failure = new Error(CANARY);
    const internal = await request('{}', {
      authorization: `Bearer ${TEST_CREDENTIAL}`
    });
    expect(internal.status).toBe(503);
    expect(JSON.stringify(await responseJson(internal))).not.toContain(CANARY);
  });

  it('rejects body-bearing installation deletion before revocation state', async () => {
    await host.stop();
    const revokeCurrentInstallation = vi.fn(async (): Promise<InstallationRevocationResult> => ({
      installationId: assertCanonicalUuid('11111111-1111-4111-8111-111111111111'),
      credentialVersion: 1,
      tombstoneVersion: 1,
      status: 'revoked',
      revokedAt: Date.parse('2026-08-10T12:02:00.000Z')
    }));
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      metricSink: productionTestMetricSink(),
      security: testSecurityWith({ runtime: { revokeCurrentInstallation } })
    });
    await host.start();
    const port = hostPort(host);
    const url = `http://127.0.0.1:${port}/v1/installations/current`;

    const empty = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TEST_CREDENTIAL}` }
    });
    expect(empty.status).toBe(204);
    expect(revokeCurrentInstallation).toHaveBeenCalledTimes(1);

    const positiveLength = await fetch(url, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${TEST_CREDENTIAL}`,
        'content-type': 'application/json'
      },
      body: '{}'
    });
    expect(positiveLength.status).toBe(400);
    expect(revokeCurrentInstallation).toHaveBeenCalledTimes(1);

    const firstChunk = await rawHttpResponse(port, [
      'DELETE /v1/installations/current HTTP/1.1',
      'Host: 127.0.0.1',
      `Authorization: Bearer ${TEST_CREDENTIAL}`,
      'Transfer-Encoding: chunked',
      'Connection: keep-alive',
      '',
      '2',
      '{}',
      ''
    ].join('\r\n'));
    expect(firstChunk.status).toBe(400);
    expect(revokeCurrentInstallation).toHaveBeenCalledTimes(1);
  });

  it('serves the exact five-route preflight matrix without state access', async () => {
    await host.stop();
    const rejectIfCalled = async (): Promise<never> => {
      throw new Error(CANARY);
    };
    const stateSpies = {
      redeemPairing: vi.fn(rejectIfCalled),
      issueSessionTicket: vi.fn(rejectIfCalled),
      beginCredentialRotation: vi.fn(rejectIfCalled),
      promoteCredential: vi.fn(rejectIfCalled),
      revokeCurrentInstallation: vi.fn(rejectIfCalled)
    };
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      browserOriginPolicy: {
        allowedOrigins: ['https://app.example'],
        allowNullOrigin: true
      },
      metricSink: productionTestMetricSink(),
      security: testSecurityWith({ runtime: stateSpies })
    });
    await host.start();
    const port = hostPort(host);
    const baseUrl = `http://127.0.0.1:${port}`;
    const routes = [
      ['/v1/pairing-redemptions', 'POST', 'Content-Type'],
      ['/v1/session-tickets', 'POST', 'Authorization, Content-Type'],
      ['/v1/credential-rotations', 'POST', 'Authorization, Content-Type'],
      ['/v1/credential-rotation-confirmations', 'POST', 'Authorization, Content-Type'],
      ['/v1/installations/current', 'DELETE', 'Authorization']
    ] as const;
    for (const [path, method, headers] of routes) {
      const requestedHeaders = headers.split(', ').reverse().join(', ').toLowerCase();
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example',
          'access-control-request-method': method,
          'access-control-request-headers': requestedHeaders
        }
      });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
      expect(response.headers.get('access-control-allow-methods')).toBe(method);
      expect(response.headers.get('access-control-allow-headers')).toBe(headers);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toBe(
        'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
      );
    }

    const nullOrigin = await fetch(`${baseUrl}/v1/pairing-redemptions`, {
      method: 'OPTIONS',
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Content-Type'
      }
    });
    expect(nullOrigin.status).toBe(204);
    expect(nullOrigin.headers.get('access-control-allow-origin')).toBe('null');

    const originless = await fetch(`${baseUrl}/v1/session-tickets`, {
      method: 'OPTIONS',
      headers: {
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Authorization, Content-Type'
      }
    });
    expect(originless.status).toBe(400);

    const malformed = await fetch(`${baseUrl}/v1/session-tickets`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example, https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Authorization, Content-Type'
      }
    });
    expect(malformed.status).toBe(403);

    const unexpectedMetadata = await fetch(`${baseUrl}/v1/session-tickets`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Authorization, Content-Type',
        'access-control-request-private-network': 'true'
      }
    });
    expect(unexpectedMetadata.status).toBe(400);

    const multipleOrigin = await rawHttpResponse(port, [
      'OPTIONS /v1/session-tickets HTTP/1.1',
      'Host: 127.0.0.1',
      'Origin: https://app.example',
      'Origin: https://app.example',
      'Access-Control-Request-Method: POST',
      'Access-Control-Request-Headers: Authorization, Content-Type',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    expect(multipleOrigin.status).toBe(403);

    for (const spy of Object.values(stateSpies)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it.each(['promoted', 'already-promoted'] as const)(
    'closes stale provider/session work before %s confirmation response',
    async (status) => {
      await host.stop();
      const oldTicket = `${'D'.repeat(42)}E`;
      const currentTicket = `${'F'.repeat(42)}E`;
      const otherTicket = `${'G'.repeat(42)}E`;
      const staleTicket = `${'H'.repeat(42)}E`;
      for (const ticket of [oldTicket, currentTicket, otherTicket, staleTicket]) {
        assertCanonical256BitToken(ticket);
      }
      const oldLease = controlledLease({
        installationId: '11111111-1111-4111-8111-111111111111',
        sessionId: '11111111-1111-4111-8111-111111111111',
        credentialVersion: 1
      });
      const currentLease = controlledLease({
        installationId: '11111111-1111-4111-8111-111111111111',
        sessionId: '66666666-6666-4666-8666-666666666666',
        credentialVersion: 2
      });
      const otherLease = controlledLease({
        installationId: '77777777-7777-4777-8777-777777777777',
        sessionId: '88888888-8888-4888-8888-888888888888',
        credentialVersion: 1
      });
      const tickets = new Map<string, SessionLease>([
        [oldTicket, oldLease],
        [currentTicket, currentLease],
        [otherTicket, otherLease],
        [staleTicket, oldLease]
      ]);
      const consumeSessionTicket = vi.fn(async ({ ticket }: {
        readonly ticket: string;
      }): Promise<SessionLease> => {
        const lease = tickets.get(ticket);
        if (lease === undefined) throw new SecurityStateError('invalid-ticket');
        tickets.delete(ticket);
        return lease;
      });
      const promoteCredential = vi.fn(async (): Promise<CredentialPromotionResult> => ({
        installationId: oldLease.installationId,
        credentialVersion: 2,
        tombstoneVersion: 1,
        status,
        confirmedAt: Date.parse('2026-08-10T12:01:00.000Z'),
        idleExpiresAt: Date.parse('2026-09-01T00:00:00.000Z'),
        absoluteExpiresAt: Date.parse('2026-10-01T00:00:00.000Z')
      }));
      const providerStarted = createDeferred();
      let providerAborted = false;
      const provider: GenerationProvider = {
        id: 'stale-session-provider',
        version: '1.0.0',
        complete: async (_input, context) => new Promise<GenerationProviderCompletion>(
          (_resolve, reject) => {
            const abort = (): void => {
              providerAborted = true;
              reject(new Error(CANARY));
            };
            if (context.signal.aborted) {
              abort();
              return;
            }
            context.signal.addEventListener('abort', abort, { once: true });
            providerStarted.resolve();
          }
        )
      };
      host = createRelayHostProduction({
        environment: 'local-mock',
        origin: ORIGIN,
        port: 0,
        gatePolicyVersion: GATE_POLICY_VERSION,
        security: {
          ...testSecurityWith({
            runtime: { consumeSessionTicket, promoteCredential }
          }),
          mode: 'local-mock'
        },
        languageBoundaryMode: 'fixture',
        transcriptionAdapters: {
          es: createSynchronousFinalEventAdapter(),
          tr: createSynchronousFinalEventAdapter()
        },
        languageClassifier: observingControlledClassifier(() => undefined),
        generationService: new GenerationService({
          provider,
          validator: new DeterministicFixtureLanguageValidator()
        })
      });
      await host.start();

      const oldSocket = await openSocket(host, oldTicket);
      const readyPromise = nextMessage(oldSocket, (message) => message.type === 'session.ready');
      oldSocket.send(sessionStartText());
      const ready = await readyPromise;
      oldSocket.send(JSON.stringify({
        type: 'utterance.start',
        sessionId: String(ready.sessionId),
        sessionEpoch: Number(ready.sessionEpoch),
        utteranceId: UTTERANCE_ID
      }));
      oldSocket.send(JSON.stringify({
        type: 'utterance.commit',
        sessionId: String(ready.sessionId),
        sessionEpoch: Number(ready.sessionEpoch),
        utteranceId: UTTERANCE_ID,
        finalOriginalSampleOffset: 0
      }));
      await providerStarted.promise;

      const currentSocket = await openSocket(host, currentTicket);
      const otherSocket = await openSocket(host, otherTicket);
      const oldClosed = waitForCloseDetails(oldSocket);
      const confirmation = await fetch(
        `http://127.0.0.1:${hostPort(host)}/v1/credential-rotation-confirmations`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${PENDING_CREDENTIAL}`,
            'content-type': 'application/json'
          },
          body: '{}'
        }
      );
      const close = await oldClosed;
      expect(confirmation.status).toBe(200);
      expect(close).toEqual({ code: 4401, reason: 'authentication_failed' });
      expect(close.reason).not.toContain(CANARY);
      expect(providerAborted).toBe(true);
      expect(currentSocket.readyState).toBe(WebSocket.OPEN);
      expect(otherSocket.readyState).toBe(WebSocket.OPEN);

      const stale = new WebSocket(
        `ws://127.0.0.1:${hostPort(host)}/v1/stream`,
        [...createWebSocketSubprotocols(staleTicket)]
      );
      await expect(waitForUnexpectedResponse(stale)).resolves.toBe(401);

      const currentClosed = waitForClose(currentSocket);
      const otherClosed = waitForClose(otherSocket);
      currentSocket.close(1000, 'test_done');
      otherSocket.close(1000, 'test_done');
      await Promise.all([currentClosed, otherClosed]);
    }
  );

  it('closes all matching sessions before first/replayed revocation success', async () => {
    await host.stop();
    const firstTicket = `${'J'.repeat(42)}E`;
    const secondTicket = `${'K'.repeat(42)}E`;
    const otherTicket = `${'L'.repeat(42)}E`;
    const delayedTicket = `${'M'.repeat(42)}E`;
    for (const ticket of [firstTicket, secondTicket, otherTicket, delayedTicket]) {
      assertCanonical256BitToken(ticket);
    }
    const installationId = assertCanonicalUuid('11111111-1111-4111-8111-111111111111');
    const firstLease = controlledLease({
      installationId,
      sessionId: '11111111-1111-4111-8111-111111111111',
      credentialVersion: 1
    });
    const secondLease = controlledLease({
      installationId,
      sessionId: '66666666-6666-4666-8666-666666666666',
      credentialVersion: 2
    });
    const otherLease = controlledLease({
      installationId: '77777777-7777-4777-8777-777777777777',
      sessionId: '88888888-8888-4888-8888-888888888888',
      credentialVersion: 1
    });
    const tickets = new Map<string, SessionLease>([
      [firstTicket, firstLease],
      [secondTicket, secondLease],
      [otherTicket, otherLease],
      [delayedTicket, firstLease]
    ]);
    const consumeSessionTicket = vi.fn(async ({ ticket }: {
      readonly ticket: string;
    }): Promise<SessionLease> => {
      const lease = tickets.get(ticket);
      if (lease === undefined) throw new SecurityStateError('invalid-ticket');
      tickets.delete(ticket);
      return lease;
    });
    let revocationCount = 0;
    const revokeCurrentInstallation = vi.fn(
      async (): Promise<InstallationRevocationResult> => {
        revocationCount += 1;
        return {
          installationId,
          credentialVersion: 2,
          tombstoneVersion: 2,
          status: revocationCount === 1 ? 'revoked' : 'already-revoked',
          revokedAt: Date.parse('2026-08-10T12:02:00.000Z')
        };
      }
    );
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      metricSink: productionTestMetricSink(),
      security: testSecurityWith({
        runtime: { consumeSessionTicket, revokeCurrentInstallation }
      })
    });
    await host.start();

    const firstSocket = await openSocket(host, firstTicket);
    const secondSocket = await openSocket(host, secondTicket);
    const otherSocket = await openSocket(host, otherTicket);
    const firstClosed = waitForCloseDetails(firstSocket);
    const secondClosed = waitForCloseDetails(secondSocket);
    const url = `http://127.0.0.1:${hostPort(host)}/v1/installations/current`;
    const revoke = () => fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TEST_CREDENTIAL}` }
    });

    const first = await revoke();
    expect(first.status).toBe(204);
    await expect(firstClosed).resolves.toEqual({ code: 4401, reason: 'authentication_failed' });
    await expect(secondClosed).resolves.toEqual({ code: 4401, reason: 'authentication_failed' });
    expect(otherSocket.readyState).toBe(WebSocket.OPEN);

    const replay = await revoke();
    expect(replay.status).toBe(204);
    expect(revokeCurrentInstallation).toHaveBeenCalledTimes(2);
    expect(otherSocket.readyState).toBe(WebSocket.OPEN);

    const delayed = new WebSocket(
      `ws://127.0.0.1:${hostPort(host)}/v1/stream`,
      [...createWebSocketSubprotocols(delayedTicket)]
    );
    await expect(waitForUnexpectedResponse(delayed)).resolves.toBe(401);

    const otherClosed = waitForClose(otherSocket);
    otherSocket.close(1000, 'test_done');
    await otherClosed;
  });

  it.each(['promotion', 'revocation'] as const)(
    'rejects delayed ticket consumption after durable %s',
    async (operation) => {
      await host.stop();
      const ticket = (operation === 'promotion' ? 'N' : 'P').repeat(42) + 'E';
      assertCanonical256BitToken(ticket);
      const lease = controlledLease({
        installationId: '11111111-1111-4111-8111-111111111111',
        sessionId: '11111111-1111-4111-8111-111111111111',
        credentialVersion: 1
      });
      const consumeStarted = createDeferred();
      const delayedLease = createValueDeferred<SessionLease>();
      const consumeSessionTicket = vi.fn(async (): Promise<SessionLease> => {
        consumeStarted.resolve();
        return delayedLease.promise;
      });
      const promoteCredential = vi.fn(async (): Promise<CredentialPromotionResult> => ({
        installationId: lease.installationId,
        credentialVersion: 2,
        tombstoneVersion: 1,
        status: 'promoted',
        confirmedAt: Date.parse('2026-08-10T12:01:00.000Z'),
        idleExpiresAt: Date.parse('2026-09-01T00:00:00.000Z'),
        absoluteExpiresAt: Date.parse('2026-10-01T00:00:00.000Z')
      }));
      const revokeCurrentInstallation = vi.fn(
        async (): Promise<InstallationRevocationResult> => ({
          installationId: lease.installationId,
          credentialVersion: 1,
          tombstoneVersion: 2,
          status: 'revoked',
          revokedAt: Date.parse('2026-08-10T12:02:00.000Z')
        })
      );
      host = createRelayHostProduction({
        environment: ENVIRONMENT,
        origin: ORIGIN,
        port: 0,
        gatePolicyVersion: GATE_POLICY_VERSION,
        metricSink: productionTestMetricSink(),
        security: testSecurityWith({
          runtime: {
            consumeSessionTicket,
            promoteCredential,
            revokeCurrentInstallation
          }
        })
      });
      await host.start();

      const socket = new WebSocket(
        `ws://127.0.0.1:${hostPort(host)}/v1/stream`,
        [...createWebSocketSubprotocols(ticket)]
      );
      const rejected = waitForUnexpectedResponse(socket);
      await consumeStarted.promise;
      const response = operation === 'promotion'
        ? await fetch(
            `http://127.0.0.1:${hostPort(host)}/v1/credential-rotation-confirmations`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${PENDING_CREDENTIAL}`,
                'content-type': 'application/json'
              },
              body: '{}'
            }
          )
        : await fetch(`http://127.0.0.1:${hostPort(host)}/v1/installations/current`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${TEST_CREDENTIAL}` }
          });
      expect(response.status).toBe(operation === 'promotion' ? 200 : 204);
      delayedLease.resolve(lease);
      await expect(rejected).resolves.toBe(401);
    }
  );

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

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'awaits successful %s shutdown without truncating process cleanup',
    async (signal) => {
      const result = await runRelayMainAndSignal(signal);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^relay listening on \d+\n$/);
      expect(result.stderr).toBe('');
    },
    15_000
  );

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

  it('keeps B audio flowing after a late no-op cancel for resolved utterance A', async () => {
    await host.stop();
    const security = testSecurityWith();
    const reserve = vi.spyOn(security.runtime, 'reserveAudio');
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      metricSink: productionTestMetricSink(),
      security
    });
    await host.start();

    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const readyPromise = nextMessage(socket, (message) => message.type === 'session.ready');
    socket.send(sessionStartText());
    const ready = await readyPromise;
    const sessionId = String(ready.sessionId);
    const sessionEpoch = Number(ready.sessionEpoch);
    const start = (utteranceId: string): void => {
      socket.send(JSON.stringify({
        type: 'utterance.start',
        sessionId,
        sessionEpoch,
        utteranceId
      }));
    };

    start(UTTERANCE_ID);
    const resolvedA = nextMessage(
      socket,
      (message) => message.type === 'language.decision' && message.utteranceId === UTTERANCE_ID
    );
    socket.send(JSON.stringify({
      type: 'utterance.commit',
      sessionId,
      sessionEpoch,
      utteranceId: UTTERANCE_ID,
      finalOriginalSampleOffset: 0
    }));
    await expect(resolvedA).resolves.toMatchObject({
      type: 'language.decision',
      utteranceId: UTTERANCE_ID,
      decision: 'uncertain'
    });

    start(SECOND_UTTERANCE_ID);
    const bInitialAck = nextMessage(
      socket,
      (message) => message.type === 'audio.ack' &&
        message.utteranceId === SECOND_UTTERANCE_ID &&
        message.highestContiguousExclusiveOffset === 8_000
    );
    for (let sequence = 0; sequence < 5; sequence += 1) {
      socket.send(frameFor(SECOND_UTTERANCE_ID, sequence, sequence * 1_600), { binary: true });
    }
    await bInitialAck;

    socket.send(JSON.stringify({
      type: 'utterance.cancel',
      sessionId,
      sessionEpoch,
      utteranceId: UTTERANCE_ID,
      finalOriginalSampleOffset: 0
    }));
    const bSubsequentAck = nextMessage(
      socket,
      (message) => message.type === 'audio.ack' &&
        message.utteranceId === SECOND_UTTERANCE_ID &&
        message.highestContiguousExclusiveOffset === 16_000
    );
    for (let sequence = 5; sequence < 10; sequence += 1) {
      socket.send(frameFor(SECOND_UTTERANCE_ID, sequence, sequence * 1_600), { binary: true });
    }

    await expect(bSubsequentAck).resolves.toMatchObject({
      type: 'audio.ack',
      utteranceId: SECOND_UTTERANCE_ID,
      highestContiguousExclusiveOffset: 16_000
    });
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(reserve.mock.calls.map(([input]) => ({
      from: input.fromOriginalSampleOffset,
      samples: input.originalSamples
    }))).toEqual([
      { from: 0, samples: 8_000 },
      { from: 0, samples: 8_000 },
      { from: 8_000, samples: 8_000 }
    ]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close(1000, 'test_done');
    await waitForClose(socket);
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
      generationService: new GenerationService({
        provider,
        validator: new DeterministicFixtureLanguageValidator()
      })
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
      generationService: new GenerationService({
        provider: new DeterministicMockProvider({
        complete: { failure: new Error(CANARY) }
        }),
        validator: new DeterministicFixtureLanguageValidator()
      })
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

  it('suppresses an asynchronous partial without classification or another inbound message', async () => {
    await host.stop();
    const classified = vi.fn();
    const receivedTypes: string[] = [];
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapters: {
        es: createAsyncCallbackAdapter(),
        tr: createAsyncCallbackAdapter()
      },
      languageClassifier: observingControlledClassifier((text) => {
        classified(text);
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
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(classified).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(receivedTypes).not.toContain('transcript.partial');
    const closed = waitForClose(socket);
    socket.close(1000, 'test_done');
    await closed;
  });

  it.each(['microtask', 'immediate'] as const)(
    'suppresses a %s partial arriving while an async drain is already scheduled',
    async (mode) => {
    await host.stop();
    const classifiedTexts: string[] = [];
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapters: {
        es: createTwoAsyncEventAdapter(mode),
        tr: createTwoAsyncEventAdapter(mode)
      },
      languageClassifier: observingControlledClassifier((text) => {
        classifiedTexts.push(text);
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

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(classifiedTexts).toEqual([]);
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
      transcriptionAdapters: {
        es: createSynchronousFailureAdapter(),
        tr: createSynchronousFailureAdapter()
      },
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
      transcriptionAdapters: {
        es: createSynchronousFinalEventAdapter(),
        tr: createSynchronousFinalEventAdapter()
      },
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

  it('suppresses queued partials without classification', async () => {
    await host.stop();
    const fixture = createBlockedDeliveryAdapter();
    const classifiedTexts: string[] = [];
    host = createRelayHost({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      transcriptionAdapters: {
        es: fixture.adapter,
        tr: fixture.adapter
      },
      languageClassifier: observingControlledClassifier((text) => {
        classifiedTexts.push(text);
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

    fixture.emitSecondEvent();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(classifiedTexts).toEqual([]);
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

  it('awaits tracked durable endSession cleanup before telemetry shutdown', async () => {
    await host.stop();
    const ending = createDeferred();
    const order: string[] = [];
    const endSession = vi.fn(async () => {
      await ending.promise;
      order.push('end-session');
    });
    const telemetryShutdown = vi.fn(async () => {
      order.push('telemetry');
    });
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security: testSecurityWith({ runtime: { endSession } }),
      metricSink: {
        record: () => undefined,
        checkReadiness: async () => true,
        shutdown: telemetryShutdown
      } as NonNullable<RelayHostConfig['metricSink']>
    });
    await host.start();
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const ready = nextMessage(socket, (message) => message.type === 'session.ready');
    socket.send(sessionStartText());
    await ready;

    const stopping = host.stop();
    await vi.waitFor(() => expect(endSession).toHaveBeenCalledTimes(1));
    expect(telemetryShutdown).not.toHaveBeenCalled();
    ending.resolve();
    await stopping;
    expect(order).toEqual(['end-session', 'telemetry']);
  });

  it('keeps deployed deny-all WSS transcript and generation content isolated', async () => {
    await host.stop();
    const provider = new DeterministicMockProvider({
      id: 'deterministic-mock-deployed-deny',
      complete: {
        result: {
          englishTranslation: 'must never be exposed',
          suggestions: [
            { englishText: 'never', selectedTargetText: 'nunca' },
            { englishText: 'never', selectedTargetText: 'asla' }
          ]
        }
      }
    });
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      security: testSecurityWith(),
      metricSink: productionTestMetricSink(),
      languageBoundaryMode: 'deny-all',
      generationService: new GenerationService({
        provider,
        validator: new FailClosedGeneratedLanguageValidator()
      })
    });
    await host.start();
    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const seen: string[] = [];
    socket.on('message', (data) => {
      try {
        const message = asObject(JSON.parse(data.toString()) as unknown);
        if (typeof message.type === 'string') seen.push(message.type);
      } catch {
        // Only protocol JSON is relevant to this assertion.
      }
    });
    const readyPromise = nextMessage(socket, (message) => message.type === 'session.ready');
    socket.send(sessionStartText());
    const ready = await readyPromise;
    const decision = nextMessage(socket, (message) => message.type === 'language.decision');
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
    await expect(decision).resolves.toMatchObject({ decision: 'uncertain' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seen).not.toContain('transcript.final');
    expect(seen).not.toContain('translation.ready');
    expect(seen).not.toContain('suggestions.ready');
    expect(provider.completeCalls).toBe(0);
    socket.close(1000, 'test_done');
    await waitForClose(socket);
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

  it('maps every host-reachable acceptor rejection through core classification', async () => {
    await host.stop();
    const records: RelayProductionMetricInput[] = [];
    const security = testSecurityWith();
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      metricSink: {
        ...productionTestMetricSink(),
        record: (input) => records.push(input)
      },
      security
    });
    await host.start();

    // decodeAudioFrame guarantees structural validity before the host acceptor sees a frame.
    type HostReachableRejectionReason = Exclude<FrameRejectionReason, 'malformed-frame'>;
    type ReserveAudioFailure = 'quota-exceeded' | 'rate-limited' | 'state-unavailable';
    const expectedMetricName = 'audio.samples.rejected' as const;
    type HostExpectedMetric =
      | Readonly<{
          readonly name: 'audio.samples.rejected';
          readonly sampleCount: number;
          readonly operation: 'audio';
          readonly outcome: 'rejected';
        }>
      | Readonly<{
          readonly name: 'utterance.abort';
          readonly count: 1;
          readonly operation: 'utterance';
          readonly outcome: 'aborted';
        }>
      | Readonly<{
          readonly name: 'provider.failure';
          readonly count: 1;
          readonly operation: 'transcription';
          readonly outcome: 'failure';
        }>
      | Readonly<{
          readonly name: 'state_store.failure';
          readonly count: 1;
          readonly operation: 'state_store';
          readonly outcome: 'failure';
        }>;
    type HostRejectionCase = {
      readonly limitOverrides?: Partial<typeof DEFAULT_NEGOTIATED_LIMITS>;
      readonly before: readonly Uint8Array[];
      readonly rejected: Uint8Array;
      readonly rejectedSampleCount: number;
      readonly reserveAudioFailure?: ReserveAudioFailure;
      readonly message:
        | { readonly type: 'error'; readonly code: 'flow_control' }
        | {
            readonly type: 'utterance.aborted';
            readonly category: 'duration' | 'provider_loss' | 'stale_conflict';
          };
      readonly close: Readonly<{ readonly code: number; readonly reason: string }>;
      readonly expectedMetrics: readonly HostExpectedMetric[];
    };
    const sample = Uint8Array.of(1, 2);
    const differentSample = Uint8Array.of(3, 4);
    const grantBoundaryFrames = [
      frame(0, 0),
      frame(1, 1_600),
      frame(2, 3_200),
      frame(3, 4_800),
      frame(4, 6_400)
    ] as const;
    const expectedRejectedMetric = (sampleCount: number): HostExpectedMetric => ({
      name: expectedMetricName,
      sampleCount,
      operation: 'audio',
      outcome: 'rejected'
    });
    const expectedAbortMetric: HostExpectedMetric = {
      name: 'utterance.abort',
      count: 1,
      operation: 'utterance',
      outcome: 'aborted'
    };
    const expectedQuotaMetrics: readonly HostExpectedMetric[] = [{
      name: 'utterance.abort',
      count: 1,
      operation: 'utterance',
      outcome: 'aborted'
    }];
    const expectedStateMetrics: readonly HostExpectedMetric[] = [
      {
        name: 'utterance.abort',
        count: 1,
        operation: 'utterance',
        outcome: 'aborted'
      },
      {
        name: 'state_store.failure',
        count: 1,
        operation: 'state_store',
        outcome: 'failure'
      }
    ];
    type HostRejectionCaseName =
      | HostReachableRejectionReason
      | 'reserve-quota-exceeded'
      | 'reserve-rate-limited'
      | 'reserve-state-unavailable';
    const cases: Readonly<Record<HostRejectionCaseName, HostRejectionCase>> = {
      'payload-limit': {
        limitOverrides: { maxAudioPayloadBytes: 2 },
        before: [],
        rejected: frame(0, 0, Uint8Array.of(1, 2, 3, 4)),
        rejectedSampleCount: 2,
        message: { type: 'error', code: 'flow_control' },
        close: { code: 1002, reason: 'protocol_error' },
        expectedMetrics: [expectedRejectedMetric(2), expectedAbortMetric]
      },
      'utterance-limit': {
        limitOverrides: { maxUtteranceSamples: 2 },
        before: [frame(0, 0, sample)],
        rejected: frame(1, 2, sample),
        rejectedSampleCount: 1,
        message: { type: 'utterance.aborted', category: 'duration' },
        close: { code: 4408, reason: 'duration_limit' },
        expectedMetrics: [expectedRejectedMetric(1), expectedAbortMetric]
      },
      'conflicting-duplicate': {
        before: [frame(0, 0, sample)],
        rejected: frame(0, 0, differentSample),
        rejectedSampleCount: 1,
        message: { type: 'utterance.aborted', category: 'stale_conflict' },
        close: { code: 1002, reason: 'protocol_error' },
        expectedMetrics: [expectedRejectedMetric(1), expectedAbortMetric]
      },
      gap: {
        before: [],
        rejected: frame(1, 1, sample),
        rejectedSampleCount: 1,
        message: { type: 'utterance.aborted', category: 'stale_conflict' },
        close: { code: 1002, reason: 'protocol_error' },
        expectedMetrics: [expectedRejectedMetric(1), expectedAbortMetric]
      },
      overlap: {
        before: [frame(0, 0, sample)],
        rejected: frame(1, 0, sample),
        rejectedSampleCount: 1,
        message: { type: 'utterance.aborted', category: 'stale_conflict' },
        close: { code: 1002, reason: 'protocol_error' },
        expectedMetrics: [expectedRejectedMetric(1), expectedAbortMetric]
      },
      'stale-frame': {
        limitOverrides: { maxRetainedReplaySamples: 1 },
        before: [frame(0, 0, sample), frame(1, 1, sample)],
        rejected: frame(0, 0, sample),
        rejectedSampleCount: 1,
        message: { type: 'utterance.aborted', category: 'stale_conflict' },
        close: { code: 1002, reason: 'protocol_error' },
        expectedMetrics: [expectedRejectedMetric(1), expectedAbortMetric]
      },
      'wrong-utterance': {
        before: [],
        rejected: frameFor(SECOND_UTTERANCE_ID, 0, 0, sample),
        rejectedSampleCount: 1,
        message: { type: 'utterance.aborted', category: 'stale_conflict' },
        close: { code: 1002, reason: 'protocol_error' },
        expectedMetrics: [expectedRejectedMetric(1), expectedAbortMetric]
      },
      'reserve-quota-exceeded': {
        before: grantBoundaryFrames,
        rejected: frame(5, 8_000, sample),
        rejectedSampleCount: 1,
        reserveAudioFailure: 'quota-exceeded',
        message: { type: 'utterance.aborted', category: 'duration' },
        close: { code: 4408, reason: 'flow_control' },
        expectedMetrics: expectedQuotaMetrics
      },
      'reserve-rate-limited': {
        before: grantBoundaryFrames,
        rejected: frame(5, 8_000, sample),
        rejectedSampleCount: 1,
        reserveAudioFailure: 'rate-limited',
        message: { type: 'utterance.aborted', category: 'duration' },
        close: { code: 4408, reason: 'flow_control' },
        expectedMetrics: expectedQuotaMetrics
      },
      'reserve-state-unavailable': {
        before: grantBoundaryFrames,
        rejected: frame(5, 8_000, sample),
        rejectedSampleCount: 1,
        reserveAudioFailure: 'state-unavailable',
        message: { type: 'utterance.aborted', category: 'provider_loss' },
        close: { code: 4503, reason: 'provider_unavailable' },
        expectedMetrics: expectedStateMetrics
      }
    };

    let activeReserveAudioFailure: ReserveAudioFailure | undefined;
    let reserveAudioCallsForCase = 0;
    const originalReserveAudio = security.runtime.reserveAudio;
    const reserveAudio = vi.spyOn(security.runtime, 'reserveAudio').mockImplementation(async (input) => {
      reserveAudioCallsForCase += 1;
      if (activeReserveAudioFailure !== undefined && reserveAudioCallsForCase > 1) {
        throw new SecurityStateError(activeReserveAudioFailure);
      }
      return originalReserveAudio(input);
    });

    for (const testCase of Object.values(cases)) {
      const caseMetricStart = records.length;
      const issued = await issueTicket(host);
      const socket = await openSocket(host, String(issued.ticket));
      try {
        activeReserveAudioFailure = testCase.reserveAudioFailure;
        reserveAudioCallsForCase = 0;
        const readyMessage = nextMessage(socket, (message) => message.type === 'session.ready');
        socket.send(sessionStartText(testCase.limitOverrides));
        const ready = await readyMessage;
        socket.send(JSON.stringify({
          type: 'utterance.start',
          sessionId: String(ready.sessionId),
          sessionEpoch: Number(ready.sessionEpoch),
          utteranceId: UTTERANCE_ID
        }));

        const rejection = nextMessage(socket, (message) => message.type === testCase.message.type);
        const closed = waitForCloseDetails(socket);
        for (const precedingFrame of testCase.before) {
          socket.send(precedingFrame);
        }
        socket.send(testCase.rejected);

        await expect(rejection).resolves.toMatchObject(testCase.message);
        await expect(closed).resolves.toEqual(testCase.close);
        const caseRecords = records.slice(caseMetricStart);
        for (const expectedMetric of testCase.expectedMetrics) {
          expect(caseRecords.filter((record) => record.name === expectedMetric.name)).toEqual([
            expect.objectContaining(expectedMetric)
          ]);
        }
        const classifiedMetricNames = new Set([
          expectedMetricName,
          'utterance.abort',
          'provider.failure',
          'state_store.failure'
        ]);
        expect(caseRecords.filter((record) => classifiedMetricNames.has(record.name))).toHaveLength(
          testCase.expectedMetrics.length
        );
      } finally {
        activeReserveAudioFailure = undefined;
        if (socket.readyState !== WebSocket.CLOSED) {
          socket.terminate();
        }
      }
    }
    reserveAudio.mockRestore();
  });

  it('routes an undecodable binary frame through core protocol handling', async () => {
    await host.stop();
    const records: RelayProductionMetricInput[] = [];
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      metricSink: {
        ...productionTestMetricSink(),
        record: (input) => records.push(input)
      },
      security: testSecurityWith()
    });
    await host.start();

    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    try {
      const readyMessage = nextMessage(socket, (message) => message.type === 'session.ready');
      socket.send(sessionStartText());
      const ready = await readyMessage;
      socket.send(JSON.stringify({
        type: 'utterance.start',
        sessionId: String(ready.sessionId),
        sessionEpoch: Number(ready.sessionEpoch),
        utteranceId: UTTERANCE_ID
      }));

      const error = nextMessage(socket, (message) => message.type === 'error');
      const closed = waitForCloseDetails(socket);
      socket.send(Uint8Array.of(0), { binary: true });

      await expect(error).resolves.toMatchObject({
        type: 'error',
        code: 'flow_control',
        scope: 'audio'
      });
      await expect(closed).resolves.toEqual({ code: 1002, reason: 'protocol_error' });
      expect(records.filter((record) => record.name === 'state_store.failure')).toHaveLength(0);
      expect(records.filter((record) => record.name === 'provider.failure')).toHaveLength(0);
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
    }
  });

  it('routes host utterance-limit rejections through core duration handling', async () => {
    await host.stop();
    const records: RelayProductionMetricInput[] = [];
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      metricSink: {
        ...productionTestMetricSink(),
        record: (input) => records.push(input)
      },
      security: testSecurityWith()
    });
    await host.start();

    const issued = await issueTicket(host);
    const socket = await openSocket(host, String(issued.ticket));
    const readyMessage = nextMessage(socket, (message) => message.type === 'session.ready');
    socket.send(sessionStartText({ maxUtteranceSamples: 2 }));
    const ready = await readyMessage;
    socket.send(JSON.stringify({
      type: 'utterance.start',
      sessionId: String(ready.sessionId),
      sessionEpoch: Number(ready.sessionEpoch),
      utteranceId: UTTERANCE_ID
    }));

    const aborted = nextMessage(socket, (message) => message.type === 'utterance.aborted');
    const closed = waitForCloseDetails(socket);
    socket.send(frame(0, 0, new Uint8Array([1, 2, 3, 4])));
    socket.send(frame(1, 2, new Uint8Array([5, 6])));

    await expect(aborted).resolves.toMatchObject({
      type: 'utterance.aborted',
      category: 'duration'
    });
    await expect(closed).resolves.toEqual({ code: 4408, reason: 'duration_limit' });
    expect(records.filter((record) => record.name === 'state_store.failure')).toHaveLength(0);
  });

  it('fails closed when an audio grant makes no progress', async () => {
    await host.stop();
    const security = testSecurityWith();
    const records: RelayProductionMetricInput[] = [];
    const reserve = vi.spyOn(security.runtime, 'reserveAudio');
    const realSnapshot = AudioGrantMeter.prototype.snapshot;
    const snapshot = vi.spyOn(AudioGrantMeter.prototype, 'snapshot').mockImplementation(function (this: AudioGrantMeter) {
      const current = realSnapshot.call(this);
      return current.fromOriginalSampleOffset === 8_000
        ? { ...current, remainingOriginalSamples: 0 }
        : current;
    });
    const accept = vi.spyOn(AudioGrantMeter.prototype, 'accept');
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      metricSink: {
        ...productionTestMetricSink(),
        record: (input) => records.push(input)
      },
      security
    });
    await host.start();

    try {
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
      await grantBoundaryAck;

      const closed = waitForCloseDetails(socket);
      socket.send(frame(5, 8_000, new Uint8Array([1, 2])));
      await expect(closed).resolves.toEqual({ code: 4503, reason: 'provider_unavailable' });
      expect(reserve).toHaveBeenCalledTimes(2);
      expect(accept.mock.calls.some(([range]) =>
        range.fromOriginalSampleOffset === range.throughOriginalSampleOffset
      )).toBe(false);
      expect(records.filter((record) => record.name === 'state_store.failure')).toHaveLength(1);
      expect(records.filter((record) => record.name === 'provider.failure')).toHaveLength(0);
      socket.terminate();
    } finally {
      snapshot.mockRestore();
      accept.mockRestore();
    }
  });

  it('reserves audio in exact 8,000-sample ranges rather than writing per frame', async () => {
    await host.stop();
    const security = testSecurityWith();
    const reserve = vi.spyOn(security.runtime, 'reserveAudio');
    host = createRelayHostProduction({
      environment: ENVIRONMENT,
      origin: ORIGIN,
      port: 0,
      gatePolicyVersion: GATE_POLICY_VERSION,
      metricSink: productionTestMetricSink(),
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
