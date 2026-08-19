import { describe, expect, it } from 'vitest';

import {
  evaluateBrowserOrigin,
  parseBrowserOriginPolicy
} from '../src/origin-policy.js';

const ALLOWED_ORIGINS = ['https://app.example.com', 'https://console.example.com:8443'];

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify(ALLOWED_ORIGINS),
    PALANCAR_ALLOW_NULL_BROWSER_ORIGIN: 'false',
    ...overrides
  };
}

function expectInvalidConfiguration(configuration: NodeJS.ProcessEnv): void {
  expect(() => parseBrowserOriginPolicy(configuration)).toThrowError(
    new TypeError('Invalid browser origin policy configuration.')
  );
}

describe('parseBrowserOriginPolicy', () => {
  it('uses an empty origin list and rejects null by default when both variables are missing', () => {
    const policy = parseBrowserOriginPolicy({});
    expect(policy).toEqual({ allowedOrigins: [], allowNullOrigin: false });
  });

  it('accepts canonical HTTPS origins, non-default ports, and the null flag', () => {
    const policy = parseBrowserOriginPolicy(env({
      PALANCAR_ALLOW_NULL_BROWSER_ORIGIN: 'true'
    }));

    expect(policy.allowedOrigins).toEqual(ALLOWED_ORIGINS);
    expect(policy.allowNullOrigin).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.allowedOrigins)).toBe(true);
  });

  it.each([
    ['not-json', 'invalid JSON'],
    ['{}', 'a JSON object'],
    ['"https://app.example.com"', 'a JSON scalar'],
    ['null', 'JSON null'],
    ['["https://app.example.com", 1]', 'a non-string member'],
    ['["https://app.example.com", null]', 'a null member'],
    [`[${JSON.stringify('https://app.example.com')}, ${JSON.stringify('https://app.example.com')}]`, 'a duplicate'],
    [JSON.stringify(Array.from({ length: 33 }, (_, index) => `https://app-${index}.example.com`)), 'more than 32 origins']
  ])('rejects %s (%s)', (allowedOriginsJson) => {
    expectInvalidConfiguration(env({
      PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON: allowedOriginsJson
    }));
  });

  it.each([
    'http://app.example.com',
    'ws://app.example.com',
    'wss://app.example.com',
    'file:///tmp/app',
    'null',
    'https://app.example.com/',
    'https://app.example.com/path',
    'https://app.example.com?query',
    'https://app.example.com#fragment',
    'https://user@app.example.com',
    'https://user:password@app.example.com',
    'https://app.example.com:443',
    'HTTPS://app.example.com',
    'https://APP.example.com',
    'https://*.example.com',
    'https://app.example.com,https://other.example.com',
    'https:// app.example.com',
    ' https://app.example.com',
    'https://app.example.com '
  ])('rejects non-canonical configured origin %s', (origin) => {
    expectInvalidConfiguration(env({
      PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify([origin])
    }));
  });

  it.each(['', 'TRUE', 'False', ' true', 'false ', '1', 'yes', 'null'])(
    'rejects invalid null-origin flag %j',
    (allowNullOrigin) => {
      expectInvalidConfiguration(env({
        PALANCAR_ALLOW_NULL_BROWSER_ORIGIN: allowNullOrigin
      }));
    }
  );

  it('does not include raw invalid input or its cause in error serialization or stack', () => {
    const canary = 'origin-policy-canary-7f6e2d';
    let thrown: unknown;
    try {
      parseBrowserOriginPolicy(env({
        PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify([`https://${canary}.example.com:443`])
      }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toBe('Invalid browser origin policy configuration.');
    expect(JSON.stringify(thrown)).not.toContain(canary);
    expect((thrown as Error).stack).not.toContain(canary);
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('does not read unrelated environment variables', () => {
    const policy = parseBrowserOriginPolicy({
      PALANCAR_UNRELATED_ORIGIN_POLICY: 'invalid'
    });
    expect(policy).toEqual({ allowedOrigins: [], allowNullOrigin: false });
  });
});

describe('evaluateBrowserOrigin', () => {
  const policy = parseBrowserOriginPolicy(env());
  const nullPolicy = parseBrowserOriginPolicy(env({
    PALANCAR_ALLOW_NULL_BROWSER_ORIGIN: 'true'
  }));

  it('allows a missing Origin header as originless', () => {
    expect(evaluateBrowserOrigin(policy, undefined)).toEqual({ kind: 'originless' });
  });

  it.each(ALLOWED_ORIGINS)('allows exact configured origin %s', (origin) => {
    expect(evaluateBrowserOrigin(policy, origin)).toEqual({ kind: 'allowed', origin });
  });

  it('allows literal null only when configured', () => {
    expect(evaluateBrowserOrigin(policy, 'null')).toEqual({ kind: 'rejected' });
    expect(evaluateBrowserOrigin(nullPolicy, 'null')).toEqual({
      kind: 'allowed',
      origin: 'null'
    });
  });

  it.each([
    'https://APP.example.com',
    'https://app.example.com/',
    ' https://app.example.com',
    'https://app.example.com ',
    'https://app.example.com,https://console.example.com:8443',
    '"https://app.example.com"',
    'https://app.example.com:443',
    'http://app.example.com',
    'ws://app.example.com',
    'wss://app.example.com',
    'file:///tmp/app',
    'NULL',
    'null '
  ])('rejects non-exact Origin header %j without normalization', (originHeader) => {
    expect(evaluateBrowserOrigin(policy, originHeader)).toEqual({ kind: 'rejected' });
  });
});
