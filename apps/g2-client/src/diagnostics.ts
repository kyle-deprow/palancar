export interface BootDiagnostic {
  readonly step: string;
  readonly outcome: "start" | "ok" | "fail";
  readonly detail?: string;
  readonly at: number;
}

let lastBootFailureStep: string | undefined;

export function getLastBootFailureStep(): string | undefined {
  if (!import.meta.env.DEV) return undefined;
  return lastBootFailureStep;
}

export function getBootDiagnosticDetail(error: unknown): string | undefined {
  if (!import.meta.env.DEV || !(error instanceof Error)) return undefined;
  try {
    return `${error.name}: ${error.message}`;
  } catch {
    return undefined;
  }
}

export function reportBootDiagnostic(value: BootDiagnostic): void {
  if (import.meta.env.DEV) {
    if (value.step === "target-storage-read" && value.outcome === "start") {
      lastBootFailureStep = undefined;
    }
    if (value.outcome === "fail") lastBootFailureStep = value.step;
    try {
      console.info("__palancar-diag", value);
      const body = JSON.stringify(value);
      let sent = false;
      try {
        const beacon = globalThis.navigator?.sendBeacon;
        if (typeof beacon === "function") {
          sent = beacon.call(
            globalThis.navigator,
            "/__palancar-diag",
            new Blob([body], { type: "application/json" }),
          );
        }
      } catch {
        sent = false;
      }
      if (!sent) {
        void fetch("/__palancar-diag", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => undefined);
      }
    } catch {
      // Diagnostics are best effort and must never affect boot.
    }
  }
}

if (import.meta.env.DEV) {
  reportBootDiagnostic({ step: "module-load", outcome: "ok", detail: "diagnostics module evaluated", at: Date.now() });
  try {
    globalThis.addEventListener?.("error", (event: unknown) => {
      const value = event as { message?: unknown; filename?: unknown; lineno?: unknown; error?: unknown };
      const from = value?.error instanceof Error
        ? `${value.error.name}: ${value.error.message}`
        : String(value?.message ?? "unknown");
      reportBootDiagnostic({
        step: "uncaught-error",
        outcome: "fail",
        detail: `${from} @ ${String(value?.filename ?? "?")}:${String(value?.lineno ?? "?")}`,
        at: Date.now(),
      });
    });
    globalThis.addEventListener?.("unhandledrejection", (event: unknown) => {
      const reason = (event as { reason?: unknown })?.reason;
      reportBootDiagnostic({
        step: "unhandled-rejection",
        outcome: "fail",
        detail: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
        at: Date.now(),
      });
    });
  } catch {
    // Global crash reporting is best effort and must never affect startup.
  }
}
