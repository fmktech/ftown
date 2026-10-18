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
