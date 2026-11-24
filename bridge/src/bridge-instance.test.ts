import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireBridgeInstance } from './bridge-instance.js';
import { runStart } from './start-commands.js';

test('a competing process is refused until its data directory owner exits, including after a crash', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ftown-instance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'primary');
  const moduleUrl = new URL('./bridge-instance.ts', import.meta.url);
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { acquireBridgeInstance } from ${JSON.stringify(moduleUrl.href)};
    const lock = await acquireBridgeInstance(process.argv[1]);
    process.on('exit', () => lock.close());
    process.on('message', () => {});
    process.send('acquired');
  `, dataDir], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill('SIGKILL'); await exited; });
  assert.equal((await Promise.race([once(child, 'message'), exited]))[0], 'acquired');
  await assert.rejects(acquireBridgeInstance(dataDir), /already running/);
  // A duplicate launch must also refuse to replace the shared installation before
  // handing off to an updated bridge.
  await assert.rejects(runStart(['--data-dir=' + dataDir], {
    env: {}, version: () => '1.0.0', fetchLatest: async () => '2.0.0',
    assertReady: () => {}, loadBridge: async () => ({ runBridge: async () => assert.fail('unexpected launch') }),
    spawn: async () => assert.fail('unexpected setup'),
  }), /already running/);
  (await acquireBridgeInstance(join(root, 'independent'))).close();
  child.kill('SIGKILL');
  await exited;
  (await acquireBridgeInstance(dataDir)).close();
});

test('a previous release serving this data directory owns it while an unrelated listener on its old port does not', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ftown-instance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let identity = 'previous';
  const listener = createServer((req, res) => {
    assert.equal(req.url, '/api/security/info');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ protocolVersion: 1, bridgeId: identity }));
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => new Promise<void>(done => { listener.close(() => done()); listener.closeAllConnections(); }));
  await writeFile(join(root, 'local-api-port'), String((listener.address() as AddressInfo).port));
  await writeFile(join(root, 'bridge-id'), 'previous');
  await assert.rejects(acquireBridgeInstance(root), /already running/);
  identity = 'different';
  (await acquireBridgeInstance(root)).close();
});
