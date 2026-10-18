import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { boundedJson, bridgePushIdentity, parsePushEvent, pushConfig, PushError, sendBrowserPush } from "@/lib/push";
import { PushStore } from "@/lib/push-store";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const identity=await bridgePushIdentity(request);
    const config=pushConfig(); if(!config) throw new PushError("push_unavailable",503);
    const event=parsePushEvent(await boundedJson(request));
    const store=new PushStore(); await store.rate(`${identity.owner}:${identity.bridgeId}`,"push-events",120);
    const saved=await store.ingest(identity.owner,identity.bridgeId,event);
    const deliveries=await store.claim(identity.owner,saved.id);
    const payload=JSON.stringify({ id:saved.id, ownerHash:createHash("sha256").update(identity.owner).digest("hex"), title:saved.event.title, body:`${saved.event.sessionName}: ${saved.event.message}`,
      sessionId:saved.event.sessionId, url:`/dashboard?session=${encodeURIComponent(saved.event.sessionId)}` });
    // At most ten endpoints; two bounded batches avoid unbounded provider fanout.
    for(let i=0;i<deliveries.length;i+=5) await Promise.all(deliveries.slice(i,i+5).map(async(delivery)=>{
      try {
        const status=await sendBrowserPush(delivery.subscription,payload,config);
        if(status===404 || status===410) await store.unsubscribe(identity.owner,delivery.subscription.endpoint);
        else if(status>=200 && status<300) await store.complete(saved.id,delivery);
        else if(status===408 || status===429 || status>=500) await store.release(saved.id,delivery);
        else await store.complete(saved.id,delivery); // Permanent provider rejection is terminal, never an indefinite replay.
      } catch { await store.release(saved.id,delivery); }
    }));
    const pending=await store.remaining(identity.owner,saved.id);
    return NextResponse.json({accepted:true,pending},{status:pending?503:202});
  } catch(error) {
    return NextResponse.json({error:error instanceof PushError?error.code:"push_unavailable"},{status:error instanceof PushError?error.status:503});
  }
}
