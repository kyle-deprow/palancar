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

import type {
  AuthOutcome,
  G2AuthController,
  SessionCredentialProvider,
} from "../src/auth/types.js";
import {
  G2BridgeRuntime,
  PALANCAR_G2_READY,
  RECOVERY_ATTEMPT_WINDOW_MS,
  RECOVERY_BACKOFF_BASE_MS,
  RECOVERY_BACKOFF_MAX_MS,
  RECOVERY_LONG_ATTEMPT_WINDOW_MS,
  RECOVERY_MAX_ATTEMPTS_PER_LONG_WINDOW,
  RECOVERY_MAX_CONSECUTIVE_ATTEMPTS,
  RECOVERY_READY_DEADLINE_MS,
  RESULT_PIPELINE_DEADLINE_MS,
  type RecoveryTiming,
  isPairedTurnEffects,
  type G2BridgePort,
  type G2Transport,
} from "../src/bridge/index.js";
import { PAGE_LAYOUTS } from "../src/display/index.js";
import { RelayTransportError } from "../src/transport/index.js";
import type {
  RelayTransportCallbackEvent,
  RelayTransportOptions,
} from "../src/transport/index.js";

const RELAY_ORIGIN = "https://relay.example";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RECOVERY_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const UTTERANCE_ID = "22222222-2222-4222-8222-222222222222";
const NEXT_UTTERANCE_ID = "66666666-6666-4666-8666-666666666666";

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
  activeUtteranceId: string | undefined;
  committed = false;
  startUtteranceRejected = false;
  closed = false;
  pushPcmImplementation: (() => void) | undefined;
  commitImplementation: (() => void) | undefined;
  closeImplementation: (() => void) | undefined;
  readonly startSessionImplementation: ((targetLanguage: "es" | "tr") => Promise<void>) | undefined;
  readonly statefulUtteranceLifecycle: boolean;

  constructor(
    options: RelayTransportOptions,
    calls: string[],
    startSessionImplementation?: (targetLanguage: "es" | "tr") => Promise<void>,
    statefulUtteranceLifecycle = false,
  ) {
    this.options = options;
    this.calls = calls;
    this.startSessionImplementation = startSessionImplementation;
    this.statefulUtteranceLifecycle = statefulUtteranceLifecycle;
  }

  async startSession(targetLanguage: "es" | "tr"): Promise<void> {
    this.calls.push(`start-session:${targetLanguage}`);
    this.targetLanguage = targetLanguage;
    await this.startSessionImplementation?.(targetLanguage);
  }

  startUtterance(utteranceId: string): void {
    if (this.statefulUtteranceLifecycle && this.activeUtteranceId !== undefined) {
      this.startUtteranceRejected = true;
      return;
    }
    this.calls.push(`start-utterance:${utteranceId}`);
    this.activeUtteranceId = utteranceId;
    this.committed = false;
  }

  pushPcm(pcm: Uint8Array): void {
    this.calls.push("pcm");
    this.pushPcmImplementation?.();
    this.pcm.push(pcm);
  }

  commitUtterance(): void {
    this.calls.push("commit");
    if (this.statefulUtteranceLifecycle) this.committed = true;
    this.commitImplementation?.();
  }

  cancelUtterance(): void {
    this.calls.push("cancel");
    if (this.statefulUtteranceLifecycle) {
      this.activeUtteranceId = undefined;
      this.committed = false;
    }
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

  emitError(recoveryDisposition: RelayTransportError["recoveryDisposition"]): void;
  emitError(
    kind: RelayTransportError["kind"],
    recoveryDisposition: RelayTransportError["recoveryDisposition"],
  ): void;
  emitError(
    kindOrDisposition: RelayTransportError["kind"] | RelayTransportError["recoveryDisposition"],
    recoveryDisposition?: RelayTransportError["recoveryDisposition"],
  ): void {
    const kind = recoveryDisposition === undefined ? "websocket" : kindOrDisposition as RelayTransportError["kind"];
    const disposition = recoveryDisposition ?? kindOrDisposition as RelayTransportError["recoveryDisposition"];
    this.options.onTransportError?.(new RelayTransportError(kind, disposition));
  }
}

const fakeCredentialProvider: SessionCredentialProvider = Object.freeze({
  acquire: async () => ({ kind: "required" as const }),
  recordAuthenticated: async () => "stale" as const,
  reject: async () => "stale" as const,
});

class FakeAuthController implements G2AuthController {
  readonly credentialProvider = fakeCredentialProvider;
  readonly calls: string[];
  readonly pairingCodes: string[] = [];
  readonly boundaryOptions: { readonly allowRotation: boolean }[] = [];
  initializeImplementation: () => Promise<AuthOutcome> = async () => ({ kind: "ready" });
  enrollImplementation: (pairingCode: string) => Promise<AuthOutcome> = async () => ({ kind: "ready" });
  retryPersistenceImplementation: () => Promise<AuthOutcome> = async () => ({ kind: "ready" });
  resetEnrollmentImplementation: () => Promise<AuthOutcome> = async () => ({
    kind: "required",
    reason: "missing",
  });
  prepareSessionBoundaryImplementation:
    (options: { readonly allowRotation: boolean }) => Promise<AuthOutcome> = async () => ({
      kind: "ready",
    });
  revokeCurrentImplementation: () => Promise<AuthOutcome> = async () => ({
    kind: "required",
    reason: "revoked",
  });
  disposeCount = 0;

  constructor(calls: string[]) {
    this.calls = calls;
  }

  initialize(): Promise<AuthOutcome> {
    this.calls.push("auth:initialize");
    return this.initializeImplementation();
  }

  enroll(pairingCode: string): Promise<AuthOutcome> {
    this.calls.push("auth:enroll");
    this.pairingCodes.push(pairingCode);
    return this.enrollImplementation(pairingCode);
  }

  retryPersistence(): Promise<AuthOutcome> {
    this.calls.push("auth:retry-persistence");
    return this.retryPersistenceImplementation();
  }

  resetEnrollment(): Promise<AuthOutcome> {
    this.calls.push("auth:reset-enrollment");
    return this.resetEnrollmentImplementation();
  }

  prepareSessionBoundary(
    options: { readonly allowRotation: boolean },
  ): Promise<AuthOutcome> {
    this.calls.push("auth:prepare-session-boundary");
    this.boundaryOptions.push({ ...options });
    return this.prepareSessionBoundaryImplementation(options);
  }

  revokeCurrent(): Promise<AuthOutcome> {
    this.calls.push("auth:revoke-current");
    return this.revokeCurrentImplementation();
  }

  dispose(): void {
    this.calls.push("auth:dispose");
    this.disposeCount += 1;
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

const readyEvent = (
  targetLanguage: "es" | "tr" = "es",
  sessionId = SESSION_ID,
  sessionEpoch = 1,
): RelayTransportCallbackEvent => ({
  type: "session.ready",
  result: "new",
  sessionId,
  sessionEpoch,
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
  readonly auth: FakeAuthController;
  readonly transports: FakeTransport[];
  readonly operations: string[];
  readonly persisted: string[];
}

interface HarnessOptions {
  readonly authController?: FakeAuthController;
  readonly waitForBridge?: () => Promise<G2BridgePort>;
  readonly startSession?: (targetLanguage: "es" | "tr") => Promise<void>;
  readonly persistTarget?: (targetLanguage: "es" | "tr") => void | Promise<void>;
  readonly idGenerator?: () => string;
  readonly utteranceIds?: readonly string[];
  readonly displayDebounceMs?: number;
  readonly recoveryTiming?: RecoveryTiming;
  readonly statefulTransport?: boolean;
}

function createHarness(harnessOptions: HarnessOptions = {}): TestHarness {
  const transports: FakeTransport[] = [];
  const operations: string[] = [];
  const bridge = new FakeBridge(operations);
  const auth = harnessOptions.authController ?? new FakeAuthController(operations);
  const persisted: string[] = [];
  let generatedUtteranceIndex = 0;
  const idGenerator = harnessOptions.idGenerator ?? (() => {
    const generated = harnessOptions.utteranceIds?.[generatedUtteranceIndex] ?? UTTERANCE_ID;
    generatedUtteranceIndex += 1;
    return generated;
  });
  const runtime = new G2BridgeRuntime({
    relayOrigin: RELAY_ORIGIN,
    authController: auth,
    waitForBridge: harnessOptions.waitForBridge ?? (async () => bridge),
    readyLogger: (marker) => bridge.calls.push(`ready:${marker}`),
    createTransport: (options) => {
      const transport = new FakeTransport(
        options,
        operations,
        harnessOptions.startSession,
        harnessOptions.statefulTransport,
      );
      transports.push(transport);
      return transport;
    },
    idGenerator,
    storage: {
      setTarget: (target) => {
        persisted.push(target);
        return harnessOptions.persistTarget?.(target);
      },
    },
    displayDebounceMs: harnessOptions.displayDebounceMs ?? 0,
    ...(harnessOptions.recoveryTiming === undefined
      ? {}
      : { recoveryTiming: harnessOptions.recoveryTiming }),
  });
  return { bridge, runtime, auth, transports, operations, persisted };
}

async function bootToEnrollmentChecking(harness: TestHarness): Promise<void> {
  await harness.runtime.boot();
}

async function boot(harness: TestHarness): Promise<void> {
  await bootToEnrollmentChecking(harness);
  await harness.runtime.whenEventsIdle();
}

async function authenticateSession(harness: TestHarness): Promise<void> {
  await harness.runtime.whenEventsIdle();
}

async function flushMicrotasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function fakeRecoveryTiming(random = 0): RecoveryTiming {
  return {
    now: () => Date.now(),
    random: () => random,
    schedule: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    },
  };
}

interface ManualRecoveryTimer {
  readonly delayMs: number;
  readonly callback: () => void;
  readonly at: number;
  cancelled: boolean;
  fired: boolean;
}

interface ManualRecoveryClock {
  readonly timing: RecoveryTiming;
  readonly timers: ManualRecoveryTimer[];
  now: number;
  fireNext(delayMs: number): ManualRecoveryTimer;
}

function manualRecoveryClock(random = 0): ManualRecoveryClock {
  const timers: ManualRecoveryTimer[] = [];
  const clock: ManualRecoveryClock = {
    now: 0,
    timing: {
      now: () => clock.now,
      random: () => random,
      schedule: (callback, delayMs) => {
        const timer: ManualRecoveryTimer = {
          delayMs,
          callback,
          at: clock.now + delayMs,
          cancelled: false,
          fired: false,
        };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
    timers,
    fireNext: (delayMs) => {
      const timer = timers.find((candidate) =>
        !candidate.cancelled && !candidate.fired && candidate.delayMs === delayMs);
      if (timer === undefined) throw new Error(`No active recovery timer for ${delayMs}ms`);
      clock.now = timer.at;
      timer.fired = true;
      timer.callback();
      return timer;
    },
  };
  return clock;
}

function recoverySessionId(index: number): string {
  const digit = ((index + 3) % 16).toString(16);
  return `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
}

async function selectSpanishAndStart(harness: TestHarness): Promise<FakeTransport> {
  await boot(harness);
  harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
  await harness.runtime.whenEventsIdle();
  await authenticateSession(harness);
  const transport = harness.transports[0];
  if (transport === undefined) throw new Error("Transport was not created");
  return transport;
}

describe("G2BridgeRuntime startup", () => {
  it("creates one startup container and renders EnrollmentChecking before initialization completes", async () => {
    const harness = createHarness();
    let resolveInitialize: ((outcome: AuthOutcome) => void) | undefined;
    harness.auth.initializeImplementation = () => new Promise((resolve) => {
      resolveInitialize = resolve;
    });
    const phoneStates: unknown[] = [];
    harness.runtime.subscribePhoneAuthState((state) => phoneStates.push(state));
    await harness.runtime.boot();
    await vi.waitFor(() => {
      expect(harness.runtime.snapshot.lastDisplayContent.status).toBe("Checking enrollment");
    });

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
    expect(harness.runtime.snapshot.state).toBe("EnrollmentChecking");
    expect(harness.runtime.snapshot.target).toBe("es");
    expect(harness.runtime.snapshot.lastDisplayContent).toEqual({
      status: "Checking enrollment",
      target: "Target: Spanish",
      source: "Source: unavailable",
      english: "English: unavailable",
      suggestion: "Please wait",
    });
    expect(harness.auth.calls).toEqual(["auth:initialize"]);
    expect(harness.transports).toHaveLength(0);
    expect(harness.bridge.audioCalls).toHaveLength(0);
    expect(phoneStates).toEqual([{ status: "starting" }, { status: "checking" }]);
    expect(harness.bridge.calls).toContain(`ready:${PALANCAR_G2_READY}`);

    resolveInitialize?.({ kind: "required", reason: "missing" });
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("EnrollmentRequired");
  });

  it("maps enrollment commands to fixed redacted lifecycle states without retaining the pairing code", async () => {
    const harness = createHarness();
    harness.auth.initializeImplementation = async () => ({
      kind: "required",
      reason: "missing",
    });
    await boot(harness);
    expect(harness.runtime.snapshot.state).toBe("EnrollmentRequired");
    expect(harness.runtime.snapshot.lastDisplayContent.status).toBe("Enrollment required");
    expect(harness.runtime.snapshot.lastDisplayContent.suggestion).toBe("Continue on phone");

    let resolveEnroll: ((outcome: AuthOutcome) => void) | undefined;
    harness.auth.enrollImplementation = () => new Promise((resolve) => {
      resolveEnroll = resolve;
    });
    const pairingCode = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
    const enrollment = harness.runtime.enroll(pairingCode);
    await vi.waitFor(() => expect(harness.runtime.snapshot.state).toBe("Enrolling"));
    expect(harness.runtime.snapshot.state).toBe("Enrolling");
    expect(harness.runtime.snapshot.lastDisplayContent.status).toBe("Enrolling");
    expect(harness.runtime.snapshot.lastDisplayContent.suggestion).toBe("Complete on phone");

    expect(JSON.stringify(harness.runtime.snapshot)).not.toContain(pairingCode);
    resolveEnroll?.({ kind: "storage-error" });
    await enrollment;
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("StorageError");
    expect(harness.runtime.snapshot.lastDisplayContent.status).toBe(
      "Enrollment storage error",
    );
    expect(harness.runtime.snapshot.lastDisplayContent.suggestion).toBe("Retry on phone");

    let resolveRetry: ((outcome: AuthOutcome) => void) | undefined;
    harness.auth.retryPersistenceImplementation = () => new Promise((resolve) => {
      resolveRetry = resolve;
    });
    const retry = harness.runtime.retryEnrollment();
    await vi.waitFor(() => expect(harness.runtime.snapshot.state).toBe("EnrollmentChecking"));
    expect(harness.runtime.snapshot.state).toBe("EnrollmentChecking");
    expect(harness.runtime.snapshot.lastDisplayContent.status).toBe("Checking enrollment");
    resolveRetry?.({ kind: "ready" });
    await retry;
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("TargetSelection");

    let resolveRevocation: ((outcome: AuthOutcome) => void) | undefined;
    harness.auth.revokeCurrentImplementation = () => new Promise((resolve) => {
      resolveRevocation = resolve;
    });
    const revocation = harness.runtime.revokeEnrollment();
    await vi.waitFor(() => expect(harness.runtime.snapshot.state).toBe("EnrollmentChecking"));
    expect(harness.runtime.snapshot.lastDisplayContent.status).toBe(
      "Revoking enrollment",
    );
    resolveRevocation?.({ kind: "required", reason: "revoked" });
    await revocation;
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("EnrollmentRequired");
  });

  it("prepares each auth attempt and ignores a stale completion after revocation", async () => {
    const harness = createHarness();
    await boot(harness);
    expect(harness.runtime.snapshot.state).toBe("TargetSelection");

    let resolveFirstPrepare: ((outcome: AuthOutcome) => void) | undefined;
    harness.auth.prepareSessionBoundaryImplementation = () => new Promise((resolve) => {
      resolveFirstPrepare = resolve;
    });
    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await vi.waitFor(() => expect(harness.runtime.snapshot.state).toBe("Ready"));
    expect(harness.runtime.snapshot.state).toBe("Ready");
    expect(harness.runtime.snapshot.sessionReady).toBe(false);
    expect(harness.runtime.snapshot.lastDisplayContent.status).toBe("Authenticating");
    expect(harness.transports).toHaveLength(0);

    const revocation = harness.runtime.revokeEnrollment();
    await vi.waitFor(() => expect(harness.auth.calls).toContain("auth:revoke-current"));
    resolveFirstPrepare?.({ kind: "ready" });
    await revocation;
    await flushMicrotasks();
    expect(harness.runtime.snapshot.state).toBe("EnrollmentRequired");
    expect(harness.transports).toHaveLength(0);
    expect(harness.auth.boundaryOptions).toEqual([{ allowRotation: true }]);
  });

  it("shares one in-flight revocation across concurrent duplicate commands", async () => {
    const harness = createHarness();
    await boot(harness);
    let resolveRevocation: ((outcome: AuthOutcome) => void) | undefined;
    harness.auth.revokeCurrentImplementation = () => new Promise((resolve) => {
      resolveRevocation = resolve;
    });
    const phoneStates: unknown[] = [];
    harness.runtime.subscribePhoneAuthState((state) => phoneStates.push(state));

    const first = harness.runtime.revokeEnrollment();
    const duplicate = harness.runtime.revokeEnrollment();
    expect(duplicate).toBe(first);
    await vi.waitFor(() => {
      expect(harness.auth.calls.filter((call) => call === "auth:revoke-current")).toHaveLength(1);
    });
    const lateDuplicate = harness.runtime.revokeEnrollment();
    expect(lateDuplicate).toBe(first);
    expect(harness.runtime.snapshot.lastDisplayContent.status).toBe("Revoking enrollment");

    resolveRevocation?.({ kind: "required", reason: "revoked" });
    await Promise.all([first, duplicate, lateDuplicate]);
    await harness.runtime.whenEventsIdle();

    expect(harness.auth.calls.filter((call) => call === "auth:revoke-current")).toHaveLength(1);
    expect(harness.runtime.snapshot.state).toBe("EnrollmentRequired");
    expect(phoneStates.at(-1)).toEqual({ status: "required", reason: "revoked" });
  });

  it("enters Enrolling before the controller performs pairing health work", async () => {
    const harness = createHarness();
    harness.auth.initializeImplementation = async () => ({
      kind: "required",
      reason: "missing",
    });
    await boot(harness);
    harness.auth.enrollImplementation = async () => {
      expect(harness.runtime.snapshot.state).toBe("Enrolling");
      harness.operations.push("auth:pairing-health");
      harness.operations.push("auth:pairing-redeem");
      return { kind: "ready" };
    };

    await harness.runtime.enroll("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ");
    await harness.runtime.whenEventsIdle();

    expect(harness.operations.slice(-3)).toEqual([
      "auth:enroll",
      "auth:pairing-health",
      "auth:pairing-redeem",
    ]);
    expect(harness.runtime.snapshot.state).toBe("TargetSelection");
  });

  it("executes reset-enrollment through the controller", async () => {
    const harness = createHarness();
    harness.auth.initializeImplementation = async () => ({ kind: "storage-error" });
    await boot(harness);
    expect(harness.runtime.snapshot.state).toBe("StorageError");

    await harness.runtime.resetEnrollment();
    await harness.runtime.whenEventsIdle();

    expect(harness.auth.calls).toContain("auth:reset-enrollment");
    expect(harness.runtime.snapshot.state).toBe("EnrollmentRequired");
  });

  it.each([
    {
      outcome: { kind: "required" as const, reason: "credential-rejected" as const },
      expectedState: "EnrollmentRequired",
    },
    {
      outcome: { kind: "storage-error" as const },
      expectedState: "StorageError",
    },
  ])("maps a prepare-session $outcome.kind outcome", async ({ outcome, expectedState }) => {
    const harness = createHarness();
    await boot(harness);
    harness.auth.prepareSessionBoundaryImplementation = async () => outcome;
    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe(expectedState);
    expect(harness.transports).toHaveLength(0);
  });

  it("cancels a pending pre-ticket transport before later enrollment work", async () => {
    let rejectStart: ((error: Error) => void) | undefined;
    const pendingStart = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    const harness = createHarness({ startSession: () => pendingStart });
    await boot(harness);
    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    const transport = harness.transports[0];
    if (transport === undefined) throw new Error("Transport was not created");

    transport.emit({ type: "credential.rejected" });
    await harness.runtime.whenEventsIdle();
    harness.auth.enrollImplementation = () => new Promise(() => undefined);
    const enrollment = harness.runtime.enroll("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ");
    await vi.waitFor(() => expect(harness.runtime.snapshot.state).toBe("Enrolling"));

    expect(harness.runtime.snapshot.state).toBe("Enrolling");
    expect(transport.closed).toBe(true);
    expect(harness.operations.filter((operation) => operation === "close")).toHaveLength(1);
    expect(harness.operations).not.toContain("end-session");
    expect(harness.bridge.audioCalls).toHaveLength(0);

    transport.emit(readyEvent());
    rejectStart?.(new Error("stale ticket request failed"));
    await flushMicrotasks();
    expect(harness.runtime.snapshot.state).toBe("Enrolling");
    expect(harness.transports).toHaveLength(1);
    await harness.runtime.cleanup();
    await enrollment;
  });

  it("cancels a live socket and microphone before accepting no stale callbacks", async () => {
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
    expect(harness.runtime.snapshot.audioOpen).toBe(true);
    harness.bridge.audioCloseImplementation = () => pendingClose;

    const operationCount = harness.operations.length;
    transport.emit({ type: "credential.storage-error" });
    const idle = harness.runtime.whenEventsIdle();
    await flushMicrotasks();

    expect(harness.runtime.snapshot.state).toBe("StorageError");
    expect(transport.closed).toBe(true);
    expect(harness.operations.slice(operationCount)).toEqual(["close", "audio:close"]);

    resolveClose?.(true);
    await idle;
    expect(harness.runtime.snapshot.audioOpen).toBe(false);

    transport.emit({ type: "fatal" });
    harness.bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array([9]) }) });
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("StorageError");
    expect(transport.pcm).toHaveLength(0);
  });

  it("exposes only the public phone commands and a fixed redacted projection", async () => {
    const harness = createHarness();
    harness.auth.initializeImplementation = async () => ({
      kind: "required",
      reason: "missing",
    });
    const states: unknown[] = [];
    const unsubscribe = harness.runtime.subscribePhoneAuthState((state) => states.push(state));
    await boot(harness);

    let resolveEnroll: ((outcome: AuthOutcome) => void) | undefined;
    harness.auth.enrollImplementation = () => new Promise((resolve) => {
      resolveEnroll = resolve;
    });
    const canary = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
    const enrollment = harness.runtime.enroll(canary);
    await vi.waitFor(() => expect(states).toContainEqual({ status: "enrolling" }));
    resolveEnroll?.({ kind: "required", reason: "pairing-failed" });
    await enrollment;
    await harness.runtime.whenEventsIdle();

    expect(states).toEqual([
      { status: "starting" },
      { status: "checking" },
      { status: "required", reason: "missing" },
      { status: "enrolling" },
      { status: "required", reason: "pairing-failed" },
    ]);
    expect(JSON.stringify(states)).not.toContain(canary);
    expect(JSON.stringify(harness.runtime.snapshot)).not.toContain(canary);
    expect("receiveAuthEvent" in harness.runtime).toBe(false);
    unsubscribe();
  });

  it("disposes the owned controller exactly once before closing live resources", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    await harness.runtime.cleanup();
    await harness.runtime.cleanup();

    expect(harness.auth.disposeCount).toBe(1);
    expect(harness.operations.indexOf("auth:dispose")).toBeLessThan(
      harness.operations.indexOf("close"),
    );
    expect(harness.operations.indexOf("auth:dispose")).toBeLessThan(
      harness.operations.indexOf("audio:close"),
    );
  });

  it("preempts a pending controller operation and suppresses its late completion", async () => {
    const harness = createHarness();
    let resolveInitialize: ((outcome: AuthOutcome) => void) | undefined;
    harness.auth.initializeImplementation = () => new Promise((resolve) => {
      resolveInitialize = resolve;
    });
    await harness.runtime.boot();
    await vi.waitFor(() => expect(harness.auth.calls).toContain("auth:initialize"));

    await harness.runtime.cleanup();
    resolveInitialize?.({ kind: "ready" });
    await flushMicrotasks();

    expect(harness.auth.disposeCount).toBe(1);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(harness.transports).toHaveLength(0);
    expect(harness.bridge.audioCalls).toHaveLength(0);
  });

  it("surfaces a typed startup error without subscription or retry", async () => {
    const harness = createHarness();
    const phoneStates: unknown[] = [];
    harness.runtime.subscribePhoneAuthState((state) => phoneStates.push(state));
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
    expect(phoneStates).toEqual([{ status: "starting" }, { status: "error" }]);
    expect(harness.auth.disposeCount).toBe(1);
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
        relayOrigin: RELAY_ORIGIN,
        authController: harness.auth,
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
      relayOrigin: RELAY_ORIGIN,
      authController: harness.auth,
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
      relayOrigin: RELAY_ORIGIN,
      authController: rejectionHarness.auth,
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
      relayOrigin: RELAY_ORIGIN,
      authController: preemptHarness.auth,
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
    await authenticateSession(harness);

    expect(harness.transports).toHaveLength(1);
    expect(harness.transports[0]?.targetLanguage).toBe("tr");
    expect(harness.transports[0]?.options.relayOrigin).toBe(RELAY_ORIGIN);
    expect(harness.transports[0]?.options.credentialProvider).toBe(
      harness.auth.credentialProvider,
    );
    expect(harness.persisted).toEqual(["tr"]);
    expect(harness.runtime.snapshot.state).toBe("Ready");
    expect(harness.runtime.snapshot.sessionReady).toBe(false);
  });

  it("coalesces a gesture burst and skips unchanged display regions", async () => {
    const harness = createHarness();
    await boot(harness);
    const initialUpdateCount = harness.runtime.snapshot.displayUpdateCount;
    const initialTextUpdateCount = harness.bridge.textUpdates.length;

    harness.bridge.emit(listEvent(OsEventTypeList.SCROLL_BOTTOM_EVENT));
    harness.bridge.emit(listEvent(OsEventTypeList.SCROLL_TOP_EVENT));
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.target).toBe("es");
    expect(harness.runtime.snapshot.displayUpdateCount).toBe(initialUpdateCount);
    expect(harness.bridge.textUpdates).toHaveLength(initialTextUpdateCount);

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
    expect(harness.operations.slice(-3)).toEqual([
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

  it("routes an active audio queue overflow through utterance abort and keeps the session alive", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Listening");

    transport.emitError("audio", "stop");
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Ready");
    expect(harness.runtime.snapshot.sessionReady).toBe(true);
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
    expect(transport.closed).toBe(false);
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
  });

  it("lands a server-directed flow abort in Ready while keeping the session alive", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Listening");

    transport.emit({
      type: "utterance.aborted",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      category: "flow",
    });
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Ready");
    expect(harness.runtime.snapshot.sessionReady).toBe(true);
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
    expect(transport.closed).toBe(false);
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
  });

  it.each([
    { name: "authentication ticket", kind: "ticket" as const },
    { name: "protocol", kind: "protocol" as const },
  ])("keeps an unrecoverable $name transport error terminal", async ({ kind }) => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    transport.emitError(kind, "stop");
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.runtime.snapshot.sessionReady).toBe(false);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(transport.closed).toBe(true);
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

  it("disables PCM and detaches before queued loss handling starts a fresh session", async () => {
    const harness = createHarness({ recoveryTiming: fakeRecoveryTiming() });
    const firstTransport = await selectSpanishAndStart(harness);
    firstTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    vi.useFakeTimers();
    try {
      firstTransport.pushPcmImplementation = () => {
        firstTransport.emit({
          type: "transport.lost",
          sessionId: SESSION_ID,
          sessionEpoch: 1,
        });
        firstTransport.emit(readyEvent("es", RECOVERY_SESSION_ID, 2));
        expect(firstTransport.closed).toBe(true);
        expect(harness.transports).toHaveLength(1);
      };
      harness.bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array([1]) }) });
      await flushMicrotasks(20);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.runtime.snapshot.state).toBe("Ready");
      expect(harness.runtime.snapshot.lastDisplayContent.status).toBe("Reconnecting");
      expect(harness.runtime.snapshot.lastDisplayContent.source).toBe("Source: Interrupted turn cleared");
      expect(harness.runtime.snapshot.lastDisplayContent.english).toBe("English: waiting");
      expect(harness.runtime.snapshot.lastDisplayContent.suggestion).toBe("Please wait");
      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks();
      const secondTransport = harness.transports[1];
      if (secondTransport === undefined) throw new Error("Replacement transport was not created");
      expect(harness.bridge.audioCalls.filter(({ isOpen }) => isOpen)).toHaveLength(1);
      secondTransport.emit(readyEvent("es", RECOVERY_SESSION_ID, 2));
      await flushMicrotasks(20);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks(20);
      expect(harness.runtime.snapshot.sessionReady).toBe(true);
      expect(harness.bridge.audioCalls.filter(({ isOpen }) => isOpen)).toHaveLength(1);
      harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
      await flushMicrotasks(20);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks(20);
      expect(harness.bridge.audioCalls.filter(({ isOpen }) => isOpen)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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

  it("waits for microphone shutdown before scheduling fresh recovery", async () => {
    let resolveClose: ((closed: boolean) => void) | undefined;
    const pendingClose = new Promise<boolean>((resolve) => { resolveClose = resolve; });
    const harness = createHarness({ recoveryTiming: fakeRecoveryTiming() });
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseImplementation = () => pendingClose;
    vi.useFakeTimers();
    try {
      transport.emit({ type: "transport.lost", sessionId: SESSION_ID, sessionEpoch: 1 });
      await flushMicrotasks(20);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();
      expect(harness.runtime.snapshot.lastDisplayContent.status).toBe("Reconnecting");
      expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
      expect(harness.transports).toHaveLength(1);

      resolveClose?.(true);
      await flushMicrotasks(20);
      expect(harness.transports).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks(20);
      expect(harness.transports).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prepares a fresh credential grant before every recovery transport", async () => {
    const clock = manualRecoveryClock(0);
    const harness = createHarness({ recoveryTiming: clock.timing });
    const initialTransport = await selectSpanishAndStart(harness);
    initialTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    expect(harness.auth.boundaryOptions).toEqual([{ allowRotation: true }]);

    initialTransport.emit({ type: "transport.lost", sessionId: SESSION_ID, sessionEpoch: 1 });
    await harness.runtime.whenEventsIdle();
    clock.fireNext(RECOVERY_BACKOFF_BASE_MS / 2);
    await harness.runtime.whenEventsIdle();

    expect(harness.auth.boundaryOptions).toEqual([
      { allowRotation: true },
      { allowRotation: true },
    ]);
    expect(harness.transports).toHaveLength(2);
    expect(harness.transports[1]?.options.credentialProvider).toBe(
      harness.auth.credentialProvider,
    );
    expect(harness.operations.lastIndexOf("auth:prepare-session-boundary")).toBeLessThan(
      harness.operations.lastIndexOf("start-session:es"),
    );
  });

  it("keeps unavailable recovery preparation inside the bounded retry path", async () => {
    const clock = manualRecoveryClock(0);
    const harness = createHarness({ recoveryTiming: clock.timing });
    const initialTransport = await selectSpanishAndStart(harness);
    initialTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.auth.prepareSessionBoundaryImplementation = async () => ({ kind: "unavailable" });

    initialTransport.emit({ type: "transport.lost", sessionId: SESSION_ID, sessionEpoch: 1 });
    await harness.runtime.whenEventsIdle();
    clock.fireNext(RECOVERY_BACKOFF_BASE_MS / 2);
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Ready");
    expect(harness.transports).toHaveLength(1);
    expect(clock.timers.some((timer) => !timer.cancelled && timer.delayMs === 500)).toBe(true);
  });

  it.each([
    { outcome: { kind: "required" as const, reason: "missing" as const }, state: "EnrollmentRequired" },
    { outcome: { kind: "storage-error" as const }, state: "StorageError" },
  ])("maps recovery auth $outcome.kind without creating a stale transport", async ({ outcome, state }) => {
    const clock = manualRecoveryClock(0);
    const harness = createHarness({ recoveryTiming: clock.timing });
    const initialTransport = await selectSpanishAndStart(harness);
    initialTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.auth.prepareSessionBoundaryImplementation = async () => outcome;

    initialTransport.emit({ type: "transport.lost", sessionId: SESSION_ID, sessionEpoch: 1 });
    await harness.runtime.whenEventsIdle();
    clock.fireNext(RECOVERY_BACKOFF_BASE_MS / 2);
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe(state);
    expect(harness.transports).toHaveLength(1);
  });

  it("turns an audio-close failure into visible recovery Error without global cleanup", async () => {
    const harness = createHarness({ recoveryTiming: fakeRecoveryTiming() });
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseImplementation = () => Promise.resolve(false);

    transport.emit({ type: "transport.lost", sessionId: SESSION_ID, sessionEpoch: 1 });
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
    expect(harness.runtime.snapshot.hasEventSubscription).toBe(true);
    expect(harness.bridge.createCount).toBe(1);
    expect(harness.bridge.subscriptionCount).toBe(1);
    expect(harness.transports).toHaveLength(1);
    expect(harness.runtime.snapshot.lastDisplayContent.suggestion).toBe("Restart app");

    const audioCalls = harness.bridge.audioCalls.length;
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.transports).toHaveLength(1);
    expect(harness.bridge.audioCalls).toHaveLength(audioCalls);
  });

  it("uses equal-jitter backoff and stops after five consecutive attempts", async () => {
    const clock = manualRecoveryClock(0);
    const harness = createHarness({ recoveryTiming: clock.timing });
    const initialTransport = await selectSpanishAndStart(harness);
    initialTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    initialTransport.emit({ type: "transport.lost", sessionId: SESSION_ID, sessionEpoch: 1 });
    await harness.runtime.whenEventsIdle();
    expect(clock.timers.find((timer) => !timer.cancelled && !timer.fired)?.delayMs).toBe(
      RECOVERY_BACKOFF_BASE_MS / 2,
    );

    const expectedDelays = [250, 500, 1_000, 2_000, 4_000];
    for (let attempt = 0; attempt < RECOVERY_MAX_CONSECUTIVE_ATTEMPTS; attempt += 1) {
      clock.fireNext(expectedDelays[attempt]!);
      await harness.runtime.whenEventsIdle();
      const transport = harness.transports[attempt + 1];
      if (transport === undefined) throw new Error("Recovery transport was not created");
      expect(transport.calls).toContain("start-session:es");
      transport.emitError("retry");
      await harness.runtime.whenEventsIdle();

      if (attempt + 1 < RECOVERY_MAX_CONSECUTIVE_ATTEMPTS) {
        const nextTimer = clock.timers.find((timer) => !timer.cancelled && !timer.fired);
        expect(nextTimer?.delayMs).toBe(expectedDelays[attempt + 1]);
      }
    }

    expect(harness.transports).toHaveLength(RECOVERY_MAX_CONSECUTIVE_ATTEMPTS + 1);
    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
    expect(harness.bridge.subscriptionCount).toBe(1);
    expect(harness.bridge.createCount).toBe(1);
    expect(clock.timers.filter((timer) => !timer.cancelled && !timer.fired)).toHaveLength(0);
    expect(RECOVERY_BACKOFF_MAX_MS).toBeGreaterThan(expectedDelays.at(-1)!);
    expect(harness.runtime.snapshot.lastDisplayContent.suggestion).toBe("Restart app");
  });

  it("blocks a sixth recovery after five successful recoveries inside sixty seconds", async () => {
    const clock = manualRecoveryClock(0);
    const harness = createHarness({ recoveryTiming: clock.timing });
    let current = await selectSpanishAndStart(harness);
    current.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    for (let recovery = 0; recovery < 5; recovery += 1) {
      clock.now = 0;
      current.emit({
        type: "transport.lost",
        sessionId: recovery === 0 ? SESSION_ID : recoverySessionId(recovery),
        sessionEpoch: recovery + 1,
      });
      await harness.runtime.whenEventsIdle();
      clock.fireNext(RECOVERY_BACKOFF_BASE_MS / 2);
      await harness.runtime.whenEventsIdle();
      const fresh = harness.transports[recovery + 1];
      if (fresh === undefined) throw new Error("Recovery transport was not created");
      fresh.emit(readyEvent("es", recoverySessionId(recovery + 1), recovery + 2));
      await harness.runtime.whenEventsIdle();
      current = fresh;
    }

    clock.now = RECOVERY_ATTEMPT_WINDOW_MS - 1;
    current.emit({
      type: "transport.lost",
      sessionId: recoverySessionId(5),
      sessionEpoch: 6,
    });
    await harness.runtime.whenEventsIdle();

    expect(harness.transports).toHaveLength(6);
    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.runtime.snapshot.lastDisplayContent.suggestion).toBe("Restart app");
    expect(clock.timers.filter((timer) => !timer.cancelled && !timer.fired)).toHaveLength(0);
  });

  it("preserves rolling recovery attempts across successful sessions", async () => {
    const clock = manualRecoveryClock(0);
    const harness = createHarness({ recoveryTiming: clock.timing });
    let current = await selectSpanishAndStart(harness);
    current.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    const groupStarts = [
      0,
      RECOVERY_ATTEMPT_WINDOW_MS + 1_251,
      (RECOVERY_ATTEMPT_WINDOW_MS + 1_251) * 2,
    ];
    let successfulAttempts = 0;
    for (let group = 0; group < groupStarts.length; group += 1) {
      const attemptsInGroup = group < 2 ? 5 : 2;
      for (let attempt = 0; attempt < attemptsInGroup; attempt += 1) {
        clock.now = groupStarts[group]!;
        current.emit({
          type: "transport.lost",
          sessionId: successfulAttempts === 0 ? SESSION_ID : recoverySessionId(successfulAttempts),
          sessionEpoch: successfulAttempts + 1,
        });
        await harness.runtime.whenEventsIdle();
        clock.fireNext(RECOVERY_BACKOFF_BASE_MS / 2);
        await harness.runtime.whenEventsIdle();
        const fresh = harness.transports[successfulAttempts + 1];
        if (fresh === undefined) throw new Error("Recovery transport was not created");
        fresh.emit(readyEvent(
          "es",
          recoverySessionId(successfulAttempts + 1),
          successfulAttempts + 2,
        ));
        await harness.runtime.whenEventsIdle();
        current = fresh;
        successfulAttempts += 1;
      }
    }

    expect(successfulAttempts).toBe(RECOVERY_MAX_ATTEMPTS_PER_LONG_WINDOW);
    expect(clock.now - 250).toBeLessThan(RECOVERY_LONG_ATTEMPT_WINDOW_MS);
    current.emit({
      type: "transport.lost",
      sessionId: recoverySessionId(successfulAttempts),
      sessionEpoch: successfulAttempts + 1,
    });
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.transports).toHaveLength(successfulAttempts + 1);
    expect(clock.timers.filter((timer) => !timer.cancelled && !timer.fired)).toHaveLength(0);
  });

  it("treats a stop error as terminal and cancels the ready deadline", async () => {
    const clock = manualRecoveryClock(0);
    const harness = createHarness({ recoveryTiming: clock.timing });
    const initialTransport = await selectSpanishAndStart(harness);
    initialTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    initialTransport.emit({ type: "transport.lost", sessionId: SESSION_ID, sessionEpoch: 1 });
    await harness.runtime.whenEventsIdle();

    clock.fireNext(RECOVERY_BACKOFF_BASE_MS / 2);
    await harness.runtime.whenEventsIdle();
    const recoveryTransport = harness.transports[1];
    if (recoveryTransport === undefined) throw new Error("Recovery transport was not created");
    expect(clock.timers.find((timer) => !timer.cancelled && !timer.fired)?.delayMs).toBe(
      RECOVERY_READY_DEADLINE_MS,
    );
    recoveryTransport.emitError("stop");
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.runtime.snapshot.cleanupState).toBe("active");
    expect(recoveryTransport.closed).toBe(true);
    expect(harness.transports).toHaveLength(2);
    expect(clock.timers.filter((timer) => !timer.cancelled && !timer.fired)).toHaveLength(0);
    expect(harness.runtime.snapshot.lastDisplayContent.suggestion).toBe("Restart app");
  });

  it("retries when a recovery transport is lost before its queued ready is reduced", async () => {
    const clock = manualRecoveryClock(0);
    const harness = createHarness({ recoveryTiming: clock.timing });
    const initialTransport = await selectSpanishAndStart(harness);
    initialTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    initialTransport.emit({ type: "transport.lost", sessionId: SESSION_ID, sessionEpoch: 1 });
    await harness.runtime.whenEventsIdle();
    clock.fireNext(RECOVERY_BACKOFF_BASE_MS / 2);
    await harness.runtime.whenEventsIdle();

    const recoveryTransport = harness.transports[1];
    if (recoveryTransport === undefined) throw new Error("Recovery transport was not created");
    recoveryTransport.emit(readyEvent("es", RECOVERY_SESSION_ID, 2));
    recoveryTransport.emit({
      type: "transport.lost",
      sessionId: RECOVERY_SESSION_ID,
      sessionEpoch: 2,
    });
    await harness.runtime.whenEventsIdle();

    expect(recoveryTransport.closed).toBe(true);
    expect(harness.runtime.snapshot.state).toBe("Ready");
    expect(harness.runtime.snapshot.sessionReady).toBe(false);
    expect(harness.transports).toHaveLength(2);
    expect(clock.timers.find((timer) => !timer.cancelled && !timer.fired)?.delayMs).toBe(500);

    clock.fireNext(500);
    await harness.runtime.whenEventsIdle();
    const retryTransport = harness.transports[2];
    if (retryTransport === undefined) throw new Error("Retry transport was not created");
    retryTransport.emit(readyEvent("es", RECOVERY_SESSION_ID, 2));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.sessionReady).toBe(true);
  });

  it("cancels a pending backoff when cleanup begins", async () => {
    const clock = manualRecoveryClock(0);
    const harness = createHarness({ recoveryTiming: clock.timing });
    const initialTransport = await selectSpanishAndStart(harness);
    initialTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    initialTransport.emit({ type: "transport.lost", sessionId: SESSION_ID, sessionEpoch: 1 });
    await harness.runtime.whenEventsIdle();
    const backoff = clock.timers.find((timer) => !timer.cancelled && !timer.fired);
    expect(backoff?.delayMs).toBe(RECOVERY_BACKOFF_BASE_MS / 2);

    await harness.runtime.cleanup();
    expect(backoff?.cancelled).toBe(true);
    expect(harness.transports).toHaveLength(1);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it("stops audio before committing in declared reducer order", async () => {
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
    expect(harness.operations.indexOf("audio:close")).toBeLessThan(
      harness.operations.indexOf("commit"),
    );
    expect(harness.bridge.calls.indexOf("audio:close")).toBeGreaterThan(-1);
  });

  it("returns a stalled Finalizing turn to Ready without losing the session", async () => {
    const clock = manualRecoveryClock();
    const harness = createHarness({ recoveryTiming: clock.timing });
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Finalizing");

    clock.fireNext(RESULT_PIPELINE_DEADLINE_MS);
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Ready");
    expect(harness.runtime.snapshot.sessionReady).toBe(true);
    expect(transport.closed).toBe(false);
    expect(harness.runtime.snapshot.lastDisplayContent.status).toContain("utterance was aborted");
    await harness.runtime.cleanup();
  });

  it("retires a committed turn before the watchdog permits the next utterance", async () => {
    const clock = manualRecoveryClock();
    const harness = createHarness({
      idGenerator: (() => {
        const ids = [UTTERANCE_ID, NEXT_UTTERANCE_ID];
        let index = 0;
        return () => ids[index++] ?? NEXT_UTTERANCE_ID;
      })(),
      recoveryTiming: clock.timing,
      statefulTransport: true,
    });
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(transport.committed).toBe(true);

    clock.fireNext(RESULT_PIPELINE_DEADLINE_MS);
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Ready");
    expect(transport.activeUtteranceId).toBeUndefined();
    expect(transport.calls.filter((call) => call === "cancel")).toHaveLength(1);

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(transport.startUtteranceRejected).toBe(false);
    expect(transport.activeUtteranceId).toBe(NEXT_UTTERANCE_ID);
    expect(harness.runtime.snapshot.state).toBe("Listening");
    await harness.runtime.cleanup();
  });

  it("returns a stalled Translating turn to Ready without losing the session", async () => {
    const clock = manualRecoveryClock();
    const harness = createHarness({ recoveryTiming: clock.timing });
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    transport.emit(utteranceEvent());
    transport.emit(languageDecision());
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Translating");

    clock.fireNext(RESULT_PIPELINE_DEADLINE_MS);
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Ready");
    expect(harness.runtime.snapshot.sessionReady).toBe(true);
    expect(transport.closed).toBe(false);
    await harness.runtime.cleanup();
  });

  it("re-arms the watchdog for legitimate pipeline progress and clears it at Results", async () => {
    const clock = manualRecoveryClock();
    const harness = createHarness({ recoveryTiming: clock.timing });
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    const finalizingTimer = clock.timers.find((timer) =>
      !timer.cancelled && !timer.fired && timer.delayMs === RESULT_PIPELINE_DEADLINE_MS);
    expect(finalizingTimer).toBeDefined();

    transport.emit(utteranceEvent("transcript.partial", "hola parcial"));
    await harness.runtime.whenEventsIdle();
    expect(finalizingTimer?.cancelled).toBe(true);
    expect(harness.runtime.snapshot.state).toBe("Finalizing");

    const partialTimer = clock.timers.find((timer) =>
      !timer.cancelled && !timer.fired && timer.delayMs === RESULT_PIPELINE_DEADLINE_MS);
    expect(partialTimer).toBeDefined();
    transport.emit(utteranceEvent());
    transport.emit(languageDecision());
    await harness.runtime.whenEventsIdle();
    expect(partialTimer?.cancelled).toBe(true);
    expect(harness.runtime.snapshot.state).toBe("Translating");

    const translatingTimer = clock.timers.find((timer) =>
      !timer.cancelled && !timer.fired && timer.delayMs === RESULT_PIPELINE_DEADLINE_MS);
    expect(translatingTimer).toBeDefined();
    transport.emit(translationReady());
    await harness.runtime.whenEventsIdle();
    expect(translatingTimer?.cancelled).toBe(true);
    expect(harness.runtime.snapshot.state).toBe("Translating");

    const translatedTimer = clock.timers.find((timer) =>
      !timer.cancelled && !timer.fired && timer.delayMs === RESULT_PIPELINE_DEADLINE_MS);
    expect(translatedTimer).toBeDefined();
    transport.emit(suggestionsReady());
    await harness.runtime.whenEventsIdle();
    expect(translatedTimer?.cancelled).toBe(true);
    expect(harness.runtime.snapshot.state).toBe("Results");
    expect(clock.timers.filter((timer) => !timer.cancelled && !timer.fired)).toHaveLength(0);
    await harness.runtime.cleanup();
  });

  it("cancels the result-pipeline watchdog during shutdown", async () => {
    const clock = manualRecoveryClock();
    const harness = createHarness({ recoveryTiming: clock.timing });
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    expect(harness.runtime.snapshot.state).toBe("Finalizing");
    const watchdog = clock.timers.find((timer) =>
      !timer.cancelled && !timer.fired && timer.delayMs === RESULT_PIPELINE_DEADLINE_MS);
    expect(watchdog).toBeDefined();

    await harness.runtime.cleanup();
    expect(watchdog?.cancelled).toBe(true);
    expect(clock.timers.filter((timer) => !timer.cancelled && !timer.fired)).toHaveLength(0);
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
  });

  it("waits for microphone shutdown before committing", async () => {
    let resolveClose: ((closed: boolean) => void) | undefined;
    const pendingClose = new Promise<boolean>((resolve) => {
      resolveClose = resolve;
    });
    const clock = manualRecoveryClock();
    const harness = createHarness({ recoveryTiming: clock.timing });
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    harness.bridge.audioCloseImplementation = () => pendingClose;

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    for (let attempt = 0; attempt < 20 && harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen).length < 1; attempt += 1) {
      await Promise.resolve();
    }
    const idle = harness.runtime.whenEventsIdle();
    let settled = false;
    void idle.then(() => { settled = true; }, () => { settled = true; });
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
    expect(harness.operations.filter((operation) => operation === "commit")).toHaveLength(0);
    expect(clock.timers.filter((timer) =>
      !timer.cancelled && !timer.fired && timer.delayMs === RESULT_PIPELINE_DEADLINE_MS,
    )).toHaveLength(0);

    resolveClose?.(true);
    await idle;
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
    expect(harness.runtime.snapshot.audioOpen).toBe(false);
    expect(harness.operations.filter((operation) => operation === "commit")).toHaveLength(1);
    expect(clock.timers.filter((timer) =>
      !timer.cancelled && !timer.fired && timer.delayMs === RESULT_PIPELINE_DEADLINE_MS,
    )).toHaveLength(1);
    expect(transport.closed).toBe(false);
    await harness.runtime.cleanup();
  });

  it("closes a late microphone-open success after transport loss and never enables PCM", async () => {
    let resolveOpen: ((opened: boolean) => void) | undefined;
    const pendingOpen = new Promise<boolean>((resolve) => { resolveOpen = resolve; });
    const harness = createHarness({ recoveryTiming: fakeRecoveryTiming() });
    const firstTransport = await selectSpanishAndStart(harness);
    firstTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    vi.useFakeTimers();
    try {
      harness.bridge.audioOpenImplementation = () => pendingOpen;
      harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
      await flushMicrotasks(8);
      expect(harness.bridge.audioCalls.at(-1)?.isOpen).toBe(true);

      firstTransport.emit({ type: "transport.lost", sessionId: SESSION_ID, sessionEpoch: 1 });
      await flushMicrotasks(20);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks(12);
      expect(firstTransport.closed).toBe(true);
      expect(harness.transports).toHaveLength(1);
      resolveOpen?.(true);
      await flushMicrotasks(20);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks(12);
      expect(harness.runtime.snapshot.lastDisplayContent.status).toBe("Reconnecting");
      expect(harness.runtime.snapshot.audioOpen).toBe(false);
      expect(harness.bridge.audioCalls.filter(({ isOpen }) => !isOpen)).toHaveLength(1);
      expect(harness.transports).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks(20);
      expect(harness.transports).toHaveLength(2);
      expect(harness.bridge.audioCalls.filter(({ isOpen }) => isOpen)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
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

  it("fails and requests cleanup when retiring the current transport cannot close it", async () => {
    const harness = createHarness({ recoveryTiming: fakeRecoveryTiming() });
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    let closeAttempts = 0;
    transport.closeImplementation = () => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error("retire close failed");
    };

    transport.emit({ type: "transport.lost", sessionId: SESSION_ID, sessionEpoch: 1 });
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.runtime.snapshot.cleanupState).toBe("cleaned");
    expect(closeAttempts).toBe(2);
    expect(transport.closed).toBe(true);
    expect(harness.bridge.unsubscribeCount).toBe(1);
    expect(harness.operations).not.toContain("end-session");
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

  it("drops stale callbacks from a dead transport and accepts only the current ready", async () => {
    const harness = createHarness({ recoveryTiming: fakeRecoveryTiming() });
    const firstTransport = await selectSpanishAndStart(harness);
    firstTransport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    vi.useFakeTimers();
    try {
      firstTransport.emit({ type: "transport.lost", sessionId: SESSION_ID, sessionEpoch: 1 });
      await flushMicrotasks(20);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks(20);
      firstTransport.emit(readyEvent("es", RECOVERY_SESSION_ID, 2));
      await flushMicrotasks(20);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks(20);
      expect(harness.runtime.snapshot.sessionReady).toBe(false);

      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks(20);
      const secondTransport = harness.transports[1];
      expect(secondTransport).toBeDefined();
      secondTransport?.emit(readyEvent("es", RECOVERY_SESSION_ID, 2));
      await flushMicrotasks(20);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks(20);
      expect(harness.runtime.snapshot.sessionReady).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let target persistence block session start", async () => {
    const pendingPersistence = new Promise<void>(() => undefined);
    const harness = createHarness({ persistTarget: () => pendingPersistence });
    await boot(harness);

    harness.bridge.emit(textEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();
    await authenticateSession(harness);
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
    await authenticateSession(harness);
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
    await authenticateSession(harness);
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
    await harness.runtime.whenEventsIdle();
    await authenticateSession(harness);
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

  it("projects full relay contract events through the state machine", async () => {
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

  it("projects the contract utterance-aborted event and stops its microphone", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    transport.emit({
      type: "utterance.aborted",
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      utteranceId: UTTERANCE_ID,
      category: "cancellation",
    });
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Ready");
    expect(harness.runtime.snapshot.audioOpen).toBe(false);
    expect(harness.operations.at(-1)).toBe("audio:close");
  });

  it("starts a fresh next turn directly from Results without recreating the session", async () => {
    const harness = createHarness({ utteranceIds: [UTTERANCE_ID, NEXT_UTTERANCE_ID] });
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(systemEvent(
      OsEventTypeList.CLICK_EVENT,
      EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
    ));
    await harness.runtime.whenEventsIdle();
    harness.bridge.emit(systemEvent(
      OsEventTypeList.CLICK_EVENT,
      EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
    ));
    await harness.runtime.whenEventsIdle();
    transport.emit(utteranceEvent());
    transport.emit(languageDecision());
    transport.emit(translationReady());
    transport.emit(suggestionsReady());
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Results");
    const resultDisplay = harness.runtime.snapshot.lastDisplayContent;
    const operationCount = harness.operations.length;
    const sessionStartCount = harness.operations.filter((operation) =>
      operation.startsWith("start-session:")).length;
    expect(resultDisplay.suggestion).toContain("hello → hola");

    harness.bridge.emit(systemEvent(
      OsEventTypeList.CLICK_EVENT,
      EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
    ));
    await harness.runtime.whenEventsIdle();

    expect(harness.runtime.snapshot.state).toBe("Listening");
    expect(harness.runtime.snapshot.audioOpen).toBe(true);
    expect(harness.transports).toHaveLength(1);
    expect(harness.operations.filter((operation) => operation.startsWith("start-session:"))).toHaveLength(
      sessionStartCount,
    );
    expect(harness.operations.slice(operationCount)).toEqual([
      `start-utterance:${NEXT_UTTERANCE_ID}`,
      "audio:open",
    ]);
    expect(harness.runtime.snapshot.lastDisplayContent).not.toEqual(resultDisplay);
    expect(JSON.stringify(harness.runtime.snapshot.lastDisplayContent)).not.toContain("hello → hola");
  });

  it("fails from Results when next-turn secure randomness fails without starting audio or utterance", async () => {
    let generationCount = 0;
    const harness = createHarness({
      idGenerator: () => {
        generationCount += 1;
        if (generationCount === 1) return UTTERANCE_ID;
        throw new Error("secure randomness unavailable");
      },
    });
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

    expect(harness.runtime.snapshot.state).toBe("Results");
    const operationCount = harness.operations.length;
    const audioOpenCount = harness.bridge.audioCalls.filter(({ isOpen }) => isOpen).length;
    const utteranceStarts = harness.operations.filter((operation) =>
      operation.startsWith("start-utterance:")).length;

    harness.bridge.emit(systemEvent(OsEventTypeList.CLICK_EVENT));
    await harness.runtime.whenEventsIdle();

    expect(generationCount).toBe(2);
    expect(harness.runtime.snapshot.state).toBe("Error");
    expect(harness.operations.slice(operationCount).filter((operation) =>
      operation === "audio:open" || operation.startsWith("start-utterance:"))).toEqual([]);
    expect(harness.bridge.audioCalls.filter(({ isOpen }) => isOpen)).toHaveLength(audioOpenCount);
    expect(harness.operations.filter((operation) => operation.startsWith("start-utterance:"))).toHaveLength(
      utteranceStarts,
    );
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
  it("treats an undefined event type as press", async () => {
    const harness = createHarness();
    const transport = await selectSpanishAndStart(harness);
    transport.emit(readyEvent());
    await harness.runtime.whenEventsIdle();

    harness.bridge.emit(textEvent());
    await harness.runtime.whenEventsIdle();

    expect(harness.transports).toHaveLength(1);
    expect(harness.runtime.snapshot.state).toBe("Listening");
    expect(harness.runtime.snapshot.audioOpen).toBe(true);
    expect(harness.operations).toContain(`start-utterance:${UTTERANCE_ID}`);

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
