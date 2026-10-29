import { createHash } from 'node:crypto';
import { getDb } from '@/lib/db';
import { importPublicKey } from '@security/crypto';
import type { EndpointDirectory, EndpointDirectoryEntry, SecurityPage, SecurityPageQuery } from '@security/protocol';
import { listSecurityPage } from '../../../bridge/src/mcp/security-events';

type Query = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
export class SecurityStoreError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
const fail = (): never => { throw new SecurityStoreError('invalid_endpoint', 400); };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
export async function parseDirectoryEntry(value: unknown): Promise<EndpointDirectoryEntry> {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'bridgeId,endpoint,label,protocolVersion' || value.protocolVersion !== 1
    || typeof value.label !== 'string' || value.label.length > 200 || /[\x00-\x1f\x7f]/.test(value.label)
    || (value.bridgeId !== null && !token(value.bridgeId)) || !object(value.endpoint)) return fail();
  const endpoint = value.endpoint;
  if (Object.keys(endpoint).sort().join(',') !== 'id,kind,ownerId,publicKey,version' || endpoint.version !== 1
    || typeof endpoint.ownerId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(endpoint.ownerId)
    || (endpoint.kind !== 'browser' && endpoint.kind !== 'bridge') || typeof endpoint.id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(endpoint.id)
    || typeof endpoint.publicKey !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(endpoint.publicKey)) return fail();
  try { await importPublicKey(endpoint.publicKey); } catch { return fail(); }
  if (createHash('sha256').update(Buffer.from(endpoint.publicKey, 'base64url')).digest('base64url') !== endpoint.id) return fail();
  if ((endpoint.kind === 'browser') !== (value.bridgeId === null)) return fail();
  return { protocolVersion: 1, bridgeId: value.bridgeId, label: value.label, endpoint: { version: 1, id: endpoint.id, ownerId: endpoint.ownerId, kind: endpoint.kind, publicKey: endpoint.publicKey } };
}
export async function boundedSecurityJson(request: Request, maxBytes = 524_288): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new SecurityStoreError('invalid_request', 400);
  if (Number(request.headers.get('content-length')) > maxBytes) throw new SecurityStoreError('invalid_request', 413);
  if (!request.body) throw new SecurityStoreError('invalid_request', 400);
  const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new SecurityStoreError('invalid_request', 413); } chunks.push(chunk.value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { if (error instanceof SecurityStoreError) throw error; throw new SecurityStoreError('invalid_request', 400); }
  finally { reader.releaseLock(); }
}
export class SecurityStore {
  constructor(private query: Query = (text, params) => getDb().query(text, params)) {}
  async register(ownerId: string, entry: EndpointDirectoryEntry): Promise<void> {
    if (entry.endpoint.ownerId !== ownerId) throw new SecurityStoreError('forbidden', 403);
    const result = await this.query(`INSERT INTO security_endpoint_directory(owner_id,endpoint_id,bridge_id,entry)
      SELECT $1,$2,$3,$4::jsonb WHERE EXISTS(SELECT 1 FROM security_endpoint_directory WHERE owner_id=$1 AND endpoint_id=$2)
      OR (SELECT COUNT(*) FROM security_endpoint_directory WHERE owner_id=$1)<1000
      ON CONFLICT(owner_id,endpoint_id) DO UPDATE SET entry=EXCLUDED.entry,bridge_id=EXCLUDED.bridge_id,updated_at=NOW()
      RETURNING endpoint_id`, [ownerId, entry.endpoint.id, entry.bridgeId, JSON.stringify(entry)]);
    if (!result.length) throw new SecurityStoreError('capacity_exceeded', 409);
  }
  async directory(ownerId: string): Promise<EndpointDirectory> {
    const rows = await this.query('SELECT entry FROM security_endpoint_directory WHERE owner_id=$1 ORDER BY endpoint_id LIMIT 1001', [ownerId]);
    if (rows.length > 1000) throw new SecurityStoreError('capacity_exceeded', 409);
    const endpoints = await Promise.all(rows.map(row => parseDirectoryEntry(row.entry)));
    if (endpoints.some(entry => entry.endpoint.ownerId !== ownerId)) throw new SecurityStoreError('storage_unavailable', 503);
    return { ownerId, endpoints };
  }
  activity(ownerId: string, query?: SecurityPageQuery): Promise<SecurityPage> { return listSecurityPage(this.query, ownerId, query); }
}
