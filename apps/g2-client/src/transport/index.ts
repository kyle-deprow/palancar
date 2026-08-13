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
const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;

type EmittedServerEvent = Exclude<
  ServerControlMessage,
  { readonly type: "audio.ack" } | { readonly type: "error" }
>;

export type RelayTransportEvent = EmittedServerEvent;
export type RelayTransportCallbackEvent = RelayTransportEvent | FatalEvent;

export type RelayTransportErrorKind =
  | "configuration"
  | "ticket"
  | "websocket"
  | "protocol"
  | "audio"
  | "callback";

export class RelayTransportError extends Error {
  readonly kind: RelayTransportErrorKind;
  override readonly cause: unknown;

  constructor(kind: RelayTransportErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "RelayTransportError";
    this.kind = kind;
    this.cause = cause;
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
  } catch (error: unknown) {
    throw new RelayTransportError("configuration", "Relay origin is not a valid URL", error);
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new RelayTransportError(
      "configuration",
      "Relay origin must be an HTTPS origin without credentials, path, query, or fragment",
    );
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

export class RelayTransport {
  readonly #relayOrigin: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #webSocket: BrowserWebSocketConstructor;
  readonly #gatePolicyVersion: string;
  readonly #clientBuild: string;
  readonly #onEvent: ((event: RelayTransportCallbackEvent) => void) | undefined;
  readonly #onServerEvent: ((event: RelayTransportEvent) => void) | undefined;
  readonly #onTransportError: ((error: RelayTransportError) => void) | undefined;
  readonly #intentionallyClosed = new WeakSet<BrowserWebSocket>();
  readonly #expectedTerminalClose = new WeakSet<BrowserWebSocket>();

  #socket: BrowserWebSocket | undefined;
  #pendingOpenResolve: (() => void) | undefined;
  #ticketAbortController: AbortController | undefined;
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
      throw new RelayTransportError("configuration", "WebSocket is not available");
    }
    this.#webSocket = webSocket;
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
    } catch (error: unknown) {
      this.#fail("configuration", "Session negotiation is invalid", error, true);
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
    } catch (error: unknown) {
      this.#fail("websocket", "WebSocket construction failed", error, true);
      return;
    }

    this.#socket = socket;
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
        if (!this.#isCurrent(socket, generation)) return;
        this.#connectionState = "open";
        this.#sendControl(start);
        settle();
      };
      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (!this.#isCurrent(socket, generation)) return;
        this.#handleMessage(event.data);
      };
      socket.onerror = () => {
        if (!this.#isCurrent(socket, generation)) return;
        this.#fail("websocket", "WebSocket transport error", undefined, true);
        settle();
      };
      socket.onclose = () => {
        if (!this.#isCurrent(socket, generation)) return;
        const intentional = this.#intentionallyClosed.has(socket);
        const expectedTerminal = this.#expectedTerminalClose.has(socket);
        this.#socket = undefined;
        this.#connectionState = "closed";
        if (!intentional && !expectedTerminal) {
          this.#report(
            new RelayTransportError("websocket", "Relay WebSocket closed unexpectedly"),
            false,
          );
        }
        settle();
      };

      if (socket.readyState === WEBSOCKET_OPEN) {
        socket.onopen(new Event("open"));
      } else if (socket.readyState !== WEBSOCKET_CONNECTING) {
        this.#fail("websocket", "Relay WebSocket was not connectable", undefined, true);
        settle();
      }
    });
  }

  startUtterance(utteranceId: string): void {
    if (!this.#isReadyForAudio()) return;
    if (this.#active !== undefined) {
      this.#report(
        new RelayTransportError("audio", "An utterance is already active"),
        false,
      );
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
    } catch (error: unknown) {
      this.#report(
        new RelayTransportError("audio", "Utterance audio queue is invalid", error),
        false,
      );
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
      this.#abortActive("PCM cannot be sent while the relay socket is not open");
      return;
    }
    if (!(pcm instanceof Uint8Array)) {
      this.#abortActive("PCM must be a Uint8Array");
      return;
    }
    if (active.paused) {
      this.#abortActive("PCM arrived while relay flow control was paused");
      return;
    }

    const result = active.queue.push(pcm);
    if (result.status === "overflow") {
      this.#abortActive(
        `PCM queue overflow: ${result.exceededLimits.join(", ")}`,
      );
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
      this.#abortActive("PCM ended with an incomplete sample", undefined, true);
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
    if (this.#active?.phase === "streaming" && !this.#sendUtteranceCancel()) return;

    const message = assertClientControlMessage({
      type: "session.end",
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
      reason,
    });
    if (!this.#sendControl(message)) return;
    this.#markExpectedTerminalClose();
    this.#active = undefined;
    this.#session = undefined;
    this.#targetLanguage = undefined;
    this.#negotiatedLimits = undefined;
  }

  close(): void {
    this.#abortTicketRequest();
    const pendingOpenResolve = this.#pendingOpenResolve;
    this.#pendingOpenResolve = undefined;
    pendingOpenResolve?.();
    this.#generation += 1;
    this.#active = undefined;
    this.#session = undefined;
    this.#targetLanguage = undefined;
    this.#negotiatedLimits = undefined;
    this.#expectedSessionNegotiation = undefined;
    this.#connectionState = "closed";
    this.#closeSocket();
  }

  async #fetchTicket(
    generation: number,
    abortController: AbortController | undefined,
  ): Promise<SessionTicketResponse | undefined> {
    const request = assertSessionTicketRequest({
      protocolVersion: PROTOCOL_VERSION,
      intent: "new",
    });

    try {
      const response = await this.#fetch(
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
      if (generation !== this.#generation) return undefined;
      if (response.ok === false) {
        throw new Error(`Session ticket request failed with HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      return assertSessionTicketResponse(body);
    } catch (error: unknown) {
      if (generation !== this.#generation) return undefined;
      this.#fail("ticket", "Session ticket exchange failed", error, true);
      return undefined;
    } finally {
      if (this.#ticketAbortController === abortController) {
        this.#ticketAbortController = undefined;
      }
    }
  }

  #isCurrent(socket: BrowserWebSocket, generation: number): boolean {
    return this.#socket === socket && this.#generation === generation;
  }

  #isReadyForAudio(): boolean {
    return (
      this.#socket?.readyState === WEBSOCKET_OPEN &&
      this.#session !== undefined &&
      this.#negotiatedLimits !== undefined
    );
  }

  #sendControl(input: ClientControlMessage): boolean {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WEBSOCKET_OPEN) {
      this.#report(
        new RelayTransportError("websocket", "Control message could not be sent"),
        false,
      );
      return false;
    }
    try {
      const message = assertClientControlMessage(input);
      socket.send(JSON.stringify(message));
      return true;
    } catch (error: unknown) {
      this.#fail("websocket", "Control message could not be sent", error, true);
      return false;
    }
  }

  #sendAudioFrame(frame: EncodedAudioFrame): boolean {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WEBSOCKET_OPEN) {
      this.#abortActive("Audio frame could not be sent");
      return false;
    }
    try {
      socket.send(frame.bytes as Uint8Array<ArrayBuffer>);
      return true;
    } catch (error: unknown) {
      this.#abortActive("Audio frame could not be sent", error);
      return false;
    }
  }

  #handleMessage(input: unknown): void {
    let parsed: unknown;
    try {
      parsed = typeof input === "string" ? JSON.parse(input) : input;
      const message = cloneAndFreeze(assertServerControlMessage(parsed));
      if (message.type === "audio.ack") {
        this.#handleAcknowledgement(message);
        return;
      }
      if (message.type === "error") {
        this.#handleServerError(message);
        return;
      }
      if (message.type === "session.ready") {
        this.#assertExpectedSessionReady(message);
        this.#expectedSessionNegotiation = undefined;
        this.#session = Object.freeze({
          sessionId: message.sessionId,
          sessionEpoch: message.sessionEpoch,
        });
        this.#targetLanguage = message.targetLanguage;
        this.#negotiatedLimits = copyLimits(message.effectiveLimits);
      }
      if (message.type === "session.rejected") {
        this.#markExpectedTerminalClose();
        this.#clearSessionState();
      } else {
        this.#retireActiveForEvent(message);
      }
      this.#emitServerEvent(message);
    } catch (error: unknown) {
      this.#fail("protocol", "Malformed server control message", error, true);
    }
  }

  #handleAcknowledgement(message: Extract<ServerControlMessage, { readonly type: "audio.ack" }>): void {
    const active = this.#active;
    const session = this.#session;
    if (active === undefined) return;
    if (
      session === undefined ||
      message.sessionId !== session.sessionId ||
      message.sessionEpoch !== session.sessionEpoch ||
      message.utteranceId !== active.utteranceId
    ) {
      this.#abortActive("Audio acknowledgement does not match the active utterance");
      return;
    }

    const result = active.queue.acknowledge(message.highestContiguousExclusiveOffset);
    if (result.status === "invalid") {
      this.#abortActive(
        `Invalid audio acknowledgement: ${result.reason}`,
      );
      return;
    }
    if (message.flowState === "abort") {
      this.#active = undefined;
      this.#report(
        new RelayTransportError("audio", "Relay aborted the active utterance"),
        false,
      );
      return;
    }
    active.paused = message.flowState === "pause";
  }

  #emitServerEvent(event: RelayTransportEvent): void {
    try {
      this.#onServerEvent?.(event);
    } catch (error: unknown) {
      this.#report(
        new RelayTransportError("callback", "Server event callback failed", error),
        false,
      );
    }
    try {
      this.#onEvent?.(event);
    } catch (error: unknown) {
      this.#report(
        new RelayTransportError("callback", "Transport event callback failed", error),
        false,
      );
    }
  }

  #handleServerError(message: Extract<ServerControlMessage, { readonly type: "error" }>): void {
    if (message.recoverable) {
      this.#active = undefined;
      this.#report(
        new RelayTransportError(
          "protocol",
          `Relay reported a recoverable ${message.scope} error: ${message.code}`,
          message,
        ),
        false,
      );
      return;
    }

    this.#markExpectedTerminalClose();
    this.#clearSessionState();
    this.#closeSocket();
    this.#emitFatal();
  }

  #emitFatal(): void {
    const fatal: FatalEvent = Object.freeze({ type: "fatal" });
    try {
      this.#onEvent?.(fatal);
    } catch (error: unknown) {
      this.#report(
        new RelayTransportError("callback", "Fatal event callback failed", error),
        false,
      );
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

  #abortActive(message: string, cause?: unknown, lockPhase = false): void {
    const active = this.#active;
    if (active === undefined) {
      this.#report(new RelayTransportError("audio", message, cause), false);
      return;
    }
    if (active.phase === "streaming") this.#sendUtteranceCancel();
    if (lockPhase && this.#active === active && active.phase === "streaming") {
      active.phase = "cancelling";
    }
    this.#report(new RelayTransportError("audio", message, cause), false);
  }

  #fail(
    kind: RelayTransportErrorKind,
    message: string,
    cause?: unknown,
    closeSocket = false,
  ): void {
    this.#report(new RelayTransportError(kind, message, cause), closeSocket);
  }

  #report(error: RelayTransportError, closeSocket: boolean): void {
    const socket = this.#socket;
    const generation = this.#generation;
    try {
      this.#onTransportError?.(error);
    } catch {
      // User error handlers must not break protocol cleanup.
    }
    if (closeSocket && this.#socket === socket && this.#generation === generation) {
      this.#closeSocket();
    }
  }

  #closeSocket(): void {
    const pendingOpenResolve = this.#pendingOpenResolve;
    this.#pendingOpenResolve = undefined;
    pendingOpenResolve?.();
    const socket = this.#socket;
    this.#socket = undefined;
    this.#generation += 1;
    this.#expectedSessionNegotiation = undefined;
    this.#connectionState = "closed";
    if (socket === undefined) return;
    this.#intentionallyClosed.add(socket);
    try {
      if (socket.readyState !== WEBSOCKET_CLOSED) socket.close();
    } catch {
      // Closing is best effort; the local transport is already detached.
    }
  }

  #abortTicketRequest(): void {
    const controller = this.#ticketAbortController;
    this.#ticketAbortController = undefined;
    try {
      controller?.abort();
    } catch {
      // Aborting is best effort; the generation check is authoritative.
    }
  }

  #markExpectedTerminalClose(): void {
    const socket = this.#socket;
    if (socket !== undefined) this.#expectedTerminalClose.add(socket);
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
