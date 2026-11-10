import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLedgerPairing } from './ledger-pairing-client.js';
import { BridgeLedgerStore } from './security/bridge/ledger-store.js';
import type { LedgerBridgeIdentity } from './security/bridge/ledger-identity.js';
import { generateEndpoint } from './security/crypto.js';
import type { EndpointIdentity } from './security/protocol.js';
import { accountIdOf, ledgerChallenge, ledgerLastIssuedAt, nextTransition, verifyLedger } from './security/ledger/ledger.js';
import { PAIR_FRAGMENT_PREFIX, bridgeFromPairRequest, pairComparisonCode, parsePairLink, sealPairApproval } from './security/ledger/pairing.js';
import type { BridgePairLink } from './security/ledger/pairing.js';
import { generateAuthKey } from './security/ledger/proof.js';
import type { Ledger, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from './security/ledger/protocol.js';
import { createSoftPasskey } from './security/ledger/testing.js';
import type { SoftPasskey } from './security/ledger/testing.js';

const rpId = 'ftown.example';
const origin = 'https://ftown.example';
const T0 = 1_750_000_000_000;
const NOW = T0 + 3_600_000;
const INTERVAL = 5000;
const LIFETIME = 600_000;
const randomB64 = (length: number): string => Buffer.from(crypto.getRandomValues(new Uint8Array(length))).toString('base64url');

async function signed<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T): Promise<Signed<T>> {
  return { payload, signature: await passkey.sign(await ledgerChallenge(payload)) };
}
async function account(label = 'iCloud Keychain'): Promise<{ passkey: SoftPasskey; ledger: Ledger; accountId: string }> {
  const passkey = await createSoftPasskey({ rpId, origin });
  const genesis = await signed(passkey, {
    type: 'ftown_account_genesis', version: 2, rpId, origins: [origin], handle: randomB64(32), createdAt: T0,
    authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label, addedAt: T0 },
  });
  return { passkey, ledger: { genesis, transitions: [] }, accountId: await accountIdOf(genesis.payload) };
}
async function append(ledger: Ledger, passkey: SoftPasskey, operation: LedgerOperation): Promise<Ledger> {
  const payload = nextTransition(await verifyLedger(ledger, NOW), passkey.credentialId, operation, NOW, ledgerLastIssuedAt(ledger));
  return { genesis: ledger.genesis, transitions: [...ledger.transitions, await signed(passkey, payload)] };
}

/** An unbound ledger bridge identity, as loadOrCreateLedgerIdentity returns it. */
async function fakeIdentity(bridgeId: string): Promise<LedgerBridgeIdentity> {
  const endpoint = await generateEndpoint(`solo:${bridgeId}`, 'bridge');
  const auth = await generateAuthKey(false);
  return {
    keyPair: endpoint.keyPair, endpointPublicKey: endpoint.endpoint.publicKey, endpointId: endpoint.endpoint.id,
    authPublicKey: auth.publicKey, authPrivateKey: auth.privateKey, endpoint: null, accountId: null,
  };
}

interface World {
  lines: string[];
  binds: string[];
  pollCount: number;
  ledgerFetches: number;
  pairCallsAfterSuccess: number;
  sleeps: number[];
  clock: number;
  store: BridgeLedgerStore;
  dir: string;
  run: (overrides?: { lifetimeMs?: number }) => Promise<{ accountId: string }>;
}
interface PollContext {
  n: number;
  link: BridgePairLink;
  world: World;
  /** The browser side: add_bridge signed by the passkey, sealed with the real sealPairApproval. */
  approve: (ledger: Ledger, secret?: string) => Promise<string>;
  entry: () => Promise<Ledger>;
  passkey: SoftPasskey;
}
interface Scenario {
  /** Response for poll number n (1-based). Default: 404, 404, then the honest sealed bundle. */
  poll?: (ctx: PollContext) => Promise<Response | 'throw'>;
  /** Ledger served by GET /api/account/ledger. Default: the approved ledger. */
  serve?: (ctx: PollContext & { approved: Ledger }) => Promise<Response | 'throw'>;
  /** Passkey label of the account. */
  label?: string;
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function world(scenario: Scenario = {}): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-pairing-'));
  const owner = await account(scenario.label);
  const identity = await fakeIdentity('studio');
  const sender: EndpointIdentity = await generateEndpoint(owner.accountId, 'browser');
  const store = new BridgeLedgerStore(dir);
  const w: World = {
    lines: [], binds: [], pollCount: 0, ledgerFetches: 0, pairCallsAfterSuccess: 0, sleeps: [], clock: NOW, store, dir,
    run: async () => { throw new Error('unset'); },
  };
  let link: BridgePairLink | null = null;
  let success = false;
  let approved: Ledger | null = null;
  const ctxFor = (n: number): PollContext => {
    if (link === null) {
      const url = w.lines.map(line => line.match(/https:\/\/\S+/)).filter(Boolean)[0]?.[0];
      assert.ok(url, 'link printed before the first poll');
      link = parsePairLink(url.slice(url.indexOf('#')));
    }
    const current = link;
    const entry = async (): Promise<Ledger> => {
      if (approved === null) {
        const bridge = await bridgeFromPairRequest(current.request, owner.accountId, NOW);
        approved = await append(owner.ledger, owner.passkey, { type: 'add_bridge', bridge });
      }
      return approved;
    };
    return {
      n, link: current, world: w, entry, passkey: owner.passkey,
      approve: async (ledger, secret) => sealPairApproval(secret === undefined ? current : { request: current.request, secret }, ledger, sender, w.clock),
    };
  };
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/pair/')) {
      w.pollCount += 1;
      if (success) w.pairCallsAfterSuccess += 1;
      const ctx = ctxFor(w.pollCount);
      const outcome = scenario.poll
        ? await scenario.poll(ctx)
        : ctx.n < 3 ? json(404, { status: 'pending' }) : json(200, { sealed: await ctx.approve(await ctx.entry()) });
      if (outcome === 'throw') throw new TypeError('fetch failed');
      return outcome;
    }
    if (url.includes('/api/account/ledger')) {
      w.ledgerFetches += 1;
      const ctx = ctxFor(w.pollCount);
      const approvedLedger = await ctx.entry();
      const outcome = scenario.serve ? await scenario.serve({ ...ctx, approved: approvedLedger }) : json(200, { ledger: approvedLedger });
      if (outcome === 'throw') throw new TypeError('fetch failed');
      return outcome;
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  w.run = async (overrides = {}) => {
    const result = await runLedgerPairing({
      apiUrl: 'https://ftown.example/some/base', dataDir: dir, bridgeId: 'studio', label: 'Studio Mac', identity, store,
      bindIdentity: async accountId => { w.binds.push(accountId); return { ...identity, accountId }; },
      print: line => { w.lines.push(line); }, fetchImpl, now: () => w.clock,
      sleep: async ms => {
        w.sleeps.push(ms);
        w.clock += ms;
        if (w.pollCount > 500) throw new Error('runaway polling');
      },
      pollIntervalMs: INTERVAL, lifetimeMs: overrides.lifetimeMs ?? LIFETIME,
    });
    success = true;
    return result;
  };
  return w;
}
async function cleanup(w: World): Promise<void> {
  await rm(w.dir, { recursive: true, force: true });
}
async function rejects(w: World, code: string): Promise<void> {
  await assert.rejects(w.run(), { message: code });
  assert.deepEqual(w.binds, [], 'identity must not be bound');
  assert.equal(await w.store.read(), null, 'store must stay empty');
}

test('happy path: prints link and code, binds, adopts, prints fingerprint and passkey label', async () => {
  const w = await world({ label: 'My YubiKey' });
  try {
    const result = await w.run();
    assert.equal(w.binds.length, 1);
    assert.equal(w.binds[0], result.accountId);
    const state = await w.store.read();
    assert.ok(state);
    assert.equal(state.checkpoint.accountId, result.accountId);
    assert.equal(state.checkpoint.head, result.checkpoint.head);

    const urlLine = w.lines.find(line => line.includes('/pair#req='));
    assert.ok(urlLine);
    const url = urlLine.match(/https:\/\/\S+/)?.[0] as string;
    assert.ok(url.startsWith(`https://ftown.example/pair${PAIR_FRAGMENT_PREFIX}`), 'origin only, not the api base path');
    const link = parsePairLink(url.slice(url.indexOf('#')));
    assert.equal(link.request.label, 'Studio Mac');
    const code = await pairComparisonCode(link.request);
    const codeLine = w.lines.find(line => line.includes(code) && !line.includes('#req='));
    assert.ok(codeLine, 'code printed on its own line');
    assert.match(codeLine, /type/i);
    assert.ok(w.lines.includes(`Paired with account ${result.accountId.slice(0, 8)} (passkey "My YubiKey")`));
    // The secret appears only in the URL fragment.
    for (const line of w.lines) if (line !== urlLine) assert.ok(!line.includes(link.secret));
    assert.ok(!urlLine.replace(/#req=\S+/, '').includes(link.secret));
  } finally { await cleanup(w); }
});

test('410 from the mailbox is pairing_expired and binds nothing', async () => {
  const w = await world({ poll: async ctx => (ctx.n < 2 ? json(404, {}) : json(410, { status: 'expired' })) });
  try {
    await rejects(w, 'pairing_expired');
    assert.ok(w.lines.includes('Pairing link expired. Run `ftown start` to try again.'));
    assert.equal(w.pollCount, 2);
  } finally { await cleanup(w); }
});

test('the deadline ends polling with pairing_expired', async () => {
  const w = await world({ poll: async () => json(404, { status: 'pending' }) });
  try {
    await rejects(w, 'pairing_expired');
    assert.equal(w.pollCount, LIFETIME / INTERVAL);
    assert.ok(w.lines.includes('Pairing link expired. Run `ftown start` to try again.'));
  } finally { await cleanup(w); }
});

test('a sealed bundle from a party without the link secret is pairing_rejected, terminally', async () => {
  const w = await world({ poll: async ctx => json(200, { sealed: await ctx.approve(await ctx.entry(), randomB64(32)) }) });
  try {
    await rejects(w, 'pairing_rejected');
    assert.equal(w.pollCount, 1, 'no polling after a bad bundle');
    assert.equal(w.ledgerFetches, 0);
  } finally { await cleanup(w); }
});

test('garbage mailbox body is pairing_rejected', async () => {
  const w = await world({ poll: async () => json(200, { sealed: 'not a bundle' }) });
  try {
    await rejects(w, 'pairing_rejected');
    assert.equal(w.pollCount, 1);
  } finally { await cleanup(w); }
});

test('a ledger of another account is rejected', async () => {
  const other = await account();
  const w = await world({
    serve: async ctx => {
      const bridge = await bridgeFromPairRequest(ctx.link.request, other.accountId, NOW);
      return json(200, { ledger: await append(other.ledger, other.passkey, { type: 'add_bridge', bridge }) });
    },
  });
  try {
    await rejects(w, 'pairing_rejected');
    assert.equal(w.ledgerFetches, 1);
  } finally { await cleanup(w); }
});

test('a ledger without this bridge is rejected', async () => {
  const w = await world({ serve: async ctx => json(200, { ledger: { genesis: (await ctx.entry()).genesis, transitions: [] } }) });
  try { await rejects(w, 'pairing_rejected'); } finally { await cleanup(w); }
});

test('a bridge revoked later in the chain is rejected', async () => {
  const w = await world({
    serve: async ctx => {
      // The honest chain, then the same passkey revokes the bridge.
      const revoked = await append(ctx.approved, ctx.passkey, { type: 'revoke_bridge', bridgeId: 'studio' });
      return json(200, { ledger: revoked });
    },
  });
  try { await rejects(w, 'pairing_rejected'); } finally { await cleanup(w); }
});

test('transient network errors and 5xx are retried until the bundle arrives', async () => {
  let ledgerTries = 0;
  const w = await world({
    poll: async ctx => {
      if (ctx.n === 1) return 'throw';
      if (ctx.n === 2) return json(503, {});
      if (ctx.n === 3) return json(404, {});
      return json(200, { sealed: await ctx.approve(await ctx.entry()) });
    },
    serve: async ctx => {
      ledgerTries += 1;
      if (ledgerTries === 1) return 'throw';
      if (ledgerTries === 2) return json(503, {});
      return json(200, { ledger: ctx.approved });
    },
  });
  try {
    const result = await w.run();
    assert.equal(w.pollCount, 4);
    assert.equal(ledgerTries, 3);
    assert.equal(w.binds[0], result.accountId);
  } finally { await cleanup(w); }
});

test('exactly one poll per interval, and nothing is fetched from the mailbox after success', async () => {
  const w = await world({
    poll: async ctx => (ctx.n < 5 ? json(404, {}) : json(200, { sealed: await ctx.approve(await ctx.entry()) })),
  });
  try {
    await w.run();
    assert.equal(w.pollCount, 5);
    assert.deepEqual(w.sleeps, [INTERVAL, INTERVAL, INTERVAL, INTERVAL]);
    assert.equal(w.clock, NOW + 4 * INTERVAL);
    assert.equal(w.pairCallsAfterSuccess, 0);
    assert.equal(w.ledgerFetches, 1);
  } finally { await cleanup(w); }
});
