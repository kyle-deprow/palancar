import {
  AudioInputSource,
  EventSourceType,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import {
  getLanguageDefinition,
  type TargetLanguage,
} from "@palancar/language-registry";

import { PAGE_LAYOUTS } from "../display/index.js";
import {
  createInitialState,
  reduceClientState,
  type ClientEffect,
  type ClientEvent,
  type ClientState,
} from "../state/index.js";
import {
  createRelayTransport,
  type RelayTransport,
  type RelayTransportCallbackEvent,
  type RelayTransportOptions,
} from "../transport/index.js";
import { toStartUpPageContainer } from "./sdk-layout.js";

export const PALANCAR_G2_READY = "PALANCAR_G2_READY";
export const DEFAULT_RELAY_ORIGIN =
  "https://ca-palancar-dev-relay-aeeacd8c.graysmoke-757a2980.eastus2.azurecontainerapps.io";

const TARGET_STORAGE_KEY = "palancar.target-language";
const DISPLAY_DEBOUNCE_MS = 175;
const DISPLAY_MAX_TEXT_LENGTH = 120;
const AUDIO_CLOSE_TIMEOUT_MS = 1_000;
const BRIDGE_CLEANUP_TIMEOUT_MS = 1_000;
const DISPLAY_UPGRADE_TIMEOUT_MS = 1_000;
const MAX_QUEUED_EVENTS = 64;

const CLEANUP_PREEMPTED = Symbol("cleanup-preempted");

type TransportCloseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: Error };

function normalizeError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(`${fallbackMessage} (undefined rejection)`);
  if (error === null) return new Error(`${fallbackMessage} (null rejection)`);
  try {
    return new Error(`${fallbackMessage}: ${String(error)}`);
  } catch {
    return new Error(fallbackMessage);
  }
}

export type G2BridgePort = Pick<
  EvenAppBridge,
  | "createStartUpPageContainer"
  | "onEvenHubEvent"
  | "shutDownPageContainer"
  | "textContainerUpgrade"
  | "audioControl"
>;

export type BridgeBootState = "idle" | "booting" | "ready" | "failed";
export type BridgeCleanupState = "active" | "cleaned";

export interface BridgeRuntimeSnapshot {
  readonly bootState: BridgeBootState;
  readonly cleanupState: BridgeCleanupState;
  readonly startupAttempts: number;
  readonly hasEventSubscription: boolean;
  readonly lastExitRequestResult: boolean | undefined;
  readonly state: ClientState["state"];
  readonly target: TargetLanguage | undefined;
  readonly sessionReady: boolean;
  readonly audioOpen: boolean;
  readonly displayUpdateCount: number;
  readonly lastDisplayContent: Readonly<Record<string, string>>;
  readonly cleanupWaiterCount: number;
}

export interface G2TargetStorage {
  readonly getTarget?: () => unknown | Promise<unknown>;
  readonly setTarget?: (targetLanguage: TargetLanguage) => void | Promise<void>;
  readonly getItem?: (key: string) => string | null | Promise<string | null>;
  readonly setItem?: (key: string, value: string) => void | Promise<void>;
}

export interface G2Transport {
  startSession(targetLanguage: TargetLanguage): Promise<void>;
  startUtterance(utteranceId: string): void;
  pushPcm(pcm: Uint8Array): void;
  commitUtterance(): void;
  cancelUtterance(): void;
  endSession(reason?: "user_requested" | "app_shutdown" | "transport_error"): void;
  close(): void;
}

export type G2TransportFactory = (
  options: RelayTransportOptions,
) => G2Transport;

export interface G2BridgeRuntimeOptions {
  readonly waitForBridge?: () => Promise<G2BridgePort>;
  readonly readyLogger?:
    (marker: typeof PALANCAR_G2_READY) => unknown | Promise<unknown>;
  readonly createTransport?: G2TransportFactory;
  readonly idGenerator?: () => string;
  readonly relayOrigin?: string;
  readonly storage?: G2TargetStorage;
  readonly displayDebounceMs?: number;
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

const isEventType = (
  eventType: OsEventTypeList | undefined,
  expected: OsEventTypeList,
): boolean => eventType === expected;

export function isPairedTurnEffects(
  stopEffect: ClientEffect,
  commitEffect: ClientEffect,
): boolean {
  return stopEffect.type === "stop-audio" &&
    commitEffect.type === "commit-utterance" &&
    stopEffect.sessionId === commitEffect.sessionId &&
    stopEffect.sessionEpoch === commitEffect.sessionEpoch &&
    stopEffect.utteranceId === commitEffect.utteranceId;
}

function randomUuidV4(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw new Error("Secure randomness is unavailable");
  }
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function compact(value: string, maxLength = DISPLAY_MAX_TEXT_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (maxLength <= 0) return "";
  const characters = Array.from(normalized);
  if (characters.length <= maxLength) return normalized;
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

function targetName(target: TargetLanguage | undefined): string {
  return target === undefined
    ? "Spanish / Turkish"
    : getLanguageDefinition(target)?.displayName ?? target;
}

function targetForState(state: ClientState): TargetLanguage | undefined {
  switch (state.state) {
    case "Starting":
    case "TargetSelection":
      return state.highlightedTarget;
    case "Ready":
    case "Listening":
    case "Finalizing":
    case "Translating":
    case "Results":
    case "Recovering":
    case "Error":
      return state.targetLanguage;
  }
}

function sessionReadyForState(state: ClientState): boolean {
  return state.state === "Ready" && state.sessionReady;
}

function displayTexts(state: ClientState): readonly string[] {
  const target = targetForState(state);
  const targetLine = `Target: ${targetName(target)}`;
  switch (state.state) {
    case "Starting":
      return [
        "Starting",
        targetLine,
        "Source: waiting",
        "English: waiting",
        "Suggestion: ready",
      ];
    case "TargetSelection":
      return [
        "Choose target",
        target === "tr" ? "Target: Spanish / [Turkish]" : "Target: [Spanish] / Turkish",
        "Press to confirm",
        "Swipe to change",
        "press to confirm, swipe to change",
      ];
    case "Ready":
      return [
        state.message === undefined ? "Ready" : compact(`Ready: ${state.message}`),
        targetLine,
        "Press to begin",
        "English: waiting",
        "Suggestion: ready",
      ];
    case "Listening":
      return [
        "Listening",
        targetLine,
        compact(state.transcript === "" ? "Source: listening..." : `Source: ${state.transcript}`),
        "English: waiting",
        "Press when finished",
      ];
    case "Finalizing":
      return [
        "Finalizing",
        targetLine,
        compact(state.transcript === "" ? "Source: finalizing..." : `Source: ${state.transcript}`),
        "English: waiting",
        "Please wait",
      ];
    case "Translating":
      return [
        "Translating",
        targetLine,
        compact(`Source: ${state.finalTranscript ?? state.transcript}`),
        compact(`English: ${state.englishTranslation ?? "translating..."}`),
        "Please wait",
      ];
    case "Results": {
      const suggestion = state.suggestions[state.suggestionIndex];
      return [
        "Results",
        targetLine,
        compact(`Source: ${state.finalTranscript ?? state.transcript}`),
        compact(`English: ${state.englishTranslation}`),
        suggestion === undefined
          ? "No suggestion"
          : compact(`${suggestion.englishText} → ${suggestion.selectedTargetText}`),
      ];
    }
    case "Recovering":
      return [
        compact(`Recovering: ${state.message}`),
        targetLine,
        "Source: unavailable",
        "English: unavailable",
        "Reconnecting",
      ];
    case "Error":
      return [
        compact(`Error: ${state.message}`),
        targetLine,
        "Source: unavailable",
        "English: unavailable",
        "Try again",
      ];
  }
}

const displayTargets = Object.freeze(
  PAGE_LAYOUTS.Starting.textObject.map(({ containerID, containerName }) =>
    Object.freeze({ containerID, containerName }),
  ),
);

function displayContent(state: ClientState): Readonly<Record<string, string>> {
  const texts = displayTexts(state);
  const content: Record<string, string> = {};
  for (let index = 0; index < displayTargets.length; index += 1) {
    const target = displayTargets[index];
    if (target === undefined) continue;
    content[target.containerName] = compact(texts[index] ?? "");
  }
  return Object.freeze(content);
}

function sameDisplayContent(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  for (const target of displayTargets) {
    if (left[target.containerName] !== right[target.containerName]) return false;
  }
  return true;
}

function defaultStorage(): G2TargetStorage | undefined {
  try {
    if (globalThis.localStorage === undefined) return undefined;
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export class G2BridgeRuntime {
  readonly #waitForBridge: () => Promise<G2BridgePort>;
  readonly #readyLogger: (marker: typeof PALANCAR_G2_READY) => unknown | Promise<unknown>;
  readonly #createTransport: G2TransportFactory;
  readonly #idGenerator: () => string;
  readonly #relayOrigin: string;
  readonly #storage: G2TargetStorage | undefined;
  readonly #displayDebounceMs: number;
  readonly #startupContainer = toStartUpPageContainer(PAGE_LAYOUTS.Starting);
  #bridge: G2BridgePort | undefined;
  #transport: G2Transport | undefined;
  readonly #pendingTransportStarts = new Set<G2Transport>();
  readonly #pendingTransportCloses = new Set<G2Transport>();
  #bootPromise: Promise<void> | undefined;
  #cleanupPromise: Promise<void> | undefined;
  #unsubscribe: (() => void) | undefined;
  #pendingShutdown: Promise<boolean> | undefined;
  #eventTail: Promise<void> = Promise.resolve();
  #queuedEventCount = 0;
  #eventQueueOverflowed = false;
  #lastEventError: Error | undefined;
  #bootState: BridgeBootState = "idle";
  #cleanupState: BridgeCleanupState = "active";
  #startupAttempts = 0;
  #lastExitRequestResult: boolean | undefined;
  #state: ClientState = createInitialState();
  #audioOpen = false;
  #audioOpenUncertain = false;
  #audioPcmEnabled = false;
  #pendingAudioOpen: Promise<void> | undefined;
  #pendingAudioClose: Promise<boolean> | undefined;
  #audioCloseRequired = false;
  #audioPcmFaultTransport: G2Transport | undefined;
  #displayTimer: ReturnType<typeof setTimeout> | undefined;
  #displayTimerPromise: Promise<void> | undefined;
  #displayTimerResolve: (() => void) | undefined;
  #pendingDisplayState: ClientState | undefined;
  #displayTail: Promise<void> = Promise.resolve();
  #displayAvailable = false;
  #displayFault: Error | undefined;
  #displayInProgress = false;
  #displayInFlightContent: Readonly<Record<string, string>> | undefined;
  #displayUpdateCount = 0;
  #lastDisplayContent: Readonly<Record<string, string>> = Object.freeze({});
  #cleanupInProgress = false;
  #cleanupRequested = false;
  #cleanupSignalResolve: (() => void) | undefined;
  readonly #cleanupSignal = new Promise<void>((resolve) => {
    this.#cleanupSignalResolve = resolve;
  });
  readonly #cleanupWaiters = new Set<() => void>();
  #startupContainerCreated = false;
  #pendingStartupCreation: Promise<StartUpPageCreateResult> | undefined;
  #startupTeardownPromise: Promise<void> | undefined;
  #audioCloseGeneration = 0;
  #detachedAudioCloseMonitor: Promise<void> | undefined;
  #detachedAudioCloseTimer: ReturnType<typeof setTimeout> | undefined;
  #detachedAudioCloseMonitorGeneration: number | undefined;
  #detachedAudioCloseFailureGeneration: number | undefined;

  constructor(options: G2BridgeRuntimeOptions = {}) {
    this.#waitForBridge = options.waitForBridge ?? waitForEvenAppBridge;
    this.#readyLogger = options.readyLogger ?? ((marker) => console.info(marker));
    this.#createTransport = options.createTransport ?? ((transportOptions) =>
      createRelayTransport(transportOptions) as RelayTransport);
    this.#idGenerator = options.idGenerator ?? randomUuidV4;
    this.#relayOrigin = options.relayOrigin ?? DEFAULT_RELAY_ORIGIN;
    this.#storage = options.storage ?? defaultStorage();
    const displayDebounceMs = options.displayDebounceMs ?? DISPLAY_DEBOUNCE_MS;
    if (!Number.isFinite(displayDebounceMs) || displayDebounceMs < 0) {
      throw new RangeError("displayDebounceMs must be non-negative");
    }
    this.#displayDebounceMs = displayDebounceMs;
  }

  get snapshot(): BridgeRuntimeSnapshot {
    return Object.freeze({
      bootState: this.#bootState,
      cleanupState: this.#cleanupState,
      startupAttempts: this.#startupAttempts,
      hasEventSubscription: this.#unsubscribe !== undefined,
      lastExitRequestResult: this.#lastExitRequestResult,
      state: this.#state.state,
      target: targetForState(this.#state),
      sessionReady: sessionReadyForState(this.#state),
      audioOpen: this.#audioOpen,
      displayUpdateCount: this.#displayUpdateCount,
      lastDisplayContent: Object.freeze({ ...this.#lastDisplayContent }),
      cleanupWaiterCount: this.#cleanupWaiters.size,
    });
  }

  boot(): Promise<void> {
    this.#bootPromise ??= this.#bootOnce();
    return this.#bootPromise;
  }

  cleanup(): Promise<void> {
    const existing = this.#cleanupPromise;
    if (existing !== undefined) return existing;
    const cleanupPromise = this.#cleanupOnce();
    this.#cleanupPromise = cleanupPromise;
    void cleanupPromise.then(
      () => {
        if (this.#cleanupPromise === cleanupPromise) this.#cleanupPromise = undefined;
      },
      () => {
        if (this.#cleanupPromise === cleanupPromise) this.#cleanupPromise = undefined;
      },
    );
    return cleanupPromise;
  }

  async whenEventsIdle(): Promise<void> {
    if (this.#cleanupRequested || this.#cleanupInProgress) {
      const cleanupPromise = this.#cleanupPromise;
      if (cleanupPromise !== undefined) {
        try {
          await cleanupPromise;
        } catch (error: unknown) {
          if (this.#lastEventError === undefined) {
            this.#lastEventError = normalizeError(error, "G2 cleanup failed");
          }
        }
      }
      if (this.#lastEventError !== undefined) throw this.#lastEventError;
      return;
    }

    while (true) {
      const eventTail = this.#eventTail;
      const cleanupPreempted = await this.#awaitEventTailOrCleanup(eventTail);
      if (cleanupPreempted || this.#cleanupRequested || this.#cleanupInProgress) {
        const cleanupPromise = this.#cleanupPromise;
        if (cleanupPromise !== undefined) {
          try {
            await cleanupPromise;
          } catch (error: unknown) {
            if (this.#lastEventError === undefined) {
              this.#lastEventError = normalizeError(error, "G2 cleanup failed");
            }
          }
        }
        break;
      }
      if (this.#cleanupState === "cleaned" || this.#bootState === "failed") break;
      const displayTimer = this.#displayTimerPromise;
      if (displayTimer !== undefined) await displayTimer;
      const displayTail = this.#displayTail;
      await displayTail;
      if (
        eventTail === this.#eventTail &&
        displayTimer === this.#displayTimerPromise &&
        this.#pendingDisplayState === undefined &&
        !this.#displayInProgress
      ) break;
    }
    if (this.#lastEventError !== undefined) throw this.#lastEventError;
  }

  async #awaitEventTailOrCleanup(eventTail: Promise<void>): Promise<boolean> {
    let cleanupWaiter: (() => void) | undefined;
    const cleanup = new Promise<typeof CLEANUP_PREEMPTED>((resolve) => {
      const waiter = (): void => resolve(CLEANUP_PREEMPTED);
      cleanupWaiter = waiter;
      if (this.#cleanupRequested) {
        resolve(CLEANUP_PREEMPTED);
      } else {
        this.#cleanupWaiters.add(waiter);
      }
    });
    try {
      const result = await Promise.race([eventTail, cleanup]);
      return result === CLEANUP_PREEMPTED;
    } finally {
      if (cleanupWaiter !== undefined) this.#cleanupWaiters.delete(cleanupWaiter);
    }
  }

  async #bootOnce(): Promise<void> {
    this.#bootState = "booting";
    try {
      this.#state = createInitialState(await this.#awaitBootDependency(
        this.#readTarget(),
        "G2 target storage read was interrupted during startup",
      ));
      this.#assertBootActive();
      const bridge = await this.#awaitBootDependency(
        this.#waitForBridge(),
        "G2 bridge arrival was interrupted during startup",
      );
      this.#assertBootActive();
      this.#bridge = bridge;
      this.#startupAttempts += 1;
      const startupCreation = Promise.resolve().then(() =>
        bridge.createStartUpPageContainer(this.#startupContainer));
      this.#pendingStartupCreation = startupCreation;
      void startupCreation.then((result) => {
        if (result === StartUpPageCreateResult.success) {
          this.#startupContainerCreated = true;
          if (this.#isRuntimeInactive()) this.#scheduleCleanupForLateResource();
        }
      }, () => undefined).finally(() => {
        if (this.#pendingStartupCreation === startupCreation) {
          this.#pendingStartupCreation = undefined;
        }
      });
      const result = await this.#awaitBootDependency(
        startupCreation,
        "G2 startup container creation was interrupted",
      );
      if (result === StartUpPageCreateResult.success) this.#startupContainerCreated = true;
      this.#assertBootActive();
      if (result !== StartUpPageCreateResult.success) {
        this.#dispatch({ type: "startup.failed" }, false);
        throw new BridgeStartupError("G2 startup page creation failed", result);
      }
      this.#displayAvailable = true;
      this.#unsubscribe = bridge.onEvenHubEvent((event) => this.#receiveBridgeEvent(event));
      this.#bootState = "ready";
      this.#dispatch({ type: "startup.ready" });
      await this.#awaitBootDependency(
        this.#whenDisplayIdle(),
        "G2 initial display was interrupted during startup",
      );
      if (this.#isRuntimeInactive() || this.#displayFault !== undefined) {
        throw new BridgeStartupError(
          "G2 bridge runtime was cleaned or display failed during startup",
          undefined,
          this.#displayFault,
        );
      }
      try {
        await this.#awaitBootDependency(
          Promise.resolve().then(() => this.#readyLogger(PALANCAR_G2_READY)),
          "G2 bridge ready logging was interrupted during startup",
        );
      } catch (error: unknown) {
        throw new BridgeStartupError(
          "G2 bridge ready logging failed",
          undefined,
          normalizeError(error, "G2 bridge ready logging failed"),
        );
      }
    } catch (error: unknown) {
      await this.#teardownAfterBootFailure();
      this.#bootState = "failed";
      if (error instanceof BridgeStartupError) {
        if (error.cause === undefined && this.#displayFault !== undefined) {
          throw new BridgeStartupError(
            "G2 bridge startup display failed",
            undefined,
            this.#displayFault,
          );
        }
        throw error;
      }
      throw new BridgeStartupError(
        "G2 bridge startup failed",
        undefined,
        normalizeError(error, "G2 bridge startup failed"),
      );
    }
  }

  async #awaitBootDependency<T>(
    dependency: Promise<T>,
    message: string,
  ): Promise<T> {
    const cleanup = this.#cleanupSignal.then(() => {
      throw new BridgeStartupError(message, undefined);
    });
    try {
      return await Promise.race([dependency, cleanup]);
    } finally {
      void cleanup.catch(() => undefined);
    }
  }

  #assertBootActive(): void {
    if (!this.#cleanupRequested && this.#cleanupState !== "cleaned") return;
    throw new BridgeStartupError(
      "G2 bridge runtime was cleaned during startup",
      undefined,
    );
  }

  async #readTarget(): Promise<unknown> {
    const storage = this.#storage;
    if (storage === undefined) return undefined;
    try {
      if (storage.getTarget !== undefined) return await storage.getTarget();
      if (storage.getItem !== undefined) return await storage.getItem(TARGET_STORAGE_KEY);
    } catch {
      // Restored target state is best effort for this development slice.
    }
    return undefined;
  }

  async #persistTarget(targetLanguage: TargetLanguage): Promise<void> {
    const storage = this.#storage;
    if (storage === undefined) return;
    try {
      if (storage.setTarget !== undefined) {
        await storage.setTarget(targetLanguage);
      } else if (storage.setItem !== undefined) {
        await storage.setItem(TARGET_STORAGE_KEY, targetLanguage);
      }
    } catch {
      // Target persistence must not interrupt gesture or transport handling.
    }
  }

  async #teardownAfterBootFailure(): Promise<void> {
    this.#displayAvailable = false;
    if (this.#displayTimer !== undefined) {
      clearTimeout(this.#displayTimer);
      this.#displayTimer = undefined;
      this.#displayTimerResolve?.();
      this.#displayTimerResolve = undefined;
      this.#displayTimerPromise = undefined;
    }
    this.#pendingDisplayState = undefined;

    let cleanupFailure: Error | undefined;
    try {
      await this.#detachEventSubscription();
    } catch (error: unknown) {
      cleanupFailure = normalizeError(error, "G2 event subscription cleanup failed");
      if (this.#lastEventError === undefined) this.#lastEventError = cleanupFailure;
    }

    if (this.#state.state !== "Error") {
      this.#state = reduceClientState(this.#state, { type: "fatal" }).state;
    }
    this.#bootState = "failed";

    const transports = new Set(this.#pendingTransportStarts);
    if (this.#transport !== undefined) transports.add(this.#transport);
    for (const transport of this.#pendingTransportCloses) transports.add(transport);
    this.#transport = undefined;
    this.#pendingTransportStarts.clear();
    for (const transport of transports) {
      const closeResult = this.#tryCloseTransport(transport);
      if (!closeResult.ok && this.#lastEventError === undefined) {
        this.#lastEventError = closeResult.error;
      }
    }

    const pendingStartupCreation = this.#pendingStartupCreation;
    if (pendingStartupCreation !== undefined) {
      try {
        await this.#awaitWithTimeout(
          pendingStartupCreation,
          "G2 startup container creation cleanup timed out",
          BRIDGE_CLEANUP_TIMEOUT_MS,
        );
      } catch (error: unknown) {
        cleanupFailure = normalizeError(
          error,
          "G2 startup container creation cleanup failed",
        );
        if (this.#lastEventError === undefined) this.#lastEventError = cleanupFailure;
      }
    }
    try {
      await this.#closeAudioForCleanup();
    } catch (error: unknown) {
      if (cleanupFailure === undefined) {
        cleanupFailure = normalizeError(error, "G2 audio cleanup failed during startup");
      }
      if (this.#lastEventError === undefined) this.#lastEventError = cleanupFailure;
    }

    try {
      await this.#teardownStartupContainer();
    } catch (error: unknown) {
      const normalized = normalizeError(
        error,
        "G2 startup container cleanup failed during startup",
      );
      if (cleanupFailure === undefined) cleanupFailure = normalized;
      if (this.#lastEventError === undefined) this.#lastEventError = normalized;
    }

    const pendingCleanup = this.#cleanupPromise;
    if (pendingCleanup !== undefined && this.#cleanupInProgress) {
      try {
        await pendingCleanup;
      } catch (error: unknown) {
        const normalized = normalizeError(error, "G2 cleanup failed during startup");
        if (cleanupFailure === undefined) cleanupFailure = normalized;
        if (this.#lastEventError === undefined) this.#lastEventError = normalized;
      }
    }

    if (this.#cleanupRequested && this.#cleanupState !== "cleaned") {
      try {
        await this.cleanup();
      } catch (error: unknown) {
        const normalized = normalizeError(error, "G2 cleanup failed during startup");
        if (cleanupFailure === undefined) cleanupFailure = normalized;
        if (this.#lastEventError === undefined) this.#lastEventError = normalized;
      }
    }

    if (cleanupFailure !== undefined || this.#hasCleanupWork()) {
      this.#cleanupState = "active";
    } else if (this.#cleanupRequested && !this.#cleanupInProgress) {
      this.#cleanupState = "cleaned";
    }
  }

  async #detachEventSubscription(): Promise<void> {
    const unsubscribe = this.#unsubscribe;
    if (unsubscribe === undefined) return;
    try {
      await Promise.resolve(unsubscribe());
      if (this.#unsubscribe === unsubscribe) this.#unsubscribe = undefined;
    } catch (error: unknown) {
      throw normalizeError(error, "G2 event subscription unsubscribe failed");
    }
  }

  #isRuntimeInactive(): boolean {
    return this.#cleanupRequested ||
      this.#displayFault !== undefined ||
      this.#cleanupState === "cleaned" ||
      this.#cleanupInProgress ||
      this.#bootState === "failed";
  }

  async #cleanupOnce(): Promise<void> {
    if (this.#cleanupState === "cleaned") return;
    this.#cleanupInProgress = true;
    this.#cleanupRequested = true;
    this.#cleanupSignalResolve?.();
    this.#cleanupSignalResolve = undefined;
    for (const waiter of this.#cleanupWaiters) waiter();
    this.#cleanupWaiters.clear();
    this.#displayAvailable = false;

    if (this.#displayTimer !== undefined) {
      clearTimeout(this.#displayTimer);
      this.#displayTimer = undefined;
      this.#displayTimerResolve?.();
      this.#displayTimerResolve = undefined;
      this.#displayTimerPromise = undefined;
    }
    this.#pendingDisplayState = undefined;

    let subscriptionFailure: Error | undefined;
    try {
      await this.#detachEventSubscription();
    } catch (error: unknown) {
      subscriptionFailure = normalizeError(error, "G2 event subscription cleanup failed");
    }

    const transports = new Set(this.#pendingTransportStarts);
    if (this.#transport !== undefined) transports.add(this.#transport);
    for (const transport of this.#pendingTransportCloses) transports.add(transport);
    this.#transport = undefined;
    this.#pendingTransportStarts.clear();

    while (true) {
      let cleanupFailure = subscriptionFailure;
      subscriptionFailure = undefined;
      for (const transport of transports) {
        const closeResult = this.#tryCloseTransport(transport);
        if (!closeResult.ok && cleanupFailure === undefined) {
          cleanupFailure = closeResult.error;
        }
      }
      transports.clear();

      try {
        await this.#closeAudioForCleanup();
      } catch (error: unknown) {
        if (cleanupFailure === undefined) {
          cleanupFailure = normalizeError(error, "G2 audio cleanup failed");
        }
      }

      try {
        await this.#teardownStartupContainer();
      } catch (error: unknown) {
        if (cleanupFailure === undefined) {
          cleanupFailure = normalizeError(error, "G2 startup container cleanup failed");
        }
      }

      if (cleanupFailure !== undefined) {
        this.#cleanupInProgress = false;
        this.#cleanupState = "active";
        throw cleanupFailure;
      }

      // An audio open may settle successfully while startup teardown is in
      // flight. Do not publish "cleaned" until that newly-opened device has
      // gone through a close pass as well.
      if (this.#audioOpenUncertain &&
        (this.#audioOpen || this.#audioCloseRequired || this.#pendingAudioOpen !== undefined)) {
        this.#cleanupInProgress = false;
        this.#cleanupState = "active";
        return;
      }
      if (!this.#audioOpenUncertain && this.#hasCleanupWork()) continue;
      break;
    }

    this.#cleanupInProgress = false;
    if (this.#hasCleanupWorkBeyondAudioUncertainty()) {
      this.#cleanupState = "active";
      this.#scheduleCleanupForLateResource();
      return;
    }
    this.#cleanupState = "cleaned";
  }

  #requestCleanup(): void {
    const cleanupPromise = this.cleanup();
    void cleanupPromise.catch((error: unknown) => {
      if (this.#lastEventError === undefined) {
        this.#lastEventError = normalizeError(error, "G2 cleanup failed");
      }
    });
  }

  #tryCloseTransport(transport: G2Transport): TransportCloseResult {
    try {
      transport.close();
      this.#pendingTransportCloses.delete(transport);
      return { ok: true };
    } catch (error: unknown) {
      this.#pendingTransportCloses.add(transport);
      return {
        ok: false,
        error: normalizeError(error, "G2 transport close failed"),
      };
    }
  }

  async #teardownStartupContainer(): Promise<void> {
    if (!this.#startupContainerCreated) return;
    const existing = this.#startupTeardownPromise;
    if (existing !== undefined) return existing;
    const bridge = this.#bridge;
    if (bridge === undefined) throw new Error("G2 bridge is unavailable");

    const teardown = (async () => {
      const shutdown = Promise.resolve()
        .then(() => bridge.shutDownPageContainer(0))
        .catch((error: unknown) => {
          throw normalizeError(error, "G2 startup container teardown failed");
        });
      this.#pendingShutdown = shutdown;
      void shutdown.then(
        (result) => {
          if (result) {
            this.#startupContainerCreated = false;
          }
        },
        () => undefined,
      );
      try {
        const result = await this.#awaitWithTimeout(
          shutdown,
          "G2 startup container teardown timed out",
          BRIDGE_CLEANUP_TIMEOUT_MS,
        );
        if (!result) throw new Error("G2 startup container teardown failed");
        this.#startupContainerCreated = false;
      } finally {
        if (this.#pendingShutdown === shutdown) this.#pendingShutdown = undefined;
      }
    })();
    this.#startupTeardownPromise = teardown;
    try {
      await teardown;
    } finally {
      if (this.#startupTeardownPromise === teardown) {
        this.#startupTeardownPromise = undefined;
      }
    }
  }

  #hasCleanupWork(): boolean {
    return this.#startupContainerCreated ||
      this.#audioOpen ||
      this.#audioOpenUncertain ||
      this.#audioCloseRequired ||
      this.#pendingAudioOpen !== undefined ||
      this.#pendingTransportStarts.size > 0 ||
      this.#pendingTransportCloses.size > 0 ||
      this.#transport !== undefined;
  }

  #hasCleanupWorkBeyondAudioUncertainty(): boolean {
    return this.#startupContainerCreated ||
      this.#audioOpen ||
      this.#audioCloseRequired ||
      this.#pendingAudioOpen !== undefined ||
      this.#pendingTransportStarts.size > 0 ||
      this.#pendingTransportCloses.size > 0 ||
      this.#transport !== undefined;
  }

  #scheduleCleanupForLateResource(): void {
    this.#cleanupState = "active";
    const cleanupPromise = this.#cleanupPromise;
    const retry = (): void => {
      if (this.#cleanupState === "cleaned" || this.#cleanupInProgress) return;
      this.#requestCleanup();
    };
    if (cleanupPromise !== undefined) {
      void cleanupPromise.then(retry, retry);
      return;
    }
    retry();
  }

  #queueEvent(event: EvenHubEvent): void {
    this.#queueSerializedEvent(() => this.#handleEvent(event));
  }

  #queueTransportEvent(
    transport: G2Transport,
    event: RelayTransportCallbackEvent | ClientEvent,
  ): void {
    if (this.#isRuntimeInactive() || this.#transport !== transport) return;
    this.#queueSerializedEvent(async () => {
      if (this.#isRuntimeInactive() || this.#transport !== transport) return;
      const clientEvent = event as ClientEvent;
      await this.#dispatchAndRunEffects(clientEvent);
      if (
        clientEvent.type === "fatal" &&
        !this.#isRuntimeInactive() &&
        this.#transport === transport
      ) {
        this.#endAndCloseTransport("transport_error");
        this.#requestCleanup();
      }
    });
  }

  #queueSerializedEvent(operation: () => void | Promise<void>): void {
    if (this.#isRuntimeInactive()) return;
    if (this.#queuedEventCount >= MAX_QUEUED_EVENTS) {
      this.#handleEventQueueOverflow();
      return;
    }
    this.#queuedEventCount += 1;
    const queuedOperation = this.#eventTail.then(async () => {
      try {
        await operation();
      } finally {
        this.#queuedEventCount -= 1;
      }
    });
    this.#eventTail = queuedOperation.catch((error: unknown) => {
      this.#lastEventError = normalizeError(error, "G2 bridge event handling failed");
    });
  }

  #handleEventQueueOverflow(): void {
    if (this.#eventQueueOverflowed || this.#isRuntimeInactive()) return;
    this.#eventQueueOverflowed = true;
    const transport = this.#transport;
    if (transport !== undefined) {
      this.#failTransport(transport);
      return;
    }
    this.#dispatch({ type: "fatal" });
    this.#requestCleanup();
  }

  #receiveBridgeEvent(event: EvenHubEvent): void {
    const systemEventType = event.sysEvent?.eventType;
    if (
      systemEventType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
      systemEventType === OsEventTypeList.ABNORMAL_EXIT_EVENT
    ) {
      queueMicrotask(() => this.#requestCleanup());
      return;
    }
    if (this.#isRuntimeInactive()) return;

    const audioEvent = event.audioEvent;
    const audioSource = audioEvent?.source;
    const transport = this.#transport;
    if (
      audioEvent?.audioPcm instanceof Uint8Array &&
      this.#audioOpen &&
      this.#audioPcmEnabled &&
      transport !== undefined &&
      this.#audioPcmFaultTransport !== transport &&
      (audioSource === undefined || audioSource === AudioInputSource.Glasses)
    ) {
      const pcm = new Uint8Array(audioEvent.audioPcm);
      try {
        transport.pushPcm(pcm);
      } catch {
        this.#audioPcmFaultTransport = transport;
        this.#queueTransportEvent(transport, { type: "fatal" });
      }
    }

    if (
      event.sysEvent !== undefined ||
      event.textEvent !== undefined ||
      event.listEvent !== undefined
    ) {
      this.#queueEvent({
        ...(event.sysEvent === undefined ? {} : { sysEvent: event.sysEvent }),
        ...(event.textEvent === undefined ? {} : { textEvent: event.textEvent }),
        ...(event.listEvent === undefined ? {} : { listEvent: event.listEvent }),
      });
    }
  }

  async #handleEvent(event: EvenHubEvent): Promise<void> {
    if (this.#isRuntimeInactive()) return;

    const systemEvent = event.sysEvent;
    if (systemEvent !== undefined) {
      if (
        systemEvent.eventType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
        systemEvent.eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT
      ) {
        this.#requestCleanup();
        return;
      }

      if (
        systemEvent.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT &&
        isValidExitSource(systemEvent.eventSource)
      ) {
        const bridge = this.#bridge;
        if (bridge === undefined) return;
        try {
          const shutdown = Promise.resolve(bridge.shutDownPageContainer(1));
          this.#pendingShutdown = shutdown;
          void shutdown.then(
            (result) => {
              this.#lastExitRequestResult = result;
            },
            () => {
              this.#lastExitRequestResult = false;
            },
          );
          const result = await this.#awaitWithCleanup(
            shutdown,
            "G2 exit request timed out",
            BRIDGE_CLEANUP_TIMEOUT_MS,
          );
          if (result !== CLEANUP_PREEMPTED) this.#lastExitRequestResult = result;
        } catch {
          this.#lastExitRequestResult = false;
        } finally {
          this.#pendingShutdown = undefined;
        }
        return;
      }

      const systemGesture = this.#gestureEvent(systemEvent.eventType);
      if (systemGesture !== undefined) {
        await this.#dispatchAndRunEffects(systemGesture);
        return;
      }
    }

    const textEvent = event.textEvent;
    if (textEvent !== undefined) {
      const textGesture = this.#gestureEvent(textEvent.eventType);
      if (textGesture !== undefined) {
        await this.#dispatchAndRunEffects(textGesture);
        return;
      }
    }

    const listEvent = event.listEvent;
    if (listEvent !== undefined) {
      const listGesture = this.#gestureEvent(listEvent.eventType);
      if (listGesture !== undefined) await this.#dispatchAndRunEffects(listGesture);
    }
  }

  #gestureEvent(eventType: OsEventTypeList | undefined): ClientEvent | undefined {
    if (isEventType(eventType, OsEventTypeList.SCROLL_TOP_EVENT)) {
      return { type: "swipe.previous" };
    }
    if (isEventType(eventType, OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
      return { type: "swipe.next" };
    }
    if (eventType === undefined || isEventType(eventType, OsEventTypeList.CLICK_EVENT)) {
      let press: ClientEvent = { type: "press" };
      if (this.#state.state === "Ready" && this.#state.sessionReady) {
        try {
          press = { type: "press", utteranceId: this.#idGenerator() };
        } catch {
          return { type: "fatal" };
        }
      }
      return press;
    }
    return undefined;
  }

  #dispatchAndRunEffects(event: ClientEvent): Promise<void> {
    if (this.#isRuntimeInactive()) return Promise.resolve();
    const reduction = this.#dispatch(event);
    return this.#runEffects(reduction.effects);
  }

  #dispatch(
    event: ClientEvent,
    scheduleDisplay = true,
  ): ReturnType<typeof reduceClientState> {
    if (this.#isRuntimeInactive()) {
      return { state: this.#state, effects: [] };
    }
    const reduction = reduceClientState(this.#state, event);
    this.#state = reduction.state;
    if (scheduleDisplay) this.#scheduleDisplay(this.#state);
    return reduction;
  }

  async #runEffects(effects: readonly ClientEffect[]): Promise<void> {
    const orderedEffects = [
      ...effects.filter((effect) => effect.type === "start-utterance"),
      ...effects.filter((effect) => effect.type !== "start-utterance"),
    ];
    for (let index = 0; index < orderedEffects.length; index += 1) {
      const effect = orderedEffects[index];
      if (effect === undefined) continue;
      if (this.#isRuntimeInactive()) return;
      try {
        const followingEffect = orderedEffects[index + 1];
        if (followingEffect !== undefined && isPairedTurnEffects(effect, followingEffect)) {
          this.#audioPcmEnabled = false;
          try {
            this.#transport?.commitUtterance();
          } finally {
            this.#startDetachedAudioClose();
          }
          index += 1;
          continue;
        }
        switch (effect.type) {
          case "persist-target":
            void this.#persistTarget(effect.targetLanguage);
            break;
          case "start-session":
            this.#startSession(effect.targetLanguage);
            break;
          case "start-utterance":
            this.#transport?.startUtterance(effect.utteranceId);
            break;
          case "start-audio":
            await this.#startAudio();
            break;
          case "stop-audio":
            await this.#stopAudio();
            break;
          case "commit-utterance":
            this.#transport?.commitUtterance();
            break;
          case "end-session":
            this.#transport?.endSession("user_requested");
            break;
          case "resume-session":
          case "request-translation":
          case "request-suggestions":
            // The reviewed transport has no separate request/resume methods in this slice.
            break;
        }
      } catch {
        this.#handleEffectFailure();
        return;
      }
    }
  }

  #handleEffectFailure(): void {
    if (this.#isRuntimeInactive()) return;
    this.#dispatch({ type: "fatal" });
    this.#endAndCloseTransport("transport_error");
    this.#requestCleanup();
  }

  #endAndCloseTransport(
    reason: "user_requested" | "app_shutdown" | "transport_error",
  ): void {
    const transport = this.#transport;
    this.#transport = undefined;
    if (transport === undefined) return;
    this.#pendingTransportStarts.delete(transport);
    try {
      transport.endSession(reason);
    } catch {
      // Fatal handling continues to close the transport even if its end call fails.
    }
    const closeResult = this.#tryCloseTransport(transport);
    if (!closeResult.ok) this.#requestCleanup();
  }

  #startSession(targetLanguage: TargetLanguage): void {
    this.#audioPcmFaultTransport = undefined;
    const priorTransport = this.#transport;
    this.#transport = undefined;
    if (priorTransport !== undefined) {
      this.#pendingTransportStarts.delete(priorTransport);
      const closeResult = this.#tryCloseTransport(priorTransport);
      if (!closeResult.ok) {
        this.#handleEffectFailure();
        return;
      }
    }

    const transportReference: { current?: G2Transport } = {};
    const transportOptions: RelayTransportOptions = {
      relayOrigin: this.#relayOrigin,
      onEvent: (event) => {
        if (transportReference.current !== undefined) {
          this.#handleTransportCallback(transportReference.current, event);
        }
      },
      onTransportError: () => {
        if (transportReference.current !== undefined) {
          this.#handleTransportError(transportReference.current);
        }
      },
    };
    const transport = this.#createTransport(transportOptions);
    transportReference.current = transport;
    this.#transport = transport;

    this.#pendingTransportStarts.add(transport);
    try {
      const startPromise = transport.startSession(targetLanguage);
      void Promise.resolve(startPromise).then(
        () => {
          this.#pendingTransportStarts.delete(transport);
        },
        () => {
          this.#pendingTransportStarts.delete(transport);
          if (!this.#isRuntimeInactive() && this.#transport === transport) {
            this.#failTransport(transport);
          }
        },
      );
    } catch {
      this.#pendingTransportStarts.delete(transport);
      if (this.#transport === transport) {
        this.#failTransport(transport);
      }
    }
  }

  #failTransport(transport: G2Transport): void {
    if (this.#isRuntimeInactive() || this.#transport !== transport) return;
    this.#dispatch({ type: "fatal" });
    this.#endAndCloseTransport("transport_error");
    this.#requestCleanup();
  }

  #handleTransportError(transport: G2Transport): void {
    if (this.#isRuntimeInactive() || this.#transport !== transport) return;
    this.#queueTransportEvent(transport, { type: "fatal" });
  }

  #handleTransportCallback(
    transport: G2Transport,
    event: RelayTransportCallbackEvent,
  ): void {
    if (this.#isRuntimeInactive() || this.#transport !== transport) return;
    if (event.type === "fatal") {
      this.#queueTransportEvent(transport, event);
      return;
    }
    if (event.type === "session.rejected") {
      this.#queueTransportEvent(transport, { type: "fatal" });
      return;
    }
    this.#queueTransportEvent(transport, event);
  }

  #startDetachedAudioClose(): void {
    let closing: Promise<boolean>;
    try {
      closing = this.#closeAudio();
    } catch (error: unknown) {
      this.#queueSerializedEvent(() => {
        if (error !== undefined) this.#lastEventError = normalizeError(error, "G2 audio close failed");
        this.#handleEffectFailure();
      });
      return;
    }

    const generation = this.#audioCloseGeneration;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let resolveMonitor: (() => void) | undefined;
    const finish = (failed: boolean): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        if (this.#detachedAudioCloseTimer === timer) {
          this.#detachedAudioCloseTimer = undefined;
        }
        timer = undefined;
      }

      const isCurrent = this.#detachedAudioCloseMonitor === monitor &&
        this.#detachedAudioCloseMonitorGeneration === generation &&
        this.#audioCloseGeneration === generation;
      if (isCurrent) {
        this.#detachedAudioCloseMonitor = undefined;
        this.#detachedAudioCloseTimer = undefined;
        this.#detachedAudioCloseMonitorGeneration = undefined;
      }
      resolveMonitor?.();

      if (failed && isCurrent) this.#queueDetachedAudioFailure(generation);
    };
    const monitor = new Promise<void>((resolve) => {
      resolveMonitor = resolve;
      timer = setTimeout(() => finish(true), AUDIO_CLOSE_TIMEOUT_MS);
      this.#detachedAudioCloseTimer = timer;
      this.#detachedAudioCloseMonitorGeneration = generation;
      void closing.then(
        (closed) => finish(!closed),
        () => finish(true),
      );
    });
    this.#detachedAudioCloseMonitor = monitor;
  }

  #queueDetachedAudioFailure(generation: number): void {
    if (this.#isRuntimeInactive() || this.#detachedAudioCloseFailureGeneration === generation) return;
    this.#detachedAudioCloseFailureGeneration = generation;
    this.#queueSerializedEvent(() => {
      if (this.#audioCloseGeneration !== generation) return;
      this.#handleEffectFailure();
    });
  }

  async #startAudio(): Promise<void> {
    if (this.#isRuntimeInactive()) return;
    const pendingAudioClose = this.#pendingAudioClose;
    if (pendingAudioClose !== undefined) {
      const closed = await this.#awaitWithCleanup(
        pendingAudioClose,
        "G2 audio close timed out",
      );
      if (closed === CLEANUP_PREEMPTED) return;
      if (!closed) throw new Error("G2 audio close failed");
      if (this.#isRuntimeInactive()) return;
    }
    if (this.#audioOpen || this.#isRuntimeInactive()) return;
    const bridge = this.#bridge;
    if (bridge === undefined) throw new Error("G2 bridge is unavailable");
    this.#audioCloseRequired = true;
    const opening = Promise.resolve()
      .then(() => {
        if (this.#isRuntimeInactive()) throw new Error("G2 bridge runtime is inactive");
        return bridge.audioControl(true, AudioInputSource.Glasses);
      })
      .then((opened) => {
        if (!opened) {
          this.#audioOpenUncertain = false;
          if (!this.#audioOpen) {
            this.#audioCloseRequired = false;
          }
          throw new Error("G2 audio open failed");
        }
        this.#audioOpen = true;
        this.#audioOpenUncertain = false;
        this.#audioCloseRequired = true;
        this.#audioPcmFaultTransport = undefined;
        if (this.#isRuntimeInactive()) {
          this.#scheduleCleanupForLateResource();
        } else {
          this.#audioPcmEnabled = true;
        }
      }, (error: unknown) => {
        this.#audioOpenUncertain = false;
        this.#audioCloseRequired = true;
        const normalized = normalizeError(error, "G2 audio open failed");
        if (this.#isRuntimeInactive()) this.#scheduleCleanupForLateResource();
        throw normalized;
      });
    this.#pendingAudioOpen = opening;
    void opening.then(
      () => {
        if (this.#pendingAudioOpen === opening) this.#pendingAudioOpen = undefined;
        this.#audioOpenUncertain = false;
      },
      () => {
        if (this.#pendingAudioOpen === opening) this.#pendingAudioOpen = undefined;
        this.#audioOpenUncertain = false;
      },
    );
    try {
      const result = await this.#awaitWithCleanup(
        opening,
        "G2 audio open timed out",
        AUDIO_CLOSE_TIMEOUT_MS,
      );
      if (result === CLEANUP_PREEMPTED) return;
    } finally {
      if (this.#pendingAudioOpen === opening) {
        this.#pendingAudioOpen = undefined;
        this.#audioOpenUncertain = true;
      }
    }
  }

  async #stopAudio(): Promise<void> {
    if (!this.#audioOpen) return;
    this.#audioPcmEnabled = false;
    this.#audioCloseRequired = true;
    const closing = this.#closeAudio();
    const closed = await this.#awaitWithCleanup(
      closing,
      "G2 audio close timed out",
      AUDIO_CLOSE_TIMEOUT_MS,
    );
    if (closed === CLEANUP_PREEMPTED) {
      return;
    }
    if (!closed) throw new Error("G2 audio close failed");
  }

  async #closeAudioForCleanup(): Promise<void> {
    const pendingAudioOpen = this.#pendingAudioOpen;
    let pendingAudioOpenError: Error | undefined;
    if (pendingAudioOpen !== undefined) {
      try {
        await this.#awaitWithTimeout(
          pendingAudioOpen,
          "G2 audio open timed out during cleanup",
        );
      } catch (error: unknown) {
        pendingAudioOpenError = normalizeError(error, "G2 audio open failed during cleanup");
      } finally {
        if (this.#pendingAudioOpen === pendingAudioOpen) {
          this.#pendingAudioOpen = undefined;
          this.#audioOpenUncertain = true;
        }
      }
    }
    if (
      pendingAudioOpenError === undefined &&
      !this.#audioOpen &&
      !this.#audioOpenUncertain &&
      !this.#audioCloseRequired
    ) return;
    if (this.#bridge === undefined) throw new Error("G2 bridge is unavailable");

    this.#audioPcmEnabled = false;
    const closePromise = this.#closeAudio();
    const closed = await this.#awaitWithTimeout(closePromise, "G2 audio close timed out");
    if (!closed) throw new Error("G2 audio close failed");
    if (pendingAudioOpenError !== undefined) {
      this.#audioCloseRequired = true;
      throw pendingAudioOpenError;
    }
  }

  #closeAudio(): Promise<boolean> {
    const pendingAudioClose = this.#pendingAudioClose;
    if (pendingAudioClose !== undefined) return pendingAudioClose;
    const bridge = this.#bridge;
    if (bridge === undefined) throw new Error("G2 bridge is unavailable");

    const generation = ++this.#audioCloseGeneration;
    const closing = Promise.resolve()
      .then(() => bridge.audioControl(false))
      .then((closed) => {
        if (
          closed &&
          this.#audioCloseGeneration === generation &&
          this.#cleanupState !== "cleaned"
        ) {
          this.#audioOpen = false;
          this.#audioPcmEnabled = false;
          this.#audioCloseRequired = false;
          this.#audioPcmFaultTransport = undefined;
        }
        return closed;
      }, (error: unknown) => {
        if (
          this.#audioCloseGeneration === generation &&
          this.#cleanupState !== "cleaned"
        ) {
          this.#audioCloseRequired = true;
        }
        throw normalizeError(error, "G2 audio close failed");
      });
    this.#pendingAudioClose = closing;
    void closing.then(
      () => this.#handleAudioCloseSettlement(closing, generation),
      () => this.#handleAudioCloseSettlement(closing, generation),
    );
    return closing;
  }

  #handleAudioCloseSettlement(
    closing: Promise<boolean>,
    generation: number,
  ): void {
    if (this.#pendingAudioClose === closing) this.#pendingAudioClose = undefined;
    if (
      this.#cleanupRequested &&
      !this.#cleanupInProgress &&
      this.#cleanupState !== "cleaned" &&
      this.#audioCloseGeneration === generation
    ) {
      this.#scheduleCleanupForLateResource();
    }
  }

  async #awaitWithTimeout<T>(
    promise: Promise<T>,
    message: string,
    timeoutMs = AUDIO_CLOSE_TIMEOUT_MS,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout: Promise<never> | undefined;
    try {
      timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      });
      return await Promise.race([promise, timeout]);
    } catch (error: unknown) {
      throw normalizeError(error, message);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      void timeout?.catch(() => undefined);
    }
  }

  async #awaitWithCleanup<T>(
    promise: Promise<T>,
    message: string,
    timeoutMs = DISPLAY_UPGRADE_TIMEOUT_MS,
  ): Promise<T | typeof CLEANUP_PREEMPTED> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanupWaiter: (() => void) | undefined;
    const cleanup = new Promise<typeof CLEANUP_PREEMPTED>((resolve) => {
      const waiter = (): void => resolve(CLEANUP_PREEMPTED);
      cleanupWaiter = waiter;
      if (this.#cleanupRequested) {
        resolve(CLEANUP_PREEMPTED);
      } else {
        this.#cleanupWaiters.add(waiter);
      }
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
      return await Promise.race([promise, cleanup, timeout]);
    } catch (error: unknown) {
      throw normalizeError(error, message);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (cleanupWaiter !== undefined) this.#cleanupWaiters.delete(cleanupWaiter);
    }
  }

  #scheduleDisplay(state: ClientState): void {
    if (
      this.#cleanupState === "cleaned" ||
      this.#cleanupInProgress ||
      this.#bootState === "failed" ||
      !this.#displayAvailable ||
      this.#displayFault !== undefined
    ) return;

    const content = displayContent(state);
    const pendingContent = this.#pendingDisplayState === undefined
      ? undefined
      : displayContent(this.#pendingDisplayState);
    const currentContent = pendingContent ??
      this.#displayInFlightContent ?? this.#lastDisplayContent;
    if (sameDisplayContent(content, currentContent)) return;

    this.#pendingDisplayState = state;
    if (this.#displayInProgress || this.#displayTimer !== undefined) return;
    this.#displayTimerPromise = new Promise<void>((resolve) => {
      this.#displayTimerResolve = resolve;
      this.#displayTimer = setTimeout(() => {
        this.#displayTimer = undefined;
        this.#displayTimerResolve = undefined;
        this.#displayTimerPromise = undefined;
        resolve();
        this.#flushDisplay();
      }, this.#displayDebounceMs);
    });
  }

  #flushDisplay(): void {
    if (
      this.#displayInProgress ||
      this.#displayFault !== undefined ||
      this.#cleanupState === "cleaned" ||
      this.#cleanupInProgress ||
      this.#bootState === "failed"
    ) return;
    const state = this.#pendingDisplayState;
    this.#pendingDisplayState = undefined;
    if (state === undefined) return;
    const content = displayContent(state);
    this.#displayInProgress = true;
    this.#displayInFlightContent = content;
    const operation = this.#displayTail.then(() => this.#upgradeDisplay(state));
    this.#displayTail = operation.then(
      () => {
        this.#displayInProgress = false;
        this.#displayInFlightContent = undefined;
        this.#flushDisplay();
      },
      (error: unknown) => {
        this.#displayInProgress = false;
        this.#displayInFlightContent = undefined;
        const normalized = normalizeError(error, "G2 display upgrade failed");
        if (this.#displayFault === undefined) this.#displayFault = normalized;
        if (this.#lastEventError === undefined) this.#lastEventError = normalized;
        this.#pendingDisplayState = undefined;
        this.#handleDisplayFault();
      },
    );
  }

  #handleDisplayFault(): void {
    if (this.#cleanupRequested) return;
    this.#displayAvailable = false;
    this.#pendingDisplayState = undefined;
    if (this.#state.state !== "Error") {
      this.#state = reduceClientState(this.#state, { type: "fatal" }).state;
    }
    this.#requestCleanup();
  }

  async #whenDisplayIdle(): Promise<void> {
    if (this.#displayFault !== undefined) throw this.#displayFault;
    if (this.#isRuntimeInactive()) return;
    while (true) {
      const timerPromise = this.#displayTimerPromise;
      if (timerPromise !== undefined) await timerPromise;
      if (this.#isRuntimeInactive()) return;
      const displayTail = this.#displayTail;
      await displayTail;
      if (
        timerPromise === this.#displayTimerPromise &&
        displayTail === this.#displayTail &&
        this.#pendingDisplayState === undefined &&
        !this.#displayInProgress
      ) break;
    }
    if (this.#displayFault !== undefined) throw this.#displayFault;
  }

  async #upgradeDisplay(state: ClientState): Promise<void> {
    const bridge = this.#bridge;
    if (bridge === undefined) return;
    const requestedContent = displayContent(state);
    const content: Record<string, string> = {};
    for (let index = 0; index < displayTargets.length; index += 1) {
      if (this.#isRuntimeInactive()) return;
      const target = displayTargets[index];
      if (target === undefined) return;
      const value = requestedContent[target.containerName] ?? "";
      content[target.containerName] = value;
      if (this.#lastDisplayContent[target.containerName] === value) {
        continue;
      }
      const result = await this.#awaitWithCleanup(
        Promise.resolve().then(() => bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: target.containerID,
          containerName: target.containerName,
          content: value,
        }))),
        "G2 text container upgrade timed out",
      );
      if (result === CLEANUP_PREEMPTED) return;
      if (this.#isRuntimeInactive()) return;
      if (!result) throw new Error("G2 text container upgrade failed");
      this.#displayUpdateCount += 1;
    }
    this.#lastDisplayContent = Object.freeze(content);
  }
}
