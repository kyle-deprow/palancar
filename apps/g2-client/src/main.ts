import { createG2AuthController, type G2AuthControllerOptions } from "./auth/controller.js";
import {
  createCredentialStore,
  type CredentialStore,
} from "./auth/credential-store.js";
import {
  createAuthHttpClient,
  type AuthHttpClient,
  type AuthHttpClientOptions,
} from "./auth/http-client.js";
import type { G2AuthController } from "./auth/types.js";
import {
  G2BridgeRuntime,
  type G2BridgeRuntimeOptions,
  type G2PhoneAuthState,
  type G2PhoneAuthStateListener,
} from "./bridge/index.js";
import {
  createPhoneAuthView,
  type PhoneAuthView,
  type PhoneAuthViewCallbacks,
  type PhoneAuthViewState,
} from "./phone-ui.js";
import {
  getBootDiagnosticDetail,
  getLastBootFailureStep,
  reportBootDiagnostic,
} from "./diagnostics.js";

declare const __PALANCAR_RELAY_ORIGIN__: string;

const FIXED_SHELL_ERROR_COPY = "Authentication is unavailable.";

export type G2ApplicationShellStatus = "starting" | "running" | "failed" | "disposed";

export interface G2ApplicationShellSnapshot {
  readonly status: G2ApplicationShellStatus;
}

export interface G2ApplicationShell {
  readonly ready: Promise<void>;
  readonly snapshot: G2ApplicationShellSnapshot;
  dispose(): Promise<void>;
}

export interface G2ApplicationRuntime {
  boot(): Promise<void>;
  enroll(pairingCode: string): Promise<void>;
  retryEnrollment(): Promise<void>;
  resetEnrollment(): Promise<void>;
  revokeEnrollment(): Promise<void>;
  subscribePhoneAuthState(listener: G2PhoneAuthStateListener): () => void;
  cleanup(): Promise<void>;
}

export interface G2ApplicationShellDependencies {
  readonly createCredentialStore: () => CredentialStore;
  readonly createAuthHttpClient: (options: AuthHttpClientOptions) => AuthHttpClient;
  readonly createAuthController: (options: G2AuthControllerOptions) => G2AuthController;
  readonly createRuntime: (options: G2BridgeRuntimeOptions) => G2ApplicationRuntime;
  readonly createPhoneView: (options: {
    readonly document: Document;
    readonly callbacks: PhoneAuthViewCallbacks;
  }) => PhoneAuthView;
}

export interface G2ApplicationShellOptions {
  readonly relayOrigin: string;
  readonly document: Document;
  readonly lifecycleTarget: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly dependencies?: G2ApplicationShellDependencies;
}

const DEFAULT_DEPENDENCIES: G2ApplicationShellDependencies = Object.freeze({
  createCredentialStore: () => createCredentialStore(),
  createAuthHttpClient,
  createAuthController: createG2AuthController,
  createRuntime: (options: G2BridgeRuntimeOptions) => new G2BridgeRuntime(options),
  createPhoneView: createPhoneAuthView,
});

function getElement(documentValue: Document, id: string): HTMLElement | undefined {
  try {
    return documentValue.getElementById(id) ?? undefined;
  } catch {
    return undefined;
  }
}

function clearPairingCode(documentValue: Document): void {
  const element = getElement(documentValue, "palancar-pairing-code");
  if (element === undefined) return;
  const input = element as HTMLElement & { value?: unknown };
  if (typeof input.value === "string") input.value = "";
  try {
    element.removeAttribute("value");
  } catch {
    // Fixed failure rendering remains best-effort on a damaged DOM.
  }
}

function renderFixedShellError(documentValue: Document): void {
  clearPairingCode(documentValue);
  const status = getElement(documentValue, "palancar-auth-status");
  if (status !== undefined) status.textContent = FIXED_SHELL_ERROR_COPY;
  try {
    documentValue.documentElement.dataset.palancarStatus = "startup-error";
  } catch {
    // The shell never exposes a platform error through phone UI or logging.
  }
}

function disposeStore(store: CredentialStore | undefined): void {
  try {
    store?.close();
  } catch {
    // Construction rollback is fixed and content-free.
  }
}

function disposeHttp(http: AuthHttpClient | undefined): void {
  try {
    http?.dispose();
  } catch {
    // Construction rollback is fixed and content-free.
  }
}

function disposeController(controller: G2AuthController | undefined): void {
  try {
    controller?.dispose();
  } catch {
    // The controller remains the sole owner of its HTTP client and store.
  }
}

function triggerRuntimeCleanup(runtime: G2ApplicationRuntime): void {
  try {
    void Promise.resolve(runtime.cleanup()).catch(() => undefined);
  } catch {
    // Runtime-owned resources remain behind one content-free cleanup attempt.
  }
}

function fixedConstructionFailure(documentValue: Document): never {
  renderFixedShellError(documentValue);
  throw new Error(FIXED_SHELL_ERROR_COPY);
}

function renderPhoneState(
  view: PhoneAuthView,
  documentValue: Document,
  state: G2PhoneAuthState,
): boolean {
  if (state.status === "error") {
    try {
      view.render({ status: "starting" });
    } catch {
      // The fixed shell state below is independent from view rendering.
    }
    renderFixedShellError(documentValue);
    return false;
  }
  view.render(state as PhoneAuthViewState);
  return true;
}

export function startG2ApplicationShell(options: G2ApplicationShellOptions): G2ApplicationShell {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  let store: CredentialStore | undefined;
  let http: AuthHttpClient | undefined;
  let authController: G2AuthController | undefined;
  let runtime: G2ApplicationRuntime | undefined;
  try {
    store = dependencies.createCredentialStore();
    http = dependencies.createAuthHttpClient({ relayOrigin: options.relayOrigin });
    authController = dependencies.createAuthController({ store, http });
    runtime = dependencies.createRuntime({
      relayOrigin: options.relayOrigin,
      authController,
    });
  } catch {
    if (runtime !== undefined) {
      triggerRuntimeCleanup(runtime);
    } else if (authController !== undefined) {
      disposeController(authController);
    } else {
      disposeHttp(http);
      disposeStore(store);
    }
    fixedConstructionFailure(options.document);
  }

  let status: G2ApplicationShellStatus = "starting";
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let disposePromise: Promise<void> | undefined;
  let view: PhoneAuthView | undefined;

  const callbacks: PhoneAuthViewCallbacks = Object.freeze({
    onEnroll: (pairingCode: string) => disposed ? undefined : runtime.enroll(pairingCode),
    onRetryStorage: () => disposed ? undefined : runtime.retryEnrollment(),
    onResetEnrollment: () => disposed ? undefined : runtime.resetEnrollment(),
    onRevoke: () => disposed ? undefined : runtime.revokeEnrollment(),
  });
  try {
    view = dependencies.createPhoneView({
      document: options.document,
      callbacks,
    });
    view.render({ status: "starting" });
    unsubscribe = runtime.subscribePhoneAuthState((phoneState) => {
      if (disposed) return;
      try {
        if (!renderPhoneState(view!, options.document, phoneState)) status = "failed";
      } catch {
        status = "failed";
        renderFixedShellError(options.document);
      }
    });
  } catch {
    disposed = true;
    try {
      unsubscribe?.();
    } catch {
      // Runtime cleanup remains the authentication owner.
    }
    try {
      view?.dispose();
    } catch {
      // Runtime cleanup remains the authentication owner.
    }
    triggerRuntimeCleanup(runtime);
    fixedConstructionFailure(options.document);
  }

  const dispose = (): Promise<void> => {
    const existing = disposePromise;
    if (existing !== undefined) return existing;
    disposed = true;
    status = "disposed";
    disposePromise = (async () => {
      try {
        options.lifecycleTarget.removeEventListener("pagehide", onPageHide);
      } catch {
        // Cleanup continues through all owners.
      }
      const stopPhoneState = unsubscribe;
      unsubscribe = undefined;
      try {
        stopPhoneState?.();
      } catch {
        // Cleanup continues through all owners.
      }
      try {
        view.dispose();
      } catch {
        // Runtime cleanup still owns authentication resources.
      }
      try {
        await runtime.cleanup();
      } catch {
        // Disposal is fixed and content-free at the shell boundary.
      }
    })();
    return disposePromise;
  };

  const onPageHide: EventListener = () => {
    void dispose();
  };
  try {
    options.lifecycleTarget.addEventListener("pagehide", onPageHide);
  } catch {
    disposed = true;
    try {
      unsubscribe?.();
    } catch {
      // Runtime cleanup remains the authentication owner.
    }
    try {
      view.dispose();
    } catch {
      // Runtime cleanup remains the authentication owner.
    }
    triggerRuntimeCleanup(runtime);
    fixedConstructionFailure(options.document);
  }

  let bootResult: Promise<void>;
  try {
    bootResult = runtime.boot();
  } catch {
    bootResult = Promise.reject(new Error(FIXED_SHELL_ERROR_COPY));
  }
  const ready = Promise.resolve(bootResult).then(
    () => {
      if (!disposed && status === "starting") status = "running";
    },
    (error: unknown) => {
      if (disposed) return;
      status = "failed";
      try {
        view.render({ status: "starting" });
      } catch {
        // The fixed shell state below is independent from view rendering.
      }
      const failingStep = getLastBootFailureStep();
      const detail = getBootDiagnosticDetail(error);
      reportBootDiagnostic(detail === undefined
        ? { step: "shell-boot", outcome: "fail", at: Date.now() }
        : { step: "shell-boot", outcome: "fail", detail, at: Date.now() });
      renderFixedShellError(options.document);
      if (import.meta.env.DEV) {
        try {
          options.document.documentElement.dataset.palancarDiagStep = failingStep ?? "shell-boot";
        } catch {
          // Dev diagnostics remain best-effort on a damaged DOM.
        }
      }
    },
  );

  return Object.freeze({
    ready,
    get snapshot(): G2ApplicationShellSnapshot {
      return Object.freeze({ status });
    },
    dispose,
  });
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  try {
    startG2ApplicationShell({
      relayOrigin: __PALANCAR_RELAY_ORIGIN__,
      document,
      lifecycleTarget: window,
    });
  } catch {
    renderFixedShellError(document);
  }
}
