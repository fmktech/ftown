// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateEndpoint } from "@security/crypto";
import { BrowserInvitation } from "./BrowserInvitation";

const mocks = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: mocks.signIn }));
const ownerId = "00000000-0000-4000-8000-000000000001";
const email = "owner@example.test";
const json = (value: unknown) => new Response(JSON.stringify(value));

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto); mocks.signIn.mockReset();
  const bridge = await generateEndpoint(ownerId, "bridge");
  const invitation = { version: 1, invitationId: crypto.randomUUID(), ownerId, bridgeId: "bridge-one", bridge: bridge.endpoint,
    secret: "A".repeat(43), expiresAt: new Date(Date.now() + 300000).toISOString(), relayUrl: "wss://relay.example.test/connection/websocket", localOrigin: null };
  window.history.replaceState(null, "", `/connect#invite=${encodeURIComponent(JSON.stringify(invitation))}`);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("browser invitation session lookup", () => {
  it.each([null, {}, [], { user: null }, { user: { id: 123, email } }, { user: { id: ownerId, email: false } }, { user: { id: "", email } }])(
    "offers inline sign-in for a valid invitation with anonymous or malformed session %j", async value => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(value)));
      render(<BrowserInvitation />);
      expect(await screen.findByRole("button", { name: "Sign in to approve" })).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull(); expect(screen.getByText(ownerId)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Approve browser and connect" })).toBeNull();
      expect(window.location.hash).toBe("");
    },
  );

  it("treats a non-JSON session response as unauthenticated without rejecting the valid invitation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json")));
    render(<BrowserInvitation />);
    await screen.findByRole("button", { name: "Sign in to approve" }); expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the scrubbed invitation in memory through successful inline sign-in to the matching account", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(null)).mockResolvedValueOnce(json({ user: { id: ownerId, email } }));
    vi.stubGlobal("fetch", fetcher); mocks.signIn.mockResolvedValue({ error: undefined });
    render(<BrowserInvitation />);
    await screen.findByRole("button", { name: "Sign in to approve" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in to approve" }));
    await screen.findByRole("button", { name: "Approve browser and connect" });
    expect(mocks.signIn).toHaveBeenCalledWith("credentials", { email, password: "test-password", redirect: false });
    expect(screen.queryByRole("alert")).toBeNull(); expect(window.location.hash).toBe("");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/auth/session", "/api/auth/session"]);
  });

  it("blocks approval after inline login returns a different immutable account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(null)).mockResolvedValueOnce(json({ user: { id: "00000000-0000-4000-8000-000000000002", email: "other@example.test" } })));
    mocks.signIn.mockResolvedValue({ error: undefined }); render(<BrowserInvitation />);
    await screen.findByRole("button", { name: "Sign in to approve" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in to approve" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("different account"));
    expect(screen.queryByRole("button", { name: "Approve browser and connect" })).toBeNull();
  });
});
