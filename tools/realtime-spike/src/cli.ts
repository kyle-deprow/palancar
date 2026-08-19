import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';

import {
  MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_LINE_BYTES,
  MAX_EVIDENCE_RECORDS,
  createSpikeEvidenceRecord
} from './evidence.js';
import { RealtimeSpikeError } from './errors.js';

const SUCCESS_OUTPUT = '{"status":"valid"}\n';
const FAILURE_OUTPUT = '{"status":"failed"}\n';
const READ_CHUNK_BYTES = 64 * 1024;

export interface RealtimeSpikeInputHandle {
  stat(): Promise<Readonly<{ size: number }>>;
  read(buffer: Uint8Array): Promise<Readonly<{ bytesRead: number }>>;
  close(): Promise<void>;
}

export interface RealtimeSpikeCliDependencies {
  readonly openFile: (path: string) => Promise<RealtimeSpikeInputHandle>;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
  /** Test-only lower cap; production always uses MAX_EVIDENCE_FILE_BYTES. */
  readonly maxInputBytes?: number;
}

const PRODUCTION_CLI_DEPENDENCIES: RealtimeSpikeCliDependencies = Object.freeze({
  openFile: async (path: string) => open(path, 'r'),
  writeStdout: (value: string) => { process.stdout.write(value); },
  writeStderr: (value: string) => { process.stderr.write(value); }
});

export function validateSpikeEvidenceJsonLines(value: string): number {
  if (typeof value !== 'string') throw new RealtimeSpikeError('invalid-evidence');
  const byteCount = Buffer.byteLength(value, 'utf8');
  if (byteCount > MAX_EVIDENCE_FILE_BYTES || (value.length > 0 && !value.endsWith('\n'))) {
    throw new RealtimeSpikeError('evidence-limit');
  }
  const lines = value.length === 0 ? [] : value.slice(0, -1).split('\n');
  if (lines.length > MAX_EVIDENCE_RECORDS) throw new RealtimeSpikeError('evidence-limit');
  for (const line of lines) {
    if (line.length === 0 || Buffer.byteLength(`${line}\n`, 'utf8') > MAX_EVIDENCE_LINE_BYTES) {
      throw new RealtimeSpikeError('evidence-limit');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
      createSpikeEvidenceRecord(parsed);
    } catch {
      throw new RealtimeSpikeError('invalid-evidence');
    }
  }
  return lines.length;
}

async function readCapped(handle: RealtimeSpikeInputHandle, maximumBytes: number): Promise<string> {
  const descriptorStat = await handle.stat();
  if (!Number.isSafeInteger(descriptorStat.size) || descriptorStat.size < 0 ||
    descriptorStat.size > maximumBytes) {
    throw new RealtimeSpikeError('evidence-limit');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const remaining = maximumBytes + 1 - total;
    if (remaining <= 0) throw new RealtimeSpikeError('evidence-limit');
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const result = await handle.read(buffer);
    if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 ||
      result.bytesRead > buffer.byteLength) {
      throw new RealtimeSpikeError('invalid-evidence');
    }
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
    if (total > maximumBytes) throw new RealtimeSpikeError('evidence-limit');
    chunks.push(buffer.subarray(0, result.bytesRead));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw new RealtimeSpikeError('invalid-evidence');
  }
}

export async function runRealtimeSpikeCli(
  arguments_: readonly string[],
  dependencies: RealtimeSpikeCliDependencies = PRODUCTION_CLI_DEPENDENCIES
): Promise<number> {
  let handle: RealtimeSpikeInputHandle | undefined;
  try {
    if (
      arguments_.length !== 2 || arguments_[0] !== 'validate' ||
      typeof arguments_[1] !== 'string' || arguments_[1].length === 0
    ) {
      throw new RealtimeSpikeError('cli');
    }
    const maximumBytes = dependencies.maxInputBytes ?? MAX_EVIDENCE_FILE_BYTES;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
      maximumBytes > MAX_EVIDENCE_FILE_BYTES) {
      throw new RealtimeSpikeError('cli');
    }
    handle = await dependencies.openFile(arguments_[1]);
    const contents = await readCapped(handle, maximumBytes);
    await handle.close();
    handle = undefined;
    validateSpikeEvidenceJsonLines(contents);
    dependencies.writeStdout(SUCCESS_OUTPUT);
    return 0;
  } catch {
    try {
      await handle?.close();
    } catch {
      // The fixed CLI failure remains authoritative.
    }
    try {
      dependencies.writeStderr(FAILURE_OUTPUT);
    } catch {
      // CLI failures remain fixed and content-free.
    }
    return 1;
  }
}
