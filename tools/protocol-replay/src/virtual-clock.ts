export interface VirtualClockEvent {
  readonly atMs: number;
  readonly insertion: number;
}

interface ScheduledEvent extends VirtualClockEvent {
  readonly callback: () => void;
  cancelled: boolean;
}

export interface VirtualClock {
  readonly nowMs: number;
  readonly pendingCount: number;
  schedule(delayMs: number, callback: () => void): () => void;
  advanceBy(milliseconds: number): void;
  advanceTo(milliseconds: number): void;
}

function validTime(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value);
}

export function createVirtualClock(): VirtualClock {
  let nowMs = 0;
  let insertion = 0;
  const events: ScheduledEvent[] = [];

  const schedule = (delayMs: number, callback: () => void): (() => void) => {
    if (!validTime(delayMs) || typeof callback !== 'function') {
      throw new TypeError('Invalid virtual clock schedule');
    }
    const event: ScheduledEvent = {
      atMs: nowMs + delayMs,
      insertion,
      callback,
      cancelled: false
    };
    insertion += 1;
    events.push(event);
    return () => { event.cancelled = true; };
  };

  const advanceTo = (milliseconds: number): void => {
    if (!validTime(milliseconds) || milliseconds < nowMs) {
      throw new RangeError('Virtual clock cannot move backwards');
    }
    while (true) {
      events.sort((left, right) => left.atMs - right.atMs || left.insertion - right.insertion);
      const next = events.find((event) => !event.cancelled && event.atMs <= milliseconds);
      if (next === undefined) break;
      events.splice(events.indexOf(next), 1);
      nowMs = next.atMs;
      next.callback();
    }
    nowMs = milliseconds;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.cancelled === true) events.splice(index, 1);
    }
  };

  return Object.freeze({
    get nowMs() { return nowMs; },
    get pendingCount() { return events.filter((event) => !event.cancelled).length; },
    schedule,
    advanceBy: (milliseconds: number): void => {
      if (!validTime(milliseconds)) throw new RangeError('Invalid virtual clock advance');
      advanceTo(nowMs + milliseconds);
    },
    advanceTo
  });
}
