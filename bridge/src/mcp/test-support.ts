/** Isolated test adapters. Production gateway always uses PostgreSQL + provisioned wrapping key. */
import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { generateEndpoint, seal } from '../security/crypto.js';
import type { ApprovedBridge, EndpointIdentity, McpBridgeApproval, McpConsentSecurity, SecurityEvent } from '../security/protocol.js';
import type { McpGrantIdentity, McpIdentityStore } from './mcp-key-store.js';
import type { FtownOAuthProvider } from './oauth.js';
import { validateSecurityEvent, type SecurityOutcome } from './security-events.js';
import { BridgeSecurityService, applicationJson } from '../security/bridge/security.js';
import { LOCAL_RECOVERY_AUTHORITY } from '../security/bridge/policy.js';
import type { LocalApiServer } from '../local-api-server.js';
import type { McpRequestContext } from './secure-client.js';
export const TEST_OWNER_A = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
export const TEST_OWNER_B = '619f68a6-77c1-49f6-ae2d-c5fa169d284b';
export class TestIdentityStore implements McpIdentityStore {
  readonly records = new Map<string, McpGrantIdentity>();
  readonly bridges = new Map<string, EndpointIdentity>();
  async bridge(ownerId: string, bridgeId: string): Promise<EndpointIdentity> {
    const key = `${ownerId}:${bridgeId}`; const existing = this.bridges.get(key);
    if (existing) return existing;
    const identity = await generateEndpoint(ownerId, 'bridge'); this.bridges.set(key, identity); return identity;
  }
  async ensurePendingIdentity(requestId: string, ownerId: string, permissions: ('read' | 'control')[]): Promise<McpConsentSecurity> {
    let record = this.records.get(requestId);
    if (!record) {
      record = { ownerId, requestId, grantId: randomBytes(32).toString('base64url'), identity: await generateEndpoint(ownerId, 'mcp'),
        bridges: [], permissions, pendingExpiresAt: new Date(Date.now() + 300_000).toISOString(), activeExpiresAt: new Date(Date.now() + 2_592_000_000).toISOString(), state: 'pending' };
      this.records.set(requestId, record);
    }
    if (record.ownerId !== ownerId || record.state !== 'pending') throw new Error('test identity rejected');
    return { requestId, grantId: record.grantId, endpoint: record.identity.endpoint, expiresAt: record.pendingExpiresAt, activeExpiresAt: record.activeExpiresAt, permissions: record.permissions };
  }
  async loadByRequest(ownerId: string, requestId: string): Promise<McpGrantIdentity> {
    const record = this.records.get(requestId); if (!record || record.ownerId !== ownerId) throw new Error('test identity rejected'); return record;
  }
  async loadGrantIdentity(ownerId: string, grantId: string): Promise<McpGrantIdentity> {
    const record = [...this.records.values()].find(value => value.grantId === grantId && value.ownerId === ownerId);
    if (!record || !['approved', 'active'].includes(record.state)) throw new Error('test identity rejected'); return record;
  }
  async approve(ownerId: string, requestId: string, bridges: ApprovedBridge[]): Promise<McpGrantIdentity> {
    const record = await this.loadByRequest(ownerId, requestId); if (record.state !== 'pending') throw new Error('test identity rejected');
    record.bridges = bridges; record.state = 'approved'; return record;
  }
  async markActive(ownerId: string, requestId: string): Promise<void> { (await this.loadByRequest(ownerId, requestId)).state = 'active'; }
  async revoke(ownerId: string, requestId: string): Promise<void> { (await this.loadByRequest(ownerId, requestId)).state = 'revoked'; }
}
export class TestAuditStore {
  readonly events: SecurityEvent[] = [];
  unavailable = false;
  async admit(event: SecurityEvent): Promise<void> { if (this.unavailable) throw new Error('test storage failure'); this.events.push(validateSecurityEvent(structuredClone(event))); }
  async finish(event: SecurityEvent, outcome: SecurityOutcome): Promise<void> {
    if (this.unavailable) throw new Error('test storage failure');
    const index = this.events.findIndex(row => row.id === event.id);
    if (index < 0) throw new Error('missing test admission');
    this.events[index] = validateSecurityEvent({ ...event, ...outcome, finishedAt: new Date().toISOString() });
  }
}
export async function testRequestContext(bridgeIds: string[] = ['a']): Promise<McpRequestContext> {
  const keys = new TestIdentityStore();
  const pending = await keys.ensurePendingIdentity(randomBytes(32).toString('base64url'), TEST_OWNER_A, ['read', 'control']);
  const bridges: ApprovedBridge[] = [];
  for (const bridgeId of bridgeIds) bridges.push({ bridgeId, endpoint: (await keys.bridge(TEST_OWNER_A, bridgeId)).endpoint, permissions: ['read', 'control'] });
  const grant = await keys.approve(TEST_OWNER_A, pending.requestId, bridges);
  await keys.markActive(TEST_OWNER_A, pending.requestId);
  return { grant, action: { actionId: randomUUID(), parentActionId: null, clientId: 'fixture-client', grantId: grant.grantId, tool: 'sessions_get', operation: null } };
}
export async function attachTestSecurity(api: LocalApiServer, dataDir: string, bridgeId: string): Promise<{ security: BridgeSecurityService; context: McpRequestContext }> {
  const identity = await generateEndpoint(TEST_OWNER_A, 'bridge');
  const security = new BridgeSecurityService(identity, bridgeId, dataDir, { relayUserId: 'owner@example.test' });
  const browser = await generateEndpoint(TEST_OWNER_A, 'browser');
  const invitation = await security.policy.createInvitation(LOCAL_RECOVERY_AUTHORITY, { label: 'Test admin' });
  await security.policy.consumeInvitation({ type: 'enroll', candidate: browser.endpoint, invitationId: invitation.invitationId, invitationSecret: invitation.secret, label: 'Test admin' });
  const keys = new TestIdentityStore();
  const details = await keys.ensurePendingIdentity(randomBytes(32).toString('base64url'), TEST_OWNER_A, ['read', 'control']);
  await security.approveMcp(await security.policy.principal(browser.endpoint.id), { requestId: details.requestId, grantId: details.grantId, endpoint: details.endpoint, permissions: details.permissions, expiresAt: details.expiresAt, activeExpiresAt: details.activeExpiresAt });
  const grant = await keys.approve(TEST_OWNER_A, details.requestId, [{ bridgeId, endpoint: identity.endpoint, permissions: ['read', 'control'] }]);
  await keys.markActive(TEST_OWNER_A, details.requestId);
  const context: McpRequestContext = { grant, action: { actionId: randomUUID(), parentActionId: null, clientId: 'fixture-client', grantId: grant.grantId, tool: 'sessions_get', operation: null } };
  api.setSecurity(security, { protocolVersion: 1, ownerId: TEST_OWNER_A, bridgeId, endpoint: identity.endpoint, relayUserId: 'owner@example.test' }, async message => {
    if (message.application.route.kind !== 'command' || message.application.route.command !== 'security_activate_mcp') throw new Error('unsupported test command');
    return applicationJson({ type: 'command_response', response: { requestId: message.application.route.requestId, success: true, data: await security.activateMcp(message.principal, grant.grantId) } });
  });
  return { security, context };
}
export async function approvalAssertion(
  provider: FtownOAuthProvider, keys: TestIdentityStore, requestId: string, ownerId: string,
  machines: string[], secret: string, approve?: (security: McpConsentSecurity, machine: string) => Promise<McpBridgeApproval>,
): Promise<string> {
  const options = { subject: ownerId, issuer: provider.options.loginUrl, audience: provider.options.publicUrl, expiresIn: 60 };
  const details = await provider.consentDetails(jwt.sign({ request: requestId, purpose: 'inspect' }, secret, options));
  const approvals: McpBridgeApproval[] = [];
  for (const machine of machines) {
    if (approve) { approvals.push(await approve(details.security, machine)); continue; }
    const bridge = await keys.bridge(ownerId, machine);
    const receipt = await seal(bridge, details.security.endpoint, {
      type: 'ftown_encrypted', version: 1, senderId: bridge.endpoint.id, recipientId: details.security.endpoint.id,
      ownerId, bridgeId: machine, channel: `mcp-approval:${machine}:${requestId}`, purpose: 'mcp-approval', messageId: randomUUID(),
      createdAt: Date.now(), expiresAt: Date.now() + 120_000, receiverEpoch: null,
    }, new TextEncoder().encode(JSON.stringify({ type: 'mcp-approval', approvalId: randomUUID(), requestId, ownerId,
      grantId: details.security.grantId, candidateEndpointId: details.security.endpoint.id, bridgeId: machine, bridge: bridge.endpoint,
      permissions: details.security.permissions, expiresAt: details.security.expiresAt, activeExpiresAt: details.security.activeExpiresAt })));
    approvals.push({ bridgeId: machine, bridge: bridge.endpoint, receipt });
  }
  return jwt.sign({ request: requestId, purpose: 'approve', machines, approvals }, secret, options);
}
