import { describe, expect, it } from "vitest";

import {
  type PhoneAuthViewCallbacks,
  type PhoneAuthViewState,
  createPhoneAuthView,
} from "../src/phone-ui";

const VALID_CODE = "012345";
const INVALID_CODE = "01234A";
const CANARY = "pairing-code-canary";
const ERROR_CANARY = "platform-error-canary";

type Listener = (event: Event) => void;

class FakeElement {
  public hidden = false;
  public textContent = "";
  public disabled = false;
  public value = "";
  public minLength = 0;
  public maxLength = 524288;
  public autocomplete = "";
  public autocapitalize = "";
  public inputMode = "";
  public pattern = "";
  public spellcheck = true;
  public type = "text";
  public blurCount = 0;
  public focusCount = 0;
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  blur(): void {
    this.blurCount += 1;
  }

  focus(): void {
    this.focusCount += 1;
  }

  emit(type: string): void {
    const event = {
      preventDefault: () => undefined,
    } as unknown as Event;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

class FakeDocument {
  public readonly elements = new Map<string, FakeElement>();

  constructor() {
    for (const id of [
      "palancar-phone-app",
      "palancar-auth-status",
      "palancar-pairing-form",
      "palancar-pairing-code",
      "palancar-pairing-submit",
      "palancar-storage-actions",
      "palancar-storage-retry",
      "palancar-storage-reset",
      "palancar-enrolled-actions",
      "palancar-revoke-start",
      "palancar-revoke-confirm",
      "palancar-revoke-cancel",
    ]) {
      this.elements.set(id, new FakeElement());
    }
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }
}

function makeCallbacks(overrides: Partial<PhoneAuthViewCallbacks> = {}): PhoneAuthViewCallbacks {
  return {
    onEnroll: () => undefined,
    onRetryStorage: () => undefined,
    onResetEnrollment: () => undefined,
    onRevoke: () => undefined,
    ...overrides,
  };
}

function makeView(callbacks: Partial<PhoneAuthViewCallbacks> = {}): {
  document: FakeDocument;
  view: ReturnType<typeof createPhoneAuthView>;
} {
  const document = new FakeDocument();
  const view = createPhoneAuthView({
    document: document as unknown as Document,
    callbacks: makeCallbacks(callbacks),
  });
  return { document, view };
}

function element(document: FakeDocument, id: string): FakeElement {
  return document.elements.get(id)!;
}

function submit(document: FakeDocument, value: string): void {
  element(document, "palancar-pairing-code").value = value;
  element(document, "palancar-pairing-form").emit("submit");
}

describe("phone authentication UI", () => {
  it("rejects missing and incapable elements with fixed errors", () => {
    const missing = new FakeDocument();
    missing.elements.delete("palancar-auth-status");
    expect(() => createPhoneAuthView({
      document: missing as unknown as Document,
      callbacks: makeCallbacks(),
    })).toThrow("Phone authentication UI unavailable");

    const incapable = new FakeDocument();
    incapable.elements.set("palancar-pairing-submit", new FakeElement());
    incapable.elements.get("palancar-pairing-submit")!.disabled = undefined as unknown as boolean;
    expect(() => createPhoneAuthView({
      document: incapable as unknown as Document,
      callbacks: makeCallbacks(),
    })).toThrow("Phone authentication UI unavailable");
  });

  it("repairs the input security and accessibility attributes", () => {
    const document = new FakeDocument();
    const input = element(document, "palancar-pairing-code");
    input.setAttribute("name", "canary");
    input.setAttribute("value", CANARY);
    input.value = CANARY;
    const view = createPhoneAuthView({
      document: document as unknown as Document,
      callbacks: makeCallbacks(),
    });

    view.render({ status: "required", reason: "missing" });
    expect(input.attributes.get("type")).toBe("password");
    expect(input.attributes.get("minlength")).toBe("6");
    expect(input.attributes.get("maxlength")).toBe("6");
    expect(input.attributes.get("inputmode")).toBe("numeric");
    expect(input.attributes.get("pattern")).toBe("[0-9]*");
    expect(input.attributes.get("autocomplete")).toBe("off");
    expect(input.attributes.get("autocapitalize")).toBe("off");
    expect(input.attributes.get("autocorrect")).toBe("off");
    expect(input.attributes.get("spellcheck")).toBe("false");
    expect(input.attributes.has("name")).toBe(false);
    expect(input.minLength).toBe(6);
    expect(input.maxLength).toBe(6);
    expect(input.inputMode).toBe("numeric");
    expect(input.pattern).toBe("[0-9]*");
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    expect(input.autocapitalize).toBe("off");
    expect(input.spellcheck).toBe(false);
    expect(input.value).toBe("");
    expect(JSON.stringify(input)).not.toContain(CANARY);
    view.dispose();
  });

  it("renders each state and required reason with fixed visibility and copy", () => {
    const { document, view } = makeView();
    const status = element(document, "palancar-auth-status");
    const form = element(document, "palancar-pairing-form");
    const storage = element(document, "palancar-storage-actions");
    const enrolled = element(document, "palancar-enrolled-actions");
    const states: PhoneAuthViewState[] = [
      { status: "starting" },
      { status: "checking" },
      { status: "enrolling" },
      { status: "revoking" },
      { status: "ready" },
      { status: "storage-error" },
      { status: "required", reason: "absolute-expired" },
      { status: "required", reason: "credential-rejected" },
      { status: "required", reason: "pairing-failed" },
      { status: "required", reason: "pairing-uncertain" },
      { status: "required", reason: "revoked" },
      { status: "required", reason: "revocation-unconfirmed" },
    ];

    for (const current of states) {
      view.render(current);
      expect(status.textContent).not.toContain(CANARY);
      expect(status.textContent).not.toContain(ERROR_CANARY);
      expect(status.attributes.get("aria-live")).toBe("polite");
      expect(form.hidden).toBe(current.status !== "required");
      expect(storage.hidden).toBe(current.status !== "storage-error");
      expect(enrolled.hidden).toBe(current.status !== "ready");
    }
    view.dispose();
  });

  it("clears partial pairing input whenever required state is left", () => {
    const { document, view } = makeView();
    const input = element(document, "palancar-pairing-code");

    for (const nextStatus of ["enrolling", "ready", "revoking"] as const) {
      view.render({ status: "required", reason: "missing" });
      input.value = "012345";
      input.setAttribute("value", "012345");
      const blurCount = input.blurCount;
      view.render({ status: nextStatus });
      expect(input.value).toBe("");
      expect(input.attributes.has("value")).toBe(false);
      expect(input.blurCount).toBe(blurCount + 1);
    }
    view.dispose();
  });

  it("requires a new code for uncertain pairing without retrying automatically", async () => {
    let callbackCount = 0;
    const callback = (): void => { callbackCount += 1; };
    const { document, view } = makeView({
      onEnroll: callback,
      onRetryStorage: callback,
      onResetEnrollment: callback,
      onRevoke: callback,
    });

    view.render({ status: "required", reason: "pairing-uncertain" });
    await Promise.resolve();
    expect(element(document, "palancar-auth-status").textContent).toBe(
      "Pairing status is uncertain. Enter a new pairing code.",
    );
    expect(element(document, "palancar-pairing-form").hidden).toBe(false);
    expect(element(document, "palancar-pairing-submit").disabled).toBe(false);
    expect(callbackCount).toBe(0);
    view.dispose();
  });

  it("accepts only exact canonical code and clears/blurs before callback", () => {
    const calls: string[] = [];
    const { document, view } = makeView({
      onEnroll: (code) => {
        calls.push(code);
        expect(element(document, "palancar-pairing-code").value).toBe("");
        expect(element(document, "palancar-pairing-code").blurCount).toBe(1);
      },
    });
    view.render({ status: "required", reason: "missing" });
    submit(document, VALID_CODE);
    expect(calls).toEqual([VALID_CODE]);

    for (const invalid of [INVALID_CODE, "12345", "0123457", ` ${VALID_CODE}`, `${VALID_CODE} `]) {
      submit(document, invalid);
    }
    expect(calls).toEqual([VALID_CODE]);
    expect(element(document, "palancar-auth-status").textContent).toBe("Enter a valid pairing code.");
    expect(element(document, "palancar-pairing-code").value).toBe("");
    expect(element(document, "palancar-pairing-code").attributes.has("aria-invalid")).toBe(true);
    view.dispose();
  });

  it("prevents async double actions, swallows callback errors, and retries", async () => {
    let resolveEnroll!: () => void;
    let enrollCalls = 0;
    const enrollment = new Promise<void>((resolve) => { resolveEnroll = resolve; });
    const { document, view } = makeView({
      onEnroll: () => {
        enrollCalls += 1;
        return enrollment;
      },
    });
    view.render({ status: "required", reason: "pairing-failed" });
    submit(document, VALID_CODE);
    submit(document, VALID_CODE);
    expect(enrollCalls).toBe(1);
    expect(element(document, "palancar-pairing-submit").disabled).toBe(true);
    resolveEnroll();
    await enrollment;
    await Promise.resolve();
    expect(element(document, "palancar-pairing-submit").disabled).toBe(false);

    let retryCalls = 0;
    view.render({ status: "storage-error" });
    const retryError = new Error(ERROR_CANARY);
    const failingRetry = makeView({
      onRetryStorage: () => {
        retryCalls += 1;
        return Promise.reject(retryError);
      },
    });
    failingRetry.view.render({ status: "storage-error" });
    element(failingRetry.document, "palancar-storage-retry").emit("click");
    element(failingRetry.document, "palancar-storage-retry").emit("click");
    await Promise.resolve();
    await Promise.resolve();
    expect(retryCalls).toBe(1);
    expect(element(failingRetry.document, "palancar-auth-status").textContent).toBe(
      "The authentication action could not be completed.",
    );
    expect(element(failingRetry.document, "palancar-auth-status").textContent).not.toContain(ERROR_CANARY);
    failingRetry.view.dispose();

    let resetCalls = 0;
    const resetView = makeView({
      onResetEnrollment: () => {
        resetCalls += 1;
        return Promise.resolve();
      },
    });
    resetView.view.render({ status: "storage-error" });
    element(resetView.document, "palancar-storage-reset").emit("click");
    element(resetView.document, "palancar-storage-reset").emit("click");
    expect(resetCalls).toBe(1);
    await Promise.resolve();
    resetView.view.dispose();
    view.dispose();
  });

  it("ignores stale async completions after render supersession and dispose", async () => {
    let resolveRetry!: () => void;
    let resolveReset!: () => void;
    const retry = new Promise<void>((resolve) => { resolveRetry = resolve; });
    const reset = new Promise<void>((resolve) => { resolveReset = resolve; });
    const current = makeView({
      onRetryStorage: () => retry,
      onResetEnrollment: () => reset,
    });
    current.view.render({ status: "storage-error" });
    element(current.document, "palancar-storage-retry").emit("click");
    current.view.render({ status: "storage-error" });
    element(current.document, "palancar-storage-reset").emit("click");
    expect(element(current.document, "palancar-storage-reset").disabled).toBe(true);

    resolveRetry();
    await retry;
    await Promise.resolve();
    expect(element(current.document, "palancar-storage-reset").disabled).toBe(true);
    expect(element(current.document, "palancar-storage-actions").hidden).toBe(false);

    resolveReset();
    await reset;
    await Promise.resolve();
    expect(element(current.document, "palancar-storage-reset").disabled).toBe(false);
    current.view.dispose();

    let resolveEnrollment!: () => void;
    const enrollment = new Promise<void>((resolve) => { resolveEnrollment = resolve; });
    const disposed = makeView({ onEnroll: () => enrollment });
    disposed.view.render({ status: "required", reason: "missing" });
    submit(disposed.document, VALID_CODE);
    disposed.view.dispose();
    resolveEnrollment();
    await enrollment;
    await Promise.resolve();
    expect(element(disposed.document, "palancar-auth-status").textContent).toBe(
      "Authentication UI unavailable.",
    );
    expect(element(disposed.document, "palancar-pairing-form").hidden).toBe(true);
    expect(element(disposed.document, "palancar-pairing-submit").disabled).toBe(true);
  });

  it("requires two revoke activations and supports cancel", async () => {
    let revokeCalls = 0;
    let resolveRevoke!: () => void;
    const revokePromise = new Promise<void>((resolve) => { resolveRevoke = resolve; });
    const { document, view } = makeView({
      onRevoke: () => {
        revokeCalls += 1;
        return revokePromise;
      },
    });
    view.render({ status: "ready" });
    const start = element(document, "palancar-revoke-start");
    const confirm = element(document, "palancar-revoke-confirm");
    const cancel = element(document, "palancar-revoke-cancel");
    start.emit("click");
    expect(start.hidden).toBe(true);
    expect(confirm.hidden).toBe(false);
    expect(cancel.hidden).toBe(false);
    expect(confirm.focusCount).toBe(1);
    expect(revokeCalls).toBe(0);
    cancel.emit("click");
    expect(start.hidden).toBe(false);
    expect(confirm.hidden).toBe(true);
    expect(start.focusCount).toBe(1);
    start.emit("click");
    confirm.emit("click");
    confirm.emit("click");
    expect(revokeCalls).toBe(1);
    resolveRevoke();
    await revokePromise;
    await Promise.resolve();
    view.render({ status: "checking" });
    expect(confirm.hidden).toBe(true);
    view.dispose();
  });

  it("attaches listeners exactly once and dispose removes/neutralizes them", () => {
    let calls = 0;
    const { document, view } = makeView({ onRetryStorage: () => { calls += 1; } });
    const form = element(document, "palancar-pairing-form");
    expect(form.listenerCount("submit")).toBe(1);
    expect(element(document, "palancar-storage-retry").listenerCount("click")).toBe(1);
    expect(element(document, "palancar-storage-reset").listenerCount("click")).toBe(1);
    expect(element(document, "palancar-revoke-start").listenerCount("click")).toBe(1);
    expect(element(document, "palancar-revoke-confirm").listenerCount("click")).toBe(1);
    expect(element(document, "palancar-revoke-cancel").listenerCount("click")).toBe(1);
    view.render({ status: "storage-error" });
    view.dispose();
    view.dispose();
    expect(form.listenerCount("submit")).toBe(0);
    expect(element(document, "palancar-storage-retry").listenerCount("click")).toBe(0);
    element(document, "palancar-storage-retry").emit("click");
    expect(calls).toBe(0);
    expect(element(document, "palancar-storage-actions").hidden).toBe(true);
    expect(element(document, "palancar-enrolled-actions").hidden).toBe(true);
    expect(element(document, "palancar-pairing-submit").disabled).toBe(true);
  });
});
