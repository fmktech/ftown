import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { BridgePushNotifier, type PushNotice } from './push-notifier.js';
const notice: PushNotice = {kind:'idle',eventKey:'idle',title:'Idle',message:'Ready',occurredAt:new Date().toISOString()};
const tick=async()=>{await setImmediate();await setImmediate();};
test('nonblocking notifier scopes a single event, excludes shells and stops queued work',async()=>{
  const bodies: string[]=[];
  const notifier=new BridgePushNotifier({apiUrl:'https://example.test',bridgeId:'b',getToken:()=> 'test-token',
    getSession:async(id)=>({name:id,shellType:id==='shell'?'shell':'claude'})}, {
    now:Date.now,schedule:setTimeout,cancel:clearTimeout,
    fetch:async(_url,options)=>{bodies.push(String(options?.body));return new Response(null,{status:202});},
  });
  notifier.notify('shell',notice);notifier.notify('agent',notice);notifier.notify('agent',notice);
  await tick();
  assert.equal(bodies.length,1);
  assert.equal(JSON.parse(bodies[0]).sessionName,'agent');
  assert.equal(JSON.parse(bodies[0]).eventKey,'idle');
  notifier.stop();notifier.notify('later',notice);await tick();assert.equal(bodies.length,1);
});
test('transient failures retry once per queued identity within a finite budget; permanent failures do not',async()=>{
  let now=0;let calls=0;
  const scheduled:{fn:()=>void;ms:number}[]=[];
  const deps={now:()=>now,schedule:(fn:()=>void,ms:number)=>{scheduled.push({fn,ms});return scheduled.length as unknown as ReturnType<typeof setTimeout>;},
    cancel:()=>{},fetch:async()=>{calls++;return new Response(null,{status:503});}};
  const notifier=new BridgePushNotifier({apiUrl:'https://example.test',bridgeId:'b',getToken:()=> 'test-token',getSession:async()=>({name:'Agent'})},deps);
  notifier.notify('a',notice);await tick();
  assert.equal(calls,1);
  const retry=scheduled.at(-1)!;assert.equal(retry.ms,5000);
  now=300_000;retry.fn();await tick();assert.equal(calls,1);
  notifier.stop();
  const denied=new BridgePushNotifier({apiUrl:'https://example.test',bridgeId:'b',getToken:()=> 'test-token',getSession:async()=>({name:'Agent'})}, {...deps,fetch:async()=>{calls++;return new Response(null,{status:401});}});
  denied.notify('a',notice);await tick();assert.equal(calls,2);denied.stop();
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
test('idle cancellation fences deferred session and token lookups without canceling questions', async () => {
  for (const phase of ['session', 'token']) {
    const session = deferred<{ name: string }>(); const token = deferred<string>(); let calls = 0;
    const notifier = new BridgePushNotifier({ apiUrl:'https://example.test', bridgeId:'b',
      getSession: () => phase === 'session' ? session.promise : Promise.resolve({ name:'Agent' }),
      getToken: () => phase === 'token' ? token.promise : 'test-token' }, {
      now:Date.now, schedule:setTimeout, cancel:clearTimeout,
      fetch:async () => { calls++; return new Response(null,{status:202}); },
    });
    notifier.notify('a',notice); await tick(); notifier.cancelIdle('a');
    session.resolve({ name:'Agent' }); token.resolve('test-token'); await tick();
    assert.equal(calls,0,phase);
    notifier.notify('a',{...notice,kind:'question',eventKey:'question:00000000-0000-4000-8000-000000000001'});
    await tick(); assert.equal(calls,1,'question unaffected'); notifier.stop();
  }
});
test('idle cancellation aborts matching in-flight delivery and permits a new cycle identity', async () => {
  let signal: AbortSignal | undefined; let calls = 0;
  const notifier = new BridgePushNotifier({ apiUrl:'https://example.test',bridgeId:'b',getToken:()=> 'test-token',getSession:async()=>({name:'Agent',status:'running'}) }, {
    now:Date.now,schedule:setTimeout,cancel:clearTimeout,
    fetch:async(_url,options)=> { calls++; if(calls>1)return new Response(null,{status:202});
      signal=options?.signal as AbortSignal;
      return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})); },
  });
  notifier.notify('a',notice); await tick(); assert.equal(signal?.aborted,false);
  notifier.cancelIdle('a'); assert.equal(signal?.aborted,true); await tick();
  notifier.notify('a',{...notice,eventKey:'idle:00000000-0000-4000-8000-000000000002'}); await tick();
  assert.equal(calls,2); notifier.stop();
});
test('idle backoff never delays immediate questions and cancellation removes the stale retry', async () => {
  let now=0; const calls:string[]=[]; const tasks=new Map<ReturnType<typeof setTimeout>,()=>void>();
  const notifier = new BridgePushNotifier({apiUrl:'https://example.test',bridgeId:'b',getToken:()=> 'test-token',getSession:async()=>({name:'Agent'})}, {
    now:()=>now,schedule:fn=>{const timer={} as ReturnType<typeof setTimeout>;tasks.set(timer,fn);return timer;},cancel:timer=>{tasks.delete(timer);},
    fetch:async(_url,options)=>{const kind=JSON.parse(String(options?.body)).kind;calls.push(kind);return new Response(null,{status:kind==='idle'?503:202});},
  });
  notifier.notify('a',notice);await tick();
  notifier.notify('a',{...notice,kind:'question',eventKey:'question:00000000-0000-4000-8000-000000000001'});await tick();
  assert.deepEqual(calls,['idle','question']);
  notifier.cancelIdle('a');now=60_000;for(const fn of [...tasks.values()])fn();await tick();
  assert.deepEqual(calls,['idle','question']);assert.equal(tasks.size,0);notifier.stop();
});
test('terminal sessions cannot hand off a queued notice', async () => {
  let calls=0;const notifier=new BridgePushNotifier({apiUrl:'https://example.test',bridgeId:'b',getToken:()=> 'test-token',getSession:async()=>({name:'Agent',status:'completed'})}, {
    now:Date.now,schedule:setTimeout,cancel:clearTimeout,fetch:async()=>{calls++;return new Response(null,{status:202});},
  });notifier.notify('a',notice);await tick();assert.equal(calls,0);notifier.stop();
});
