import {
  MAX_BINARY_MESSAGE_BYTES,
  MAX_CONTROL_MESSAGE_BYTES,
  decodeAudioFrame,
  encodeAudioFrame
} from '@palancar/contracts';

import type { ReplayCatalog } from './catalog.js';
import { FAULT_CODES, type FaultCode } from './schema.js';

export type PacketKind = 'client.control' | 'server.control' | 'client.audio';

export interface ReplayPacket {
  readonly kind: PacketKind;
  readonly value: unknown;
}

export type FaultAction =
  | 'drop'
  | 'duplicate'
  | 'delay'
  | 'reorder'
  | 'disconnect'
  | 'mutate';

export interface FaultDefinition {
  readonly code: FaultCode;
  readonly action: FaultAction;
}

export const FAULT_CATALOG: Readonly<Record<FaultCode, FaultDefinition>> = Object.freeze(
  Object.fromEntries(FAULT_CODES.map((code) => [
    code,
    Object.freeze({
      code,
      action: code === 'drop.next'
        ? 'drop'
        : code === 'duplicate.next'
          ? 'duplicate'
          : code === 'delay.next'
            ? 'delay'
            : code === 'reorder.pair'
              ? 'reorder'
              : code === 'disconnect.next'
                ? 'disconnect'
                : 'mutate'
    })
  ])) as Record<FaultCode, FaultDefinition>
);

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function bytes(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array();
}

function mutateAudio(value: unknown, mutation: 'corrupt' | 'gap' | 'overlap' | 'conflict'): Uint8Array {
  const output = bytes(value);
  if (mutation === 'corrupt') {
    if (output[0] !== undefined) output[0] = output[0] ^ 0xff;
    return output;
  }
  try {
    const frame = decodeAudioFrame(output);
    const payload = new Uint8Array(frame.payload);
    const lastIndex = payload.length - 1;
    if (mutation === 'conflict' && payload[lastIndex] !== undefined) {
      payload[lastIndex] = payload[lastIndex] ^ 0x01;
    }
    return encodeAudioFrame({
      utteranceId: frame.utteranceId,
      sequence: frame.sequence,
      offset: mutation === 'gap'
        ? frame.offset + 1
        : mutation === 'overlap'
          ? Math.max(0, frame.offset - 1)
          : frame.offset,
      payload
    });
  } catch {
    return output;
  }
}

export function mutatePacket(
  fault: FaultCode,
  packet: ReplayPacket,
  catalog: ReplayCatalog
): ReplayPacket {
  switch (fault) {
    case 'control.malformed':
      return { kind: packet.kind === 'client.audio' ? 'client.control' : packet.kind, value: { type: 'invalid' } };
    case 'control.invalid-utf8':
      return {
        kind: packet.kind === 'client.audio' ? 'client.control' : packet.kind,
        value: new Uint8Array([0xc3, 0x28])
      };
    case 'control.oversize':
      return {
        kind: packet.kind === 'client.audio' ? 'client.control' : packet.kind,
        value: 'x'.repeat(MAX_CONTROL_MESSAGE_BYTES + 1)
      };
    case 'audio.oversize':
      return { kind: 'client.audio', value: new Uint8Array(MAX_BINARY_MESSAGE_BYTES + 1) };
    case 'audio.corrupt':
      return { kind: 'client.audio', value: mutateAudio(packet.value, 'corrupt') };
    case 'audio.gap':
      return { kind: 'client.audio', value: mutateAudio(packet.value, 'gap') };
    case 'audio.overlap':
      return { kind: 'client.audio', value: mutateAudio(packet.value, 'overlap') };
    case 'audio.conflict':
      return { kind: 'client.audio', value: mutateAudio(packet.value, 'conflict') };
    case 'revision.regression': {
      const value = record(packet.value);
      return { kind: 'server.control', value: { ...value, revision: 1 } };
    }
    case 'identity.stale-session': {
      const value = record(packet.value);
      return {
        kind: packet.kind,
        value: { ...value, sessionId: catalog.identities.staleSessionId }
      };
    }
    case 'identity.stale-utterance': {
      const value = record(packet.value);
      return {
        kind: packet.kind,
        value: { ...value, utteranceId: catalog.identities.staleUtteranceId }
      };
    }
    case 'provider.failure':
    case 'state.unavailable': {
      const base = catalog.server('error.protocol');
      return {
        kind: 'server.control',
        value: {
          ...base,
          code: fault === 'provider.failure' ? 'provider_unavailable' : 'state_unavailable',
          scope: 'server',
          recoverable: true
        }
      };
    }
    case 'drop.next':
    case 'duplicate.next':
    case 'delay.next':
    case 'reorder.pair':
    case 'disconnect.next':
      return packet;
  }
}
