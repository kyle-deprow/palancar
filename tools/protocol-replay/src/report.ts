import { isProxy } from 'node:util/types';

export const REPLAY_REPORT_VERSION = 1 as const;

export const REPLAY_CATEGORIES = Object.freeze([
  'ok',
  'fixture.invalid',
  'fault.drop',
  'fault.duplicate',
  'fault.delay',
  'fault.reorder',
  'transport.closed',
  'transport.disconnected',
  'transport.stale-generation',
  'protocol.order',
  'control.invalid',
  'control.size-limit',
  'audio.invalid',
  'audio.size-limit',
  'audio.sequence-gap',
  'audio.sequence-overlap',
  'audio.sequence-conflict',
  'revision.nonmonotonic',
  'identity.session-mismatch',
  'identity.utterance-mismatch',
  'provider.unavailable',
  'state.persistence-unavailable'
] as const);

export const REPLAY_OUTCOMES = Object.freeze(['completed', 'faulted'] as const);

export type ReplayCategory = (typeof REPLAY_CATEGORIES)[number];
export type ReplayOutcome = (typeof REPLAY_OUTCOMES)[number];

export interface ReplayCounts {
  readonly steps: number;
  readonly delivered: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly dropped: number;
  readonly stale: number;
  readonly duplicated: number;
  readonly delayed: number;
  readonly reordered: number;
  readonly disconnects: number;
}

export interface ReplayTimings {
  readonly startedAtMs: 0;
  readonly finishedAtMs: number;
  readonly lastEventAtMs: number;
}

export interface ReplayReport {
  readonly version: typeof REPLAY_REPORT_VERSION;
  readonly seed: number;
  readonly outcome: ReplayOutcome;
  readonly category: ReplayCategory;
  readonly counts: ReplayCounts;
  readonly timings: ReplayTimings;
}

export interface ReplayReportInput {
  readonly seed: number;
  readonly category: ReplayCategory;
  readonly counts: ReplayCounts;
  readonly finishedAtMs: number;
  readonly lastEventAtMs: number;
}

export class ReplayReportError extends TypeError {
  constructor() {
    super('Invalid protocol replay report');
    this.name = 'ReplayReportError';
  }
}

const REPORT_KEYS = Object.freeze([
  'version',
  'seed',
  'outcome',
  'category',
  'counts',
  'timings'
] as const);
const COUNT_KEYS = Object.freeze([
  'steps',
  'delivered',
  'accepted',
  'rejected',
  'dropped',
  'stale',
  'duplicated',
  'delayed',
  'reordered',
  'disconnects'
] as const);
const TIMING_KEYS = Object.freeze(['startedAtMs', 'finishedAtMs', 'lastEventAtMs'] as const);
const INPUT_KEYS = Object.freeze([
  'seed',
  'category',
  'counts',
  'finishedAtMs',
  'lastEventAtMs'
] as const);

function fail(): never {
  throw new ReplayReportError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotValues(
  input: unknown,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  if (!isRecord(input)) fail();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key) => typeof key === 'string' && expectedKeys.includes(key))
  ) fail();
  const output: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail();
    output[key] = descriptor.value;
  }
  return output;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0;
}

function isSeed(value: unknown): value is number {
  return isSafeCount(value) && value <= 4_294_967_295;
}

function isCategory(value: unknown): value is ReplayCategory {
  return typeof value === 'string' && REPLAY_CATEGORIES.includes(value as ReplayCategory);
}

function isOutcome(value: unknown): value is ReplayOutcome {
  return typeof value === 'string' && REPLAY_OUTCOMES.includes(value as ReplayOutcome);
}

function snapshotCounts(input: unknown): ReplayCounts {
  const values = snapshotValues(input, COUNT_KEYS);
  for (const key of COUNT_KEYS) {
    if (!isSafeCount(values[key])) fail();
  }
  const counts = values as unknown as ReplayCounts;
  if (counts.delivered !== counts.accepted + counts.rejected || counts.stale > counts.dropped) {
    fail();
  }
  return Object.freeze({
    steps: counts.steps,
    delivered: counts.delivered,
    accepted: counts.accepted,
    rejected: counts.rejected,
    dropped: counts.dropped,
    stale: counts.stale,
    duplicated: counts.duplicated,
    delayed: counts.delayed,
    reordered: counts.reordered,
    disconnects: counts.disconnects
  });
}

function snapshotTimings(input: unknown): ReplayTimings {
  const values = snapshotValues(input, TIMING_KEYS);
  const startedAtMs = values.startedAtMs;
  const finishedAtMs = values.finishedAtMs;
  const lastEventAtMs = values.lastEventAtMs;
  if (
    !Object.is(startedAtMs, 0) ||
    !isSafeCount(finishedAtMs) ||
    !isSafeCount(lastEventAtMs) ||
    lastEventAtMs > finishedAtMs
  ) fail();
  return Object.freeze({ startedAtMs: 0 as const, finishedAtMs, lastEventAtMs });
}

function snapshotReport(input: unknown): ReplayReport {
  const values = snapshotValues(input, REPORT_KEYS);
  if (
    values.version !== REPLAY_REPORT_VERSION ||
    !isSeed(values.seed) ||
    !isOutcome(values.outcome) ||
    !isCategory(values.category) ||
    (values.category === 'ok') !== (values.outcome === 'completed')
  ) fail();
  return Object.freeze({
    version: REPLAY_REPORT_VERSION,
    seed: values.seed,
    outcome: values.outcome,
    category: values.category,
    counts: snapshotCounts(values.counts),
    timings: snapshotTimings(values.timings)
  });
}

export function parseReplayReport(input: unknown): ReplayReport {
  try {
    return snapshotReport(input);
  } catch {
    throw new ReplayReportError();
  }
}

export function createReplayReport(input: ReplayReportInput): ReplayReport {
  try {
    const values = snapshotValues(input, INPUT_KEYS);
    if (
      !isSeed(values.seed) ||
      !isCategory(values.category) ||
      !isSafeCount(values.finishedAtMs) ||
      !isSafeCount(values.lastEventAtMs)
    ) fail();
    return snapshotReport({
      version: REPLAY_REPORT_VERSION,
      seed: values.seed,
      outcome: values.category === 'ok' ? 'completed' : 'faulted',
      category: values.category,
      counts: values.counts,
      timings: {
        startedAtMs: 0,
        finishedAtMs: values.finishedAtMs,
        lastEventAtMs: values.lastEventAtMs
      }
    });
  } catch {
    throw new ReplayReportError();
  }
}

export function serializeReplayReport(report: ReplayReport): string {
  const snapshot = parseReplayReport(report);
  return `${JSON.stringify(snapshot)}\n`;
}
