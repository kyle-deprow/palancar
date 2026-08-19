import type { FaultCode, ReplayFixture, ReplayStep } from '../src/schema.js';

export function fixture(
  steps: readonly ReplayStep[],
  overrides: Partial<Pick<ReplayFixture, 'seed' | 'target' | 'durationMs'>> = {}
): ReplayFixture {
  return {
    version: 1,
    seed: overrides.seed ?? 7,
    target: overrides.target ?? 'es',
    durationMs: overrides.durationMs ?? 0,
    steps
  };
}

export function sessionSteps(): ReplayStep[] {
  return [
    { op: 'transport.open' },
    { op: 'client.control', ref: 'session.start' },
    { op: 'server.control', ref: 'session.ready' },
    { op: 'client.control', ref: 'utterance.start' },
    { op: 'client.audio', ref: 'audio.frame.0' }
  ];
}

export function faultFixture(fault: FaultCode): ReplayFixture {
  const steps = sessionSteps();
  if (fault === 'audio.conflict') steps.push({ op: 'client.audio', ref: 'audio.frame.1' });
  if (fault === 'revision.regression') {
    steps.push({ op: 'server.control', ref: 'transcript.partial' });
  }
  steps.push({ op: 'fault.inject', fault });
  if (fault.startsWith('control.')) {
    steps.push({ op: 'server.control', ref: 'transcript.partial' });
  } else if (fault === 'revision.regression') {
    steps.push({ op: 'server.control', ref: 'transcript.final' });
  } else if (fault.startsWith('identity.') || fault === 'provider.failure' || fault === 'state.unavailable') {
    steps.push({ op: 'server.control', ref: 'transcript.partial' });
  } else {
    steps.push({ op: 'client.audio', ref: 'audio.frame.1' });
  }
  if (fault === 'reorder.pair') steps.push({ op: 'client.audio', ref: 'audio.frame.2' });
  if (fault === 'delay.next') steps.push({ op: 'clock.advance', ms: 10 });
  return fixture(steps, { durationMs: fault === 'delay.next' ? 10 : 0 });
}
