import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const imageName = 'palancar-relay:local';
const containerPort = 8787;
const healthTimeoutMs = 30_000;
const pollIntervalMs = 250;

function runDocker(args) {
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('docker_command_failed');
  }
  return result.stdout.trim();
}

function buildImage() {
  const result = spawnSync('docker', [
    'build',
    '-f',
    'apps/relay/Dockerfile',
    '-t',
    imageName,
    '.'
  ], {
    cwd: repositoryRoot,
    stdio: 'inherit'
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('docker_build_failed');
  }
}

function hostPortFor(containerId) {
  const binding = runDocker(['port', containerId, `${containerPort}/tcp`]);
  const lastLine = binding.split(/\r?\n/).filter(Boolean).at(-1);
  const separator = lastLine?.lastIndexOf(':') ?? -1;
  const port = Number(separator === -1 ? undefined : lastLine.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('docker_port_lookup_failed');
  }
  return port;
}

async function waitForHealth(port) {
  const deadline = Date.now() + healthTimeoutMs;
  const url = `http://127.0.0.1:${port}/healthz`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(1_000, deadline - Date.now()))
      });
      if (response.status === 200) {
        const body = await response.json();
        if (body?.ok === true) {
          return;
        }
      }
    } catch {
      // The container may still be starting.
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await delay(Math.min(pollIntervalMs, remainingMs));
    }
  }
  throw new Error('healthcheck_timeout');
}

let containerId;
let failed = false;
try {
  buildImage();
  containerId = runDocker([
    'run',
    '--detach',
    '--publish',
    `127.0.0.1::${containerPort}`,
    imageName
  ]);
  const hostPort = hostPortFor(containerId);
  await waitForHealth(hostPort);
  console.log('container smoke passed');
} catch {
  failed = true;
} finally {
  if (containerId !== undefined) {
    try {
      runDocker(['stop', '--time', '5', containerId]);
    } catch {
      failed = true;
    }
    try {
      runDocker(['rm', '--force', containerId]);
    } catch {
      failed = true;
    }
  }
}

if (failed) {
  console.error('container smoke failed');
  process.exitCode = 1;
}
