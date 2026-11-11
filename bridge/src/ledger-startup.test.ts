import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  LEGACY_ACCOUNT_RESET_MESSAGE, NOT_IN_LEDGER_MESSAGE, PAIRING_REJECTED_HINT, PAIRING_REVOKED_MESSAGE, SERVER_LEDGER_MISMATCH_MESSAGE, UPDATED_TO_LEDGER_MESSAGE,
  UPDATE_RESTART_UNPAIRED_MESSAGE,
  ledgerUnavailableMessage, ownStatusAction, resetIdentityForStart, startAccountIdentity, usesLedger, type AccountStartupDeps,
} from './ledger-startup.js';
import { beginIdentityReset } from './identity-reset.js';
import { UnauthorizedError } from 'centrifuge';
import { HttpStatusError, MISSING_RELAY_URL_MESSAGE, relayTokenFailureMessage } from './ledger-relay.js';
import {
  DO_NOT_RESET_LINE, HELD_NO_RELAY_URL_LINE, HELD_OFFLINE_LINE, createEndpointRegistrar, endpointRefusedMessage, heldHistoryNotice, offlineWithoutRelayUrlMessage, startRelay,
} from './ledger-startup.js';
import type { BridgeMode } from './revocation-gating.js';
import { accountIdOf, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, nextTransition, verifyLedger } from './security/ledger/ledger.js';
import { bridgeFromPairRequest, createBridgePairRequest } from './security/ledger/pairing.js';
import type { Ledger, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from './security/ledger/protocol.js';
import { createSoftPasskey, type SoftPasskey } from './security/ledger/testing.js';
import { bindLedgerIdentity, loadOrCreateLedgerIdentity, readLedgerIdentity, type LedgerBridgeIdentity } from './security/bridge/ledger-identity.js';
import { BridgeLedgerStore } from './security/bridge/ledger-store.js';

const MODES: BridgeMode[] = ['account', 'solo', 'local'];
const OLD_ID = '11111111-1111-4111-8111-111111111111';
const rpId = 'ftown.example';
const origin = 'https://ftown.example';
const T0 = 1750000000000;
const NOW = T0 + 3600000;

interface Chain { ledger: Ledger; accountId: string; head: string }
async function signed<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T): Promise<Signed<T>> {
  return { payload, signature: await passkey.sign(await ledgerChallenge(payload)) };
}
async function genesis(passkey: SoftPasskey): Promise<Chain> {
  const record = await signed(passkey, {
    type: 'ftown_account_genesis', version: 2, rpId, origins: [origin], handle: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    createdAt: T0, authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: 'iCloud Keychain', addedAt: T0 },
  });
  const accountId = await accountIdOf(record.payload);
  return { ledger: { genesis: record, transitions: [] }, accountId, head: accountId };
}
async function append(chain: Chain, passkey: SoftPasskey, operation: LedgerOperation): Promise<Chain> {
  const last = ledgerLastIssuedAt(chain.ledger);
  const payload = nextTransition(await verifyLedger(chain.ledger, NOW), passkey.credentialId, operation, last + 1000, last);
  const record = await signed(passkey, payload);
  return { ledger: { genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, record] }, accountId: chain.accountId, head: await ledgerHead(payload) };
}
async function addBridge(chain: Chain, passkey: SoftPasskey, keys: LedgerBridgeIdentity, bridgeId: string): Promise<Chain> {
  const link = createBridgePairRequest({ bridgeId, endpointPublicKey: keys.endpointPublicKey, authPublicKey: keys.authPublicKey, label: bridgeId, now: T0 });
  return append(chain, passkey, { type: 'add_bridge', bridge: await bridgeFromPairRequest(link.request, chain.accountId, T0) });
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ledger-startup-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('usesLedger', () => {
  it('only account bridges enter the ledger startup', () => {
    assert.deepEqual(MODES.filter(usesLedger), ['account']);
  });
});

describe('resetIdentityForStart (step 2)', () => {
  const sec = (name: string): string => join(dir, 'security', name);
  function seedLegacy(): void {
    mkdirSync(join(dir, 'security'), { recursive: true });
    writeFileSync(join(dir, 'bridge-id'), `${OLD_ID}\n`);
    writeFileSync(join(dir, 'refresh-token'), 'tok');
    writeFileSync(sec('policy.json'), '{}');
  }
  const run = (mode: BridgeMode, newIdentity = false, updateRestart = false) => {
    const logs: string[] = [];
    const outcome = resetIdentityForStart({ dataDir: dir, mode, newIdentity, updateRestart, log: line => logs.push(line) });
    return { outcome, result: outcome.kind === 'continue' ? outcome.reset : null, logs };
  };
  const nothing = { outcome: { kind: 'continue', reset: null }, result: null, logs: [] };

  it('account mode: v1 account state on disk resets the identity and says so once', () => {
    seedLegacy();
    const { result, logs } = run('account');
    assert.equal(result?.reason, 'manual');
    assert.equal(result?.oldBridgeId, OLD_ID);
    assert.deepEqual(logs, [LEGACY_ACCOUNT_RESET_MESSAGE]);
    assert.equal(existsSync(join(dir, 'refresh-token')), false);
    assert.equal(existsSync(sec('policy.json')), false);
    assert.equal(readFileSync(join(dir, 'bridge-id'), 'utf8'), `${result?.newBridgeId}\n`);
    // The next start finds nothing left to reset.
    assert.deepEqual(run('account'), nothing);
  });

  it('account mode: --new-identity resets without the legacy line', () => {
    mkdirSync(join(dir, 'security'), { recursive: true });
    writeFileSync(sec('ledger-identity.json'), '{}');
    const { result, logs } = run('account', true);
    assert.equal(result?.reason, 'manual');
    assert.deepEqual(logs, []);
    assert.equal(existsSync(sec('ledger-identity.json')), false);
  });

  it('account mode: a Solo-owned identity alone is not v1 account state', () => {
    mkdirSync(join(dir, 'security'), { recursive: true });
    writeFileSync(sec('bridge-identity.json'), JSON.stringify({ version: 1, endpoint: { ownerId: `solo:${OLD_ID}` } }));
    writeFileSync(sec('policy.json'), '{}');
    assert.deepEqual(run('account'), nothing);
    assert.equal(existsSync(sec('policy.json')), true);
  });

  it('update restart (v1 -> v2 auto-update) with v1 state: one line, exit, nothing changed, no pairing link', () => {
    seedLegacy();
    const { outcome, logs } = run('account', false, true);
    assert.deepEqual(outcome, { kind: 'exit', message: UPDATED_TO_LEDGER_MESSAGE });
    assert.equal(UPDATED_TO_LEDGER_MESSAGE, '[Bridge] ftown was updated to the passkey ledger; run `ftown start` to pair this computer.');
    assert.deepEqual(logs, []);
    assert.equal(existsSync(join(dir, 'refresh-token')), true);
    assert.equal(existsSync(sec('policy.json')), true);
    assert.equal(existsSync(sec('identity-reset.json')), false);
    assert.equal(readFileSync(join(dir, 'bridge-id'), 'utf8'), `${OLD_ID}\n`);
    // The next interactive start resets and pairs.
    assert.equal(run('account').result?.reason, 'manual');
  });

  it('update restart without v1 state continues normally', () => {
    assert.deepEqual(run('account', false, true), nothing);
  });

  for (const mode of ['solo', 'local'] as const) {
    it(`${mode} mode never starts a reset, even with v1 account files present`, () => {
      seedLegacy();
      assert.deepEqual(run(mode, true, true), nothing);
      assert.equal(existsSync(join(dir, 'refresh-token')), true);
      assert.equal(existsSync(sec('policy.json')), true);
      assert.equal(existsSync(sec('identity-reset.json')), false);
      assert.equal(readFileSync(join(dir, 'bridge-id'), 'utf8'), `${OLD_ID}\n`);
    });

    it(`${mode} mode still finishes a reset that is already pending, as before`, () => {
      seedLegacy();
      beginIdentityReset(dir, 'revoked');
      const { result, logs } = run(mode);
      assert.equal(result?.reason, 'revoked');
      assert.deepEqual(logs, []);
    });
  }

  it('uses the injected steps in order: begin before complete', () => {
    const steps: string[] = [];
    resetIdentityForStart({ dataDir: dir, mode: 'account', newIdentity: false, updateRestart: false, log: () => steps.push('log') }, {
      hasLegacyAccountState: () => { steps.push('legacy'); return true; },
      beginIdentityReset: (_dir, reason) => { steps.push(`begin:${reason}`); },
      completePendingIdentityReset: () => { steps.push('complete'); return null; },
    });
    assert.deepEqual(steps, ['legacy', 'log', 'begin:manual', 'complete']);
  });
});

describe('ownStatusAction (step 4)', () => {
  it('only a signed revocation restarts; an unlisted bridge exits', () => {
    assert.equal(ownStatusAction('active'), 'continue');
    assert.equal(ownStatusAction('revoked'), 'revoked_restart');
    assert.equal(ownStatusAction('absent'), 'exit_absent');
  });
});

describe('startAccountIdentity (steps 3-4)', () => {
  let passkey: SoftPasskey;
  before(async () => { passkey = await createSoftPasskey({ rpId, origin }); });

  /** Keys on disk plus a chain listing them as `studio` (base) and one revoking `studio` (revoked). */
  async function fixture() {
    const keys = await loadOrCreateLedgerIdentity(dir);
    const root = await genesis(passkey);
    const base = await addBridge(root, passkey, keys, 'studio');
    const revoked = await append(base, passkey, { type: 'revoke_bridge', bridgeId: 'studio' });
    return { keys, base, revoked };
  }
  async function bindTo(chain: Chain): Promise<void> {
    await bindLedgerIdentity(dir, chain.accountId);
    await new BridgeLedgerStore(dir).adoptBound(chain.ledger);
  }
  function deps(overrides: Partial<AccountStartupDeps> = {}) {
    const calls = { pair: 0, fetch: [] as string[] };
    const value: AccountStartupDeps = {
      dataDir: dir, bridgeId: 'studio', allowPairing: true,
      pair: async () => { calls.pair++; throw new Error('unexpected pairing'); },
      fetchLedger: async accountId => { calls.fetch.push(accountId); throw new Error('unexpected fetch'); },
      ...overrides,
    };
    return { value, calls };
  }

  it('paired and listed: ready, with no pairing and no fetch', async () => {
    const f = await fixture();
    await bindTo(f.base);
    const d = deps();
    const result = await startAccountIdentity(d.value);
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') return;
    assert.equal(result.identity.accountId, f.base.accountId);
    assert.equal(result.identity.endpoint.id, f.keys.endpointId);
    assert.equal(result.reconciled, 'ok');
    assert.equal(await result.store.ownBridgeStatus({ bridgeId: 'studio', endpointId: f.keys.endpointId, endpointPublicKey: f.keys.endpointPublicKey,
      authPublicKey: f.keys.authPublicKey }), 'active');
    assert.deepEqual(d.calls, { pair: 0, fetch: [] });
  });

  it('unpaired: runs one pairing with the unbound keys and an empty store, then continues bound', async () => {
    const f = await fixture();
    const seen: Array<{ accountId: string | null; stored: unknown }> = [];
    const d = deps({
      pair: async (identity, store) => {
        seen.push({ accountId: identity.accountId, stored: await store.read() });
        await bindTo(f.base);
      },
    });
    const result = await startAccountIdentity(d.value);
    assert.equal(result.kind, 'ready');
    assert.deepEqual(seen, [{ accountId: null, stored: null }]);
    assert.deepEqual(d.calls.fetch, []);
  });

  it('unpaired: an expired or rejected pairing exits 1 with its hint; any other failure propagates', async () => {
    await fixture();
    const expired = await startAccountIdentity(deps({ pair: async () => { throw new Error('pairing_expired'); } }).value);
    assert.deepEqual(expired, { kind: 'exit', message: null });
    const rejected = await startAccountIdentity(deps({ pair: async () => { throw new Error('pairing_rejected'); } }).value);
    assert.deepEqual(rejected, { kind: 'exit', message: PAIRING_REJECTED_HINT });
    // The account already revokes this bridge id: a clear exit that names the fix, never a loop and never a reset.
    const revoked = await startAccountIdentity(deps({ pair: async () => { throw new Error('pairing_revoked'); } }).value);
    assert.deepEqual(revoked, { kind: 'exit', message: PAIRING_REVOKED_MESSAGE });
    assert.match(PAIRING_REVOKED_MESSAGE, /removed from the account before pairing completed.*--new-identity/);
    await assert.rejects(startAccountIdentity(deps({ pair: async () => { throw new Error('disk full'); } }).value), /disk full/);
  });

  it('unpaired during an update restart: exits without pairing', async () => {
    await fixture();
    const d = deps({ allowPairing: false });
    assert.deepEqual(await startAccountIdentity(d.value), { kind: 'exit', message: UPDATE_RESTART_UNPAIRED_MESSAGE });
    assert.equal(d.calls.pair, 0);
  });

  it('needs_ledger: fetches the bound account ledger and adopts it only through adoptBound', async () => {
    const f = await fixture();
    await bindLedgerIdentity(dir, f.base.accountId);
    const d = deps({ fetchLedger: async accountId => { d.calls.fetch.push(accountId); return f.base.ledger; } });
    const result = await startAccountIdentity(d.value);
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') return;
    assert.equal(result.reconciled, 'needs_ledger');
    assert.deepEqual(d.calls.fetch, [f.base.accountId]);
    assert.equal((await new BridgeLedgerStore(dir).read())?.checkpoint.head, f.base.head);
  });

  it('needs_ledger: a failed read exits 1 and leaves the identity bound', async () => {
    const f = await fixture();
    await bindLedgerIdentity(dir, f.base.accountId);
    const result = await startAccountIdentity(deps({ fetchLedger: async () => { throw new Error('Ledger read failed (503)'); } }).value);
    assert.deepEqual(result, { kind: 'exit', message: ledgerUnavailableMessage('Ledger read failed (503)') });
    assert.equal((await readLedgerIdentity(dir))?.accountId, f.base.accountId);
    assert.equal(await new BridgeLedgerStore(dir).read(), null);
  });

  it('needs_ledger: a server ledger that does not list these keys is refused, never stored', async () => {
    const f = await fixture();
    await bindLedgerIdentity(dir, f.base.accountId);
    const other = await loadOrCreateLedgerIdentity(join(dir, 'other'));
    const stranger = await addBridge(await genesis(passkey), passkey, other, 'studio');
    for (const ledger of [stranger.ledger, f.revoked.ledger, { garbage: true }]) {
      const result = await startAccountIdentity(deps({ fetchLedger: async () => ledger }).value);
      assert.deepEqual(result, { kind: 'exit', message: SERVER_LEDGER_MISMATCH_MESSAGE });
    }
    assert.equal(await new BridgeLedgerStore(dir).read(), null);
  });

  it('revoked in the trusted replica: revoked restart, before any network use', async () => {
    const f = await fixture();
    await bindTo(f.base);
    assert.equal((await new BridgeLedgerStore(dir).offer(f.revoked.ledger, 'server')).decision, 'adopt');
    const d = deps();
    assert.deepEqual(await startAccountIdentity(d.value), { kind: 'revoked' });
    assert.deepEqual(d.calls, { pair: 0, fetch: [] });
  });

  it('absent from the ledger: exits 1 with the --new-identity hint and never resets', async () => {
    const f = await fixture();
    await bindTo(f.base);
    const d = deps({ bridgeId: 'kitchen' });
    assert.deepEqual(await startAccountIdentity(d.value), { kind: 'exit', message: NOT_IN_LEDGER_MESSAGE });
    assert.equal(NOT_IN_LEDGER_MESSAGE, "This computer is not in your account's ledger. Run `ftown start --new-identity` to pair it again.");
    assert.equal(existsSync(join(dir, 'security', 'identity-reset.json')), false);
    assert.equal((await readLedgerIdentity(dir))?.accountId, f.base.accountId);
    assert.equal((await new BridgeLedgerStore(dir).read())?.checkpoint.head, f.base.head);
    assert.deepEqual(d.calls, { pair: 0, fetch: [] });
  });
});

describe('startRelay (step 5: the first relay token)', () => {
  const API = 'https://ftown.example';
  const URL_ = 'wss://relay.ftown.example/ws';
  const start = (getToken: () => Promise<string>, opts: { relayUrl?: string | null; revoked?: () => boolean } = {}) => startRelay({
    getToken, relayUrl: () => (opts.relayUrl === undefined ? URL_ : opts.relayUrl), bridgeRevoked: opts.revoked ?? (() => false), apiUrl: API,
  });

  it('online: the token and the relay URL', async () => {
    assert.deepEqual(await start(async () => 'jwt'), { kind: 'online', token: 'jwt', relayUrl: URL_ });
  });

  it('a revocation proven by the token response wins over a successful token', async () => {
    let revoked = false;
    assert.deepEqual(await start(async () => { revoked = true; return 'jwt'; }, { revoked: () => revoked }), { kind: 'revoked' });
  });

  it('online without any relay URL exits', async () => {
    assert.deepEqual(await start(async () => 'jwt', { relayUrl: null }), { kind: 'exit', message: MISSING_RELAY_URL_MESSAGE });
  });

  it('a refusal exits (or restarts when the evidence proved the revocation)', async () => {
    const unauthorized = new UnauthorizedError('no');
    assert.deepEqual(await start(async () => { throw unauthorized; }), { kind: 'exit', message: relayTokenFailureMessage(unauthorized, API) });
    assert.deepEqual(await start(async () => { throw unauthorized; }, { revoked: () => true }), { kind: 'revoked' });
    const forbidden = new Error('Relay token failed (403): no');
    assert.deepEqual(await start(async () => { throw forbidden; }), { kind: 'exit', message: relayTokenFailureMessage(forbidden, API) });
  });

  it('a refusal of a computer that holds its own history starts OFFLINE with the held-history notice, never the reset advice', async () => {
    const unauthorized = new UnauthorizedError('Relay token rejected (401)');
    const notice = heldHistoryNotice({ afterRevision: 5, records: 3, removals: 2, passkeys: 1 });
    const held = await startRelay({ getToken: async () => { throw unauthorized; }, relayUrl: () => URL_, bridgeRevoked: () => false, apiUrl: API, held: () => notice });
    assert.deepEqual(held, { kind: 'offline', relayUrl: URL_, reason: 'Relay token rejected (401)', notice: [...notice, HELD_OFFLINE_LINE] });
    for (const line of held.kind === 'offline' ? held.notice ?? [] : []) assert.doesNotMatch(line, /run `ftown start --new-identity`/);
    // A 403 refusal too.
    const forbidden = await startRelay({ getToken: async () => { throw new Error('Relay token failed (403): no'); }, relayUrl: () => URL_, bridgeRevoked: () => false, apiUrl: API, held: () => notice });
    assert.equal(forbidden.kind, 'offline');
    // Without a saved relay URL there is no offline start: exit, still without the reset advice.
    const nowhere = await startRelay({ getToken: async () => { throw unauthorized; }, relayUrl: () => null, bridgeRevoked: () => false, apiUrl: API, held: () => notice });
    assert.deepEqual(nowhere, { kind: 'exit', message: [...notice, HELD_NO_RELAY_URL_LINE].join('\n') });
    // A proven revocation still wins; a computer that is not an active member (held() null) gets the reset advice as before.
    assert.deepEqual(await startRelay({ getToken: async () => { throw unauthorized; }, relayUrl: () => URL_, bridgeRevoked: () => true, apiUrl: API, held: () => notice }), { kind: 'revoked' });
    assert.deepEqual(await startRelay({ getToken: async () => { throw unauthorized; }, relayUrl: () => URL_, bridgeRevoked: () => false, apiUrl: API, held: () => null }),
      { kind: 'exit', message: relayTokenFailureMessage(unauthorized, API) });
    // A temporary failure is the plain offline start.
    const temporary = await startRelay({ getToken: async () => { throw new Error('fetch failed'); }, relayUrl: () => URL_, bridgeRevoked: () => false, apiUrl: API, held: () => notice });
    assert.deepEqual(temporary, { kind: 'offline', relayUrl: URL_, reason: 'fetch failed' });
  });

  it('the held-history notice: what is unique to this computer when known, else that it holds changes the server lacks; then do not reset', () => {
    assert.deepEqual(heldHistoryNotice({ afterRevision: 5, records: 3, removals: 2, passkeys: 1 }), [
      "[Bridge] The ftown server refused this computer's key, and this computer holds account history the server does not have: 2 removals and 1 passkey among 3 changes after revision 5.",
      '[Bridge] Do NOT run --new-identity: this computer may hold the only copy. Open Security in the dashboard to choose a history.',
    ]);
    assert.deepEqual(heldHistoryNotice(null), [
      "[Bridge] The ftown server refused this computer's key, and this computer holds changes the server does not have.", DO_NOT_RESET_LINE,
    ]);
    assert.equal(heldHistoryNotice({ afterRevision: 4, records: 0, removals: 0, passkeys: 0 })[0], heldHistoryNotice(null)[0]);
  });

  it('a temporary failure starts offline with the saved relay URL, and exits only without one', async () => {
    for (const message of ['fetch failed', 'Relay token failed (503): down', 'Relay request timed out after 15000ms', 'Token refresh cooling down for 15s after 1 failed attempts']) {
      assert.deepEqual(await start(async () => { throw new Error(message); }), { kind: 'offline', relayUrl: URL_, reason: message });
      assert.deepEqual(await start(async () => { throw new Error(message); }, { relayUrl: null }), { kind: 'exit', message: offlineWithoutRelayUrlMessage(message) });
    }
  });
});

describe('createEndpointRegistrar (step 6)', () => {
  function harness(overrides: { register?: (token: string) => Promise<void>; getToken?: () => Promise<string>; cooldown?: () => number; revoked?: () => boolean } = {}) {
    const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];
    const logs: string[] = [];
    const registered: string[] = [];
    const registrar = createEndpointRegistrar({
      register: overrides.register ?? (async token => { registered.push(token); }),
      tokens: { getToken: overrides.getToken ?? (async () => 'jwt'), cooldownRemainingMs: overrides.cooldown ?? (() => 0) },
      bridgeRevoked: overrides.revoked ?? (() => false),
      log: line => logs.push(line),
      schedule: (run, ms) => { const timer = { ms, run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    });
    const live = () => timers.filter(timer => !timer.cancelled);
    const fire = async () => { const timer = live()[0]; timer.cancelled = true; timer.run(); await new Promise(resolve => setImmediate(resolve)); };
    return { registrar, timers, live, fire, logs, registered };
  }

  it('online: registers with the first token', async () => {
    const h = harness();
    assert.deepEqual(await h.registrar.registerNow('first'), { kind: 'registered' });
    assert.deepEqual(h.registered, ['first']);
    assert.equal(h.registrar.registered(), true);
    h.registrar.retryInBackground();
    assert.deepEqual(h.live(), []);
  });

  it('online: a refusal (401/403) exits, or restarts after a proven revocation', async () => {
    for (const status of [401, 403]) {
      const error = new HttpStatusError(`Endpoint directory registration failed (${status})`, status);
      assert.deepEqual(await harness({ register: async () => { throw error; } }).registrar.registerNow('t'), { kind: 'exit', message: endpointRefusedMessage(error.message) });
      assert.deepEqual(await harness({ register: async () => { throw error; }, revoked: () => true }).registrar.registerNow('t'), { kind: 'revoked' });
    }
  });

  it('online: a temporary failure is retried in the background, never earlier than the token cooldown', async () => {
    let fail = true;
    let cooldown = 40_000;
    const h = harness({ register: async () => { if (fail) throw new HttpStatusError('Endpoint directory registration failed (503)', 503); }, cooldown: () => cooldown });
    assert.deepEqual(await h.registrar.registerNow('t'), { kind: 'retry' });
    h.registrar.retryInBackground();
    h.registrar.retryInBackground();
    assert.deepEqual(h.live().map(timer => timer.ms), [40_000]);
    cooldown = 0;
    await h.fire();
    assert.deepEqual(h.live().map(timer => timer.ms), [30_000]);
    fail = false;
    await h.fire();
    assert.equal(h.registrar.registered(), true);
    assert.deepEqual(h.live(), []);
  });

  it('background, holding its own history: a refusal is not final, it keeps retrying with the backoff and never advises a reset', async () => {
    let refuse = true;
    const registered: string[] = [];
    const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];
    const logs: string[] = [];
    const registrar = createEndpointRegistrar({
      register: async token => { registered.push(token); },
      tokens: { getToken: async () => { if (refuse) throw new UnauthorizedError('no'); return 'jwt'; }, cooldownRemainingMs: () => 0 },
      bridgeRevoked: () => false, held: () => true, log: line => logs.push(line),
      schedule: (run, ms) => { const timer = { ms, run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    });
    const fire = async () => { const timer = timers.filter(item => !item.cancelled)[0]; timer.cancelled = true; timer.run(); await new Promise(resolve => setImmediate(resolve)); };
    registrar.retryInBackground();
    await fire();
    await fire();
    assert.deepEqual(timers.filter(item => !item.cancelled).map(item => item.ms), [60_000], 'still retrying, backing off');
    assert.deepEqual(logs, []);
    refuse = false;
    await fire();
    assert.deepEqual(registered, ['jwt']);
    assert.equal(registrar.registered(), true);
    // registerNow with a refused registration: retried in the background, not an exit.
    const now = createEndpointRegistrar({ register: async () => { throw new HttpStatusError('no', 401); }, tokens: { getToken: async () => 'jwt', cooldownRemainingMs: () => 0 },
      bridgeRevoked: () => false, held: () => true, log: () => undefined, schedule: () => () => undefined });
    assert.notEqual((await now.registerNow('jwt')).kind, 'exit');
  });

  it('background: a token or registration refusal stops retrying and says why', async () => {
    const h = harness({ getToken: async () => { throw new UnauthorizedError('no'); } });
    h.registrar.retryInBackground();
    await h.fire();
    assert.deepEqual(h.live(), []);
    assert.equal(h.logs.length, 1);
    assert.match(h.logs[0], /refused this computer's encrypted endpoint/);
  });

  it('stop cancels the background retry', () => {
    const h = harness();
    h.registrar.retryInBackground();
    h.registrar.stop();
    assert.deepEqual(h.live(), []);
  });
});
