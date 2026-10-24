import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { seal, open, SecurityError } from '../security/crypto.js';
import type { ApplicationJson, EnvelopeHeader, McpActionContext, SecureApplication, SecureEnvelope } from '../security/protocol.js';
import type { McpGrantIdentity } from './mcp-key-store.js';
import { FleetError, type BridgeRequest } from './fleet.js';
import { classifyHttp } from '../security/bridge/permissions.js';

export interface McpRequestContext { grant: McpGrantIdentity; action: McpActionContext; revalidate?: () => Promise<void> }
export type SecureExchange = (envelope: SecureEnvelope, deadline: number, mutating: boolean, signal?: AbortSignal) => Promise<SecureEnvelope>;
/** Both endpoint adapters use the same semantic allowlist. */
export function isMcpMutation(request: Pick<BridgeRequest, 'method' | 'path'>): boolean {
  try { return classifyHttp(request.method, request.path).mutating; }
  catch { throw new FleetError('permission_denied', 'MCP request is outside the bridge semantic allowlist'); }
}
const responseSchema = z.object({ type: z.literal('application'), route: z.object({ kind: z.literal('response'), requestId: z.string() }).strict(), data: z.unknown(), mcp: z.unknown().nullable() }).strict();
const welcomeSchema = z.object({ type: z.literal('welcome'), challenge: z.string(), receiverEpoch: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();
function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new SecurityError('invalid_envelope', 'Bridge returned an invalid encrypted response'); }
}
function applicationJson(value: unknown, depth = 0): ApplicationJson {
  if (depth > 32) throw new FleetError('invalid_request', 'MCP request nesting exceeds the encrypted transport limit');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => applicationJson(item, depth + 1));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, applicationJson(item, depth + 1)]));
  throw new FleetError('invalid_request', 'MCP request must contain JSON values');
}
/** An immutable grant-bound endpoint; no state is shared across callers or grants. */
export class SecureMcpClient {
  constructor(private context: McpRequestContext, private bridgeId: string, private channel: string, private exchange: SecureExchange) {}
  private pin() {
    const pin = this.context.grant.bridges.find(candidate => candidate.bridgeId === this.bridgeId);
    if (!pin || pin.endpoint.ownerId !== this.context.grant.ownerId || !pin.permissions.includes('read')) throw new FleetError('approval_required', 'Bridge encryption approval is required; configure machine.id as the actual bridgeId and use label for aliases');
    if (Date.parse(this.context.grant.activeExpiresAt) <= Date.now()) throw new FleetError('expired', 'Bridge encryption approval has expired');
    return pin;
  }
  private header(id: string, purpose: EnvelopeHeader['purpose'], epoch: string | null, deadline: number): EnvelopeHeader {
    return {
      type: 'ftown_encrypted', version: 1, senderId: this.context.grant.identity.endpoint.id,
      recipientId: this.pin().endpoint.id, ownerId: this.context.grant.ownerId, bridgeId: this.bridgeId,
      channel: this.channel, purpose, messageId: id, createdAt: Date.now(), expiresAt: Math.min(deadline, Date.now() + 120_000), receiverEpoch: epoch,
    };
  }
  private async send(header: EnvelopeHeader, value: unknown, mutating: boolean, deadline: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted || Date.now() >= deadline) throw new FleetError('cancelled', 'Encrypted request cancelled before dispatch');
    const packet = await seal(this.context.grant.identity, this.pin().endpoint, header, new TextEncoder().encode(JSON.stringify(value)));
    const reply = await this.exchange(packet, deadline, mutating, signal);
    if (reply.messageId !== header.messageId) throw new FleetError('bridge_error', 'Bridge response correlation failed', mutating);
    const expected = { ownerId: this.context.grant.ownerId, bridgeId: this.bridgeId, channel: this.channel, recipientId: this.context.grant.identity.endpoint.id, purpose: header.purpose === 'hello' ? 'welcome' as const : 'application' as const };
    try { return json(await open(this.context.grant.identity, this.pin().endpoint, reply, expected)); }
    catch { throw new FleetError('authentication_failed', 'Bridge encrypted response authentication failed', mutating); }
  }
  async request(request: BridgeRequest, signal?: AbortSignal): Promise<unknown> {
    await this.context.revalidate?.();
    const deadline = Date.now() + request.timeoutMs;
    const pin = this.pin();
    const mutating = isMcpMutation(request);
    if (mutating && (!pin.permissions.includes('control') || !this.context.grant.permissions.includes('control'))) throw new FleetError('permission_denied', 'This MCP grant cannot control the bridge');
    const challenge = randomBytes(32).toString('base64url');
    const hello = await this.send(this.header(randomUUID(), 'hello', null, deadline), { type: 'hello', challenge }, false, deadline, signal);
    const welcome = welcomeSchema.safeParse(hello);
    if (!welcome.success || welcome.data.challenge !== challenge) throw new FleetError('authentication_failed', 'Bridge encryption handshake failed');
    const activationId = randomUUID();
    const activation: SecureApplication = {
      type: 'application', route: { kind: 'command', command: 'security_activate_mcp', requestId: activationId, sessionId: null },
      data: { type: 'security_activate_mcp', requestId: activationId, payload: { bridgeId: this.bridgeId, grantId: this.context.grant.grantId } }, mcp: this.context.action,
    };
    const activated = responseSchema.safeParse(await this.send(this.header(activationId, 'application', welcome.data.receiverEpoch, deadline), activation, false, deadline, signal));
    if (!activated.success || activated.data.route.requestId !== activationId) throw new FleetError('bridge_error', 'Bridge activation response is invalid');
    const activationResponse = z.object({ type: z.literal('command_response'), response: z.object({ requestId: z.literal(activationId), success: z.boolean(), error: z.string().optional(), data: z.unknown().optional() }) }).safeParse(activated.data.data);
    if (!activationResponse.success || !activationResponse.data.response.success) throw new FleetError('approval_required', 'Bridge MCP approval could not be activated');
    await this.context.revalidate?.();
    const requestId = randomUUID();
    const application: SecureApplication = {
      type: 'application', route: { kind: 'http', requestId, method: request.method, path: request.path },
      data: applicationJson({ timeoutMs: Math.max(1000, deadline - Date.now()), ...(request.body === undefined ? {} : { body: request.body }) }), mcp: this.context.action,
    };
    const result = responseSchema.safeParse(await this.send(this.header(requestId, 'application', welcome.data.receiverEpoch, deadline), application, mutating, deadline, signal));
    if (!result.success || result.data.route.requestId !== requestId) throw new FleetError('bridge_error', 'Bridge response is invalid', mutating);
    const http = z.object({ status: z.number().int().min(100).max(599), body: z.unknown() }).strict().safeParse(result.data.data);
    if (!http.success) throw new FleetError('bridge_error', 'Bridge HTTP response is invalid', mutating);
    if (http.data.status < 200 || http.data.status >= 300) {
      const error = z.object({ code: z.string().optional(), outcomeUnknown: z.boolean().optional() }).passthrough().safeParse(http.data.body);
      const allowed = ['unknown_session', 'invalid_cursor', 'unknown_attention', 'permission_denied', 'endpoint_revoked', 'upgrade_required', 'audit_unavailable', 'outcome_unknown'];
      const code = error.success && error.data.code && allowed.includes(error.data.code) ? error.data.code : 'bridge_error';
      throw new FleetError(code, 'Bridge rejected the encrypted request', mutating && (http.data.status >= 500 || (error.success && error.data.outcomeUnknown === true)), http.data.status);
    }
    return http.data.body;
  }
}
