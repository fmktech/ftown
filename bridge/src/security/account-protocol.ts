/**
 * FROZEN CONTRACT — immutable once fan-out has started.
 * If this contract is wrong or incomplete, STOP and report to the orchestrator;
 * do not amend locally. Local amendments cause parallel implementers to diverge.
 * No executable application logic here. Frozen after three independent reviews.
 * Behavior: docs/investigations/2026-10-25-account-trust-contract.md.
 */
import type { EndpointIdentity, EndpointPublic, SecureEnvelope } from './protocol.js';

export interface AccountSigningIdentity { publicKey: string; keyPair: CryptoKeyPair }
export interface AccountDevice {
  endpoint: EndpointPublic;
  /** Separate ECDSA P-256 raw public point; never reuse the ECDH key. */
  signingPublicKey: string;
  label: string;
  approvedAt: string;
}
export interface AccountBridge { bridgeId: string; endpoint: EndpointPublic; label: string; approvedAt: string }
export interface AccountGenesis {
  type: 'ftown_account_genesis'; version: 1; ownerId: string; rootId: string;
  createdAt: string; device: AccountDevice;
}
export type AccountOperation =
  | { type: 'add_device'; device: AccountDevice }
  | { type: 'revoke_device'; endpointId: string }
  | { type: 'add_bridge'; bridge: AccountBridge }
  | { type: 'revoke_bridge'; bridgeId: string };
export interface AccountTransition {
  type: 'ftown_account_transition'; version: 1; ownerId: string; rootId: string;
  revision: number; previousHead: string; issuedAt: string; signerId: string; operation: AccountOperation;
}
export interface SignedAccountGenesis { payload: AccountGenesis; signature: string }
export interface SignedAccountTransition { payload: AccountTransition; signature: string }
/** Full, bounded public history; null API history means no row, never permission to reset a pin. */
export interface AccountHistory { genesis: SignedAccountGenesis; transitions: SignedAccountTransition[] }
/** Verified derived state, trusted only after proof-bound bootstrap or continuity verification. */
export interface AccountCheckpoint {
  version: 1; ownerId: string; rootId: string; revision: number; head: string;
  devices: AccountDevice[]; bridges: AccountBridge[];
  revokedDeviceIds: string[]; revokedBridgeIds: string[];
}
export interface VerifiedAccountTrust { checkpoint: AccountCheckpoint; history: AccountHistory }
export interface StoredAccountTrust extends VerifiedAccountTrust { lastServerReadAt: number; lastObservedAt: number }
export interface AccountHead { rootId: string; revision: number; head: string }
export type AccountEnrollmentRequest = {
  version: 1; requestId: string; label: string; challenge: string; expiresAt: string;
} & (
  | { kind: 'browser'; candidate: EndpointPublic; signingPublicKey: string; signingProof: string }
  | { kind: 'bridge'; candidate: EndpointPublic; bridgeId: string }
);
/** Kept on candidate/approver only, transported in URL fragment; never upload/log the secret. */
export interface AccountEnrollmentLink { request: AccountEnrollmentRequest; secret: string }
/** Public relay wrapper; plaintext carries exact request + head + secret HMAC. */
export interface AccountEnrollmentBundle {
  version: 1; requestId: string; ownerId: string; approver: EndpointPublic; envelope: SecureEnvelope;
}
export interface AccountApprovalPlaintext {
  type: 'ftown_account_approval'; version: 1; request: AccountEnrollmentRequest;
  ownerId: string; head: AccountHead; approvedAt: string; secretProof: string;
}
export interface AccountReadResponse { history: AccountHistory | null }
export interface AccountAppendRequest {
  /** null only for first genesis; server rejects if account already exists. */
  expectedHead: AccountHead | null;
  record: SignedAccountGenesis | SignedAccountTransition;
}
export interface AccountEnrollmentStatus {
  request: AccountEnrollmentRequest;
  status: 'pending' | 'approved';
  /** null while pending; expired requests return an error instead. */
  bundle: AccountEnrollmentBundle | null;
}
export interface AccountEnrollmentApproval { requestId: string; bundle: AccountEnrollmentBundle }
/** Extensions to existing pairing request/response, carried by new clients only. */
export interface AccountPairingStart { enrollment: AccountEnrollmentRequest }
export interface AccountPairingLookup { enrollment: AccountEnrollmentRequest | null }
export interface AccountPairingApproval { userCode: string; accountApproval: AccountEnrollmentBundle }
export interface AccountPairingResult { accountApproval: AccountEnrollmentBundle; accountHistory: AccountHistory }
export type AccountErrorCode =
  | 'invalid_account_trust' | 'account_trust_conflict' | 'account_trust_rollback'
  | 'account_approval_required' | 'account_device_revoked' | 'account_bridge_revoked'
  | 'account_offline_expired' | 'account_last_admin' | 'account_capacity_exceeded'
  | 'account_enrollment_expired' | 'account_enrollment_invalid' | 'account_storage_unavailable';
export interface AccountTrustFailure { code: AccountErrorCode; message: string; retryable: boolean }
export interface AccountApiError { error: AccountTrustFailure }
export interface AccountApiRoutes {
  'GET /api/security/account': { response: AccountReadResponse };
  'POST /api/security/account': { body: AccountAppendRequest; response: AccountReadResponse };
  'POST /api/security/account/enrollments': { body: AccountEnrollmentRequest; response: AccountEnrollmentStatus };
  'GET /api/security/account/enrollments/:id': { response: AccountEnrollmentStatus };
  'POST /api/security/account/enrollments/:id': { body: AccountEnrollmentApproval; response: AccountEnrollmentStatus };
}

/** Named exports implemented by account-crypto.ts; methods throw AccountTrustFailure. */
export interface AccountCrypto {
  generateAccountSigningIdentity(extractable?: boolean): Promise<AccountSigningIdentity>;
  /** Pending bridge identity only; never accepted for ordinary application encryption. */
  generateAccountBridgeCandidate(bridgeId: string, extractable?: boolean): Promise<EndpointIdentity>;
  importAccountBridgeCandidate(endpoint: EndpointPublic, privateKey: JsonWebKey, extractable?: boolean): Promise<EndpointIdentity>;
  createAccountGenesis(ownerId: string, endpoint: EndpointPublic, signing: AccountSigningIdentity, label: string, now?: number): Promise<SignedAccountGenesis>;
  signAccountTransition(checkpoint: AccountCheckpoint, signerId: string, signing: AccountSigningIdentity, operation: AccountOperation, now?: number): Promise<SignedAccountTransition>;
  /** pinned=null validates internally but DOES NOT confer trust; caller must establish bootstrap authority. */
  verifyAccountHistory(history: AccountHistory, pinned: AccountCheckpoint | null, now?: number): Promise<AccountCheckpoint>;
  createAccountEnrollment(identity: EndpointIdentity, label: string, signing: AccountSigningIdentity | null, bridgeId: string | null, now?: number): Promise<AccountEnrollmentLink>;
  parseAccountEnrollmentRequest(value: unknown, now?: number): Promise<AccountEnrollmentRequest>;
  /** URL fragment account=<returned base64url JSON>; never a search parameter. */
  encodeAccountEnrollmentLink(link: AccountEnrollmentLink): string;
  parseAccountEnrollmentLink(value: unknown, now?: number): Promise<AccountEnrollmentLink>;
  accountComparisonCode(link: AccountEnrollmentLink): Promise<string>;
  sealAccountApproval(approver: EndpointIdentity, link: AccountEnrollmentLink, history: AccountHistory, now?: number): Promise<AccountEnrollmentBundle>;
  openAccountApproval(candidate: EndpointIdentity, link: AccountEnrollmentLink, bundle: AccountEnrollmentBundle, history: AccountHistory, now?: number): Promise<VerifiedAccountTrust>;
  /** Unknown is intentional only at untrusted JSON decoding boundaries. */
  parseAccountHistory(value: unknown): AccountHistory;
}

/** No new environment variables. Literal limits exported from implementation with this shape. */
export interface AccountTrustLimits {
  maxHistoryBytes: 2097152; maxTransitions: 1024; maxDevices: 128; maxBridges: 128;
  enrollmentLifetimeMs: 300000; refreshIntervalMs: 30000; offlineGraceMs: 86400000;
  maxFutureSkewMs: 30000; maxLabelLength: 200;
}
