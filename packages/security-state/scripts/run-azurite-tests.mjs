import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  process.stderr.write(`Azurite test blocker: ${message}\n`);
  process.exitCode = 1;
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function testToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: 'none', typ: 'JWT' });
  const payload = base64url({
    aud: 'https://storage.azure.com/',
    exp: now + 900,
    iat: now - 5,
    iss: 'https://sts.windows.net/00000000-0000-4000-8000-000000000001/',
    nbf: now - 5,
    sub: 'security-state-azurite-test'
  });
  return `${header}.${payload}.`;
}

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not allocate a loopback port'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function waitForListening(child, timeoutMs) {
  return await new Promise((resolveReady, reject) => {
    let output = '';
    let settled = false;
    const finish = (action) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error(`startup timed out: ${output.trim()}`))),
      timeoutMs
    );
    const inspect = (chunk) => {
      output += chunk.toString();
      if (/Azurite Table service (?:is )?successfully (?:started|listening)/i.test(output)) {
        finish(resolveReady);
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code, signal) => {
      finish(() => reject(new Error(
        `exited before readiness (code=${String(code)}, signal=${String(signal)}): ${output.trim()}`
      )));
    });
    child.once('error', (error) => {
      finish(() => reject(error));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000))
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

const packageRoot = resolve(import.meta.dirname, '..');
const azuriteExecutable = resolve(packageRoot, 'node_modules/.bin/azurite-table');
const vitestExecutable = fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json')));
let temporaryDirectory;
let azurite;

try {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'security-state-azurite-'));
  const certificate = join(temporaryDirectory, 'azurite-cert.pem');
  const key = join(temporaryDirectory, 'azurite-key.pem');
  const certificateResult = run('openssl', [
    'req', '-newkey', 'rsa:2048', '-x509', '-nodes',
    '-keyout', key, '-out', certificate, '-sha256', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'
  ]);
  if (certificateResult.error || certificateResult.status !== 0) {
    throw new Error(`OpenSSL certificate generation failed: ${certificateResult.stderr.trim() || certificateResult.error?.message || 'unknown error'}`);
  }

  const port = await availablePort();
  azurite = spawn(azuriteExecutable, [
    '--oauth', 'basic',
    '--cert', certificate,
    '--key', key,
    '--inMemoryPersistence',
    '--disableTelemetry',
    '--disableProductStyleUrl',
    '--tableHost', '127.0.0.1',
    '--tablePort', String(port)
  ], { cwd: temporaryDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForListening(azurite, 15_000);

  const testResult = run(process.execPath, [vitestExecutable, 'run', 'test/azure-store.azurite.test.ts'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      AZURITE_OAUTH_TOKEN: testToken(),
      AZURITE_TABLE_ENDPOINT: `https://127.0.0.1:${port}/devstoreaccount1`,
      NODE_EXTRA_CA_CERTS: certificate
    }
  });
  if (testResult.stdout !== undefined) process.stdout.write(testResult.stdout);
  if (testResult.stderr !== undefined) process.stderr.write(testResult.stderr);
  if (testResult.error || testResult.status !== 0) {
    throw new Error(`Vitest/Azurite integration failed (exit=${String(testResult.status)}): ${testResult.error?.message || 'see test output above'}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : 'unknown failure');
} finally {
  if (azurite !== undefined) await stopChild(azurite);
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}
