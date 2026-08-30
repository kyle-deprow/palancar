export interface VadRunner {
  detect(samples: Float32Array): Promise<boolean> | boolean;
}
export interface EmbeddingRunner {
  embed(samples: Float32Array): Promise<Float32Array> | Float32Array;
}
export interface SpeakerVerifierConfig {
  /** Trailing audio supplied to VAD and embedding, in milliseconds. Default 1000. */
  readonly windowMs?: number;
  /** Minimum audio-time spacing between embeddings, in milliseconds. Default 250. */
  readonly embedIntervalMs?: number;
  /** EMA weight for a new cosine score. Default 0.4. */
  readonly emaAlpha?: number;
  /** Smoothed score required to enter wearer state. Default 0.75. */
  readonly wearerEnterThreshold?: number;
  /** Smoothed score at or below which wearer state may exit. Default 0.65. */
  readonly wearerExitThreshold?: number;
  /** Consecutive threshold hits required for either state transition. Default 2. */
  readonly minConsecutiveHits?: number;
  /** Neutral score toward which silence decays. Default 0. */
  readonly neutralScore?: number;
}
export interface VerifierDecision {
  readonly speech: boolean;
  /** The latest raw cosine score, or neutral zero when the gate is silent. */
  readonly score: number;
  readonly smoothedScore: number;
  readonly isWearer: boolean;
  /** True only when this call changed isWearer. */
  readonly changed: boolean;
}
export interface VerifierSnapshot {
  readonly audioMs: number;
  readonly retainedSamples: number;
  readonly embeddingsProduced: number;
  readonly lastEmbeddingAtMs: number | undefined;
  readonly score: number;
  readonly smoothedScore: number;
  readonly isWearer: boolean;
  readonly consecutiveHits: number;
}
export interface SpeakerVerifier {
  pushPcm(bytes: Uint8Array): Promise<VerifierDecision>;
  reset(): void;
  /** Permanently clears the verifier and its in-memory centroid. */
  dispose(): void;
  snapshot(): VerifierSnapshot;
}
