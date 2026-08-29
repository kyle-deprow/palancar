import { describe, expect, it } from 'vitest';

import { isCanonicalPairingCode, systemPairingCode } from '../src/crypto.js';

describe('pairing code crypto', () => {
  it('generates six decimal digits with preserved leading zeros and first-digit coverage', () => {
    const codes = Array.from({ length: 5_000 }, () => systemPairingCode());
    expect(codes.every((code) => /^[0-9]{6}$/.test(code))).toBe(true);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
    expect(new Set(codes.map((code) => code.slice(0, 1)))).toEqual(
      new Set('0123456789'.split(''))
    );
  });

  it('accepts only canonical six-digit pairing codes', () => {
    for (const valid of ['000000', '999999']) {
      expect(isCanonicalPairingCode(valid)).toBe(true);
    }
    for (const invalid of ['12345', '1234567', '12345A', '', '0'.repeat(26)]) {
      expect(isCanonicalPairingCode(invalid)).toBe(false);
    }
  });
});
