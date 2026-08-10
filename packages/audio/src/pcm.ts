import { MAX_AUDIO_PAYLOAD_BYTES } from '@palancar/contracts';

export type PcmFramerErrorReason = 'invalid-payload-limit';

export class PcmFramerError extends RangeError {
  readonly reason: PcmFramerErrorReason;

  constructor(reason: PcmFramerErrorReason) {
    super('Invalid PCM framer payload limit');
    this.name = 'PcmFramerError';
    this.reason = reason;
  }
}

export type PcmFlushResult =
  | { readonly status: 'complete' }
  | { readonly status: 'incomplete-sample'; readonly trailingByte: number };

/**
 * Copies arbitrary G2 PCM callbacks, aligns S16LE samples, and emits bounded payloads.
 * A failed flush consumes and reports the incomplete byte; reset discards all state.
 */
export class PcmChunkFramer {
  readonly maxPayloadBytes: number;
  #trailingByte: number | undefined;

  constructor(maxPayloadBytes: number = MAX_AUDIO_PAYLOAD_BYTES) {
    if (
      !Number.isInteger(maxPayloadBytes) ||
      maxPayloadBytes < 2 ||
      maxPayloadBytes > MAX_AUDIO_PAYLOAD_BYTES ||
      maxPayloadBytes % 2 !== 0
    ) {
      throw new PcmFramerError('invalid-payload-limit');
    }
    this.maxPayloadBytes = maxPayloadBytes;
  }

  get pendingByteCount(): 0 | 1 {
    return this.#trailingByte === undefined ? 0 : 1;
  }

  push(input: Uint8Array): readonly Uint8Array[] {
    const copied = new Uint8Array(input);
    const merged = new Uint8Array(copied.length + this.pendingByteCount);
    if (this.#trailingByte !== undefined) {
      merged[0] = this.#trailingByte;
    }
    merged.set(copied, this.pendingByteCount);

    const completeLength = merged.length - (merged.length % 2);
    const payloads: Uint8Array[] = [];
    for (let offset = 0; offset < completeLength; offset += this.maxPayloadBytes) {
      payloads.push(merged.slice(offset, Math.min(offset + this.maxPayloadBytes, completeLength)));
    }

    this.#trailingByte = completeLength < merged.length ? merged[completeLength] : undefined;
    return payloads;
  }

  flush(): PcmFlushResult {
    const trailingByte = this.#trailingByte;
    this.#trailingByte = undefined;
    return trailingByte === undefined
      ? { status: 'complete' }
      : { status: 'incomplete-sample', trailingByte };
  }

  reset(): void {
    this.#trailingByte = undefined;
  }
}
