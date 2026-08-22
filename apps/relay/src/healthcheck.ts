import { open as openFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PROC_CMDLINE_PATH = '/proc/1/cmdline';
const MAX_PROC_CMDLINE_BYTES = 4_096;
const DIAGNOSTIC_ENTRYPOINT = 'apps/relay/dist/azure-generation-diagnostic.js';
const CANONICAL_AZURE_CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_AZURE_GENERATION_ENDPOINT =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openai\.azure\.com$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PLAN_SHA256 = /^[a-f0-9]{64}$/;
const DIAGNOSTIC_KEYS = Object.freeze([
  'PALANCAR_DIAGNOSTIC_REQUEST_ID',
  'PALANCAR_DIAGNOSTIC_RUN_ID',
  'PALANCAR_DIAGNOSTIC_PLAN_SHA256'
] as const);

type HealthcheckEnvironment = Readonly<Record<string, string | undefined>>;

export interface HealthcheckResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type HealthcheckFetch = (url: string) => Promise<HealthcheckResponse>;

export interface HealthcheckDependencies {
  readonly environment?: HealthcheckEnvironment;
  readonly readProcCmdline?: () => Promise<Uint8Array>;
  readonly fetch?: HealthcheckFetch;
}

async function readProcCmdline(): Promise<Uint8Array> {
  const file = await openFile(PROC_CMDLINE_PATH, 'r');
  try {
    const buffer = Buffer.alloc(MAX_PROC_CMDLINE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await file.read(buffer, offset, buffer.byteLength - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_PROC_CMDLINE_BYTES) throw new Error('proc cmdline too large');
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

function parseProcArgv(value: Uint8Array): readonly string[] | undefined {
  if (value.byteLength === 0 || value[value.byteLength - 1] !== 0) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
    const argv = text.slice(0, -1).split('\0');
    if (argv.some((argument) => argument.length === 0)) return undefined;
    return argv;
  } catch {
    return undefined;
  }
}

function hasExactDiagnosticEnvironment(environment: HealthcheckEnvironment): boolean {
  if (Object.keys(environment).some((name) =>
    name.startsWith('PALANCAR_DIAGNOSTIC_') && !DIAGNOSTIC_KEYS.includes(
      name as (typeof DIAGNOSTIC_KEYS)[number]
    )
  )) {
    return false;
  }
  const clientId = environment.AZURE_CLIENT_ID;
  const endpoint = environment.PALANCAR_AZURE_GENERATION_ENDPOINT;
  const deployment = environment.PALANCAR_AZURE_GENERATION_DEPLOYMENT;
  const requestId = environment.PALANCAR_DIAGNOSTIC_REQUEST_ID;
  const runId = environment.PALANCAR_DIAGNOSTIC_RUN_ID;
  const planSha256 = environment.PALANCAR_DIAGNOSTIC_PLAN_SHA256;
  return (
    typeof clientId === 'string' && CANONICAL_AZURE_CLIENT_ID.test(clientId) &&
    typeof endpoint === 'string' && CANONICAL_AZURE_GENERATION_ENDPOINT.test(endpoint) &&
    deployment === 'gpt-5.6-luna' &&
    typeof requestId === 'string' && CANONICAL_UUID.test(requestId) &&
    typeof runId === 'string' && RUN_ID.test(runId) && runId !== '.' && runId !== '..' &&
    typeof planSha256 === 'string' && PLAN_SHA256.test(planSha256)
  );
}

function isDiagnosticInvocation(
  argv: readonly string[] | undefined,
  environment: HealthcheckEnvironment
): boolean {
  return argv?.length === 2 && argv[0] === 'node' && argv[1] === DIAGNOSTIC_ENTRYPOINT &&
    hasExactDiagnosticEnvironment(environment);
}

async function checkRelayHealth(
  environment: HealthcheckEnvironment,
  fetchFunction: HealthcheckFetch
): Promise<boolean> {
  const response = await fetchFunction(`http://127.0.0.1:${environment.PORT}/healthz`);
  if (!response.ok) return false;
  const body = await response.json() as { readonly ok?: unknown };
  return body?.ok === true;
}

export async function runHealthcheck(
  dependencies: HealthcheckDependencies = {}
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  const fetchFunction = dependencies.fetch ?? globalThis.fetch as HealthcheckFetch;

  let argv: readonly string[] | undefined;
  try {
    const procCmdline = await (dependencies.readProcCmdline ?? readProcCmdline)();
    if (procCmdline.byteLength <= MAX_PROC_CMDLINE_BYTES) {
      argv = parseProcArgv(procCmdline);
    }
  } catch {
    argv = undefined;
  }

  try {
    if (isDiagnosticInvocation(argv, environment)) return 0;
    return await checkRelayHealth(environment, fetchFunction) ? 0 : 1;
  } catch {
    return 1;
  }
}

const isMainModule = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  process.exitCode = await runHealthcheck();
}
