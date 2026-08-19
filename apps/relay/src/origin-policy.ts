const INVALID_CONFIGURATION_MESSAGE = 'Invalid browser origin policy configuration.';
const ALLOWED_ORIGINS_ENV = 'PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON';
const ALLOW_NULL_ORIGIN_ENV = 'PALANCAR_ALLOW_NULL_BROWSER_ORIGIN';
const MAX_ALLOWED_ORIGINS = 32;

export interface BrowserOriginPolicy {
  readonly allowedOrigins: readonly string[];
  readonly allowNullOrigin: boolean;
}

export type BrowserOriginDecision =
  | { readonly kind: 'originless' }
  | { readonly kind: 'allowed'; readonly origin: string }
  | { readonly kind: 'rejected' };

function invalidConfiguration(): TypeError {
  return new TypeError(INVALID_CONFIGURATION_MESSAGE);
}

function isCanonicalHttpsOrigin(value: string): boolean {
  if (value.length === 0 || /\s/.test(value) || value.includes('*')) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.pathname === '/' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.hostname === parsed.hostname.toLowerCase() &&
    parsed.origin === value
  );
}

function parseAllowedOrigins(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw invalidConfiguration();
  }

  if (!Array.isArray(decoded) || decoded.length > MAX_ALLOWED_ORIGINS) {
    throw invalidConfiguration();
  }

  const origins = decoded.map((origin) => {
    if (typeof origin !== 'string' || !isCanonicalHttpsOrigin(origin)) {
      throw invalidConfiguration();
    }
    return origin;
  });

  if (new Set(origins).size !== origins.length) {
    throw invalidConfiguration();
  }

  return origins;
}

function parseAllowNullOrigin(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw invalidConfiguration();
}

export function parseBrowserOriginPolicy(env: NodeJS.ProcessEnv): BrowserOriginPolicy {
  const allowedOrigins = parseAllowedOrigins(env[ALLOWED_ORIGINS_ENV]);
  const allowNullOrigin = parseAllowNullOrigin(env[ALLOW_NULL_ORIGIN_ENV]);
  const frozenOrigins = Object.freeze(allowedOrigins);
  return Object.freeze({ allowedOrigins: frozenOrigins, allowNullOrigin });
}

export function evaluateBrowserOrigin(
  policy: BrowserOriginPolicy,
  originHeader: string | undefined
): BrowserOriginDecision {
  if (originHeader === undefined) {
    return { kind: 'originless' };
  }
  if (originHeader === 'null' && policy.allowNullOrigin) {
    return { kind: 'allowed', origin: 'null' };
  }
  if (policy.allowedOrigins.includes(originHeader)) {
    return { kind: 'allowed', origin: originHeader };
  }
  return { kind: 'rejected' };
}
