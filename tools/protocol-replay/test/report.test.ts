import { describe, expect, it } from 'vitest';

import {
  REPLAY_CATEGORIES,
  REPLAY_OUTCOMES,
  ReplayReportError,
  createReplayReport,
  parseReplayReport,
  serializeReplayReport,
  type ReplayReport
} from '../src/report.js';

function reportObject(): ReplayReport {
  return {
    version: 1,
    seed: 19,
    outcome: 'completed',
    category: 'ok',
    counts: {
      steps: 1,
      delivered: 1,
      accepted: 1,
      rejected: 0,
      dropped: 0,
      stale: 0,
      duplicated: 0,
      delayed: 0,
      reordered: 0,
      disconnects: 0
    },
    timings: { startedAtMs: 0, finishedAtMs: 2, lastEventAtMs: 1 }
  };
}

function fixedReportError(action: () => unknown): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ReplayReportError);
  expect(String(error)).toBe('ReplayReportError: Invalid protocol replay report');
}

describe('public replay report boundary', () => {
  it('validates, snapshots, and recursively freezes an ordinary report', () => {
    const input = reportObject();
    const snapshot = parseReplayReport(input);
    (input.counts as { accepted: number }).accepted = 0;

    expect(snapshot.counts.accepted).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.counts)).toBe(true);
    expect(Object.isFrozen(snapshot.timings)).toBe(true);
  });

  it('publishes closed category and outcome vocabularies', () => {
    expect(new Set(REPLAY_OUTCOMES)).toEqual(new Set(['completed', 'faulted']));
    expect(REPLAY_CATEGORIES).toContain('transport.stale-generation');
    expect(new Set(REPLAY_CATEGORIES).size).toBe(REPLAY_CATEGORIES.length);
  });

  it.each([
    { extra: true },
    { [Symbol('extra')]: true }
  ])('rejects extra report keys and symbols', (extra) => {
    fixedReportError(() => parseReplayReport({ ...reportObject(), ...extra }));
  });

  it('rejects extra nested count and timing keys', () => {
    const report = reportObject();
    fixedReportError(() => parseReplayReport({
      ...report,
      counts: { ...report.counts, authorization: 'Bearer CANARY' }
    }));
    fixedReportError(() => parseReplayReport({
      ...report,
      timings: { ...report.timings, wallClock: 3 }
    }));
  });

  it('rejects accessors without invoking them', () => {
    let calls = 0;
    const report = reportObject() as unknown as Record<string, unknown>;
    Object.defineProperty(report, 'seed', {
      enumerable: true,
      get: () => { calls += 1; return 19; }
    });
    fixedReportError(() => parseReplayReport(report));
    expect(calls).toBe(0);
  });

  it('rejects non-enumerable data descriptors', () => {
    const report = reportObject() as unknown as Record<string, unknown>;
    Object.defineProperty(report, 'seed', { value: 19, enumerable: false });
    fixedReportError(() => parseReplayReport(report));
  });

  it.each([
    ['outcome', 'unknown'],
    ['category', 'fault.requested'],
    ['seed', -0],
    ['seed', 4_294_967_296]
  ])('rejects invalid public field %s', (key, value) => {
    fixedReportError(() => parseReplayReport({ ...reportObject(), [key]: value }));
  });

  it('requires outcome and category to agree', () => {
    fixedReportError(() => parseReplayReport({ ...reportObject(), outcome: 'faulted' }));
    fixedReportError(() => parseReplayReport({
      ...reportObject(),
      outcome: 'completed',
      category: 'protocol.order'
    }));
  });

  it('enforces safe count and timing invariants', () => {
    const report = reportObject();
    fixedReportError(() => parseReplayReport({
      ...report,
      counts: { ...report.counts, delivered: 2 }
    }));
    fixedReportError(() => parseReplayReport({
      ...report,
      counts: { ...report.counts, dropped: 0, stale: 1 }
    }));
    fixedReportError(() => parseReplayReport({
      ...report,
      counts: { ...report.counts, steps: Number.POSITIVE_INFINITY }
    }));
    fixedReportError(() => parseReplayReport({
      ...report,
      timings: { ...report.timings, lastEventAtMs: 3 }
    }));
  });

  it('converts hostile proxy traps to a fresh fixed error', () => {
    const canary = new Error('authorization=Bearer SECRET-CANARY');
    const hostile = new Proxy(reportObject(), {
      ownKeys: () => { throw canary; }
    });
    let first: unknown;
    let second: unknown;
    try { parseReplayReport(hostile); } catch (error) { first = error; }
    try { parseReplayReport(hostile); } catch (error) { second = error; }
    expect(first).toBeInstanceOf(ReplayReportError);
    expect(second).toBeInstanceOf(ReplayReportError);
    expect(first).not.toBe(second);
    expect(first).not.toBe(canary);
    expect(String(first)).not.toContain('SECRET-CANARY');
  });

  it('rejects transparent root and nested proxies', () => {
    fixedReportError(() => parseReplayReport(new Proxy(reportObject(), {})));
    const report = reportObject();
    fixedReportError(() => parseReplayReport({
      ...report,
      counts: new Proxy(report.counts, {})
    }));
  });

  it('rejects nested symbols and accessors without invoking them', () => {
    const report = reportObject();
    fixedReportError(() => parseReplayReport({
      ...report,
      counts: { ...report.counts, [Symbol('canary')]: true }
    }));
    let calls = 0;
    const timings = { ...report.timings } as Record<string, unknown>;
    Object.defineProperty(timings, 'lastEventAtMs', {
      enumerable: true,
      get: () => { calls += 1; return 1; }
    });
    fixedReportError(() => parseReplayReport({ ...report, timings }));
    expect(calls).toBe(0);
  });

  it('revalidates before serialization and never invokes hostile toJSON', () => {
    let calls = 0;
    const hostile = reportObject() as ReplayReport & { toJSON?: () => unknown };
    Object.defineProperty(hostile, 'toJSON', {
      enumerable: true,
      get: () => { calls += 1; return () => ({ authorization: 'Bearer SECRET-CANARY' }); }
    });
    fixedReportError(() => serializeReplayReport(hostile));
    expect(calls).toBe(0);
  });

  it('serializes only a revalidated content-free snapshot', () => {
    const report = createReplayReport({
      seed: 20,
      category: 'protocol.order',
      counts: { ...reportObject().counts, accepted: 0, rejected: 1 },
      finishedAtMs: 2,
      lastEventAtMs: 1
    });
    expect(JSON.parse(serializeReplayReport(report))).toEqual(report);
    expect(serializeReplayReport(report)).not.toMatch(/authorization|CANARY|https?:\/\//iu);
  });
});
