import {
  DEFAULT_NEGOTIATED_LIMITS,
  PROTOCOL_VERSION,
  assertClientControlMessage,
  assertServerControlMessage,
  assertSessionStart,
  assertSessionTicketRequest,
  assertSessionTicketResponse,
  assertUtteranceAborted,
  assertUtteranceCancel,
  assertUtteranceCommit,
  assertUtteranceStart,
  createWebSocketSubprotocols,
  isBase64UrlSecret,
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
import type {
  CredentialRejectedEvent,
  CredentialStorageErrorEvent,
} from "../state/index.js";
import type {
  SessionCredentialGrantToken,
  SessionCredentialLease,
  SessionCredentialProvider,
} from "../auth/types.js";

const SESSION_TICKET_PATH = "/v1/session-tickets" as const;
const MAX_TICKET_BODY_BYTES = 16 * 1024;
const DEFAULT_GATE_POLICY_VERSION = "1.0.0" as const;
const DEFAULT_CLIENT_BUILD = "g2-client-dev" as const;
const DEFAULT_READY_TIMEOUT_MS = 10_000 as const;
const MAX_READY_TIMEOUT_MS = 2_147_483_647 as const;
const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;
const RETIRED_UTTERANCE_CAPACITY = 8;

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

function utteranceIdentityKey(
  sessionId: string,
  sessionEpoch: number,
  utteranceId: string,
): string {
  return `${sessionId}\u0000${sessionEpoch}\u0000${utteranceId}`;
}

function serverUtteranceIdentity(event: ServerControlMessage): string | undefined {
  if (!("utteranceId" in event)) return undefined;
  return utteranceIdentityKey(event.sessionId, event.sessionEpoch, event.utteranceId);
}

function terminalUtteranceIdentity(event: RelayTransportEvent): string | undefined {
  switch (event.type) {
    case "utterance.aborted":
    case "suggestions.ready":
      return utteranceIdentityKey(event.sessionId, event.sessionEpoch, event.utteranceId);
    case "language.decision":
      return event.decision === "target"
        ? undefined
        : utteranceIdentityKey(event.sessionId, event.sessionEpoch, event.utteranceId);
    default:
      return undefined;
  }
}

export type RelayTransportEvent = EmittedServerEvent;
export interface RelayTransportLostEvent {
  readonly type: "transport.lost";
  readonly sessionId: string;
  readonly sessionEpoch: number;
}

export type RelayTransportCallbackEvent =
  | RelayTransportEvent
  | FatalEvent
  | RelayTransportLostEvent
  | CredentialRejectedEvent
  | CredentialStorageErrorEvent;

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
  readonly credentialProvider: SessionCredentialProvider;
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
  readonly pendingFrames: EncodedAudioFrame[];
  paused: boolean;
  commitRequested: boolean;
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

interface AuthenticatedTicket {
  readonly ticket: SessionTicketResponse;
  readonly credentialVersion: number;
  readonly grantToken: SessionCredentialGrantToken;
}

interface LiveCredentialGrant {
  readonly generation: number;
  readonly credentialVersion: number;
  readonly grantToken: SessionCredentialGrantToken;
  rejectionStarted: boolean;
}

const CREDENTIAL_REJECTED_EVENT: CredentialRejectedEvent = Object.freeze({
  type: "credential.rejected",
});
const CREDENTIAL_STORAGE_ERROR_EVENT: CredentialStorageErrorEvent = Object.freeze({
  type: "credential.storage-error",
});

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

function expectedWebSocketOrigin(relayOrigin: string): string {
  return `wss://${new URL(relayOrigin).host}`;
}

function exactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every(
    (key) => typeof key === "string" && expected.includes(key),
  );
}

function acquiredLease(value: unknown): SessionCredentialLease | "required" | "storage-error" | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!exactOwnKeys(value, ["kind", ...(Reflect.get(value, "kind") === "ready" ? ["lease"] : [])])) {
    return undefined;
  }
  const kind = Reflect.get(value, "kind");
  if (kind === "required" || kind === "storage-error") return kind;
  if (kind !== "ready") return undefined;
  const lease = Reflect.get(value, "lease");
  if (
    typeof lease !== "object" || lease === null ||
    !exactOwnKeys(lease, ["credential", "credentialVersion", "grantToken"])
  ) return undefined;
  const credential = Reflect.get(lease, "credential");
  const credentialVersion = Reflect.get(lease, "credentialVersion");
  const grantToken = Reflect.get(lease, "grantToken");
  if (
    !isBase64UrlSecret(credential) ||
    typeof credentialVersion !== "number" ||
    !Number.isSafeInteger(credentialVersion) ||
    credentialVersion <= 0 ||
    typeof grantToken !== "object" ||
    grantToken === null
  ) return undefined;
  return lease as SessionCredentialLease;
}

function cancelResponseBody(body: ReadableStream<Uint8Array> | null): void {
  if (body === null) return;
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best effort and never exposes a response failure.
  }
}

function cancelResponse(response: Response): void {
  try {
    cancelResponseBody(response.body);
  } catch {
    // A late or rejected response is discarded even if its body accessor fails.
  }
}

async function awaitWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (signal === undefined) return operation;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = (): void => {
    onAbort();
    rejectAbort(new Error("ticket body aborted"));
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function readBoundedTicketJson(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (signal?.aborted) {
    cancelResponse(response);
    throw new Error("ticket body aborted");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > MAX_TICKET_BODY_BYTES) {
      cancelResponse(response);
      throw new Error("ticket body overflow");
    }
  }
  if (response.body === null) {
    const text = await awaitWithAbort(
      response.text(),
      signal,
      () => cancelResponse(response),
    );
    if (new TextEncoder().encode(text).byteLength > MAX_TICKET_BODY_BYTES) {
      throw new Error("ticket body overflow");
    }
    return JSON.parse(text) as unknown;
  }

  const reader = response.body.getReader();
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancelReader = (): void => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cancellation is best effort; the abort race settles the operation.
    }
    if (signal !== undefined) rejectAbort(new Error("ticket body aborted"));
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  if (signal?.aborted) cancelReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const read = reader.read();
      const next = signal === undefined ? await read : await Promise.race([read, aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_TICKET_BODY_BYTES) {
        cancelReader();
        throw new Error("ticket body overflow");
      }
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // A noncooperative pending read may keep its lock after local cancellation.
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function copyLimits(limits: NegotiatedLimits): Readonly<NegotiatedLimits> {
  return Object.freeze({ ...limits });
}

function limitsEqual(
  left: Readonly<NegotiatedLimits>,
  right: Readonly<NegotiatedLimits>,
): boolean {
  const leftKeys = Object.keys(left) as Array<keyof NegotiatedLimits>;
  const rightKeys = Object.keys(right) as Array<keyof NegotiatedLimits>;
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key],
    )
  );
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
  readonly #wssOrigin: string;
  readonly #credentialProvider: SessionCredentialProvider;
  readonly #fetch: typeof globalThis.fetch;
  readonly #webSocket: BrowserWebSocketConstructor;
  readonly #gatePolicyVersion: string;
  readonly #clientBuild: string;
  readonly #readyTimeoutMs: number;
  readonly #onEvent: ((event: RelayTransportCallbackEvent) => void) | undefined;
  readonly #onServerEvent: ((event: RelayTransportEvent) => void) | undefined;
  readonly #onTransportError: ((error: RelayTransportError) => void) | undefined;
  readonly #expectedTerminalClose = new WeakSet<BrowserWebSocket>();
  readonly #retiredUtterances = new Set<string>();

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
  #liveCredentialGrant: LiveCredentialGrant | undefined;

  constructor(options: RelayTransportOptions) {
    this.#relayOrigin = configuredRelayOrigin(options.relayOrigin);
    this.#wssOrigin = expectedWebSocketOrigin(this.#relayOrigin);
    let credentialProvider: SessionCredentialProvider;
    try {
      credentialProvider = options.credentialProvider;
      if (
        typeof credentialProvider !== "object" || credentialProvider === null ||
        typeof credentialProvider.acquire !== "function" ||
        typeof credentialProvider.recordAuthenticated !== "function" ||
        typeof credentialProvider.reject !== "function"
      ) throw new Error("invalid credential provider");
    } catch {
      throw new RelayTransportError("configuration");
    }
    this.#credentialProvider = credentialProvider;
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
      this.#report(this.#currentSource(), "configuration", "stop");
      return;
    }

    this.close();
    this.#connectionState = "connecting";
    const generation = ++this.#generation;
    const ticketSource: TransportSource = { socket: undefined, generation };

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
    const authenticated = await this.#authorizeTicket(generation, ticketAbortController);
    if (authenticated === undefined || generation !== this.#generation) return;
    const { ticket, credentialVersion, grantToken } = authenticated;
    this.#liveCredentialGrant = {
      generation,
      credentialVersion,
      grantToken,
      rejectionStarted: false,
    };

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
        if (code === 4401) {
          this.#beginLiveCredentialRejection(source);
          settle();
          return;
        }
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
      pendingFrames: [],
      paused: false,
      commitRequested: false,
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

    const result = active.queue.push(pcm);
    if (result.status === "overflow") {
      this.#abortActive();
      return;
    }

    active.pendingFrames.push(...result.frames);
    if (!active.paused) this.#drainPendingAudio(active);
  }

  commitUtterance(): void {
    const active = this.#active;
    const session = this.#session;
    if (active === undefined || active.phase !== "streaming" || session === undefined) return;

    active.commitRequested = true;
    if (active.paused) {
      active.phase = "committing";
      return;
    }
    this.#commitActive(active);
  }

  cancelUtterance(options: Readonly<{ readonly retireImmediately?: boolean }> = {}): void {
    const active = this.#active;
    const session = this.#session;
    if (active === undefined || session === undefined) return;
    this.#sendUtteranceCancel(options.retireImmediately === true);
  }

  endSession(reason: "user_requested" | "app_shutdown" | "transport_error" = "user_requested"): void {
    const session = this.#session;
    if (session === undefined) return;
    const source = this.#currentSource();
    if (source.socket !== undefined) {
      this.#expectedTerminalClose.add(source.socket);
    }
    try {
      if (this.#active !== undefined && !this.#sendUtteranceCancel()) return;
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
    lease: SessionCredentialLease,
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
              Authorization: `Bearer ${lease.credential}`,
            },
            body: JSON.stringify(request),
            credentials: "omit",
            redirect: "error",
            ...(abortController === undefined ? {} : { signal: abortController.signal }),
          },
        );
      } catch {
        if (this.#isSourceCurrent(source)) {
          this.#fail(source, "ticket", "retry");
        }
        return undefined;
      }
      if (!this.#isSourceCurrent(source)) {
        cancelResponse(response);
        return undefined;
      }
      if (response.status === 401) {
        cancelResponse(response);
        await this.#rejectTicketCredential(source, lease);
        return undefined;
      }
      if (
        response.ok === false ||
        response.status < 200 ||
        response.status >= 300
      ) {
        cancelResponse(response);
        this.#fail(source, "ticket", httpRecoveryDisposition(response.status));
        return undefined;
      }

      let body: unknown;
      try {
        body = await readBoundedTicketJson(response, abortController?.signal);
      } catch {
        if (this.#isSourceCurrent(source)) {
          this.#fail(source, "ticket", "stop");
        }
        return undefined;
      }
      if (!this.#isSourceCurrent(source)) {
        cancelResponse(response);
        return undefined;
      }

      try {
        const ticket = assertSessionTicketResponse(body);
        if (ticket.wssOrigin !== this.#wssOrigin) throw new Error("unexpected ticket origin");
        return ticket;
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

  async #authorizeTicket(
    generation: number,
    abortController: AbortController | undefined,
  ): Promise<AuthenticatedTicket | undefined> {
    const source: TransportSource = { socket: undefined, generation };
    let acquisition: unknown;
    try {
      acquisition = await this.#credentialProvider.acquire();
    } catch {
      if (this.#isSourceCurrent(source)) {
        this.#emitCredentialOutcome(source, CREDENTIAL_STORAGE_ERROR_EVENT);
      }
      return undefined;
    }
    if (!this.#isSourceCurrent(source)) return undefined;

    let lease: SessionCredentialLease | "required" | "storage-error" | undefined;
    try {
      lease = acquiredLease(acquisition);
    } catch {
      lease = undefined;
    }
    if (lease === "required") {
      this.#emitCredentialOutcome(source, CREDENTIAL_REJECTED_EVENT);
      return undefined;
    }
    if (lease === "storage-error" || lease === undefined) {
      this.#emitCredentialOutcome(source, CREDENTIAL_STORAGE_ERROR_EVENT);
      return undefined;
    }

    let ticket: SessionTicketResponse | undefined;
    try {
      ticket = await this.#fetchTicket(generation, abortController, lease);
    } catch {
      if (this.#isSourceCurrent(source)) this.#fail(source, "ticket", "stop");
      return undefined;
    }
    if (ticket === undefined || !this.#isSourceCurrent(source)) return undefined;

    let result: unknown;
    try {
      result = await this.#credentialProvider.recordAuthenticated(
        lease.credentialVersion,
        lease.grantToken,
      );
    } catch {
      if (this.#isSourceCurrent(source)) {
        this.#emitCredentialOutcome(source, CREDENTIAL_STORAGE_ERROR_EVENT);
      }
      return undefined;
    }
    if (!this.#isSourceCurrent(source)) return undefined;
    if (result === "stale") {
      this.#detachAndClear(source);
      return undefined;
    }
    if (result !== "recorded") {
      this.#emitCredentialOutcome(source, CREDENTIAL_STORAGE_ERROR_EVENT);
      return undefined;
    }
    return Object.freeze({
      ticket,
      credentialVersion: lease.credentialVersion,
      grantToken: lease.grantToken,
    });
  }

  async #rejectTicketCredential(
    source: TransportSource,
    lease: SessionCredentialLease,
  ): Promise<void> {
    let result: unknown;
    try {
      result = await this.#credentialProvider.reject(
        lease.credentialVersion,
        lease.grantToken,
      );
    } catch {
      if (this.#isSourceCurrent(source)) {
        this.#emitCredentialOutcome(source, CREDENTIAL_STORAGE_ERROR_EVENT);
      }
      return;
    }
    if (!this.#isSourceCurrent(source)) return;
    if (result === "stale") {
      this.#detachAndClear(source);
    } else if (result === "required") {
      this.#emitCredentialOutcome(source, CREDENTIAL_REJECTED_EVENT);
    } else {
      this.#emitCredentialOutcome(source, CREDENTIAL_STORAGE_ERROR_EVENT);
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

  #drainPendingAudio(active: ActiveUtterance): boolean {
    if (active.paused) return true;
    while (active.pendingFrames.length > 0) {
      const frame = active.pendingFrames[0];
      if (frame === undefined) return true;
      if (!this.#sendAudioFrame(frame)) return false;
      active.pendingFrames.shift();
    }
    return true;
  }

  #commitActive(active: ActiveUtterance): void {
    if (
      active.paused ||
      !active.commitRequested ||
      (active.phase !== "streaming" && active.phase !== "committing")
    ) return;
    if (!this.#drainPendingAudio(active)) return;

    const session = this.#session;
    if (session === undefined) {
      this.#abortActive();
      return;
    }

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

    const message = assertUtteranceCommit({
      type: "utterance.commit",
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
      utteranceId: active.utteranceId,
      finalOriginalSampleOffset: active.queue.state.nextCapturedOffset,
    });
    if (this.#sendControl(message)) {
      active.commitRequested = false;
      active.phase = "committing";
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
      if (
        (message.type === "session.rejected" || message.type === "error") &&
        message.code === "authentication_failed"
      ) {
        this.#beginLiveCredentialRejection(source);
        return;
      }
      if (message.type === "audio.ack") {
        this.#handleAcknowledgement(source, message);
        return;
      }
      if (message.type === "error") {
        this.#handleServerError(source, message);
        return;
      }
      if (message.type === "session.ready") {
        if (!this.#assertExpectedSessionReady(message)) return;
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
        const utteranceIdentity = serverUtteranceIdentity(message);
        if (
          utteranceIdentity !== undefined &&
          !this.#matchesActiveUtterance(utteranceIdentity) &&
          this.#retiredUtterances.has(utteranceIdentity)
        ) return;
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
    const identity = utteranceIdentityKey(
      message.sessionId,
      message.sessionEpoch,
      message.utteranceId,
    );
    const live =
      active !== undefined &&
      !this.#isTerminalUtterance(active) &&
      session !== undefined &&
      message.sessionId === session.sessionId &&
      message.sessionEpoch === session.sessionEpoch &&
      message.utteranceId === active.utteranceId;
    if (!live && this.#retiredUtterances.has(identity)) return;
    if (active === undefined || this.#isTerminalUtterance(active)) return;
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
      const aborted = assertUtteranceAborted({
        type: "utterance.aborted",
        sessionId: message.sessionId,
        sessionEpoch: message.sessionEpoch,
        utteranceId: message.utteranceId,
        category: "flow",
      });
      this.#active = undefined;
      this.#emitServerEvent(source, aborted);
      return;
    }
    active.paused = message.flowState === "pause";
    if (!active.paused) {
      if (!this.#drainPendingAudio(active)) return;
      if (active.commitRequested) this.#commitActive(active);
    }
  }

  #emitServerEvent(source: TransportSource, event: RelayTransportEvent): void {
    if (!this.#isSourceCurrent(source)) return;
    const terminalIdentity = terminalUtteranceIdentity(event);
    if (terminalIdentity !== undefined && !this.#rememberRetiredUtterance(terminalIdentity)) return;
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
    event:
      | FatalEvent
      | RelayTransportLostEvent
      | CredentialRejectedEvent
      | CredentialStorageErrorEvent,
  ): void {
    if (!this.#isSourceCurrent(source)) return;
    try {
      this.#onEvent?.(event);
    } catch {
      this.#report(source, "callback");
    }
  }

  #emitCredentialOutcome(
    source: TransportSource,
    event: CredentialRejectedEvent | CredentialStorageErrorEvent,
  ): void {
    const deliverySource = this.#detachAndClear(source);
    if (deliverySource !== undefined) this.#emitCallbackEvent(deliverySource, event);
  }

  #beginLiveCredentialRejection(source: TransportSource): void {
    const liveGrant = this.#liveCredentialGrant;
    if (
      !this.#isSourceCurrent(source) ||
      liveGrant === undefined ||
      liveGrant.generation !== source.generation ||
      liveGrant.rejectionStarted
    ) return;
    liveGrant.rejectionStarted = true;
    const deliverySource = this.#detachAndClear(source);
    if (deliverySource === undefined) return;
    void this.#finishDetachedCredentialRejection(deliverySource, liveGrant);
  }

  async #finishDetachedCredentialRejection(
    deliverySource: TransportSource,
    liveGrant: LiveCredentialGrant,
  ): Promise<void> {
    let result: unknown;
    try {
      result = await this.#credentialProvider.reject(
        liveGrant.credentialVersion,
        liveGrant.grantToken,
      );
    } catch {
      if (this.#isSourceCurrent(deliverySource)) {
        this.#emitCallbackEvent(deliverySource, CREDENTIAL_STORAGE_ERROR_EVENT);
      }
      return;
    }
    if (!this.#isSourceCurrent(deliverySource) || result === "stale") return;
    this.#emitCallbackEvent(
      deliverySource,
      result === "required" ? CREDENTIAL_REJECTED_EVENT : CREDENTIAL_STORAGE_ERROR_EVENT,
    );
  }

  #sendUtteranceCancel(retireImmediately = false): boolean {
    const active = this.#active;
    const session = this.#session;
    if (active === undefined || session === undefined) return true;
    if (active.phase === "cancelling") return true;
    const committed = active.phase === "committing" && !active.commitRequested;
    const commitDeferred = active.phase === "committing" && active.commitRequested;
    if (!committed && !commitDeferred && active.phase !== "streaming") return true;
    const message = assertUtteranceCancel({
      type: "utterance.cancel",
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
      utteranceId: active.utteranceId,
      finalOriginalSampleOffset: active.queue.state.nextCapturedOffset,
    });
    if (!this.#sendControl(message)) return false;
    active.commitRequested = false;
    if (committed || (retireImmediately && commitDeferred)) {
      // `utterance.commit` is the normal terminal control for a turn, but it
      // either marks the relay's active turn committed or is still deferred
      // behind a legal audio pause. Relay accepts the follow-up
      // `utterance.cancel` in both cases. Retire the identity locally after
      // sending that terminal control so the next turn can start without
      // waiting for relay's delayed aborted event.
      this.#retireActiveAfterLocalCancel(active, session);
    } else {
      active.phase = "cancelling";
    }
    return true;
  }

  #isTerminalUtterance(active: ActiveUtterance): boolean {
    return (
      active.phase === "cancelling" ||
      (active.phase === "committing" && !active.commitRequested)
    );
  }

  #retireActiveAfterLocalCancel(active: ActiveUtterance, session: SessionIdentity): void {
    if (this.#active !== active) return;
    this.#rememberRetiredUtterance(
      utteranceIdentityKey(session.sessionId, session.sessionEpoch, active.utteranceId),
    );
    this.#active = undefined;
  }

  #abortActive(lockPhase = false): void {
    const source = this.#currentSource();
    const active = this.#active;
    if (active === undefined) {
      this.#report(source, "audio");
      return;
    }
    if (!this.#sendUtteranceCancel()) return;
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
    this.#liveCredentialGrant = undefined;
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
    this.#retiredUtterances.clear();
    this.#session = undefined;
    this.#targetLanguage = undefined;
    this.#negotiatedLimits = undefined;
  }

  #rememberRetiredUtterance(identity: string): boolean {
    if (this.#retiredUtterances.has(identity)) return false;
    this.#retiredUtterances.add(identity);
    if (this.#retiredUtterances.size > RETIRED_UTTERANCE_CAPACITY) {
      const oldest = this.#retiredUtterances.values().next().value as string | undefined;
      if (oldest !== undefined) this.#retiredUtterances.delete(oldest);
    }
    return true;
  }

  #matchesActiveUtterance(identity: string): boolean {
    const active = this.#active;
    const session = this.#session;
    return (
      active !== undefined &&
      session !== undefined &&
      identity === utteranceIdentityKey(
        session.sessionId,
        session.sessionEpoch,
        active.utteranceId,
      )
    );
  }

  #assertExpectedSessionReady(
    message: Extract<ServerControlMessage, { readonly type: "session.ready" }>,
  ): boolean {
    const session = this.#session;
    if (session !== undefined) {
      const sameIdentity =
        message.sessionId === session.sessionId &&
        message.sessionEpoch === session.sessionEpoch;
      if (
        sameIdentity &&
        this.#negotiatedLimits !== undefined &&
        limitsEqual(message.effectiveLimits, this.#negotiatedLimits)
      ) return false;
      if (sameIdentity) {
        throw new Error("Server session.ready does not match this session limits");
      }
      throw new Error("Server session.ready does not match this session identity");
    }

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
    return true;
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
