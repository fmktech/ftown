import { test, expect, type APIRequestContext } from "@playwright/test";
import { makeUser, registerAndLogin, sharedEmail, E2E_PASSWORD } from "../helpers/app";
import { bridgeApiFetch, readBridgePointer } from "../helpers/bridge-api";
import { UI_BASE_URL } from "../helpers/config";

/**
 * Defensive authZ / IDOR regression suite. Every test asserts that a guard
 * RETURNS THE SECURE STATUS for hostile input — it never exploits anything and
 * never mutates cross-tenant state. Two groups:
 *
 *  GROUP 1 — the bridge's loopback HTTP API (bind 127.0.0.1) triple-guards
 *  /api/**: a spoofed Host ⇒ 421, a non-localhost Origin ⇒ 403, a missing/wrong
 *  bearer ⇒ 401. A positive control (legit pointer bearer + loopback host) ⇒ 200
 *  proves the guards deny ONLY bad input.
 *
 *  GROUP 2 — the Next.js UI API routes (NextAuth-protected, owner-scoped). Acting
 *  as user B (or unauthenticated) against user A's resources must never leak or
 *  mutate A's data: the connect-token `sub` is the session email (unspoofable),
 *  unauthenticated calls are rejected, revoking A's bridge as B is a 0-row no-op
 *  (404) that leaves A's bridge intact, and B's device list never contains A's
 *  bridgeId.
 *
 * User A is the harness's shared user (sharedEmail()) — the running e2e bridge
 * was onboarded to it via /api/auth/bridge, so a bridge_refresh row for
 * pointer.bridgeId is owned by A. User B is a fresh, isolated account.
 */

/** Decode a JWT payload (base64url) WITHOUT verifying — we only inspect claims. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error(`not a JWT (expected 3 parts): ${token}`);
  const json = Buffer.from(parts[1], "base64url").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

interface DeviceListBody {
  devices?: Array<{ bridgeId?: string; revoked?: boolean }>;
}

/** GET /api/bridges/devices with the given (authenticated or anon) request context. */
async function getDevices(req: APIRequestContext): Promise<{ status: number; body: DeviceListBody }> {
  const res = await req.get(`${UI_BASE_URL}/api/bridges/devices`);
  const body = res.status() === 200 ? ((await res.json()) as DeviceListBody) : {};
  return { status: res.status(), body };
}

test.describe("GROUP 1 — bridge loopback API guards", () => {
  test("wrong Host ⇒ 421 (Misdirected Request)", async () => {
    const res = await bridgeApiFetch("GET", "/api/sessions", { host: "evil.example.com" });
    expect(res.status, "spoofed Host must be rejected with 421").toBe(421);
  });

  test("non-localhost Origin ⇒ 403", async () => {
    const res = await bridgeApiFetch("GET", "/api/sessions", { origin: "http://evil.example.com" });
    expect(res.status, "non-localhost Origin must be rejected with 403").toBe(403);
  });

  test("missing bearer ⇒ 401", async () => {
    const res = await bridgeApiFetch("GET", "/api/sessions", { bearer: null });
    expect(res.status, "missing Authorization must be rejected with 401").toBe(401);
  });

  test("wrong bearer ⇒ 401", async () => {
    const res = await bridgeApiFetch("GET", "/api/sessions", { bearer: "wrong-token-xxxx" });
    expect(res.status, "wrong bearer token must be rejected with 401").toBe(401);
  });

  test("positive control: legit pointer bearer + loopback host/origin ⇒ 200", async () => {
    const res = await bridgeApiFetch("GET", "/api/sessions", {});
    expect(res.status, "guards must ADMIT a legitimate loopback+bearer call").toBe(200);
  });
});

test.describe("GROUP 2 — UI API route authZ / IDOR", () => {
  test("Centrifugo connect-token sub is the session email — body input is ignored", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const b = await registerAndLogin(page, makeUser("e2e-idor-b"));

      // Attempt to spoof the subject via the request body. The route (POST() with
      // no request param) signs session.user.email and ignores input entirely.
      const res = await page.request.post(`${UI_BASE_URL}/api/auth/token`, {
        data: { sub: "attacker@evil.example.com", email: "attacker@evil.example.com" },
      });
      expect(res.status(), "authenticated token mint must succeed").toBe(200);
      const { token } = (await res.json()) as { token?: string };
      expect(token, "route must return a token").toBeTruthy();

      const claims = decodeJwtPayload(token!);
      expect(claims.sub, "token sub must be the session email, never body-controlled").toBe(b.email);
      expect(claims.aud, "token audience must be pinned to the Centrifugo aud").toBe("ftown:centrifugo");
    } finally {
      await context.close();
    }
  });

  test("unauthenticated /api/auth/token and /api/bridges/devices are rejected", async ({ browser }) => {
    // Fresh context, never logged in ⇒ no NextAuth session cookie.
    const anon = await browser.newContext();
    try {
      const tokenRes = await anon.request.post(`${UI_BASE_URL}/api/auth/token`);
      expect(tokenRes.status(), "anon token mint must be denied").not.toBe(200);
      expect([401, 403], "anon /api/auth/token secure status").toContain(tokenRes.status());

      const devRes = await anon.request.get(`${UI_BASE_URL}/api/bridges/devices`);
      expect(devRes.status(), "anon device list must be denied").not.toBe(200);
      expect([401, 403], "anon /api/bridges/devices secure status").toContain(devRes.status());
    } finally {
      await anon.close();
    }
  });

  test("device revoke IDOR — B cannot revoke A's bridge; A's bridge survives", async ({ browser }) => {
    const aBridgeId = readBridgePointer().bridgeId;
    expect(aBridgeId, "running bridge must advertise a bridgeId").toBeTruthy();

    const aCtx = await browser.newContext();
    const bCtx = await browser.newContext();
    try {
      // User A = the harness user that owns the running bridge.
      const aPage = await aCtx.newPage();
      await registerAndLogin(aPage, { email: sharedEmail(), password: E2E_PASSWORD });

      // Precondition: A owns pointer.bridgeId and it is not revoked.
      const before = await getDevices(aPage.request);
      expect(before.status).toBe(200);
      const aDeviceBefore = (before.body.devices ?? []).find((d) => d.bridgeId === aBridgeId);
      expect(aDeviceBefore, `A must own bridge ${aBridgeId} before the IDOR attempt`).toBeTruthy();
      expect(aDeviceBefore?.revoked, "A's bridge must start un-revoked").toBe(false);

      // User B = fresh, isolated account.
      const bPage = await bCtx.newPage();
      await registerAndLogin(bPage, makeUser("e2e-idor-b"));

      // B attempts to revoke A's bridge. revokeDevice is scoped by sub, so the
      // UPDATE matches 0 rows for B ⇒ the route returns 404 {error:"Device not found"}.
      const revoke = await bPage.request.post(`${UI_BASE_URL}/api/bridges/devices/revoke`, {
        data: { bridgeId: aBridgeId },
      });
      expect(
        revoke.status(),
        `IDOR: B must NOT be able to revoke A's bridge ${aBridgeId} — expected secure 404`,
      ).toBe(404);
      // If the route ever returns 2xx here, the assertion above already fails
      // loudly naming the exposed bridgeId.

      // CRUCIAL: A's bridge is untouched — still present and still un-revoked.
      const after = await getDevices(aPage.request);
      expect(after.status).toBe(200);
      const aDeviceAfter = (after.body.devices ?? []).find((d) => d.bridgeId === aBridgeId);
      expect(aDeviceAfter, `A's bridge ${aBridgeId} must still exist after B's revoke attempt`).toBeTruthy();
      expect(aDeviceAfter?.revoked, `A's bridge ${aBridgeId} must remain un-revoked (no cross-tenant mutation)`).toBe(
        false,
      );
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });

  test("device list isolation — B's device list never contains A's bridgeId", async ({ browser }) => {
    const aBridgeId = readBridgePointer().bridgeId;
    const bCtx = await browser.newContext();
    try {
      const bPage = await bCtx.newPage();
      await registerAndLogin(bPage, makeUser("e2e-idor-b"));

      const { status, body } = await getDevices(bPage.request);
      expect(status, "B's authenticated device list must succeed").toBe(200);
      const ids = (body.devices ?? []).map((d) => d.bridgeId);
      expect(ids, `IDOR: B's device list leaked A's bridge ${aBridgeId}`).not.toContain(aBridgeId);
      // B paired no bridge, so its list is empty — proving strict owner-scoping.
      expect(body.devices ?? [], "fresh user B must see zero devices").toHaveLength(0);
    } finally {
      await bCtx.close();
    }
  });
});
