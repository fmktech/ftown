import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeMailWaker } from './native-mail.js';
import type { Session } from './types.js';

const target = '01900000-0000-7000-8000-000000000001';
const queued = '01900000-0000-7000-8000-000000000002';
const pointer = 'You have new ftown mail — run `ftown harness mail read`.';
const session: Session = { id:'ftown-session', name:'display name is never a target', command:'codex', status:'running',
  bridgeId:'b', createdAt:'2026-10-18T00:00:00.000Z', updatedAt:'2026-10-18T00:00:00.000Z',
  shellType:'codex', codexSessionId:target, workingDir:'/target/workspace' };
const result = (extra: Record<string, unknown> = {}) => ({ started:true, code:0, stdout:'', stderr:'', ...extra });
const help = () => result({ stdout:'Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>' });
const accepted = () => result({ stdout:`Queued message ${queued} for thread ${target}.\n` });
type Dependencies = NonNullable<Parameters<typeof createNativeMailWaker>[0]>;
type Run = NonNullable<Dependencies['run']>;
function fixture(responses = [help(), accepted()]) {
  const calls: Parameters<Run>[] = [];
  const run: Run = async (...args) => { calls.push(args); return responses.shift()!; };
  return { calls, wake:createNativeMailWaker({ run, env:{ PATH:'/target/bin', HOME:'/bridge/home' } }) };
}
test('only supported live harness UUIDs reach the subprocess boundary', async () => {
  const f=fixture();
  for(const change of [{shellType:'claude' as const},{codexSessionId:undefined},{codexSessionId:'friendly-name'},{codexSessionId:'../bad'}]) {
    assert.equal((await f.wake({...session,...change},pointer)).status,'unsupported');
  }
  assert.equal((await f.wake({...session,status:'completed'},pointer)).status,'rejected');
  assert.equal(f.calls.length,0);
  assert.equal((await f.wake(session,pointer)).status,'accepted');
  assert.deepEqual(f.calls.map(call=>[call[0],call[1]]),[
    ['codex',['queue','--help']],['codex',['queue','--thread',target,'--message',pointer]],
  ]);
  assert.equal(f.calls[1][2].input,undefined);
  assert.equal(f.calls[1][2].cwd,'/target/workspace');
  assert.equal(f.calls[1][2].timeoutMs,10_000);assert.equal(f.calls[1][2].maxOutputBytes,65_536);
});
test('Codex wake uses target home/XDG/cwd and excludes the bridge agent transport and sender identities', async () => {
  const calls:Parameters<Run>[]=[];
  const wake=createNativeMailWaker({env:{PATH:'/bridge/bin',HOME:'/bridge/home',CODEX_HOME:'/bridge/codex',
    CODEX_APP_SERVER_WS_URL:'ws://wrong-owner',CODEX_THREAD_ID:'wrong-thread',MUSE_SESSION_ID:'wrong-muse',MUSE_THREAD_ID:'wrong-child'},
    run:async(...args)=>{calls.push(args);return args[1].includes('--help')?help():accepted();}});
  await wake({...session,env:{PATH:'/target/bin',HOME:'/target/home',USERPROFILE:'/target/home',CODEX_HOME:'/target/codex',
    XDG_CONFIG_HOME:'/target/config',XDG_DATA_HOME:'/target/data',CODEX_SESSION_ID:'must-not-leak',MUSE_THREAD_ID:'must-not-leak'}},pointer);
  const options=calls[1][2];assert.equal(options.cwd,session.workingDir);
  assert.equal(options.env.HOME,'/target/home');assert.equal(options.env.USERPROFILE,'/target/home');
  assert.equal(options.env.CODEX_HOME,'/target/codex');assert.equal(options.env.PATH,'/target/bin');
  assert.equal(options.env.XDG_CONFIG_HOME,'/target/config');assert.equal(options.env.XDG_DATA_HOME,'/target/data');
  for(const key of ['CODEX_APP_SERVER_WS_URL','CODEX_THREAD_ID','CODEX_SESSION_ID','MUSE_SESSION_ID','MUSE_THREAD_ID'])assert.equal(options.env[key],undefined,key);
  assert.equal(options.env.MUSE_NO_AUTO_UPDATE,'1');
});
test('capability probes cache bounded support by runtime context and expire', async () => {
  let now=0,probes=0,sends=0;
  const wake=createNativeMailWaker({now:()=>now,run:async(_file,args)=>{if(args.includes('--help')){probes++;return help();}sends++;return accepted();}});
  await wake(session,pointer);await wake(session,pointer);assert.equal(probes,1);assert.equal(sends,2);
  await wake({...session,env:{CODEX_HOME:'/another-home'}},pointer);assert.equal(probes,2);
  now=60_001;await wake(session,pointer);assert.equal(probes,3);
});
test('missing/unsupported commands permit fallback without interpreting arbitrary failures as capability absence', async () => {
  for(const response of [result({started:false,code:null,errorCode:'ENOENT'}),result({code:2,stderr:"error: unrecognized subcommand 'queue'"}),result({stdout:'Usage: codex [OPTIONS]'})]) {
    const f=fixture([response]);assert.equal((await f.wake(session,pointer)).status,'unsupported');assert.equal(f.calls.length,1);
  }
  const failed=fixture([result({code:1,stderr:'config unreadable'})]);
  assert.equal((await failed.wake(session,pointer)).status,'rejected','help failure is before dispatch');
});
test('only matching server receipt proves native admission, never actual inbox consumption', async () => {
  for(const response of [result(),result({stdout:`Queued message ${queued} for thread 01900000-0000-7000-8000-000000000099.`}),
    result({stdout:'queued'}),result({code:1,stderr:'backend unavailable'}),result({timedOut:true}),result({aborted:true}),result({overflow:true})]) {
    const f=fixture([help(),response]);assert.equal((await f.wake(session,pointer)).status,'unknown');assert.equal(f.calls.length,2,'never retries uncertain dispatch');
  }
  const f=fixture([help(),result({started:false,code:null,errorCode:'ENOENT'})]);
  assert.equal((await f.wake(session,pointer)).status,'unsupported');
});
test('abort and post-probe validation fence stale sessions before native dispatch', async () => {
  const controller=new AbortController();const f=fixture();controller.abort();
  assert.equal((await f.wake(session,pointer,controller.signal)).status,'rejected');assert.equal(f.calls.length,0);
  const stale=fixture();assert.equal((await stale.wake(session,pointer,undefined,async()=>false)).status,'rejected');assert.equal(stale.calls.length,1);
  let release!:()=>void;const pause=new Promise<void>(resolve=>{release=resolve;});const during=new AbortController();let calls=0;
  const wake=createNativeMailWaker({run:async()=>{calls++;await pause;return help();}});
  const pending=wake(session,pointer,during.signal);during.abort();release();
  assert.equal((await pending).status,'rejected');assert.equal(calls,1);
});
test('thrown runner failures remain unknown and unverified Muse stays on fallback', async () => {
  const wake=createNativeMailWaker({run:async()=>{throw new Error('transport uncertain');}});
  assert.equal((await wake(session,pointer)).status,'unknown');
  assert.equal((await wake({...session,shellType:'muse',museSessionId:target},pointer)).status,'unsupported');
});
test('an explicitly unsupported daemon permits fallback, while queue-capacity rejection remains unknown', async () => {
  const unsupported=fixture([help(),result({code:1,stderr:'Error: the local app-server daemon does not support thread/queue/add; update or restart the local app-server daemon'})]);
  assert.equal((await unsupported.wake(session,pointer)).status,'unsupported');
  const full=fixture([help(),result({code:1,stderr:'failed to queue session message: queue cannot contain more than 100 submissions'})]);
  assert.equal((await full.wake(session,pointer)).status,'unknown');
});
