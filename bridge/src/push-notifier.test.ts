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
  assert.equal(JSON.parse(bodies[0]).sessionName,'FTown');
  assert.equal(JSON.parse(bodies[0]).title,'FTown attention');
  assert.equal(JSON.parse(bodies[0]).message,'Open FTown to view details.');
  assert.ok(!bodies[0].includes('Ready'));
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

test('retry and expiry follow elapsed time through wall steps', async () => {
  const original = Date.now;
  try {
    for (const jump of [-600_000, 600_000]) {
      let wall=1_000_000, elapsed=0, calls=0; Date.now=()=>wall;
      const tasks=new Map<ReturnType<typeof setTimeout>,{fn:()=>void;ms:number}>();
      const notifier=new BridgePushNotifier({apiUrl:'https://example.test',bridgeId:'b',getToken:()=> 'token',getSession:async()=>({name:'Agent'})}, {
        now:()=>elapsed, schedule:(fn,ms)=>{const token={} as ReturnType<typeof setTimeout>;tasks.set(token,{fn,ms});return token;},
        cancel:token=>{tasks.delete(token);}, fetch:async()=>{calls++;return new Response(null,{status:503});},
      });
      notifier.notify('a',notice); await tick(); assert.equal(calls,1);
      wall+=jump; let retry=[...tasks.values()][0]; assert.equal(retry.ms,5000);
      elapsed=4999; retry.fn(); await tick(); assert.equal(calls,1);
      retry=[...tasks.values()].at(-1)!; assert.equal(retry.ms,1);
      elapsed=5000; retry.fn(); await tick(); assert.equal(calls,2);
      elapsed=300_000; [...tasks.values()].at(-1)!.fn(); await tick(); assert.equal(calls,2);
      notifier.stop();
    }
  } finally { Date.now=original; }
});

test('default clock keeps retry and expiry deadlines across wall steps', async () => {
  const originalDateNow = Date.now, originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  const originalPerformanceNow = Object.getOwnPropertyDescriptor(performance, 'now');
  let wall = 1_000_000, elapsed = 0, calls = 0;
  const tasks = new Map<ReturnType<typeof setTimeout>, { fn: () => void; ms: number }>();
  Date.now = () => wall;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => elapsed });
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const token = {} as ReturnType<typeof setTimeout>; tasks.set(token, { fn, ms }); return token;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((token: ReturnType<typeof setTimeout>) => { tasks.delete(token); }) as typeof clearTimeout;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 503 }); };
  try {
    // A fresh module captures the mocked Date.now in the old implementation.
    const modulePath = './push-notifier.js?default-clock-regression';
    const { BridgePushNotifier: DefaultNotifier } = await import(modulePath) as typeof import('./push-notifier.js');
    for (const jump of [-600_000, 600_000]) {
      wall = 1_000_000; elapsed = 0; calls = 0; tasks.clear();
      const notifier = new DefaultNotifier({ apiUrl: 'https://example.test', bridgeId: 'b',
        getToken: () => 'token', getSession: async () => ({ name: 'Agent' }) });
      notifier.notify('a', notice); await tick(); assert.equal(calls, 1);
      wall += jump;
      let [token, retry] = [...tasks.entries()][0]; assert.equal(retry.ms, 5000);
      tasks.delete(token); elapsed = 4999; retry.fn(); await tick(); assert.equal(calls, 1);
      [token, retry] = [...tasks.entries()][0]; assert.equal(retry.ms, 1);
      tasks.delete(token); elapsed = 5000; retry.fn(); await tick(); assert.equal(calls, 2);
      [token, retry] = [...tasks.entries()][0]; tasks.delete(token);
      elapsed = 299_999; retry.fn(); await tick(); assert.equal(calls, 3);
      [token, retry] = [...tasks.entries()][0]; assert.equal(retry.ms, 1); tasks.delete(token);
      elapsed = 300_000; retry.fn(); await tick(); assert.equal(calls, 3);
      notifier.stop();
    }
  } finally {
    Date.now = originalDateNow; globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
    if (originalPerformanceNow) Object.defineProperty(performance, 'now', originalPerformanceNow);
    else delete (performance as { now?: () => number }).now;
  }
});
