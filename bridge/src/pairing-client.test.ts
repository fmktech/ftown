import { afterEach, describe, it, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { runPairing } from './pairing-client.js';
import { createAccountEnrollment, createAccountGenesis, generateAccountBridgeCandidate, generateAccountSigningIdentity,
  sealAccountApproval, signAccountTransition, verifyAccountHistory } from './security/account-crypto.js';
import { generateEndpoint } from './security/crypto.js';
import * as pendingCrypto from './security/pending-approval-crypto.js';
import type { PendingApprovalState, PendingBridgeDecision, PendingBridgeStatus, PendingCandidateConfirmation, PendingHello,
  PendingOfferLocal, PendingResult, PendingSecret } from './security/pending-approval-protocol.js';
import type { AccountHistory } from './security/account-protocol.js';

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


interface PendingHarnessOptions {
  loseReplies?: boolean; renew?: boolean; revoked?: boolean; wrongOwner?: boolean;
  swapOffer?: boolean; localReject?: boolean; unconfirmed?: boolean; advanceHistory?: boolean; rejectAfterConfirm?: boolean;
}
async function pendingHarness(t: TestContext, options: PendingHarnessOptions = {}) {
  let now = Date.now(); const realNow = Date.now; Date.now = () => now; t.after(() => { Date.now = realNow; });
  const candidate = await generateAccountBridgeCandidate('bridge-pending');
  const link = await createAccountEnrollment(candidate, 'Computer', null, 'bridge-pending');
  if (link.request.kind !== 'bridge') throw new Error('fixture request');
  const request = link.request;
  const browser = await generateEndpoint(APPROVED.ownerId, 'browser'); const signing = await generateAccountSigningIdentity();
  const initialHistory: AccountHistory = { genesis: await createAccountGenesis(APPROVED.ownerId, browser.endpoint, signing, 'Admin'), transitions: [] };
  let history = initialHistory;
  const local = await pendingCrypto.createPendingOffer(request, browser, signing, history);
  const offerHash = await pendingCrypto.pendingOfferHash(local.offer);
  let state: PendingApprovalState = { request, revision: 1, status: 'offered', offer: local.offer };
  let opened: PendingSecret | undefined; let approvedResult: PendingResult | undefined; let confirmation: PendingCandidateConfirmation | undefined;
  let pinnedOffer = false; let pinnedHello: PendingHello | undefined; let localConfirmed = false;
  let credentialReplies = 0; let startCalls = 0; let helloCalls = 0; let confirmCalls = 0; let freshReads = 0; let renewals = 0;
  let rejectAfterConfirmation: (() => void) | undefined; let confirmingWatches = 0; let cancellations = 0;
  const startBodies: unknown[] = []; const log: string[] = []; const statuses: PendingBridgeStatus[] = [];
  const lost = new Set<string>();
  const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const failOnce = (key: string) => { if (options.loseReplies && !lost.has(key)) { lost.add(key); throw new TypeError('Simulated lost HTTP reply'); } };
  const finish = async (proof: PendingCandidateConfirmation) => {
    assert.ok(localConfirmed, 'candidate confirmation must follow the local comparison action');
    confirmation = proof;
    await pendingCrypto.verifyPendingConfirmation(local.offer, opened!, { offerHash, contribution: local.contribution }, proof);
    const current = await verifyAccountHistory(history, null);
    history = { genesis: history.genesis, transitions: [...history.transitions, await signAccountTransition(current, browser.endpoint.id, signing,
      { type: 'add_bridge', bridge: { bridgeId: 'bridge-pending', endpoint: { ...candidate.endpoint, ownerId: APPROVED.ownerId }, label: 'Computer', approvedAt: new Date(now).toISOString() } })] };
    // This mock reviewer deliberately performs its independent positive action before result creation.
    approvedResult = await pendingCrypto.createPendingResult(browser, local, opened!, proof, offerHash, history);
    state = { request, revision: state.revision + 1, status: 'approved', offer: local.offer, hello: pinnedHello!,
      reveal: { offerHash, contribution: local.contribution }, confirmation: proof, result: approvedResult };
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    assert.equal(new URL(String(url)).origin, API);
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.cache, 'no-store');
    if (path === '/api/security/account') {
      freshReads++; assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${APPROVED.token}`);
      if (options.renew && freshReads === 1) now += 130000;
      if ((options.revoked || options.advanceHistory) && freshReads === 1) {
        const checkpoint = await verifyAccountHistory(history, null);
        const operation = options.revoked ? { type: 'revoke_bridge' as const, bridgeId: 'bridge-pending' }
          : { type: 'add_bridge' as const, bridge: { bridgeId: 'unrelated', endpoint: (await generateEndpoint(APPROVED.ownerId, 'bridge')).endpoint,
            label: 'Other', approvedAt: new Date(now).toISOString() } };
        history = { genesis: history.genesis, transitions: [...history.transitions, await signAccountTransition(checkpoint, browser.endpoint.id, signing, operation)] };
      }
      return response({ history });
    }
    const body = JSON.parse(String(init?.body));
    if (path === '/api/auth/bridge/pair/start') {
      startCalls++; startBodies.push(body);
      assert.equal(body.approvalMethod, 'pending-v1'); assert.equal(body.accountHint, 'user@example.com');
      assert.deepEqual(body.enrollment, request); assert.equal(body.candidateToken, Buffer.alloc(32, 9).toString('base64url'));
      assert.equal(JSON.stringify(body).includes(link.secret), false);
      failOnce('start'); return response({ ...START, intervalMs: 2000, expiresInMs: 300000 });
    }
    if (path === '/api/auth/bridge/pair/poll') {
      credentialReplies++;
      assert.deepEqual(body, { deviceCode: DEVICE_CODE, localPort: LOCAL_PORT });
      failOnce('credentials');
      return response({ ...APPROVED, ...(options.wrongOwner ? { ownerId: '619f68a6-77c1-49f6-ae2d-c5fa169d284b' } : {}), pendingApproval: approvedResult });
    }
    assert.equal(path, `/api/security/approvals/${request.requestId}/candidate`);
    assert.equal(body.candidateToken, Buffer.alloc(32, 9).toString('base64url'));
    if (body.action.type === 'read') {
      if (options.swapOffer && pinnedHello) {
        const changed = await pendingCrypto.createPendingOffer(request, browser, signing, initialHistory);
        return response({ request, revision: state.revision + 1, status: 'offered', offer: changed.offer });
      }
      if (options.renew && state.status === 'approved' && approvedResult && now >= approvedResult.bundle.envelope.expiresAt) {
        renewals++;
        const renewed = await pendingCrypto.createPendingResult(browser, local, opened!, confirmation!, offerHash, history);
        state = { ...state, revision: state.revision + 1, result: renewed };
      }
      return response(state);
    }
    if (body.action.type === 'hello') {
      helloCalls++; assert.ok(pinnedOffer); assert.deepEqual(body.action.hello, pinnedHello, 'exact hello must be durable before HTTP');
      opened = await pendingCrypto.openPendingHello(browser, local, body.action.hello);
      state = { request, revision: state.revision + 1, status: 'comparing', offer: local.offer, hello: body.action.hello,
        reveal: { offerHash, contribution: local.contribution } };
      failOnce('hello'); return response(state);
    }
    if (body.action.type === 'confirm') {
      confirmCalls++;
      if (options.rejectAfterConfirm) {
        await pendingCrypto.verifyPendingConfirmation(local.offer, opened!, { offerHash, contribution: local.contribution }, body.action.confirmation);
        state = { request, revision: state.revision + 1, status: 'confirmed', offer: local.offer, hello: pinnedHello!,
          reveal: { offerHash, contribution: local.contribution }, confirmation: body.action.confirmation };
        // Hold trusted finalization, then deliver a local reject after the valid candidate MAC is committed.
        rejectAfterConfirmation?.();
      } else await finish(body.action.confirmation);
      failOnce('confirm'); return response(state);
    }
    if (body.action.type === 'cancel') { cancellations++; state = { request, revision: state.revision + 1, status: 'cancelled' }; return response(state); }
    throw new Error('Unexpected candidate action');
  };
  const context = {
    identity: candidate, request, candidateToken: Buffer.alloc(32, 9).toString('base64url'), signal: AbortSignal.timeout(5000),
    pinOffer: async (offer: PendingOfferLocal['offer']) => { assert.equal(pinnedOffer, false); assert.deepEqual(offer, local.offer); pinnedOffer = true; },
    pinHello: async (hello: PendingHello) => { assert.equal(pinnedHello, undefined); pinnedHello = hello; },
    onLocalStatus: async (status: PendingBridgeStatus) => {
      statuses.push(status);
      if (status.phase === 'confirming') { assert.equal(status.offerHash, offerHash); localConfirmed = true; }
    },
    waitForLocalDecision: async (status: PendingBridgeStatus, signal: AbortSignal): Promise<PendingBridgeDecision> => {
      const common = { version: 1 as const, requestId: status.requestId, processNonce: status.processNonce, expiresAt: status.expiresAt };
      if (options.localReject) return { ...common, decision: 'reject', offerHash: status.offerHash };
      if (status.phase === 'comparing' && !options.unconfirmed) return { ...common, decision: 'confirm', offerHash: status.offerHash, comparisonCode: status.comparisonCode };
      if (status.phase === 'confirming') {
        confirmingWatches++;
        if (options.rejectAfterConfirm) return new Promise(resolve => {
          rejectAfterConfirmation = () => resolve({ ...common, decision: 'reject', offerHash: status.offerHash });
        });
      }
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  };
  const run = () => runPairing({ apiUrl: API, bridgeId: 'bridge-pending', hostname: 'Computer', platform: 'linux', localPort: LOCAL_PORT,
    localNonce: LOCAL_NONCE, accountHint: ' USER@Example.com ', pending: context, fetchImpl,
    sleepImpl: async () => { if (options.unconfirmed && statuses.some(status => status.phase === 'comparing')) now += 300001; }, log: value => log.push(value) });
  return { run, candidate, context, fetchImpl, log, statuses, startBodies,
    localDecisionCounts: () => ({ confirmingWatches, cancellations }),
    counters: () => ({ credentialReplies, startCalls, helloCalls, confirmCalls, freshReads, renewals }) };
}
test('pending bridge uses both local confirmations and fresh authenticated history; returns current verified trust, never a raw bundle grant', async t => {
  const f = await pendingHarness(t, { advanceHistory: true });
  const result = await f.run();
  assert.equal(result.approvalMethod, 'pending-v1'); assert.equal(result.verifiedAccountTrust?.checkpoint.revision, 2);
  assert.equal(result.verifiedAccountTrust?.checkpoint.bridges.find(bridge => bridge.bridgeId === 'bridge-pending')?.endpoint.publicKey, f.candidate.endpoint.publicKey);
  assert.ok(result.lastServerReadAt); assert.ok(f.statuses.some(status => status.phase === 'confirming'));
  assert.equal(f.statuses.at(-1)?.phase, 'approved');
  for (const secret of [f.context.candidateToken, DEVICE_CODE, APPROVED.token, APPROVED.refreshToken]) assert.equal(f.log.join('\n').includes(secret), false);
});
test('lost create, hello, confirmation and credential responses retry without regenerating the pinned ceremony', async t => {
  const f = await pendingHarness(t, { loseReplies: true }); const result = await f.run();
  assert.equal(result.approvalMethod, 'pending-v1');
  assert.deepEqual(f.startBodies[0], f.startBodies[1]);
  assert.deepEqual(f.counters(), { credentialReplies: 2, startCalls: 2, helloCalls: 1, confirmCalls: 1, freshReads: 1, renewals: 0 });
});
test('expired delivery renews through candidate RPC after credentials were consumed, with no extra credential poll', async t => {
  const f = await pendingHarness(t, { renew: true }); const result = await f.run();
  assert.equal(result.approvalMethod, 'pending-v1'); assert.equal(f.counters().credentialReplies, 1);
  assert.equal(f.counters().freshReads, 2); assert.equal(f.counters().renewals, 1);
});
test('current revoked bridge and mismatched immutable credential owner fail closed', async t => {
  const f = await pendingHarness(t, { revoked: true }); await assert.rejects(f.run(), { code: 'account_bridge_revoked' });
  assert.notEqual(f.statuses.at(-1)?.phase, 'approved');
});
test('credential owner must match proof-bound account owner', async t => {
  const f = await pendingHarness(t, { wrongOwner: true }); await assert.rejects(f.run(), { code: 'account_enrollment_invalid' });
});
test('relay cannot swap reviewer offer or bypass the candidate local action', async t => {
  const f = await pendingHarness(t, { swapOffer: true }); await assert.rejects(f.run(), { code: 'account_trust_conflict' });
  assert.equal(f.counters().confirmCalls, 0); assert.equal(f.counters().credentialReplies, 0);
});
test('no local comparison action means no MAC, credential consumption or trust', async t => {
  const f = await pendingHarness(t, { unconfirmed: true }); await assert.rejects(f.run(), { code: 'account_enrollment_expired' });
  assert.equal(f.counters().confirmCalls, 0); assert.equal(f.counters().credentialReplies, 0);
});
test('local rejection before offer stops without publishing hello or consuming credentials', async t => {
  const f = await pendingHarness(t, { localReject: true }); await assert.rejects(f.run(), /cancelled locally/);
  assert.equal(f.counters().helloCalls, 0); assert.equal(f.counters().credentialReplies, 0);
  assert.equal(f.statuses.at(-1)?.phase, 'cancelled');
});
test('local rejection after candidate confirmation cancels the held approval before credentials or verified trust', async t => {
  const f = await pendingHarness(t, { rejectAfterConfirm: true });
  await assert.rejects(f.run(), /cancelled locally/);
  assert.equal(f.counters().confirmCalls, 1, 'the original confirmation is submitted once');
  assert.equal(f.counters().credentialReplies, 0);
  assert.equal(f.counters().freshReads, 0);
  assert.deepEqual(f.localDecisionCounts(), { confirmingWatches: 1, cancellations: 1 });
  assert.equal(f.statuses.at(-1)?.phase, 'cancelled');
  assert.equal(f.statuses.some(status => status.phase === 'approved'), false);
});
test('pending HTTP forbids redirects, oversize or malformed bodies, and untrusted origins', async t => {
  const f = await pendingHarness(t);
  const run = (response: Response, apiUrl = API) => runPairing({ apiUrl, bridgeId: 'bridge-pending', hostname: 'Computer', platform: 'linux', localPort: LOCAL_PORT,
    localNonce: LOCAL_NONCE, accountHint: 'user@example.com', pending: f.context, fetchImpl: async () => response, log: () => {} });
  await assert.rejects(run(new Response(null, { status: 302, headers: { Location: 'https://attacker.test/' } })), { code: 'account_enrollment_invalid' });
  await assert.rejects(run(new Response('x'.repeat(65537))), { code: 'account_capacity_exceeded' });
  await assert.rejects(run(new Response('not json SECRET')), { code: 'account_enrollment_invalid' });
  await assert.rejects(run(new Response('{}'), 'http://attacker.test'), { code: 'invalid_account_trust' });
});
test('lifetime abort covers a stalled response body and prevents a late result', async t => {
  const f = await pendingHarness(t); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Local cancellation')), 20); t.after(() => clearTimeout(timer));
  await assert.rejects(runPairing({ apiUrl: API, bridgeId: 'bridge-pending', hostname: 'Computer', platform: 'linux', localPort: LOCAL_PORT,
    localNonce: LOCAL_NONCE, accountHint: 'user@example.com', pending: { ...f.context, signal: controller.signal },
    fetchImpl: async () => new Response(new ReadableStream({ start() { /* Deliberately never produces a body chunk. */ } })), log: () => {} }), /Local cancellation/);
  assert.notEqual(f.statuses.at(-1)?.phase, 'approved');
});
test('15-second request deadline includes stalled body parsing, then retries only the retained request', async t => {
  const f = await pendingHarness(t); const controller = new AbortController();
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; }); let backoffs = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = runPairing({ apiUrl: API, bridgeId: 'bridge-pending', hostname: 'Computer', platform: 'linux', localPort: LOCAL_PORT,
    localNonce: LOCAL_NONCE, accountHint: 'user@example.com', pending: { ...f.context, signal: controller.signal },
    fetchImpl: async () => { started(); return new Response(new ReadableStream({ start() {} })); },
    sleepImpl: async () => { backoffs++; controller.abort(new Error('Observed bounded retry')); }, log: () => {} });
  await ready; t.mock.timers.tick(15000);
  await assert.rejects(running, /Observed bounded retry/); assert.equal(backoffs, 1);
  assert.notEqual(f.statuses.at(-1)?.phase, 'approved');
});
