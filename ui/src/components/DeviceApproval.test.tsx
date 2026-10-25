// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateEndpoint } from "@security/crypto";
import { accountComparisonCode, createAccountEnrollment, encodeAccountEnrollmentLink, generateAccountSigningIdentity } from "@security/account-crypto";
import type { AccountSecurityClient, AccountSecuritySnapshot } from "@/lib/account-security-client";
import { PrivateDeviceApproval as DeviceApproval, DeviceApprovalPage } from "./DeviceApproval";
const owner = "00000000-0000-4000-8000-000000000001";
const checking = { status: "checking", identity: null, signing: null, trust: null, legacyBridges: [], historyExists: false, code: null, offline: false } as const;
vi.mock("@/hooks/useAccountSecurity", () => ({ useAccountSecurity: () => ({ client: null, snapshot: checking }) }));
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); sessionStorage.clear(); window.history.replaceState(null, "", "/devices/approve"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
async function fixture(candidateOwner = owner) {
  const candidate = await generateEndpoint(candidateOwner, "browser"); const signing = await generateAccountSigningIdentity();
  const link = await createAccountEnrollment(candidate, "Phone", signing, null);
  let state: AccountSecuritySnapshot = { ...checking, legacyBridges: [], status: "ready", identity: candidate, signing, historyExists: true };
  const approveDevice = vi.fn().mockResolvedValue(undefined); const requestDevice = vi.fn().mockResolvedValue(link); const finishDevice = vi.fn().mockResolvedValue(false);
  const resumeDevice = vi.fn().mockResolvedValue(null);
  const listeners = new Set<() => void>();
  const update = (next: AccountSecuritySnapshot) => { state = next; for (const listener of listeners) listener(); };
  const client = { resumeDevice, snapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, approveDevice, requestDevice, finishDevice } as unknown as AccountSecurityClient;
  return { link, client, approveDevice, finishDevice, requestDevice, resumeDevice, state, update };
}
it("scrubs a valid incoming fragment and preserves exact comparison/approval through StrictMode remount", async () => {
  const f = await fixture(); window.history.replaceState(null, "", `/devices/approve#account=${encodeAccountEnrollmentLink(f.link)}`);
  render(<StrictMode><DeviceApproval ownerId={owner} email="owner@example.test" client={f.client} incoming /></StrictMode>);
  expect(window.location.hash).toBe("");
  await waitFor(async () => expect(screen.getByLabelText("Comparison code").textContent).toBe(await accountComparisonCode(f.link)));
  fireEvent.click(screen.getByRole("button", { name: "Codes match — approve device" }));
  await waitFor(() => expect(f.approveDevice).toHaveBeenCalledWith(f.link));
  expect(await screen.findByText(/Device approved\./)).toBeTruthy();
  expect(window.location.search).not.toContain(f.link.secret);
});
it("a link for another account cannot enable approval or reveal supplied raw errors", async () => {
  const f = await fixture("00000000-0000-4000-8000-000000000002");
  window.history.replaceState(null, "", `/devices/approve#account=${encodeAccountEnrollmentLink(f.link)}`);
  render(<DeviceApproval ownerId={owner} email="owner@example.test" client={f.client} incoming />);
  await screen.findByRole("alert");
  expect((screen.getByRole("button", { name: "Codes match — approve device" }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.approveDevice).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain(f.link.secret);
});
it("the requesting device displays a fragment-only link and waits for actual approval", async () => {
  const f = await fixture(); render(<DeviceApproval ownerId={owner} email="owner@example.test" client={f.client} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Create approval link" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "Phone" } });
  fireEvent.click(screen.getByRole("button", { name: "Create approval link" }));
  const input = await screen.findByLabelText("Private approval link") as HTMLInputElement;
  expect(new URL(input.value).hash).toContain("account="); expect(new URL(input.value).search).toBe("");
  await waitFor(() => expect(f.finishDevice).toHaveBeenCalledWith(f.link));
  expect(screen.queryByText(/This device is approved\./)).toBeNull();
});

it("restores the existing waiting request on remount without creating a replacement", async () => {
  const f = await fixture(); f.resumeDevice.mockResolvedValue(f.link);
  render(<DeviceApproval ownerId={owner} email="owner@example.test" client={f.client} />);
  expect(await screen.findByLabelText("Private approval link")).toBeTruthy();
  await waitFor(() => expect(f.finishDevice).toHaveBeenCalledWith(f.link));
  expect(f.requestDevice).not.toHaveBeenCalled();
});

it("clears a transient polling error after a validated still-pending response", async () => {
  const f = await fixture(); f.resumeDevice.mockResolvedValue(f.link);
  f.finishDevice.mockRejectedValueOnce({ code: "account_storage_unavailable" }).mockResolvedValue(false);
  let poll: () => void = () => {};
  vi.spyOn(globalThis, "setInterval").mockImplementation(callback => { poll = callback as () => void; return 1 as unknown as ReturnType<typeof setInterval>; });
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  render(<DeviceApproval ownerId={owner} email="owner@example.test" client={f.client} />);
  await screen.findByRole("alert");
  await act(async () => { poll(); });
  expect(f.finishDevice).toHaveBeenCalledTimes(2); expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/This device is approved\./)).toBeNull();
});

it("stops polling an expired request and leaves an explicit refresh action", async () => {
  const f = await fixture(); f.resumeDevice.mockResolvedValue(f.link);
  f.finishDevice.mockRejectedValue({ code: "account_enrollment_expired" });
  const clear = vi.spyOn(globalThis, "clearInterval");
  const interval = vi.spyOn(globalThis, "setInterval");
  render(<DeviceApproval ownerId={owner} email="owner@example.test" client={f.client} />);
  await screen.findByRole("alert");
  const polling = interval.mock.results[0].value;
  expect(clear).toHaveBeenCalledWith(polling);
  expect(f.finishDevice).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Refresh approval request" })).toBeTruthy();
});

it("refreshes a terminal request without restarting its old poll or carrying its error into the replacement", async () => {
  const f = await fixture(); const replacement = await fixture(); f.resumeDevice.mockResolvedValue(f.link);
  f.finishDevice.mockRejectedValueOnce({ code: "account_enrollment_expired" }).mockResolvedValue(false);
  f.requestDevice.mockResolvedValue(replacement.link);
  render(<DeviceApproval ownerId={owner} email="owner@example.test" client={f.client} />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Refresh approval request" }));
  await waitFor(() => expect(f.finishDevice).toHaveBeenLastCalledWith(replacement.link));
  expect(f.finishDevice).toHaveBeenCalledTimes(2); expect(screen.queryByRole("alert")).toBeNull();
});

it("ignores a request response that completes after the account context changed", async () => {
  const first = await fixture(); const second = await fixture();
  let release: (link: typeof first.link) => void = () => {};
  first.requestDevice.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const view = render(<DeviceApproval ownerId={owner} email="first@example.test" client={first.client} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Create approval link" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Create approval link" }));
  view.rerender(<DeviceApproval ownerId="00000000-0000-4000-8000-000000000002" email="second@example.test" client={second.client} />);
  await act(async () => { release(first.link); });
  expect(screen.queryByLabelText("Private approval link")).toBeNull(); expect(first.finishDevice).not.toHaveBeenCalled();
});

it("does not turn a late completion for the old account into approval for the new view", async () => {
  const first = await fixture(); const second = await fixture();
  first.resumeDevice.mockResolvedValue(first.link);
  let finish: (value: boolean) => void = () => {};
  first.finishDevice.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const onApproved = vi.fn();
  const view = render(<DeviceApproval ownerId={owner} email="first@example.test" client={first.client} onApproved={onApproved} />);
  await waitFor(() => expect(first.finishDevice).toHaveBeenCalledTimes(1));
  view.rerender(<DeviceApproval ownerId="00000000-0000-4000-8000-000000000002" email="second@example.test" client={second.client} onApproved={onApproved} />);
  await act(async () => { finish(true); });
  expect(onApproved).not.toHaveBeenCalled(); expect(screen.queryByText(/This device is approved\./)).toBeNull();
});

it("blocks unauthorized incoming approval and clears its stale authority error only after validated readiness", async () => {
  const f = await fixture(); window.history.replaceState(null, "", `/devices/approve#account=${encodeAccountEnrollmentLink(f.link)}`);
  f.update({ ...f.state, status: "unapproved" });
  render(<DeviceApproval ownerId={owner} email="owner@example.test" client={f.client} incoming />);
  await screen.findByLabelText("Comparison code");
  const button = screen.getByRole("button", { name: "Codes match — approve device" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true); expect(f.approveDevice).not.toHaveBeenCalled();
  act(() => f.update({ ...f.state }));
  f.approveDevice.mockRejectedValueOnce({ code: "account_approval_required" });
  fireEvent.click(button); await screen.findByRole("alert");
  expect(button.disabled).toBe(true);
  act(() => f.update({ ...f.state }));
  expect(screen.queryByRole("alert")).toBeNull(); expect(button.disabled).toBe(false);
});

it("retains the exact incoming request for delivery retry and ignores success after unmount", async () => {
  const f = await fixture(); window.history.replaceState(null, "", `/devices/approve#account=${encodeAccountEnrollmentLink(f.link)}`);
  let approve: () => void = () => {};
  f.approveDevice.mockImplementationOnce(() => Promise.reject({ code: "account_storage_unavailable" }))
    .mockImplementation(() => new Promise<void>(resolve => { approve = resolve; }));
  const view = render(<DeviceApproval ownerId={owner} email="owner@example.test" client={f.client} incoming />);
  await screen.findByLabelText("Comparison code");
  const button = screen.getByRole("button", { name: "Codes match — approve device" });
  fireEvent.click(button); await screen.findByRole("alert");
  const saved = sessionStorage.getItem("ftown:account-link:/devices/approve"); expect(saved).not.toBeNull();
  fireEvent.click(button); await waitFor(() => expect(f.approveDevice).toHaveBeenCalledTimes(2));
  expect(f.approveDevice.mock.calls.map(call => call[0])).toEqual([f.link, f.link]);
  view.unmount(); await act(async () => { approve(); });
  expect(sessionStorage.getItem("ftown:account-link:/devices/approve")).toBe(saved);
});

it("keeps the bounded public request continuation through anonymous sign-in without a fragment", async () => {
  const requestId = "A".repeat(43); window.history.replaceState(null, "", `/devices/approve?request=${requestId}`);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("null", { status: 200 })));
  render(<DeviceApprovalPage />);
  const link = await screen.findByRole("link", { name: /^Sign in$/ });
  const destination = new URL(link.getAttribute("href")!, window.location.origin);
  expect(destination.searchParams.get("returnTo")).toBe(`/devices/approve?request=${requestId}`);
  expect(destination.hash).toBe("");
});
