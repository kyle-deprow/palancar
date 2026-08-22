import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runHealthcheck, type HealthcheckFetch } from '../src/healthcheck.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_SHA256 = 'a'.repeat(64);
const VALID_ARGV = ['node', 'apps/relay/dist/azure-generation-diagnostic.js'] as const;
const VALID_ENV = Object.freeze({
  PORT: '8787',
  AZURE_CLIENT_ID: CLIENT_ID,
  PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://diagnostic.openai.azure.com',
  PALANCAR_AZURE_GENERATION_DEPLOYMENT: 'gpt-5.6-luna',
  PALANCAR_DIAGNOSTIC_REQUEST_ID: REQUEST_ID,
  PALANCAR_DIAGNOSTIC_RUN_ID: 'run_01-A',
  PALANCAR_DIAGNOSTIC_PLAN_SHA256: PLAN_SHA256
});

function cmdline(argv: readonly string[]): Uint8Array {
  return Buffer.from(`${argv.join('\0')}\0`, 'utf8');
}

function healthyFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true })
  }));
}

function unhealthyFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: false,
    json: async () => ({ ok: true })
  }));
}

function asHealthcheckFetch(value: unknown): HealthcheckFetch {
  return value as HealthcheckFetch;
}

describe('relay diagnostic-aware healthcheck', () => {
  it('bypasses HTTP only for the exact diagnostic invocation and tuple', async () => {
    const fetchFunction = healthyFetch();

    await expect(runHealthcheck({
      environment: VALID_ENV,
      readProcCmdline: async () => cmdline(VALID_ARGV),
      fetch: asHealthcheckFetch(fetchFunction)
    })).resolves.toBe(0);
    expect(fetchFunction).not.toHaveBeenCalled();
  });

  it.each([
    ['shell', ['sh', '-c', 'node apps/relay/dist/azure-generation-diagnostic.js']],
    ['eval', ['node', '-e', 'eval("...")']],
    ['sleep', ['sleep', '60']],
    ['extra argv', [...VALID_ARGV, 'extra']],
    ['wrong path', ['node', 'apps/relay/dist/main.js']],
    ['absolute node', ['/usr/local/bin/node', VALID_ARGV[1]]]
  ] as const)('does not bypass for %s', async (_label, argv) => {
    const fetchFunction = healthyFetch();

    await expect(runHealthcheck({
      environment: VALID_ENV,
      readProcCmdline: async () => cmdline(argv),
      fetch: asHealthcheckFetch(fetchFunction)
    })).resolves.toBe(0);
    expect(fetchFunction).toHaveBeenCalledOnce();
  });

  it.each([
    ['client ID', { AZURE_CLIENT_ID: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }],
    ['non-v4 client ID', { AZURE_CLIENT_ID: '11111111-1111-5111-8111-111111111111' }],
    ['endpoint scheme', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'HTTPS://diagnostic.openai.azure.com' }],
    ['endpoint host case', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://Diagnostic.openai.azure.com' }],
    ['endpoint path', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://diagnostic.openai.azure.com/path' }],
    ['endpoint query', { PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://diagnostic.openai.azure.com?x=1' }],
    ['deployment', { PALANCAR_AZURE_GENERATION_DEPLOYMENT: 'gpt-5.6-luna-2' }],
    ['request ID', { PALANCAR_DIAGNOSTIC_REQUEST_ID: 'not-a-uuid' }],
    ['run ID leading punctuation', { PALANCAR_DIAGNOSTIC_RUN_ID: '-run' }],
    ['run ID too long', { PALANCAR_DIAGNOSTIC_RUN_ID: 'a'.repeat(65) }],
    ['plan hash uppercase', { PALANCAR_DIAGNOSTIC_PLAN_SHA256: 'A'.repeat(64) }],
    ['plan hash short', { PALANCAR_DIAGNOSTIC_PLAN_SHA256: 'a'.repeat(63) }],
    ['missing client ID', { AZURE_CLIENT_ID: undefined }],
    ['missing endpoint', { PALANCAR_AZURE_GENERATION_ENDPOINT: undefined }],
    ['missing deployment', { PALANCAR_AZURE_GENERATION_DEPLOYMENT: undefined }],
    ['missing request ID', { PALANCAR_DIAGNOSTIC_REQUEST_ID: undefined }],
    ['missing run ID', { PALANCAR_DIAGNOSTIC_RUN_ID: undefined }],
    ['missing plan hash', { PALANCAR_DIAGNOSTIC_PLAN_SHA256: undefined }],
    ['extra diagnostic key', { PALANCAR_DIAGNOSTIC_EXTRA: 'unexpected' }]
  ] as const)('falls back for invalid diagnostic %s', async (_label, override) => {
    const fetchFunction = healthyFetch();

    await expect(runHealthcheck({
      environment: { ...VALID_ENV, ...override },
      readProcCmdline: async () => cmdline(VALID_ARGV),
      fetch: asHealthcheckFetch(fetchFunction)
    })).resolves.toBe(0);
    expect(fetchFunction).toHaveBeenCalledOnce();
  });

  it('returns failure when malformed argv falls back to an unhealthy relay', async () => {
    const fetchFunction = unhealthyFetch();

    await expect(runHealthcheck({
      environment: VALID_ENV,
      readProcCmdline: async () => cmdline(['sh', '-c', 'node apps/relay/dist/azure-generation-diagnostic.js']),
      fetch: asHealthcheckFetch(fetchFunction)
    })).resolves.toBe(1);
    expect(fetchFunction).toHaveBeenCalledOnce();
  });

  it('returns failure when malformed diagnostic environment falls back to an unhealthy relay', async () => {
    const fetchFunction = unhealthyFetch();

    await expect(runHealthcheck({
      environment: {
        ...VALID_ENV,
        PALANCAR_AZURE_GENERATION_ENDPOINT: 'https://diagnostic.openai.azure.com/path'
      },
      readProcCmdline: async () => cmdline(VALID_ARGV),
      fetch: asHealthcheckFetch(fetchFunction)
    })).resolves.toBe(1);
    expect(fetchFunction).toHaveBeenCalledOnce();
  });

  it.each([
    ['unreadable', async () => { throw new Error('unreadable'); }],
    ['malformed', async () => Buffer.from('node\0apps/relay/dist/azure-generation-diagnostic.js')],
    ['invalid UTF-8', async () => Uint8Array.from([0x6e, 0x6f, 0x64, 0x65, 0, 0xff, 0])],
    ['oversized', async () => new Uint8Array(4_097)]
  ] as const)('falls back for %s proc data', async (_label, readProcCmdline) => {
    const fetchFunction = healthyFetch();

    await expect(runHealthcheck({
      environment: VALID_ENV,
      readProcCmdline,
      fetch: asHealthcheckFetch(fetchFunction)
    })).resolves.toBe(0);
    expect(fetchFunction).toHaveBeenCalledOnce();
  });

  it('keeps the strict healthy and unhealthy HTTP fallback behavior', async () => {
    const healthy = healthyFetch();
    await expect(runHealthcheck({
      environment: { PORT: '8788' },
      readProcCmdline: async () => cmdline(['node', 'apps/relay/dist/main.js']),
      fetch: asHealthcheckFetch(healthy)
    })).resolves.toBe(0);
    expect(healthy).toHaveBeenCalledWith('http://127.0.0.1:8788/healthz');

    for (const response of [
      { ok: false, json: async () => ({ ok: true }) },
      { ok: true, json: async () => ({ ok: false }) },
      { ok: true, json: async () => ({}) },
      { ok: true, json: async () => { throw new Error('invalid JSON'); } }
    ]) {
      const fetchFunction = vi.fn(async () => response);
      await expect(runHealthcheck({
        environment: { PORT: '8787' },
        readProcCmdline: async () => cmdline(['node', 'apps/relay/dist/main.js']),
        fetch: asHealthcheckFetch(fetchFunction)
      })).resolves.toBe(1);
      expect(fetchFunction).toHaveBeenCalledOnce();
    }
  });

  it('uses the exec-form Docker healthcheck entrypoint with the fixed bounds', () => {
    const dockerfile = readFileSync(resolve(import.meta.dirname, '..', 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(
      'HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=6 CMD ["node", "apps/relay/dist/healthcheck.js"]'
    );
  });
});
