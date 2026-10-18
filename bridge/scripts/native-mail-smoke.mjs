#!/usr/bin/env node
/** Root-only runtime probe. No production credentials, homes or sessions are used.
 *   rtk proxy node bridge/scripts/native-mail-smoke.mjs --muse
 * Requires existing bridge dependencies (node-pty) and installed Muse Code.
 * Uses its deterministic echo provider; never calls a real model. All process
 * handles and files are owned here and cleaned in finally, including on signals.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, realpath, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function until(fn, label, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(50); }
  throw new Error(`Timed out: ${label}`);
}
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]))).flat();
}
async function executable(name) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const path = join(dir, name);
    try { return await realpath(path); } catch { /* next PATH entry */ }
  }
  throw new Error(`Missing ${name}`);
}
async function museBinary() {
  const launcher = process.env.FTOWN_MUSE_BINARY ?? await executable('muse');
  // Bypass the updater launcher so even update notices in the user's real
  // installation are untouched. An explicit native path is also accepted.
  const header = await readFile(launcher).then(data => data.subarray(0, 40).toString());
  if (!header.startsWith('#!')) return launcher;
  const version = (await readFile(join(dirname(launcher), '.muse-version'), 'utf8')).trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(?:\.[0-9]+)?$/.test(version)) throw new Error('Invalid installed Muse version marker');
  return realpath(join(dirname(launcher), `muse-bin-${version}`));
}
function command(file, args, env, cwd, input) {
  return new Promise(resolve => {
    const child = spawn(file, args, { env, cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10_000);
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 65_536) child.kill('SIGKILL'); });
    child.stderr.on('data', data => { stderr += data; if (stderr.length > 65_536) child.kill('SIGKILL'); });
    child.on('error', error => { stderr = error.code ?? 'spawn_error'; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function museProbe() {
  const root = await mkdtemp(join(tmpdir(), 'ftown-native-muse-'));
  const home = join(root, 'home'), cwd = join(root, 'workspace');
  await mkdir(home); await mkdir(cwd);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'),
    TERM: 'xterm-256color', LANG: 'en_US.UTF-8', MUSE_NO_AUTO_UPDATE: '1' };
  let receiver, ended = false, terminal = '';
  const cleanup = async () => {
    if (receiver && !ended) { receiver.kill('SIGTERM'); await pause(500); if (!ended) receiver.kill('SIGKILL'); }
    await rm(root, { recursive: true, force: true });
  };
  const interrupted = () => { void cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  try {
    const binary = await museBinary();
    const initial = `ftown-native-initial-${randomUUID()}`;
    receiver = pty.spawn(binary, ['--provider', 'echo', '--echo-delay-ms', '2000',
      '--workspace', cwd, '--trust-workspace', '--disable-shell', '--disable-write', initial],
      { env, cwd, name: 'xterm-256color', cols: 100, rows: 35 });
    receiver.onData(data => { terminal = (terminal + data).slice(-100_000); });
    receiver.onExit(() => { ended = true; });
    const log = await until(async () => (await files(home)).find(path => basename(path) === 'session.jsonl' && uuid.test(basename(dirname(path)))), 'scratch Muse session log');
    const sessionId = basename(dirname(log));
    // Echo has a fixed two-second run. Give the initial turn time to settle;
    // retained output is checked separately, never confuse CLI receipt with read.
    await until(async () => (await readFile(log, 'utf8')).includes(initial), 'initial prompt persisted');
    await pause(3_000);
    assert.equal(ended, false, 'scratch receiver stays live');
    const idle = `ftown-native-idle-${randomUUID()}`;
    const idleResult = await command(binary, ['session-message', 'send', '--target', sessionId, '--json'], env, cwd, idle);
    console.log(JSON.stringify({ probe: 'muse-idle-receipt', sessionId, ...idleResult }));
    const idleObserved = await until(async () => (await readFile(log, 'utf8')).includes(idle), 'idle native input persisted').then(() => true).catch(() => false);
    const busy = `ftown-native-busy-${randomUUID()}`;
    receiver.write(busy); await pause(700); receiver.write('\r');
    await until(async () => (await readFile(log, 'utf8')).includes(busy), 'busy prompt persisted');
    const queued = `ftown-native-during-busy-${randomUUID()}`;
    const busyResult = await command(binary, ['session-message', 'send', '--target', sessionId, '--json'], env, cwd, queued);
    console.log(JSON.stringify({ probe: 'muse-busy-receipt', sessionId, ...busyResult }));
    const busyObserved = await until(async () => (await readFile(log, 'utf8')).includes(queued), 'busy native input persisted').then(() => true).catch(() => false);
    console.log(JSON.stringify({ probe: 'muse-observation', idleObserved, busyObserved, sameSession: true,
      receiptIsNotConsumption: true, terminalTail: terminal.slice(-1_500) }));
    assert.equal(idleObserved, true, 'native idle submission must reach scratch receiver');
    assert.equal(busyObserved, true, 'native busy submission must reach scratch receiver');
  } catch (error) {
    console.error(JSON.stringify({ probe:'muse-failure', terminalTail:terminal.slice(-3_000), message:error.message }));
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
    await cleanup();
  }
}
async function codexProbe() {
  const root = await mkdtemp(join(tmpdir(), 'ftown-native-codex-'));
  const home = join(root, 'home'), cwd = join(root, 'workspace'), codexHome = join(home, '.codex');
  await mkdir(cwd); await mkdir(codexHome, { recursive:true });
  const env = { PATH:process.env.PATH ?? '/usr/bin:/bin', HOME:home, USERPROFILE:home, CODEX_HOME:codexHome,
    XDG_CONFIG_HOME:join(home,'.config'), XDG_DATA_HOME:join(home,'.local/share'),
    XDG_STATE_HOME:join(home,'.local/state'), XDG_CACHE_HOME:join(home,'.cache'),
    TERM:'xterm-256color', LANG:'en_US.UTF-8', FTOWN_PROBE_KEY:'scratch-no-real-credentials' };
  const calls = []; let busyNonce, busyHeld = false, releaseBusy, receiver, ended = false, terminal = '', server;
  const binary = process.env.FTOWN_CODEX_BINARY ?? await executable('codex');
  const cleanup = async () => {
    releaseBusy?.();
    if (receiver && !ended) { receiver.kill('SIGTERM'); await pause(400); if (!ended) receiver.kill('SIGKILL'); }
    // The daemon/socket registry is scoped to this verified scratch CODEX_HOME.
    assert.equal(env.CODEX_HOME, join(root,'home','.codex'));
    await command(binary, ['app-server','daemon','stop'], env, cwd);
    server?.closeAllConnections(); if(server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive:true, force:true });
  };
  const interrupted = () => { void cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
  try {
    server=createServer(async(req,res)=>{
      if(req.method !== 'POST' || !req.url?.endsWith('/responses')) {
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[]}));return;
      }
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const payload=JSON.parse(Buffer.concat(chunks).toString());
      const users=Array.isArray(payload.input)?payload.input.filter(item=>item?.role==='user'):[];
      const last=users.at(-1);
      const lastUser=typeof last?.content==='string'?last.content:Array.isArray(last?.content)?last.content.map(part=>part.text??'').join('\n'):'';
      const nonce=/^ftown-native-(?:initial|idle|busy|queued)-[a-f0-9-]{36}$/.test(lastUser.trim())?lastUser.trim():undefined;
      calls.push({payload,nonce,lastUser:lastUser.slice(-240)});
      const index=calls.length;
      if(nonce===busyNonce && busyNonce && !busyHeld) {busyHeld=true;await new Promise(resolve=>{releaseBusy=resolve;});}
      const text=`scratch assistant reply ${index}`;
      const item={id:`msg_${index}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
      const response={id:`resp_${index}`,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',
        model:'ftown-fixture',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
      const event=data=>res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
      event({type:'response.created',response:{...response,status:'in_progress',output:[]}});
      event({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}});
      event({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text});
      event({type:'response.output_item.done',output_index:0,item});
      event({type:'response.completed',response});res.end();
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const port=server.address().port;
    await writeFile(join(codexHome,'config.toml'), `model = "ftown-fixture"\nmodel_provider = "ftown_probe"\nmodel_reasoning_effort = "low"\n[model_providers.ftown_probe]\nname = "Scratch native queue probe"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "FTOWN_PROBE_KEY"\nrequires_openai_auth = false\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n[analytics]\nenabled = false\n`, {mode:0o600});
    const initial=`ftown-native-initial-${randomUUID()}`;
    receiver=pty.spawn(binary,['--dangerously-bypass-approvals-and-sandbox','--dangerously-bypass-hook-trust',initial],
      {env,cwd,name:'xterm-256color',cols:100,rows:35});
    receiver.onData(data=>{terminal=(terminal+data).slice(-100_000);});receiver.onExit(()=>{ended=true;});
    await until(()=>calls.some(call=>call.nonce===initial),'initial scratch provider request');
    const log=await until(async()=> (await files(codexHome)).find(path=>basename(path).startsWith('rollout-') && path.endsWith('.jsonl')), 'scratch Codex rollout');
    const first=JSON.parse((await readFile(log,'utf8')).split('\n').find(line=>line.trim()));
    const sessionId=first.payload?.id;
    assert.match(sessionId,uuid,'native id comes only from this scratch rollout');
    await pause(1_000);
    const idle=`ftown-native-idle-${randomUUID()}`;
    const idleResult=await command(binary,['queue','--thread',sessionId,'--message',idle],env,cwd);
    console.log(JSON.stringify({probe:'codex-idle-receipt',sessionId,...idleResult}));
    assert.equal(idleResult.code,0);assert.match(idleResult.stdout,new RegExp(`Queued message .+ for thread ${sessionId}\\.`));
    await until(()=>calls.some(call=>call.nonce===idle),'idle queued input reaches same scratch provider');
    await pause(500);
    const busy=`ftown-native-busy-${randomUUID()}`;busyNonce=busy;
    receiver.write(busy);await pause(700);receiver.write('\r');
    await until(()=>busyHeld && typeof releaseBusy==='function','busy provider barrier');
    const queued=`ftown-native-queued-${randomUUID()}`;
    const queuedResult=await command(binary,['queue','--thread',sessionId,'--message',queued],env,cwd);
    console.log(JSON.stringify({probe:'codex-busy-receipt',sessionId,...queuedResult}));
    assert.equal(queuedResult.code,0);
    await pause(500);assert.equal(calls.filter(call=>call.nonce===queued).length,0,'busy enqueue must not start concurrent inference');
    releaseBusy();releaseBusy=undefined;
    await until(()=>calls.some(call=>call.nonce===queued),'queued follow-up starts after active turn');
    await pause(500);assert.equal(calls.filter(call=>call.nonce===idle).length,1,'one idle input');assert.equal(calls.filter(call=>call.nonce===queued).length,1,'one queued follow-up input');
    console.log(JSON.stringify({probe:'codex-result',idleAccepted:true,busyQueued:true,sameSession:true,providerTurns:calls.length,nativeInputTurns:calls.filter(call=>call.nonce).map(call=>call.nonce.split('-').slice(0,3).join('-')),realModels:false}));
  } catch(error) {
    console.error(JSON.stringify({probe:'codex-failure',message:error.message,providerTurns:calls.length,requests:calls.map(call=>({nonce:call.nonce??null,lastUser:call.lastUser,model:call.payload.model})),terminalTail:terminal.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').slice(-1_500)}));throw error;
  } finally {
    process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);await cleanup();
  }
}
if(process.argv[2]==='--muse') await museProbe();
else if(process.argv[2]==='--codex') await codexProbe();
else throw new Error('Root-only usage: node bridge/scripts/native-mail-smoke.mjs --muse|--codex');
