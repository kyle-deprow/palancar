import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { SecurityStateError } from './errors.js';

const PAIRING_PATTERN = /^[0-7][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type CanonicalPairingCode = string & { readonly __pairing: unique symbol };
export type CanonicalToken = string & { readonly __token: unique symbol };
export type CanonicalUuid = string & { readonly __uuid: unique symbol };
export type CanonicalSha256 = string & { readonly __sha256: unique symbol };

function invalid(): never {
  throw new SecurityStateError('invalid-input');
}

export function isCanonicalPairingCode(value: unknown): value is CanonicalPairingCode {
  return typeof value === 'string' && PAIRING_PATTERN.test(value);
}

export function assertCanonicalPairingCode(value: unknown): CanonicalPairingCode {
  return isCanonicalPairingCode(value) ? value : invalid();
}

export function isCanonical256BitToken(value: unknown): value is CanonicalToken {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === value;
  } catch {
    return false;
  }
}

export function assertCanonical256BitToken(value: unknown): CanonicalToken {
  return isCanonical256BitToken(value) ? value : invalid();
}

export function isCanonicalUuid(value: unknown): value is CanonicalUuid {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function assertCanonicalUuid(value: unknown): CanonicalUuid {
  return isCanonicalUuid(value) ? value : invalid();
}

export function isCanonicalSha256(value: unknown): value is CanonicalSha256 {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

export function assertCanonicalSha256(value: unknown): CanonicalSha256 {
  return isCanonicalSha256(value) ? value : invalid();
}

function sha256(value: string): CanonicalSha256 {
  return createHash('sha256').update(value, 'utf8').digest('hex') as CanonicalSha256;
}

export function hashPairingCode(value: unknown): CanonicalSha256 {
  return sha256(assertCanonicalPairingCode(value));
}

export function hashCredential(value: unknown): CanonicalSha256 {
  return sha256(assertCanonical256BitToken(value));
}

export function hashTicket(value: unknown): CanonicalSha256 {
  return sha256(assertCanonical256BitToken(value));
}

export function hashCorrelationKey(value: string): CanonicalSha256 {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) invalid();
  return sha256(value);
}

export function systemToken(): string {
  return randomBytes(32).toString('base64url');
}

export function systemUuid(): string {
  return randomUUID();
}

export function systemPairingCode(): string {
  let source = BigInt(`0x${randomBytes(16).toString('hex')}`);
  const output = Array<string>(26).fill('0');
  for (let index = output.length - 1; index >= 0; index -= 1) {
    output[index] = PAIRING_ALPHABET[Number(source & 31n)] ?? '0';
    source >>= 5n;
  }
  return output.join('');
}
