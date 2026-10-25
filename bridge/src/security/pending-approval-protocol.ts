/**
 * FROZEN CONTRACT — immutable once fan-out has started.
 * If this contract is wrong or incomplete, STOP and report to the orchestrator;
 * do not amend locally. Local amendments cause parallel implementers to diverge.
 * Behavior: docs/investigations/2026-10-25-pending-approval-contract.md.
 * Types only; browser, server and bridge import the neutral implementation.
 */
import type {
  AccountEnrollmentRequest, AccountEnrollmentLink, AccountEnrollmentBundle,
  AccountHead, AccountHistory, AccountSigningIdentity, SignedAccountTransition,
  VerifiedAccountTrust, AccountTrustFailure,
} from './account-protocol.js';
import type { EndpointIdentity, EndpointPublic, SecureEnvelope } from './protocol.js';

export interface PendingOfferCore {
  type: 'ftown_pending_offer'; version: 1;
  suite: 'hpke-p256-sha256-commit-v1';
  request: AccountEnrollmentRequest;
  ownerId: string;
  /** Immutable account head BEFORE any approval addition. */
  anchor: AccountHead;
  approver: EndpointPublic;
  signingPublicKey: string;
  /** Random 256-bit identifier, fixed before the candidate secret exists. */
  offerId: string;
  expiresAt: string;
}
export interface PendingOfferPayload extends PendingOfferCore {
  /** SHA-256 commitment to core plus the hidden 32-byte reviewer contribution. */
  commitment: string;
}
export interface PendingOffer { payload: PendingOfferPayload; signature: string }
export interface PendingHello {
  version: 1; requestId: string; offerHash: string;
  /** HPKE Auth; secret never appears outside this ciphertext on the wire. */
  envelope: SecureEnvelope;
}
export interface PendingReveal { offerHash: string; contribution: string }
export interface PendingCandidateConfirmation { offerHash: string; mac: string }
export interface PendingResult {
  version: 1; offerHash: string; head: AccountHead;
  bundle: AccountEnrollmentBundle;
  /** Separate approver-direction MAC binds head and exact bundle digest. */
  mac: string;
}
/** Local-only; nonextractable HKDF key, persisted by structured clone in browsers. */
export interface PendingSecret { key: CryptoKey }
export interface PendingOfferLocal { offer: PendingOffer; contribution: string }
export interface PendingHelloLocal { hello: PendingHello; secret: PendingSecret }
/** Persist atomically after first valid hello open, BEFORE revealing contribution. */
export interface PendingReviewerOpened {
  offerHash: string; helloHash: string; secret: PendingSecret; openedAt: number;
}
export type PendingOpenResult =
  | { status: 'verified'; trust: VerifiedAccountTrust }
  /** Only after result MAC/bindings/current history validate; request is still live. */
  | { status: 'awaiting-delivery-renewal' };

export type PendingTerminalStatus = 'rejected' | 'cancelled' | 'expired' | 'conflict';
export type PendingApprovalState = {
  request: AccountEnrollmentRequest;
  /** Monotonic server CAS revision, not an authority proof. */
  revision: number;
} & (
  | { status: 'pending' }
  | { status: 'offered'; offer: PendingOffer }
  | { status: 'submitted'; offer: PendingOffer; hello: PendingHello }
  | { status: 'comparing'; offer: PendingOffer; hello: PendingHello; reveal: PendingReveal }
  | { status: 'confirmed'; offer: PendingOffer; hello: PendingHello; reveal: PendingReveal; confirmation: PendingCandidateConfirmation }
  | { status: 'approved'; offer: PendingOffer; hello: PendingHello; reveal: PendingReveal; confirmation: PendingCandidateConfirmation; result: PendingResult }
  | { status: PendingTerminalStatus }
);
export interface PendingApprovalSummary {
  request: AccountEnrollmentRequest;
  status: PendingApprovalState['status']; revision: number;
}
export interface PendingApprovalInbox { requests: PendingApprovalSummary[] }
export interface PendingBrowserCreate {
  request: Extract<AccountEnrollmentRequest, { kind: 'browser' }>;
  /** Random 256-bit per-request bearer, server stores SHA-256 only. */
  candidateToken: string;
}
export type PendingCandidateAction =
  | { type: 'read' }
  | { type: 'hello'; expectedRevision: number; hello: PendingHello }
  | { type: 'confirm'; expectedRevision: number; confirmation: PendingCandidateConfirmation }
  | { type: 'cancel'; expectedRevision: number };
export interface PendingCandidateCommand { candidateToken: string; action: PendingCandidateAction }
export type PendingReviewerAction =
  | { type: 'review'; offer: PendingOffer }
  | { type: 'reveal'; offerHash: string; helloHash: string; reveal: PendingReveal }
  | { type: 'reject' }
  | { type: 'finish'; offerHash: string; transition: SignedAccountTransition | null; result: PendingResult }
  | { type: 'renew'; offerHash: string; result: PendingResult };
export interface PendingReviewerPayload {
  type: 'ftown_pending_action'; version: 1;
  requestId: string; ownerId: string; signerId: string;
  head: AccountHead; expectedRevision: number; issuedAt: string;
  action: PendingReviewerAction;
}
export interface PendingReviewerCommand { payload: PendingReviewerPayload; signature: string }
export interface PendingPairingStart {
  /** Explicit mode; absence preserves the existing fragment/auth-only protocol. */
  approvalMethod: 'pending-v1';
  /** Untrusted normalized email routing hint, never authority. */
  accountHint: string;
  /** Persist before start; exact retries recover the same server-generated deviceCode. */
  candidateToken: string;
  enrollment: Extract<AccountEnrollmentRequest, { kind: 'bridge' }>;
}
/** Extends existing pair/start body fields bridgeId, hostname and platform. */
export interface PendingPairingStartResponse {
  deviceCode: string; userCode: string; verificationUri: string;
  intervalMs: number; expiresInMs: number;
}
/** Discovery port only; local authorization nonce never leaves the bridge. */
export interface PendingPairingPollRequest { deviceCode: string; localPort: number }
export interface PendingPairingApproved {
  status: 'approved'; ownerId: string; token: string; refreshToken: string;
  centrifugoUrl: string; userId: string; pendingApproval: PendingResult;
}
export type PendingPairingPollResponse = PendingPairingApproved
  | { status: 'pending' | 'slow_down' | 'denied' | 'expired' | 'consumed' | 'unknown' };
/** Local only: runPairing's pending branch verifies fresh configured-origin account GET. */
export interface PendingPairingVerified extends PendingPairingApproved {
  approvalMethod: 'pending-v1'; verifiedAccountTrust: VerifiedAccountTrust;
  lastServerReadAt: number;
}
export type PendingBridgeStatus = {
  version: 1; requestId: string; processNonce: string; expiresAt: string;
} & (
  | { phase: 'waiting'; offerHash: string | null; comparisonCode: null }
  | { phase: 'comparing' | 'confirming'; offerHash: string; comparisonCode: string }
  | { phase: 'approved' | PendingTerminalStatus; offerHash: string | null; comparisonCode: null }
);
export type PendingBridgeDecision = {
  version: 1; requestId: string; processNonce: string; expiresAt: string;
} & (
  | { decision: 'confirm'; offerHash: string; comparisonCode: string }
  | { decision: 'reject'; offerHash: string | null }
);
export interface PendingBridgePairingContext {
  identity: EndpointIdentity; request: Extract<AccountEnrollmentRequest, { kind: 'bridge' }>; candidateToken: string;
  signal: AbortSignal;
  /** Durable exact CAS before candidate secret generation; identical replay only. */
  pinOffer(offer: PendingOffer): Promise<void>;
  /** Durable exact CAS before any hello transmission; no replacement ciphertext. */
  pinHello(hello: PendingHello): Promise<void>;
  /** confirming must durably store the positive local confirmed offer hash before MAC. */
  onLocalStatus(status: PendingBridgeStatus): Promise<void>;
  waitForLocalDecision(status: PendingBridgeStatus, signal: AbortSignal): Promise<PendingBridgeDecision>;
}
export interface PendingApprovalApiRoutes {
  'GET /api/security/approvals': { response: PendingApprovalInbox };
  'POST /api/security/approvals': { body: PendingBrowserCreate; response: PendingApprovalState };
  'GET /api/security/approvals/:id': { response: PendingApprovalState };
  'POST /api/security/approvals/:id': { body: PendingReviewerCommand; response: PendingApprovalState };
  'POST /api/security/approvals/:id/candidate': { body: PendingCandidateCommand; response: PendingApprovalState };
}

/** Named exports of pending-approval-crypto.ts; existing sanitized AccountTrustFailure errors. */
export interface PendingApprovalCrypto {
  /** ASCII whitespace trim/case-fold; preserve non-ASCII exactly; strict email bounds. */
  normalizePendingAccountHint(value: unknown): string;
  createPendingOffer(request: AccountEnrollmentRequest, approver: EndpointIdentity, signing: AccountSigningIdentity, history: AccountHistory, now?: number): Promise<PendingOfferLocal>;
  /** Valid signature is self-consistency only until the user confirms the SAS. */
  parsePendingOffer(value: unknown, request: AccountEnrollmentRequest, now?: number): Promise<PendingOffer>;
  pendingOfferHash(offer: PendingOffer): Promise<string>;
  pendingHelloHash(hello: PendingHello): Promise<string>;
  /** Caller MUST durably pin this offer first, persist result before transmission. */
  createPendingHello(candidate: EndpointIdentity, offer: PendingOffer, now?: number): Promise<PendingHelloLocal>;
  /** Caller MUST durably pin one ciphertext before open/reveal; failure burns request. */
  openPendingHello(approver: EndpointIdentity, local: PendingOfferLocal, hello: PendingHello, now?: number): Promise<PendingSecret>;
  pendingComparisonCode(offer: PendingOffer, secret: PendingSecret, reveal: PendingReveal): Promise<string>;
  /** confirmedOfferHash comes from positive LOCAL user confirmation, never relay state. */
  createPendingConfirmation(offer: PendingOffer, secret: PendingSecret, reveal: PendingReveal, confirmedOfferHash: string): Promise<PendingCandidateConfirmation>;
  verifyPendingConfirmation(offer: PendingOffer, secret: PendingSecret, reveal: PendingReveal, confirmation: PendingCandidateConfirmation): Promise<void>;
  pendingBootstrapLink(offer: PendingOffer, secret: PendingSecret, reveal: PendingReveal): Promise<AccountEnrollmentLink>;
  createPendingResult(approver: EndpointIdentity, local: PendingOfferLocal, secret: PendingSecret, confirmation: PendingCandidateConfirmation, confirmedOfferHash: string, approvalHistory: AccountHistory, now?: number): Promise<PendingResult>;
  openPendingResult(candidate: EndpointIdentity, offer: PendingOffer, secret: PendingSecret, reveal: PendingReveal, confirmedOfferHash: string, result: PendingResult, history: AccountHistory, now?: number): Promise<PendingOpenResult>;
  signPendingAction(payload: PendingReviewerPayload, signing: AccountSigningIdentity): Promise<PendingReviewerCommand>;
  verifyPendingAction(value: unknown, request: AccountEnrollmentRequest, history: AccountHistory, now?: number): Promise<PendingReviewerCommand>;
  /** Unknown is intentional only at strict untrusted JSON boundaries. */
  parsePendingState(value: unknown, now?: number): Promise<PendingApprovalState>;
}
/** No new environment variables or dependencies. All limits centralized. */
export interface PendingApprovalLimits {
  lifetimeMs: 300000; pollIntervalMs: 2000; requestTimeoutMs: 15000;
  maxPendingPerTarget: 128; maxPendingGlobal: 4096; maxWireBytes: 65536;
  maxInboxBytes: 524288;
  maxFutureSkewMs: 30000;
}
export type PendingApprovalFailure = AccountTrustFailure;
