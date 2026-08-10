import {
  getLanguageDefinition,
  isTargetLanguage,
  listLanguageDefinitions,
  type TargetLanguage,
} from "@palancar/language-registry";

export const MAX_DISPLAY_MESSAGE_LENGTH = 256;
export const MAX_RESULT_TEXT_LENGTH = 1_024;
export const MAX_TRANSCRIPT_LENGTH = 4_096;
export const MAX_TRANSCRIPT_SEGMENTS = 64;
export const MAX_AUDIO_OFFSET = 480_000;
export const MAX_RETAINED_REPLAY_SAMPLES = 8_000;

type StateName =
  | "Starting"
  | "TargetSelection"
  | "Ready"
  | "Listening"
  | "Finalizing"
  | "Translating"
  | "Results"
  | "Recovering"
  | "Error";

export interface StartingState {
  readonly state: "Starting";
  readonly type: "Starting";
  readonly highlightedTarget: TargetLanguage;
}

export interface TargetSelectionState {
  readonly state: "TargetSelection";
  readonly type: "TargetSelection";
  readonly highlightedTarget: TargetLanguage;
}

interface ReadyStateBase {
  readonly state: "Ready";
  readonly type: "Ready";
  readonly targetLanguage: TargetLanguage;
  readonly turn: number;
  readonly transcript: "";
  readonly suggestions: readonly [];
  readonly suggestionIndex: 0;
  readonly message?: string;
}

export interface PendingReadyState extends ReadyStateBase {
  readonly sessionReady: false;
}

export interface EstablishedReadyState extends ReadyStateBase {
  readonly sessionReady: true;
  readonly sessionId: string;
  readonly sessionEpoch: number;
}

export type ReadyState = PendingReadyState | EstablishedReadyState;

interface ActiveTurnState {
  readonly targetLanguage: TargetLanguage;
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
  readonly turn: number;
  readonly transcript: string;
  readonly segmentTexts: Readonly<Record<string, string>>;
  readonly segmentRevisions: Readonly<Record<string, number>>;
  readonly finalSegments: Readonly<Record<string, boolean>>;
  readonly finalTranscript?: string;
  readonly finalSegmentId?: string;
  readonly finalRevision?: number;
}

export interface ListeningState extends ActiveTurnState {
  readonly state: "Listening";
  readonly type: "Listening";
}

export interface FinalizingState extends ActiveTurnState {
  readonly state: "Finalizing";
  readonly type: "Finalizing";
}

export interface TranslatingState extends ActiveTurnState {
  readonly state: "Translating";
  readonly type: "Translating";
  readonly englishTranslation?: string;
  readonly suggestions: readonly [];
  readonly suggestionIndex: 0;
}

export interface Suggestion {
  readonly englishText: string;
  readonly selectedTargetText: string;
}

export interface ResultsState extends ActiveTurnState {
  readonly state: "Results";
  readonly type: "Results";
  readonly englishTranslation: string;
  readonly suggestions: readonly Suggestion[];
  readonly suggestionIndex: number;
}

export type ActiveResumableState =
  | ListeningState
  | FinalizingState
  | TranslatingState
  | ResultsState;

export type ResumableState = ReadyState | ActiveResumableState;

export interface ReplaySnapshot {
  readonly utteranceId: string;
  readonly clientLastAcknowledgedOffset: number;
  readonly oldestRetainedOffset: number;
  readonly nextCapturedOffset: number;
}

export interface RecoveringState {
  readonly state: "Recovering";
  readonly type: "Recovering";
  readonly targetLanguage: TargetLanguage;
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly priorState: ActiveResumableState;
  readonly replay: ReplaySnapshot;
  readonly message: string;
}

export interface ErrorState {
  readonly state: "Error";
  readonly type: "Error";
  readonly message: string;
  readonly terminal: boolean;
  readonly targetLanguage?: TargetLanguage;
  readonly sessionId?: string;
  readonly sessionEpoch?: number;
}

export type ClientState =
  | StartingState
  | TargetSelectionState
  | ReadyState
  | ListeningState
  | FinalizingState
  | TranslatingState
  | ResultsState
  | RecoveringState
  | ErrorState;

export interface StartupReadyEvent {
  readonly type: "startup.ready";
}

export interface StartupFailedEvent {
  readonly type: "startup.failed";
}

export interface SwipeNextEvent {
  readonly type: "swipe.next";
}

export interface SwipePreviousEvent {
  readonly type: "swipe.previous";
}

export interface PressEvent {
  readonly type: "press";
  readonly utteranceId?: string;
}

export interface SessionReadyEvent {
  readonly type: "session.ready";
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly targetLanguage: TargetLanguage;
  readonly result: "new" | "resumed";
}

export interface TranscriptEventBase {
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
  readonly segmentId: string;
  readonly revision: number;
  readonly text: string;
}

export interface TranscriptPartialEvent extends TranscriptEventBase {
  readonly type: "transcript.partial";
}

export interface TranscriptFinalEvent extends TranscriptEventBase {
  readonly type: "transcript.final";
}

export type LanguageDecisionValue =
  | "target"
  | "mixed"
  | "english"
  | "supported_unselected"
  | "unsupported"
  | "uncertain";

export interface LanguageDecisionEvent {
  readonly type: "language.decision";
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
  readonly segmentId: string;
  readonly revision: number;
  readonly decision: LanguageDecisionValue;
  readonly selectedTargetLanguage: TargetLanguage;
}

export interface TranslationReadyEvent {
  readonly type: "translation.ready";
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
  readonly segmentId: string;
  readonly acceptedFinalRevision: number;
  readonly englishTranslation: unknown;
}

export interface SuggestionsReadyEvent {
  readonly type: "suggestions.ready";
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
  readonly segmentId: string;
  readonly acceptedFinalRevision: number;
  readonly suggestions: unknown;
}

export interface IdleTransportLostEvent {
  readonly type: "transport.lost";
  readonly sessionId: string;
  readonly sessionEpoch: number;
}

export interface ActiveTransportLostEvent extends IdleTransportLostEvent {
  readonly utteranceId: string;
  readonly clientLastAcknowledgedOffset: number;
  readonly oldestRetainedOffset: number;
  readonly nextCapturedOffset: number;
}

export type TransportLostEvent = IdleTransportLostEvent | ActiveTransportLostEvent;

export interface TransportResumedEvent {
  readonly type: "transport.resumed";
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly resumable?: boolean;
}

export interface TransportNonResumableEvent {
  readonly type: "transport.non-resumable";
  readonly sessionId: string;
  readonly sessionEpoch: number;
}

export type UtteranceAbortCategory =
  | "non_resumable"
  | "flow"
  | "duration"
  | "rate"
  | "cancellation"
  | "stale_conflict"
  | "provider_loss";

export interface UtteranceAbortedEvent {
  readonly type: "utterance.aborted";
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly utteranceId: string;
  readonly category: UtteranceAbortCategory;
}

export interface FatalEvent {
  readonly type: "fatal";
}

export interface ShutdownEvent {
  readonly type: "shutdown";
}

export type LocalClientEvent =
  | StartupReadyEvent
  | StartupFailedEvent
  | SwipeNextEvent
  | SwipePreviousEvent
  | PressEvent
  | TransportLostEvent
  | TransportResumedEvent
  | TransportNonResumableEvent
  | FatalEvent
  | ShutdownEvent;

export type ServerClientEvent =
  | SessionReadyEvent
  | TranscriptPartialEvent
  | TranscriptFinalEvent
  | LanguageDecisionEvent
  | TranslationReadyEvent
  | SuggestionsReadyEvent
  | UtteranceAbortedEvent;

export type ClientEvent = LocalClientEvent | ServerClientEvent;

export interface PersistTargetEffect {
  readonly type: "persist-target";
  readonly targetLanguage: TargetLanguage;
}

export interface StartSessionEffect {
  readonly type: "start-session";
  readonly targetLanguage: TargetLanguage;
}

export interface SessionEffect {
  readonly sessionId: string;
  readonly sessionEpoch: number;
}

export interface AudioEffect extends SessionEffect {
  readonly type: "start-audio" | "stop-audio";
  readonly utteranceId: string;
}

export interface UtteranceEffect extends SessionEffect {
  readonly type: "start-utterance" | "commit-utterance";
  readonly utteranceId: string;
}

export interface ResumeSessionEffect extends SessionEffect, ReplaySnapshot {
  readonly type: "resume-session";
}

export interface EndSessionEffect extends SessionEffect {
  readonly type: "end-session";
}

export interface RequestTranslationEffect extends SessionEffect {
  readonly type: "request-translation";
  readonly utteranceId: string;
  readonly segmentId: string;
  readonly acceptedFinalRevision: number;
}

export interface RequestSuggestionsEffect extends SessionEffect {
  readonly type: "request-suggestions";
  readonly utteranceId: string;
  readonly segmentId: string;
  readonly acceptedFinalRevision: number;
}

export type ClientEffect =
  | PersistTargetEffect
  | StartSessionEffect
  | AudioEffect
  | UtteranceEffect
  | ResumeSessionEffect
  | EndSessionEffect
  | RequestTranslationEffect
  | RequestSuggestionsEffect;

export interface ClientStateReduction {
  readonly state: ClientState;
  readonly effects: readonly ClientEffect[];
}

interface SessionIdentity {
  readonly sessionId: string;
  readonly sessionEpoch: number;
}

interface ActiveTurnData extends SessionIdentity {
  readonly targetLanguage: TargetLanguage;
  readonly utteranceId: string;
  readonly turn: number;
  readonly transcript: string;
  readonly segmentTexts: Readonly<Record<string, string>>;
  readonly segmentRevisions: Readonly<Record<string, number>>;
  readonly finalSegments: Readonly<Record<string, boolean>>;
  readonly finalTranscript?: string;
  readonly finalSegmentId?: string;
  readonly finalRevision?: number;
}

const NO_EFFECTS: readonly ClientEffect[] = Object.freeze([]);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEGMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_MESSAGES = Object.freeze({
  startup: "Startup failed.",
  fatal: "The client encountered an unrecoverable error.",
  shutdown: "Shutting down.",
  transportLost: "Connection lost; recovering.",
  nonResumable: "Connection could not be resumed; start a new turn.",
  replayInvalid: "The captured audio could not be safely resumed; start a new turn.",
  utteranceAborted: "The utterance was aborted; ready for a new turn.",
  malformedResults: "Response results were invalid; ready for a new turn.",
  transcriptOverflow: "The transcript exceeded the safe display limit; ready for a new turn.",
  sessionMismatch: "The session target did not match the confirmed target.",
} as const);

function cloneValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const objectValue = value as object;
  const existing = seen.get(objectValue);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(objectValue, clone);
    for (const child of value) clone.push(cloneValue(child, seen));
    return clone as T;
  }

  const clone: Record<string, unknown> = {};
  seen.set(objectValue, clone);
  for (const [key, child] of Object.entries(value)) clone[key] = cloneValue(child, seen);
  return clone as T;
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor !== undefined && "value" in descriptor) freezeDeep(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function makeState<T extends { readonly state: StateName }>(value: T): T & { readonly type: T["state"] } {
  const withType = {
    ...cloneValue(value),
    type: value.state,
  } as T & { readonly type: T["state"] };
  return freezeDeep(withType);
}

function normalizeInput<T>(value: T): T {
  return freezeDeep(cloneValue(value));
}

function reduction(state: ClientState, effects: readonly ClientEffect[] = NO_EFFECTS): ClientStateReduction {
  const frozenState = normalizeInput(state);
  const frozenEffects = effects.length === 0
    ? NO_EFFECTS
    : freezeDeep(cloneValue([...effects]));
  return Object.freeze({ state: frozenState, effects: frozenEffects });
}

function noChange(state: ClientState): ClientStateReduction {
  return reduction(state);
}

function validUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function validEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_AUDIO_OFFSET;
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function validSegmentId(value: unknown): value is string {
  return typeof value === "string" && SEGMENT_ID_PATTERN.test(value);
}

function defaultTarget(): TargetLanguage {
  const definition = listLanguageDefinitions()[0];
  if (definition === undefined || !isTargetLanguage(definition.code)) {
    throw new Error("The language registry has no target language");
  }
  return definition.code;
}

function restoredTarget(value: unknown): TargetLanguage {
  return typeof value === "string" && isTargetLanguage(value) ? value : defaultTarget();
}

export function createInitialState(restoredTargetValue?: unknown): ClientState {
  return makeState({
    state: "Starting" as const,
    highlightedTarget: restoredTarget(restoredTargetValue),
  }) as StartingState;
}

function stateTarget(state: ClientState): TargetLanguage | undefined {
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
      return state.targetLanguage;
    case "Error":
      return state.targetLanguage;
  }
}

function stateSession(state: ClientState): SessionIdentity | undefined {
  switch (state.state) {
    case "Ready":
      return state.sessionReady && validUuidV4(state.sessionId) && validEpoch(state.sessionEpoch)
        ? { sessionId: state.sessionId, sessionEpoch: state.sessionEpoch }
        : undefined;
    case "Listening":
    case "Finalizing":
    case "Translating":
    case "Results":
      return validUuidV4(state.sessionId) && validEpoch(state.sessionEpoch)
        ? { sessionId: state.sessionId, sessionEpoch: state.sessionEpoch }
        : undefined;
    case "Recovering":
      return validUuidV4(state.sessionId) && validEpoch(state.sessionEpoch)
        ? { sessionId: state.sessionId, sessionEpoch: state.sessionEpoch }
        : undefined;
    case "Error":
      return validUuidV4(state.sessionId) && validEpoch(state.sessionEpoch)
        ? { sessionId: state.sessionId, sessionEpoch: state.sessionEpoch }
        : undefined;
    case "Starting":
    case "TargetSelection":
      return undefined;
  }
}

function eventSession(event: object): SessionIdentity | undefined {
  const value = event as { readonly sessionId?: unknown; readonly sessionEpoch?: unknown };
  return validUuidV4(value.sessionId) && validEpoch(value.sessionEpoch)
    ? { sessionId: value.sessionId, sessionEpoch: value.sessionEpoch }
    : undefined;
}

function sameSession(state: ClientState, event: object): boolean {
  const stateIdentity = stateSession(state);
  const eventIdentity = eventSession(event);
  return stateIdentity !== undefined && eventIdentity !== undefined &&
    stateIdentity.sessionId === eventIdentity.sessionId &&
    stateIdentity.sessionEpoch === eventIdentity.sessionEpoch;
}

function eventTarget(event: SessionReadyEvent): TargetLanguage | undefined {
  return typeof event.targetLanguage === "string" && isTargetLanguage(event.targetLanguage)
    ? event.targetLanguage
    : undefined;
}

function targetDefinition(target: TargetLanguage) {
  return getLanguageDefinition(target);
}

function readyState(
  targetLanguage: TargetLanguage,
  session: undefined,
  turn: number,
  message?: string,
): PendingReadyState;
function readyState(
  targetLanguage: TargetLanguage,
  session: SessionIdentity,
  turn: number,
  message?: string,
): EstablishedReadyState;
function readyState(
  targetLanguage: TargetLanguage,
  session: SessionIdentity | undefined,
  turn: number,
  message?: string,
): ReadyState {
  return makeState({
    state: "Ready" as const,
    targetLanguage,
    sessionReady: session !== undefined,
    ...(session ?? {}),
    turn,
    transcript: "" as const,
    suggestions: [] as readonly [],
    suggestionIndex: 0 as const,
    ...(message === undefined ? {} : { message }),
  }) as ReadyState;
}

function activeData(state: ActiveResumableState): ActiveTurnData {
  return {
    targetLanguage: state.targetLanguage,
    sessionId: state.sessionId,
    sessionEpoch: state.sessionEpoch,
    utteranceId: state.utteranceId,
    turn: state.turn,
    transcript: state.transcript,
    segmentTexts: { ...state.segmentTexts },
    segmentRevisions: { ...state.segmentRevisions },
    finalSegments: { ...state.finalSegments },
    ...(state.finalTranscript === undefined ? {} : { finalTranscript: state.finalTranscript }),
    ...(state.finalSegmentId === undefined ? {} : { finalSegmentId: state.finalSegmentId }),
    ...(state.finalRevision === undefined ? {} : { finalRevision: state.finalRevision }),
  };
}

function listeningState(data: ActiveTurnData): ListeningState {
  return makeState({ state: "Listening" as const, ...data }) as ListeningState;
}

function finalizingState(data: ActiveTurnData): FinalizingState {
  return makeState({ state: "Finalizing" as const, ...data }) as FinalizingState;
}

function translatingState(data: ActiveTurnData, englishTranslation?: string): TranslatingState {
  return makeState({
    state: "Translating" as const,
    ...data,
    ...(englishTranslation === undefined ? {} : { englishTranslation }),
    suggestions: [] as readonly [],
    suggestionIndex: 0 as const,
  }) as TranslatingState;
}

function resultsState(
  data: ActiveTurnData,
  englishTranslation: string,
  suggestions: readonly Suggestion[],
  suggestionIndex = 0,
): ResultsState {
  return makeState({
    state: "Results" as const,
    ...data,
    englishTranslation,
    suggestions: suggestions.map((suggestion) => ({ ...suggestion })),
    suggestionIndex,
  }) as ResultsState;
}

function errorState(
  message: string,
  terminal: boolean,
  targetLanguage?: TargetLanguage,
  session?: SessionIdentity,
): ErrorState {
  return makeState({
    state: "Error" as const,
    message,
    terminal,
    ...(targetLanguage === undefined ? {} : { targetLanguage }),
    ...(session === undefined ? {} : session),
  }) as ErrorState;
}

function nextTarget(target: TargetLanguage, direction: 1 | -1): TargetLanguage {
  const definitions = listLanguageDefinitions();
  const currentIndex = definitions.findIndex((definition) => definition.code === target);
  if (currentIndex < 0 || definitions.length === 0) return defaultTarget();
  const nextIndex = (currentIndex + direction + definitions.length) % definitions.length;
  const next = definitions[nextIndex];
  if (next === undefined || !isTargetLanguage(next.code)) return target;
  return next.code;
}

function isActiveTurnState(state: ClientState): state is ActiveResumableState {
  return state.state === "Listening" || state.state === "Finalizing" ||
    state.state === "Translating" || state.state === "Results";
}

function startSessionEffects(targetLanguage: TargetLanguage): readonly ClientEffect[] {
  return [
    { type: "persist-target", targetLanguage },
    { type: "start-session", targetLanguage },
  ];
}

function endSessionEffect(session: SessionIdentity): EndSessionEffect {
  return { type: "end-session", ...session };
}

function stopAudioEffect(state: ClientState): AudioEffect | undefined {
  const session = stateSession(state);
  if (state.state !== "Listening" || session === undefined) return undefined;
  return { type: "stop-audio", ...session, utteranceId: state.utteranceId };
}

function cleanupEffects(state: ClientState): ClientEffect[] {
  const effects: ClientEffect[] = [];
  const stopAudio = stopAudioEffect(state);
  if (stopAudio !== undefined) effects.push(stopAudio);
  const session = stateSession(state);
  if (session !== undefined) effects.push(endSessionEffect(session));
  return effects;
}

function sessionReadyMismatch(state: ReadyState, event: SessionReadyEvent): ClientStateReduction {
  const session = stateSession(state) ?? eventSession(event);
  return reduction(
    errorState(SAFE_MESSAGES.sessionMismatch, true, stateTarget(state)),
    session === undefined ? NO_EFFECTS : [endSessionEffect(session)],
  );
}

function transcriptOverflow(state: ActiveResumableState): ClientStateReduction {
  return reduction(
    errorState(SAFE_MESSAGES.transcriptOverflow, true, state.targetLanguage),
    cleanupEffects(state),
  );
}

function segmentUpdate(
  state: ListeningState | FinalizingState,
  event: TranscriptPartialEvent | TranscriptFinalEvent,
): ClientStateReduction {
  if (!sameSession(state, event) || !validUuidV4(event.utteranceId) ||
    event.utteranceId !== state.utteranceId || !validSegmentId(event.segmentId) ||
    !validRevision(event.revision)) {
    return noChange(state);
  }

  const previousRevision = state.segmentRevisions[event.segmentId] ?? 0;
  if (event.revision <= previousRevision) return noChange(state);
  if (event.type === "transcript.partial" && state.finalSegments[event.segmentId] === true) {
    return noChange(state);
  }

  if (typeof event.text !== "string") return noChange(state);
  if (event.text.length > MAX_TRANSCRIPT_LENGTH) return transcriptOverflow(state);
  if (!validText(event.text, MAX_TRANSCRIPT_LENGTH)) return noChange(state);

  const isNewSegment = !Object.prototype.hasOwnProperty.call(state.segmentTexts, event.segmentId);
  if (isNewSegment && Object.keys(state.segmentTexts).length >= MAX_TRANSCRIPT_SEGMENTS) {
    return transcriptOverflow(state);
  }

  const segmentTexts = { ...state.segmentTexts, [event.segmentId]: event.text };
  const segmentRevisions = { ...state.segmentRevisions, [event.segmentId]: event.revision };
  const finalSegments = event.type === "transcript.final"
    ? { ...state.finalSegments, [event.segmentId]: true }
    : { ...state.finalSegments };
  const transcript = Object.values(segmentTexts).join(" ");
  if (transcript.length > MAX_TRANSCRIPT_LENGTH) return transcriptOverflow(state);

  const data: ActiveTurnData = {
    targetLanguage: state.targetLanguage,
    sessionId: state.sessionId,
    sessionEpoch: state.sessionEpoch,
    utteranceId: state.utteranceId,
    turn: state.turn,
    transcript,
    segmentTexts,
    segmentRevisions,
    finalSegments,
    ...(event.type === "transcript.final"
      ? { finalTranscript: transcript, finalSegmentId: event.segmentId, finalRevision: event.revision }
      : state.finalTranscript === undefined
        ? {}
        : {
            finalTranscript: state.finalTranscript,
            finalSegmentId: state.finalSegmentId,
            finalRevision: state.finalRevision,
          }),
  };

  return reduction(state.state === "Finalizing" ? finalizingState(data) : listeningState(data));
}

function decisionMessage(decision: LanguageDecisionValue, target: TargetLanguage): string {
  const definition = targetDefinition(target);
  const displayName = definition?.displayName ?? "the selected language";
  switch (decision) {
    case "english":
      return "English detected; speak in the selected target language.";
    case "mixed":
      return "Mixed-language speech was not accepted.";
    case "supported_unselected":
      return "A different supported language was detected.";
    case "unsupported":
      return "The detected language is not supported.";
    case "uncertain":
      return `The language was unclear; speak in ${displayName}.`;
    case "target":
      return "";
  }
}

function isLanguageDecisionValue(value: unknown): value is LanguageDecisionValue {
  return value === "target" || value === "mixed" || value === "english" ||
    value === "supported_unselected" || value === "unsupported" || value === "uncertain";
}

function languageDecision(state: FinalizingState, event: LanguageDecisionEvent): ClientStateReduction {
  if (!sameSession(state, event) || !validUuidV4(event.utteranceId) ||
    event.utteranceId !== state.utteranceId || !validSegmentId(event.segmentId) ||
    !validRevision(event.revision) || event.segmentId !== state.finalSegmentId ||
    event.revision !== state.finalRevision || state.finalTranscript === undefined ||
    !isTargetLanguage(event.selectedTargetLanguage) ||
    event.selectedTargetLanguage !== state.targetLanguage ||
    !isLanguageDecisionValue(event.decision)) {
    return noChange(state);
  }

  if (event.decision !== "target") {
    return reduction(readyState(
      state.targetLanguage,
      { sessionId: state.sessionId, sessionEpoch: state.sessionEpoch },
      state.turn,
      decisionMessage(event.decision, state.targetLanguage),
    ));
  }

  return reduction(translatingState(activeData(state)), [{
    type: "request-translation",
    sessionId: state.sessionId,
    sessionEpoch: state.sessionEpoch,
    utteranceId: state.utteranceId,
    segmentId: state.finalSegmentId!,
    acceptedFinalRevision: state.finalRevision!,
  }]);
}

function acceptedResultMatches(
  state: TranslatingState | ResultsState,
  event: TranslationReadyEvent | SuggestionsReadyEvent,
): boolean {
  return sameSession(state, event) && validUuidV4(event.utteranceId) &&
    event.utteranceId === state.utteranceId && validSegmentId(event.segmentId) &&
    event.segmentId === state.finalSegmentId && validRevision(event.acceptedFinalRevision) &&
    event.acceptedFinalRevision === state.finalRevision;
}

function normalizeSuggestion(value: unknown): Suggestion | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "englishText" && key !== "selectedTargetText") ||
    keys.length !== 2) return undefined;
  if (!validText(record.englishText, MAX_RESULT_TEXT_LENGTH) ||
    !validText(record.selectedTargetText, MAX_RESULT_TEXT_LENGTH)) return undefined;
  return {
    englishText: record.englishText,
    selectedTargetText: record.selectedTargetText,
  };
}

function malformedResults(state: TranslatingState | ResultsState): ClientStateReduction {
  return reduction(
    errorState(SAFE_MESSAGES.malformedResults, true, state.targetLanguage),
    cleanupEffects(state),
  );
}

function translationReady(
  state: TranslatingState | ResultsState,
  event: TranslationReadyEvent,
): ClientStateReduction {
  if (!acceptedResultMatches(state, event)) return noChange(state);
  if (state.state === "Results" || state.englishTranslation !== undefined) return noChange(state);
  if (!validText(event.englishTranslation, MAX_RESULT_TEXT_LENGTH)) return malformedResults(state);

  return reduction(
    translatingState(activeData(state), event.englishTranslation),
    [{
      type: "request-suggestions",
      sessionId: state.sessionId,
      sessionEpoch: state.sessionEpoch,
      utteranceId: state.utteranceId,
      segmentId: state.finalSegmentId!,
      acceptedFinalRevision: state.finalRevision!,
    }],
  );
}

function suggestionsReady(
  state: TranslatingState | ResultsState,
  event: SuggestionsReadyEvent,
): ClientStateReduction {
  if (!acceptedResultMatches(state, event)) return noChange(state);
  if (state.state === "Results" || state.englishTranslation === undefined) return noChange(state);
  if (!Array.isArray(event.suggestions) || event.suggestions.length < 2 || event.suggestions.length > 3) {
    return malformedResults(state);
  }
  const normalizedSuggestions = event.suggestions.map(normalizeSuggestion);
  if (normalizedSuggestions.some((suggestion) => suggestion === undefined)) {
    return malformedResults(state);
  }
  return reduction(resultsState(
    activeData(state),
    state.englishTranslation,
    normalizedSuggestions as Suggestion[],
  ));
}

function replaySnapshotFromEvent(
  state: ActiveResumableState,
  event: ActiveTransportLostEvent,
): ReplaySnapshot | undefined {
  if (!validUuidV4(event.utteranceId) || event.utteranceId !== state.utteranceId ||
    !validOffset(event.clientLastAcknowledgedOffset) ||
    !validOffset(event.oldestRetainedOffset) || !validOffset(event.nextCapturedOffset) ||
    event.oldestRetainedOffset > event.clientLastAcknowledgedOffset ||
    event.clientLastAcknowledgedOffset > event.nextCapturedOffset ||
    event.nextCapturedOffset - event.oldestRetainedOffset > MAX_RETAINED_REPLAY_SAMPLES) {
    return undefined;
  }
  return {
    utteranceId: event.utteranceId,
    clientLastAcknowledgedOffset: event.clientLastAcknowledgedOffset,
    oldestRetainedOffset: event.oldestRetainedOffset,
    nextCapturedOffset: event.nextCapturedOffset,
  };
}

function recoveringState(state: ActiveResumableState, replay: ReplaySnapshot): RecoveringState {
  const session = stateSession(state);
  if (session === undefined) throw new Error("Recovering requires a session");
  return makeState({
    state: "Recovering" as const,
    targetLanguage: state.targetLanguage,
    ...session,
    priorState: cloneValue(state),
    replay: { ...replay },
    message: SAFE_MESSAGES.transportLost,
  }) as RecoveringState;
}

function resumeEffect(state: RecoveringState): ResumeSessionEffect {
  return {
    type: "resume-session",
    sessionId: state.sessionId,
    sessionEpoch: state.sessionEpoch,
    ...state.replay,
  };
}

function clearAfterAbort(
  state: RecoveringState | ActiveResumableState,
  effects: readonly ClientEffect[] = NO_EFFECTS,
): ClientStateReduction {
  const prior = state.state === "Recovering" ? state.priorState : state;
  const session = stateSession(prior);
  if (session === undefined) return noChange(state);
  return reduction(readyState(
    prior.targetLanguage,
    session,
    prior.turn,
    SAFE_MESSAGES.utteranceAborted,
  ), effects);
}

function fatalReduction(state: ClientState): ClientStateReduction {
  if (state.state === "Error" && state.terminal) return noChange(state);
  return reduction(
    errorState(SAFE_MESSAGES.fatal, true, stateTarget(state)),
    cleanupEffects(state),
  );
}

function shutdownReduction(state: ClientState): ClientStateReduction {
  if (state.state === "Error" && state.terminal) return noChange(state);
  return reduction(
    errorState(SAFE_MESSAGES.shutdown, true, stateTarget(state)),
    cleanupEffects(state),
  );
}

function swipeResult(state: ResultsState, direction: 1 | -1): ClientStateReduction {
  const count = state.suggestions.length;
  if (count === 0) return noChange(state);
  const index = (state.suggestionIndex + direction + count) % count;
  return reduction(resultsState(activeData(state), state.englishTranslation, state.suggestions, index));
}

function pressReduction(state: ClientState, event: PressEvent): ClientStateReduction {
  if (state.state === "TargetSelection") {
    return reduction(
      readyState(state.highlightedTarget, undefined, 0),
      startSessionEffects(state.highlightedTarget),
    );
  }

  if (state.state === "Ready" && state.sessionReady) {
    const session = stateSession(state);
    if (session === undefined || !validUuidV4(event.utteranceId)) return noChange(state);
    const data: ActiveTurnData = {
      ...session,
      targetLanguage: state.targetLanguage,
      utteranceId: event.utteranceId,
      turn: state.turn + 1,
      transcript: "",
      segmentTexts: {},
      segmentRevisions: {},
      finalSegments: {},
    };
    return reduction(listeningState(data), [
      { type: "start-audio", ...session, utteranceId: event.utteranceId },
      { type: "start-utterance", ...session, utteranceId: event.utteranceId },
    ]);
  }

  if (state.state === "Listening") {
    return reduction(finalizingState(activeData(state)), [
      {
        type: "stop-audio",
        sessionId: state.sessionId,
        sessionEpoch: state.sessionEpoch,
        utteranceId: state.utteranceId,
      },
      {
        type: "commit-utterance",
        sessionId: state.sessionId,
        sessionEpoch: state.sessionEpoch,
        utteranceId: state.utteranceId,
      },
    ]);
  }

  if (state.state === "Results") {
    return reduction(readyState(
      state.targetLanguage,
      { sessionId: state.sessionId, sessionEpoch: state.sessionEpoch },
      state.turn,
    ));
  }

  return noChange(state);
}

function handleTransportLost(
  state: ClientState,
  event: TransportLostEvent,
): ClientStateReduction {
  if (!sameSession(state, event)) return noChange(state);

  if (state.state === "Ready" && state.sessionReady) {
    return reduction(
      readyState(state.targetLanguage, undefined, state.turn, SAFE_MESSAGES.transportLost),
      startSessionEffects(state.targetLanguage),
    );
  }

  if (!isActiveTurnState(state)) return noChange(state);

  const replay = replaySnapshotFromEvent(state, event as ActiveTransportLostEvent);
  if (replay === undefined) {
    return reduction(
      readyState(
        state.targetLanguage,
        { sessionId: state.sessionId, sessionEpoch: state.sessionEpoch },
        state.turn,
        SAFE_MESSAGES.replayInvalid,
      ),
      stopAudioEffect(state) === undefined ? NO_EFFECTS : [stopAudioEffect(state)!],
    );
  }

  const recovering = recoveringState(state, replay);
  const effects: ClientEffect[] = [];
  const stopAudio = stopAudioEffect(state);
  if (stopAudio !== undefined) effects.push(stopAudio);
  effects.push(resumeEffect(recovering));
  return reduction(recovering, effects);
}

export function reduceClientState(inputState: ClientState, inputEvent: ClientEvent): ClientStateReduction {
  const state = normalizeInput(inputState);
  const event = normalizeInput(inputEvent);

  switch (event.type) {
    case "startup.ready":
      return state.state === "Starting"
        ? reduction(makeState({ state: "TargetSelection" as const, highlightedTarget: state.highlightedTarget }) as TargetSelectionState)
        : noChange(state);

    case "startup.failed":
      return state.state === "Starting"
        ? reduction(errorState(SAFE_MESSAGES.startup, true, state.highlightedTarget))
        : noChange(state);

    case "swipe.next":
      if (state.state === "TargetSelection") {
        return reduction(makeState({ state: "TargetSelection" as const, highlightedTarget: nextTarget(state.highlightedTarget, 1) }) as TargetSelectionState);
      }
      return state.state === "Results" ? swipeResult(state, 1) : noChange(state);

    case "swipe.previous":
      if (state.state === "TargetSelection") {
        return reduction(makeState({ state: "TargetSelection" as const, highlightedTarget: nextTarget(state.highlightedTarget, -1) }) as TargetSelectionState);
      }
      return state.state === "Results" ? swipeResult(state, -1) : noChange(state);

    case "press":
      return pressReduction(state, event);

    case "session.ready": {
      if (state.state !== "Ready") return noChange(state);
      const target = eventTarget(event);
      const session = eventSession(event);
      if (target === undefined || session === undefined ||
        (event.result !== "new" && event.result !== "resumed")) return noChange(state);
      const confirmedTarget = stateTarget(state);
      if (confirmedTarget === undefined || target !== confirmedTarget) {
        return sessionReadyMismatch(state, event);
      }
      if (state.sessionReady) {
        return sameSession(state, event) ? noChange(state) : sessionReadyMismatch(state, event);
      }
      return reduction(readyState(target, session, state.turn, state.message));
    }

    case "transcript.partial":
      return state.state === "Listening" || state.state === "Finalizing"
        ? segmentUpdate(state, event)
        : noChange(state);

    case "transcript.final":
      return state.state === "Finalizing" ? segmentUpdate(state, event) : noChange(state);

    case "language.decision":
      return state.state === "Finalizing" ? languageDecision(state, event) : noChange(state);

    case "translation.ready":
      return state.state === "Translating" || state.state === "Results"
        ? translationReady(state, event)
        : noChange(state);

    case "suggestions.ready":
      return state.state === "Translating" || state.state === "Results"
        ? suggestionsReady(state, event)
        : noChange(state);

    case "transport.lost":
      return handleTransportLost(state, event);

    case "transport.resumed":
      if (state.state !== "Recovering" || !sameSession(state, event)) return noChange(state);
      if (event.resumable === false) {
        return reduction(readyState(
          state.targetLanguage,
          { sessionId: state.sessionId, sessionEpoch: state.sessionEpoch },
          state.priorState.turn,
          SAFE_MESSAGES.nonResumable,
        ));
      }
      return reduction(
        state.priorState,
        state.priorState.state === "Listening"
          ? [{
              type: "start-audio",
              sessionId: state.sessionId,
              sessionEpoch: state.sessionEpoch,
              utteranceId: state.priorState.utteranceId,
            }]
          : NO_EFFECTS,
      );

    case "transport.non-resumable":
      if (state.state !== "Recovering" || !sameSession(state, event)) return noChange(state);
      return reduction(readyState(
        state.targetLanguage,
        { sessionId: state.sessionId, sessionEpoch: state.sessionEpoch },
        state.priorState.turn,
        SAFE_MESSAGES.nonResumable,
      ));

    case "utterance.aborted":
      if (state.state === "Recovering") {
        if (!sameSession(state, event) || !validUuidV4(event.utteranceId) ||
          event.utteranceId !== state.priorState.utteranceId) return noChange(state);
        return clearAfterAbort(state);
      }
      if (!isActiveTurnState(state) || !sameSession(state, event) ||
        !validUuidV4(event.utteranceId) || event.utteranceId !== state.utteranceId) {
        return noChange(state);
      }
      return clearAfterAbort(
        state,
        state.state === "Listening"
          ? [{
              type: "stop-audio",
              sessionId: state.sessionId,
              sessionEpoch: state.sessionEpoch,
              utteranceId: state.utteranceId,
            }]
          : NO_EFFECTS,
      );

    case "fatal":
      return fatalReduction(state);

    case "shutdown":
      return shutdownReduction(state);
  }
}
