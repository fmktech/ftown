import { afterEach, beforeEach, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import type { Centrifuge } from "centrifuge";

const { query, published } = vi.hoisted(() => ({ query: vi.fn(), published: [] as Array<{ channel: string; data: unknown }> }));
vi.mock("centrifuge", () => ({ Centrifuge: class {
  private handlers: Record<string, () => void> = {};
  on(event: string, handler: () => void) { this.handlers[event] = handler; return this; }
  connect() { queueMicrotask(() => this.handlers.connected?.()); }
  disconnect() {}
  async publish(channel: string, data: unknown) { published.push({ channel, data }); return {}; }
} }));
vi.mock("@/lib/pending-approval-store", () => ({ PENDING_NORMALIZED_EMAIL_SQL: "norm(email)" }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ query }) }));
import { nudgeOwnerById, nudgeOwnerByTarget, nudgePendingChange, publishOwnerSecurityNudge } from "./server-security-nudge";

class FakeClient {
  handlers: Record<string, () => void> = {};
  published: Array<{ channel: string; data: unknown }> = [];
  disconnects = 0;
  connects = 0;
  publishResult: Promise<unknown> = Promise.resolve({});
  on(event: string, handler: () => void) { this.handlers[event] = handler; return this; }
  connect() { this.connects++; }
  disconnect() { this.disconnects++; }
  publish(channel: string, data: unknown) { this.published.push({ channel, data }); return this.publishResult; }
}
const asClient = (c: FakeClient) => c as unknown as Centrifuge;
const flush = () => new Promise(resolve => setTimeout(resolve, 20));

beforeEach(() => { vi.useRealTimers(); query.mockReset(); published.length = 0; vi.stubEnv("CENTRIFUGO_TOKEN_SECRET", "k".repeat(48)); vi.stubEnv("NEXT_PUBLIC_CENTRIFUGO_URL", "wss://hub.test/ws"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it("publishes the exact nudge on the owner's channel after connected, then disconnects", async () => {
  const client = new FakeClient();
  const createClient = vi.fn(() => asClient(client));
  const signToken = vi.fn(() => "signed");
  const done = publishOwnerSecurityNudge("owner@example.test", "approvals", { signToken, centrifugoUrl: () => "wss://hub.test/ws", createClient });
  await flush();
  expect(client.published).toEqual([]);
  expect(client.disconnects).toBe(0);
  client.handlers.connected();
  await done;
  expect(createClient).toHaveBeenCalledWith("wss://hub.test/ws", "signed");
  expect(signToken).toHaveBeenCalledWith("owner@example.test");
  expect(client.published).toEqual([{ channel: "bridges:security#owner@example.test", data: { type: "ftown_security_changed", version: 1, scope: "approvals" } }]);
  expect(client.disconnects).toBe(1);
});

it("default token is a 60 s ftown:centrifugo JWT for the owner email", async () => {
  vi.stubEnv("CENTRIFUGO_TOKEN_SECRET", "k".repeat(48));
  const client = new FakeClient();
  const createClient = vi.fn((_url: string, _token: string) => asClient(client));
  const done = publishOwnerSecurityNudge("owner@example.test", "account", { centrifugoUrl: () => "wss://hub.test/ws", createClient });
  client.handlers.connected();
  await done;
  const claims = jwt.verify(createClient.mock.calls[0][1] as string, "k".repeat(48), { audience: "ftown:centrifugo" }) as jwt.JwtPayload;
  expect(claims.sub).toBe("owner@example.test");
  expect(claims.exp! - claims.iat!).toBe(60);
});

it("times out after 3 s without connecting and disconnects", async () => {
  vi.useFakeTimers();
  const client = new FakeClient();
  const done = publishOwnerSecurityNudge("owner@example.test", "account", { signToken: () => "t", centrifugoUrl: () => "wss://hub.test/ws", createClient: () => asClient(client) });
  await vi.advanceTimersByTimeAsync(2999);
  expect(client.disconnects).toBe(0);
  await vi.advanceTimersByTimeAsync(2);
  await done;
  expect(client.disconnects).toBe(1);
  expect(client.published).toEqual([]);
});

it("a missing secret or URL is a no-op", async () => {
  const createClient = vi.fn();
  await publishOwnerSecurityNudge("owner@example.test", "account", { centrifugoUrl: () => null, signToken: () => "t", createClient });
  vi.stubEnv("CENTRIFUGO_TOKEN_SECRET", "");
  await publishOwnerSecurityNudge("owner@example.test", "account", { centrifugoUrl: () => "wss://hub.test/ws", createClient });
  await publishOwnerSecurityNudge("", "account", { centrifugoUrl: () => "wss://hub.test/ws", signToken: () => "t", createClient });
  expect(createClient).not.toHaveBeenCalled();
});

it("never throws: sign, create, publish rejection and connect failures are swallowed", async () => {
  const url = () => "wss://hub.test/ws";
  await expect(publishOwnerSecurityNudge("o@e.test", "account", { centrifugoUrl: url, signToken: () => { throw new Error("x"); } })).resolves.toBeUndefined();
  await expect(publishOwnerSecurityNudge("o@e.test", "account", { centrifugoUrl: url, signToken: () => "t", createClient: () => { throw new Error("x"); } })).resolves.toBeUndefined();
  const rejecting = new FakeClient(); rejecting.publishResult = Promise.reject(new Error("denied"));
  const done = publishOwnerSecurityNudge("o@e.test", "account", { centrifugoUrl: url, signToken: () => "t", createClient: () => asClient(rejecting) });
  rejecting.handlers.connected();
  await expect(done).resolves.toBeUndefined();
  expect(rejecting.disconnects).toBe(1);
  const broken = new FakeClient(); broken.connect = () => { throw new Error("boom"); }; broken.disconnect = () => { throw new Error("boom"); };
  await expect(publishOwnerSecurityNudge("o@e.test", "account", { centrifugoUrl: url, signToken: () => "t", createClient: () => asClient(broken) })).resolves.toBeUndefined();
});

it("owner lookups are no-ops for unknown or ambiguous owners and swallow db errors", async () => {
  query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ email: "a@e.test" }, { email: "b@e.test" }]).mockRejectedValueOnce(new Error("db"));
  await expect(nudgeOwnerById("id", "account")).resolves.toBeUndefined();
  await expect(nudgeOwnerByTarget("t", "approvals")).resolves.toBeUndefined();
  await expect(nudgeOwnerById("id", "account")).resolves.toBeUndefined();
  expect(query).toHaveBeenCalledTimes(3);
  expect(published).toEqual([]);
});

it("nudgePendingChange does nothing without a change", async () => {
  nudgePendingChange({ change: null });
  await flush();
  expect(query).not.toHaveBeenCalled();
});

it("a unique owner publishes every requested scope over one connection and one lookup", async () => {
  query.mockResolvedValueOnce([{ email: "a@e.test" }]);
  await nudgeOwnerByTarget("a@e.test", ["approvals", "account"]);
  expect(query).toHaveBeenCalledTimes(1);
  expect(published.map(item => (item.data as { scope: string }).scope).sort()).toEqual(["account", "approvals"]);
  expect(new Set(published.map(item => item.channel))).toEqual(new Set(["bridges:security#a@e.test"]));
});
