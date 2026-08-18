import {
  DEFAULT_NEGOTIATED_LIMITS,
  PROTOCOL_VERSION,
  assertClientControlMessage,
  assertServerControlMessage,
  assertSessionStart,
  assertSessionTicketRequest,
  assertSessionTicketResponse,
  assertUtteranceCancel,
  assertUtteranceCommit,
  assertUtteranceStart,
  createWebSocketSubprotocols,
  type ClientControlMessage,
  type NegotiatedLimits,
  type ServerControlMessage,
  type SessionTicketResponse,
} from "@palancar/contracts";
import {
  ClientRetainedAudioQueue,
  type ClientAudioQueueState,
  type EncodedAudioFrame,
} from "@palancar/audio";
import {
  LANGUAGE_REGISTRY_VERSION,
  isTargetLanguage,
  type TargetLanguage,
} from "@palancar/language-registry";

import type { FatalEvent } from "../state/index.js";

const SESSION_TICKET_PATH = "/v1/session-tickets" as const;
const DEFAULT_GATE_POLICY_VERSION = "1.0.0" as const;
const DEFAULT_CLIENT_BUILD = "g2-client-dev" as const;
const DEFAULT_READY_TIMEOUT_MS = 10_000 as const;
const MAX_READY_TIMEOUT_MS = 2_147_483_647 as const;
const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;

const RELAY_CLOSE_RECOVERY_DISPOSITIONS = new Map<
  number,
  RelayTransportRecoveryDisposition
>([
  [0, "retry"],
  [1000, "stop"],
  [1001, "retry"],
  [1002, "stop"],
  [1003, "stop"],
  [1005, "retry"],
  [1006, "retry"],
  [1008, "stop"],
  [1009, "stop"],
  [1011, "retry"],
  [1012, "retry"],
  [1013, "retry"],
  [1014, "retry"],
  [1015, "retry"],
  [4401, "stop"],
  [4403, "stop"],
  [4406, "stop"],
  [4408, "stop"],
  [4409, "stop"],
  [4410, "stop"],
  [4429, "stop"],
  [4503, "retry"],
]);

type EmittedServerEvent = Exclude<
  ServerControlMessage,
  { readonly type: "audio.ack" } | { readonly type: "error" }
>;

export type RelayTransportEvent = EmittedServerEvent;
export interface RelayTransportLostEvent {
  readonly type: "transport.lost";
  readonly sessionId: string;
  readonly sessionEpoch: number;
}

export type RelayTransportCallbackEvent =
  | RelayTransportEvent
  | FatalEvent
  | RelayTransportLostEvent;

export type RelayTransportRecoveryDisposition = "retry" | "stop";

export type RelayTransportErrorKind =
  | "configuration"
  | "ticket"
  | "websocket"
  | "protocol"
  | "audio"
  | "callback";

const RELAY_TRANSPORT_ERROR_MESSAGES: Readonly<
  Record<RelayTransportErrorKind, string>
> = Object.freeze({
  configuration: "Relay transport configuration failed",
  ticket: "Relay session ticket request failed",
  websocket: "Relay WebSocket transport failed",
  protocol: "Relay protocol failed",
  audio: "Relay audio operation failed",
  callback: "Relay transport callback failed",
});

export class RelayTransportError extends Error {
  readonly kind: RelayTransportErrorKind;
  readonly recoveryDisposition: RelayTransportRecoveryDisposition;

  constructor(
    kind: RelayTransportErrorKind,
    recoveryDisposition: RelayTransportRecoveryDisposition =
      kind === "websocket" ? "retry" : "stop",
  ) {
    super(RELAY_TRANSPORT_ERROR_MESSAGES[kind]);
    Object.defineProperty(this, "name", {
      value: "RelayTransportError",
      configurable: true,
    });
    this.kind = kind;
    this.recoveryDisposition = recoveryDisposition;
  }
}

export interface BrowserWebSocket {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

export interface BrowserWebSocketConstructor {
  new (url: string, protocols?: string | string[]): BrowserWebSocket;
}

export interface RelayTransportOptions {
  /** HTTPS origin of the configured relay, without a path or credentials. */
  readonly relayOrigin: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly WebSocket?: BrowserWebSocketConstructor;
  readonly webSocket?: BrowserWebSocketConstructor;
  readonly webSocketConstructor?: BrowserWebSocketConstructor;
  readonly readyTimeoutMs?: number;
  readonly gatePolicyVersion?: string;
  readonly clientBuild?: string;
  readonly onEvent?: (event: RelayTransportCallbackEvent) => void;
  readonly onServerEvent?: (event: RelayTransportEvent) => void;
  readonly onTransportError?: (error: RelayTransportError) => void;
}

export type RelayConnectionState = "idle" | "connecting" | "open" | "closed";

export interface RelayTransportSnapshot {
  readonly connectionState: RelayConnectionState;
  readonly sessionReady: boolean;
  readonly sessionId?: string;
  readonly sessionEpoch?: number;
  readonly targetLanguage?: TargetLanguage;
  readonly negotiatedLimits?: Readonly<NegotiatedLimits>;
  readonly activeUtteranceId?: string;
  readonly queue?: Readonly<ClientAudioQueueState>;
}

interface ActiveUtterance {
  readonly utteranceId: string;
  readonly queue: ClientRetainedAudioQueue;
  paused: boolean;
  phase: "streaming" | "committing" | "cancelling";
}

interface SessionIdentity {
  readonly sessionId: string;
  readonly sessionEpoch: number;
}

interface ExpectedSessionNegotiation {
  readonly generation: number;
  readonly targetLanguage: TargetLanguage;
  readonly languageRegistryVersion: string;
  readonly gatePolicyVersion: string;
}

interface TransportSource {
  readonly socket: BrowserWebSocket | undefined;
  readonly generation: number;
}

interface ReadyTimeoutRegistration {
  readonly handle: ReturnType<typeof setTimeout>;
  readonly source: TransportSource;
}

function cloneAndFreeze<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();

  const clone = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    const objectValue = input as object;
    const existing = seen.get(objectValue);
    if (existing !== undefined) return existing;

    const output: Record<PropertyKey, unknown> | unknown[] = Array.isArray(input)
      ? new Array(input.length)
      : Object.create(
          Object.getPrototypeOf(input) === null ? null : Object.prototype,
        ) as Record<PropertyKey, unknown>;
    seen.set(objectValue, output);

    for (const key of Reflect.ownKeys(objectValue)) {
      const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
      if (descriptor === undefined || !descriptor.enumerable) continue;
      const propertyValue = "value" in descriptor
        ? descriptor.value
        : Reflect.get(objectValue, key);
      Object.defineProperty(output, key, {
        value: clone(propertyValue),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return Object.freeze(output);
  };

  return clone(value) as T;
}

function configuredRelayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayTransportError("configuration");
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new RelayTransportError("configuration");
  }

  return url.origin;
}

function copyLimits(limits: NegotiatedLimits): Readonly<NegotiatedLimits> {
  return Object.freeze({ ...limits });
}

function copyQueueState(queue: ClientRetainedAudioQueue): Readonly<ClientAudioQueueState> {
  const state = queue.state;
  return Object.freeze({
    ...state,
    inFlightInterval: Object.freeze({ ...state.inFlightInterval }),
    replayInterval: Object.freeze({ ...state.replayInterval }),
  });
}

function closeRecoveryDisposition(code: number): RelayTransportRecoveryDisposition {
  if (code >= 4400 && code <= 4499) return "stop";
  return RELAY_CLOSE_RECOVERY_DISPOSITIONS.get(code) ?? "stop";
}

function httpRecoveryDisposition(status: number): RelayTransportRecoveryDisposition {
  return status === 0 || status === 409 || (status >= 500 && status <= 599)
    ? "retry"
    : "stop";
}

export class RelayTransport {
  readonly #relayOrigin: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #webSocket: BrowserWebSocketConstructor;
  readonly #gatePolicyVersion: string;
  readonly #clientBuild: string;
  readonly #readyTimeoutMs: number;
  readonly #onEvent: ((event: RelayTransportCallbackEvent) => void) | undefined;
  readonly #onServerEvent: ((event: RelayTransportEvent) => void) | undefined;
  readonly #onTransportError: ((error: RelayTransportError) => void) | undefined;
  readonly #expectedTerminalClose = new WeakSet<BrowserWebSocket>();

  #socket: BrowserWebSocket | undefined;
  #pendingOpenResolve: (() => void) | undefined;
  #ticketAbortController: AbortController | undefined;
  #readyTimeout: ReadyTimeoutRegistration | undefined;
  #connectionState: RelayConnectionState = "idle";
  #generation = 0;
  #session: SessionIdentity | undefined;
  #targetLanguage: TargetLanguage | undefined;
  #negotiatedLimits: Readonly<NegotiatedLimits> | undefined;
  #active: ActiveUtterance | undefined;
  #expectedSessionNegotiation: ExpectedSessionNegotiation | undefined;

  constructor(options: RelayTransportOptions) {
    this.#relayOrigin = configuredRelayOrigin(options.relayOrigin);
    this.#fetch =
      options.fetchImpl ?? options.fetch ?? globalThis.fetch.bind(globalThis);
    const webSocket =
      options.webSocketConstructor ?? options.webSocket ?? options.WebSocket ?? globalThis.WebSocket;
    if (webSocket === undefined) {
      throw new RelayTransportError("configuration");
    }
    this.#webSocket = webSocket;
    const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(readyTimeoutMs) ||
      readyTimeoutMs <= 0 ||
      readyTimeoutMs > MAX_READY_TIMEOUT_MS
    ) {
      throw new RelayTransportError("configuration");
    }
    this.#readyTimeoutMs = readyTimeoutMs;
    this.#gatePolicyVersion = options.gatePolicyVersion ?? DEFAULT_GATE_POLICY_VERSION;
    this.#clientBuild = options.clientBuild ?? DEFAULT_CLIENT_BUILD;
    this.#onEvent = options.onEvent;
    this.#onServerEvent = options.onServerEvent;
    this.#onTransportError = options.onTransportError;
  }

  get snapshot(): RelayTransportSnapshot {
    return cloneAndFreeze({
      connectionState: this.#connectionState,
      sessionReady: this.#session !== undefined && this.#negotiatedLimits !== undefined,
      ...(this.#session ?? {}),
      ...(this.#targetLanguage === undefined
        ? {}
        : { targetLanguage: this.#targetLanguage }),
      ...(this.#negotiatedLimits === undefined
        ? {}
        : { negotiatedLimits: { ...this.#negotiatedLimits } }),
      ...(this.#active === undefined
        ? {}
        : {
            activeUtteranceId: this.#active.utteranceId,
            queue: copyQueueState(this.#active.queue),
          }),
    });
  }

  async startSession(targetLanguage: TargetLanguage): Promise<void> {
    this.close();
    this.#connectionState = "connecting";
    const generation = ++this.#generation;
    const ticketSource: TransportSource = { socket: undefined, generation };

    let start: ClientControlMessage;
    try {
      if (!isTargetLanguage(targetLanguage)) {
        throw new TypeError("Target language is not registered");
      }
      start = assertSessionStart({
        type: "session.start",
        protocolVersion: PROTOCOL_VERSION,
        wearerLanguage: "en",
        targetLanguage,
        languageRegistryVersion: LANGUAGE_REGISTRY_VERSION,
        gatePolicyVersion: this.#gatePolicyVersion,
        clientBuild: this.#clientBuild,
        requestedLimits: DEFAULT_NEGOTIATED_LIMITS,
      });
    } catch {
      this.#fail(ticketSource, "configuration", "stop");
      return;
    }

    this.#expectedSessionNegotiation = Object.freeze({
      generation,
      targetLanguage,
      languageRegistryVersion: LANGUAGE_REGISTRY_VERSION,
      gatePolicyVersion: this.#gatePolicyVersion,
    });
    const ticketAbortController = typeof AbortController === "undefined"
      ? undefined
      : new AbortController();
    this.#ticketAbortController = ticketAbortController;
    const ticket = await this.#fetchTicket(generation, ticketAbortController);
    if (ticket === undefined || generation !== this.#generation) return;

    let socket: BrowserWebSocket;
    try {
      socket = new this.#webSocket(
        `${ticket.wssOrigin}${ticket.wssPath}`,
        [...createWebSocketSubprotocols(ticket.ticket)],
      );
    } catch {
      this.#fail(ticketSource, "websocket", "retry");
      return;
    }
    if (!this.#isSourceCurrent(ticketSource)) {
      try {
        if (socket.readyState !== WEBSOCKET_CLOSED) socket.close();
      } catch {
        // A socket displaced during construction was never attached.
      }
      return;
    }

    this.#socket = socket;
    const source: TransportSource = { socket, generation };
    return new Promise<void>((resolve) => {
      let settled = false;
      this.#pendingOpenResolve = resolve;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (this.#pendingOpenResolve === resolve) this.#pendingOpenResolve = undefined;
        resolve();
      };

      socket.onopen = () => {
        if (!this.#isSourceCurrent(source)) return;
        this.#connectionState = "open";
        this.#sendControl(start);
        settle();
      };
      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (!this.#isSourceCurrent(source)) return;
        this.#handleMessage(source, event.data);
      };
      socket.onerror = () => {
        if (!this.#isSourceCurrent(source)) return;
        if (this.#expectedTerminalClose.has(socket)) {
          this.#detachAndClear(source);
          settle();
          return;
        }
        this.#fail(source, "websocket", "retry");
        settle();
      };
      socket.onclose = (event) => {
        if (!this.#isSourceCurrent(source)) return;
        if (this.#expectedTerminalClose.has(socket)) {
          this.#detachAndClear(source);
          settle();
          return;
        }
        const code = Number.isInteger(event.code) ? event.code : 0;
        this.#fail(source, "websocket", closeRecoveryDisposition(code));
        settle();
      };

      this.#armReadyTimeout(source);
      if (socket.readyState === WEBSOCKET_OPEN) {
        socket.onopen(new Event("open"));
      } else if (socket.readyState !== WEBSOCKET_CONNECTING) {
        this.#fail(source, "websocket", "retry");
        settle();
      }
    });
  }

  startUtterance(utteranceId: string): void {
    if (!this.#isReadyForAudio()) return;
    if (this.#active !== undefined) {
      this.#report(this.#currentSource(), "audio");
      return;
    }

    const limits = this.#negotiatedLimits;
    const session = this.#session;
    if (limits === undefined || session === undefined) return;

    let queue: ClientRetainedAudioQueue;
    try {
      queue = new ClientRetainedAudioQueue(utteranceId, {
        maxAudioPayloadBytes: limits.maxAudioPayloadBytes,
        maxUnacknowledgedSamples: limits.maxUnacknowledgedSamples,
        maxRetainedReplaySamples: limits.maxRetainedReplaySamples,
        maxUtteranceSamples: limits.maxUtteranceSamples,
      });
    } catch {
      this.#report(this.#currentSource(), "audio");
      return;
    }

    const active: ActiveUtterance = {
      utteranceId,
      queue,
      paused: false,
      phase: "streaming",
    };
    this.#active = active;
    const message = assertUtteranceStart({
      type: "utterance.start",
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
      utteranceId,
    });
    this.#sendControl(message);
  }

  pushPcm(pcm: Uint8Array): void {
    const active = this.#active;
    if (active === undefined) return;
    if (active.phase !== "streaming") return;
    if (!this.#isReadyForAudio()) {
      this.#abortActive();
      return;
    }
    if (!(pcm instanceof Uint8Array)) {
      this.#abortActive();
      return;
    }
    if (active.paused) {
      this.#abortActive();
      return;
    }

    const result = active.queue.push(pcm);
    if (result.status === "overflow") {
      this.#abortActive();
      return;
    }

    for (const frame of result.frames) {
      if (!this.#sendAudioFrame(frame)) return;
    }
  }

  commitUtterance(): void {
    const active = this.#active;
    const session = this.#session;
    if (active === undefined || active.phase !== "streaming" || session === undefined) return;

    const flush = active.queue.flush();
    for (const frame of flush.frames) {
      if (!this.#sendAudioFrame(frame)) {
        if (this.#active === active && active.phase === "streaming") {
          active.phase = "cancelling";
        }
        return;
      }
    }
    if (flush.status === "incomplete-sample") {
      this.#abortActive(true);
      return;
    }

    const finalOriginalSampleOffset = active.queue.state.nextCapturedOffset;
    const message = assertUtteranceCommit({
      type: "utterance.commit",
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
      utteranceId: active.utteranceId,
      finalOriginalSampleOffset,
    });
    if (this.#sendControl(message)) {
      active.phase = "committing";
    }
  }

  cancelUtterance(): void {
    const active = this.#active;
    const session = this.#session;
    if (active === undefined || active.phase !== "streaming" || session === undefined) return;

    const message = assertUtteranceCancel({
      type: "utterance.cancel",
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
      utteranceId: active.utteranceId,
      finalOriginalSampleOffset: active.queue.state.nextCapturedOffset,
    });
    if (this.#sendControl(message)) {
      active.phase = "cancelling";
    }
  }

  endSession(reason: "user_requested" | "app_shutdown" | "transport_error" = "user_requested"): void {
    const session = this.#session;
    if (session === undefined) return;
    const source = this.#currentSource();
    if (source.socket !== undefined) {
      this.#expectedTerminalClose.add(source.socket);
    }
    try {
      if (this.#active?.phase === "streaming" && !this.#sendUtteranceCancel()) return;
      if (!this.#isSourceCurrent(source)) return;
      const message = assertClientControlMessage({
        type: "session.end",
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        reason,
      });
      this.#sendControl(message);
    } finally {
      this.#detachAndClear(source);
    }
  }

  close(): void {
    this.#detachAndClear(this.#currentSource());
  }

  async #fetchTicket(
    generation: number,
    abortController: AbortController | undefined,
  ): Promise<SessionTicketResponse | undefined> {
    const request = assertSessionTicketRequest({
      protocolVersion: PROTOCOL_VERSION,
      intent: "new",
    });
    const source: TransportSource = { socket: undefined, generation };

    try {
      let response: Response;
      try {
        response = await this.#fetch(
          `${this.#relayOrigin}${SESSION_TICKET_PATH}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
            ...(abortController === undefined ? {} : { signal: abortController.signal }),
          },
        );
      } catch {
        if (this.#isSourceCurrent(source)) {
          this.#fail(source, "ticket", "retry");
        }
        return undefined;
      }
      if (!this.#isSourceCurrent(source)) return undefined;
      if (
        response.ok === false ||
        response.status < 200 ||
        response.status >= 300
      ) {
        this.#fail(source, "ticket", httpRecoveryDisposition(response.status));
        return undefined;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (this.#isSourceCurrent(source)) {
          this.#fail(source, "ticket", "stop");
        }
        return undefined;
      }
      if (!this.#isSourceCurrent(source)) return undefined;

      try {
        return assertSessionTicketResponse(body);
      } catch {
        this.#fail(source, "ticket", "stop");
        return undefined;
      }
    } finally {
      if (this.#ticketAbortController === abortController) {
        this.#ticketAbortController = undefined;
      }
    }
  }

  #currentSource(): TransportSource {
    return { socket: this.#socket, generation: this.#generation };
  }

  #isSourceCurrent(source: TransportSource): boolean {
    return this.#socket === source.socket && this.#generation === source.generation;
  }

  #isReadyForAudio(): boolean {
    return (
      this.#socket?.readyState === WEBSOCKET_OPEN &&
      this.#session !== undefined &&
      this.#negotiatedLimits !== undefined
    );
  }

  #isSessionReady(): boolean {
    return this.#session !== undefined && this.#negotiatedLimits !== undefined;
  }

  #armReadyTimeout(source: TransportSource): void {
    this.#clearReadyTimeout();
    const registration: ReadyTimeoutRegistration = {
      handle: setTimeout(() => {
        if (this.#readyTimeout !== registration) return;
        this.#readyTimeout = undefined;
        if (!this.#isSourceCurrent(source) || this.#isSessionReady()) return;
        this.#fail(source, "websocket", "retry");
      }, this.#readyTimeoutMs),
      source,
    };
    this.#readyTimeout = registration;
  }

  #clearReadyTimeout(source?: TransportSource): void {
    const registration = this.#readyTimeout;
    if (
      registration === undefined ||
      (source !== undefined &&
        (registration.source.socket !== source.socket ||
          registration.source.generation !== source.generation))
    ) return;
    this.#readyTimeout = undefined;
    clearTimeout(registration.handle);
  }

  #sendControl(input: ClientControlMessage): boolean {
    const source = this.#currentSource();
    let message: ClientControlMessage;
    try {
      message = assertClientControlMessage(input);
    } catch {
      this.#fail(source, "protocol", "stop");
      return false;
    }

    const socket = source.socket;
    if (socket === undefined || socket.readyState !== WEBSOCKET_OPEN) {
      this.#fail(source, "websocket", "retry");
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return this.#isSourceCurrent(source);
    } catch {
      this.#fail(source, "websocket", "retry");
      return false;
    }
  }

  #sendAudioFrame(frame: EncodedAudioFrame): boolean {
    const source = this.#currentSource();
    const socket = source.socket;
    if (socket === undefined || socket.readyState !== WEBSOCKET_OPEN) {
      this.#fail(source, "websocket", "retry");
      return false;
    }
    try {
      socket.send(frame.bytes as Uint8Array<ArrayBuffer>);
      return this.#isSourceCurrent(source);
    } catch {
      this.#fail(source, "websocket", "retry");
      return false;
    }
  }

  #handleMessage(source: TransportSource, input: unknown): void {
    try {
      const parsed: unknown = typeof input === "string" ? JSON.parse(input) : input;
      const message = cloneAndFreeze(assertServerControlMessage(parsed));
      if (!this.#isSourceCurrent(source)) return;
      if (message.type === "audio.ack") {
        this.#handleAcknowledgement(source, message);
        return;
      }
      if (message.type === "error") {
        this.#handleServerError(source, message);
        return;
      }
      if (message.type === "session.ready") {
        this.#assertExpectedSessionReady(message);
        this.#clearReadyTimeout(source);
        this.#expectedSessionNegotiation = undefined;
        this.#session = Object.freeze({
          sessionId: message.sessionId,
          sessionEpoch: message.sessionEpoch,
        });
        this.#targetLanguage = message.targetLanguage;
        this.#negotiatedLimits = copyLimits(message.effectiveLimits);
      }
      if (message.type === "session.rejected") {
        const deliverySource = this.#detachAndClear(source);
        if (deliverySource !== undefined) {
          this.#emitServerEvent(deliverySource, message);
        }
        return;
      } else {
        this.#retireActiveForEvent(message);
      }
      this.#emitServerEvent(source, message);
    } catch {
      this.#fail(source, "protocol", "stop");
    }
  }

  #handleAcknowledgement(
    source: TransportSource,
    message: Extract<ServerControlMessage, { readonly type: "audio.ack" }>,
  ): void {
    const active = this.#active;
    const session = this.#session;
    if (active === undefined) return;
    if (
      session === undefined ||
      message.sessionId !== session.sessionId ||
      message.sessionEpoch !== session.sessionEpoch ||
      message.utteranceId !== active.utteranceId
    ) {
      this.#abortActive();
      return;
    }

    const result = active.queue.acknowledge(message.highestContiguousExclusiveOffset);
    if (result.status === "invalid") {
      this.#abortActive();
      return;
    }
    if (message.flowState === "abort") {
      this.#active = undefined;
      this.#report(source, "audio");
      return;
    }
    active.paused = message.flowState === "pause";
  }

  #emitServerEvent(source: TransportSource, event: RelayTransportEvent): void {
    if (!this.#isSourceCurrent(source)) return;
    try {
      this.#onServerEvent?.(event);
    } catch {
      this.#report(source, "callback");
    }
    if (!this.#isSourceCurrent(source)) return;
    try {
      this.#onEvent?.(event);
    } catch {
      this.#report(source, "callback");
    }
  }

  #handleServerError(
    source: TransportSource,
    message: Extract<ServerControlMessage, { readonly type: "error" }>,
  ): void {
    if (message.recoverable) return;

    const deliverySource = this.#detachAndClear(source);
    if (deliverySource !== undefined) this.#emitFatal(deliverySource);
  }

  #emitFatal(source: TransportSource): void {
    const fatal: FatalEvent = Object.freeze({ type: "fatal" });
    this.#emitCallbackEvent(source, fatal);
  }

  #emitCallbackEvent(
    source: TransportSource,
    event: FatalEvent | RelayTransportLostEvent,
  ): void {
    if (!this.#isSourceCurrent(source)) return;
    try {
      this.#onEvent?.(event);
    } catch {
      this.#report(source, "callback");
    }
  }

  #sendUtteranceCancel(): boolean {
    const active = this.#active;
    const session = this.#session;
    if (active === undefined || active.phase !== "streaming" || session === undefined) return true;
    const message = assertUtteranceCancel({
      type: "utterance.cancel",
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
      utteranceId: active.utteranceId,
      finalOriginalSampleOffset: active.queue.state.nextCapturedOffset,
    });
    if (!this.#sendControl(message)) return false;
    active.phase = "cancelling";
    return true;
  }

  #abortActive(lockPhase = false): void {
    const source = this.#currentSource();
    const active = this.#active;
    if (active === undefined) {
      this.#report(source, "audio");
      return;
    }
    if (active.phase === "streaming") this.#sendUtteranceCancel();
    if (!this.#isSourceCurrent(source) || this.#active !== active) return;
    if (lockPhase && this.#active === active && active.phase === "streaming") {
      active.phase = "cancelling";
    }
    this.#report(source, "audio");
  }

  #fail(
    source: TransportSource,
    kind: RelayTransportErrorKind,
    recoveryDisposition: RelayTransportRecoveryDisposition,
  ): void {
    if (!this.#isSourceCurrent(source)) return;
    const expectedTerminal =
      source.socket !== undefined && this.#expectedTerminalClose.has(source.socket);
    const session =
      recoveryDisposition === "retry" && this.#isSessionReady() && !expectedTerminal
        ? this.#session
        : undefined;
    const deliverySource = this.#detachAndClear(source);
    if (deliverySource === undefined) return;
    if (
      session !== undefined &&
      recoveryDisposition === "retry" &&
      !expectedTerminal
    ) {
      const event: RelayTransportLostEvent = Object.freeze({
        type: "transport.lost",
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
      });
      this.#emitCallbackEvent(deliverySource, event);
      return;
    }
    this.#report(deliverySource, kind, recoveryDisposition);
  }

  #report(
    source: TransportSource,
    kind: RelayTransportErrorKind,
    recoveryDisposition: RelayTransportRecoveryDisposition =
      kind === "websocket" ? "retry" : "stop",
  ): void {
    if (!this.#isSourceCurrent(source)) return;
    const error = new RelayTransportError(kind, recoveryDisposition);
    try {
      this.#onTransportError?.(error);
    } catch {
      // User error handlers are isolated from transport lifecycle state.
    }
  }

  #detachAndClear(source: TransportSource): TransportSource | undefined {
    if (!this.#isSourceCurrent(source)) return undefined;

    const socket = source.socket;
    const pendingOpenResolve = this.#pendingOpenResolve;
    this.#pendingOpenResolve = undefined;
    const abortController = this.#ticketAbortController;
    this.#ticketAbortController = undefined;
    const readyTimeout = this.#readyTimeout;
    this.#readyTimeout = undefined;
    this.#socket = undefined;
    this.#generation += 1;
    this.#expectedSessionNegotiation = undefined;
    this.#connectionState = "closed";
    this.#clearSessionState();
    const deliverySource = this.#currentSource();

    if (readyTimeout !== undefined) clearTimeout(readyTimeout.handle);
    try {
      abortController?.abort();
    } catch {
      // Aborting is best effort; detachment is authoritative.
    }
    pendingOpenResolve?.();
    try {
      if (socket !== undefined && socket.readyState !== WEBSOCKET_CLOSED) {
        socket.close();
      }
    } catch {
      // Closing is best effort; the local transport is already detached.
    }
    return deliverySource;
  }

  #clearSessionState(): void {
    this.#active = undefined;
    this.#session = undefined;
    this.#targetLanguage = undefined;
    this.#negotiatedLimits = undefined;
  }

  #assertExpectedSessionReady(
    message: Extract<ServerControlMessage, { readonly type: "session.ready" }>,
  ): void {
    const expected = this.#expectedSessionNegotiation;
    if (
      expected === undefined ||
      expected.generation !== this.#generation ||
      message.result !== "new" ||
      message.targetLanguage !== expected.targetLanguage ||
      message.languageRegistryVersion !== expected.languageRegistryVersion ||
      message.gatePolicyVersion !== expected.gatePolicyVersion
    ) {
      throw new Error("Server session.ready does not match this session negotiation");
    }
  }

  #retireActiveForEvent(event: RelayTransportEvent): void {
    const active = this.#active;
    const session = this.#session;
    if (
      active === undefined ||
      session === undefined ||
      !("sessionId" in event) ||
      event.sessionId !== session.sessionId ||
      event.sessionEpoch !== session.sessionEpoch ||
      !("utteranceId" in event) ||
      event.utteranceId !== active.utteranceId
    ) {
      return;
    }

    if (
      event.type === "utterance.aborted" ||
      event.type === "suggestions.ready" ||
      (event.type === "language.decision" && event.decision !== "target")
    ) {
      this.#active = undefined;
    }
  }
}

export function createRelayTransport(options: RelayTransportOptions): RelayTransport {
  return new RelayTransport(options);
}

export const G2RelayTransport = RelayTransport;
export const RelayClientTransport = RelayTransport;
