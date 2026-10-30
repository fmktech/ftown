// Root-only, after `cd bridge && npm run build`, from repo root:
// PATH=/Users/fkesheh/.nvm/versions/node/v24.22.1/bin:$PATH node --experimental-strip-types docs/investigations/pr-agent-events/runtime-smoke.ts
// Scratch files, fake gh executable, no GitHub/network or production sessions.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = process.cwd(), dir = await mkdtemp(join(tmpdir(), 'ftown-pr-events-runtime-'));
const bin = join(dir, 'bin'), data = join(dir, 'data'), stateFile = join(dir, 'gh-state.json'), entered = join(dir, 'entered'), release = join(dir, 'release');
const oldPath = process.env.PATH, oldState = process.env.FTOWN_PR_FIXTURE_STATE;
let watcher, server, security;
try {
  await mkdir(bin); await mkdir(data);
  const gh = `#!/usr/bin/env node
const fs = require('fs');
let input=''; process.stdin.on('data',chunk=>input+=chunk); process.stdin.on('end',()=>{
 const config=JSON.parse(fs.readFileSync(process.env.FTOWN_PR_FIXTURE_STATE,'utf8'));
 const answer=()=>{const query=JSON.parse(input).query; const ids=[...query.matchAll(/r(\\d+): repository/g)].map(m=>m[1]); const pr=config.state==='merged'?{state:'MERGED',merged:true}:{state:'OPEN',merged:false,headRefOid:config.head,commits:{nodes:[{commit:{oid:config.head,statusCheckRollup:{state:config.state,contexts:{totalCount:1}}}}]}}; const data=Object.fromEntries(ids.map(id=>['r'+id,{pullRequest:pr}])); data.rateLimit={remaining:5000};process.stdout.write(JSON.stringify({data}));};
 if(config.hold){fs.writeFileSync(config.entered,'ready');const timer=setInterval(()=>{if(fs.existsSync(config.release)){clearInterval(timer);answer();}},10);}else answer();
});`;
  await writeFile(join(bin, 'gh'), gh); await chmod(join(bin, 'gh'), 0o700);
  process.env.PATH = `${bin}:${oldPath ?? ''}`; process.env.FTOWN_PR_FIXTURE_STATE = stateFile;
  const module = async name => import(pathToFileURL(resolve(root, `bridge/dist/${name}.js`)).href);
  const { SessionStore } = await module('session-store');
  const { SessionController } = await module('session-controller');
  const { MailStore } = await module('mail-store');
  const { LocalApiServer } = await module('local-api-server');
  const { generateEndpoint } = await module('security/crypto');
  const { BridgeSecurityService } = await module('security/bridge/security');
  const { loadOrCreateIdentity } = await module('security/bridge/identity');
  const { fetchInbox } = await module('cli-client');
  const { PullRequestStatusService } = await module('pull-request-status');
  const { PullRequestEventWatcher } = await module('pull-request-events');
  const store = new SessionStore(data), mail = new MailStore(id => store.sessionDir(id));
  const locks = new Map();
  const lock = async (id, fn) => { const previous = locks.get(id) ?? Promise.resolve(); const next = previous.then(fn); locks.set(id, next.catch(() => {})); await next; };
  const running = new Set(['fixture']); const writes = [];
  const runner = Object.assign(new EventEmitter(), { isRunning: id => running.has(id), write: (id, text) => { writes.push([id, text]); return true; }, stop: () => false });
  const controller = new SessionController({ store, runner, withSessionWrite: lock, publishSessionUpdate: async () => {}, removeSession: async id => { const value = await store.loadSession(id); await store.deleteSession(id); return value; } });
  const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
  const identity = await generateEndpoint(owner, 'bridge');
  security = new BridgeSecurityService(identity, 'bridge', data, { relayUserId: 'smoke@example.test' });
  const cliIdentity = await loadOrCreateIdentity(data, owner, 'local-cli');
  await security.policy.provisionLocalEndpoint(cliIdentity.endpoint);
  server = new LocalApiServer(); server.setAuthToken('fixture-token');
  server.setDependencies(store, runner, {}, 'smoke@example.test'); server.setMailStore(mail); server.setSessionController(controller);
  server.setSecurity(security, { protocolVersion: 1, ownerId: owner, bridgeId: 'bridge', endpoint: identity.endpoint, relayUserId: 'smoke@example.test' }, async () => null);
  const port = await server.start();
  const pointer = { port, token: 'fixture-token', dataDir: data, ownerId: owner, endpoint: identity.endpoint, bridgeId: 'bridge' };
  await writeFile(join(data, 'bridge.json'), JSON.stringify(pointer));
  const run = promisify(execFile);
  const status = await run(process.execPath, [resolve(root, 'bridge/dist/harness-cli.js'), 'status'], { env: { ...process.env, HOME: dir, USERPROFILE: dir, FTOWN_DATA_DIR: data }, timeout: 15_000 });
  assert.match(status.stdout, /bridge:\s+up/);
  let now = Date.parse('2026-01-01T00:00:00Z');
  const statuses = new PullRequestStatusService(() => now);
  const createWatcher = () => new PullRequestEventWatcher({ bridgeId:'bridge', store, withSessionMutation:lock, statusService:statuses, mailStore:mail, notifyCommitted:(s, from)=>server.notifyCommittedMail(s, from, true), now:()=>now });
  const session = { id:'fixture', name:'Fixture', command:'agent', status:'running', bridgeId:'bridge', shellType:'claude', parentSessionId:'parent', createdAt:new Date(now).toISOString(), updatedAt:new Date(now).toISOString() };
  await store.saveSession(session);
  await controller.update('fixture', { pullRequestUrl:'https://github.com/example/repo/pull/1' });
  watcher = createWatcher();
  const set = value => writeFile(stateFile, JSON.stringify(value));
  await set({state:'FAILURE',head:'head-one'});
  const inbox = fetchInbox(pointer, 'fixture', { wait:20, signal:AbortSignal.timeout(15_000) });
  void inbox.catch(() => {});
  // Wait until the real encrypted HTTP request is parked before producing the event.
  const waiterDeadline = Date.now() + 10_000;
  while (!server.mail.mailWaiters.has('fixture')) {
    if (Date.now() >= waiterDeadline) throw new Error('encrypted inbox long poll was not installed');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await watcher.runOnce();
  const delivered = await inbox; assert.equal(delivered.length, 1); assert.match(delivered[0].body, /rollup checks failed/);
  assert.equal(delivered[0].deliveredVia, 'poll');
  assert.equal((await mail.listAll('fixture', 0)).length, 1);
  await watcher.runOnce(); assert.equal((await mail.listAll('fixture', 0)).length, 1);
  now += 300_000; await set({state:'PENDING',head:'head-one'}); await watcher.runOnce();
  now += 60_000; await set({state:'SUCCESS',head:'head-one'}); await watcher.runOnce();
  now += 300_000; await set({state:'merged',head:'head-one'}); await watcher.runOnce();
  assert.equal((await mail.listAll('fixture', 0)).length, 3);
  await watcher.stop(); watcher = createWatcher(); await watcher.runOnce();
  assert.equal((await mail.listAll('fixture', 0)).length, 3, 'restart must not duplicate');
  // A stopped linked agent receives durable mail without starting or waking it.
  await lock('fixture', async () => { const value = await store.loadSession('fixture'); value.status = 'completed'; await store.saveSession(value); });
  running.delete('fixture');
  await controller.update('fixture', { pullRequestUrl:'https://github.com/example/repo/pull/3' });
  now += 60_000; await set({state:'FAILURE',head:'stopped-head'}); await watcher.runOnce();
  assert.equal((await mail.listUndelivered('fixture')).length, 3);
  assert.equal(writes.length, 0); assert.equal(running.has('fixture'), false);
  // Fence a fetch while the link is cleared; fixture gh waits until released.
  await controller.update('fixture', { pullRequestUrl:'https://github.com/example/repo/pull/2' });
  now += 60_000; await set({state:'FAILURE',head:'head-two',hold:true,entered,release});
  const scan = watcher.runOnce();
  const deadline = Date.now() + 10_000;
  for (;;) { try { await access(entered); break; } catch { if (Date.now() >= deadline) throw new Error('fixture gh did not start'); await new Promise(resolve => setTimeout(resolve, 20)); } }
  await controller.update('fixture', { pullRequestUrl:null }); await writeFile(release, 'go'); await scan;
  assert.equal((await mail.listAll('fixture', 0)).length, 4, 'cleared link must fence in-flight event');
  // Exercise real status-service cache/fairness with >500 background URLs and continuous foreground churn.
  let fairNow = 1_000_000, launches = 0; const served = new Set();
  const fair = new PullRequestStatusService(() => fairNow, async input => {
    launches++;
    const ids = [...JSON.parse(input).query.matchAll(/pullRequest\(number: (\d+)\)/g)].map(match => Number(match[1]));
    ids.filter(id => id <= 501).forEach(id => served.add(id));
    const pr = { state:'OPEN', merged:false, headRefOid:'verified', commits:{nodes:[{commit:{oid:'verified',statusCheckRollup:{state:'PENDING',contexts:{totalCount:1}}}}]} };
    return { stdout:JSON.stringify({data:{...Object.fromEntries(ids.map((_, i)=>[`r${i}`,{pullRequest:pr}])),rateLimit:{remaining:5000}}}), stderr:'', exitCode:0 };
  });
  for (let start = 1; start <= 501; start += 20) {
    const group = Array.from({length:Math.min(20, 502-start)},(_,i)=>`https://github.com/example/repo/pull/${start+i}`);
    fair.setBackgroundUrls(group);
    let complete = false;
    for (let round = 0; round < 3 && !complete; round++) {
      const foreground = Array.from({length:25},(_,i)=>`https://github.com/example/repo/pull/${10000+launches*25+i}`);
      await fair.get(foreground);
      const result = await fair.getObservations(group);
      complete = result.observations.length === group.length && result.observations.every(item => item.attempt > 0);
      fairNow += 60_000;
    }
    if (!complete) throw new Error(`background group ${start} starved under foreground churn`);
    fair.setBackgroundUrls([]);
  }
  assert.equal(served.size, 501); assert.ok(launches <= 60);
  console.log('PASS: authenticated HTTP long-poll, task-owned harness status, stopped queue/no wake, status transitions, restart, unlink and 501-URL shared-cache fairness');
} finally {
  await writeFile(release, 'cleanup').catch(() => {});
  if (watcher) await watcher.stop();
  if (server) { server.getHttpServer()?.closeAllConnections(); server.stop(); }
  if (security) await security.close();
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  if (oldState === undefined) delete process.env.FTOWN_PR_FIXTURE_STATE; else process.env.FTOWN_PR_FIXTURE_STATE = oldState;
  await rm(dir, { recursive:true, force:true });
}
