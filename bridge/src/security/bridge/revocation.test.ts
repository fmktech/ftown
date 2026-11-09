import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateEndpoint } from '../crypto.js';
import { createAccountGenesis, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory } from '../account-crypto.js';
import type { AccountCheckpoint, AccountDevice, AccountHistory, AccountOperation } from '../account-protocol.js';
import { AccountBridgeRevoked, confirmOwnRevocation, isOwnBridgeRevoked, parseBridgeRevokedBody } from './revocation.js';

const ownerId = '349f8d2e-38e4-4d59-888d-687dcfa19e39';

async function account() {
  const now = Date.now();
  const first = await generateEndpoint(ownerId, 'browser');
  const signing = await generateAccountSigningIdentity();
  const second = await generateEndpoint(ownerId, 'browser');
  const secondSigning = await generateAccountSigningIdentity();
  const secondDevice: AccountDevice = { endpoint: second.endpoint, signingPublicKey: secondSigning.publicKey, label: 'Second', approvedAt: new Date(now).toISOString() };
  const genesis: AccountHistory = { genesis: await createAccountGenesis(ownerId, first.endpoint, signing, 'First', now), transitions: [] };
  const states: AccountCheckpoint[] = [await verifyAccountHistory(genesis, null, now)];
  const chain = { history: genesis, now };
  async function append(op: AccountOperation, from = chain.history, base = states[from.transitions.length]): Promise<AccountHistory> {
    const at = now + from.transitions.length + 1;
    const record = await signAccountTransition(base, first.endpoint.id, signing, op, at);
    return { ...from, transitions: [...from.transitions, record] };
  }
  const bridge = async (id: string): Promise<AccountOperation> => ({ type: 'add_bridge', bridge: { bridgeId: id, endpoint: (await generateEndpoint(ownerId, 'bridge')).endpoint, label: id, approvedAt: new Date(now).toISOString() } });
  async function extend(op: AccountOperation) {
    chain.history = await append(op);
    states.push(await verifyAccountHistory(chain.history, states[states.length - 1], now + chain.history.transitions.length + 1));
  }
  return { now, signing, first, genesis, secondDevice, chain, states, extend, append, bridge };
}

// genesis(0), add A(1), add B(2), revoke A(3), add_device(4)
async function standard() {
  const f = await account();
  await f.extend(await f.bridge('A'));
  await f.extend(await f.bridge('B'));
  await f.extend({ type: 'revoke_bridge', bridgeId: 'A' });
  await f.extend({ type: 'add_device', device: f.secondDevice });
  const full = f.chain.history;
  const evidence: AccountHistory = { ...full, transitions: full.transitions.slice(0, 3) };
  return { ...f, full, evidence, pin: (revision: number) => f.states[revision] };
}
const body = (history: unknown, error: unknown = 'bridge_revoked') => JSON.stringify({ error, history });

test('parseBridgeRevokedBody accepts a valid body and ignores extra fields', async () => {
  const f = await standard();
  assert.deepEqual(parseBridgeRevokedBody(body(f.evidence)), f.evidence);
  assert.deepEqual(parseBridgeRevokedBody(JSON.stringify({ error: 'bridge_revoked', history: f.evidence, extra: 1 })), f.evidence);
});

test('parseBridgeRevokedBody returns null for every malformed shape and never throws', async () => {
  const f = await standard();
  assert.equal(parseBridgeRevokedBody(body(f.evidence, 'other')), null);
  assert.equal(parseBridgeRevokedBody(JSON.stringify({ history: f.evidence })), null);
  assert.equal(parseBridgeRevokedBody(JSON.stringify({ error: 'bridge_revoked' })), null);
  assert.equal(parseBridgeRevokedBody('not json'), null);
  assert.equal(parseBridgeRevokedBody(''), null);
  assert.equal(parseBridgeRevokedBody('null'), null);
  assert.equal(parseBridgeRevokedBody('"bridge_revoked"'), null);
  assert.equal(parseBridgeRevokedBody('[1]'), null);
  assert.equal(parseBridgeRevokedBody(body(null)), null);
  assert.equal(parseBridgeRevokedBody(body({ genesis: 1, transitions: [] })), null);
  assert.equal(parseBridgeRevokedBody(body({ genesis: f.evidence.genesis })), null);
  assert.equal(parseBridgeRevokedBody(body({ ...f.evidence, transitions: 'x' })), null);
});

test('isOwnBridgeRevoked reflects revokedBridgeIds and tolerates a null checkpoint', async () => {
  const f = await standard();
  assert.equal(isOwnBridgeRevoked(f.pin(3), 'A'), true);
  assert.equal(isOwnBridgeRevoked(f.pin(3), 'B'), false);
  assert.equal(isOwnBridgeRevoked(f.pin(2), 'A'), false);
  assert.equal(isOwnBridgeRevoked(null, 'A'), false);
});

test('confirmOwnRevocation accepts evidence that extends the pin and revokes this bridge', async () => {
  const f = await standard();
  assert.equal(await confirmOwnRevocation({ evidence: f.evidence, pinned: f.pin(2), bridgeId: 'A' }), true);
  assert.equal(await confirmOwnRevocation({ evidence: f.evidence, pinned: f.pin(3), bridgeId: 'A', now: f.now + 100 }), true);
});

test('confirmOwnRevocation is false for a different bridge or a null pin', async () => {
  const f = await standard();
  assert.equal(await confirmOwnRevocation({ evidence: f.evidence, pinned: f.pin(2), bridgeId: 'B' }), false);
  assert.equal(await confirmOwnRevocation({ evidence: f.evidence, pinned: null, bridgeId: 'A' }), false);
});

test('confirmOwnRevocation rejects tampered operations and signatures', async () => {
  const f = await standard();
  const swapped = JSON.parse(JSON.stringify(f.evidence)) as AccountHistory;
  swapped.transitions[2].payload.operation = { type: 'revoke_bridge', bridgeId: 'B' };
  assert.equal(await confirmOwnRevocation({ evidence: swapped, pinned: f.pin(2), bridgeId: 'B' }), false);
  const signature = JSON.parse(JSON.stringify(f.evidence)) as AccountHistory;
  const sig = signature.transitions[2].signature;
  signature.transitions[2].signature = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  assert.equal(await confirmOwnRevocation({ evidence: signature, pinned: f.pin(2), bridgeId: 'A' }), false);
});

test('confirmOwnRevocation rejects a fork that shares the pinned genesis but diverges', async () => {
  const f = await standard();
  // Fork: same genesis and rev 1, but a different transition at rev 2; the pin lives on the fork.
  const forkHistory = await f.append(await f.bridge('C'), { ...f.full, transitions: f.full.transitions.slice(0, 1) }, f.pin(1));
  const forkPin = await verifyAccountHistory(forkHistory, f.pin(1), f.now + 10);
  assert.equal(forkPin.revision, 2);
  assert.notDeepEqual(forkPin, f.pin(2));
  assert.equal(await confirmOwnRevocation({ evidence: f.evidence, pinned: forkPin, bridgeId: 'A' }), false);
});

test('confirmOwnRevocation rejects rollback when the pin is ahead of the evidence', async () => {
  const f = await standard();
  assert.equal(await confirmOwnRevocation({ evidence: f.evidence, pinned: f.pin(4), bridgeId: 'A' }), false);
});

test('confirmOwnRevocation rejects another account\'s history', async () => {
  const f = await standard();
  const g = await standard();
  assert.equal(await confirmOwnRevocation({ evidence: g.evidence, pinned: f.pin(2), bridgeId: 'A' }), false);
});

test('confirmOwnRevocation never throws on garbage input', async () => {
  const f = await standard();
  const garbage = { genesis: null, transitions: null } as unknown as AccountHistory;
  assert.equal(await confirmOwnRevocation({ evidence: garbage, pinned: f.pin(2), bridgeId: 'A' }), false);
  assert.equal(await confirmOwnRevocation({ evidence: null as unknown as AccountHistory, pinned: f.pin(2), bridgeId: 'A' }), false);
  assert.equal(await confirmOwnRevocation({ evidence: f.evidence, pinned: f.pin(2), bridgeId: 'A', now: Number.NaN }), false);
});

test('AccountBridgeRevoked carries its name and evidence', async () => {
  const f = await standard();
  const error = new AccountBridgeRevoked(f.evidence);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'AccountBridgeRevoked');
  assert.equal(error.evidence, f.evidence);
});

test('confirmOwnRevocation still accepts evidence that runs past the revocation', async () => {
  const f = await standard();
  assert.equal(f.full.transitions.length, 4);
  assert.equal(await confirmOwnRevocation({ evidence: f.full, pinned: f.pin(2), bridgeId: 'A' }), true);
});

test('confirmOwnRevocation works from a genesis pin and rejects another account', async () => {
  const f = await standard();
  const g = await standard();
  assert.equal(f.pin(0).revision, 0);
  assert.equal(await confirmOwnRevocation({ evidence: f.evidence, pinned: f.pin(0), bridgeId: 'A' }), true);
  assert.equal(await confirmOwnRevocation({ evidence: g.evidence, pinned: f.pin(0), bridgeId: 'A' }), false);
});

test('parseBridgeRevokedBody is inert for prototype keys, deep nesting and non-string bodies', async () => {
  const f = await standard();
  const polluted = () => (({} as Record<string, unknown>).polluted);
  const withProto = '{"__proto__":{"polluted":1},"error":"bridge_revoked","history":' + JSON.stringify(f.evidence) + '}';
  parseBridgeRevokedBody(withProto);
  assert.equal(polluted(), undefined);
  const inHistory = '{"error":"bridge_revoked","history":{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"genesis":1,"transitions":[]}}';
  assert.equal(parseBridgeRevokedBody(inHistory), null);
  assert.equal(parseBridgeRevokedBody('{"error":"bridge_revoked","history":{"constructor":{"prototype":{"polluted":1}}}}'), null);
  assert.equal(polluted(), undefined);
  assert.equal(parseBridgeRevokedBody('{"error":"bridge_revoked","history":' + '['.repeat(100000) + ']'.repeat(100000) + '}'), null);
  assert.equal(parseBridgeRevokedBody('{"error":"bridge_revoked","history":' + '{"a":'.repeat(50000) + '1' + '}'.repeat(50000) + '}'), null);
  for (const bad of [undefined, null, 123, {}, [], { error: 'bridge_revoked' }]) assert.equal(parseBridgeRevokedBody(bad as unknown as string), null);
  assert.equal(polluted(), undefined);
});

test('a revoked bridge cannot be added again: signing and verifying both reject it', async () => {
  const f = await standard();
  const readd = f.full.transitions[0].payload.operation;
  assert.equal(readd.type, 'add_bridge');
  const head = f.pin(4);
  await assert.rejects(signAccountTransition(head, f.first.endpoint.id, f.signing, readd, f.now + 10));
  // Forge a correctly signed record so only the verifier's tombstone rule can reject it.
  const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, i]) => `${JSON.stringify(k)}:${canonical(i)}`).join(',')}}` : JSON.stringify(v);
  const payload = { type: 'ftown_account_transition' as const, version: 1 as const, ownerId, rootId: head.rootId, revision: 5, previousHead: head.head,
    issuedAt: new Date(f.now + 10).toISOString(), signerId: f.first.endpoint.id, operation: readd };
  const bytes = new TextEncoder().encode('ftown-account-trust-v1\n' + canonical(payload));
  const signature = Buffer.from(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, f.signing.keyPair.privateKey, bytes))).toString('base64url');
  const forged: AccountHistory = { ...f.full, transitions: [...f.full.transitions, { payload, signature }] };
  await assert.rejects(verifyAccountHistory(forged, head, f.now + 20), { code: "invalid_account_trust" });
});
