import { spikeFailure } from './errors.js';

export interface MonotonicNanosecondClock {
  nowNs(): bigint;
  toUtcTimestamp(monotonicNs: bigint): string;
}

export interface SpikeScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export function nanosecondsToMilliseconds(durationNs: bigint): number {
  if (durationNs < 0n) spikeFailure('invalid-input');
  const milliseconds = Number(durationNs) / 1_000_000;
  if (!Number.isFinite(milliseconds)) spikeFailure('invalid-input');
  return milliseconds;
}

export function createMonotonicNanosecondClock(): MonotonicNanosecondClock {
  const originNs = process.hrtime.bigint();
  const originEpochMs = Date.now();
  return Object.freeze({
    nowNs: () => process.hrtime.bigint(),
    toUtcTimestamp: (monotonicNs: bigint) => {
      if (typeof monotonicNs !== 'bigint' || monotonicNs < originNs) {
        spikeFailure('invalid-input');
      }
      const elapsedMs = Number(monotonicNs - originNs) / 1_000_000;
      const timestamp = new Date(originEpochMs + elapsedMs);
      if (!Number.isFinite(timestamp.getTime())) spikeFailure('invalid-input');
      return timestamp.toISOString();
    }
  });
}

export const SYSTEM_SPIKE_SCHEDULER: SpikeScheduler = Object.freeze({
  schedule(callback: () => void, delayMs: number): () => void {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  }
});
