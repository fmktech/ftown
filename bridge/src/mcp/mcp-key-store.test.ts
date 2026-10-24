import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateEndpoint } from '../security/crypto.js';
import { decryptMcpIdentity, encryptMcpIdentity, type McpGrantIdentity } from './mcp-key-store.js';
import type { McpKeyEncryptionConfig } from '../security/protocol.js';

const ownerId = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const token = () => randomBytes(32).toString('base64url');
async function fixture() {
  const identity = await generateEndpoint(ownerId, 'mcp', true);
  const bridge = await generateEndpoint(ownerId, 'bridge');
  const privateKey = await crypto.subtle.exportKey('jwk', identity.keyPair.privateKey);
  const record: McpGrantIdentity = {
    ownerId, requestId: token(), grantId: token(), identity,
    bridges: [{ bridgeId: 'machine-a', endpoint: bridge.endpoint, permissions: ['read', 'control'] }],
    permissions: ['read', 'control'], pendingExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    activeExpiresAt: new Date(Date.now() + 2_592_000_000).toISOString(), state: 'approved',
  };
  const config: McpKeyEncryptionConfig = { keyId: 'fixture-key-v1', key: randomBytes(32) };
  const row = await encryptMcpIdentity(record, privateKey, config);
  return { record, privateKey, config, row };
}
test('serialized database envelope contains no private JWK, raw key or bridge permissions/pins', async () => {
  const { record, privateKey, config, row } = await fixture();
  const serialized = JSON.stringify(row);
  assert.ok(privateKey.d);
  for (const secret of [privateKey.d, privateKey.x, privateKey.y, record.identity.endpoint.publicKey, record.bridges[0].endpoint.publicKey, 'permissions', 'privateKey', config.key.toString()]) {
    assert.ok(secret && !serialized.includes(secret));
  }
  const restored = await decryptMcpIdentity(JSON.parse(serialized), config);
  assert.deepEqual(restored.identity.endpoint, record.identity.endpoint);
  assert.equal(restored.identity.keyPair.privateKey.extractable, false);
  assert.deepEqual(restored.bridges, record.bridges);
  assert.deepEqual(restored.permissions, ['read', 'control']);
  assert.equal(restored.grantId, record.grantId);
});
test('at-rest wrapping uses fresh nonce and ciphertext for each persistence', async () => {
  const { record, privateKey, config, row } = await fixture();
  const second = await encryptMcpIdentity(record, privateKey, config);
  assert.notEqual(second.nonce, row.nonce);
  assert.notEqual(second.ciphertext, row.ciphertext);
  assert.equal((await decryptMcpIdentity(second, config)).grantId, record.grantId);
});
test('wrong wrapping key or key ID fails closed without leaking values', async () => {
  const { config, row } = await fixture();
  for (const wrong of [{ ...config, key: randomBytes(32) }, { ...config, keyId: 'another-key' }]) {
    await assert.rejects(decryptMcpIdentity(row, wrong), { code: 'key_unavailable' });
  }
  for (const invalid of [{ ...config, key: new Uint8Array() }, { ...config, keyId: '' }]) {
    await assert.rejects(decryptMcpIdentity(row, invalid), { code: 'security_setup_required' });
  }
});
test('swapping any persisted lookup/expiry context or modifying ciphertext is rejected', async () => {
  const { config, row } = await fixture();
  const changed = [
    { ...row, ownerId: '619f68a6-77c1-49f6-ae2d-c5fa169d284b' },
    { ...row, requestId: token() }, { ...row, grantId: token() }, { ...row, endpointId: token() },
    { ...row, expiresAt: new Date(Date.now() + 1000).toISOString() },
    { ...row, nonce: randomBytes(12).toString('base64url') }, { ...row, ciphertext: row.ciphertext + '=' },
    { ...row, extra: 'unrecognized' },
  ];
  for (const value of changed) await assert.rejects(decryptMcpIdentity(value, config), { code: 'key_unavailable' });
  const ciphertext = Buffer.from(row.ciphertext, 'base64url'); ciphertext[0] ^= 1;
  await assert.rejects(decryptMcpIdentity({ ...row, ciphertext: ciphertext.toString('base64url') }, config), { code: 'key_unavailable' });
});
test('persisting cross-owner pins, admin MCP permissions or mismatched private identity fails', async () => {
  const { record, config, privateKey } = await fixture();
  await assert.rejects(encryptMcpIdentity({ ...record, bridges: [{ ...record.bridges[0], endpoint: { ...record.bridges[0].endpoint, ownerId: '619f68a6-77c1-49f6-ae2d-c5fa169d284b' } }] }, privateKey, config));
  await assert.rejects(encryptMcpIdentity({ ...record, bridges: [{ ...record.bridges[0], permissions: ['read', 'admin'] }] }, privateKey, config));
  const other = await generateEndpoint(ownerId, 'mcp', true);
  await assert.rejects(encryptMcpIdentity(record, await crypto.subtle.exportKey('jwk', other.keyPair.privateKey), config));
});
