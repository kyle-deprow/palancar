import type { MetadataEvidenceRecord } from '@palancar/transcription';

import {
  nanosecondsToMilliseconds,
  type MonotonicNanosecondClock
} from './clock.js';
import { type MetadataEvidenceSink } from './evidence.js';
import { spikeFailure } from './errors.js';
import type { SpikeGateDisposition, SpikeTrialResult } from './runner.js';
import type { SpikeTargetLanguage } from './wer.js';

export const EXPLORATORY_MINIMUM_TRIALS = 30;
export const CONFIRMATION_MINIMUM_TRIALS = 200;

export type SpikeAggregatePhase = 'exploratory' | 'confirmation';

export interface SpikeGateCounts {
  readonly expectedAccept: number;
  readonly expectedReject: number;
  readonly correctAccept: number;
  readonly correctReject: number;
  readonly falseAccept: number;
  readonly falseReject: number;
}

export interface SpikeWerSums {
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
  readonly numerator: number;
  readonly denominator: number;
  readonly wordErrorRate: number;
}

export interface LanguageSpikeAggregate {
  readonly targetLanguage: SpikeTargetLanguage;
  readonly trialCount: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly gate: Readonly<SpikeGateCounts>;
  readonly wer: Readonly<SpikeWerSums>;
}

export interface SpikeAggregateResult {
  readonly es: Readonly<LanguageSpikeAggregate>;
  readonly tr: Readonly<LanguageSpikeAggregate>;
}

export interface AggregateSpikeTrialsOptions {
  readonly runId: string;
  readonly phase: SpikeAggregatePhase;
  readonly trials: readonly SpikeTrialResult[];
  readonly evidence: MetadataEvidenceSink;
  readonly clock: MonotonicNanosecondClock;
  readonly startedNs?: bigint;
}

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_AGGREGATE_TRIALS = 250_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isGateDisposition(value: unknown): value is SpikeGateDisposition {
  return value === 'accept' || value === 'reject';
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function expectedWerRate(numerator: number, denominator: number): number {
  return denominator === 0 ? numerator === 0 ? 0 : 1 : numerator / denominator;
}

function validateTrial(trial: unknown): asserts trial is SpikeTrialResult {
  if (!isPlainObject(trial) ||
    (trial.status !== 'completed' && trial.status !== 'failed' &&
      trial.status !== 'timed-out' && trial.status !== 'cancelled') ||
    (trial.targetLanguage !== 'es' && trial.targetLanguage !== 'tr')) {
    spikeFailure('invalid-input');
  }
  if (trial.status !== 'completed') {
    if (!hasExactKeys(trial, ['status', 'targetLanguage'])) spikeFailure('invalid-input');
    return;
  }
  if (
    !hasExactKeys(trial, [
      'status', 'targetLanguage', 'latencyMs', 'wer', 'expectedGate', 'observedGate'
    ]) || typeof trial.latencyMs !== 'number' || !Number.isFinite(trial.latencyMs) ||
    trial.latencyMs < 0 || !isGateDisposition(trial.expectedGate) ||
    !isGateDisposition(trial.observedGate) || !isPlainObject(trial.wer) ||
    !hasExactKeys(trial.wer, [
      'substitutions', 'deletions', 'insertions', 'numerator', 'denominator', 'wordErrorRate'
    ])
  ) {
    spikeFailure('invalid-input');
  }
  const wer = trial.wer;
  if (
    !validCount(wer.substitutions) || !validCount(wer.deletions) ||
    !validCount(wer.insertions) || !validCount(wer.numerator) ||
    !validCount(wer.denominator) ||
    !Number.isSafeInteger(wer.substitutions + wer.deletions + wer.insertions) ||
    wer.numerator !== wer.substitutions + wer.deletions + wer.insertions ||
    typeof wer.wordErrorRate !== 'number' || !Number.isFinite(wer.wordErrorRate) ||
    wer.wordErrorRate !== expectedWerRate(wer.numerator, wer.denominator)
  ) {
    spikeFailure('invalid-input');
  }
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) spikeFailure('insufficient-trials');
  const selected = sorted[Math.ceil(percentile * sorted.length) - 1];
  if (selected === undefined) spikeFailure('insufficient-trials');
  return selected;
}

function safeAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) spikeFailure('invalid-input');
  return sum;
}

function incrementGate(
  counts: {
    expectedAccept: number;
    expectedReject: number;
    correctAccept: number;
    correctReject: number;
    falseAccept: number;
    falseReject: number;
  },
  expected: SpikeGateDisposition,
  observed: SpikeGateDisposition
): void {
  if (expected === 'accept') {
    counts.expectedAccept = safeAdd(counts.expectedAccept, 1);
    if (observed === 'accept') counts.correctAccept = safeAdd(counts.correctAccept, 1);
    else counts.falseReject = safeAdd(counts.falseReject, 1);
  } else {
    counts.expectedReject = safeAdd(counts.expectedReject, 1);
    if (observed === 'reject') counts.correctReject = safeAdd(counts.correctReject, 1);
    else counts.falseAccept = safeAdd(counts.falseAccept, 1);
  }
}

function aggregateLanguage(
  language: SpikeTargetLanguage,
  trials: readonly SpikeTrialResult[],
  minimum: number
): LanguageSpikeAggregate {
  const admitted = trials.filter((trial) => trial.targetLanguage === language);
  if (admitted.length < minimum) spikeFailure('insufficient-trials');
  if (admitted.some((trial) => trial.status !== 'completed')) {
    spikeFailure('insufficient-trials');
  }
  const completed = admitted as readonly (SpikeTrialResult & {
    readonly status: 'completed';
    readonly latencyMs: number;
    readonly wer: WordErrorRateShape;
    readonly expectedGate: SpikeGateDisposition;
    readonly observedGate: SpikeGateDisposition;
  })[];
  const latencies = completed.map((trial) => trial.latencyMs).sort((a, b) => a - b);
  const gate = {
    expectedAccept: 0,
    expectedReject: 0,
    correctAccept: 0,
    correctReject: 0,
    falseAccept: 0,
    falseReject: 0
  };
  const wer = { substitutions: 0, deletions: 0, insertions: 0, numerator: 0, denominator: 0 };
  for (const trial of completed) {
    incrementGate(gate, trial.expectedGate, trial.observedGate);
    wer.substitutions = safeAdd(wer.substitutions, trial.wer.substitutions);
    wer.deletions = safeAdd(wer.deletions, trial.wer.deletions);
    wer.insertions = safeAdd(wer.insertions, trial.wer.insertions);
    wer.numerator = safeAdd(wer.numerator, trial.wer.numerator);
    wer.denominator = safeAdd(wer.denominator, trial.wer.denominator);
  }
  if (gate.expectedAccept === 0 || gate.expectedReject === 0) {
    spikeFailure('insufficient-trials');
  }
  return Object.freeze({
    targetLanguage: language,
    trialCount: completed.length,
    p50LatencyMs: nearestRank(latencies, 0.5),
    p95LatencyMs: nearestRank(latencies, 0.95),
    gate: Object.freeze({ ...gate }),
    wer: Object.freeze({ ...wer, wordErrorRate: expectedWerRate(wer.numerator, wer.denominator) })
  });
}

interface WordErrorRateShape {
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
  readonly numerator: number;
  readonly denominator: number;
  readonly wordErrorRate: number;
}

function emitAggregate(
  aggregate: LanguageSpikeAggregate,
  options: AggregateSpikeTrialsOptions,
  timestamp: string,
  elapsedMs: number
): readonly MetadataEvidenceRecord[] {
  const scores = {
    accuracy: Math.max(0, 1 - Math.min(1, aggregate.wer.wordErrorRate)),
    wordErrorRate: Math.min(1, aggregate.wer.wordErrorRate),
    gateAcceptanceRate: aggregate.gate.correctAccept / aggregate.gate.expectedAccept,
    gateRejectionRate: aggregate.gate.correctReject / aggregate.gate.expectedReject
  };
  const records: MetadataEvidenceRecord[] = [];
  const aggregateRows = [
    [`${aggregate.targetLanguage}.p50`, aggregate.trialCount, aggregate.p50LatencyMs],
    [`${aggregate.targetLanguage}.p95`, aggregate.trialCount, aggregate.p95LatencyMs],
    [`${aggregate.targetLanguage}.expected-accept`, aggregate.gate.expectedAccept, elapsedMs],
    [`${aggregate.targetLanguage}.expected-reject`, aggregate.gate.expectedReject, elapsedMs],
    [`${aggregate.targetLanguage}.false-accept`, aggregate.gate.falseAccept, elapsedMs],
    [`${aggregate.targetLanguage}.false-reject`, aggregate.gate.falseReject, elapsedMs]
  ] as const;
  for (const [status, sampleCount, latencyMs] of aggregateRows) {
    records.push(options.evidence.add({
      event: 'spike.aggregate.completed', timestamp, status, sampleCount, latencyMs, scores
    }));
  }
  const werComponents = [
    ['spike.wer.substitutions', aggregate.wer.substitutions],
    ['spike.wer.deletions', aggregate.wer.deletions],
    ['spike.wer.insertions', aggregate.wer.insertions],
    ['spike.wer.numerator', aggregate.wer.numerator],
    ['spike.wer.denominator', aggregate.wer.denominator]
  ] as const;
  for (const [event, count] of werComponents) {
    records.push(options.evidence.add({
      event, timestamp, status: aggregate.targetLanguage, tokenCount: count
    }));
  }
  return Object.freeze(records);
}

export function aggregateSpikeTrials(
  options: AggregateSpikeTrialsOptions
): Readonly<SpikeAggregateResult> {
  if (
    typeof options !== 'object' || options === null ||
    !OPAQUE_ID_PATTERN.test(options.runId) ||
    (options.phase !== 'exploratory' && options.phase !== 'confirmation') ||
    !Array.isArray(options.trials) || options.trials.length > MAX_AGGREGATE_TRIALS ||
    typeof options.evidence?.add !== 'function' ||
    typeof options.clock?.nowNs !== 'function' ||
    typeof options.clock?.toUtcTimestamp !== 'function'
  ) {
    spikeFailure('invalid-input');
  }
  for (const trial of options.trials) validateTrial(trial);
  const minimum = options.phase === 'exploratory'
    ? EXPLORATORY_MINIMUM_TRIALS
    : CONFIRMATION_MINIMUM_TRIALS;
  const es = aggregateLanguage('es', options.trials, minimum);
  const tr = aggregateLanguage('tr', options.trials, minimum);
  const nowNs = options.clock.nowNs();
  const startedNs = options.startedNs ?? nowNs;
  if (startedNs > nowNs) spikeFailure('invalid-input');
  const timestamp = options.clock.toUtcTimestamp(nowNs);
  const elapsedMs = nanosecondsToMilliseconds(nowNs - startedNs);
  try {
    emitAggregate(es, options, timestamp, elapsedMs);
    emitAggregate(tr, options, timestamp, elapsedMs);
  } catch {
    spikeFailure('invalid-evidence');
  }
  return Object.freeze({ es, tr });
}
