// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountSecurityClient } from "@/lib/account-security-client";
import type { PendingApprovalClient, PendingSnapshot, PendingView } from "@/lib/pending-approval-client";
import { usePendingApprovals } from "@/hooks/usePendingApprovals";
import { PendingDeviceInbox, PendingDeviceWaiting } from "./PendingDeviceApprovals";
vi.mock("@/hooks/usePendingApprovals", () => ({ usePendingApprovals: vi.fn() }));
const view: PendingView = { status: "waiting", requestId: "request", label: "Phone", code: null, localConfirmed: false, peerConfirmed: false, error: null };
const account = {} as AccountSecurityClient;
function fixture() {
  const client = { confirmCandidate: vi.fn(async () => {}), ensureCandidate: vi.fn(async () => {}), cancelCandidate: vi.fn(async () => {}), restartCandidate: vi.fn(async () => {}), review: vi.fn(async () => {}), confirmReview: vi.fn(async () => {}), refreshInbox: vi.fn(async () => {}), reject: vi.fn(async () => {}), dismissReview: vi.fn() };
  const snapshot: PendingSnapshot = { candidate: { ...view }, inbox: [], review: null, inboxError: null };
  return { client: client as unknown as PendingApprovalClient, calls: client, snapshot };
}
beforeEach(() => { vi.mocked(usePendingApprovals).mockReset(); });
afterEach(() => cleanup());
it("an untrusted incoming visitor sees their own waiting request and no unauthorized approval action", () => {
  const f = fixture(); vi.mocked(usePendingApprovals).mockReturnValue({ client: f.client, snapshot: f.snapshot });
  render(<PendingDeviceWaiting account={account} email="owner@example.test" incoming onPrivateLink={() => {}} />);
  expect(screen.getByRole("heading", { name: "Waiting for device approval" })).toBeTruthy();
  expect(screen.getByText(/This browser is not approved and cannot approve another device/)).toBeTruthy();
  expect(screen.queryByLabelText("Verification code")).toBeNull(); expect(screen.queryByRole("button", { name: "Codes match — approve device" })).toBeNull();
  expect(f.calls.confirmCandidate).not.toHaveBeenCalled(); expect(f.calls.confirmReview).not.toHaveBeenCalled();
});
it("candidate confirmation is an explicit local click and is distinct from verified access", async () => {
  const f = fixture(); f.snapshot.candidate = { ...view, status: "comparing", code: "1234-5678-9ABC" };
  vi.mocked(usePendingApprovals).mockReturnValue({ client: f.client, snapshot: f.snapshot });
  const element = <PendingDeviceWaiting account={account} email="owner@example.test" onPrivateLink={() => {}} />;
  const page = render(element); expect(f.calls.confirmCandidate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Codes match on this device" }));
  await waitFor(() => expect(f.calls.confirmCandidate).toHaveBeenCalledTimes(1));
  expect(f.calls.confirmCandidate).toHaveBeenCalledWith(f.snapshot.candidate);
  f.snapshot.candidate = { ...f.snapshot.candidate, status: "confirming", localConfirmed: true }; page.rerender(<PendingDeviceWaiting account={account} email="owner@example.test" onPrivateLink={() => {}} />);
  expect(screen.getByText(/Confirmed here\. Waiting for approval/)).toBeTruthy();
  expect(screen.queryByText(/This device is approved\./)).toBeNull();
});
it("an approved selected review stays open for delivery renewal even with an empty pending list", () => {
  const f = fixture(); f.snapshot.review = { ...view, status: "approved", code: "1234-5678-9ABC", localConfirmed: true, peerConfirmed: true };
  render(<PendingDeviceInbox client={f.client} snapshot={f.snapshot} />);
  expect(screen.getByRole("region", { name: "Review device approval" })).toBeTruthy();
  expect(screen.getByText(/Keep this view open until it connects/)).toBeTruthy(); expect(screen.getByLabelText("Verification code")).toHaveProperty("textContent", "1234-5678-9ABC");
  expect(screen.getByRole("button", { name: "Close review" })).toBeTruthy(); expect(f.calls.dismissReview).not.toHaveBeenCalled();
});
it("offline review cannot enable local approval and raw server details never become UI text", () => {
  const f = fixture(); f.snapshot.review = { ...view, status: "comparing", code: "1234-5678-9ABC", error: "PRIVATE_RAW_CRYPTO_ERROR" };
  render(<PendingDeviceInbox client={f.client} snapshot={f.snapshot} offline />);
  expect((screen.getByRole("button", { name: "Codes match — approve device" }) as HTMLButtonElement).disabled).toBe(true);
  expect(document.body.textContent).not.toContain("PRIVATE_RAW_CRYPTO_ERROR"); expect(f.calls.confirmReview).not.toHaveBeenCalled();
});
it("a current authority error disables approval until a validated state replaces it", () => {
  const f = fixture(); f.snapshot.review = { ...view, status: "comparing", code: "1234-5678-9ABC", error: "account_approval_required" };
  const page = render(<PendingDeviceInbox client={f.client} snapshot={f.snapshot} />);
  expect((screen.getByRole("button", { name: "Codes match — approve device" }) as HTMLButtonElement).disabled).toBe(true);
  page.rerender(<PendingDeviceInbox client={f.client} snapshot={{ ...f.snapshot, review: { ...f.snapshot.review, error: null } }} />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByRole("button", { name: "Codes match — approve device" }) as HTMLButtonElement).disabled).toBe(false);
});

it("explains revocation when approval committed before cancellation, without showing cancelled", () => {
  const f = fixture(); f.snapshot.candidate = { ...view, status: "approved", cancellationLost: true };
  vi.mocked(usePendingApprovals).mockReturnValue({ client: f.client, snapshot: f.snapshot });
  render(<PendingDeviceWaiting account={account} email="owner@example.test" onPrivateLink={() => {}} />);
  expect(screen.getByText(/Approval already completed\. To remove access, revoke this device/)).toBeTruthy();
  expect(screen.queryByText(/This request was cancelled/)).toBeNull();
});
it("trusted confirmation receives the rendered transcript rather than rereading a newer snapshot", async () => {
  const f = fixture(); f.snapshot.review = { ...view, status: "comparing", code: "1234-5678-9ABC", offerHash: "displayed-offer" };
  render(<PendingDeviceInbox client={f.client} snapshot={f.snapshot} />);
  fireEvent.click(screen.getByRole("button", { name: "Codes match — approve device" }));
  await waitFor(() => expect(f.calls.confirmReview).toHaveBeenCalledWith(f.snapshot.review));
});

it("saved approval without fresh verification explains reconnect/revoke and offers no cancellation or new attempt", () => {
  const f = fixture(); f.snapshot.candidate = { ...view, status: "completed-unverified", cancellationLost: true, error: "account_storage_unavailable" };
  vi.mocked(usePendingApprovals).mockReturnValue({ client: f.client, snapshot: f.snapshot });
  render(<PendingDeviceWaiting account={account} email="owner@example.test" onPrivateLink={() => {}} />);
  expect(screen.getByRole("heading", { name: "Approval saved — reconnect to verify" })).toBeTruthy();
  expect(screen.getByText(/Approval was already saved\. Reconnect to verify current access/)).toBeTruthy();
  expect(screen.queryByText(/This request was cancelled/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel request" })).toBeNull(); expect(screen.queryByRole("button", { name: "Start a new request" })).toBeNull();
  expect(screen.queryByText(/This device is approved\./)).toBeNull(); expect(screen.queryByRole("button", { name: "Use a private approval link" })).toBeNull();
  expect(screen.getByRole("button", { name: "Check approval" })).toBeTruthy();
});
