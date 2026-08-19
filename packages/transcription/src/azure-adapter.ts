import WebSocket from 'ws';

import {
  MAX_UTTERANCE_SAMPLES,
  assertTranscriptFinal,
  assertTranscriptPartial
} from '@palancar/contracts';
import { LinearPcm16To24AudioResampler } from '@palancar/audio';

import {
  buildAzureRealtimeInputAudioClearMessage,
  buildAzureRealtimeInputAudioCommitMessage,
  buildAzureRealtimeSessionUpdateMessage,
  type AzureRealtimeClientMessage
} from './azure-client.js';
import {
  AzureRealtimeServerEventError,
  parseAzureRealtimeServerEvent,
  type AzureRealtimeServerEvent
} from './azure-server.js';
import { TranscriptionSessionError } from './errors.js';
import type {
  CancelResult,
  CloseResult,
  CreateTranscriptionSessionInput,
  EventDeliveryFailureStatus,
  FinalizeResult,
  NormalizedLanguageEvidence,
  NormalizedTranscriptionEvent,
  NormalizedTranscriptionFinal,
  NormalizedTranscriptionPartial,
  PushAudioInput,
  PushAudioResult,
  StartUtteranceInput,
  StartUtteranceResult,
  TranscriptionAdapter,
  TranscriptionCapabilities,
  TranscriptionConnectionState,
  TranscriptionFailure,
  TranscriptionFailureReason,
  TranscriptionReadiness,
  TranscriptionSession,
  TranscriptionSessionConfiguration,
  TranscriptionSessionState
} from './types.js';

export const AZURE_REALTIME_TRANSCRIPTION_READY_TIMEOUT_MS = 5_000 as const;
export const AZURE_REALTIME_TRANSCRIPTION_FINALIZATION_TIMEOUT_MS = 10_000 as const;
export const AZURE_REALTIME_TRANSCRIPTION_QUEUE_BYTES = 128 * 1024;
export const AZURE_REALTIME_TRANSCRIPTION_BUFFERED_HIGH_WATER_MARK_BYTES = 64 * 1024;
export const AZURE_REALTIME_TRANSCRIPTION_APPEND_MAX_BYTES = 4_800 as const;
export const AZURE_REALTIME_TRANSCRIPTION_COMMIT_CADENCE_MS = 600 as const;
export const AZURE_REALTIME_TRANSCRIPTION_COMMIT_ORIGINAL_SAMPLES = 9_600 as const;
export const AZURE_REALTIME_TRANSCRIPTION_COMMIT_PROVIDER_SAMPLES = 14_400 as const;

const SOCKET_OPEN = 1 as const;
const DEPLOYMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/;
const AZURE_OPENAI_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.openai\.azure\.com$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;
const TEXT_ENCODER = new TextEncoder();

export type AzureRealtimeSocketEvent = 'open' | 'message' | 'error' | 'close';

/** Small websocket surface that keeps the adapter deterministic and testable. */
export interface AzureRealtimeSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code?: number): void;
  terminate(): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'error', listener: () => void): void;
  on(event: 'close', listener: () => void): void;
  off(event: AzureRealtimeSocketEvent, listener: (...args: never[]) => void): void;
}

export type AzureTokenProvider = (
  signal: AbortSignal
) => Promise<Readonly<{ token: string; expiresOnTimestamp: number }>>;

export type AzureRealtimeSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>
) => AzureRealtimeSocket;

export type AzureRealtimeClock = () => Date | number;

export interface AzureRealtimeTranscriptionAdapterOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly tokenProvider: AzureTokenProvider;
  readonly socketFactory?: AzureRealtimeSocketFactory;
  readonly clock?: AzureRealtimeClock;
  readonly readyTimeoutMs?: number;
  readonly finalizationTimeoutMs?: number;
  readonly queueBytes?: number;
  readonly bufferedHighWaterMarkBytes?: number;
  readonly appendMaxBytes?: number;
  readonly maxUtteranceSamples?: number;
}

export type AzureRealtimeAdapterErrorReason =
  | 'invalid-options'
  | 'invalid-audio'
  | 'backpressure'
  | 'closed'
  | 'no-active-utterance'
  | 'wrong-utterance'
  | 'stale-utterance'
  | 'finalization-requested';

export class AzureRealtimeAdapterError extends TypeError {
  readonly reason: AzureRealtimeAdapterErrorReason;

  constructor(reason: AzureRealtimeAdapterErrorReason) {
    super(`Azure Realtime transcription ${reason.replaceAll('-', ' ')}.`);
    this.name = 'AzureRealtimeAdapterError';
    this.reason = reason;
  }
}

const AZURE_CAPABILITIES: Readonly<TranscriptionCapabilities> = Object.freeze({
  identity: Object.freeze({
    provider: 'azure-realtime',
    model: 'deployment-selected-at-runtime',
    version: 'ga-transcription-websocket'
  }),
  acceptedInput: Object.freeze({ sampleRateHz: 16_000, sampleFormat: 's16le', channels: 1 }),
  providerInput: Object.freeze({ sampleRateHz: 24_000, sampleFormat: 's16le', channels: 1 }),
  resampling: Object.freeze({ mode: 'required', stateful: true }),
  serverVad: Object.freeze({ supported: true, modes: Object.freeze(['disabled'] as const) }),
  manualCommit: Object.freeze({
    supported: true,
    cadencesMs: Object.freeze([AZURE_REALTIME_TRANSCRIPTION_COMMIT_CADENCE_MS])
  }),
  languageModes: Object.freeze(['automatic'] as const),
  partialResults: Object.freeze({ supported: true }),
  providerRetention: Object.freeze({ status: 'unverified', evidenceVersion: 'pending-adr-0002' })
});

const ACTIVE_CONFIGURED_STATES = Object.freeze([
  'ready',
  'finalizing'
] as const satisfies readonly TranscriptionConnectionState[]);

/** Exhaustive protocol-state admission table for every parsed server event. */
const AZURE_SERVER_EVENT_ALLOWED_STATES = Object.freeze({
  'session.created': Object.freeze(['configuring'] as const),
  'session.updated': Object.freeze(['configuring'] as const),
  'rate_limits.updated': ACTIVE_CONFIGURED_STATES,
  'input_audio_buffer.committed': ACTIVE_CONFIGURED_STATES,
  'input_audio_buffer.cleared': Object.freeze([] as const),
  'input_audio_buffer.speech_started': Object.freeze([] as const),
  'input_audio_buffer.speech_stopped': Object.freeze([] as const),
  'input_audio_buffer.timeout_triggered': Object.freeze([] as const),
  'conversation.item.created': ACTIVE_CONFIGURED_STATES,
  'conversation.item.input_audio_transcription.delta': ACTIVE_CONFIGURED_STATES,
  'conversation.item.input_audio_transcription.completed': ACTIVE_CONFIGURED_STATES,
  'conversation.item.input_audio_transcription.segment': ACTIVE_CONFIGURED_STATES,
  'conversation.item.input_audio_transcription.failed': ACTIVE_CONFIGURED_STATES,
  error: Object.freeze(['configuring', 'ready', 'finalizing'] as const)
} satisfies Readonly<Record<
  AzureRealtimeServerEvent['type'],
  readonly TranscriptionConnectionState[]
>>);

interface QueueEntry {
  readonly payload: string;
  readonly bytes: number;
  readonly kind: 'session.update' | 'append' | 'commit' | 'clear';
  readonly commitOriginalOffset?: number;
}

interface CommittedItem {
  readonly itemId: string;
  readonly originalOffset: number;
  readonly order: number;
  created: boolean;
  text: string;
  completed: boolean;
}

interface AzureAdapterRuntimeOptions {
  readonly readyTimeoutMs: number;
  readonly finalizationTimeoutMs: number;
  readonly queueBytes: number;
  readonly bufferedHighWaterMarkBytes: number;
  readonly appendMaxBytes: number;
  readonly maxUtteranceSamples: number;
  readonly clock: AzureRealtimeClock;
}

type TerminalStatus = 'cancelled' | 'finalized' | 'failed';

function adapterError(reason: AzureRealtimeAdapterErrorReason): never {
  throw new AzureRealtimeAdapterError(reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertUuidLike(value: string, label: string): void {
  if (typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TranscriptionSessionError('invalid-identifier', `${label} must be a canonical UUID`);
  }
}

function assertSessionEpoch(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 4_294_967_295) {
    throw new TranscriptionSessionError(
      'invalid-identifier',
      'Session epoch must be a positive unsigned 32-bit integer'
    );
  }
}

function validateWebSocketEndpoint(endpoint: string): string {
  if (typeof endpoint !== 'string' || endpoint.length < 1 || endpoint.length > 512) {
    throw new TypeError('Invalid Azure Realtime endpoint');
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError('Invalid Azure Realtime endpoint');
  }
  if (
    parsed.protocol !== 'wss:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.hash !== '' ||
    parsed.pathname !== '/openai/v1/realtime' ||
    !AZURE_OPENAI_HOST_PATTERN.test(parsed.hostname) ||
    parsed.searchParams.size !== 1 ||
    parsed.searchParams.getAll('intent').length !== 1 ||
    parsed.searchParams.get('intent') !== 'transcription'
  ) {
    throw new TypeError('Invalid Azure Realtime endpoint');
  }
  const canonical = `wss://${parsed.hostname}/openai/v1/realtime?intent=transcription`;
  if (endpoint !== canonical) {
    throw new TypeError('Invalid Azure Realtime endpoint');
  }
  return canonical;
}

function defaultSocketFactory(url: string, headers: Readonly<Record<string, string>>): AzureRealtimeSocket {
  return new WebSocket(url, { headers }) as unknown as AzureRealtimeSocket;
}

function messageDataToInput(data: unknown): string | Uint8Array {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof Uint8Array) {
    return new Uint8Array(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  throw new TypeError('Unsupported websocket message data');
}

function normalizeText(value: string): string {
  return value.normalize('NFC').trim();
}

function tokens(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized.length === 0 ? [] : normalized.split(/\s+/u);
}

function joinSegments(segments: readonly string[]): string {
  let result = '';
  for (const segment of segments) {
    const current = normalizeText(segment);
    if (current.length === 0) {
      continue;
    }
    if (result.length === 0) {
      result = current;
      continue;
    }
    const left = tokens(result);
    const right = tokens(current);
    let overlap = 0;
    const limit = Math.min(left.length, right.length);
    for (let count = limit; count >= 2; count -= 1) {
      const leftTail = left.slice(left.length - count).join('\u0000');
      const rightHead = right.slice(0, count).join('\u0000');
      if (leftTail === rightHead) {
        overlap = count;
        break;
      }
    }
    const suffix = right.slice(overlap).join(' ');
    if (suffix.length > 0) {
      result = `${result} ${suffix}`;
    }
  }
  return normalizeText(result);
}

function advisoryLanguageEvidence(): Readonly<NormalizedLanguageEvidence> {
  return Object.freeze({
    detectorVersion: 'azure-realtime-advisory-1',
    source: 'transcription-metadata'
  });
}

function jsonMessage(message: AzureRealtimeClientMessage, eventId: string): string {
  return JSON.stringify({ ...message, event_id: eventId });
}

function validateFiniteOption(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError(`Invalid Azure Realtime ${label}`);
  }
  return result;
}

function systemClock(): Date {
  return new Date();
}

export class AzureRealtimeTranscriptionAdapter implements TranscriptionAdapter {
  readonly capabilities = AZURE_CAPABILITIES;
  readonly endpoint: string;
  readonly deployment: string;
  readonly #tokenProvider: AzureTokenProvider;
  readonly #socketFactory: AzureRealtimeSocketFactory;
  readonly #options: Readonly<AzureAdapterRuntimeOptions>;

  constructor(options: AzureRealtimeTranscriptionAdapterOptions) {
    if (!isPlainObject(options) || !DEPLOYMENT_PATTERN.test(options.deployment)) {
      throw new TypeError('Invalid Azure Realtime adapter options');
    }
    this.endpoint = validateWebSocketEndpoint(options.endpoint);
    this.deployment = options.deployment;
    if (typeof options.tokenProvider !== 'function') {
      throw new TypeError('Invalid Azure Realtime token provider');
    }
    if (options.clock !== undefined && typeof options.clock !== 'function') {
      throw new TypeError('Invalid Azure Realtime clock');
    }
    const appendMaxBytes = validateFiniteOption(
      options.appendMaxBytes,
      AZURE_REALTIME_TRANSCRIPTION_APPEND_MAX_BYTES,
      'append size'
    );
    if (appendMaxBytes > AZURE_REALTIME_TRANSCRIPTION_APPEND_MAX_BYTES || appendMaxBytes % 2 !== 0) {
      throw new TypeError('Invalid Azure Realtime append size');
    }
    this.#tokenProvider = options.tokenProvider;
    this.#socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.#options = Object.freeze({
      readyTimeoutMs: validateFiniteOption(
        options.readyTimeoutMs,
        AZURE_REALTIME_TRANSCRIPTION_READY_TIMEOUT_MS,
        'ready timeout'
      ),
      finalizationTimeoutMs: validateFiniteOption(
        options.finalizationTimeoutMs,
        AZURE_REALTIME_TRANSCRIPTION_FINALIZATION_TIMEOUT_MS,
        'finalization timeout'
      ),
      queueBytes: validateFiniteOption(
        options.queueBytes,
        AZURE_REALTIME_TRANSCRIPTION_QUEUE_BYTES,
        'queue size'
      ),
      bufferedHighWaterMarkBytes: validateFiniteOption(
        options.bufferedHighWaterMarkBytes,
        AZURE_REALTIME_TRANSCRIPTION_BUFFERED_HIGH_WATER_MARK_BYTES,
        'buffered high water mark'
      ),
      appendMaxBytes,
      maxUtteranceSamples: Math.min(
        validateFiniteOption(options.maxUtteranceSamples, MAX_UTTERANCE_SAMPLES, 'utterance size'),
        MAX_UTTERANCE_SAMPLES
      ),
      clock: options.clock ?? systemClock
    });
  }

  checkReadiness(signal?: AbortSignal): Promise<TranscriptionReadiness> {
    const readiness = (ready: boolean): TranscriptionReadiness => Object.freeze({
      ready,
      provider: 'azure-realtime',
      model: this.deployment
    });
    const controller = new AbortController();
    const identity = {};
    let activeIdentity: object | undefined = identity;

    return new Promise((resolve) => {
      let settled = false;
      let socket: AzureRealtimeSocket | undefined;
      let updateSent = false;
      let externalAbortAttached = false;
      const timerState: { value?: ReturnType<typeof setTimeout> } = {};
      const registeredEvents = new Set<AzureRealtimeSocketEvent>();
      let listeners:
        | Readonly<{
          readonly open: () => void;
          readonly message: (data: unknown) => void;
          readonly error: () => void;
          readonly close: () => void;
        }>
        | undefined;

      const shutdownSocket = (target: AzureRealtimeSocket): void => {
        try { target.close(1000); } catch { /* best effort */ }
        try { target.terminate(); } catch { /* best effort */ }
      };

      const finish = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        activeIdentity = undefined;
        controller.abort();
        if (timerState.value !== undefined) clearTimeout(timerState.value);
        if (externalAbortAttached && signal !== undefined) {
          try { signal.removeEventListener('abort', onExternalAbort); } catch { /* best effort */ }
          externalAbortAttached = false;
        }
        const currentSocket = socket;
        const currentListeners = listeners;
        if (currentSocket !== undefined && currentListeners !== undefined) {
          if (registeredEvents.has('open')) {
            try { currentSocket.off('open', currentListeners.open); } catch { /* best effort */ }
          }
          if (registeredEvents.has('message')) {
            try { currentSocket.off('message', currentListeners.message); } catch { /* best effort */ }
          }
          if (registeredEvents.has('error')) {
            try { currentSocket.off('error', currentListeners.error); } catch { /* best effort */ }
          }
          if (registeredEvents.has('close')) {
            try { currentSocket.off('close', currentListeners.close); } catch { /* best effort */ }
          }
        }
        registeredEvents.clear();
        if (currentSocket !== undefined) shutdownSocket(currentSocket);
        socket = undefined;
        listeners = undefined;
        resolve(readiness(ready));
      };

      const onExternalAbort = (): void => finish(false);
      if (signal !== undefined) {
        try {
          if (signal.aborted) {
            finish(false);
            return;
          }
          signal.addEventListener('abort', onExternalAbort, { once: true });
          externalAbortAttached = true;
          if (signal.aborted) {
            finish(false);
            return;
          }
        } catch {
          finish(false);
          return;
        }
      }

      timerState.value = setTimeout(() => finish(false), this.#options.readyTimeoutMs);

      void (async (): Promise<void> => {
        let credentials: Readonly<{ token: string; expiresOnTimestamp: number }>;
        try {
          credentials = await this.#tokenProvider(controller.signal);
        } catch {
          finish(false);
          return;
        }
        let token: string;
        let expiresOnTimestamp: number;
        try {
          token = credentials.token;
          expiresOnTimestamp = credentials.expiresOnTimestamp;
        } catch {
          finish(false);
          return;
        }
        if (settled || controller.signal.aborted || typeof token !== 'string' || token.length === 0 ||
            !Number.isFinite(expiresOnTimestamp) || expiresOnTimestamp <= Date.now()) {
          finish(false);
          return;
        }
        let createdSocket: AzureRealtimeSocket;
        try {
          createdSocket = this.#socketFactory(this.endpoint, {
            Authorization: `Bearer ${token}`
          });
        } catch {
          finish(false);
          return;
        }
        if (settled || controller.signal.aborted) {
          shutdownSocket(createdSocket);
          return;
        }
        socket = createdSocket;
        const probeSocket = createdSocket;

        const isCurrent = (): boolean =>
          !settled && socket === probeSocket && activeIdentity === identity;
        const onOpen = (): void => {
          if (!isCurrent() || updateSent) return;
          updateSent = true;
          const payload = jsonMessage(
            buildAzureRealtimeSessionUpdateMessage(this.deployment),
            'palancar-readiness-1'
          );
          try {
            probeSocket.send(payload, (error?: Error) => {
              if (!isCurrent() || socket !== probeSocket) return;
              if (error !== undefined) finish(false);
            });
          } catch {
            finish(false);
          }
        };
        const onMessage = (data: unknown): void => {
          if (!isCurrent()) return;
          let event: AzureRealtimeServerEvent;
          try {
            event = parseAzureRealtimeServerEvent(messageDataToInput(data), {
              expectedDeployment: this.deployment
            });
          } catch {
            finish(false);
            return;
          }
          if (event.type === 'session.created') return;
          if (event.type === 'session.updated' && event.session.configured) {
            finish(true);
            return;
          }
          finish(false);
        };
        const onError = (): void => finish(false);
        const onClose = (): void => finish(false);
        listeners = Object.freeze({
          open: onOpen,
          message: onMessage,
          error: onError,
          close: onClose
        });
        const register = (
          event: AzureRealtimeSocketEvent,
          add: () => void,
          remove: () => void
        ): boolean => {
          try {
            add();
          } catch {
            try { remove(); } catch { /* best effort */ }
            finish(false);
            return false;
          }
          if (settled) {
            try { remove(); } catch { /* best effort */ }
            return false;
          }
          registeredEvents.add(event);
          return true;
        };
        if (!register('open',
          () => probeSocket.on('open', onOpen),
          () => probeSocket.off('open', onOpen))) return;
        if (!register('message',
          () => probeSocket.on('message', onMessage),
          () => probeSocket.off('message', onMessage))) return;
        if (!register('error',
          () => probeSocket.on('error', onError),
          () => probeSocket.off('error', onError))) return;
        if (!register('close',
          () => probeSocket.on('close', onClose),
          () => probeSocket.off('close', onClose))) return;
        try {
          if (probeSocket.readyState === SOCKET_OPEN) onOpen();
        } catch {
          finish(false);
        }
      })();
    });
  }

  createSession(input: CreateTranscriptionSessionInput): AzureRealtimeTranscriptionSession {
    return new AzureRealtimeTranscriptionSession(input, this);
  }

  get options(): Readonly<AzureAdapterRuntimeOptions> {
    return this.#options;
  }

  createSocket(url: string, headers: Readonly<Record<string, string>>): AzureRealtimeSocket {
    return this.#socketFactory(url, headers);
  }

  get tokenProvider(): AzureTokenProvider {
    return this.#tokenProvider;
  }

  nowEpochMs(): number {
    const value = this.#options.clock();
    const epochMs = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(epochMs)) {
      throw new TypeError('Invalid Azure Realtime clock value');
    }
    return epochMs;
  }
}

export class AzureRealtimeTranscriptionSession implements TranscriptionSession {
  readonly capabilities = AZURE_CAPABILITIES;
  readonly configuration: Readonly<TranscriptionSessionConfiguration>;
  readonly #input: Readonly<CreateTranscriptionSessionInput>;
  readonly #adapter: AzureRealtimeTranscriptionAdapter;
  readonly #sessionId: string;
  readonly #sessionEpoch: number;
  readonly #resampler = new LinearPcm16To24AudioResampler();
  readonly #terminalByUtterance = new Map<string, TerminalStatus>();
  readonly #encoder = TEXT_ENCODER;
  #activeUtteranceId: string | undefined;
  #acceptedOriginalOffset = 0;
  #nextBoundaryOriginalOffset = AZURE_REALTIME_TRANSCRIPTION_COMMIT_ORIGINAL_SAMPLES;
  #providerSamples = 0;
  #lastCommittedProviderSamples = 0;
  #scheduledCommitOffsets: number[] = [];
  #ackEligibleCommitOffsets: number[] = [];
  #unacknowledgedCommitCount = 0;
  #lastEnqueuedCommitOffset = 0;
  #items: CommittedItem[] = [];
  #itemsById = new Map<string, CommittedItem>();
  #lastItemId: string | null = null;
  #queued: QueueEntry[] = [];
  #queuedBytes = 0;
  #socket: AzureRealtimeSocket | undefined;
  #socketIdentity: object | undefined;
  #socketOpen = false;
  #sessionUpdateSent = false;
  #sessionCreatedReceived = false;
  #providerSessionId: string | undefined;
  #configured = false;
  #sending = false;
  #eventCounter = 0;
  #operationEpoch = 0;
  #audioStateEpoch = 0;
  #abortController: AbortController | undefined;
  #readyTimer: ReturnType<typeof setTimeout> | undefined;
  #finalizationTimer: ReturnType<typeof setTimeout> | undefined;
  #connectionState: TranscriptionConnectionState = 'idle';
  #finalizationRequested = false;
  #closed = false;
  #deliveryFailureCount = 0;
  #lastDeliveryFailure:
    | { readonly eventType: NormalizedTranscriptionEvent['type']; readonly revision: number }
    | undefined;
  #revision = 0;
  #segmentId: string | undefined;
  #finalEvent: NormalizedTranscriptionFinal | undefined;
  #failureReported = false;
  #segmentIds = new Set<string>();
  #socketListeners:
    | Readonly<{
      readonly socket: AzureRealtimeSocket;
      readonly open: () => void;
      readonly message: (data: unknown) => void;
      readonly error: () => void;
      readonly close: () => void;
    }>
    | undefined;

  constructor(input: CreateTranscriptionSessionInput, adapter: AzureRealtimeTranscriptionAdapter) {
    assertUuidLike(input.sessionId, 'Session ID');
    assertSessionEpoch(input.sessionEpoch);
    if (typeof input.onEvent !== 'function') {
      throw new TypeError('Transcription event callback must be a function');
    }
    if (typeof input.onFailure !== 'function') {
      throw new TypeError('Transcription failure callback must be a function');
    }
    if (input.configuration.languageMode !== 'automatic' ||
        input.configuration.serverVadMode !== 'disabled' ||
        input.configuration.manualCommitCadenceMs !== AZURE_REALTIME_TRANSCRIPTION_COMMIT_CADENCE_MS) {
      throw new RangeError('Azure Realtime requires automatic language and 600 ms manual commits');
    }
    this.#input = Object.freeze({ ...input });
    this.#adapter = adapter;
    this.#sessionId = input.sessionId;
    this.#sessionEpoch = input.sessionEpoch;
    this.configuration = Object.freeze({ ...input.configuration });
  }

  get state(): Readonly<TranscriptionSessionState> {
    return Object.freeze({
      closed: this.#closed,
      connectionState: this.#connectionState,
      finalizationRequested: this.#finalizationRequested,
      ...(this.#activeUtteranceId === undefined ? {} : { activeUtteranceId: this.#activeUtteranceId }),
      acceptedThroughOriginalSampleOffset: this.#acceptedOriginalOffset,
      audioStateEpoch: this.#audioStateEpoch
    });
  }

  get deliveryFailures(): Readonly<EventDeliveryFailureStatus> {
    return Object.freeze({
      failureCount: this.#deliveryFailureCount,
      ...(this.#lastDeliveryFailure === undefined ? {} : {
        lastFailure: Object.freeze({ ...this.#lastDeliveryFailure })
      })
    });
  }

  start(input: StartUtteranceInput): StartUtteranceResult {
    this.#assertOpen();
    assertUuidLike(input.utteranceId, 'Utterance ID');
    if (this.#activeUtteranceId !== undefined) {
      if (this.#activeUtteranceId === input.utteranceId) {
        return Object.freeze({ status: 'already-active' });
      }
      throw new TranscriptionSessionError('active-utterance', 'A different utterance is already active');
    }
    if (this.#terminalByUtterance.has(input.utteranceId)) {
      adapterError('stale-utterance');
    }
    this.#resetUtteranceState();
    this.#activeUtteranceId = input.utteranceId;
    this.#segmentId = `${input.utteranceId}:0`;
    this.#connectionState = 'acquiring-token';
    this.#openSocket();
    return Object.freeze({ status: 'started' });
  }

  pushAudio(input: PushAudioInput): PushAudioResult {
    this.#assertOpen();
    this.#requireActive(input.utteranceId);
    if (this.#finalizationRequested) {
      adapterError('finalization-requested');
    }
    if (!(input.pcm instanceof Uint8Array) || input.pcm.byteLength === 0 || input.pcm.byteLength % 2 !== 0) {
      throw new TranscriptionSessionError('invalid-audio', 'PCM must be a non-empty even-length Uint8Array');
    }
    if (!Number.isSafeInteger(input.originalSampleOffset) || input.originalSampleOffset < 0) {
      throw new TranscriptionSessionError('invalid-audio', 'Original sample offset must be a non-negative integer');
    }
    if (input.originalSampleOffset !== this.#acceptedOriginalOffset) {
      throw new TranscriptionSessionError(
        input.originalSampleOffset < this.#acceptedOriginalOffset ? 'overlap' : 'gap',
        'PCM must be contiguous in original sample offsets'
      );
    }
    const acceptedSamples = input.pcm.byteLength / 2;
    const nextOffset = input.originalSampleOffset + acceptedSamples;
    if (nextOffset > this.#adapter.options.maxUtteranceSamples) {
      throw new TranscriptionSessionError('utterance-overflow', 'PCM exceeds the utterance limit');
    }
    const owned = new Uint8Array(input.pcm);
    this.#acceptedOriginalOffset = nextOffset;
    while (this.#acceptedOriginalOffset >= this.#nextBoundaryOriginalOffset) {
      this.#scheduledCommitOffsets.push(this.#nextBoundaryOriginalOffset);
      this.#nextBoundaryOriginalOffset += AZURE_REALTIME_TRANSCRIPTION_COMMIT_ORIGINAL_SAMPLES;
    }
    let providerAudio: Uint8Array;
    try {
      providerAudio = this.#resampler.push(owned);
    } catch {
      this.#fail('protocol');
      throw new TranscriptionSessionError('invalid-audio', 'Audio resampling failed');
    }
    this.#enqueueProviderAudio(providerAudio);
    return Object.freeze({
      status: 'accepted',
      acceptedSamples,
      acceptedThroughOriginalSampleOffset: this.#acceptedOriginalOffset
    });
  }

  finalize(utteranceId: string): FinalizeResult {
    this.#assertOpen();
    assertUuidLike(utteranceId, 'Utterance ID');
    const terminal = this.#terminalByUtterance.get(utteranceId);
    if (terminal === 'finalized') {
      return Object.freeze({ status: 'already-finalized' });
    }
    if (terminal === 'cancelled') {
      return Object.freeze({ status: 'already-cancelled' });
    }
    this.#requireActive(utteranceId);
    if (this.#finalizationRequested) {
      return Object.freeze({ status: 'already-requested' });
    }
    this.#finalizationRequested = true;
    this.#connectionState = 'finalizing';
    let tail: Uint8Array;
    try {
      tail = this.#resampler.flush();
    } catch {
      this.#fail('protocol');
      throw new TranscriptionSessionError('invalid-audio', 'Audio resampling failed');
    }
    this.#enqueueProviderAudio(tail);
    if (this.#providerSamples > this.#lastCommittedProviderSamples) {
      this.#enqueueCommit(this.#acceptedOriginalOffset);
      this.#lastCommittedProviderSamples = this.#providerSamples;
    }
    const timerEpoch = this.#operationEpoch;
    const timerSocketIdentity = this.#socketIdentity;
    this.#finalizationTimer = setTimeout(() => {
      if (
        timerSocketIdentity !== undefined &&
        this.#isCurrent(timerEpoch, timerSocketIdentity) &&
        this.#finalizationRequested &&
        this.#finalEvent === undefined
      ) {
        this.#fail('finalization-timeout');
      }
    }, this.#adapter.options.finalizationTimeoutMs);
    this.#maybeFinish();
    return Object.freeze({ status: 'finalization-requested' });
  }

  cancel(utteranceId: string): CancelResult {
    this.#assertOpen();
    assertUuidLike(utteranceId, 'Utterance ID');
    const active = this.#activeUtteranceId;
    const terminal = this.#terminalByUtterance.get(utteranceId);
    if (terminal === 'cancelled') {
      return Object.freeze({ status: 'already-cancelled' });
    }
    if (terminal === 'finalized') {
      return Object.freeze({ status: 'already-finalized' });
    }
    if (active === undefined || active !== utteranceId) {
      throw new TranscriptionSessionError(
        active === undefined ? 'no-active-utterance' : 'wrong-utterance',
        'No matching active utterance'
      );
    }
    this.#terminalByUtterance.set(utteranceId, 'cancelled');
    this.#invalidateAndCleanup(true);
    this.#activeUtteranceId = undefined;
    this.#connectionState = 'closed';
    return Object.freeze({ status: 'cancelled' });
  }

  close(): CloseResult {
    if (this.#closed) {
      return Object.freeze({ status: 'already-closed' });
    }
    if (this.#activeUtteranceId !== undefined) {
      this.#terminalByUtterance.set(this.#activeUtteranceId, 'cancelled');
    }
    this.#invalidateAndCleanup(true);
    this.#activeUtteranceId = undefined;
    this.#finalEvent = undefined;
    this.#terminalByUtterance.clear();
    this.#closed = true;
    this.#connectionState = 'closed';
    return Object.freeze({ status: 'closed' });
  }

  #assertOpen(): void {
    if (this.#closed) {
      adapterError('closed');
    }
  }

  #requireActive(utteranceId: string): string {
    assertUuidLike(utteranceId, 'Utterance ID');
    if (this.#activeUtteranceId === undefined) {
      if (this.#terminalByUtterance.has(utteranceId)) {
        adapterError('stale-utterance');
      }
      throw new TranscriptionSessionError('no-active-utterance', 'No active utterance');
    }
    if (this.#activeUtteranceId !== utteranceId) {
      throw new TranscriptionSessionError('wrong-utterance', 'Wrong utterance');
    }
    return utteranceId;
  }

  #resetUtteranceState(): void {
    this.#invalidateAndCleanup(false);
    this.#activeUtteranceId = undefined;
    this.#acceptedOriginalOffset = 0;
    this.#nextBoundaryOriginalOffset = AZURE_REALTIME_TRANSCRIPTION_COMMIT_ORIGINAL_SAMPLES;
    this.#providerSamples = 0;
    this.#lastCommittedProviderSamples = 0;
    this.#scheduledCommitOffsets = [];
    this.#ackEligibleCommitOffsets = [];
    this.#unacknowledgedCommitCount = 0;
    this.#lastEnqueuedCommitOffset = 0;
    this.#items = [];
    this.#itemsById.clear();
    this.#lastItemId = null;
    this.#queued = [];
    this.#queuedBytes = 0;
    this.#sessionUpdateSent = false;
    this.#sessionCreatedReceived = false;
    this.#providerSessionId = undefined;
    this.#configured = false;
    this.#sending = false;
    this.#finalizationRequested = false;
    this.#finalEvent = undefined;
    this.#revision = 0;
    this.#failureReported = false;
    this.#segmentIds.clear();
    this.#resampler.reset();
  }

  #openSocket(): void {
    const epoch = this.#operationEpoch;
    const abortController = new AbortController();
    this.#abortController = abortController;
    const socketIdentity = {};
    this.#socketIdentity = socketIdentity;
    this.#readyTimer = setTimeout(() => {
      if (this.#isCurrent(epoch, socketIdentity) && this.#configured === false) {
        this.#fail('connect-timeout');
      }
    }, this.#adapter.options.readyTimeoutMs);
    void this.#connect(epoch, socketIdentity, abortController.signal);
  }

  async #connect(epoch: number, socketIdentity: object, signal: AbortSignal): Promise<void> {
    let credentials: Readonly<{ token: string; expiresOnTimestamp: number }>;
    try {
      credentials = await this.#adapter.tokenProvider(signal);
    } catch {
      if (this.#isCurrent(epoch, socketIdentity)) {
        this.#fail('authentication');
      }
      return;
    }
    if (!this.#isCurrent(epoch, socketIdentity) || signal.aborted ||
        typeof credentials.token !== 'string' || credentials.token.length === 0 ||
        !Number.isFinite(credentials.expiresOnTimestamp) ||
        credentials.expiresOnTimestamp <= Date.now()) {
      if (this.#isCurrent(epoch, socketIdentity) && !signal.aborted) {
        this.#fail('authentication');
      }
      return;
    }
    const url = this.#adapter.endpoint;
    let socket: AzureRealtimeSocket;
    try {
      socket = this.#adapter.createSocket(url, {
        Authorization: `Bearer ${credentials.token}`
      });
    } catch {
      if (this.#isCurrent(epoch, socketIdentity)) {
        this.#fail('socket');
      }
      return;
    }
    if (!this.#isCurrent(epoch, socketIdentity)) {
      try { socket.terminate(); } catch { /* stale socket */ }
      return;
    }
    this.#socket = socket;
    this.#connectionState = 'connecting';
    const onOpen = (): void => {
      if (!this.#isCurrent(epoch, socketIdentity)) return;
      if (this.#sessionUpdateSent) return;
      this.#socketOpen = true;
      this.#connectionState = 'configuring';
      const update = buildAzureRealtimeSessionUpdateMessage(this.#adapter.deployment);
      try {
        this.#enqueueMessage(update, 'session.update', true);
        this.#pump();
      } catch {
        if (this.#isCurrent(epoch, socketIdentity)) this.#fail('backpressure');
      }
    };
    const onMessage = (data: unknown): void => {
      if (!this.#isCurrent(epoch, socketIdentity)) return;
      this.#handleServerMessage(data);
    };
    const onError = (): void => {
      if (this.#isCurrent(epoch, socketIdentity)) this.#fail('socket');
    };
    const onClose = (): void => {
      if (this.#isCurrent(epoch, socketIdentity) && this.#finalEvent === undefined) {
        this.#fail('socket');
      }
    };
    socket.on('open', onOpen);
    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.on('close', onClose);
    this.#socketListeners = Object.freeze({
      socket,
      open: onOpen,
      message: onMessage,
      error: onError,
      close: onClose
    });
    if (socket.readyState === SOCKET_OPEN) onOpen();
  }

  #isCurrent(epoch: number, socketIdentity: object): boolean {
    return !this.#closed && epoch === this.#operationEpoch && this.#socketIdentity === socketIdentity;
  }

  #enqueueProviderAudio(pcm: Uint8Array): void {
    if (pcm.byteLength === 0) return;
    for (let offset = 0; offset < pcm.byteLength;) {
      const remaining = pcm.byteLength - offset;
      const providerSamplesUntilBoundary = this.#scheduledCommitOffsets.length > 0
        ? AZURE_REALTIME_TRANSCRIPTION_COMMIT_PROVIDER_SAMPLES -
          (this.#providerSamples - this.#lastCommittedProviderSamples)
        : remaining / 2;
      const chunkBytes = Math.min(
        this.#adapter.options.appendMaxBytes,
        remaining,
        Math.max(2, providerSamplesUntilBoundary * 2)
      );
      const evenChunkBytes = chunkBytes - (chunkBytes % 2);
      if (evenChunkBytes < 2) {
        this.#fail('protocol');
        return;
      }
      const chunk = pcm.slice(offset, offset + evenChunkBytes);
      this.#enqueueAppend(chunk);
      offset += evenChunkBytes;
      this.#providerSamples += evenChunkBytes / 2;
      if (this.#scheduledCommitOffsets.length > 0 &&
          this.#providerSamples - this.#lastCommittedProviderSamples ===
            AZURE_REALTIME_TRANSCRIPTION_COMMIT_PROVIDER_SAMPLES) {
        const originalOffset = this.#scheduledCommitOffsets.shift();
        if (originalOffset === undefined) {
          this.#fail('protocol');
          return;
        }
        this.#enqueueCommit(originalOffset);
        this.#lastCommittedProviderSamples = this.#providerSamples;
      }
    }
  }

  #enqueueAppend(pcm: Uint8Array): void {
    const message = {
      type: 'input_audio_buffer.append' as const,
      audio: this.#base64(pcm)
    };
    this.#enqueueMessage(message, 'append');
  }

  #enqueueCommit(originalOffset: number): void {
    if (!Number.isSafeInteger(originalOffset) || originalOffset < 1 ||
        originalOffset <= this.#lastEnqueuedCommitOffset) {
      this.#fail('protocol');
      return;
    }
    this.#enqueueMessage(
      buildAzureRealtimeInputAudioCommitMessage(),
      'commit',
      false,
      originalOffset
    );
  }

  #enqueueMessage(
    message: AzureRealtimeClientMessage,
    kind: QueueEntry['kind'],
    prepend = false,
    commitOriginalOffset?: number
  ): void {
    const eventId = this.#nextEventId();
    const payload = jsonMessage(message, eventId);
    const bytes = this.#encoder.encode(payload).byteLength;
    if (this.#queuedBytes + bytes > this.#adapter.options.queueBytes) {
      this.#fail('backpressure');
      throw new AzureRealtimeAdapterError('backpressure');
    }
    const entry: QueueEntry = Object.freeze({
      payload,
      bytes,
      kind,
      ...(commitOriginalOffset === undefined ? {} : { commitOriginalOffset })
    });
    if (prepend) {
      this.#queued.unshift(entry);
    } else {
      this.#queued.push(entry);
    }
    this.#queuedBytes += bytes;
    if (kind === 'commit') {
      if (commitOriginalOffset === undefined) {
        this.#fail('protocol');
        return;
      }
      this.#lastEnqueuedCommitOffset = commitOriginalOffset;
      this.#unacknowledgedCommitCount += 1;
    }
    this.#pump();
  }

  #nextEventId(): string {
    this.#eventCounter = (this.#eventCounter + 1) >>> 0;
    const value = `palancar-${this.#eventCounter}`;
    if (!EVENT_ID_PATTERN.test(value)) {
      this.#eventCounter = 1;
      return 'palancar-1';
    }
    return value;
  }

  #pump(): void {
    const socket = this.#socket;
    const socketIdentity = this.#socketIdentity;
    const epoch = this.#operationEpoch;
    if (!this.#socketOpen || socket === undefined || socketIdentity === undefined ||
        socket.readyState !== SOCKET_OPEN || this.#sending) {
      return;
    }
    const next = this.#queued[0];
    if (next === undefined) return;
    if (!this.#sessionUpdateSent && next.kind !== 'session.update') {
      this.#fail('configuration');
      return;
    }
    if (this.#sessionUpdateSent && !this.#configured) return;
    if (socket.bufferedAmount > this.#adapter.options.bufferedHighWaterMarkBytes) {
      this.#fail('backpressure');
      return;
    }
    this.#queued.shift();
    this.#queuedBytes -= next.bytes;
    this.#sending = true;
    if (next.kind === 'session.update') this.#sessionUpdateSent = true;
    try {
      socket.send(next.payload, (error?: Error) => {
        if (!this.#isCurrent(epoch, socketIdentity) || this.#socket !== socket) return;
        this.#sending = false;
        if (error !== undefined) {
          this.#fail('socket');
          return;
        }
        if (next.kind === 'commit') {
          const originalOffset = next.commitOriginalOffset;
          const previousOffset = this.#ackEligibleCommitOffsets.at(-1) ??
            this.#items.at(-1)?.originalOffset ?? 0;
          if (originalOffset === undefined || originalOffset <= previousOffset) {
            this.#fail('protocol');
            return;
          }
          this.#ackEligibleCommitOffsets.push(originalOffset);
        }
        this.#pump();
      });
    } catch {
      this.#sending = false;
      this.#fail('socket');
    }
  }

  #handleServerMessage(data: unknown): void {
    let event: AzureRealtimeServerEvent;
    try {
      event = parseAzureRealtimeServerEvent(messageDataToInput(data), {
        expectedDeployment: this.#adapter.deployment
      });
    } catch (error) {
      if (error instanceof AzureRealtimeServerEventError) {
        this.#fail('protocol');
        return;
      }
      this.#fail('protocol');
      return;
    }
    if (!this.#isServerEventAllowed(event.type)) {
      this.#fail(event.type === 'session.updated' ? 'configuration' : 'protocol');
      return;
    }
    switch (event.type) {
      case 'session.created':
        if (this.#sessionCreatedReceived || this.#configured || !this.#sessionUpdateSent ||
            event.session.configured || event.session.phase !== 'basic') {
          this.#fail('protocol');
          return;
        }
        this.#sessionCreatedReceived = true;
        this.#providerSessionId = event.session.id;
        return;
      case 'session.updated':
        if (!event.session.configured || this.#configured || !this.#socketOpen ||
            !this.#sessionUpdateSent || !this.#sessionCreatedReceived ||
            event.session.phase !== 'configured' || event.session.id !== this.#providerSessionId) {
          this.#fail('configuration');
          return;
        }
        this.#configured = true;
        this.#connectionState = this.#finalizationRequested ? 'finalizing' : 'ready';
        this.#clearTimer('ready');
        this.#pump();
        return;
      case 'rate_limits.updated':
        return;
      case 'input_audio_buffer.committed':
        this.#handleCommitted(event.item_id, event.previous_item_id);
        return;
      case 'input_audio_buffer.cleared':
      case 'input_audio_buffer.speech_started':
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.timeout_triggered':
        this.#fail('protocol');
        return;
      case 'conversation.item.created':
        this.#handleItemCreated(event.item_id, event.previous_item_id);
        return;
      case 'conversation.item.input_audio_transcription.delta':
        this.#handleDelta(event.item_id, event.delta);
        return;
      case 'conversation.item.input_audio_transcription.completed':
        this.#handleCompleted(event.item_id, event.transcript);
        return;
      case 'conversation.item.input_audio_transcription.segment':
        this.#handleSegment(event.id, event.item_id);
        return;
      case 'conversation.item.input_audio_transcription.failed':
        if (!this.#hasIncompleteItem(event.item_id)) {
          this.#fail('protocol');
          return;
        }
        this.#fail('provider');
        return;
      case 'error':
        this.#fail('protocol');
        return;
    }
  }

  #isServerEventAllowed(type: AzureRealtimeServerEvent['type']): boolean {
    return this.#socketOpen &&
      AZURE_SERVER_EVENT_ALLOWED_STATES[type].includes(this.#connectionState as never) &&
      (type === 'session.created' || type === 'session.updated' || type === 'error' || this.#configured);
  }

  #handleCommitted(itemId: string, previousItemId: string | null): void {
    const originalOffset = this.#ackEligibleCommitOffsets.shift();
    if (originalOffset === undefined || this.#itemsById.has(itemId) || previousItemId !== this.#lastItemId) {
      this.#fail('protocol');
      return;
    }
    this.#unacknowledgedCommitCount -= 1;
    if (this.#unacknowledgedCommitCount < 0) {
      this.#fail('protocol');
      return;
    }
    const item: CommittedItem = {
      itemId,
      originalOffset,
      order: this.#items.length,
      created: false,
      text: '',
      completed: false
    };
    this.#items.push(item);
    this.#itemsById.set(itemId, item);
    this.#lastItemId = itemId;
  }

  #handleItemCreated(itemId: string, previousItemId: string | null): void {
    const item = this.#itemsById.get(itemId);
    const expectedPreviousItemId = item === undefined || item.order === 0
      ? null
      : this.#items[item.order - 1]?.itemId ?? null;
    if (item === undefined || item.created || item.completed ||
        previousItemId !== expectedPreviousItemId) {
      this.#fail('protocol');
      return;
    }
    item.created = true;
  }

  #hasIncompleteItem(itemId: string): boolean {
    const item = this.#itemsById.get(itemId);
    return item !== undefined && !item.completed;
  }

  #handleSegment(segmentId: string, itemId: string): void {
    if (!this.#hasIncompleteItem(itemId) || this.#segmentIds.has(segmentId)) {
      this.#fail('protocol');
      return;
    }
    this.#segmentIds.add(segmentId);
  }

  #handleDelta(itemId: string, delta: string): void {
    const item = this.#itemsById.get(itemId);
    if (item === undefined || item.completed) {
      this.#fail('protocol');
      return;
    }
    item.text = normalizeText(`${item.text} ${delta}`);
    this.#emitPartial();
  }

  #handleCompleted(itemId: string, transcript: string): void {
    const item = this.#itemsById.get(itemId);
    if (item === undefined || item.completed) {
      this.#fail('protocol');
      return;
    }
    item.text = normalizeText(transcript);
    item.completed = true;
    this.#emitPartial();
    this.#maybeFinish();
  }

  #currentText(): string {
    const segments: string[] = [];
    for (const item of this.#items) {
      if (!item.completed) break;
      if (item.text.length === 0) continue;
      segments.push(item.text);
    }
    return joinSegments(segments);
  }

  #acceptedOffsetForPrefix(): number {
    let offset = 0;
    for (const item of this.#items) {
      if (!item.completed) break;
      offset = item.originalOffset;
    }
    return offset;
  }

  #emitPartial(): void {
    if (this.#activeUtteranceId === undefined) return;
    const text = this.#currentText();
    if (text.length === 0) return;
    this.#revision += 1;
    const providerEventTime = this.#providerEventTime();
    if (providerEventTime === undefined) return;
    const event: NormalizedTranscriptionPartial = {
      type: 'transcript.partial',
      sessionId: this.#sessionId,
      sessionEpoch: this.#sessionEpoch,
      utteranceId: this.#activeUtteranceId,
      segmentId: this.#segmentId ?? `${this.#activeUtteranceId}:0`,
      revision: this.#revision,
      text,
      providerEventTime,
      languageEvidence: advisoryLanguageEvidence(),
      acceptedThroughOriginalSampleOffset: this.#acceptedOffsetForPrefix()
    };
    assertTranscriptPartial({
      type: event.type,
      sessionId: event.sessionId,
      sessionEpoch: event.sessionEpoch,
      utteranceId: event.utteranceId,
      segmentId: event.segmentId,
      revision: event.revision,
      text: event.text,
      providerEventTime: event.providerEventTime
    });
    this.#deliver(Object.freeze(event));
  }

  #maybeFinish(): void {
    if (!this.#finalizationRequested || this.#finalEvent !== undefined || this.#activeUtteranceId === undefined) return;
    if (this.#scheduledCommitOffsets.length > 0 || this.#unacknowledgedCommitCount > 0 ||
        this.#items.some((item) => !item.completed) ||
        this.#providerSamples !== this.#lastCommittedProviderSamples) return;
    this.#finish(this.#activeUtteranceId);
  }

  #finish(utteranceId: string): void {
    const text = this.#currentText();
    if (text.length === 0) {
      this.#fail('provider');
      return;
    }
    this.#revision += 1;
    const providerEventTime = this.#providerEventTime();
    if (providerEventTime === undefined) return;
    const event: NormalizedTranscriptionFinal = {
      type: 'transcript.final',
      sessionId: this.#sessionId,
      sessionEpoch: this.#sessionEpoch,
      utteranceId,
      segmentId: this.#segmentId ?? `${utteranceId}:0`,
      revision: this.#revision,
      text,
      providerEventTime,
      languageEvidence: advisoryLanguageEvidence(),
      acceptedThroughOriginalSampleOffset: this.#acceptedOriginalOffset,
      finalizationReason: 'explicit'
    };
    assertTranscriptFinal({
      type: event.type,
      sessionId: event.sessionId,
      sessionEpoch: event.sessionEpoch,
      utteranceId: event.utteranceId,
      segmentId: event.segmentId,
      revision: event.revision,
      text: event.text,
      providerEventTime: event.providerEventTime
    });
    this.#finalEvent = Object.freeze(event);
    this.#terminalByUtterance.set(utteranceId, 'finalized');
    this.#clearTimer('finalization');
    this.#invalidateAndCleanup(false);
    this.#activeUtteranceId = undefined;
    this.#connectionState = 'idle';
    this.#deliver(this.#finalEvent);
  }

  #fail(reason: TranscriptionFailureReason): void {
    if (this.#closed || this.#failureReported || this.#finalEvent !== undefined) return;
    this.#failureReported = true;
    const utteranceId = this.#activeUtteranceId;
    if (utteranceId !== undefined) this.#terminalByUtterance.set(utteranceId, 'failed');
    this.#connectionState = 'failed';
    const failure: TranscriptionFailure = Object.freeze({
      reason,
      audioStateEpoch: this.#audioStateEpoch
    });
    this.#invalidateAndCleanup(true);
    this.#activeUtteranceId = undefined;
    try { this.#input.onFailure(failure); } catch { /* failure hooks are isolated */ }
  }

  #providerEventTime(): string | undefined {
    try {
      return new Date(this.#adapter.nowEpochMs()).toISOString();
    } catch {
      this.#fail('protocol');
      return undefined;
    }
  }

  #invalidateAndCleanup(sendClear: boolean): void {
    const socket = this.#socket;
    const hasUncommittedAudio = this.#providerSamples > this.#lastCommittedProviderSamples ||
      this.#queued.some((entry) => entry.kind === 'append');
    this.#audioStateEpoch += 1;
    this.#operationEpoch += 1;
    this.#abortController?.abort();
    this.#abortController = undefined;
    this.#clearTimer('ready');
    this.#clearTimer('finalization');
    if (sendClear && hasUncommittedAudio && socket !== undefined && this.#socketOpen &&
        socket.readyState === SOCKET_OPEN) {
      try {
        const clear = jsonMessage(buildAzureRealtimeInputAudioClearMessage(), this.#nextEventId());
        const clearEpoch = this.#operationEpoch;
        const clearSocketIdentity = this.#socketIdentity;
        socket.send(clear, () => {
          if (clearSocketIdentity === undefined) return;
          if (!this.#isCurrent(clearEpoch, clearSocketIdentity) || this.#socket !== socket) return;
        });
      } catch { /* cleanup must continue */ }
    }
    this.#queued = [];
    this.#queuedBytes = 0;
    this.#sending = false;
    this.#detachSocket(socket);
    this.#socket = undefined;
    this.#socketIdentity = undefined;
    this.#socketOpen = false;
    this.#sessionUpdateSent = false;
    this.#sessionCreatedReceived = false;
    this.#providerSessionId = undefined;
    this.#configured = false;
    this.#resampler.reset();
    this.#acceptedOriginalOffset = 0;
    this.#nextBoundaryOriginalOffset = AZURE_REALTIME_TRANSCRIPTION_COMMIT_ORIGINAL_SAMPLES;
    this.#providerSamples = 0;
    this.#lastCommittedProviderSamples = 0;
    this.#scheduledCommitOffsets = [];
    this.#ackEligibleCommitOffsets = [];
    this.#unacknowledgedCommitCount = 0;
    this.#lastEnqueuedCommitOffset = 0;
    this.#items = [];
    this.#itemsById.clear();
    this.#segmentIds.clear();
    this.#lastItemId = null;
    this.#segmentId = undefined;
    this.#revision = 0;
    this.#finalizationRequested = false;
  }

  #detachSocket(socket: AzureRealtimeSocket | undefined): void {
    if (socket === undefined) return;
    const listeners = this.#socketListeners;
    if (listeners?.socket === socket) {
      try { socket.off('open', listeners.open); } catch { /* best effort */ }
      try { socket.off('message', listeners.message); } catch { /* best effort */ }
      try { socket.off('error', listeners.error); } catch { /* best effort */ }
      try { socket.off('close', listeners.close); } catch { /* best effort */ }
      this.#socketListeners = undefined;
    }
    try { socket.close(1000); } catch { /* best effort */ }
    try { socket.terminate(); } catch { /* best effort */ }
  }

  #clearTimer(kind: 'ready' | 'finalization'): void {
    if (kind === 'ready' && this.#readyTimer !== undefined) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = undefined;
    }
    if (kind === 'finalization' && this.#finalizationTimer !== undefined) {
      clearTimeout(this.#finalizationTimer);
      this.#finalizationTimer = undefined;
    }
  }

  #base64(pcm: Uint8Array): string {
    let binary = '';
    for (const byte of pcm) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  #deliver(event: NormalizedTranscriptionEvent): void {
    try {
      const result = this.#input.onEvent(event);
      if (result !== undefined && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => this.#recordDeliveryFailure(event));
      }
    } catch {
      this.#recordDeliveryFailure(event);
    }
  }

  #recordDeliveryFailure(event: NormalizedTranscriptionEvent): void {
    this.#deliveryFailureCount += 1;
    this.#lastDeliveryFailure = Object.freeze({ eventType: event.type, revision: event.revision });
    try { this.#input.onDeliveryFailure?.(this.deliveryFailures); } catch { /* isolated */ }
  }
}
