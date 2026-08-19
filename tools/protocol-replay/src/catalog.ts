import {
  DEFAULT_NEGOTIATED_LIMITS,
  MAX_AUDIO_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  encodeAudioFrame,
  type ClientControlMessage,
  type ServerControlMessage
} from '@palancar/contracts';

import type {
  AudioReference,
  ClientControlReference,
  ReplayTarget,
  ServerControlReference
} from './schema.js';

const FIXED_TIME = '2026-01-01T00:00:00.000Z' as const;
const GATE_POLICY_VERSION = '1.0.0' as const;
const REGISTRY_VERSION = '1.0.0' as const;
const CLIENT_BUILD = 'protocol-replay' as const;

export interface ReplayIdentities {
  readonly sessionId: string;
  readonly utteranceId: string;
  readonly staleSessionId: string;
  readonly staleUtteranceId: string;
  readonly errorId: string;
  readonly segmentId: string;
  readonly sessionEpoch: number;
}

export interface ReplayCatalog {
  readonly identities: ReplayIdentities;
  client(reference: ClientControlReference): ClientControlMessage;
  server(reference: ServerControlReference): ServerControlMessage;
  audio(reference: AudioReference): Uint8Array;
}

function mix(value: number): number {
  let state = value >>> 0;
  state ^= state >>> 16;
  state = Math.imul(state, 0x7feb352d);
  state ^= state >>> 15;
  state = Math.imul(state, 0x846ca68b);
  state ^= state >>> 16;
  return state >>> 0;
}

function uuidFromSeed(seed: number, domain: number, generation: number): string {
  const bytes = new Uint8Array(16);
  const generationDomain = mix(generation ^ Math.imul(domain, 0x9e3779b1));
  let state = mix(seed ^ generationDomain);
  for (let index = 0; index < bytes.length; index += 1) {
    state = mix(state + index + generationDomain);
    bytes[index] = state & 0xff;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}

function payload(seed: number, frame: number): Uint8Array {
  const bytes = new Uint8Array(MAX_AUDIO_PAYLOAD_BYTES);
  let state = mix(seed ^ frame);
  for (let index = 0; index < bytes.length; index += 2) {
    state = mix(state + index + 1);
    const sample = state & 0xffff;
    bytes[index] = sample & 0xff;
    bytes[index + 1] = sample >>> 8;
  }
  return bytes;
}

export function createReplayCatalog(
  seed: number,
  target: ReplayTarget,
  generation = 1
): ReplayCatalog {
  const identities: ReplayIdentities = Object.freeze({
    sessionId: uuidFromSeed(seed, 1, generation),
    utteranceId: uuidFromSeed(seed, 2, generation),
    staleSessionId: uuidFromSeed(seed, 3, generation),
    staleUtteranceId: uuidFromSeed(seed, 4, generation),
    errorId: uuidFromSeed(seed, 5, generation),
    segmentId: `segment-${mix(seed ^ generation).toString(16)}`,
    sessionEpoch: generation
  });
  const frameSamples = MAX_AUDIO_PAYLOAD_BYTES / 2;

  const client = (reference: ClientControlReference): ClientControlMessage => {
    switch (reference) {
      case 'session.start':
        return {
          type: 'session.start',
          protocolVersion: PROTOCOL_VERSION,
          wearerLanguage: 'en',
          targetLanguage: target,
          languageRegistryVersion: REGISTRY_VERSION,
          gatePolicyVersion: GATE_POLICY_VERSION,
          clientBuild: CLIENT_BUILD,
          requestedLimits: DEFAULT_NEGOTIATED_LIMITS
        };
      case 'utterance.start':
        return {
          type: 'utterance.start',
          sessionId: identities.sessionId,
          sessionEpoch: identities.sessionEpoch,
          utteranceId: identities.utteranceId
        };
      case 'utterance.commit':
      case 'utterance.cancel':
        return {
          type: reference,
          sessionId: identities.sessionId,
          sessionEpoch: identities.sessionEpoch,
          utteranceId: identities.utteranceId,
          finalOriginalSampleOffset: frameSamples * 3
        };
      case 'session.end':
        return {
          type: 'session.end',
          sessionId: identities.sessionId,
          sessionEpoch: identities.sessionEpoch,
          reason: 'user_requested'
        };
    }
  };

  const server = (reference: ServerControlReference): ServerControlMessage => {
    const session = {
      sessionId: identities.sessionId,
      sessionEpoch: identities.sessionEpoch
    } as const;
    const utterance = { ...session, utteranceId: identities.utteranceId } as const;
    const result = {
      ...utterance,
      segmentId: identities.segmentId,
      acceptedFinalRevision: 2
    } as const;
    switch (reference) {
      case 'session.ready':
        return {
          type: 'session.ready',
          result: 'new',
          ...session,
          targetLanguage: target,
          languageRegistryVersion: REGISTRY_VERSION,
          gatePolicyVersion: GATE_POLICY_VERSION,
          effectiveLimits: DEFAULT_NEGOTIATED_LIMITS,
          serverTime: FIXED_TIME
        };
      case 'session.rejected':
        return {
          type: 'session.rejected',
          code: 'invalid_session',
          displaySafeMessage: 'Session unavailable'
        };
      case 'utterance.aborted':
        return { type: 'utterance.aborted', ...utterance, category: 'cancellation' };
      case 'audio.ack':
        return {
          type: 'audio.ack',
          ...utterance,
          highestContiguousExclusiveOffset: frameSamples * 3,
          flowState: 'normal'
        };
      case 'transcript.partial':
        return {
          type: 'transcript.partial',
          ...utterance,
          segmentId: identities.segmentId,
          revision: 1,
          text: 'synthetic partial',
          providerEventTime: FIXED_TIME
        };
      case 'transcript.final':
        return {
          type: 'transcript.final',
          ...utterance,
          segmentId: identities.segmentId,
          revision: 2,
          text: 'synthetic final',
          providerEventTime: FIXED_TIME
        };
      case 'language.target':
        return {
          type: 'language.decision',
          ...utterance,
          segmentId: identities.segmentId,
          revision: 2,
          decision: 'target',
          selectedTargetLanguage: target,
          gatePolicyVersion: GATE_POLICY_VERSION
        };
      case 'translation.ready':
        return { type: 'translation.ready', ...result, englishTranslation: 'synthetic result' };
      case 'suggestions.ready':
        return {
          type: 'suggestions.ready',
          ...result,
          suggestions: [
            { englishText: 'synthetic one', selectedTargetText: 'target one' },
            { englishText: 'synthetic two', selectedTargetText: 'target two' }
          ]
        };
      case 'error.protocol':
        return {
          type: 'error',
          code: 'malformed_message',
          scope: 'message',
          recoverable: false,
          displaySafeMessage: 'Protocol unavailable',
          errorId: identities.errorId,
          time: FIXED_TIME
        };
    }
  };

  const audio = (reference: AudioReference): Uint8Array => {
    const frame = reference === 'audio.frame.0' ? 0 : reference === 'audio.frame.1' ? 1 : 2;
    return encodeAudioFrame({
      utteranceId: identities.utteranceId,
      sequence: frame,
      offset: frame * frameSamples,
      payload: payload(seed, frame)
    });
  };

  return Object.freeze({ identities, client, server, audio });
}
