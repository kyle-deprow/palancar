import { afterEach, describe, expect, it, vi } from "vitest";

import { reportBootDiagnostic } from "../src/diagnostics.js";

describe("boot diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("logs and posts a diagnostic without propagating fetch failures", () => {
    const diagnostic = {
      step: "bridge-wait",
      outcome: "fail" as const,
      detail: "Error: bridge unavailable",
      at: 123,
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetch = vi.fn().mockRejectedValue(new Error("dev server unavailable"));
    vi.stubGlobal("fetch", fetch);

    expect(() => reportBootDiagnostic(diagnostic)).not.toThrow();
    expect(info).toHaveBeenCalledWith("__palancar-diag", diagnostic);
    expect(fetch).toHaveBeenCalledWith("/__palancar-diag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify(diagnostic),
    });
  });
});

it("prefers sendBeacon and does not fall back to fetch when it succeeds", () => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const fetchSpy = vi.fn();
  const sendBeacon = vi.fn().mockReturnValue(true);
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("navigator", { sendBeacon });

  reportBootDiagnostic({ step: "bridge-wait", outcome: "ok", at: 7 });

  expect(sendBeacon).toHaveBeenCalledTimes(1);
  expect(sendBeacon.mock.calls[0]?.[0]).toBe("/__palancar-diag");
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("falls back to fetch when sendBeacon reports failure", () => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const fetchSpy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("navigator", { sendBeacon: vi.fn().mockReturnValue(false) });

  reportBootDiagnostic({ step: "bridge-wait", outcome: "ok", at: 7 });

  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
