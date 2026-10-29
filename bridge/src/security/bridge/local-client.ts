import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BridgePointer } from '../../wire-types.js';
import type { ApplicationJson, EndpointPublic, SecureApplication } from '../protocol.js';
import { open, parseSecureEnvelope, seal } from '../crypto.js';
import { loadLocalIdentity } from './identity.js';
import { BridgeSecurityError } from './errors.js';

/** OS-local clients pin bridge metadata from the owner-only pointer, never remote discovery. */
export async function localApplication(pointer: BridgePointer, application: SecureApplication, signal?: AbortSignal,
  fetchFn: typeof fetch = fetch): Promise<ApplicationJson> {
  if (!pointer.dataDir || !pointer.ownerId || !pointer.endpoint || !pointer.bridgeId) throw new BridgeSecurityError('upgrade_required');
  const bridge: EndpointPublic = pointer.endpoint;
  if (bridge.kind !== 'bridge' || bridge.ownerId !== pointer.ownerId) throw new BridgeSecurityError('wrong_context');
  const identity = await loadLocalIdentity(pointer.dataDir, pointer.ownerId);
  const channel = `local-http:${pointer.bridgeId}`;
  const requestId = application.route.kind === 'command' || application.route.kind === 'http' || application.route.kind === 'response'
    ? application.route.requestId : randomUUID();
  const post = async (purpose: 'hello' | 'application', body: unknown, epoch: string | null, messageId: string) => {
    const createdAt = Date.now();
    const packet = await seal(identity, bridge, { type: 'ftown_encrypted', version: 1, senderId: identity.endpoint.id,
      recipientId: bridge.id, ownerId: pointer.ownerId!, bridgeId: pointer.bridgeId!, channel, purpose, messageId,
      createdAt, expiresAt: createdAt + 120000, receiverEpoch: epoch }, new TextEncoder().encode(JSON.stringify(body)));
    const response = await fetchFn(`http://127.0.0.1:${pointer.port}/api/security/envelope`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(packet), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000) });
    if (!response.ok) throw new BridgeSecurityError('bridge_offline');
    const envelope = parseSecureEnvelope(await response.json());
    if (envelope.messageId !== messageId) throw new BridgeSecurityError('wrong_context');
    const bytes = await open(identity, bridge, envelope, { ownerId: pointer.ownerId!, bridgeId: pointer.bridgeId!, channel,
      recipientId: identity.endpoint.id, purpose: purpose === 'hello' ? 'welcome' : 'application' });
    if (envelope.expiresAt <= Date.now() || envelope.createdAt > Date.now() + 30000) throw new BridgeSecurityError('expired');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  };
  const challenge = randomUUID();
  const hello = z.object({ type: z.literal('welcome'), challenge: z.literal(challenge), receiverEpoch: z.string().min(1).max(128) }).strict()
    .parse(await post('hello', { type: 'hello', challenge }, null, randomUUID()));
  const result = z.object({ type: z.literal('application'), route: z.object({ kind: z.literal('response'), requestId: z.literal(requestId) }).strict(),
    data: z.unknown().optional(), mcp: z.null() }).strict().parse(await post('application', application, hello.receiverEpoch, requestId));
  return result.data as ApplicationJson;
}
