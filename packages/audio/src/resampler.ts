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
