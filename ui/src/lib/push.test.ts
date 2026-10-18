import { afterEach, describe, expect, it, vi } from "vitest";
import { createECDH } from "node:crypto";
import jwt from "jsonwebtoken";
import { boundedJson, bridgePushIdentity, endpointAllowed, eventIdentity, parsePushEvent, parseSubscription, pushConfig, requireSameOrigin, cleanPushText } from "./push";
const query=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/db",()=>({getDb:()=>({query})}));
const ecdh=createECDH("prime256v1");ecdh.generateKeys();
const subscription={endpoint:"https://fcm.googleapis.com/fcm/send/test",keys:{p256dh:ecdh.getPublicKey().toString("base64url"),auth:Buffer.alloc(16,1).toString("base64url")}};
afterEach(()=>{vi.unstubAllEnvs();query.mockReset();});
describe("push boundary",()=>{
  it("accepts genuine browser keys and confines endpoints to HTTPS push vendors",()=>{
    expect(parseSubscription(subscription).endpoint).toBe(subscription.endpoint);
    for(const endpoint of ["http://fcm.googleapis.com/x","https://fcm.googleapis.com.evil.test/x","https://evil.test/x","https://127.0.0.1/x","https://u:p@fcm.googleapis.com/x","https://fcm.googleapis.com:444/x","https://web.push.apple.com/x#fragment"]){
      expect(endpointAllowed(endpoint)).toBe(false);expect(()=>parseSubscription({...subscription,endpoint})).toThrow();
    }
    expect(()=>parseSubscription({...subscription,keys:{...subscription.keys,p256dh:Buffer.alloc(65,4).toString("base64url")}})).toThrow();
  });
  it("uses complete identity for idle and distinct question dedup",()=>{
    const event={sessionId:"s",eventKey:"idle"};
    expect(eventIdentity("owner","b",event)).toHaveLength(64);
    expect(new Set([eventIdentity("a","b",event),eventIdentity("c","b",event),eventIdentity("a","c",event),eventIdentity("a","b",{...event,sessionId:"t"})]).size).toBe(4);
  });
  it("rejects invalid payload/time/key and preserves safe Unicode",()=>{
    const event={sessionId:"s",sessionName:"Agent 🐈",kind:"idle",eventKey:"idle",title:"Ready",message:"hello",occurredAt:new Date().toISOString()};
    expect(parsePushEvent(event).sessionName).toBe("Agent 🐈");
    for(const change of [{eventKey:"other"},{sessionId:"../x"},{occurredAt:"bad"},{occurredAt:new Date(Date.now()+120000).toISOString()},{message:"x".repeat(2001)}]) expect(()=>parsePushEvent({...event,...change})).toThrow();
    expect(cleanPushText("Bearer fixture-token API_KEY=fixture-value",100)).toBe("Bearer [redacted] API_KEY=[redacted]");
  });
  it("requires same-origin mutations and bounded streamed JSON",async()=>{
    expect(()=>requireSameOrigin(new Request("https://app.test/api/push",{headers:{origin:"https://evil.test"}}))).toThrow();
    await expect(boundedJson(new Request("https://app.test/api/push",{method:"POST",body:"x".repeat(16385)}))).rejects.toMatchObject({status:413});
    await expect(boundedJson(new Request("https://app.test/api/push",{method:"POST",body:"garbage"}))).rejects.toMatchObject({status:400});
  });
  it("rejects browser tokens and inactive/cross-owner bridge identities",async()=>{
    vi.stubEnv("CENTRIFUGO_TOKEN_SECRET","unit-secret-long-enough-for-signing-fixtures");
    const make=(payload:object)=>new Request("https://app.test/api/push/events",{headers:{authorization:`Bearer ${jwt.sign(payload,process.env.CENTRIFUGO_TOKEN_SECRET!,{audience:"ftown:centrifugo",expiresIn:60})}`}});
    await expect(bridgePushIdentity(make({sub:"a"}))).rejects.toMatchObject({status:401});
    query.mockResolvedValueOnce([]);
    await expect(bridgePushIdentity(make({sub:"a",info:{bridgeId:"b"}}))).rejects.toMatchObject({status:403});
    query.mockResolvedValueOnce([{bridge_id:"b"}]);
    await expect(bridgePushIdentity(make({sub:"a",info:{bridgeId:"b"}}))).resolves.toEqual({owner:"a",bridgeId:"b"});
  });
  it("stays unavailable with missing or invalid VAPID configuration",()=>{
    vi.stubEnv("VAPID_PUBLIC_KEY","");expect(pushConfig()).toBeNull();
  });
});
