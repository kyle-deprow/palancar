import {
  DEFAULT_NEGOTIATED_LIMITS,
  WEBSOCKET_SUBPROTOCOL,
  WEBSOCKET_TICKET_PREFIX,
  assertBase64UrlSecret,
  assertNegotiatedLimits
} from '@palancar/contracts';
import type { NegotiatedLimits } from '@palancar/contracts';

import type {
  PreparedStreamUpgrade,
  RelayUpgradeAudience,
  StreamSubprotocolSelection
} from './types.js';
import {
  SecurityStateError,
  type SecurityRuntimeStore
} from '@palancar/security-state';

export function selectStreamSubprotocols(
  offered: readonly string[]
): StreamSubprotocolSelection {
  if (offered.length !== 2) {
    return { status: 'rejected', httpStatus: 400 };
  }

  const baseCount = offered.filter((value) => value === WEBSOCKET_SUBPROTOCOL).length;
  const ticketBearing = offered.filter((value) => value.startsWith(WEBSOCKET_TICKET_PREFIX));
  if (baseCount !== 1 || ticketBearing.length !== 1 || new Set(offered).size !== 2) {
    return { status: 'rejected', httpStatus: baseCount === 1 ? 401 : 400 };
  }

  const ticketValue = ticketBearing[0]?.slice(WEBSOCKET_TICKET_PREFIX.length);
  if (ticketValue === undefined) {
    return { status: 'rejected', httpStatus: 401 };
  }

  try {
    assertBase64UrlSecret(ticketValue);
  } catch {
    return { status: 'rejected', httpStatus: 401 };
  }

  return {
    status: 'accepted',
    ticket: ticketValue,
    selectedProtocol: WEBSOCKET_SUBPROTOCOL
  };
}

function consumeFailureStatus(error: unknown): 401 | 409 | 429 | 503 {
  if (!(error instanceof SecurityStateError)) return 503;
  if (error.category === 'rate-limited' || error.category === 'quota-exceeded') return 429;
  if (error.category === 'session-rejected') return 409;
  if (error.category === 'state-unavailable') return 503;
  return 401;
}

export async function prepareStreamUpgrade(input: {
  readonly offeredSubprotocols: readonly string[];
  readonly audience: RelayUpgradeAudience;
  readonly environment: string;
  readonly securityRuntime: SecurityRuntimeStore;
}): Promise<PreparedStreamUpgrade> {
  const selection = selectStreamSubprotocols(input.offeredSubprotocols);
  if (selection.status === 'rejected') {
    return selection;
  }

  try {
    const sessionLease = await input.securityRuntime.consumeSessionTicket({
      ticket: selection.ticket,
      environment: input.environment,
      audience: input.audience,
      intent: 'new'
    });
    return {
      status: 'accepted',
      selectedProtocol: WEBSOCKET_SUBPROTOCOL,
      sessionLease
    };
  } catch (error) {
    return { status: 'rejected', httpStatus: consumeFailureStatus(error) };
  }
}

const LIMIT_KEYS: readonly (keyof NegotiatedLimits)[] = [
  'maxAudioPayloadBytes',
  'maxBinaryMessageBytes',
  'maxControlMessageBytes',
  'maxUnacknowledgedSamples',
  'maxRetainedReplaySamples',
  'ackIntervalMs',
  'maxUtteranceSamples',
  'maxUtteranceMs',
  'maxSessionDurationMs',
  'noNewTurnAfterMs',
  'inactivityTimeoutMs',
  'heartbeatIntervalMs',
  'heartbeatGraceMs',
  'audioRateRefillSamplesPerSecond',
  'audioRateBucketCapacitySamples'
];

export function negotiateLimits(
  requested: NegotiatedLimits,
  maximums: NegotiatedLimits = DEFAULT_NEGOTIATED_LIMITS
): NegotiatedLimits {
  assertNegotiatedLimits(requested);
  assertNegotiatedLimits(maximums);
  const negotiated = {} as NegotiatedLimits;
  for (const key of LIMIT_KEYS) {
    negotiated[key] = Math.min(requested[key], maximums[key]);
  }
  return Object.freeze(assertNegotiatedLimits(negotiated));
}
