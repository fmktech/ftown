/**
 * FROZEN CONTRACT — immutable once fan-out has started.
 * If this contract is wrong or incomplete, STOP and report to the orchestrator;
 * do not amend locally. Local amendments cause parallel implementers to diverge.
 * Behavior/security rules: docs/investigations/2026-10-24-e2ee-contract.md.
 * Types only. All implementation modules depend on this file, never vice versa.
 */

import type { AccountErrorCode, AccountHead } from './account-protocol.js';

/** Existing application JSON is intentionally open; domain handlers validate it. */
export type ApplicationJson = null | boolean | number | string | ApplicationJson[] | { [key: string]: ApplicationJson };
export type EndpointKind = 'bridge' | 'browser' | 'mcp' | 'local-cli';
export type EndpointPermission = 'read' | 'control' | 'admin';
export type EnvelopePurpose = 'application' | 'hello' | 'welcome' | 'enroll' | 'enrolled' | 'mcp-approval';
export type SecureTransport = 'cloud' | 'local-http' | 'local-events' | 'loopback-ws' | 'webrtc';

export interface EndpointPublic {
  version: 1;
  /** Canonical base64url SHA-256 of the raw 65-byte P-256 public point. */
  id: string;
  /** Immutable account UUID, or solo:<bridgeId>; never an email alias. */
  ownerId: string;
  kind: EndpointKind;
  /** Canonical unpadded base64url uncompressed P-256 point. */
  publicKey: string;
}

export interface EndpointIdentity {
  endpoint: EndpointPublic;
  /** Full pair is required by HPKE Auth when privateKey is non-extractable. */
  keyPair: CryptoKeyPair;
}

export interface EnvelopeHeader {
  type: 'ftown_encrypted';
  version: 1;
  senderId: string;
  recipientId: string;
  ownerId: string;
  bridgeId: string;
  /** Actual transport-derived channel; included in authenticated data. */
  channel: string;
  purpose: EnvelopePurpose;
  messageId: string;
  createdAt: number;
  expiresAt: number;
  /** Null only for bootstrap/non-executable endpoint publications. */
  receiverEpoch: string | null;
}

export interface SecureEnvelope extends EnvelopeHeader {
  enc: string;
  ciphertext: string;
}

export interface SecurePublication {
  type: 'ftown_encrypted_batch';
  version: 1;
  envelopes: SecureEnvelope[];
}

export interface EnrollmentPacket {
  type: 'ftown_enrollment';
  version: 1;
  /** Untrusted until the encrypted invitation is atomically redeemed. */
  candidate: EndpointPublic;
  envelope: SecureEnvelope;
}

export type SecureWirePacket = SecureEnvelope | SecurePublication | EnrollmentPacket;

export interface OpenContext {
  ownerId: string;
  bridgeId: string;
  channel: string;
  recipientId: string;
  purpose: EnvelopePurpose;
}

/** Implemented/exported as named functions by ./crypto.ts. */
export interface SecureCrypto {
  generateEndpoint(ownerId: string, kind: EndpointKind, extractable?: boolean): Promise<EndpointIdentity>;
  importEndpoint(endpoint: EndpointPublic, privateKey: JsonWebKey, extractable?: boolean): Promise<EndpointIdentity>;
  exportPublicKey(key: CryptoKey): Promise<string>;
  importPublicKey(raw: string): Promise<CryptoKey>;
  seal(identity: EndpointIdentity, recipient: EndpointPublic, header: EnvelopeHeader, plaintext: Uint8Array): Promise<SecureEnvelope>;
  open(identity: EndpointIdentity, sender: EndpointPublic, envelope: SecureEnvelope, expected: OpenContext): Promise<Uint8Array>;
  /** Untrusted wire input is intentionally unknown at this decoding boundary. */
  parseSecureEnvelope(value: unknown): SecureEnvelope;
  parseSecurePublication(value: unknown): SecurePublication;
}

export type SecurityErrorCode =
  | AccountErrorCode
  | 'security_setup_required' | 'secure_context_required' | 'storage_unavailable'
  | 'upgrade_required' | 'approval_required' | 'key_changed' | 'endpoint_revoked'
  | 'invalid_envelope' | 'authentication_failed' | 'wrong_context'
  | 'expired' | 'replayed' | 'epoch_changed' | 'permission_denied'
  | 'invitation_invalid' | 'invitation_expired' | 'invitation_consumed'
  | 'capacity_exceeded' | 'audit_unavailable' | 'outcome_unknown'
  | 'bridge_offline' | 'invalid_cursor' | 'key_unavailable';

/** Implementations throw sanitized errors with these fields; never raw secrets. */
export interface SecurityFailure {
  code: SecurityErrorCode;
  message: string;
  retryable: boolean;
}

export interface ApprovedEndpoint {
  endpoint: EndpointPublic;
  label: string;
  permissions: EndpointPermission[];
  approvedAt: string;
  /** Null for browser/local CLI; immutable OAuth grant for MCP. */
  grantId: string | null;
  /** Null means no time expiry; revocation remains enforced. */
  expiresAt: string | null;
  /** Absent means existing per-bridge grant; account grants follow signed roster. */
  source?: 'local' | 'account';
}

export interface ApprovedBridge {
  bridgeId: string;
  endpoint: EndpointPublic;
  permissions: EndpointPermission[];
}

export interface BridgeInvitation {
  version: 1;
  invitationId: string;
  ownerId: string;
  bridgeId: string;
  bridge: EndpointPublic;
  /** Secret is only shown locally/in fragment and sent inside ciphertext. */
  secret: string;
  expiresAt: string;
  /** Broker WebSocket URL is routing metadata, not a trust anchor; never the web/API origin. */
  relayUrl: string | null;
  /** Optional local discovery origin; never grants authorization. */
  localOrigin: string | null;
}

export interface HelloMessage { type: 'hello'; challenge: string }
export interface WelcomeMessage { type: 'welcome'; challenge: string; receiverEpoch: string }
export interface EnrollmentMessage {
  type: 'enroll';
  candidate: EndpointPublic;
  invitationId: string;
  invitationSecret: string;
  label: string;
}
export interface EnrollmentReceipt {
  type: 'enrolled';
  invitationId: string;
  approved: ApprovedEndpoint;
  receiverEpoch: string;
}

export interface McpActionContext {
  actionId: string;
  parentActionId: string | null;
  clientId: string;
  grantId: string;
  tool: string;
  operation: string | null;
}

/** Constructed only after cryptographic and locally stored-policy validation. */
export interface VerifiedPrincipal {
  endpoint: EndpointPublic;
  bridgeId: string;
  permissions: readonly EndpointPermission[];
  policyGeneration: number;
  grantId: string | null;
}

export type ApplicationRoute =
  | { kind: 'command'; requestId: string; command: string; sessionId: string | null }
  | { kind: 'http'; requestId: string; method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string }
  | { kind: 'terminal'; sessionId: string; frameType: string; pairId: string | null }
  | { kind: 'response'; requestId: string }
  | { kind: 'publication' };

export interface SecureApplication {
  type: 'application';
  route: ApplicationRoute;
  /** Existing domain JSON; independently schema-validated before dispatch. */
  data: ApplicationJson;
  /** Only approved MCP endpoint kind may supply this non-authorizing context. */
  mcp: McpActionContext | null;
}

export interface InboundTransportContext {
  transport: SecureTransport;
  channel: string;
  bridgeId: string;
  /** Null when not a direct peer; bound to endpoint during authenticated hello. */
  pairId: string | null;
}

export interface VerifiedApplication {
  principal: VerifiedPrincipal;
  envelope: SecureEnvelope;
  application: SecureApplication;
}

export interface McpApproval {
  requestId: string;
  grantId: string;
  endpoint: EndpointPublic;
  permissions: ('read' | 'control')[];
  /** Pending approval expires unless activated by the approved MCP identity. */
  expiresAt: string;
  /** Fixed maximum active lifetime approved by browser, at most 30 days. */
  activeExpiresAt: string;
}

export interface McpApprovalReceipt {
  type: 'mcp-approval';
  approvalId: string;
  requestId: string;
  ownerId: string;
  grantId: string;
  candidateEndpointId: string;
  bridgeId: string;
  bridge: EndpointPublic;
  permissions: ('read' | 'control')[];
  expiresAt: string;
  activeExpiresAt: string;
}

export interface McpBridgeApproval {
  bridgeId: string;
  bridge: EndpointPublic;
  receipt: SecureEnvelope;
}

export interface SecurityPageQuery {
  /** Absent means newest page; cursor is opaque, versioned and owner-bound. */
  cursor?: string;
  bridgeId?: string;
  limit?: number;
}

export type SecurityEventStatus = 'started' | 'succeeded' | 'rejected' | 'failed' | 'unknown';
export interface SecurityEvent {
  version: 1;
  id: string;
  actionId: string;
  parentActionId: string | null;
  ownerId: string;
  source: 'gateway' | 'bridge';
  bridgeId: string | null;
  clientId: string | null;
  grantId: string | null;
  endpointId: string | null;
  tool: string;
  operation: string | null;
  sessionId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: SecurityEventStatus;
  errorCode: string | null;
  mutating: boolean;
}

export interface SecurityPage {
  events: SecurityEvent[];
  nextCursor: string | null;
  retentionDays: 30;
  maxEvents: 10000;
  oldestAvailableAt: string | null;
  truncated: boolean;
  reset: boolean;
}

/** Commands use existing requestId/bridgeId command-RPC envelope. */
export type SecurityCommand =
  | { type: 'security_devices'; bridgeId: string }
  | { type: 'security_invite'; bridgeId: string; label: string }
  | { type: 'security_revoke'; bridgeId: string; endpointId: string }
  | { type: 'security_approve_mcp'; bridgeId: string; approval: McpApproval }
  | { type: 'security_activate_mcp'; bridgeId: string; grantId: string }
  | { type: 'security_activity'; bridgeId: string; page: SecurityPageQuery }
  | { type: 'security_account_adopt'; bridgeId: string; head: AccountHead };

export interface SecurityCommandResults {
  security_account_adopt: { head: AccountHead };
  security_devices: { devices: ApprovedEndpoint[] };
  security_invite: BridgeInvitation;
  security_revoke: { endpointId: string; revoked: true };
  security_approve_mcp: McpBridgeApproval;
  security_activate_mcp: { grantId: string; expiresAt: string };
  security_activity: SecurityPage;
}

export type BridgeSecurityStatus = 'unpaired' | 'connecting' | 'ready' | 'offline' | 'revoked' | 'key_changed' | 'upgrade_required';
export interface BridgeSecurityState {
  bridgeId: string;
  status: BridgeSecurityStatus;
  endpoint: EndpointPublic | null;
}

export interface EndpointDirectoryEntry {
  endpoint: EndpointPublic;
  bridgeId: string | null;
  label: string;
  protocolVersion: 1;
}
export interface EndpointDirectory {
  ownerId: string;
  endpoints: EndpointDirectoryEntry[];
}

export interface McpConsentSecurity {
  requestId: string;
  grantId: string;
  endpoint: EndpointPublic;
  expiresAt: string;
  activeExpiresAt: string;
  permissions: ('read' | 'control')[];
}

export interface BridgeSecurityInfo {
  protocolVersion: 1;
  ownerId: string;
  bridgeId: string;
  endpoint: EndpointPublic;
  /** Existing channel-routing subject; explicitly not cryptographic owner ID. */
  relayUserId: string;
}

export interface LocalEventPage {
  events: { channel: string; data: ApplicationJson; cursor: number }[];
  cursor: number;
  reset: boolean;
}

/** Never constructed from request JSON or sent over the network. */
export interface LocalRecoveryAuthority { source: 'os-local-recovery' }

export interface InvitationOptions { label: string }

/** Implemented by security/bridge/security.ts; crypto and policy stay separate. */
export interface BridgeSecurity {
  readonly endpoint: EndpointPublic;
  readonly receiverEpoch: string;
  handleHandshake(packet: SecureEnvelope | EnrollmentPacket, route: InboundTransportContext): Promise<SecureEnvelope>;
  acceptApplication(packet: SecureEnvelope, route: InboundTransportContext): Promise<VerifiedApplication>;
  /** Re-check immediately before queued dispatch/egress; throws when revoked. */
  revalidate(principal: VerifiedPrincipal): Promise<void>;
  sealTo(recipientId: string, application: SecureApplication, route: InboundTransportContext): Promise<SecureEnvelope>;
  sealPublication(channel: string, application: SecureApplication): Promise<(SecureEnvelope | SecurePublication)[]>;
  createInvitation(actor: VerifiedPrincipal | LocalRecoveryAuthority, options: InvitationOptions): Promise<BridgeInvitation>;
  listDevices(actor: VerifiedPrincipal): Promise<ApprovedEndpoint[]>;
  approveMcp(actor: VerifiedPrincipal, approval: McpApproval): Promise<McpBridgeApproval>;
  activateMcp(actor: VerifiedPrincipal, grantId: string): Promise<{ grantId: string; expiresAt: string }>;
  revokeEndpoint(actor: VerifiedPrincipal, endpointId: string): Promise<void>;
  adoptAccount(actor: VerifiedPrincipal, head: AccountHead): Promise<AccountHead>;
  onRevoked(listener: (endpointId: string) => void): () => void;
  close(): Promise<void>;
}

/** One provisioned secret; config parsing belongs only to gateway bootstrap. */
export interface McpKeyEncryptionConfig {
  keyId: string;
  key: Uint8Array;
}

export interface SecurityLimits {
  maxEnvelopeBytes: 450000;
  maxApplicationAgeMs: 120000;
  maxFutureSkewMs: 30000;
  invitationLifetimeMs: 300000;
  maxConsentBridges: 64;
  maxConsentBodyBytes: 524288;
  maxActiveMcpGrantMs: 2592000000;
  retentionDays: 30;
  maxAuditEvents: 10000;
  defaultPageSize: 50;
  maxPageSize: 100;
}
