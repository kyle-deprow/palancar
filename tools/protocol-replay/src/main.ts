#!/usr/bin/env node

import { readBoundedStdin } from './bounded-input.js';
import { replayFixture } from './replay.js';
import { createReplayReport, serializeReplayReport } from './report.js';
import { parseReplayFixtureText } from './schema.js';

function invalidFixtureReport(): string {
  return serializeReplayReport(createReplayReport({
    seed: 0,
    category: 'fixture.invalid',
    counts: {
      steps: 0,
      delivered: 0,
      accepted: 0,
      rejected: 0,
      dropped: 0,
      stale: 0,
      duplicated: 0,
      delayed: 0,
      reordered: 0,
      disconnects: 0
    },
    finishedAtMs: 0,
    lastEventAtMs: 0
  }));
}

try {
  if (process.argv.length !== 2) throw new TypeError('Invalid invocation');
  const input = readBoundedStdin();
  const report = replayFixture(parseReplayFixtureText(input));
  process.stdout.write(serializeReplayReport(report));
} catch {
  process.stdout.write(invalidFixtureReport());
  process.exitCode = 1;
}
