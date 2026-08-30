import { describe, expect, it, vi } from "vitest";

import {
  DISPLAY_HEIGHT,
  DISPLAY_STATES,
  DISPLAY_WIDTH,
  DisplaySchedulerCancelledError,
  DisplayUpdateFailedError,
  DisplayUpdateValidationError,
  PAGE_LAYOUTS,
  SerializedLatestUpdateScheduler,
  type ImmutablePageLayout,
  type SchedulerClock,
  type TextUpgrade,
  type TextUpgradeTarget,
  validatePageLayout,
} from "../src/display/index.js";
import { displayTexts } from "../src/bridge/runtime.js";
import type { ClientState } from "../src/state/index.js";

const replaceLayout = (
  layout: ImmutablePageLayout,
  replacement: Partial<ImmutablePageLayout>,
): ImmutablePageLayout => ({ ...layout, ...replacement });

const omitZOrder = <Container extends { readonly zOrderIndex?: number }>(
  container: Container,
): Omit<Container, "zOrderIndex"> => {
  const { zOrderIndex, ...withoutZOrder } = container;
  void zOrderIndex;
  return withoutZOrder;
};

class FakeClock implements SchedulerClock {
  readonly delays: number[] = [];
  #scheduled: { callback: () => void; cancelled: boolean }[] = [];

  schedule(callback: () => void, delayMs: number): () => void {
    const entry = { callback, cancelled: false };
    this.delays.push(delayMs);
    this.#scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  fireNext(): void {
    const entry = this.#scheduled.shift();
    if (entry !== undefined && !entry.cancelled) entry.callback();
  }

  fireAll(): void {
    while (this.#scheduled.length > 0) this.fireNext();
  }
}

const TEXT_TARGET = Object.freeze({ containerID: 6, containerName: "hint" });
const textUpdate = (
  content: string,
  target: TextUpgradeTarget = TEXT_TARGET,
): TextUpgrade => ({
  ...target,
  content,
});

describe("G2 page layouts", () => {
  it("does not expose a recovering layout", () => {
    expect(DISPLAY_STATES).toEqual([
      "Starting",
      "TargetSelection",
      "Ready",
      "Listening",
      "Finalizing",
      "Translating",
      "Results",
      "Error",
    ]);
    expect("Recovering" in PAGE_LAYOUTS).toBe(false);
  });

  it.each(DISPLAY_STATES)("validates the immutable %s layout", (state) => {
    const layout = PAGE_LAYOUTS[state];
    expect(validatePageLayout(layout)).toEqual({ valid: true, errors: [] });
    expect(Object.isFrozen(layout)).toBe(true);
    expect(Object.isFrozen(layout.textObject)).toBe(true);
    expect(layout.textObject.every(Object.isFrozen)).toBe(true);
  });

  it("keeps stable regions and a quiet, label-free hierarchy", () => {
    const expectedRegions = ["status", "target", "source", "english", "translated", "hint"];
    for (const state of DISPLAY_STATES) {
      const layout = PAGE_LAYOUTS[state];
      expect(layout.textObject.map((region) => region.containerName)).toEqual(expectedRegions);
      expect(layout.textObject.map(({ xPosition, yPosition, width, height }) => [xPosition, yPosition, width, height])).toEqual(
        PAGE_LAYOUTS.Starting.textObject.map(({ xPosition, yPosition, width, height }) => [xPosition, yPosition, width, height]),
      );
      expect(layout.textObject.map((region) => region.content).some((content) => /(?:Source|English|Target|Suggestion|Status):/.test(content))).toBe(false);
    }
    expect(PAGE_LAYOUTS.TargetSelection.textObject[4]?.content).toContain("[ES]");
    expect(PAGE_LAYOUTS.TargetSelection.textObject[4]?.content).toContain("TR");
    expect(PAGE_LAYOUTS.Error.textObject[5]?.content).toBe("Restart app");
    expect(PAGE_LAYOUTS.Starting.textObject.map(({ textColor, paddingLength }) => [textColor, paddingLength])).toEqual([
      [1, 2],
      [1, 2],
      [2, 4],
      [2, 4],
      [4, 6],
      [1, 4],
    ]);
  });

  it("keeps regions non-overlapping and inside the 576x288 display", () => {
    for (const state of DISPLAY_STATES) {
      const regions = PAGE_LAYOUTS[state].textObject;
      for (let index = 0; index < regions.length; index += 1) {
        const region = regions[index];
        if (region === undefined) continue;
        expect(region.xPosition).toBeGreaterThanOrEqual(0);
        expect(region.yPosition).toBeGreaterThanOrEqual(0);
        expect(region.xPosition + region.width).toBeLessThanOrEqual(DISPLAY_WIDTH);
        expect(region.yPosition + region.height).toBeLessThanOrEqual(DISPLAY_HEIGHT);
        for (const other of regions.slice(index + 1)) {
          expect(
            region.xPosition < other.xPosition + other.width &&
              region.xPosition + region.width > other.xPosition &&
              region.yPosition < other.yPosition + other.height &&
              region.yPosition + region.height > other.yPosition,
          ).toBe(false);
        }
      }
    }
  });

  it("uses brightness 4 for at most one region per state", () => {
    for (const state of DISPLAY_STATES) {
      expect(PAGE_LAYOUTS[state].textObject.filter((region) => region.textColor === 4)).toHaveLength(1);
    }
  });

  it("returns one label-free string per region for every client state variant", () => {
    const activeTurn = {
      targetLanguage: "es" as const,
      authAttempt: 1,
      sessionId: "11111111-1111-4111-8111-111111111111",
      sessionEpoch: 1,
      utteranceId: "22222222-2222-4222-8222-222222222222",
      turn: 1,
      transcript: "hola",
      segmentTexts: {},
      segmentRevisions: {},
      finalSegments: {},
    } as const;
    const variants = [
      { state: "Starting", type: "Starting", highlightedTarget: "es", authAttempt: 0 },
      { state: "EnrollmentChecking", type: "EnrollmentChecking", highlightedTarget: "es", authAttempt: 0, phase: "checking" },
      { state: "EnrollmentRequired", type: "EnrollmentRequired", highlightedTarget: "es", authAttempt: 0, reason: "missing" },
      { state: "Enrolling", type: "Enrolling", highlightedTarget: "es", authAttempt: 0 },
      { state: "StorageError", type: "StorageError", highlightedTarget: "es", authAttempt: 0 },
      { state: "TargetSelection", type: "TargetSelection", highlightedTarget: "es", authAttempt: 0 },
      { state: "Ready", type: "Ready", targetLanguage: "es", authAttempt: 0, turn: 0, sessionReady: false, pending: "initial" },
      { ...activeTurn, state: "Listening", type: "Listening" },
      { ...activeTurn, state: "Finalizing", type: "Finalizing" },
      { ...activeTurn, state: "Translating", type: "Translating", suggestions: [], suggestionIndex: 0 },
      { ...activeTurn, state: "Results", type: "Results", englishTranslation: "hello", suggestions: [{ englishText: "hello", selectedTargetText: "hola" }], suggestionIndex: 0 },
      { state: "Error", type: "Error", message: "Something went wrong", terminal: true, targetLanguage: "es" },
    ] as const satisfies readonly ClientState[];

    for (const state of variants) {
      const texts = displayTexts(state);
      expect(texts).toHaveLength(PAGE_LAYOUTS.Starting.textObject.length);
      expect(texts.every((text) => !/(?:Source|English|Target|Suggestion|Status):/.test(text))).toBe(true);
    }
  });

  it("enforces count, identity, bounds, capture, content, and z-order invariants", () => {
    const base = PAGE_LAYOUTS.Starting;
    const first = base.textObject[0];
    const second = base.textObject[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    const invalidLayouts: ImmutablePageLayout[] = [
      replaceLayout(base, { containerTotalNum: 4 }),
      replaceLayout(base, { textObject: [...base.textObject, ...base.textObject, ...base.textObject] }),
      replaceLayout(base, { imageObject: Array.from({ length: 8 }, (_, index) => ({ containerID: 20 + index, containerName: `image${index}`, xPosition: 0, yPosition: 0, width: 20, height: 20, zOrderIndex: 20 + index })) }),
      replaceLayout(base, { textObject: [{ ...first, containerID: second.containerID }, ...base.textObject.slice(1)] }),
      replaceLayout(base, { textObject: [{ ...first, containerName: second.containerName }, ...base.textObject.slice(1)] }),
      replaceLayout(base, { textObject: [{ ...first, containerName: "12345678901234567" }, ...base.textObject.slice(1)] }),
      replaceLayout(base, { textObject: [{ ...first, xPosition: DISPLAY_WIDTH }, ...base.textObject.slice(1)] }),
      replaceLayout(base, { textObject: [{ ...first, yPosition: DISPLAY_HEIGHT }, ...base.textObject.slice(1)] }),
      replaceLayout(base, { textObject: base.textObject.map((region) => ({ ...region, isEventCapture: 0 })) }),
      replaceLayout(base, { textObject: [{ ...first, content: "x".repeat(1_001) }, ...base.textObject.slice(1)] }),
      replaceLayout(base, { textObject: [omitZOrder(first), ...base.textObject.slice(1)] }),
      replaceLayout(base, { textObject: [{ ...first, zOrderIndex: second.zOrderIndex ?? 2 }, ...base.textObject.slice(1)] }),
    ];
    for (const layout of invalidLayouts) expect(validatePageLayout(layout).valid).toBe(false);
  });

  it("accepts all-omitted z-order and counts list capture/content limits", () => {
    const base = PAGE_LAYOUTS.Starting;
    const withoutZ = replaceLayout(base, {
      textObject: base.textObject.map(omitZOrder),
    });
    expect(validatePageLayout(withoutZ).valid).toBe(true);

    const listLayout = replaceLayout(base, {
      containerTotalNum: 1,
      textObject: [],
      listObject: [{
        containerID: 9,
        containerName: "targets",
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        isEventCapture: 1,
        itemContainer: { itemCount: 2, itemName: ["Spanish", "Turkish"] },
      }],
    });
    expect(validatePageLayout(listLayout).valid).toBe(true);
    const badList = replaceLayout(listLayout, {
      listObject: [{ ...listLayout.listObject[0]!, itemContainer: { itemCount: 1, itemName: ["x".repeat(65), "Turkish"] } }],
    });
    expect(validatePageLayout(badList).valid).toBe(false);
  });

  it("enforces SDK image count and dimensions", () => {
    const base = PAGE_LAYOUTS.Starting;
    const image = (index: number, width = 20, height = 20) => ({
      containerID: 10 + index,
      containerName: `image${index}`,
      xPosition: 0,
      yPosition: 0,
      width,
      height,
      zOrderIndex: 10 + index,
    });
    const tooMany = replaceLayout(base, {
      containerTotalNum: 10,
      imageObject: Array.from({ length: 5 }, (_, index) => image(index)),
    });
    expect(validatePageLayout(tooMany).errors).toContain("image container count exceeds 4");

    for (const [width, height] of [[19, 20], [289, 20], [20, 19], [20, 145]]) {
      const invalidDimensions = replaceLayout(base, {
        containerTotalNum: 6,
        imageObject: [image(0, width, height)],
      });
      expect(validatePageLayout(invalidDimensions).valid).toBe(false);
    }
    const maximumDimensions = replaceLayout(base, {
      containerTotalNum: 7,
      imageObject: [image(0, 288, 144)],
    });
    expect(validatePageLayout(maximumDimensions).valid).toBe(true);
  });
});

describe("SerializedLatestUpdateScheduler", () => {
  it("uses 175ms by default and coalesces a burst to the latest update", async () => {
    const clock = new FakeClock();
    const sink = vi.fn(async () => true);
    const scheduler = new SerializedLatestUpdateScheduler(sink, { clock, target: TEXT_TARGET });
    const first = scheduler.schedule(textUpdate("first"));
    const second = scheduler.schedule(textUpdate("second"));
    const third = scheduler.schedule(textUpdate("latest"));
    expect(clock.delays).toEqual([175, 175, 175]);
    clock.fireAll();
    await Promise.all([first, second, third]);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(textUpdate("latest"));
  });

  it("keeps one running and one replaceable pending update without concurrent sinks", async () => {
    const clock = new FakeClock();
    let releaseFirst: (() => void) | undefined;
    let active = 0;
    let maximumActive = 0;
    const calls: string[] = [];
    const scheduler = new SerializedLatestUpdateScheduler(async (update: TextUpgrade) => {
      calls.push(update.content);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (update.content === "A") await new Promise<void>((resolve) => { releaseFirst = resolve; });
      active -= 1;
      return true;
    }, { clock, target: TEXT_TARGET });

    const first = scheduler.schedule(textUpdate("A"));
    clock.fireNext();
    await Promise.resolve();
    const second = scheduler.schedule(textUpdate("B"));
    clock.fireNext();
    await Promise.resolve();
    const third = scheduler.schedule(textUpdate("C"));
    clock.fireNext();
    await Promise.resolve();
    expect(calls).toEqual(["A"]);
    let idle = false;
    const idleResult = scheduler.whenIdle().then(() => { idle = true; });
    expect(idle).toBe(false);
    releaseFirst?.();
    await Promise.all([first, second, third, idleResult]);
    expect(calls).toEqual(["A", "C"]);
    expect(maximumActive).toBe(1);
    expect(idle).toBe(true);
  });

  it("whenIdle waits for the debounce timer and sink completion", async () => {
    const clock = new FakeClock();
    let releaseSink: (() => void) | undefined;
    const scheduler = new SerializedLatestUpdateScheduler(async () => {
      await new Promise<void>((resolve) => { releaseSink = resolve; });
      return true;
    }, { clock, target: TEXT_TARGET });
    const scheduled = scheduler.schedule(textUpdate("pending"));
    let idle = false;
    const idleResult = scheduler.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    clock.fireNext();
    await Promise.resolve();
    expect(idle).toBe(false);
    releaseSink?.();
    await Promise.all([scheduled, idleResult]);
    expect(idle).toBe(true);
  });

  it("rejects target mismatches and oversized text before calling the sink", async () => {
    const clock = new FakeClock();
    const sink = vi.fn(async () => true);
    const scheduler = new SerializedLatestUpdateScheduler(sink, { clock, target: TEXT_TARGET });
    await expect(scheduler.schedule(textUpdate("wrong id", { ...TEXT_TARGET, containerID: 4 }))).rejects.toBeInstanceOf(DisplayUpdateValidationError);
    await expect(scheduler.schedule(textUpdate("wrong name", { ...TEXT_TARGET, containerName: "status" }))).rejects.toBeInstanceOf(DisplayUpdateValidationError);
    await expect(scheduler.schedule(textUpdate("x".repeat(2_001)))).rejects.toBeInstanceOf(DisplayUpdateValidationError);
    expect(sink).not.toHaveBeenCalled();
    expect(clock.delays).toEqual([]);
    expect(() => new SerializedLatestUpdateScheduler(sink, {
      clock,
      target: { containerID: 17, containerName: "suggestion" },
    })).toThrow(DisplayUpdateValidationError);
    expect(() => new SerializedLatestUpdateScheduler(sink, {
      clock,
      target: { containerID: 5, containerName: "12345678901234567" },
    })).toThrow(DisplayUpdateValidationError);
  });

  it("surfaces false results and thrown sink failures", async () => {
    const falseClock = new FakeClock();
    const falseScheduler = new SerializedLatestUpdateScheduler(async () => false, { clock: falseClock, target: TEXT_TARGET });
    const falseResult = falseScheduler.schedule(textUpdate("update"));
    falseClock.fireNext();
    await expect(falseResult).rejects.toBeInstanceOf(DisplayUpdateFailedError);

    const thrown = new Error("sink unavailable");
    const throwClock = new FakeClock();
    const throwScheduler = new SerializedLatestUpdateScheduler(async () => { throw thrown; }, { clock: throwClock, target: TEXT_TARGET });
    const throwResult = throwScheduler.schedule(textUpdate("update"));
    throwClock.fireNext();
    await expect(throwResult).rejects.toBe(thrown);
  });

  it("recovers from a synchronously throwing sink and settles pending work and idle", async () => {
    const clock = new FakeClock();
    const thrown = new Error("synchronous sink failure");
    const calls: string[] = [];
    const sink = (update: TextUpgrade): Promise<boolean> => {
      calls.push(update.content);
      if (update.content === "broken") throw thrown;
      return Promise.resolve(true);
    };
    const scheduler = new SerializedLatestUpdateScheduler(sink, {
      clock,
      target: TEXT_TARGET,
    });

    const broken = scheduler.schedule(textUpdate("broken"));
    clock.fireNext();
    const recovery = scheduler.schedule(textUpdate("recovery"));
    clock.fireNext();
    let idle = false;
    const idleResult = scheduler.whenIdle().then(() => { idle = true; });

    await expect(broken).rejects.toBe(thrown);
    await Promise.all([recovery, idleResult]);
    expect(calls).toEqual(["broken", "recovery"]);
    expect(idle).toBe(true);
    await expect(scheduler.whenIdle()).resolves.toBeUndefined();
  });

  it("cancels pending work, rejects future work, and cleans up idempotently", async () => {
    const clock = new FakeClock();
    const sink = vi.fn(async () => true);
    const scheduler = new SerializedLatestUpdateScheduler(sink, { clock, target: TEXT_TARGET });
    const pending = scheduler.schedule(textUpdate("pending"));
    const firstCleanup = scheduler.cleanup();
    const secondCleanup = scheduler.cleanup();
    expect(secondCleanup).toBe(firstCleanup);
    await expect(pending).rejects.toBeInstanceOf(DisplaySchedulerCancelledError);
    clock.fireAll();
    await firstCleanup;
    expect(sink).not.toHaveBeenCalled();
    await expect(scheduler.schedule(textUpdate("late"))).rejects.toBeInstanceOf(DisplaySchedulerCancelledError);
  });
});
