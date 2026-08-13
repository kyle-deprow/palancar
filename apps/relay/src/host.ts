import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  MAX_CONTROL_MESSAGE_BYTES,
  WEBSOCKET_SUBPROTOCOL,
  assertCanonicalWssOrigin,
  assertSessionTicketRequest,
  assertSessionTicketResponse,
  type ServerControlMessage
} from '@palancar/contracts';
import {
  DeterministicMockProvider,
  GenerationService,
  LiteLLMChatGenerationProvider
} from '@palancar/generation';
import {
  DeterministicMockTranscriptionAdapter,
  type TranscriptionAdapter
} from '@palancar/transcription';
import { WebSocketServer, WebSocket } from 'ws';

import { DevelopmentTicketStore } from './dev-auth.js';
import { prepareStreamUpgrade } from './protocol.js';
import { RelaySessionCore } from './session.js';
import type {
  ConsumedRelayTicket,
  RelayClock,
  RelayIdGenerator,
  RelayStepResult,
  RelayTicketIntent,
  RelayUpgradeAudience
} from './types.js';

const SESSION_TICKET_PATH = '/v1/session-tickets';
const STREAM_PATH = '/v1/stream';
const MAX_SESSION_TICKET_BODY_BYTES = 4_096;
const DEFAULT_PORT = 8_787;
const DEFAULT_ENVIRONMENT = 'dev-local';
const DEFAULT_GATE_POLICY_VERSION = '1.0.0';
const DEFAULT_BIND_HOST = '127.0.0.1' as const;
const REQUEST_REJECTED_BODY = Object.freeze({ error: 'request_rejected' });
const RELAY_CONFIGURATION_ERROR = 'Invalid relay host configuration.';
const READINESS_TIMEOUT_MS = 2_000;
const READINESS_MAX_RESPONSE_BYTES = 16_384;

type RelayBindHost = '127.0.0.1' | '0.0.0.0';

interface MockGenerationReadiness {
  readonly provider: 'mock';
  readonly providerId: string;
  readonly model: 'mock';
}

interface LiteLLMGenerationReadiness {
  readonly provider: 'litellm';
  readonly providerId: string;
  readonly model: string;
  readonly backend: string;
  readonly upstreamModel: string;
  readonly check: () => Promise<boolean>;
}

export type RelayGenerationReadiness = MockGenerationReadiness | LiteLLMGenerationReadiness;

export interface RelayHostConfig {
  readonly environment: string;
  readonly origin: string;
  readonly port: number;
  readonly bindHost?: RelayBindHost;
  readonly gatePolicyVersion: string;
  readonly ticketStore?: DevelopmentTicketStore;
  readonly clock?: RelayClock;
  readonly ids?: RelayIdGenerator;
  readonly transcriptionAdapter?: TranscriptionAdapter;
  readonly generationService?: GenerationService;
  readonly generationReadiness?: RelayGenerationReadiness;
  readonly beforeServerMessageDelivery?: (message: ServerControlMessage) => void | Promise<void>;
}

export interface RelayHost {
  readonly server: Server;
  readonly ticketStore: DevelopmentTicketStore;
  start(): Promise<{ readonly port: number }>;
  stop(): Promise<void>;
}

interface RelayConnection {
  readonly socket: WebSocket;
  readonly core: RelaySessionCore;
  queue: Promise<void>;
  closed: boolean;
  coreClosed: boolean;
  drainScheduled: boolean;
}

interface BodyReadResult {
  readonly status: 'ok' | 'too_large' | 'invalid';
  readonly value?: unknown;
}

function systemClock(): RelayClock {
  return { nowIso: () => new Date().toISOString() };
}

function systemIds(): RelayIdGenerator {
  return {
    sessionId: () => randomUUID(),
    errorId: () => randomUUID()
  };
}

function defaultTranscriptionAdapter(): TranscriptionAdapter {
  return new DeterministicMockTranscriptionAdapter({ evidenceCategory: 'selected-target' });
}

function defaultGenerationService(): GenerationService {
  return new GenerationService(
    new DeterministicMockProvider({
      id: 'deterministic-mock-generation',
      complete: {
        result: {
          englishTranslation: 'hello',
          suggestions: [
          { englishText: 'hello', selectedTargetText: 'hola' },
          { englishText: 'hi', selectedTargetText: 'merhaba' }
          ]
        }
      }
    })
  );
}

function defaultGenerationReadiness(generationService: GenerationService): MockGenerationReadiness {
  return Object.freeze({
    provider: 'mock',
    providerId: generationService.provider.id,
    model: 'mock'
  });
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError('Relay port is invalid');
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }
  if (!/^\d+$/.test(value)) {
    throw new RangeError('Relay PORT is invalid');
  }
  return normalizePort(Number(value));
}

function parseBindHost(value: string | undefined): RelayBindHost {
  const bindHost = value ?? DEFAULT_BIND_HOST;
  if (bindHost !== '127.0.0.1' && bindHost !== '0.0.0.0') {
    throw new RangeError('Relay bind host is invalid');
  }
  return bindHost;
}

function requiredEnvironmentString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value;
}

function parseOptionalTimeout(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return timeoutMs;
}

function normalizedReadinessUrl(value: string): string {
  let url: URL;
  try {
    if (value.trim() !== value) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    url = new URL(value);
  } catch {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    value.includes('?') ||
    value.includes('#')
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return url.toString().replace(/\/+$/, '');
}

function readinessUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

async function readBoundedReadinessBody(response: Response): Promise<string | undefined> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const bytes = Number(contentLength);
    if (!Number.isSafeInteger(bytes) || bytes > READINESS_MAX_RESPONSE_BYTES) {
      try {
        await response.body?.cancel();
      } catch {
        // The body is intentionally never surfaced in readiness failures.
      }
      return undefined;
    }
  }

  if (response.body === null) {
    try {
      const text = await response.text();
      return new TextEncoder().encode(text).byteLength <= READINESS_MAX_RESPONSE_BYTES
        ? text
        : undefined;
    } catch {
      return undefined;
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        return undefined;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > READINESS_MAX_RESPONSE_BYTES) {
        return undefined;
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Readiness is content-free and failure is represented only by false.
    }
  }
}

async function fetchReadinessJson(url: string, apiKey?: string): Promise<unknown | undefined> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = (async (): Promise<unknown | undefined> => {
    try {
      const response = await globalThis.fetch(url, {
        method: 'GET',
        redirect: 'error',
        ...(apiKey === undefined
          ? {}
          : { headers: { Authorization: `Bearer ${apiKey}` } }),
        signal: controller.signal
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // The body is intentionally never surfaced in readiness failures.
        }
        return undefined;
      }
      const body = await readBoundedReadinessBody(response);
      if (body === undefined) {
        return undefined;
      }
      try {
        return JSON.parse(body) as unknown;
      } catch {
        return undefined;
      }
    } catch {
      return undefined;
    }
  })();
  const timeoutPromise = new Promise<undefined>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('readiness_timeout'));
    }, READINESS_TIMEOUT_MS);
  });

  try {
    return await Promise.race([request, timeoutPromise]);
  } catch {
    return undefined;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExpectedModel(value: unknown, model: string): boolean {
  if (!isPlainObject(value) || !Array.isArray(value.data)) {
    return false;
  }
  let matches = 0;
  for (const item of value.data) {
    if (isPlainObject(item) && item.id === model) {
      matches += 1;
    }
  }
  return matches === 1;
}

function hasExpectedMetadata(
  value: unknown,
  expected: Pick<LiteLLMGenerationReadiness, 'backend' | 'model' | 'upstreamModel'>
): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 3 &&
    keys.includes('alias') &&
    keys.includes('backend') &&
    keys.includes('upstreamModel') &&
    value.alias === expected.model &&
    value.backend === expected.backend &&
    value.upstreamModel === expected.upstreamModel
  );
}

async function checkLiteLLMReadiness(config: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly metadataUrl: string;
  readonly backend: string;
  readonly upstreamModel: string;
}): Promise<boolean> {
  const catalog = await fetchReadinessJson(
    readinessUrl(config.baseUrl, '/v1/models'),
    config.apiKey
  );
  if (!hasExpectedModel(catalog, config.model)) {
    return false;
  }
  const metadata = await fetchReadinessJson(
    readinessUrl(config.metadataUrl, '/palancar/provider')
  );
  return hasExpectedMetadata(metadata, config);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

interface UpgradeSocket {
  write(chunk: string): void;
  destroy(): void;
}

interface PendingUpgrade {
  readonly socket: UpgradeSocket;
  decision: Promise<void>;
}

function writeRejectedUpgrade(socket: UpgradeSocket, status: number): void {
  const body = JSON.stringify(REQUEST_REJECTED_BODY);
  const reason = status === 400
    ? 'Bad Request'
    : status === 401
      ? 'Unauthorized'
      : status === 403
        ? 'Forbidden'
        : status === 404
          ? 'Not Found'
          : status === 409
            ? 'Conflict'
            : status === 429
              ? 'Too Many Requests'
              : 'Service Unavailable';
  const response = [
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n');
  socket.write(response);
  socket.destroy();
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value.join(',');
  }
  return value;
}

function offeredSubprotocols(request: IncomingMessage): readonly string[] {
  const header = headerValue(request, 'sec-websocket-protocol');
  if (header === undefined) {
    return [];
  }
  return header.split(',').map((value) => value.trim());
}

function readJsonBody(request: IncomingMessage): Promise<BodyReadResult> {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined && /^\d+$/.test(contentLength)) {
    if (Number(contentLength) > MAX_SESSION_TICKET_BODY_BYTES) {
      request.resume();
      return Promise.resolve({ status: 'too_large' });
    }
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;

    const finish = (result: BodyReadResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    request.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > MAX_SESSION_TICKET_BODY_BYTES) {
        finish({ status: 'too_large' });
        request.removeAllListeners('data');
        request.resume();
        return;
      }
      chunks.push(bytes);
    });
    request.on('end', () => {
      if (settled) {
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        finish({ status: 'ok', value: JSON.parse(text) as unknown });
      } catch {
        finish({ status: 'invalid' });
      }
    });
    request.on('error', () => finish({ status: 'invalid' }));
  });
}

function rawDataBuffer(data: unknown): Buffer | undefined {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    const buffers: Buffer[] = [];
    for (const part of data) {
      if (Buffer.isBuffer(part)) {
        buffers.push(part);
      } else if (part instanceof ArrayBuffer) {
        buffers.push(Buffer.from(part));
      } else if (ArrayBuffer.isView(part)) {
        buffers.push(Buffer.from(
          part.buffer as ArrayBuffer,
          part.byteOffset,
          part.byteLength
        ));
      } else {
        return undefined;
      }
    }
    return Buffer.concat(buffers);
  }
  return undefined;
}

export function parseRelayHostConfig(env: NodeJS.ProcessEnv = process.env): RelayHostConfig {
  try {
    const port = parsePort(env.PORT);
    const origin = env.PALANCAR_RELAY_ORIGIN ??
      (port === 0 ? 'wss://127.0.0.1' : `wss://127.0.0.1:${port}`);
    assertCanonicalWssOrigin(origin);
    const generationProvider = env.PALANCAR_GENERATION_PROVIDER;
    if (generationProvider !== 'mock' && generationProvider !== 'litellm') {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }

    const baseConfig = {
      environment: env.PALANCAR_RELAY_ENVIRONMENT ?? DEFAULT_ENVIRONMENT,
      origin,
      port,
      bindHost: parseBindHost(env.PALANCAR_RELAY_BIND_HOST),
      gatePolicyVersion: env.PALANCAR_GATE_POLICY_VERSION ?? DEFAULT_GATE_POLICY_VERSION
    };
    if (generationProvider === 'mock') {
      const generationService = defaultGenerationService();
      return Object.freeze({
        ...baseConfig,
        generationService,
        generationReadiness: defaultGenerationReadiness(generationService)
      });
    }

    const baseUrl = requiredEnvironmentString(env, 'PALANCAR_LITELLM_BASE_URL');
    const apiKey = requiredEnvironmentString(env, 'PALANCAR_LITELLM_API_KEY');
    const model = requiredEnvironmentString(env, 'PALANCAR_LITELLM_MODEL');
    const expectedBackend = requiredEnvironmentString(
      env,
      'PALANCAR_LITELLM_EXPECTED_BACKEND'
    );
    const expectedUpstreamModel = requiredEnvironmentString(
      env,
      'PALANCAR_LITELLM_EXPECTED_UPSTREAM_MODEL'
    );
    const metadataUrl = requiredEnvironmentString(env, 'PALANCAR_LITELLM_METADATA_URL');
    const timeoutMs = parseOptionalTimeout(env.PALANCAR_LITELLM_TIMEOUT_MS);
    const normalizedBaseUrl = normalizedReadinessUrl(baseUrl);
    const normalizedMetadataUrl = normalizedReadinessUrl(metadataUrl);
    const provider = new LiteLLMChatGenerationProvider({
      baseUrl,
      apiKey,
      model,
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
    const generationService = new GenerationService(provider);
    const generationReadiness: LiteLLMGenerationReadiness = Object.freeze({
      provider: 'litellm',
      providerId: generationService.provider.id,
      model,
      backend: expectedBackend,
      upstreamModel: expectedUpstreamModel,
      check: () => checkLiteLLMReadiness({
        baseUrl: normalizedBaseUrl,
        apiKey,
        model,
        metadataUrl: normalizedMetadataUrl,
        backend: expectedBackend,
        upstreamModel: expectedUpstreamModel
      })
    });
    return Object.freeze({
      ...baseConfig,
      generationService,
      generationReadiness
    });
  } catch {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
}

export function createRelayHost(config: RelayHostConfig): RelayHost {
  const environment = config.environment;
  const origin = assertCanonicalWssOrigin(config.origin);
  const port = normalizePort(config.port);
  const bindHost = parseBindHost(config.bindHost);
  const gatePolicyVersion = config.gatePolicyVersion;
  const ticketStore = config.ticketStore ?? new DevelopmentTicketStore();
  const clock = config.clock ?? systemClock();
  const ids = config.ids ?? systemIds();
  const transcriptionAdapter = config.transcriptionAdapter ?? defaultTranscriptionAdapter();
  const generationService = config.generationService ?? defaultGenerationService();
  const beforeServerMessageDelivery = config.beforeServerMessageDelivery;
  const generationReadiness = config.generationReadiness ??
    defaultGenerationReadiness(generationService);
  const audience: RelayUpgradeAudience = Object.freeze({
    environment,
    origin,
    path: STREAM_PATH,
    protocol: WEBSOCKET_SUBPROTOCOL
  });
  const connections = new Set<RelayConnection>();
  const claims = new WeakMap<WebSocket, ConsumedRelayTicket>();
  const pendingUpgrades = new Set<PendingUpgrade>();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;

  const webSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_CONTROL_MESSAGE_BYTES,
    handleProtocols: () => WEBSOCKET_SUBPROTOCOL
  });

  const server = createServer((request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      writeJson(response, 404, REQUEST_REJECTED_BODY);
      return;
    }

    if (pathname === '/healthz' && request.method === 'GET') {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (pathname === '/readyz' && request.method === 'GET') {
      if (generationReadiness.provider === 'mock') {
        writeJson(response, 200, {
          ready: true,
          generation: {
            provider: generationReadiness.provider,
            providerId: generationReadiness.providerId,
            model: generationReadiness.model,
            upstreamReady: true
          }
        });
        return;
      }
      void generationReadiness.check().then((upstreamReady) => {
        writeJson(response, upstreamReady ? 200 : 503, {
          ready: upstreamReady,
          generation: {
            provider: generationReadiness.provider,
            providerId: generationReadiness.providerId,
            model: generationReadiness.model,
            backend: generationReadiness.backend,
            upstreamModel: generationReadiness.upstreamModel,
            upstreamReady
          }
        });
      }).catch(() => {
        writeJson(response, 503, {
          ready: false,
          generation: {
            provider: generationReadiness.provider,
            providerId: generationReadiness.providerId,
            model: generationReadiness.model,
            backend: generationReadiness.backend,
            upstreamModel: generationReadiness.upstreamModel,
            upstreamReady: false
          }
        });
      });
      return;
    }
    if (pathname === SESSION_TICKET_PATH) {
      if (request.method !== 'POST') {
        writeJson(response, 405, REQUEST_REJECTED_BODY);
        return;
      }
      const contentType = request.headers['content-type'];
      if (contentType === undefined || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
        request.resume();
        writeJson(response, 400, REQUEST_REJECTED_BODY);
        return;
      }
      void readJsonBody(request).then((body) => {
        if (body.status === 'too_large') {
          writeJson(response, 413, REQUEST_REJECTED_BODY);
          return;
        }
        if (body.status !== 'ok') {
          writeJson(response, 400, REQUEST_REJECTED_BODY);
          return;
        }
        try {
          const requestBody = assertSessionTicketRequest(body.value);
          const intent: RelayTicketIntent = requestBody.intent === 'new'
            ? { intent: 'new' }
            : { intent: 'resume', sessionId: requestBody.sessionId };
          const issued = ticketStore.issue({ intent, audience });
          const result = {
            ticket: issued.ticket,
            wssOrigin: origin,
            wssPath: STREAM_PATH,
            protocolVersion: 1,
            expiresAt: issued.expiresAt
          };
          assertSessionTicketResponse(result);
          writeJson(response, 200, result);
        } catch {
          writeJson(response, 400, REQUEST_REJECTED_BODY);
        }
      }).catch(() => {
        writeJson(response, 400, REQUEST_REJECTED_BODY);
      });
      return;
    }
    writeJson(response, 404, REQUEST_REJECTED_BODY);
  });

  const closeCoreOnce = (connection: RelayConnection): void => {
    if (connection.coreClosed) {
      return;
    }
    connection.coreClosed = true;
    try {
      connection.core.close();
    } catch {
      // Cleanup is best effort and intentionally content-free.
    }
  };

  const closeConnection = (connection: RelayConnection, code: number, reason: string): void => {
    if (connection.socket.readyState === WebSocket.OPEN) {
      try {
        connection.socket.close(code, reason);
      } catch {
        connection.socket.terminate();
      }
    } else if (connection.socket.readyState === WebSocket.CONNECTING) {
      connection.socket.terminate();
    }
  };

  const deliver = async (connection: RelayConnection, result: RelayStepResult): Promise<void> => {
    if (connection.socket.readyState === WebSocket.OPEN) {
      for (const message of result.outgoing) {
        if (beforeServerMessageDelivery !== undefined) {
          await beforeServerMessageDelivery(message);
        }
        connection.socket.send(JSON.stringify(message));
      }
    }
    if (result.close !== undefined) {
      closeConnection(connection, result.close.code, result.close.reason);
    }
  };

  const enqueue = (connection: RelayConnection, work: () => Promise<void> | void): void => {
    connection.queue = connection.queue.then(async () => {
      if (!connection.closed) {
        await work();
      }
    }).catch(() => {
      if (!connection.closed) {
        closeConnection(connection, 1011, 'server_error');
      }
    });
  };

  webSocketServer.on('connection', (socket) => {
    const ticketClaim = claims.get(socket);
    claims.delete(socket);
    if (ticketClaim === undefined) {
      socket.close(1008, 'request_rejected');
      return;
    }

    let requestDrain: () => void = () => undefined;
    const core = new RelaySessionCore({
      ticketClaim,
      clock,
      ids,
      transcriptionAdapter,
      generationService,
      gatePolicyVersion,
      onAsyncEventsAvailable: () => requestDrain()
    });
    const connection: RelayConnection = {
      socket,
      core,
      queue: Promise.resolve(),
      closed: false,
      coreClosed: false,
      drainScheduled: false
    };
    connections.add(connection);

    const scheduleDrain = (): void => {
      if (connection.closed || connection.drainScheduled) {
        return;
      }
      connection.drainScheduled = true;
      enqueue(connection, async () => {
        try {
          if (connection.socket.readyState === WebSocket.OPEN) {
            await deliver(connection, await core.drainAsyncEvents());
          }
        } finally {
          connection.drainScheduled = false;
        }
        if (
          !connection.closed &&
          connection.socket.readyState === WebSocket.OPEN &&
          core.hasPendingAsyncEvents()
        ) {
          scheduleDrain();
        }
      });
    };
    requestDrain = scheduleDrain;

    socket.on('message', (data, isBinary) => {
      enqueue(connection, async () => {
        if (connection.socket.readyState !== WebSocket.OPEN) {
          return;
        }
        let result: RelayStepResult;
        if (isBinary) {
          const bytes = rawDataBuffer(data);
          if (bytes === undefined) {
            closeConnection(connection, 1003, 'unsupported_data');
            return;
          }
          result = core.handleBinary(new Uint8Array(bytes));
        } else {
          const bytes = rawDataBuffer(data);
          if (bytes === undefined) {
            closeConnection(connection, 1003, 'unsupported_data');
            return;
          }
          result = core.handleText(bytes.toString('utf8'));
        }
        await deliver(connection, result);
        if (result.close === undefined && connection.socket.readyState === WebSocket.OPEN) {
          scheduleDrain();
        }
      });
    });
    socket.on('close', () => {
      connection.closed = true;
      closeCoreOnce(connection);
      connections.delete(connection);
    });
    socket.on('error', () => {
      closeCoreOnce(connection);
    });
  });

  server.on('clientError', (_error, errorSocket) => {
    errorSocket.destroy();
  });

  server.on('upgrade', (request, socket, head) => {
    if (stopping) {
      socket.destroy();
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      writeRejectedUpgrade(socket, 404);
      return;
    }
    if (request.method !== 'GET' || pathname !== STREAM_PATH) {
      writeRejectedUpgrade(socket, 404);
      return;
    }

    const pendingUpgrade: PendingUpgrade = {
      socket,
      decision: Promise.resolve()
    };
    pendingUpgrades.add(pendingUpgrade);
    pendingUpgrade.decision = prepareStreamUpgrade({
      offeredSubprotocols: offeredSubprotocols(request),
      audience,
      ticketConsumer: ticketStore
    }).then((prepared) => {
      if (stopping) {
        socket.destroy();
        return;
      }
      if (prepared.status === 'rejected') {
        writeRejectedUpgrade(socket, prepared.httpStatus);
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        claims.set(webSocket, prepared.ticketClaim);
        webSocketServer.emit('connection', webSocket, request);
      });
    }).catch(() => {
      if (stopping) {
        socket.destroy();
        return;
      }
      writeRejectedUpgrade(socket, 503);
    });
    void pendingUpgrade.decision.then(
      () => pendingUpgrades.delete(pendingUpgrade),
      () => pendingUpgrades.delete(pendingUpgrade)
    );
  });

  const start = (): Promise<{ readonly port: number }> => new Promise((resolve, reject) => {
    if (server.listening) {
      const address = server.address();
      if (address !== null && typeof address !== 'string') {
        resolve({ port: address.port });
        return;
      }
    }
    const onError = (): void => {
      server.removeListener('listening', onListening);
      reject(new Error('relay_start_failed'));
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('relay_start_failed'));
        return;
      }
      resolve({ port: address.port });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, bindHost);
  });

  const closeServer = (): Promise<void> => new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const stop = (): Promise<void> => {
    if (stopPromise !== undefined) {
      return stopPromise;
    }
    stopping = true;
    for (const pendingUpgrade of pendingUpgrades) {
      try {
        writeRejectedUpgrade(pendingUpgrade.socket, 503);
      } catch {
        pendingUpgrade.socket.destroy();
      }
    }
    stopPromise = Promise.all([
      closeServer(),
      Promise.all(Array.from(connections, (connection) => new Promise<void>((resolve) => {
        if (connection.socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        connection.socket.once('close', () => resolve());
        closeConnection(connection, 1001, 'server_shutdown');
      })))
    ]).then(() => undefined);
    return stopPromise;
  };

  return { server, ticketStore, start, stop };
}
