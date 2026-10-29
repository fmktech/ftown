import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ query }) }));
import { consumeRateLimit, recordAttempt } from "./login-rate-limit";

beforeEach(() => query.mockReset());

describe("consumeRateLimit", () => {
  it("uses one parameterized upsert and returns the database admission decision", async () => {
    query.mockResolvedValueOnce([{ allowed: true, retry_after_ms: "1000" }]);
    await expect(consumeRateLimit("scope", "key", { maxAttempts: 2, lockoutMs: 1000 })).resolves.toEqual({ allowed: true });
    expect(query).toHaveBeenCalledTimes(1);
    const [statement, params] = query.mock.calls[0];
    expect(statement).toContain("ON CONFLICT (scope, key) DO UPDATE");
    expect(statement).toContain("RETURNING failed_count <= $3::integer AS allowed");
    expect(statement).toContain("locked_until IS NULL OR rate_limit_attempts.locked_until <= NOW()");
    expect(statement).toContain("LEAST(rate_limit_attempts.failed_count, $3::integer) + 1");
    expect(params).toEqual(["scope", "key", 2, 1000]);
    query.mockResolvedValueOnce([{ allowed: false, retry_after_ms: "429" }]);
    await expect(consumeRateLimit("scope", "key", { maxAttempts: 2, lockoutMs: 1000 })).resolves.toEqual({ allowed: false, retryAfterMs: 429 });
  });

  it.each([
    { maxAttempts: 0, lockoutMs: 1 }, { maxAttempts: 1.5, lockoutMs: 1 },
    { maxAttempts: 2147483647, lockoutMs: 1 }, { maxAttempts: 1, lockoutMs: 0 },
    { maxAttempts: 1, lockoutMs: Infinity }, { maxAttempts: 1, lockoutMs: 0.5 },
  ])("rejects invalid configuration before database access: %o", async (config) => {
    await expect(consumeRateLimit("scope", "key", config)).rejects.toThrow(RangeError);
    expect(query).not.toHaveBeenCalled();
  });
});

it("resets an expired legacy lock count and recalculates its lock", async () => {
  query.mockResolvedValueOnce([]);
  await recordAttempt("legacy", "key", { maxAttempts: 10, lockoutMs: 1000 });
  const statement = query.mock.calls[0][0];
  expect(statement).toContain("locked_until <= NOW() THEN 1");
  expect(statement).toContain("THEN CASE WHEN $3::integer <= 1");
});
