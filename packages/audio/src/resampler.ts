export interface AudioResamplerCapabilities {
  readonly inputSampleRateHz: number;
  readonly outputSampleRateHz: number;
  readonly channels: 1;
  readonly sampleFormat: 's16le';
  readonly stateful: boolean;
}

export interface StatefulAudioResampler {
  readonly capabilities: Readonly<AudioResamplerCapabilities>;
  push(input: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  reset(): void;
}

export type AudioResamplerErrorReason = 'incomplete-sample';

/** A typed failure raised when an utterance ends halfway through an S16LE sample. */
export class AudioResamplerError extends Error {
  readonly reason: AudioResamplerErrorReason;

  constructor(reason: AudioResamplerErrorReason) {
    super('Audio resampler ended with an incomplete S16LE sample');
    this.name = 'AudioResamplerError';
    this.reason = reason;
  }
}

const INPUT_SAMPLE_RATE_HZ = 16_000 as const;
const OUTPUT_SAMPLE_RATE_HZ = 24_000 as const;
const PHASE_DENOMINATOR = 3 as const;
const OUTPUT_PHASE_STEP = 2 as const;
const INT16_MIN = -32_768 as const;
const INT16_MAX = 32_767 as const;

function roundRationalAwayFromZero(numerator: number, denominator: number): number {
  const magnitude = Math.abs(numerator);
  const roundedMagnitude = Math.floor((magnitude * 2 + denominator) / (denominator * 2));
  if (roundedMagnitude === 0) {
    return 0;
  }
  return numerator < 0 ? -roundedMagnitude : roundedMagnitude;
}

function saturateInt16(value: number): number {
  return Math.min(INT16_MAX, Math.max(INT16_MIN, value));
}

function interpolate(left: number, right: number, fraction: number): number {
  const numerator = (PHASE_DENOMINATOR - fraction) * left + fraction * right;
  return saturateInt16(roundRationalAwayFromZero(numerator, PHASE_DENOMINATOR));
}

function encodeSample(output: Uint8Array, sampleIndex: number, sample: number): void {
  const boundedSample = saturateInt16(sample);
  const unsigned = boundedSample < 0 ? boundedSample + 0x1_0000 : boundedSample;
  const byteOffset = sampleIndex * 2;
  output[byteOffset] = unsigned & 0xff;
  output[byteOffset + 1] = unsigned >>> 8;
}

function decodeSample(lowByte: number, highByte: number): number {
  const unsigned = lowByte | (highByte << 8);
  return unsigned < 0x8000 ? unsigned : unsigned - 0x1_0000;
}

/**
 * Stateful 16 kHz mono S16LE to 24 kHz mono S16LE linear resampler.
 *
 * Output positions are an integer phase grid at 2/3 input-sample steps. A
 * push emits positions whose interpolation endpoints have arrived. The input
 * is treated as a half-open duration: at flush, the last sample is held as the
 * right endpoint and the one remaining output position in that duration is
 * emitted. Therefore a non-empty input of N samples produces ceil(3N/2)
 * samples across push calls and one final flush. Ties in rational rounding are
 * rounded away from zero, and the result is saturated to signed int16.
 *
 * flush consumes the current utterance. An incomplete final byte throws an
 * AudioResamplerError with reason "incomplete-sample" and also consumes all
 * state. A completed flush and a repeated flush both return fresh empty
 * buffers. reset discards the current utterance without producing output.
 */
export class LinearPcm16To24AudioResampler implements StatefulAudioResampler {
  readonly capabilities: Readonly<AudioResamplerCapabilities> = Object.freeze({
    inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    outputSampleRateHz: OUTPUT_SAMPLE_RATE_HZ,
    channels: 1,
    sampleFormat: 's16le',
    stateful: true
  });

  #pendingByte: number | undefined;
  #lastSample: number | undefined;
  #inputSampleCount = 0;
  #nextOutputPhase = 0;

  push(input: Uint8Array): Uint8Array {
    // Own the callback synchronously, including a single byte carried across
    // pushes. No output or pending state refers to the caller's view.
    const ownedInput = new Uint8Array(input);
    const carriedByteCount = this.#pendingByte === undefined ? 0 : 1;
    const completeSampleCount = Math.floor((ownedInput.length + carriedByteCount) / 2);
    const output = new Uint8Array(
      this.#outputCountForInputSamples(completeSampleCount) * 2
    );
    let outputSampleIndex = 0;
    let offset = 0;

    if (this.#pendingByte !== undefined && ownedInput.length > 0) {
      const sample = decodeSample(this.#pendingByte, ownedInput[0] ?? 0);
      this.#pendingByte = undefined;
      offset = 1;
      outputSampleIndex = this.#acceptSample(sample, output, outputSampleIndex);
    }

    while (offset + 1 < ownedInput.length) {
      outputSampleIndex = this.#acceptSample(
        decodeSample(ownedInput[offset] ?? 0, ownedInput[offset + 1] ?? 0),
        output,
        outputSampleIndex
      );
      offset += 2;
    }

    if (offset < ownedInput.length) {
      this.#pendingByte = ownedInput[offset];
    }

    return output;
  }

  flush(): Uint8Array {
    if (this.#pendingByte !== undefined) {
      this.#clearState();
      throw new AudioResamplerError('incomplete-sample');
    }

    if (this.#lastSample === undefined) {
      return new Uint8Array(0);
    }

    const exclusiveEnd = this.#inputSampleCount * PHASE_DENOMINATOR;
    const outputSampleCount = this.#outputCountBeforePhase(exclusiveEnd);
    const output = new Uint8Array(outputSampleCount * 2);
    let outputSampleIndex = 0;
    while (this.#nextOutputPhase < exclusiveEnd) {
      encodeSample(output, outputSampleIndex, this.#lastSample);
      outputSampleIndex += 1;
      this.#nextOutputPhase += OUTPUT_PHASE_STEP;
    }
    this.#clearState();
    return output;
  }

  reset(): void {
    this.#clearState();
  }

  #acceptSample(sample: number, output: Uint8Array, outputSampleIndex: number): number {
    const sampleIndex = this.#inputSampleCount;
    const previousSample = this.#lastSample;
    this.#lastSample = sample;
    this.#inputSampleCount += 1;

    while (this.#nextOutputPhase <= sampleIndex * PHASE_DENOMINATOR) {
      const fraction = this.#nextOutputPhase % PHASE_DENOMINATOR;
      if (fraction === 0 || previousSample === undefined) {
        const isCurrentSample = this.#nextOutputPhase === sampleIndex * PHASE_DENOMINATOR;
        encodeSample(
          output,
          outputSampleIndex,
          isCurrentSample ? sample : previousSample ?? sample
        );
      } else {
        encodeSample(output, outputSampleIndex, interpolate(previousSample, sample, fraction));
      }
      outputSampleIndex += 1;
      this.#nextOutputPhase += OUTPUT_PHASE_STEP;
    }
    return outputSampleIndex;
  }

  #outputCountForInputSamples(sampleCount: number): number {
    if (sampleCount === 0) {
      return 0;
    }
    const lastSamplePhase =
      (this.#inputSampleCount + sampleCount - 1) * PHASE_DENOMINATOR;
    return this.#outputCountThroughPhase(lastSamplePhase);
  }

  #outputCountBeforePhase(exclusiveEnd: number): number {
    if (this.#nextOutputPhase >= exclusiveEnd) {
      return 0;
    }
    return Math.floor((exclusiveEnd - 1 - this.#nextOutputPhase) / OUTPUT_PHASE_STEP) + 1;
  }

  #outputCountThroughPhase(inclusiveEnd: number): number {
    if (this.#nextOutputPhase > inclusiveEnd) {
      return 0;
    }
    return Math.floor((inclusiveEnd - this.#nextOutputPhase) / OUTPUT_PHASE_STEP) + 1;
  }

  #clearState(): void {
    this.#pendingByte = undefined;
    this.#lastSample = undefined;
    this.#inputSampleCount = 0;
    this.#nextOutputPhase = 0;
  }
}

/** Provider-neutral native-rate pass-through that always returns fresh buffers. */
export class IdentityAudioResampler implements StatefulAudioResampler {
  readonly capabilities: Readonly<AudioResamplerCapabilities>;

  constructor(sampleRateHz = 16_000) {
    if (!Number.isInteger(sampleRateHz) || sampleRateHz < 1) {
      throw new RangeError('Invalid identity resampler sample rate');
    }
    this.capabilities = Object.freeze({
      inputSampleRateHz: sampleRateHz,
      outputSampleRateHz: sampleRateHz,
      channels: 1,
      sampleFormat: 's16le',
      stateful: false
    });
  }

  push(input: Uint8Array): Uint8Array {
    return new Uint8Array(input);
  }

  flush(): Uint8Array {
    return new Uint8Array(0);
  }

  reset(): void {
    // Native-rate identity conversion has no buffered state.
  }
}
