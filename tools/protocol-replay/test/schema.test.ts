import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CLIENT_CONTROL_REFERENCES,
  FAULT_CODES,
  MAX_FIXTURE_BYTES,
  MAX_FIXTURE_DURATION_MS,
  MAX_FIXTURE_STEPS,
  ReplayFixtureError,
  parseReplayFixture,
  parseReplayFixtureText
} from '../src/schema.js';
import { fixture } from './helpers.js';

const oneStep = [{ op: 'transport.open' as const }];

describe('protocol replay fixture schema', () => {
  it.each([0, 4_294_967_295])('accepts canonical uint32 seed %s', (seed) => {
    expect(parseReplayFixture(fixture(oneStep, { seed })).seed).toBe(seed);
  });

  it.each(['es', 'tr'] as const)('accepts target %s', (target) => {
    expect(parseReplayFixture(fixture(oneStep, { target })).target).toBe(target);
  });

  it.each([-0, -1, 1.5, 4_294_967_296, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects non-canonical seed %s',
    (seed) => expect(() => parseReplayFixture({ ...fixture(oneStep), seed })).toThrow(ReplayFixtureError)
  );

  it.each([-1, MAX_FIXTURE_DURATION_MS + 1, 0.5])('rejects duration %s', (durationMs) => {
    expect(() => parseReplayFixture({ ...fixture(oneStep), durationMs })).toThrow(ReplayFixtureError);
  });

  it('rejects empty and oversized step lists', () => {
    expect(() => parseReplayFixture({ ...fixture(oneStep), steps: [] })).toThrow(ReplayFixtureError);
    expect(() => parseReplayFixture({
      ...fixture(oneStep),
      steps: Array.from({ length: MAX_FIXTURE_STEPS + 1 }, () => ({ op: 'transport.open' }))
    })).toThrow(ReplayFixtureError);
  });

  it('accepts the inclusive duration and step-count bounds', () => {
    const parsed = parseReplayFixture({
      ...fixture(oneStep, { durationMs: MAX_FIXTURE_DURATION_MS }),
      steps: Array.from({ length: MAX_FIXTURE_STEPS }, () => ({ op: 'transport.open' }))
    });
    expect(parsed.durationMs).toBe(MAX_FIXTURE_DURATION_MS);
    expect(parsed.steps).toHaveLength(MAX_FIXTURE_STEPS);
  });

  it('rejects clock advances beyond declared duration', () => {
    expect(() => parseReplayFixture(fixture([
      { op: 'clock.advance', ms: 11 }
    ], { durationMs: 10 }))).toThrow(ReplayFixtureError);
  });

  it('rejects unknown root and operation keys', () => {
    expect(() => parseReplayFixture({ ...fixture(oneStep), extra: true })).toThrow(ReplayFixtureError);
    expect(() => parseReplayFixture({
      ...fixture(oneStep),
      steps: [{ op: 'transport.open', extra: true }]
    })).toThrow(ReplayFixtureError);
  });

  it('rejects inline identifiers, text, and payload fields', () => {
    for (const extra of ['sessionId', 'utteranceId', 'text', 'transcript', 'credential', 'payload']) {
      expect(() => parseReplayFixture({
        ...fixture(oneStep),
        steps: [{ op: 'client.control', ref: 'session.start', [extra]: 'canary' }]
      })).toThrow(ReplayFixtureError);
    }
  });

  it('rejects open operation, reference, and fault catalogs', () => {
    expect(() => parseReplayFixture({
      ...fixture(oneStep), steps: [{ op: 'network.send' }]
    })).toThrow(ReplayFixtureError);
    expect(() => parseReplayFixture({
      ...fixture(oneStep), steps: [{ op: 'client.control', ref: 'unknown' }]
    })).toThrow(ReplayFixtureError);
    expect(() => parseReplayFixture({
      ...fixture(oneStep), steps: [{ op: 'fault.inject', fault: 'random' }]
    })).toThrow(ReplayFixtureError);
    expect(CLIENT_CONTROL_REFERENCES).toHaveLength(5);
    expect(FAULT_CODES).toHaveLength(18);
  });

  it('rejects strings over 64 UTF-8 bytes and graphs over depth six', () => {
    expect(() => parseReplayFixture({ ...fixture(oneStep), target: 'é'.repeat(33) })).toThrow(
      ReplayFixtureError
    );
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 7; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() => parseReplayFixture(deep)).toThrow(ReplayFixtureError);
  });

  it('rejects cycles, accessors, and hostile proxies without evaluating content', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseReplayFixture(cyclic)).toThrow(ReplayFixtureError);
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'version', {
      enumerable: true,
      get: () => { getterCalls += 1; return 1; }
    });
    expect(() => parseReplayFixture(accessor)).toThrow(ReplayFixtureError);
    expect(getterCalls).toBe(0);
    expect(() => parseReplayFixture(new Proxy({}, {
      ownKeys: () => { throw new Error('canary'); }
    }))).toThrow(ReplayFixtureError);
  });

  it('replaces hostile traps and errors with a fresh fixed fixture error', () => {
    const canary = new Error('authorization=Bearer SECRET-CANARY');
    const hostile = new Proxy({}, { ownKeys: () => { throw canary; } });
    let first: unknown;
    let second: unknown;
    try { parseReplayFixture(hostile); } catch (error) { first = error; }
    try { parseReplayFixture(hostile); } catch (error) { second = error; }
    expect(first).toBeInstanceOf(ReplayFixtureError);
    expect(second).toBeInstanceOf(ReplayFixtureError);
    expect(first).not.toBe(second);
    expect(first).not.toBe(canary);
    expect(String(first)).toBe('ReplayFixtureError: Invalid protocol replay fixture');
  });

  it('rejects transparent proxies at every fixture boundary', () => {
    expect(() => parseReplayFixture(new Proxy(fixture(oneStep), {}))).toThrow(ReplayFixtureError);
    const input = fixture(oneStep);
    expect(() => parseReplayFixture({ ...input, steps: new Proxy([...input.steps], {}) })).toThrow(
      ReplayFixtureError
    );
  });

  it('rejects sparse, accessor-backed, and decorated step arrays', () => {
    const sparse = Array.from({ length: 2 }) as unknown[];
    sparse[0] = { op: 'transport.open' };
    expect(() => parseReplayFixture({ ...fixture(oneStep), steps: sparse })).toThrow(
      ReplayFixtureError
    );

    let getterCalls = 0;
    const accessor = [{ op: 'transport.open' }, { op: 'transport.close' }];
    Object.defineProperty(accessor, '1', {
      enumerable: true,
      get: () => { getterCalls += 1; return { op: 'transport.close' }; }
    });
    expect(() => parseReplayFixture({ ...fixture(oneStep), steps: accessor })).toThrow(
      ReplayFixtureError
    );
    expect(getterCalls).toBe(0);

    const decorated = [...oneStep] as Array<(typeof oneStep)[number]> & { extra?: boolean };
    decorated.extra = true;
    expect(() => parseReplayFixture({ ...fixture(oneStep), steps: decorated })).toThrow(
      ReplayFixtureError
    );
  });

  it('enforces the UTF-8 fixture file bound before parsing', () => {
    const base = JSON.stringify(fixture(oneStep));
    expect(parseReplayFixtureText(base.padEnd(MAX_FIXTURE_BYTES, ' ')).steps).toHaveLength(1);
    expect(() => parseReplayFixtureText(' '.repeat(MAX_FIXTURE_BYTES + 1))).toThrow(
      ReplayFixtureError
    );
  });

  it.each(['es-happy.v1.json', 'tr-cancel.v1.json', 'audio-gap.v1.json'])(
    'parses symbolic fixture %s within the file bound',
    (name) => {
      const text = readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_FIXTURE_BYTES);
      expect(parseReplayFixtureText(text).steps.length).toBeGreaterThan(0);
    }
  );
});
