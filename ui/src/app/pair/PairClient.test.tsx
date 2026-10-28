// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAccountEnrollment, encodeAccountEnrollmentLink, generateAccountBridgeCandidate } from "@security/account-crypto";
import { PairClient } from "./PairClient";
const mocks = vi.hoisted(() => ({ approve: vi.fn(), snapshot: { status: "unapproved", historyExists: false, bootstrapRecoverable: false, offline: false, code: null } }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock("@/hooks/useAccountSecurity", () => ({ useAccountSecurity: () => ({ client: { approve: mocks.approve }, snapshot: mocks.snapshot }) }));
const owner = "00000000-0000-4000-8000-000000000001";
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); mocks.approve.mockReset(); sessionStorage.clear(); window.history.replaceState(null, "", "/pair?code=ABCD-EFGH"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
it("one comparison confirmation posts the exact cryptographic approval and proceeds to the dashboard", async () => {
  const candidate = await generateAccountBridgeCandidate("one"); const link = await createAccountEnrollment(candidate, "Computer", null, "one");
  window.history.replaceState(null, "", `/pair?code=ABCD-EFGH#account=${encodeAccountEnrollmentLink(link)}`);
  const bundle = { version: 1, requestId: link.request.requestId, ownerId: owner, envelope: {}, approver: {} };
  let finishApproval!: (value: typeof bundle) => void;
  mocks.approve.mockReturnValue(new Promise(resolve => { finishApproval = resolve; }));
  const fetcher = vi.fn(async (path: string, _init?: RequestInit) => new Response(JSON.stringify(path.endsWith("lookup")
    ? { bridgeId: "one", hostname: "Laptop", platform: "test", createdAt: new Date().toISOString(), enrollment: link.request } : { ok: true })));
  vi.stubGlobal("fetch", fetcher); const connected = vi.fn();
  render(<PairClient userEmail="owner@example.test" ownerId={owner} onConnected={connected} />);
  expect(window.location.hash).toBe("");
  const button = await screen.findByRole("button", { name: "Codes match — connect computer" });
  expect(screen.getByRole("link", { name: "Back to dashboard" }).getAttribute("href")).toBe("/dashboard");
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button);
  expect(screen.queryByRole("link", { name: "Back to dashboard" })).toBeNull();
  finishApproval(bundle);
  await waitFor(() => expect(connected).toHaveBeenCalledOnce());
  expect(mocks.approve).toHaveBeenCalledWith(link, true);
  const approved = fetcher.mock.calls.find(([path]) => path.endsWith("/approve")); expect(approved).toBeTruthy();
  expect(JSON.parse(String(approved![1]?.body))).toEqual({ userCode: "ABCD-EFGH", accountApproval: bundle });
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain(link.secret);
});
it("offers a safe dashboard link before and after a validation error without changing approval state", async () => {
  window.history.replaceState(null, "", "/pair");
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  render(<PairClient userEmail="owner@example.test" ownerId={owner} />);
  const back = screen.getByRole("link", { name: "Back to dashboard" });
  expect(back.getAttribute("href")).toBe("/dashboard");
  expect(back.className).toContain("min-h-11");
  back.addEventListener("click", event => event.preventDefault());
  fireEvent.click(back);
  expect(fetcher).not.toHaveBeenCalled();
  expect(mocks.approve).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Computer code"), { target: { value: "AB" } });
  fireEvent.click(screen.getByRole("button", { name: "Look up code" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Enter the full eight-character computer code.");
  expect(screen.getByRole("link", { name: "Back to dashboard" }).getAttribute("href")).toBe("/dashboard");
  expect(fetcher).not.toHaveBeenCalled();
  expect(mocks.approve).not.toHaveBeenCalled();
});
it("an old lookup without cryptographic enrollment cannot silently downgrade", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ bridgeId: "old", hostname: "Old", platform: "test", enrollment: null }))));
  render(<PairClient userEmail="owner@example.test" ownerId={owner} />);
  await screen.findByText(/Upgrade and restart/); expect(screen.queryByRole("button", { name: "Codes match — connect computer" })).toBeNull(); expect(mocks.approve).not.toHaveBeenCalled();
});
