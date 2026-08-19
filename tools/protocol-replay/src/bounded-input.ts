import { readSync } from 'node:fs';

import { MAX_FIXTURE_BYTES } from './schema.js';

export class ReplayInputError extends TypeError {
  constructor() {
    super('Invalid protocol replay input');
    this.name = 'ReplayInputError';
  }
}

export type BoundedInputReader = (
  buffer: Uint8Array,
  offset: number,
  length: number
) => number;

const decoder = new TextDecoder('utf-8', { fatal: true });

export function readBoundedInput(reader: BoundedInputReader): string {
  try {
    if (typeof reader !== 'function') throw new ReplayInputError();
    const buffer = Buffer.alloc(MAX_FIXTURE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const remaining = buffer.byteLength - offset;
      const bytesRead = reader(buffer, offset, remaining);
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > remaining) {
        throw new ReplayInputError();
      }
      if (bytesRead === 0) return decoder.decode(buffer.subarray(0, offset));
      offset += bytesRead;
    }
    throw new ReplayInputError();
  } catch {
    throw new ReplayInputError();
  }
}

export function readBoundedStdin(): string {
  return readBoundedInput((buffer, offset, length) =>
    readSync(0, buffer, offset, length, null)
  );
}
