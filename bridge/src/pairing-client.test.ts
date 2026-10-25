import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runPairing } from './pairing-client.js';
import { createAccountEnrollment, createAccountGenesis, generateAccountBridgeCandidate, generateAccountSigningIdentity,
  sealAccountApproval, signAccountTransition, verifyAccountHistory } from './security/account-crypto.js';
import { generateEndpoint } from './security/crypto.js';

const API = 'https://ftown.example';
const DEVICE_CODE = 'super-secret-device-code-32bytes';
const LOCAL_PORT = 51234;
const LOCAL_NONCE = '0123456789abcdef0123456789abcdef';
const START = {
  deviceCode: DEVICE_CODE,
  userCode: 'ABCD-2345',
  verificationUri: `${API}/pair`,
  intervalMs: 5000,
  expiresInMs: 60000,
};

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * Scripted fetch: /pair/start returns START, /pair/poll pops the next poll body
 * off a queue. Records every request body so tests can assert the deviceCode
 * secret leaves the bridge only over the wire, never into `log`.
 */
function makeFetch(pollBodies: unknown[]): {
  fetchImpl: typeof fetch;
  requests: Array<{ url: string; body: unknown }>;
} {
  const requests: Array<{ url: string; body: unknown }> = [];
  const queue = [...pollBodies];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: u, body });
    if (u.endsWith('/pair/start')) return jsonResponse(START);
    if (u.endsWith('/pair/poll')) {
      if (queue.length === 0) return jsonResponse({ status: 'pending' });
      return jsonResponse(queue.shift());
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

/**
 * Fake clock driven by sleepImpl so Date.now() advances deterministically and
 * the overall-timeout path is testable without real time. Records sleep waits.
 */
function makeClock(): { sleepImpl: (ms: number) => Promise<void>; waits: number[]; restore: () => void } {
  const waits: number[] = [];
  let now = 1_000_000;
  const original = Date.now;
  Date.now = () => now;
  const sleepImpl = async (ms: number): Promise<void> => {
    waits.push(ms);
    now += ms;
  };
  return { sleepImpl, waits, restore: () => { Date.now = original; } };
}

const APPROVED = {
  status: 'approved',
  ownerId: '7bac2a7f-c58e-4845-856f-8283fb07ad96',
  token: 'connect-token-secret',
  refreshToken: 'refresh-token-secret',
  centrifugoUrl: 'wss://centrifugo.example/connection/websocket',
  userId: 'user@example.com',
};

describe('runPairing', () => {
  let restoreClock: (() => void) | undefined;

  afterEach(() => {
    restoreClock?.();
    restoreClock = undefined;
  });

  it('start → pending ×2 → approved returns the token bundle', async () => {
    const { fetchImpl } = makeFetch([
      { status: 'pending' },
      { status: 'pending' },
      APPROVED,
    ]);
    const clock = makeClock();
    restoreClock = clock.restore;

    const result = await runPairing({
      apiUrl: API,
      bridgeId: 'bridge-1',
      hostname: 'host',
      platform: 'darwin',
      localPort: LOCAL_PORT,
      localNonce: LOCAL_NONCE,
      fetchImpl,
      sleepImpl: clock.sleepImpl,
      log: () => {},
    });

    assert.deepEqual(result, {
      ownerId: APPROVED.ownerId,
      token: APPROVED.token,
      refreshToken: APPROVED.refreshToken,
      centrifugoUrl: APPROVED.centrifugoUrl,
      userId: APPROVED.userId,
    });
  });

  it('denied throws "Pairing denied"', async () => {
    const { fetchImpl } = makeFetch([{ status: 'pending' }, { status: 'denied' }]);
    const clock = makeClock();
    restoreClock = clock.restore;

    await assert.rejects(
      runPairing({ apiUrl: API, bridgeId: 'b', hostname: 'h', platform: 'p', localPort: LOCAL_PORT, localNonce: LOCAL_NONCE, fetchImpl, sleepImpl: clock.sleepImpl, log: () => {} }),
      /Pairing denied/,
    );
  });

  it('expired status throws a clear message', async () => {
    const { fetchImpl } = makeFetch([{ status: 'expired' }]);
    const clock = makeClock();
    restoreClock = clock.restore;

    await assert.rejects(
      runPairing({ apiUrl: API, bridgeId: 'b', hostname: 'h', platform: 'p', localPort: LOCAL_PORT, localNonce: LOCAL_NONCE, fetchImpl, sleepImpl: clock.sleepImpl, log: () => {} }),
      /expired/,
    );
  });

  it('overall timeout throws "Pairing timed out" when never approved', async () => {
    // expiresInMs = intervalMs → the pre-poll wait alone crosses the deadline.
    const { fetchImpl } = makeFetch([]); // all polls default to pending
    const clock = makeClock();
    restoreClock = clock.restore;

    await assert.rejects(
      runPairing({ apiUrl: API, bridgeId: 'b', hostname: 'h', platform: 'p', localPort: LOCAL_PORT, localNonce: LOCAL_NONCE, fetchImpl, sleepImpl: clock.sleepImpl, log: () => {} }),
      /Pairing timed out/,
    );
  });

  it('slow_down backs off an extra interval before the next poll', async () => {
    const { fetchImpl } = makeFetch([
      { status: 'slow_down' },
      APPROVED,
    ]);
    const clock = makeClock();
    restoreClock = clock.restore;

    await runPairing({
      apiUrl: API, bridgeId: 'b', hostname: 'h', platform: 'p',
      localPort: LOCAL_PORT, localNonce: LOCAL_NONCE,
      fetchImpl, sleepImpl: clock.sleepImpl, log: () => {},
    });

    // waits: [intervalMs (pre-poll), intervalMs*2 (slow_down back-off)].
    assert.deepEqual(clock.waits, [START.intervalMs, START.intervalMs * 2]);
  });

  it('never passes deviceCode or any token to the log sink', async () => {
    const { fetchImpl, requests } = makeFetch([{ status: 'pending' }, APPROVED]);
    const clock = makeClock();
    restoreClock = clock.restore;
    const logged: string[] = [];

    const result = await runPairing({
      apiUrl: API, bridgeId: 'b', hostname: 'h', platform: 'p',
      localPort: LOCAL_PORT, localNonce: LOCAL_NONCE,
      fetchImpl, sleepImpl: clock.sleepImpl,
      log: (msg) => logged.push(msg),
    });

    const secrets = [DEVICE_CODE, result.token, result.refreshToken];
    const blob = logged.join('\n');
    for (const secret of secrets) {
      assert.ok(!blob.includes(secret), `log leaked a secret: ${secret}`);
    }
    // userCode MAY appear — prove the block was actually printed.
    assert.ok(blob.includes(START.userCode), 'userCode should be printed');
    // Sanity: the deviceCode DID travel over the wire (to /pair/poll), just not to log.
    const pollReq = requests.find((r) => r.url.endsWith('/pair/poll'));
    assert.equal((pollReq?.body as { deviceCode?: string }).deviceCode, DEVICE_CODE);
    // The loopback advert (localPort/localNonce) rides the poll body so the poll
    // route can embed it in the Centrifugo connect token's presence `info` claim.
    assert.equal((pollReq?.body as { localPort?: number }).localPort, LOCAL_PORT);
    assert.equal((pollReq?.body as { localNonce?: string }).localNonce, undefined, 'cloud never receives a local authorization capability');
  });

  it('virgin enrollment uploads no fragment secret and displays only an operator-origin proof-bound link through the explicit TTY sink', async () => {
    const clock = makeClock(); restoreClock = clock.restore;
    const candidate = await generateAccountBridgeCandidate('bridge-1');
    const link = await createAccountEnrollment(candidate, 'Computer', null, 'bridge-1');
    const browser = await generateEndpoint(APPROVED.ownerId, 'browser'); const signing = await generateAccountSigningIdentity();
    const genesis = await createAccountGenesis(APPROVED.ownerId, browser.endpoint, signing, 'Browser');
    const state = await verifyAccountHistory({ genesis, transitions: [] }, null);
    const history = { genesis, transitions: [await signAccountTransition(state, browser.endpoint.id, signing,
      { type: 'add_bridge', bridge: { bridgeId: 'bridge-1', endpoint: { ...candidate.endpoint, ownerId: APPROVED.ownerId }, label: 'Computer', approvedAt: new Date(Date.now()).toISOString() } })] };
    const approval = await sealAccountApproval(browser, link, history);
    const scripted = makeFetch([{ ...APPROVED, accountApproval: approval, accountHistory: history }]);
    const fetchImpl: typeof fetch = async (url, init) => String(url).endsWith('/pair/start')
      ? (scripted.requests.push({ url: String(url), body: JSON.parse(String(init?.body)) }), jsonResponse({ ...START, verificationUri: 'https://attacker.example/pair' }) as unknown as Response)
      : scripted.fetchImpl(url, init);
    const logs: string[] = []; const display: string[] = []; const codes: string[] = [];
    const result = await runPairing({ apiUrl: API, bridgeId: 'bridge-1', hostname: 'Computer', platform: 'linux', localPort: LOCAL_PORT,
      localNonce: LOCAL_NONCE, fetchImpl, enrollment: link, sleepImpl: clock.sleepImpl, log: value => logs.push(value),
      onPairingCode: async code => { codes.push(code); }, displayEnrollmentUrl: url => display.push(url) });
    assert.deepEqual(result.accountApproval, approval); assert.deepEqual(codes, [START.userCode]);
    const shown = new URL(display[0]); assert.equal(shown.origin, API); assert.equal(shown.pathname, '/pair');
    assert.equal(shown.searchParams.get('code'), START.userCode); assert.ok(shown.hash.startsWith('#account='));
    const start = scripted.requests.find(item => item.url.endsWith('/pair/start'))!;
    assert.deepEqual((start.body as { enrollment: unknown }).enrollment, link.request);
    const uploads = JSON.stringify(scripted.requests); const logged = logs.join('\n');
    assert.ok(!uploads.includes(link.secret)); assert.ok(!logged.includes('#account='));
    for (const secret of [link.secret, DEVICE_CODE, result.token, result.refreshToken]) assert.ok(!logged.includes(secret));
  });

  it('new enrollment cannot downgrade to legacy credentials when an encrypted approval is missing', async () => {
    const clock = makeClock(); restoreClock = clock.restore;
    const identity = await generateAccountBridgeCandidate('bridge-1');
    const link = await createAccountEnrollment(identity, 'Computer', null, 'bridge-1');
    const { fetchImpl } = makeFetch([APPROVED]);
    await assert.rejects(runPairing({ apiUrl: API, bridgeId: 'bridge-1', hostname: 'Computer', platform: 'linux', localPort: LOCAL_PORT,
      localNonce: LOCAL_NONCE, fetchImpl, enrollment: link, sleepImpl: clock.sleepImpl, log: () => {}, displayEnrollmentUrl: () => {} }), /no legacy fallback/);
  });
});
