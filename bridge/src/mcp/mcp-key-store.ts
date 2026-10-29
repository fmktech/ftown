import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { generateEndpoint, importEndpoint, importPublicKey, SecurityError } from '../security/crypto.js';
import type { ApprovedBridge, EndpointPublic, McpConsentSecurity, McpKeyEncryptionConfig } from '../security/protocol.js';

const MAX_RECORD_BYTES = 65_536;
const MAX_ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;
const endpointSchema = z.object({ version: z.literal(1), id: z.string().regex(/^[A-Za-z0-9_-]{43}$/), ownerId: z.string().guid(), kind: z.enum(['bridge', 'browser', 'mcp', 'local-cli']), publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/) }).strict();
const pinSchema = z.object({ bridgeId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), endpoint: endpointSchema, permissions: z.array(z.enum(['read', 'control'])).min(1).max(2) }).strict();
const keySchema = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/), d: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const storedSchema = z.object({
  version: z.literal(1), ownerId: z.string().guid(), requestId: z.string().regex(/^[A-Za-z0-9_-]{43}$/), grantId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  endpoint: endpointSchema, privateKey: keySchema, bridges: z.array(pinSchema).max(64),
  permissions: z.array(z.enum(['read', 'control'])).min(1).max(2),
  pendingExpiresAt: z.string().datetime(), activeExpiresAt: z.string().datetime(), state: z.enum(['pending', 'approved', 'active', 'revoked']),
}).strict();
type StoredIdentity = z.infer<typeof storedSchema>;
export interface McpGrantIdentity {
  ownerId: string;
  requestId: string;
  grantId: string;
  identity: Awaited<ReturnType<typeof importEndpoint>>;
  bridges: ApprovedBridge[];
  permissions: ('read' | 'control')[];
  pendingExpiresAt: string;
  activeExpiresAt: string;
  state: 'pending' | 'approved' | 'active' | 'revoked';
}
export interface McpIdentityStore {
  ensurePendingIdentity(requestId: string, ownerId: string, permissions: ('read' | 'control')[]): Promise<McpConsentSecurity>;
  loadByRequest(ownerId: string, requestId: string): Promise<McpGrantIdentity>;
  loadGrantIdentity(ownerId: string, grantId: string): Promise<McpGrantIdentity>;
  approve(ownerId: string, requestId: string, bridges: ApprovedBridge[]): Promise<McpGrantIdentity>;
  markActive(ownerId: string, requestId: string): Promise<void>;
  revoke(ownerId: string, requestId: string): Promise<void>;
}
/** All columns used as context are authenticated, including lookup and expiry metadata. */
export interface EncryptedMcpIdentity {
  version: 1;
  ownerId: string;
  requestId: string;
  grantId: string;
  endpointId: string;
  expiresAt: string;
  keyId: string;
  nonce: string;
  ciphertext: string;
}
interface DbRow { owner_id: string; request_id: string; grant_id: string; endpoint_id: string; expires_at: Date; envelope: EncryptedMcpIdentity }
const safeUnavailable = () => new SecurityError('key_unavailable', 'MCP encryption identity is unavailable');
const b64 = (value: Uint8Array) => Buffer.from(value).toString('base64url');
function from64(value: string, min: number, max = min): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(max * 4 / 3)) throw safeUnavailable();
  const decoded = Uint8Array.from(Buffer.from(value, 'base64url'));
  if (decoded.length < min || decoded.length > max || b64(decoded) !== value) throw safeUnavailable();
  return decoded;
}
function context(row: EncryptedMcpIdentity): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(['ftown/mcp-private-key/v1', row.version, row.ownerId, row.requestId, row.grantId, row.endpointId, row.expiresAt, row.keyId]));
}
function configKey(config: McpKeyEncryptionConfig): Promise<CryptoKey> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.keyId) || config.key.byteLength !== 32) throw new SecurityError('security_setup_required', 'MCP encryption wrapping key and key ID must be provisioned');
  return crypto.subtle.importKey('raw', Uint8Array.from(config.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function validatePins(pins: readonly ApprovedBridge[], ownerId: string): Promise<void> {
  if (pins.length > 64 || new Set(pins.map(pin => pin.bridgeId)).size !== pins.length || new Set(pins.map(pin => pin.endpoint.id)).size !== pins.length) throw safeUnavailable();
  for (const pin of pins) {
    if (pin.endpoint.ownerId !== ownerId || pin.endpoint.kind !== 'bridge' || !pin.permissions.includes('read') || pin.permissions.some(permission => permission === 'admin')) throw safeUnavailable();
    await importPublicKey(pin.endpoint.publicKey);
    if (b64(new Uint8Array(await crypto.subtle.digest('SHA-256', from64(pin.endpoint.publicKey, 65)))) !== pin.endpoint.id) throw safeUnavailable();
  }
}
function stored(identity: McpGrantIdentity, privateKey: JsonWebKey): StoredIdentity {
  const parsed = storedSchema.safeParse({
    version: 1, ownerId: identity.ownerId, requestId: identity.requestId, grantId: identity.grantId,
    endpoint: identity.identity.endpoint, privateKey: { kty: privateKey.kty, crv: privateKey.crv, x: privateKey.x, y: privateKey.y, d: privateKey.d },
    bridges: identity.bridges, permissions: identity.permissions, pendingExpiresAt: identity.pendingExpiresAt,
    activeExpiresAt: identity.activeExpiresAt, state: identity.state,
  });
  if (!parsed.success) throw safeUnavailable();
  return parsed.data;
}
export async function encryptMcpIdentity(identity: McpGrantIdentity, privateKey: JsonWebKey, config: McpKeyEncryptionConfig): Promise<EncryptedMcpIdentity> {
  const value = stored(identity, privateKey);
  await importEndpoint(value.endpoint, value.privateKey);
  await validatePins(value.bridges, value.ownerId);
  if (value.endpoint.kind !== 'mcp' || value.endpoint.ownerId !== value.ownerId) throw safeUnavailable();
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  if (plaintext.byteLength > MAX_RECORD_BYTES) throw safeUnavailable();
  const row: EncryptedMcpIdentity = { version: 1, ownerId: value.ownerId, requestId: value.requestId, grantId: value.grantId, endpointId: value.endpoint.id, expiresAt: value.activeExpiresAt, keyId: config.keyId, nonce: b64(randomBytes(12)), ciphertext: '' };
  const key = await configKey(config);
  row.ciphertext = b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: from64(row.nonce, 12), additionalData: context(row), tagLength: 128 }, key, plaintext)));
  return row;
}
export async function decryptMcpIdentity(row: EncryptedMcpIdentity, config: McpKeyEncryptionConfig): Promise<McpGrantIdentity> {
  const key = await configKey(config);
  try {
    if (row.version !== 1 || row.keyId !== config.keyId || Object.keys(row).length !== 9) throw safeUnavailable();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(row.nonce, 12), additionalData: context(row), tagLength: 128 }, key, from64(row.ciphertext, 16, MAX_RECORD_BYTES + 16));
    const parsed = storedSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
    if (!parsed.success) throw safeUnavailable();
    const value = parsed.data;
    if (value.ownerId !== row.ownerId || value.requestId !== row.requestId || value.grantId !== row.grantId || value.endpoint.id !== row.endpointId || value.activeExpiresAt !== row.expiresAt || value.endpoint.ownerId !== value.ownerId || value.endpoint.kind !== 'mcp') throw safeUnavailable();
    await validatePins(value.bridges, value.ownerId);
    return { ownerId: value.ownerId, requestId: value.requestId, grantId: value.grantId, identity: await importEndpoint(value.endpoint, value.privateKey), bridges: value.bridges, permissions: value.permissions, pendingExpiresAt: value.pendingExpiresAt, activeExpiresAt: value.activeExpiresAt, state: value.state };
  } catch { throw safeUnavailable(); }
}
function dbEnvelope(row: DbRow): EncryptedMcpIdentity {
  if (row.envelope.ownerId !== row.owner_id || row.envelope.requestId !== row.request_id || row.envelope.grantId !== row.grant_id
    || row.envelope.endpointId !== row.endpoint_id || row.envelope.expiresAt !== row.expires_at.toISOString()) throw safeUnavailable();
  return row.envelope;
}
function securityDetails(identity: McpGrantIdentity): McpConsentSecurity {
  return { requestId: identity.requestId, grantId: identity.grantId, endpoint: identity.identity.endpoint, expiresAt: identity.pendingExpiresAt, activeExpiresAt: identity.activeExpiresAt, permissions: identity.permissions };
}

/** Uses the gateway's existing pool; no second connection-string/secret source. */
export class McpKeyStore implements McpIdentityStore {
  private readonly config: McpKeyEncryptionConfig;
  constructor(readonly pool: Pool, config: McpKeyEncryptionConfig, private readonly now = Date.now) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.keyId) || config.key.byteLength !== 32) throw new SecurityError('security_setup_required', 'MCP encryption wrapping key and key ID must be provisioned');
    this.config = { keyId: config.keyId, key: Uint8Array.from(config.key) };
  }
  async checkSchema(): Promise<void> {
    try { await this.pool.query('SELECT owner_id,request_id,grant_id,endpoint_id,envelope,expires_at FROM mcp_endpoint_identities LIMIT 0'); }
    catch { throw new SecurityError('security_setup_required', 'MCP encryption database migration is required'); }
  }
  async ensurePendingIdentity(requestId: string, ownerId: string, permissions: ('read' | 'control')[]): Promise<McpConsentSecurity> {
    const existing = await this.pool.query<DbRow>('SELECT * FROM mcp_endpoint_identities WHERE request_id=$1', [requestId]);
    if (existing.rows[0]) {
      const current = await decryptMcpIdentity(dbEnvelope(existing.rows[0]), this.config);
      if (current.ownerId !== ownerId || current.state !== 'pending' || Date.parse(current.pendingExpiresAt) <= this.now() || current.permissions.join(' ') !== permissions.join(' ')) throw safeUnavailable();
      return securityDetails(current);
    }
    const identity = await generateEndpoint(ownerId, 'mcp', true);
    const privateKey = await crypto.subtle.exportKey('jwk', identity.keyPair.privateKey);
    const record: McpGrantIdentity = {
      ownerId, requestId, grantId: b64(randomBytes(32)), identity, bridges: [], permissions,
      pendingExpiresAt: new Date(this.now() + 300_000).toISOString(), activeExpiresAt: new Date(this.now() + MAX_ACTIVE_MS).toISOString(), state: 'pending',
    };
    const envelope = await encryptMcpIdentity(record, privateKey, this.config);
    await this.pool.query('INSERT INTO mcp_endpoint_identities(owner_id,request_id,grant_id,endpoint_id,envelope,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(request_id) DO NOTHING', [ownerId, requestId, record.grantId, identity.endpoint.id, JSON.stringify(envelope), record.activeExpiresAt]);
    // Reload the winner, including under concurrent consent inspections.
    return this.ensurePendingIdentity(requestId, ownerId, permissions);
  }
  async loadByRequest(ownerId: string, requestId: string): Promise<McpGrantIdentity> {
    const result = await this.pool.query<DbRow>('SELECT * FROM mcp_endpoint_identities WHERE owner_id=$1 AND request_id=$2', [ownerId, requestId]);
    if (!result.rows[0]) throw safeUnavailable();
    return decryptMcpIdentity(dbEnvelope(result.rows[0]), this.config);
  }
  async loadGrantIdentity(ownerId: string, grantId: string): Promise<McpGrantIdentity> {
    const result = await this.pool.query<DbRow>('SELECT * FROM mcp_endpoint_identities WHERE owner_id=$1 AND grant_id=$2 AND expires_at>NOW()', [ownerId, grantId]);
    if (!result.rows[0]) throw safeUnavailable();
    const identity = await decryptMcpIdentity(dbEnvelope(result.rows[0]), this.config);
    if ((identity.state !== 'approved' && identity.state !== 'active') || Date.parse(identity.activeExpiresAt) <= this.now()) throw safeUnavailable();
    if (identity.state === 'approved' && Date.parse(identity.pendingExpiresAt) <= this.now()) throw safeUnavailable();
    return identity;
  }
  /** Caller must verify exact bridge Auth receipts before supplying these pins. */
  async approve(ownerId: string, requestId: string, bridges: ApprovedBridge[]): Promise<McpGrantIdentity> {
    if (!bridges.length) throw safeUnavailable();
    return this.update(ownerId, requestId, current => {
      if (current.state !== 'pending' || Date.parse(current.pendingExpiresAt) <= this.now()
        || bridges.some(bridge => bridge.permissions.some(permission => !current.permissions.includes(permission === 'admin' ? 'control' : permission)) || bridge.permissions.includes('admin'))) throw safeUnavailable();
      return { ...current, state: 'approved', bridges };
    });
  }
  async markActive(ownerId: string, requestId: string): Promise<void> {
    await this.update(ownerId, requestId, current => {
      if (current.state === 'active' && Date.parse(current.activeExpiresAt) > this.now()) return current;
      if (current.state !== 'approved' || Date.parse(current.pendingExpiresAt) <= this.now()) throw safeUnavailable();
      return { ...current, state: 'active' };
    });
  }
  async revoke(ownerId: string, requestId: string): Promise<void> {
    await this.update(ownerId, requestId, current => ({ ...current, state: 'revoked' }));
  }
  private async update(ownerId: string, requestId: string, change: (current: McpGrantIdentity) => McpGrantIdentity): Promise<McpGrantIdentity> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<DbRow>('SELECT * FROM mcp_endpoint_identities WHERE owner_id=$1 AND request_id=$2 FOR UPDATE', [ownerId, requestId]);
      if (!result.rows[0]) throw safeUnavailable();
      const envelope = dbEnvelope(result.rows[0]);
      const current = await decryptMcpIdentity(envelope, this.config);
      const updated = change(current);
      // Private keys are non-extractable after loading. Recover original plaintext only inside the wrapping boundary.
      const key = await configKey(this.config);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(envelope.nonce, 12), additionalData: context(envelope), tagLength: 128 }, key, from64(envelope.ciphertext, 16, MAX_RECORD_BYTES + 16));
      const original = storedSchema.parse(JSON.parse(new TextDecoder().decode(plain)));
      const encrypted = await encryptMcpIdentity(updated, original.privateKey, this.config);
      await client.query('UPDATE mcp_endpoint_identities SET envelope=$1 WHERE owner_id=$2 AND request_id=$3', [JSON.stringify(encrypted), ownerId, requestId]);
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof SecurityError) throw error;
      throw safeUnavailable();
    } finally { client.release(); }
  }
}
