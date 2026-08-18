#!/usr/bin/env node

import { contentFreeFailure, runSecurityOps } from './index.js';

const io = {
  stdinIsTty: process.stdin.isTTY === true,
  stdoutIsTty: process.stdout.isTTY === true,
  stdout: (value: string): void => { process.stdout.write(value); },
  stderr: (value: string): void => { process.stderr.write(value); }
};

try {
  await runSecurityOps(process.argv.slice(2), process.env, io);
} catch {
  process.stderr.write(contentFreeFailure());
  process.exitCode = 1;
}
