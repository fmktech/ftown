// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PAIR_FRAGMENT_PREFIX, encodePairLink, createBridgePairRequest } from "@security/ledger/pairing";
import { PairClient, PAIR_LINK_STORAGE_KEY } from "./PairClient";

const ledger = vi.hoisted(() => ({ approveBridge: vi.fn(), selectPasskey: vi.fn(), snapshot: {} as Record<string, unknown> }));
vi.mock("@/hooks/useLedger", () => ({ useLedger: () => ({ client: { approveBridge: ledger.approveBridge, selectPasskey: ledger.selectPasskey }, snapshot: ledger.snapshot }) }));

let keyA = "";
let keyB = "";
async function rawKey(algorithm: "ECDH" | "ECDSA"): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: algorithm, namedCurve: "P-256" }, true, algorithm === "ECDH" ? ["deriveBits"] : ["sign"]);
  return Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
}
beforeAll(async () => { keyA = await rawKey("ECDH"); keyB = await rawKey("ECDSA"); });
function makeFragment(): string {
  return PAIR_FRAGMENT_PREFIX + encodePairLink(createBridgePairRequest({ bridgeId: "bridge-1", endpointPublicKey: keyA, authPublicKey: keyB, label: "Studio Mac" }));
}
const replace = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); ledger.snapshot = {}; window.sessionStorage.clear();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, hash: "", pathname: "/pair", replace } });
});
afterEach(() => cleanup());

function open(fragment: string) { (window.location as { hash: string }).hash = fragment.startsWith("#") ? fragment : "#" + fragment; }

it("signed out: stores the fragment in sessionStorage and redirects without it in the URL", async () => {
  const fragment = makeFragment(); open(fragment);
  render(<PairClient signedIn={false} />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?returnTo=%2Fpair"));
  expect(window.sessionStorage.getItem(PAIR_LINK_STORAGE_KEY)).toBe(fragment);
  expect(replace.mock.calls[0][0]).not.toContain("req=");
});

it("signed in after login: reads the stored copy, shows the label, never a code", async () => {
  window.sessionStorage.setItem(PAIR_LINK_STORAGE_KEY, makeFragment());
  render(<PairClient signedIn />);
  expect(await screen.findByText("Studio Mac")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Approve with passkey" })).toBeTruthy();
});

it("approves with the typed code and shows success", async () => {
  const fragment = makeFragment(); open(fragment); ledger.approveBridge.mockResolvedValue(undefined);
  render(<PairClient signedIn />);
  fireEvent.change(await screen.findByLabelText("Code from your computer"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve with passkey" }));
  await screen.findByText("Computer added");
  expect(ledger.approveBridge).toHaveBeenCalledWith(fragment, "123456");
  expect(window.sessionStorage.getItem(PAIR_LINK_STORAGE_KEY)).toBeNull();
});

it("discards the link after 5 wrong codes", async () => {
  open(makeFragment()); ledger.approveBridge.mockRejectedValue(new Error("pair_code_mismatch"));
  render(<PairClient signedIn />);
  const input = await screen.findByLabelText("Code from your computer");
  for (let i = 0; i < 5; i++) {
    fireEvent.change(input, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve with passkey" }));
    await waitFor(() => expect(ledger.approveBridge).toHaveBeenCalledTimes(i + 1));
    if (i < 4) await screen.findByText(/does not match/);
  }
  await screen.findByText(/discarded/);
  expect(window.sessionStorage.getItem(PAIR_LINK_STORAGE_KEY)).toBeNull();
  expect(screen.queryByLabelText("Code from your computer")).toBeNull();
});

it("rejects a malformed link", async () => {
  open("req=garbage");
  render(<PairClient signedIn />);
  await screen.findByText(/invalid or expired/);
  expect(window.sessionStorage.getItem(PAIR_LINK_STORAGE_KEY)).toBeNull();
});

it("with 2+ authorities and unknown signer: Choose passkey comes first and gates Approve", async () => {
  open(makeFragment()); ledger.selectPasskey.mockResolvedValue(undefined);
  ledger.snapshot = { checkpoint: { authorities: [{}, {}] }, signer: null };
  render(<PairClient signedIn />);
  fireEvent.change(await screen.findByLabelText("Code from your computer"), { target: { value: "123456" } });
  expect((screen.getByRole("button", { name: "Approve with passkey" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Choose passkey" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Approve with passkey" }) as HTMLButtonElement).disabled).toBe(false));
  expect(ledger.selectPasskey).toHaveBeenCalledOnce();
});

it("single authority or known signer: no Choose passkey step", async () => {
  open(makeFragment());
  ledger.snapshot = { checkpoint: { authorities: [{}] }, signer: null };
  const first = render(<PairClient signedIn />);
  await screen.findByLabelText("Code from your computer");
  expect(screen.queryByRole("button", { name: "Choose passkey" })).toBeNull();
  first.unmount();
  ledger.snapshot = { checkpoint: { authorities: [{}, {}] }, signer: "cred" };
  render(<PairClient signedIn />);
  await screen.findByLabelText("Code from your computer");
  expect(screen.queryByRole("button", { name: "Choose passkey" })).toBeNull();
});

it("shows expiry before the code is typed, including while the page is open", async () => {
  open(makeFragment());
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    render(<PairClient signedIn />);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByLabelText("Code from your computer")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect(screen.getByText(/This pairing link has expired/)).toBeTruthy();
    expect(screen.queryByLabelText("Code from your computer")).toBeNull();
  } finally { vi.useRealTimers(); }
});

it("already expired on open", async () => {
  const fragment = makeFragment(); open(fragment);
  const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 1000);
  render(<PairClient signedIn />);
  await screen.findByText(/This pairing link has expired/);
  spy.mockRestore();
});

it("blocked storage does not crash; signed-out asks to sign in first and does not redirect", async () => {
  open(makeFragment());
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  render(<PairClient signedIn={false} />);
  await screen.findByText(/Sign in first, then open the link again/);
  expect(replace).not.toHaveBeenCalled();
  spy.mockRestore(); get.mockRestore();
});

it("a second link opened in the same tab (hashchange) replaces the first and resets state", async () => {
  open(makeFragment());
  render(<PairClient signedIn />);
  await screen.findByText("Studio Mac");
  const second = PAIR_FRAGMENT_PREFIX + encodePairLink(createBridgePairRequest({ bridgeId: "bridge-2", endpointPublicKey: keyA, authPublicKey: keyB, label: "Office Linux" }));
  fireEvent.change(screen.getByLabelText("Code from your computer"), { target: { value: "111111" } });
  open(second);
  window.dispatchEvent(new Event("hashchange"));
  await screen.findByText("Office Linux");
  expect((screen.getByLabelText("Code from your computer") as HTMLInputElement).value).toBe("");
  ledger.approveBridge.mockResolvedValue(undefined);
  fireEvent.change(screen.getByLabelText("Code from your computer"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve with passkey" }));
  await screen.findByText("Computer added");
  expect(ledger.approveBridge).toHaveBeenCalledWith(second, "123456");
});
