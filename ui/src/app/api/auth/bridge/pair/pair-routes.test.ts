import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

import type { PairingRequestRow } from "@/lib/pairing-store";

const TEST_SECRET = "test-secret-at-least-32-characters-long-xxxxx"; // gitleaks:allow (fake test fixture, not a real secret)
process.env.NEXT_PUBLIC_CENTRIFUGO_URL = "wss://centrifugo.test.example";

vi.mock("@/lib/pairing-store", () => ({
  createPairingRequest: vi.fn(),
  deleteExpiredRequests: vi.fn(),
  getByDeviceCode: vi.fn(),
  getByUserCode: vi.fn(),
  approvePairingRequest: vi.fn(),
  denyPairingRequest: vi.fn(),
  consumePairingRequest: vi.fn(),
}));

vi.mock("@/lib/pairing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pairing")>();
  return {
    ...actual,
    genDeviceCode: vi.fn(() => "fixed-device-code"),
    genUserCode: vi.fn(() => "ABCD-1234"),
  };
});

vi.mock("@/lib/bridge-refresh", () => ({
  upsertBridgeRefresh: vi.fn(),
  getBridgeRefreshOwner: vi.fn(),
  getDevicesForSub: vi.fn(),
  revokeDevice: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/secrets", () => ({
  getRequiredSecret: vi.fn(() => TEST_SECRET),
}));

vi.mock("@/lib/login-rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  recordAttempt: vi.fn(async () => {}),
  resetAttempts: vi.fn(async () => {}),
}));

import {
  createPairingRequest,
  getByDeviceCode,
  getByUserCode,
  approvePairingRequest,
  denyPairingRequest,
  consumePairingRequest,
} from "@/lib/pairing-store";
import { upsertBridgeRefresh, getBridgeRefreshOwner } from "@/lib/bridge-refresh";
import { auth } from "@/lib/auth";
import { checkRateLimit } from "@/lib/login-rate-limit";

const mockCreate = vi.mocked(createPairingRequest);
const mockGetByDeviceCode = vi.mocked(getByDeviceCode);
const mockGetByUserCode = vi.mocked(getByUserCode);
const mockApprove = vi.mocked(approvePairingRequest);
const mockDeny = vi.mocked(denyPairingRequest);
const mockConsume = vi.mocked(consumePairingRequest);
const mockUpsertBridgeRefresh = vi.mocked(upsertBridgeRefresh);
const mockGetBridgeRefreshOwner = vi.mocked(getBridgeRefreshOwner);
const mockAuth = vi.mocked(auth);
const mockCheckRateLimit = vi.mocked(checkRateLimit);

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function row(overrides: Partial<PairingRequestRow>): PairingRequestRow {
  return {
    deviceCode: "fixed-device-code",
    userCode: "ABCD-1234",
    bridgeId: "bridge-1",
    hostname: "host-1",
    platform: "darwin",
    status: "pending",
    sub: null,
    refreshJti: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    approvedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue({ allowed: true });
  // Default: bridge is unclaimed and the owner-scoped upsert succeeds.
  mockGetBridgeRefreshOwner.mockResolvedValue(null);
  mockUpsertBridgeRefresh.mockResolvedValue(true);
});

describe("POST /api/auth/bridge/pair/start", () => {
  it("valid body -> 200 with deviceCode/userCode/verificationUri/intervalMs/expiresInMs", async () => {
    const { POST } = await import("./start/route");
    const res = await POST(
      jsonRequest("http://localhost/api/auth/bridge/pair/start", {
        bridgeId: "bridge-1",
        hostname: "host-1",
        platform: "darwin",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deviceCode).toBeTruthy();
    expect(body.userCode).toBeTruthy();
    expect(body.verificationUri).toContain("/pair?code=");
    expect(typeof body.intervalMs).toBe("number");
    expect(typeof body.expiresInMs).toBe("number");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("missing bridgeId -> 400", async () => {
    const { POST } = await import("./start/route");
    const res = await POST(
      jsonRequest("http://localhost/api/auth/bridge/pair/start", {
        hostname: "host-1",
        platform: "darwin",
      }),
    );
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rate-limited -> 429", async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterMs: 5000 });
    const { POST } = await import("./start/route");
    const res = await POST(
      jsonRequest("http://localhost/api/auth/bridge/pair/start", {
        bridgeId: "bridge-1",
        hostname: "host-1",
        platform: "darwin",
      }),
    );
    expect(res.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith("pair-start", expect.any(String));
  });
});

describe("POST /api/auth/bridge/pair/poll", () => {
  const pollUrl = "http://localhost/api/auth/bridge/pair/poll";

  it("unknown deviceCode -> {status:'unknown'}", async () => {
    mockGetByDeviceCode.mockResolvedValueOnce(null);
    const { POST } = await import("./poll/route");
    const res = await POST(jsonRequest(pollUrl, { deviceCode: "nope" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "unknown" });
  });

  it("pending -> {status:'pending'}", async () => {
    mockGetByDeviceCode.mockResolvedValueOnce(row({ status: "pending" }));
    const { POST } = await import("./poll/route");
    const res = await POST(jsonRequest(pollUrl, { deviceCode: "fixed-device-code" }));
    await expect(res.json()).resolves.toEqual({ status: "pending" });
  });

  it("expired pending -> {status:'expired'}", async () => {
    mockGetByDeviceCode.mockResolvedValueOnce(
      row({ status: "pending", expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    const { POST } = await import("./poll/route");
    const res = await POST(jsonRequest(pollUrl, { deviceCode: "fixed-device-code" }));
    await expect(res.json()).resolves.toEqual({ status: "expired" });
  });

  it("denied -> {status:'denied'}", async () => {
    mockGetByDeviceCode.mockResolvedValueOnce(row({ status: "denied" }));
    const { POST } = await import("./poll/route");
    const res = await POST(jsonRequest(pollUrl, { deviceCode: "fixed-device-code" }));
    await expect(res.json()).resolves.toEqual({ status: "denied" });
  });

  it("consumed row -> {status:'consumed'}", async () => {
    mockGetByDeviceCode.mockResolvedValueOnce(row({ status: "consumed" }));
    const { POST } = await import("./poll/route");
    const res = await POST(jsonRequest(pollUrl, { deviceCode: "fixed-device-code" }));
    await expect(res.json()).resolves.toEqual({ status: "consumed" });
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it("approved -> mints tokens, upserts bridge_refresh, marks consumed", async () => {
    const approvedRow = row({
      status: "approved",
      sub: "user@example.com",
      refreshJti: "jti-123",
      bridgeId: "bridge-1",
      hostname: "host-1",
    });
    mockGetByDeviceCode.mockResolvedValueOnce(approvedRow);
    mockConsume.mockResolvedValueOnce(approvedRow);

    const { POST } = await import("./poll/route");
    const res = await POST(jsonRequest(pollUrl, { deviceCode: "fixed-device-code" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");
    expect(body.userId).toBe("user@example.com");
    expect(body.centrifugoUrl).toBe("wss://centrifugo.test.example");
    expect(typeof body.token).toBe("string");
    expect(typeof body.refreshToken).toBe("string");

    const connectDecoded = jwt.verify(body.token, TEST_SECRET, {
      audience: "ftown:centrifugo",
    }) as { sub: string };
    expect(connectDecoded.sub).toBe("user@example.com");

    const refreshDecoded = jwt.verify(body.refreshToken, TEST_SECRET, {
      audience: "ftown:bridge-refresh",
    }) as { sub: string; jti: string; type: string; bridgeId: string };
    expect(refreshDecoded.sub).toBe("user@example.com");
    expect(refreshDecoded.jti).toBeTruthy();
    // HIGH-2: refresh claim set must match /api/auth/bridge exactly.
    expect(refreshDecoded.type).toBe("bridge_refresh");
    expect(refreshDecoded.bridgeId).toBe("bridge-1");

    expect(mockConsume).toHaveBeenCalledWith("fixed-device-code");
    expect(mockUpsertBridgeRefresh).toHaveBeenCalledWith({
      bridgeId: "bridge-1",
      sub: "user@example.com",
      jti: expect.any(String),
      hostname: "host-1",
    });
  });

  it("approved but owner-scoped upsert is blocked (different owner) -> {status:'denied'}, no tokens", async () => {
    const approvedRow = row({
      status: "approved",
      sub: "user@example.com",
      refreshJti: "jti-123",
      bridgeId: "bridge-1",
      hostname: "host-1",
    });
    mockGetByDeviceCode.mockResolvedValueOnce(approvedRow);
    mockConsume.mockResolvedValueOnce(approvedRow);
    mockUpsertBridgeRefresh.mockResolvedValueOnce(false);

    const { POST } = await import("./poll/route");
    const res = await POST(jsonRequest(pollUrl, { deviceCode: "fixed-device-code" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "denied" });
  });

  it("approved but consume races to null -> {status:'consumed'}", async () => {
    const approvedRow = row({ status: "approved", sub: "user@example.com", refreshJti: "jti-123" });
    mockGetByDeviceCode.mockResolvedValueOnce(approvedRow);
    mockConsume.mockResolvedValueOnce(null);

    const { POST } = await import("./poll/route");
    const res = await POST(jsonRequest(pollUrl, { deviceCode: "fixed-device-code" }));
    await expect(res.json()).resolves.toEqual({ status: "consumed" });
    expect(mockUpsertBridgeRefresh).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/bridge/pair/approve", () => {
  const approveUrl = "http://localhost/api/auth/bridge/pair/approve";

  it("no session -> 401", async () => {
    mockAuth.mockResolvedValueOnce(null as never);
    const { POST } = await import("./approve/route");
    const res = await POST(jsonRequest(approveUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(401);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("with session, approvePairingRequest succeeds -> {ok:true}", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockApprove.mockResolvedValueOnce(row({ status: "approved", sub: "user@example.com" }));
    const { POST } = await import("./approve/route");
    const res = await POST(jsonRequest(approveUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(mockApprove).toHaveBeenCalledWith("ABCD-1234", "user@example.com", expect.any(String));
  });

  it("with session, approvePairingRequest returns null -> 400", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockApprove.mockResolvedValueOnce(null);
    const { POST } = await import("./approve/route");
    const res = await POST(jsonRequest(approveUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(400);
  });

  it("HIGH-1: bridge owned by a DIFFERENT account -> 409, does not approve", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "attacker@example.com" } } as never);
    mockGetByUserCode.mockResolvedValueOnce(row({ status: "pending", bridgeId: "bridge-1" }));
    mockGetBridgeRefreshOwner.mockResolvedValueOnce("owner@example.com");
    const { POST } = await import("./approve/route");
    const res = await POST(jsonRequest(approveUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "This bridge is registered to another account.",
    });
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("HIGH-1: bridge unclaimed (owner null) -> approves", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockGetByUserCode.mockResolvedValueOnce(row({ status: "pending", bridgeId: "bridge-1" }));
    mockGetBridgeRefreshOwner.mockResolvedValueOnce(null);
    mockApprove.mockResolvedValueOnce(row({ status: "approved", sub: "user@example.com" }));
    const { POST } = await import("./approve/route");
    const res = await POST(jsonRequest(approveUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith("ABCD-1234", "user@example.com", expect.any(String));
  });

  it("HIGH-1: bridge owned by the SAME account -> approves", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockGetByUserCode.mockResolvedValueOnce(row({ status: "pending", bridgeId: "bridge-1" }));
    mockGetBridgeRefreshOwner.mockResolvedValueOnce("user@example.com");
    mockApprove.mockResolvedValueOnce(row({ status: "approved", sub: "user@example.com" }));
    const { POST } = await import("./approve/route");
    const res = await POST(jsonRequest(approveUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith("ABCD-1234", "user@example.com", expect.any(String));
  });

  it("MED-4: rate-limited -> 429, does not approve", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterMs: 5000 });
    const { POST } = await import("./approve/route");
    const res = await POST(jsonRequest(approveUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith("pair-approve", "user@example.com");
    expect(mockApprove).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/bridge/pair/deny", () => {
  const denyUrl = "http://localhost/api/auth/bridge/pair/deny";

  it("no session -> 401", async () => {
    mockAuth.mockResolvedValueOnce(null as never);
    const { POST } = await import("./deny/route");
    const res = await POST(jsonRequest(denyUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(401);
    expect(mockDeny).not.toHaveBeenCalled();
  });

  it("with session -> {ok:true}", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockDeny.mockResolvedValueOnce(true);
    const { POST } = await import("./deny/route");
    const res = await POST(jsonRequest(denyUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(mockDeny).toHaveBeenCalledWith("ABCD-1234");
  });

  it("MED-4: rate-limited -> 429, does not deny", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterMs: 5000 });
    const { POST } = await import("./deny/route");
    const res = await POST(jsonRequest(denyUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith("pair-deny", "user@example.com");
    expect(mockDeny).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/bridge/pair/lookup", () => {
  const lookupUrl = "http://localhost/api/auth/bridge/pair/lookup";

  it("no session -> 401", async () => {
    mockAuth.mockResolvedValueOnce(null as never);
    const { POST } = await import("./lookup/route");
    const res = await POST(jsonRequest(lookupUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(401);
  });

  it("unknown userCode -> 404", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockGetByUserCode.mockResolvedValueOnce(null);
    const { POST } = await import("./lookup/route");
    const res = await POST(jsonRequest(lookupUrl, { userCode: "ZZZZ-0000" }));
    expect(res.status).toBe(404);
  });

  it("non-pending (e.g. denied) -> 404", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockGetByUserCode.mockResolvedValueOnce(row({ status: "denied" }));
    const { POST } = await import("./lookup/route");
    const res = await POST(jsonRequest(lookupUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(404);
  });

  it("expired pending -> 404", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockGetByUserCode.mockResolvedValueOnce(
      row({ status: "pending", expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    const { POST } = await import("./lookup/route");
    const res = await POST(jsonRequest(lookupUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(404);
  });

  it("pending -> {bridgeId,hostname,platform,createdAt}", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    const pendingRow = row({ status: "pending", bridgeId: "bridge-9", hostname: "host-9", platform: "linux" });
    mockGetByUserCode.mockResolvedValueOnce(pendingRow);
    const { POST } = await import("./lookup/route");
    const res = await POST(jsonRequest(lookupUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      bridgeId: "bridge-9",
      hostname: "host-9",
      platform: "linux",
      createdAt: pendingRow.createdAt,
    });
  });

  it("MED-4: rate-limited -> 429, does not look up", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } } as never);
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterMs: 5000 });
    const { POST } = await import("./lookup/route");
    const res = await POST(jsonRequest(lookupUrl, { userCode: "ABCD-1234" }));
    expect(res.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith("pair-lookup", "user@example.com");
    expect(mockGetByUserCode).not.toHaveBeenCalled();
  });
});
