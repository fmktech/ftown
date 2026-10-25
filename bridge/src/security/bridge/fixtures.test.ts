import { loadOrCreateIdentity } from './identity.js';
import { BridgeSecurityService, applicationJson } from './security.js';
import { executeSecurePacket } from './execute.js';
import type { BridgePointer } from '../../wire-types.js';
import type { ApplicationJson, EnrollmentPacket, SecureEnvelope } from '../protocol.js';

/** Real crypto, policy and local CLI protocol; an in-process socket substitute for unit tests. */
export async function secureFixture(dataDir: string, business: typeof fetch, port = 1234) {
  const ownerId = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
  const identity = await loadOrCreateIdentity(dataDir, ownerId, 'bridge');
  const client = await loadOrCreateIdentity(dataDir, ownerId, 'local-cli');
  const security = new BridgeSecurityService(identity, 'bridge', dataDir, { relayUserId: 'owner@example.test' });
  await security.policy.provisionLocalEndpoint(client.endpoint);
  const pointer: BridgePointer = { port, token: 'hook-only', bridgeId: 'bridge', dataDir, ownerId, endpoint: identity.endpoint };
  const encryptedFetch: typeof fetch = async (url, init) => {
    if (String(url) !== `http://127.0.0.1:${port}/api/security/envelope` || init?.method !== 'POST') throw new Error('Plaintext application attempted');
    const packet = JSON.parse(String(init.body)) as SecureEnvelope | EnrollmentPacket;
    const response = await executeSecurePacket(security, packet, { transport: 'local-http', channel: 'local-http:bridge', bridgeId: 'bridge', pairId: null }, async message => {
      const route = message.application.route;
      if (route.kind !== 'http') throw new Error('Unexpected unit command');
      const input = message.application.data as { body?: ApplicationJson; callerSessionId?: string };
      const result = await business(`http://127.0.0.1:${port}${route.path}`, { method: route.method,
        headers: input.callerSessionId ? { 'x-ftown-session-id': input.callerSessionId } : {},
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}) });
      const text = await result.text();
      let body: ApplicationJson;
      try { body = JSON.parse(text) as ApplicationJson; } catch { body = { error: `HTTP ${result.status}` }; }
      return applicationJson({ status: result.status, body });
    });
    return new Response(JSON.stringify(response));
  };
  return { pointer, security, fetch: encryptedFetch };
}
