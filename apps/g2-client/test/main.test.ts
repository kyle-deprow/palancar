import { describe, expect, it, vi } from "vitest";

import type { CredentialStore } from "../src/auth/credential-store.js";
import type { AuthHttpClient } from "../src/auth/http-client.js";
import type { G2AuthController } from "../src/auth/types.js";
import type { G2PhoneAuthState } from "../src/bridge/index.js";
import {
  startG2ApplicationShell,
  type G2ApplicationRuntime,
  type G2ApplicationShellDependencies,
} from "../src/main.js";
import type {
  PhoneAuthViewCallbacks,
  PhoneAuthViewState,
} from "../src/phone-ui.js";

const RELAY_ORIGIN = "https://relay.example.test";
const PAIRING_CODE = "012345";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeElement {
  textContent: string | null = null;
  value = "";
  readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

class FakeLifecycleTarget {
  readonly listeners = new Set<EventListener>();
  addCount = 0;
  removeCount = 0;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== "pagehide" || typeof listener !== "function") return;
    this.addCount += 1;
    this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== "pagehide" || typeof listener !== "function") return;
    this.removeCount += 1;
    this.listeners.delete(listener);
  }

  pageHide(): void {
    for (const listener of [...this.listeners]) listener(new Event("pagehide"));
  }
}

function createDocument() {
  const status = new FakeElement();
  const pairing = new FakeElement();
  const elements = new Map<string, FakeElement>([
    ["palancar-auth-status", status],
    ["palancar-pairing-code", pairing],
  ]);
  const dataset: Record<string, string> = {};
  const documentValue = {
    documentElement: { dataset },
    getElementById: (id: string) => elements.get(id) ?? null,
  } as unknown as Document;
  return { documentValue, status, pairing, dataset };
}

function createHarness(options: { readonly pendingCleanup?: boolean } = {}) {
  const calls: string[] = [];
  const boot = deferred<void>();
  const cleanup = deferred<void>();
  const documentHarness = createDocument();
  const lifecycle = new FakeLifecycleTarget();
  const rendered: PhoneAuthViewState[] = [];
  let callbacks: PhoneAuthViewCallbacks | undefined;
  let phoneListener: ((state: G2PhoneAuthState) => void) | undefined;
  let unsubscribeCount = 0;
  let viewDisposeCount = 0;
  let cleanupCount = 0;
  let controllerDisposeCount = 0;
  let httpDisposeCount = 0;
  let storeCloseCount = 0;

  const store: CredentialStore = {
    load: async () => undefined,
    save: async () => undefined,
    clear: async () => undefined,
    close: () => {
      storeCloseCount += 1;
      calls.push("store.close");
    },
  };
  const http: AuthHttpClient = {
    ensureRelayAwake: async () => undefined,
    redeemPairing: async () => { throw new Error("unused"); },
    beginRotation: async () => { throw new Error("unused"); },
    confirmRotation: async () => { throw new Error("unused"); },
    revokeCurrent: async () => "confirmed",
    dispose: () => {
      httpDisposeCount += 1;
      calls.push("http.dispose");
    },
  };
  const controller: G2AuthController = {
    initialize: async () => ({ kind: "ready" }),
    enroll: async () => ({ kind: "ready" }),
    retryPersistence: async () => ({ kind: "ready" }),
    resetEnrollment: async () => ({ kind: "required", reason: "missing" }),
    prepareSessionBoundary: async () => ({ kind: "ready" }),
    revokeCurrent: async () => ({ kind: "required", reason: "revoked" }),
    credentialProvider: {
      acquire: async () => ({ kind: "required" }),
      recordAuthenticated: async () => "stale",
      reject: async () => "stale",
    },
    dispose: () => {
      controllerDisposeCount += 1;
      calls.push("controller.dispose");
      http.dispose();
      store.close();
    },
  };

  const runtime: G2ApplicationRuntime = {
    boot: () => {
      calls.push("runtime.boot");
      return boot.promise;
    },
    enroll: async (pairingCode) => {
      calls.push(pairingCode === PAIRING_CODE ? "runtime.enroll" : "runtime.enroll:unexpected");
    },
    retryEnrollment: async () => { calls.push("runtime.retry"); },
    resetEnrollment: async () => { calls.push("runtime.reset"); },
    revokeEnrollment: async () => { calls.push("runtime.revoke"); },
    subscribePhoneAuthState: (listener) => {
      calls.push("runtime.subscribe");
      phoneListener = listener;
      listener({ status: "starting" });
      return () => {
        unsubscribeCount += 1;
        calls.push("runtime.unsubscribe");
        phoneListener = undefined;
      };
    },
    cleanup: async () => {
      cleanupCount += 1;
      calls.push("runtime.cleanup");
      controller.dispose();
      if (options.pendingCleanup) await cleanup.promise;
    },
  };

  const dependencies: G2ApplicationShellDependencies = {
    createCredentialStore: () => {
      calls.push("credential-store");
      return store;
    },
    createAuthHttpClient: (httpOptions) => {
      calls.push(`http:${httpOptions.relayOrigin}`);
      return http;
    },
    createAuthController: (controllerOptions) => {
      expect(controllerOptions).toEqual({ store, http });
      calls.push("controller");
      return controller;
    },
    createRuntime: (runtimeOptions) => {
      expect(runtimeOptions.relayOrigin).toBe(RELAY_ORIGIN);
      expect(runtimeOptions.authController).toBe(controller);
      calls.push("runtime");
      return runtime;
    },
    createPhoneView: (viewOptions) => {
      expect(viewOptions.document).toBe(documentHarness.documentValue);
      callbacks = viewOptions.callbacks;
      calls.push("phone-view");
      return {
        render: (state) => {
          rendered.push(state);
          calls.push(`view.render:${state.status}`);
        },
        dispose: () => {
          viewDisposeCount += 1;
          calls.push("view.dispose");
        },
      };
    },
  };

  const shell = startG2ApplicationShell({
    relayOrigin: RELAY_ORIGIN,
    document: documentHarness.documentValue,
    lifecycleTarget: lifecycle as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
    dependencies,
  });

  return {
    ...documentHarness,
    shell,
    calls,
    boot,
    cleanup,
    lifecycle,
    rendered,
    emit: (state: G2PhoneAuthState) => phoneListener?.(state),
    callbacks: () => {
      if (callbacks === undefined) throw new Error("Phone callbacks were not mounted");
      return callbacks;
    },
    counts: () => ({
      unsubscribeCount,
      viewDisposeCount,
      cleanupCount,
      controllerDisposeCount,
      httpDisposeCount,
      storeCloseCount,
    }),
  };
}

type ConstructionFailureStage = "http" | "controller" | "runtime" | "view" | "render";

function createConstructionFailureHarness(stage: ConstructionFailureStage) {
  const canary = `${PAIRING_CODE}-CONSTRUCTION-FAILURE-CANARY`;
  const calls: string[] = [];
  const documentHarness = createDocument();
  const lifecycle = new FakeLifecycleTarget();
  let storeCloseCount = 0;
  let httpDisposeCount = 0;
  let controllerDisposeCount = 0;
  let runtimeCleanupCount = 0;
  let viewDisposeCount = 0;

  documentHarness.pairing.value = PAIRING_CODE;
  documentHarness.pairing.setAttribute("value", PAIRING_CODE);

  const store: CredentialStore = {
    load: async () => undefined,
    save: async () => undefined,
    clear: async () => undefined,
    close: () => {
      storeCloseCount += 1;
      calls.push("store.close");
    },
  };
  const http = {
    ensureRelayAwake: async () => undefined,
    redeemPairing: async () => { throw new Error("unused"); },
    beginRotation: async () => { throw new Error("unused"); },
    confirmRotation: async () => { throw new Error("unused"); },
    revokeCurrent: async () => "confirmed" as const,
    dispose: () => {
      httpDisposeCount += 1;
      calls.push("http.dispose");
    },
  } satisfies AuthHttpClient;
  const controller = {
    initialize: async () => ({ kind: "ready" } as const),
    enroll: async () => ({ kind: "ready" } as const),
    retryPersistence: async () => ({ kind: "ready" } as const),
    resetEnrollment: async () => ({ kind: "required", reason: "missing" } as const),
    prepareSessionBoundary: async () => ({ kind: "ready" } as const),
    revokeCurrent: async () => ({ kind: "required", reason: "revoked" } as const),
    credentialProvider: {
      acquire: async () => ({ kind: "required" } as const),
      recordAuthenticated: async () => "stale" as const,
      reject: async () => "stale" as const,
    },
    dispose: () => {
      controllerDisposeCount += 1;
      calls.push("controller.dispose");
      http.dispose();
      store.close();
    },
  } satisfies G2AuthController;
  const runtime: G2ApplicationRuntime = {
    boot: async () => undefined,
    enroll: async () => undefined,
    retryEnrollment: async () => undefined,
    resetEnrollment: async () => undefined,
    revokeEnrollment: async () => undefined,
    subscribePhoneAuthState: () => () => undefined,
    cleanup: async () => {
      runtimeCleanupCount += 1;
      calls.push("runtime.cleanup");
      controller.dispose();
    },
  };

  const dependencies: G2ApplicationShellDependencies = {
    createCredentialStore: () => {
      calls.push("credential-store");
      return store;
    },
    createAuthHttpClient: () => {
      calls.push("http");
      if (stage === "http") throw new Error(canary);
      return http;
    },
    createAuthController: () => {
      calls.push("controller");
      if (stage === "controller") throw new Error(canary);
      return controller;
    },
    createRuntime: () => {
      calls.push("runtime");
      if (stage === "runtime") throw new Error(canary);
      return runtime;
    },
    createPhoneView: () => {
      calls.push("view");
      if (stage === "view") throw new Error(canary);
      return {
        render: () => {
          calls.push("view.render");
          if (stage === "render") throw new Error(canary);
        },
        dispose: () => {
          viewDisposeCount += 1;
          calls.push("view.dispose");
        },
      };
    },
  };

  let thrown: unknown;
  try {
    startG2ApplicationShell({
      relayOrigin: RELAY_ORIGIN,
      document: documentHarness.documentValue,
      lifecycleTarget: lifecycle as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
      dependencies,
    });
  } catch (error: unknown) {
    thrown = error;
  }

  return {
    ...documentHarness,
    canary,
    calls,
    thrown,
    counts: () => ({
      storeCloseCount,
      httpDisposeCount,
      controllerDisposeCount,
      runtimeCleanupCount,
      viewDisposeCount,
    }),
  };
}

describe("G2 application shell", () => {
  it.each([
    ["http", {
      storeCloseCount: 1,
      httpDisposeCount: 0,
      controllerDisposeCount: 0,
      runtimeCleanupCount: 0,
      viewDisposeCount: 0,
    }],
    ["controller", {
      storeCloseCount: 1,
      httpDisposeCount: 1,
      controllerDisposeCount: 0,
      runtimeCleanupCount: 0,
      viewDisposeCount: 0,
    }],
    ["runtime", {
      storeCloseCount: 1,
      httpDisposeCount: 1,
      controllerDisposeCount: 1,
      runtimeCleanupCount: 0,
      viewDisposeCount: 0,
    }],
    ["view", {
      storeCloseCount: 1,
      httpDisposeCount: 1,
      controllerDisposeCount: 1,
      runtimeCleanupCount: 1,
      viewDisposeCount: 0,
    }],
    ["render", {
      storeCloseCount: 1,
      httpDisposeCount: 1,
      controllerDisposeCount: 1,
      runtimeCleanupCount: 1,
      viewDisposeCount: 1,
    }],
  ] as const)(
    "rolls back exact ownership after %s construction failure",
    (stage, expectedCounts) => {
      const harness = createConstructionFailureHarness(stage);
      expect(harness.thrown).toBeInstanceOf(Error);
      expect((harness.thrown as Error).message).toBe("Authentication is unavailable.");
      expect(JSON.stringify(harness.thrown)).not.toContain(harness.canary);
      expect(harness.counts()).toEqual(expectedCounts);
      expect(harness.status.textContent).toBe("Authentication is unavailable.");
      expect(harness.dataset.palancarStatus).toBe("startup-error");
      expect(harness.pairing.value).toBe("");
      expect(harness.pairing.attributes.has("value")).toBe(false);
    },
  );

  it("constructs committed owners in order and mounts starting before boot", async () => {
    const harness = createHarness();
    expect(harness.calls).toEqual([
      "credential-store",
      `http:${RELAY_ORIGIN}`,
      "controller",
      "runtime",
      "phone-view",
      "view.render:starting",
      "runtime.subscribe",
      "view.render:starting",
      "runtime.boot",
    ]);
    expect(harness.shell.snapshot).toEqual({ status: "starting" });
    expect(JSON.stringify(harness.shell.snapshot)).not.toContain(RELAY_ORIGIN);

    harness.boot.resolve();
    await harness.shell.ready;
    expect(harness.shell.snapshot).toEqual({ status: "running" });

    await harness.shell.dispose();
    expect(harness.counts()).toEqual({
      unsubscribeCount: 1,
      viewDisposeCount: 1,
      cleanupCount: 1,
      controllerDisposeCount: 1,
      httpDisposeCount: 1,
      storeCloseCount: 1,
    });
    expect(harness.calls.indexOf("runtime.cleanup")).toBeLessThan(
      harness.calls.indexOf("controller.dispose"),
    );
  });

  it("maps phone callbacks and redacted subscriptions without retaining a pairing code", async () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();

    await callbacks.onEnroll(PAIRING_CODE);
    await callbacks.onRetryStorage();
    await callbacks.onResetEnrollment();
    await callbacks.onRevoke();
    expect(harness.calls).toEqual(expect.arrayContaining([
      "runtime.enroll",
      "runtime.retry",
      "runtime.reset",
      "runtime.revoke",
    ]));

    harness.emit({ status: "required", reason: "pairing-uncertain" });
    harness.emit({ status: "storage-error" });
    harness.emit({ status: "ready" });
    expect(harness.rendered.slice(-3)).toEqual([
      { status: "required", reason: "pairing-uncertain" },
      { status: "storage-error" },
      { status: "ready" },
    ]);
    expect(JSON.stringify(harness.shell.snapshot)).not.toContain(PAIRING_CODE);

    harness.pairing.value = PAIRING_CODE;
    harness.pairing.setAttribute("value", PAIRING_CODE);
    harness.emit({ status: "error" });
    expect(harness.shell.snapshot).toEqual({ status: "failed" });
    expect(harness.status.textContent).toBe("Authentication is unavailable.");
    expect(harness.pairing.value).toBe("");
    expect(harness.pairing.attributes.has("value")).toBe(false);
    expect(JSON.stringify(harness.shell.snapshot)).not.toContain(PAIRING_CODE);

    harness.boot.resolve();
    await harness.shell.ready;
    await harness.shell.dispose();
    const callsBeforeDisposedCallback = harness.calls.length;
    await callbacks.onEnroll(PAIRING_CODE);
    expect(harness.calls).toHaveLength(callsBeforeDisposedCallback);
  });

  it("handles concurrent pagehide disposal exactly once and ignores late boot failure", async () => {
    const harness = createHarness({ pendingCleanup: true });
    harness.lifecycle.pageHide();
    harness.lifecycle.pageHide();
    const first = harness.shell.dispose();
    const second = harness.shell.dispose();
    expect(first).toBe(second);
    expect(harness.counts()).toMatchObject({
      unsubscribeCount: 1,
      viewDisposeCount: 1,
      cleanupCount: 1,
    });

    const canary = "BOOT-PAIRING-SECRET-CANARY";
    harness.boot.reject(new Error(canary));
    await harness.shell.ready;
    expect(harness.shell.snapshot).toEqual({ status: "disposed" });
    expect(harness.dataset.palancarStatus).toBeUndefined();
    expect(JSON.stringify(harness.shell.snapshot)).not.toContain(canary);

    harness.cleanup.resolve();
    await first;
    expect(harness.lifecycle.removeCount).toBe(1);
    expect(harness.counts()).toEqual({
      unsubscribeCount: 1,
      viewDisposeCount: 1,
      cleanupCount: 1,
      controllerDisposeCount: 1,
      httpDisposeCount: 1,
      storeCloseCount: 1,
    });
  });

  it("converts boot rejection to fixed content-free UI without logging the cause", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const harness = createHarness();
      const canary = `${PAIRING_CODE}-RAW-BOOT-ERROR`;
      harness.pairing.value = PAIRING_CODE;
      harness.pairing.setAttribute("value", PAIRING_CODE);
      harness.boot.reject(new Error(canary));

      await expect(harness.shell.ready).resolves.toBeUndefined();
      expect(harness.shell.snapshot).toEqual({ status: "failed" });
      expect(harness.status.textContent).toBe("Authentication is unavailable.");
      expect(harness.dataset.palancarStatus).toBe("startup-error");
      expect(harness.pairing.value).toBe("");
      expect(harness.pairing.attributes.has("value")).toBe(false);
      expect(JSON.stringify(harness.shell.snapshot)).not.toContain(canary);
      expect(harness.status.textContent).not.toContain(PAIRING_CODE);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      await harness.shell.dispose();
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
