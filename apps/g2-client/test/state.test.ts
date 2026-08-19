import { describe, expect, it } from "vitest";

import {
  MAX_TRANSCRIPT_LENGTH,
  MAX_TRANSCRIPT_SEGMENTS,
  MAX_UINT32,
  createInitialState,
  reduceClientState,
  type ActiveTurnClientState,
  type ClientEvent,
  type ClientState,
  type LanguageDecisionValue,
} from "../src/state/index.js";

const SESSION = Object.freeze({
  sessionId: "11111111-1111-4111-8111-111111111111",
  sessionEpoch: 1,
});
const SESSION_ID_WRONG_VERSION = "11111111-1111-5111-8111-111111111111";
const SESSION_ID_WRONG_VARIANT = "11111111-1111-4111-7111-111111111111";
const OTHER_SESSION = Object.freeze({
  sessionId: "33333333-3333-4333-8333-333333333333",
  sessionEpoch: 1,
});
const UTTERANCE_ID = "22222222-2222-4222-8222-222222222222";
const UTTERANCE_ID_WRONG_VERSION = "22222222-2222-5222-8222-222222222222";
const UTTERANCE_ID_WRONG_VARIANT = "22222222-2222-4222-7222-222222222222";
const OTHER_UTTERANCE_ID = "44444444-4444-4444-8444-444444444444";
const NEXT_UTTERANCE_ID = "55555555-5555-4555-8555-555555555555";
const SEGMENT_ID = "segment-1";
const FIRST_AUTH_ATTEMPT = 1;

const sessionReady = (targetLanguage: "es" | "tr"): ClientEvent => ({
  type: "session.ready",
  ...SESSION,
  targetLanguage,
  result: "new",
});

const reduce = (state: ClientState, event: ClientEvent): ClientState =>
  reduceClientState(state, event).state;

const asClientEvent = (event: unknown): ClientEvent => event as ClientEvent;

const highlightedTarget = (state: ClientState): "es" | "tr" => {
  if (state.state !== "Starting" && state.state !== "EnrollmentChecking" &&
    state.state !== "EnrollmentRequired" && state.state !== "Enrolling" &&
    state.state !== "StorageError" && state.state !== "TargetSelection") {
    throw new Error(`Expected a selection state, received ${state.state}`);
  }
  return state.highlightedTarget;
};

const toTargetSelection = (targetLanguage: "es" | "tr" = "es"): ClientState => {
  let state = createInitialState(targetLanguage);
  state = reduce(state, { type: "startup.ready" });
  return reduce(state, { type: "enrollment.ready" });
};

const toAuthenticationPending = (targetLanguage: "es" | "tr" = "es"): ClientState =>
  reduce(toTargetSelection(targetLanguage), { type: "press" });

const toInitialPending = (targetLanguage: "es" | "tr" = "es"): ClientState =>
  reduce(toAuthenticationPending(targetLanguage), {
    type: "session.authenticated",
    authAttempt: FIRST_AUTH_ATTEMPT,
  });

const toSessionReady = (targetLanguage: "es" | "tr" = "es"): ClientState => {
  const state = toInitialPending(targetLanguage);
  return reduce(state, sessionReady(targetLanguage));
};

const toListening = (targetLanguage: "es" | "tr" = "es"): ClientState =>
  reduce(toSessionReady(targetLanguage), { type: "press", utteranceId: UTTERANCE_ID });

const toFinalizing = (targetLanguage: "es" | "tr" = "es"): ClientState => {
  let state = toListening(targetLanguage);
  state = reduce(state, {
    type: "transcript.partial",
    ...SESSION,
    utteranceId: UTTERANCE_ID,
    segmentId: SEGMENT_ID,
    revision: 1,
    text: "hola",
  });
  state = reduce(state, { type: "press" });
  return reduce(state, {
    type: "transcript.final",
    ...SESSION,
    utteranceId: UTTERANCE_ID,
    segmentId: SEGMENT_ID,
    revision: 2,
    text: "hola mundo",
  });
};

const toResults = (targetLanguage: "es" | "tr" = "es"): ClientState => {
  const finalizing = toFinalizing(targetLanguage);
  const translating = reduce(finalizing, languageDecision("target", targetLanguage));
  const translated = reduce(translating, targetTranslation());
  return reduce(translated, suggestionsReady());
};

const languageDecision = (
  decision: LanguageDecisionValue,
  targetLanguage: "es" | "tr" = "es",
  revision = 2,
): ClientEvent => ({
  type: "language.decision",
  ...SESSION,
  utteranceId: UTTERANCE_ID,
  segmentId: SEGMENT_ID,
  revision,
  decision,
  selectedTargetLanguage: targetLanguage,
});

const targetTranslation = (acceptedFinalRevision = 2): ClientEvent => ({
  type: "translation.ready",
  ...SESSION,
  utteranceId: UTTERANCE_ID,
  segmentId: SEGMENT_ID,
  acceptedFinalRevision,
  englishTranslation: "hello world",
});

const targetSuggestions = [
  { englishText: "Hello", selectedTargetText: "Hola" },
  { englishText: "Good morning", selectedTargetText: "Buenos días" },
  { englishText: "See you", selectedTargetText: "Hasta luego" },
];

const suggestionsReady = (overrides: Record<string, unknown> = {}): ClientEvent =>
  asClientEvent({
    type: "suggestions.ready",
    ...SESSION,
    utteranceId: UTTERANCE_ID,
    segmentId: SEGMENT_ID,
    acceptedFinalRevision: 2,
    suggestions: targetSuggestions,
    ...overrides,
  });

const transportLost = (overrides: Record<string, unknown> = {}): ClientEvent =>
  asClientEvent({
    type: "transport.lost",
    ...SESSION,
    ...overrides,
  });

describe("G2 client interaction state", () => {
  it("uses registry order, treats restored targets as highlights, and freezes output", () => {
    const defaultState = createInitialState();
    const restoredState = createInitialState("tr");
    const invalidRestoredState = createInitialState("fr");

    expect(defaultState.state).toBe("Starting");
    expect(defaultState.type).toBe("Starting");
    expect(Object.prototype.propertyIsEnumerable.call(defaultState, "type")).toBe(true);
    expect(highlightedTarget(defaultState)).toBe("es");
    expect(highlightedTarget(restoredState)).toBe("tr");
    expect(highlightedTarget(invalidRestoredState)).toBe("es");
    expect(Object.isFrozen(defaultState)).toBe(true);

    const checking = reduceClientState(defaultState, { type: "startup.ready" });
    expect(checking.state.state).toBe("EnrollmentChecking");
    expect(checking.state.type).toBe("EnrollmentChecking");
    expect(checking.effects).toEqual([{ type: "check-enrollment" }]);
    if (checking.state.state !== "EnrollmentChecking") return;
    expect(checking.state.phase).toBe("checking");

    const selected = reduceClientState(checking.state, { type: "enrollment.ready" });
    expect(selected.state.state).toBe("TargetSelection");
    expect(highlightedTarget(selected.state)).toBe("es");
    expect(Object.isFrozen(selected.state)).toBe(true);
    expect(Object.isFrozen(selected.effects)).toBe(true);

    const next = reduceClientState(selected.state, { type: "swipe.next" });
    expect(highlightedTarget(next.state)).toBe("tr");
    expect(highlightedTarget(reduceClientState(next.state, { type: "swipe.next" }).state)).toBe("es");
    expect(highlightedTarget(reduceClientState(next.state, { type: "swipe.previous" }).state)).toBe("es");
  });

  it("does not start a session or microphone before explicit confirmation and session.ready", () => {
    const initial = createInitialState("tr");
    expect(reduceClientState(initial, { type: "press" }).effects).toHaveLength(0);

    const checking = reduceClientState(initial, { type: "startup.ready" });
    expect(checking.state.state).toBe("EnrollmentChecking");
    expect(checking.effects).toEqual([{ type: "check-enrollment" }]);
    const selection = reduce(checking.state, { type: "enrollment.ready" });
    const confirmed = reduceClientState(selection, { type: "press" });
    expect(confirmed.state.state).toBe("Ready");
    if (confirmed.state.state !== "Ready") return;
    expect(confirmed.state.sessionReady).toBe(false);
    expect(confirmed.state.pending).toBe("authentication");
    if (confirmed.state.pending !== "authentication") return;
    expect(confirmed.state.authAttempt).toBe(FIRST_AUTH_ATTEMPT);
    expect(confirmed.effects.map((effect) => effect.type)).toEqual([
      "persist-target",
      "prepare-session-auth",
    ]);
    expect(confirmed.effects).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "start-session" }),
    ]));
    expect(confirmed.effects).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "start-audio" }),
    ]));

    const authenticated = reduceClientState(confirmed.state, {
      type: "session.authenticated",
      authAttempt: FIRST_AUTH_ATTEMPT,
    });
    expect(authenticated.state.state).toBe("Ready");
    if (authenticated.state.state !== "Ready") return;
    expect(authenticated.state.pending).toBe("initial");
    expect(authenticated.effects).toEqual([{ type: "start-session", targetLanguage: "tr" }]);

    expect(reduceClientState(authenticated.state, { type: "press" }).effects).toHaveLength(0);
    const ready = reduceClientState(authenticated.state, sessionReady("tr"));
    expect(ready.state.state).toBe("Ready");
    if (ready.state.state !== "Ready") return;
    expect(ready.state.sessionReady).toBe(true);
    if (!ready.state.sessionReady) return;
    expect(ready.state.pending).toBe(false);
    expect(ready.effects).toHaveLength(0);
  });

  it("runs the redacted enrollment transition table for every reason and recovery action", () => {
    const initial = createInitialState("tr");
    const checking = reduceClientState(initial, { type: "startup.ready" });
    expect(checking.state).toMatchObject({
      state: "EnrollmentChecking",
      type: "EnrollmentChecking",
      highlightedTarget: "tr",
      authAttempt: 0,
      phase: "checking",
    });
    expect(checking.effects).toEqual([{ type: "check-enrollment" }]);

    const reasons = [
      "missing",
      "absolute-expired",
      "credential-rejected",
      "pairing-failed",
      "pairing-uncertain",
      "revoked",
      "revocation-unconfirmed",
    ] as const;
    for (const reason of reasons) {
      const required = reduceClientState(checking.state, {
        type: "enrollment.required",
        reason,
      });
      expect(required.state).toMatchObject({
        state: "EnrollmentRequired",
        type: "EnrollmentRequired",
        highlightedTarget: "tr",
        authAttempt: 0,
        reason,
      });
      expect(required.effects).toHaveLength(0);
      expect(Object.keys(required.state).sort()).toEqual([
        "authAttempt",
        "highlightedTarget",
        "reason",
        "state",
        "type",
      ]);

      const enrolling = reduceClientState(required.state, { type: "enrollment.started" });
      expect(enrolling.state).toEqual({
        state: "Enrolling",
        type: "Enrolling",
        highlightedTarget: "tr",
        authAttempt: 0,
      });
      expect(enrolling.effects).toHaveLength(0);

      const ready = reduceClientState(enrolling.state, { type: "enrollment.ready" });
      expect(ready.state).toEqual({
        state: "TargetSelection",
        type: "TargetSelection",
        highlightedTarget: "tr",
        authAttempt: 0,
      });
      expect(ready.effects).toHaveLength(0);

      for (const pairingReason of ["pairing-failed", "pairing-uncertain"] as const) {
        const failed = reduceClientState(enrolling.state, {
          type: "enrollment.failed",
          reason: pairingReason,
        });
        expect(failed.state).toEqual({
          state: "EnrollmentRequired",
          type: "EnrollmentRequired",
          highlightedTarget: "tr",
          authAttempt: 0,
          reason: pairingReason,
        });
        expect(failed.effects).toHaveLength(0);
      }
    }

    for (const source of [
      checking.state,
      reduceClientState(checking.state, {
        type: "enrollment.required",
        reason: "missing",
      }).state,
      reduceClientState(
        reduceClientState(checking.state, {
          type: "enrollment.required",
          reason: "missing",
        }).state,
        { type: "enrollment.started" },
      ).state,
    ]) {
      const failed = reduceClientState(source, { type: "enrollment.storage-error" });
      expect(failed.state).toEqual({
        state: "StorageError",
        type: "StorageError",
        highlightedTarget: "tr",
        authAttempt: 0,
      });
      expect(failed.effects).toHaveLength(0);
      const retried = reduceClientState(failed.state, { type: "enrollment.retry" });
      expect(retried.state).toEqual({
        state: "EnrollmentChecking",
        type: "EnrollmentChecking",
        highlightedTarget: "tr",
        authAttempt: 0,
        phase: "checking",
      });
      expect(retried.effects).toEqual([{ type: "check-enrollment" }]);
      const reset = reduceClientState(failed.state, { type: "enrollment.reset" });
      expect(reset.state).toEqual(retried.state);
      expect(reset.effects).toEqual([{ type: "reset-enrollment" }]);
    }

    const malformed = reduceClientState(checking.state, asClientEvent({
      type: "enrollment.required",
      reason: "unknown",
      credential: "CREDENTIAL-CANARY",
    }));
    expect(malformed.state).toEqual(checking.state);
    expect(malformed.effects).toHaveLength(0);
    expect(JSON.stringify(malformed)).not.toContain("CREDENTIAL-CANARY");
  });

  it("keeps enrollment and storage states target-only and ignores gestures", () => {
    const checking = reduceClientState(
      createInitialState("es"),
      { type: "startup.ready" },
    ).state;
    const required = reduceClientState(checking, {
      type: "enrollment.required",
      reason: "missing",
    }).state;
    const enrolling = reduceClientState(required, { type: "enrollment.started" }).state;
    const storageError = reduceClientState(enrolling, { type: "enrollment.storage-error" }).state;
    const states = [checking, required, enrolling, storageError];

    for (const state of states) {
      expect(Object.keys(state).every((key) => [
        "state",
        "type",
        "highlightedTarget",
        "authAttempt",
        "phase",
        "reason",
      ].includes(key))).toBe(true);
      expect(Object.isFrozen(state)).toBe(true);
      for (const event of [
        { type: "press" },
        { type: "swipe.next" },
        { type: "swipe.previous" },
      ] as const) {
        const unchanged = reduceClientState(state, event);
        expect(unchanged.state).toEqual(state);
        expect(unchanged.effects).toHaveLength(0);
      }
    }
  });

  it("requires authentication before starting a session and supports a redacted retry", () => {
    const selection = toTargetSelection("es");
    const authPending = reduceClientState(selection, { type: "press" });
    expect(authPending.state).toEqual({
      state: "Ready",
      type: "Ready",
      targetLanguage: "es",
      sessionReady: false,
      pending: "authentication",
      authAttempt: FIRST_AUTH_ATTEMPT,
      turn: 0,
    });
    expect(authPending.effects).toEqual([
      { type: "persist-target", targetLanguage: "es" },
      {
        type: "prepare-session-auth",
        targetLanguage: "es",
        authAttempt: FIRST_AUTH_ATTEMPT,
      },
    ]);

    const bypass = reduceClientState(authPending.state, sessionReady("es"));
    expect(bypass.state).toEqual(authPending.state);
    expect(bypass.effects).toHaveLength(0);

    const duplicatePress = reduceClientState(authPending.state, { type: "press" });
    expect(duplicatePress.state).toEqual(authPending.state);
    expect(duplicatePress.effects).toHaveLength(0);

    for (const staleEvent of [
      { type: "session.authenticated", authAttempt: 2 },
      { type: "session.auth-required", authAttempt: 2, reason: "absolute-expired" },
      { type: "session.auth-storage-error", authAttempt: 2 },
      { type: "session.auth-unavailable", authAttempt: 2 },
    ] as const) {
      const stale = reduceClientState(authPending.state, staleEvent);
      expect(stale.state).toEqual(authPending.state);
      expect(stale.effects).toHaveLength(0);
    }

    for (const malformedEvent of [
      { type: "session.authenticated", authAttempt: FIRST_AUTH_ATTEMPT, extra: true },
      { type: "session.auth-required", authAttempt: FIRST_AUTH_ATTEMPT },
      { type: "session.auth-storage-error", authAttempt: 0 },
      { type: "session.authenticated", authAttempt: MAX_UINT32 + 1 },
      { type: "session.auth-unavailable" },
    ]) {
      const malformed = reduceClientState(authPending.state, asClientEvent(malformedEvent));
      expect(malformed.state).toEqual(authPending.state);
      expect(malformed.effects).toHaveLength(0);
    }

    const authenticated = reduceClientState(authPending.state, {
      type: "session.authenticated",
      authAttempt: FIRST_AUTH_ATTEMPT,
    });
    expect(authenticated.state).toMatchObject({
      state: "Ready",
      type: "Ready",
      targetLanguage: "es",
      sessionReady: false,
      pending: "initial",
      authAttempt: FIRST_AUTH_ATTEMPT,
      turn: 0,
    });
    expect(authenticated.effects).toEqual([{ type: "start-session", targetLanguage: "es" }]);

    const required = reduceClientState(authPending.state, {
      type: "session.auth-required",
      authAttempt: FIRST_AUTH_ATTEMPT,
      reason: "absolute-expired",
    });
    expect(required.state).toEqual({
      state: "EnrollmentRequired",
      type: "EnrollmentRequired",
      highlightedTarget: "es",
      authAttempt: FIRST_AUTH_ATTEMPT,
      reason: "absolute-expired",
    });
    expect(required.effects).toEqual([{ type: "cancel-session-boundary" }]);

    const storageError = reduceClientState(authPending.state, {
      type: "session.auth-storage-error",
      authAttempt: FIRST_AUTH_ATTEMPT,
    });
    expect(storageError.state).toEqual({
      state: "StorageError",
      type: "StorageError",
      highlightedTarget: "es",
      authAttempt: FIRST_AUTH_ATTEMPT,
    });
    expect(storageError.effects).toEqual([{ type: "cancel-session-boundary" }]);

    const unavailable = reduceClientState(authPending.state, {
      type: "session.auth-unavailable",
      authAttempt: FIRST_AUTH_ATTEMPT,
    });
    expect(unavailable.state.state).toBe("Ready");
    if (unavailable.state.state !== "Ready") return;
    expect(unavailable.state.pending).toBe("authentication");
    if (unavailable.state.pending !== "authentication") return;
    expect(unavailable.state.authAttempt).toBe(FIRST_AUTH_ATTEMPT);
    expect(unavailable.state.message).toBe("Session authentication unavailable; press to retry.");
    expect(JSON.stringify(unavailable.state)).not.toContain("CREDENTIAL-CANARY");
    expect(unavailable.effects).toHaveLength(0);

    const lateCompletion = reduceClientState(unavailable.state, {
      type: "session.authenticated",
      authAttempt: FIRST_AUTH_ATTEMPT,
    });
    expect(lateCompletion.state).toEqual(unavailable.state);
    expect(lateCompletion.effects).toHaveLength(0);

    const retry = reduceClientState(unavailable.state, { type: "press" });
    expect(retry.state).toEqual({
      state: "Ready",
      type: "Ready",
      targetLanguage: "es",
      sessionReady: false,
      pending: "authentication",
      authAttempt: 2,
      turn: 0,
    });
    expect(retry.effects).toEqual([{
      type: "prepare-session-auth",
      targetLanguage: "es",
      authAttempt: 2,
    }]);

    const staleRetryCompletion = reduceClientState(retry.state, {
      type: "session.authenticated",
      authAttempt: FIRST_AUTH_ATTEMPT,
    });
    expect(staleRetryCompletion.state).toEqual(retry.state);
    expect(staleRetryCompletion.effects).toHaveLength(0);

    const retryAuthenticated = reduceClientState(retry.state, {
      type: "session.authenticated",
      authAttempt: 2,
    });
    expect(retryAuthenticated.state).toMatchObject({ pending: "initial" });
    expect(retryAuthenticated.effects).toEqual([{ type: "start-session", targetLanguage: "es" }]);

    const exhausted = {
      ...unavailable.state,
      authAttempt: MAX_UINT32,
    } as ClientState;
    const exhaustedRetry = reduceClientState(exhausted, { type: "press" });
    expect(exhaustedRetry.state).toEqual(exhausted);
    expect(exhaustedRetry.effects).toHaveLength(0);

    const exhaustedSelection = {
      ...selection,
      authAttempt: MAX_UINT32,
    } as ClientState;
    const exhaustedStart = reduceClientState(exhaustedSelection, { type: "press" });
    expect(exhaustedStart.state).toEqual(exhaustedSelection);
    expect(exhaustedStart.effects).toHaveLength(0);
  });

  it("routes credential rejection and storage failures through exact authenticated cleanup", () => {
    const authPending = toAuthenticationPending();
    const pendingRejected = reduceClientState(authPending, { type: "credential.rejected" });
    expect(pendingRejected.state).toEqual({
      state: "EnrollmentRequired",
      type: "EnrollmentRequired",
      highlightedTarget: "es",
      authAttempt: FIRST_AUTH_ATTEMPT,
      reason: "credential-rejected",
    });
    expect(pendingRejected.effects).toEqual([{ type: "cancel-session-boundary" }]);

    const pendingStorage = reduceClientState(authPending, { type: "credential.storage-error" });
    expect(pendingStorage.state).toEqual({
      state: "StorageError",
      type: "StorageError",
      highlightedTarget: "es",
      authAttempt: FIRST_AUTH_ATTEMPT,
    });
    expect(pendingStorage.effects).toEqual([{ type: "cancel-session-boundary" }]);

    const authenticatedStates = [
      toInitialPending(),
      toSessionReady(),
      toListening(),
      toFinalizing(),
      reduce(toFinalizing(), languageDecision("target")),
      toResults(),
    ];
    for (const state of authenticatedStates) {
      const expectedCleanup = state.state === "Listening"
        ? ["cancel-session-boundary", "stop-audio", "end-session"]
        : state.state === "Ready" && state.pending === "initial"
          ? ["cancel-session-boundary"]
          : ["cancel-session-boundary", "end-session"];
      const rejected = reduceClientState(state, { type: "credential.rejected" });
      expect(rejected.state).toEqual({
        state: "EnrollmentRequired",
        type: "EnrollmentRequired",
        highlightedTarget: "es",
        authAttempt: FIRST_AUTH_ATTEMPT,
        reason: "credential-rejected",
      });
      expect(rejected.effects.map((effect) => effect.type)).toEqual(expectedCleanup);

      const stored = reduceClientState(state, { type: "credential.storage-error" });
      expect(stored.state).toEqual({
        state: "StorageError",
        type: "StorageError",
        highlightedTarget: "es",
        authAttempt: FIRST_AUTH_ATTEMPT,
      });
      expect(stored.effects.map((effect) => effect.type)).toEqual(expectedCleanup);
    }

    const enrollment = reduceClientState(
      reduceClientState(
        reduceClientState(createInitialState(), { type: "startup.ready" }).state,
        { type: "enrollment.required", reason: "missing" },
      ).state,
      { type: "credential.rejected" },
    );
    expect(enrollment.state.state).toBe("EnrollmentRequired");
    if (enrollment.state.state === "EnrollmentRequired") {
      expect(enrollment.state.reason).toBe("missing");
    }
    expect(enrollment.effects).toHaveLength(0);
  });

  it("never reuses an authentication generation after revocation and re-enrollment", () => {
    const first = reduceClientState(toTargetSelection(), { type: "press" });
    expect(first.state).toMatchObject({
      state: "Ready",
      pending: "authentication",
      authAttempt: FIRST_AUTH_ATTEMPT,
    });

    const revoking = reduceClientState(first.state, { type: "revocation.started" });
    expect(revoking.effects[0]).toEqual({ type: "cancel-session-boundary" });
    expect(revoking.state).toEqual({
      state: "EnrollmentChecking",
      type: "EnrollmentChecking",
      highlightedTarget: "es",
      authAttempt: FIRST_AUTH_ATTEMPT,
      phase: "revoking",
    });

    const required = reduce(revoking.state, {
      type: "revocation.completed",
      reason: "revoked",
    });
    const enrolling = reduce(required, { type: "enrollment.started" });
    const reselection = reduce(enrolling, { type: "enrollment.ready" });
    expect(reselection).toEqual({
      state: "TargetSelection",
      type: "TargetSelection",
      highlightedTarget: "es",
      authAttempt: FIRST_AUTH_ATTEMPT,
    });

    const second = reduceClientState(reselection, { type: "press" });
    expect(second.state).toMatchObject({
      state: "Ready",
      pending: "authentication",
      authAttempt: FIRST_AUTH_ATTEMPT + 1,
    });
    expect(second.effects).toContainEqual({
      type: "prepare-session-auth",
      targetLanguage: "es",
      authAttempt: FIRST_AUTH_ATTEMPT + 1,
    });

    const delayedFirst = reduceClientState(second.state, {
      type: "session.authenticated",
      authAttempt: FIRST_AUTH_ATTEMPT,
    });
    expect(delayedFirst.state).toEqual(second.state);
    expect(delayedFirst.effects).toHaveLength(0);

    const current = reduceClientState(second.state, {
      type: "session.authenticated",
      authAttempt: FIRST_AUTH_ATTEMPT + 1,
    });
    expect(current.state).toMatchObject({
      state: "Ready",
      pending: "initial",
      authAttempt: FIRST_AUTH_ATTEMPT + 1,
    });
    expect(current.effects).toEqual([{ type: "start-session", targetLanguage: "es" }]);
  });

  it("revokes every pending or active authenticated state without retaining session data", () => {
    const recoveryPending = reduce(toSessionReady(), transportLost());
    const revocableStates = [
      toTargetSelection(),
      toAuthenticationPending(),
      toInitialPending(),
      recoveryPending,
      toSessionReady(),
      toListening(),
      toFinalizing(),
      reduce(toFinalizing(), languageDecision("target")),
      toResults(),
    ];
    for (const state of revocableStates) {
      const started = reduceClientState(state, { type: "revocation.started" });
      if (state.state === "Error") throw new Error("Expected a revocable state");
      expect(started.state).toEqual({
        state: "EnrollmentChecking",
        type: "EnrollmentChecking",
        highlightedTarget: "es",
        authAttempt: state.authAttempt,
        phase: "revoking",
      });
      const expectedCleanup = state.state === "Listening"
        ? ["cancel-session-boundary", "stop-audio", "end-session"]
        : state.state === "TargetSelection"
          ? ["cancel-session-boundary"]
        : state.state === "Ready" &&
            (state.pending === "authentication" || state.pending === "initial")
          ? ["cancel-session-boundary"]
          : ["cancel-session-boundary", "end-session"];
      expect(started.effects.map((effect) => effect.type)).toEqual(expectedCleanup);
      for (const reason of ["revoked", "revocation-unconfirmed"] as const) {
        const completed = reduceClientState(started.state, {
          type: "revocation.completed",
          reason,
        });
        expect(completed.state).toEqual({
          state: "EnrollmentRequired",
          type: "EnrollmentRequired",
          highlightedTarget: "es",
          authAttempt: state.authAttempt,
          reason,
        });
        expect(completed.effects).toHaveLength(0);
      }
    }

    const checking = reduceClientState(createInitialState(), { type: "startup.ready" });
    const completedBeforeRevocation = reduceClientState(checking.state, {
      type: "revocation.completed",
      reason: "revoked",
    });
    expect(completedBeforeRevocation.state).toEqual(checking.state);
    expect(completedBeforeRevocation.effects).toHaveLength(0);
  });

  it("rejects malformed, secret-bearing, accessor, and proxy events without throwing", () => {
    const state = toTargetSelection();
    const canary = "PAIRING-CODE-CREDENTIAL-CANARY";
    const malformedEvents: unknown[] = [
      { type: "enrollment.ready", credential: canary },
      { type: "enrollment.required", reason: "invalid", secret: canary },
      { type: "enrollment.failed", reason: "missing", pairingCode: canary },
      { type: "revocation.completed", reason: "invalid", credential: canary },
      { type: "session.authenticated", credential: canary },
      { type: "press", utteranceId: UTTERANCE_ID, secret: canary },
      { type: "unknown.event", credential: canary },
    ];
    for (const event of malformedEvents) {
      const outcome = reduceClientState(state, asClientEvent(event));
      expect(outcome.state).toEqual(state);
      expect(outcome.effects).toHaveLength(0);
      expect(JSON.stringify(outcome)).not.toContain(canary);
    }

    const getter = { type: "enrollment.ready" } as Record<string, unknown>;
    Object.defineProperty(getter, "credential", {
      enumerable: true,
      get: () => {
        throw new Error(canary);
      },
    });
    expect(() => reduceClientState(state, asClientEvent(getter))).not.toThrow();
    const getterOutcome = reduceClientState(state, asClientEvent(getter));
    expect(getterOutcome.state).toEqual(state);
    expect(JSON.stringify(getterOutcome)).not.toContain(canary);

    const proxy = new Proxy({ type: "enrollment.ready" }, {
      ownKeys: () => {
        throw new Error(canary);
      },
    });
    expect(() => reduceClientState(state, asClientEvent(proxy))).not.toThrow();
    const proxyOutcome = reduceClientState(state, asClientEvent(proxy));
    expect(proxyOutcome.state).toEqual(state);
    expect(JSON.stringify(proxyOutcome)).not.toContain(canary);
  });

  it("requires canonical session fields and v4 identities", () => {
    const pending = toInitialPending("es");
    const epochAliasReady = reduceClientState(pending, asClientEvent({
      type: "session.ready",
      sessionId: SESSION.sessionId,
      epoch: SESSION.sessionEpoch,
      targetLanguage: "es",
      result: "new",
    }));
    expect(epochAliasReady.state.state).toBe("Ready");
    if (epochAliasReady.state.state !== "Ready") return;
    expect(epochAliasReady.state.sessionReady).toBe(false);
    expect(epochAliasReady.effects).toHaveLength(0);

    const targetAliasReady = reduceClientState(pending, asClientEvent({
      type: "session.ready",
      sessionId: SESSION.sessionId,
      sessionEpoch: SESSION.sessionEpoch,
      target: "es",
      result: "new",
    }));
    expect(targetAliasReady.state.state).toBe("Ready");
    if (targetAliasReady.state.state !== "Ready") return;
    expect(targetAliasReady.state.sessionReady).toBe(false);
    expect(targetAliasReady.effects).toHaveLength(0);

    const legacyResultReady = reduceClientState(pending, asClientEvent({
      type: "session.ready",
      sessionId: SESSION.sessionId,
      sessionEpoch: SESSION.sessionEpoch,
      targetLanguage: "es",
      result: "resumed",
    }));
    expect(legacyResultReady.state).toEqual(pending);
    expect(legacyResultReady.effects).toHaveLength(0);

    for (const invalidSessionId of [
      "session-1",
      SESSION_ID_WRONG_VERSION,
      SESSION_ID_WRONG_VARIANT,
    ]) {
      const invalidSession = reduceClientState(pending, asClientEvent({
        type: "session.ready",
        sessionId: invalidSessionId,
        sessionEpoch: SESSION.sessionEpoch,
        targetLanguage: "es",
        result: "new",
      }));
      expect(invalidSession.state.state).toBe("Ready");
      if (invalidSession.state.state !== "Ready") return;
      expect(invalidSession.state.sessionReady).toBe(false);
    }

    const ready = toSessionReady();
    const missingUtterance = reduceClientState(ready, { type: "press" });
    expect(missingUtterance.state.state).toBe("Ready");
    expect(missingUtterance.effects).toHaveLength(0);
    for (const invalidUtteranceId of [
      "utterance-1",
      UTTERANCE_ID_WRONG_VERSION,
      UTTERANCE_ID_WRONG_VARIANT,
    ]) {
      const invalidUtterance = reduceClientState(ready, {
        type: "press",
        utteranceId: invalidUtteranceId,
      });
      expect(invalidUtterance.state.state).toBe("Ready");
      expect(invalidUtterance.effects).toHaveLength(0);
      expect(JSON.stringify(invalidUtterance.state)).not.toContain("utterance-");
    }
  });

  it("bounds initial and recovery epochs to positive uint32 values", () => {
    const initialPending = toInitialPending("es");
    const maximumInitial = reduceClientState(initialPending, {
      type: "session.ready",
      sessionId: SESSION.sessionId,
      sessionEpoch: MAX_UINT32,
      targetLanguage: "es",
      result: "new",
    });
    expect(maximumInitial.state.state).toBe("Ready");
    if (maximumInitial.state.state !== "Ready" || !maximumInitial.state.sessionReady) return;
    expect(maximumInitial.state.sessionEpoch).toBe(MAX_UINT32);

    for (const invalidEpoch of [0, MAX_UINT32 + 1]) {
      const invalidInitial = reduceClientState(initialPending, asClientEvent({
        type: "session.ready",
        sessionId: SESSION.sessionId,
        sessionEpoch: invalidEpoch,
        targetLanguage: "es",
        result: "new",
      }));
      expect(invalidInitial.state).toEqual(initialPending);
      expect(invalidInitial.effects).toHaveLength(0);
    }

    const priorEstablished = reduce(initialPending, {
      type: "session.ready",
      sessionId: SESSION.sessionId,
      sessionEpoch: MAX_UINT32 - 1,
      targetLanguage: "es",
      result: "new",
    });
    const recoveryPending = reduceClientState(priorEstablished, {
      type: "transport.lost",
      sessionId: SESSION.sessionId,
      sessionEpoch: MAX_UINT32 - 1,
    }).state;
    expect(recoveryPending.state).toBe("Ready");
    if (recoveryPending.state !== "Ready" || recoveryPending.pending !== "recovery") return;

    const maximumRecovery = reduceClientState(recoveryPending, {
      type: "session.ready",
      sessionId: OTHER_SESSION.sessionId,
      sessionEpoch: MAX_UINT32,
      targetLanguage: "es",
      result: "new",
    });
    expect(maximumRecovery.state.state).toBe("Ready");
    if (maximumRecovery.state.state !== "Ready" || !maximumRecovery.state.sessionReady) return;
    expect(maximumRecovery.state.sessionEpoch).toBe(MAX_UINT32);
    expect(maximumRecovery.effects).toEqual([]);

    const overflowRecovery = reduceClientState(recoveryPending, asClientEvent({
      type: "session.ready",
      sessionId: OTHER_SESSION.sessionId,
      sessionEpoch: MAX_UINT32 + 1,
      targetLanguage: "es",
      result: "new",
    }));
    expect(overflowRecovery.state.state).toBe("Error");
    if (overflowRecovery.state.state === "Error") {
      expect(overflowRecovery.state.terminal).toBe(true);
    }

    for (const invalidPreviousEpoch of [0, MAX_UINT32 + 1]) {
      const forgedRecovery = {
        ...recoveryPending,
        previousSessionEpoch: invalidPreviousEpoch,
      } as ClientState;
      const invalidPrevious = reduceClientState(forgedRecovery, {
        type: "session.ready",
        sessionId: OTHER_SESSION.sessionId,
        sessionEpoch: 1,
        targetLanguage: "es",
        result: "new",
      });
      expect(invalidPrevious.state.state).toBe("Error");
      if (invalidPrevious.state.state === "Error") {
        expect(invalidPrevious.state.terminal).toBe(true);
      }
    }
  });

  it.each(["es", "tr"] as const)("runs the full happy path for %s", (targetLanguage) => {
    let state = toSessionReady(targetLanguage);
    expect(state.state).toBe("Ready");

    let transition = reduceClientState(state, { type: "press", utteranceId: UTTERANCE_ID });
    expect(transition.state.state).toBe("Listening");
    expect(transition.effects.map((effect) => effect.type)).toEqual([
      "start-utterance",
      "start-audio",
    ]);
    state = transition.state;

    state = reduce(state, {
      type: "transcript.partial",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      revision: 1,
      text: targetLanguage === "es" ? "hola" : "merhaba",
    });
    expect(state.state).toBe("Listening");
    if (state.state !== "Listening") return;
    expect(state.transcript).toBe(targetLanguage === "es" ? "hola" : "merhaba");

    const stale = reduceClientState(state, {
      type: "transcript.partial",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      revision: 1,
      text: "stale payload",
    });
    expect(stale.state).toEqual(state);
    expect(stale.effects).toHaveLength(0);

    transition = reduceClientState(state, { type: "press" });
    expect(transition.state.state).toBe("Finalizing");
    expect(transition.effects.map((effect) => effect.type)).toEqual([
      "stop-audio",
      "commit-utterance",
    ]);
    state = transition.state;

    const partialAfterCommit = reduceClientState(state, {
      type: "transcript.partial",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      revision: 2,
      text: "partial after commit",
    });
    expect(partialAfterCommit.state.state).toBe("Finalizing");
    state = partialAfterCommit.state;

    const finalInListening = reduceClientState(
      toListening(targetLanguage),
      {
        type: "transcript.final",
        ...SESSION,
        utteranceId: UTTERANCE_ID,
        segmentId: SEGMENT_ID,
        revision: 1,
        text: "out of order",
      },
    );
    expect(finalInListening.state.state).toBe("Listening");

    state = reduce(state, {
      type: "transcript.final",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      revision: 3,
      text: "final phrase",
    });
    expect(state.state).toBe("Finalizing");

    transition = reduceClientState(state, languageDecision("target", targetLanguage, 3));
    expect(transition.state.state).toBe("Translating");
    expect(transition.effects).toEqual([expect.objectContaining({ type: "request-translation" })]);
    state = transition.state;

    transition = reduceClientState(state, targetTranslation(3));
    expect(transition.state.state).toBe("Translating");
    expect(transition.effects).toEqual([expect.objectContaining({ type: "request-suggestions" })]);
    if (transition.state.state !== "Translating") return;
    expect(transition.state.englishTranslation).toBe("hello world");
    state = transition.state;

    const duplicateTranslation = reduceClientState(state, targetTranslation());
    expect(duplicateTranslation.state).toEqual(state);
    expect(duplicateTranslation.effects).toHaveLength(0);

    state = reduce(state, suggestionsReady({ acceptedFinalRevision: 3 }));
    expect(state.state).toBe("Results");
    if (state.state !== "Results") return;
    expect(state.englishTranslation).toBe("hello world");
    expect(state.suggestionIndex).toBe(0);
    expect(state.suggestions).toEqual(targetSuggestions);

    state = reduce(state, { type: "swipe.next" });
    if (state.state !== "Results") return;
    expect(state.suggestionIndex).toBe(1);
    state = reduce(state, { type: "swipe.previous" });
    if (state.state !== "Results") return;
    expect(state.suggestionIndex).toBe(0);
    const next = reduceClientState(state, {
      type: "press",
      utteranceId: NEXT_UTTERANCE_ID,
    });
    expect(next.state.state).toBe("Listening");
    expect(next.effects.map((effect) => effect.type)).toEqual([
      "start-utterance",
      "start-audio",
    ]);
  });

  it.each(["es", "tr"] as const)(
    "starts the next %s utterance directly from Results with exact effects",
    (targetLanguage) => {
      const results = toResults(targetLanguage);
      expect(results.state).toBe("Results");
      if (results.state !== "Results") return;

      const transition = reduceClientState(results, {
        type: "press",
        utteranceId: NEXT_UTTERANCE_ID,
      });
      expect(transition.state.state).toBe("Listening");
      if (transition.state.state !== "Listening") return;
      expect(transition.state.targetLanguage).toBe(targetLanguage);
      expect(transition.state.sessionId).toBe(SESSION.sessionId);
      expect(transition.state.sessionEpoch).toBe(SESSION.sessionEpoch);
      expect(transition.state.utteranceId).toBe(NEXT_UTTERANCE_ID);
      expect(transition.state.utteranceId).not.toBe(results.utteranceId);
      expect(transition.state.turn).toBe(results.turn + 1);
      expect(transition.state.transcript).toBe("");
      expect(transition.state.segmentTexts).toEqual({});
      expect(transition.state.segmentRevisions).toEqual({});
      expect(transition.state.finalSegments).toEqual({});
      expect(transition.effects).toEqual([
        {
          type: "start-utterance",
          sessionId: SESSION.sessionId,
          sessionEpoch: SESSION.sessionEpoch,
          utteranceId: NEXT_UTTERANCE_ID,
        },
        {
          type: "start-audio",
          sessionId: SESSION.sessionId,
          sessionEpoch: SESSION.sessionEpoch,
          utteranceId: NEXT_UTTERANCE_ID,
        },
      ]);
      expect(Object.isFrozen(transition.state)).toBe(true);
      expect(Object.isFrozen(transition.effects)).toBe(true);
    },
  );

  it("clears all completed result content and active-turn final fields", () => {
    const results = toResults("es");
    expect(results.state).toBe("Results");
    if (results.state !== "Results") return;
    expect(results.finalTranscript).toBe("hola mundo");
    expect(results.finalSegmentId).toBe(SEGMENT_ID);
    expect(results.finalRevision).toBe(2);
    expect(results.englishTranslation).toBe("hello world");
    expect(results.suggestions).toEqual(targetSuggestions);

    const next = reduceClientState(results, {
      type: "press",
      utteranceId: NEXT_UTTERANCE_ID,
    });
    expect(next.state.state).toBe("Listening");
    if (next.state.state !== "Listening") return;
    for (const clearedField of [
      "finalTranscript",
      "finalSegmentId",
      "finalRevision",
      "englishTranslation",
      "suggestions",
      "suggestionIndex",
    ]) {
      expect(clearedField in next.state).toBe(false);
    }
  });

  it("no-ops from Results for absent, malformed, or reused utterance IDs", () => {
    const results = toResults();
    for (const event of [
      { type: "press" },
      { type: "press", utteranceId: "not-a-uuid" },
      { type: "press", utteranceId: UTTERANCE_ID_WRONG_VERSION },
      { type: "press", utteranceId: UTTERANCE_ID_WRONG_VARIANT },
      { type: "press", utteranceId: UTTERANCE_ID },
    ] as const) {
      const unchanged = reduceClientState(results, asClientEvent(event));
      expect(unchanged.state).toEqual(results);
      expect(unchanged.effects).toHaveLength(0);
      expect(Object.isFrozen(unchanged.state)).toBe(true);
    }
  });

  it("no-ops from Results when incrementing turn would exceed uint32", () => {
    const results = toResults();
    const maximumTurnResults = { ...results, turn: MAX_UINT32 } as ClientState;
    const overflow = reduceClientState(maximumTurnResults, {
      type: "press",
      utteranceId: NEXT_UTTERANCE_ID,
    });
    expect(overflow.state).toEqual(maximumTurnResults);
    expect(overflow.effects).toHaveLength(0);
  });

  it("bounds transcript and accepted-result revisions to positive uint32 values", () => {
    const listening = toListening();
    const maximumPartial = reduceClientState(listening, {
      type: "transcript.partial",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      revision: MAX_UINT32,
      text: "maximum revision",
    });
    expect(maximumPartial.state.state).toBe("Listening");
    if (maximumPartial.state.state !== "Listening") return;
    expect(maximumPartial.state.segmentRevisions[SEGMENT_ID]).toBe(MAX_UINT32);

    for (const invalidRevision of [0, MAX_UINT32 + 1]) {
      const invalidPartial = reduceClientState(listening, asClientEvent({
        type: "transcript.partial",
        ...SESSION,
        utteranceId: UTTERANCE_ID,
        segmentId: SEGMENT_ID,
        revision: invalidRevision,
        text: "must not be retained",
      }));
      expect(invalidPartial.state).toEqual(listening);
      expect(invalidPartial.effects).toHaveLength(0);
    }

    let finalizing = reduce(toListening(), { type: "press" });
    finalizing = reduce(finalizing, {
      type: "transcript.final",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      revision: MAX_UINT32,
      text: "maximum final",
    });
    const translating = reduceClientState(
      finalizing,
      languageDecision("target", "es", MAX_UINT32),
    ).state;
    expect(translating.state).toBe("Translating");
    if (translating.state !== "Translating") return;

    const translated = reduceClientState(translating, targetTranslation(MAX_UINT32));
    expect(translated.state.state).toBe("Translating");
    if (translated.state.state !== "Translating") return;
    expect(translated.state.englishTranslation).toBe("hello world");
    expect(translated.effects.map((effect) => effect.type)).toEqual(["request-suggestions"]);
    const maximumResults = reduceClientState(
      translated.state,
      suggestionsReady({ acceptedFinalRevision: MAX_UINT32 }),
    );
    expect(maximumResults.state.state).toBe("Results");

    const forgedOverflowRevision = {
      ...translating,
      finalRevision: MAX_UINT32 + 1,
    } as ClientState;
    const overflowTranslation = reduceClientState(forgedOverflowRevision, asClientEvent({
      ...targetTranslation(MAX_UINT32 + 1),
    }));
    expect(overflowTranslation.state).toEqual(forgedOverflowRevision);
    expect(overflowTranslation.effects).toHaveLength(0);

    const forgedTranslatedOverflow = {
      ...translated.state,
      finalRevision: MAX_UINT32 + 1,
    } as ClientState;
    const overflowSuggestions = reduceClientState(
      forgedTranslatedOverflow,
      suggestionsReady({ acceptedFinalRevision: MAX_UINT32 + 1 }),
    );
    expect(overflowSuggestions.state).toEqual(forgedTranslatedOverflow);
    expect(overflowSuggestions.effects).toHaveLength(0);
  });

  it.each([
    "english",
    "mixed",
    "supported_unselected",
    "unsupported",
    "uncertain",
  ] as const)("suppresses generation for %s decisions", (decision) => {
    const state = toFinalizing("tr");
    const transition = reduceClientState(state, languageDecision(decision, "tr"));
    expect(transition.state.state).toBe("Ready");
    expect(transition.effects).toHaveLength(0);
    if (transition.state.state !== "Ready") return;
    expect(transition.state.sessionReady).toBe(true);
    expect(transition.state.message?.length).toBeGreaterThan(0);
    expect(transition.state.message?.length).toBeLessThanOrEqual(256);
  });

  it("ignores stale async events and rejects mismatched sessions", () => {
    const state = toSessionReady("es");
    const mismatch = reduceClientState(state, {
      type: "session.ready",
      sessionId: OTHER_SESSION.sessionId,
      sessionEpoch: 2,
      targetLanguage: "tr",
      result: "new",
    });
    expect(mismatch.state.state).toBe("Error");
    expect(mismatch.effects).toEqual([expect.objectContaining({ type: "end-session" })]);

    const listening = toListening();
    const stale = reduceClientState(listening, {
      type: "transcript.partial",
      ...OTHER_SESSION,
      utteranceId: OTHER_UTTERANCE_ID,
      segmentId: "s1",
      revision: 1,
      text: "must not be shown",
    });
    expect(stale.state).toEqual(listening);
    expect(JSON.stringify(stale.state)).not.toContain("must not be shown");
  });

  it("requires canonical translation and suggestion fields", () => {
    const translating = reduce(toFinalizing("es"), languageDecision("target", "es"));
    if (translating.state !== "Translating") return;

    const englishAliasTranslation = reduceClientState(translating, asClientEvent({
      type: "translation.ready",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      acceptedFinalRevision: 2,
      english: "must not be accepted",
    }));
    expect(englishAliasTranslation.state).toEqual(translating);
    expect(englishAliasTranslation.effects).toHaveLength(0);
    expect(JSON.stringify(englishAliasTranslation.state)).not.toContain("must not be accepted");

    const englishTextAliasTranslation = reduceClientState(translating, asClientEvent({
      type: "translation.ready",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      acceptedFinalRevision: 2,
      englishText: "must not be accepted",
    }));
    expect(englishTextAliasTranslation.state).toEqual(translating);
    expect(englishTextAliasTranslation.effects).toHaveLength(0);
    expect(JSON.stringify(englishTextAliasTranslation.state)).not.toContain("must not be accepted");

    const beforeTranslation = reduceClientState(translating, suggestionsReady({
      suggestions: [
        { english: "hello", target: "hola" },
        { english: "hi", target: "buenas" },
      ],
    }));
    expect(beforeTranslation.state).toEqual(translating);
    expect(beforeTranslation.effects).toHaveLength(0);

    const translated = reduce(translating, targetTranslation());
    const suggestionAliasPayloads = [
      [
        { english: "hello", selectedTargetText: "hola" },
        { english: "hi", selectedTargetText: "buenas" },
      ],
      [
        { englishText: "hello", targetText: "hola" },
        { englishText: "hi", targetText: "buenas" },
      ],
      [
        { englishText: "hello", target: "hola" },
        { englishText: "hi", target: "buenas" },
      ],
    ];
    for (const payload of suggestionAliasPayloads) {
      const aliasedSuggestions = reduceClientState(translated, suggestionsReady({
        suggestions: payload,
      }));
      expect(aliasedSuggestions.state.state).toBe("Error");
      expect(aliasedSuggestions.effects.map((effect) => effect.type)).toEqual(["end-session"]);
      expect(JSON.stringify(aliasedSuggestions.state)).not.toContain("hola");
    }
  });

  it("ignores stale, cross-session, and cross-revision suggestions", () => {
    const translating = reduce(toFinalizing("es"), languageDecision("target", "es"));
    if (translating.state !== "Translating") return;

    const beforeTranslation = reduceClientState(translating, suggestionsReady());
    expect(beforeTranslation.state).toEqual(translating);

    const withTranslation = reduceClientState(translating, targetTranslation()).state;
    const crossSession = reduceClientState(withTranslation, suggestionsReady({
      sessionId: OTHER_SESSION.sessionId,
    }));
    expect(crossSession.state).toEqual(withTranslation);
    expect(crossSession.effects).toHaveLength(0);

    const crossRevision = reduceClientState(withTranslation, suggestionsReady({
      acceptedFinalRevision: 1,
    }));
    expect(crossRevision.state).toEqual(withTranslation);
    expect(crossRevision.effects).toHaveLength(0);
  });

  it("clears every active turn and starts a fresh session after matching loss", () => {
    const listening = reduce(toListening(), {
      type: "transcript.partial",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      revision: 1,
      text: "payload-rich partial",
    });
    const finalizing = toFinalizing();
    const translating = reduce(finalizing, languageDecision("target"));
    const translated = reduce(translating, targetTranslation());
    const results = reduce(translated, suggestionsReady());
    const activeStates: ActiveTurnClientState[] = [
      listening as Extract<ClientState, { state: "Listening" }>,
      finalizing as Extract<ClientState, { state: "Finalizing" }>,
      translated as Extract<ClientState, { state: "Translating" }>,
      results as Extract<ClientState, { state: "Results" }>,
    ];
    expect(activeStates.map((state) => state.state)).toEqual([
      "Listening",
      "Finalizing",
      "Translating",
      "Results",
    ]);

    for (const activeState of activeStates) {
      const lost = reduceClientState(activeState, transportLost());
      expect(lost.state.state).toBe("Ready");
      expect(lost.effects.map((effect) => effect.type)).toEqual([
        "stop-audio",
        "start-fresh-session",
      ]);
      expect(lost.effects[1]).toEqual({
        type: "start-fresh-session",
        targetLanguage: "es",
        previousSessionId: SESSION.sessionId,
        previousSessionEpoch: SESSION.sessionEpoch,
      });
      if (lost.state.state !== "Ready") return;
      if (lost.state.pending !== "recovery") return;
      expect(lost.state.sessionReady).toBe(false);
      expect(lost.state.pending).toBe("recovery");
      expect(lost.state.previousSessionId).toBe(SESSION.sessionId);
      expect(lost.state.previousSessionEpoch).toBe(SESSION.sessionEpoch);
      expect(lost.state.turn).toBe(activeState.turn);
      for (const clearedField of [
        "sessionId",
        "sessionEpoch",
        "utteranceId",
        "transcript",
        "segmentTexts",
        "segmentRevisions",
        "finalSegments",
        "finalTranscript",
        "finalSegmentId",
        "finalRevision",
        "englishTranslation",
        "suggestions",
        "suggestionIndex",
      ]) {
        expect(clearedField in lost.state).toBe(false);
      }
    }
  });

  it("ignores partial identity matches across established and every active state", () => {
    const listening = reduce(toListening(), {
      type: "transcript.partial",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      revision: 1,
      text: "retained until a matching loss",
    });
    const finalizing = toFinalizing();
    const translating = reduce(
      reduce(finalizing, languageDecision("target")),
      targetTranslation(),
    );
    const results = reduce(translating, suggestionsReady());
    const guardedStates = [toSessionReady(), listening, finalizing, translating, results];

    for (const guardedState of guardedStates) {
      for (const mismatch of [
        { sessionId: OTHER_SESSION.sessionId, sessionEpoch: SESSION.sessionEpoch },
        { sessionId: SESSION.sessionId, sessionEpoch: SESSION.sessionEpoch + 1 },
      ]) {
        const ignored = reduceClientState(guardedState, {
          type: "transport.lost",
          ...mismatch,
        });
        expect(ignored.state).toEqual(guardedState);
        expect(ignored.effects).toHaveLength(0);
      }
    }
  });

  it("restarts an idle established session with only a fresh-session effect", () => {
    const lost = reduceClientState(toSessionReady(), {
      type: "transport.lost",
      ...SESSION,
    });
    expect(lost.state.state).toBe("Ready");
    if (lost.state.state !== "Ready") return;
    expect(lost.state.sessionReady).toBe(false);
    expect(lost.state.pending).toBe("recovery");
    expect(lost.effects).toEqual([{
      type: "start-fresh-session",
      targetLanguage: "es",
      previousSessionId: SESSION.sessionId,
      previousSessionEpoch: SESSION.sessionEpoch,
    }]);
  });

  it("accepts recovery only for a strictly newer session and never opens audio", () => {
    const lost = reduceClientState(toListening(), transportLost());
    if (lost.state.state !== "Ready") return;
    const ready = reduceClientState(lost.state, {
      type: "session.ready",
      sessionId: OTHER_SESSION.sessionId,
      sessionEpoch: 2,
      targetLanguage: "es",
      result: "new",
    });
    expect(ready.state.state).toBe("Ready");
    if (ready.state.state !== "Ready") return;
    expect(ready.state.sessionReady).toBe(true);
    if (!ready.state.sessionReady) return;
    expect(ready.state.pending).toBe(false);
    expect(ready.state.sessionId).toBe(OTHER_SESSION.sessionId);
    expect(ready.state.sessionEpoch).toBe(2);
    expect(ready.state.turn).toBe(1);
    expect(ready.state.message).toBe("Connection lost; starting a fresh session.");
    expect("previousSessionId" in ready.state).toBe(false);
    expect("previousSessionEpoch" in ready.state).toBe(false);
    expect(ready.effects).toEqual([]);

    for (const invalid of [
      { sessionId: SESSION.sessionId, sessionEpoch: 1, targetLanguage: "es" },
      { sessionId: SESSION.sessionId, sessionEpoch: 2, targetLanguage: "es" },
      { sessionId: OTHER_SESSION.sessionId, sessionEpoch: 1, targetLanguage: "es" },
      { sessionId: OTHER_SESSION.sessionId, sessionEpoch: 2, targetLanguage: "tr" },
    ]) {
      const invalidReady = reduceClientState(lost.state, asClientEvent({
        type: "session.ready",
        ...invalid,
        result: "new",
      }));
      expect(invalidReady.state.state).toBe("Error");
      if (invalidReady.state.state === "Error") expect(invalidReady.state.terminal).toBe(true);
      expect(invalidReady.effects).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "start-audio" }),
      ]));
    }
  });

  it("enters a terminal recovery error, ignores presses, and ignores stale legacy events", () => {
    const lost = reduceClientState(toListening(), transportLost());
    if (lost.state.state !== "Ready") return;
    const stale = reduceClientState(lost.state, {
      type: "recovery.failed",
      ...OTHER_SESSION,
    });
    expect(stale.state).toEqual(lost.state);
    expect(stale.effects).toHaveLength(0);

    const failed = reduceClientState(lost.state, asClientEvent({
      type: "recovery.failed",
      ...SESSION,
    }));
    expect(failed.state.state).toBe("Error");
    if (failed.state.state !== "Error") return;
    expect(failed.state.terminal).toBe(true);
    expect(failed.state.message).toBe("Fresh-session recovery failed.");
    expect(JSON.stringify(failed.state)).not.toContain("must not be displayed");

    const pressed = reduceClientState(failed.state, {
      type: "press",
      utteranceId: UTTERANCE_ID,
    });
    expect(pressed.state).toEqual(failed.state);
    expect(pressed.effects).toHaveLength(0);

    for (const legacyType of ["transport.resumed", "transport.non-resumable"] as const) {
      const legacy = reduceClientState(lost.state, asClientEvent({
        type: legacyType,
        ...SESSION,
      }));
      expect(legacy.state).toEqual(lost.state);
      expect(legacy.effects).toHaveLength(0);
    }
  });

  it("validates abort categories and ignores the removed non-resumable category", () => {
    const active = toListening();
    for (const category of ["non_resumable", "unknown"] as const) {
      const ignored = reduceClientState(active, asClientEvent({
        type: "utterance.aborted",
        ...SESSION,
        utteranceId: UTTERANCE_ID,
        category,
      }));
      expect(ignored.state).toEqual(active);
      expect(ignored.effects).toHaveLength(0);
    }

    const utteranceAborted = reduceClientState(active, {
      type: "utterance.aborted",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      category: "flow",
    });
    expect(utteranceAborted.state.state).toBe("Ready");
    expect(utteranceAborted.effects.map((effect) => effect.type)).toEqual(["stop-audio"]);
    if (utteranceAborted.state.state !== "Ready") return;
    expect("transcript" in utteranceAborted.state).toBe(false);
    expect(utteranceAborted.state.sessionReady).toBe(true);
  });

  it("turns matching malformed results and transcript overflow into terminal cleanup", () => {
    const translating = reduce(toFinalizing("es"), languageDecision("target", "es"));
    if (translating.state !== "Translating") return;
    const malformedTranslation = reduceClientState(translating, asClientEvent({
      type: "translation.ready",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      acceptedFinalRevision: 2,
    }));
    expect(malformedTranslation.state.state).toBe("Error");
    expect(malformedTranslation.effects.map((effect) => effect.type)).toEqual(["end-session"]);

    const malformedSuggestions = reduceClientState(
      reduce(translating, targetTranslation()),
      suggestionsReady({ suggestions: [{ englishText: "", selectedTargetText: "secret result" }] }),
    );
    expect(malformedSuggestions.state.state).toBe("Error");
    expect(JSON.stringify(malformedSuggestions.state)).not.toContain("secret result");

    const fullTranscript = reduce(
      toListening(),
      {
        type: "transcript.partial",
        ...SESSION,
        utteranceId: UTTERANCE_ID,
        segmentId: SEGMENT_ID,
        revision: 1,
        text: "x".repeat(MAX_TRANSCRIPT_LENGTH),
      },
    );
    const transcriptOverflow = reduceClientState(fullTranscript, {
      type: "transcript.partial",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: "segment-2",
      revision: 1,
      text: "x",
    });
    expect(transcriptOverflow.state.state).toBe("Error");
    expect(transcriptOverflow.effects.map((effect) => effect.type)).toEqual([
      "stop-audio",
      "end-session",
    ]);
  });

  it("bounds retained segment count", () => {
    let state = toListening();
    for (let index = 1; index <= MAX_TRANSCRIPT_SEGMENTS; index += 1) {
      state = reduce(state, {
        type: "transcript.partial",
        ...SESSION,
        utteranceId: UTTERANCE_ID,
        segmentId: `segment-${index}`,
        revision: 1,
        text: "x",
      });
    }
    expect(state.state).toBe("Listening");
    const overflow = reduceClientState(state, {
      type: "transcript.partial",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: `segment-${MAX_TRANSCRIPT_SEGMENTS + 1}`,
      revision: 1,
      text: "x",
    });
    expect(overflow.state.state).toBe("Error");
  });

  it("does not freeze caller-owned state, events, or nested values", () => {
    const withPartial = reduce(toListening(), {
      type: "transcript.partial",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      revision: 1,
      text: "hola",
    });
    if (withPartial.state !== "Listening") return;
    const callerState = {
      ...withPartial,
      segmentTexts: { ...withPartial.segmentTexts },
      segmentRevisions: { ...withPartial.segmentRevisions },
      finalSegments: { ...withPartial.finalSegments },
    };
    const callerSegmentTexts = callerState.segmentTexts;
    const stateResult = reduceClientState(callerState, {
      type: "transcript.partial",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      revision: 2,
      text: "hola dos",
    });

    expect(Object.isFrozen(callerState)).toBe(false);
    expect(Object.isFrozen(callerSegmentTexts)).toBe(false);
    expect(callerSegmentTexts[SEGMENT_ID]).toBe("hola");
    expect(stateResult.state.state).toBe("Listening");
    if (stateResult.state.state !== "Listening") return;
    expect(stateResult.state.segmentTexts).not.toBe(callerSegmentTexts);
    expect(stateResult.state.segmentTexts[SEGMENT_ID]).toBe("hola dos");

    const event = {
      type: "suggestions.ready" as const,
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      acceptedFinalRevision: 2,
      suggestions: [
        { englishText: "Hello", selectedTargetText: "Hola" },
        { englishText: "Hi", selectedTargetText: "Buenas" },
      ],
    };
    const translation = reduce(toFinalizing(), languageDecision("target"));
    const translating = reduce(translation, targetTranslation());
    const result = reduceClientState(translating, event);

    expect(Object.isFrozen(event)).toBe(false);
    expect(Object.isFrozen(event.suggestions)).toBe(false);
    expect(Object.isFrozen(event.suggestions[0])).toBe(false);
    expect(result.state.state).toBe("Results");
    expect(Object.isFrozen(result.state)).toBe(true);
    if (result.state.state !== "Results") return;
    expect(Object.isFrozen(result.state.suggestions)).toBe(true);
    expect(Object.isFrozen(result.state.suggestions[0])).toBe(true);
    expect(Object.prototype.propertyIsEnumerable.call(result.state, "type")).toBe(true);
  });

  it("bounds safe startup messages and performs fatal/shutdown cleanup once", () => {
    const failed = reduceClientState(createInitialState(), asClientEvent({
      type: "startup.failed",
    }));
    expect(failed.state.state).toBe("Error");
    if (failed.state.state !== "Error") return;
    expect(failed.state.terminal).toBe(true);
    expect(failed.state.message).toBe("Startup failed.");
    expect(failed.state.message.length).toBeLessThanOrEqual(256);

    const active = toListening();
    const fatal = reduceClientState(active, asClientEvent({
      type: "fatal",
    }));
    expect(fatal.state.state).toBe("Error");
    expect(fatal.effects.map((effect) => effect.type)).toEqual(["stop-audio", "end-session"]);
    if (fatal.state.state !== "Error") return;
    expect(JSON.stringify(fatal.state)).not.toContain("arbitrary");

    const shutdown = reduceClientState(active, { type: "shutdown" });
    expect(shutdown.state.state).toBe("Error");
    expect(shutdown.effects.map((effect) => effect.type)).toEqual(["stop-audio", "end-session"]);
    const repeated = reduceClientState(shutdown.state, { type: "shutdown" });
    expect(repeated.effects).toHaveLength(0);
    expect(repeated.state).toEqual(shutdown.state);

    const repeatedFatal = reduceClientState(fatal.state, { type: "fatal" });
    expect(repeatedFatal.effects).toHaveLength(0);
    expect(repeatedFatal.state).toEqual(fatal.state);
  });

  it("keeps state and effects deeply frozen", () => {
    const state = toFinalizing("tr");
    const result = reduceClientState(state, languageDecision("target", "tr"));
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(Object.isFrozen(result.effects)).toBe(true);
    expect(Object.isFrozen(result.effects[0])).toBe(true);
    expect(Object.prototype.propertyIsEnumerable.call(result.state, "type")).toBe(true);
  });
});
