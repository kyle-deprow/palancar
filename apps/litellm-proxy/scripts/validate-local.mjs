import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../..', import.meta.url);
const cwd = root.pathname;
const proxyDirectory = 'apps/litellm-proxy';
const runId = `${process.pid}-${randomBytes(4).toString('hex')}`;
const forbiddenPort = String(4000 + 1);
const usage = 'usage: node apps/litellm-proxy/scripts/validate-local.mjs [--azure-qualification|--all]';
const releaseIndex = 'ghcr.io/berriai/litellm:v1.94.0@sha256:65d84a2282137b4dc73bbe184650a7c807177c533e4223b3bfbc87963fe3fabe';
const runtimeChildren = {
  amd64: {
    platform: 'linux/amd64',
    image: 'ghcr.io/berriai/litellm:v1.94.0@sha256:fa88aab52bfcf894f964b855f31be0ef83cba9f5be5d94bbc46f78fcdeb4d46b'
  },
  x86_64: {
    platform: 'linux/amd64',
    image: 'ghcr.io/berriai/litellm:v1.94.0@sha256:fa88aab52bfcf894f964b855f31be0ef83cba9f5be5d94bbc46f78fcdeb4d46b'
  },
  arm64: {
    platform: 'linux/arm64',
    image: 'ghcr.io/berriai/litellm:v1.94.0@sha256:9e2822d534546632b0678d47904d892cb3fd9332209a219720dec3af48895dff'
  },
  aarch64: {
    platform: 'linux/arm64',
    image: 'ghcr.io/berriai/litellm:v1.94.0@sha256:9e2822d534546632b0678d47904d892cb3fd9332209a219720dec3af48895dff'
  }
};

const expectedOpenRouterConfig = `model_list:
  - model_name: palancar-generation
    litellm_params:
      model: os.environ/PALANCAR_LITELLM_UPSTREAM_MODEL
      api_key: os.environ/OPENROUTER_API_KEY
      max_retries: 0

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY

litellm_settings:
  num_retries: 0
  fallbacks: []
  context_window_fallbacks: []

router_settings:
  num_retries: 0
  fallbacks: []
  context_window_fallbacks: []
`;

const expectedAzureConfig = `model_list:
  - model_name: palancar-generation
    litellm_params:
      model: os.environ/PALANCAR_LITELLM_UPSTREAM_MODEL
      api_base: os.environ/AZURE_API_BASE
      api_version: os.environ/AZURE_API_VERSION
      max_retries: 0

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY

litellm_settings:
  enable_azure_ad_token_refresh: true
  num_retries: 0
  fallbacks: []
  context_window_fallbacks: []

router_settings:
  num_retries: 0
  fallbacks: []
  context_window_fallbacks: []
`;

const forbiddenAzureExamples = [
  'AZURE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_AD_TOKEN',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'AZURE_CLIENT_CERTIFICATE_PASSWORD',
  'AZURE_CERTIFICATE_PATH',
  'AZURE_CERTIFICATE_PASSWORD',
  'AZURE_TENANT_ID',
  'AZURE_FEDERATED_TOKEN_FILE',
  'AZURE_USERNAME',
  'AZURE_PASSWORD',
  'AZURE_SCOPE',
  'AZURE_AUTHORITY_HOST',
  'AZURE_FUTURE_CREDENTIAL'
];

function parseMode(arguments_) {
  if (arguments_.length === 0) return { openRouter: true, azureQualification: false, name: 'default' };
  if (arguments_.length === 1 && arguments_[0] === '--azure-qualification') {
    return { openRouter: false, azureQualification: true, name: 'azure-qualification' };
  }
  if (arguments_.length === 1 && arguments_[0] === '--all') {
    return { openRouter: true, azureQualification: true, name: 'all' };
  }
  throw new Error(`unknown validator arguments: ${arguments_.join(' ') || '(none)'}\n${usage}`);
}

const mode = parseMode(process.argv.slice(2));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relativePath) {
  return readFileSync(relativePath, 'utf8');
}

function docker(args, options = {}) {
  return spawnSync('docker', args, {
    cwd,
    encoding: 'utf8',
    env: options.env ? { ...process.env, ...options.env } : process.env,
    timeout: options.timeout ?? 30_000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function envArgs(environment) {
  return Object.keys(environment).flatMap((key) => ['-e', key]);
}

function without(environment, variable) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key !== variable));
}

function readFileIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function staticValidate() {
  const dockerfile = read(`${proxyDirectory}/Dockerfile`);
  const entrypoint = read(`${proxyDirectory}/entrypoint.sh`);
  const readme = read(`${proxyDirectory}/README.md`);
  const openRouterConfig = read(`${proxyDirectory}/config.openrouter.yaml`);
  const azureConfig = read(`${proxyDirectory}/config.azure.yaml`);
  const topLevelFiles = readdirSync(proxyDirectory).sort();

  assert(topLevelFiles.join('\n') === [
    'Dockerfile',
    'README.md',
    'config.azure.yaml',
    'config.openrouter.yaml',
    'entrypoint.sh',
    'scripts'
  ].join('\n'), `unexpected proxy files: ${topLevelFiles.join(', ')}`);
  assert(
    dockerfile.includes('FROM --platform=linux/amd64 ghcr.io/berriai/litellm:v1.94.0@sha256:fa88aab52bfcf894f964b855f31be0ef83cba9f5be5d94bbc46f78fcdeb4d46b'),
    'Dockerfile does not pin the verified LiteLLM linux/amd64 manifest'
  );
  assert(!/^RUN /m.test(dockerfile), 'Dockerfile must not execute build-time steps');
  assert(/^EXPOSE 4000$/m.test(dockerfile), 'Dockerfile must expose port 4000');
  assert(!dockerfile.includes(forbiddenPort), `Dockerfile must not expose port ${forbiddenPort}`);
  assert(dockerfile.includes('config.openrouter.yaml'), 'Dockerfile must copy the production OpenRouter config');
  assert(!dockerfile.includes('config.azure.yaml'), 'Dockerfile must not copy the unqualified Azure fixture');
  assert(entrypoint.startsWith('#!/bin/sh\nset -eu\n'), 'entrypoint must use /bin/sh with set -eu');
  assert(entrypoint.includes('[ "$backend" = "openrouter" ] || fail "PALANCAR_LITELLM_BACKEND must be openrouter"'), 'entrypoint must allow only the OpenRouter backend');
  assert(!entrypoint.includes('config.azure.yaml'), 'entrypoint must not select the Azure qualification fixture');
  assert(!/bypass/i.test(entrypoint), 'entrypoint must not provide a backend bypass');
  assert(entrypoint.includes('name.startswith("AZURE_")'), 'entrypoint must reject the complete Azure namespace');
  assert(entrypoint.includes('name.startswith("OPENROUTER_")'), 'entrypoint must reject the complete OpenRouter namespace');
  assert(entrypoint.includes('allowed_openrouter = {"OPENROUTER_API_KEY"}'), 'entrypoint must have the exact OpenRouter namespace allowlist');
  assert(entrypoint.includes('exec litellm --config /app/config.openrouter.yaml --host 0.0.0.0 --port 4000'), 'entrypoint must exec one LiteLLM process with the OpenRouter config');
  assert(!entrypoint.includes(' &') && !entrypoint.includes('/tmp/'), 'entrypoint must not launch a helper or render a temporary config');
  assert(!entrypoint.includes(forbiddenPort), `entrypoint must not use port ${forbiddenPort}`);
  assert(openRouterConfig === expectedOpenRouterConfig, 'OpenRouter config does not match the expected static config');
  assert(azureConfig === expectedAzureConfig, 'Azure config does not match the expected static config');
  assert(!/^\s*api_key:/m.test(azureConfig), 'Azure config must not contain api_key');
  assert(!/(database|sqlite|postgres|mysql|mongodb|redis)/i.test(openRouterConfig + azureConfig), 'static configs must not configure a database');
  assert(!readme.includes(forbiddenPort), `README must not advertise port ${forbiddenPort}`);
  assert(readme.includes('every `AZURE_*`'), 'README must document exhaustive Azure namespace rejection');
  assert(readme.includes('Azure is **UNQUALIFIED**'), 'README must mark Azure unqualified');
  assert(readme.includes('--azure-qualification') && readme.includes('--all'), 'README must document validator modes');
}

function createEntrypointHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'palancar-litellm-entrypoint-'));
  const capture = join(directory, 'arguments');
  const executable = join(directory, 'litellm');
  writeFileSync(executable, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$PALANCAR_CAPTURE"\n', 'utf8');
  chmodSync(executable, 0o700);
  return {
    capture,
    directory,
    run(environment) {
      rmSync(capture, { force: true });
      return spawnSync('/bin/sh', [`${cwd}/${proxyDirectory}/entrypoint.sh`], {
        cwd,
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          PALANCAR_CAPTURE: capture,
          ...environment
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }
  };
}

function assertRejected(harness, environment, label, secret = undefined) {
  const result = harness.run(environment);
  assert(result.status !== 0, `${label} configuration was accepted unexpectedly`);
  assert(!readFileIfPresent(harness.capture), `${label} reached LiteLLM unexpectedly`);
  if (secret !== undefined) {
    assert(!`${result.stdout}${result.stderr}`.includes(secret), `${label} exposed a rejected environment value`);
  }
}

function assertBackendRejectedContentFree(harness, environment, label) {
  const result = harness.run(environment);
  assert(result.status !== 0, `${label} configuration was accepted unexpectedly`);
  assert(!readFileIfPresent(harness.capture), `${label} reached LiteLLM unexpectedly`);
  assert(result.stdout === '', `${label} wrote unexpected stdout`);
  assert(
    result.stderr === 'palancar-litellm: configuration error: PALANCAR_LITELLM_BACKEND must be openrouter\n',
    `${label} did not return the exact content-free backend error: ${JSON.stringify(result.stderr)}`
  );
  for (const value of Object.values(environment)) {
    assert(!result.stderr.includes(value), `${label} exposed an environment value`);
  }
}

function assertAccepted(harness, environment, config, label) {
  const result = harness.run(environment);
  assert(result.status === 0, `${label} entrypoint rejected valid configuration:\n${result.stderr}`);
  assert(readFileIfPresent(harness.capture) === [
    '--config', config,
    '--host', '0.0.0.0',
    '--port', '4000',
    ''
  ].join('\n'), `${label} did not exec LiteLLM with the exact arguments`);
}

function containerPort(container) {
  const result = docker(['port', container, '4000/tcp']);
  assert(result.status === 0, `could not inspect port 4000: ${result.stderr}`);
  const match = result.stdout.trim().match(/:(\d+)$/m);
  assert(match, 'could not parse published LiteLLM port');
  return Number(match[1]);
}

async function waitForRunning(container) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const inspected = docker(['inspect', '--format', '{{.State.Status}}', container]);
    assert(inspected.status === 0, `could not inspect ${container}: ${inspected.stderr}`);
    const state = inspected.stdout.trim();
    if (state === 'running') return;
    if (state === 'exited' || state === 'dead') {
      const logs = docker(['logs', container]);
      throw new Error(`${container} exited during startup:\n${logs.stdout}${logs.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${container} did not become running`);
}

async function waitForReadiness(container, port) {
  const deadline = Date.now() + 60_000;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/readiness`);
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error.message;
    }
    const state = docker(['inspect', '--format', '{{.State.Status}}', container]);
    if (state.stdout.trim() === 'exited' || state.stdout.trim() === 'dead') {
      const logs = docker(['logs', container]);
      throw new Error(`${container} exited before readiness:\n${logs.stdout}${logs.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const logs = docker(['logs', container]);
  throw new Error(`LiteLLM readiness failed: ${lastError}\n${logs.stdout}${logs.stderr}`);
}

function respondJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function consume(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

async function createFakeServices() {
  const state = {
    scenario: 'success',
    upstreamRequests: { success: 0, rateLimit: 0, serverError: 0, timeout: 0 },
    openRouterRequests: [],
    tokenRequests: [],
    azureRequests: []
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake.invalid');
    if (url.pathname === '/identity/token') {
      await consume(request);
      const number = state.tokenRequests.length + 1;
      state.tokenRequests.push({
        clientId: url.searchParams.get('client_id'),
        header: request.headers['x-identity-header'],
        resource: url.searchParams.get('resource')
      });
      const lifetime = number === 1 ? 310 : 3_600;
      respondJson(response, 200, {
        access_token: `fake-managed-identity-token-${number}`,
        client_id: '11111111-1111-4111-8111-111111111111',
        expires_in: lifetime,
        expires_on: Math.floor(Date.now() / 1_000) + lifetime,
        ...(number === 1 ? { refresh_in: 5 } : {}),
        resource: 'https://cognitiveservices.azure.com/',
        token_type: 'Bearer'
      });
      return;
    }
    if (url.pathname.includes('/openai/deployments/')) {
      await consume(request);
      state.azureRequests.push({
        authorization: request.headers.authorization,
        apiKey: request.headers['api-key']
      });
      respondJson(response, 200, completion('azure-runtime'));
      return;
    }
    if (url.pathname.endsWith('/chat/completions')) {
      const body = await consume(request);
      const scenario = state.scenario;
      state.upstreamRequests[scenario] += 1;
      state.openRouterRequests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(body),
        path: url.pathname,
        scenario
      });
      if (scenario === 'success') {
        respondJson(response, 200, completion('openai-runtime'));
      } else if (scenario === 'rateLimit') {
        respondJson(response, 429, { error: { message: 'fake rate limit', type: 'rate_limit_error' } });
      } else if (scenario === 'serverError') {
        respondJson(response, 500, { error: { message: 'fake server error', type: 'server_error' } });
      } else {
        setTimeout(() => {
          if (!response.writableEnded) respondJson(response, 200, completion('late-timeout'));
        }, 1_500);
      }
      return;
    }
    await consume(request);
    respondJson(response, 404, { error: 'not found' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'fake service did not receive a TCP port');
  return {
    port: address.port,
    state,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function completion(id) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1_000),
    model: 'fake-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  };
}

function writeOpenRouterRuntimeConfig(directory) {
  const openRouterPath = join(directory, 'openrouter.yaml');
  const common = `general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY

litellm_settings:
  num_retries: 0
  fallbacks: []
  context_window_fallbacks: []

router_settings:
  num_retries: 0
  fallbacks: []
  context_window_fallbacks: []
`;
  writeFileSync(openRouterPath, `model_list:
  - model_name: palancar-generation
    litellm_params:
      model: openrouter/fake-model
      api_base: os.environ/FAKE_OPENROUTER_API_BASE
      api_key: os.environ/FAKE_OPENROUTER_API_KEY
      max_retries: 0
      timeout: 0.3

${common}`, 'utf8');
  return openRouterPath;
}

async function startRuntime(label, runtime, configPath, environment) {
  const container = `palancar-litellm-runtime-${label}-${runId}`;
  const command = [
    'docker run -d',
    `--name ${container}`,
    `--platform ${runtime.platform}`,
    '--add-host host.docker.internal:host-gateway',
    '-p 127.0.0.1:0:4000',
    ...Object.keys(environment).map((name) => `-e ${name}`),
    `-v ${configPath}:/test/config.yaml:ro`,
    '--entrypoint litellm',
    runtime.image,
    '--config /test/config.yaml --host 0.0.0.0 --port 4000'
  ].join(' ');
  const started = docker([
    'run', '-d', '--name', container,
    '--platform', runtime.platform,
    '--add-host', 'host.docker.internal:host-gateway',
    '-p', '127.0.0.1:0:4000',
    ...envArgs(environment),
    '-v', `${configPath}:/test/config.yaml:ro`,
    '--entrypoint', 'litellm',
    runtime.image,
    '--config', '/test/config.yaml', '--host', '0.0.0.0', '--port', '4000'
  ], { env: environment, timeout: 60_000 });
  assert(started.status === 0, `${label} runtime command failed:\n${command}\n${started.stdout}${started.stderr}`);
  try {
    await waitForRunning(container);
    const port = containerPort(container);
    await waitForReadiness(container, port);
    return { container, port, command };
  } catch (error) {
    const logs = docker(['logs', container]);
    docker(['rm', '-f', container]);
    throw new Error(`${label} runtime failed. Command:\n${command}\n${error.message}\n${logs.stdout}${logs.stderr}`);
  }
}

async function assertCatalog(runtime, masterKey, label) {
  const unauthenticated = await fetch(`http://127.0.0.1:${runtime.port}/v1/models`);
  assert(unauthenticated.status === 401, `${label} unauthenticated catalog returned ${unauthenticated.status}`);
  const authenticated = await fetch(`http://127.0.0.1:${runtime.port}/v1/models`, {
    headers: { authorization: `Bearer ${masterKey}` }
  });
  assert(authenticated.ok, `${label} authenticated catalog returned ${authenticated.status}`);
  const catalog = await authenticated.json();
  assert(
    Array.isArray(catalog.data) && catalog.data.length === 1 && catalog.data[0]?.id === 'palancar-generation',
    `${label} catalog was not the exact alias: ${JSON.stringify(catalog)}`
  );
}

async function infer(runtime, masterKey) {
  return fetch(`http://127.0.0.1:${runtime.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${masterKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'palancar-generation',
      messages: [{ role: 'user', content: 'deterministic validation' }]
    }),
    signal: AbortSignal.timeout(15_000)
  });
}

function assertNoPersistedSecret(runtime, secrets, label) {
  const script = secrets.map((_, index) => `matches=$(find /app /tmp -xdev -type f -mmin -10 -exec grep -l -F "$CHECK_${index}" {} + 2>/dev/null || true); if [ -n "$matches" ]; then printf '%s\\n' "$matches"; exit 1; fi`).join('; ');
  const environment = Object.fromEntries(secrets.map((secret, index) => [`CHECK_${index}`, secret]));
  const checked = docker(['exec', ...envArgs(environment), runtime.container, '/bin/sh', '-c', script], { env: environment });
  assert(checked.status === 0, `${label} secret-file probe failed (${checked.status}): ${checked.stdout.trim() || checked.stderr.trim() || 'path unavailable'}`);
  const logs = docker(['logs', runtime.container]);
  const combined = `${logs.stdout}${logs.stderr}`;
  for (const secret of secrets) assert(!combined.includes(secret), `${label} logs exposed a validation secret`);
}

async function validateOpenRouterRuntime(runtimeImage, configPath, fake, masterKey) {
  const environment = {
    LITELLM_MASTER_KEY: masterKey,
    FAKE_OPENROUTER_API_BASE: `http://host.docker.internal:${fake.port}/v1`,
    FAKE_OPENROUTER_API_KEY: `fake-openrouter-${runId}`
  };
  const runtime = await startRuntime('openrouter', runtimeImage, configPath, environment);
  try {
    await assertCatalog(runtime, masterKey, 'OpenRouter runtime');
    for (const [scenario, expectedStatus] of [['success', 200], ['rateLimit', 429], ['serverError', 500]]) {
      fake.state.scenario = scenario;
      const before = fake.state.upstreamRequests[scenario];
      const response = await infer(runtime, masterKey);
      assert(response.status === expectedStatus, `${scenario} inference returned ${response.status}, expected ${expectedStatus}: ${await response.text()}`);
      assert(fake.state.upstreamRequests[scenario] - before === 1, `${scenario} inference made ${fake.state.upstreamRequests[scenario] - before} upstream requests`);
    }
    fake.state.scenario = 'timeout';
    const before = fake.state.upstreamRequests.timeout;
    const timeoutResponse = await infer(runtime, masterKey);
    assert(!timeoutResponse.ok, `timeout inference unexpectedly returned ${timeoutResponse.status}`);
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    assert(fake.state.upstreamRequests.timeout - before === 1, `timeout inference made ${fake.state.upstreamRequests.timeout - before} upstream requests`);
    assert(fake.state.openRouterRequests.length === 4, `OpenRouter fixture received ${fake.state.openRouterRequests.length} requests instead of 4`);
    for (const request of fake.state.openRouterRequests) {
      assert(request.path === '/v1/chat/completions', `OpenRouter provider used unexpected path ${request.path}`);
      assert(request.authorization === `Bearer ${environment.FAKE_OPENROUTER_API_KEY}`, 'OpenRouter provider omitted its bearer key');
      assert(request.body.model === 'fake-model', `OpenRouter provider forwarded unexpected model ${request.body.model}`);
    }
    assertNoPersistedSecret(runtime, [masterKey, environment.FAKE_OPENROUTER_API_KEY], 'OpenRouter runtime');
  } catch (error) {
    const logs = docker(['logs', runtime.container]);
    throw new Error(`OpenRouter deterministic runtime validation failed. Command:\n${runtime.command}\n${error.message}\n${logs.stdout}${logs.stderr}`);
  } finally {
    docker(['rm', '-f', runtime.container]);
  }
}

async function validateManagedIdentityRuntime(runtimeImage, configPath, fake, masterKey) {
  const clientId = '11111111-1111-4111-8111-111111111111';
  const environment = {
    LITELLM_MASTER_KEY: masterKey,
    PALANCAR_LITELLM_UPSTREAM_MODEL: 'azure/fake-deployment',
    AZURE_API_BASE: `http://host.docker.internal:${fake.port}`,
    AZURE_API_VERSION: '2024-10-21',
    AZURE_CLIENT_ID: clientId,
    AZURE_CREDENTIAL: 'DefaultAzureCredential',
    IDENTITY_ENDPOINT: `http://host.docker.internal:${fake.port}/identity/token`,
    IDENTITY_HEADER: `fake-identity-header-${runId}`
  };
  const runtime = await startRuntime('managed-identity', runtimeImage, configPath, environment);
  try {
    await assertCatalog(runtime, masterKey, 'managed-identity runtime');
    const first = await infer(runtime, masterKey);
    assert(first.ok, `first managed-identity inference returned ${first.status}: ${await first.text()}`);
    assert(fake.state.tokenRequests.length === 1, `first inference made ${fake.state.tokenRequests.length} token requests`);
    assert(fake.state.azureRequests.length === 1, `first inference made ${fake.state.azureRequests.length} Azure requests`);
    assert(fake.state.azureRequests[0].authorization === 'Bearer fake-managed-identity-token-1', 'first Azure request lacked the managed-identity bearer token');
    assert(fake.state.azureRequests[0].apiKey === undefined, 'first Azure request sent an api-key header');
    assert(fake.state.tokenRequests[0].clientId === clientId, 'managed-identity request lacked the configured client id');
    assert(fake.state.tokenRequests[0].header === environment.IDENTITY_HEADER, 'managed-identity request lacked the Container Apps identity header');

    const second = await infer(runtime, masterKey);
    assert(second.ok, `cached managed-identity inference returned ${second.status}: ${await second.text()}`);
    assert(fake.state.tokenRequests.length === 1, `cached inference refreshed the token unexpectedly (${fake.state.tokenRequests.length} requests)`);
    assert(fake.state.azureRequests[1]?.authorization === 'Bearer fake-managed-identity-token-1', 'cached inference did not reuse the first bearer token');
    assert(fake.state.azureRequests[1]?.apiKey === undefined, 'cached Azure request sent an api-key header');

    // Allow for azure-identity's 30-second proactive-refresh suppression window.
    await new Promise((resolve) => setTimeout(resolve, 35_000));
    const refreshed = await infer(runtime, masterKey);
    assert(refreshed.ok, `refreshed managed-identity inference returned ${refreshed.status}: ${await refreshed.text()}`);
    assert(
      fake.state.tokenRequests.length === 2,
      `managed-identity token did not refresh after refresh_in=5 and the 30-second suppression window; token endpoint requests=${fake.state.tokenRequests.length}, expected=2`
    );
    assert(fake.state.azureRequests[2]?.authorization === 'Bearer fake-managed-identity-token-2', 'expiry refresh did not use the second bearer token');
    assert(fake.state.azureRequests[2]?.apiKey === undefined, 'refreshed Azure request sent an api-key header');
    assertNoPersistedSecret(runtime, [masterKey, environment.IDENTITY_HEADER], 'managed-identity runtime');
  } catch (error) {
    const logs = docker(['logs', runtime.container]);
    throw new Error(`Managed-identity deterministic runtime validation failed. Command:\n${runtime.command}\n${error.message}\n${logs.stdout}${logs.stderr}`);
  } finally {
    docker(['rm', '-f', runtime.container]);
  }
}

staticValidate();

const suffix = randomBytes(8).toString('hex');
const openRouter = {
  PALANCAR_LITELLM_BACKEND: 'openrouter',
  PALANCAR_LITELLM_UPSTREAM_MODEL: 'openrouter/dummy/model',
  OPENROUTER_API_KEY: `sk-or-validation-${suffix}`,
  LITELLM_MASTER_KEY: `sk-litellm-validation-${suffix}`
};
if (mode.openRouter) {
  const entrypointHarness = createEntrypointHarness();
  try {
    assertAccepted(entrypointHarness, openRouter, '/app/config.openrouter.yaml', 'OpenRouter');
    assertBackendRejectedContentFree(entrypointHarness, {}, 'missing-backend');
    assertBackendRejectedContentFree(entrypointHarness, {
      PALANCAR_LITELLM_BACKEND: 'azure',
      PALANCAR_LITELLM_UPSTREAM_MODEL: `azure/private-${suffix}`,
      AZURE_API_KEY: `azure-secret-${suffix}`,
      LITELLM_MASTER_KEY: `master-secret-${suffix}`
    }, 'azure-backend');
    assertBackendRejectedContentFree(entrypointHarness, {
      PALANCAR_LITELLM_BACKEND: `future-${suffix}`,
      PALANCAR_LITELLM_UPSTREAM_MODEL: `private-${suffix}`
    }, 'unknown-backend');
    for (const variable of ['PALANCAR_LITELLM_UPSTREAM_MODEL', 'OPENROUTER_API_KEY', 'LITELLM_MASTER_KEY']) {
      assertRejected(entrypointHarness, without(openRouter, variable), `openrouter-missing-${variable.toLowerCase()}`);
    }
    assertRejected(entrypointHarness, { ...openRouter, PALANCAR_LITELLM_UPSTREAM_MODEL: 'azure/wrong' }, 'openrouter-wrong-model-prefix');
    for (const variable of forbiddenAzureExamples) {
      const canary = `unexpected-${variable.toLowerCase()}-${suffix}`;
      assertRejected(entrypointHarness, { ...openRouter, [variable]: canary }, `openrouter-mixed-${variable.toLowerCase()}`, canary);
    }
    for (const variable of ['OPENROUTER_FUTURE_CREDENTIAL', 'OPENROUTER_BASE_URL']) {
      const canary = `unexpected-${variable.toLowerCase()}-${suffix}`;
      assertRejected(entrypointHarness, { ...openRouter, [variable]: canary }, `openrouter-extra-${variable.toLowerCase()}`, canary);
    }
    assertRejected(entrypointHarness, { ...openRouter, AZURE_FUTURE_EMPTY: '' }, 'openrouter-present-empty-azure-name');
  } finally {
    rmSync(entrypointHarness.directory, { recursive: true, force: true });
  }
}

const dockerAvailable = docker(['version', '--format', '{{.Server.Version}}']);
assert(dockerAvailable.status === 0 && !dockerAvailable.error, `Docker daemon is required for deterministic LiteLLM runtime validation:\n${dockerAvailable.stderr || dockerAvailable.error?.message}`);

const daemonArchitecture = docker(['info', '--format', '{{.Architecture}}']);
assert(daemonArchitecture.status === 0, `could not determine Docker daemon architecture: ${daemonArchitecture.stderr}`);
const runtimeImage = runtimeChildren[daemonArchitecture.stdout.trim()];
assert(runtimeImage, `no LiteLLM v1.94.0 runtime child is registered for Docker architecture ${daemonArchitecture.stdout.trim()}`);

const pull = docker(['pull', '--platform', runtimeImage.platform, runtimeImage.image], { timeout: 600_000 });
assert(pull.status === 0, `could not pull native LiteLLM v1.94.0 child from ${releaseIndex}:\ndocker pull --platform ${runtimeImage.platform} ${runtimeImage.image}\n${pull.stdout}${pull.stderr}`);
const pulledArchitecture = docker(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', runtimeImage.image]);
assert(pulledArchitecture.status === 0 && pulledArchitecture.stdout.trim() === runtimeImage.platform, `native child platform mismatch: ${pulledArchitecture.stdout.trim()}`);

const runtimeDirectory = mkdtempSync(join(tmpdir(), 'palancar-litellm-runtime-'));
const fake = await createFakeServices();
try {
  const masterKey = `sk-litellm-runtime-${suffix}`;
  if (mode.openRouter) {
    const openRouterConfigPath = writeOpenRouterRuntimeConfig(runtimeDirectory);
    await validateOpenRouterRuntime(runtimeImage, openRouterConfigPath, fake, masterKey);
  }
  if (mode.azureQualification) {
    await validateManagedIdentityRuntime(
      runtimeImage,
      join(cwd, proxyDirectory, 'config.azure.yaml'),
      fake,
      masterKey
    );
    throw new Error('Azure qualification is UNQUALIFIED; production enablement requires an explicit gating change');
  }
} finally {
  await fake.close();
  rmSync(runtimeDirectory, { recursive: true, force: true });
}

console.log(`LiteLLM ${mode.name} validation passed`);
