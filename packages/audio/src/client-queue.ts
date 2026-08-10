import {
  MAX_AUDIO_PAYLOAD_BYTES,
  MAX_UNACKNOWLEDGED_SAMPLES,
  MAX_UTTERANCE_SAMPLES,
  UUID_PATTERN,
  encodeAudioFrame
} from '@palancar/contracts';

import { PcmChunkFramer, type PcmFlushResult } from './pcm.js';

const UUID_V4 = new RegExp(UUID_PATTERN);

export interface ClientAudioQueueLimits {
  readonly maxAudioPayloadBytes: number;
  readonly maxUnacknowledgedSamples: number;
  readonly maxRetainedReplaySamples: number;
  readonly maxUtteranceSamples: number;
}

export type ClientAudioQueueErrorReason = 'invalid-limits' | 'uuid';

export class ClientAudioQueueError extends TypeError {
  readonly reason: ClientAudioQueueErrorReason;

  constructor(reason: ClientAudioQueueErrorReason) {
    super(reason === 'uuid' ? 'Invalid audio queue utterance ID' : 'Invalid audio queue limits');
    this.name = 'ClientAudioQueueError';
    this.reason = reason;
  }
}

export interface EncodedAudioFrame {
  readonly sequence: number;
  readonly offset: number;
  readonly sampleCount: number;
  readonly bytes: Uint8Array;
}

interface RetainedAudioFrame extends EncodedAudioFrame {
  readonly endOffset: number;
}

export interface ClientAudioQueueState {
  readonly utteranceId: string;
  readonly nextSequence: number;
  readonly oldestRetainedOffset: number;
  readonly highestAcknowledgedOffset: number;
  readonly nextCapturedOffset: number;
  readonly inFlightSamples: number;
  readonly inFlightInterval: Readonly<SampleInterval>;
  readonly retainedReplaySamples: number;
  readonly replayInterval: Readonly<SampleInterval>;
  readonly retainedFrameCount: number;
  readonly pendingByteCount: 0 | 1;
}

export interface SampleInterval {
  readonly startOffset: number;
  readonly endOffset: number;
}

export type QueueLimitName =
  | 'maxUnacknowledgedSamples'
  | 'maxRetainedReplaySamples'
  | 'maxUtteranceSamples';

export type QueuePushResult =
  | { readonly status: 'accepted'; readonly frames: readonly EncodedAudioFrame[] }
  | {
      readonly status: 'overflow';
      readonly attemptedSamples: number;
      readonly exceededLimits: readonly QueueLimitName[];
    };

export type AcknowledgementResult =
  | {
      readonly status: 'applied';
      readonly acknowledgedOffset: number;
      readonly releasedFrames: number;
    }
  | { readonly status: 'stale'; readonly acknowledgedOffset: number }
  | {
      readonly status: 'invalid';
      readonly reason: 'non-integer' | 'negative' | 'beyond-captured' | 'interior-frame';
      readonly acknowledgedOffset: number;
    };

export type ReplayResult =
  | {
      readonly status: 'replay';
      readonly requestedOffset: number;
      readonly frames: readonly EncodedAudioFrame[];
    }
  | {
      readonly status: 'non-resumable';
      readonly reason:
        | 'invalid-offset'
        | 'older-than-retained'
        | 'newer-than-captured'
        | 'interior-frame';
      readonly requestedOffset: number;
    };

function assertUuid(utteranceId: string): void {
  if (!UUID_V4.test(utteranceId)) {
    throw new ClientAudioQueueError('uuid');
  }
}

function assertLimits(limits: ClientAudioQueueLimits): void {
  if (
    !Number.isInteger(limits.maxAudioPayloadBytes) ||
    limits.maxAudioPayloadBytes < 2 ||
    limits.maxAudioPayloadBytes > MAX_AUDIO_PAYLOAD_BYTES ||
    limits.maxAudioPayloadBytes % 2 !== 0 ||
    !Number.isInteger(limits.maxUnacknowledgedSamples) ||
    limits.maxUnacknowledgedSamples < 1 ||
    limits.maxUnacknowledgedSamples > MAX_UNACKNOWLEDGED_SAMPLES ||
    !Number.isInteger(limits.maxRetainedReplaySamples) ||
    limits.maxRetainedReplaySamples < 1 ||
    limits.maxRetainedReplaySamples > limits.maxUnacknowledgedSamples ||
    !Number.isInteger(limits.maxUtteranceSamples) ||
    limits.maxUtteranceSamples < 1 ||
    limits.maxUtteranceSamples > MAX_UTTERANCE_SAMPLES
  ) {
    throw new ClientAudioQueueError('invalid-limits');
  }
}

function copyFrame(frame: EncodedAudioFrame): EncodedAudioFrame {
  return { ...frame, bytes: frame.bytes.slice() };
}

/**
 * Client-side original-rate queue. ACK and replay offsets are frame boundaries,
 * so every replay is exactly [requestedOffset, nextCapturedOffset).
 */
export class ClientRetainedAudioQueue {
  readonly limits: Readonly<ClientAudioQueueLimits>;
  #utteranceId: string;
  #framer: PcmChunkFramer;
  #nextSequence = 0;
  #highestAcknowledgedOffset = 0;
  #nextCapturedOffset = 0;
  #retained: Array<RetainedAudioFrame | undefined> = [];
  #retainedHead = 0;

  constructor(utteranceId: string, limits: ClientAudioQueueLimits) {
    assertUuid(utteranceId);
    assertLimits(limits);
    this.#utteranceId = utteranceId;
    this.limits = Object.freeze({ ...limits });
    this.#framer = new PcmChunkFramer(limits.maxAudioPayloadBytes);
  }

  get state(): ClientAudioQueueState {
    const inFlightSamples = this.#nextCapturedOffset - this.#highestAcknowledgedOffset;
    const interval = Object.freeze({
      startOffset: this.#highestAcknowledgedOffset,
      endOffset: this.#nextCapturedOffset
    });
    return {
      utteranceId: this.#utteranceId,
      nextSequence: this.#nextSequence,
      oldestRetainedOffset: this.#highestAcknowledgedOffset,
      highestAcknowledgedOffset: this.#highestAcknowledgedOffset,
      nextCapturedOffset: this.#nextCapturedOffset,
      inFlightSamples,
      inFlightInterval: interval,
      retainedReplaySamples: inFlightSamples,
      replayInterval: interval,
      retainedFrameCount: this.#retained.length - this.#retainedHead,
      pendingByteCount: this.#framer.pendingByteCount
    };
  }

  push(input: Uint8Array): QueuePushResult {
    const newSamples = Math.floor((input.length + this.#framer.pendingByteCount) / 2);
    const attemptedInFlight = this.state.inFlightSamples + newSamples;
    const attemptedCaptured = this.#nextCapturedOffset + newSamples;
    const exceededLimits: QueueLimitName[] = [];
    if (attemptedInFlight > this.limits.maxUnacknowledgedSamples) {
      exceededLimits.push('maxUnacknowledgedSamples');
    }
    if (attemptedInFlight > this.limits.maxRetainedReplaySamples) {
      exceededLimits.push('maxRetainedReplaySamples');
    }
    if (attemptedCaptured > this.limits.maxUtteranceSamples) {
      exceededLimits.push('maxUtteranceSamples');
    }
    if (exceededLimits.length > 0) {
      return { status: 'overflow', attemptedSamples: newSamples, exceededLimits };
    }

    const payloads = this.#framer.push(input);
    const pendingFrames: RetainedAudioFrame[] = [];
    let sequence = this.#nextSequence;
    let offset = this.#nextCapturedOffset;
    for (const payload of payloads) {
      const sampleCount = payload.length / 2;
      const bytes = encodeAudioFrame({
        utteranceId: this.#utteranceId,
        sequence,
        offset,
        payload
      });
      pendingFrames.push({ sequence, offset, sampleCount, endOffset: offset + sampleCount, bytes });
      sequence += 1;
      offset += sampleCount;
    }

    this.#retained.push(...pendingFrames);
    this.#nextSequence = sequence;
    this.#nextCapturedOffset = offset;
    return { status: 'accepted', frames: pendingFrames.map(copyFrame) };
  }

  flush(): PcmFlushResult {
    return this.#framer.flush();
  }

  acknowledge(acknowledgedOffset: number): AcknowledgementResult {
    if (!Number.isInteger(acknowledgedOffset)) {
      return { status: 'invalid', reason: 'non-integer', acknowledgedOffset };
    }
    if (acknowledgedOffset < 0) {
      return { status: 'invalid', reason: 'negative', acknowledgedOffset };
    }
    if (acknowledgedOffset <= this.#highestAcknowledgedOffset) {
      return { status: 'stale', acknowledgedOffset };
    }
    if (acknowledgedOffset > this.#nextCapturedOffset) {
      return { status: 'invalid', reason: 'beyond-captured', acknowledgedOffset };
    }

    let nextHead = this.#retainedHead;
    while (this.#retained[nextHead]?.endOffset !== undefined &&
      this.#retained[nextHead]!.endOffset < acknowledgedOffset) {
      nextHead += 1;
    }
    if (this.#retained[nextHead]?.endOffset !== acknowledgedOffset) {
      return { status: 'invalid', reason: 'interior-frame', acknowledgedOffset };
    }

    const releasedFrames = nextHead - this.#retainedHead + 1;
    for (let index = this.#retainedHead; index <= nextHead; index += 1) {
      this.#retained[index] = undefined;
    }
    this.#retainedHead = nextHead + 1;
    this.#highestAcknowledgedOffset = acknowledgedOffset;
    this.#compactRetained();
    return {
      status: 'applied',
      acknowledgedOffset,
      releasedFrames
    };
  }

  replay(requestedOffset: number): ReplayResult {
    if (!Number.isInteger(requestedOffset) || requestedOffset < 0) {
      return { status: 'non-resumable', reason: 'invalid-offset', requestedOffset };
    }
    if (requestedOffset < this.#highestAcknowledgedOffset) {
      return { status: 'non-resumable', reason: 'older-than-retained', requestedOffset };
    }
    if (requestedOffset > this.#nextCapturedOffset) {
      return { status: 'non-resumable', reason: 'newer-than-captured', requestedOffset };
    }
    if (requestedOffset === this.#nextCapturedOffset) {
      return {
        status: 'replay',
        requestedOffset,
        frames: []
      };
    }

    let firstIndex = this.#retainedHead;
    while (this.#retained[firstIndex]?.offset !== undefined &&
      this.#retained[firstIndex]!.offset < requestedOffset) {
      firstIndex += 1;
    }
    if (this.#retained[firstIndex]?.offset !== requestedOffset) {
      return { status: 'non-resumable', reason: 'interior-frame', requestedOffset };
    }
    const frames: EncodedAudioFrame[] = [];
    for (let index = firstIndex; index < this.#retained.length; index += 1) {
      const frame = this.#retained[index];
      if (frame !== undefined) {
        frames.push(copyFrame(frame));
      }
    }
    return {
      status: 'replay',
      requestedOffset,
      frames
    };
  }

  reset(utteranceId: string): void {
    assertUuid(utteranceId);
    this.#utteranceId = utteranceId;
    this.#framer.reset();
    this.#nextSequence = 0;
    this.#highestAcknowledgedOffset = 0;
    this.#nextCapturedOffset = 0;
    this.#retained = [];
    this.#retainedHead = 0;
  }

  #compactRetained(): void {
    if (this.#retainedHead === this.#retained.length) {
      this.#retained = [];
      this.#retainedHead = 0;
    } else if (this.#retainedHead >= MAX_AUDIO_PAYLOAD_BYTES / 2) {
      this.#retained = this.#retained.slice(this.#retainedHead);
      this.#retainedHead = 0;
    }
  }
}
