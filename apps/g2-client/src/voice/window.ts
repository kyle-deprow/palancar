export const PCM_SAMPLE_RATE_HZ = 16_000 as const;
const PCM_SAMPLE_BYTES = 2 as const;
export interface PcmWindowOptions {
  readonly capacitySamples?: number;
  readonly capacityMs?: number;
}
export interface PcmWindow {
  readonly capacitySamples: number;
  readonly sampleCount: number;
  readonly pendingByteCount: 0 | 1;
  /** Adds complete S16LE samples and returns the number accepted. */
  push(bytes: Uint8Array): number;
  /** Returns the newest requested samples in chronological order. */
  trailingSamples(durationMs?: number): Float32Array;
  clear(): void;
}
function samplesForMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError("PCM window duration must be positive and finite");
  }
  return Math.max(1, Math.round((durationMs * PCM_SAMPLE_RATE_HZ) / 1_000));
}
function resolveCapacity(options: number | PcmWindowOptions): number {
  if (typeof options === "number") {
    if (!Number.isInteger(options) || options <= 0) {
      throw new RangeError("PCM window capacity must be a positive integer");
    }
    return options;
  }
  if (options.capacitySamples !== undefined && options.capacityMs !== undefined) {
    throw new TypeError("Specify either capacitySamples or capacityMs, not both");
  }
  if (options.capacitySamples !== undefined) {
    if (!Number.isInteger(options.capacitySamples) || options.capacitySamples <= 0) {
      throw new RangeError("PCM window capacity must be a positive integer");
    }
    return options.capacitySamples;
  }
  return samplesForMs(options.capacityMs ?? 1_000);
}
function decodeSample(low: number, high: number): number {
  const unsigned = low | (high << 8);
  return unsigned >= 0x8000 ? unsigned - 0x1_0000 : unsigned;
}
export class PcmSlidingWindow implements PcmWindow {
  readonly capacitySamples: number;
  #samples: Int16Array;
  #writeIndex = 0;
  #sampleCount = 0;
  #trailingByte: number | undefined;
  constructor(options: number | PcmWindowOptions = { capacityMs: 1_000 }) {
    this.capacitySamples = resolveCapacity(options);
    // The only retained audio allocation is fixed at construction time.
    this.#samples = new Int16Array(this.capacitySamples);
  }
  get sampleCount(): number {
    return this.#sampleCount;
  }
  get pendingByteCount(): 0 | 1 {
    return this.#trailingByte === undefined ? 0 : 1;
  }
  push(bytes: Uint8Array): number {
    let offset = 0;
    let accepted = 0;
    if (this.#trailingByte !== undefined && bytes.length > 0) {
      this.#write(decodeSample(this.#trailingByte, bytes[0] ?? 0));
      accepted += 1;
      offset = 1;
      this.#trailingByte = undefined;
    }
    while (offset + 1 < bytes.length) {
      this.#write(decodeSample(bytes[offset] ?? 0, bytes[offset + 1] ?? 0));
      accepted += 1;
      offset += PCM_SAMPLE_BYTES;
    }
    if (offset < bytes.length) {
      // Deliberately retain one trailing byte until the next frame so S16LE
      // alignment survives arbitrary callback boundaries.
      this.#trailingByte = bytes[offset];
    }
    return accepted;
  }
  trailingSamples(durationMs?: number): Float32Array {
    const requested = durationMs === undefined ? this.#sampleCount : samplesForMs(durationMs);
    const count = Math.min(requested, this.#sampleCount);
    const output = new Float32Array(count);
    const first = (this.#writeIndex - count + this.capacitySamples) % this.capacitySamples;
    for (let i = 0; i < count; i += 1) {
      const index = (first + i) % this.capacitySamples;
      output[i] = (this.#samples[index] ?? 0) / 32_768;
    }
    return output;
  }
  clear(): void {
    this.#samples.fill(0);
    this.#writeIndex = 0;
    this.#sampleCount = 0;
    this.#trailingByte = undefined;
  }
  #write(sample: number): void {
    this.#samples[this.#writeIndex] = sample;
    this.#writeIndex = (this.#writeIndex + 1) % this.capacitySamples;
    this.#sampleCount = Math.min(this.#sampleCount + 1, this.capacitySamples);
  }
}
export function createPcmWindow(options: number | PcmWindowOptions = { capacityMs: 1_000 }): PcmWindow {
  return new PcmSlidingWindow(options);
}
