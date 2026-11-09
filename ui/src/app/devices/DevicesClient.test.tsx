// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICES_ACCOUNT_NOTE, DevicesClient } from "./DevicesClient";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const reply = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as Response;

function mockDevices(devices: unknown[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/bridges/devices") return reply({ devices });
    return reply({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const base = { hostname: "laptop", lastSeen: null, revoked: false };

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DevicesClient account computers", () => {
  it("shows the account note and dashboard link, and no Revoke button, for an account member", async () => {
    mockDevices([{ ...base, bridgeId: "bridge-member", accountMember: true }]);
    render(<DevicesClient />);

    expect(await screen.findByText(DEVICES_ACCOUNT_NOTE)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open dashboard" });
    expect(link.getAttribute("href")).toBe("/dashboard");
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("shows Revoke for a row that is not an account member", async () => {
    mockDevices([{ ...base, bridgeId: "bridge-plain", accountMember: false }]);
    render(<DevicesClient />);

    expect(await screen.findByRole("button", { name: "Revoke" })).toBeTruthy();
    expect(screen.queryByText(DEVICES_ACCOUNT_NOTE)).toBeNull();
    expect(screen.queryByRole("link", { name: "Open dashboard" })).toBeNull();
  });

  it("shows Revoke for a row without the accountMember field", async () => {
    mockDevices([{ ...base, bridgeId: "bridge-legacy" }]);
    render(<DevicesClient />);

    expect(await screen.findByRole("button", { name: "Revoke" })).toBeTruthy();
    expect(screen.queryByText(DEVICES_ACCOUNT_NOTE)).toBeNull();
  });

  it("leaves an already-revoked account member row unchanged", async () => {
    mockDevices([{ ...base, bridgeId: "bridge-revoked", revoked: true, accountMember: true }]);
    render(<DevicesClient />);

    expect(await screen.findByText("Revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.queryByText(DEVICES_ACCOUNT_NOTE)).toBeNull();
    expect(screen.queryByRole("link", { name: "Open dashboard" })).toBeNull();
  });

  it("revokes a non-member row through the revoke route", async () => {
    const fetchMock = mockDevices([{ ...base, bridgeId: "bridge-plain", accountMember: false }]);
    render(<DevicesClient />);

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/bridges/devices/revoke",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ bridgeId: "bridge-plain" }) })
      )
    );
  });
});
