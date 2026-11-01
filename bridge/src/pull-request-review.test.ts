import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrReviewService, runReviewGh, type GhReviewRunner } from './pull-request-review.js';
import { PR_REVIEW_CHUNK_BYTES, PR_REVIEW_MAX_DIFF_BYTES } from './pull-request-review-protocol.js';
import { prReviewGeneration, toWireSession } from './session-wire.js';
import { classifyCommand } from './security/bridge/permissions.js';
import { createCommandHandler } from './command-rpc.js';
import type { Session, CommandResponse, Command } from './types.js';
import type { VerifiedPrincipal, VerifiedApplication } from './security/protocol.js';
import type { BridgeSecurityService } from './security/bridge/security.js';
import type { SessionController } from './session-controller.js';

const url = 'https://github.com/example/repo/pull/3';
const fixture = (): Session => ({ id: 'session', name: 'test', command: '', status: 'running', bridgeId: 'bridge', createdAt: '', updatedAt: '', pullRequestUrl: url, pullRequestLinkId: 'link' });
const principal = (): VerifiedPrincipal => ({ endpoint: { version: 1, id: 'browser', ownerId: 'owner', kind: 'browser', publicKey: 'public' }, bridgeId: 'bridge', permissions: ['read'], policyGeneration: 1, grantId: null });
const request = () => ({ bridgeId: 'bridge', sessionId: 'session', linkGeneration: prReviewGeneration('link') });
const metadata = (change: Record<string, unknown> = {}) => ({ title: '<img onerror=alert(1)>', body: '<script>untrusted</script>', user: { login: 'author' }, state: 'open', merged_at: null, base: { ref: 'main', sha: 'a'.repeat(40) }, head: { ref: 'feature', sha: 'b'.repeat(40) }, additions: 1, deletions: 2, changed_files: 1, ...change });
const ok = (s: string | Buffer) => ({ stdout: Buffer.from(s), stderr: Buffer.alloc(0), exitCode: 0 });
const runner = (diff: string | Buffer = 'diff --git a/x b/x\n+hello\n', data = metadata()): GhReviewRunner => async args => ok(args.includes('Accept: application/vnd.github.v3.diff') ? diff : JSON.stringify(data));
const make = (opts: { run?: GhReviewRunner; clock?: () => number } = {}) => {
  let session: Session | null = fixture(), revoked = false;
  const service = createPrReviewService({ bridgeId: 'bridge', loadSession: async () => session, revalidate: async () => { if (revoked) throw new Error('private secret'); }, runner: opts.run ?? runner(), now: opts.clock });
  return { service, setSession: (s: Session | null) => { session = s; }, revoke: () => { revoked = true; } };
};

test('wire generation is derived, link ID and all private fields never escape', () => {
  const s = { ...fixture(), env: { secret: 'token' }, previewSource: { version: 1 as const, id: 'id', root: '/secret', filePath: '/secret/file' }, pullRequestReviewGeneration: 'untrusted' };
  const wire = toWireSession(s);
  assert.equal(wire.pullRequestReviewGeneration, createHash('sha256').update('ftown-pr-review:link').digest('hex'));
  assert(!('env' in wire) && !('previewSource' in wire) && !('pullRequestLinkId' in wire));
  assert.equal(s.pullRequestLinkId, 'link');
  assert.equal(toWireSession({ ...s, pullRequestUrl: undefined }).pullRequestReviewGeneration, undefined);
  assert.equal(toWireSession({ ...s, pullRequestLinkId: undefined }).pullRequestReviewGeneration, undefined);
});

test('metadata is bounded text and valid multibyte bytes survive aligned chunks', async () => {
  const bytes = Buffer.from('a'.repeat(PR_REVIEW_CHUNK_BYTES - 1) + '€ end'); const args: string[][] = [];
  const { service } = make({ run: async (a, signal) => { args.push(a); return runner(bytes)(a, signal); } });
  const p = principal(), r = request(), result = await service.get(p, r);
  assert.equal(result.state, 'ready'); if (result.state !== 'ready') return;
  assert.equal(result.metadata.title, '<img onerror=alert(1)>'); assert.equal(result.metadata.body, '<script>untrusted</script>');
  assert.equal(result.revision, createHash('sha256').update(bytes).digest('hex')); assert.equal(result.totalBytes, bytes.length);
  const a = await service.chunk(p, { ...r, revision: result.revision, offset: 0 });
  const b = await service.chunk(p, { ...r, revision: result.revision, offset: PR_REVIEW_CHUNK_BYTES });
  assert.equal(a.state, 'chunk'); assert.equal(b.state, 'chunk');
  if (a.state === 'chunk' && b.state === 'chunk') { assert.equal(a.done, false); assert.equal(b.done, true); assert.deepEqual(Buffer.concat([Buffer.from(a.dataBase64, 'base64'), Buffer.from(b.dataBase64, 'base64')]), bytes); }
  assert.equal(args.length, 3); for (const a of args) { assert.equal(a[0], 'api'); assert(a.includes('github.com')); assert.equal(a.at(-1), 'repos/example/repo/pulls/3'); }
});

test('empty diff, invalid offset, expiry and endpoint/policy isolation', async () => {
  let now = 1000; const { service } = make({ run: runner(''), clock: () => now }); const p = principal(), r = request();
  const result = await service.get(p, r); assert.equal(result.state, 'ready'); if (result.state !== 'ready') return;
  assert.deepEqual(await service.chunk(p, { ...r, revision: result.revision, offset: 0 }), { state: 'chunk', revision: result.revision, totalBytes: 0, offset: 0, dataBase64: '', done: true });
  assert.equal((await service.chunk(p, { ...r, revision: result.revision, offset: 1 })).state, 'unavailable');
  assert.equal((await service.chunk({ ...p, endpoint: { ...p.endpoint, id: 'other' } }, { ...r, revision: result.revision, offset: 0 })).state, 'stale_revision');
  assert.equal((await service.chunk({ ...p, policyGeneration: 2 }, { ...r, revision: result.revision, offset: 0 })).state, 'stale_revision');
  now += 60_000; assert.equal((await service.chunk(p, { ...r, revision: result.revision, offset: 0 })).state, 'stale_revision');
});

test('link and authorization fences prevent old results during fetch or chunk', async () => {
  let release!: () => void, started!: () => void; const waiting = new Promise<void>(r => { release = r; }); const begun = new Promise<void>(r => { started = r; }); let calls = 0;
  const x = make({ run: async (args, signal) => { if (++calls === 2) { started(); await waiting; } return runner()(args, signal); } });
  const pending = x.service.get(principal(), request()); await begun; x.setSession({ ...fixture(), pullRequestLinkId: 'new-link' }); release();
  assert.deepEqual(await pending, { state: 'unavailable', reason: 'stale' });
  const y = make(); const result = await y.service.get(principal(), request()); assert.equal(result.state, 'ready'); if (result.state !== 'ready') return;
  y.revoke(); assert.deepEqual(await y.service.chunk(principal(), { ...request(), revision: result.revision, offset: 0 }), { state: 'unavailable', reason: 'unavailable' });
  const z = make(); z.setSession({ ...fixture(), pullRequestLinkId: undefined }); assert.deepEqual(await z.service.get(principal(), request()), { state: 'unavailable', reason: 'stale' });
});

test('untrusted inputs and upstream errors fail closed without exposing raw error text', async () => {
  const x = make(); const p = principal();
  assert.equal((await x.service.get({ ...p, endpoint: { ...p.endpoint, kind: 'mcp' } }, request())).state, 'unavailable');
  assert.equal((await x.service.get({ ...p, permissions: [] }, request())).state, 'unavailable');
  assert.equal((await x.service.get({ ...p, bridgeId: 'else' }, request())).state, 'unavailable');
  x.setSession({ ...fixture(), pullRequestUrl: 'https://github.com/example/repo/pull/3;touch' }); assert.deepEqual(await x.service.get(p, request()), { state: 'unavailable', reason: 'unavailable' });
  for (const [err, reason] of [['HTTP 401 token SECRET authentication', 'unauthenticated'], ['HTTP 429 SECRET rate limit', 'rate_limited'], ['HTTP 404 SECRET', 'not_found_or_forbidden'], ['SECRET arbitrary', 'unavailable']] as const) {
    const service = make({ run: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from(err), exitCode: 1 }) }).service;
    assert.deepEqual(await service.get(p, request()), { state: 'unavailable', reason });
  }
  for (const [run, reason] of [[runner(Buffer.alloc(PR_REVIEW_MAX_DIFF_BYTES + 1)), 'too_large'], [runner(Buffer.from([0xff])), 'unsupported'], [runner('ok', metadata({ title: 'x'.repeat(1025) })), 'too_large'], [runner('ok', metadata({ state: 'surprise' })), 'unavailable']] as const) {
    assert.deepEqual(await make({ run }).service.get(p, request()), { state: 'unavailable', reason });
  }
  let index = 0; const changed: GhReviewRunner = async a => { index++; return ok(a.includes('Accept: application/vnd.github.v3.diff') ? 'patch' : JSON.stringify(metadata(index === 3 ? { head: { ref: 'x', sha: 'c'.repeat(40) } } : {}))); };
  assert.deepEqual(await make({ run: changed }).service.get(p, request()), { state: 'unavailable', reason: 'stale' });
});

test('coalesces same request and rejects a third active fetch without queuing', async () => {
  let release!: () => void; const wait = new Promise<void>(r => { release = r; }); let calls = 0;
  const service = make({ run: async (a, s) => { calls++; if (calls <= 2) await wait; return runner()(a, s); } }).service;
  const p = principal(); const a = service.get(p, request()), same = service.get(p, request());
  const second = service.get({ ...p, endpoint: { ...p.endpoint, id: 'other' } }, request());
  await new Promise(r => setImmediate(r));
  const third = await service.get({ ...p, endpoint: { ...p.endpoint, id: 'third' } }, request()); assert.deepEqual(third, { state: 'unavailable', reason: 'unavailable' });
  release(); const results = await Promise.all([a, same, second]); assert(results.every(x => x.state === 'ready')); assert.equal(calls, 6);
});

test('review commands classify as session-scoped reads and adapter denies MCP and extra fields', async () => {
  assert.deepEqual(classifyCommand('get_pull_request_review', { sessionId: 'session' }), { permission: 'read', mutating: false, operation: 'get_pull_request_review', sessionId: 'session' });
  assert.throws(() => classifyCommand('get_pull_request_review', {}));
  const responses: CommandResponse[] = []; let calls = 0;
  const security = { revalidate: async () => {}, policy: { revalidate: async () => {} } } as unknown as BridgeSecurityService;
  const fake = { get: async () => { calls++; return { state: 'unavailable' as const, reason: 'unlinked' as const }; }, chunk: async () => ({ state: 'stale_revision' as const }) };
  const handler = createCommandHandler({ bridgeId: 'bridge', security, sessionController: { get: async () => fixture() } as unknown as SessionController, pullRequestReview: fake, publishCommandResponse: async r => { responses.push(r); } });
  const command: Command = { type: 'get_pull_request_review', requestId: 'id', payload: request() };
  await handler(command, { principal: principal() } as VerifiedApplication); assert.equal(responses.at(-1)?.success, true); assert.equal(calls, 1);
  await handler({ ...command, payload: { ...request(), url } }, { principal: principal() } as VerifiedApplication); assert.equal(responses.at(-1)?.success, false); assert.equal(calls, 1);
  await handler(command, { principal: { ...principal(), endpoint: { ...principal().endpoint, kind: 'mcp' } } } as VerifiedApplication); assert.equal(responses.at(-1)?.success, false); assert.equal(calls, 1);
  await handler(command); assert.equal(responses.at(-1)?.success, false); assert.equal(calls, 1);
});

test('real gh runner aborts and kills on output overflow without leaking data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-review-test-')); const path = process.env.PATH;
  try {
    await writeFile(join(dir, 'gh'), `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(1400000)); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    process.env.PATH = dir;
    await assert.rejects(runReviewGh(['api'], new AbortController().signal), (e: Error) => e.message === 'too_large');
    const c = new AbortController(); c.abort(); await assert.rejects(runReviewGh(['api'], c.signal), (e: Error) => e.message === 'timeout');
  } finally { process.env.PATH = path; await rm(dir, { recursive: true, force: true }); }
});

test('in-flight revocation and relinking at adapter release do not return content', async () => {
  let release!: () => void, started!: () => void; const wait = new Promise<void>(r => { release = r; }); const begun = new Promise<void>(r => { started = r; }); let calls = 0;
  const x = make({ run: async (a, s) => { if (++calls === 2) { started(); await wait; } return runner()(a, s); } });
  const pending = x.service.get(principal(), request()); await begun; x.revoke(); release();
  assert.deepEqual(await pending, { state: 'unavailable', reason: 'unavailable' });
  const responses: CommandResponse[] = [];
  const security = { revalidate: async () => {}, policy: { revalidate: async () => {} } } as unknown as BridgeSecurityService;
  const ready = await make().service.get(principal(), request()); assert.equal(ready.state, 'ready');
  const fake = { get: async () => ready, chunk: async () => ({ state: 'stale_revision' as const }) };
  const handler = createCommandHandler({ bridgeId: 'bridge', security, sessionController: { get: async () => ({ ...fixture(), pullRequestLinkId: 'relinked' }) } as unknown as SessionController, pullRequestReview: fake, publishCommandResponse: async r => { responses.push(r); } });
  await handler({ type: 'get_pull_request_review', requestId: 'id', payload: request() }, { principal: principal() } as VerifiedApplication);
  assert.deepEqual(responses[0].data, { state: 'unavailable', reason: 'stale' });
});

test('snapshots are evicted at four and never shared between sessions', async () => {
  const service = createPrReviewService({ bridgeId: 'bridge', loadSession: async id => ({ ...fixture(), id }), revalidate: async () => {}, runner: runner() });
  const p = principal(), results = [];
  for (let i = 0; i < 5; i++) results.push(await service.get(p, { ...request(), sessionId: `session${i}` }));
  const first = results[0], last = results[4]; assert.equal(first.state, 'ready'); assert.equal(last.state, 'ready');
  if (first.state === 'ready' && last.state === 'ready') {
    assert.equal((await service.chunk(p, { ...request(), sessionId: 'session0', revision: first.revision, offset: 0 })).state, 'stale_revision');
    assert.equal((await service.chunk(p, { ...request(), sessionId: 'session4', revision: last.revision, offset: 0 })).state, 'chunk');
    assert.equal((await service.chunk(p, { ...request(), sessionId: 'unknown', revision: last.revision, offset: 0 })).state, 'stale_revision');
  }
});

test('running gh process is killed on cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-review-abort-')); const path = process.env.PATH;
  try {
    await writeFile(join(dir, 'gh'), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 }); process.env.PATH = dir;
    const controller = new AbortController(); const pending = runReviewGh(['api'], controller.signal); controller.abort();
    await assert.rejects(pending, (e: Error) => e.message === 'timeout');
  } finally { process.env.PATH = path; await rm(dir, { recursive: true, force: true }); }
});
