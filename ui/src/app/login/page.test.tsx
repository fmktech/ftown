// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LoginPage from "./page";

const m = vi.hoisted(() => ({
  push: vi.fn(),
  configured: true,
  snapshot: { status: "signed_out", checkpoint: null, discarded: [], pending: "none" } as { status: string; checkpoint: null; discarded: never[]; pending: string },
  client: {
    signInKnownDevice: vi.fn(),
    identifyAccount: vi.fn(),
    enrollThisDevice: vi.fn(),
    createAccountStart: vi.fn(),
    createAccountFinish: vi.fn(),
    rotateDeviceIdentity: vi.fn(),
    forget: vi.fn(),
    retryCreateAccount: vi.fn(),
  },
}));
vi.mock("@/lib/ledger-runtime", () => ({ ledgerRuntimeConfig: () => ({ configured: m.configured }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("@/hooks/useLedger", () => ({ useLedger: () => ({ client: m.client, snapshot: m.snapshot }) }));

beforeEach(() => {
  vi.clearAllMocks();
  m.snapshot = { status: "signed_out", checkpoint: null, discarded: [], pending: "none" };
  m.configured = true;
  window.sessionStorage.clear(); window.localStorage.clear();
  m.client.signInKnownDevice.mockResolvedValue(false);
});
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

it("signs in a known device automatically and goes to the dashboard", async () => {
  m.client.signInKnownDevice.mockResolvedValue(true);
  render(<LoginPage />);
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/dashboard"));
});

it("honors a safe returnTo and rejects hostile ones and drops fragments", async () => {
  m.client.signInKnownDevice.mockResolvedValue(true);
  window.history.replaceState(null, "", `/login?returnTo=${encodeURIComponent("/pair")}`);
  render(<LoginPage />);
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/pair"));
  cleanup(); m.push.mockClear();
  window.history.replaceState(null, "", `/login?returnTo=${encodeURIComponent("//evil.test/x")}`);
  render(<LoginPage />);
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/dashboard"));
  cleanup(); m.push.mockClear();
  window.history.replaceState(null, "", `/login?returnTo=${encodeURIComponent("/pair#secret")}`);
  render(<LoginPage />);
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/pair"));
});

it("keeps sessionStorage (pair link) intact across login", async () => {
  window.sessionStorage.setItem("ftown-pair-link", "x");
  m.client.signInKnownDevice.mockResolvedValue(true);
  window.history.replaceState(null, "", "/login?returnTo=%2Fpair");
  render(<LoginPage />);
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/pair"));
  expect(window.sessionStorage.getItem("ftown-pair-link")).toBe("x");
});

it("runs one ceremony per click: identify, then add this browser", async () => {
  m.client.identifyAccount.mockResolvedValue({ enrolled: false });
  const view = render(<LoginPage />);
  await waitFor(() => expect(m.client.signInKnownDevice).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Sign in with passkey" }));
  await waitFor(() => expect(m.client.identifyAccount).toHaveBeenCalledOnce());
  expect(m.client.enrollThisDevice).not.toHaveBeenCalled();
  expect(m.push).not.toHaveBeenCalled();
  m.snapshot = { ...m.snapshot, pending: "enrollment_ready" };
  view.rerender(<LoginPage />);
  fireEvent.change(screen.getByLabelText("Name this browser"), { target: { value: "Laptop" } });
  m.client.enrollThisDevice.mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("button", { name: "Add this browser" }));
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/dashboard"));
  expect(m.client.enrollThisDevice).toHaveBeenCalledWith({ deviceLabel: "Laptop" });
});

it("shows plain messages for known errors", async () => {
  for (const [code, text] of [
    ["passkey_cancelled", /cancelled/], ["secure_context_required", /secure connection/],
    ["passkey_already_registered", /already registered/], ["registration_closed", /closed/],
  ] as const) {
    m.client.identifyAccount.mockRejectedValue(new Error(code));
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with passkey" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(text);
    cleanup();
  }
});

it("offers to reset a revoked browser", async () => {
  m.snapshot = { ...m.snapshot, status: "device_revoked" };
  m.client.rotateDeviceIdentity.mockResolvedValue(undefined);
  render(<LoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "Reset this browser" }));
  await waitFor(() => expect(m.client.rotateDeviceIdentity).toHaveBeenCalledOnce());
});

it("creates an account in three separate clicks with a password-type bootstrap field", async () => {
  m.client.createAccountStart.mockResolvedValue(undefined);
  m.client.createAccountFinish.mockResolvedValue(undefined);
  m.client.enrollThisDevice.mockResolvedValue(undefined);
  const view = render(<LoginPage />);
  const secret = screen.getByLabelText("Setup secret") as HTMLInputElement;
  expect(secret.type).toBe("password");
  fireEvent.change(secret, { target: { value: "s3cret" } });
  fireEvent.click(screen.getByRole("button", { name: "1. Create passkey" }));
  await waitFor(() => expect(m.client.createAccountStart).toHaveBeenCalledWith({ passkeyLabel: "My passkey", userName: "My passkey" }));
  expect((screen.getByRole("button", { name: "2. Sign the account" }) as HTMLButtonElement).disabled).toBe(true);
  m.snapshot = { ...m.snapshot, pending: "passkey_created" };
  view.rerender(<LoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "2. Sign the account" }));
  await waitFor(() => expect(m.client.createAccountFinish).toHaveBeenCalledWith({ bootstrap: "s3cret" }));
  expect((screen.getByLabelText("Setup secret") as HTMLInputElement).value).toBe("");
  m.snapshot = { ...m.snapshot, pending: "enrollment_ready" };
  view.rerender(<LoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "3. Add this browser" }));
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/dashboard"));
});

it("rejects bypass returnTo values and navigates only to the resolved path", async () => {
  for (const bad of ["/.//evil.com", "/%2e%2e//x", "/\\evil.com", "https://evil.com/x", "//evil.com"]) {
    m.client.signInKnownDevice.mockResolvedValue(true);
    window.history.replaceState(null, "", `/login?returnTo=${encodeURIComponent(bad)}`);
    render(<LoginPage />);
    await waitFor(() => expect(m.push).toHaveBeenCalled());
    expect(m.push).toHaveBeenLastCalledWith("/dashboard");
    cleanup(); m.push.mockClear();
  }
});

it("skips automatic sign-in while signed out, and an explicit click clears the flag", async () => {
  window.localStorage.setItem("ftown-signed-out", "1");
  m.client.identifyAccount.mockResolvedValue({ enrolled: true });
  render(<LoginPage />);
  await new Promise(r => setTimeout(r, 20));
  expect(m.client.signInKnownDevice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Sign in with passkey" }));
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/dashboard"));
  expect(window.localStorage.getItem("ftown-signed-out")).toBeNull();
});

it("refuses account creation when the public URL is not configured", () => {
  m.configured = false;
  render(<LoginPage />);
  expect(screen.getByRole("alert").textContent).toMatch(/not configured for account creation/);
  expect(screen.queryByRole("button", { name: "1. Create passkey" })).toBeNull();
});

it("retries a rejected setup secret without creating a second passkey", async () => {
  m.client.createAccountStart.mockResolvedValue(undefined);
  m.client.enrollThisDevice.mockRejectedValue(new Error("invalid_bootstrap"));
  m.client.retryCreateAccount.mockResolvedValue(undefined);
  const view = render(<LoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "1. Create passkey" }));
  await waitFor(() => expect(m.client.createAccountStart).toHaveBeenCalledOnce());
  m.snapshot = { ...m.snapshot, pending: "enrollment_ready" };
  view.rerender(<LoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "3. Add this browser" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/setup secret is wrong/);
  fireEvent.change(screen.getByLabelText("Setup secret"), { target: { value: "right" } });
  fireEvent.click(await screen.findByRole("button", { name: "3. Retry with this secret" }));
  await waitFor(() => expect(m.client.retryCreateAccount).toHaveBeenCalledWith({ bootstrap: "right" }));
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/dashboard"));
  expect(m.client.createAccountStart).toHaveBeenCalledOnce();
});

it("offers an explicit discard that forgets the half-made setup", async () => {
  m.client.createAccountStart.mockResolvedValue(undefined);
  m.client.forget.mockResolvedValue(undefined);
  const view = render(<LoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "1. Create passkey" }));
  await waitFor(() => expect(m.client.createAccountStart).toHaveBeenCalled());
  m.snapshot = { ...m.snapshot, pending: "passkey_created" };
  view.rerender(<LoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "Discard this setup and create a new passkey" }));
  await waitFor(() => expect(m.client.forget).toHaveBeenCalled());
});

it("keeps an encoded backslash as a same-origin path", async () => {
  m.client.signInKnownDevice.mockResolvedValue(true);
  window.history.replaceState(null, "", `/login?returnTo=${encodeURIComponent("/%5Cevil.com")}`);
  render(<LoginPage />);
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/%5Cevil.com"));
});
