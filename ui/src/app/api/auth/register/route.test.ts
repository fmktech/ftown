import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { query, deferred } = vi.hoisted(() => ({
  query: vi.fn(),
  deferred: [] as Array<() => Promise<void>>,
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => Promise<void>) => deferred.push(callback),
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({ query }) }));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed") }));
vi.mock("@/lib/login-rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  recordAttempt: vi.fn(),
  REGISTER_RATE_LIMIT: {},
}));

import { POST } from "./route";

const webhook = vi.fn();
const email = "customer@example.com";
const register = () => POST(new Request("http://localhost/api/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: "password123" }),
}));

beforeEach(() => {
  query.mockReset();
  deferred.length = 0;
  webhook.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", webhook);
  vi.stubEnv("REGISTRATION_ENABLED", "true");
  vi.stubEnv("SLACK_SIGNUP_WEBHOOK_URL", "https://example.com/signup-hook");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("signup notification", () => {
  it("sends the exact payload after a successful signup response", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "new-user" }]);
    expect((await register()).status).toBe(200);
    expect(webhook).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await deferred[0]();
    expect(webhook).toHaveBeenCalledExactlyOnceWith("https://example.com/signup-hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: "ftown", customer: email, email }),
      signal: expect.any(AbortSignal),
    });
    expect(query.mock.calls[1][0]).toContain("RETURNING id");
  });

  it.each(["existing", "concurrent"])("does not notify for %s accounts", async (kind) => {
    query.mockResolvedValueOnce(kind === "existing" ? [{ id: "existing" }] : []);
    if (kind === "concurrent") query.mockResolvedValueOnce([]);
    expect((await register()).status).toBe(200);
    expect(deferred).toHaveLength(0);
    expect(webhook).not.toHaveBeenCalled();
  });

  it.each(["network", "http", "timeout"])("ignores %s failures without retries", async (kind) => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "new-user" }]);
    if (kind === "http") webhook.mockResolvedValue(new Response(null, { status: 500 }));
    else if (kind === "network") webhook.mockRejectedValue(new Error("offline"));
    else {
      vi.useFakeTimers();
      const controller = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
      });
      webhook.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("timeout")));
      }));
    }
    expect((await register()).status).toBe(200);
    const delivery = deferred[0]();
    if (kind === "timeout") {
      expect(AbortSignal.timeout).toHaveBeenCalledWith(3000);
      await vi.advanceTimersByTimeAsync(3000);
    }
    await expect(delivery).resolves.toBeUndefined();
    expect(webhook).toHaveBeenCalledTimes(1);
  });

  it("skips delivery when the environment variable is unset", async () => {
    vi.stubEnv("SLACK_SIGNUP_WEBHOOK_URL", "");
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "new-user" }]);
    expect((await register()).status).toBe(200);
    await deferred[0]();
    expect(webhook).not.toHaveBeenCalled();
  });

  it("does not notify when insertion fails", async () => {
    query.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(register()).rejects.toThrow("database unavailable");
    expect(deferred).toHaveLength(0);
    expect(webhook).not.toHaveBeenCalled();
  });
});
