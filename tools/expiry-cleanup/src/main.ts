#!/usr/bin/env node

import { writeSync } from 'node:fs';
import {
  createAzureTableRuntimeStore,
  type AzureTableRuntimeStoreOptions
} from '@palancar/security-state';
import { main, type ExpiryCleanupRuntime } from './index.js';

const runtime: ExpiryCleanupRuntime<ReturnType<typeof setTimeout>> = Object.freeze({
  createStore: (options: AzureTableRuntimeStoreOptions) => {
    const store = createAzureTableRuntimeStore(options);
    return Object.freeze({ cleanupExpired: store.cleanupExpired });
  },
  setTimeout: (callback: () => void, timeoutMs: number) => setTimeout(callback, timeoutMs),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle)
});

await main(
  process.env,
  Object.freeze({
    writeStdout: (value: string) => {
      writeSync(process.stdout.fd, value);
    },
    writeStderr: (value: string) => {
      writeSync(process.stderr.fd, value);
    },
    exit: (code: number) => process.exit(code)
  }),
  runtime
);
