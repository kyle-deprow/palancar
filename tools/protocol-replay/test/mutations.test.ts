import {
  MAX_BINARY_MESSAGE_BYTES,
  MAX_CONTROL_MESSAGE_BYTES,
  assertServerControlMessage
} from '@palancar/contracts';
import { describe, expect, it } from 'vitest';

import { createReplayCatalog } from '../src/catalog.js';
import { FAULT_CATALOG, mutatePacket } from '../src/mutations.js';
import { FAULT_CODES } from '../src/schema.js';

describe('closed mutation catalog', () => {
  it('defines every and only the stable fault codes', () => {
    expect(Object.keys(FAULT_CATALOG)).toEqual([...FAULT_CODES]);
    expect(new Set(Object.values(FAULT_CATALOG).map(({ action }) => action))).toEqual(
      new Set(['drop', 'duplicate', 'delay', 'reorder', 'disconnect', 'mutate'])
    );
  });

  it('mutates audio deterministically without changing the catalog packet', () => {
    const catalog = createReplayCatalog(9, 'es');
    const original = catalog.audio('audio.frame.1');
    const before = new Uint8Array(original);
    const first = mutatePacket('audio.corrupt', { kind: 'client.audio', value: original }, catalog);
    const second = mutatePacket('audio.corrupt', { kind: 'client.audio', value: original }, catalog);

    expect(first.value).toEqual(second.value);
    expect(first.value).not.toEqual(before);
    expect(original).toEqual(before);
  });

  it('uses contract hard limits for oversize control and audio mutations', () => {
    const catalog = createReplayCatalog(10, 'tr');
    const packet = { kind: 'client.audio' as const, value: catalog.audio('audio.frame.0') };
    const control = mutatePacket('control.oversize', packet, catalog);
    const audio = mutatePacket('audio.oversize', packet, catalog);

    expect(new TextEncoder().encode(control.value as string)).toHaveLength(
      MAX_CONTROL_MESSAGE_BYTES + 1
    );
    expect(audio.value).toHaveLength(MAX_BINARY_MESSAGE_BYTES + 1);
  });

  it.each([
    ['provider.failure', 'provider_unavailable'],
    ['state.unavailable', 'state_unavailable']
  ] as const)('produces a contract-valid %s envelope', (fault, code) => {
    const catalog = createReplayCatalog(11, 'es');
    const mutated = mutatePacket(
      fault,
      { kind: 'server.control', value: catalog.server('error.protocol') },
      catalog
    );
    expect(assertServerControlMessage(mutated.value)).toMatchObject({ type: 'error', code });
  });

  it('keeps pass-through scheduling faults byte-identical', () => {
    const catalog = createReplayCatalog(12, 'tr');
    const packet = { kind: 'client.audio' as const, value: catalog.audio('audio.frame.0') };
    for (const fault of [
      'drop.next',
      'duplicate.next',
      'delay.next',
      'reorder.pair',
      'disconnect.next'
    ] as const) {
      expect(mutatePacket(fault, packet, catalog)).toBe(packet);
    }
  });
});
