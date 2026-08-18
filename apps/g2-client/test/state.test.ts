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
const SEGMENT_ID = "segment-1";

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
  if (state.state !== "Starting" && state.state !== "TargetSelection") {
    throw new Error(`Expected a selection state, received ${state.state}`);
  }
  return state.highlightedTarget;
};

const toSessionReady = (targetLanguage: "es" | "tr" = "es"): ClientState => {
  let state = createInitialState(targetLanguage);
  state = reduce(state, { type: "startup.ready" });
  state = reduce(state, { type: "press" });
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

    const selected = reduceClientState(defaultState, { type: "startup.ready" });
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

    const selection = reduce(initial, { type: "startup.ready" });
    const confirmed = reduceClientState(selection, { type: "press" });
    expect(confirmed.state.state).toBe("Ready");
    if (confirmed.state.state !== "Ready") return;
    expect(confirmed.state.sessionReady).toBe(false);
    expect(confirmed.state.pending).toBe("initial");
    expect(confirmed.effects.map((effect) => effect.type)).toEqual([
      "persist-target",
      "start-session",
    ]);
    expect(confirmed.effects).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "start-audio" }),
    ]));

    expect(reduceClientState(confirmed.state, { type: "press" }).effects).toHaveLength(0);
    const ready = reduceClientState(confirmed.state, sessionReady("tr"));
    expect(ready.state.state).toBe("Ready");
    if (ready.state.state !== "Ready") return;
    expect(ready.state.sessionReady).toBe(true);
    if (!ready.state.sessionReady) return;
    expect(ready.state.pending).toBe(false);
    expect(ready.effects).toHaveLength(0);
  });

  it("requires canonical session fields and v4 identities", () => {
    const pending = reduce(
      reduce(createInitialState("es"), { type: "startup.ready" }),
      { type: "press" },
    );
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
    const initialPending = reduce(
      reduce(createInitialState("es"), { type: "startup.ready" }),
      { type: "press" },
    );
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
      "start-audio",
      "start-utterance",
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
    state = reduce(state, { type: "press" });
    expect(state.state).toBe("Ready");
    if (state.state !== "Ready") return;
    expect(state.sessionReady).toBe(true);
    expect("transcript" in state).toBe(false);
    expect("suggestions" in state).toBe(false);
    expect("suggestionIndex" in state).toBe(false);
    expect("englishTranslation" in state).toBe(false);
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
    expect(englishAliasTranslation.state.state).toBe("Error");
    expect(englishAliasTranslation.effects.map((effect) => effect.type)).toEqual(["end-session"]);
    expect(JSON.stringify(englishAliasTranslation.state)).not.toContain("must not be accepted");

    const englishTextAliasTranslation = reduceClientState(translating, asClientEvent({
      type: "translation.ready",
      ...SESSION,
      utteranceId: UTTERANCE_ID,
      segmentId: SEGMENT_ID,
      acceptedFinalRevision: 2,
      englishText: "must not be accepted",
    }));
    expect(englishTextAliasTranslation.state.state).toBe("Error");
    expect(englishTextAliasTranslation.effects.map((effect) => effect.type)).toEqual(["end-session"]);
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
      message: { secret: "must not be displayed" },
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
      message: "x".repeat(1_000),
    }));
    expect(failed.state.state).toBe("Error");
    if (failed.state.state !== "Error") return;
    expect(failed.state.terminal).toBe(true);
    expect(failed.state.message).toBe("Startup failed.");
    expect(failed.state.message.length).toBeLessThanOrEqual(256);

    const active = toListening();
    const fatal = reduceClientState(active, asClientEvent({
      type: "fatal",
      message: { arbitrary: "object" },
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
