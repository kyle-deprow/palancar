import {
  AUDIO_FRAME_HEADER_BYTES,
  DEFAULT_NEGOTIATED_LIMITS,
  decodeAudioFrame,
  type NegotiatedLimits,
} from "@palancar/contracts";
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

type SentMessage = string | Uint8Array<ArrayBuffer>;

class FakeWebSocket implements BrowserWebSocket {
  static readonly instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly protocols: readonly string[];
  readonly sent: SentMessage[] = [];
  readyState = 0;
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

  close(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  message(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
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
    languageRegistryVersion: "1.0.0",
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
      languageRegistryVersion: "1.0.0",
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

  it("does not commit after a flush frame send fails", async () => {
    const errors: RelayTransportError[] = [];
    const { transport } = createTransport(undefined, (error) => errors.push(error));
    const socket = await openReady(transport);

    transport.startUtterance(UTTERANCE_ID);
    transport.pushPcm(Uint8Array.of(1, 2));
    socket.failNextSend = new Error("flush send failed");
    transport.commitUtterance();

    expect(socket.sent).toHaveLength(3);
    expect(sentControl(socket, 2)).toMatchObject({
      type: "utterance.cancel",
      utteranceId: UTTERANCE_ID,
    });
    expect(socket.sent.some((value) => typeof value === "string" && value.includes('"utterance.commit"'))).toBe(false);
    expect(errors.some((error) => error.kind === "audio")).toBe(true);

    transport.commitUtterance();
    expect(socket.sent.some((value) => typeof value === "string" && value.includes('"utterance.commit"'))).toBe(false);
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
    expect(malformedTicketTransport.snapshot.connectionState).toBe("closed");

    const protocolErrors: RelayTransportError[] = [];
    const { transport } = createTransport(undefined, (error) => protocolErrors.push(error));
    const start = transport.startSession("es");
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("WebSocket was not constructed");
    socket.open();
    await start;
    socket.message(JSON.stringify({ type: "session.ready", malformed: true }));

    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]?.kind).toBe("protocol");
    expect(socket.readyState).toBe(3);
    expect(transport.snapshot.connectionState).toBe("closed");
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

  it("routes recoverable server errors to onTransportError and makes terminal errors expected", async () => {
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
    socket.message(JSON.stringify(serverError(true)));
    expect(errors.at(-1)?.kind).toBe("protocol");
    expect(events.some((event) => event.type === "fatal")).toBe(false);

    socket.message(JSON.stringify(serverError(false)));
    expect(events.filter((event) => event.type === "fatal")).toHaveLength(1);
    expect(socket.readyState).toBe(3);
    expect(transport.snapshot.connectionState).toBe("closed");
    expect(errors.filter((error) => error.kind === "websocket")).toHaveLength(0);
  });

  it("clears a committed utterance before recoverable server-error callbacks", async () => {
    const errors: RelayTransportError[] = [];
    const events: RelayTransportCallbackEvent[] = [];
    let activeInCallback: string | undefined;
    const created = createTransport(
      (event) => events.push(event),
      (error) => {
        errors.push(error);
        if (error.kind === "protocol") {
          activeInCallback = created.transport.snapshot.activeUtteranceId;
          created.transport.startUtterance(SECOND_UTTERANCE_ID);
        }
      },
    );
    const transport = created.transport;
    const socket = await openReady(transport);

    transport.startUtterance(UTTERANCE_ID);
    transport.pushPcm(Uint8Array.of(1, 2));
    transport.commitUtterance();
    socket.message(JSON.stringify(serverError(true, "server")));

    expect(activeInCallback).toBeUndefined();
    expect(events.filter((event) => event.type === "fatal")).toHaveLength(0);
    expect(socket.readyState).toBe(1);
    expect(transport.snapshot.activeUtteranceId).toBe(SECOND_UTTERANCE_ID);
    expect(sentControl(socket, socket.sent.length - 1)).toMatchObject({
      type: "utterance.start",
      utteranceId: SECOND_UTTERANCE_ID,
    });
    expect(errors.at(-1)?.kind).toBe("protocol");
  });

  it("reports required control send failures while retaining the unsent boundary state", async () => {
    const errors: RelayTransportError[] = [];
    const { transport } = createTransport(undefined, (error) => errors.push(error));
    const socket = await openReady(transport);
    transport.startUtterance(UTTERANCE_ID);
    socket.sendError = new Error("send failed");
    transport.commitUtterance();
    expect(errors.some((error) => error.kind === "websocket")).toBe(true);
    expect(transport.snapshot.activeUtteranceId).toBe(UTTERANCE_ID);

    FakeWebSocket.instances.length = 0;
    const endErrors: RelayTransportError[] = [];
    const endTransport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onTransportError: (error) => endErrors.push(error),
    });
    const endSocket = await openReady(endTransport);
    endSocket.sendError = new Error("end failed");
    endTransport.endSession();
    expect(endErrors.some((error) => error.kind === "websocket")).toBe(true);
    expect(endTransport.snapshot.sessionReady).toBe(true);
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

  it("marks endSession and session.rejected closes as expected", async () => {
    const errors: RelayTransportError[] = [];
    const { transport } = createTransport(undefined, (error) => errors.push(error));
    const socket = await openReady(transport);
    transport.endSession();
    expect(sentControl(socket, 1)).toMatchObject({ type: "session.end" });
    socket.close();
    expect(errors).toHaveLength(0);

    FakeWebSocket.instances.length = 0;
    const rejectedErrors: RelayTransportError[] = [];
    const rejected = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onTransportError: (error) => rejectedErrors.push(error),
    });
    const rejectedSocket = await openSocket(rejected);
    rejectedSocket.message(JSON.stringify({
      type: "session.rejected",
      code: "authentication_failed",
      displaySafeMessage: "The session could not be started.",
    }));
    rejectedSocket.close();
    expect(rejectedErrors).toHaveLength(0);
  });

  it("isolates callbacks and defensively clones object server messages", async () => {
    const errors: RelayTransportError[] = [];
    const events: RelayTransportCallbackEvent[] = [];
    FakeWebSocket.instances.length = 0;
    const transport = new RelayTransport({
      relayOrigin: "https://relay.example",
      fetch: async () => ticketResponse(),
      WebSocket: fakeWebSocketConstructor,
      onServerEvent: () => {
        throw new Error("server callback failed");
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
  });

  it("rejects a duplicate session.ready without changing negotiated session state", async () => {
    const errors: RelayTransportError[] = [];
    const { transport } = createTransport(undefined, (error) => errors.push(error));
    const socket = await openSocket(transport);
    socket.message(JSON.stringify(readyMessage()));
    const beforeDuplicate = transport.snapshot;
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
    expect(transport.snapshot.sessionId).toBe(beforeDuplicate.sessionId);
    expect(transport.snapshot.sessionEpoch).toBe(beforeDuplicate.sessionEpoch);
    expect(transport.snapshot.negotiatedLimits).toEqual(beforeDuplicate.negotiatedLimits);
  });

  it("rejects session.ready messages that violate this generation's negotiation", async () => {
    const mismatches = [
      { targetLanguage: "tr" },
      { languageRegistryVersion: "2.0.0" },
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
