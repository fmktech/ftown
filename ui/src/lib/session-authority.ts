import type { MessageClient } from '@/lib/message-client';

/** A stable fingerprint only while the existing runtime and account policy permit read. */
export function sessionAuthority(client: MessageClient, bridgeId: string): string | null {
  const runtime = client.securityRuntime;
  if (!runtime) return null;
  const pin = runtime.bridge(bridgeId); const state = runtime.state(bridgeId);
  if (!pin || !['ready', 'offline', 'connecting'].includes(state.status) || !pin.permissions.includes('read')) return null;
  runtime.assertCanSend(bridgeId);
  const endpoint = (value: typeof pin.endpoint) => [value.version, value.id, value.ownerId, value.kind, value.publicKey];
  return JSON.stringify([endpoint(runtime.identity.endpoint), endpoint(pin.endpoint), [...pin.permissions].sort()]);
}
