import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

const TEST_SECRET = "test-secret-at-least-32-characters-long-xxxxx"; // gitleaks:allow (fake test fixture, not a real secret)

vi.mock("@/lib/bridge-refresh", () => ({
  setBridgeRefreshJti: vi.fn(async () => {}),
  getOwnerIdForSub: vi.fn(async () => "349f8d2e-38e4-4d59-888d-687dcfa19e39"),
}));

vi.mock("@/lib/bridge-revocation", () => ({
  bridgeRevocationForOwner: vi.fn(async () => ({ revoked: false })),
}));

vi.mock("@/lib/secrets", () => ({
  getRequiredSecret: vi.fn(() => TEST_SECRET),
}));

import { POST } from "./route";
import { setBridgeRefreshJti, getOwnerIdForSub } from "@/lib/bridge-refresh";
import { bridgeRevocationForOwner } from "@/lib/bridge-revocation";

const mockSetJti = vi.mocked(setBridgeRefreshJti);
const mockOwnerId = vi.mocked(getOwnerIdForSub);
const mockRevocation = vi.mocked(bridgeRevocationForOwner);

const OWNER_ID = "349f8d2e-38e4-4d59-888d-687dcfa19e39";

function bootstrapToken(): string {
  return jwt.sign({ sub: "user-sub-1" }, TEST_SECRET, {
    audience: "ftown:bridge-bootstrap",
    expiresIn: "5m",
  });
}

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("https://app.test.example/api/auth/bridge", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test.example" },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: bootstrapToken(),
    bridgeId: "bridge-1",
    hostname: "host-1",
    ...overrides,
  };
}

describe("POST /api/auth/bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOwnerId.mockResolvedValue(OWNER_ID);
    mockRevocation.mockResolvedValue({ revoked: false });
  });

  it("revoked bridgeId -> 403 bridge_revoked, no issuance", async () => {
    mockRevocation.mockResolvedValue({
      revoked: true,
      evidence: { genesis: {} as never, transitions: [] },
    });

    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "bridge_revoked" });
    expect(mockRevocation).toHaveBeenCalledWith(OWNER_ID, "bridge-1");
    expect(mockSetJti).not.toHaveBeenCalled();
  });

  it("not revoked -> 200 with tokens and issuance", async () => {
    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.token).toBe("string");
    expect(typeof json.refreshToken).toBe("string");
    expect(json.ownerId).toBe(OWNER_ID);
    expect(json.userId).toBe("user-sub-1");
    expect(mockRevocation).toHaveBeenCalledWith(OWNER_ID, "bridge-1");
    expect(mockSetJti).toHaveBeenCalledTimes(1);
    expect(mockSetJti).toHaveBeenCalledWith("bridge-1", "user-sub-1", expect.any(String));
  });

  it("revocation helper throws -> 503 account_unavailable, no issuance", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRevocation.mockRejectedValue(new Error("db down"));

    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "account_unavailable" });
    expect(errorSpy).toHaveBeenCalled();
    expect(mockSetJti).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("invalid bootstrap token -> 401, revocation helper not called", async () => {
    const res = await POST(jsonRequest(validBody({ token: "not-a-jwt" })));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired token" });
    expect(mockRevocation).not.toHaveBeenCalled();
    expect(mockSetJti).not.toHaveBeenCalled();
  });
});
