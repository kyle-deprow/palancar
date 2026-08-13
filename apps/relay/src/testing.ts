import {
  DEFAULT_NEGOTIATED_LIMITS,
  createWebSocketSubprotocols,
  type NegotiatedLimits
} from '@palancar/contracts';
import {
  GenerationService,
  type GenerationProvider,
  type GenerationProviderCompletion
} from '@palancar/generation';
import { DeterministicMockTranscriptionAdapter } from '@palancar/transcription';

import type {
  ConsumedRelayTicket,
  RelayClock,
  RelayIdGenerator,
  RelaySessionCoreOptions
} from './types.js';

export const TEST_SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_UTTERANCE_ID = '22222222-2222-4222-8222-222222222222';
export const TEST_SECOND_UTTERANCE_ID = '33333333-3333-4333-8333-333333333333';
export const TEST_ERROR_ID = '44444444-4444-4444-8444-444444444444';
export const TEST_GATE_POLICY_VERSION = '1.0.0';
export const TEST_TICKET = 'A'.repeat(42) + 'E';

export function createTestTicketClaim(
  intent: ConsumedRelayTicket['intent'] = { intent: 'new' }
): ConsumedRelayTicket {
  return {
    installationId: TEST_SESSION_ID,
    credentialVersion: 1,
    intent,
    expiresAt: '2026-08-10T00:00:00.000Z'
  };
}

export function createTestClock(): RelayClock {
  return { nowIso: () => '2026-08-10T12:00:00.000Z' };
}

export function createTestIds(): RelayIdGenerator {
  let errorCounter = 0;
  return {
    sessionId: () => TEST_SESSION_ID,
    errorId: () => {
      errorCounter += 1;
      return errorCounter === 1
        ? TEST_ERROR_ID
        : `44444444-4444-4444-8444-${String(errorCounter).padStart(12, '0')}`;
    }
  };
}

export function createTestGenerationService(
  provider: GenerationProvider = {
    id: 'test-provider',
    version: '1.0.0',
    complete: async (): Promise<GenerationProviderCompletion> => ({
      englishTranslation: 'hello',
      suggestions: [
        { englishText: 'hello', selectedTargetText: 'hola' },
        { englishText: 'hi', selectedTargetText: 'buenas' }
      ]
    })
  }
): GenerationService {
  return new GenerationService(provider);
}

export function createTestOptions(
  overrides: Partial<RelaySessionCoreOptions> = {},
  limits: NegotiatedLimits = DEFAULT_NEGOTIATED_LIMITS
): RelaySessionCoreOptions {
  return {
    ticketClaim: createTestTicketClaim(),
    clock: createTestClock(),
    ids: createTestIds(),
    transcriptionAdapter: new DeterministicMockTranscriptionAdapter({
      evidenceCategory: 'selected-target'
    }),
    generationService: createTestGenerationService(),
    gatePolicyVersion: TEST_GATE_POLICY_VERSION,
    serverLimits: limits,
    ...overrides
  };
}

export function createTestSubprotocols(): readonly [string, string] {
  return createWebSocketSubprotocols(TEST_TICKET);
}
