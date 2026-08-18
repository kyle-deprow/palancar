export const SECURITY_ERROR_MESSAGES = Object.freeze({
  'invalid-input': 'Security operation rejected.',
  'invalid-pairing': 'Pairing operation rejected.',
  'invalid-credential': 'Credential operation rejected.',
  'invalid-ticket': 'Ticket operation rejected.',
  'stale-lease': 'Lease operation rejected.',
  'session-rejected': 'Session operation rejected.',
  'generation-rejected': 'Generation operation rejected.',
  'quota-exceeded': 'Security quota rejected.',
  'rate-limited': 'Security rate rejected.',
  'state-unavailable': 'Security state unavailable.'
} as const);

export type SecurityErrorCategory = keyof typeof SECURITY_ERROR_MESSAGES;

/** Public errors never retain input, causes, callback failures, or secret values. */
export class SecurityStateError extends Error {
  readonly category!: SecurityErrorCategory;
  readonly code!: SecurityErrorCategory;

  constructor(category: SecurityErrorCategory) {
    const safeCategory: SecurityErrorCategory =
      typeof category === 'string' && Object.hasOwn(SECURITY_ERROR_MESSAGES, category)
        ? category
        : 'invalid-input';
    super(SECURITY_ERROR_MESSAGES[safeCategory]);
    Object.defineProperties(this, {
      name: { configurable: false, enumerable: false, value: 'SecurityStateError' },
      category: { configurable: false, enumerable: true, value: safeCategory },
      code: { configurable: false, enumerable: true, value: safeCategory }
    });
  }
}

export function securityError(category: SecurityErrorCategory): SecurityStateError {
  return new SecurityStateError(category);
}
