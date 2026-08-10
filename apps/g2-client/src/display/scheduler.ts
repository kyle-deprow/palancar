export interface SchedulerClock {
  schedule(callback: () => void, delayMs: number): () => void;
}

export const SYSTEM_SCHEDULER_CLOCK: SchedulerClock = Object.freeze({
  schedule(callback: () => void, delayMs: number): () => void {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
});

export interface TextUpgrade {
  readonly containerID: number;
  readonly containerName: string;
  readonly content: string;
}

export interface TextUpgradeTarget {
  readonly containerID: number;
  readonly containerName: string;
}

export interface LatestUpdateSchedulerOptions {
  readonly target: TextUpgradeTarget;
  readonly delayMs?: number;
  readonly clock?: SchedulerClock;
}

export class DisplayUpdateFailedError extends Error {
  constructor() {
    super("Display text update returned false");
    this.name = "DisplayUpdateFailedError";
  }
}

export class DisplayUpdateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisplayUpdateValidationError";
  }
}

export class DisplaySchedulerCancelledError extends Error {
  constructor() {
    super("Display text update scheduler is cancelled");
    this.name = "DisplaySchedulerCancelledError";
  }
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

interface UpdateBatch<Update> {
  readonly update: Update;
  readonly waiters: readonly Waiter[];
}

interface DebouncedBatch<Update> extends UpdateBatch<Update> {
  readonly cancelTimer: () => void;
}

export class SerializedLatestUpdateScheduler<Update extends TextUpgrade> {
  static readonly DEFAULT_DELAY_MS = 175;
  static readonly MAX_TEXT_LENGTH = 2_000;

  readonly #sink: (update: Update) => Promise<boolean>;
  readonly #target: TextUpgradeTarget;
  readonly #delayMs: number;
  readonly #clock: SchedulerClock;
  #debounced: DebouncedBatch<Update> | undefined;
  #pending: UpdateBatch<Update> | undefined;
  #running = false;
  #cancelled = false;
  #cleanupPromise: Promise<void> | undefined;
  #idleWaiters: Waiter[] = [];

  constructor(
    sink: (update: Update) => Promise<boolean>,
    options: LatestUpdateSchedulerOptions,
  ) {
    const delayMs = options.delayMs ?? SerializedLatestUpdateScheduler.DEFAULT_DELAY_MS;
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError("delayMs must be non-negative");
    this.#validateTarget(options.target);
    this.#sink = sink;
    this.#target = Object.freeze({ ...options.target });
    this.#delayMs = delayMs;
    this.#clock = options.clock ?? SYSTEM_SCHEDULER_CLOCK;
  }

  schedule(update: Update): Promise<void> {
    if (this.#cancelled) return Promise.reject(new DisplaySchedulerCancelledError());
    try {
      this.#validateUpdate(update);
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    const result = new Promise<void>((resolve, reject) => {
      const waiters: Waiter[] = [{ resolve, reject }];
      if (this.#debounced !== undefined) {
        this.#debounced.cancelTimer();
        waiters.unshift(...this.#debounced.waiters);
        this.#debounced = undefined;
      }
      if (this.#pending !== undefined) {
        waiters.unshift(...this.#pending.waiters);
        this.#pending = undefined;
      }

      const cancelTimer = this.#clock.schedule(() => this.#flushDebounced(), this.#delayMs);
      this.#debounced = { update, waiters, cancelTimer };
    });
    return result;
  }

  cleanup(): Promise<void> {
    if (this.#cleanupPromise !== undefined) return this.#cleanupPromise;
    this.#cancelled = true;
    const error = new DisplaySchedulerCancelledError();
    if (this.#debounced !== undefined) {
      this.#debounced.cancelTimer();
      this.#reject(this.#debounced.waiters, error);
      this.#debounced = undefined;
    }
    if (this.#pending !== undefined) {
      this.#reject(this.#pending.waiters, error);
      this.#pending = undefined;
    }
    this.#cleanupPromise = this.whenIdle();
    this.#notifyIfIdle();
    return this.#cleanupPromise;
  }

  whenIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.#idleWaiters.push({ resolve, reject });
    });
  }

  #flushDebounced(): void {
    const debounced = this.#debounced;
    this.#debounced = undefined;
    if (debounced === undefined) {
      this.#notifyIfIdle();
      return;
    }
    const batch: UpdateBatch<Update> = {
      update: debounced.update,
      waiters:
        this.#pending === undefined
          ? debounced.waiters
          : [...this.#pending.waiters, ...debounced.waiters],
    };
    if (this.#running) {
      this.#pending = batch;
      return;
    }
    this.#run(batch);
  }

  #run(batch: UpdateBatch<Update>): void {
    this.#running = true;
    const operation = Promise.resolve()
      .then(() => {
        if (this.#cancelled) throw new DisplaySchedulerCancelledError();
        return this.#sink(batch.update);
      })
      .then((success) => {
        if (!success) throw new DisplayUpdateFailedError();
      });

    void operation.then(
      () => this.#resolve(batch.waiters),
      (error: unknown) => this.#reject(batch.waiters, error),
    ).then(() => {
      this.#running = false;
      const next = this.#pending;
      this.#pending = undefined;
      if (next !== undefined) this.#run(next);
      else this.#notifyIfIdle();
    });
  }

  #validateTarget(target: TextUpgradeTarget): void {
    if (!Number.isInteger(target.containerID) || target.containerID < 1 || target.containerID > 16) {
      throw new DisplayUpdateValidationError("Target containerID must be an integer from 1 to 16");
    }
    if (target.containerName.length < 1 || target.containerName.length > 16) {
      throw new DisplayUpdateValidationError("Target containerName must contain 1 to 16 characters");
    }
  }

  #validateUpdate(update: Update): void {
    if (
      update.containerID !== this.#target.containerID ||
      update.containerName !== this.#target.containerName
    ) {
      throw new DisplayUpdateValidationError("Text update does not match the configured container");
    }
    if (update.content.length > SerializedLatestUpdateScheduler.MAX_TEXT_LENGTH) {
      throw new DisplayUpdateValidationError("Text update content exceeds 2000 characters");
    }
  }

  #isIdle(): boolean {
    return !this.#running && this.#debounced === undefined && this.#pending === undefined;
  }

  #notifyIfIdle(): void {
    if (!this.#isIdle()) return;
    this.#resolve(this.#idleWaiters.splice(0));
  }

  #resolve(waiters: readonly Waiter[]): void {
    for (const waiter of waiters) waiter.resolve();
  }

  #reject(waiters: readonly Waiter[], error: unknown): void {
    for (const waiter of waiters) waiter.reject(error);
  }
}
