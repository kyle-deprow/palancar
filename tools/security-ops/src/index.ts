import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import {
  DEFAULT_NEGOTIATED_LIMITS,
  MAX_CONTROL_MESSAGE_BYTES,
  WEBSOCKET_SUBPROTOCOL,
  assertClientControlMessage,
  assertInstallationCredentialResponse,
  assertServerControlMessage,
  assertSessionTicketResponse,
  createWebSocketSubprotocols,
  encodeAudioFrame,
  type ServerControlMessage,
  type SessionReady
} from '@palancar/contracts';
import { LANGUAGE_REGISTRY_VERSION, type TargetLanguage } from '@palancar/language-registry';
import {
  createAzureCliTableOperations,
  type AzureCliTableOperationsOptions
} from '@palancar/security-state';
import WebSocket, { type RawData } from 'ws';

const execFile = promisify(execFileCallback);

const SECURITY_TABLE = 'SecurityState';
const RATE_TABLE = 'RateState';
const STREAM_PATH = '/v1/stream';
const READY_PATH = '/readyz';
const GATE_POLICY_VERSION = '1.0.0';
const AUDIO_SAMPLES_PER_FRAME = 1_600;
const AUDIO_FRAME_COUNT = 18;
const AUDIO_BYTES_PER_FRAME = AUDIO_SAMPLES_PER_FRAME * 2;
const OPERATION_TIMEOUT_MS = 20_000;
const GENERATION_TIMEOUT_MS = 120_000;
const READY_ATTEMPT_TIMEOUT_MS = 30_000;
const READY_RETRY_DELAY_MS = 1_000;
const CLEANUP_PAGE_LIMIT = 100;
const ALLOWED_ENV = new Set([
  'PALANCAR_OP_TABLE_ENDPOINT',
  'PALANCAR_OP_ENVIRONMENT',
  'PALANCAR_OP_RELAY_ORIGIN',
  'PALANCAR_OP_OPERATOR_SCOPE',
  'PALANCAR_OP_SUBSCRIPTION_ID',
  'PALANCAR_OP_TENANT_ID',
  'PALANCAR_OP_PRINCIPAL_ID'
]);

export type SecurityOpsCommand = 'initialize' | 'issue-pairing' | 'cleanup' | 'smoke';

export interface SecurityOpsConfig extends AzureCliTableOperationsOptions {
  readonly relayOrigin: `wss://${string}`;
  readonly operatorScope: string;
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly principalId: string;
}

type Operations = ReturnType<typeof createAzureCliTableOperations>;

interface SecurityOpsSocket {
  readonly protocol: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
  on(event: 'open' | 'error' | 'unexpected-response', listener: () => void): this;
  on(event: 'close', listener: (code: number) => void): this;
  once(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
  once(event: 'open' | 'error' | 'unexpected-response', listener: () => void): this;
  once(event: 'close', listener: (code: number) => void): this;
  off(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
  off(event: 'open' | 'error' | 'unexpected-response', listener: () => void): this;
  off(event: 'close', listener: (code: number) => void): this;
}

export interface SecurityOpsDependencies {
  readonly createOperations: (config: AzureCliTableOperationsOptions) => Operations;
  readonly fetch: typeof globalThis.fetch;
  readonly createSocket: (url: string, protocols: readonly string[]) => SecurityOpsSocket;
  readonly delay: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
  readonly verifyAzureContext: (config: SecurityOpsConfig) => Promise<void>;
}

export interface SecurityOpsIo {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

class SecurityOpsError extends Error {
  constructor() {
    super('Security operation failed.');
    this.name = 'SecurityOpsError';
  }
}

function fail(): never {
  throw new SecurityOpsError();
}

function required(env: NodeJS.ProcessEnv, name: string, maximum: number): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\r\n\0]/.test(value)) fail();
  return value;
}

function canonicalRelayOrigin(value: string): `wss://${string}` {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'wss:' || url.origin !== value || url.username !== '' ||
      url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    ) fail();
    return value as `wss://${string}`;
  } catch (error) {
    if (error instanceof SecurityOpsError) throw error;
    fail();
  }
}

export function parseSecurityOpsConfig(env: NodeJS.ProcessEnv): SecurityOpsConfig {
  for (const key of Object.keys(env)) {
    if (key.startsWith('PALANCAR_OP_') && !ALLOWED_ENV.has(key)) fail();
  }
  const endpointInput = required(env, 'PALANCAR_OP_TABLE_ENDPOINT', 255);
  const environment = required(env, 'PALANCAR_OP_ENVIRONMENT', 64);
  const relayOrigin = canonicalRelayOrigin(required(env, 'PALANCAR_OP_RELAY_ORIGIN', 255));
  const operatorScope = required(env, 'PALANCAR_OP_OPERATOR_SCOPE', 128);
  const subscriptionId = required(env, 'PALANCAR_OP_SUBSCRIPTION_ID', 36);
  const tenantId = required(env, 'PALANCAR_OP_TENANT_ID', 36);
  const principalId = required(env, 'PALANCAR_OP_PRINCIPAL_ID', 36);
  let endpoint: string;
  try {
    const url = new URL(endpointInput);
    if (
      !/^https:\/\/[a-z0-9]{3,24}\.table\.core\.windows\.net\/?$/.test(endpointInput) ||
      url.protocol !== 'https:' || url.pathname !== '/' || url.search !== '' ||
      url.hash !== '' || url.port !== '' || url.username !== '' || url.password !== '' ||
      !/^[a-z0-9]{3,24}\.table\.core\.windows\.net$/.test(url.hostname)
    ) fail();
    endpoint = url.origin;
  } catch (error) {
    if (error instanceof SecurityOpsError) throw error;
    fail();
  }
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(environment) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:._@-]{0,127}$/.test(operatorScope) ||
    ![subscriptionId, tenantId, principalId].every((value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ) || operatorScope !== `azure-cli:${principalId}`
  ) fail();
  return Object.freeze({
    endpoint,
    securityTableName: SECURITY_TABLE,
    rateTableName: RATE_TABLE,
    environment,
    audience: Object.freeze({ origin: relayOrigin, path: STREAM_PATH, protocol: WEBSOCKET_SUBPROTOCOL }),
    relayOrigin,
    operatorScope,
    subscriptionId,
    tenantId,
    principalId
  });
}

function parseCommand(arguments_: readonly string[]): SecurityOpsCommand {
  if (arguments_.length !== 1) fail();
  const command = arguments_[0];
  if (command !== 'initialize' && command !== 'issue-pairing' && command !== 'cleanup' && command !== 'smoke') fail();
  return command;
}

function httpsOrigin(origin: string): string {
  return `https://${origin.slice('wss://'.length)}`;
}

async function verifyAzureCliContext(config: SecurityOpsConfig): Promise<void> {
  try {
    const account = await execFile('az', [
      'account', 'show', '--query', '{subscription:id,tenant:tenantId}', '-o', 'json'
    ], { timeout: OPERATION_TIMEOUT_MS, maxBuffer: 4_096 });
    const tokenResult = await execFile('az', [
      'account', 'get-access-token', '--resource', 'https://storage.azure.com/',
      '--query', 'accessToken', '-o', 'tsv'
    ], { timeout: OPERATION_TIMEOUT_MS, maxBuffer: 32_768 });
    if (account.stdout.length > 4_096 || tokenResult.stdout.length > 32_768) fail();
    const parsed = JSON.parse(account.stdout) as unknown;
    const token = tokenResult.stdout.trim();
    const parts = token.split('.');
    if (parts.length !== 3 || parts[1] === undefined) fail();
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      (parsed as { subscription?: unknown }).subscription !== config.subscriptionId ||
      (parsed as { tenant?: unknown }).tenant !== config.tenantId ||
      typeof claims !== 'object' || claims === null || Array.isArray(claims) ||
      (claims as { oid?: unknown }).oid !== config.principalId ||
      (claims as { tid?: unknown }).tid !== config.tenantId
    ) fail();
  } catch (error) {
    if (error instanceof SecurityOpsError) throw error;
    fail();
  }
}

const PRODUCTION_DEPENDENCIES: SecurityOpsDependencies = Object.freeze({
  createOperations: createAzureCliTableOperations,
  fetch: globalThis.fetch,
  createSocket: (url: string, protocols: readonly string[]) => new WebSocket(url, [...protocols], {
    perMessageDeflate: false,
    handshakeTimeout: OPERATION_TIMEOUT_MS,
    maxPayload: MAX_CONTROL_MESSAGE_BYTES
  }) as unknown as SecurityOpsSocket,
  delay: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  now: () => performance.now(),
  verifyAzureContext: verifyAzureCliContext
});

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) fail();
  try {
    if (response.body === null) fail();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_CONTROL_MESSAGE_BYTES) {
        await reader.cancel();
        fail();
      }
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    fail();
  }
}

function socketUrl(origin: string): string {
  return `${origin}${STREAM_PATH}`;
}

function withTimeout<T>(promise: Promise<T>, milliseconds = OPERATION_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SecurityOpsError()), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); reject(new SecurityOpsError()); }
    );
  });
}

function rawText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  fail();
}

interface SocketLifecycle {
  readonly signal: AbortSignal;
  readonly failure: Promise<never>;
  race<T>(promise: Promise<T>): Promise<T>;
  expectNormalClose(): void;
  shutdown(): Promise<void>;
}

function monitorSocket(socket: SecurityOpsSocket): SocketLifecycle {
  const controller = new AbortController();
  let rejectFailure: (reason: SecurityOpsError) => void = () => undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => undefined);
  let failed = false;
  let shutdownStarted = false;
  let normalCloseExpected = false;
  let terminalSettled = false;
  let resolveTerminal: () => void = () => undefined;
  let terminalTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const settleTerminal = (): void => {
    if (terminalSettled) return;
    terminalSettled = true;
    if (terminalTimer !== undefined) clearTimeout(terminalTimer);
    resolveTerminal();
  };
  const failSocket = (): void => {
    if (failed || shutdownStarted) return;
    failed = true;
    clearTimeout(deadline);
    controller.abort();
    rejectFailure(new SecurityOpsError());
  };
  const onError = (): void => {
    if (!shutdownStarted) failSocket();
  };
  const onClose = (code: number): void => {
    if (shutdownStarted) {
      settleTerminal();
      return;
    }
    if (!normalCloseExpected || code !== 1000) failSocket();
  };
  socket.on('error', onError);
  socket.on('close', onClose);
  const deadline = setTimeout(failSocket, GENERATION_TIMEOUT_MS);
  return {
    signal: controller.signal,
    failure,
    race<T>(promise: Promise<T>): Promise<T> {
      return Promise.race([promise, failure]);
    },
    expectNormalClose(): void {
      normalCloseExpected = true;
    },
    shutdown(): Promise<void> {
      if (shutdownPromise !== undefined) return shutdownPromise;
      shutdownStarted = true;
      clearTimeout(deadline);
      controller.abort();
      shutdownPromise = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
        terminalTimer = setTimeout(settleTerminal, OPERATION_TIMEOUT_MS);
        if (socket.readyState === WebSocket.CLOSED) {
          settleTerminal();
          return;
        }
        try {
          socket.terminate();
        } catch {
          settleTerminal();
        }
      }).then(() => {
        socket.off('error', onError);
        socket.off('close', onClose);
      });
      return shutdownPromise;
    }
  };
}

function waitForOpen(socket: SecurityOpsSocket, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('unexpected-response', onFailure);
      signal.removeEventListener('abort', onAbort);
    };
    const onFailure = (): void => { cleanup(); reject(new SecurityOpsError()); };
    const onAbort = (): void => { onFailure(); };
    const onOpen = (): void => { cleanup(); resolve(); };
    const timer = setTimeout(onFailure, OPERATION_TIMEOUT_MS);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('open', onOpen);
    socket.once('unexpected-response', onFailure);
  });
}

function waitForMessage<T extends ServerControlMessage>(
  socket: SecurityOpsSocket,
  predicate: (message: ServerControlMessage) => message is T,
  signal: AbortSignal,
  timeoutMs = OPERATION_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('message', onMessage);
      signal.removeEventListener('abort', onAbort);
    };
    const onFailure = (): void => { cleanup(); reject(new SecurityOpsError()); };
    const onAbort = (): void => { onFailure(); };
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) return;
      try {
        const message = assertServerControlMessage(JSON.parse(rawText(data)) as unknown);
        if (message.type === 'error' || message.type === 'session.rejected' || message.type === 'utterance.aborted') {
          onFailure();
          return;
        }
        if (predicate(message)) {
          cleanup();
          resolve(message);
        }
      } catch {
        onFailure();
      }
    };
    const timer = setTimeout(onFailure, timeoutMs);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.on('message', onMessage);
  });
}

async function closeSocket(socket: SecurityOpsSocket, signal: AbortSignal): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('close', onClose);
      socket.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onClose = (code: number): void => {
      cleanup();
      if (code === 1000) resolve(); else reject(new SecurityOpsError());
    };
    const onError = (): void => { cleanup(); reject(new SecurityOpsError()); };
    const onAbort = (): void => {
      cleanup();
      reject(new SecurityOpsError());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new SecurityOpsError());
    }, OPERATION_TIMEOUT_MS);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

async function redeemPairingCredential(
  config: SecurityOpsConfig,
  operations: Operations,
  dependencies: SecurityOpsDependencies
): Promise<string> {
  const pairing = await operations.operator.issuePairing({ operatorScope: config.operatorScope });
  const origin = httpsOrigin(config.relayOrigin);
  const redemption = await dependencies.fetch(`${origin}/v1/pairing-redemptions`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode: pairing.pairingCode }),
    signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS)
  });
  const credential = assertInstallationCredentialResponse(await responseJson(redemption));
  return credential.credential;
}

async function issueSessionTicket(
  config: SecurityOpsConfig,
  credential: string,
  dependencies: SecurityOpsDependencies
): Promise<string> {
  const origin = httpsOrigin(config.relayOrigin);
  const ticketResponse = await dependencies.fetch(`${origin}/v1/session-tickets`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${credential}`
    },
    body: JSON.stringify({ protocolVersion: 1, intent: 'new' }),
    signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS)
  });
  const ticket = assertSessionTicketResponse(await responseJson(ticketResponse));
  if (ticket.wssOrigin !== config.relayOrigin || ticket.wssPath !== STREAM_PATH) fail();
  return ticket.ticket;
}

function isRelayReady(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'ready' && (value as { ready?: unknown }).ready === true;
}

async function awaitRelayReady(
  config: SecurityOpsConfig,
  dependencies: SecurityOpsDependencies
): Promise<void> {
  const deadline = dependencies.now() + GENERATION_TIMEOUT_MS;
  const url = `${httpsOrigin(config.relayOrigin)}${READY_PATH}`;
  const retry = async (): Promise<void> => {
    const remaining = deadline - dependencies.now();
    if (!Number.isFinite(remaining) || remaining <= 0) fail();
    const delayMs = Math.max(1, Math.min(READY_RETRY_DELAY_MS, Math.floor(remaining)));
    await withTimeout(dependencies.delay(delayMs), delayMs);
    if (dependencies.now() >= deadline) fail();
  };

  while (true) {
    const remaining = deadline - dependencies.now();
    if (!Number.isFinite(remaining) || remaining <= 0) fail();
    const attemptTimeout = Math.max(1, Math.min(READY_ATTEMPT_TIMEOUT_MS, Math.floor(remaining)));
    let response: Response;
    try {
      response = await withTimeout(dependencies.fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(attemptTimeout)
      } as RequestInit), attemptTimeout);
    } catch {
      await retry();
      continue;
    }
    if (response.status === 503) {
      await retry();
      continue;
    }
    if (response.status !== 200) fail();
    if (!isRelayReady(await responseJson(response))) fail();
    return;
  }
}

function isSessionReady(message: ServerControlMessage): message is SessionReady {
  return message.type === 'session.ready';
}

type TranscriptFinal = Extract<ServerControlMessage, { type: 'transcript.final' }>;
type LanguageDecision = Extract<ServerControlMessage, { type: 'language.decision' }>;
type TranslationReady = Extract<ServerControlMessage, { type: 'translation.ready' }>;
type SuggestionsReady = Extract<ServerControlMessage, { type: 'suggestions.ready' }>;

function collectTurnResults(
  socket: SecurityOpsSocket,
  ready: SessionReady,
  utteranceId: string,
  targetLanguage: TargetLanguage,
  signal: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let transcript: TranscriptFinal | undefined;
    let decision: LanguageDecision | undefined;
    let translation: TranslationReady | undefined;
    let suggestions: SuggestionsReady | undefined;
    let settling = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      socket.off('message', onMessage);
      signal.removeEventListener('abort', onAbort);
    };
    const onFailure = (): void => { cleanup(); reject(new SecurityOpsError()); };
    const onAbort = (): void => { onFailure(); };
    const finish = (): void => {
      if (transcript === undefined || decision === undefined || translation === undefined || suggestions === undefined) return;
      if (
        transcript.sessionId !== ready.sessionId || transcript.sessionEpoch !== ready.sessionEpoch ||
        decision.sessionId !== ready.sessionId || decision.sessionEpoch !== ready.sessionEpoch ||
        translation.sessionId !== ready.sessionId || translation.sessionEpoch !== ready.sessionEpoch ||
        suggestions.sessionId !== ready.sessionId || suggestions.sessionEpoch !== ready.sessionEpoch ||
        decision.segmentId !== transcript.segmentId || decision.revision !== transcript.revision ||
        translation.segmentId !== transcript.segmentId ||
        translation.acceptedFinalRevision !== transcript.revision ||
        suggestions.segmentId !== transcript.segmentId ||
        suggestions.acceptedFinalRevision !== transcript.revision ||
        decision.decision !== 'target' || decision.selectedTargetLanguage !== targetLanguage ||
        decision.detectedLanguage !== targetLanguage || decision.gatePolicyVersion !== GATE_POLICY_VERSION ||
        transcript.text.trim().length === 0 ||
        translation.englishTranslation.trim().length === 0 ||
        suggestions.suggestions.length < 2 || suggestions.suggestions.length > 3 ||
        suggestions.suggestions.some((item) =>
          item.englishText.trim().length === 0 || item.selectedTargetText.trim().length === 0 ||
          item.englishText === item.selectedTargetText
        )
      ) {
        onFailure();
        return;
      }
      if (!settling) {
        settling = true;
        settleTimer = setTimeout(() => { cleanup(); resolve(); }, 100);
      }
    };
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) { onFailure(); return; }
      try {
        const message = assertServerControlMessage(JSON.parse(rawText(data)) as unknown);
        if (message.type === 'error' || message.type === 'session.rejected' || message.type === 'utterance.aborted') {
          onFailure();
          return;
        }
        if (
          !('utteranceId' in message) || message.utteranceId !== utteranceId ||
          !['transcript.final', 'language.decision', 'translation.ready', 'suggestions.ready'].includes(message.type)
        ) return;
        if (message.type === 'transcript.final') {
          if (transcript !== undefined) { onFailure(); return; }
          transcript = message;
        } else if (message.type === 'language.decision') {
          if (decision !== undefined) { onFailure(); return; }
          decision = message;
        } else if (message.type === 'translation.ready') {
          if (translation !== undefined) { onFailure(); return; }
          translation = message;
        } else if (message.type === 'suggestions.ready') {
          if (suggestions !== undefined) { onFailure(); return; }
          suggestions = message;
        }
        finish();
      } catch {
        onFailure();
      }
    };
    const deadline = setTimeout(onFailure, GENERATION_TIMEOUT_MS);
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.on('message', onMessage);
  });
}

function effectiveLimitsDoNotExceed(
  effective: SessionReady['effectiveLimits'],
  requested: SessionReady['effectiveLimits']
): boolean {
  return (Object.keys(requested) as Array<keyof SessionReady['effectiveLimits']>).every((key) =>
    effective[key] <= requested[key]
  );
}

async function smokeTarget(
  config: SecurityOpsConfig,
  targetLanguage: TargetLanguage,
  credential: string,
  dependencies: SecurityOpsDependencies
): Promise<number> {
  const started = dependencies.now();
  const ticket = await issueSessionTicket(config, credential, dependencies);
  const socket = dependencies.createSocket(
    socketUrl(config.relayOrigin),
    createWebSocketSubprotocols(ticket)
  );
  const lifecycle = monitorSocket(socket);
  try {
    await lifecycle.race(waitForOpen(socket, lifecycle.signal));
    if (socket.protocol !== WEBSOCKET_SUBPROTOCOL) fail();
    const requestedLimits = DEFAULT_NEGOTIATED_LIMITS;
    const readyPromise = waitForMessage(socket, isSessionReady, lifecycle.signal);
    socket.send(JSON.stringify({
      type: 'session.start',
      protocolVersion: 1,
      wearerLanguage: 'en',
      targetLanguage,
      languageRegistryVersion: LANGUAGE_REGISTRY_VERSION,
      gatePolicyVersion: GATE_POLICY_VERSION,
      clientBuild: 'security-ops-0.1.0',
      requestedLimits
    }));
    const ready = await lifecycle.race(readyPromise);
    if (
      ready.result !== 'new' || ready.targetLanguage !== targetLanguage ||
      ready.languageRegistryVersion !== LANGUAGE_REGISTRY_VERSION ||
      ready.gatePolicyVersion !== GATE_POLICY_VERSION ||
      !effectiveLimitsDoNotExceed(ready.effectiveLimits, requestedLimits)
    ) fail();
    const utteranceId = randomUUID();
    socket.send(JSON.stringify({
      type: 'utterance.start',
      sessionId: ready.sessionId,
      sessionEpoch: ready.sessionEpoch,
      utteranceId
    }));
    for (let sequence = 0; sequence < AUDIO_FRAME_COUNT; sequence += 1) {
      const expectedOffset = (sequence + 1) * AUDIO_SAMPLES_PER_FRAME;
      const ack = waitForMessage(
        socket,
        (message): message is Extract<ServerControlMessage, { type: 'audio.ack' }> =>
          message.type === 'audio.ack' && message.utteranceId === utteranceId &&
          message.sessionId === ready.sessionId && message.sessionEpoch === ready.sessionEpoch &&
          message.flowState === 'normal' &&
          message.highestContiguousExclusiveOffset === expectedOffset,
        lifecycle.signal
      );
      socket.send(encodeAudioFrame({
        utteranceId,
        sequence,
        offset: sequence * AUDIO_SAMPLES_PER_FRAME,
        payload: new Uint8Array(AUDIO_BYTES_PER_FRAME)
      }));
      await lifecycle.race(ack);
      if (sequence + 1 < AUDIO_FRAME_COUNT) {
        await lifecycle.race(dependencies.delay(100));
      }
    }
    const turnResults = collectTurnResults(socket, ready, utteranceId, targetLanguage, lifecycle.signal);
    socket.send(JSON.stringify({
      type: 'utterance.commit',
      sessionId: ready.sessionId,
      sessionEpoch: ready.sessionEpoch,
      utteranceId,
      finalOriginalSampleOffset: AUDIO_FRAME_COUNT * AUDIO_SAMPLES_PER_FRAME
    }));
    await lifecycle.race(turnResults);
    lifecycle.expectNormalClose();
    const normalClose = closeSocket(socket, lifecycle.signal);
    socket.send(JSON.stringify(assertClientControlMessage({
      type: 'session.end',
      sessionId: ready.sessionId,
      sessionEpoch: ready.sessionEpoch,
      reason: 'user_requested'
    })));
    await lifecycle.race(normalClose);
    return Math.min(Math.max(0, Math.round(dependencies.now() - started)), GENERATION_TIMEOUT_MS);
  } catch {
    fail();
  } finally {
    await lifecycle.shutdown();
  }
  fail();
}

export async function runSecurityOps(
  arguments_: readonly string[],
  env: NodeJS.ProcessEnv,
  io: SecurityOpsIo,
  dependencies: SecurityOpsDependencies = PRODUCTION_DEPENDENCIES
): Promise<void> {
  const command = parseCommand(arguments_);
  const config = parseSecurityOpsConfig(env);
  if (command === 'issue-pairing' && (!io.stdinIsTty || !io.stdoutIsTty)) fail();
  await withTimeout(dependencies.verifyAzureContext(config));
  const operations = dependencies.createOperations({
    endpoint: config.endpoint,
    securityTableName: config.securityTableName,
    rateTableName: config.rateTableName,
    environment: config.environment,
    audience: config.audience
  });
  if (command === 'initialize') {
    await withTimeout(operations.bootstrap.initializeState(AbortSignal.timeout(OPERATION_TIMEOUT_MS)));
    await withTimeout(operations.maintenance.checkReadiness(AbortSignal.timeout(OPERATION_TIMEOUT_MS)));
    io.stdout('security-ops initialize: pass\n');
    return;
  }
  if (command === 'issue-pairing') {
    const pairing = await withTimeout(
      operations.operator.issuePairing({ operatorScope: config.operatorScope })
    );
    io.stdout(`${pairing.pairingCode}\n`);
    io.stderr('security-ops issue-pairing: issued once\n');
    return;
  }
  if (command === 'cleanup') {
    const result = await withTimeout(
      operations.maintenance.cleanupExpired({ limit: CLEANUP_PAGE_LIMIT })
    );
    io.stdout(`security-ops cleanup: pass visited=${result.visited} removed=${result.removed}\n`);
    return;
  }
  await awaitRelayReady(config, dependencies);
  const credential = await withTimeout(
    redeemPairingCredential(config, operations, dependencies),
    GENERATION_TIMEOUT_MS
  );
  const spanishMs = await smokeTarget(config, 'es', credential, dependencies);
  const turkishMs = await smokeTarget(config, 'tr', credential, dependencies);
  io.stdout(`security-ops smoke: pass targets=2 es_ms=${spanishMs} tr_ms=${turkishMs}\n`);
}

export function contentFreeFailure(): string {
  return 'security-ops: failed\n';
}
