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
export const MAX_UINT32 = 4_294_967_295;

type StateName =
  | "Starting"
  | "EnrollmentChecking"
  | "EnrollmentRequired"
  | "Enrolling"
  | "StorageError"
  | "TargetSelection"
  | "Ready"
  | "Listening"
  | "Finalizing"
  | "Translating"
  | "Results"
  | "Error";

export type EnrollmentReason =
  | "missing"
  | "absolute-expired"
  | "credential-rejected"
  | "pairing-failed"
  | "pairing-uncertain"
  | "revoked"
  | "revocation-unconfirmed";

export type PairingFailureReason = "pairing-failed" | "pairing-uncertain";

export interface EnrollmentCheckingState {
  readonly state: "EnrollmentChecking";
  readonly type: "EnrollmentChecking";
  readonly highlightedTarget: TargetLanguage;
  readonly authAttempt: number;
  readonly phase: "checking" | "revoking";
}

export interface EnrollmentRequiredState {
  readonly state: "EnrollmentRequired";
  readonly type: "EnrollmentRequired";
  readonly highlightedTarget: TargetLanguage;
  readonly authAttempt: number;
  readonly reason: EnrollmentReason;
}

export interface EnrollingState {
  readonly state: "Enrolling";
  readonly type: "Enrolling";
  readonly highlightedTarget: TargetLanguage;
  readonly authAttempt: number;
}

export interface StorageErrorState {
  readonly state: "StorageError";
  readonly type: "StorageError";
  readonly highlightedTarget: TargetLanguage;
  readonly authAttempt: number;
}

export interface StartingState {
  readonly state: "Starting";
  readonly type: "Starting";
  readonly highlightedTarget: TargetLanguage;
  readonly authAttempt: number;
}

export interface TargetSelectionState {
  readonly state: "TargetSelection";
  readonly type: "TargetSelection";
  readonly highlightedTarget: TargetLanguage;
  readonly authAttempt: number;
}

interface ReadyStateBase {
  readonly state: "Ready";
  readonly type: "Ready";
  readonly targetLanguage: TargetLanguage;
  readonly authAttempt: number;
  readonly turn: number;
  readonly message?: string;
}

export interface InitialReadyState extends ReadyStateBase {
  readonly sessionReady: false;
  readonly pending: "initial";
}

export interface RecoveryReadyState extends ReadyStateBase {
  readonly sessionReady: false;
  readonly pending: "recovery";
  readonly previousSessionId: string;
  readonly previousSessionEpoch: number;
  readonly message: string;
}

export interface AuthenticationReadyState extends ReadyStateBase {
  readonly sessionReady: false;
  readonly pending: "authentication";
}

export interface EstablishedReadyState extends ReadyStateBase {
  readonly sessionReady: true;
  readonly pending: false;
  readonly sessionId: string;
  readonly sessionEpoch: number;
}

export type PendingReadyState =
  | InitialReadyState
  | RecoveryReadyState
  | AuthenticationReadyState;
export type ReadyState = PendingReadyState | EstablishedReadyState;

interface ActiveTurnState {
  readonly targetLanguage: TargetLanguage;
  readonly authAttempt: number;
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

export type ActiveTurnClientState =
  | ListeningState
  | FinalizingState
  | TranslatingState
  | ResultsState;

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
  | EnrollmentCheckingState
  | EnrollmentRequiredState
  | EnrollingState
  | StorageErrorState
  | TargetSelectionState
  | ReadyState
  | ListeningState
  | FinalizingState
  | TranslatingState
  | ResultsState
  | ErrorState;

export interface StartupReadyEvent {
  readonly type: "startup.ready";
}

export interface StartupFailedEvent {
  readonly type: "startup.failed";
}

export interface EnrollmentReadyEvent {
  readonly type: "enrollment.ready";
}

export interface EnrollmentRequiredEvent {
  readonly type: "enrollment.required";
  readonly reason: EnrollmentReason;
}

export interface EnrollmentStartedEvent {
  readonly type: "enrollment.started";
}

export interface EnrollmentFailedEvent {
  readonly type: "enrollment.failed";
  readonly reason: PairingFailureReason;
}

export interface EnrollmentStorageErrorEvent {
  readonly type: "enrollment.storage-error";
}

export interface EnrollmentRetryEvent {
  readonly type: "enrollment.retry";
}

export interface EnrollmentResetEvent {
  readonly type: "enrollment.reset";
}

export interface SessionAuthenticatedEvent {
  readonly type: "session.authenticated";
  readonly authAttempt: number;
}

export interface SessionAuthRequiredEvent {
  readonly type: "session.auth-required";
  readonly authAttempt: number;
  readonly reason: EnrollmentReason;
}

export interface SessionAuthStorageErrorEvent {
  readonly type: "session.auth-storage-error";
  readonly authAttempt: number;
}

export interface SessionAuthUnavailableEvent {
  readonly type: "session.auth-unavailable";
  readonly authAttempt: number;
}

export interface CredentialRejectedEvent {
  readonly type: "credential.rejected";
}

export interface CredentialStorageErrorEvent {
  readonly type: "credential.storage-error";
}

export interface RevocationStartedEvent {
  readonly type: "revocation.started";
}

export interface RevocationCompletedEvent {
  readonly type: "revocation.completed";
  readonly reason: "revoked" | "revocation-unconfirmed";
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
  readonly result: "new";
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

export interface TransportLostEvent {
  readonly type: "transport.lost";
  readonly sessionId: string;
  readonly sessionEpoch: number;
}

export interface RecoveryFailedEvent {
  readonly type: "recovery.failed";
  readonly sessionId: string;
  readonly sessionEpoch: number;
}

export type UtteranceAbortCategory =
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
  | EnrollmentReadyEvent
  | EnrollmentRequiredEvent
  | EnrollmentStartedEvent
  | EnrollmentFailedEvent
  | EnrollmentStorageErrorEvent
  | EnrollmentRetryEvent
  | EnrollmentResetEvent
  | SessionAuthenticatedEvent
  | SessionAuthRequiredEvent
  | SessionAuthStorageErrorEvent
  | SessionAuthUnavailableEvent
  | CredentialRejectedEvent
  | CredentialStorageErrorEvent
  | RevocationStartedEvent
  | RevocationCompletedEvent
  | SwipeNextEvent
  | SwipePreviousEvent
  | PressEvent
  | TransportLostEvent
  | RecoveryFailedEvent
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

export interface CheckEnrollmentEffect {
  readonly type: "check-enrollment";
}

export interface ResetEnrollmentEffect {
  readonly type: "reset-enrollment";
}

export interface PrepareSessionAuthEffect {
  readonly type: "prepare-session-auth";
  readonly targetLanguage: TargetLanguage;
  readonly authAttempt: number;
}

export interface CancelSessionBoundaryEffect {
  readonly type: "cancel-session-boundary";
}

export interface StartSessionEffect {
  readonly type: "start-session";
  readonly targetLanguage: TargetLanguage;
}

export interface StartFreshSessionEffect {
  readonly type: "start-fresh-session";
  readonly targetLanguage: TargetLanguage;
  readonly previousSessionId: string;
  readonly previousSessionEpoch: number;
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
  | CheckEnrollmentEffect
  | ResetEnrollmentEffect
  | PrepareSessionAuthEffect
  | CancelSessionBoundaryEffect
  | PersistTargetEffect
  | StartSessionEffect
  | StartFreshSessionEffect
  | AudioEffect
  | UtteranceEffect
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
  readonly authAttempt: number;
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
  transportLost: "Connection lost; starting a fresh session.",
  recoveryFailed: "Fresh-session recovery failed.",
  recoveryInvalid: "Fresh-session recovery returned an invalid session.",
  utteranceAborted: "The utterance was aborted; ready for a new turn.",
  malformedResults: "Response results were invalid; ready for a new turn.",
  transcriptOverflow: "The transcript exceeded the safe display limit; ready for a new turn.",
  sessionMismatch: "The session target did not match the confirmed target.",
  authUnavailable: "Session authentication unavailable; press to retry.",
} as const);
const KNOWN_CLIENT_EVENT_TYPES = Object.freeze({
  "startup.ready": true,
  "startup.failed": true,
  "enrollment.ready": true,
  "enrollment.required": true,
  "enrollment.started": true,
  "enrollment.failed": true,
  "enrollment.storage-error": true,
  "enrollment.retry": true,
  "enrollment.reset": true,
  "session.authenticated": true,
  "session.auth-required": true,
  "session.auth-storage-error": true,
  "session.auth-unavailable": true,
  "credential.rejected": true,
  "credential.storage-error": true,
  "revocation.started": true,
  "revocation.completed": true,
  "swipe.next": true,
  "swipe.previous": true,
  press: true,
  "transport.lost": true,
  "recovery.failed": true,
  fatal: true,
  shutdown: true,
  "session.ready": true,
  "transcript.partial": true,
  "transcript.final": true,
  "language.decision": true,
  "translation.ready": true,
  "suggestions.ready": true,
  "utterance.aborted": true,
} satisfies Record<ClientEvent["type"], true>);

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

function isKnownClientEvent(value: unknown): value is ClientEvent {
  if (value === null || typeof value !== "object") return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Array.isArray(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    const stringKeys = keys.filter((key): key is string => typeof key === "string");
    if (stringKeys.length !== keys.length) return false;
    for (const key of stringKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        return false;
      }
    }
    const typeDescriptor = descriptors.type;
    if (typeDescriptor === undefined || !Object.prototype.hasOwnProperty.call(typeDescriptor, "value")) {
      return false;
    }
    const type = typeDescriptor.value;
    if (typeof type !== "string" ||
      !Object.prototype.hasOwnProperty.call(KNOWN_CLIENT_EVENT_TYPES, type)) return false;

    const hasExactKeys = (...allowed: readonly string[][]): boolean => allowed.some((expected) =>
      expected.length === stringKeys.length && expected.every((key) => stringKeys.includes(key)));
    const hasOnlyKeys = (allowed: readonly string[]): boolean =>
      stringKeys.every((key) => allowed.includes(key));
    const record = value as Record<string, unknown>;
    switch (type) {
      case "startup.ready":
      case "startup.failed":
      case "enrollment.ready":
      case "enrollment.started":
      case "enrollment.storage-error":
      case "enrollment.retry":
      case "enrollment.reset":
      case "credential.rejected":
      case "credential.storage-error":
      case "revocation.started":
      case "swipe.next":
      case "swipe.previous":
      case "fatal":
      case "shutdown":
        return hasExactKeys(["type"]);
      case "session.authenticated":
      case "session.auth-storage-error":
      case "session.auth-unavailable":
        return hasExactKeys(["type", "authAttempt"]) &&
          validAuthAttempt(record.authAttempt);
      case "session.auth-required":
        return hasExactKeys(["type", "authAttempt", "reason"]) &&
          validAuthAttempt(record.authAttempt) && isEnrollmentReason(record.reason);
      case "enrollment.required":
        return hasExactKeys(["type", "reason"]) && isEnrollmentReason(record.reason);
      case "enrollment.failed":
        return hasExactKeys(["type", "reason"]) && isPairingFailureReason(record.reason);
      case "revocation.completed":
        return hasExactKeys(["type", "reason"]) && isRevocationReason(record.reason);
      case "press":
        return hasExactKeys(["type"], ["type", "utteranceId"]) &&
          (!Object.prototype.hasOwnProperty.call(record, "utteranceId") ||
            typeof record.utteranceId === "string");
      case "session.ready":
        return hasOnlyKeys(["type", "sessionId", "sessionEpoch", "targetLanguage", "result"]);
      case "transcript.partial":
      case "transcript.final":
        return hasOnlyKeys([
          "type",
          "sessionId",
          "sessionEpoch",
          "utteranceId",
          "segmentId",
          "revision",
          "text",
        ]);
      case "language.decision":
        return hasOnlyKeys([
          "type",
          "sessionId",
          "sessionEpoch",
          "utteranceId",
          "segmentId",
          "revision",
          "decision",
          "selectedTargetLanguage",
        ]);
      case "translation.ready":
        return hasOnlyKeys([
          "type",
          "sessionId",
          "sessionEpoch",
          "utteranceId",
          "segmentId",
          "acceptedFinalRevision",
          "englishTranslation",
        ]);
      case "suggestions.ready":
        return hasOnlyKeys([
          "type",
          "sessionId",
          "sessionEpoch",
          "utteranceId",
          "segmentId",
          "acceptedFinalRevision",
          "suggestions",
        ]);
      case "transport.lost":
      case "recovery.failed":
        return hasOnlyKeys(["type", "sessionId", "sessionEpoch"]);
      case "utterance.aborted":
        return hasOnlyKeys(["type", "sessionId", "sessionEpoch", "utteranceId", "category"]);
    }
    return false;
  } catch {
    return false;
  }
}

function assertNeverClientEvent(event: never): never {
  void event;
  throw new Error("Unhandled client event");
}

function validUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function validPositiveUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 &&
    value <= MAX_UINT32;
}

function validAuthGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= 0 && value <= MAX_UINT32;
}

function validAuthAttempt(value: unknown): value is number {
  return validAuthGeneration(value) && value > 0;
}

function nextAuthAttempt(value: number): number | undefined {
  return validAuthGeneration(value) && value < MAX_UINT32 ? value + 1 : undefined;
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function validSegmentId(value: unknown): value is string {
  return typeof value === "string" && SEGMENT_ID_PATTERN.test(value);
}

function isEnrollmentReason(value: unknown): value is EnrollmentReason {
  return value === "missing" || value === "absolute-expired" ||
    value === "credential-rejected" || value === "pairing-failed" ||
    value === "pairing-uncertain" || value === "revoked" ||
    value === "revocation-unconfirmed";
}

function isPairingFailureReason(value: unknown): value is PairingFailureReason {
  return value === "pairing-failed" || value === "pairing-uncertain";
}

function isRevocationReason(
  value: unknown,
): value is "revoked" | "revocation-unconfirmed" {
  return value === "revoked" || value === "revocation-unconfirmed";
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
    authAttempt: 0,
  }) as StartingState;
}

function stateTarget(state: ClientState): TargetLanguage | undefined {
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
      return state.targetLanguage;
    case "Error":
      return state.targetLanguage;
  }
}

function stateSession(state: ClientState): SessionIdentity | undefined {
  switch (state.state) {
    case "Ready":
      if (state.sessionReady && validUuidV4(state.sessionId) &&
        validPositiveUint32(state.sessionEpoch)) {
        return { sessionId: state.sessionId, sessionEpoch: state.sessionEpoch };
      }
      return state.pending === "recovery" && validUuidV4(state.previousSessionId) &&
        validPositiveUint32(state.previousSessionEpoch)
        ? { sessionId: state.previousSessionId, sessionEpoch: state.previousSessionEpoch }
        : undefined;
    case "Listening":
    case "Finalizing":
    case "Translating":
    case "Results":
      return validUuidV4(state.sessionId) && validPositiveUint32(state.sessionEpoch)
        ? { sessionId: state.sessionId, sessionEpoch: state.sessionEpoch }
        : undefined;
    case "Error":
      return validUuidV4(state.sessionId) && validPositiveUint32(state.sessionEpoch)
        ? { sessionId: state.sessionId, sessionEpoch: state.sessionEpoch }
        : undefined;
    case "Starting":
    case "EnrollmentChecking":
    case "EnrollmentRequired":
    case "Enrolling":
    case "StorageError":
    case "TargetSelection":
      return undefined;
  }
}

function eventSession(event: object): SessionIdentity | undefined {
  const value = event as { readonly sessionId?: unknown; readonly sessionEpoch?: unknown };
  return validUuidV4(value.sessionId) && validPositiveUint32(value.sessionEpoch)
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
  authAttempt: number,
  message?: string,
): PendingReadyState;
function readyState(
  targetLanguage: TargetLanguage,
  session: SessionIdentity,
  turn: number,
  authAttempt: number,
  message?: string,
): EstablishedReadyState;
function readyState(
  targetLanguage: TargetLanguage,
  session: SessionIdentity | undefined,
  turn: number,
  authAttempt: number,
  message?: string,
): ReadyState {
  if (session === undefined) {
    return makeState({
      state: "Ready" as const,
      targetLanguage,
      sessionReady: false as const,
      pending: "initial" as const,
      turn,
      authAttempt,
      ...(message === undefined ? {} : { message }),
    }) as InitialReadyState;
  }
  return makeState({
    state: "Ready" as const,
    targetLanguage,
    sessionReady: true as const,
    pending: false as const,
    ...session,
    turn,
    authAttempt,
    ...(message === undefined ? {} : { message }),
  }) as ReadyState;
}

function authenticationReadyState(
  targetLanguage: TargetLanguage,
  authAttempt: number,
  message?: string,
): AuthenticationReadyState {
  return makeState({
    state: "Ready" as const,
    targetLanguage,
    sessionReady: false as const,
    pending: "authentication" as const,
    authAttempt,
    turn: 0,
    ...(message === undefined ? {} : { message }),
  }) as AuthenticationReadyState;
}

function enrollmentCheckingState(
  highlightedTarget: TargetLanguage,
  phase: "checking" | "revoking",
  authAttempt: number,
): EnrollmentCheckingState {
  return makeState({
    state: "EnrollmentChecking" as const,
    highlightedTarget,
    authAttempt,
    phase,
  });
}

function enrollmentRequiredState(
  highlightedTarget: TargetLanguage,
  reason: EnrollmentReason,
  authAttempt: number,
): EnrollmentRequiredState {
  return makeState({
    state: "EnrollmentRequired" as const,
    highlightedTarget,
    authAttempt,
    reason,
  });
}

function enrollingState(highlightedTarget: TargetLanguage, authAttempt: number): EnrollingState {
  return makeState({
    state: "Enrolling" as const,
    highlightedTarget,
    authAttempt,
  });
}

function storageErrorState(highlightedTarget: TargetLanguage, authAttempt: number): StorageErrorState {
  return makeState({
    state: "StorageError" as const,
    highlightedTarget,
    authAttempt,
  });
}

function recoveryReadyState(
  targetLanguage: TargetLanguage,
  previousSession: SessionIdentity,
  turn: number,
  authAttempt: number,
): RecoveryReadyState {
  return makeState({
    state: "Ready" as const,
    targetLanguage,
    sessionReady: false as const,
    pending: "recovery" as const,
    previousSessionId: previousSession.sessionId,
    previousSessionEpoch: previousSession.sessionEpoch,
    turn,
    authAttempt,
    message: SAFE_MESSAGES.transportLost,
  }) as RecoveryReadyState;
}

function activeData(state: ActiveTurnClientState): ActiveTurnData {
  return {
    targetLanguage: state.targetLanguage,
    authAttempt: state.authAttempt,
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

function isActiveTurnState(state: ClientState): state is ActiveTurnClientState {
  return state.state === "Listening" || state.state === "Finalizing" ||
    state.state === "Translating" || state.state === "Results";
}

function prepareSessionAuthEffect(
  targetLanguage: TargetLanguage,
  authAttempt: number,
): PrepareSessionAuthEffect {
  return { type: "prepare-session-auth", targetLanguage, authAttempt };
}

function startSessionEffects(
  targetLanguage: TargetLanguage,
  authAttempt: number,
): readonly ClientEffect[] {
  return [
    { type: "persist-target", targetLanguage },
    prepareSessionAuthEffect(targetLanguage, authAttempt),
  ];
}

function cancelSessionBoundaryEffect(): CancelSessionBoundaryEffect {
  return { type: "cancel-session-boundary" };
}

function startFreshSessionEffect(
  targetLanguage: TargetLanguage,
  previousSession: SessionIdentity,
): StartFreshSessionEffect {
  return {
    type: "start-fresh-session",
    targetLanguage,
    previousSessionId: previousSession.sessionId,
    previousSessionEpoch: previousSession.sessionEpoch,
  };
}

function endSessionEffect(session: SessionIdentity): EndSessionEffect {
  return { type: "end-session", ...session };
}

function stopAudioEffect(state: ClientState): AudioEffect | undefined {
  const session = stateSession(state);
  if (state.state !== "Listening" || session === undefined) return undefined;
  return { type: "stop-audio", ...session, utteranceId: state.utteranceId };
}

function stopAudioForActiveTurn(state: ActiveTurnClientState): AudioEffect | undefined {
  const session = stateSession(state);
  return session === undefined
    ? undefined
    : { type: "stop-audio", ...session, utteranceId: state.utteranceId };
}

function cleanupEffects(state: ClientState): ClientEffect[] {
  const effects: ClientEffect[] = [];
  const stopAudio = stopAudioEffect(state);
  if (stopAudio !== undefined) effects.push(stopAudio);
  const session = stateSession(state);
  if (session !== undefined) effects.push(endSessionEffect(session));
  return effects;
}

function boundaryCleanupEffects(state: ClientState): ClientEffect[] {
  return [cancelSessionBoundaryEffect(), ...cleanupEffects(state)];
}

function isAuthenticatedSessionState(state: ClientState): boolean {
  if (state.state === "Ready") {
    return state.pending === "authentication" || state.pending === "initial" ||
      state.pending === "recovery" || state.pending === false;
  }
  return isActiveTurnState(state);
}

function stateAuthGeneration(state: ClientState): number | undefined {
  return state.state !== "Error" && validAuthGeneration(state.authAttempt)
    ? state.authAttempt
    : undefined;
}

function matchesAuthAttempt(
  state: ClientState,
  event: { readonly authAttempt: number },
): state is AuthenticationReadyState {
  return state.state === "Ready" && state.pending === "authentication" &&
    state.message === undefined && validAuthAttempt(state.authAttempt) &&
    state.authAttempt === event.authAttempt;
}

function credentialRejected(state: ClientState): ClientStateReduction {
  if (!isAuthenticatedSessionState(state)) return noChange(state);
  const target = stateTarget(state);
  const authAttempt = stateAuthGeneration(state);
  return target === undefined || authAttempt === undefined
    ? noChange(state)
    : reduction(
        enrollmentRequiredState(target, "credential-rejected", authAttempt),
        boundaryCleanupEffects(state),
      );
}

function credentialStorageError(state: ClientState): ClientStateReduction {
  if (!isAuthenticatedSessionState(state)) return noChange(state);
  const target = stateTarget(state);
  const authAttempt = stateAuthGeneration(state);
  return target === undefined || authAttempt === undefined
    ? noChange(state)
    : reduction(storageErrorState(target, authAttempt), boundaryCleanupEffects(state));
}

function isRevocableSessionState(state: ClientState): boolean {
  if (state.state === "TargetSelection") return true;
  if (state.state === "Ready") {
    return state.pending === "authentication" || state.pending === "initial" ||
      state.pending === "recovery" || state.pending === false;
  }
  return isActiveTurnState(state);
}

function revocationStarted(state: ClientState): ClientStateReduction {
  if (!isRevocableSessionState(state)) return noChange(state);
  const target = stateTarget(state);
  const authAttempt = stateAuthGeneration(state);
  return target === undefined || authAttempt === undefined
    ? noChange(state)
    : reduction(
        enrollmentCheckingState(target, "revoking", authAttempt),
        boundaryCleanupEffects(state),
      );
}

function enrollmentStorageError(state: ClientState): ClientStateReduction {
  if (state.state !== "EnrollmentChecking" && state.state !== "EnrollmentRequired" &&
    state.state !== "Enrolling") return noChange(state);
  return validAuthGeneration(state.authAttempt)
    ? reduction(storageErrorState(state.highlightedTarget, state.authAttempt))
    : noChange(state);
}

function sessionReadyMismatch(state: ReadyState, event: SessionReadyEvent): ClientStateReduction {
  const session = stateSession(state) ?? eventSession(event);
  return reduction(
    errorState(SAFE_MESSAGES.sessionMismatch, true, stateTarget(state)),
    session === undefined ? NO_EFFECTS : [endSessionEffect(session)],
  );
}

function invalidRecoveryReady(
  state: RecoveryReadyState,
  event: SessionReadyEvent,
): ClientStateReduction {
  const session = eventSession(event);
  const previousSession = {
    sessionId: state.previousSessionId,
    sessionEpoch: state.previousSessionEpoch,
  };
  const effects = session !== undefined &&
    (session.sessionId !== previousSession.sessionId || session.sessionEpoch !== previousSession.sessionEpoch)
    ? [endSessionEffect(session)]
    : NO_EFFECTS;
  return reduction(
    errorState(SAFE_MESSAGES.recoveryInvalid, true, state.targetLanguage),
    effects,
  );
}

function isUtteranceAbortCategory(value: unknown): value is UtteranceAbortCategory {
  return value === "flow" || value === "duration" || value === "rate" ||
    value === "cancellation" || value === "stale_conflict" || value === "provider_loss";
}

function transcriptOverflow(state: ActiveTurnClientState): ClientStateReduction {
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
    !validPositiveUint32(event.revision)) {
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
    authAttempt: state.authAttempt,
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
    !validPositiveUint32(event.revision) || event.segmentId !== state.finalSegmentId ||
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
      state.authAttempt,
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
    event.segmentId === state.finalSegmentId &&
    validPositiveUint32(event.acceptedFinalRevision) &&
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

function clearAfterAbort(
  state: ActiveTurnClientState,
  effects: readonly ClientEffect[] = NO_EFFECTS,
): ClientStateReduction {
  const session = stateSession(state);
  if (session === undefined) return noChange(state);
  return reduction(readyState(
    state.targetLanguage,
    session,
    state.turn,
    state.authAttempt,
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
    const authAttempt = nextAuthAttempt(state.authAttempt);
    if (authAttempt === undefined) return noChange(state);
    return reduction(
      authenticationReadyState(state.highlightedTarget, authAttempt),
      startSessionEffects(state.highlightedTarget, authAttempt),
    );
  }

  if (state.state === "Ready" && state.pending === "authentication") {
    if (state.message !== SAFE_MESSAGES.authUnavailable) return noChange(state);
    const authAttempt = nextAuthAttempt(state.authAttempt);
    if (authAttempt === undefined) return noChange(state);
    return reduction(
      authenticationReadyState(state.targetLanguage, authAttempt),
      [prepareSessionAuthEffect(state.targetLanguage, authAttempt)],
    );
  }

  if (state.state === "Ready" && state.sessionReady) {
    const session = stateSession(state);
    if (session === undefined || !validUuidV4(event.utteranceId)) return noChange(state);
    const data: ActiveTurnData = {
      ...session,
      targetLanguage: state.targetLanguage,
      authAttempt: state.authAttempt,
      utteranceId: event.utteranceId,
      turn: state.turn + 1,
      transcript: "",
      segmentTexts: {},
      segmentRevisions: {},
      finalSegments: {},
    };
    return reduction(listeningState(data), [
      { type: "start-utterance", ...session, utteranceId: event.utteranceId },
      { type: "start-audio", ...session, utteranceId: event.utteranceId },
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
    const session = stateSession(state);
    if (session === undefined || !validUuidV4(event.utteranceId) ||
      event.utteranceId === state.utteranceId || !validPositiveUint32(state.turn) ||
      state.turn >= MAX_UINT32) {
      return noChange(state);
    }

    const data: ActiveTurnData = {
      ...session,
      targetLanguage: state.targetLanguage,
      authAttempt: state.authAttempt,
      utteranceId: event.utteranceId,
      turn: state.turn + 1,
      transcript: "",
      segmentTexts: {},
      segmentRevisions: {},
      finalSegments: {},
    };
    return reduction(listeningState(data), [
      { type: "start-utterance", ...session, utteranceId: event.utteranceId },
      { type: "start-audio", ...session, utteranceId: event.utteranceId },
    ]);
  }

  return noChange(state);
}

function handleTransportLost(
  state: ClientState,
  event: TransportLostEvent,
): ClientStateReduction {
  if (!sameSession(state, event)) return noChange(state);

  if (state.state === "Ready" && state.sessionReady) {
    const session = stateSession(state);
    if (session === undefined) return noChange(state);
    return reduction(
      recoveryReadyState(state.targetLanguage, session, state.turn, state.authAttempt),
      [startFreshSessionEffect(state.targetLanguage, session)],
    );
  }

  if (!isActiveTurnState(state)) return noChange(state);
  const session = stateSession(state);
  if (session === undefined) return noChange(state);
  const effects: ClientEffect[] = [];
  const stopAudio = stopAudioForActiveTurn(state);
  if (stopAudio !== undefined) effects.push(stopAudio);
  effects.push(startFreshSessionEffect(state.targetLanguage, session));
  return reduction(
    recoveryReadyState(state.targetLanguage, session, state.turn, state.authAttempt),
    effects,
  );
}

export function reduceClientState(inputState: ClientState, inputEvent: ClientEvent): ClientStateReduction {
  const state = normalizeInput(inputState);
  let eventValue: unknown;
  try {
    if (!isKnownClientEvent(inputEvent as unknown)) return noChange(state);
    eventValue = normalizeInput(inputEvent as unknown);
  } catch {
    return noChange(state);
  }
  if (!isKnownClientEvent(eventValue)) return noChange(state);
  const event = eventValue;

  switch (event.type) {
    case "startup.ready":
      return state.state === "Starting"
        ? reduction(enrollmentCheckingState(
            state.highlightedTarget,
            "checking",
            state.authAttempt,
          ), [
            { type: "check-enrollment" },
          ])
        : noChange(state);

    case "startup.failed":
      return state.state === "Starting"
        ? reduction(errorState(SAFE_MESSAGES.startup, true, state.highlightedTarget))
        : noChange(state);

    case "enrollment.ready":
      return state.state === "EnrollmentChecking" && state.phase === "checking"
        ? reduction(makeState({
            state: "TargetSelection" as const,
            highlightedTarget: state.highlightedTarget,
            authAttempt: state.authAttempt,
          }) as TargetSelectionState)
        : state.state === "Enrolling"
          ? reduction(makeState({
              state: "TargetSelection" as const,
              highlightedTarget: state.highlightedTarget,
              authAttempt: state.authAttempt,
            }) as TargetSelectionState)
          : noChange(state);

    case "enrollment.required":
      return state.state === "EnrollmentChecking" && state.phase === "checking"
        ? reduction(enrollmentRequiredState(
            state.highlightedTarget,
            event.reason,
            state.authAttempt,
          ))
        : noChange(state);

    case "enrollment.started":
      return state.state === "EnrollmentRequired"
        ? reduction(enrollingState(state.highlightedTarget, state.authAttempt))
        : noChange(state);

    case "enrollment.failed":
      return state.state === "Enrolling"
        ? reduction(enrollmentRequiredState(
            state.highlightedTarget,
            event.reason,
            state.authAttempt,
          ))
        : noChange(state);

    case "enrollment.storage-error":
      return enrollmentStorageError(state);

    case "enrollment.retry":
      return state.state === "StorageError"
        ? reduction(enrollmentCheckingState(
            state.highlightedTarget,
            "checking",
            state.authAttempt,
          ), [
            { type: "check-enrollment" },
          ])
        : noChange(state);

    case "enrollment.reset":
      return state.state === "StorageError"
        ? reduction(enrollmentCheckingState(
            state.highlightedTarget,
            "checking",
            state.authAttempt,
          ), [
            { type: "reset-enrollment" },
          ])
        : noChange(state);

    case "session.authenticated":
      return matchesAuthAttempt(state, event)
        ? reduction(readyState(
            state.targetLanguage,
            undefined,
            0,
            state.authAttempt,
          ), [
            { type: "start-session", targetLanguage: state.targetLanguage },
          ])
        : noChange(state);

    case "session.auth-required":
      return matchesAuthAttempt(state, event)
          ? reduction(
            enrollmentRequiredState(state.targetLanguage, event.reason, state.authAttempt),
            [cancelSessionBoundaryEffect()],
          )
        : noChange(state);

    case "session.auth-storage-error":
      return matchesAuthAttempt(state, event)
        ? reduction(
            storageErrorState(state.targetLanguage, state.authAttempt),
            [cancelSessionBoundaryEffect()],
          )
        : noChange(state);

    case "session.auth-unavailable":
      return matchesAuthAttempt(state, event)
        ? reduction(authenticationReadyState(
            state.targetLanguage,
            state.authAttempt,
            SAFE_MESSAGES.authUnavailable,
          ))
        : noChange(state);

    case "credential.rejected":
      return credentialRejected(state);

    case "credential.storage-error":
      return credentialStorageError(state);

    case "revocation.started":
      return revocationStarted(state);

    case "revocation.completed":
      return state.state === "EnrollmentChecking" && state.phase === "revoking"
        ? reduction(enrollmentRequiredState(
            state.highlightedTarget,
            event.reason,
            state.authAttempt,
          ))
        : noChange(state);

    case "swipe.next":
      if (state.state === "TargetSelection") {
        return reduction(makeState({
          state: "TargetSelection" as const,
          highlightedTarget: nextTarget(state.highlightedTarget, 1),
          authAttempt: state.authAttempt,
        }) as TargetSelectionState);
      }
      return state.state === "Results" ? swipeResult(state, 1) : noChange(state);

    case "swipe.previous":
      if (state.state === "TargetSelection") {
        return reduction(makeState({
          state: "TargetSelection" as const,
          highlightedTarget: nextTarget(state.highlightedTarget, -1),
          authAttempt: state.authAttempt,
        }) as TargetSelectionState);
      }
      return state.state === "Results" ? swipeResult(state, -1) : noChange(state);

    case "press":
      return pressReduction(state, event);

    case "session.ready": {
      if (state.state !== "Ready") return noChange(state);
      if (state.pending === "authentication") return noChange(state);
      const target = eventTarget(event);
      const session = eventSession(event);
      if (state.pending === "recovery") {
        const previousSession = stateSession(state);
        if (target === undefined || session === undefined || previousSession === undefined ||
          event.result !== "new" ||
          target !== state.targetLanguage ||
          session.sessionId === previousSession.sessionId ||
          session.sessionEpoch <= previousSession.sessionEpoch) {
          return invalidRecoveryReady(state, event);
        }
        return reduction(readyState(
          target,
          session,
          state.turn,
          state.authAttempt,
          state.message,
        ));
      }
      if (target === undefined || session === undefined || event.result !== "new") return noChange(state);
      const confirmedTarget = stateTarget(state);
      if (confirmedTarget === undefined || target !== confirmedTarget) {
        return sessionReadyMismatch(state, event);
      }
      if (state.sessionReady) {
        return sameSession(state, event) ? noChange(state) : sessionReadyMismatch(state, event);
      }
      return reduction(readyState(
        target,
        session,
        state.turn,
        state.authAttempt,
        state.message,
      ));
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

    case "recovery.failed":
      if (state.state !== "Ready" || state.pending !== "recovery" || !sameSession(state, event)) {
        return noChange(state);
      }
      return reduction(errorState(SAFE_MESSAGES.recoveryFailed, true, state.targetLanguage));

    case "utterance.aborted":
      if (!isActiveTurnState(state) || !sameSession(state, event) ||
        !validUuidV4(event.utteranceId) || event.utteranceId !== state.utteranceId ||
        !isUtteranceAbortCategory(event.category)) {
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

  return assertNeverClientEvent(event);
}
