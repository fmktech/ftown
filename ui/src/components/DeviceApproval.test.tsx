// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateEndpoint } from "@security/crypto";
import { accountComparisonCode, createAccountEnrollment, encodeAccountEnrollmentLink, generateAccountSigningIdentity } from "@security/account-crypto";
import type { AccountSecurityClient, AccountSecuritySnapshot } from "@/lib/account-security-client";
import { DeviceApproval } from "./DeviceApproval";
const owner = "00000000-0000-4000-8000-000000000001";
const checking = { status: "checking", identity: null, signing: null, trust: null, legacyBridges: [], historyExists: false, code: null, offline: false } as const;
vi.mock("@/hooks/useAccountSecurity", () => ({ useAccountSecurity: () => ({ client: null, snapshot: checking }) }));
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); sessionStorage.clear(); window.history.replaceState(null, "", "/devices/approve"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
async function fixture(candidateOwner = owner) {
  const candidate = await generateEndpoint(candidateOwner, "browser"); const signing = await generateAccountSigningIdentity();
  const link = await createAccountEnrollment(candidate, "Phone", signing, null);
  const state: AccountSecuritySnapshot = { ...checking, legacyBridges: [], status: "ready", identity: candidate, signing, historyExists: true };
  const approveDevice = vi.fn().mockResolvedValue(undefined); const requestDevice = vi.fn().mockResolvedValue(link); const finishDevice = vi.fn().mockResolvedValue(false);
  const client = { snapshot: () => state, subscribe: () => () => {}, approveDevice, requestDevice, finishDevice } as unknown as AccountSecurityClient;
  return { link, client, approveDevice, finishDevice };
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
  fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "Phone" } });
  fireEvent.click(screen.getByRole("button", { name: "Create approval link" }));
  const input = await screen.findByLabelText("Private approval link") as HTMLInputElement;
  expect(new URL(input.value).hash).toContain("account="); expect(new URL(input.value).search).toBe("");
  await waitFor(() => expect(f.finishDevice).toHaveBeenCalledWith(f.link));
  expect(screen.queryByText(/This device is approved\./)).toBeNull();
});
