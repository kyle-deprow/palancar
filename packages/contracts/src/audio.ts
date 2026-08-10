import {
  AUDIO_HEADER_BYTES,
  BINARY_MAGIC,
  MAX_AUDIO_PAYLOAD_BYTES,
  MAX_BINARY_MESSAGE_BYTES,
  MAX_UTTERANCE_SAMPLES,
  PROTOCOL_VERSION
} from './constants.js';
import { UUID_PATTERN, type Uuid } from './schemas.js';

export type AudioFrameErrorReason =
  | 'magic'
  | 'version'
  | 'flags'
  | 'uuid'
  | 'integer'
  | 'length'
  | 'odd-payload'
  | 'oversize'
  | 'utterance-range';

export class AudioFrameError extends Error {
  readonly reason: AudioFrameErrorReason;

  constructor(reason: AudioFrameErrorReason, message: string) {
    super(message);
    this.name = 'AudioFrameError';
    this.reason = reason;
  }
}

export interface AudioFrameInput {
  readonly utteranceId: string;
  readonly sequence: number;
  readonly offset: number;
  /** Original 16 kHz mono signed 16-bit little-endian PCM bytes, copied unchanged. */
  readonly payload: Uint8Array;
  readonly flags?: number;
}

export interface AudioFrame {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly flags: 0;
  readonly utteranceId: Uuid;
  readonly sequence: number;
  readonly offset: number;
  readonly payloadLength: number;
  /** Original 16 kHz mono signed 16-bit little-endian PCM bytes, copied on decode. */
  readonly payload: Uint8Array;
}

export const AUDIO_FRAME_HEADER_BYTES = AUDIO_HEADER_BYTES;
export const MAX_FRAME_BYTES = MAX_BINARY_MESSAGE_BYTES;

function fail(reason: AudioFrameErrorReason, message: string): never {
  throw new AudioFrameError(reason, message);
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 4_294_967_295;
}

function parseUuid(value: string): Uint8Array {
  if (!new RegExp(UUID_PATTERN).test(value)) {
    fail('uuid', 'Audio frame utterance ID must be a canonical UUID');
  }

  const bytes = new Uint8Array(16);
  const hex = value.replaceAll('-', '');
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = hex.slice(index * 2, index * 2 + 2);
    const byte = Number.parseInt(pair, 16);
    if (!Number.isInteger(byte)) {
      fail('uuid', 'Audio frame utterance ID must be a canonical UUID');
    }
    bytes[index] = byte;
  }

  return bytes;
}

function validateUuidBytes(bytes: Uint8Array): void {
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    fail('uuid', 'Audio frame UUID header bytes are incomplete');
  }

  const version = versionByte >>> 4;
  const variant = variantByte & 0xc0;
  if (version !== 4 || variant !== 0x80) {
    fail('uuid', 'Audio frame UUID header bits are invalid');
  }
}

function formatUuid(bytes: Uint8Array): Uuid {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}` as Uuid;
}

function validateFrameInput(frame: AudioFrameInput): {
  readonly uuidBytes: Uint8Array;
  readonly payload: Uint8Array;
  readonly flags: number;
} {
  const uuidBytes = parseUuid(frame.utteranceId);
  const flags = frame.flags ?? 0;
  if (!Number.isInteger(flags)) {
    fail('integer', 'Audio frame flags must be an integer');
  }
  if (flags !== 0) {
    fail('flags', 'Audio frame flags must be zero');
  }
  if (!isUint32(frame.sequence) || !isUint32(frame.offset)) {
    fail('integer', 'Audio frame sequence and offset must be unsigned 32-bit integers');
  }
  if (!(frame.payload instanceof Uint8Array)) {
    fail('length', 'Audio frame payload must be a Uint8Array');
  }

  const payload = new Uint8Array(frame.payload);
  if (payload.length > MAX_AUDIO_PAYLOAD_BYTES) {
    fail('oversize', 'Audio frame payload exceeds the v1 maximum');
  }
  if (payload.length % 2 !== 0) {
    fail('odd-payload', 'Audio frame payload length must be even');
  }
  if (payload.length < 2) {
    fail('length', 'Audio frame payload must contain 2 or more bytes');
  }
  if (frame.offset + payload.length / 2 > 4_294_967_295) {
    fail('utterance-range', 'Audio frame sample range exceeds unsigned 32-bit offset space');
  }
  if (frame.offset + payload.length / 2 > MAX_UTTERANCE_SAMPLES) {
    fail('utterance-range', 'Audio frame sample range exceeds the utterance maximum');
  }

  return { uuidBytes, payload, flags };
}

export function encodeAudioFrame(frame: AudioFrameInput): Uint8Array {
  const { uuidBytes, payload, flags } = validateFrameInput(frame);
  const output = new Uint8Array(AUDIO_HEADER_BYTES + payload.length);
  const view = new DataView(output.buffer);

  view.setUint16(0, BINARY_MAGIC, false);
  view.setUint8(2, PROTOCOL_VERSION);
  view.setUint8(3, flags);
  output.set(uuidBytes, 4);
  view.setUint32(20, frame.sequence, false);
  view.setUint32(24, frame.offset, false);
  view.setUint16(28, payload.length, false);
  output.set(payload, AUDIO_HEADER_BYTES);

  return output;
}

export function decodeAudioFrame(input: Uint8Array): AudioFrame {
  if (!(input instanceof Uint8Array) || input.length < AUDIO_HEADER_BYTES) {
    fail('length', 'Audio frame is shorter than its fixed header');
  }
  if (input.length > MAX_BINARY_MESSAGE_BYTES) {
    fail('oversize', 'Audio frame exceeds the v1 maximum');
  }

  const bytes = new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, false) !== BINARY_MAGIC) {
    fail('magic', 'Audio frame magic is invalid');
  }
  if (view.getUint8(2) !== PROTOCOL_VERSION) {
    fail('version', 'Audio frame protocol version is invalid');
  }
  if (view.getUint8(3) !== 0) {
    fail('flags', 'Audio frame flags must be zero');
  }

  const uuidBytes = bytes.slice(4, 20);
  validateUuidBytes(uuidBytes);

  const sequence = view.getUint32(20, false);
  const offset = view.getUint32(24, false);
  const payloadLength = view.getUint16(28, false);
  if (payloadLength > MAX_AUDIO_PAYLOAD_BYTES) {
    fail('oversize', 'Audio frame payload exceeds the v1 maximum');
  }
  if (payloadLength % 2 !== 0) {
    fail('odd-payload', 'Audio frame payload length must be even');
  }
  if (payloadLength < 2) {
    fail('length', 'Audio frame payload must contain 2 or more bytes');
  }
  if (input.length !== AUDIO_HEADER_BYTES + payloadLength) {
    fail('length', 'Audio frame declared payload length does not match the message');
  }

  const payload = bytes.slice(AUDIO_HEADER_BYTES);
  if (offset + payloadLength / 2 > 4_294_967_295) {
    fail('utterance-range', 'Audio frame sample range exceeds unsigned 32-bit offset space');
  }
  if (offset + payloadLength / 2 > MAX_UTTERANCE_SAMPLES) {
    fail('utterance-range', 'Audio frame sample range exceeds the utterance maximum');
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    flags: 0,
    utteranceId: formatUuid(uuidBytes),
    sequence,
    offset,
    payloadLength,
    payload
  };
}
