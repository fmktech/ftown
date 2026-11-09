import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

const TEST_SECRET = "test-secret-at-least-32-characters-long-xxxxx"; // gitleaks:allow (fake test fixture, not a real secret)
const OWNER = "349f8d2e-38e4-4d59-888d-687dcfa19e39";

vi.mock("@/lib/secrets", () => ({ getRequiredSecret: vi.fn(() => TEST_SECRET) }));
vi.mock("@/lib/bridge-refresh", () => ({
  rotateBridgeRefreshJti: vi.fn(),
  getBridgeRefreshJti: vi.fn(),
  getOwnerIdForSub: vi.fn(async () => "349f8d2e-38e4-4d59-888d-687dcfa19e39"),
}));
vi.mock("@/lib/bridge-revocation", () => ({ bridgeRevocationForOwner: vi.fn() }));

import { POST } from "./route";
import { rotateBridgeRefreshJti, getBridgeRefreshJti, getOwnerIdForSub } from "@/lib/bridge-refresh";
import { bridgeRevocationForOwner } from "@/lib/bridge-revocation";

function refreshToken(bridgeId = "bridge-1", claims: Record<string, unknown> = {}, expiresIn: string | number = "1h"): string {
  return jwt.sign(
    { sub: "user@example.com", bridgeId, type: "bridge_refresh", jti: "jti-1", ...claims },
    TEST_SECRET,
    { audience: "ftown:bridge-refresh", expiresIn } as jwt.SignOptions,
  );
}

function call(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/auth/bridge/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const good = () => ({ refreshToken: refreshToken(), bridgeId: "bridge-1", hostname: "host-1" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(rotateBridgeRefreshJti).mockResolvedValue(true);
  vi.mocked(getBridgeRefreshJti).mockResolvedValue("jti-1");
  vi.mocked(getOwnerIdForSub).mockResolvedValue(OWNER);
  vi.mocked(bridgeRevocationForOwner).mockResolvedValue({ revoked: false });
});

describe("POST /api/auth/bridge/refresh revocation", () => {
  it("refuses a tombstoned (current_jti=revoked) bridge with signed evidence and does not rotate", async () => {
    const evidence = { genesis: { g: 1 }, transitions: [{ t: 1 }] } as never;
    vi.mocked(getBridgeRefreshJti).mockResolvedValue("revoked");
    vi.mocked(bridgeRevocationForOwner).mockResolvedValue({ revoked: true, evidence });
    const res = await call(good());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "bridge_revoked", history: evidence });
    expect(bridgeRevocationForOwner).toHaveBeenCalledWith(OWNER, "bridge-1");
    expect(rotateBridgeRefreshJti).not.toHaveBeenCalled();
  });

  it("rotates and issues tokens when not revoked", async () => {
    const res = await call(good());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token).toBeTruthy();
    expect(json.refreshToken).toBeTruthy();
    expect(rotateBridgeRefreshJti).toHaveBeenCalledTimes(1);
    expect(getBridgeRefreshJti).toHaveBeenCalledWith("bridge-1", "user@example.com");
    expect(rotateBridgeRefreshJti).toHaveBeenCalledWith("bridge-1", "user@example.com", "jti-1", expect.any(String));
    const order = (f: unknown) => vi.mocked(f as () => void).mock.invocationCallOrder[0];
    expect(order(getBridgeRefreshJti)).toBeLessThan(order(bridgeRevocationForOwner));
    expect(order(bridgeRevocationForOwner)).toBeLessThan(order(rotateBridgeRefreshJti));
  });

  it("returns the existing 401 for a stale jti without the expensive check", async () => {
    vi.mocked(getBridgeRefreshJti).mockResolvedValue("jti-newer");
    const res = await call(good());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Refresh token has been rotated or revoked" });
    expect(bridgeRevocationForOwner).not.toHaveBeenCalled();
    expect(rotateBridgeRefreshJti).not.toHaveBeenCalled();
  });

  it("returns 503 when the jti read throws", async () => {
    vi.mocked(getBridgeRefreshJti).mockRejectedValue(new Error("db down"));
    const res = await call(good());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "account_unavailable" });
    expect(bridgeRevocationForOwner).not.toHaveBeenCalled();
    expect(rotateBridgeRefreshJti).not.toHaveBeenCalled();
  });

  it("returns the existing 401 when the owner lookup fails", async () => {
    vi.mocked(getOwnerIdForSub).mockRejectedValue(new Error("no user"));
    const res = await call(good());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Bridge account is unavailable" });
    expect(bridgeRevocationForOwner).not.toHaveBeenCalled();
  });

  it("keeps the wrong-type 401", async () => {
    const res = await call({ ...good(), refreshToken: refreshToken("bridge-1", { type: "other" }) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid token type" });
  });

  it("keeps the missing-jti 401", async () => {
    const res = await call({ ...good(), refreshToken: refreshToken("bridge-1", { jti: undefined }) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Refresh token missing jti" });
  });

  it("keeps the expired-token 401", async () => {
    const res = await call({ ...good(), refreshToken: refreshToken("bridge-1", {}, -10) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired refresh token" });
  });

  it("returns 503 and does not rotate when the revocation check throws", async () => {
    vi.mocked(bridgeRevocationForOwner).mockRejectedValue(new Error("db down"));
    const res = await call(good());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "account_unavailable" });
    expect(console.error).toHaveBeenCalled();
    expect(rotateBridgeRefreshJti).not.toHaveBeenCalled();
  });

  it("keeps the invalid-token 401 and skips the check", async () => {
    const res = await call({ ...good(), refreshToken: "garbage" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired refresh token" });
    expect(bridgeRevocationForOwner).not.toHaveBeenCalled();
  });

  it("keeps the bridgeId mismatch 401 and skips the check", async () => {
    const res = await call({ ...good(), refreshToken: refreshToken("other-bridge") });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "bridgeId mismatch" });
    expect(bridgeRevocationForOwner).not.toHaveBeenCalled();
  });
});
