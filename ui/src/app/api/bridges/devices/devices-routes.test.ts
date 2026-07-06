import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import type { BridgeDevice } from "@/lib/bridge-refresh";

vi.mock("@/lib/bridge-refresh", () => ({
  upsertBridgeRefresh: vi.fn(),
  getDevicesForSub: vi.fn(),
  revokeDevice: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

import { getDevicesForSub, revokeDevice } from "@/lib/bridge-refresh";
import { auth } from "@/lib/auth";

const mockGetDevicesForSub = vi.mocked(getDevicesForSub);
const mockRevokeDevice = vi.mocked(revokeDevice);
const mockAuth = vi.mocked(auth);

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/bridges/devices", () => {
  it("no session -> 401", async () => {
    mockAuth.mockResolvedValueOnce(null as never);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockGetDevicesForSub).not.toHaveBeenCalled();
  });

  it("with session -> {devices:[...]} from getDevicesForSub(email)", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    const devices: BridgeDevice[] = [
      { bridgeId: "bridge-1", hostname: "host-1", lastSeen: "2026-01-01T00:00:00.000Z", revoked: false },
      { bridgeId: "bridge-2", hostname: "host-2", lastSeen: null, revoked: true },
    ];
    mockGetDevicesForSub.mockResolvedValueOnce(devices);

    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ devices });
    expect(mockGetDevicesForSub).toHaveBeenCalledWith("user@example.com");
  });
});

describe("POST /api/bridges/devices/revoke", () => {
  const revokeUrl = "http://localhost/api/bridges/devices/revoke";

  it("no session -> 401", async () => {
    mockAuth.mockResolvedValueOnce(null as never);
    const { POST } = await import("./revoke/route");
    const res = await POST(jsonRequest(revokeUrl, { bridgeId: "bridge-1" }));
    expect(res.status).toBe(401);
    expect(mockRevokeDevice).not.toHaveBeenCalled();
  });

  it("missing bridgeId -> 400", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    const { POST } = await import("./revoke/route");
    const res = await POST(jsonRequest(revokeUrl, {}));
    expect(res.status).toBe(400);
    expect(mockRevokeDevice).not.toHaveBeenCalled();
  });

  it("revokeDevice true -> {ok:true}, owner-scoped call", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockRevokeDevice.mockResolvedValueOnce(true);
    const { POST } = await import("./revoke/route");
    const res = await POST(jsonRequest(revokeUrl, { bridgeId: "bridge-1" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(mockRevokeDevice).toHaveBeenCalledWith("user@example.com", "bridge-1");
  });

  it("revokeDevice false -> 404", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockRevokeDevice.mockResolvedValueOnce(false);
    const { POST } = await import("./revoke/route");
    const res = await POST(jsonRequest(revokeUrl, { bridgeId: "bridge-unknown" }));
    expect(res.status).toBe(404);
  });
});
