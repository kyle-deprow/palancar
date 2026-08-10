import { randomBytes } from 'node:crypto';

import { assertBase64UrlSecret, TICKET_LIFETIME_MS } from '@palancar/contracts';

import type {
  ConsumedRelayTicket,
  RelayTicketIntent,
  RelayUpgradeAudience,
  TicketConsumer,
  TicketConsumeResult
} from './types.js';

const DEVELOPMENT_INSTALLATION_ID = '00000000-0000-4000-8000-000000000001';

export interface DevelopmentTicketStoreOptions {
  readonly clock?: () => number;
  readonly ticketLifetimeMs?: number;
}

export interface IssueDevelopmentTicketInput {
  readonly intent: RelayTicketIntent;
  readonly audience: RelayUpgradeAudience;
  readonly installationId?: string;
  readonly credentialVersion?: number;
}

interface StoredTicket {
  readonly audience: RelayUpgradeAudience;
  readonly claim: ConsumedRelayTicket;
  readonly expiresAtMs: number;
}

function sameAudience(left: RelayUpgradeAudience, right: RelayUpgradeAudience): boolean {
  return (
    left.environment === right.environment &&
    left.origin === right.origin &&
    left.path === right.path &&
    left.protocol === right.protocol
  );
}

export class DevelopmentTicketStore implements TicketConsumer {
  readonly #clock: () => number;
  readonly #ticketLifetimeMs: number;
  readonly #tickets = new Map<string, StoredTicket>();

  constructor(options: DevelopmentTicketStoreOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#ticketLifetimeMs = options.ticketLifetimeMs ?? TICKET_LIFETIME_MS;
    if (
      typeof this.#ticketLifetimeMs !== 'number' ||
      !Number.isFinite(this.#ticketLifetimeMs) ||
      this.#ticketLifetimeMs < 0
    ) {
      throw new RangeError('Ticket lifetime must be a non-negative finite number');
    }
  }

  issue(input: IssueDevelopmentTicketInput): { readonly ticket: string; readonly expiresAt: string } {
    const ticket = assertBase64UrlSecret(randomBytes(32).toString('base64url'));
    const expiresAtMs = this.#clock() + this.#ticketLifetimeMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const claim: ConsumedRelayTicket = Object.freeze({
      installationId: input.installationId ?? DEVELOPMENT_INSTALLATION_ID,
      credentialVersion: input.credentialVersion ?? 1,
      intent: input.intent,
      expiresAt
    });
    const audience: RelayUpgradeAudience = Object.freeze({ ...input.audience });
    this.#tickets.set(ticket, { audience, claim, expiresAtMs });
    return Object.freeze({ ticket, expiresAt });
  }

  async consume(ticket: string, audience: RelayUpgradeAudience): Promise<TicketConsumeResult> {
    const stored = this.#tickets.get(ticket);
    if (stored === undefined) {
      return { status: 'rejected', reason: 'authentication_failed' };
    }

    this.#tickets.delete(ticket);
    if (this.#clock() >= stored.expiresAtMs) {
      return { status: 'rejected', reason: 'ticket_expired' };
    }
    if (!sameAudience(stored.audience, audience)) {
      return { status: 'rejected', reason: 'origin_rejected' };
    }
    return { status: 'accepted', claim: stored.claim };
  }

  get size(): number {
    return this.#tickets.size;
  }
}
