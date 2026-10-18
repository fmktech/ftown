import { afterEach,expect,it,vi } from "vitest";
import jwt from "jsonwebtoken";
import webpush from "web-push";
const mocks=vi.hoisted(()=>({query:vi.fn(),send:vi.fn()}));
vi.mock("@/lib/db",()=>({getDb:()=>({query:mocks.query})}));
vi.mock("@/lib/push",async(original)=>({...await original<typeof import("@/lib/push")>(),sendBrowserPush:mocks.send}));
import { POST } from "./route";
const event={sessionId:"s",sessionName:"Agent",kind:"idle",eventKey:"idle",title:"Idle",message:"Ready",occurredAt:new Date().toISOString()};
function request(bridge=true){const token=jwt.sign({sub:"owner",...(bridge?{info:{bridgeId:"bridge"}}:{})},"unit-signing-secret-for-local-fixtures-only",{audience:"ftown:centrifugo",expiresIn:60});return new Request("https://app.test/api/push/events",{method:"POST",headers:{authorization:`Bearer ${token}`},body:JSON.stringify(event)});}
function configure(pending:number,claim=true){
 const keys=webpush.generateVAPIDKeys();vi.stubEnv("VAPID_PUBLIC_KEY",keys.publicKey);vi.stubEnv("VAPID_PRIVATE_KEY",keys.privateKey);vi.stubEnv("VAPID_SUBJECT","mailto:test@example.test");vi.stubEnv("CENTRIFUGO_TOKEN_SECRET","unit-signing-secret-for-local-fixtures-only");
 mocks.query.mockImplementation(async(text:string)=>{
  if(text.includes("SELECT bridge_id"))return[{bridge_id:"bridge"}];
  if(text.includes("RETURNING failed_count"))return[{failed_count:1}];
  if(text.includes("SELECT payload"))return[{payload:event}];
  if(text.includes("WITH claimed"))return claim?[{endpoint_hash:"endpoint",endpoint:"https://fcm.googleapis.com/x",p256dh:"fixture",auth:"fixture"}]:[];
  if(text.includes("COUNT(*) AS count"))return[{count:pending}];return[];
 });
}
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
it("rejects ordinary browser connection tokens before delivery",async()=>{configure(0);expect((await POST(request(false))).status).toBe(401);expect(mocks.send).not.toHaveBeenCalled();});
it("returns accepted after successful provider delivery",async()=>{configure(0);mocks.send.mockResolvedValue(201);const response=await POST(request());expect(response.status).toBe(202);expect(await response.json()).toEqual({accepted:true,pending:0});});
it("leaves transient delivery pending for bounded bridge retry",async()=>{configure(1);mocks.send.mockResolvedValue(503);const response=await POST(request());expect(response.status).toBe(503);expect(await response.json()).toEqual({accepted:true,pending:1});});
it("removes expired endpoints without retrying them",async()=>{configure(0);mocks.send.mockResolvedValue(410);expect((await POST(request())).status).toBe(202);});

it("keeps another request's lease pending without sending and never resends completed deliveries",async()=>{
 configure(1,false);expect((await POST(request())).status).toBe(503);expect(mocks.send).not.toHaveBeenCalled();
 configure(0,false);expect((await POST(request())).status).toBe(202);expect(mocks.send).not.toHaveBeenCalled();
});
