import { afterEach, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import webpush from "web-push";
const mocks = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn(), config: vi.fn(), readLedger: vi.fn() }));
const ACCOUNT = "A".repeat(43);
// Auth reads the persisted trusted checkpoint (readTrustedCheckpoint); the fixtures below describe the stored row (no revoked ids).
vi.mock("@/lib/account-ledger-store", () => ({ readTrustedCheckpoint: async (accountId: string) => { const t = ((await mocks.readLedger({ accountId })) as { trusted?: object } | null | undefined)?.trusted; return t ? { revokedDeviceIds: [], revokedBridgeIds: [], ...t } : null; } }));
vi.mock("@/lib/auth-nonce-store", () => ({ consumeNonce: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: (config: unknown) => config }));
const ledgerWith = (trustedBridges: string[], rawBridges = trustedBridges) => ({ ledger: {}, sticky: { deviceIds: [], bridgeIds: [] },
  checkpoint: { bridges: rawBridges.map(bridgeId => ({ bridgeId })), devices: [] }, trusted: { bridges: trustedBridges.map(bridgeId => ({ bridgeId })), devices: [] } });
vi.mock("@/lib/db", () => ({ getDb: () => ({ query: mocks.query }) }));
vi.mock("@/lib/push", async original => ({ ...await original<typeof import("@/lib/push")>(), sendBrowserPush: mocks.send, pushConfig: mocks.config }));
import { POST } from "./route";
import { PushStore } from "@/lib/push-store";
const secret = "unit-signing-secret-for-local-fixtures-only";
const event = { sessionId: "s", sessionName: "Agent", kind: "question", eventKey: "question:00000000-0000-4000-8000-000000000001", title: "Question", message: "Choose", occurredAt: new Date().toISOString() };
const idle = { ...event, kind: "idle", eventKey: "idle:00000000-0000-4000-8000-000000000001" };
function request(bridge = true, payload: unknown = event, headers: Record<string, string> = {}) {
  const token = jwt.sign({ sub: ACCOUNT, ...(bridge ? { info: { bridgeId: "bridge", ownerId: ACCOUNT } } : {}) }, secret, { audience: "ftown:centrifugo", expiresIn: 60 });
  return new Request("https://app.test/api/push/events", { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(payload) });
}
function configure(pending: number, claim = true) {
  const keys = webpush.generateVAPIDKeys();
  vi.stubEnv("CENTRIFUGO_TOKEN_SECRET", secret);
  mocks.readLedger.mockResolvedValue(ledgerWith(["bridge"]));
  mocks.config.mockReturnValue({ publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:test@example.test" });
  mocks.query.mockImplementation(async (text: string) => {
    if (text.includes("RETURNING failed_count")) return [{ failed_count: 1 }];
    if (text.includes("SELECT payload")) return [{ payload: event }];
    if (text.includes("WITH claimed")) return claim ? [{ endpoint_hash: "endpoint", endpoint: "https://fcm.googleapis.com/x", p256dh: "fixture", auth: "fixture" }] : [];
    if (text.includes("COUNT(*) AS count")) return [{ count: pending }]; return [];
  });
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks(); });
it("rejects ordinary browser connection tokens before delivery", async () => { configure(0); expect((await POST(request(false))).status).toBe(401); expect(mocks.send).not.toHaveBeenCalled(); });
it("returns accepted after successful question provider delivery", async () => { configure(0); mocks.send.mockResolvedValue(201); const response = await POST(request()); expect(response.status).toBe(202); expect(await response.json()).toEqual({ accepted: true, pending: 0 }); });
it("leaves transient question delivery pending for bounded bridge retry", async () => { configure(1); mocks.send.mockResolvedValue(503); const response = await POST(request()); expect(response.status).toBe(503); expect(await response.json()).toEqual({ accepted: true, pending: 1 }); });
it("removes expired question endpoints without retrying them", async () => { configure(0); mocks.send.mockResolvedValue(410); expect((await POST(request())).status).toBe(202); });
it("keeps another question request's lease pending and never resends completed deliveries", async () => {
  configure(1, false); expect((await POST(request())).status).toBe(503); expect(mocks.send).not.toHaveBeenCalled();
  configure(0, false); expect((await POST(request())).status).toBe(202); expect(mocks.send).not.toHaveBeenCalled();
});
it("acknowledges authenticated idle without loading config or creating/claiming/delivering events", async () => {
  configure(0); mocks.config.mockReturnValue(null);
  const ingest = vi.spyOn(PushStore.prototype, "ingest"), claim = vi.spyOn(PushStore.prototype, "claim"), rate = vi.spyOn(PushStore.prototype, "rate");
  const response = await POST(request(true, idle));
  expect(response.status).toBe(202); expect(await response.json()).toEqual({ accepted: true, pending: false });
  expect(mocks.config).not.toHaveBeenCalled(); expect(ingest).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled(); expect(rate).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.readLedger).toHaveBeenCalledWith({ accountId: ACCOUNT });
});
it("still authenticates and validates idle before acknowledging it", async () => {
  configure(0); expect((await POST(new Request("https://app.test/api/push/events", { method: "POST", body: JSON.stringify(idle) }))).status).toBe(401);
  expect((await POST(request(false, idle))).status).toBe(401);
  mocks.readLedger.mockResolvedValueOnce(ledgerWith([])); expect((await POST(request(true, idle))).status).toBe(401);
  expect((await POST(request(true, { ...idle, eventKey: "idle:invalid" }))).status).toBe(400);
  const malformed = request(true, idle); const authorization = malformed.headers.get("authorization")!;
  expect((await POST(new Request("https://app.test/api/push/events", { method: "POST", headers: { authorization }, body: "{" }))).status).toBe(400);
  expect((await POST(request(true, idle, { "content-length": "16385" }))).status).toBe(413);
  expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
});
it("still rejects questions when provider configuration is unavailable", async () => {
  configure(0); mocks.config.mockReturnValue(null); const response = await POST(request());
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "push_unavailable" }); expect(mocks.send).not.toHaveBeenCalled();
});
it("rejects a bridge that a sticky revocation removed from the trusted roster, before any push work", async () => {
  configure(0); mocks.readLedger.mockResolvedValue(ledgerWith([], ["bridge"]));
  const ingest = vi.spyOn(PushStore.prototype, "ingest");
  expect((await POST(request())).status).toBe(401);
  expect(ingest).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});
it("scopes ingest to the token's account and bridge, never to anything in the body", async () => {
  configure(0); mocks.send.mockResolvedValue(201);
  const ingest = vi.spyOn(PushStore.prototype, "ingest");
  await POST(request(true, { ...event, bridgeId: "other-bridge", accountId: "B".repeat(43) }));
  expect(ingest).toHaveBeenCalledWith(ACCOUNT, "bridge", expect.anything());
});
