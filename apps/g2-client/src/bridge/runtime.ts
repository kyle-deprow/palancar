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

import type {
  AuthOutcome,
  AuthRequiredReason,
  G2AuthController,
} from "../auth/types.js";
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
  type RelayTransportError,
  type RelayTransportOptions,
} from "../transport/index.js";
import { toStartUpPageContainer } from "./sdk-layout.js";

export const PALANCAR_G2_READY = "PALANCAR_G2_READY";

const TARGET_STORAGE_KEY = "palancar.target-language";
const DISPLAY_DEBOUNCE_MS = 175;
const DISPLAY_MAX_TEXT_LENGTH = 120;
const AUDIO_CLOSE_TIMEOUT_MS = 1_000;
const BRIDGE_CLEANUP_TIMEOUT_MS = 1_000;
const DISPLAY_UPGRADE_TIMEOUT_MS = 1_000;
const MAX_QUEUED_EVENTS = 64;

export const RECOVERY_MAX_CONSECUTIVE_ATTEMPTS = 5;
export const RECOVERY_ATTEMPT_WINDOW_MS = 60_000;
export const RECOVERY_MAX_ATTEMPTS_PER_WINDOW = 5;
export const RECOVERY_LONG_ATTEMPT_WINDOW_MS = 600_000;
export const RECOVERY_MAX_ATTEMPTS_PER_LONG_WINDOW = 12;
export const RECOVERY_BACKOFF_BASE_MS = 500;
export const RECOVERY_BACKOFF_MAX_MS = 8_000;
export const RECOVERY_READY_DEADLINE_MS = 10_000;
export const RESULT_PIPELINE_DEADLINE_MS = 15_000;

const CLEANUP_PREEMPTED = Symbol("cleanup-preempted");
const AUTH_OPERATION_PREEMPTED = Symbol("auth-operation-preempted");

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

export type G2PhoneAuthState =
  | { readonly status: "starting" | "checking" | "revoking" | "enrolling" | "ready" | "storage-error" | "error" }
  | { readonly status: "required"; readonly reason: AuthRequiredReason };

export type G2PhoneAuthStateListener = (state: G2PhoneAuthState) => void;

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
  cancelUtterance(options?: Readonly<{ readonly retireImmediately?: boolean }>): void;
  endSession(reason?: "user_requested" | "app_shutdown" | "transport_error"): void;
  close(): void;
}

export type G2TransportFactory = (
  options: RelayTransportOptions,
) => G2Transport;

export interface G2BridgeRuntimeOptions {
  readonly relayOrigin: string;
  readonly authController: G2AuthController;
  readonly waitForBridge?: () => Promise<G2BridgePort>;
  readonly readyLogger?:
    (marker: typeof PALANCAR_G2_READY) => unknown | Promise<unknown>;
  readonly createTransport?: G2TransportFactory;
  readonly idGenerator?: () => string;
  readonly storage?: G2TargetStorage;
  readonly displayDebounceMs?: number;
  readonly recoveryTiming?: RecoveryTiming;
}

export interface RecoveryTiming {
  readonly now: () => number;
  readonly random: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
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

function toClientEvent(event: RelayTransportCallbackEvent): ClientEvent | undefined {
  switch (event.type) {
    case "session.ready":
      return {
        type: event.type,
        sessionId: event.sessionId,
        sessionEpoch: event.sessionEpoch,
        targetLanguage: event.targetLanguage,
        result: event.result,
      };
    case "transcript.partial":
    case "transcript.final":
      return {
        type: event.type,
        sessionId: event.sessionId,
        sessionEpoch: event.sessionEpoch,
        utteranceId: event.utteranceId,
        segmentId: event.segmentId,
        revision: event.revision,
        text: event.text,
      };
    case "language.decision":
      return {
        type: event.type,
        sessionId: event.sessionId,
        sessionEpoch: event.sessionEpoch,
        utteranceId: event.utteranceId,
        segmentId: event.segmentId,
        revision: event.revision,
        decision: event.decision,
        selectedTargetLanguage: event.selectedTargetLanguage,
      };
    case "translation.ready":
      return {
        type: event.type,
        sessionId: event.sessionId,
        sessionEpoch: event.sessionEpoch,
        utteranceId: event.utteranceId,
        segmentId: event.segmentId,
        acceptedFinalRevision: event.acceptedFinalRevision,
        englishTranslation: event.englishTranslation,
      };
    case "suggestions.ready":
      return {
        type: event.type,
        sessionId: event.sessionId,
        sessionEpoch: event.sessionEpoch,
        utteranceId: event.utteranceId,
        segmentId: event.segmentId,
        acceptedFinalRevision: event.acceptedFinalRevision,
        suggestions: event.suggestions,
      };
    case "utterance.aborted":
      return {
        type: event.type,
        sessionId: event.sessionId,
        sessionEpoch: event.sessionEpoch,
        utteranceId: event.utteranceId,
        category: event.category,
      };
    case "transport.lost":
      return {
        type: event.type,
        sessionId: event.sessionId,
        sessionEpoch: event.sessionEpoch,
      };
    case "fatal":
      return { type: event.type };
    case "credential.rejected":
    case "credential.storage-error":
      return { type: event.type };
    case "session.rejected":
      return undefined;
  }
}

function transportErrorEvent(error: RelayTransportError, state: ClientState): ClientEvent {
  if (error.kind !== "audio" || error.recoveryDisposition !== "stop") {
    return { type: "fatal" };
  }

  switch (state.state) {
    case "Listening":
    case "Finalizing":
    case "Translating":
    case "Results":
      return Object.freeze({
        type: "utterance.aborted" as const,
        sessionId: state.sessionId,
        sessionEpoch: state.sessionEpoch,
        utteranceId: state.utteranceId,
        category: "flow" as const,
      });
    case "Starting":
    case "EnrollmentChecking":
    case "EnrollmentRequired":
    case "Enrolling":
    case "StorageError":
    case "TargetSelection":
    case "Ready":
    case "Error":
      return { type: "fatal" };
  }
}

type ResultPipelineState = Extract<ClientState, { state: "Finalizing" | "Translating" }>;
type ResultPipelineTimeoutEvent = Extract<ClientEvent, { type: "utterance.aborted" }>;

function isResultPipelineState(state: ClientState): state is ResultPipelineState {
  return state.state === "Finalizing" || state.state === "Translating";
}

function isResultPipelineProgress(
  previousState: ClientState,
  event: ClientEvent,
  nextState: ClientState,
): boolean {
  if (!isResultPipelineState(previousState) || !isResultPipelineState(nextState)) return false;

  switch (event.type) {
    case "transcript.partial":
    case "transcript.final":
      return previousState.state === "Finalizing" && nextState.state === "Finalizing" &&
        nextState.utteranceId === event.utteranceId &&
        nextState.segmentRevisions[event.segmentId] === event.revision &&
        previousState.segmentRevisions[event.segmentId] !== event.revision;
    case "language.decision":
      return previousState.state === "Finalizing" && nextState.state === "Translating";
    case "translation.ready":
      return previousState.state === "Translating" && nextState.state === "Translating" &&
        previousState.englishTranslation === undefined &&
        nextState.englishTranslation !== undefined;
    default:
      return false;
  }
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
    case "EnrollmentChecking":
    case "EnrollmentRequired":
    case "Enrolling":
    case "StorageError":
    case "TargetSelection":
      return state.highlightedTarget;
    case "Ready":
    case "Listening":
    case "Finalizing":
    case "Translating":
    case "Results":
    case "Error":
      return state.targetLanguage;
  }
}

function sessionReadyForState(state: ClientState): boolean {
  return state.state === "Ready" && state.sessionReady;
}

function phoneAuthState(state: ClientState): G2PhoneAuthState {
  switch (state.state) {
    case "Starting":
      return Object.freeze({ status: "starting" });
    case "EnrollmentChecking":
      return Object.freeze({
        status: state.phase === "revoking" ? "revoking" : "checking",
      });
    case "EnrollmentRequired":
      return state.reason === "relay-unavailable"
        ? Object.freeze({ status: "error" })
        : Object.freeze({ status: "required", reason: state.reason });
    case "Enrolling":
      return Object.freeze({ status: "enrolling" });
    case "StorageError":
      return Object.freeze({ status: "storage-error" });
    case "TargetSelection":
    case "Ready":
    case "Listening":
    case "Finalizing":
    case "Translating":
    case "Results":
      return Object.freeze({ status: "ready" });
    case "Error":
      return Object.freeze({ status: "error" });
  }
}

function samePhoneAuthState(left: G2PhoneAuthState, right: G2PhoneAuthState): boolean {
  return left.status === right.status &&
    (left.status !== "required" ||
      (right.status === "required" && left.reason === right.reason));
}

function enrollmentOutcomeEvent(outcome: AuthOutcome): ClientEvent {
  switch (outcome.kind) {
    case "ready":
      return { type: "enrollment.ready" };
    case "required":
      return { type: "enrollment.required", reason: outcome.reason };
    case "storage-error":
      return { type: "enrollment.storage-error" };
    case "unavailable":
      return { type: "enrollment.unavailable" };
  }
}

function enrollmentAttemptOutcomeEvent(outcome: AuthOutcome): ClientEvent {
  switch (outcome.kind) {
    case "ready":
      return { type: "enrollment.ready" };
    case "required":
      return outcome.reason === "pairing-failed" || outcome.reason === "pairing-uncertain"
        ? { type: "enrollment.failed", reason: outcome.reason }
        : { type: "enrollment.failed", reason: "pairing-uncertain" };
    case "storage-error":
      return { type: "enrollment.storage-error" };
    case "unavailable":
      return { type: "enrollment.unavailable" };
  }
}

function sessionAuthOutcomeEvent(outcome: AuthOutcome, authAttempt: number): ClientEvent {
  switch (outcome.kind) {
    case "ready":
      return { type: "session.authenticated", authAttempt };
    case "required":
      return { type: "session.auth-required", authAttempt, reason: outcome.reason };
    case "storage-error":
      return { type: "session.auth-storage-error", authAttempt };
    case "unavailable":
      return { type: "session.auth-unavailable", authAttempt };
  }
}

function revocationOutcomeEvent(outcome: AuthOutcome): ClientEvent {
  if (outcome.kind === "storage-error") return { type: "enrollment.storage-error" };
  if (outcome.kind === "required" && outcome.reason === "revoked") {
    return { type: "revocation.completed", reason: "revoked" };
  }
  return { type: "revocation.completed", reason: "revocation-unconfirmed" };
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
    case "EnrollmentChecking":
      return [
        state.phase === "revoking" ? "Revoking enrollment" : "Checking enrollment",
        targetLine,
        "Source: unavailable",
        "English: unavailable",
        "Please wait",
      ];
    case "EnrollmentRequired":
      return [
        "Enrollment required",
        targetLine,
        "Source: unavailable",
        "English: unavailable",
        "Continue on phone",
      ];
    case "Enrolling":
      return [
        "Enrolling",
        targetLine,
        "Source: unavailable",
        "English: unavailable",
        "Complete on phone",
      ];
    case "StorageError":
      return [
        "Enrollment storage error",
        targetLine,
        "Source: unavailable",
        "English: unavailable",
        "Retry on phone",
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
      if (state.pending === "recovery") {
        return [
          "Reconnecting",
          targetLine,
          "Source: Interrupted turn cleared",
          "English: waiting",
          "Please wait",
        ];
      }
      if (state.pending === "authentication") {
        return [
          state.message === undefined ? "Authenticating" : "Authentication unavailable",
          targetLine,
          "Source: unavailable",
          "English: unavailable",
          state.message === undefined ? "Please wait" : "Press to retry",
        ];
      }
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
    case "Error":
      return [
        compact(`Error: ${state.message}`),
        targetLine,
        "Source: unavailable",
        "English: unavailable",
        state.terminal ? "Restart app" : "Try again",
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

function defaultRecoveryTiming(): RecoveryTiming {
  return {
    now: () => Date.now(),
    random: () => Math.random(),
    schedule: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    },
  };
}

interface RecoveryContext {
  readonly cycle: number;
  readonly targetLanguage: TargetLanguage;
  readonly previousSessionId: string;
  readonly previousSessionEpoch: number;
  consecutiveAttempts: number;
  readonly attemptTimes: number[];
  scheduledCancel: (() => void) | undefined;
  activeAttempt: RecoveryAttempt | undefined;
}

interface RecoveryAttempt {
  readonly cycle: number;
  readonly attempt: number;
  transport: G2Transport | undefined;
  transportGeneration: number | undefined;
  deadlineCancel: (() => void) | undefined;
}

interface StartAudioEffect {
  readonly type: "start-audio";
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
}

interface TransportEventGuard {
  readonly transport: G2Transport;
  readonly generation: number;
  readonly recoveryAttempt: number | undefined;
}

export class G2BridgeRuntime {
  readonly #waitForBridge: () => Promise<G2BridgePort>;
  readonly #readyLogger: (marker: typeof PALANCAR_G2_READY) => unknown | Promise<unknown>;
  readonly #createTransport: G2TransportFactory;
  readonly #authController: G2AuthController;
  readonly #idGenerator: () => string;
  readonly #relayOrigin: string;
  readonly #storage: G2TargetStorage | undefined;
  readonly #displayDebounceMs: number;
  readonly #recoveryTiming: RecoveryTiming;
  readonly #startupContainer = toStartUpPageContainer(PAGE_LAYOUTS.Starting);
  #bridge: G2BridgePort | undefined;
  #transport: G2Transport | undefined;
  #transportGeneration = 0;
  #recoveryCycle = 0;
  #recoveryContext: RecoveryContext | undefined;
  #pendingRecoveryLoss = false;
  #authGeneration = 0;
  readonly #authCancellationWaiters = new Set<() => void>();
  readonly #pendingAuthOperations = new Set<Promise<void>>();
  #revocationPromise: Promise<void> | undefined;
  #authControllerDisposed = false;
  readonly #phoneAuthListeners = new Set<G2PhoneAuthStateListener>();
  #lastPhoneAuthState: G2PhoneAuthState = Object.freeze({ status: "starting" });
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
  #resultPipelineWatchdogCancel: (() => void) | undefined;
  #resultPipelineWatchdogArmed = false;
  #resultPipelineWatchdogGeneration = 0;
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

  constructor(options: G2BridgeRuntimeOptions) {
    if (options === undefined || options === null) {
      throw new TypeError("G2 bridge runtime options are required");
    }
    this.#waitForBridge = options.waitForBridge ?? waitForEvenAppBridge;
    this.#readyLogger = options.readyLogger ?? ((marker) => console.info(marker));
    this.#createTransport = options.createTransport ?? ((transportOptions) =>
      createRelayTransport(transportOptions) as RelayTransport);
    this.#authController = options.authController;
    if (
      this.#authController === undefined ||
      typeof this.#authController.initialize !== "function" ||
      typeof this.#authController.enroll !== "function" ||
      typeof this.#authController.retryPersistence !== "function" ||
      typeof this.#authController.resetEnrollment !== "function" ||
      typeof this.#authController.prepareSessionBoundary !== "function" ||
      typeof this.#authController.revokeCurrent !== "function" ||
      typeof this.#authController.dispose !== "function" ||
      this.#authController.credentialProvider === undefined
    ) {
      throw new TypeError("authController must provide the G2 authentication contract");
    }
    this.#idGenerator = options.idGenerator ?? randomUuidV4;
    if (typeof options.relayOrigin !== "string" || options.relayOrigin.length === 0) {
      throw new TypeError("relayOrigin is required");
    }
    this.#relayOrigin = options.relayOrigin;
    this.#storage = options.storage ?? defaultStorage();
    const displayDebounceMs = options.displayDebounceMs ?? DISPLAY_DEBOUNCE_MS;
    if (!Number.isFinite(displayDebounceMs) || displayDebounceMs < 0) {
      throw new RangeError("displayDebounceMs must be non-negative");
    }
    this.#displayDebounceMs = displayDebounceMs;
    const recoveryTiming = options.recoveryTiming ?? defaultRecoveryTiming();
    if (
      typeof recoveryTiming.now !== "function" ||
      typeof recoveryTiming.random !== "function" ||
      typeof recoveryTiming.schedule !== "function"
    ) {
      throw new TypeError("recoveryTiming must provide now, random, and schedule functions");
    }
    this.#recoveryTiming = recoveryTiming;
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

  #currentState(): ClientState {
    return this.#state;
  }

  async enroll(pairingCode: string): Promise<void> {
    let completion: Promise<void> | undefined;
    await this.#queueSerializedEvent(async () => {
      if (this.#state.state !== "EnrollmentRequired") return;
      await this.#dispatchAndRunEffects({ type: "enrollment.started" });
      const postDispatchState = this.#currentState();
      if (postDispatchState.state !== "Enrolling" || this.#isRuntimeInactive()) return;
      completion = this.#launchAuthOperation(
        () => this.#authController.enroll(pairingCode),
        (outcome) => this.#dispatchAndRunEffects(enrollmentAttemptOutcomeEvent(outcome)),
      );
    });
    await completion;
  }

  async retryEnrollment(): Promise<void> {
    let completion: Promise<void> | undefined;
    await this.#queueSerializedEvent(() => this.#dispatchAndRunEffects(
      { type: "enrollment.retry" },
      undefined,
      (operation) => { completion = operation; },
    ));
    await completion;
  }

  async resetEnrollment(): Promise<void> {
    let completion: Promise<void> | undefined;
    await this.#queueSerializedEvent(() => this.#dispatchAndRunEffects(
      { type: "enrollment.reset" },
      undefined,
      (operation) => { completion = operation; },
    ));
    await completion;
  }

  revokeEnrollment(): Promise<void> {
    const existing = this.#revocationPromise;
    if (existing !== undefined) return existing;
    const revocation = this.#revokeEnrollmentOnce();
    this.#revocationPromise = revocation;
    const clear = (): void => {
      if (this.#revocationPromise === revocation) this.#revocationPromise = undefined;
    };
    void revocation.then(clear, clear);
    return revocation;
  }

  async #revokeEnrollmentOnce(): Promise<void> {
    let completion: Promise<void> | undefined;
    await this.#queueSerializedEvent(async () => {
      const previousState = this.#state;
      await this.#dispatchAndRunEffects({ type: "revocation.started" });
      if (
        this.#state === previousState ||
        this.#state.state !== "EnrollmentChecking" ||
        this.#state.phase !== "revoking" ||
        this.#isRuntimeInactive()
      ) return;
      completion = this.#launchAuthOperation(
        () => this.#authController.revokeCurrent(),
        (outcome) => this.#dispatchAndRunEffects(revocationOutcomeEvent(outcome)),
      );
    });
    await completion;
  }

  subscribePhoneAuthState(listener: G2PhoneAuthStateListener): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("Phone authentication listener must be a function");
    }
    if (this.#cleanupRequested || this.#cleanupState === "cleaned") return () => undefined;
    this.#phoneAuthListeners.add(listener);
    try {
      listener(this.#lastPhoneAuthState);
    } catch {
      // A phone listener cannot interrupt bridge or authentication work.
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#phoneAuthListeners.delete(listener);
    };
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
      const pendingAuthOperations = [...this.#pendingAuthOperations];
      if (pendingAuthOperations.length > 0) {
        const authPreempted = await this.#awaitEventTailOrCleanup(
          Promise.all(pendingAuthOperations).then(() => undefined),
        );
        if (authPreempted || this.#cleanupRequested || this.#cleanupInProgress) continue;
      }
      const displayTimer = this.#displayTimerPromise;
      if (displayTimer !== undefined) await displayTimer;
      const displayTail = this.#displayTail;
      await displayTail;
      if (
        eventTail === this.#eventTail &&
        this.#pendingAuthOperations.size === 0 &&
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
      await this.#dispatchAndRunEffects({ type: "startup.ready" });
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

  #invalidateAuthOperations(): void {
    this.#authGeneration += 1;
    for (const cancel of this.#authCancellationWaiters) cancel();
    this.#authCancellationWaiters.clear();
  }

  #disposeAuthController(): Error | undefined {
    if (this.#authControllerDisposed) return undefined;
    this.#authControllerDisposed = true;
    try {
      this.#authController.dispose();
      return undefined;
    } catch (error: unknown) {
      return normalizeError(error, "G2 authentication controller disposal failed");
    }
  }

  #launchAuthOperation(
    operation: () => Promise<AuthOutcome>,
    applyOutcome: (outcome: AuthOutcome) => void | Promise<void>,
  ): Promise<void> {
    this.#invalidateAuthOperations();
    const generation = this.#authGeneration;
    let cancelOperation = (): void => undefined;
    const cancelled = new Promise<typeof AUTH_OPERATION_PREEMPTED>((resolve) => {
      cancelOperation = () => resolve(AUTH_OPERATION_PREEMPTED);
    });
    this.#authCancellationWaiters.add(cancelOperation);

    const completion = (async () => {
      let operationResult: AuthOutcome | typeof AUTH_OPERATION_PREEMPTED;
      try {
        operationResult = await Promise.race([
          Promise.resolve().then(operation).catch(() => ({ kind: "unavailable" } as const)),
          cancelled,
        ]);
      } finally {
        this.#authCancellationWaiters.delete(cancelOperation);
      }
      if (
        operationResult === AUTH_OPERATION_PREEMPTED ||
        generation !== this.#authGeneration ||
        this.#isRuntimeInactive()
      ) return;
      await this.#queueSerializedEvent(async () => {
        if (generation !== this.#authGeneration || this.#isRuntimeInactive()) return;
        await applyOutcome(operationResult);
      });
    })();
    this.#pendingAuthOperations.add(completion);
    void completion.finally(() => this.#pendingAuthOperations.delete(completion));
    return completion;
  }

  #publishPhoneAuthState(): void {
    const next = phoneAuthState(this.#state);
    if (samePhoneAuthState(this.#lastPhoneAuthState, next)) return;
    this.#lastPhoneAuthState = next;
    for (const listener of this.#phoneAuthListeners) {
      try {
        listener(next);
      } catch {
        // Phone projection is observational and cannot affect runtime work.
      }
    }
  }

  async #teardownAfterBootFailure(): Promise<void> {
    this.#invalidateAuthOperations();
    const authFailure = this.#disposeAuthController();
    this.#cancelRecoveryTimers();
    this.#cancelResultPipelineWatchdog();
    this.#recoveryCycle += 1;
    this.#recoveryContext = undefined;
    this.#pendingRecoveryLoss = false;
    this.#displayAvailable = false;
    if (this.#displayTimer !== undefined) {
      clearTimeout(this.#displayTimer);
      this.#displayTimer = undefined;
      this.#displayTimerResolve?.();
      this.#displayTimerResolve = undefined;
      this.#displayTimerPromise = undefined;
    }
    this.#pendingDisplayState = undefined;

    let cleanupFailure: Error | undefined = authFailure;
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
    this.#invalidateAuthOperations();
    let controllerFailure = this.#disposeAuthController();
    this.#phoneAuthListeners.clear();
    this.#cancelRecoveryTimers();
    this.#cancelResultPipelineWatchdog();
    this.#recoveryCycle += 1;
    this.#recoveryContext = undefined;
    this.#pendingRecoveryLoss = false;
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
      let cleanupFailure = controllerFailure ?? subscriptionFailure;
      controllerFailure = undefined;
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
    event: ClientEvent,
    generation = this.#transportGeneration,
    recoveryAttempt: number | undefined = undefined,
  ): void {
    if (this.#isRuntimeInactive() || !this.#isCurrentTransport(transport, generation)) return;
    const guard: TransportEventGuard = { transport, generation, recoveryAttempt };
    this.#queueSerializedEvent(async () => {
      if (this.#isRuntimeInactive() || !this.#isCurrentTransport(guard.transport, guard.generation)) return;
      await this.#dispatchAndRunEffects(event, guard);
      if (
        event.type === "fatal" &&
        !this.#isRuntimeInactive() &&
        this.#isCurrentTransport(guard.transport, guard.generation)
      ) {
        if (guard.recoveryAttempt !== undefined && this.#isRecoveryPending()) {
          this.#retireCurrentTransport(guard.transport, guard.generation, false);
          this.#failRecovery();
        } else {
          this.#endAndCloseTransport("transport_error");
          this.#requestCleanup();
        }
      }
    });
  }

  #queueSerializedEvent(operation: () => void | Promise<void>): Promise<void> {
    if (this.#isRuntimeInactive()) return Promise.resolve();
    if (this.#queuedEventCount >= MAX_QUEUED_EVENTS) {
      this.#handleEventQueueOverflow();
      return Promise.resolve();
    }
    this.#queuedEventCount += 1;
    const queuedOperation = this.#eventTail.then(async () => {
      try {
        await operation();
      } finally {
        this.#queuedEventCount -= 1;
      }
    });
    const settledOperation = queuedOperation.catch((error: unknown) => {
      this.#lastEventError = normalizeError(error, "G2 bridge event handling failed");
    });
    this.#eventTail = settledOperation;
    return settledOperation;
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
      this.#cancelRecoveryTimers();
      this.#cancelResultPipelineWatchdog();
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
        this.#cancelRecoveryTimers();
        this.#cancelResultPipelineWatchdog();
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
      if (
        (this.#state.state === "Ready" && this.#state.sessionReady) ||
        this.#state.state === "Results"
      ) {
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

  #dispatchAndRunEffects(
    event: ClientEvent,
    guard?: TransportEventGuard,
    onAuthOperation?: (operation: Promise<void>) => void,
  ): Promise<void> {
    if (this.#isRuntimeInactive()) return Promise.resolve();
    const reduction = this.#dispatch(event);
    if (
      event.type === "session.ready" &&
      guard?.recoveryAttempt !== undefined &&
      reduction.state.state === "Ready" &&
      reduction.state.sessionReady
    ) {
      this.#completeRecoveryAttempt(guard);
    } else if (
      reduction.state.state === "Error" &&
      guard?.recoveryAttempt !== undefined
    ) {
      this.#cancelRecoveryTimers();
    }
    return this.#runEffects(reduction.effects, onAuthOperation);
  }

  #dispatch(
    event: ClientEvent,
    scheduleDisplay = true,
  ): ReturnType<typeof reduceClientState> {
    if (this.#isRuntimeInactive()) {
      this.#cancelResultPipelineWatchdog();
      return { state: this.#state, effects: [] };
    }
    const previousState = this.#state;
    const reduction = reduceClientState(this.#state, event);
    this.#state = reduction.state;
    this.#syncResultPipelineWatchdog(previousState, event, this.#state);
    this.#publishPhoneAuthState();
    if (scheduleDisplay) this.#scheduleDisplay(this.#state);
    return reduction;
  }

  #syncResultPipelineWatchdog(
    previousState: ClientState,
    event: ClientEvent,
    nextState: ClientState,
  ): void {
    if (!isResultPipelineState(nextState)) {
      this.#cancelResultPipelineWatchdog();
      return;
    }
    if (
      isResultPipelineProgress(previousState, event, nextState) &&
      this.#resultPipelineWatchdogArmed
    ) {
      this.#armResultPipelineWatchdog(nextState);
    }
  }

  #cancelResultPipelineWatchdog(): void {
    this.#resultPipelineWatchdogGeneration += 1;
    this.#resultPipelineWatchdogArmed = false;
    const cancel = this.#resultPipelineWatchdogCancel;
    this.#resultPipelineWatchdogCancel = undefined;
    if (cancel === undefined) return;
    try {
      cancel();
    } catch {
      // A custom scheduler's cancellation is best effort.
    }
  }

  #armResultPipelineWatchdog(state: ResultPipelineState): void {
    this.#cancelResultPipelineWatchdog();
    const generation = this.#resultPipelineWatchdogGeneration;
    this.#resultPipelineWatchdogArmed = true;
    const timeoutEvent: ResultPipelineTimeoutEvent = {
      type: "utterance.aborted",
      sessionId: state.sessionId,
      sessionEpoch: state.sessionEpoch,
      utteranceId: state.utteranceId,
      category: "provider_loss",
    };
    try {
      this.#resultPipelineWatchdogCancel = this.#recoveryTiming.schedule(() => {
        if (this.#resultPipelineWatchdogGeneration !== generation) return;
        this.#resultPipelineWatchdogCancel = undefined;
        this.#queueResultPipelineTimeout(timeoutEvent, generation);
      }, RESULT_PIPELINE_DEADLINE_MS);
    } catch {
      this.#resultPipelineWatchdogCancel = undefined;
      this.#queueResultPipelineTimeout(timeoutEvent, generation);
    }
  }

  #queueResultPipelineTimeout(event: ResultPipelineTimeoutEvent, generation: number): void {
    void this.#queueSerializedEvent(() => {
      if (
        this.#isRuntimeInactive() ||
        this.#resultPipelineWatchdogGeneration !== generation ||
        !isResultPipelineState(this.#state) ||
        this.#state.sessionId !== event.sessionId ||
        this.#state.sessionEpoch !== event.sessionEpoch ||
        this.#state.utteranceId !== event.utteranceId
      ) return;
      this.#resultPipelineWatchdogArmed = false;
      try {
        this.#transport?.cancelUtterance({ retireImmediately: true });
      } catch {
        this.#handleEffectFailure();
        return;
      }
      return this.#dispatchAndRunEffects(event);
    });
  }

  async #runEffects(
    effects: readonly ClientEffect[],
    onAuthOperation?: (operation: Promise<void>) => void,
  ): Promise<void> {
    for (let index = 0; index < effects.length; index += 1) {
      const effect = effects[index];
      if (effect === undefined) continue;
      if (this.#isRuntimeInactive()) return;
      try {
        switch (effect.type) {
          case "check-enrollment": {
            const operation = this.#launchAuthOperation(
              effect.mode === "initialize"
                ? () => this.#authController.initialize()
                : () => this.#authController.retryPersistence(),
              (outcome) => this.#dispatchAndRunEffects(enrollmentOutcomeEvent(outcome)),
            );
            onAuthOperation?.(operation);
            break;
          }
          case "reset-enrollment": {
            const operation = this.#launchAuthOperation(
              () => this.#authController.resetEnrollment(),
              (outcome) => this.#dispatchAndRunEffects(enrollmentOutcomeEvent(outcome)),
            );
            onAuthOperation?.(operation);
            break;
          }
          case "prepare-session-auth": {
            const operation = this.#launchAuthOperation(
              () => this.#authController.prepareSessionBoundary({ allowRotation: true }),
              (outcome) => this.#dispatchAndRunEffects(
                sessionAuthOutcomeEvent(outcome, effect.authAttempt),
              ),
            );
            onAuthOperation?.(operation);
            break;
          }
          case "cancel-session-boundary":
            await this.#cancelSessionBoundary();
            break;
          case "persist-target":
            void this.#persistTarget(effect.targetLanguage);
            break;
          case "start-session":
            this.#startSession(effect.targetLanguage);
            break;
          case "start-fresh-session":
            await this.#beginFreshRecovery(effect.targetLanguage, effect.previousSessionId, effect.previousSessionEpoch);
            break;
          case "start-utterance":
            this.#transport?.startUtterance(effect.utteranceId);
            break;
          case "start-audio":
            await this.#startAudio(effect as StartAudioEffect);
            break;
          case "stop-audio":
            await this.#stopAudio();
            break;
          case "commit-utterance":
            {
              const transport = this.#transport;
              if (transport === undefined) break;
              transport.commitUtterance();
              const state = this.#state;
              if (
                isResultPipelineState(state) &&
                state.sessionId === effect.sessionId &&
                state.sessionEpoch === effect.sessionEpoch &&
                state.utteranceId === effect.utteranceId
              ) {
                this.#armResultPipelineWatchdog(state);
              }
            }
            break;
          case "end-session":
            this.#transport?.endSession("user_requested");
            break;
          case "request-translation":
          case "request-suggestions":
            break;
        }
      } catch {
        if (this.#isRecoveryPending()) {
          this.#failRecovery();
        } else {
          this.#handleEffectFailure();
        }
        return;
      }
    }
  }

  async #cancelSessionBoundary(): Promise<void> {
    this.#audioPcmEnabled = false;
    this.#invalidateAuthOperations();
    this.#cancelRecoveryTimers();
    this.#cancelResultPipelineWatchdog();
    this.#recoveryCycle += 1;
    this.#recoveryContext = undefined;
    this.#pendingRecoveryLoss = false;

    const transport = this.#transport;
    if (transport !== undefined) {
      const closeResult = this.#retireCurrentTransport(
        transport,
        this.#transportGeneration,
        false,
      );
      if (!closeResult.ok) throw closeResult.error;
    }

    await this.#stopAudio();
  }

  #handleEffectFailure(): void {
    if (this.#isRuntimeInactive()) return;
    this.#cancelRecoveryTimers();
    this.#dispatch({ type: "fatal" });
    this.#endAndCloseTransport("transport_error");
    this.#requestCleanup();
  }

  #endAndCloseTransport(
    reason: "user_requested" | "app_shutdown" | "transport_error",
  ): void {
    const transport = this.#transport;
    if (transport === undefined) return;
    const generation = this.#transportGeneration;
    const closeResult = this.#retireCurrentTransport(transport, generation, true, reason);
    if (!closeResult.ok) this.#requestCleanup();
  }

  #startSession(
    targetLanguage: TargetLanguage,
    recoveryAttempt?: number,
  ): { readonly transport: G2Transport; readonly generation: number } | undefined {
    this.#audioPcmFaultTransport = undefined;
    const priorTransport = this.#transport;
    if (priorTransport !== undefined) {
      const closeResult = this.#retireCurrentTransport(
        priorTransport,
        this.#transportGeneration,
        false,
      );
      if (!closeResult.ok) {
        throw closeResult.error;
      }
    }

    const generation = ++this.#transportGeneration;
    const transportReference: { current?: G2Transport } = {};
    const transportOptions: RelayTransportOptions = {
      relayOrigin: this.#relayOrigin,
      credentialProvider: this.#authController.credentialProvider,
      onEvent: (event) => {
        if (transportReference.current !== undefined) {
          this.#handleTransportCallback(
            transportReference.current,
            generation,
            recoveryAttempt,
            event,
          );
        }
      },
      onTransportError: (error) => {
        if (transportReference.current !== undefined) {
          this.#handleTransportError(
            transportReference.current,
            generation,
            recoveryAttempt,
            error,
          );
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
          if (!this.#isCurrentTransport(transport, generation)) return;
          if (recoveryAttempt !== undefined) {
            this.#handleRecoveryAttemptFailure(
              transport,
              generation,
              recoveryAttempt,
              "retry",
            );
          } else {
            this.#failTransport(transport, generation);
          }
        },
      );
    } catch {
      this.#pendingTransportStarts.delete(transport);
      if (this.#isCurrentTransport(transport, generation)) {
        if (recoveryAttempt !== undefined) {
          this.#handleRecoveryAttemptFailure(
            transport,
            generation,
            recoveryAttempt,
            "retry",
          );
        } else {
          this.#failTransport(transport, generation);
        }
      }
    }
    return { transport, generation };
  }

  #failTransport(transport: G2Transport, generation = this.#transportGeneration): void {
    if (this.#isRuntimeInactive() || !this.#isCurrentTransport(transport, generation)) return;
    this.#dispatch({ type: "fatal" });
    this.#endAndCloseTransport("transport_error");
    this.#requestCleanup();
  }

  #handleTransportError(
    transport: G2Transport,
    generation: number,
    recoveryAttempt: number | undefined,
    error: RelayTransportError,
  ): void {
    if (this.#isRuntimeInactive() || !this.#isCurrentTransport(transport, generation)) return;
    if (recoveryAttempt !== undefined && this.#isRecoveryPending()) {
      this.#handleRecoveryAttemptFailure(
        transport,
        generation,
        recoveryAttempt,
        error.recoveryDisposition,
      );
      return;
    }
    this.#queueTransportEvent(
      transport,
      transportErrorEvent(error, this.#state),
      generation,
    );
  }

  #handleTransportCallback(
    transport: G2Transport,
    generation: number,
    recoveryAttempt: number | undefined,
    event: RelayTransportCallbackEvent,
  ): void {
    if (this.#isRuntimeInactive() || !this.#isCurrentTransport(transport, generation)) return;
    if (event.type === "transport.lost") {
      if (recoveryAttempt !== undefined && this.#isRecoveryPending()) {
        this.#handleRecoveryAttemptFailure(
          transport,
          generation,
          recoveryAttempt,
          "retry",
        );
        return;
      }
      this.#handleTransportLostSynchronously(transport, generation, event);
      return;
    }
    if (event.type === "fatal") {
      this.#queueTransportEvent(transport, event, generation, recoveryAttempt);
      return;
    }
    if (event.type === "session.rejected") {
      this.#queueTransportEvent(transport, { type: "fatal" }, generation, recoveryAttempt);
      return;
    }
    const clientEvent = toClientEvent(event);
    if (clientEvent !== undefined) {
      this.#queueTransportEvent(transport, clientEvent, generation, recoveryAttempt);
    }
  }

  #isCurrentTransport(transport: G2Transport, generation: number): boolean {
    return this.#transport === transport && this.#transportGeneration === generation;
  }

  #retireCurrentTransport(
    transport: G2Transport,
    generation: number,
    endSession: boolean,
    reason: "user_requested" | "app_shutdown" | "transport_error" = "transport_error",
  ): TransportCloseResult {
    if (!this.#isCurrentTransport(transport, generation)) return { ok: true };
    this.#audioPcmEnabled = false;
    this.#transport = undefined;
    this.#transportGeneration += 1;
    this.#pendingTransportStarts.delete(transport);
    if (endSession) {
      try {
        transport.endSession(reason);
      } catch {
        // Closing remains best effort after a failed session-end call.
      }
    }
    const closeResult = this.#tryCloseTransport(transport);
    if (!closeResult.ok) {
      this.#cancelRecoveryTimers();
      this.#dispatch({ type: "fatal" });
      this.#requestCleanup();
    }
    return closeResult;
  }

  #handleTransportLostSynchronously(
    transport: G2Transport,
    generation: number,
    event: Extract<RelayTransportCallbackEvent, { readonly type: "transport.lost" }>,
  ): void {
    if (this.#isRuntimeInactive() || !this.#isCurrentTransport(transport, generation)) return;
    this.#audioPcmEnabled = false;
    this.#pendingRecoveryLoss = true;
    this.#cancelRecoveryTimers();
    this.#cancelResultPipelineWatchdog();
    this.#retireCurrentTransport(transport, generation, false);

    // The transport is detached before this callback enters the serialized
    // reducer. A later callback from this dead transport therefore cannot
    // replace the fresh-session attempt or feed it stale events.
    this.#queueSerializedEvent(async () => {
      if (this.#isRuntimeInactive()) return;
      const reduction = this.#dispatch(event);
      if (!this.#isRecoveryPending()) {
        this.#pendingRecoveryLoss = false;
        return;
      }
      await this.#runEffects(reduction.effects);
    });
  }

  #isRecoveryPending(): boolean {
    return this.#state.state === "Ready" && this.#state.pending === "recovery";
  }

  #recoveryNow(): number {
    const now = this.#recoveryTiming.now();
    return Number.isFinite(now) ? now : Date.now();
  }

  #recoveryRandom(): number {
    const random = this.#recoveryTiming.random();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw new RangeError("recoveryTiming.random must return a number in [0, 1)");
    }
    return random;
  }

  #pruneRecoveryAttempts(context: RecoveryContext, now: number): void {
    const oldest = now - RECOVERY_LONG_ATTEMPT_WINDOW_MS;
    while (context.attemptTimes[0] !== undefined && context.attemptTimes[0] <= oldest) {
      context.attemptTimes.shift();
    }
  }

  #recoveryBudgetAvailable(context: RecoveryContext, now: number): boolean {
    this.#pruneRecoveryAttempts(context, now);
    const recentMinute = context.attemptTimes.filter((time) => now - time < RECOVERY_ATTEMPT_WINDOW_MS);
    const recentTenMinutes = context.attemptTimes.filter(
      (time) => now - time < RECOVERY_LONG_ATTEMPT_WINDOW_MS,
    );
    return context.consecutiveAttempts < RECOVERY_MAX_CONSECUTIVE_ATTEMPTS &&
      recentMinute.length < RECOVERY_MAX_ATTEMPTS_PER_WINDOW &&
      recentTenMinutes.length < RECOVERY_MAX_ATTEMPTS_PER_LONG_WINDOW;
  }

  #cancelRecoveryTimers(): void {
    const context = this.#recoveryContext;
    if (context?.scheduledCancel !== undefined) {
      try {
        context.scheduledCancel();
      } catch {
        // A custom scheduler's cancellation is best effort.
      }
      context.scheduledCancel = undefined;
    }
    const active = context?.activeAttempt;
    if (active?.deadlineCancel !== undefined) {
      try {
        active.deadlineCancel();
      } catch {
        // A custom scheduler's cancellation is best effort.
      }
      active.deadlineCancel = undefined;
    }
  }

  async #beginFreshRecovery(
    targetLanguage: TargetLanguage,
    previousSessionId: string,
    previousSessionEpoch: number,
  ): Promise<void> {
    if (!this.#isRecoveryPending() || this.#isRuntimeInactive()) return;

    this.#cancelRecoveryTimers();
    const cycle = ++this.#recoveryCycle;
    const previousTimes = this.#recoveryContext?.attemptTimes ?? [];
    const context: RecoveryContext = {
      cycle,
      targetLanguage,
      previousSessionId,
      previousSessionEpoch,
      consecutiveAttempts: 0,
      attemptTimes: previousTimes,
      scheduledCancel: undefined,
      activeAttempt: undefined,
    };
    this.#recoveryContext = context;

    try {
      await this.#awaitMicrophoneShutdownForRecovery();
    } catch {
      this.#pendingRecoveryLoss = false;
      this.#failRecovery();
      return;
    }
    this.#pendingRecoveryLoss = false;
    if (this.#isRuntimeInactive() || this.#recoveryContext !== context || !this.#isRecoveryPending()) return;
    this.#scheduleRecoveryAttempt(context);
  }

  #scheduleRecoveryAttempt(context: RecoveryContext): void {
    if (this.#isRuntimeInactive() || this.#recoveryContext !== context || !this.#isRecoveryPending()) return;
    const now = this.#recoveryNow();
    if (!this.#recoveryBudgetAvailable(context, now)) {
      this.#failRecovery();
      return;
    }
    let delay: number;
    try {
      const cap = Math.min(
        RECOVERY_BACKOFF_MAX_MS,
        RECOVERY_BACKOFF_BASE_MS * 2 ** context.consecutiveAttempts,
      );
      delay = cap / 2 + this.#recoveryRandom() * cap / 2;
    } catch {
      this.#failRecovery();
      return;
    }

    const cycle = context.cycle;
    try {
      context.scheduledCancel = this.#recoveryTiming.schedule(() => {
        if (this.#recoveryContext !== context || context.cycle !== cycle) return;
        context.scheduledCancel = undefined;
        this.#queueSerializedEvent(() => {
          if (this.#recoveryContext !== context || context.cycle !== cycle) return;
          this.#startRecoveryAttempt(context);
        });
      }, delay);
    } catch {
      this.#failRecovery();
    }
  }

  #startRecoveryAttempt(context: RecoveryContext): void {
    if (this.#isRuntimeInactive() || this.#recoveryContext !== context || !this.#isRecoveryPending()) return;
    const now = this.#recoveryNow();
    if (!this.#recoveryBudgetAvailable(context, now)) {
      this.#failRecovery();
      return;
    }

    const attempt = context.consecutiveAttempts + 1;
    context.consecutiveAttempts = attempt;
    context.attemptTimes.push(now);
    const active: RecoveryAttempt = {
      cycle: context.cycle,
      attempt,
      transport: undefined,
      transportGeneration: undefined,
      deadlineCancel: undefined,
    };
    context.activeAttempt = active;

    this.#launchAuthOperation(
      () => this.#authController.prepareSessionBoundary({ allowRotation: true }),
      async (outcome) => {
        if (
          this.#recoveryContext !== context ||
          context.activeAttempt !== active ||
          !this.#isRecoveryPending()
        ) return;
        if (outcome.kind === "unavailable") {
          this.#finishRecoveryAttemptFailure(context, active, "retry");
          return;
        }
        if (outcome.kind === "required") {
          context.activeAttempt = undefined;
          await this.#dispatchAndRunEffects({ type: "credential.rejected" });
          return;
        }
        if (outcome.kind === "storage-error") {
          context.activeAttempt = undefined;
          await this.#dispatchAndRunEffects({ type: "credential.storage-error" });
          return;
        }

        let binding: { readonly transport: G2Transport; readonly generation: number } | undefined;
        try {
          binding = this.#startSession(context.targetLanguage, attempt);
        } catch {
          this.#finishRecoveryAttemptFailure(context, active, "retry");
          return;
        }
        if (this.#recoveryContext !== context || context.activeAttempt !== active) return;
        if (binding === undefined) {
          this.#finishRecoveryAttemptFailure(context, active, "retry");
          return;
        }
        active.transport = binding.transport;
        active.transportGeneration = binding.generation;
        try {
          active.deadlineCancel = this.#recoveryTiming.schedule(() => {
            if (this.#recoveryContext !== context || context.activeAttempt !== active) return;
            active.deadlineCancel = undefined;
            this.#handleRecoveryAttemptFailure(
              binding!.transport,
              binding!.generation,
              active.attempt,
              "retry",
            );
          }, RECOVERY_READY_DEADLINE_MS);
        } catch {
          this.#handleRecoveryAttemptFailure(
            binding.transport,
            binding.generation,
            active.attempt,
            "stop",
          );
        }
      },
    );
  }

  #handleRecoveryAttemptFailure(
    transport: G2Transport,
    generation: number,
    attempt: number,
    disposition: "retry" | "stop",
  ): void {
    const context = this.#recoveryContext;
    const active = context?.activeAttempt;
    if (
      context === undefined ||
      active === undefined ||
      active.attempt !== attempt ||
      (active.transport !== undefined && active.transport !== transport) ||
      (active.transportGeneration !== undefined && active.transportGeneration !== generation)
    ) return;
    this.#retireCurrentTransport(transport, generation, false);
    this.#queueSerializedEvent(() => {
      if (this.#recoveryContext !== context || context.activeAttempt?.attempt !== attempt) return;
      const active = context.activeAttempt;
      if (active === undefined) return;
      this.#finishRecoveryAttemptFailure(context, active, disposition);
    });
  }

  #finishRecoveryAttemptFailure(
    context: RecoveryContext,
    active: RecoveryAttempt,
    disposition: "retry" | "stop",
  ): void {
    if (this.#recoveryContext !== context || context.activeAttempt !== active) return;
    if (active.deadlineCancel !== undefined) {
      try {
        active.deadlineCancel();
      } catch {
        // A custom scheduler's cancellation is best effort.
      }
      active.deadlineCancel = undefined;
    }
    context.activeAttempt = undefined;
    if (disposition === "stop" || !this.#recoveryBudgetAvailable(context, this.#recoveryNow())) {
      this.#failRecovery();
      return;
    }
    this.#scheduleRecoveryAttempt(context);
  }

  #completeRecoveryAttempt(guard: TransportEventGuard): void {
    const context = this.#recoveryContext;
    const active = context?.activeAttempt;
    if (
      context === undefined ||
      active === undefined ||
      active.attempt !== guard.recoveryAttempt ||
      active.transport !== guard.transport ||
      active.transportGeneration !== guard.generation
    ) return;
    if (active.deadlineCancel !== undefined) {
      try {
        active.deadlineCancel();
      } catch {
        // A custom scheduler's cancellation is best effort.
      }
      active.deadlineCancel = undefined;
    }
    if (context.scheduledCancel !== undefined) {
      try {
        context.scheduledCancel();
      } catch {
        // A custom scheduler's cancellation is best effort.
      }
      context.scheduledCancel = undefined;
    }
    context.activeAttempt = undefined;
    context.consecutiveAttempts = 0;
  }

  #failRecovery(): void {
    const context = this.#recoveryContext;
    const pendingState = this.#state.state === "Ready" && this.#state.pending === "recovery"
      ? this.#state
      : undefined;
    this.#cancelRecoveryTimers();
    this.#cancelResultPipelineWatchdog();
    this.#recoveryCycle += 1;
    this.#recoveryContext = undefined;
    this.#pendingRecoveryLoss = false;
    if (!this.#isRecoveryPending()) return;
    this.#dispatch({
      type: "recovery.failed",
      sessionId: context?.previousSessionId ?? pendingState!.previousSessionId,
      sessionEpoch: context?.previousSessionEpoch ?? pendingState!.previousSessionEpoch,
    });
  }

  async #awaitMicrophoneShutdownForRecovery(): Promise<void> {
    this.#audioPcmEnabled = false;
    const pendingAudioOpen = this.#pendingAudioOpen;
    if (pendingAudioOpen !== undefined) {
      try {
        await this.#awaitWithTimeout(
          pendingAudioOpen,
          "G2 audio open timed out during recovery",
          AUDIO_CLOSE_TIMEOUT_MS,
        );
      } catch (error: unknown) {
        // A late open is still owned by the old turn. The close pass below
        // makes the recovery failure terminal without opening a new turn.
        if (this.#audioOpen || this.#audioOpenUncertain || this.#audioCloseRequired) {
          try {
            const closed = await this.#awaitWithTimeout(
              this.#closeAudio(),
              "G2 audio close timed out during recovery",
              AUDIO_CLOSE_TIMEOUT_MS,
            );
            if (!closed) throw new Error("G2 audio close failed during recovery");
          } catch (closeError: unknown) {
            throw normalizeError(closeError, "G2 audio close failed during recovery");
          }
        }
        throw normalizeError(error, "G2 audio open failed during recovery");
      }
    }

    const pendingAudioClose = this.#pendingAudioClose;
    if (pendingAudioClose !== undefined) {
      const closed = await this.#awaitWithTimeout(
        pendingAudioClose,
        "G2 audio close timed out during recovery",
        AUDIO_CLOSE_TIMEOUT_MS,
      );
      if (!closed) throw new Error("G2 audio close failed during recovery");
    }
    if (!this.#audioOpen && !this.#audioOpenUncertain && !this.#audioCloseRequired) return;
    const closed = await this.#awaitWithTimeout(
      this.#closeAudio(),
      "G2 audio close timed out during recovery",
      AUDIO_CLOSE_TIMEOUT_MS,
    );
    if (!closed) throw new Error("G2 audio close failed during recovery");
  }

  async #startAudio(effect: StartAudioEffect): Promise<void> {
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
    const ownerTransport = this.#transport;
    const ownerTransportGeneration = this.#transportGeneration;
    const ownsTurn = (): boolean => {
      const state = this.#state;
      return ownerTransport !== undefined &&
        this.#isCurrentTransport(ownerTransport, ownerTransportGeneration) &&
        state.state === "Listening" &&
        state.sessionId === effect.sessionId &&
        state.sessionEpoch === effect.sessionEpoch &&
        state.utteranceId === effect.utteranceId;
    };
    if (!ownsTurn()) return;
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
        if (ownsTurn() && !this.#isRuntimeInactive()) {
          this.#audioPcmEnabled = true;
        } else {
          this.#audioPcmEnabled = false;
          const lateClose = this.#closeAudio();
          return lateClose.then((closed) => {
            if (!closed) throw new Error("G2 audio close failed");
          });
        }
        return undefined;
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
    } catch (error: unknown) {
      if (this.#pendingRecoveryLoss && this.#pendingAudioOpen === opening) return;
      throw error;
    } finally {
      if (this.#pendingAudioOpen === opening) {
        if (!this.#pendingRecoveryLoss) this.#pendingAudioOpen = undefined;
        this.#audioOpenUncertain = true;
      }
    }
  }

  async #stopAudio(): Promise<void> {
    const pendingAudioClose = this.#pendingAudioClose;
    if (!this.#audioOpen && pendingAudioClose !== undefined) {
      const closed = await this.#awaitWithCleanup(
        pendingAudioClose,
        "G2 audio close timed out",
        AUDIO_CLOSE_TIMEOUT_MS,
      );
      if (closed === CLEANUP_PREEMPTED) return;
      if (!closed) throw new Error("G2 audio close failed");
      return;
    }
    if (!this.#audioOpen && this.#pendingAudioOpen === undefined && !this.#audioOpenUncertain && !this.#audioCloseRequired) return;
    this.#audioPcmEnabled = false;
    this.#audioCloseRequired = true;
    if (!this.#audioOpen && this.#pendingAudioOpen !== undefined) {
      await this.#awaitMicrophoneShutdownForRecovery();
      return;
    }
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
    this.#cancelResultPipelineWatchdog();
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
