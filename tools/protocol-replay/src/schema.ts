import { isProxy } from 'node:util/types';

export const REPLAY_FIXTURE_VERSION = 1 as const;
export const MAX_FIXTURE_BYTES = 262_144 as const;
export const MAX_FIXTURE_DEPTH = 6 as const;
export const MAX_FIXTURE_STRING_BYTES = 64 as const;
export const MAX_FIXTURE_DURATION_MS = 1_860_000 as const;
export const MAX_FIXTURE_STEPS = 10_000 as const;

export const CLIENT_CONTROL_REFERENCES = Object.freeze([
  'session.start',
  'utterance.start',
  'utterance.commit',
  'utterance.cancel',
  'session.end'
] as const);

export const SERVER_CONTROL_REFERENCES = Object.freeze([
  'session.ready',
  'session.rejected',
  'utterance.aborted',
  'audio.ack',
  'transcript.partial',
  'transcript.final',
  'language.target',
  'translation.ready',
  'suggestions.ready',
  'error.protocol'
] as const);

export const AUDIO_REFERENCES = Object.freeze([
  'audio.frame.0',
  'audio.frame.1',
  'audio.frame.2'
] as const);

export const FAULT_CODES = Object.freeze([
  'drop.next',
  'duplicate.next',
  'delay.next',
  'reorder.pair',
  'disconnect.next',
  'control.malformed',
  'control.invalid-utf8',
  'control.oversize',
  'audio.oversize',
  'audio.corrupt',
  'audio.gap',
  'audio.overlap',
  'audio.conflict',
  'revision.regression',
  'identity.stale-session',
  'identity.stale-utterance',
  'provider.failure',
  'state.unavailable'
] as const);

export type ClientControlReference = (typeof CLIENT_CONTROL_REFERENCES)[number];
export type ServerControlReference = (typeof SERVER_CONTROL_REFERENCES)[number];
export type AudioReference = (typeof AUDIO_REFERENCES)[number];
export type FaultCode = (typeof FAULT_CODES)[number];
export type ReplayTarget = 'es' | 'tr';

export type ReplayStep =
  | { readonly op: 'client.control'; readonly ref: ClientControlReference }
  | { readonly op: 'server.control'; readonly ref: ServerControlReference }
  | { readonly op: 'client.audio'; readonly ref: AudioReference }
  | { readonly op: 'clock.advance'; readonly ms: number }
  | { readonly op: 'fault.inject'; readonly fault: FaultCode }
  | { readonly op: 'transport.open' }
  | { readonly op: 'transport.close' };

export interface ReplayFixture {
  readonly version: typeof REPLAY_FIXTURE_VERSION;
  readonly seed: number;
  readonly target: ReplayTarget;
  readonly durationMs: number;
  readonly steps: readonly ReplayStep[];
}

export class ReplayFixtureError extends TypeError {
  constructor() {
    super('Invalid protocol replay fixture');
    this.name = 'ReplayFixtureError';
  }
}

const encoder = new TextEncoder();

function fail(): never {
  throw new ReplayFixtureError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) fail();
  return descriptor.value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key));
}

function inspectGraph(value: unknown, depth: number, seen: Set<object>): void {
  if (depth > MAX_FIXTURE_DEPTH) fail();
  if (typeof value === 'string') {
    if (encoder.encode(value).byteLength > MAX_FIXTURE_STRING_BYTES) fail();
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  if (isProxy(value)) fail();
  if (seen.has(value)) fail();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const length = ownData(value, 'length');
      if (!Number.isSafeInteger(length) || (length as number) < 0) fail();
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== (length as number) + 1 ||
        !keys.includes('length') ||
        !Array.from({ length: length as number }, (_, index) => String(index))
          .every((key) => keys.includes(key))
      ) fail();
      for (let index = 0; index < (length as number); index += 1) {
        inspectGraph(ownData(value, String(index)), depth + 1, seen);
      }
      return;
    }
    if (!isRecord(value)) fail();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || encoder.encode(key).byteLength > MAX_FIXTURE_STRING_BYTES) fail();
      inspectGraph(ownData(value, key), depth + 1, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function canonicalInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && !Object.is(value, -0) &&
    value >= 0 && value <= maximum;
}

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function parseStep(input: unknown): ReplayStep {
  if (!isRecord(input)) fail();
  const operation = ownData(input, 'op');
  switch (operation) {
    case 'client.control': {
      if (!hasExactKeys(input, ['op', 'ref'])) fail();
      const reference = ownData(input, 'ref');
      if (!member(CLIENT_CONTROL_REFERENCES, reference)) fail();
      return Object.freeze({ op: operation, ref: reference });
    }
    case 'server.control': {
      if (!hasExactKeys(input, ['op', 'ref'])) fail();
      const reference = ownData(input, 'ref');
      if (!member(SERVER_CONTROL_REFERENCES, reference)) fail();
      return Object.freeze({ op: operation, ref: reference });
    }
    case 'client.audio': {
      if (!hasExactKeys(input, ['op', 'ref'])) fail();
      const reference = ownData(input, 'ref');
      if (!member(AUDIO_REFERENCES, reference)) fail();
      return Object.freeze({ op: operation, ref: reference });
    }
    case 'clock.advance': {
      if (!hasExactKeys(input, ['op', 'ms'])) fail();
      const milliseconds = ownData(input, 'ms');
      if (!canonicalInteger(milliseconds, MAX_FIXTURE_DURATION_MS)) fail();
      return Object.freeze({ op: operation, ms: milliseconds });
    }
    case 'fault.inject': {
      if (!hasExactKeys(input, ['op', 'fault'])) fail();
      const fault = ownData(input, 'fault');
      if (!member(FAULT_CODES, fault)) fail();
      return Object.freeze({ op: operation, fault });
    }
    case 'transport.open':
    case 'transport.close':
      if (!hasExactKeys(input, ['op'])) fail();
      return Object.freeze({ op: operation });
    default:
      fail();
  }
}

export function parseReplayFixture(input: unknown): ReplayFixture {
  try {
    inspectGraph(input, 0, new Set());
    if (!isRecord(input) || !hasExactKeys(input, ['version', 'seed', 'target', 'durationMs', 'steps'])) {
      fail();
    }
    const version = ownData(input, 'version');
    const seed = ownData(input, 'seed');
    const target = ownData(input, 'target');
    const durationMs = ownData(input, 'durationMs');
    const rawSteps = ownData(input, 'steps');
    if (
      version !== REPLAY_FIXTURE_VERSION ||
      !canonicalInteger(seed, 4_294_967_295) ||
      (target !== 'es' && target !== 'tr') ||
      !canonicalInteger(durationMs, MAX_FIXTURE_DURATION_MS) ||
      !Array.isArray(rawSteps) || rawSteps.length < 1 || rawSteps.length > MAX_FIXTURE_STEPS
    ) fail();
    const steps = rawSteps.map(parseStep);
    let advanced = 0;
    for (const step of steps) {
      if (step.op === 'clock.advance') {
        advanced += step.ms;
        if (advanced > durationMs) fail();
      }
    }
    return Object.freeze({
      version: REPLAY_FIXTURE_VERSION,
      seed,
      target,
      durationMs,
      steps: Object.freeze(steps)
    });
  } catch {
    throw new ReplayFixtureError();
  }
}

export function parseReplayFixtureText(text: string): ReplayFixture {
  if (typeof text !== 'string' || encoder.encode(text).byteLength > MAX_FIXTURE_BYTES) fail();
  try {
    return parseReplayFixture(JSON.parse(text) as unknown);
  } catch {
    throw new ReplayFixtureError();
  }
}
