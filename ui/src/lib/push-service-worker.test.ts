import { expect,it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source=readFileSync(new URL("../../public/sw.js",import.meta.url),"utf8");
function worker(){
 const listeners=new Map<string,(event:Record<string,unknown>)=>void>();const shown:unknown[]=[];const opened:string[]=[];const receipts=new Map();
 let chain=Promise.resolve();
 const stores=new Map<string,Map<string,unknown>>([["receipts",receipts],["settings",new Map()]]);
 const indexedDB={open:()=>{
  const request:{result?:unknown;onsuccess?:()=>void;onerror?:()=>void}={};
  queueMicrotask(()=>{request.result={close(){},transaction(name:string){
   let reading=false;const data=stores.get(name)!;
   const tx:{oncomplete?:()=>void;objectStore:()=>unknown}={objectStore:()=>({
    get(id:string){reading=true;const read:{result?:unknown;onsuccess?:()=>void}={};chain=chain.then(()=>{read.result=data.get(id);read.onsuccess?.();tx.oncomplete?.();});return read;},
    put(value:unknown,id:string){data.set(id,value);if(!reading)queueMicrotask(()=>tx.oncomplete?.());},
   })};return tx;
  }};request.onsuccess?.();});return request;
 }};
 const self={location:{origin:"https://app.test"},addEventListener:(name:string,fn:(e:Record<string,unknown>)=>void)=>listeners.set(name,fn),
  registration:{getNotifications:async()=>[],showNotification:async(title:string,options:unknown)=>{shown.push({title,options});}},clients:{matchAll:async()=>[],openWindow:async(url:string)=>{opened.push(url);}}};
 runInNewContext(source,{self,indexedDB,URL,caches:{},queueMicrotask});
 async function emit(name:string,event:Record<string,unknown>){let pending=Promise.resolve();listeners.get(name)?.({...event,waitUntil:(promise:Promise<void>)=>{pending=promise;}});await pending;}
 return{emit,shown,opened};
}
it("shows a distinct full-identity push once and opens only its fixed session URL",async()=>{
 const w=worker();const payload={id:"a".repeat(64),ownerHash:"c".repeat(64),sessionId:"session-1",title:"Question",body:"Agent: choose"};
 await w.emit("message",{source:{url:"https://app.test/dashboard"},data:{type:"ftown-push-owner",ownerHash:payload.ownerHash},ports:[]});
 await Promise.all([w.emit("push",{data:{json:()=>payload}}),w.emit("push",{data:{json:()=>payload}})]);
 expect(w.shown).toHaveLength(1);
 expect(w.shown[0]).toMatchObject({title:"FTown attention",options:{body:"Open FTown to view details."}});
 expect(JSON.stringify(w.shown)).not.toContain("Agent: choose");
 expect(JSON.stringify(w.shown)).not.toContain("Question");
 await w.emit("push",{data:{json:()=>({...payload,id:"b".repeat(64)})}});expect(w.shown).toHaveLength(2);
 await w.emit("notificationclick",{notification:{close(){},data:{sessionId:"session-1",url:"https://evil.test"}}});expect(w.opened).toEqual(["https://app.test/dashboard?session=session-1"]);
 await w.emit("notificationclick",{notification:{close(){},data:{sessionId:"../outside"}}});expect(w.opened).toHaveLength(1);
});
it("never caches authenticated API responses",async()=>{
 const w=worker();let intercepted=false;await w.emit("fetch",{request:{method:"GET",url:"https://app.test/api/push"},respondWith:()=>{intercepted=true;}});expect(intercepted).toBe(false);
});

it("suppresses in-flight notifications for a signed-out or switched account",async()=>{
 const w=worker();const payload={id:"d".repeat(64),ownerHash:"a".repeat(64),sessionId:"s",title:"Question",body:"Agent"};
 const bind=(ownerHash:string|null)=>w.emit("message",{source:{url:"https://app.test/dashboard"},data:{type:"ftown-push-owner",ownerHash},ports:[]});
 await bind(payload.ownerHash);await bind(null);await w.emit("push",{data:{json:()=>payload}});expect(w.shown).toHaveLength(0);
 await bind("b".repeat(64));await w.emit("push",{data:{json:()=>payload}});expect(w.shown).toHaveLength(0);
 await w.emit("push",{data:{json:()=>({...payload,id:"e".repeat(64),ownerHash:"b".repeat(64)})}});expect(w.shown).toHaveLength(1);
});
