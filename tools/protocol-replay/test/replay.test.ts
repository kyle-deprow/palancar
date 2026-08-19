import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { createReplayCatalog } from '../src/catalog.js';
import { replayFixture } from '../src/replay.js';
import type { ReplayCategory } from '../src/report.js';
import { FAULT_CODES, parseReplayFixtureText, type FaultCode, type ReplayStep } from '../src/schema.js';
import { faultFixture, fixture } from './helpers.js';

const expectedFaultCategories: Readonly<Record<FaultCode, string>> = {
  'drop.next': 'fault.drop',
  'duplicate.next': 'fault.duplicate',
  'delay.next': 'fault.delay',
  'reorder.pair': 'fault.reorder',
  'disconnect.next': 'transport.disconnected',
  'control.malformed': 'control.invalid',
  'control.invalid-utf8': 'control.invalid',
  'control.oversize': 'control.size-limit',
  'audio.oversize': 'audio.size-limit',
  'audio.corrupt': 'audio.invalid',
  'audio.gap': 'audio.sequence-gap',
  'audio.overlap': 'audio.sequence-overlap',
  'audio.conflict': 'audio.sequence-conflict',
  'revision.regression': 'revision.nonmonotonic',
  'identity.stale-session': 'identity.session-mismatch',
  'identity.stale-utterance': 'identity.utterance-mismatch',
  'provider.failure': 'provider.unavailable',
  'state.unavailable': 'state.persistence-unavailable'
};

const schedulingFaults = new Set<FaultCode>([
  'drop.next',
  'duplicate.next',
  'delay.next',
  'reorder.pair',
  'disconnect.next'
]);

const activeMutationMatrix = [
  {
    fault: 'control.malformed',
    client: 'control.invalid',
    server: 'control.invalid',
    audio: 'control.invalid'
  },
  {
    fault: 'control.invalid-utf8',
    client: 'control.invalid',
    server: 'control.invalid',
    audio: 'control.invalid'
  },
  {
    fault: 'control.oversize',
    client: 'control.size-limit',
    server: 'control.size-limit',
    audio: 'control.size-limit'
  },
  {
    fault: 'audio.oversize',
    client: 'audio.size-limit',
    server: 'audio.size-limit',
    audio: 'audio.size-limit'
  },
  {
    fault: 'audio.corrupt',
    client: 'audio.invalid',
    server: 'audio.invalid',
    audio: 'audio.invalid'
  },
  {
    fault: 'audio.gap',
    client: 'audio.invalid',
    server: 'audio.invalid',
    audio: 'audio.sequence-gap'
  },
  {
    fault: 'audio.overlap',
    client: 'audio.invalid',
    server: 'audio.invalid',
    audio: 'ok',
    audioRef: 'audio.frame.0'
  },
  {
    fault: 'audio.conflict',
    client: 'audio.invalid',
    server: 'audio.invalid',
    audio: 'audio.sequence-conflict',
    audioRef: 'audio.frame.0'
  },
  {
    fault: 'revision.regression',
    client: 'control.invalid',
    server: 'ok',
    audio: 'control.size-limit'
  },
  {
    fault: 'identity.stale-session',
    client: 'identity.session-mismatch',
    server: 'identity.session-mismatch',
    audio: 'audio.invalid'
  },
  {
    fault: 'identity.stale-utterance',
    client: 'identity.utterance-mismatch',
    server: 'identity.utterance-mismatch',
    audio: 'audio.invalid'
  },
  {
    fault: 'provider.failure',
    client: 'provider.unavailable',
    server: 'provider.unavailable',
    audio: 'provider.unavailable'
  },
  {
    fault: 'state.unavailable',
    client: 'state.persistence-unavailable',
    server: 'state.persistence-unavailable',
    audio: 'state.persistence-unavailable'
  }
] as const satisfies readonly {
  fault: FaultCode;
  client: ReplayCategory;
  server: ReplayCategory;
  audio: ReplayCategory;
  audioRef?: 'audio.frame.0' | 'audio.frame.1';
}[];

type ActivePacketKind = 'client' | 'server' | 'audio';

function activeMutationFixture(
  fault: FaultCode,
  packetKind: ActivePacketKind,
  audioRef: 'audio.frame.0' | 'audio.frame.1' = 'audio.frame.1'
) {
  const steps: ReplayStep[] = [
    { op: 'transport.open' },
    { op: 'client.control', ref: 'session.start' },
    { op: 'server.control', ref: 'session.ready' },
    { op: 'client.control', ref: 'utterance.start' },
    { op: 'client.audio', ref: 'audio.frame.0' },
    { op: 'fault.inject', fault }
  ];
  steps.push(packetKind === 'client'
    ? { op: 'client.control', ref: 'utterance.start' }
    : packetKind === 'server'
      ? { op: 'server.control', ref: 'transcript.partial' }
      : { op: 'client.audio', ref: audioRef });
  return fixture(steps);
}

const activeMutationCases = activeMutationMatrix.flatMap((entry) =>
  (['client', 'server', 'audio'] as const).map((packetKind) => ({
    fault: entry.fault,
    packetKind,
    expected: entry[packetKind],
    audioRef: 'audioRef' in entry ? entry.audioRef : undefined
  }))
);

function incompatibleFaultFixture(fault: FaultCode) {
  const steps: ReplayStep[] = [
    { op: 'fault.inject', fault },
    { op: 'client.control', ref: 'session.start' }
  ];
  if (fault === 'reorder.pair') steps.push({ op: 'client.control', ref: 'session.start' });
  if (fault === 'delay.next') steps.push({ op: 'clock.advance', ms: 10 });
  return fixture(steps, { durationMs: fault === 'delay.next' ? 10 : 0 });
}

function loadFixture(name: string) {
  return parseReplayFixtureText(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
  );
}

describe('deterministic protocol replay', () => {
  it.each(['es-happy.v1.json', 'tr-cancel.v1.json'])('completes %s', (name) => {
    const report = replayFixture(loadFixture(name));
    expect(report).toMatchObject({ outcome: 'completed', category: 'ok' });
    expect(report.counts.rejected).toBe(0);
    expect(report.counts.accepted).toBeGreaterThan(0);
  });

  it('replays the same fixture to a deeply equal report', () => {
    const input = loadFixture('es-happy.v1.json');
    expect(replayFixture(input)).toEqual(replayFixture(input));
  });

  it('uses only the virtual fixture timeline', () => {
    const now = vi.spyOn(Date, 'now');
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const fetch = vi.spyOn(globalThis, 'fetch');

    const report = replayFixture(loadFixture('es-happy.v1.json'));

    expect(report.timings).toEqual({ startedAtMs: 0, finishedAtMs: 100, lastEventAtMs: 100 });
    expect(now).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it.each(Object.entries(expectedFaultCategories) as [FaultCode, string][])(
    'injects %s as stable category %s',
    (fault, expected) => {
      const report = replayFixture(faultFixture(fault));
      expect(report.outcome).toBe('faulted');
      expect(report.category).toBe(expected);
      expect(report.seed).toBe(7);
    }
  );

  it.each(FAULT_CODES)('reports observed compatible/incompatible outcomes for %s', (fault) => {
    expect(replayFixture(faultFixture(fault)).category).toBe(expectedFaultCategories[fault]);
    expect(replayFixture(incompatibleFaultFixture(fault)).category).toBe(
      schedulingFaults.has(fault) ? expectedFaultCategories[fault] : 'protocol.order'
    );
  });

  it.each(activeMutationCases)(
    'observes $fault on active $packetKind packets as $expected',
    ({ fault, packetKind, expected, audioRef }) => {
      const report = replayFixture(activeMutationFixture(fault, packetKind, audioRef));
      expect(report.category).toBe(expected);
      expect(report.outcome).toBe(expected === 'ok' ? 'completed' : 'faulted');
      expect(report.counts.delivered).toBe(report.counts.accepted + report.counts.rejected);
    }
  );

  it('uses actual control parser rejection for malformed control', () => {
    const report = replayFixture(faultFixture('control.malformed'));
    expect(report.counts).toMatchObject({ delivered: 5, accepted: 4, rejected: 1 });
  });

  it('uses actual binary parser rejection for corrupt audio', () => {
    const report = replayFixture(faultFixture('audio.corrupt'));
    expect(report.counts).toMatchObject({ delivered: 5, accepted: 4, rejected: 1 });
  });

  it('preserves same-time reorder insertion semantics', () => {
    const report = replayFixture(faultFixture('reorder.pair'));
    expect(report.category).toBe('fault.reorder');
    expect(report.counts).toMatchObject({ reordered: 1, delivered: 6, rejected: 1 });
    expect(report.timings).toEqual({ startedAtMs: 0, finishedAtMs: 0, lastEventAtMs: 0 });
  });

  it('rejects impossible protocol ordering independently of faults', () => {
    const report = replayFixture(fixture([
      { op: 'transport.open' },
      { op: 'client.control', ref: 'utterance.start' }
    ]));
    expect(report).toMatchObject({ outcome: 'faulted', category: 'protocol.order' });
  });

  it.each([
    ['closed error', [
      { op: 'transport.open' },
      { op: 'transport.close' },
      { op: 'server.control', ref: 'error.protocol' }
    ]],
    ['terminal error', [
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' },
      { op: 'server.control', ref: 'session.ready' },
      { op: 'client.control', ref: 'session.end' },
      { op: 'server.control', ref: 'error.protocol' }
    ]],
    ['closed session.ready', [
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' },
      { op: 'transport.close' },
      { op: 'server.control', ref: 'session.ready' }
    ]],
    ['terminal session.ready', [
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' },
      { op: 'server.control', ref: 'session.rejected' },
      { op: 'server.control', ref: 'session.ready' }
    ]],
    ['closed transcript', [
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' },
      { op: 'server.control', ref: 'session.ready' },
      { op: 'client.control', ref: 'utterance.start' },
      { op: 'transport.close' },
      { op: 'server.control', ref: 'transcript.partial' }
    ]],
    ['terminal transcript', [
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' },
      { op: 'server.control', ref: 'session.ready' },
      { op: 'client.control', ref: 'utterance.start' },
      { op: 'client.control', ref: 'session.end' },
      { op: 'server.control', ref: 'transcript.partial' }
    ]]
  ] as const)('rejects the %s probe as protocol ordering', (_name, steps) => {
    const report = replayFixture(fixture(steps));
    expect(report.category).toBe('protocol.order');
    expect(report.counts.rejected).toBe(1);
  });

  it('derives distinct deterministic identities and epochs for transport generations', () => {
    const first = createReplayCatalog(25, 'es', 1).identities;
    const second = createReplayCatalog(25, 'es', 2).identities;
    expect(first.sessionEpoch).toBe(1);
    expect(second.sessionEpoch).toBe(2);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.utteranceId).not.toBe(first.utteranceId);
    expect(createReplayCatalog(25, 'es', 2).identities).toEqual(second);
  });

  it('cancels delayed packets across close and reopen without mutating the new session', () => {
    const report = replayFixture(fixture([
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' },
      { op: 'fault.inject', fault: 'delay.next' },
      { op: 'server.control', ref: 'session.ready' },
      { op: 'transport.close' },
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' },
      { op: 'server.control', ref: 'session.ready' },
      { op: 'clock.advance', ms: 10 }
    ], { durationMs: 10 }));
    expect(report.category).toBe('fault.delay');
    expect(report.counts).toMatchObject({
      delivered: 3,
      accepted: 3,
      rejected: 0,
      delayed: 1,
      dropped: 1,
      stale: 1
    });
  });

  it('drops a held reorder packet at a generation boundary', () => {
    const report = replayFixture(fixture([
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' },
      { op: 'fault.inject', fault: 'reorder.pair' },
      { op: 'server.control', ref: 'session.ready' },
      { op: 'transport.close' },
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' },
      { op: 'server.control', ref: 'session.ready' }
    ]));
    expect(report.category).toBe('transport.stale-generation');
    expect(report.counts).toMatchObject({ reordered: 0, dropped: 1, stale: 1 });
  });

  it('clears pending faults before packets in the next generation', () => {
    const report = replayFixture(fixture([
      { op: 'transport.open' },
      { op: 'fault.inject', fault: 'control.malformed' },
      { op: 'transport.close' },
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' }
    ]));
    expect(report).toMatchObject({ outcome: 'completed', category: 'ok' });
    expect(report.counts).toMatchObject({ delivered: 1, accepted: 1, rejected: 0 });
  });

  it.each([
    ['audio.overlap', [
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' },
      { op: 'server.control', ref: 'session.ready' },
      { op: 'client.control', ref: 'utterance.start' },
      { op: 'fault.inject', fault: 'audio.overlap' },
      { op: 'client.audio', ref: 'audio.frame.0' }
    ]],
    ['audio.conflict', [
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' },
      { op: 'server.control', ref: 'session.ready' },
      { op: 'client.control', ref: 'utterance.start' },
      { op: 'client.audio', ref: 'audio.frame.0' },
      { op: 'fault.inject', fault: 'audio.conflict' },
      { op: 'client.audio', ref: 'audio.frame.1' }
    ]],
    ['revision.regression', [
      { op: 'transport.open' },
      { op: 'client.control', ref: 'session.start' },
      { op: 'server.control', ref: 'session.ready' },
      { op: 'client.control', ref: 'utterance.start' },
      { op: 'fault.inject', fault: 'revision.regression' },
      { op: 'server.control', ref: 'transcript.partial' }
    ]]
  ] as const)('does not premark a no-op %s mutation', (_fault, steps) => {
    expect(replayFixture(fixture(steps))).toMatchObject({ outcome: 'completed', category: 'ok' });
  });

  it('reports the parser result when an audio mutation targets control', () => {
    const report = replayFixture(fixture([
      { op: 'transport.open' },
      { op: 'fault.inject', fault: 'audio.gap' },
      { op: 'client.control', ref: 'session.start' }
    ]));
    expect(report.category).toBe('audio.invalid');
  });

  it('reports the parser result when an identity mutation targets session.start', () => {
    const report = replayFixture(fixture([
      { op: 'transport.open' },
      { op: 'fault.inject', fault: 'identity.stale-utterance' },
      { op: 'client.control', ref: 'session.start' }
    ]));
    expect(report.category).toBe('control.invalid');
  });

  it.each([
    ['client control', { op: 'client.control', ref: 'session.start' }],
    ['server control', { op: 'server.control', ref: 'error.protocol' }],
    ['client audio', { op: 'client.audio', ref: 'audio.frame.0' }]
  ] as const)('enforces the closed transport boundary for %s', (_name, probe) => {
    const report = replayFixture(fixture([
      { op: 'transport.open' },
      { op: 'transport.close' },
      probe
    ]));
    expect(report.category).toBe('protocol.order');
    expect(report.counts).toMatchObject({ delivered: 1, accepted: 0, rejected: 1 });
  });
});
