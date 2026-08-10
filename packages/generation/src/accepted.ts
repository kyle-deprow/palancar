import {
  VERSION_PATTERN,
  type PositiveRevision,
  type PositiveEpoch,
  type SegmentId,
  type SessionId,
  type UtteranceId,
  type Version
} from '@palancar/contracts';
import { isTargetLanguage, type TargetLanguage } from '@palancar/language-registry';

import { GenerationError } from './errors.js';
import type { AcceptedTargetTurn, AcceptedTargetTurnInput } from './types.js';

const CANONICAL_V4_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEGMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const VERSION = new RegExp(VERSION_PATTERN);
const MAX_REVISION = 4_294_967_295;
const MAX_EPOCH = 4_294_967_295;
const MAX_TRANSCRIPT_LENGTH = 4_096;

const INPUT_KEYS = new Set([
  'sessionId',
  'sessionEpoch',
  'utteranceId',
  'segmentId',
  'acceptedFinalRevision',
  'selectedTargetLanguage',
  'decision',
  'targetTranscript',
  'gatePolicyVersion'
]);

const acceptedTurns = new WeakSet<object>();

function invalid(): never {
  throw new GenerationError('invalid-input');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isPositiveRevision(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_REVISION
  );
}

function isPositiveEpoch(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_EPOCH
  );
}

function snapshotInput(input: Record<string, unknown>): Record<string, unknown> {
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new GenerationError('invalid-input');
  }

  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !INPUT_KEYS.has(key)) {
        invalid();
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        invalid();
      }
    }
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    throw new GenerationError('invalid-input');
  }

  const copy: Record<string, unknown> = {};
  for (const key of INPUT_KEYS) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      invalid();
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

function readInput(input: unknown): AcceptedTargetTurnInput {
  if (!isRecord(input)) {
    invalid();
  }

  const candidate = snapshotInput(input);
  const sessionId = candidate.sessionId;
  const sessionEpoch = candidate.sessionEpoch;
  const utteranceId = candidate.utteranceId;
  const segmentId = candidate.segmentId;
  const acceptedFinalRevision = candidate.acceptedFinalRevision;
  const selectedTargetLanguage = candidate.selectedTargetLanguage;
  const decision = candidate.decision;
  const targetTranscript = candidate.targetTranscript;
  const gatePolicyVersion = candidate.gatePolicyVersion;
  if (
    typeof sessionId !== 'string' ||
    !CANONICAL_V4_ID.test(sessionId) ||
    !isPositiveEpoch(sessionEpoch) ||
    typeof utteranceId !== 'string' ||
    !CANONICAL_V4_ID.test(utteranceId) ||
    typeof segmentId !== 'string' ||
    !SEGMENT_ID.test(segmentId) ||
    !isPositiveRevision(acceptedFinalRevision) ||
    typeof selectedTargetLanguage !== 'string' ||
    !isTargetLanguage(selectedTargetLanguage) ||
    decision !== 'target' ||
    !isBoundedString(targetTranscript, MAX_TRANSCRIPT_LENGTH) ||
    typeof gatePolicyVersion !== 'string' ||
    gatePolicyVersion.length < 5 ||
    gatePolicyVersion.length > 32 ||
    !VERSION.test(gatePolicyVersion)
  ) {
    invalid();
  }

  return {
    sessionId,
    sessionEpoch,
    utteranceId,
    segmentId,
    acceptedFinalRevision,
    selectedTargetLanguage,
    decision: 'target',
    targetTranscript,
    gatePolicyVersion
  };
}

export function createAcceptedTargetTurn(
  input: AcceptedTargetTurnInput
): AcceptedTargetTurn {
  let copy: AcceptedTargetTurnInput;
  try {
    copy = readInput(input);
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    throw new GenerationError('invalid-input');
  }

  const turn = Object.freeze({
    sessionId: copy.sessionId as SessionId,
    sessionEpoch: copy.sessionEpoch as PositiveEpoch,
    utteranceId: copy.utteranceId as UtteranceId,
    segmentId: copy.segmentId as SegmentId,
    acceptedFinalRevision: copy.acceptedFinalRevision as PositiveRevision,
    selectedTargetLanguage: copy.selectedTargetLanguage as TargetLanguage,
    decision: copy.decision,
    targetTranscript: copy.targetTranscript,
    gatePolicyVersion: copy.gatePolicyVersion as Version
  });
  acceptedTurns.add(turn);
  return turn;
}

export function isAcceptedTargetTurn(value: unknown): value is AcceptedTargetTurn {
  return typeof value === 'object' && value !== null && acceptedTurns.has(value);
}
