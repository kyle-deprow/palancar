import { assertCanonicalUuid } from './crypto.js';
import { createSystemClock } from './clock.js';
import { SecurityStateError } from './errors.js';
import { exactDataObject, nonNegativeSafeInteger, positiveSafeInteger } from './schema.js';
import { CLOCK_BACKWARDS_TOLERANCE_MS, type AudioGrant, type SecurityClock } from './types.js';

export interface AudioGrantMeterRangeInput {
  readonly fromOriginalSampleOffset: number;
  readonly throughOriginalSampleOffset: number;
}

export interface AudioGrantMeterSnapshot {
  readonly grantId: AudioGrant['grantId'];
  readonly fromOriginalSampleOffset: number;
  readonly throughOriginalSampleOffset: number;
  readonly acceptedThroughOriginalSampleOffset: number;
  readonly acceptedOriginalSamples: number;
  readonly remainingOriginalSamples: number;
  readonly complete: boolean;
}

export interface AudioGrantMeterOptions {
  readonly grant: AudioGrant;
  readonly clock?: SecurityClock;
}

function fail(category: 'invalid-input' | 'stale-lease' | 'state-unavailable'): never {
  throw new SecurityStateError(category);
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function parseAudioGrant(value: unknown): AudioGrant {
  const input = exactDataObject(value, [
    'grantId', 'utteranceId', 'installationId', 'sessionId', 'sessionEpoch', 'sessionLeaseVersion',
    'issuedAt', 'expiresAt', 'fromOriginalSampleOffset', 'throughOriginalSampleOffset',
    'reservedOriginalSamples'
  ]);
  if (
    !positiveSafeInteger(input.sessionEpoch) || !positiveSafeInteger(input.sessionLeaseVersion) ||
    !nonNegativeSafeInteger(input.issuedAt) || !nonNegativeSafeInteger(input.expiresAt) ||
    !nonNegativeSafeInteger(input.fromOriginalSampleOffset) ||
    !positiveSafeInteger(input.throughOriginalSampleOffset) ||
    !positiveSafeInteger(input.reservedOriginalSamples) ||
    input.expiresAt <= input.issuedAt ||
    input.throughOriginalSampleOffset - input.fromOriginalSampleOffset !== input.reservedOriginalSamples
  ) fail('invalid-input');
  return freeze({
    grantId: assertCanonicalUuid(input.grantId),
    utteranceId: assertCanonicalUuid(input.utteranceId),
    installationId: assertCanonicalUuid(input.installationId),
    sessionId: assertCanonicalUuid(input.sessionId),
    sessionEpoch: input.sessionEpoch,
    sessionLeaseVersion: input.sessionLeaseVersion,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    fromOriginalSampleOffset: input.fromOriginalSampleOffset,
    throughOriginalSampleOffset: input.throughOriginalSampleOffset,
    reservedOriginalSamples: input.reservedOriginalSamples
  });
}

function parseClock(value: unknown): SecurityClock {
  const input = exactDataObject(value, ['now']);
  if (typeof input.now !== 'function') fail('invalid-input');
  return freeze({ now: input.now as () => number });
}

/** Connection-local meter. It never writes consumption state to the durable store. */
export class AudioGrantMeter {
  readonly #grant: AudioGrant;
  readonly #clock: SecurityClock;
  #acceptedThroughOriginalSampleOffset: number;
  #lastNow: number;
  #externalActive = false;
  #operationActive = false;
  #reentryDetected = false;

  constructor(options: AudioGrantMeterOptions) {
    const input = exactDataObject(options, ['grant'], ['clock']);
    this.#grant = parseAudioGrant(input.grant);
    this.#clock = parseClock(input.clock ?? createSystemClock());
    this.#acceptedThroughOriginalSampleOffset = this.#grant.fromOriginalSampleOffset;
    this.#lastNow = this.#grant.issuedAt;
    Object.freeze(this);
  }

  #entry(): void {
    if (this.#externalActive || this.#operationActive) {
      this.#reentryDetected = true;
      fail('state-unavailable');
    }
  }

  #now(): number {
    this.#externalActive = true;
    this.#reentryDetected = false;
    try {
      const observedNow = this.#clock.now();
      if (this.#reentryDetected || !nonNegativeSafeInteger(observedNow)) {
        fail('state-unavailable');
      }
      if (
        observedNow < this.#lastNow &&
        this.#lastNow - observedNow > CLOCK_BACKWARDS_TOLERANCE_MS
      ) {
        fail('state-unavailable');
      }
      // Keep the meter's high-water mark as effective time so rollback cannot
      // extend the grant's lifetime or move its permitted window backwards.
      const now = observedNow < this.#lastNow ? this.#lastNow : observedNow;
      this.#lastNow = now;
      return now;
    } catch (error) {
      if (error instanceof SecurityStateError) throw error;
      fail('state-unavailable');
    } finally {
      this.#externalActive = false;
    }
  }

  #snapshot(): AudioGrantMeterSnapshot {
    const acceptedOriginalSamples =
      this.#acceptedThroughOriginalSampleOffset - this.#grant.fromOriginalSampleOffset;
    return freeze({
      grantId: this.#grant.grantId,
      fromOriginalSampleOffset: this.#grant.fromOriginalSampleOffset,
      throughOriginalSampleOffset: this.#grant.throughOriginalSampleOffset,
      acceptedThroughOriginalSampleOffset: this.#acceptedThroughOriginalSampleOffset,
      acceptedOriginalSamples,
      remainingOriginalSamples: this.#grant.reservedOriginalSamples - acceptedOriginalSamples,
      complete: this.#acceptedThroughOriginalSampleOffset === this.#grant.throughOriginalSampleOffset
    });
  }

  accept(value: AudioGrantMeterRangeInput): AudioGrantMeterSnapshot {
    this.#entry();
    const input = exactDataObject(value, ['fromOriginalSampleOffset', 'throughOriginalSampleOffset']);
    if (
      !nonNegativeSafeInteger(input.fromOriginalSampleOffset) ||
      !positiveSafeInteger(input.throughOriginalSampleOffset) ||
      input.throughOriginalSampleOffset <= input.fromOriginalSampleOffset
    ) fail('invalid-input');
    const now = this.#now();
    if (now >= this.#grant.expiresAt) fail('stale-lease');
    this.#operationActive = true;
    try {
      if (
        input.fromOriginalSampleOffset !== this.#acceptedThroughOriginalSampleOffset ||
        input.throughOriginalSampleOffset > this.#grant.throughOriginalSampleOffset
      ) fail('stale-lease');
      this.#acceptedThroughOriginalSampleOffset = input.throughOriginalSampleOffset;
      return this.#snapshot();
    } finally {
      this.#operationActive = false;
    }
  }

  snapshot(): AudioGrantMeterSnapshot {
    this.#entry();
    return this.#snapshot();
  }
}

export function createAudioGrantMeter(options: AudioGrantMeterOptions): AudioGrantMeter {
  return new AudioGrantMeter(options);
}
