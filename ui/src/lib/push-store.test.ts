import { expect,it,vi } from "vitest";
import { PushStore } from "./push-store";
it("rejects exhausted limits and conflicting endpoint writes",async()=>{
 const query=vi.fn().mockResolvedValueOnce([{failed_count:121}]).mockResolvedValueOnce([]);
 const store=new PushStore(query);
 await expect(store.rate("owner","events",120)).rejects.toMatchObject({status:429});
 await expect(store.subscribe("owner",{endpoint:"https://fcm.googleapis.com/x",keys:{p256dh:"x",auth:"y"}})).rejects.toMatchObject({status:409});
});
it("retains immutable stored event payload and leased delivery identities",async()=>{
 const event={sessionId:"s",sessionName:"Original",kind:"idle" as const,eventKey:"idle",title:"Idle",message:"Ready",occurredAt:new Date().toISOString()};
 const query=vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{payload:event}]).mockResolvedValueOnce([{endpoint_hash:"endpoint",endpoint:"https://fcm.googleapis.com/x",p256dh:"x",auth:"y"}]);
 const store=new PushStore(query);const saved=await store.ingest("owner","bridge",{...event,sessionName:"Changed"});
 expect(saved.event.sessionName).toBe("Original");const deliveries=await store.claim("owner",saved.id);
 expect(deliveries[0].endpointHash).toBe("endpoint");expect(deliveries[0].lease).toMatch(/^[a-f0-9-]{36}$/);
});

it("uses the same durable event row for cycle retry and a new row for a later idle cycle",async()=>{
 const event={sessionId:"s",sessionName:"Agent",kind:"idle" as const,eventKey:"idle:00000000-0000-4000-8000-000000000001",title:"Idle",message:"Ready",occurredAt:new Date().toISOString()};
 const query=vi.fn().mockImplementation(async(text:string)=>text.includes("SELECT payload")?[{payload:event}]:[]);
 const store=new PushStore(query);const first=await store.ingest("owner","bridge",event);
 const retry=await store.ingest("owner","bridge",event);
 const next=await store.ingest("owner","bridge",{...event,eventKey:"idle:00000000-0000-4000-8000-000000000002"});
 expect(retry.id).toBe(first.id);expect(next.id).not.toBe(first.id);
 const inserts=query.mock.calls.filter(([text])=>String(text).includes("WITH created"));
 expect(inserts.map(([,params])=>(params as unknown[])[4])).toEqual([event.eventKey,event.eventKey,"idle:00000000-0000-4000-8000-000000000002"]);
});
