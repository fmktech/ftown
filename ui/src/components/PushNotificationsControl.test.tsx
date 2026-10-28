// @vitest-environment jsdom
import { afterEach,expect,it,vi } from "vitest";
import { webcrypto } from "node:crypto";
import { cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { PushNotificationsControl, detachPushSubscription } from "./PushNotificationsControl";
const permission=vi.fn();const subscribe=vi.fn();const unsubscribe=vi.fn();
function fixture(enabled=true){
 Object.defineProperty(window,"isSecureContext",{value:true,configurable:true});
 Object.defineProperty(window,"PushManager",{value:class{},configurable:true});
 Object.defineProperty(window,"Notification",{value:{permission:"default",requestPermission:permission},configurable:true});
 const subscription={endpoint:"https://fcm.googleapis.com/x",toJSON:()=>({endpoint:"https://fcm.googleapis.com/x",keys:{p256dh:"fixture",auth:"fixture"}}),unsubscribe};
 Object.defineProperty(window,"crypto",{value:webcrypto,configurable:true});
 const registration={active:{postMessage:(_value:unknown,ports:MessagePort[])=>ports[0].postMessage({ok:true})},pushManager:{getSubscription:async()=>null,subscribe}};
 Object.defineProperty(navigator,"serviceWorker",{value:{getRegistration:async()=>registration,ready:Promise.resolve(registration),register:async()=>registration},configurable:true});
 subscribe.mockResolvedValue(subscription);permission.mockResolvedValue("granted");unsubscribe.mockResolvedValue(true);
 vi.stubGlobal("fetch",vi.fn(async(_input,options)=>new Response(JSON.stringify(options?.method?{enabled:true}:{enabled,publicKey:"BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}),{status:options?.method?201:200})));
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.resetAllMocks();localStorage.clear();});
it("requests permission only after explicit enable and permits opt-out",async()=>{
 fixture();render(<PushNotificationsControl accountId="owner"/>);
 await waitFor(()=>expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false));
 expect(permission).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"Enable push notifications"}));
 await screen.findByRole("button",{name:"Disable push notifications"});expect(permission).toHaveBeenCalledTimes(1);expect(localStorage.getItem("ftown:pushOwner")).toBe("owner");
});
it("does not ask for permission when server configuration is unavailable",async()=>{
 fixture(false);render(<PushNotificationsControl accountId="owner"/>);
 await screen.findByText(/not configured/);expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);expect(permission).not.toHaveBeenCalled();
});
it("makes local-mode limitations explicit",async()=>{
 fixture();render(<PushNotificationsControl localMode accountId="owner"/>);expect(screen.getByText(/hosted connection/)).toBeTruthy();expect(permission).not.toHaveBeenCalled();
});

it("does not prompt when the schema is unavailable",async()=>{
 fixture();vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({error:"push_unavailable"}),{status:503})));
 render(<PushNotificationsControl accountId="owner"/>);await screen.findByText(/not configured/);expect(permission).not.toHaveBeenCalled();
});

it("clears previous-account worker binding even if its browser subscription vanished",async()=>{
 fixture();localStorage.setItem("ftown:pushOwner","previous-owner");
 const worker=await navigator.serviceWorker.getRegistration("/");
 const post=vi.spyOn(worker!.active!,"postMessage");
 render(<PushNotificationsControl accountId="new-owner"/>);
 await waitFor(()=>expect(localStorage.getItem("ftown:pushOwner")).toBeNull());
 expect(post.mock.calls.some(([value])=>value.type==="ftown-push-owner" && value.ownerHash===null)).toBe(true);
});

it("late successful enable cannot restore ownership after logout",async()=>{
 fixture();let completePost!:(response:Response)=>void;
 vi.stubGlobal("fetch",vi.fn(async(_input,options)=>{
  if(options?.method==="POST") return new Promise<Response>(resolve=>{completePost=resolve;});
  return new Response(options?.method?null:JSON.stringify({enabled:true,publicKey:"BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}),{status:options?.method?204:200});
 }));
 const registration=await navigator.serviceWorker.getRegistration("/");
 const post=vi.spyOn(registration!.active!,"postMessage");
 const view=render(<PushNotificationsControl accountId="owner"/>);
 await waitFor(()=>expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Enable push notifications"}));
 await waitFor(()=>expect(completePost).toBeDefined());
 await detachPushSubscription();view.unmount();
 completePost(new Response(JSON.stringify({enabled:true}),{status:201}));
 await waitFor(()=>expect(unsubscribe).toHaveBeenCalled());
 expect(localStorage.getItem("ftown:pushOwner")).toBeNull();
 expect(post.mock.calls.every(([value])=>value.ownerHash===null)).toBe(true);
});

it("preserves the notification controller when presentation changes and requests permission synchronously on click",async()=>{
 fixture();const view=render(<PushNotificationsControl accountId="owner" presentation="responsive"/>);
 await waitFor(()=>expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false));
 const initialRequests=vi.mocked(fetch).mock.calls.length;
 expect(permission).not.toHaveBeenCalled();
 view.rerender(<PushNotificationsControl accountId="owner" presentation="default"/>);
 expect(vi.mocked(fetch).mock.calls).toHaveLength(initialRequests);
 fireEvent.click(screen.getByRole("button",{name:"Enable push notifications"}));
 expect(permission).toHaveBeenCalledTimes(1);
 await screen.findByRole("button",{name:"Disable push notifications"});
 view.rerender(<PushNotificationsControl accountId="owner" presentation="responsive"/>);
 expect(screen.getAllByRole("button",{name:"Disable push notifications"})).toHaveLength(1);
 expect(localStorage.getItem("ftown:pushOwner")).toBe("owner");
 expect(vi.mocked(fetch).mock.calls.filter(([,options])=>!options?.method)).toHaveLength(1);
});

it("explains a disabled notification control on hover and focus", () => {
 fixture();render(<PushNotificationsControl localMode accountId="owner" presentation="responsive"/>);
 const button=screen.getByRole("button",{name:"Enable push notifications"});
 const trigger=button.parentElement!;
 fireEvent.mouseEnter(trigger);
 expect(screen.getByRole("tooltip").textContent).toContain("require a hosted connection");
 fireEvent.mouseLeave(trigger);
 fireEvent.focus(trigger);
 expect(trigger.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
 expect(permission).not.toHaveBeenCalled();
});
