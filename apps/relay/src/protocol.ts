import {
  DEFAULT_NEGOTIATED_LIMITS,
  WEBSOCKET_SUBPROTOCOL,
  WEBSOCKET_TICKET_PREFIX,
  assertBase64UrlSecret,
  assertNegotiatedLimits
} from '@palancar/contracts';
import type { NegotiatedLimits } from '@palancar/contracts';

import type {
  ConsumedRelayTicket,
  PreparedStreamUpgrade,
  RelayUpgradeAudience,
  StreamSubprotocolSelection,
  TicketConsumer
} from './types.js';

export function hasExactNewSessionIntent(claim: unknown): boolean {
  if (typeof claim !== 'object' || claim === null) {
    return false;
  }

  try {
    const claimIntent = Object.getOwnPropertyDescriptor(claim, 'intent');
    if (claimIntent === undefined || !Object.hasOwn(claimIntent, 'value')) {
      return false;
    }

    const intent = claimIntent.value as unknown;
    if (
      typeof intent !== 'object' ||
      intent === null ||
      Object.getPrototypeOf(intent) !== Object.prototype
    ) {
      return false;
    }

    const keys = Reflect.ownKeys(intent);
    if (keys.length !== 1 || keys[0] !== 'intent') {
      return false;
    }

    const intentValue = Object.getOwnPropertyDescriptor(intent, 'intent');
    return (
      intentValue !== undefined &&
      Object.hasOwn(intentValue, 'value') &&
      intentValue.value === 'new'
    );
  } catch {
    return false;
  }
}

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

function consumeFailureStatus(reason: string): 401 | 403 | 409 | 429 | 503 {
  switch (reason) {
    case 'authentication_failed':
    case 'ticket_expired':
      return 401;
    case 'origin_rejected':
      return 403;
    case 'session_conflict':
      return 409;
    case 'rate_limited':
      return 429;
    case 'state_unavailable':
      return 503;
    default:
      return 503;
  }
}

export async function prepareStreamUpgrade(input: {
  readonly offeredSubprotocols: readonly string[];
  readonly audience: RelayUpgradeAudience;
  readonly ticketConsumer: TicketConsumer;
}): Promise<PreparedStreamUpgrade> {
  const selection = selectStreamSubprotocols(input.offeredSubprotocols);
  if (selection.status === 'rejected') {
    return selection;
  }

  try {
    const result = await input.ticketConsumer.consume(selection.ticket, input.audience);
    if (result.status === 'accepted') {
      if (!hasExactNewSessionIntent(result.claim)) {
        return { status: 'rejected', httpStatus: 401 };
      }
      return {
        status: 'accepted',
        selectedProtocol: WEBSOCKET_SUBPROTOCOL,
        ticketClaim: result.claim
      };
    }
    return { status: 'rejected', httpStatus: consumeFailureStatus(result.reason) };
  } catch {
    return { status: 'rejected', httpStatus: 503 };
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

export type { ConsumedRelayTicket };
