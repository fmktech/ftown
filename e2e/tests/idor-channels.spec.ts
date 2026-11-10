import { expect, type BrowserContext } from "@playwright/test";
import jwt from "jsonwebtoken";
import { test } from "../helpers/fixtures";
import { login, sharedAccountId, waitForBridgeOnline, createShellSession, getCentrifugoToken } from "../helpers/app";
import { browserEndpointId } from "../helpers/passkey";
import { revokeDevices } from "../helpers/ledger-admin";
import { sessionIdsFor, waitForNewSessionId, commandsRpcClients } from "../helpers/centrifugo";
import { attemptSubscribe, attemptPublish, type CentrifugoAttempt } from "../helpers/centrifugo-raw";
import { CENTRIFUGO_TOKEN_SECRET, TOKEN_AUDIENCE, UI_BASE_URL } from "../helpers/config";

/**
 * Relay channel guards of the shared account A that do not need a second
 * account: unauthenticated / garbage / wrong-secret / expired tokens never
 * connect, a REVOKED browser can no longer mint a relay token, and raw
 * plaintext commands published to A's own commands:rpc do not drive the bridge
 * (the bridge requires encrypted, ledger-trusted envelopes).
 *
 * Cross-account channel isolation (a REAL second account B's relay token on
 * every one of A's channels, subscribe and publish) lives in
 * account-isolation.spec.ts; it replaced the hand-minted "other relay tenant"
 * JWT this spec used while the server held a single account.
 */

interface TenantA {
  accountId: string;
  sid: string;
  token: string;
}

let contextA: BrowserContext;
let tenantA: TenantA;

/** A thrown rejection (connect/subscribe refused) is walled; a resolved outcome must be ok:false/103. */
async function expectWalled(channel: string, attempt: () => Promise<CentrifugoAttempt>, who: string): Promise<void> {
  let result: CentrifugoAttempt;
  try {
    result = await attempt();
  } catch {
    return;
  }
  expect(result.ok, `SECURITY WALL OPEN: ${who} reached A's channel "${channel}" - it resolved ok:true.`).toBe(false);
  expect(result.error?.code, `"${channel}" denied but not with permission-denied 103 (got ${JSON.stringify(result.error)})`).toBe(103);
}

test.describe("IDOR: relay channel guards of the shared account", () => {
  test.beforeAll(async ({ browser }) => {
    contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    const accountId = sharedAccountId();
    await login(pageA);
    await waitForBridgeOnline(pageA);
    const before = await sessionIdsFor(accountId);
    await createShellSession(pageA, `idor-A-${Date.now()}`);
    const sid = await waitForNewSessionId(accountId, before);
    tenantA = { accountId, sid, token: await getCentrifugoToken(pageA) };
  });

  test.afterAll(async () => {
    await contextA?.close();
  });

  test("positive control: A's own relay token subscribes to A's commands:rpc channel", async () => {
    const channel = `commands:rpc#${tenantA.accountId}`;
    const result = await attemptSubscribe(tenantA.token, channel);
    expect(result.ok, `positive control failed on "${channel}" (${JSON.stringify(result.error)}) - rejections below may be a broken client`).toBe(true);
  });

  test("no token and garbage tokens cannot connect or subscribe", async () => {
    const channel = `sessions:updates#${tenantA.accountId}`;
    const wrongSecret = jwt.sign({ sub: tenantA.accountId }, "not-the-relay-secret-0123456789abcdef", {
      algorithm: "HS256", audience: TOKEN_AUDIENCE, expiresIn: 600,
    });
    const expired = jwt.sign({ sub: tenantA.accountId, exp: Math.floor(Date.now() / 1000) - 3600 }, CENTRIFUGO_TOKEN_SECRET, {
      algorithm: "HS256", audience: TOKEN_AUDIENCE,
    });
    for (const [label, token] of [["empty", ""], ["garbage", "not.a.jwt"], ["wrong secret", wrongSecret], ["expired", expired]] as const) {
      await expectWalled(channel, () => attemptSubscribe(token, channel), `${label} token`);
    }
  });

  test("a REVOKED browser cannot mint a relay token", async ({ browser }) => {
    const ctx2 = await browser.newContext();
    try {
      const page2 = await ctx2.newPage();
      await login(page2, { browserLabel: "E2E revoked browser" });
      const before = await page2.request.post(`${UI_BASE_URL}/api/auth/token`);
      expect(before.status(), "a signed-in, trusted browser mints a token").toBe(200);
      await revokeDevices([await browserEndpointId(page2)]);
      const after = await page2.request.post(`${UI_BASE_URL}/api/auth/token`);
      expect(after.status(), "a revoked browser must be refused a relay token").toBe(401);
    } finally {
      await ctx2.close();
    }
  });

  test("raw plaintext commands on commands:rpc never drive the bridge; the signed-in browser can create a session", async ({ browser }) => {
    // The broker accepts the account's own raw publish, so the wall is the bridge's encrypted-envelope +
    // ledger-trust check: a plaintext create_session must not spawn a session. (Another account's publish
    // into this channel: account-isolation.spec.ts.)
    const channel = `commands:rpc#${tenantA.accountId}`;
    expect(await commandsRpcClients(tenantA.accountId)).toBeGreaterThanOrEqual(1);
    const before = await sessionIdsFor(tenantA.accountId);

    const own = await attemptPublish(tenantA.token, channel, {
      type: "create_session",
      payload: { command: "/bin/zsh -l", shellType: "shell", name: `idor-A-plain-${Date.now()}` },
      requestId: `idor-A-plain-${Date.now()}`,
    });
    expect(own.ok, "the broker accepts the account's own raw publish; the bridge must still refuse it").toBe(true);
    await new Promise((r) => setTimeout(r, 3000));
    const after = await sessionIdsFor(tenantA.accountId);
    expect(
      [...after].filter((id) => !before.has(id)),
      `SECURITY: a plaintext create_session on ${channel} spawned a session - an unencrypted command crossed the execution boundary.`,
    ).toEqual([]);
    expect(await commandsRpcClients(tenantA.accountId), "bridges stay subscribed").toBeGreaterThanOrEqual(1);

    // Positive control: a signed-in browser's encrypted command through the UI does spawn a session.
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const frames: string[] = [];
      page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
        frames.push(typeof payload === "string" ? payload : payload.toString());
      }));
      await login(page);
      await waitForBridgeOnline(page);
      const start = frames.length;
      const name = `idor-A-encrypted-${Date.now()}`;
      await createShellSession(page, name);
      const newId = await waitForNewSessionId(tenantA.accountId, before);
      expect(newId, "the signed-in browser's encrypted command should spawn a session").toBeTruthy();
      await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
      const sent = frames.slice(start);
      const encrypted = sent.some((frame) => frame.split("\n").some((line) => {
        try {
          const cmd = JSON.parse(line) as { publish?: { channel?: string; data?: { type?: string; purpose?: string; enc?: string; ciphertext?: string } } } | null;
          const d = cmd?.publish?.data;
          return cmd?.publish?.channel === channel && d?.type === "ftown_encrypted" && d.purpose === "application"
            && typeof d.enc === "string" && typeof d.ciphertext === "string";
        } catch { return false; }
      }));
      expect(encrypted, "browser publishes an encrypted application envelope to commands:rpc").toBe(true);
      expect(sent.join("\n")).not.toContain(name);
      expect(sent.join("\n")).not.toContain('"type":"create_session"');
    } finally {
      await ctx.close();
    }
  });
});
