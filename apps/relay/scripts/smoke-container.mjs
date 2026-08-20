import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { setTimeout as defaultDelay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const localImageName = 'palancar-relay:local';
const healthTimeoutMs = 30_000;
const cleanupTimeoutMs = 10_000;
const pollIntervalMs = 250;
const immutableImageReferencePattern = /^(?=.{1,255}$)(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/;

function smokeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isTimeoutResult(result) {
  return result.error?.code === 'ETIMEDOUT' ||
    (result.status === null && result.signal !== null && result.signal !== undefined);
}

export function isImmutableImageReference(value) {
  return typeof value === 'string' && immutableImageReferencePattern.test(value);
}

export function parseSmokeArguments(args) {
  if (args.length === 0) {
    return Object.freeze({ image: localImageName, shouldBuild: true });
  }
  if (args.length === 1 && isImmutableImageReference(args[0])) {
    return Object.freeze({ image: args[0], shouldBuild: false });
  }
  throw smokeError('invalid_image_reference');
}

function remainingDeadlineMs(deadline, clock) {
  const remainingMs = deadline - clock();
  if (remainingMs <= 0) {
    throw smokeError('healthcheck_timeout');
  }
  return remainingMs;
}

export function runDocker(args, {
  deadline,
  clock = Date.now,
  spawnSync = defaultSpawnSync,
  timeoutMs = cleanupTimeoutMs
} = {}) {
  const timeout = deadline === undefined
    ? timeoutMs
    : remainingDeadlineMs(deadline, clock);
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout
  });
  if (isTimeoutResult(result)) {
    throw smokeError('docker_command_timeout');
  }
  if (result.error !== undefined || result.status !== 0) {
    throw smokeError('docker_command_failed');
  }
  if (deadline !== undefined && deadline <= clock()) {
    throw smokeError('docker_command_timeout');
  }
  return result.stdout.trim();
}

function buildImage(spawnSync) {
  const result = spawnSync('docker', [
    'build',
    '-f',
    'apps/relay/Dockerfile',
    '-t',
    localImageName,
    '.'
  ], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'ignore', 'ignore']
  });
  if (result.error !== undefined || result.status !== 0) {
    throw smokeError('docker_build_failed');
  }
}

export function parseContainerState(output) {
  let state;
  try {
    state = JSON.parse(output);
  } catch {
    throw smokeError('docker_inspect_failed');
  }
  return Object.freeze({
    running: state?.Running === true,
    healthStatus: state?.Health?.Status
  });
}

function inspectContainerState(containerId, options) {
  const output = runDocker([
    'inspect',
    '--format',
    '{{json .State}}',
    containerId
  ], options);
  return parseContainerState(output);
}

export async function waitForHealth(containerId, {
  clock = Date.now,
  deadline = clock() + healthTimeoutMs,
  delay = defaultDelay,
  inspect = (id, options) => inspectContainerState(id, options),
  spawnSync = defaultSpawnSync
} = {}) {
  while (clock() < deadline) {
    let state;
    try {
      state = inspect(containerId, { clock, deadline, spawnSync });
    } catch (error) {
      if (error?.code === 'docker_command_timeout' || error?.code === 'healthcheck_timeout') {
        throw error;
      }
    }
    if (state?.running !== true) {
      if (state !== undefined) {
        throw smokeError('container_not_running');
      }
    } else if (state.healthStatus === 'healthy') {
      return;
    } else if (state.healthStatus === 'unhealthy') {
      throw smokeError('healthcheck_failed');
    }

    const remainingMs = deadline - clock();
    if (remainingMs > 0) {
      await delay(Math.min(pollIntervalMs, remainingMs));
    }
  }
  throw smokeError('healthcheck_timeout');
}

export async function runSmoke(args = process.argv.slice(2), {
  clock = Date.now,
  delay = defaultDelay,
  spawnSync = defaultSpawnSync
} = {}) {
  let image;
  let shouldBuild;
  let containerId;
  let failed = false;
  try {
    ({ image, shouldBuild } = parseSmokeArguments(args));
    if (shouldBuild) {
      buildImage(spawnSync);
    }
    containerId = runDocker([
      'run',
      '--detach',
      '--env',
      'PALANCAR_SECURITY_MODE=local-mock',
      '--env',
      'PALANCAR_GENERATION_PROVIDER=mock',
      '--env',
      'PALANCAR_TRANSCRIPTION_PROVIDER=mock',
      '--env',
      'PALANCAR_RELAY_BIND_HOST=127.0.0.1',
      image
    ], { clock, spawnSync });
    if (containerId.length === 0) {
      throw smokeError('docker_run_failed');
    }
    await waitForHealth(containerId, { clock, delay, spawnSync });
  } catch {
    failed = true;
  } finally {
    if (containerId !== undefined) {
      try {
        runDocker(['stop', '--time', '5', containerId], { clock, spawnSync });
      } catch {
        failed = true;
      }
      try {
        runDocker(['rm', '--force', containerId], { clock, spawnSync });
      } catch {
        failed = true;
      }
    }
  }
  return !failed;
}

const isMainModule = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  const passed = await runSmoke();
  if (passed) {
    console.log('container smoke passed');
  } else {
    console.error('container smoke failed');
    process.exitCode = 1;
  }
}
