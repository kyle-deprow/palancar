import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  BoundedDisplayMessageSchema,
  PositiveRevisionSchema,
  ProtocolVersionSchema,
  UtcTimestampSchema,
  UuidSchema
} from './schemas.js';

export const CANONICAL_PAIRING_CODE_PATTERN =
  '^[0-7][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{25}$';
export const BASE64URL_SECRET_PATTERN =
  '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$';

export const CanonicalPairingCodeSchema = Type.String({
  pattern: CANONICAL_PAIRING_CODE_PATTERN,
  minLength: 26,
  maxLength: 26
});
export type CanonicalPairingCode = Static<typeof CanonicalPairingCodeSchema>;

export const Base64UrlSecretSchema = Type.String({
  pattern: BASE64URL_SECRET_PATTERN,
  minLength: 43,
  maxLength: 43
});
export type Base64UrlSecret = Static<typeof Base64UrlSecretSchema>;

export const InstallationCredentialSchema = Base64UrlSecretSchema;
export type InstallationCredential = Static<typeof InstallationCredentialSchema>;

export const SessionTicketSchema = Base64UrlSecretSchema;
export type SessionTicket = Static<typeof SessionTicketSchema>;

export const PairingRedemptionRequestSchema = Type.Object(
  { pairingCode: CanonicalPairingCodeSchema },
  { additionalProperties: false }
);
export type PairingRedemptionRequest = Static<typeof PairingRedemptionRequestSchema>;

export const InstallationCredentialResponseSchema = Type.Object(
  {
    installationId: UuidSchema,
    credential: InstallationCredentialSchema,
    credentialVersion: PositiveRevisionSchema,
    idleExpiresAt: UtcTimestampSchema,
    absoluteExpiresAt: UtcTimestampSchema
  },
  { additionalProperties: false }
);
export type InstallationCredentialResponse = Static<
  typeof InstallationCredentialResponseSchema
>;

export const PairingRedemptionResponseSchema = InstallationCredentialResponseSchema;
export type PairingRedemptionResponse = InstallationCredentialResponse;

export const NewSessionTicketIntentSchema = Type.Object(
  { protocolVersion: ProtocolVersionSchema, intent: Type.Literal('new') },
  { additionalProperties: false }
);
export type NewSessionTicketIntent = Static<typeof NewSessionTicketIntentSchema>;

export const SessionTicketIntentSchema = NewSessionTicketIntentSchema;
export type SessionTicketIntent = NewSessionTicketIntent;

export const SessionTicketRequestSchema = NewSessionTicketIntentSchema;
export type SessionTicketRequest = NewSessionTicketIntent;

export const WssOriginSchema = Type.String({
  pattern: '^wss://\\S+$',
  minLength: 7,
  maxLength: 255
});
export type WssOrigin = Static<typeof WssOriginSchema>;

export const WssPathSchema = Type.Literal('/v1/stream');
export type WssPath = Static<typeof WssPathSchema>;

export const SessionTicketResponseSchema = Type.Object(
  {
    ticket: SessionTicketSchema,
    wssOrigin: WssOriginSchema,
    wssPath: WssPathSchema,
    protocolVersion: ProtocolVersionSchema,
    expiresAt: UtcTimestampSchema
  },
  { additionalProperties: false }
);
export type SessionTicketResponse = Static<typeof SessionTicketResponseSchema>;

export const RotationBeginResponseSchema = Type.Object(
  {
    pendingCredential: InstallationCredentialSchema,
    pendingCredentialVersion: PositiveRevisionSchema,
    pendingCredentialExpiresAt: UtcTimestampSchema
  },
  { additionalProperties: false }
);
export type RotationBeginResponse = Static<typeof RotationBeginResponseSchema>;

export const RotationConfirmationResponseSchema = Type.Object(
  {
    credentialVersion: PositiveRevisionSchema,
    promoted: Type.Literal(true),
    confirmedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema
  },
  { additionalProperties: false }
);
export type RotationConfirmationResponse = Static<typeof RotationConfirmationResponseSchema>;

export const HttpStatusSchema = Type.Integer({ minimum: 400, maximum: 599 });
export type HttpStatus = Static<typeof HttpStatusSchema>;

export const HttpErrorCodeSchema = Type.String({
  pattern: '^[a-z][a-z0-9_]{0,47}$',
  minLength: 1,
  maxLength: 48
});
export type HttpErrorCode = Static<typeof HttpErrorCodeSchema>;

export const HttpErrorResponseSchema = Type.Object(
  {
    status: HttpStatusSchema,
    code: HttpErrorCodeSchema,
    message: BoundedDisplayMessageSchema
  },
  { additionalProperties: false }
);
export type HttpErrorResponse = Static<typeof HttpErrorResponseSchema>;

export const WEBSOCKET_SUBPROTOCOL = 'palancar.v1' as const;
export const WEBSOCKET_TICKET_PREFIX = 'palancar.ticket.' as const;

export function isCanonicalPairingCode(value: unknown): value is CanonicalPairingCode {
  return Value.Check(CanonicalPairingCodeSchema, value);
}

export function assertCanonicalPairingCode(value: unknown): CanonicalPairingCode {
  if (!isCanonicalPairingCode(value)) {
    throw new TypeError('Pairing code is not canonical Crockford Base32');
  }

  return value;
}

export function isBase64UrlSecret(value: unknown): value is Base64UrlSecret {
  return Value.Check(Base64UrlSecretSchema, value);
}

export function assertBase64UrlSecret(value: unknown): Base64UrlSecret {
  if (!isBase64UrlSecret(value)) {
    throw new TypeError('Secret must be canonical 256-bit unpadded base64url');
  }

  return value;
}

export function isInstallationCredential(value: unknown): value is InstallationCredential {
  return isBase64UrlSecret(value);
}

export function isSessionTicket(value: unknown): value is SessionTicket {
  return isBase64UrlSecret(value);
}

function isValidCanonicalHostname(hostname: string): boolean {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return /^[0-9a-f:]+$/.test(hostname.slice(1, -1));
  }

  if (hostname.length === 0 || hostname.length > 253) {
    return false;
  }

  return hostname.split('.').every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}

export function isCanonicalWssOrigin(value: unknown): value is WssOrigin {
  if (!Value.Check(WssOriginSchema, value)) {
    return false;
  }

  try {
    const url = new URL(value);
    const port = url.port === '' ? undefined : Number(url.port);
    return (
      url.protocol === 'wss:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      isValidCanonicalHostname(url.hostname) &&
      (port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65_535)) &&
      value === url.origin
    );
  } catch {
    return false;
  }
}

export function assertCanonicalWssOrigin(value: unknown): WssOrigin {
  if (!isCanonicalWssOrigin(value)) {
    throw new TypeError('WebSocket origin must be a canonical wss origin');
  }

  return value;
}

export function createWebSocketSubprotocols(
  ticket: unknown
): readonly [typeof WEBSOCKET_SUBPROTOCOL, string] {
  const validTicket = assertBase64UrlSecret(ticket);
  return Object.freeze([
    WEBSOCKET_SUBPROTOCOL,
    `${WEBSOCKET_TICKET_PREFIX}${validTicket}`
  ]) as readonly [typeof WEBSOCKET_SUBPROTOCOL, string];
}

export const buildWebSocketSubprotocols = createWebSocketSubprotocols;
