import {
  MAX_AUDIO_PAYLOAD_BYTES,
  MAX_UNACKNOWLEDGED_SAMPLES,
  MAX_UTTERANCE_SAMPLES,
  PROTOCOL_VERSION,
  UUID_PATTERN,
  type AudioFrame
} from '@palancar/contracts';

const UUID_V4 = new RegExp(UUID_PATTERN);
const UINT32_MAX = 4_294_967_295;

export interface RelayOrderedFrameAcceptorOptions {
  readonly maxAudioPayloadBytes: number;
  readonly maxRetainedReplaySamples: number;
  readonly maxUtteranceSamples: number;
}

export type OrderedFrameAcceptorErrorReason = 'invalid-options' | 'uuid';

export class OrderedFrameAcceptorError extends TypeError {
  readonly reason: OrderedFrameAcceptorErrorReason;

  constructor(reason: OrderedFrameAcceptorErrorReason) {
    super(reason === 'uuid' ? 'Invalid ordered-stream utterance ID' : 'Invalid acceptor options');
    this.name = 'OrderedFrameAcceptorError';
    this.reason = reason;
  }
}

export interface OrderedFrameAcceptorState {
  readonly utteranceId: string;
  readonly nextSequence: number;
  readonly highestContiguousExclusiveOffset: number;
  readonly retainedFingerprintSamples: number;
  readonly retainedFingerprintCount: number;
}

export type FrameRejectionReason =
  | 'malformed-frame'
  | 'payload-limit'
  | 'utterance-limit'
  | 'conflicting-duplicate'
  | 'gap'
  | 'overlap'
  | 'stale-frame'
  | 'wrong-utterance';

export type FrameAcceptanceResult =
  | {
      readonly status: 'accepted';
      readonly highestContiguousExclusiveOffset: number;
      readonly chargeSamples: number;
      readonly forwardPayload: Uint8Array;
    }
  | {
      readonly status: 'duplicate';
      readonly highestContiguousExclusiveOffset: number;
      readonly chargeSamples: 0;
      readonly forwardPayload: undefined;
    }
  | {
      readonly status: 'rejected';
      readonly reason: FrameRejectionReason;
      readonly highestContiguousExclusiveOffset: number;
    };

interface ValidatedFrame {
  readonly utteranceId: string;
  readonly sequence: number;
  readonly offset: number;
  readonly sampleCount: number;
  readonly payload: Uint8Array;
}

type AcceptedFingerprint = ValidatedFrame;

function assertUuid(utteranceId: string): void {
  if (!UUID_V4.test(utteranceId)) {
    throw new OrderedFrameAcceptorError('uuid');
  }
}

function assertOptions(options: RelayOrderedFrameAcceptorOptions): void {
  if (
    !Number.isInteger(options.maxAudioPayloadBytes) ||
    options.maxAudioPayloadBytes < 2 ||
    options.maxAudioPayloadBytes > MAX_AUDIO_PAYLOAD_BYTES ||
    options.maxAudioPayloadBytes % 2 !== 0 ||
    !Number.isInteger(options.maxRetainedReplaySamples) ||
    options.maxRetainedReplaySamples < 1 ||
    options.maxRetainedReplaySamples > MAX_UNACKNOWLEDGED_SAMPLES ||
    !Number.isInteger(options.maxUtteranceSamples) ||
    options.maxUtteranceSamples < 1 ||
    options.maxUtteranceSamples > MAX_UTTERANCE_SAMPLES
  ) {
    throw new OrderedFrameAcceptorError('invalid-options');
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Accepts one structurally validated contiguous stream. Live fingerprints use
 * O(1)-average sequence lookup and are sample-bounded by the negotiated replay
 * window. Frames evicted from that window are stale and never charged/forwarded.
 */
export class RelayOrderedFrameAcceptor {
  readonly options: Readonly<RelayOrderedFrameAcceptorOptions>;
  #utteranceId: string;
  #nextSequence = 0;
  #nextOffset = 0;
  #fingerprintSamples = 0;
  #fingerprintsBySequence = new Map<number, AcceptedFingerprint>();
  #fingerprintQueue: Array<AcceptedFingerprint | undefined> = [];
  #fingerprintHead = 0;

  constructor(utteranceId: string, options: RelayOrderedFrameAcceptorOptions) {
    assertUuid(utteranceId);
    assertOptions(options);
    this.#utteranceId = utteranceId;
    this.options = Object.freeze({ ...options });
  }

  get state(): OrderedFrameAcceptorState {
    return {
      utteranceId: this.#utteranceId,
      nextSequence: this.#nextSequence,
      highestContiguousExclusiveOffset: this.#nextOffset,
      retainedFingerprintSamples: this.#fingerprintSamples,
      retainedFingerprintCount: this.#fingerprintsBySequence.size
    };
  }

  accept(frame: AudioFrame): FrameAcceptanceResult {
    const validation = this.#validateFrame(frame);
    if ('reason' in validation) {
      return this.#rejected(validation.reason);
    }
    const validated = validation.frame;
    if (validated.utteranceId !== this.#utteranceId) {
      return this.#rejected('wrong-utterance');
    }

    if (validated.sequence < this.#nextSequence) {
      const fingerprint = this.#fingerprintsBySequence.get(validated.sequence);
      if (fingerprint === undefined) {
        return this.#rejected('stale-frame');
      }
      if (
        fingerprint.offset !== validated.offset ||
        fingerprint.sampleCount !== validated.sampleCount ||
        !equalBytes(fingerprint.payload, validated.payload)
      ) {
        return this.#rejected('conflicting-duplicate');
      }
      return {
        status: 'duplicate',
        highestContiguousExclusiveOffset: this.#nextOffset,
        chargeSamples: 0,
        forwardPayload: undefined
      };
    }

    if (validated.sequence > this.#nextSequence) {
      return this.#rejected(validated.offset < this.#nextOffset ? 'overlap' : 'gap');
    }
    if (validated.offset < this.#nextOffset) {
      return this.#rejected('overlap');
    }
    if (validated.offset > this.#nextOffset) {
      return this.#rejected('gap');
    }

    const payload = new Uint8Array(validated.payload);
    const fingerprint: AcceptedFingerprint = { ...validated, payload };
    this.#fingerprintsBySequence.set(validated.sequence, fingerprint);
    this.#fingerprintQueue.push(fingerprint);
    this.#fingerprintSamples += validated.sampleCount;
    this.#nextSequence += 1;
    this.#nextOffset += validated.sampleCount;
    this.#evictFingerprints();

    return {
      status: 'accepted',
      highestContiguousExclusiveOffset: this.#nextOffset,
      chargeSamples: validated.sampleCount,
      forwardPayload: new Uint8Array(payload)
    };
  }

  reset(utteranceId: string): void {
    assertUuid(utteranceId);
    this.#utteranceId = utteranceId;
    this.#nextSequence = 0;
    this.#nextOffset = 0;
    this.#fingerprintSamples = 0;
    this.#fingerprintsBySequence.clear();
    this.#fingerprintQueue = [];
    this.#fingerprintHead = 0;
  }

  #validateFrame(frame: AudioFrame):
    | { readonly frame: ValidatedFrame }
    | { readonly reason: 'malformed-frame' | 'payload-limit' | 'utterance-limit' } {
    const candidate: unknown = frame;
    if (typeof candidate !== 'object' || candidate === null) {
      return { reason: 'malformed-frame' };
    }
    const value = candidate as Record<string, unknown>;
    if (
      value.protocolVersion !== PROTOCOL_VERSION ||
      value.flags !== 0 ||
      typeof value.utteranceId !== 'string' ||
      !UUID_V4.test(value.utteranceId) ||
      !Number.isInteger(value.sequence) ||
      (value.sequence as number) < 0 ||
      (value.sequence as number) > UINT32_MAX ||
      !Number.isInteger(value.offset) ||
      (value.offset as number) < 0 ||
      (value.offset as number) > UINT32_MAX ||
      !(value.payload instanceof Uint8Array) ||
      !Number.isInteger(value.payloadLength) ||
      value.payloadLength !== value.payload.length ||
      value.payload.length < 2 ||
      value.payload.length % 2 !== 0
    ) {
      return { reason: 'malformed-frame' };
    }
    if (value.payload.length > this.options.maxAudioPayloadBytes) {
      return { reason: 'payload-limit' };
    }

    const sequence = value.sequence as number;
    const offset = value.offset as number;
    const sampleCount = value.payload.length / 2;
    if (offset + sampleCount > this.options.maxUtteranceSamples) {
      return { reason: 'utterance-limit' };
    }
    return {
      frame: {
        utteranceId: value.utteranceId,
        sequence,
        offset,
        sampleCount,
        payload: value.payload
      }
    };
  }

  #evictFingerprints(): void {
    while (this.#fingerprintSamples > this.options.maxRetainedReplaySamples) {
      const removed = this.#fingerprintQueue[this.#fingerprintHead];
      if (removed === undefined) {
        break;
      }
      this.#fingerprintsBySequence.delete(removed.sequence);
      this.#fingerprintSamples -= removed.sampleCount;
      this.#fingerprintQueue[this.#fingerprintHead] = undefined;
      this.#fingerprintHead += 1;
    }
    if (this.#fingerprintHead === this.#fingerprintQueue.length) {
      this.#fingerprintQueue = [];
      this.#fingerprintHead = 0;
    } else if (this.#fingerprintHead >= MAX_AUDIO_PAYLOAD_BYTES / 2) {
      this.#fingerprintQueue = this.#fingerprintQueue.slice(this.#fingerprintHead);
      this.#fingerprintHead = 0;
    }
  }

  #rejected(reason: FrameRejectionReason): FrameAcceptanceResult {
    return {
      status: 'rejected',
      reason,
      highestContiguousExclusiveOffset: this.#nextOffset
    };
  }
}
