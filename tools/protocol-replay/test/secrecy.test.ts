import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createReplayCatalog } from '../src/catalog.js';
import { replayFixture } from '../src/replay.js';
import { REPLAY_CATEGORIES, serializeReplayReport, type ReplayReport } from '../src/report.js';
import { ReplayFixtureError, parseReplayFixture } from '../src/schema.js';
import { faultFixture, fixture } from './helpers.js';

const reportKeys = ['version', 'seed', 'outcome', 'category', 'counts', 'timings'];
const countKeys = [
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
];
const timingKeys = ['startedAtMs', 'finishedAtMs', 'lastEventAtMs'];

function expectContentFreeShape(report: ReplayReport): void {
  expect(Object.keys(report)).toEqual(reportKeys);
  expect(Object.keys(report.counts)).toEqual(countKeys);
  expect(Object.keys(report.timings)).toEqual(timingKeys);
  expect(['completed', 'faulted']).toContain(report.outcome);
  expect(REPLAY_CATEGORIES).toContain(report.category);

  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      expect([...REPLAY_CATEGORIES, 'completed', 'faulted']).toContain(value);
      expect(value).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/iu);
      expect(value).not.toMatch(/(?:https?:|wss?:|authorization|bearer|cookie|pairing)/iu);
      return;
    }
    if (typeof value === 'number') {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      return;
    }
    expect(value).toBeTypeOf('object');
    expect(value).not.toBeNull();
    for (const nested of Object.values(value as Record<string, unknown>)) visit(nested);
  };
  visit(report);
}

describe('content-free reports', () => {
  it.each([
    fixture([{ op: 'transport.open' }]),
    faultFixture('identity.stale-session'),
    faultFixture('provider.failure'),
    faultFixture('control.invalid-utf8')
  ])('has an exact recursively constrained report shape', (input) => {
    expectContentFreeShape(replayFixture(input));
  });

  it('contains no fixture references, generated identities, or generated content', () => {
    const input = faultFixture('identity.stale-utterance');
    const catalog = createReplayCatalog(input.seed, input.target);
    const serialized = serializeReplayReport(replayFixture(input));
    const forbidden = [
      ...input.steps.flatMap((step) => [
        step.op,
        'ref' in step ? step.ref : '',
        'fault' in step ? step.fault : ''
      ]),
      ...Object.values(catalog.identities).filter(
        (value): value is string => typeof value === 'string'
      ),
      'synthetic partial',
      'synthetic final',
      'synthetic result',
      'target one',
      'Session unavailable',
      'Protocol unavailable'
    ].filter((value) => value.length > 0);

    for (const value of forbidden) expect(serialized).not.toContain(value);
  });

  it('returns a fixed schema error without reflecting adversarial input', () => {
    const canary = 'Bearer SECRET-CANARY';
    let error: unknown;
    try {
      parseReplayFixture({ ...fixture([{ op: 'transport.open' }]), authorization: canary });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ReplayFixtureError);
    expect(String(error)).not.toContain(canary);
  });

  it('freezes the report tree against post-replay contamination', () => {
    const report = replayFixture(faultFixture('state.unavailable'));
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.counts)).toBe(true);
    expect(Object.isFrozen(report.timings)).toBe(true);
  });

  it('keeps replay-critical modules free of ambient time, network, and random APIs', () => {
    for (const name of ['catalog.ts', 'mutations.ts', 'replay.ts', 'virtual-clock.ts']) {
      const source = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/Date\.now|setTimeout|setInterval|fetch\s*\(|WebSocket|Math\.random|randomUUID/u);
    }
  });
});
