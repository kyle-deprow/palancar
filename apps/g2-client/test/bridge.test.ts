import {
  AudioEvent,
  AudioInputSource,
  EventSourceType,
  List_ItemEvent,
  OsEventTypeList,
  StartUpPageCreateResult,
  Sys_ItemEvent,
  TextContainerUpgrade,
  Text_ItemEvent,
  type CreateStartUpPageContainer,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { DEFAULT_NEGOTIATED_LIMITS } from "@palancar/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RELAY_ORIGIN,
  G2BridgeRuntime,
  PALANCAR_G2_READY,
  isPairedTurnEffects,
  type G2BridgePort,
  type G2Transport,
} from "../src/bridge/index.js";
import { PAGE_LAYOUTS } from "../src/display/index.js";
import type {
  RelayTransportCallbackEvent,
  RelayTransportOptions,
} from "../src/transport/index.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const UTTERANCE_ID = "22222222-2222-4222-8222-222222222222";

class FakeBridge implements G2BridgePort {
  startupResult = StartUpPageCreateResult.success;
  shutdownResult = true;
  shutdownImplementation: ((exitMode?: number) => Promise<boolean>) | undefined;
  readonly calls: string[] = [];
  readonly operationLog: string[];
  readonly startupContainers: CreateStartUpPageContainer[] = [];
  createStartUpPageContainerImplementation:
    ((container: CreateStartUpPageContainer) => Promise<StartUpPageCreateResult>) | undefined;
  readonly textUpdates: TextContainerUpgrade[] = [];
  readonly audioCalls: { isOpen: boolean; source: string | undefined }[] = [];
  textUpgradeResult = true;
  textUpgradeImplementation: ((container: TextContainerUpgrade) => Promise<boolean>) | undefined;
  audioOpenResult = true;
  audioOpenImplementation: (() => Promise<boolean>) | undefined;
  audioCloseResults: boolean[] = [];
  audioCloseImplementation: (() => Promise<boolean>) | undefined;
  unsubscribeImplementation: (() => void | PromiseLike<unknown>) | undefined;
  createCount = 0;
  subscriptionCount = 0;
  unsubscribeCount = 0;
  shutdownModes: number[] = [];
  #eventHandler: ((event: EvenHubEvent) => void) | undefined;

  constructor(operationLog: string[]) {
    this.operationLog = operationLog;
  }

  async createStartUpPageContainer(
    container: CreateStartUpPageContainer,
  ): Promise<StartUpPageCreateResult> {
    this.calls.push("create");
    this.createCount += 1;
    this.startupContainers.push(container);
    if (this.createStartUpPageContainerImplementation !== undefined) {
      return this.createStartUpPageContainerImplementation(container);
    }
    return this.startupResult;
  }

  async textContainerUpgrade(container: TextContainerUpgrade): Promise<boolean> {
    this.calls.push(`upgrade:${container.containerName}`);
    this.textUpdates.push(new TextContainerUpgrade({ ...container }));
    if (this.textUpgradeImplementation !== undefined) {
      return this.textUpgradeImplementation(container);
    }
    return this.textUpgradeResult;
  }

  async audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean> {
    this.calls.push(`audio:${isOpen ? "open" : "close"}`);
    this.operationLog.push(`audio:${isOpen ? "open" : "close"}`);
    this.audioCalls.push({ isOpen, source: source?.toString() });
    if (isOpen && this.audioOpenImplementation !== undefined) {
      return this.audioOpenImplementation();
    }
    if (!isOpen && this.audioCloseImplementation !== undefined) {
      return this.audioCloseImplementation();
    }
    return isOpen ? this.audioOpenResult : (this.audioCloseResults.shift() ?? true);
  }

  onEvenHubEvent(callback: (event: EvenHubEvent) => void): () => void {
    this.calls.push("subscribe");
    this.subscriptionCount += 1;
    this.#eventHandler = callback;
    let active = true;
    return () => {
      if (!active) return;
      this.calls.push("unsubscribe");
      this.unsubscribeCount += 1;
      const result = this.unsubscribeImplementation?.();
      const finish = (): void => {
        active = false;
        this.#eventHandler = undefined;
      };
      if (result === undefined) {
        finish();
        return;
      }
      return Promise.resolve(result).then(finish);
    };
  }

  async shutDownPageContainer(exitMode = 0): Promise<boolean> {
    this.calls.push("shutdown:start");
    this.shutdownModes.push(exitMode);
    const result = this.shutdownImplementation === undefined
      ? this.shutdownResult
      : await this.shutdownImplementation(exitMode);
    this.calls.push("shutdown:end");
    return result;
  }

  emit(event: EvenHubEvent): void {
    this.#eventHandler?.(event);
  }
}

class FakeTransport implements G2Transport {
  readonly options: RelayTransportOptions;
  readonly calls: string[];
  readonly pcm: Uint8Array[] = [];
  targetLanguage: string | undefined;
  closed = false;
  pushPcmImplementation: (() => void) | undefined;
  commitImplementation: (() => void) | undefined;
  closeImplementation: (() => void) | undefined;
  readonly startSessionImplementation: ((targetLanguage: "es" | "tr") => Promise<void>) | undefined;

  constructor(
    options: RelayTransportOptions,
    calls: string[],
    startSessionImplementation?: (targetLanguage: "es" | "tr") => Promise<void>,
  ) {
    this.options = options;
    this.calls = calls;
    this.startSessionImplementation = startSessionImplementation;
  }

  async startSession(targetLanguage: "es" | "tr"): Promise<void> {
    this.calls.push(`start-session:${targetLanguage}`);
    this.targetLanguage = targetLanguage;
    await this.startSessionImplementation?.(targetLanguage);
  }

  startUtterance(utteranceId: string): void {
    this.calls.push(`start-utterance:${utteranceId}`);
  }

  pushPcm(pcm: Uint8Array): void {
    this.calls.push("pcm");
    this.pushPcmImplementation?.();
    this.pcm.push(pcm);
  }

  commitUtterance(): void {
    this.calls.push("commit");
    this.commitImplementation?.();
  }

  cancelUtterance(): void {
    this.calls.push("cancel");
  }

  endSession(): void {
    this.calls.push("end-session");
  }

  close(): void {
    this.calls.push("close");
    this.closeImplementation?.();
    this.closed = true;
  }

  emit(event: RelayTransportCallbackEvent): void {
    this.options.onEvent?.(event);
  }
}

const systemEvent = (
  eventType?: OsEventTypeList,
  eventSource?: EventSourceType,
): EvenHubEvent => ({
  sysEvent: new Sys_ItemEvent({
    ...(eventType === undefined ? {} : { eventType }),
    ...(eventSource === undefined ? {} : { eventSource }),
  }),
});

const textEvent = (eventType?: OsEventTypeList): EvenHubEvent => ({
  textEvent: new Text_ItemEvent({
    containerName: "status",
    ...(eventType === undefined ? {} : { eventType }),
  }),
});

const listEvent = (eventType?: OsEventTypeList): EvenHubEvent => ({
  listEvent: new List_ItemEvent({
    containerName: "targets",
    ...(eventType === undefined ? {} : { eventType }),
  }),
});

const readyEvent = (targetLanguage: "es" | "tr" = "es"): RelayTransportCallbackEvent => ({
  type: "session.ready",
  result: "new",
  sessionId: SESSION_ID,
  sessionEpoch: 1,
  targetLanguage,
  languageRegistryVersion: "1.0.0",
  gatePolicyVersion: "1.0.0",
  effectiveLimits: DEFAULT_NEGOTIATED_LIMITS,
  serverTime: "2026-08-10T12:00:00.000Z",
});

const utteranceEvent = (
  type: "transcript.partial" | "transcript.final" = "transcript.final",
  text = "hola",
): RelayTransportCallbackEvent => ({
  type,
  sessionId: SESSION_ID,
  sessionEpoch: 1,
  utteranceId: UTTERANCE_ID,
  segmentId: "segment-1",
  revision: type === "transcript.partial" ? 1 : 2,
  text,
  providerEventTime: "2026-08-10T12:00:00.000Z",
} as RelayTransportCallbackEvent);

const languageDecision = (): RelayTransportCallbackEvent => ({
  type: "language.decision",
  sessionId: SESSION_ID,
  sessionEpoch: 1,
  utteranceId: UTTERANCE_ID,
  segmentId: "segment-1",
  revision: 2,
  decision: "target",
  selectedTargetLanguage: "es",
  gatePolicyVersion: "1.0.0",
} as RelayTransportCallbackEvent);

const translationReady = (): RelayTransportCallbackEvent => ({
  type: "translation.ready",
  sessionId: SESSION_ID,
  sessionEpoch: 1,
  utteranceId: UTTERANCE_ID,
  segmentId: "segment-1",
  acceptedFinalRevision: 2,
  englishTranslation: "hello",
} as RelayTransportCallbackEvent);

const suggestionsReady = (): RelayTransportCallbackEvent => ({
  type: "suggestions.ready",
  sessionId: SESSION_ID,
  sessionEpoch: 1,
  utteranceId: UTTERANCE_ID,
  segmentId: "segment-1",
  acceptedFinalRevision: 2,
  suggestions: [
    { englishText: "hello", selectedTargetText: "hola" },
    { englishText: "hi", selectedTargetText: "buenas" },
  ],
} as RelayTransportCallbackEvent);

interface TestHarness {
  readonly bridge: FakeBridge;
  readonly runtime: G2BridgeRuntime;
  readonly transports: FakeTransport[];
  readonly operations: string[];
  readonly persisted: string[];
}

interface HarnessOptions {
  readonly waitForBridge?: () => Promise<G2BridgePort>;
  readonly startSession?: (targetLanguage: "es" | "tr") => Promise<void>;
  readonly persistTarget?: (targetLanguage: "es" | "tr") => void | Promise<void>;
  readonly displayDebounceMs?: number;
}

function createHarness(harnessOptions: HarnessOptions = {}): TestHarness {
  const transports: FakeTransport[] = [];
  const operations: string[] = [];
  const bridge = new FakeBridge(operations);
  const persisted: string[] = [];
  const runtime = new G2BridgeRuntime({
    waitForBridge: harnessOptions.waitForBridge ?? (async () => bridge),
    readyLogger: (marker) => bridge.calls.push(`ready:${marker}`),
    createTransport: (options) => {
      const transport = new FakeTransport(options, operations, harnessOptions.startSession);
      transports.push(transport);
      return transport;
    },
    idGenerator: () => UTTERANCE_ID,
    storage: {
      setTarget: (target) => {
        persisted.push(target);
        return harnessOptions.persistTarget?.(target);
      },
    },
    displayDebounceMs: harnessOptions.displayDebounceMs ?? 0,
  });
  return { bridge, runtime, transports, operations, persisted };
}

async function boot(harness: TestHarness): Promise<void> {
  await harness.runtime.boot();
  await harness.runtime.whenEventsIdle();
}

async function flushMicrotasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

async function selectSpanishAndStart(harness: TestHarness): Promise<FakeTransport> {
  await boot(harness);
  harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
  await harness.runtime.whenEventsIdle();
  const transport = harness.transports[0];
  if (transport === undefined) throw new Error("Transport was not created");
  return transport;
}

describe("G2BridgeRuntime startup", () => {
  it("creates the Starting page once, subscribes once, then displays TargetSelection", async () => {
    const harness = createHarness();
    await boot(harness);

    expect(harness.bridge.createCount).toBe(1);
    expect(harness.bridge.subscriptionCount).toBe(1);
    expect(harness.bridge.startupContainers).toHaveLength(1);
    expect(harness.bridge.startupContainers[0]?.containerTotalNum).toBe(
      PAGE_LAYOUTS.Starting.containerTotalNum,
    );
    expect(harness.bridge.textUpdates).toHaveLength(5);
    expect(harness.bridge.textUpdates.map((update) => update.containerName)).toEqual([
      "status",
      "target",
      "source",
      "english",
      "suggestion",
    ]);
    expect(harness.runtime.snapshot.state).toBe("TargetSelection");
    expect(harness.runtime.snapshot.lastDisplayContent.target).toContain("[Spanish]");
    expect(harness.runtime.snapshot.lastDisplayContent.suggestion).toContain(
      "press to confirm, swipe to change",
    );
    expect(harness.bridge.calls).toContain(`ready:${PALANCAR_G2_READY}`);
  });

  it("surfaces a typed startup error without subscription or retry", async () => {
    const harness = createHarness();
    harness.bridge.startupResult = StartUpPageCreateResult.invalid;

    const firstBoot = harness.runtime.boot();
    await expect(firstBoot).rejects.toMatchObject({
      name: "BridgeStartupError",
      result: StartUpPageCreateResult.invalid,
    });
    expect(harness.runtime.boot()).toBe(firstBoot);
    expect(harness.bridge.createCount).toBe(1);
    expect(harness.bridge.subscriptionCount).toBe(0);
    expect(harness.bridge.textUpdates).toHaveLength(0);
    expect(harness.runtime.snapshot.state).toBe("Error");
  });

  it("fails boot when the first display upgrade fails and does not log ready", async () => {
    const harness = createHarness();
    harness.bridge.textUpgradeResult = false;

    await expect(harness.runtime.boot()).rejects.toMatchObject({
      name: "BridgeStartupError",
      cause: expect.objectContaining({
        message: "G2 text container upgrade failed",
      }),
    });

    expect(harness.bridge.textUpdates).toHaveLength(1);
    expect(harness.bridge.calls).not.toContain(`ready:${PALANCAR_G2_READY}`);
    expect(harness.bridge.unsubscribeCount).toBe(1);
    expect(harness.runtime.snapshot.hasEventSubscription).toBe(false);
    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.runtime.snapshot.bootState).toBe("failed");
    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    expect(harness.transports).toHaveLength(0);
    await expect(harness.runtime.whenEventsIdle()).rejects.toThrow(
      "G2 text container upgrade failed",
    );
    expect(harness.bridge.textUpdates).toHaveLength(1);
  });

  it("shares a concurrent successful boot promise", async () => {
    const harness = createHarness();
    const firstBoot = harness.runtime.boot();
    const secondBoot = harness.runtime.boot();

    expect(secondBoot).toBe(firstBoot);
    await Promise.all([firstBoot, secondBoot]);
    await harness.runtime.whenEventsIdle();
    expect(harness.bridge.createCount).toBe(1);
    expect(harness.bridge.subscriptionCount).toBe(1);
  });

  it("removes cleanup waiters after repeated idle checks", async () => {
    const harness = createHarness();
    await boot(harness);

    const idleChecks = Array.from({ length: 128 }, () =>
      harness.runtime.whenEventsIdle());
    expect(harness.runtime.snapshot.cleanupWaiterCount).toBe(idleChecks.length);

    await Promise.all(idleChecks);
    expect(harness.runtime.snapshot.cleanupWaiterCount).toBe(0);

    await harness.runtime.cleanup();
    expect(harness.runtime.snapshot.cleanupWaiterCount).toBe(0);
  });

  it("rejects boot without touching the SDK when cleanup precedes bridge arrival", async () => {
    let resolveBridge: ((bridge: G2BridgePort) => void) | undefined;
    const bridgePromise = new Promise<G2BridgePort>((resolve) => {
      resolveBridge = resolve;
    });
    const harness = createHarness({ waitForBridge: () => bridgePromise });
    const bootPromise = harness.runtime.boot();

    await harness.runtime.cleanup();
    resolveBridge?.(harness.bridge);

    await expect(bootPromise).rejects.toMatchObject({ name: "BridgeStartupError" });
    expect(harness.bridge.createCount).toBe(0);
    expect(harness.bridge.subscriptionCount).toBe(0);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it.each(["getTarget", "getItem"] as const)(
    "preempts a non-settling %s target storage read during boot",
    async (storageMethod) => {
      let readCalls = 0;
      const harness = createHarness();
      const storage = storageMethod === "getTarget"
        ? {
            getTarget: () => {
              readCalls += 1;
              return new Promise<unknown>(() => undefined);
            },
          }
        : {
            getItem: () => {
              readCalls += 1;
              return new Promise<string | null>(() => undefined);
            },
          };
      const runtime = new G2BridgeRuntime({
        waitForBridge: async () => harness.bridge,
        readyLogger: (marker) => harness.bridge.calls.push(`ready:${marker}`),
        storage,
        displayDebounceMs: 0,
      });

      const bootPromise = runtime.boot();
      for (let attempt = 0; attempt < 20 && readCalls === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(readCalls).toBe(1);

      await runtime.cleanup();
      await expect(bootPromise).rejects.toMatchObject({ name: "BridgeStartupError" });
      expect(harness.bridge.createCount).toBe(0);
      expect(runtime.snapshot.cleanupState).toBe("cleaned");
    },
  );

  it("rejects boot and tears down a startup container created after cleanup began", async () => {
    let resolveCreate: ((result: StartUpPageCreateResult) => void) | undefined;
    const createPromise = new Promise<StartUpPageCreateResult>((resolve) => {
      resolveCreate = resolve;
    });
    const harness = createHarness();
    harness.bridge.createStartUpPageContainerImplementation = () => createPromise;
    const bootPromise = harness.runtime.boot();

    for (let attempt = 0; attempt < 20 && harness.bridge.createCount === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(harness.bridge.createCount).toBe(1);

    await harness.runtime.cleanup();
    resolveCreate?.(StartUpPageCreateResult.success);

    await expect(bootPromise).rejects.toMatchObject({ name: "BridgeStartupError" });
    expect(harness.bridge.subscriptionCount).toBe(0);
    expect(harness.bridge.shutdownModes).toEqual([0]);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it("makes a ready logger failure safe and rejects boot", async () => {
    const harness = createHarness();
    const runtime = new G2BridgeRuntime({
      waitForBridge: async () => harness.bridge,
      readyLogger: () => {
        throw new Error("logger failed");
      },
      displayDebounceMs: 0,
    });

    await expect(runtime.boot()).rejects.toMatchObject({
      name: "BridgeStartupError",
      cause: expect.objectContaining({ message: "logger failed" }),
    });
    expect(runtime.snapshot.state).toBe("Error");
    expect(runtime.snapshot.hasEventSubscription).toBe(false);
  });

  it("rejects boot without ready when cleanup interrupts the initial display debounce", async () => {
    const harness = createHarness({ displayDebounceMs: 1_000 });
    const bootPromise = harness.runtime.boot();
    for (let attempt = 0; attempt < 20 && harness.bridge.subscriptionCount === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(harness.bridge.subscriptionCount).toBe(1);

    await harness.runtime.cleanup();
    await expect(bootPromise).rejects.toMatchObject({ name: "BridgeStartupError" });
    expect(harness.bridge.calls).not.toContain(`ready:${PALANCAR_G2_READY}`);
    expect(harness.bridge.unsubscribeCount).toBe(1);
    expect(harness.runtime.snapshot.bootState).toBe("failed");
  });

  it("keeps startup teardown retryable after false and rejected shutdown results", async () => {
    const harness = createHarness();
    await boot(harness);

    harness.bridge.shutdownResult = false;
    await expect(harness.runtime.cleanup()).rejects.toThrow(
      "G2 startup container teardown failed",
    );
    expect(harness.runtime.snapshot.cleanupState).toBe("active");

    harness.bridge.shutdownImplementation = async () => {
      throw new Error("shutdown rejected");
    };
    await expect(harness.runtime.cleanup()).rejects.toThrow("shutdown rejected");
    expect(harness.runtime.snapshot.cleanupState).toBe("active");

    harness.bridge.shutdownImplementation = undefined;
    harness.bridge.shutdownResult = true;
    await harness.runtime.cleanup();
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it("retains boot-failure cleanup work for an explicit teardown retry", async () => {
    const harness = createHarness();
    harness.bridge.textUpgradeResult = false;
    harness.bridge.shutdownResult = false;

    await expect(harness.runtime.boot()).rejects.toMatchObject({
      name: "BridgeStartupError",
    });
    expect(harness.runtime.snapshot.cleanupState).toBe("active");

    harness.bridge.shutdownResult = true;
    await harness.runtime.cleanup();
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it.each([undefined, null])(
    "normalizes %s from a display-upgrade rejection",
    async (rejection) => {
      const harness = createHarness();
      harness.bridge.textUpgradeImplementation = () => Promise.reject(rejection);

      await expect(harness.runtime.boot()).rejects.toMatchObject({
        name: "BridgeStartupError",
        cause: expect.objectContaining({ message: expect.stringContaining("rejection") }),
      });
      expect(harness.runtime.snapshot.state).toBe("Error");
    },
  );

  it("reconciles a late successful startup teardown after timeout", async () => {
    let resolveShutdown: ((result: boolean) => void) | undefined;
    let shutdownCalls = 0;
    const harness = createHarness();
    await boot(harness);
    harness.bridge.shutdownImplementation = () => {
      shutdownCalls += 1;
      if (shutdownCalls > 1) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        resolveShutdown = resolve;
      });
    };

    vi.useFakeTimers();
    try {
      const cleanup = harness.runtime.cleanup();
      const cleanupExpectation = expect(cleanup).rejects.toThrow(
        "G2 startup container teardown timed out",
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await cleanupExpectation;
      expect(harness.runtime.snapshot.cleanupState).toBe("active");

      await harness.runtime.cleanup();
      expect(shutdownCalls).toBe(2);
      expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");

      resolveShutdown?.(true);
      await Promise.resolve();
      await harness.runtime.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a display upgrade and cleans up", async () => {
    const pendingUpgrade = new Promise<boolean>(() => undefined);
    const harness = createHarness();
    await boot(harness);
    harness.bridge.textUpgradeImplementation = () => pendingUpgrade;

    vi.useFakeTimers();
    try {
      harness.bridge.emit(listEvent(OsEventTypeList.SCROLL_BOTTOM_EVENT));
      const idle = harness.runtime.whenEventsIdle();
      const idleExpectation = expect(idle).rejects.toThrow(
        "G2 text container upgrade timed out",
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await idleExpectation;
      expect(harness.runtime.snapshot.state).toBe("Error");
      expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let pending target storage block cleanup", async () => {
    const pendingPersistence = new Promise<void>(() => undefined);
    const harness = createHarness({ persistTarget: () => pendingPersistence });
    await boot(harness);

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.SYSTEM_EXIT_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it("handles async ready logger rejection and cleanup preemption", async () => {
    const rejectionHarness = createHarness();
    const rejectingRuntime = new G2BridgeRuntime({
      waitForBridge: async () => rejectionHarness.bridge,
      readyLogger: async () => {
        throw new Error("async logger failed");
      },
      displayDebounceMs: 0,
    });
    await expect(rejectingRuntime.boot()).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "async logger failed" }),
    });

    let resolveLogger: (() => void) | undefined;
    const pendingLogger = new Promise<void>((resolve) => {
      resolveLogger = resolve;
    });
    const preemptHarness = createHarness();
    const preemptedRuntime = new G2BridgeRuntime({
      waitForBridge: async () => preemptHarness.bridge,
      readyLogger: () => pendingLogger,
      displayDebounceMs: 0,
    });
    const bootPromise = preemptedRuntime.boot();
    for (let attempt = 0; attempt < 20 && preemptHarness.bridge.subscriptionCount === 0; attempt += 1) {
      await Promise.resolve();
    }
    await preemptedRuntime.cleanup();
    await expect(bootPromise).rejects.toMatchObject({ name: "BridgeStartupError" });
    resolveLogger?.();
    await Promise.resolve();
  });
});

describe("G2BridgeRuntime gestures, transport, display, and cleanup", () => {
  it("swipes to a target, confirms once, starts one relay session, and persists it", async () => {
    const harness = createHarness();
    await boot(harness);

    harness.bridge.emit(listEvent(OsEventTypeList.SCROLL_BOTTOM_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.target).toBe("tr");

    harness.bridge.emit(listEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    expect(harness.transports).toHaveLength(1);
    expect(harness.transports[0]?.targetLanguage).toBe("tr");
    expect(harness.transports[0]?.options.relayOrigin).toBe(DEFAULT_RELAY_ORIGIN);
    expect(harness.persisted).toEqual(["tr"]);
    expect(harness.runtime.snapshot.state).toBe("Ready");
    expect(harness.runtime.snapshot.sessionReady).toBe(false);
  });

  it("coalesces a gesture burst and skips unchanged display regions", async () => {
    const harness = createHarness();
    await boot(harness);
    const initialUpdateCount = harness.runtime.snapshot.displayUpdateCount;

    harness.bridge.emit(listEvent(OsEventTypeList.SCROLL_BOTTOM_EVENT));
    harness.bridge.emit(listEvent(OsEventTypeList.SCROLL_TOP_EVENT));
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.target).toBe("es");
    expect(harness.runtime.snapshot.displayUpdateCount).toBe(initialUpdateCount);
    expect(harness.bridge.textUpdates).toHaveLength(5);

    harness.bridge.emit(listEvent(OsEventTypeList.SCROLL_BOTTOM_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.displayUpdateCount).toBe(initialUpdateCount + 1);
    expect(harness.bridge.textUpdates.at(-1)?.containerName).toBe("target");
  });

  it("latches a post-boot display failure and blocks a later press", async () => {
    const harness = createHarness();
    await boot(harness);
    harness.bridge.textUpgradeResult = false;

    harness.bridge.emit(listEvent(OsEventTypeList.SCROLL_BOTTOM_EVENT));
    await expect(harness.runtime.whenEventsIdle()).rejects.toThrow(
      "G2 text container upgrade failed",
    );

    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(harness.runtime.snapshot.hasEventSubscription).toBe(false);

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    expect(harness.transports).toHaveLength(0);
    expect(harness.bridge.audioCalls).toHaveLength(0);
  });

  it("generates a v4 utterance, starts it before glasses audio, and streams copied PCM", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Listening");
    expect(harness.runtime.snapshot.audioOpen).toBe(true);
    expect(harness.operations).toEqual([
      "start-session:es",
      `start-utterance:${UTTERANCE_ID}`,
      "audio:open",
    ]);
    expect(harness.bridge.audioCalls.at(-1)).toMatchObject({ isOpen: true, source: "glasses" });

    const pcm = new Uint8Array([1, 2, 3]);
    harness.bridge.emit({ audioEvent: new AudioEvent({ audioPcm: pcm }) });
    expect(transport.pcm).toHaveLength(1);
    expect(transport.pcm[0]).not.toBe(pcm);
    expect([...transport.pcm[0]!]).toEqual([1, 2, 3]);

    harness.bridge.emit({
      audioEvent: new AudioEvent({
        audioPcm: new Uint8Array([4, 5]),
        source: AudioInputSource.Phone,
      }),
    });
    expect(transport.pcm).toHaveLength(1);
  });

  it("reports audio open failure without marking the microphone open", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioOpenResult = false;

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.runtime.snapshot.audioOpen).toBe(false);
    expect(harness.operations).toContain(`start-utterance:${UTTERANCE_ID}`);
    expect(harness.operations).toContain("audio:open");
  });

  it("attempts a bounded close after a rejected audio open", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioOpenImplementation = () => Promise.reject(undefined);

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
    expect(harness.runtime.snapshot.audioOpen).toBe(false);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it.each([undefined, null])(
    "normalizes %s from an audio-close rejection",
    async (rejection) => {
      const harness = createHarness();
      const transport = await selectSpanishAndStart(harness);
      transport.emit(readyEvent());
      await harness.runtime.whenEventsIdle();
      harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
      await harness.runtime.whenEventsIdle();
      harness.bridge.audioCloseImplementation = () => Promise.reject(rejection);

      harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
      await expect(harness.runtime.whenEventsIdle()).rejects.toThrow(/audio close failed/);
      expect(harness.runtime.snapshot.cleanupState).toBe("active");

      harness.bridge.audioCloseImplementation = undefined;
      await harness.runtime.cleanup();
      expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    },
  );

  it("bounds a permanently pending normal audio open and closes a late microphone", async () => {
    let resolveOpen: ((opened: boolean) => void) | undefined;
    const pendingOpen = new Promise<boolean>((resolve) => {
      resolveOpen = resolve;
    });
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioOpenImplementation = () => pendingOpen;

    vi.useFakeTimers();
    try {
      harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
      for (let attempt = 0; attempt < 20 && harness.bridge.audioCalls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      const idle = harness.runtime.whenEventsIdle();
      const idleExpectation = expect(idle).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      await idleExpectation;
      expect(harness.runtime.snapshot.state).toBe("Error");
      expect(harness.runtime.snapshot.audioOpen).toBe(false);
      expect(transport.closed).toBe(true);

      resolveOpen?.(true);
      for (let attempt = 0; attempt < 20 && harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen).length < 2; attempt += 1) {
        await Promise.resolve();
      }
      expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(2);
      await harness.runtime.cleanup();
      expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a pending audio open before completing cleanup and closes the late microphone", async () => {
    let resolveOpen: ((opened: boolean) => void) | undefined;
    const pendingOpen = new Promise<boolean>((resolve) => {
      resolveOpen = resolve;
    });
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioOpenImplementation = () => pendingOpen;

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    for (let attempt = 0; attempt < 20 && harness.bridge.audioCalls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(harness.bridge.audioCalls.at(-1)?.isOpen).toBe(true);
    harness.bridge.audioCloseResults = [false, true];

    let cleanupSettled = false;
    const cleanupPromise = harness.runtime.cleanup();
    void cleanupPromise.then(
      () => { cleanupSettled = true; },
      () => { cleanupSettled = true; },
    );
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(0);

    resolveOpen?.(true);
    await expect(cleanupPromise).rejects.toThrow("G2 audio close failed");
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
    expect(harness.runtime.snapshot.audioOpen).toBe(false);

    await harness.runtime.cleanup();
    expect(harness.bridge.audioCalls.at(-1)?.isOpen).toBe(false);
    expect(harness.runtime.snapshot.audioOpen).toBe(false);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it("closes a late audio-open success before cleanup reports cleaned during startup teardown", async () => {
    let resolveOpen: ((opened: boolean) => void) | undefined;
    let resolveShutdown: ((result: boolean) => void) | undefined;
    const pendingOpen = new Promise<boolean>((resolve) => {
      resolveOpen = resolve;
    });
    const pendingShutdown = new Promise<boolean>((resolve) => {
      resolveShutdown = resolve;
    });
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioOpenImplementation = () => pendingOpen;
    harness.bridge.shutdownImplementation = () => pendingShutdown;

    vi.useFakeTimers();
    try {
      harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
      for (let attempt = 0; attempt < 20 && harness.bridge.audioCalls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      const idle = harness.runtime.whenEventsIdle();
      void idle.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      for (let attempt = 0; attempt < 20 && harness.bridge.shutdownModes.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(harness.bridge.shutdownModes).toEqual([0]);

      resolveOpen?.(true);
      for (let attempt = 0; attempt < 20 && !harness.runtime.snapshot.audioOpen; attempt += 1) {
        await Promise.resolve();
      }
      expect(harness.runtime.snapshot.audioOpen).toBe(true);

      resolveShutdown?.(true);
      await idle;
      expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(2);
      expect(harness.runtime.snapshot.audioOpen).toBe(false);
      expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds lifecycle cleanup behind a pending audio open and leaves cleanup retryable", async () => {
    let resolveOpen: ((opened: boolean) => void) | undefined;
    const pendingOpen = new Promise<boolean>((resolve) => {
      resolveOpen = resolve;
    });
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioOpenImplementation = () => pendingOpen;
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    for (let attempt = 0; attempt < 20 && harness.bridge.audioCalls.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    vi.useFakeTimers();
    try {
      harness.bridge.emit(systemEvent(OsEventTypeList.SYSTEM_EXIT_EVENT));
      const cleanupIdle = harness.runtime.whenEventsIdle();
      void cleanupIdle.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(cleanupIdle).rejects.toThrow("G2 audio open timed out during cleanup");
      expect(harness.runtime.snapshot.cleanupState).toBe("active");
      expect(transport.closed).toBe(true);

      resolveOpen?.(true);
      await Promise.resolve();
      await Promise.resolve();
      harness.bridge.audioCloseResults = [true];
      await harness.runtime.cleanup();
      expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
      expect(harness.runtime.snapshot.audioOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attempts a bounded close after system cleanup times out a pending audio open", async () => {
    const pendingOpen = new Promise<boolean>(() => undefined);
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioOpenImplementation = () => pendingOpen;

    vi.useFakeTimers();
    try {
      harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
      for (let attempt = 0; attempt < 20 && harness.bridge.audioCalls.length === 0; attempt += 1) {
        await Promise.resolve();
      }

      harness.bridge.emit(systemEvent(OsEventTypeList.SYSTEM_EXIT_EVENT));
      const cleanupIdle = harness.runtime.whenEventsIdle();
      const cleanupExpectation = expect(cleanupIdle).rejects.toThrow(
        "G2 audio open timed out during cleanup",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await cleanupExpectation;

      expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
      expect(harness.runtime.snapshot.cleanupState).toBe("active");
      expect(transport.closed).toBe(true);

      await harness.runtime.cleanup();
      expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    } finally {
      vi.useRealTimers();
    }
  });

  it("latches a synchronous PCM failure so an audio burst queues one fatal event", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    transport.pushPcmImplementation = () => {
      throw new Error("PCM sink failed");
    };

    harness.bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array([1]) }) });
    harness.bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array([2]) }) });
    harness.bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array([3]) }) });

    expect(transport.calls.filter((call) => call === "pcm")).toHaveLength(1);
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Error");
  });

  it("discards a queued PCM fatal for replaced transport A without latching transport B", async () => {
    const harness = createHarness();
    const firstTransport = await selectSpanishAndStart(harness);
    firstTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    firstTransport.pushPcmImplementation = () => {
      firstTransport.emit({
        type: "transport.lost",
        sessionId: SESSION_ID,
        sessionEpoch: 1,
      } as unknown as RelayTransportCallbackEvent);
      firstTransport.emit({
        type: "transport.lost",
        sessionId: SESSION_ID,
        sessionEpoch: 1,
      } as unknown as RelayTransportCallbackEvent);
      throw new Error("PCM sink failed");
    };
    harness.bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array([1]) }) });
    await harness.runtime.whenEventsIdle();

    const secondTransport = harness.transports[1];
    if (secondTransport === undefined) throw new Error("Replacement transport was not created");
    secondTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array([2]) }) });
    expect(secondTransport.pcm).toHaveLength(1);
    expect(harness.runtime.snapshot.state).toBe("Listening");
  });

  it("fails closed when serialized transport callbacks exceed the queue bound", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);

    for (let index = 0; index < 70; index += 1) {
      transport.emit(readyEvent());
    }
    await expect(harness.runtime.whenEventsIdle()).resolves.toBeUndefined();
    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(transport.closed).toBe(true);
  });

  it("starts microphone shutdown even when commit throws", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseResults = [true];
    transport.commitImplementation = () => {
      throw new Error("commit failed");
    };

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    expect(harness.operations.filter((operation) => operation === "commit")).toHaveLength(1);
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
    expect(harness.operations.filter((operation) => operation === "end-session")).toHaveLength(1);
    expect(harness.operations.filter((operation) => operation === "close")).toHaveLength(1);
    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it("suppresses PCM injected synchronously by commit", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseResults = [true];
    transport.commitImplementation = () => {
      harness.bridge.emit({
        audioEvent: new AudioEvent({ audioPcm: new Uint8Array([1, 2, 3]) }),
      });
    };

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    expect(transport.pcm).toHaveLength(0);
    expect(harness.operations.filter((operation) => operation === "commit")).toHaveLength(1);
  });

  it.each([
    { field: "sessionId", value: "33333333-3333-4333-8333-333333333333" },
    { field: "sessionEpoch", value: 2 },
    { field: "utteranceId", value: "44444444-4444-4444-8444-444444444444" },
  ])("does not pair effects when $field does not match", ({ field, value }) => {
    const stopEffect = {
      type: "stop-audio" as const,
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
    };
    const commitEffect = {
      type: "commit-utterance" as const,
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      [field]: value,
    };

    expect(isPairedTurnEffects(stopEffect, commitEffect)).toBe(false);
  });

  it("awaits a standalone stop before completing transport recovery", async () => {
    let resolveClose: ((closed: boolean) => void) | undefined;
    const pendingClose = new Promise<boolean>((resolve) => {
      resolveClose = resolve;
    });
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseImplementation = () => pendingClose;

    transport.emit({
      type: "transport.lost",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      clientLastAcknowledgedOffset: 0,
      oldestRetainedOffset: 0,
      nextCapturedOffset: 0,
    } as unknown as RelayTransportCallbackEvent);
    const idle = harness.runtime.whenEventsIdle();
    let settled = false;
    void idle.then(() => { settled = true; }, () => { settled = true; });
    await flushMicrotasks();

    expect(settled).toBe(false);
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
    expect(harness.runtime.snapshot.state).toBe("Recovering");

    resolveClose?.(true);
    await idle;
    expect(settled).toBe(true);
    expect(harness.runtime.snapshot.state).toBe("Recovering");
  });

  it("blocks a recovery open until an unresolved standalone close settles", async () => {
    let resolveClose: ((closed: boolean) => void) | undefined;
    const pendingClose = new Promise<boolean>((resolve) => {
      resolveClose = resolve;
    });
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseImplementation = () => pendingClose;

    transport.emit({
      type: "transport.lost",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      clientLastAcknowledgedOffset: 0,
      oldestRetainedOffset: 0,
      nextCapturedOffset: 0,
    } as unknown as RelayTransportCallbackEvent);
    transport.emit({
      type: "transport.resumed",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      resumable: true,
    } as unknown as RelayTransportCallbackEvent);
    await flushMicrotasks();

    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => isOpen)).toHaveLength(1);

    resolveClose?.(true);
    await harness.runtime.whenEventsIdle();
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => isOpen)).toHaveLength(2);
    expect(harness.operations.indexOf("audio:close")).toBeLessThan(
      harness.operations.lastIndexOf("audio:open"),
    );
    expect(harness.runtime.snapshot.state).toBe("Listening");
  });

  it("commits immediately and starts a detached audio close", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Finalizing");
    expect(harness.runtime.snapshot.audioOpen).toBe(false);
    expect(harness.bridge.audioCalls.at(-1)?.isOpen).toBe(false);
    expect(harness.operations.filter((operation) => operation === "commit")).toHaveLength(1);
    expect(harness.operations.indexOf("commit")).toBeLessThan(
      harness.operations.indexOf("audio:close"),
    );
    expect(harness.bridge.calls.indexOf("audio:close")).toBeGreaterThan(-1);
  });

  it("routes a false detached close through fatal handling after one commit", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseResults = [false, true];

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.runtime.snapshot.audioOpen).toBe(false);
    expect(harness.operations.filter((operation) => operation === "commit")).toHaveLength(1);
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(2);
    expect(transport.closed).toBe(true);
    expect(harness.operations.filter((operation) => operation === "end-session")).toHaveLength(1);
    expect(harness.operations.filter((operation) => operation === "close")).toHaveLength(1);
  });

  it("routes a rejected detached close through fatal handling after one commit", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    let closeAttempts = 0;
    harness.bridge.audioCloseImplementation = () => {
      closeAttempts += 1;
      return closeAttempts === 1
        ? Promise.reject(new Error("detached close failed"))
        : Promise.resolve(true);
    };

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.operations.filter((operation) => operation === "commit")).toHaveLength(1);
    expect(closeAttempts).toBe(2);
    expect(transport.closed).toBe(true);
    expect(harness.operations.filter((operation) => operation === "end-session")).toHaveLength(1);
    expect(harness.operations.filter((operation) => operation === "close")).toHaveLength(1);
  });

  it("times out a detached close without overlapping SDK close calls", async () => {
    const pendingClose = new Promise<boolean>(() => undefined);
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseImplementation = () => pendingClose;

    vi.useFakeTimers();
    try {
      harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
      for (let attempt = 0; attempt < 20 && harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen).length < 1; attempt += 1) {
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(0);
      await harness.runtime.whenEventsIdle();
      expect(harness.operations.filter((operation) => operation === "commit")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
      const idle = harness.runtime.whenEventsIdle();
      const idleExpectation = expect(idle).rejects.toThrow("G2 audio close timed out");
      for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await idleExpectation;
      expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
      expect(harness.operations.filter((operation) => operation === "commit")).toHaveLength(1);
      expect(transport.closed).toBe(true);
      expect(harness.runtime.snapshot.state).toBe("Error");
      expect(harness.runtime.snapshot.cleanupState).toBe("active");
      expect(harness.operations.filter((operation) => operation === "end-session")).toHaveLength(1);
      expect(harness.operations.filter((operation) => operation === "close")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["success", "false", "reject"] as const)(
    "reconciles a detached timeout followed by a late %s settlement",
    async (settlement) => {
      let resolveClose: ((closed: boolean) => void) | undefined;
      let rejectClose: ((error: unknown) => void) | undefined;
      const pendingClose = new Promise<boolean>((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      });
      let closeAttempts = 0;
      const harness = createHarness();
      const transport = await selectSpanishAndStart(harness);
      transport.emit(readyEvent());
      await harness.runtime.whenEventsIdle();
      harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
      await harness.runtime.whenEventsIdle();
      harness.bridge.audioCloseImplementation = () => {
        closeAttempts += 1;
        return closeAttempts === 1 ? pendingClose : Promise.resolve(true);
      };

      vi.useFakeTimers();
      try {
        harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
        for (let attempt = 0; attempt < 20 && closeAttempts < 1; attempt += 1) {
          await Promise.resolve();
        }
        expect(closeAttempts).toBe(1);

        await vi.advanceTimersByTimeAsync(1_000);
        await flushMicrotasks();
        const idle = harness.runtime.whenEventsIdle();
        const idleExpectation = expect(idle).rejects.toThrow("G2 audio close timed out");
        await vi.advanceTimersByTimeAsync(1_000);
        await idleExpectation;
        expect(harness.runtime.snapshot.cleanupState).toBe("active");
        expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);

        if (settlement === "success") {
          resolveClose?.(true);
        } else if (settlement === "false") {
          resolveClose?.(false);
        } else {
          rejectClose?.(new Error("late detached close failed"));
        }
        await flushMicrotasks(20);
        await harness.runtime.cleanup();

        expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
        expect(harness.runtime.snapshot.audioOpen).toBe(false);
        expect(closeAttempts).toBe(settlement === "success" ? 1 : 2);
        expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(
          settlement === "success" ? 1 : 2,
        );
        expect(harness.operations.filter((operation) => operation === "end-session")).toHaveLength(1);
        expect(harness.operations.filter((operation) => operation === "close")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("adopts the same unresolved close after its detached timeout", async () => {
    let resolveClose: ((closed: boolean) => void) | undefined;
    const pendingClose = new Promise<boolean>((resolve) => {
      resolveClose = resolve;
    });
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseImplementation = () => pendingClose;

    vi.useFakeTimers();
    try {
      harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
      for (let attempt = 0; attempt < 20 && harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen).length < 1; attempt += 1) {
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await flushMicrotasks();
      const cleanup = harness.runtime.cleanup();
      let settled = false;
      void cleanup.then(() => { settled = true; }, () => { settled = true; });
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);

      resolveClose?.(true);
      await cleanup;
      expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
      expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
      expect(transport.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts unresolved detached close work during cleanup", async () => {
    let resolveClose: ((closed: boolean) => void) | undefined;
    const pendingClose = new Promise<boolean>((resolve) => {
      resolveClose = resolve;
    });
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseImplementation = () => {
      return pendingClose;
    };

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    for (let attempt = 0; attempt < 20 && harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen).length < 1; attempt += 1) {
      await Promise.resolve();
    }
    const cleanup = harness.runtime.cleanup();
    await Promise.resolve();
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);

    resolveClose?.(true);
    await cleanup;
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
    expect(harness.runtime.snapshot.audioOpen).toBe(false);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(transport.closed).toBe(true);
  });

  it("waits for a detached close before reopening audio for a fast next turn", async () => {
    let resolveClose: ((closed: boolean) => void) | undefined;
    const pendingClose = new Promise<boolean>((resolve) => {
      resolveClose = resolve;
    });
    const harness = createHarness();
    const firstTransport = await selectSpanishAndStart(harness);
    firstTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseImplementation = () => pendingClose;

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    for (let attempt = 0; attempt < 20 && harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen).length < 1; attempt += 1) {
      await Promise.resolve();
    }
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);

    firstTransport.emit(utteranceEvent());
    firstTransport.emit(languageDecision());
    await harness.runtime.whenEventsIdle();
    firstTransport.emit(translationReady());
    firstTransport.emit(suggestionsReady());
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Results");

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Ready");
    firstTransport.emit({
      type: "transport.lost",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
    } as unknown as RelayTransportCallbackEvent);
    await harness.runtime.whenEventsIdle();
    const secondTransport = harness.transports[1];
    if (secondTransport === undefined) throw new Error("Replacement transport was not created");
    secondTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    const idle = harness.runtime.whenEventsIdle();
    let settled = false;
    void idle.then(() => { settled = true; }, () => { settled = true; });
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => isOpen)).toHaveLength(1);

    resolveClose?.(true);
    await idle;
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => isOpen)).toHaveLength(2);
    expect(harness.runtime.snapshot.audioOpen).toBe(true);

    harness.bridge.emit({
      audioEvent: new AudioEvent({ audioPcm: new Uint8Array([4, 5, 6]) }),
    });
    expect(secondTransport.pcm).toHaveLength(1);
    expect([...secondTransport.pcm[0]!]).toEqual([4, 5, 6]);
  });

  it("keeps cleanup active after a false audio close and retries without blocking transport close", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseResults = [false, true];

    await expect(harness.runtime.cleanup()).rejects.toThrow("G2 audio close failed");
    expect(transport.closed).toBe(true);
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
    expect(harness.runtime.snapshot.audioOpen).toBe(true);
    expect(harness.operations.indexOf("close")).toBeLessThan(
      harness.operations.lastIndexOf("audio:close"),
    );

    await harness.runtime.cleanup();
    expect(harness.runtime.snapshot.audioOpen).toBe(false);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(2);
  });

  it("retains a transport close failure for a later cleanup retry", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    let closeAttempts = 0;
    transport.closeImplementation = () => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error("transport close failed");
    };

    await expect(harness.runtime.cleanup()).rejects.toThrow("transport close failed");
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
    expect(closeAttempts).toBe(1);

    await harness.runtime.cleanup();
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(closeAttempts).toBe(2);
  });

  it.each([undefined, null])(
    "normalizes %s from a transport-close failure",
    async (failure) => {
      const harness = createHarness();
      const transport = await selectSpanishAndStart(harness);
      let closeAttempts = 0;
      transport.closeImplementation = () => {
        closeAttempts += 1;
        if (closeAttempts === 1) throw failure;
      };

      await expect(harness.runtime.cleanup()).rejects.toThrow("G2 transport close failed");
      expect(harness.runtime.snapshot.cleanupState).toBe("active");
      await harness.runtime.cleanup();
      expect(closeAttempts).toBe(2);
      expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    },
  );

  it("ignores callbacks from a replaced transport", async () => {
    const harness = createHarness();
    const firstTransport = await selectSpanishAndStart(harness);
    firstTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    firstTransport.emit({
      type: "transport.lost",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
    } as unknown as RelayTransportCallbackEvent);
    await harness.runtime.whenEventsIdle();
    const secondTransport = harness.transports[1];
    expect(secondTransport).toBeDefined();

    firstTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.sessionReady).toBe(false);

    secondTransport?.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.sessionReady).toBe(true);
  });

  it("does not let target persistence block session start", async () => {
    const pendingPersistence = new Promise<void>(() => undefined);
    const harness = createHarness({ persistTarget: () => pendingPersistence });
    await boot(harness);

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.transports).toHaveLength(1);
    expect(harness.transports[0]?.calls).toContain("start-session:es");
  });

  it.each([
    OsEventTypeList.SYSTEM_EXIT_EVENT,
    OsEventTypeList.ABNORMAL_EXIT_EVENT,
  ])("closes a pending session start during %s", async (exitEventType) => {
    let rejectStart: ((error: Error) => void) | undefined;
    const pendingStart = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    const harness = createHarness({ startSession: async () => pendingStart });
    await boot(harness);

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    const transport = harness.transports[0];
    if (transport === undefined) throw new Error("Transport was not created");

    harness.bridge.emit(systemEvent(exitEventType));
    await harness.runtime.whenEventsIdle();
    expect(transport.closed).toBe(true);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");

    rejectStart?.(new Error("ticket request failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it("does not apply a reducer event that was already queued when cleanup began", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.sessionReady).toBe(true);

    transport.emit({
      type: "session.rejected",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      code: "state_unavailable",
      displaySafeMessage: "rejected",
    } as RelayTransportCallbackEvent);
    await harness.runtime.cleanup();
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Ready");
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it("handles a pending session-start rejection before a later cleanup", async () => {
    let rejectStart: ((error: Error) => void) | undefined;
    const pendingStart = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    const harness = createHarness({ startSession: async () => pendingStart });
    await boot(harness);
    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    const transport = harness.transports[0];
    if (transport === undefined) throw new Error("Transport was not created");

    rejectStart?.(new Error("ticket request failed"));
    await Promise.resolve();
    await Promise.resolve();
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(transport.closed).toBe(true);

    await harness.runtime.cleanup();
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it("preserves bridge arrival order and ignores events after cleanup", async () => {
    const harness = createHarness();
    await boot(harness);

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    harness.bridge.emit(systemEvent(OsEventTypeList.SYSTEM_EXIT_EVENT));
    await harness.runtime.whenEventsIdle();

    const transport = harness.transports[0];
    expect(transport).toBeDefined();
    expect(transport?.closed).toBe(true);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");

    const stateAfterCleanup = harness.runtime.snapshot.state;
    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe(stateAfterCleanup);
    expect(harness.transports).toHaveLength(1);
  });

  it("routes transcript, translation, and suggestion events through the state machine", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    transport.emit(utteranceEvent("transcript.partial", "hola mundo"));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.lastDisplayContent.source).toContain("hola mundo");

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    transport.emit(utteranceEvent());
    transport.emit(languageDecision());
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Translating");

    transport.emit(translationReady());
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.lastDisplayContent.english).toContain("hello");
    transport.emit(suggestionsReady());
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Results");
    expect(harness.runtime.snapshot.lastDisplayContent.suggestion).toContain("hello → hola");
  });

  it("cycles the selected result suggestion with a swipe", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    transport.emit(utteranceEvent());
    transport.emit(languageDecision());
    transport.emit(translationReady());
    transport.emit(suggestionsReady());
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(listEvent(OsEventTypeList.SCROLL_BOTTOM_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.lastDisplayContent.suggestion).toContain("hi → buenas");
  });

  it.each([
    OsEventTypeList.SYSTEM_EXIT_EVENT,
    OsEventTypeList.ABNORMAL_EXIT_EVENT,
  ])("cleans transport, audio, and subscription for system event %s", async (eventType) => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(eventType));
    await harness.runtime.whenEventsIdle();

    expect(transport.closed).toBe(true);
    expect(harness.bridge.audioCalls.at(-1)?.isOpen).toBe(false);
    expect(harness.bridge.unsubscribeCount).toBe(1);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(harness.runtime.snapshot.hasEventSubscription).toBe(false);

    await harness.runtime.cleanup();
    await harness.runtime.cleanup();
    expect(transport.closed).toBe(true);
    expect(harness.bridge.unsubscribeCount).toBe(1);
  });

  it.each([
    new Error("unsubscribe failed"),
    undefined,
    null,
  ])("normalizes and retries an unsubscribe failure: %s", async (failure) => {
    const harness = createHarness();
    await boot(harness);
    harness.bridge.unsubscribeImplementation = () => {
      throw failure;
    };

    const expectedFailure = failure instanceof Error
      ? failure.message
      : "G2 event subscription unsubscribe failed";
    await expect(harness.runtime.cleanup()).rejects.toThrow(expectedFailure);
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
    expect(harness.runtime.snapshot.hasEventSubscription).toBe(true);
    expect(harness.bridge.unsubscribeCount).toBe(1);

    harness.bridge.unsubscribeImplementation = undefined;
    await harness.runtime.cleanup();
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(harness.runtime.snapshot.hasEventSubscription).toBe(false);
    expect(harness.bridge.unsubscribeCount).toBe(2);
  });

  it("keeps the subscription when root double-click shutdown mode 1 is cancelled", async () => {
    const harness = createHarness();
    let resolveShutdown: ((result: boolean) => void) | undefined;
    harness.bridge.shutdownImplementation = () => new Promise<boolean>((resolve) => {
      resolveShutdown = resolve;
    });
    await boot(harness);

    harness.bridge.emit(systemEvent(
      OsEventTypeList.DOUBLE_CLICK_EVENT,
      EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
    ));
    await Promise.resolve();
    expect(harness.bridge.shutdownModes).toEqual([1]);
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
    resolveShutdown?.(false);
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.lastExitRequestResult).toBe(false);
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
    expect(harness.bridge.unsubscribeCount).toBe(0);
  });

  it("processes a queued system exit after a successful shutdown request", async () => {
    const harness = createHarness();
    let resolveShutdown: ((result: boolean) => void) | undefined;
    harness.bridge.shutdownImplementation = () => new Promise<boolean>((resolve) => {
      resolveShutdown = resolve;
    });
    await boot(harness);

    harness.bridge.emit(systemEvent(
      OsEventTypeList.DOUBLE_CLICK_EVENT,
      EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
    ));
    harness.bridge.emit(systemEvent(OsEventTypeList.SYSTEM_EXIT_EVENT));
    await Promise.resolve();
    resolveShutdown?.(true);
    harness.bridge.shutdownImplementation = () => Promise.resolve(true);
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.lastExitRequestResult).toBe(true);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(harness.bridge.unsubscribeCount).toBe(1);
  });

  it("does not let an unresolved mode-1 shutdown block system-exit cleanup", async () => {
    const harness = createHarness();
    const pendingShutdown = new Promise<boolean>(() => undefined);
    harness.bridge.shutdownImplementation = async (exitMode) =>
      exitMode === 1 ? pendingShutdown : true;
    await boot(harness);

    harness.bridge.emit(systemEvent(
      OsEventTypeList.DOUBLE_CLICK_EVENT,
      EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
    ));
    harness.bridge.emit(systemEvent(OsEventTypeList.SYSTEM_EXIT_EVENT));
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(harness.bridge.unsubscribeCount).toBe(1);
  });

  it("handles repeated system and abnormal exit notifications idempotently", async () => {
    const harness = createHarness();
    await boot(harness);

    harness.bridge.emit(systemEvent(OsEventTypeList.SYSTEM_EXIT_EVENT));
    harness.bridge.emit(systemEvent(OsEventTypeList.ABNORMAL_EXIT_EVENT));
    harness.bridge.emit(systemEvent(OsEventTypeList.SYSTEM_EXIT_EVENT));
    await harness.runtime.whenEventsIdle();
    await harness.runtime.cleanup();

    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(harness.bridge.unsubscribeCount).toBe(1);
  });
});

describe("G2BridgeRuntime event normalization", () => {
  it("makes an undefined list event diagnostic from TargetSelection", async () => {
    const harness = createHarness();
    await boot(harness);

    harness.bridge.emit(listEvent());
    await harness.runtime.whenEventsIdle();

    expect(harness.transports).toHaveLength(1);
    expect(harness.runtime.snapshot.state).toBe("Ready");
  });

  it("treats undefined text/list event types as press and ignores malformed double-clicks", async () => {
    const harness = createHarness();
    await boot(harness);
    harness.bridge.emit(textEvent());
    await harness.runtime.whenEventsIdle();
    expect(harness.transports).toHaveLength(1);

    harness.bridge.emit(listEvent());
    await harness.runtime.whenEventsIdle();
    expect(harness.transports).toHaveLength(1);

    harness.bridge.emit(systemEvent(OsEventTypeList.DOUBLE_CLICK_EVENT));
    harness.bridge.emit(textEvent(OsEventTypeList.DOUBLE_CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.bridge.shutdownModes).toEqual([]);
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
  });

  it("ignores a double-click from an invalid source", async () => {
    const harness = createHarness();
    await boot(harness);

    harness.bridge.emit(systemEvent(
      OsEventTypeList.DOUBLE_CLICK_EVENT,
      "invalid-source" as unknown as EventSourceType,
    ));
    await harness.runtime.whenEventsIdle();

    expect(harness.bridge.shutdownModes).toEqual([]);
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
  });
});
