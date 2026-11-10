import { expect, type BrowserContext } from "@playwright/test";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { test } from "../helpers/fixtures";
import { login, sharedAccountId, waitForBridgeOnline, createShellSession, getCentrifugoToken } from "../helpers/app";
import { browserEndpointId } from "../helpers/passkey";
import { revokeDevices } from "../helpers/ledger-admin";
import { sessionIdsFor, waitForNewSessionId, commandsRpcClients } from "../helpers/centrifugo";
import { attemptSubscribe, attemptPublish, type CentrifugoAttempt } from "../helpers/centrifugo-raw";
import { CENTRIFUGO_TOKEN_SECRET, TOKEN_AUDIENCE, UI_BASE_URL } from "../helpers/config";

/**
 * Channel isolation under the single-account passkey-ledger product.
 *
 * There is exactly ONE account per server, so there is no "user B". The
 * outsider is another tenant of the relay: a validly signed Centrifugo JWT
 * (HS256, aud ftown:centrifugo) whose `sub` is a different 43-char account id.
 * Its own `#<sub>` channels are allowed; A's `#<accountId>` channels must be
 * denied (allow_user_limited_channels). Raw plaintext commands published to
 * commands:rpc must not drive the bridge (the bridge requires encrypted,
 * ledger-trusted envelopes). Unauthenticated / garbage tokens never connect,
 * and a REVOKED browser can no longer mint a relay token.
 */

interface TenantA {
  accountId: string;
  sid: string;
  token: string;
}

let contextA: BrowserContext;
let tenantA: TenantA;
let outsiderSub: string;
let outsiderToken: string;

/** Another relay tenant: same secret/audience, different 43-char base64url sub. */
function mintOutsiderToken(sub: string): string {
  return jwt.sign({ sub }, CENTRIFUGO_TOKEN_SECRET, { algorithm: "HS256", audience: TOKEN_AUDIENCE, expiresIn: 600 });
}

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

test.describe("IDOR: relay channel isolation", () => {
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
    outsiderSub = randomBytes(32).toString("base64url");
    expect(outsiderSub).toHaveLength(43);
    expect(outsiderSub).not.toBe(accountId);
    outsiderToken = mintOutsiderToken(outsiderSub);
  });

  test.afterAll(async () => {
    await contextA?.close();
  });

  for (const [label, channelOf] of [
    ["sessions:updates", (a: TenantA) => `sessions:updates#${a.accountId}`],
    ["session events", (a: TenantA) => `events:${a.sid}#${a.accountId}`],
    ["terminal output", (a: TenantA) => `terminal:${a.sid}#${a.accountId}`],
    ["terminal-input (keystroke injection)", (a: TenantA) => `terminal-input:${a.sid}#${a.accountId}`],
    ["bridge presence", (a: TenantA) => `bridges:presence#${a.accountId}`],
    ["commands:rpc", (a: TenantA) => `commands:rpc#${a.accountId}`],
  ] as Array<[string, (a: TenantA) => string]>) {
    test(`another relay tenant cannot subscribe to A's ${label} channel`, async () => {
      const channel = channelOf(tenantA);
      await expectWalled(channel, () => attemptSubscribe(outsiderToken, channel), `outsider tenant (${outsiderSub})`);
    });
  }

  test("positive control: the outsider CAN subscribe to its OWN commands:rpc channel", async () => {
    const channel = `commands:rpc#${outsiderSub}`;
    const result = await attemptSubscribe(outsiderToken, channel);
    expect(result.ok, `positive control failed on "${channel}" (${JSON.stringify(result.error)}) - rejections above may be a broken client`).toBe(true);
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
    // Centrifugo accepts client publishes (only SUBSCRIBE is user-limited), so the wall is the
    // bridge's encrypted-envelope + ledger-trust check. Neither an outsider's nor the account's own
    // plaintext create_session may spawn a session.
    const channel = `commands:rpc#${tenantA.accountId}`;
    expect(await commandsRpcClients(tenantA.accountId)).toBeGreaterThanOrEqual(1);
    const before = await sessionIdsFor(tenantA.accountId);

    const foreign = await attemptPublish(outsiderToken, channel, {
      type: "create_session",
      payload: { command: "/bin/zsh -l", shellType: "shell", name: `idor-outsider-${Date.now()}` },
      requestId: `idor-outsider-${Date.now()}`,
    }).catch((e: unknown) => ({ ok: false, error: { code: -1, message: String(e) } }) as CentrifugoAttempt);
    // Either the broker denies the foreign publish or accepts it and the bridge ignores it; both are safe.
    void foreign;
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
