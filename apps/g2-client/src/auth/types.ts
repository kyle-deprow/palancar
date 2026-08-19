export type AuthRequiredReason =
  | "missing"
  | "absolute-expired"
  | "credential-rejected"
  | "pairing-failed"
  | "pairing-uncertain"
  | "revoked"
  | "revocation-unconfirmed";

export type AuthOutcome =
  | { readonly kind: "ready" }
  | { readonly kind: "required"; readonly reason: AuthRequiredReason }
  | { readonly kind: "unavailable" }
  | { readonly kind: "storage-error" };

declare const sessionCredentialGrantTokenBrand: unique symbol;

export type SessionCredentialGrantToken = Readonly<{
  readonly [sessionCredentialGrantTokenBrand]: true;
}>;

export interface SessionCredentialLease {
  readonly credential: string;
  readonly credentialVersion: number;
  readonly grantToken: SessionCredentialGrantToken;
}

export type CredentialAcquisition =
  | { readonly kind: "ready"; readonly lease: SessionCredentialLease }
  | { readonly kind: "required" }
  | { readonly kind: "storage-error" };

export interface SessionCredentialProvider {
  acquire(): Promise<CredentialAcquisition>;
  recordAuthenticated(
    version: number,
    grantToken: SessionCredentialGrantToken,
  ): Promise<"recorded" | "stale" | "storage-error">;
  reject(
    version: number,
    grantToken: SessionCredentialGrantToken,
  ): Promise<"required" | "stale" | "storage-error">;
}

export interface G2AuthController {
  initialize(): Promise<AuthOutcome>;
  enroll(pairingCode: string): Promise<AuthOutcome>;
  retryPersistence(): Promise<AuthOutcome>;
  resetEnrollment(): Promise<AuthOutcome>;
  prepareSessionBoundary(options: { readonly allowRotation: boolean }): Promise<AuthOutcome>;
  revokeCurrent(): Promise<AuthOutcome>;
  readonly credentialProvider: SessionCredentialProvider;
  dispose(): void;
}

export interface AuthControllerClock {
  now(): number;
}

export type AuthControllerNow = AuthControllerClock | (() => number);

export interface AuthHttpClientLike {
  ensureRelayAwake(): Promise<void>;
  redeemPairing(code: string): Promise<InstallationCredentialResponseLike>;
  beginRotation(credential: string): Promise<RotationBeginResponseLike>;
  confirmRotation(credential: string): Promise<RotationConfirmationResponseLike>;
  revokeCurrent(credential: string): Promise<"confirmed">;
  dispose(): void;
}

export interface InstallationCredentialResponseLike {
  readonly installationId: string;
  readonly credential: string;
  readonly credentialVersion: number;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export interface RotationBeginResponseLike {
  readonly pendingCredential: string;
  readonly pendingCredentialVersion: number;
  readonly pendingCredentialExpiresAt: string;
}

export interface RotationConfirmationResponseLike {
  readonly credentialVersion: number;
  readonly promoted: true;
  readonly confirmedAt: string;
  readonly expiresAt: string;
}
