import {
  EventSourceType,
  OsEventTypeList,
  StartUpPageCreateResult,
  Sys_ItemEvent,
  Text_ItemEvent,
  type CreateStartUpPageContainer,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { describe, expect, it } from "vitest";

import {
  BridgeStartupError,
  G2BridgeRuntime,
  PALANCAR_G2_READY,
  type G2BridgePort,
} from "../src/bridge/index.js";
import { PAGE_LAYOUTS } from "../src/display/index.js";

class FakeBridge implements G2BridgePort {
  startupResult = StartUpPageCreateResult.success;
  shutdownResult = true;
  shutdownImplementation: (() => Promise<boolean>) | undefined;
  readonly calls: string[] = [];
  readonly startupContainers: CreateStartUpPageContainer[] = [];
  createCount = 0;
  subscriptionCount = 0;
  unsubscribeCount = 0;
  shutdownModes: number[] = [];
  #eventHandler: ((event: EvenHubEvent) => void) | undefined;

  async createStartUpPageContainer(
    container: CreateStartUpPageContainer,
  ): Promise<StartUpPageCreateResult> {
    this.calls.push("create");
    this.createCount += 1;
    this.startupContainers.push(container);
    return this.startupResult;
  }

  onEvenHubEvent(callback: (event: EvenHubEvent) => void): () => void {
    this.calls.push("subscribe");
    this.subscriptionCount += 1;
    this.#eventHandler = callback;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.calls.push("unsubscribe");
      this.unsubscribeCount += 1;
      this.#eventHandler = undefined;
    };
  }

  async shutDownPageContainer(exitMode = 0): Promise<boolean> {
    this.calls.push("shutdown:start");
    this.shutdownModes.push(exitMode);
    const result = this.shutdownImplementation === undefined
      ? this.shutdownResult
      : await this.shutdownImplementation();
    this.calls.push("shutdown:end");
    return result;
  }

  emit(event: EvenHubEvent): void {
    this.#eventHandler?.(event);
  }
}

const systemEvent = (
  eventType: OsEventTypeList,
  eventSource?: EventSourceType,
): EvenHubEvent => ({
  sysEvent: new Sys_ItemEvent(
    eventSource === undefined ? { eventType } : { eventType, eventSource },
  ),
});

const validDoubleClick = (): EvenHubEvent =>
  systemEvent(
    OsEventTypeList.DOUBLE_CLICK_EVENT,
    EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
  );

const createRuntime = (
  bridge: FakeBridge,
  order: string[] = bridge.calls,
): G2BridgeRuntime =>
  new G2BridgeRuntime({
    waitForBridge: async () => {
      order.push("wait");
      return bridge;
    },
    readyLogger: (marker) => order.push(`ready:${marker}`),
  });

describe("G2BridgeRuntime startup", () => {
  it("creates the Starting page and subscribes exactly once before readiness", async () => {
    const bridge = new FakeBridge();
    const runtime = createRuntime(bridge);

    const firstBoot = runtime.boot();
    const secondBoot = runtime.boot();
    expect(secondBoot).toBe(firstBoot);
    await Promise.all([firstBoot, secondBoot]);

    expect(bridge.calls).toEqual([
      "wait",
      "create",
      "subscribe",
      `ready:${PALANCAR_G2_READY}`,
    ]);
    expect(bridge.createCount).toBe(1);
    expect(bridge.subscriptionCount).toBe(1);
    expect(bridge.startupContainers).toHaveLength(1);
    const startup = bridge.startupContainers[0];
    expect(startup?.containerTotalNum).toBe(PAGE_LAYOUTS.Starting.containerTotalNum);
    expect(startup?.textObject?.map((container) => container.content)).toEqual(
      PAGE_LAYOUTS.Starting.textObject.map((container) => container.content),
    );
    expect(runtime.snapshot).toEqual({
      bootState: "ready",
      cleanupState: "active",
      startupAttempts: 1,
      hasEventSubscription: true,
      lastExitRequestResult: undefined,
    });
  });

  it("surfaces a typed startup error without subscription, readiness, or retry", async () => {
    const bridge = new FakeBridge();
    bridge.startupResult = StartUpPageCreateResult.invalid;
    const runtime = createRuntime(bridge);

    const firstBoot = runtime.boot();
    await expect(firstBoot).rejects.toMatchObject({
      name: "BridgeStartupError",
      result: StartUpPageCreateResult.invalid,
    });
    expect(runtime.boot()).toBe(firstBoot);
    await expect(runtime.boot()).rejects.toBeInstanceOf(BridgeStartupError);
    expect(bridge.createCount).toBe(1);
    expect(bridge.subscriptionCount).toBe(0);
    expect(bridge.calls).toEqual(["wait", "create"]);
    expect(runtime.snapshot.bootState).toBe("failed");
    expect(runtime.snapshot.startupAttempts).toBe(1);
  });
});

describe("G2BridgeRuntime events and cleanup", () => {
  it("ignores empty, CLICK, malformed double-click, and non-system events", async () => {
    const bridge = new FakeBridge();
    const runtime = createRuntime(bridge);
    await runtime.boot();

    bridge.emit({});
    bridge.emit(systemEvent(
      OsEventTypeList.CLICK_EVENT,
      EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
    ));
    bridge.emit(systemEvent(OsEventTypeList.DOUBLE_CLICK_EVENT));
    bridge.emit(systemEvent(
      OsEventTypeList.DOUBLE_CLICK_EVENT,
      EventSourceType.TOUCH_EVENT_FORM_DUMMY_NULL,
    ));
    bridge.emit({
      textEvent: new Text_ItemEvent({
        eventType: OsEventTypeList.DOUBLE_CLICK_EVENT,
        containerID: 1,
        containerName: "status",
      }),
    });
    await runtime.whenEventsIdle();

    expect(bridge.shutdownModes).toEqual([]);
    expect(runtime.snapshot.cleanupState).toBe("active");
    expect(runtime.snapshot.hasEventSubscription).toBe(true);
  });

  it("requests mode 1 and retains the subscription when the request is cancelled", async () => {
    const bridge = new FakeBridge();
    let resolveShutdown: ((result: boolean) => void) | undefined;
    bridge.shutdownImplementation = () => new Promise<boolean>((resolve) => {
      resolveShutdown = resolve;
    });
    const runtime = createRuntime(bridge);
    await runtime.boot();

    bridge.emit(validDoubleClick());
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.shutdownModes).toEqual([1]);
    expect(bridge.unsubscribeCount).toBe(0);
    expect(runtime.snapshot.cleanupState).toBe("active");

    resolveShutdown?.(false);
    await runtime.whenEventsIdle();
    expect(runtime.snapshot.lastExitRequestResult).toBe(false);
    expect(runtime.snapshot.cleanupState).toBe("active");
    expect(runtime.snapshot.hasEventSubscription).toBe(true);
    expect(bridge.unsubscribeCount).toBe(0);
  });

  it("finishes a mode-1 request before queued system-exit cleanup", async () => {
    const bridge = new FakeBridge();
    let resolveShutdown: ((result: boolean) => void) | undefined;
    bridge.shutdownImplementation = () => new Promise<boolean>((resolve) => {
      resolveShutdown = resolve;
    });
    const runtime = createRuntime(bridge);
    await runtime.boot();

    bridge.emit(validDoubleClick());
    bridge.emit(systemEvent(OsEventTypeList.SYSTEM_EXIT_EVENT));
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.calls).toContain("shutdown:start");
    expect(bridge.unsubscribeCount).toBe(0);

    resolveShutdown?.(true);
    await runtime.whenEventsIdle();
    expect(bridge.calls.slice(-3)).toEqual([
      "shutdown:start",
      "shutdown:end",
      "unsubscribe",
    ]);
    expect(runtime.snapshot.cleanupState).toBe("cleaned");
    expect(runtime.snapshot.hasEventSubscription).toBe(false);
  });

  it.each([
    OsEventTypeList.SYSTEM_EXIT_EVENT,
    OsEventTypeList.ABNORMAL_EXIT_EVENT,
  ])("cleans up idempotently for system event %s", async (eventType) => {
    const bridge = new FakeBridge();
    const runtime = createRuntime(bridge);
    await runtime.boot();

    bridge.emit(systemEvent(eventType));
    bridge.emit(systemEvent(eventType));
    await runtime.whenEventsIdle();
    const firstCleanup = runtime.cleanup();
    const secondCleanup = runtime.cleanup();
    expect(secondCleanup).toBe(firstCleanup);
    await Promise.all([firstCleanup, secondCleanup]);

    expect(bridge.unsubscribeCount).toBe(1);
    expect(runtime.snapshot.cleanupState).toBe("cleaned");
    expect(runtime.snapshot.hasEventSubscription).toBe(false);
  });
});
