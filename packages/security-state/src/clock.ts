import { systemPairingCode, systemToken, systemUuid } from './crypto.js';
import type { SecurityClock, SecurityIdFactory, SecurityTokenFactory, StateAvailability } from './types.js';

export function createSystemClock(): SecurityClock {
  return Object.freeze({ now: (): number => Date.now() });
}

export function createSystemIdFactory(): SecurityIdFactory {
  return Object.freeze({
    installationId: systemUuid,
    sessionId: systemUuid,
    grantId: systemUuid,
    generationClaimId: systemUuid
  });
}

export function createSystemTokenFactory(): SecurityTokenFactory {
  return Object.freeze({
    pairingCode: systemPairingCode,
    credential: systemToken,
    ticket: systemToken
  });
}

export function createAvailableState(): StateAvailability {
  return Object.freeze({ isAvailable: (): boolean => true });
}
