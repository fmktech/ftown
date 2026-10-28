"use client";
import { useEffect, useState } from "react";
const OWNER_KEY="ftown:pushOwner";
let ownerGeneration=0;
let enableController:AbortController|null=null;
let endpointClaim:{endpoint:string;generation:number}|null=null;
class Superseded extends Error {}
function requireCurrent(generation:number):void {
  if(generation!==ownerGeneration) throw new Superseded();
}
async function currentRegistration(): Promise<ServiceWorkerRegistration> {
  const existing=await navigator.serviceWorker.getRegistration("/");
  if(existing?.active) return existing;
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}
async function setWorkerOwner(accountId: string | null,generation:number): Promise<void> {
  const registration=await currentRegistration();
  requireCurrent(generation);
  const worker=registration.active;
  if(!worker) throw new Error("Notification service is not ready. Try again.");
  const ownerHash=accountId===null?null:Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(accountId))),byte=>byte.toString(16).padStart(2,"0")).join("");
  requireCurrent(generation);
  await new Promise<void>((resolve,reject)=>{
    const channel=new MessageChannel();
    const timer=setTimeout(()=>{channel.port1.close();reject(new Error("Notification service is not ready. Try again."));},3000);
    channel.port1.onmessage=(event)=>{clearTimeout(timer);channel.port1.close();event.data?.ok?resolve():reject(new Error("Could not update notification privacy settings."));};
    requireCurrent(generation);
    worker.postMessage({type:"ftown-push-owner",ownerHash},[channel.port2]);
  });
  requireCurrent(generation);
}
export async function detachPushSubscription(): Promise<void> {
  const generation=++ownerGeneration;
  enableController?.abort();enableController=null;endpointClaim=null;
  localStorage.removeItem(OWNER_KEY);
  if(!("serviceWorker" in navigator)) return;
  try { await setWorkerOwner(null,generation); } catch { /* Still revoke the browser endpoint when worker storage is unavailable. */ }
  const registration=await navigator.serviceWorker.getRegistration("/");
  const subscription=await registration?.pushManager.getSubscription();
  if(subscription && generation===ownerGeneration) {
    try { await fetch("/api/push",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({endpoint:subscription.endpoint})}); }
    finally { if(generation===ownerGeneration) await subscription.unsubscribe(); }
  }
}
export function PushNotificationsControl({localMode=false,accountId,presentation="default"}:{localMode?:boolean;accountId:string;presentation?:"default"|"responsive"}) {
  const [state,setState]=useState<"loading"|"available"|"enabled"|"unavailable"|"denied"|"busy">("loading");
  const [detail,setDetail]=useState(""); const [publicKey,setPublicKey]=useState("");
  useEffect(()=>{
    let active=true;
    const generation=++ownerGeneration;
    const update=(next:typeof state,text="")=>{if(active && generation===ownerGeneration){setState(next);setDetail(text);}};
    if(localMode){update("unavailable","Push notifications require a hosted connection.");return;}
    if(!window.isSecureContext || !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      update("unavailable","This browser does not support push here. On iPhone or iPad, add FTown to the Home Screen.");return;
    }
    void(async()=>{
      try {
        const registration=await navigator.serviceWorker.getRegistration("/");
        const subscription=await registration?.pushManager.getSubscription();
        requireCurrent(generation);
        if(localStorage.getItem(OWNER_KEY)!==accountId) {
          await setWorkerOwner(null,generation); if(subscription) await subscription.unsubscribe();
          requireCurrent(generation);localStorage.removeItem(OWNER_KEY);
        }
        const response=await fetch("/api/push",{cache:"no-store"});
        const config=await response.json();
        requireCurrent(generation);
        if(!response.ok || !config.enabled || typeof config.publicKey!=="string") {update("unavailable","Push notifications are not configured on this server.");return;}
        if(active) setPublicKey(config.publicKey);
        if(Notification.permission==="denied") {update("denied","Notifications are blocked. Allow them in your browser settings.");return;}
        if(subscription && localStorage.getItem(OWNER_KEY)===accountId) {
          endpointClaim={endpoint:subscription.endpoint,generation};
          await setWorkerOwner(accountId,generation);
        }
        update(subscription && localStorage.getItem(OWNER_KEY)===accountId?"enabled":"available");
      } catch {update("unavailable","Push notifications are temporarily unavailable.");}
    })();
    return()=>{active=false;++ownerGeneration;enableController?.abort();};
  },[localMode,accountId]);
  const enable=async()=>{
    const generation=++ownerGeneration;
    const controller=new AbortController();enableController=controller;
    let subscription:PushSubscription|null=null;
    setState("busy");setDetail("");
    try {
      // Invoked directly by a click, before any await: browsers require a user gesture.
      const permissionRequest=Notification.requestPermission();
      await setWorkerOwner(null,generation);
      const permission=await permissionRequest;requireCurrent(generation);
      if(permission!=="granted"){setState(permission==="denied"?"denied":"available");setDetail("Notifications were not enabled.");return;}
      const registration=await currentRegistration();requireCurrent(generation);
      const key=Uint8Array.from(atob(publicKey.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
      subscription=await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
      requireCurrent(generation);endpointClaim={endpoint:subscription.endpoint,generation};
      const response=await fetch("/api/push",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(subscription.toJSON()),signal:controller.signal});
      requireCurrent(generation);
      if(!response.ok) throw new Error(response.status===409?"This browser subscription belongs to another account or the device limit was reached. Try enabling again.":"Could not save notifications. Try again.");
      await setWorkerOwner(accountId,generation);requireCurrent(generation);
      localStorage.setItem(OWNER_KEY,accountId);setState("enabled");
    } catch(error){
      // A superseded operation may revoke only the endpoint it still owns.
      if(subscription && (!endpointClaim || endpointClaim.generation===generation)) {
        await subscription.unsubscribe().catch(()=>{});
        await fetch("/api/push",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({endpoint:subscription.endpoint})}).catch(()=>{});
        if(endpointClaim?.generation===generation) endpointClaim=null;
      }
      if(generation!==ownerGeneration) return;
      localStorage.removeItem(OWNER_KEY);setState("available");setDetail(error instanceof Error?error.message:"Could not enable notifications.");
    } finally {if(enableController===controller) enableController=null;}
  };
  const disable=async()=>{
    setState("busy");
    try {await detachPushSubscription();setState("available");setDetail("");}
    catch {setState("available");setDetail("Browser notifications are off. Server cleanup will retry when its endpoint expires.");}
  };
  const label=state==="enabled"?"Disable push notifications":state==="busy"?"Updating notifications…":"Enable push notifications";
  const responsive=presentation==="responsive";
  return <div className={responsive?"min-w-0 md:w-auto":""} style={responsive?{fontSize:11}:{fontSize:11,padding:"8px 12px",maxWidth:280}}>
    <button type="button" onClick={()=>void(state==="enabled"?disable():enable())}
      aria-label={label} title={detail?`${label}: ${detail}`:label} data-push-state={state}
      className={responsive?"btn-ghost flex min-h-11 w-full items-center gap-2 text-left md:min-h-8 md:w-8 md:justify-center":""}
      disabled={!["available","enabled"].includes(state)}
      style={responsive?{padding:"4px 6px",cursor:["available","enabled"].includes(state)?"pointer":"default"}:{minHeight:36,cursor:["available","enabled"].includes(state)?"pointer":"default"}}>
      {responsive&&<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>{state==="enabled"&&<circle cx="19" cy="4" r="2" fill="currentColor" stroke="none"/>}</svg>}
      <span className={responsive?"md:sr-only":""}>{label}</span>
    </button>
    {detail && <p role="status" className={responsive?"mt-1 max-w-64 text-xs md:sr-only":""} style={responsive?undefined:{marginTop:4}}>{detail}</p>}
  </div>;
}
