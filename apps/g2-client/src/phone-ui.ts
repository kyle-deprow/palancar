import { isCanonicalPairingCode } from "@palancar/contracts";

import type { AuthRequiredReason } from "./auth/types.js";

const PHONE_AUTH_UI_ERROR = "Phone authentication UI unavailable";
const PAIRING_LENGTH = 6;
const INVALID_PAIRING_COPY = "Enter a valid pairing code.";
const ACTION_ERROR_COPY = "The authentication action could not be completed.";
const DISPOSED_COPY = "Authentication UI unavailable.";

const REQUIRED_COPY: Record<AuthRequiredReason, string> = {
  missing: "Phone authentication required.",
  "absolute-expired": "Phone authentication expired.",
  "credential-rejected": "Phone authentication required.",
  "pairing-failed": "Pairing failed. Try again.",
  "pairing-uncertain": "Pairing status is uncertain. Enter a new pairing code.",
  revoked: "Phone authentication revoked.",
  "revocation-unconfirmed": "Revocation could not be confirmed.",
};

export type PhoneAuthViewState =
  | { readonly status: "starting" | "checking" | "enrolling" | "revoking" }
  | { readonly status: "required"; readonly reason: AuthRequiredReason }
  | { readonly status: "ready" }
  | { readonly status: "storage-error" };

export interface PhoneAuthViewCallbacks {
  readonly onEnroll: (pairingCode: string) => void | Promise<void>;
  readonly onRetryStorage: () => void | Promise<void>;
  readonly onResetEnrollment: () => void | Promise<void>;
  readonly onRevoke: () => void | Promise<void>;
}

export interface PhoneAuthView {
  render(state: PhoneAuthViewState): void;
  dispose(): void;
}

type ViewContainer = HTMLElement & { hidden: boolean };
type ViewButton = ViewContainer & { disabled: boolean };
type ViewInput = HTMLInputElement & { value: string; blur(): void };
type ViewForm = HTMLFormElement & ViewContainer;

interface ViewElements {
  readonly app: ViewContainer;
  readonly status: ViewContainer;
  readonly pairingForm: ViewForm;
  readonly pairingCode: ViewInput;
  readonly pairingSubmit: ViewButton;
  readonly storageActions: ViewContainer;
  readonly storageRetry: ViewButton;
  readonly storageReset: ViewButton;
  readonly enrolledActions: ViewContainer;
  readonly revokeStart: ViewButton;
  readonly revokeConfirm: ViewButton;
  readonly revokeCancel: ViewButton;
}

function unavailable(): never {
  throw new Error(PHONE_AUTH_UI_ERROR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasFunction(value: object, key: string): boolean {
  return typeof (value as Record<string, unknown>)[key] === "function";
}

function isViewContainer(value: unknown): value is ViewContainer {
  if (!isRecord(value)) return false;
  return (
    typeof value.hidden === "boolean" &&
    "textContent" in value &&
    hasFunction(value, "addEventListener") &&
    hasFunction(value, "removeEventListener") &&
    hasFunction(value, "setAttribute") &&
    hasFunction(value, "removeAttribute")
  );
}

function isViewButton(value: unknown): value is ViewButton {
  return (
    isViewContainer(value) &&
    typeof (value as ViewButton).disabled === "boolean" &&
    hasFunction(value, "focus")
  );
}

function isViewInput(value: unknown): value is ViewInput {
  return (
    isViewContainer(value) &&
    typeof (value as ViewInput).value === "string" &&
    hasFunction(value, "blur")
  );
}

function isViewForm(value: unknown): value is ViewForm {
  return isViewContainer(value);
}

function getElement<T extends HTMLElement>(
  documentValue: Document,
  id: string,
  predicate: (value: unknown) => value is T,
): T {
  let value: HTMLElement | null;
  try {
    value = documentValue.getElementById(id);
  } catch {
    unavailable();
  }
  if (!predicate(value)) unavailable();
  return value;
}

function collectElements(documentValue: Document): ViewElements {
  if (!isRecord(documentValue) || !hasFunction(documentValue, "getElementById")) {
    unavailable();
  }
  return {
    app: getElement(documentValue, "palancar-phone-app", isViewContainer),
    status: getElement(documentValue, "palancar-auth-status", isViewContainer),
    pairingForm: getElement(documentValue, "palancar-pairing-form", isViewForm),
    pairingCode: getElement(documentValue, "palancar-pairing-code", isViewInput),
    pairingSubmit: getElement(documentValue, "palancar-pairing-submit", isViewButton),
    storageActions: getElement(documentValue, "palancar-storage-actions", isViewContainer),
    storageRetry: getElement(documentValue, "palancar-storage-retry", isViewButton),
    storageReset: getElement(documentValue, "palancar-storage-reset", isViewButton),
    enrolledActions: getElement(documentValue, "palancar-enrolled-actions", isViewContainer),
    revokeStart: getElement(documentValue, "palancar-revoke-start", isViewButton),
    revokeConfirm: getElement(documentValue, "palancar-revoke-confirm", isViewButton),
    revokeCancel: getElement(documentValue, "palancar-revoke-cancel", isViewButton),
  };
}

function setHidden(element: ViewContainer, hidden: boolean): void {
  element.hidden = hidden;
  if (hidden) {
    element.setAttribute("hidden", "");
  } else {
    element.removeAttribute("hidden");
  }
}

function setDisabled(element: ViewButton, disabled: boolean): void {
  element.disabled = disabled;
  element.setAttribute("aria-disabled", disabled ? "true" : "false");
}

function stateCopy(state: PhoneAuthViewState): string {
  switch (state.status) {
    case "starting":
      return "Starting authentication.";
    case "checking":
      return "Checking authentication.";
    case "enrolling":
      return "Completing authentication.";
    case "revoking":
      return "Revoking authentication.";
    case "ready":
      return "Phone authentication is ready.";
    case "storage-error":
      return "Phone authentication storage is unavailable.";
    case "required":
      return REQUIRED_COPY[state.reason] ?? ACTION_ERROR_COPY;
  }
}

function isCallbacks(value: unknown): value is PhoneAuthViewCallbacks {
  if (!isRecord(value)) return false;
  return (
    typeof value.onEnroll === "function" &&
    typeof value.onRetryStorage === "function" &&
    typeof value.onResetEnrollment === "function" &&
    typeof value.onRevoke === "function"
  );
}

export function createPhoneAuthView(options: {
  readonly document?: Document;
  readonly callbacks: PhoneAuthViewCallbacks;
}): PhoneAuthView {
  if (!isRecord(options) || !isCallbacks(options.callbacks)) unavailable();
  const documentValue = options.document ?? (typeof document === "undefined" ? undefined : document);
  if (documentValue === undefined) unavailable();
  const elements = collectElements(documentValue);
  const {
    app,
    status,
    pairingForm,
    pairingCode,
    pairingSubmit,
    storageActions,
    storageRetry,
    storageReset,
    enrolledActions,
    revokeStart,
    revokeConfirm,
    revokeCancel,
  } = elements;
  const callbacks = options.callbacks;
  let active = true;
  let pendingAction = false;
  let revokeConfirmation = false;
  let renderedStatus: PhoneAuthViewState["status"] = "starting";
  let generation = 0;

  const clearPairingInput = (): void => {
    pairingCode.value = "";
    pairingCode.removeAttribute("value");
    pairingCode.blur();
  };

  const setStatus = (copy: string): void => {
    status.textContent = copy;
  };

  const updateControls = (): void => {
    const required = renderedStatus === "required";
    const storageError = renderedStatus === "storage-error";
    const ready = renderedStatus === "ready";
    setHidden(pairingForm, !required);
    setHidden(storageActions, !storageError);
    setHidden(enrolledActions, !ready);
    pairingCode.disabled = !active || !required || pendingAction;
    setDisabled(pairingSubmit, !active || !required || pendingAction);
    setDisabled(storageRetry, !active || !storageError || pendingAction);
    setDisabled(storageReset, !active || !storageError || pendingAction);
    setHidden(revokeStart, !ready || revokeConfirmation);
    setHidden(revokeConfirm, !ready || !revokeConfirmation);
    setHidden(revokeCancel, !ready || !revokeConfirmation);
    setDisabled(revokeStart, !active || !ready || pendingAction || revokeConfirmation);
    setDisabled(revokeConfirm, !active || !ready || pendingAction || !revokeConfirmation);
    setDisabled(revokeCancel, !active || !ready || pendingAction || !revokeConfirmation);
  };

  const finishAction = (actionGeneration: number, successful: boolean): void => {
    if (!active || actionGeneration !== generation) return;
    pendingAction = false;
    if (!successful) setStatus(ACTION_ERROR_COPY);
    updateControls();
  };

  const runAction = (callback: () => void | Promise<void>): void => {
    if (!active || pendingAction) return;
    pendingAction = true;
    const actionGeneration = generation;
    updateControls();
    let result: void | Promise<void>;
    try {
      result = callback();
    } catch {
      finishAction(actionGeneration, false);
      return;
    }
    if (result === undefined) {
      finishAction(actionGeneration, true);
      return;
    }
    try {
      void Promise.resolve(result).then(
        () => { finishAction(actionGeneration, true); },
        () => { finishAction(actionGeneration, false); },
      );
    } catch {
      finishAction(actionGeneration, false);
    }
  };

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    if (!active || renderedStatus !== "required" || pendingAction) return;
    const pairingCodeValue = pairingCode.value;
    if (!isCanonicalPairingCode(pairingCodeValue)) {
      clearPairingInput();
      pairingCode.setAttribute("aria-invalid", "true");
      setStatus(INVALID_PAIRING_COPY);
      return;
    }
    clearPairingInput();
    pairingCode.removeAttribute("aria-invalid");
    runAction(() => callbacks.onEnroll(pairingCodeValue));
  };

  const onRetryStorage = (event: Event): void => {
    event.preventDefault();
    if (!active || renderedStatus !== "storage-error") return;
    runAction(callbacks.onRetryStorage);
  };

  const onResetEnrollment = (event: Event): void => {
    event.preventDefault();
    if (!active || renderedStatus !== "storage-error") return;
    runAction(callbacks.onResetEnrollment);
  };

  const onRevokeStart = (event: Event): void => {
    event.preventDefault();
    if (!active || renderedStatus !== "ready" || pendingAction) return;
    revokeConfirmation = true;
    updateControls();
    setStatus("Confirm revocation to continue.");
    revokeConfirm.focus();
  };

  const onRevokeConfirm = (event: Event): void => {
    event.preventDefault();
    if (!active || renderedStatus !== "ready" || pendingAction || !revokeConfirmation) return;
    revokeConfirmation = false;
    updateControls();
    runAction(callbacks.onRevoke);
  };

  const onRevokeCancel = (event: Event): void => {
    event.preventDefault();
    if (!active || renderedStatus !== "ready" || pendingAction || !revokeConfirmation) return;
    revokeConfirmation = false;
    updateControls();
    setStatus("Phone authentication is ready.");
    revokeStart.focus();
  };

  pairingCode.setAttribute("type", "password");
  pairingCode.setAttribute("minlength", String(PAIRING_LENGTH));
  pairingCode.setAttribute("maxlength", String(PAIRING_LENGTH));
  pairingCode.setAttribute("inputmode", "numeric");
  pairingCode.setAttribute("pattern", "[0-9]*");
  pairingCode.setAttribute("autocomplete", "off");
  pairingCode.setAttribute("autocapitalize", "off");
  pairingCode.setAttribute("autocorrect", "off");
  pairingCode.setAttribute("spellcheck", "false");
  pairingCode.removeAttribute("name");
  pairingCode.removeAttribute("value");
  pairingCode.type = "password";
  pairingCode.minLength = PAIRING_LENGTH;
  pairingCode.maxLength = PAIRING_LENGTH;
  pairingCode.inputMode = "numeric";
  pairingCode.pattern = "[0-9]*";
  pairingCode.autocomplete = "off";
  pairingCode.autocapitalize = "off";
  pairingCode.spellcheck = false;
  pairingCode.value = "";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  app.setAttribute("aria-label", "Phone authentication");

  pairingForm.addEventListener("submit", onSubmit);
  storageRetry.addEventListener("click", onRetryStorage);
  storageReset.addEventListener("click", onResetEnrollment);
  revokeStart.addEventListener("click", onRevokeStart);
  revokeConfirm.addEventListener("click", onRevokeConfirm);
  revokeCancel.addEventListener("click", onRevokeCancel);

  const render = (state: PhoneAuthViewState): void => {
    if (!active) return;
    const leavingRequired = renderedStatus === "required" && state.status !== "required";
    generation += 1;
    pendingAction = false;
    renderedStatus = state.status;
    if (leavingRequired) {
      clearPairingInput();
      pairingCode.removeAttribute("aria-invalid");
    }
    if (state.status !== "ready") revokeConfirmation = false;
    setStatus(stateCopy(state));
    status.setAttribute("aria-busy", state.status === "starting" || state.status === "checking" ? "true" : "false");
    updateControls();
  };

  const dispose = (): void => {
    if (!active) return;
    active = false;
    generation += 1;
    pendingAction = false;
    revokeConfirmation = false;
    pairingForm.removeEventListener("submit", onSubmit);
    storageRetry.removeEventListener("click", onRetryStorage);
    storageReset.removeEventListener("click", onResetEnrollment);
    revokeStart.removeEventListener("click", onRevokeStart);
    revokeConfirm.removeEventListener("click", onRevokeConfirm);
    revokeCancel.removeEventListener("click", onRevokeCancel);
    clearPairingInput();
    setStatus(DISPOSED_COPY);
    setHidden(pairingForm, true);
    setHidden(storageActions, true);
    setHidden(enrolledActions, true);
    setHidden(revokeStart, true);
    setHidden(revokeConfirm, true);
    setHidden(revokeCancel, true);
    pairingCode.disabled = true;
    setDisabled(pairingSubmit, true);
    setDisabled(storageRetry, true);
    setDisabled(storageReset, true);
    setDisabled(revokeStart, true);
    setDisabled(revokeConfirm, true);
    setDisabled(revokeCancel, true);
  };

  render({ status: "starting" });
  return Object.freeze({ render, dispose });
}
