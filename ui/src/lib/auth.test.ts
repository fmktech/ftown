import { beforeEach, expect, it, vi } from "vitest";

const { state, query, compare, consume } = vi.hoisted(() => ({
  state: { authorize: undefined as undefined | ((credentials: Record<string, unknown>, request: Request) => Promise<unknown>) },
  query: vi.fn(), compare: vi.fn(), consume: vi.fn(),
}));
vi.mock("next-auth", () => ({ default: (config: { providers: Array<{ authorize: typeof state.authorize }> }) => {
  state.authorize = config.providers[0].authorize;
  return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
} }));
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }));
vi.mock("@/lib/secrets", () => ({ getRequiredSecret: () => "secret" }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ query }) }));
vi.mock("bcryptjs", () => ({ compare }));
vi.mock("@/lib/login-rate-limit", () => ({ consumeRateLimit: consume, LOGIN_IP_RATE_LIMIT: { maxAttempts: 30, lockoutMs: 900000 } }));
import "./auth";

const login = (ip: string, password = "password") => state.authorize!(
  { email: "victim@example.com", password }, new Request("http://localhost", { headers: { "fly-client-ip": ip } })
);

beforeEach(() => { query.mockReset(); compare.mockReset(); consume.mockReset(); });

it("charges every login to its source, including successes, and does not lock the victim email", async () => {
  const counts = new Map<string, number>();
  consume.mockImplementation(async (_scope, ip) => {
    const count = (counts.get(ip) ?? 0) + 1; counts.set(ip, count);
    return { allowed: count <= 30 };
  });
  query.mockResolvedValue([{ id: "victim", email: "victim@example.com", password_hash: "hash" }]);
  compare.mockResolvedValue(false);
  for (let i = 0; i < 30; i++) expect(await login("attacker")).toBeNull();
  await expect(login("attacker")).rejects.toThrow("Too many failed attempts");
  expect(query).toHaveBeenCalledTimes(30);
  compare.mockResolvedValue(true);
  await expect(login("victim")).resolves.toEqual({ id: "victim", email: "victim@example.com" });
  await expect(login("victim")).resolves.toEqual({ id: "victim", email: "victim@example.com" });
  expect(counts.get("victim")).toBe(2);
  expect(consume).toHaveBeenCalledWith("login-ip-admission", "victim", { maxAttempts: 30, lockoutMs: 900000 });
});

it("uses the dummy hash for unknown users and rejects oversized passwords before expensive work", async () => {
  consume.mockResolvedValue({ allowed: true }); query.mockResolvedValue([]); compare.mockResolvedValue(false);
  expect(await login("source")).toBeNull();
  expect(compare).toHaveBeenCalledWith("password", expect.stringMatching(/^\$2b\$12\$/));
  consume.mockClear(); query.mockClear(); compare.mockClear();
  expect(await login("source", "x".repeat(1025))).toBeNull();
  expect(consume).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); expect(compare).not.toHaveBeenCalled();
});
