#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runRealtimeSpikeCli } from './cli.js';

export async function isRealtimeSpikeDirectEntry(
  moduleUrl: string,
  entryPath: string | undefined,
  resolveRealpath: (path: string) => Promise<string> = realpath
): Promise<boolean> {
  if (entryPath === undefined) return false;
  try {
    const [modulePath, invokedPath] = await Promise.all([
      resolveRealpath(fileURLToPath(moduleUrl)),
      resolveRealpath(entryPath)
    ]);
    return modulePath === invokedPath;
  } catch {
    return false;
  }
}

async function startWhenDirect(): Promise<void> {
  if (await isRealtimeSpikeDirectEntry(import.meta.url, process.argv[1])) {
    process.exitCode = await runRealtimeSpikeCli(process.argv.slice(2));
  }
}

void startWhenDirect();
