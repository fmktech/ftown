import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

const { requireAccount } = vi.hoisted(() => ({ requireAccount: vi.fn() }));
const { consumeRateLimit } = vi.hoisted(() => ({ consumeRateLimit: vi.fn() }));
vi.mock("@/lib/ledger-auth", () => ({ requireAccount }));
vi.mock("@/lib/login-rate-limit", () => ({ consumeRateLimit }));
vi.mock("@/lib/secrets", () => ({ getRequiredSecret: () => "s".repeat(40) }));
import { POST } from "./route";

const ACCOUNT = "A".repeat(43);
class Unauthorized extends Error { readonly status = 401; }

beforeEach(() => {
  requireAccount.mockReset();
  consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
  process.env.NEXT_PUBLIC_CENTRIFUGO_URL = "wss://relay.example/connection/websocket";
});

describe("/api/auth/token", () => {
  it("returns 401 and no token when requireAccount rejects (no session or revoked device)", async () => {
    requireAccount.mockRejectedValue(new Unauthorized());
    const response = await POST();
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain("token\":\"");
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it("limits per account: 120 per minute under relay-token-session, 429 rate_limited with Retry-After", async () => {
    requireAccount.mockResolvedValue({ accountId: ACCOUNT, endpointId: "e1" });
    expect((await POST()).status).toBe(200);
    expect(consumeRateLimit).toHaveBeenCalledWith("relay-token-session", ACCOUNT, { maxAttempts: 120, lockoutMs: 60_000 });
    consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 4200 });
    const response = await POST();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keys the limiter by account so another account is not throttled by this one", async () => {
    const counts = new Map<string, number>();
    consumeRateLimit.mockImplementation(async (scope: string, key: string, cfg: { maxAttempts: number }) => {
      const n = (counts.get(`${scope}:${key}`) ?? 0) + 1;
      counts.set(`${scope}:${key}`, n);
      return n <= cfg.maxAttempts ? { allowed: true } : { allowed: false, retryAfterMs: 1000 };
    });
    requireAccount.mockResolvedValue({ accountId: ACCOUNT, endpointId: "e1" });
    for (let i = 0; i < 120; i++) expect((await POST()).status).toBe(200);
    expect((await POST()).status).toBe(429);
    requireAccount.mockResolvedValue({ accountId: "B".repeat(43), endpointId: "e2" });
    expect((await POST()).status).toBe(200);
  });

  it("returns 500 (not a token) on an unexpected session-check failure", async () => {
    requireAccount.mockRejectedValue(new Error("db down"));
    expect((await POST()).status).toBe(500);
  });

  it("mints a 1 h relay JWT with sub = accountId", async () => {
    requireAccount.mockResolvedValue({ accountId: ACCOUNT, endpointId: "e1" });
    const response = await POST();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.accountId).toBe(ACCOUNT);
    expect(body.centrifugoUrl).toBe("wss://relay.example/connection/websocket");
    const claims = jwt.verify(body.token, "s".repeat(40), { audience: "ftown:centrifugo" }) as jwt.JwtPayload;
    expect(claims.sub).toBe(ACCOUNT);
    expect(claims.info).toBeUndefined();
    expect(claims.exp! - claims.iat!).toBe(3600);
    expect(body.expiresAt).toBe(claims.exp! * 1000);
  });
});
