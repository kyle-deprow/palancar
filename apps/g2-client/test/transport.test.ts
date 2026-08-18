import {
  AUDIO_FRAME_HEADER_BYTES,
  DEFAULT_NEGOTIATED_LIMITS,
  decodeAudioFrame,
  type NegotiatedLimits,
} from "@palancar/contracts";
import { LANGUAGE_REGISTRY_VERSION } from "@palancar/language-registry";
import { describe, expect, it, vi } from "vitest";

import {
  RelayTransportError,
  RelayTransport,
  type RelayTransportCallbackEvent,
  type BrowserWebSocket,
  type BrowserWebSocketConstructor,
  type RelayTransportEvent,
} from "../src/transport/index.js";

const TICKET = `${"A".repeat(42)}E`;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const UTTERANCE_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_UTTERANCE_ID = "33333333-3333-4333-8333-333333333333";
const ERROR_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_READY_TIME = "2026-08-10T12:00:00.000Z";

function noncurrentRegistryVersion(current: string): string {
  return current === "1.0.0" ? "2.0.0" : "1.0.0";
}

const NONCURRENT_LANGUAGE_REGISTRY_VERSION = noncurrentRegistryVersion(
  LANGUAGE_REGISTRY_VERSION,
);
const RETRYABLE_CLOSE_CODES = [
  0,
  1001,
  1005,
  1006,
  1011,
  1012,
  1013,
  1014,
  1015,
  4503,
] as const;
const TERMINAL_CLOSE_CODES = [
  1000,
  1002,
  1003,
  1008,
  1009,
  4400,
  4401,
  4403,
  4406,
  4408,
  4409,
  4410,
  4429,
  4499,
] as const;

type SentMessage = string | Uint8Array<ArrayBuffer>;

class FakeWebSocket implements BrowserWebSocket {
  static readonly instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly protocols: readonly string[];
  readonly sent: SentMessage[] = [];
  readyState = 0;
  closeCalls = 0;
  sendError: Error | undefined;
  failNextSend: Error | undefined;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string, protocols: string | string[] = []) {
    this.url = url;
    this.protocols = typeof protocols === "string" ? [protocols] : [...protocols];
    FakeWebSocket.instances.push(this);
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    if (this.sendError !== undefined) throw this.sendError;
    const failNextSend = this.failNextSend;
    this.failNextSend = undefined;
    if (failNextSend !== undefined) throw failNextSend;
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCalls += 1;
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  message(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  error(): void {
    this.onerror?.({} as Event);
  }

  unexpectedClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

const fakeWebSocketConstructor = FakeWebSocket as unknown as BrowserWebSocketConstructor;

function ticketResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ticket: TICKET,
      wssOrigin: "wss://relay.example",
      wssPath: "/v1/stream",
      protocolVersion: 1,
      expiresAt: "2026-08-10T12:01:00.000Z",
    }),
  } as Response;
}

function ticketHttpResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  } as Response;
}

function readyMessage(
  limits: NegotiatedLimits = DEFAULT_NEGOTIATED_LIMITS,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "session.ready",
    result: "new",
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    targetLanguage: "es",
    languageRegistryVersion: LANGUAGE_REGISTRY_VERSION,
    gatePolicyVersion: "1.0.0",
    effectiveLimits: limits,
    serverTime: SESSION_READY_TIME,
    ...overrides,
  };
}

function audioAck(
  utteranceId = UTTERANCE_ID,
  highestContiguousExclusiveOffset = 0,
  flowState: "normal" | "pause" | "abort" = "normal",
): Record<string, unknown> {
  return {
    type: "audio.ack",
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    utteranceId,
    highestContiguousExclusiveOffset,
    flowState,
  };
}

function utteranceAborted(
  utteranceId = UTTERANCE_ID,
  category = "cancellation",
): Record<string, unknown> {
  return {
    type: "utterance.aborted",
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    utteranceId,
    category,
  };
}

function serverError(
  recoverable: boolean,
  scope = "session",
): Record<string, unknown> {
  return {
    type: "error",
    code: recoverable ? "provider_unavailable" : "authentication_failed",
    scope,
    recoverable,
    displaySafeMessage: "The request could not be completed.",
    errorId: ERROR_ID,
    time: SESSION_READY_TIME,
  };
}

async function openReady(transport: RelayTransport): Promise<FakeWebSocket> {
  const socket = await openSocket(transport);
  socket.message(JSON.stringify(readyMessage()));
  return socket;
}

async function openSocket(transport: RelayTransport): Promise<FakeWebSocket> {
  const start = transport.startSession("es");
  await flushMicrotasks();
  const socket = FakeWebSocket.instances[0];
  if (socket === undefined) throw new Error("WebSocket was not constructed");
  socket.open();
  await start;
  return socket;
}

function createTransport(
  onEvent?: (event: RelayTransportEvent) => void,
  onTransportError?: (error: RelayTransportError) => void,
  onCallbackEvent?: (event: RelayTransportCallbackEvent) => void,
): {
  readonly transport: RelayTransport;
  readonly requests: Array<{ readonly input: RequestInfo | URL; readonly init: RequestInit | undefined }>;
} {
  FakeWebSocket.instances.length = 0;
  const requests: Array<{ readonly input: RequestInfo | URL; readonly init: RequestInit | undefined }> = [];
  const transport = new RelayTransport({
    relayOrigin: "https://relay.example",
    fetch: async (input, init) => {
      requests.push({ input, init });
      return ticketResponse();
    },
    WebSocket: fakeWebSocketConstructor,
    ...(onEvent === undefined ? {} : { onServerEvent: onEvent }),
    ...(onCallbackEvent === undefined ? {} : { onEvent: onCallbackEvent }),
    ...(onTransportError === undefined ? {} : { onTransportError }),
  });
  return { transport, requests };
}

function sentControl(socket: FakeWebSocket, index: number): Record<string, unknown> {
  const value = socket.sent[index];
  if (typeof value !== "string") throw new Error("Expected a control message");
  return JSON.parse(value) as Record<string, unknown>;
}

function sentControlTypes(socket: FakeWebSocket): string[] {
  return socket.sent.flatMap((value) => {
    if (typeof value !== "string") return [];
    const message = JSON.parse(value) as { readonly type: string };
    return [message.type];
  });
}

function pcmCallback(value: number): Uint8Array {
  return Uint8Array.from({ length: 320 }, () => value);
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function expectClosedEmpty(transport: RelayTransport): void {
  expect(transport.snapshot).toEqual({
    connectionState: "closed",
    sessionReady: false,
  });
}

function expectRedactedError(
  error: RelayTransportError,
  expected: {
    readonly kind: RelayTransportError["kind"];
    readonly disposition: RelayTransportError["recoveryDisposition"];
    readonly message: string;
  },
  canary: string,
): void {
  expect(error).toMatchObject({
    name: "RelayTransportError",
    kind: expected.kind,
    recoveryDisposition: expected.disposition,
    message: expected.message,
  });
  expect("cause" in error).toBe(false);
  expect(Reflect.ownKeys(error)).not.toContain("cause");
  expect(Object.keys(error)).toEqual(["kind", "recoveryDisposition"]);
  expect(error.stack).not.toContain(canary);
  expect(JSON.stringify(error)).toBe(JSON.stringify({
    kind: expected.kind,
    recoveryDisposition: expected.disposition,
  }));
  expect(JSON.stringify(error)).not.toContain(canary);
}

describe("G2 relay transport", () => {
  it("posts a new ticket request and sends session.start with ticket subprotocols on open", async () => {
    const events: RelayTransportEvent[] = [];
    const { transport, requests } = createTransport((event) => events.push(event));

    const start = transport.startSession("es");
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("WebSocket was not constructed");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("https://relay.example/v1/session-tickets");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ protocolVersion: 1, intent: "new" }),
    });
    expect(socket.url).toBe("wss://relay.example/v1/stream");
    expect(socket.protocols).toEqual(["palancar.v1", `palancar.ticket.${TICKET}`]);

    socket.open();
    await start;

    expect(sentControl(socket, 0)).toEqual({
      type: "session.start",
      protocolVersion: 1,
      wearerLanguage: "en",
      targetLanguage: "es",
      languageRegistryVersion: LANGUAGE_REGISTRY_VERSION,
      gatePolicyVersion: "1.0.0",
      clientBuild: "g2-client-dev",
      requestedLimits: DEFAULT_NEGOTIATED_LIMITS,
    });
    expect(events).toHaveLength(0);
  });

  it("validates and emits session.ready while installing negotiated queue limits", async () => {
    const events: RelayTransportEvent[] = [];
    const { transport } = createTransport((event) => events.push(event));
    const start = transport.startSession("es");
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("WebSocket was not constructed");
    socket.open();
    await start;

    socket.message(JSON.stringify(readyMessage()));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session.ready",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      targetLanguage: "es",
      result: "new",
    });
    expect(transport.snapshot).toMatchObject({
      connectionState: "open",
      sessionReady: true,
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      targetLanguage: "es",
      negotiatedLimits: DEFAULT_NEGOTIATED_LIMITS,
    });
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(transport.snapshot)).toBe(true);
  });

  it("classifies pre-ready ticket failures for retry without emitting transport.lost", async () => {
    const cases: Array<{
      readonly name: string;
      readonly fetch: typeof globalThis.fetch;
      readonly disposition: "retry" | "stop";
    }> = [
      {
        name: "network",
        fetch: async () => { throw new Error("offline"); },
        disposition: "retry",
      },
      ...[0, 409, 500, 502, 503, 599].map((status) => ({
        name: `HTTP ${status}`,
        fetch: async () => ticketHttpResponse(status),
        disposition: "retry" as const,
      })),
      ...[400, 401, 403, 429].map((status) => ({
        name: `HTTP ${status}`,
        fetch: async () => ticketHttpResponse(status),
        disposition: "stop" as const,
      })),
    ];

    for (const testCase of cases) {
      FakeWebSocket.instances.length = 0;
      const errors: RelayTransportError[] = [];
      const events: RelayTransportCallbackEvent[] = [];
      const transport = new RelayTransport({
        relayOrigin: "https://relay.example",
        fetch: testCase.fetch,
        WebSocket: fakeWebSocketConstructor,
        onEvent: (event) => events.push(event),
        onTransportError: (error) => errors.push(error),
      });

      await transport.startSession("es");

      expect(errors, testCase.name).toHaveLength(1);
      expect(errors[0]?.kind, testCase.name).toBe("ticket");
      expect(errors[0]?.recoveryDisposition, testCase.name).toBe(testCase.disposition);
      expect(events.filter((event) => event.type === "transport.lost"), testCase.name)
        .toHaveLength(0);
      expectClosedEmpty(transport);
    }
  });

  it("normalizes every ticket response.json failure exactly once as stop", async () => {
    const canary = "RAW_JSON_CANARY";
    const jsonFailures: Array<() => unknown> = [
      () => { throw new Error(canary); },
      () => Promise.reject(new Error(canary)),
      () => Promise.reject(canary),
    ];

    for (const json of jsonFailures) {
      FakeWebSocket.instances.length = 0;
      const errors: RelayTransportError[] = [];
      const transport = new RelayTransport({
        relayOrigin: "https://relay.example",
        fetch: async () => ({ ok: true, status: 200, json } as unknown as Response),
        WebSocket: fakeWebSocketConstructor,
        onTransportError: (error) => errors.push(error),
      });

      await transport.startSession("es");

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ kind: "ticket", recoveryDisposition: "stop" });
      expectClosedEmpty(transport);
      expect(FakeWebSocket.instances).toHaveLength(0);
    }
  });

  it("exposes fixed redacted transport errors without cause or raw failures", async () => {
    const canary = "RAW_FAILURE_CANARY";
    const errors: RelayTransportError[] = [];
    const transport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => { throw new Error(canary); },
      WebSocket: fakeWebSocketConstructor,
      onTransportError: (error) => errors.push(error),
    });

    await transport.startSession("es");

    expect(errors).toHaveLength(1);
    const error = errors[0];
    if (error === undefined) throw new Error("Transport error missing");
    expectRedactedError(error, {
      kind: "ticket",
      disposition: "retry",
      message: "Relay session ticket request failed",
    }, canary);

    const constructed = new RelayTransportError("protocol", "stop");
    expectRedactedError(constructed, {
      kind: "protocol",
      disposition: "stop",
      message: "Relay protocol failed",
    }, canary);
  });

  it("rejects unsafe ready timeouts with a fixed configuration error", () => {
    for (const readyTimeoutMs of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2_147_483_648,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => new RelayTransport({
        relayOrigin: "https://relay.example",
        fetch: async () => ticketResponse(),
        WebSocket: fakeWebSocketConstructor,
        readyTimeoutMs,
      }), String(readyTimeoutMs)).toThrowError(RelayTransportError);
    }

    expect(() => new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      readyTimeoutMs: 2_147_483_647,
    })).not.toThrow();
  });

  it("classifies WebSocket construction and ready timeout as pre-ready retry", async () => {
    const constructionErrors: RelayTransportError[] = [];
    const throwingWebSocketConstructor = function (): never {
      throw new Error("constructor failed");
    } as unknown as BrowserWebSocketConstructor;
    const constructionTransport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: throwingWebSocketConstructor,
      onTransportError: (error) => constructionErrors.push(error),
    });

    await constructionTransport.startSession("es");
    expect(constructionErrors).toHaveLength(1);
    expect(constructionErrors[0]?.kind).toBe("websocket");
    expect(constructionErrors[0]?.recoveryDisposition).toBe("retry");

    vi.useFakeTimers();
    try {
      FakeWebSocket.instances.length = 0;
      const timeoutErrors: RelayTransportError[] = [];
      const timeoutEvents: RelayTransportCallbackEvent[] = [];
      const transport = new RelayTransport({
        relayOrigin: "https://relay.example",
        fetch: async () => ticketResponse(),
        WebSocket: fakeWebSocketConstructor,
        readyTimeoutMs: 25,
        onEvent: (event) => timeoutEvents.push(event),
        onTransportError: (error) => timeoutErrors.push(error),
      });
      const start = transport.startSession("es");
      await flushMicrotasks();
      const socket = FakeWebSocket.instances[0];
      if (socket === undefined) throw new Error("WebSocket was not constructed");
      socket.open();
      await start;
      vi.advanceTimersByTime(25);

      expect(timeoutErrors).toHaveLength(1);
      expect(timeoutErrors[0]?.kind).toBe("websocket");
      expect(timeoutErrors[0]?.recoveryDisposition).toBe("retry");
      expect(timeoutEvents.filter((event) => event.type === "transport.lost")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns ready timer handles per generation and leaves zero timers after lifecycle exits", async () => {
    vi.useFakeTimers();
    try {
      FakeWebSocket.instances.length = 0;
      const errors: RelayTransportError[] = [];
      const transport = new RelayTransport({
        relayOrigin: "https://relay.example",
        fetch: async () => ticketResponse(),
        WebSocket: fakeWebSocketConstructor,
        readyTimeoutMs: 30,
        onTransportError: (error) => errors.push(error),
      });

      const firstStart = transport.startSession("es");
      await flushMicrotasks();
      const firstSocket = FakeWebSocket.instances[0];
      if (firstSocket === undefined) throw new Error("First WebSocket missing");
      firstSocket.open();
      await firstStart;
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(10);
      const replacementStart = transport.startSession("tr");
      await flushMicrotasks();
      const replacementSocket = FakeWebSocket.instances[1];
      if (replacementSocket === undefined) throw new Error("Replacement WebSocket missing");
      replacementSocket.open();
      await replacementStart;
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(20);
      expect(errors).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(10);
      expect(errors).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      expectClosedEmpty(transport);

      const readyStart = transport.startSession("es");
      await flushMicrotasks();
      const readySocket = FakeWebSocket.instances[2];
      if (readySocket === undefined) throw new Error("Ready WebSocket missing");
      readySocket.open();
      await readyStart;
      expect(vi.getTimerCount()).toBe(1);
      readySocket.message(JSON.stringify(readyMessage()));
      expect(vi.getTimerCount()).toBe(0);
      transport.endSession();
      expect(vi.getTimerCount()).toBe(0);
      expectClosedEmpty(transport);

      const rejectedStart = transport.startSession("es");
      await flushMicrotasks();
      const rejectedSocket = FakeWebSocket.instances[3];
      if (rejectedSocket === undefined) throw new Error("Rejected WebSocket missing");
      rejectedSocket.open();
      await rejectedStart;
      expect(vi.getTimerCount()).toBe(1);
      rejectedSocket.message(JSON.stringify({
        type: "session.rejected",
        code: "authentication_failed",
        displaySafeMessage: "The session could not be started.",
      }));
      expect(vi.getTimerCount()).toBe(0);
      expectClosedEmpty(transport);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports pre-ready WebSocket errors and retryable closes through onTransportError", async () => {
    for (const failure of ["error", ...RETRYABLE_CLOSE_CODES] as const) {
      const errors: RelayTransportError[] = [];
      const events: RelayTransportCallbackEvent[] = [];
      const { transport } = createTransport(
        undefined,
        (error) => errors.push(error),
        (event) => events.push(event),
      );
      const start = transport.startSession("es");
      await flushMicrotasks();
      const socket = FakeWebSocket.instances[0];
      if (socket === undefined) throw new Error("WebSocket was not constructed");
      socket.open();
      await start;

      if (failure === "error") {
        socket.error();
        socket.unexpectedClose(1013);
      } else {
        socket.unexpectedClose(failure);
        socket.error();
      }

      expect(errors, String(failure)).toHaveLength(1);
      expect(errors[0]?.kind, String(failure)).toBe("websocket");
      expect(errors[0]?.recoveryDisposition, String(failure)).toBe("retry");
      expect(events.filter((event) => event.type === "transport.lost"), String(failure))
        .toHaveLength(0);
      expectClosedEmpty(transport);
    }
  });

  it("emits one identity-only loss for every retryable post-ready socket failure", async () => {
    for (const failure of ["error", ...RETRYABLE_CLOSE_CODES] as const) {
      const events: RelayTransportCallbackEvent[] = [];
      const serverEvents: RelayTransportEvent[] = [];
      const errors: RelayTransportError[] = [];
      const { transport } = createTransport(
        (event) => serverEvents.push(event),
        (error) => errors.push(error),
        (event) => events.push(event),
      );
      const socket = await openReady(transport);
      transport.startUtterance(UTTERANCE_ID);
      transport.pushPcm(Uint8Array.of(1, 2));

      if (failure === "error") {
        socket.error();
        socket.unexpectedClose(1013);
      } else {
        socket.unexpectedClose(failure);
        socket.error();
      }

      const lostEvents = events.filter((event) => event.type === "transport.lost");
      expect(lostEvents, String(failure)).toHaveLength(1);
      expect(lostEvents[0], String(failure)).toEqual({
        type: "transport.lost",
        sessionId: SESSION_ID,
        sessionEpoch: 1,
      });
      expect(Object.isFrozen(lostEvents[0]), String(failure)).toBe(true);
      expect(serverEvents, String(failure)).toHaveLength(1);
      expect(errors, String(failure)).toHaveLength(0);
      expect(transport.snapshot, String(failure)).toEqual({
        connectionState: "closed",
        sessionReady: false,
      });
    }
  });

  it("routes every terminal relay close code to stop after synchronous cleanup", async () => {
    for (const code of TERMINAL_CLOSE_CODES) {
      const events: RelayTransportCallbackEvent[] = [];
      const errors: RelayTransportError[] = [];
      let snapshotInCallback: RelayTransport["snapshot"] | undefined;
      const created = createTransport(
        undefined,
        (error) => {
          errors.push(error);
          snapshotInCallback = created.transport.snapshot;
        },
        (event) => events.push(event),
      );
      const { transport } = created;
      const socket = await openReady(transport);
      transport.startUtterance(UTTERANCE_ID);
      transport.pushPcm(Uint8Array.of(1, 2));
      socket.unexpectedClose(code);
      socket.error();

      expect(events.filter((event) => event.type === "transport.lost"), String(code))
        .toHaveLength(0);
      expect(errors, String(code)).toHaveLength(1);
      expect(errors[0]?.kind, String(code)).toBe("websocket");
      expect(errors[0]?.recoveryDisposition, String(code)).toBe("stop");
      expect(snapshotInCallback, String(code)).toEqual({
        connectionState: "closed",
        sessionReady: false,
      });
      expectClosedEmpty(transport);
    }
  });

  it("sends utterance audio in offset order, applies audio.ack, and commits the final offset", async () => {
    const { transport } = createTransport();
    const start = transport.startSession("es");
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("WebSocket was not constructed");
    socket.open();
    await start;
    socket.message(JSON.stringify(readyMessage()));

    transport.startUtterance(UTTERANCE_ID);
    const source = Uint8Array.from({ length: 1_920 }, (_, index) => index % 256);
    transport.pushPcm(source);
    source[0] = 99;

    expect(sentControl(socket, 1)).toEqual({
      type: "utterance.start",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
    });
    const firstFrame = socket.sent[2];
    if (typeof firstFrame === "string" || firstFrame === undefined) {
      throw new Error("Expected a binary audio frame");
    }
    expect(decodeAudioFrame(firstFrame)).toMatchObject({
      utteranceId: UTTERANCE_ID,
      sequence: 0,
      offset: 0,
      payload: Uint8Array.from({ length: 1_920 }, (_, index) => index % 256),
    });

    socket.message(JSON.stringify({
      type: "audio.ack",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      highestContiguousExclusiveOffset: 960,
      flowState: "normal",
    }));
    expect(transport.snapshot.queue?.highestAcknowledgedOffset).toBe(960);
    expect(transport.snapshot.queue?.inFlightSamples).toBe(0);

    transport.commitUtterance();
    expect(sentControl(socket, 3)).toEqual({
      type: "utterance.commit",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      finalOriginalSampleOffset: 960,
    });
  });

  it("coalesces 10ms PCM callbacks until 60ms, then sends one audio frame", async () => {
    const { transport } = createTransport();
    const socket = await openReady(transport);

    transport.startUtterance(UTTERANCE_ID);
    const callbacks = Array.from({ length: 6 }, (_, index) => pcmCallback(index + 1));
    for (const callback of callbacks.slice(0, 5)) {
      transport.pushPcm(callback);
      expect(socket.sent).toHaveLength(2);
    }

    transport.pushPcm(callbacks[5]!);
    expect(socket.sent).toHaveLength(3);
    const frame = socket.sent[2];
    if (typeof frame === "string" || frame === undefined) {
      throw new Error("Expected a binary audio frame");
    }
    expect(decodeAudioFrame(frame).payload).toEqual(
      Uint8Array.from(callbacks.flatMap((callback) => [...callback])),
    );
  });

  it("flushes a buffered tail before commit with the exact final offset and original bytes", async () => {
    const { transport } = createTransport();
    const socket = await openReady(transport);

    transport.startUtterance(UTTERANCE_ID);
    const source = Uint8Array.of(1, 2, 3, 4);
    transport.pushPcm(source);
    source[0] = 99;
    expect(socket.sent).toHaveLength(2);

    transport.commitUtterance();

    const frame = socket.sent[2];
    if (typeof frame === "string" || frame === undefined) {
      throw new Error("Expected a binary audio frame");
    }
    expect(decodeAudioFrame(frame).payload).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(sentControl(socket, 3)).toEqual({
      type: "utterance.commit",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      finalOriginalSampleOffset: 2,
    });

    transport.commitUtterance();
    transport.pushPcm(Uint8Array.of(5, 6));
    expect(socket.sent).toHaveLength(4);
  });

  it("sends an even prefix before cancelling an incomplete sample and never commits", async () => {
    const errors: RelayTransportError[] = [];
    const { transport } = createTransport(undefined, (error) => errors.push(error));
    const socket = await openReady(transport);

    transport.startUtterance(UTTERANCE_ID);
    transport.pushPcm(Uint8Array.of(1, 2, 3));
    transport.commitUtterance();

    const frame = socket.sent[2];
    if (typeof frame === "string" || frame === undefined) {
      throw new Error("Expected an even-prefix audio frame");
    }
    expect(decodeAudioFrame(frame).payload).toEqual(Uint8Array.of(1, 2));
    expect(sentControl(socket, 3)).toMatchObject({
      type: "utterance.cancel",
      utteranceId: UTTERANCE_ID,
      finalOriginalSampleOffset: 1,
    });
    expect(sentControlTypes(socket)).not.toContain("utterance.commit");
    expect(errors.at(-1)?.kind).toBe("audio");

    const sentAfterAbort = socket.sent.length;
    transport.commitUtterance();
    expect(socket.sent).toHaveLength(sentAfterAbort);
  });

  it("sends the queue-owned frame bytes without adding a transport copy", async () => {
    const { transport } = createTransport();
    const socket = await openReady(transport);
    const payload = Uint8Array.of(1, 2);
    const frameByteLength = AUDIO_FRAME_HEADER_BYTES + payload.length;
    const frameSizedSlices: Uint8Array[] = [];
    const originalSlice = Uint8Array.prototype.slice;
    const sliceSpy = vi.spyOn(Uint8Array.prototype, "slice").mockImplementation(
      function (this: Uint8Array<ArrayBuffer>, start?: number, end?: number): Uint8Array<ArrayBuffer> {
        const result = originalSlice.call(this, start, end);
        if (result.length === frameByteLength) frameSizedSlices.push(result);
        return result;
      },
    );

    try {
      transport.startUtterance(UTTERANCE_ID);
      transport.pushPcm(payload);
      transport.commitUtterance();

      const frame = socket.sent[2];
      if (typeof frame === "string" || frame === undefined) {
        throw new Error("Expected a binary audio frame");
      }
      expect(frameSizedSlices).toHaveLength(1);
      expect(frame).toBe(frameSizedSlices[0]);
    } finally {
      sliceSpy.mockRestore();
    }
  });

  it("turns a persistent audio send failure into one loss with no trailing error", async () => {
    const errors: RelayTransportError[] = [];
    const events: RelayTransportCallbackEvent[] = [];
    const { transport } = createTransport(
      undefined,
      (error) => errors.push(error),
      (event) => events.push(event),
    );
    const socket = await openReady(transport);

    transport.startUtterance(UTTERANCE_ID);
    socket.sendError = new Error("PERSISTENT_AUDIO_SEND_CANARY");
    transport.pushPcm(Uint8Array.from({ length: 1_920 }, (_, index) => index % 256));
    socket.error();
    socket.unexpectedClose(4503);

    expect(events.filter((event) => event.type === "transport.lost")).toEqual([{
      type: "transport.lost",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
    }]);
    expect(errors).toHaveLength(0);
    expectClosedEmpty(transport);
    expect(socket.sent).toHaveLength(2);
  });

  it("reports malformed ticket and server control data, then closes safely", async () => {
    const ticketErrors: RelayTransportError[] = [];
    const malformedTicketTransport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ invalid: true }) } as Response),
      WebSocket: fakeWebSocketConstructor,
      onTransportError: (error) => ticketErrors.push(error),
    });
    await malformedTicketTransport.startSession("es");
    expect(ticketErrors).toHaveLength(1);
    expect(ticketErrors[0]?.kind).toBe("ticket");
    expect(ticketErrors[0]?.recoveryDisposition).toBe("stop");
    expect(malformedTicketTransport.snapshot.connectionState).toBe("closed");

    const protocolErrors: RelayTransportError[] = [];
    let protocolSnapshot: RelayTransport["snapshot"] | undefined;
    const created = createTransport(undefined, (error) => {
      protocolErrors.push(error);
      protocolSnapshot = created.transport.snapshot;
    });
    const { transport } = created;
    const start = transport.startSession("es");
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("WebSocket was not constructed");
    socket.open();
    await start;
    socket.message(JSON.stringify({ type: "session.ready", malformed: true }));

    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]?.kind).toBe("protocol");
    expect(protocolErrors[0]?.recoveryDisposition).toBe("stop");
    expect(socket.readyState).toBe(3);
    expect(protocolSnapshot).toEqual({ connectionState: "closed", sessionReady: false });
    expectClosedEmpty(transport);
  });

  it("does not send PCM before ready, without an utterance, or after commit", async () => {
    const { transport } = createTransport();
    const start = transport.startSession("es");
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("WebSocket was not constructed");
    socket.open();
    await start;

    transport.pushPcm(Uint8Array.of(1, 2));
    expect(socket.sent).toHaveLength(1);

    socket.message(JSON.stringify(readyMessage()));
    transport.pushPcm(Uint8Array.of(3, 4));
    expect(socket.sent).toHaveLength(1);

    transport.startUtterance(UTTERANCE_ID);
    transport.commitUtterance();
    const sentAfterCommit = socket.sent.length;
    transport.pushPcm(Uint8Array.of(5, 6));
    expect(socket.sent).toHaveLength(sentAfterCommit);
  });

  it("retains a committed queue for delayed ACKs until the server retires the utterance", async () => {
    const errors: RelayTransportError[] = [];
    const { transport } = createTransport(undefined, (error) => errors.push(error));
    const socket = await openReady(transport);

    transport.startUtterance(UTTERANCE_ID);
    transport.pushPcm(Uint8Array.of(1, 2, 3, 4));
    transport.commitUtterance();

    socket.message(JSON.stringify(audioAck(UTTERANCE_ID, 2)));
    expect(errors).toHaveLength(0);
    expect(transport.snapshot.activeUtteranceId).toBe(UTTERANCE_ID);

    transport.startUtterance(SECOND_UTTERANCE_ID);
    expect(errors.at(-1)?.kind).toBe("audio");

    socket.message(JSON.stringify(utteranceAborted()));
    expect(transport.snapshot.activeUtteranceId).toBeUndefined();
    transport.startUtterance(SECOND_UTTERANCE_ID);
    expect(sentControl(socket, 4)).toMatchObject({
      type: "utterance.start",
      utteranceId: SECOND_UTTERANCE_ID,
    });
  });

  it("retains a cancelled queue for delayed ACKs and clears it before utterance.aborted callbacks", async () => {
    const errors: RelayTransportError[] = [];
    let activeInCallback: string | undefined;
    const created = createTransport((event) => {
      if (event.type === "utterance.aborted") {
        activeInCallback = created.transport.snapshot.activeUtteranceId;
        created.transport.startUtterance(SECOND_UTTERANCE_ID);
      }
    }, (error) => errors.push(error));
    const transport = created.transport;
    const socket = await openReady(transport);

    transport.startUtterance(UTTERANCE_ID);
    transport.pushPcm(Uint8Array.from({ length: 1_920 }, (_, index) => index % 256));
    transport.cancelUtterance();
    socket.message(JSON.stringify(audioAck(UTTERANCE_ID, 960)));
    expect(errors).toHaveLength(0);
    expect(transport.snapshot.activeUtteranceId).toBe(UTTERANCE_ID);

    socket.message(JSON.stringify(utteranceAborted()));
    expect(activeInCallback).toBeUndefined();
    expect(sentControl(socket, 4)).toMatchObject({
      type: "utterance.start",
      utteranceId: SECOND_UTTERANCE_ID,
    });
  });

  it("preserves frame offsets across multiple frames and rejects interior ACK offsets", async () => {
    const errors: RelayTransportError[] = [];
    const { transport } = createTransport(undefined, (error) => errors.push(error));
    const socket = await openSocket(transport);
    socket.message(JSON.stringify(readyMessage({
      ...DEFAULT_NEGOTIATED_LIMITS,
      maxAudioPayloadBytes: 4,
    })));

    transport.startUtterance(UTTERANCE_ID);
    transport.pushPcm(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12));
    const frames = socket.sent.slice(2).map((value) => {
      if (typeof value === "string") throw new Error("Expected binary audio frame");
      return decodeAudioFrame(value);
    });
    expect(frames.map((frame) => ({ sequence: frame.sequence, offset: frame.offset }))).toEqual([
      { sequence: 0, offset: 0 },
      { sequence: 1, offset: 2 },
      { sequence: 2, offset: 4 },
    ]);

    socket.message(JSON.stringify(audioAck(UTTERANCE_ID, 2)));
    socket.message(JSON.stringify(audioAck(UTTERANCE_ID, 6)));
    expect(transport.snapshot.queue?.highestAcknowledgedOffset).toBe(6);
    expect(transport.snapshot.queue?.inFlightSamples).toBe(0);

    socket.message(JSON.stringify(audioAck(UTTERANCE_ID, 7)));
    expect(errors.at(-1)?.kind).toBe("audio");
    expect(sentControl(socket, socket.sent.length - 1)).toMatchObject({
      type: "utterance.cancel",
      utteranceId: UTTERANCE_ID,
    });
  });

  it("handles pause and flow abort ACKs without emitting fatal events", async () => {
    const errors: RelayTransportError[] = [];
    const events: RelayTransportCallbackEvent[] = [];
    FakeWebSocket.instances.length = 0;
    const transport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onEvent: (event) => events.push(event),
      onTransportError: (error) => errors.push(error),
    });
    const socket = await openReady(transport);
    transport.startUtterance(UTTERANCE_ID);
    socket.message(JSON.stringify(audioAck(UTTERANCE_ID, 0, "pause")));
    const sentWhilePaused = socket.sent.length;
    transport.pushPcm(Uint8Array.from({ length: 1_920 }, (_, index) => index % 256));
    expect(socket.sent).toHaveLength(sentWhilePaused + 1);
    expect(sentControl(socket, socket.sent.length - 1).type).toBe("utterance.cancel");

    FakeWebSocket.instances.length = 0;
    const second = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onEvent: (event) => events.push(event),
      onTransportError: (error) => errors.push(error),
    });
    const secondSocket = await openReady(second);
    second.startUtterance(UTTERANCE_ID);
    second.pushPcm(Uint8Array.from({ length: 1_920 }, (_, index) => index % 256));
    secondSocket.message(JSON.stringify(audioAck(UTTERANCE_ID, 960, "abort")));
    expect(second.snapshot.activeUtteranceId).toBeUndefined();
    expect(errors.some((error) => error.kind === "audio")).toBe(true);
    expect(events.some((event) => event.type === "fatal")).toBe(false);
  });

  it("follows the relay recoverable error to 4503 flow with exactly one fresh loss", async () => {
    const errors: RelayTransportError[] = [];
    const events: RelayTransportCallbackEvent[] = [];
    FakeWebSocket.instances.length = 0;
    const transport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onEvent: (event) => events.push(event),
      onTransportError: (error) => errors.push(error),
    });
    const socket = await openReady(transport);
    transport.startUtterance(UTTERANCE_ID);
    transport.pushPcm(Uint8Array.of(1, 2));
    socket.message(JSON.stringify(utteranceAborted()));
    socket.message(JSON.stringify(serverError(true)));
    expect(errors).toHaveLength(0);
    expect(events.some((event) => event.type === "fatal")).toBe(false);
    expect(transport.snapshot.sessionReady).toBe(true);

    socket.unexpectedClose(4503);
    socket.error();

    expect(events.filter((event) => event.type === "transport.lost")).toEqual([{
      type: "transport.lost",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
    }]);
    expect(errors).toHaveLength(0);
    expectClosedEmpty(transport);
  });

  it("clears all retained state before a terminal server error emits fatal", async () => {
    const errors: RelayTransportError[] = [];
    const events: RelayTransportCallbackEvent[] = [];
    let snapshotInFatal: RelayTransport["snapshot"] | undefined;
    FakeWebSocket.instances.length = 0;
    const transport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "fatal") {
          snapshotInFatal = transport.snapshot;
        }
      },
      onTransportError: (error) => errors.push(error),
    });
    const socket = await openReady(transport);

    transport.startUtterance(UTTERANCE_ID);
    transport.pushPcm(Uint8Array.of(1, 2));
    transport.commitUtterance();
    socket.message(JSON.stringify(serverError(false, "server")));
    socket.error();
    socket.unexpectedClose(1011);

    expect(events.filter((event) => event.type === "fatal")).toHaveLength(1);
    expect(events.filter((event) => event.type === "transport.lost")).toHaveLength(0);
    expect(snapshotInFatal).toEqual({
      connectionState: "closed",
      sessionReady: false,
    });
    expect(socket.readyState).toBe(3);
    expect(socket.closeCalls).toBe(1);
    expect(errors).toHaveLength(0);
    expectClosedEmpty(transport);
  });

  it("turns post-ready control send failures into one fresh transport loss", async () => {
    const errors: RelayTransportError[] = [];
    const events: RelayTransportCallbackEvent[] = [];
    const { transport } = createTransport(
      undefined,
      (error) => errors.push(error),
      (event) => events.push(event),
    );
    const socket = await openReady(transport);
    transport.startUtterance(UTTERANCE_ID);
    socket.sendError = new Error("send failed");
    transport.commitUtterance();
    expect(errors).toHaveLength(0);
    expect(events.filter((event) => event.type === "transport.lost")).toEqual([{
      type: "transport.lost",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
    }]);
    expect(transport.snapshot).toEqual({
      connectionState: "closed",
      sessionReady: false,
    });

    FakeWebSocket.instances.length = 0;
    const endErrors: RelayTransportError[] = [];
    const endEvents: RelayTransportCallbackEvent[] = [];
    const endTransport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onEvent: (event) => endEvents.push(event),
      onTransportError: (error) => endErrors.push(error),
    });
    const endSocket = await openReady(endTransport);
    endSocket.sendError = new Error("end failed");
    endTransport.endSession();
    expect(endErrors).toHaveLength(1);
    expect(endErrors[0]?.recoveryDisposition).toBe("retry");
    expect(endEvents.filter((event) => event.type === "transport.lost")).toHaveLength(0);
    const endError = endErrors[0];
    if (endError === undefined) throw new Error("End transport error missing");
    expectRedactedError(endError, {
      kind: "websocket",
      disposition: "retry",
      message: "Relay WebSocket transport failed",
    }, "end failed");
    expect(endSocket.closeCalls).toBe(1);
    expectClosedEmpty(endTransport);
  });

  it("does not let a stale ticket failure close a newer session generation", async () => {
    FakeWebSocket.instances.length = 0;
    let rejectFirst!: (error: unknown) => void;
    let requestCount = 0;
    const errors: RelayTransportError[] = [];
    const transport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Promise<Response>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        return ticketResponse();
      },
      WebSocket: fakeWebSocketConstructor,
      onTransportError: (error) => errors.push(error),
    });

    const first = transport.startSession("es");
    await flushMicrotasks();
    const second = transport.startSession("es");
    await flushMicrotasks();
    rejectFirst(new Error("stale ticket failure"));
    await first;
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("WebSocket was not constructed");
    socket.open();
    await second;
    expect(errors).toHaveLength(0);
    expect(transport.snapshot.connectionState).toBe("open");
  });

  it("does not let a stale socket loss clear or report a replacement generation", async () => {
    FakeWebSocket.instances.length = 0;
    const errors: RelayTransportError[] = [];
    const events: RelayTransportCallbackEvent[] = [];
    const transport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onEvent: (event) => events.push(event),
      onTransportError: (error) => errors.push(error),
    });

    const firstSocket = await openReady(transport);
    const replacementStart = transport.startSession("tr");
    await flushMicrotasks();
    const secondSocket = FakeWebSocket.instances[1];
    if (secondSocket === undefined) throw new Error("Replacement WebSocket was not constructed");

    firstSocket.error();
    firstSocket.unexpectedClose(1013);
    secondSocket.open();
    await replacementStart;
    secondSocket.message(JSON.stringify(readyMessage(DEFAULT_NEGOTIATED_LIMITS, {
      targetLanguage: "tr",
    })));

    expect(errors).toHaveLength(0);
    expect(events.filter((event) => event.type === "transport.lost")).toHaveLength(0);
    expect(transport.snapshot).toMatchObject({
      connectionState: "open",
      sessionReady: true,
      targetLanguage: "tr",
    });
  });

  it("drops displaced event delivery when the first callback replaces its source", async () => {
    FakeWebSocket.instances.length = 0;
    const serverEvents: RelayTransportEvent[] = [];
    const callbackEvents: RelayTransportCallbackEvent[] = [];
    const errors: RelayTransportError[] = [];
    const transport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onServerEvent: (event) => {
        serverEvents.push(event);
        if (event.type === "utterance.aborted") {
          void transport.startSession("tr");
        }
      },
      onEvent: (event) => callbackEvents.push(event),
      onTransportError: (error) => errors.push(error),
    });
    const firstSocket = await openReady(transport);
    transport.startUtterance(UTTERANCE_ID);

    firstSocket.message(JSON.stringify(utteranceAborted()));
    firstSocket.message(JSON.stringify(readyMessage()));
    await flushMicrotasks();

    expect(serverEvents.filter((event) => event.type === "utterance.aborted"))
      .toHaveLength(1);
    expect(callbackEvents.filter((event) => event.type === "utterance.aborted"))
      .toHaveLength(0);
    expect(errors).toHaveLength(0);
    const replacementSocket = FakeWebSocket.instances[1];
    if (replacementSocket === undefined) throw new Error("Replacement WebSocket missing");
    replacementSocket.open();
    replacementSocket.message(JSON.stringify(readyMessage(DEFAULT_NEGOTIATED_LIMITS, {
      targetLanguage: "tr",
    })));
    expect(transport.snapshot).toMatchObject({
      connectionState: "open",
      sessionReady: true,
      targetLanguage: "tr",
    });
  });

  it("does not let terminal error callbacks clear a reentrant replacement", async () => {
    FakeWebSocket.instances.length = 0;
    const errors: RelayTransportError[] = [];
    const transport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onTransportError: (error) => {
        errors.push(error);
        void transport.startSession("tr");
      },
    });
    const firstSocket = await openReady(transport);

    firstSocket.unexpectedClose(1000);
    firstSocket.error();
    await flushMicrotasks();

    expect(errors).toHaveLength(1);
    const replacementSocket = FakeWebSocket.instances[1];
    if (replacementSocket === undefined) throw new Error("Replacement WebSocket missing");
    replacementSocket.open();
    replacementSocket.message(JSON.stringify(readyMessage(DEFAULT_NEGOTIATED_LIMITS, {
      targetLanguage: "tr",
    })));
    expect(transport.snapshot).toMatchObject({
      connectionState: "open",
      sessionReady: true,
      targetLanguage: "tr",
    });
  });

  it("proactively detaches and closes after endSession and session.rejected", async () => {
    const errors: RelayTransportError[] = [];
    const events: RelayTransportCallbackEvent[] = [];
    const { transport } = createTransport(
      undefined,
      (error) => errors.push(error),
      (event) => events.push(event),
    );
    const socket = await openReady(transport);
    transport.endSession();
    expect(sentControl(socket, 1)).toMatchObject({ type: "session.end" });
    expect(socket.readyState).toBe(3);
    expect(socket.closeCalls).toBe(1);
    expect(errors).toHaveLength(0);
    expect(events.filter((event) => event.type === "transport.lost")).toHaveLength(0);
    expectClosedEmpty(transport);

    FakeWebSocket.instances.length = 0;
    const rejectedErrors: RelayTransportError[] = [];
    const rejectedEvents: RelayTransportCallbackEvent[] = [];
    let rejectedSnapshot: RelayTransport["snapshot"] | undefined;
    const rejected = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onEvent: (event) => {
        rejectedEvents.push(event);
        if (event.type === "session.rejected") {
          rejectedSnapshot = rejected.snapshot;
        }
      },
      onTransportError: (error) => rejectedErrors.push(error),
    });
    const rejectedSocket = await openSocket(rejected);
    rejectedSocket.message(JSON.stringify({
      type: "session.rejected",
      code: "authentication_failed",
      displaySafeMessage: "The session could not be started.",
    }));
    expect(rejectedSocket.readyState).toBe(3);
    expect(rejectedSocket.closeCalls).toBe(1);
    expect(rejectedErrors).toHaveLength(0);
    expect(rejectedEvents.filter((event) => event.type === "transport.lost")).toHaveLength(0);
    expect(rejectedEvents.filter((event) => event.type === "session.rejected"))
      .toHaveLength(1);
    expect(rejectedSnapshot).toEqual({ connectionState: "closed", sessionReady: false });
    expectClosedEmpty(rejected);
  });

  it("isolates callbacks and defensively clones object server messages", async () => {
    const canary = "RAW_CALLBACK_CANARY";
    const errors: RelayTransportError[] = [];
    const events: RelayTransportCallbackEvent[] = [];
    FakeWebSocket.instances.length = 0;
    const transport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onServerEvent: () => {
        throw new Error(canary);
      },
      onEvent: (event) => events.push(event),
      onTransportError: (error) => errors.push(error),
    });
    const socket = await openSocket(transport);
    const original = readyMessage({ ...DEFAULT_NEGOTIATED_LIMITS });
    socket.message(original);
    const event = events.find((candidate) => candidate.type === "session.ready");
    if (event === undefined || event.type !== "session.ready") throw new Error("Ready event missing");
    (original.effectiveLimits as Record<string, unknown>).maxAudioPayloadBytes = 2;
    expect(event.effectiveLimits.maxAudioPayloadBytes).toBe(DEFAULT_NEGOTIATED_LIMITS.maxAudioPayloadBytes);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.effectiveLimits)).toBe(true);
    expect(errors.some((error) => error.kind === "callback")).toBe(true);
    const callbackError = errors.find((error) => error.kind === "callback");
    if (callbackError === undefined) throw new Error("Callback error missing");
    expectRedactedError(callbackError, {
      kind: "callback",
      disposition: "stop",
      message: "Relay transport callback failed",
    }, canary);
  });

  it("rejects a duplicate session.ready and synchronously clears negotiated state", async () => {
    const errors: RelayTransportError[] = [];
    const { transport } = createTransport(undefined, (error) => errors.push(error));
    const socket = await openSocket(transport);
    socket.message(JSON.stringify(readyMessage()));
    transport.startUtterance(UTTERANCE_ID);
    transport.pushPcm(Uint8Array.of(1, 2));
    const duplicateLimits = {
      ...DEFAULT_NEGOTIATED_LIMITS,
      maxAudioPayloadBytes: 2,
    };

    socket.message(JSON.stringify(readyMessage(duplicateLimits, {
      sessionId: "55555555-5555-4555-8555-555555555555",
      sessionEpoch: 2,
    })));

    expect(errors.at(-1)?.kind).toBe("protocol");
    expect(socket.readyState).toBe(3);
    expectClosedEmpty(transport);
  });

  it("rejects session.ready messages that violate this generation's negotiation", async () => {
    const mismatches = [
      { targetLanguage: "tr" },
      { languageRegistryVersion: NONCURRENT_LANGUAGE_REGISTRY_VERSION },
      { gatePolicyVersion: "2.0.0" },
      { result: "resumed", requestedReplayOffset: 0 },
    ];
    for (const mismatch of mismatches) {
      FakeWebSocket.instances.length = 0;
      const errors: RelayTransportError[] = [];
      const transport = new RelayTransport({
        relayOrigin: "https://relay.example",
        fetch: async () => ticketResponse(),
        WebSocket: fakeWebSocketConstructor,
        onTransportError: (error) => errors.push(error),
      });
      const socket = await openSocket(transport);
      socket.message(JSON.stringify(readyMessage(DEFAULT_NEGOTIATED_LIMITS, mismatch)));
      expect(errors.at(-1)?.kind).toBe("protocol");
      expect(transport.snapshot.connectionState).toBe("closed");
    }
  });
});
