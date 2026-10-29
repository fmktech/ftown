import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const { state, consume, query, revoke } = vi.hoisted(() => ({
  state: { authenticated: true, registration: true }, consume: vi.fn(), query: vi.fn(), revoke: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: async () => state.authenticated ? { user: { email: "test@example.com" } } : null }));
vi.mock("@/lib/registration", () => ({ isRegistrationEnabled: () => state.registration }));
vi.mock("@/lib/login-rate-limit", () => ({ consumeRateLimit: consume, REGISTER_RATE_LIMIT: { maxAttempts: 10, lockoutMs: 3600000 } }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ query }) }));
vi.mock("@/lib/bridge-refresh", () => ({ revokeDevice: revoke, setBridgeRefreshJti: vi.fn(), getOwnerIdForSub: vi.fn(), rotateBridgeRefreshJti: vi.fn() }));
vi.mock("@/lib/secrets", () => ({ getRequiredSecret: () => "test-secret" }));
vi.mock("bcryptjs", () => ({ hash: vi.fn() }));
import { POST as bridge } from "@/app/api/auth/bridge/route";
import { POST as refresh } from "@/app/api/auth/bridge/refresh/route";
import { POST as revokeRoute } from "@/app/api/bridges/devices/revoke/route";
import { POST as register } from "@/app/api/auth/register/route";

const routes = [bridge, refresh, revokeRoute, register];
function request(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}): NextRequest {
  return new Request("http://localhost", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit) as NextRequest;
}
function stream(body: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } });
}

beforeEach(() => {
  state.authenticated = true; state.registration = true;
  consume.mockReset().mockResolvedValue({ allowed: true }); query.mockReset(); revoke.mockReset();
});

describe.each(routes.map((route, index) => [index, route] as const))("route %i", (_index, route) => {
  it.each(["null", "[]", '"string"', "123", "{"])("rejects non-object or malformed JSON %s", async (body) => {
    expect((await route(request(body))).status).toBe(400);
    expect(query).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
  });
  it("returns 413 for declared and streamed oversized bodies", async () => {
    expect((await route(request("{}", { "content-length": "16385" }))).status).toBe(413);
    expect((await route(request(stream('"' + "x".repeat(16384) + '"')))).status).toBe(413);
    expect(query).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
  });
  it("rejects unsupported content types", async () => {
    expect((await route(request("{}", { "content-type": "text/plain" }))).status).toBe(400);
  });
});

it("keeps revoke authentication ahead of body reading", async () => {
  state.authenticated = false;
  expect((await revokeRoute(request("{}", { "content-length": "16385" }))).status).toBe(401);
  expect(revoke).not.toHaveBeenCalled();
});

it("keeps disabled registration ahead of admission and body reading", async () => {
  state.registration = false;
  expect((await register(request("{}", { "content-length": "16385" }))).status).toBe(404);
  expect(consume).not.toHaveBeenCalled();
});

it("charges malformed registration requests and denies before reading the body", async () => {
  expect((await register(request("{" , { "fly-client-ip": "source" }))).status).toBe(400);
  expect(consume).toHaveBeenCalledWith("register-admission", "source", { maxAttempts: 10, lockoutMs: 3600000 });
  consume.mockResolvedValueOnce({ allowed: false });
  expect((await register(request("{}", { "content-length": "16385" }))).status).toBe(429);
  expect(query).not.toHaveBeenCalled();
});

it("allows an exactly 16 KiB valid revoke body and calls the existing operation", async () => {
  revoke.mockResolvedValue(true);
  const prefix = '{"bridgeId":"device","padding":"';
  const suffix = '"}';
  const body = prefix + "x".repeat(16384 - prefix.length - suffix.length) + suffix;
  expect(Buffer.byteLength(body)).toBe(16384);
  const response = await revokeRoute(request(body));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(revoke).toHaveBeenCalledWith("test@example.com", "device");
});

it("retains invalid bridge token authentication failures", async () => {
  expect((await bridge(request(JSON.stringify({ token: "invalid", bridgeId: "bridge", hostname: "host" })))).status).toBe(401);
  expect((await refresh(request(JSON.stringify({ refreshToken: "invalid", bridgeId: "bridge", hostname: "host" })))).status).toBe(401);
});

it("limits malformed registration attempts from one source", async () => {
  let count = 0;
  consume.mockImplementation(async () => ({ allowed: ++count <= 10 }));
  for (let i = 0; i < 10; i++) expect((await register(request("{"))).status).toBe(400);
  expect((await register(request("{"))).status).toBe(429);
  expect(query).not.toHaveBeenCalled();
});
