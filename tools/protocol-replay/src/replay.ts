import {
  AudioFrameError,
  MAX_CONTROL_MESSAGE_BYTES,
  assertClientControlMessage,
  assertServerControlMessage,
  decodeAudioFrame,
  type ClientControlMessage,
  type ServerControlMessage
} from '@palancar/contracts';

import { createReplayCatalog } from './catalog.js';
import { FAULT_CATALOG, mutatePacket, type ReplayPacket } from './mutations.js';
import {
  parseReplayFixture,
  type FaultCode,
  type ReplayFixture
} from './schema.js';
import {
  createReplayReport,
  type ReplayCategory,
  type ReplayCounts,
  type ReplayReport
} from './report.js';
import { createVirtualClock } from './virtual-clock.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const DELAY_MS = 10;

interface MutableCounts {
  steps: number;
  delivered: number;
  accepted: number;
  rejected: number;
  dropped: number;
  stale: number;
  duplicated: number;
  delayed: number;
  reordered: number;
  disconnects: number;
}

interface ProtocolState {
  transportOpen: boolean;
  sessionStarted: boolean;
  sessionReady: boolean;
  sessionEnded: boolean;
  utteranceStarted: boolean;
  utteranceActive: boolean;
  finalOffset: number | undefined;
  expectedSequence: number;
  expectedOffset: number;
  readonly frames: Map<number, Uint8Array>;
  lastRevision: number;
  finalRevision: number | undefined;
  targetAccepted: boolean;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function decodeControl(packet: ReplayPacket): unknown {
  const value = packet.value;
  if (typeof value === 'string') {
    if (encoder.encode(value).byteLength > MAX_CONTROL_MESSAGE_BYTES) throw new RangeError();
    return JSON.parse(value) as unknown;
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_CONTROL_MESSAGE_BYTES) throw new RangeError();
    return JSON.parse(decoder.decode(value)) as unknown;
  }
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || encoder.encode(serialized).byteLength > MAX_CONTROL_MESSAGE_BYTES) {
    throw new RangeError();
  }
  return value;
}

function sameSession(
  message: { readonly sessionId?: unknown; readonly sessionEpoch?: unknown },
  sessionId: string,
  sessionEpoch: number
): boolean {
  return message.sessionId === sessionId && message.sessionEpoch === sessionEpoch;
}

function sameUtterance(
  message: { readonly utteranceId?: unknown },
  utteranceId: string
): boolean {
  return message.utteranceId === utteranceId;
}

function applyClientControl(
  message: ClientControlMessage,
  state: ProtocolState,
  sessionId: string,
  utteranceId: string,
  sessionEpoch: number
): ReplayCategory | undefined {
  if (!state.transportOpen || state.sessionEnded) return 'protocol.order';
  switch (message.type) {
    case 'session.start':
      if (state.sessionStarted) return undefined;
      state.sessionStarted = true;
      return undefined;
    case 'utterance.start':
      if (!sameSession(message, sessionId, sessionEpoch)) return 'identity.session-mismatch';
      if (!sameUtterance(message, utteranceId)) return 'identity.utterance-mismatch';
      if (!state.sessionReady) return 'protocol.order';
      if (state.utteranceStarted) {
        return state.utteranceActive ? undefined : 'audio.sequence-conflict';
      }
      state.utteranceStarted = true;
      state.utteranceActive = true;
      return undefined;
    case 'utterance.commit':
    case 'utterance.cancel':
      if (!sameSession(message, sessionId, sessionEpoch)) return 'identity.session-mismatch';
      if (!sameUtterance(message, utteranceId)) return 'identity.utterance-mismatch';
      if (state.finalOffset !== undefined) {
        return state.finalOffset === message.finalOriginalSampleOffset
          ? undefined
          : 'audio.sequence-conflict';
      }
      if (!state.utteranceActive || message.finalOriginalSampleOffset !== state.expectedOffset) {
        return 'protocol.order';
      }
      state.finalOffset = message.finalOriginalSampleOffset;
      state.utteranceActive = false;
      return undefined;
    case 'session.end':
      if (!sameSession(message, sessionId, sessionEpoch)) return 'identity.session-mismatch';
      if (!state.sessionReady) return 'protocol.order';
      state.sessionEnded = true;
      state.utteranceActive = false;
      return undefined;
  }
}

function applyServerControl(
  message: ServerControlMessage,
  state: ProtocolState,
  sessionId: string,
  utteranceId: string,
  sessionEpoch: number
): ReplayCategory | undefined {
  if (!state.transportOpen || state.sessionEnded) return 'protocol.order';
  if (message.type === 'session.rejected') {
    if (!state.sessionStarted || state.sessionReady) return 'protocol.order';
    state.sessionEnded = true;
    return undefined;
  }
  if (message.type === 'error') {
    if (message.code === 'provider_unavailable') return 'provider.unavailable';
    if (message.code === 'state_unavailable') return 'state.persistence-unavailable';
    return undefined;
  }
  if (!sameSession(message, sessionId, sessionEpoch)) return 'identity.session-mismatch';
  if (message.type === 'session.ready') {
    if (!state.sessionStarted || state.sessionReady || state.sessionEnded) return 'protocol.order';
    state.sessionReady = true;
    return undefined;
  }
  if (!sameUtterance(message, utteranceId)) return 'identity.utterance-mismatch';
  if (!state.utteranceStarted) return 'protocol.order';
  switch (message.type) {
    case 'utterance.aborted':
      state.utteranceActive = false;
      return undefined;
    case 'audio.ack':
      return message.highestContiguousExclusiveOffset <= state.expectedOffset
        ? undefined
        : 'audio.sequence-gap';
    case 'transcript.partial':
    case 'transcript.final':
      if (message.revision <= state.lastRevision) return 'revision.nonmonotonic';
      state.lastRevision = message.revision;
      if (message.type === 'transcript.final') state.finalRevision = message.revision;
      return undefined;
    case 'language.decision':
      if (state.finalRevision === undefined || message.revision !== state.finalRevision) {
        return 'revision.nonmonotonic';
      }
      state.targetAccepted = message.decision === 'target';
      return undefined;
    case 'translation.ready':
    case 'suggestions.ready':
      return state.targetAccepted && message.acceptedFinalRevision === state.finalRevision
        ? undefined
        : 'protocol.order';
  }
}

function applyAudio(
  packet: ReplayPacket,
  state: ProtocolState,
  utteranceId: string
): ReplayCategory | undefined {
  if (!state.transportOpen || state.sessionEnded) return 'protocol.order';
  let frame;
  try {
    frame = decodeAudioFrame(packet.value as Uint8Array);
  } catch (error) {
    return error instanceof AudioFrameError && error.reason === 'oversize'
      ? 'audio.size-limit'
      : 'audio.invalid';
  }
  if (!state.sessionReady || !state.utteranceActive) return 'protocol.order';
  if (frame.utteranceId !== utteranceId) return 'identity.utterance-mismatch';
  const prior = state.frames.get(frame.sequence);
  if (prior !== undefined) {
    return sameBytes(prior, packet.value as Uint8Array) ? undefined : 'audio.sequence-conflict';
  }
  if (frame.sequence > state.expectedSequence || frame.offset > state.expectedOffset) {
    return 'audio.sequence-gap';
  }
  if (frame.offset < state.expectedOffset) return 'audio.sequence-overlap';
  if (frame.sequence < state.expectedSequence) return 'audio.sequence-conflict';
  state.frames.set(frame.sequence, new Uint8Array(packet.value as Uint8Array));
  state.expectedSequence += 1;
  state.expectedOffset += frame.payloadLength / 2;
  return undefined;
}

export function replayFixture(input: ReplayFixture): ReplayReport {
  const fixture = parseReplayFixture(input);
  const clock = createVirtualClock();
  const counts: MutableCounts = {
    steps: fixture.steps.length,
    delivered: 0,
    accepted: 0,
    rejected: 0,
    dropped: 0,
    stale: 0,
    duplicated: 0,
    delayed: 0,
    reordered: 0,
    disconnects: 0
  };
  const state: ProtocolState = {
    transportOpen: false,
    sessionStarted: false,
    sessionReady: false,
    sessionEnded: false,
    utteranceStarted: false,
    utteranceActive: false,
    finalOffset: undefined,
    expectedSequence: 0,
    expectedOffset: 0,
    frames: new Map(),
    lastRevision: 0,
    finalRevision: undefined,
    targetAccepted: false
  };
  const pendingFaults: FaultCode[] = [];
  const delayedDeliveries = new Set<{
    generation: number;
    cancel: () => void;
    active: boolean;
  }>();
  let transportGeneration = 0;
  let catalog = createReplayCatalog(fixture.seed, fixture.target);
  let heldPacket: { packet: ReplayPacket; generation: number } | undefined;
  let category: ReplayCategory = 'ok';
  let lastEventAtMs = 0;

  const mark = (next: ReplayCategory): void => {
    if (category === 'ok') category = next;
  };

  const markStalePacket = (): void => {
    counts.dropped += 1;
    counts.stale += 1;
    mark('transport.stale-generation');
  };

  const deliver = (packet: ReplayPacket, generation: number): void => {
    if (generation !== transportGeneration) {
      markStalePacket();
      return;
    }
    counts.delivered += 1;
    lastEventAtMs = clock.nowMs;
    let result: ReplayCategory | undefined;
    if (!state.transportOpen || state.sessionEnded) {
      result = 'protocol.order';
    } else try {
      if (packet.kind === 'client.audio') {
        result = applyAudio(packet, state, catalog.identities.utteranceId);
      } else {
        const raw = decodeControl(packet);
        if (packet.kind === 'client.control') {
          const message = assertClientControlMessage(raw);
          result = applyClientControl(
            message,
            state,
            catalog.identities.sessionId,
            catalog.identities.utteranceId,
            catalog.identities.sessionEpoch
          );
        } else {
          const message = assertServerControlMessage(raw);
          result = applyServerControl(
            message,
            state,
            catalog.identities.sessionId,
            catalog.identities.utteranceId,
            catalog.identities.sessionEpoch
          );
        }
      }
    } catch (error) {
      result = error instanceof RangeError ? 'control.size-limit' : 'control.invalid';
    }
    if (result === undefined) {
      counts.accepted += 1;
    } else {
      counts.rejected += 1;
      mark(result);
    }
  };

  const clearGenerationArtifacts = (): void => {
    for (const delivery of delayedDeliveries) {
      if (delivery.active) {
        delivery.active = false;
        delivery.cancel();
        markStalePacket();
      }
    }
    delayedDeliveries.clear();
    if (heldPacket !== undefined) {
      heldPacket = undefined;
      markStalePacket();
    }
    pendingFaults.length = 0;
  };

  const route = (packet: ReplayPacket): void => {
    if (heldPacket !== undefined) {
      const held = heldPacket;
      heldPacket = undefined;
      if (held.generation !== transportGeneration) {
        markStalePacket();
        deliver(packet, transportGeneration);
        return;
      }
      counts.reordered += 1;
      mark('fault.reorder');
      deliver(packet, transportGeneration);
      deliver(held.packet, held.generation);
      return;
    }
    const fault = pendingFaults.shift();
    if (fault === undefined) {
      deliver(packet, transportGeneration);
      return;
    }
    switch (FAULT_CATALOG[fault].action) {
      case 'drop':
        counts.dropped += 1;
        mark('fault.drop');
        return;
      case 'duplicate':
        counts.duplicated += 1;
        mark('fault.duplicate');
        deliver(packet, transportGeneration);
        deliver(packet, transportGeneration);
        return;
      case 'delay': {
        counts.delayed += 1;
        mark('fault.delay');
        const generation = transportGeneration;
        const delivery = {
          generation,
          cancel: (): void => undefined,
          active: true
        };
        delivery.cancel = clock.schedule(DELAY_MS, () => {
          if (!delivery.active) return;
          delivery.active = false;
          delayedDeliveries.delete(delivery);
          deliver(packet, generation);
        });
        delayedDeliveries.add(delivery);
        return;
      }
      case 'reorder':
        heldPacket = { packet, generation: transportGeneration };
        return;
      case 'disconnect':
        counts.disconnects += 1;
        counts.dropped += 1;
        mark('transport.disconnected');
        clearGenerationArtifacts();
        state.transportOpen = false;
        state.sessionEnded = true;
        state.utteranceActive = false;
        lastEventAtMs = clock.nowMs;
        return;
      case 'mutate':
        deliver(mutatePacket(fault, packet, catalog), transportGeneration);
        return;
    }
  };

  for (const step of fixture.steps) {
    switch (step.op) {
      case 'transport.open':
        if (state.transportOpen) mark('protocol.order');
        clearGenerationArtifacts();
        transportGeneration += 1;
        catalog = createReplayCatalog(fixture.seed, fixture.target, transportGeneration);
        state.transportOpen = true;
        state.sessionStarted = false;
        state.sessionReady = false;
        state.sessionEnded = false;
        state.utteranceStarted = false;
        state.utteranceActive = false;
        state.finalOffset = undefined;
        state.expectedSequence = 0;
        state.expectedOffset = 0;
        state.frames.clear();
        state.lastRevision = 0;
        state.finalRevision = undefined;
        state.targetAccepted = false;
        lastEventAtMs = clock.nowMs;
        break;
      case 'transport.close':
        if (!state.transportOpen) mark('transport.closed');
        clearGenerationArtifacts();
        state.transportOpen = false;
        state.sessionEnded = true;
        state.utteranceActive = false;
        lastEventAtMs = clock.nowMs;
        break;
      case 'clock.advance':
        clock.advanceBy(step.ms);
        break;
      case 'fault.inject':
        pendingFaults.push(step.fault);
        break;
      case 'client.control':
        route({ kind: step.op, value: catalog.client(step.ref) });
        break;
      case 'server.control':
        route({ kind: step.op, value: catalog.server(step.ref) });
        break;
      case 'client.audio':
        route({ kind: step.op, value: catalog.audio(step.ref) });
        break;
    }
  }
  clock.advanceTo(fixture.durationMs);
  if (heldPacket !== undefined || pendingFaults.length > 0 || clock.pendingCount > 0) {
    mark('protocol.order');
  }

  return createReplayReport({
    seed: fixture.seed,
    category,
    counts: counts as ReplayCounts,
    finishedAtMs: clock.nowMs,
    lastEventAtMs
  });
}
