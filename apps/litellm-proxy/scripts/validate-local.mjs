import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../../..', import.meta.url);
const cwd = root.pathname;
const image = process.env.PALANCAR_LITELLM_IMAGE ?? 'palancar-litellm-proxy:local';
const container = `palancar-litellm-validation-${process.pid}-${randomBytes(4).toString('hex')}`;

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function envArgs(environment) {
  return Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
}

function assertRejected(environment, label) {
  const result = docker([
    'run', '--rm', '--name', `${container}-${label}`,
    ...envArgs(environment), image
  ]);
  assert(result.status !== 0, `${label} configuration was accepted unexpectedly`);
}

function staticValidate(reason) {
  const dockerfile = readFileSync('apps/litellm-proxy/Dockerfile', 'utf8');
  const entrypoint = readFileSync('apps/litellm-proxy/entrypoint.sh', 'utf8');
  const metadata = readFileSync('apps/litellm-proxy/metadata-server.mjs', 'utf8');
  const config = readFileSync('apps/litellm-proxy/config.template.yaml', 'utf8');

  assert(
    dockerfile.includes('ghcr.io/berriai/litellm:v1.75.5-stable@sha256:751ba882360f8d62c63ceb0a5b628f897cee0e0b93b3596c81ff1228e6b77ce3'),
    'Dockerfile does not use the pinned LiteLLM base image'
  );
  assert(!/^RUN /m.test(dockerfile), 'Dockerfile must not execute build-time steps against the amd64-only pinned image');
  assert(dockerfile.includes('ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]'), 'Dockerfile must invoke entrypoint through /bin/sh');
  assert(entrypoint.includes('set -eu'), 'entrypoint must use set -eu');
  assert(entrypoint.includes('openrouter|azure'), 'entrypoint must validate the backend enum');
  assert(entrypoint.includes('reject_nonempty AZURE_API_KEY'), 'entrypoint must reject Azure credentials in OpenRouter mode');
  assert(entrypoint.includes('reject_nonempty AZURE_OPENAI_API_KEY'), 'entrypoint must reject AZURE_OPENAI_API_KEY in OpenRouter mode');
  assert(entrypoint.includes('reject_nonempty AZURE_USERNAME'), 'entrypoint must reject AZURE_USERNAME in OpenRouter mode');
  assert(entrypoint.includes('reject_nonempty AZURE_PASSWORD'), 'entrypoint must reject AZURE_PASSWORD in OpenRouter mode');
  assert(entrypoint.includes('reject_nonempty OPENROUTER_API_KEY'), 'entrypoint must reject OpenRouter credentials in Azure mode');
  assert(entrypoint.includes('litellm --config /tmp/palancar-litellm.yaml --host 0.0.0.0 --port 4000'), 'entrypoint must start LiteLLM on 0.0.0.0:4000');
  assert(entrypoint.includes('python /app/metadata-server.mjs &'), 'entrypoint must start metadata server');
  assert(metadata.includes('"alias": "palancar-generation"'), 'metadata endpoint must expose fixed alias');
  assert(metadata.includes('"backend"') && metadata.includes('"upstreamModel"'), 'metadata endpoint must expose backend and upstreamModel');
  assert(!metadata.includes('API_KEY') && !metadata.includes('MASTER_KEY'), 'metadata server must not reference credential variables');
  assert(config.includes('model_name: palancar-generation'), 'config must expose only the fixed model alias');
  assert(config.includes('num_retries: 0'), 'config must disable LiteLLM retries');
  assert(config.includes('fallbacks: []'), 'config must disable fallbacks');
  assert(!/(database|sqlite|postgres|mysql|mongodb|redis)/i.test(config), 'config must not configure a database');

  return `runtime skipped (${reason}); static validation covered pinned image, backend validation, credential rejection wiring, metadata shape, fixed model alias, retry/fallback disablement, and no DB config`;
}

let output = '';
try {
  const build = docker(['build', '-f', 'apps/litellm-proxy/Dockerfile', '-t', image, '.'], { timeout: 300_000 });
  assert(build.status === 0, `docker build failed:\n${build.stderr}`);

  const common = {
    PALANCAR_LITELLM_BACKEND: 'openrouter',
    PALANCAR_LITELLM_UPSTREAM_MODEL: 'openrouter/dummy/model',
    OPENROUTER_API_KEY: 'dummy-openrouter-key',
    LITELLM_MASTER_KEY: 'dummy-master-key'
  };

  const started = docker([
    'run', '-d', '--name', container,
    '-p', '127.0.0.1:0:4000',
    '-p', '127.0.0.1:0:4001',
    ...envArgs(common), image
  ]);
  assert(started.status === 0, `docker run failed:\n${started.stderr}`);

  let state = '';
  const startupDeadline = Date.now() + 20_000;
  while (Date.now() < startupDeadline) {
    const inspected = docker(['inspect', '--format', '{{.State.Status}}', container]);
    assert(inspected.status === 0, `could not inspect container state: ${inspected.stderr}`);
    state = inspected.stdout.trim();
    if (state === 'running' || state === 'exited' || state === 'dead') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (state !== 'running') {
    const logs = docker(['logs', container]);
    const combinedLogs = `${logs.stdout}${logs.stderr}`;
    if ((state === 'exited' || state === 'dead') && combinedLogs.includes('exec format error')) {
      output = staticValidate('pinned LiteLLM image is not executable by this Docker host: exec format error');
    } else if (state === 'exited' || state === 'dead') {
      throw new Error(`container exited before validation:\n${combinedLogs}`);
    } else {
      throw new Error(`container did not become running within the startup window (state: ${state || 'unknown'}):\n${combinedLogs}`);
    }
  }

  const port = (containerPort) => {
    const result = docker(['port', container, `${containerPort}/tcp`]);
    assert(result.status === 0, `could not inspect port ${containerPort}: ${result.stderr}`);
    const match = result.stdout.trim().match(/:(\d+)$/m);
    assert(match, `could not parse published port ${containerPort}`);
    return Number(match[1]);
  };

  if (output === '') {
    assertRejected({
      ...common,
      AZURE_API_KEY: 'unexpected-azure-key'
    }, 'mixed-openrouter');
    for (const [variable, label] of [
      ['AZURE_OPENAI_API_KEY', 'azure-openai-api-key'],
      ['AZURE_USERNAME', 'azure-username'],
      ['AZURE_PASSWORD', 'azure-password']
    ]) {
      assertRejected({
        ...common,
        [variable]: `unexpected-${variable.toLowerCase()}`
      }, `mixed-openrouter-${label}`);
    }
    assertRejected({
      PALANCAR_LITELLM_BACKEND: 'azure',
      PALANCAR_LITELLM_UPSTREAM_MODEL: 'azure/dummy-deployment',
      AZURE_API_BASE: 'https://dummy.invalid',
      AZURE_API_VERSION: '2024-10-21',
      AZURE_API_KEY: 'dummy-azure-key',
      OPENROUTER_API_KEY: 'unexpected-openrouter-key',
      LITELLM_MASTER_KEY: 'dummy-master-key'
    }, 'mixed-azure');

    const litellmPort = port(4000);
    const metadataPort = port(4001);
    const waitFor = async (url, predicate, label, timeoutMs = 45_000) => {
      const deadline = Date.now() + timeoutMs;
      let lastError = 'not ready';
      while (Date.now() < deadline) {
        try {
          const response = await fetch(url);
          const body = await response.text();
          if (predicate(response, body)) return body;
          lastError = `${response.status} ${body.slice(0, 200)}`;
        } catch (error) {
          lastError = error.message;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`${label} did not become ready: ${lastError}`);
    };

    await waitFor(
      `http://127.0.0.1:${litellmPort}/health/readiness`,
      (response) => response.ok,
      'LiteLLM readiness'
    );

    const unauthenticated = await fetch(`http://127.0.0.1:${litellmPort}/v1/models`);
    assert(unauthenticated.status === 401, `unauthenticated /v1/models returned ${unauthenticated.status}, expected 401`);

    const authenticated = await fetch(`http://127.0.0.1:${litellmPort}/v1/models`, {
      headers: { authorization: 'Bearer dummy-master-key' }
    });
    assert(authenticated.ok, `authenticated /v1/models returned ${authenticated.status}`);
    const catalog = await authenticated.json();
    assert(Array.isArray(catalog.data), 'authenticated catalog .data is not an array');
    assert(catalog.data.length === 1 && catalog.data[0]?.id === 'palancar-generation', `unexpected model catalog: ${JSON.stringify(catalog)}`);

    const metadataResponse = await fetch(`http://127.0.0.1:${metadataPort}/palancar/provider`);
    assert(metadataResponse.ok, `metadata endpoint returned ${metadataResponse.status}`);
    const metadata = await metadataResponse.json();
    assert(JSON.stringify(metadata) === JSON.stringify({
      alias: 'palancar-generation',
      backend: 'openrouter',
      upstreamModel: 'openrouter/dummy/model'
    }), `unexpected metadata: ${JSON.stringify(metadata)}`);
    assert(!JSON.stringify(metadata).includes('dummy-openrouter-key'), 'metadata exposed a credential');

    const logs = docker(['logs', container]).stdout + docker(['logs', container]).stderr;
    assert(!/(database|sqlite|postgres|mysql|mongodb|redis)/i.test(logs), 'container logs contain database-related output');
    assert(!logs.includes('dummy-openrouter-key'), 'container logs exposed the provider credential');

    output = 'validated readiness, authentication, exact model catalog, metadata, mixed-credential rejection, and database-free logs';
  }
} finally {
  docker(['rm', '-f', container]);
}

console.log(`LiteLLM local validation passed: ${output}`);
