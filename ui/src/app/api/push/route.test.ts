import { afterEach,expect,it,vi } from "vitest";
import { createECDH } from "node:crypto";
import webpush from "web-push";
const mocks=vi.hoisted(()=>({auth:vi.fn(),query:vi.fn(),readLedger:vi.fn()}));
const ACCOUNT="A".repeat(43),DEVICE="D".repeat(43);
vi.mock("@/lib/auth",()=>({auth:mocks.auth}));
// Auth reads the persisted trusted checkpoint (readTrustedCheckpoint); the fixtures below describe the stored row (no revoked ids).
vi.mock("@/lib/account-ledger-store",()=>({readTrustedCheckpoint:async(accountId:string)=>{const t=((await mocks.readLedger({accountId})) as {trusted?:object}|null|undefined)?.trusted;return t?{revokedDeviceIds:[],revokedBridgeIds:[],...t}:null;}}));
vi.mock("@/lib/auth-nonce-store",()=>({consumeNonce:vi.fn()}));
vi.mock("next-auth/providers/credentials",()=>({default:(config:unknown)=>config}));
vi.mock("@/lib/db",()=>({getDb:()=>({query:mocks.query})}));
import { GET,POST,DELETE } from "./route";
const key=createECDH("prime256v1");key.generateKeys();
const subscription={endpoint:"https://fcm.googleapis.com/x",keys:{p256dh:key.getPublicKey().toString("base64url"),auth:Buffer.alloc(16,1).toString("base64url")}};
function config(){const keys=webpush.generateVAPIDKeys();vi.stubEnv("VAPID_PUBLIC_KEY",keys.publicKey);vi.stubEnv("VAPID_PRIVATE_KEY",keys.privateKey);vi.stubEnv("VAPID_SUBJECT","mailto:test@example.test");}
function request(method:string,body:unknown,origin="https://app.test"){return new Request("https://app.test/api/push",{method,headers:{origin,"Content-Type":"application/json"},body:JSON.stringify(body)});}
const signedIn=()=>{mocks.auth.mockResolvedValue({user:{id:ACCOUNT,endpointId:DEVICE}});mocks.readLedger.mockResolvedValue({trusted:{devices:[{endpoint:{id:DEVICE}}],bridges:[]},checkpoint:{},ledger:{},sticky:{deviceIds:[],bridgeIds:[]}});};
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
it("requires login and never exposes private VAPID data",async()=>{
 mocks.auth.mockResolvedValue(null);expect((await GET()).status).toBe(401);
 signedIn();config();mocks.query.mockResolvedValue([{subscriptions:"s",events:"e",deliveries:"d"}]);
 const response=await GET();const body=await response.json();expect(body.enabled).toBe(true);expect(Object.keys(body).sort()).toEqual(["enabled","publicKey"]);
 expect(response.headers.get("cache-control")).toBe("no-store");
});
it("explains unavailable configuration before any permission flow",async()=>{
 signedIn();vi.stubEnv("VAPID_PUBLIC_KEY","");expect(await(await GET()).json()).toEqual({enabled:false});
});
it("enforces CSRF, endpoint validation and owner-scoped unsubscribe",async()=>{
 signedIn();config();
 expect((await POST(request("POST",subscription,"https://other.test"))).status).toBe(403);
 expect((await POST(request("POST",{...subscription,endpoint:"https://127.0.0.1/x"}))).status).toBe(400);
 mocks.query.mockResolvedValue([{failed_count:1,endpoint_hash:"endpoint"}]);
 expect((await POST(request("POST",subscription))).status).toBe(201);
 expect((await DELETE(request("DELETE",{endpoint:subscription.endpoint}))).status).toBe(204);
 const calls=mocks.query.mock.calls.filter(([sql])=>/push_subscriptions/.test(String(sql)));
 expect(calls.length).toBe(2);
 for(const [sql,params] of calls){expect(String(sql)).toContain("account_id");expect(String(sql)).not.toMatch(/\bsub=/);expect((params as unknown[])[0]).toBe(ACCOUNT);}
});
it("rejects a session whose device was revoked from the ledger",async()=>{
 signedIn();mocks.readLedger.mockResolvedValue({trusted:{devices:[],bridges:[]},checkpoint:{},ledger:{},sticky:{deviceIds:[],bridgeIds:[]}});config();
 expect((await GET()).status).toBe(401);expect((await POST(request("POST",subscription))).status).toBe(401);
 expect(mocks.query).not.toHaveBeenCalled();
});
it("checks same-origin BEFORE authentication",async()=>{
 config();signedIn();
 expect((await POST(request("POST",subscription,"https://other.test"))).status).toBe(403);
 expect((await DELETE(request("DELETE",{endpoint:subscription.endpoint},"https://other.test"))).status).toBe(403);
 expect(mocks.auth).not.toHaveBeenCalled();expect(mocks.readLedger).not.toHaveBeenCalled();
});
