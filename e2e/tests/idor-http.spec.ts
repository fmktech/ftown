import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedAccountId } from "../helpers/app";
import { bridgeApiFetch, readBridgePointer } from "../helpers/bridge-api";
import { UI_BASE_URL, TOKEN_AUDIENCE } from "../helpers/config";
import { createSecondAccount } from "../helpers/second-account";

/**
 * Defensive authZ regression suite. Every test asserts that a guard RETURNS THE
 * SECURE STATUS for hostile input; nothing is exploited or mutated.
 *
 *  GROUP 1 - the bridge's loopback HTTP API (bind 127.0.0.1): spoofed Host 421,
 *  hostile Origin 403 on public security routes, plaintext business calls 426,
 *  approved encrypted call 200.
 *
 *  GROUP 2 - the Next.js UI API routes on a multi-account server:
 *  the relay-token sub is the session accountId (body input ignored),
 *  unauthenticated callers are refused, /api/bridges/devices/** no longer
 *  exists (404), and a REAL second account's relay token is no credential for
 *  the session-only security routes. Cross-account IDOR on every
 *  account-scoped route with B's session (endpoint directory, device names,
 *  push, pair mailbox, relay tokens, ledger) lives in account-isolation.spec.ts.
 */

/** Decode a JWT payload (base64url) WITHOUT verifying — we only inspect claims. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error(`not a JWT (expected 3 parts): ${token}`);
  const json = Buffer.from(parts[1], "base64url").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

test.describe("GROUP 1 — bridge loopback API guards", () => {
  test("wrong Host ⇒ 421 (Misdirected Request)", async () => {
    const res = await bridgeApiFetch("GET", "/api/sessions", { host: "evil.example.com" });
    expect(res.status, "spoofed Host must be rejected with 421").toBe(421);
  });

  test("hostile Origin is rejected by security discovery and envelope routes", async () => {
    for (const [method, path] of [["GET", "/api/security/info"], ["POST", "/api/security/envelope"]]) {
      const res = await bridgeApiFetch(method, path, { origin: "http://evil.example.com", body: method === "POST" ? {} : undefined });
      expect(res.status, `${method} ${path} must reject a hostile Origin`).toBe(403);
    }
    const allowed = await bridgeApiFetch("GET", "/api/security/info", { origin: UI_BASE_URL });
    expect(allowed.status, "security discovery accepts the configured browser origin").toBe(200);
  });

  test("plaintext business API without a bearer requires encryption", async () => {
    const res = await bridgeApiFetch("GET", "/api/sessions", { bearer: null });
    expect(res.status).toBe(426);
    expect(res.body).toEqual({ error: "upgrade_required", code: "upgrade_required" });
  });

  test("plaintext business API with wrong or valid hook bearer still requires encryption", async () => {
    for (const bearer of ["wrong-token-xxxx", readBridgePointer().token]) {
      const res = await bridgeApiFetch("GET", "/api/sessions", { bearer });
      expect(res.status).toBe(426);
      expect(res.body).toEqual({ error: "upgrade_required", code: "upgrade_required" });
    }
    const hostileOrigin = await bridgeApiFetch("GET", "/api/sessions", { origin: "http://evil.example.com" });
    expect(hostileOrigin.status, "plaintext business routes cannot bypass encryption through Origin headers").toBe(426);
  });

  test("positive control: approved encrypted loopback request ⇒ 200", async () => {
    const res = await bridgeApiFetch("GET", "/api/sessions", {});
    expect(res.status, "approved encrypted endpoints must retain business API access").toBe(200);
  });
});

test.describe("GROUP 2 - UI API route authZ", () => {
  test("relay token sub is the session accountId - body input is ignored", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await login(page);
      const res = await page.request.post(`${UI_BASE_URL}/api/auth/token`, {
        data: { sub: "attacker-account-id", accountId: "attacker-account-id", email: "attacker@evil.example.com" },
      });
      expect(res.status(), "authenticated token mint must succeed").toBe(200);
      const body = (await res.json()) as { token?: string; accountId?: string };
      expect(body.token, "route must return a token").toBeTruthy();
      const claims = decodeJwtPayload(body.token!);
      expect(claims.sub, "token sub must be the session accountId, never body-controlled").toBe(sharedAccountId());
      expect(body.accountId).toBe(sharedAccountId());
      expect(claims.aud, "token audience pinned").toBe(TOKEN_AUDIENCE);
    } finally {
      await context.close();
    }
  });

  test("unauthenticated /api/auth/token is rejected", async ({ browser }) => {
    const anon = await browser.newContext();
    try {
      const res = await anon.request.post(`${UI_BASE_URL}/api/auth/token`);
      expect(res.status(), "anon token mint must be 401").toBe(401);
    } finally {
      await anon.close();
    }
  });

  test("/api/bridges/devices routes no longer exist (404)", async ({ browser }) => {
    const anon = await browser.newContext();
    try {
      expect((await anon.request.get(`${UI_BASE_URL}/api/bridges/devices`)).status()).toBe(404);
      expect((await anon.request.post(`${UI_BASE_URL}/api/bridges/devices/revoke`, { data: { bridgeId: "x" } })).status()).toBe(404);
    } finally {
      await anon.close();
    }
  });

  test("/api/security/endpoints and /device-names refuse unauthenticated callers and a real second account's relay token", async ({ browser }) => {
    // B is a real, unrelated account on this server; its relay token comes from B's own session.
    const second = await createSecondAccount(browser);
    const anon = await browser.newContext();
    try {
      const relayToken = await second.relayToken();
      expect(relayToken.split(".")).toHaveLength(3);
      for (const path of ["/api/security/endpoints", "/api/security/device-names"]) {
        const none = await anon.request.get(`${UI_BASE_URL}${path}`);
        expect(none.status(), `anonymous GET ${path}`).toBe(401);
        const bearer = await anon.request.get(`${UI_BASE_URL}${path}`, { headers: { Authorization: `Bearer ${relayToken}` } });
        expect(bearer.status(), `account B's relay token as a bearer on GET ${path}`).toBe(401);
      }
    } finally {
      await anon.close();
      await second.close();
    }
  });
});
