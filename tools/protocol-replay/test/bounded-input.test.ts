import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ReplayInputError, readBoundedInput } from '../src/bounded-input.js';
import { MAX_FIXTURE_BYTES } from '../src/schema.js';

function readerFor(input: Uint8Array, chunkSize: number) {
  let sourceOffset = 0;
  return (buffer: Uint8Array, offset: number, length: number): number => {
    if (sourceOffset === input.byteLength) return 0;
    const count = Math.min(chunkSize, length, input.byteLength - sourceOffset);
    buffer.set(input.subarray(sourceOffset, sourceOffset + count), offset);
    sourceOffset += count;
    return count;
  };
}

describe('bounded stdin input', () => {
  it('reads deterministic chunks through the fixed buffer', () => {
    const input = new TextEncoder().encode('{"version":1}');
    expect(readBoundedInput(readerFor(input, 2))).toBe('{"version":1}');
  });

  it('accepts exactly the fixture byte limit', () => {
    const input = new TextEncoder().encode(' '.repeat(MAX_FIXTURE_BYTES));
    expect(new TextEncoder().encode(readBoundedInput(readerFor(input, 8191)))).toHaveLength(
      MAX_FIXTURE_BYTES
    );
  });

  it('rejects max plus one bytes without requesting unbounded storage', () => {
    const input = new TextEncoder().encode(' '.repeat(MAX_FIXTURE_BYTES + 1));
    expect(() => readBoundedInput(readerFor(input, input.byteLength))).toThrow(ReplayInputError);
  });

  it('rejects invalid UTF-8 with fixed content-free output', () => {
    let error: unknown;
    try {
      readBoundedInput(readerFor(new Uint8Array([0xc3, 0x28]), 2));
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toBe('ReplayInputError: Invalid protocol replay input');
  });

  it('replaces hostile reader failures with a fresh fixed error', () => {
    const canary = new Error('authorization=Bearer SECRET-CANARY');
    let first: unknown;
    let second: unknown;
    const hostile = (): number => { throw canary; };
    try { readBoundedInput(hostile); } catch (error) { first = error; }
    try { readBoundedInput(hostile); } catch (error) { second = error; }
    expect(first).toBeInstanceOf(ReplayInputError);
    expect(second).toBeInstanceOf(ReplayInputError);
    expect(first).not.toBe(second);
    expect(first).not.toBe(canary);
    expect(String(first)).not.toContain('SECRET-CANARY');
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])('rejects hostile read count %s', (count) => {
    expect(() => readBoundedInput(() => count)).toThrow(ReplayInputError);
  });

  it('wires the CLI to bounded stdin rather than whole-stream reads', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(source).toContain('readBoundedStdin()');
    expect(source).not.toContain('readFileSync');
  });
});
