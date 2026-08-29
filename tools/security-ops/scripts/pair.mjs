import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const terraformPath = '/home/dev/.local/bin/terraform-1.15.8';
const cliPath = resolve(repositoryRoot, 'tools/security-ops/dist/main.js');

function fail(message) {
  console.error(`pair: ${message}`);
  return 1;
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch {
    return undefined;
  }
}

function main() {
  if (!existsSync(cliPath)) {
    return fail('CLI itself is missing; the tool needs npm run build --workspace @palancar/security-ops');
  }
  if (!existsSync(terraformPath)) {
    return fail(`terraform output failed: missing ${terraformPath}`);
  }

  const terraformText = commandOutput(terraformPath, [
    '-chdir=infra/environments/dev',
    'output',
    '-json'
  ]);
  if (terraformText === undefined) {
    return fail('terraform output failed: unable to read dev outputs');
  }

  let terraformOutput;
  try {
    terraformOutput = JSON.parse(terraformText);
  } catch {
    return fail('terraform output failed: output was not valid JSON');
  }
  const outputValue = (value) => typeof value === 'string' ? value : value?.value;
  const tableEndpoint = outputValue(terraformOutput?.workload_table_endpoint);
  const relayOrigin = outputValue(terraformOutput?.relay_origin);
  if (typeof tableEndpoint !== 'string' || typeof relayOrigin !== 'string') {
    return fail('terraform output failed: workload_table_endpoint or relay_origin is missing');
  }
  const normalizedTableEndpoint = tableEndpoint.replace(/\/+$/, '');
  if (normalizedTableEndpoint === '' || !relayOrigin.startsWith('wss://')) {
    return fail('terraform output failed: workload_table_endpoint or relay_origin is invalid');
  }

  const accountText = commandOutput('az', [
    'account',
    'show',
    '--query',
    '{s:id,t:tenantId}',
    '-o',
    'json'
  ]);
  if (accountText === undefined) {
    return fail('az login failed: unable to read the active account');
  }
  let account;
  try {
    account = JSON.parse(accountText);
  } catch {
    return fail('az login failed: account output was not valid JSON');
  }
  if (typeof account?.s !== 'string' || typeof account?.t !== 'string') {
    return fail('az login failed: subscription or tenant ID is missing');
  }

  const principalId = commandOutput('az', [
    'ad',
    'signed-in-user',
    'show',
    '--query',
    'id',
    '-o',
    'tsv'
  ]);
  if (principalId === undefined || principalId === '') {
    return fail('az login failed: unable to read the signed-in principal ID');
  }

  const child = spawnSync(process.execPath, [cliPath, 'issue-pairing'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PALANCAR_OP_TABLE_ENDPOINT: normalizedTableEndpoint,
      PALANCAR_OP_SUBSCRIPTION_ID: account.s,
      PALANCAR_OP_TENANT_ID: account.t,
      PALANCAR_OP_PRINCIPAL_ID: principalId,
      PALANCAR_OP_OPERATOR_SCOPE: `azure-cli:${principalId}`,
      PALANCAR_OP_RELAY_ORIGIN: relayOrigin,
      PALANCAR_OP_ENVIRONMENT: 'dev'
    },
    stdio: 'inherit'
  });
  if (child.error !== undefined || child.status === null) {
    return fail('CLI itself failed to start');
  }
  if (child.status !== 0) {
    console.error('pair: CLI itself failed');
  }
  return child.status;
}

process.exitCode = main();
