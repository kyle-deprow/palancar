import { decodeAudioFrame, encodeAudioFrame, type AudioFrame } from '@palancar/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ClientAudioQueueError,
  ClientRetainedAudioQueue,
  IdentityAudioResampler,
  OrderedFrameAcceptorError,
  PcmChunkFramer,
  PcmFramerError,
  RelayOrderedFrameAcceptor,
  type EncodedAudioFrame,
  type RelayOrderedFrameAcceptorOptions
} from '../src/index.js';

const UTTERANCE_ID = '11111111-1111-4111-8111-111111111111';
const NEXT_UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';
const RELAY_OPTIONS: RelayOrderedFrameAcceptorOptions = {
  maxAudioPayloadBytes: 3_200,
  maxRetainedReplaySamples: 8_000,
  maxUtteranceSamples: 480_000
};

function relayOptions(
  overrides: Partial<RelayOrderedFrameAcceptorOptions> = {}
): RelayOrderedFrameAcceptorOptions {
  return { ...RELAY_OPTIONS, ...overrides };
}

function nodeBufferFrom(bytes: readonly number[]): Uint8Array | undefined {
  const bufferConstructor = (globalThis as unknown as {
    readonly Buffer?: { from(input: readonly number[]): Uint8Array };
  }).Buffer;
  return bufferConstructor?.from(bytes);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function partition(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let sizeIndex = 0;
  while (offset < bytes.length) {
    const requested = sizes[sizeIndex % sizes.length] ?? 1;
    const end = Math.min(offset + requested, bytes.length);
    chunks.push(bytes.subarray(offset, end));
    offset = end;
    sizeIndex += 1;
  }
  return chunks;
}

function acceptedFrames(result: ReturnType<ClientRetainedAudioQueue['push']>): readonly EncodedAudioFrame[] {
  expect(result.status).toBe('accepted');
  return result.status === 'accepted' ? result.frames : [];
}

function decodedFrame(
  sequence: number,
  offset: number,
  payload: Uint8Array,
  utteranceId = UTTERANCE_ID
): AudioFrame {
  return decodeAudioFrame(encodeAudioFrame({ utteranceId, sequence, offset, payload }));
}

function runtimeFrame(
  sequence: number,
  offset: number,
  payload: Uint8Array,
  utteranceId = UTTERANCE_ID
): AudioFrame {
  return {
    protocolVersion: 1,
    flags: 0,
    utteranceId,
    sequence,
    offset,
    payloadLength: payload.length,
    payload
  } as AudioFrame;
}

describe('PCM chunk normalization and framing', () => {
  it('round-trips arbitrary even PCM across arbitrary partitions', () => {
    const evenPcm = fc
      .array(fc.integer({ min: 0, max: 255 }), { maxLength: 400 })
      .map((bytes) => Uint8Array.from(bytes.slice(0, bytes.length - (bytes.length % 2))));
    const chunkSizes = fc.array(fc.integer({ min: 1, max: 41 }), {
      minLength: 1,
      maxLength: 30
    });

    fc.assert(
      fc.property(evenPcm, chunkSizes, (pcm, sizes) => {
        const framer = new PcmChunkFramer(64);
        const output = partition(pcm, sizes).flatMap((chunk) => framer.push(chunk));
        expect(framer.flush()).toEqual({ status: 'complete' });
        expect(concatenate(output)).toEqual(pcm);
        for (const payload of output) {
          expect(payload.length).toBeGreaterThan(0);
          expect(payload.length % 2).toBe(0);
          expect(payload.length).toBeLessThanOrEqual(64);
        }
      }),
      { seed: 20260810, numRuns: 250, endOnFailure: true }
    );
  });

  it('round-trips an every-one-byte partition in order', () => {
    const pcm = Uint8Array.from({ length: 6_400 }, (_, index) => index % 251);
    const framer = new PcmChunkFramer(3_200);
    const output = Array.from(pcm, (byte) => Uint8Array.of(byte)).flatMap((chunk) =>
      framer.push(chunk)
    );
    expect(framer.flush()).toEqual({ status: 'complete' });
    expect(concatenate(output)).toEqual(pcm);
  });

  it('copies non-zero-offset views before the callback buffer can be reused', () => {
    const backing = Uint8Array.from([99, 1, 2, 3, 4, 88]);
    const framer = new PcmChunkFramer();
    const output = framer.push(backing.subarray(1, 5));
    backing.fill(0);
    expect(output).toEqual([Uint8Array.from([1, 2, 3, 4])]);
  });

  it('carries and reports one trailing byte, then reset clears it', () => {
    const framer = new PcmChunkFramer();
    expect(framer.push(Uint8Array.of(1))).toEqual([]);
    expect(framer.push(Uint8Array.of(2, 3))).toEqual([Uint8Array.of(1, 2)]);
    expect(framer.pendingByteCount).toBe(1);
    expect(framer.flush()).toEqual({ status: 'incomplete-sample', trailingByte: 3 });
    expect(framer.flush()).toEqual({ status: 'complete' });
    framer.push(Uint8Array.of(4));
    framer.reset();
    expect(framer.pendingByteCount).toBe(0);
    expect(framer.flush()).toEqual({ status: 'complete' });
  });

  it('accepts the exact payload cap, splits one sample over, and rejects invalid limits', () => {
    const framer = new PcmChunkFramer(3_200);
    expect(framer.push(new Uint8Array(3_200)).map((part) => part.length)).toEqual([3_200]);
    expect(framer.push(new Uint8Array(3_202)).map((part) => part.length)).toEqual([3_200, 2]);
    for (const invalid of [0, 1, 3_201, 3_202]) {
      expect(() => new PcmChunkFramer(invalid)).toThrow(PcmFramerError);
    }
  });
});

describe('client retained and in-flight queue', () => {
  it('builds monotonic protocol sequences and original-sample offsets', () => {
    const queue = new ClientRetainedAudioQueue(UTTERANCE_ID, {
      maxAudioPayloadBytes: 4,
      maxUnacknowledgedSamples: 8,
      maxRetainedReplaySamples: 8,
      maxUtteranceSamples: 480_000
    });
    const frames = acceptedFrames(queue.push(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])));
    expect(frames.map(({ sequence, offset, sampleCount }) => ({ sequence, offset, sampleCount })))
      .toEqual([
        { sequence: 0, offset: 0, sampleCount: 2 },
        { sequence: 1, offset: 2, sampleCount: 2 }
      ]);
    expect(frames.map((frame) => decodeAudioFrame(frame.bytes).offset)).toEqual([0, 2]);
    expect(queue.state).toMatchObject({
      nextSequence: 2,
      nextCapturedOffset: 4,
      inFlightSamples: 4,
      retainedReplaySamples: 4
    });
  });

  it('accepts exactly 8,000 samples and rejects one over atomically', () => {
    const queue = new ClientRetainedAudioQueue(UTTERANCE_ID, {
      maxAudioPayloadBytes: 3_200,
      maxUnacknowledgedSamples: 8_000,
      maxRetainedReplaySamples: 8_000,
      maxUtteranceSamples: 480_000
    });
    expect(queue.push(new Uint8Array(16_000)).status).toBe('accepted');
    const beforeState = queue.state;
    const beforeReplay = queue.replay(0);
    expect(queue.push(Uint8Array.of(1, 2))).toEqual({
      status: 'overflow',
      attemptedSamples: 1,
      exceededLimits: ['maxUnacknowledgedSamples', 'maxRetainedReplaySamples']
    });
    expect(queue.state).toEqual(beforeState);
    expect(queue.replay(0)).toEqual(beforeReplay);
    expect(() => new ClientRetainedAudioQueue(UTTERANCE_ID, {
      maxAudioPayloadBytes: 3_200,
      maxUnacknowledgedSamples: 8_001,
      maxRetainedReplaySamples: 8_000,
      maxUtteranceSamples: 480_000
    })).toThrow(ClientAudioQueueError);
  });

  it('enforces a lowered retained replay bound independently', () => {
    const queue = new ClientRetainedAudioQueue(UTTERANCE_ID, {
      maxAudioPayloadBytes: 8,
      maxUnacknowledgedSamples: 8,
      maxRetainedReplaySamples: 3,
      maxUtteranceSamples: 480_000
    });
    expect(queue.push(new Uint8Array(6)).status).toBe('accepted');
    expect(queue.push(Uint8Array.of(1, 2))).toEqual({
      status: 'overflow',
      attemptedSamples: 1,
      exceededLimits: ['maxRetainedReplaySamples']
    });
    expect(queue.state.nextCapturedOffset).toBe(3);
  });

  it('enforces lowered payload framing and utterance limits at exact and one-over boundaries', () => {
    const payloadQueue = new ClientRetainedAudioQueue(UTTERANCE_ID, {
      maxAudioPayloadBytes: 4,
      maxUnacknowledgedSamples: 8,
      maxRetainedReplaySamples: 8,
      maxUtteranceSamples: 8
    });
    expect(acceptedFrames(payloadQueue.push(new Uint8Array(4))).map((frame) => frame.bytes.length))
      .toEqual([34]);
    expect(acceptedFrames(payloadQueue.push(new Uint8Array(6))).map((frame) =>
      decodeAudioFrame(frame.bytes).payloadLength
    )).toEqual([4, 2]);

    const utteranceQueue = new ClientRetainedAudioQueue(NEXT_UTTERANCE_ID, {
      maxAudioPayloadBytes: 8,
      maxUnacknowledgedSamples: 8,
      maxRetainedReplaySamples: 8,
      maxUtteranceSamples: 3
    });
    expect(utteranceQueue.push(new Uint8Array(6)).status).toBe('accepted');
    const beforeOverflow = utteranceQueue.state;
    expect(utteranceQueue.push(Uint8Array.of(1, 2))).toEqual({
      status: 'overflow',
      attemptedSamples: 1,
      exceededLimits: ['maxUtteranceSamples']
    });
    expect(utteranceQueue.state).toEqual(beforeOverflow);
    expect(() => new ClientRetainedAudioQueue(UTTERANCE_ID, {
      maxAudioPayloadBytes: 3_202,
      maxUnacknowledgedSamples: 8_000,
      maxRetainedReplaySamples: 8_000,
      maxUtteranceSamples: 480_001
    })).toThrow(ClientAudioQueueError);
  });

  it('applies only boundary ACKs and rejects interior/invalid ACKs without mutation', () => {
    const queue = new ClientRetainedAudioQueue(UTTERANCE_ID, {
      maxAudioPayloadBytes: 8,
      maxUnacknowledgedSamples: 8,
      maxRetainedReplaySamples: 8,
      maxUtteranceSamples: 480_000
    });
    queue.push(new Uint8Array(8));
    const beforeInterior = queue.state;
    expect(queue.acknowledge(2)).toEqual({
      status: 'invalid',
      reason: 'interior-frame',
      acknowledgedOffset: 2
    });
    expect(queue.state).toEqual(beforeInterior);
    expect(queue.acknowledge(-1)).toEqual({
      status: 'invalid',
      reason: 'negative',
      acknowledgedOffset: -1
    });
    expect(queue.acknowledge(1.5)).toEqual({
      status: 'invalid',
      reason: 'non-integer',
      acknowledgedOffset: 1.5
    });
    expect(queue.acknowledge(4)).toEqual({
      status: 'applied',
      acknowledgedOffset: 4,
      releasedFrames: 1
    });
    expect(queue.state).toMatchObject({
      oldestRetainedOffset: 4,
      highestAcknowledgedOffset: 4,
      inFlightSamples: 0,
      retainedFrameCount: 0
    });
    expect(queue.acknowledge(3)).toEqual({ status: 'stale', acknowledgedOffset: 3 });
    expect(queue.acknowledge(4)).toEqual({ status: 'stale', acknowledgedOffset: 4 });
    expect(queue.acknowledge(5)).toEqual({
      status: 'invalid',
      reason: 'beyond-captured',
      acknowledgedOffset: 5
    });
  });

  it('replays inclusively, preserves original bytes, and never advances capture state', () => {
    const queue = new ClientRetainedAudioQueue(UTTERANCE_ID, {
      maxAudioPayloadBytes: 4,
      maxUnacknowledgedSamples: 8,
      maxRetainedReplaySamples: 8,
      maxUtteranceSamples: 480_000
    });
    const original = acceptedFrames(queue.push(new Uint8Array(12)));
    queue.acknowledge(2);
    const before = queue.state;
    const atStart = queue.replay(2);
    expect(atStart.status).toBe('replay');
    if (atStart.status === 'replay') {
      expect(atStart.frames.map((frame) => frame.bytes)).toEqual(
        original.slice(1).map((frame) => frame.bytes)
      );
    }
    const beforeInterior = queue.state;
    expect(queue.replay(3)).toEqual({
      status: 'non-resumable',
      reason: 'interior-frame',
      requestedOffset: 3
    });
    expect(queue.state).toEqual(beforeInterior);
    const empty = queue.replay(6);
    expect(empty).toEqual({
      status: 'replay',
      requestedOffset: 6,
      frames: []
    });
    expect(queue.replay(1)).toMatchObject({
      status: 'non-resumable',
      reason: 'older-than-retained'
    });
    expect(queue.replay(7)).toMatchObject({
      status: 'non-resumable',
      reason: 'newer-than-captured'
    });
    expect(queue.state).toEqual(before);
  });

  it('resets sequence, offsets, ACKs, retained frames, and trailing bytes for a v4 UUID', () => {
    const queue = new ClientRetainedAudioQueue(UTTERANCE_ID, {
      maxAudioPayloadBytes: 4,
      maxUnacknowledgedSamples: 8,
      maxRetainedReplaySamples: 8,
      maxUtteranceSamples: 480_000
    });
    queue.push(Uint8Array.of(1, 2, 3));
    queue.acknowledge(1);
    expect(() => queue.reset('not-a-uuid')).toThrow(ClientAudioQueueError);
    queue.reset(NEXT_UTTERANCE_ID);
    expect(queue.state).toEqual({
      utteranceId: NEXT_UTTERANCE_ID,
      nextSequence: 0,
      oldestRetainedOffset: 0,
      highestAcknowledgedOffset: 0,
      nextCapturedOffset: 0,
      inFlightSamples: 0,
      inFlightInterval: { startOffset: 0, endOffset: 0 },
      retainedReplaySamples: 0,
      replayInterval: { startOffset: 0, endOffset: 0 },
      retainedFrameCount: 0,
      pendingByteCount: 0
    });
    expect(queue.flush()).toEqual({ status: 'complete' });
  });

  it('keeps sequence and offset continuity across arbitrary chunking', () => {
    const evenPcm = fc
      .array(fc.integer({ min: 0, max: 255 }), { maxLength: 500 })
      .map((bytes) => Uint8Array.from(bytes.slice(0, bytes.length - (bytes.length % 2))));
    const chunkSizes = fc.array(fc.integer({ min: 1, max: 29 }), {
      minLength: 1,
      maxLength: 20
    });
    fc.assert(
      fc.property(evenPcm, chunkSizes, (pcm, sizes) => {
        const queue = new ClientRetainedAudioQueue(UTTERANCE_ID, {
          maxAudioPayloadBytes: 10,
          maxUnacknowledgedSamples: 8_000,
          maxRetainedReplaySamples: 8_000,
          maxUtteranceSamples: 480_000
        });
        const frames = partition(pcm, sizes).flatMap((chunk) => acceptedFrames(queue.push(chunk)));
        expect(queue.flush()).toEqual({ status: 'complete' });
        let expectedOffset = 0;
        frames.forEach((frame, sequence) => {
          const decoded = decodeAudioFrame(frame.bytes);
          expect(decoded.sequence).toBe(sequence);
          expect(decoded.offset).toBe(expectedOffset);
          expectedOffset += decoded.payloadLength / 2;
        });
        expect(concatenate(frames.map((frame) => decodeAudioFrame(frame.bytes).payload))).toEqual(pcm);
        expect(queue.state.nextCapturedOffset).toBe(pcm.length / 2);
      }),
      { seed: 20260811, numRuns: 250, endOnFailure: true }
    );
  });
});

describe('relay ordered frame acceptor', () => {
  it('accepts contiguous frames and idempotently ignores an exact duplicate', () => {
    const acceptor = new RelayOrderedFrameAcceptor(
      UTTERANCE_ID,
      relayOptions({ maxRetainedReplaySamples: 8 })
    );
    const first = decodedFrame(0, 0, Uint8Array.of(1, 2, 3, 4));
    const accepted = acceptor.accept(first);
    expect(accepted).toMatchObject({
      status: 'accepted',
      highestContiguousExclusiveOffset: 2,
      chargeSamples: 2
    });
    if (accepted.status === 'accepted') {
      first.payload.fill(0);
      expect(accepted.forwardPayload).toEqual(Uint8Array.of(1, 2, 3, 4));
    }
    const duplicate = decodedFrame(0, 0, Uint8Array.of(1, 2, 3, 4));
    expect(acceptor.accept(duplicate)).toEqual({
      status: 'duplicate',
      highestContiguousExclusiveOffset: 2,
      chargeSamples: 0,
      forwardPayload: undefined
    });
    expect(acceptor.accept(decodedFrame(1, 2, Uint8Array.of(5, 6)))).toMatchObject({
      status: 'accepted',
      highestContiguousExclusiveOffset: 3
    });
  });

  it('copies Buffer-subclass input at forward and retained fingerprint boundaries', () => {
    const input = nodeBufferFrom([1, 2, 3, 4]);
    if (input === undefined) {
      return;
    }
    const acceptor = new RelayOrderedFrameAcceptor(UTTERANCE_ID, RELAY_OPTIONS);
    const accepted = acceptor.accept(runtimeFrame(0, 0, input));
    expect(accepted.status).toBe('accepted');
    input.fill(9);
    if (accepted.status === 'accepted') {
      expect(accepted.forwardPayload).toEqual(Uint8Array.of(1, 2, 3, 4));
      accepted.forwardPayload.fill(8);
    }
    expect(acceptor.accept(runtimeFrame(0, 0, Uint8Array.of(1, 2, 3, 4)))).toMatchObject({
      status: 'duplicate',
      chargeSamples: 0
    });
  });

  it('returns explicit conflicting duplicate, gap, overlap, and wrong-utterance outcomes', () => {
    const conflict = new RelayOrderedFrameAcceptor(UTTERANCE_ID, RELAY_OPTIONS);
    conflict.accept(decodedFrame(0, 0, Uint8Array.of(1, 2)));
    expect(conflict.accept(decodedFrame(0, 0, Uint8Array.of(3, 4)))).toMatchObject({
      status: 'rejected',
      reason: 'conflicting-duplicate'
    });

    const gap = new RelayOrderedFrameAcceptor(UTTERANCE_ID, RELAY_OPTIONS);
    gap.accept(decodedFrame(0, 0, Uint8Array.of(1, 2)));
    expect(gap.accept(decodedFrame(1, 2, Uint8Array.of(3, 4)))).toMatchObject({
      status: 'rejected',
      reason: 'gap'
    });

    const overlap = new RelayOrderedFrameAcceptor(UTTERANCE_ID, RELAY_OPTIONS);
    overlap.accept(decodedFrame(0, 0, Uint8Array.of(1, 2, 3, 4)));
    expect(overlap.accept(decodedFrame(1, 1, Uint8Array.of(5, 6)))).toMatchObject({
      status: 'rejected',
      reason: 'overlap'
    });
    expect(overlap.accept(decodedFrame(1, 2, Uint8Array.of(5, 6), NEXT_UTTERANCE_ID)))
      .toMatchObject({ status: 'rejected', reason: 'wrong-utterance' });
  });

  it('rejects malformed public frames structurally without mutating state', () => {
    const acceptor = new RelayOrderedFrameAcceptor(
      UTTERANCE_ID,
      relayOptions({ maxAudioPayloadBytes: 4, maxUtteranceSamples: 3 })
    );
    const base = runtimeFrame(0, 0, Uint8Array.of(1, 2));
    const malformedNumbers = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, -1, 4_294_967_296];
    const cases: Array<{
      readonly candidate: unknown;
      readonly reason: 'malformed-frame' | 'payload-limit' | 'utterance-limit' | 'wrong-utterance';
    }> = [
      ...malformedNumbers.flatMap((invalid) => [
        { candidate: { ...base, sequence: invalid }, reason: 'malformed-frame' as const },
        { candidate: { ...base, offset: invalid }, reason: 'malformed-frame' as const }
      ]),
      { candidate: { ...base, protocolVersion: 2 }, reason: 'malformed-frame' },
      { candidate: { ...base, flags: 1 }, reason: 'malformed-frame' },
      { candidate: { ...base, utteranceId: 'not-a-uuid' }, reason: 'malformed-frame' },
      { candidate: { ...base, payload: [1, 2] }, reason: 'malformed-frame' },
      { candidate: { ...base, payloadLength: Number.NaN }, reason: 'malformed-frame' },
      { candidate: { ...base, payloadLength: 1.5 }, reason: 'malformed-frame' },
      { candidate: { ...base, payloadLength: 4 }, reason: 'malformed-frame' },
      { candidate: { ...base, payload: new Uint8Array(0), payloadLength: 0 }, reason: 'malformed-frame' },
      { candidate: { ...base, payload: new Uint8Array(3), payloadLength: 3 }, reason: 'malformed-frame' },
      { candidate: { ...base, payload: new Uint8Array(6), payloadLength: 6 }, reason: 'payload-limit' },
      { candidate: { ...base, offset: 3 }, reason: 'utterance-limit' },
      { candidate: { ...base, utteranceId: NEXT_UTTERANCE_ID }, reason: 'wrong-utterance' }
    ];

    for (const { candidate, reason } of cases) {
      const before = acceptor.state;
      expect(acceptor.accept(candidate as AudioFrame)).toMatchObject({
        status: 'rejected',
        reason
      });
      expect(acceptor.state).toEqual(before);
    }
  });

  it('enforces lowered payload and utterance limits at exact and one-over boundaries', () => {
    const payloadAcceptor = new RelayOrderedFrameAcceptor(
      UTTERANCE_ID,
      relayOptions({ maxAudioPayloadBytes: 4 })
    );
    expect(payloadAcceptor.accept(runtimeFrame(0, 0, new Uint8Array(4))).status).toBe('accepted');
    const payloadBefore = payloadAcceptor.state;
    expect(payloadAcceptor.accept(runtimeFrame(1, 2, new Uint8Array(6)))).toMatchObject({
      status: 'rejected',
      reason: 'payload-limit'
    });
    expect(payloadAcceptor.state).toEqual(payloadBefore);

    const utteranceAcceptor = new RelayOrderedFrameAcceptor(
      NEXT_UTTERANCE_ID,
      relayOptions({ maxAudioPayloadBytes: 8, maxUtteranceSamples: 3 })
    );
    expect(utteranceAcceptor.accept(
      runtimeFrame(0, 0, new Uint8Array(6), NEXT_UTTERANCE_ID)
    ).status).toBe('accepted');
    const utteranceBefore = utteranceAcceptor.state;
    expect(utteranceAcceptor.accept(
      runtimeFrame(1, 3, Uint8Array.of(1, 2), NEXT_UTTERANCE_ID)
    )).toMatchObject({ status: 'rejected', reason: 'utterance-limit' });
    expect(utteranceAcceptor.state).toEqual(utteranceBefore);
  });

  it('rejects utterance overflow and treats duplicates outside the bounded window as stale', () => {
    const acceptor = new RelayOrderedFrameAcceptor(
      UTTERANCE_ID,
      relayOptions({ maxRetainedReplaySamples: 2 })
    );
    const valid = decodedFrame(0, 0, Uint8Array.of(1, 2, 3, 4));
    const beyondLimit = { ...valid, offset: 479_999 };
    expect(acceptor.accept(beyondLimit)).toMatchObject({
      status: 'rejected',
      reason: 'utterance-limit'
    });
    acceptor.accept(valid);
    acceptor.accept(decodedFrame(1, 2, Uint8Array.of(5, 6, 7, 8)));
    expect(acceptor.state).toMatchObject({
      retainedFingerprintSamples: 2,
      retainedFingerprintCount: 1
    });
    expect(acceptor.accept(decodedFrame(0, 0, Uint8Array.of(1, 2, 3, 4)))).toMatchObject({
      status: 'rejected',
      reason: 'stale-frame'
    });
  });

  it('accepts the 8,000-sample replay cap, rejects one over, and resets safely', () => {
    const acceptor = new RelayOrderedFrameAcceptor(UTTERANCE_ID, RELAY_OPTIONS);
    expect(Object.isFrozen(acceptor.options)).toBe(true);
    expect(() => new RelayOrderedFrameAcceptor(
      UTTERANCE_ID,
      relayOptions({ maxRetainedReplaySamples: 8_001 })
    )).toThrow(
      OrderedFrameAcceptorError
    );
    expect(() => new RelayOrderedFrameAcceptor(
      UTTERANCE_ID,
      relayOptions({ maxAudioPayloadBytes: 3_202 })
    )).toThrow(OrderedFrameAcceptorError);
    expect(() => new RelayOrderedFrameAcceptor(
      UTTERANCE_ID,
      relayOptions({ maxUtteranceSamples: 480_001 })
    )).toThrow(OrderedFrameAcceptorError);
    expect(() => acceptor.reset('11111111-1111-1111-8111-111111111111')).toThrow(
      OrderedFrameAcceptorError
    );
    acceptor.accept(decodedFrame(0, 0, Uint8Array.of(1, 2)));
    acceptor.reset(NEXT_UTTERANCE_ID);
    expect(acceptor.state).toEqual({
      utteranceId: NEXT_UTTERANCE_ID,
      nextSequence: 0,
      highestContiguousExclusiveOffset: 0,
      retainedFingerprintSamples: 0,
      retainedFingerprintCount: 0
    });
  });
});

describe('state-machine and high-frame-count regressions', () => {
  it('matches a client queue model across push, ACK, replay, and reset sequences', () => {
    const commandArbitrary = fc.array(
      fc.constantFrom(
        'push',
        'ack-boundary',
        'ack-stale',
        'ack-interior',
        'ack-future',
        'replay-valid',
        'replay-interior',
        'replay-old',
        'replay-future',
        'reset'
      ),
      { minLength: 1, maxLength: 80 }
    );

    fc.assert(
      fc.property(commandArbitrary, (commands) => {
        let utteranceId = UTTERANCE_ID;
        const queue = new ClientRetainedAudioQueue(utteranceId, {
          maxAudioPayloadBytes: 4,
          maxUnacknowledgedSamples: 16,
          maxRetainedReplaySamples: 16,
          maxUtteranceSamples: 64
        });
        let nextSequence = 0;
        let acknowledgedOffset = 0;
        let nextCapturedOffset = 0;
        let frames: Array<{ readonly offset: number; readonly endOffset: number }> = [];

        const expectModel = (): void => {
          expect(queue.state).toMatchObject({
            utteranceId,
            nextSequence,
            oldestRetainedOffset: acknowledgedOffset,
            highestAcknowledgedOffset: acknowledgedOffset,
            nextCapturedOffset,
            inFlightSamples: nextCapturedOffset - acknowledgedOffset,
            retainedReplaySamples: nextCapturedOffset - acknowledgedOffset,
            retainedFrameCount: frames.length,
            pendingByteCount: 0
          });
          expect(queue.state.inFlightSamples).toBeGreaterThanOrEqual(0);
          expect(queue.state.inFlightSamples).toBeLessThanOrEqual(16);
        };

        for (const command of commands) {
          const before = queue.state;
          switch (command) {
            case 'push': {
              const shouldAccept =
                nextCapturedOffset + 2 <= 64 && nextCapturedOffset - acknowledgedOffset + 2 <= 16;
              const result = queue.push(Uint8Array.of(1, 2, 3, 4));
              expect(result.status).toBe(shouldAccept ? 'accepted' : 'overflow');
              if (result.status === 'accepted') {
                expect(result.frames).toHaveLength(1);
                frames.push({ offset: nextCapturedOffset, endOffset: nextCapturedOffset + 2 });
                nextCapturedOffset += 2;
                nextSequence += 1;
              } else {
                expect(queue.state).toEqual(before);
              }
              break;
            }
            case 'ack-boundary': {
              const target = frames[0]?.endOffset ?? acknowledgedOffset;
              const result = queue.acknowledge(target);
              if (frames.length === 0) {
                expect(result.status).toBe('stale');
              } else {
                expect(result).toMatchObject({ status: 'applied', acknowledgedOffset: target });
                acknowledgedOffset = target;
                frames = frames.slice(1);
              }
              break;
            }
            case 'ack-stale': {
              const target = Math.max(0, acknowledgedOffset - 1);
              expect(queue.acknowledge(target).status).toBe('stale');
              expect(queue.state).toEqual(before);
              break;
            }
            case 'ack-interior': {
              const first = frames[0];
              if (first === undefined) {
                expect(queue.acknowledge(acknowledgedOffset + 0.5)).toMatchObject({
                  status: 'invalid',
                  reason: 'non-integer'
                });
              } else {
                expect(queue.acknowledge(first.offset + 1)).toMatchObject({
                  status: 'invalid',
                  reason: 'interior-frame'
                });
              }
              expect(queue.state).toEqual(before);
              break;
            }
            case 'ack-future':
              expect(queue.acknowledge(nextCapturedOffset + 1)).toMatchObject({
                status: 'invalid',
                reason: 'beyond-captured'
              });
              expect(queue.state).toEqual(before);
              break;
            case 'replay-valid': {
              const target = frames[0]?.offset ?? nextCapturedOffset;
              const result = queue.replay(target);
              expect(result.status).toBe('replay');
              if (result.status === 'replay') {
                expect(result.frames.every((frame) => frame.offset >= target)).toBe(true);
              }
              expect(queue.state).toEqual(before);
              break;
            }
            case 'replay-interior': {
              const first = frames[0];
              if (first !== undefined) {
                expect(queue.replay(first.offset + 1)).toMatchObject({
                  status: 'non-resumable',
                  reason: 'interior-frame'
                });
              } else {
                expect(queue.replay(nextCapturedOffset + 0.5)).toMatchObject({
                  status: 'non-resumable',
                  reason: 'invalid-offset'
                });
              }
              expect(queue.state).toEqual(before);
              break;
            }
            case 'replay-old': {
              const target = acknowledgedOffset > 0 ? acknowledgedOffset - 1 : -1;
              expect(queue.replay(target).status).toBe('non-resumable');
              expect(queue.state).toEqual(before);
              break;
            }
            case 'replay-future':
              expect(queue.replay(nextCapturedOffset + 1)).toMatchObject({
                status: 'non-resumable',
                reason: 'newer-than-captured'
              });
              expect(queue.state).toEqual(before);
              break;
            case 'reset':
              utteranceId = utteranceId === UTTERANCE_ID ? NEXT_UTTERANCE_ID : UTTERANCE_ID;
              queue.reset(utteranceId);
              nextSequence = 0;
              acknowledgedOffset = 0;
              nextCapturedOffset = 0;
              frames = [];
              break;
          }
          expectModel();
        }
      }),
      { seed: 20260812, numRuns: 220, endOnFailure: true }
    );
  });

  it('matches a relay model across ordering, duplicates, eviction, and reset', () => {
    const commandArbitrary = fc.array(
      fc.constantFrom(
        'accept',
        'duplicate',
        'evicted-or-duplicate',
        'conflict',
        'gap',
        'overlap',
        'malformed',
        'reset'
      ),
      { minLength: 1, maxLength: 80 }
    );

    fc.assert(
      fc.property(commandArbitrary, (commands) => {
        let utteranceId = UTTERANCE_ID;
        const acceptor = new RelayOrderedFrameAcceptor(utteranceId, {
          maxAudioPayloadBytes: 2,
          maxRetainedReplaySamples: 5,
          maxUtteranceSamples: 200
        });
        let frames: AudioFrame[] = [];

        const expectModel = (): void => {
          expect(acceptor.state).toEqual({
            utteranceId,
            nextSequence: frames.length,
            highestContiguousExclusiveOffset: frames.length,
            retainedFingerprintSamples: Math.min(frames.length, 5),
            retainedFingerprintCount: Math.min(frames.length, 5)
          });
        };

        for (const command of commands) {
          const before = acceptor.state;
          const sequence = frames.length;
          switch (command) {
            case 'accept': {
              const frame = runtimeFrame(
                sequence,
                sequence,
                Uint8Array.of(sequence % 251, (sequence + 1) % 251),
                utteranceId
              );
              expect(acceptor.accept(frame).status).toBe('accepted');
              frames.push(frame);
              break;
            }
            case 'duplicate': {
              const frame = frames.at(-1);
              if (frame !== undefined) {
                expect(acceptor.accept(frame).status).toBe('duplicate');
                expect(acceptor.state).toEqual(before);
              }
              break;
            }
            case 'evicted-or-duplicate': {
              const frame = frames[0];
              if (frame !== undefined) {
                const result = acceptor.accept(frame);
                expect(result.status).toBe(frames.length > 5 ? 'rejected' : 'duplicate');
                if (frames.length > 5) {
                  expect(result).toMatchObject({ reason: 'stale-frame' });
                }
                expect(acceptor.state).toEqual(before);
              }
              break;
            }
            case 'conflict': {
              const frame = frames.at(-1);
              if (frame !== undefined) {
                expect(acceptor.accept({ ...frame, payload: Uint8Array.of(253, 254) })).toMatchObject({
                  status: 'rejected',
                  reason: 'conflicting-duplicate'
                });
                expect(acceptor.state).toEqual(before);
              }
              break;
            }
            case 'gap':
              expect(acceptor.accept(
                runtimeFrame(sequence + 1, sequence + 1, Uint8Array.of(1, 2), utteranceId)
              )).toMatchObject({ status: 'rejected', reason: 'gap' });
              expect(acceptor.state).toEqual(before);
              break;
            case 'overlap':
              if (sequence > 0) {
                expect(acceptor.accept(
                  runtimeFrame(sequence, sequence - 1, Uint8Array.of(1, 2), utteranceId)
                )).toMatchObject({ status: 'rejected', reason: 'overlap' });
              }
              expect(acceptor.state).toEqual(before);
              break;
            case 'malformed':
              expect(acceptor.accept({
                ...runtimeFrame(sequence, sequence, Uint8Array.of(1, 2), utteranceId),
                flags: 1
              } as unknown as AudioFrame)).toMatchObject({
                status: 'rejected',
                reason: 'malformed-frame'
              });
              expect(acceptor.state).toEqual(before);
              break;
            case 'reset':
              utteranceId = utteranceId === UTTERANCE_ID ? NEXT_UTTERANCE_ID : UTTERANCE_ID;
              acceptor.reset(utteranceId);
              frames = [];
              break;
          }
          expectModel();
        }
      }),
      { seed: 20260813, numRuns: 220, endOnFailure: true }
    );
  });

  it('handles 24,000 one-sample frames with bounded live state', () => {
    const frameCount = 24_000;
    const queue = new ClientRetainedAudioQueue(UTTERANCE_ID, {
      maxAudioPayloadBytes: 2,
      maxUnacknowledgedSamples: 8_000,
      maxRetainedReplaySamples: 8_000,
      maxUtteranceSamples: frameCount
    });
    for (let block = 0; block < 3; block += 1) {
      const blockStart = block * 8_000;
      expect(queue.push(new Uint8Array(16_000)).status).toBe('accepted');
      for (let offset = blockStart + 1; offset <= blockStart + 8_000; offset += 1) {
        expect(queue.acknowledge(offset).status).toBe('applied');
      }
    }
    expect(queue.state).toMatchObject({
      nextSequence: frameCount,
      nextCapturedOffset: frameCount,
      retainedFrameCount: 0,
      inFlightSamples: 0
    });

    const acceptor = new RelayOrderedFrameAcceptor(UTTERANCE_ID, {
      maxAudioPayloadBytes: 2,
      maxRetainedReplaySamples: 8_000,
      maxUtteranceSamples: frameCount
    });
    for (let sequence = 0; sequence < frameCount; sequence += 1) {
      expect(acceptor.accept(
        runtimeFrame(sequence, sequence, Uint8Array.of(sequence % 251, 0))
      ).status).toBe('accepted');
    }
    expect(acceptor.state).toMatchObject({
      nextSequence: frameCount,
      highestContiguousExclusiveOffset: frameCount,
      retainedFingerprintSamples: 8_000,
      retainedFingerprintCount: 8_000
    });
    expect(acceptor.accept(runtimeFrame(frameCount - 1, frameCount - 1, Uint8Array.of(
      (frameCount - 1) % 251,
      0
    ))).status).toBe('duplicate');
    expect(acceptor.accept(runtimeFrame(0, 0, Uint8Array.of(0, 0)))).toMatchObject({
      status: 'rejected',
      reason: 'stale-frame'
    });
  });
});

describe('stateful resampler abstraction', () => {
  it('identity conversion declares native-rate capabilities and never aliases buffers', () => {
    const resampler = new IdentityAudioResampler();
    expect(resampler.capabilities).toEqual({
      inputSampleRateHz: 16_000,
      outputSampleRateHz: 16_000,
      channels: 1,
      sampleFormat: 's16le',
      stateful: false
    });
    expect(Object.isFrozen(resampler.capabilities)).toBe(true);
    const input = Uint8Array.of(1, 2, 3, 4);
    const output = resampler.push(input);
    input[0] = 9;
    expect(output).toEqual(Uint8Array.of(1, 2, 3, 4));
    output[1] = 9;
    expect(input[1]).toBe(2);
    expect(resampler.flush()).toEqual(new Uint8Array(0));
    resampler.reset();
    expect(resampler.flush()).toEqual(new Uint8Array(0));
    expect(resampler.push(Uint8Array.of(5, 6))).toEqual(Uint8Array.of(5, 6));
  });

  it('copies Buffer-subclass input in the identity resampler', () => {
    const input = nodeBufferFrom([1, 2, 3, 4]);
    if (input === undefined) {
      return;
    }
    const output = new IdentityAudioResampler().push(input);
    input.fill(9);
    expect(output).toEqual(Uint8Array.of(1, 2, 3, 4));
  });
});
