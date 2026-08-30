import { describe, expect, it } from "vitest";

import {
  cosineSimilarity,
  createEnrollmentSession,
  createLocalStorageCentroidStore,
  createSpeakerVerifier,
  PcmSlidingWindow,
  type EmbeddingRunner,
  type VadRunner,
} from "../src/voice/index.js";

function pcm(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  samples.forEach((sample, index) => {
    const unsigned = sample < 0 ? sample + 0x1_0000 : sample;
    bytes[index * 2] = unsigned & 0xff;
    bytes[index * 2 + 1] = (unsigned >>> 8) & 0xff;
  });
  return bytes;
}

function repeatedPcm(sample: number, count: number): Uint8Array {
  return pcm(Array.from({ length: count }, () => sample));
}

function fixedEmbedding(vector: readonly number[]): EmbeddingRunner {
  return { embed: () => new Float32Array(vector) };
}

function scriptedEmbedding(vectors: readonly (readonly number[])[]): EmbeddingRunner & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    embed: () => {
      const vector = vectors[Math.min(calls, vectors.length - 1)] ?? [];
      calls += 1;
      return new Float32Array(vector);
    },
  };
}

function scriptedVad(speech: boolean | readonly boolean[]): VadRunner & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    detect: () => {
      const result = typeof speech === "boolean" ? speech : speech[Math.min(calls, speech.length - 1)] ?? false;
      calls += 1;
      return result;
    },
  };
}

async function pushFrames(
  push: (bytes: Uint8Array, speech?: boolean) => Promise<unknown>,
  count: number,
  samplesPerFrame: number,
  speech = true,
): Promise<void> {
  const frame = repeatedPcm(1_000, samplesPerFrame);
  for (let i = 0; i < count; i += 1) await push(frame, speech);
}

describe("PCM sliding window", () => {
  it("returns the trailing requested samples in chronological order", () => {
    const window = new PcmSlidingWindow(4);
    window.push(pcm([1, 2, 3, 4]));
    expect([...window.trailingSamples(0.125)]).toEqual([3 / 32_768, 4 / 32_768]);
  });

  it("handles wraparound, partial frames, and an oversized frame", () => {
    const wrapped = new PcmSlidingWindow(4);
    wrapped.push(pcm([1, 2, 3]));
    wrapped.push(pcm([4, 5]));
    expect([...wrapped.trailingSamples()]).toEqual([2, 3, 4, 5].map((item) => item / 32_768));

    const partial = new PcmSlidingWindow(2);
    partial.push(new Uint8Array([0x34]));
    expect(partial.pendingByteCount).toBe(1);
    partial.push(new Uint8Array([0x12, 0, 0]));
    expect([...partial.trailingSamples()]).toEqual([0x1234 / 32_768, 0]);

    const oversized = new PcmSlidingWindow(3);
    oversized.push(pcm([1, 2, 3, 4, 5]));
    expect([...oversized.trailingSamples()]).toEqual([3, 4, 5].map((item) => item / 32_768));
  });

  it("normalises signed samples and clear zeroes retained audio", () => {
    const window = new PcmSlidingWindow(2);
    window.push(pcm([-32_768, 32_767]));
    expect([...window.trailingSamples()]).toEqual([-1, 32_767 / 32_768]);
    window.clear();
    expect(window.sampleCount).toBe(0);
    expect(window.pendingByteCount).toBe(0);
    expect(window.trailingSamples()).toHaveLength(0);
  });
});

describe("speaker verification", () => {
  const cadenceConfig = {
    windowMs: 1_000,
    embedIntervalMs: 250,
    emaAlpha: 1,
    wearerEnterThreshold: 0.8,
    wearerExitThreshold: 0.4,
    minConsecutiveHits: 2,
  } as const;

  it("scores orthogonal, identical, and zero-norm vectors safely", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
    expect(cosineSimilarity(new Float32Array([2, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0);
    expect(Number.isNaN(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([0, 0])))).toBe(false);
    expect(cosineSimilarity(new Float32Array([Number.NaN, 0]), new Float32Array([1, 0]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([Number.POSITIVE_INFINITY, 0]), new Float32Array([1, 0]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([0.1, 0.2]), new Float32Array([0.1, 0.2]))).toBeLessThanOrEqual(1);
    expect(cosineSimilarity(new Float32Array([0.1, 0.2]), new Float32Array([0.1, 0.2]))).toBeGreaterThanOrEqual(-1);
    expect(() => cosineSimilarity(new Float32Array([1]), new Float32Array([1, 0]))).toThrow(RangeError);
  });

  it("rejects non-finite verifier configuration and unusable centroids", () => {
    const base = {
      vad: scriptedVad(true),
      embedding: fixedEmbedding([1, 0]),
      centroid: new Float32Array([1, 0]),
    };
    for (const config of [
      { emaAlpha: Number.NaN },
      { wearerEnterThreshold: Number.NaN },
      { wearerExitThreshold: Number.NaN },
      { neutralScore: Number.NaN },
    ]) {
      expect(() => createSpeakerVerifier({ ...base, config })).toThrow(RangeError);
    }
    expect(() => createSpeakerVerifier({ ...base, centroid: new Float32Array([0, 0]) })).toThrow(RangeError);
    expect(() => createSpeakerVerifier({ ...base, centroid: new Float32Array([Number.NaN, 1]) })).toThrow(RangeError);
  });

  it("embeds on cadence rather than on every 60 ms frame", async () => {
    const embedding = scriptedEmbedding([[1, 0]]);
    const verifier = createSpeakerVerifier({
      vad: scriptedVad(true),
      embedding,
      centroid: new Float32Array([1, 0]),
      config: cadenceConfig,
    });
    await pushFrames(verifier.pushPcm, 34, 960);
    expect(embedding.calls).toBe(4);
    expect(verifier.snapshot().embeddingsProduced).toBe(4);
  });

  it("gates embedding entirely when VAD reports silence", async () => {
    const embedding = scriptedEmbedding([[1, 0]]);
    const verifier = createSpeakerVerifier({
      vad: scriptedVad(false),
      embedding,
      centroid: new Float32Array([1, 0]),
      config: cadenceConfig,
    });
    const decision = await verifier.pushPcm(repeatedPcm(1_000, 960));
    await pushFrames(verifier.pushPcm, 20, 960);
    expect(decision.speech).toBe(false);
    expect(embedding.calls).toBe(0);
  });

  it("honours hysteresis, consecutive hits, holds the middle band, and reports exact flips", async () => {
    const embedding = scriptedEmbedding([
      [1, 0], [1, 0], [0.6, 0.8], [0, 1], [0, 1],
    ]);
    const verifier = createSpeakerVerifier({
      vad: scriptedVad(true),
      embedding,
      centroid: new Float32Array([1, 0]),
      config: { ...cadenceConfig, windowMs: 1, embedIntervalMs: 1 },
    });
    const first = await verifier.pushPcm(repeatedPcm(1_000, 16));
    const entered = await verifier.pushPcm(repeatedPcm(1_000, 16));
    const middle = await verifier.pushPcm(repeatedPcm(1_000, 16));
    const firstExit = await verifier.pushPcm(repeatedPcm(1_000, 16));
    const exited = await verifier.pushPcm(repeatedPcm(1_000, 16));

    expect(first.isWearer).toBe(false);
    expect(first.changed).toBe(false);
    expect(entered.isWearer).toBe(true);
    expect(entered.changed).toBe(true);
    expect(middle.smoothedScore).toBeCloseTo(0.6);
    expect(middle.isWearer).toBe(true);
    expect(middle.changed).toBe(false);
    expect(firstExit.isWearer).toBe(true);
    expect(firstExit.changed).toBe(false);
    expect(exited.isWearer).toBe(false);
    expect(exited.changed).toBe(true);
  });

  it("does not reuse the entry streak on an immediate reverse edge", async () => {
    const embedding = scriptedEmbedding([[1, 0], [1, 0], [0, 1], [0, 1]]);
    const verifier = createSpeakerVerifier({
      vad: scriptedVad(true),
      embedding,
      centroid: new Float32Array([1, 0]),
      config: { ...cadenceConfig, windowMs: 1, embedIntervalMs: 1 },
    });
    await verifier.pushPcm(repeatedPcm(1_000, 16));
    const entered = await verifier.pushPcm(repeatedPcm(1_000, 16));
    const firstReverse = await verifier.pushPcm(repeatedPcm(1_000, 16));
    const exited = await verifier.pushPcm(repeatedPcm(1_000, 16));

    expect(entered.isWearer).toBe(true);
    expect(firstReverse.isWearer).toBe(true);
    expect(firstReverse.changed).toBe(false);
    expect(exited.isWearer).toBe(false);
    expect(exited.changed).toBe(true);
  });

  it("has chunk-independent fixed-hop decisions and embedding cadence", async () => {
    const audio = repeatedPcm(1_000, 34 * 960);
    const largeEmbedding = scriptedEmbedding([[1, 0]]);
    const largeVerifier = createSpeakerVerifier({
      vad: scriptedVad(true),
      embedding: largeEmbedding,
      centroid: new Float32Array([1, 0]),
      config: cadenceConfig,
    });
    const largeDecision = await largeVerifier.pushPcm(audio);

    const smallEmbedding = scriptedEmbedding([[1, 0]]);
    const smallVerifier = createSpeakerVerifier({
      vad: scriptedVad(true),
      embedding: smallEmbedding,
      centroid: new Float32Array([1, 0]),
      config: cadenceConfig,
    });
    let smallDecision = await smallVerifier.pushPcm(audio.subarray(0, 0));
    for (let offset = 0; offset < audio.length; offset += 1_920) {
      smallDecision = await smallVerifier.pushPcm(audio.subarray(offset, Math.min(offset + 1_920, audio.length)));
    }

    expect(largeEmbedding.calls).toBe(smallEmbedding.calls);
    expect(largeEmbedding.calls).toBe(4);
    expect(largeVerifier.snapshot()).toMatchObject(smallVerifier.snapshot());
    expect(largeDecision).toEqual(smallDecision);
  });

  it("invalidates deferred inference when reset races the runner", async () => {
    let resolveVad: ((speech: boolean) => void) | undefined;
    let vadCalls = 0;
    const verifier = createSpeakerVerifier({
      vad: {
        detect: () => {
          vadCalls += 1;
          if (vadCalls === 1) return new Promise<boolean>((resolve) => { resolveVad = resolve; });
          return true;
        },
      },
      embedding: fixedEmbedding([1, 0]),
      centroid: new Float32Array([1, 0]),
      config: { ...cadenceConfig, windowMs: 1, embedIntervalMs: 1 },
    });
    const stale = verifier.pushPcm(repeatedPcm(1_000, 16));
    verifier.reset();
    resolveVad?.(true);
    await stale;

    expect(verifier.snapshot()).toMatchObject({ audioMs: 0, retainedSamples: 0, embeddingsProduced: 0, isWearer: false });
    await verifier.pushPcm(repeatedPcm(1_000, 16));
    await verifier.pushPcm(repeatedPcm(1_000, 16));
    expect(verifier.snapshot().embeddingsProduced).toBe(2);
  });

  it("disposes the centroid and ignores later audio", async () => {
    const embedding = scriptedEmbedding([[1, 0], [1, 0], [1, 0]]);
    const verifier = createSpeakerVerifier({
      vad: scriptedVad(true),
      embedding,
      centroid: new Float32Array([1, 0]),
      config: { ...cadenceConfig, windowMs: 1, embedIntervalMs: 1 },
    });
    await verifier.pushPcm(repeatedPcm(1_000, 16));
    await verifier.pushPcm(repeatedPcm(1_000, 16));
    expect(verifier.snapshot().isWearer).toBe(true);
    verifier.dispose();
    await verifier.pushPcm(repeatedPcm(1_000, 32));
    expect(verifier.snapshot()).toMatchObject({ audioMs: 0, embeddingsProduced: 0, isWearer: false });
    expect(embedding.calls).toBe(2);
  });
});

describe("voice enrollment", () => {
  const config = {
    minEnrollmentMs: 1_000,
    minEnrollmentEmbeddings: 3,
    minEnrollmentCoherence: 0.5,
    windowMs: 250,
    embedIntervalMs: 250,
  } as const;

  it("produces a normalised centroid from speech-gated audio", async () => {
    const session = createEnrollmentSession({ embedding: fixedEmbedding([3, 0]), config });
    await session.pushPcm(repeatedPcm(1_000, 4_000), false);
    await pushFrames(session.pushPcm, 4, 4_000);
    const result = await session.complete();
    expect(result.centroid[0]).toBeCloseTo(1);
    expect(result.centroid[1]).toBeCloseTo(0);
    expect(Math.hypot(...result.centroid)).toBeCloseTo(1);
    expect(result.embeddingCount).toBeGreaterThanOrEqual(3);
  });

  it("fails loudly when too few embeddings were collected", async () => {
    const session = createEnrollmentSession({
      embedding: fixedEmbedding([1, 0]),
      config: { ...config, minEnrollmentEmbeddings: 8, embedIntervalMs: 1_000 },
    });
    await pushFrames(session.pushPcm, 4, 4_000);
    await expect(session.complete()).rejects.toMatchObject({ reason: "insufficient-embeddings" });
  });

  it("fails loudly for incoherent embeddings", async () => {
    const embedding = scriptedEmbedding([[1, 0], [-1, 0]]);
    const session = createEnrollmentSession({
      embedding,
      config: { ...config, minEnrollmentMs: 500, minEnrollmentEmbeddings: 2 },
    });
    await pushFrames(session.pushPcm, 2, 4_000);
    await expect(session.complete()).rejects.toMatchObject({ reason: "invalid-embedding" });
  });

  it("does not duplicate the final cadence embedding and normalises unequal magnitudes", async () => {
    const embedding = scriptedEmbedding([[2, 0], [1, 0], [0, 1]]);
    const session = createEnrollmentSession({
      embedding,
      config: {
        minEnrollmentMs: 1,
        minEnrollmentEmbeddings: 2,
        minEnrollmentCoherence: 0.5,
        windowMs: 1,
        embedIntervalMs: 1,
      },
    });
    await session.pushPcm(repeatedPcm(1_000, 16), true);
    await session.pushPcm(repeatedPcm(1_000, 16), true);
    const result = await session.complete();

    expect(embedding.calls).toBe(2);
    expect(result.embeddingCount).toBe(2);
    expect(result.centroid[0]).toBeCloseTo(1);
    expect(result.centroid[1]).toBeCloseTo(0);
  });

  it("rejects non-finite enrollment coherence and keeps speech alignment explicit", async () => {
    expect(() => createEnrollmentSession({
      embedding: fixedEmbedding([1, 0]),
      config: { minEnrollmentCoherence: Number.NaN },
    })).toThrow(RangeError);

    const session = createEnrollmentSession({
      embedding: fixedEmbedding([1, 0]),
      config: { ...config, minEnrollmentMs: 1, minEnrollmentEmbeddings: 1 },
    });
    await session.pushPcm(new Uint8Array([0x34]), true);
    await session.pushPcm(new Uint8Array([0x12]), false);
    await session.pushPcm(new Uint8Array([0x78]));
    expect(session.snapshot().speechMs).toBe(0);
    await session.pushPcm(new Uint8Array([0x56]), true);
    await session.pushPcm(new Uint8Array([0x34, 0x12]), true);
    expect(session.snapshot().speechMs).toBeCloseTo(1_000 / 16_000);
    expect(session.snapshot().retainedSamples).toBe(1);
  });
});

describe("centroid store", () => {
  function memoryStorage(): Map<string, string> & {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  } {
    const values = new Map<string, string>();
    return Object.assign(values, {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    });
  }

  it("round-trips, tolerates absent/corrupt data, and genuinely clears", () => {
    const storage = memoryStorage();
    const store = createLocalStorageCentroidStore({
      storage,
      key: "centroid",
      embeddingModelId: "model-a",
      calibrationId: "calibration-a",
    });
    expect(store.load()).toBeUndefined();
    expect(store.save(new Float32Array([0.6, 0.8]))).toBe(true);
    expect(store.load()?.[0]).toBeCloseTo(0.6);
    expect(store.load()?.[1]).toBeCloseTo(0.8);
    const record = JSON.parse(storage.getItem("centroid") ?? "null") as Record<string, unknown>;
    storage.setItem("centroid", JSON.stringify({ ...record, embeddingModelId: "model-b" }));
    expect(store.load()).toBeUndefined();
    expect(store.save(new Float32Array([0, 0]))).toBe(false);
    expect(store.save(new Float32Array([Number.NaN, 1]))).toBe(false);
    storage.setItem("centroid", "corrupt");
    expect(store.load()).toBeUndefined();
    expect(store.clear()).toBe(true);
    expect(storage.getItem("centroid")).toBeNull();
    expect(store.load()).toBeUndefined();
  });
});
