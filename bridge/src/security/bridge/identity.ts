import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { generateEndpoint, importEndpoint } from '../crypto.js';
import type { EndpointIdentity, EndpointKind } from '../protocol.js';
import { endpointSchema } from './metadata.js';
import { AtomicSnapshot } from './snapshot.js';
import { BridgeSecurityError } from './errors.js';

const recordSchema = z.object({ version: z.literal(1), endpoint: endpointSchema, privateKey: z.object({
  kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string(), d: z.string(),
  key_ops: z.array(z.string()).optional(), ext: z.boolean().optional(),
}).strict() }).strict();

/** OS-local persisted keys; corruption/wrong owner never silently generates a replacement identity. */
export async function loadOrCreateIdentity(dataDir: string, ownerId: string, kind: 'bridge' | 'local-cli'): Promise<EndpointIdentity> {
  const generated = await generateEndpoint(ownerId, kind, true);
  const jwk = await crypto.subtle.exportKey('jwk', generated.keyPair.privateKey);
  const initial = recordSchema.parse({ version: 1, endpoint: generated.endpoint, privateKey: jwk });
  const store = new AtomicSnapshot(join(dataDir, 'security', `${kind}-identity.json`), recordSchema, () => initial);
  const saved = await store.transact(state => {
    if (state.endpoint.ownerId !== ownerId || state.endpoint.kind !== kind) throw new BridgeSecurityError('wrong_context');
    return state;
  });
  try { return await importEndpoint(saved.endpoint, saved.privateKey, false); }
  catch { throw new BridgeSecurityError('key_unavailable'); }
}

export function isLocalIdentityKind(kind: EndpointKind): kind is 'bridge' | 'local-cli' { return kind === 'bridge' || kind === 'local-cli'; }

export async function loadLocalIdentity(dataDir: string, ownerId: string): Promise<EndpointIdentity> {
  try {
    const saved = recordSchema.parse(JSON.parse(await readFile(join(dataDir, 'security', 'local-cli-identity.json'), 'utf8')));
    if (saved.endpoint.ownerId !== ownerId || saved.endpoint.kind !== 'local-cli') throw new Error('Wrong local key');
    return await importEndpoint(saved.endpoint, saved.privateKey, false);
  } catch { throw new BridgeSecurityError('key_unavailable'); }
}
