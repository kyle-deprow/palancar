import {
  EventSourceType,
  OsEventTypeList,
  StartUpPageCreateResult,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";

import { PAGE_LAYOUTS } from "../display/index.js";
import { toStartUpPageContainer } from "./sdk-layout.js";

export const PALANCAR_G2_READY = "PALANCAR_G2_READY";

export type G2BridgePort = Pick<
  EvenAppBridge,
  | "createStartUpPageContainer"
  | "onEvenHubEvent"
  | "shutDownPageContainer"
>;

export type BridgeBootState = "idle" | "booting" | "ready" | "failed";
export type BridgeCleanupState = "active" | "cleaned";

export interface BridgeRuntimeSnapshot {
  readonly bootState: BridgeBootState;
  readonly cleanupState: BridgeCleanupState;
  readonly startupAttempts: number;
  readonly hasEventSubscription: boolean;
  readonly lastExitRequestResult: boolean | undefined;
}
export interface G2BridgeRuntimeOptions {
  readonly waitForBridge?: () => Promise<G2BridgePort>;
  readonly readyLogger?: (marker: typeof PALANCAR_G2_READY) => void;
}

export class BridgeStartupError extends Error {
  readonly result: StartUpPageCreateResult | undefined;
  override readonly cause: unknown;

  constructor(
    message: string,
    result: StartUpPageCreateResult | undefined,
    cause?: unknown,
  ) {
    super(message);
    this.name = "BridgeStartupError";
    this.result = result;
    this.cause = cause;
  }
}

const isValidExitSource = (source: EventSourceType | undefined): boolean =>
  source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R ||
  source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L ||
  source === EventSourceType.TOUCH_EVENT_FROM_RING;

export class G2BridgeRuntime {
  readonly #waitForBridge: () => Promise<G2BridgePort>;
  readonly #readyLogger: (marker: typeof PALANCAR_G2_READY) => void;
  readonly #startupContainer = toStartUpPageContainer(PAGE_LAYOUTS.Starting);
  #bridge: G2BridgePort | undefined;
  #bootPromise: Promise<void> | undefined;
  #cleanupPromise: Promise<void> | undefined;
  #unsubscribe: (() => void) | undefined;
  #eventTail: Promise<void> = Promise.resolve();
  #lastEventError: unknown;
  #bootState: BridgeBootState = "idle";
  #cleanupState: BridgeCleanupState = "active";
  #startupAttempts = 0;
  #lastExitRequestResult: boolean | undefined;

  constructor(options: G2BridgeRuntimeOptions = {}) {
    this.#waitForBridge = options.waitForBridge ?? waitForEvenAppBridge;
    this.#readyLogger = options.readyLogger ?? ((marker) => console.info(marker));
  }

  get snapshot(): BridgeRuntimeSnapshot {
    return Object.freeze({
      bootState: this.#bootState,
      cleanupState: this.#cleanupState,
      startupAttempts: this.#startupAttempts,
      hasEventSubscription: this.#unsubscribe !== undefined,
      lastExitRequestResult: this.#lastExitRequestResult,
    });
  }

  boot(): Promise<void> {
    this.#bootPromise ??= this.#bootOnce();
    return this.#bootPromise;
  }

  cleanup(): Promise<void> {
    this.#cleanupPromise ??= this.#cleanupOnce();
    return this.#cleanupPromise;
  }

  async whenEventsIdle(): Promise<void> {
    await this.#eventTail;
    if (this.#lastEventError !== undefined) throw this.#lastEventError;
  }

  async #bootOnce(): Promise<void> {
    this.#bootState = "booting";
    try {
      const bridge = await this.#waitForBridge();
      this.#bridge = bridge;
      this.#startupAttempts += 1;
      const result = await bridge.createStartUpPageContainer(this.#startupContainer);
      if (result !== StartUpPageCreateResult.success) {
        throw new BridgeStartupError(
          "G2 startup page creation failed",
          result,
        );
      }
      if (this.#cleanupState === "cleaned") {
        throw new BridgeStartupError(
          "G2 bridge runtime was cleaned during startup",
          undefined,
        );
      }
      this.#unsubscribe = bridge.onEvenHubEvent((event) => this.#queueEvent(event));
      this.#bootState = "ready";
    } catch (error: unknown) {
      this.#bootState = "failed";
      if (error instanceof BridgeStartupError) throw error;
      throw new BridgeStartupError(
        "G2 bridge startup failed",
        undefined,
        error,
      );
    }
    this.#readyLogger(PALANCAR_G2_READY);
  }

  async #cleanupOnce(): Promise<void> {
    if (this.#cleanupState === "cleaned") return;
    this.#cleanupState = "cleaned";
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    unsubscribe?.();
  }

  #queueEvent(event: EvenHubEvent): void {
    if (this.#cleanupState === "cleaned") return;
    const operation = this.#eventTail.then(() => this.#handleEvent(event));
    this.#eventTail = operation.catch((error: unknown) => {
      this.#lastEventError = error;
    });
  }

  async #handleEvent(event: EvenHubEvent): Promise<void> {
    if (this.#cleanupState === "cleaned") return;
    const systemEvent = event.sysEvent;
    if (systemEvent === undefined) return;

    if (
      systemEvent.eventType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
      systemEvent.eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT
    ) {
      await this.cleanup();
      return;
    }

    if (
      systemEvent.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT &&
      isValidExitSource(systemEvent.eventSource)
    ) {
      const bridge = this.#bridge;
      if (bridge === undefined) return;
      this.#lastExitRequestResult = await bridge.shutDownPageContainer(1);
    }
  }
}
