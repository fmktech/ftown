import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { boundedJson, parseSubscription, pushConfig, PushError, requireSameOrigin } from "@/lib/push";
import { PushStore } from "@/lib/push-store";
export const runtime = "nodejs";
function failure(error: unknown): NextResponse {
  return NextResponse.json({ error: error instanceof PushError ? error.code : "push_unavailable" }, { status: error instanceof PushError ? error.status : 503 });
}
async function owner(): Promise<string> {
  const session = await auth();
  if (!session?.user?.email) throw new PushError("unauthorized",401);
  return session.user.email;
}
export async function GET(): Promise<NextResponse> {
  try {
    await owner();
    const config = pushConfig();
    const enabled = !!config && await new PushStore().available();
    return NextResponse.json(enabled ? { enabled:true, publicKey:config!.publicKey } : { enabled:false }, { headers:{"Cache-Control":"no-store"} });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const sub = await owner(); requireSameOrigin(request);
    if (!pushConfig()) throw new PushError("push_unavailable",503);
    const subscription = parseSubscription(await boundedJson(request));
    const store = new PushStore(); await store.rate(sub,"push-subscribe",20);
    await store.subscribe(sub,subscription);
    return NextResponse.json({ enabled:true },{status:201});
  } catch (error) { return failure(error); }
}
export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    const sub=await owner(); requireSameOrigin(request);
    const body=await boundedJson(request);
    if (!body || typeof body!=="object" || !("endpoint" in body) || typeof body.endpoint!=="string" || body.endpoint.length>2048) throw new PushError("invalid_subscription",400);
    const store=new PushStore(); await store.rate(sub,"push-subscribe",20); await store.unsubscribe(sub,body.endpoint);
    return new NextResponse(null,{status:204});
  } catch(error) { return failure(error); }
}
