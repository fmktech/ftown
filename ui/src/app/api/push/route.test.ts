import { afterEach,expect,it,vi } from "vitest";
import { createECDH } from "node:crypto";
import webpush from "web-push";
const mocks=vi.hoisted(()=>({auth:vi.fn(),query:vi.fn()}));
vi.mock("@/lib/auth",()=>({auth:mocks.auth}));
vi.mock("@/lib/db",()=>({getDb:()=>({query:mocks.query})}));
import { GET,POST,DELETE } from "./route";
const key=createECDH("prime256v1");key.generateKeys();
const subscription={endpoint:"https://fcm.googleapis.com/x",keys:{p256dh:key.getPublicKey().toString("base64url"),auth:Buffer.alloc(16,1).toString("base64url")}};
function config(){const keys=webpush.generateVAPIDKeys();vi.stubEnv("VAPID_PUBLIC_KEY",keys.publicKey);vi.stubEnv("VAPID_PRIVATE_KEY",keys.privateKey);vi.stubEnv("VAPID_SUBJECT","mailto:test@example.test");}
function request(method:string,body:unknown,origin="https://app.test"){return new Request("https://app.test/api/push",{method,headers:{origin,"Content-Type":"application/json"},body:JSON.stringify(body)});}
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
it("requires login and never exposes private VAPID data",async()=>{
 mocks.auth.mockResolvedValue(null);expect((await GET()).status).toBe(401);
 mocks.auth.mockResolvedValue({user:{email:"owner"}});config();mocks.query.mockResolvedValue([{subscriptions:"s",events:"e",deliveries:"d"}]);
 const response=await GET();const body=await response.json();expect(body.enabled).toBe(true);expect(Object.keys(body).sort()).toEqual(["enabled","publicKey"]);
 expect(response.headers.get("cache-control")).toBe("no-store");
});
it("explains unavailable configuration before any permission flow",async()=>{
 mocks.auth.mockResolvedValue({user:{email:"owner"}});vi.stubEnv("VAPID_PUBLIC_KEY","");expect(await(await GET()).json()).toEqual({enabled:false});
});
it("enforces CSRF, endpoint validation and owner-scoped unsubscribe",async()=>{
 mocks.auth.mockResolvedValue({user:{email:"owner"}});config();
 expect((await POST(request("POST",subscription,"https://other.test"))).status).toBe(403);
 expect((await POST(request("POST",{...subscription,endpoint:"https://127.0.0.1/x"}))).status).toBe(400);
 mocks.query.mockResolvedValue([{failed_count:1,endpoint_hash:"endpoint"}]);
 expect((await POST(request("POST",subscription))).status).toBe(201);
 expect((await DELETE(request("DELETE",{endpoint:subscription.endpoint}))).status).toBe(204);
});
