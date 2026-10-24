import { test, expect } from "@playwright/test";
import { createECDH, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import pg from "pg";
import { registerAndLogin, getCentrifugoToken } from "../helpers/app";
import { CENTRIFUGO_TOKEN_SECRET, UI_BASE_URL } from "../helpers/config";

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
 await registerAndLogin(page);
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
 const enable=page.getByRole("button",{name:"Enable push notifications"});await expect(enable).toBeEnabled();
 expect(await page.evaluate(()=>localStorage.getItem("ftown:pushOwner"))).toBeNull();
 await enable.click();await expect(page.getByRole("button",{name:"Disable push notifications"})).toBeEnabled();
 expect(await page.evaluate(()=>(Notification as unknown as {fixtureRequests:number}).fixtureRequests)).toBe(1);
 await page.getByRole("button",{name:"Disable push notifications"}).click();await expect(enable).toBeEnabled();
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
 expect(await worker.evaluate(()=>(self as unknown as {testNotifications:{title:string;options:NotificationOptions}[]}).testNotifications[0]))
  .toMatchObject({title:"Foreground question",options:{body:"Agent: review while the app is open",data:{sessionId:"foreground-push-session"}}});
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

test("real push API binds bridge owner and durably deduplicates idle cycles/questions without recipients",async({page})=>{
 const idle=`idle:${randomUUID()}`;const nextIdle=`idle:${randomUUID()}`;
 const user=await registerAndLogin(page);const bridgeId=`push-${randomUUID()}`;const sessionId=randomUUID();
 const db=new pg.Client({host:process.env.PGHOST??"localhost",port:Number(process.env.PGPORT??5432),user:process.env.PGUSER??"ftown",password:process.env.PGPASSWORD??"ftown",database:process.env.PGDATABASE??"ftown"});
 await db.connect();
 const token=jwt.sign({sub:user.email,info:{bridgeId}},CENTRIFUGO_TOKEN_SECRET,{audience:"ftown:centrifugo",expiresIn:60});
 const post=(eventKey:string,kind:string,overrideToken=token)=>page.request.post("/api/push/events",{headers:{authorization:`Bearer ${overrideToken}`},data:{sessionId,sessionName:"Agent",eventKey,kind,title:"Ready",message:"Fixture",occurredAt:new Date().toISOString()}});
 try {
  await db.query("INSERT INTO bridge_refresh(bridge_id,sub,current_jti) VALUES($1,$2,'test-jti')",[bridgeId,user.email]);
  const browserToken=await getCentrifugoToken(page);expect((await post(idle,"idle",browserToken)).status()).toBe(401);
  for(let n=0;n<2;n++)expect((await post(idle,"idle")).status()).toBe(202);
  // First ingest freezes recipients: later subscribers cannot get this idle replay.
  const key=createECDH("prime256v1");key.generateKeys();
  const subscription={endpoint:`https://fcm.googleapis.com/no-backlog-${randomUUID()}`,keys:{p256dh:key.getPublicKey().toString("base64url"),auth:Buffer.alloc(16,1).toString("base64url")}};
  expect((await page.request.post("/api/push",{headers:{origin:new URL(UI_BASE_URL).origin},data:subscription})).status()).toBe(201);
  expect((await post(idle,"idle")).status()).toBe(202);
  expect((await db.query("SELECT COUNT(*)::int AS count FROM push_deliveries d JOIN push_events e ON e.id=d.event_id WHERE e.sub=$1 AND e.bridge_id=$2",[user.email,bridgeId])).rows[0].count).toBe(0);
  expect((await page.request.delete("/api/push",{headers:{origin:new URL(UI_BASE_URL).origin},data:{endpoint:subscription.endpoint}})).status()).toBe(204);
  // A subsequent idle period has its own UUID; retries of either stay deduplicated.
  for(let n=0;n<2;n++)expect((await post(nextIdle,"idle")).status()).toBe(202);
  const question=`question:${randomUUID()}`;
  await Promise.all([post(question,"question"),post(question,"question")]).then(responses=>responses.forEach(response=>expect(response.status()).toBe(202)));
  const {rows}=await db.query("SELECT kind,COUNT(*)::int AS count FROM push_events WHERE sub=$1 AND bridge_id=$2 GROUP BY kind ORDER BY kind",[user.email,bridgeId]);
  expect(rows).toEqual([{kind:"idle",count:2},{kind:"question",count:1}]);
  expect((await db.query("SELECT COUNT(*)::int AS count FROM push_deliveries d JOIN push_events e ON e.id=d.event_id WHERE e.sub=$1 AND e.bridge_id=$2",[user.email,bridgeId])).rows[0].count).toBe(0);
  await db.query("UPDATE bridge_refresh SET sub='different-owner' WHERE bridge_id=$1",[bridgeId]);expect((await post(idle,"idle")).status()).toBe(403);
  await db.query("UPDATE bridge_refresh SET sub=$1,current_jti='revoked' WHERE bridge_id=$2",[user.email,bridgeId]);expect((await post(idle,"idle")).status()).toBe(403);
 }finally{await db.query("DELETE FROM push_events WHERE sub=$1 AND bridge_id=$2",[user.email,bridgeId]);await db.query("DELETE FROM bridge_refresh WHERE bridge_id=$1",[bridgeId]);await db.end();}
});
