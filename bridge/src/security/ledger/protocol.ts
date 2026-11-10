import type { EndpointPublic } from '../protocol.js';

export const LEDGER_DOMAIN = 'ftown-account-trust-v2\n';
/** Sign-in assertions are over SHA-256(SIGNIN_DOMAIN + nonce); never over raw server bytes. */
export const SIGNIN_DOMAIN = 'ftown-signin-v2\n';
/** A new authority's consent is its own assertion over SHA-256(AUTHORITY_CONSENT_DOMAIN + canonical({accountId, credentialId, publicKey})). */
export const AUTHORITY_CONSENT_DOMAIN = 'ftown-authority-consent-v2\n';

export interface LedgerAuthority {
  credentialId: string;
  /** Raw uncompressed P-256 point, 65 bytes, base64url. */
  publicKey: string;
  label: string;
  addedAt: number;
}
export interface LedgerDevice { endpoint: EndpointPublic; authPublicKey: string; label: string; approvedAt: number }
export interface LedgerBridge { bridgeId: string; endpoint: EndpointPublic; authPublicKey: string; label: string; approvedAt: number }
export interface LedgerGenesis {
  type: 'ftown_account_genesis';
  version: 2;
  rpId: string;
  origins: string[];
  /** WebAuthn user.id: 32 random bytes, base64url. */
  handle: string;
  createdAt: number;
  authority: LedgerAuthority;
}
/** Authorities are add-only: a lost or compromised passkey means a new account. `consent` is the added passkey's own assertion
 *  over authorityConsentChallenge(accountId, authority), so no account can claim a passkey that did not agree to join it. */
export type LedgerOperation =
  | { type: 'add_device'; device: LedgerDevice }
  | { type: 'revoke_device'; endpointId: string }
  | { type: 'add_bridge'; bridge: LedgerBridge }
  | { type: 'revoke_bridge'; bridgeId: string }
  | { type: 'add_authority'; authority: LedgerAuthority; consent: PasskeySignature };
export interface LedgerTransition {
  type: 'ftown_account_transition';
  version: 2;
  accountId: string;
  revision: number;
  previousHead: string;
  issuedAt: number;
  credentialId: string;
  operation: LedgerOperation;
}
/** All fields base64url; signature is DER. */
export interface PasskeySignature { authenticatorData: string; clientDataJSON: string; signature: string }
export interface Signed<T> { payload: T; signature: PasskeySignature }
export interface Ledger { genesis: Signed<LedgerGenesis>; transitions: Signed<LedgerTransition>[] }
export interface LedgerCheckpoint {
  version: 2;
  accountId: string;
  revision: number;
  head: string;
  authorities: LedgerAuthority[];
  devices: LedgerDevice[];
  bridges: LedgerBridge[];
  revokedDeviceIds: string[];
  revokedBridgeIds: string[];
}
export const LEDGER_LIMITS = {
  maxBytes: 2097152,
  maxTransitions: 1024,
  maxAuthorities: 8,
  maxDevices: 128,
  maxBridges: 128,
  maxFutureSkewMs: 30000,
  maxLabelLength: 200,
  offlineGraceMs: 86400000,
} as const;
