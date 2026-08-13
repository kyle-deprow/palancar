import {
  MAX_AUDIO_PAYLOAD_BYTES,
  MAX_UNACKNOWLEDGED_SAMPLES
} from '@palancar/contracts';

export const PCM_SAMPLE_RATE_HZ = 16_000 as const;
export const PCM_SAMPLE_BYTES = 2 as const;
export const DEFAULT_PCM_COALESCING_TARGET_MS = 60 as const;
export const DEFAULT_PCM_COALESCING_TARGET_SAMPLES = 960 as const;
export const DEFAULT_PCM_COALESCING_TARGET_BYTES = 1_920 as const;

export type PcmFramerErrorReason =
  | 'invalid-payload-limit'
  | 'invalid-sample-limit'
  | 'invalid-coalescing-target';

export class PcmFramerError extends RangeError {
  readonly reason: PcmFramerErrorReason;

  constructor(reason: PcmFramerErrorReason) {
    super(
      reason === 'invalid-payload-limit'
        ? 'Invalid PCM framer payload limit'
        : reason === 'invalid-sample-limit'
          ? 'Invalid PCM framer sample limit'
          : 'Invalid PCM framer coalescing target'
    );
    this.name = 'PcmFramerError';
    this.reason = reason;
  }
}

/** Options used to derive the bounded, sample-aligned coalescing target. */
export interface PcmChunkFramerOptions {
  /** Negotiated maximum payload size. */
  readonly maxPayloadBytes?: number;
  /** Alias for maxPayloadBytes when options are shared with the queue. */
  readonly maxAudioPayloadBytes?: number;
  /** Optional rollout target in bytes. It is still capped at the 60 ms default. */
  readonly coalescingTargetBytes?: number;
  /** Optional target expressed as original PCM samples. */
  readonly coalescingTargetSamples?: number;
  /** Optional target expressed as milliseconds at 16 kHz mono S16LE. */
  readonly coalescingTargetMs?: number;
  /** Negotiated replay window, used when deriving the effective target. */
  readonly maxRetainedReplaySamples?: number;
  /** Negotiated in-flight window, used when deriving the effective target. */
  readonly maxUnacknowledgedSamples?: number;
}

export type PcmFlushResult =
  | {
      readonly status: 'complete';
      readonly payloads: readonly Uint8Array[];
    }
  | {
      readonly status: 'incomplete-sample';
      readonly payloads: readonly Uint8Array[];
      readonly trailingByte: number;
    };

function assertIntegerLimit(
  value: number,
  reason: 'invalid-payload-limit' | 'invalid-sample-limit',
  minimum: number,
  maximum: number
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new PcmFramerError(reason);
  }
}

function resolveAlias(
  first: number | undefined,
  second: number | undefined,
  reason: PcmFramerErrorReason
): number | undefined {
  if (first !== undefined && second !== undefined && first !== second) {
    throw new PcmFramerError(reason);
  }
  return first ?? second;
}

function resolveTargetBytes(options: PcmChunkFramerOptions): number {
  const targetBytes = options.coalescingTargetBytes;
  const targetSamples = options.coalescingTargetSamples;
  const targetMs = options.coalescingTargetMs;
  const configuredTargets = [targetBytes, targetSamples, targetMs].filter(
    (value): value is number => value !== undefined
  );
  if (configuredTargets.length > 1) {
    throw new PcmFramerError('invalid-coalescing-target');
  }

  if (targetBytes !== undefined) {
    if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
      throw new PcmFramerError('invalid-coalescing-target');
    }
    return targetBytes;
  }
  if (targetSamples !== undefined) {
    if (!Number.isFinite(targetSamples) || targetSamples <= 0) {
      throw new PcmFramerError('invalid-coalescing-target');
    }
    return targetSamples * PCM_SAMPLE_BYTES;
  }
  if (targetMs !== undefined) {
    if (!Number.isFinite(targetMs) || targetMs <= 0) {
      throw new PcmFramerError('invalid-coalescing-target');
    }
    return (targetMs * PCM_SAMPLE_RATE_HZ * PCM_SAMPLE_BYTES) / 1_000;
  }
  return DEFAULT_PCM_COALESCING_TARGET_BYTES;
}

function largestEvenAtMost(value: number): number {
  return Math.floor(value / PCM_SAMPLE_BYTES) * PCM_SAMPLE_BYTES;
}

/**
 * Copies arbitrary G2 PCM callbacks, aligns S16LE samples, and coalesces them
 * into bounded payloads. Complete samples remain buffered until the effective
 * target is reached; one incomplete byte is carried separately.
 */
export class PcmChunkFramer {
  readonly maxPayloadBytes: number;
  readonly targetBytes: number;
  readonly coalescingTargetBytes: number;
  #pendingSamples = new Uint8Array(0);
  #trailingByte: number | undefined;

  constructor(maxPayloadBytes?: number);
  constructor(options?: PcmChunkFramerOptions);
  constructor(
    maxPayloadOrOptions: number | PcmChunkFramerOptions = MAX_AUDIO_PAYLOAD_BYTES
  ) {
    const options: PcmChunkFramerOptions =
      typeof maxPayloadOrOptions === 'number'
        ? { maxPayloadBytes: maxPayloadOrOptions }
        : maxPayloadOrOptions;
    const maxPayloadBytes = resolveAlias(
      options.maxPayloadBytes,
      options.maxAudioPayloadBytes,
      'invalid-payload-limit'
    ) ?? MAX_AUDIO_PAYLOAD_BYTES;
    assertIntegerLimit(
      maxPayloadBytes,
      'invalid-payload-limit',
      PCM_SAMPLE_BYTES,
      MAX_AUDIO_PAYLOAD_BYTES
    );
    if (maxPayloadBytes % PCM_SAMPLE_BYTES !== 0) {
      throw new PcmFramerError('invalid-payload-limit');
    }

    for (const sampleLimit of [
      options.maxRetainedReplaySamples,
      options.maxUnacknowledgedSamples
    ]) {
      if (sampleLimit !== undefined) {
        assertIntegerLimit(
          sampleLimit,
          'invalid-sample-limit',
          1,
          MAX_UNACKNOWLEDGED_SAMPLES
        );
      }
    }

    const configuredTargetBytes = resolveTargetBytes(options);
    const candidateLimits = [
      DEFAULT_PCM_COALESCING_TARGET_BYTES,
      configuredTargetBytes,
      maxPayloadBytes,
      options.maxRetainedReplaySamples === undefined
        ? Number.POSITIVE_INFINITY
        : options.maxRetainedReplaySamples * PCM_SAMPLE_BYTES,
      options.maxUnacknowledgedSamples === undefined
        ? Number.POSITIVE_INFINITY
        : options.maxUnacknowledgedSamples * PCM_SAMPLE_BYTES
    ];
    const effectiveTargetBytes = largestEvenAtMost(Math.min(...candidateLimits));
    if (effectiveTargetBytes < PCM_SAMPLE_BYTES) {
      throw new PcmFramerError('invalid-coalescing-target');
    }

    this.maxPayloadBytes = maxPayloadBytes;
    this.targetBytes = effectiveTargetBytes;
    this.coalescingTargetBytes = effectiveTargetBytes;
  }

  get pendingByteCount(): 0 | 1 {
    return this.#trailingByte === undefined ? 0 : 1;
  }

  get pendingSampleCount(): number {
    return this.#pendingSamples.length / PCM_SAMPLE_BYTES;
  }

  push(input: Uint8Array): readonly Uint8Array[] {
    // Copy before doing any buffering so callback-owned views can be reused or
    // mutated as soon as this call returns.
    const copied = new Uint8Array(input);
    const merged = new Uint8Array(
      this.#pendingSamples.length + this.pendingByteCount + copied.length
    );
    let offset = 0;
    merged.set(this.#pendingSamples, offset);
    offset += this.#pendingSamples.length;
    if (this.#trailingByte !== undefined) {
      merged[offset] = this.#trailingByte;
      offset += 1;
    }
    merged.set(copied, offset);

    const completeLength = largestEvenAtMost(merged.length);
    this.#pendingSamples = merged.slice(0, completeLength);
    this.#trailingByte =
      completeLength < merged.length ? merged[completeLength] : undefined;
    return this.#drainTarget();
  }

  /**
   * Consumes all currently buffered complete samples but leaves an odd byte
   * pending. The queue uses this to make a deterministic replay tail without
   * treating an incomplete sample as captured audio.
   */
  drainCompleteSamples(): readonly Uint8Array[] {
    if (this.#pendingSamples.length === 0) {
      return [];
    }
    const payload = this.#pendingSamples;
    this.#pendingSamples = new Uint8Array(0);
    return [payload.slice()];
  }

  flush(): PcmFlushResult {
    const payloads = this.drainCompleteSamples();
    const trailingByte = this.#trailingByte;
    this.#trailingByte = undefined;
    return trailingByte === undefined
      ? { status: 'complete', payloads }
      : { status: 'incomplete-sample', payloads, trailingByte };
  }

  reset(): void {
    this.#pendingSamples = new Uint8Array(0);
    this.#trailingByte = undefined;
  }

  #drainTarget(): readonly Uint8Array[] {
    const completeLength = this.#pendingSamples.length;
    const frameLength = this.targetBytes;
    const emittedLength = completeLength - (completeLength % frameLength);
    if (emittedLength === 0) {
      return [];
    }

    const payloads: Uint8Array[] = [];
    for (let offset = 0; offset < emittedLength; offset += frameLength) {
      payloads.push(this.#pendingSamples.slice(offset, offset + frameLength));
    }
    this.#pendingSamples = this.#pendingSamples.slice(emittedLength);
    return payloads;
  }
}
