#!/usr/bin/env node
// Root-only process smoke. Synthetic setup/replacement; no registry or user HOME.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bridge = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const handoff = pathToFileURL(join(bridge, 'dist', 'update-handoff.js')).href;
const root = await realpath(await mkdtemp(join(tmpdir(), 'ftown-update-smoke-')));
async function waitForReceipt(home, expected) {
  const path = join(home, '.ftown', 'updates', 'operation.json'); const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const r = JSON.parse(await readFile(path, 'utf8')); if (r.operation.phase === expected) return r; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Expected ${expected} receipt`);
}
async function run(mode) {
  const home = join(root, mode); await mkdir(home, { mode: 0o700 });
  const installed = `import { reportUpdateReady } from ${JSON.stringify(handoff)};\n${mode === 'ready-fail' ? 'process.exit(1);' : "await reportUpdateReady({version:'0.19.58',bridgeId:'smoke-bridge',ownerId:'smoke-owner',endpointId:'smoke-endpoint'});process.exit(0);"}`;
  const fixture = `import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
if (process.argv[2] !== 'setup') process.exit(2);
const home = process.env.HOME; await writeFile(join(home,'setup-started'),'yes');
${mode === 'setup-fail' ? 'process.exit(1);' : ''}
const dir=join(home,'.ftown','cli','dist'); await mkdir(dir,{recursive:true,mode:0o700});
await writeFile(join(home,'.ftown','cli','package.json'),JSON.stringify({type:'module',version:'0.19.58',ftownUpdateProtocol:1}));
await writeFile(join(dir,'ftown-cli.js'),${JSON.stringify(installed)});`;
  const source = `import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reserveUpdate, writeUpdateReceipt, prepareHandoff } from ${JSON.stringify(handoff)};
const home=process.env.HOME, op=randomUUID(), root=join(home,'.ftown','updates'), job=join(root,op);
const packageRoot=join(job,'install','node_modules','ftown'), packageEntry=join(packageRoot,'dist','ftown-cli.js');
await mkdir(join(packageRoot,'dist'),{recursive:true,mode:0o700});
await writeFile(join(job,'owner.json'),JSON.stringify({operationId:op,version:'0.19.58'}),{mode:0o600});
await writeFile(packageEntry,${JSON.stringify(fixture)});
const reservation=await reserveUpdate(home,op);
await writeUpdateReceipt(root,{schema:1,bridgeId:'smoke-bridge',operation:{id:op,targetVersion:'0.19.58',phase:'prepared',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),error:null}});
const prepared={protocol:1,operationId:op,targetVersion:'0.19.58',jobDir:job,packageRoot,packageEntry};
const restart={mode:'local',home,dataDir:join(home,'.ftown','data'),cwd:home,apiUrl:'http://localhost:3000',bridgeId:'smoke-bridge',ownerId:'smoke-owner',endpointId:'smoke-endpoint'};
const h=await prepareHandoff(prepared,restart,new AbortController().signal);
if (${JSON.stringify(mode)}==='cancel') { await h.cancel(); await reservation.release(); await new Promise((ok,fail)=>process.send({type:'cancelled'},e=>e?fail(e):ok())); process.exit(0); }
await h.commit();
try { await access(join(home,'setup-started')); throw new Error('setup began before old exit'); } catch(e) { if(e.code!=='ENOENT') throw e; }
const helperPid=JSON.parse(await readFile(join(home,'.ftown','update-reservation.json'),'utf8')).ownerPid;
await new Promise((ok,fail)=>process.send({type:'committed',op,helperPid},e=>e?fail(e):ok())); process.exit(0);`;
  const controller = join(home, 'controller.mjs'); await writeFile(controller, source, { mode: 0o600 });
  const child = fork(controller, [], { cwd: home, env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const message = await new Promise((ok, fail) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('controller timeout')); }, 20_000);
    child.once('message', m => { clearTimeout(timer); ok(m); });
    child.once('exit', code => { if (code !== 0) { clearTimeout(timer); fail(new Error('controller failed')); } });
  });
  if (mode === 'cancel') { assert.equal(message.type, 'cancelled'); await assert.rejects(readFile(join(home,'setup-started'))); }
  else {
    assert.equal(message.type, 'committed'); const receipt = await waitForReceipt(home, mode === 'success' ? 'succeeded' : 'failed'); assert.equal(receipt.operation.id, message.op);
    const deadline = Date.now() + 20_000; let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(message.helperPid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
      if (alive) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(alive, false, 'owned helper must exit before cleanup');
  }
  console.log(`${mode}: passed`);
}
try { for (const mode of ['cancel', 'success', 'setup-fail', 'ready-fail']) await run(mode); }
finally { await rm(root, { recursive: true, force: true }); }
