import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { createECDH, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { login, getCentrifugoToken, sharedAccountId } from "../helpers/app";
import { BRIDGE_HOME, UI_BASE_URL } from "../helpers/config";
import { readBridgePointer } from "../helpers/bridge-api";
import { importAuthKey, requestRelayToken, signProof } from "../helpers/ledger-admin";

// OS permission/provider transport are simulated at browser API boundaries.
// Real authenticated routes, SQL state, worker receipt/privacy/display/click code run.
// Vanilla Chromium here reports Notification.permission denied despite granted
// Permissions API state, independently reproduced outside the application.
test("explicit push opt-in/opt-out and foreground/closed-page service-worker display/click",async({page,context},testInfo)=>{
 const key=createECDH("prime256v1");key.generateKeys();
 const subscription={endpoint:`https://fcm.googleapis.com/ftown-e2e-${randomUUID()}`,keys:{p256dh:key.getPublicKey().toString("base64url"),auth:Buffer.alloc(16,1).toString("base64url")}};
 await context.addInitScript((value)=>{
  let current:PushSubscription|null=null;
  let permission:NotificationPermission="default";let requests=0;
  Object.defineProperty(Notification,"permission",{get:()=>permission,configurable:true});
  Object.defineProperty(Notification,"requestPermission",{value:async()=>{requests++;permission="granted";return permission;},configurable:true});
  Object.defineProperty(Notification,"fixtureRequests",{get:()=>requests,configurable:true});
  const fake={endpoint:value.endpoint,toJSON:()=>value,unsubscribe:async()=>{current=null;return true;}} as unknown as PushSubscription;
  Object.defineProperty(ServiceWorkerRegistration.prototype,"pushManager",{get:()=>({getSubscription:async()=>current,subscribe:async()=>{current=fake;return fake;}})});
 },subscription);
 await login(page);
 // Retain diagnostics for the real Permissions API; Notification's OS boundary
 // is deliberately supplied by the synthetic provider fixture above.
 const permissionSnapshot=()=>page.evaluate(async()=>({
  origin:location.origin,path:location.pathname,secure:window.isSecureContext,
  notification:Notification.permission,
  fixtureRequests:(Notification as unknown as {fixtureRequests:number}).fixtureRequests,
  permissions:(await navigator.permissions.query({name:"notifications"})).state,
 }));
 const before=await permissionSnapshot();
 const actualOrigin=new URL(page.url()).origin;
 await context.clearPermissions();
 await context.grantPermissions(["notifications"],{origin:actualOrigin});
 const afterGrant=await permissionSnapshot();
 await page.reload();
 const afterReload=await permissionSnapshot();
 await testInfo.attach("push-permission.json",{body:JSON.stringify({before,afterGrant,afterReload,grantedOrigin:actualOrigin},null,2),contentType:"application/json"});
 expect(afterReload.secure,"push requires a secure localhost/test origin").toBe(true);
 expect(afterReload.notification,"synthetic permission starts undecided until the user's click").toBe("default");
 expect(afterReload.fixtureRequests).toBe(0);
 expect(afterReload.permissions).toBe("granted");
 const config=await page.request.get("/api/push");expect(config.status()).toBe(200);expect((await config.json()).enabled).toBe(true);
 await page.setViewportSize({width:1280,height:900});
 const pushControl=page.locator("[data-push-state]");await expect(pushControl).toHaveCount(1);
 await pushControl.evaluate(element=>element.setAttribute("data-e2e-push-instance","initial"));
 const enable=page.getByRole("button",{name:"Enable push notifications"});await expect(enable).toBeEnabled();
 expect(await page.evaluate(()=>localStorage.getItem("ftown:pushOwner"))).toBeNull();
 await enable.click();await expect(page.getByRole("button",{name:"Disable push notifications"})).toBeEnabled();
 expect(await page.evaluate(()=>(Notification as unknown as {fixtureRequests:number}).fixtureRequests)).toBe(1);
 await page.getByRole("button",{name:"Disable push notifications"}).click();await expect(enable).toBeEnabled();
 // Resizing the dashboard must not replace its owner-bound controller.
 await page.setViewportSize({width:390,height:844});
 await expect(pushControl).toHaveCount(1);
 await expect(pushControl).toHaveAttribute("data-e2e-push-instance","initial");
 await page.setViewportSize({width:1280,height:900});
 // Enable again before testing both foreground and closed-page delivery.
 await enable.click();await expect(page.getByRole("button",{name:"Disable push notifications"})).toBeEnabled();
 await page.screenshot({path:testInfo.outputPath("notifications-enabled.png"),fullPage:true});
 const ownerHash=await page.evaluate(async()=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(localStorage.getItem("ftown:pushOwner")!))),byte=>byte.toString(16).padStart(2,"0")).join(""));
 await page.evaluate(()=>navigator.serviceWorker.ready);
 const worker=context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
 await worker.evaluate(()=>{
  const scope=self as unknown as {testNotifications: {title:string;options:NotificationOptions}[];testOpenedUrls:string[];registration:ServiceWorkerRegistration;clients:{openWindow:(url:string)=>Promise<null>}};
  scope.testNotifications=[];scope.testOpenedUrls=[];
  // Synthetic notificationclick has no OS user activation; capture this browser
  // boundary, then navigate a real context page to the exact requested URL.
  scope.clients.openWindow=async(url)=>{scope.testOpenedUrls.push(url);return null;};
  scope.registration.showNotification=async(title,options)=>{scope.testNotifications.push({title,options:options??{}});};
 });
 const foregroundId=randomUUID().replace(/-/g,"").repeat(2);
 await page.bringToFront();
 expect(await page.evaluate(()=>document.visibilityState)).toBe("visible");
 await worker.evaluate(async({id,ownerHash})=>{
  const payload={id,ownerHash,sessionId:"foreground-push-session",title:"Foreground question",body:"Agent: review while the app is open"};
  let pending=Promise.resolve();const event=new Event("push");
  Object.defineProperties(event,{data:{value:{json:()=>payload}},waitUntil:{value:(promise:Promise<void>)=>{pending=promise;}}});
  self.dispatchEvent(event);await pending;
 },{id:foregroundId,ownerHash});
 await expect.poll(()=>worker.evaluate(()=>(self as unknown as {testNotifications:unknown[]}).testNotifications.length)).toBe(1);
 const foreground=await worker.evaluate(()=>(self as unknown as {testNotifications:{title:string;options:NotificationOptions}[]}).testNotifications[0]);
 expect(foreground).toMatchObject({title:"FTown attention",options:{body:"Open FTown to view details.",data:{sessionId:"foreground-push-session"}}});
 expect(JSON.stringify(foreground)).not.toContain("Foreground question");
 expect(JSON.stringify(foreground)).not.toContain("Agent: review while the app is open");
 // End all app pages; a distinct provider receipt still displays through the
 // same real service worker, independently of the foreground notification.
 await page.close();
 const id=randomUUID().replace(/-/g,"").repeat(2);
 await worker.evaluate(async({id,ownerHash})=>{
  const payload={id,ownerHash,sessionId:"push-test-session",title:"Question",body:"Agent: choose"};
  let pending=Promise.resolve();const event=new Event("push");
  Object.defineProperties(event,{data:{value:{json:()=>payload}},waitUntil:{value:(promise:Promise<void>)=>{pending=promise;}}});
  self.dispatchEvent(event);await pending;
 },{id,ownerHash});
 await expect.poll(()=>worker.evaluate(()=>(self as unknown as {testNotifications:unknown[]}).testNotifications.length)).toBe(2);
 const closedPage=await worker.evaluate(()=>(self as unknown as {testNotifications:{title:string;options:NotificationOptions}[]}).testNotifications[1]);
 expect(closedPage).toMatchObject({title:"FTown attention",options:{body:"Open FTown to view details.",data:{sessionId:"push-test-session"}}});
 expect(JSON.stringify(closedPage)).not.toContain("Question");
 expect(JSON.stringify(closedPage)).not.toContain("Agent: choose");
 await worker.evaluate(async({id,ownerHash})=>{
  let pending=Promise.resolve();const event=new Event("push");
  Object.defineProperties(event,{data:{value:{json:()=>({id,ownerHash,sessionId:"push-test-session",title:"Question",body:"duplicate"})}},waitUntil:{value:(promise:Promise<void>)=>{pending=promise;}}});
  self.dispatchEvent(event);await pending;
 },{id,ownerHash});
 await expect.poll(()=>worker.evaluate(()=>(self as unknown as {testNotifications:unknown[]}).testNotifications.length)).toBe(2);
 await worker.evaluate(async()=>{
  let pending=Promise.resolve();const event=new Event("notificationclick");
  Object.defineProperties(event,{notification:{value:{close(){},data:{sessionId:"push-test-session"}}},waitUntil:{value:(promise:Promise<void>)=>{pending=promise;}}});
  self.dispatchEvent(event);await pending;
 });
 const requested=await worker.evaluate(()=>(self as unknown as {testOpenedUrls:string[]}).testOpenedUrls);
 expect(requested).toEqual([`${new URL(UI_BASE_URL).origin}/dashboard?session=push-test-session`]);
 const opened=await context.newPage();await opened.goto(requested[0]);
 await opened.waitForURL("**/dashboard?session=push-test-session");
 expect(new URL(opened.url()).origin).toBe(new URL(UI_BASE_URL).origin);
 await opened.request.delete("/api/push",{headers:{origin:new URL(UI_BASE_URL).origin},data:{endpoint:subscription.endpoint}});
});

test("real push API ignores legacy idle and durably deduplicates questions without recipients",async({page})=>{
 const idle=`idle:${randomUUID()}`;const nextIdle=`idle:${randomUUID()}`;
 await login(page);const accountId=sharedAccountId();const sessionId=randomUUID();
 // A real bridge relay token: sign a relay proof with the shared bridge's auth key.
 const home=BRIDGE_HOME;
 const identity=JSON.parse(readFileSync(join(home,".ftown/data/security/ledger-identity.json"),"utf8")) as {authPrivateKey:JsonWebKey};
 const bridgeId=readBridgePointer(home).bridgeId;
 const relay=await requestRelayToken(await signProof(await importAuthKey(identity.authPrivateKey),{accountId,kind:"bridge",keyId:bridgeId,purpose:"relay"}));
 expect(relay.status,JSON.stringify(relay.body)).toBe(200);
 const token=String(relay.body.token);
 const db=new pg.Client({host:process.env.PGHOST??"localhost",port:Number(process.env.PGPORT??5432),user:process.env.PGUSER??"ftown",password:process.env.PGPASSWORD??"ftown",database:process.env.PGDATABASE??"ftown"});
 await db.connect();
 const post=(eventKey:string,kind:string,overrideToken=token)=>page.request.post("/api/push/events",{headers:{authorization:`Bearer ${overrideToken}`},data:{sessionId,sessionName:"Agent",eventKey,kind,title:"Ready",message:"Fixture",occurredAt:new Date().toISOString()}});
 const subscription={endpoint:`https://fcm.googleapis.com/no-backlog-${randomUUID()}`,keys:{p256dh:"",auth:Buffer.alloc(16,1).toString("base64url")}};
 try {
  const browserToken=await getCentrifugoToken(page);expect((await post(idle,"idle",browserToken)).status()).toBe(401);
  expect((await post(idle,"idle","not-a-token")).status()).toBe(401);
  for(let n=0;n<2;n++){const response=await post(idle,"idle");expect(response.status()).toBe(202);expect(await response.json()).toEqual({accepted:true,pending:false});}
  expect((await db.query("SELECT COUNT(*)::int AS count FROM push_events WHERE account_id=$1 AND session_id=$2 AND kind='idle'",[accountId,sessionId])).rows[0].count).toBe(0);
  // A later subscription still must not turn legacy idle into a delivery.
  const key=createECDH("prime256v1");key.generateKeys();subscription.keys.p256dh=key.getPublicKey().toString("base64url");
  expect((await page.request.post("/api/push",{headers:{origin:new URL(UI_BASE_URL).origin},data:subscription})).status()).toBe(201);
  expect((await post(idle,"idle")).status()).toBe(202);
  expect((await db.query("SELECT COUNT(*)::int AS count FROM push_deliveries d JOIN push_events e ON e.id=d.event_id WHERE e.account_id=$1 AND e.session_id=$2",[accountId,sessionId])).rows[0].count).toBe(0);
  expect((await page.request.delete("/api/push",{headers:{origin:new URL(UI_BASE_URL).origin},data:{endpoint:subscription.endpoint}})).status()).toBe(204);
  // A subsequent idle period is also ignored; questions still deduplicate.
  for(let n=0;n<2;n++){const response=await post(nextIdle,"idle");expect(response.status()).toBe(202);expect(await response.json()).toEqual({accepted:true,pending:false});}
  const question=`question:${randomUUID()}`;
  await Promise.all([post(question,"question"),post(question,"question")]).then(responses=>responses.forEach(response=>expect(response.status()).toBe(202)));
  const {rows}=await db.query("SELECT kind,COUNT(*)::int AS count FROM push_events WHERE account_id=$1 AND session_id=$2 GROUP BY kind ORDER BY kind",[accountId,sessionId]);
  expect(rows).toEqual([{kind:"question",count:1}]);
  expect((await db.query("SELECT COUNT(*)::int AS count FROM push_deliveries d JOIN push_events e ON e.id=d.event_id WHERE e.account_id=$1 AND e.session_id=$2",[accountId,sessionId])).rows[0].count).toBe(0);
 }finally{
  await page.request.delete("/api/push",{headers:{origin:new URL(UI_BASE_URL).origin},data:{endpoint:subscription.endpoint}}).catch(()=>undefined);
  await db.query("DELETE FROM push_events WHERE account_id=$1 AND session_id=$2",[accountId,sessionId]);await db.end();
 }
});
