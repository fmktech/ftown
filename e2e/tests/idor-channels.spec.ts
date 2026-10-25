import { expect, type BrowserContext } from "@playwright/test";
import { test } from "../helpers/fixtures";
import {
  sharedEmail,
  login,
  waitForBridgeOnline,
  createShellSession,
  getCentrifugoToken,
  registerAndLogin,
  type UserCreds,
} from "../helpers/app";
import { sessionIdsFor, waitForNewSessionId, commandsRpcClients } from "../helpers/centrifugo";
import {
  attemptSubscribe,
  attemptPublish,
  type CentrifugoAttempt,
} from "../helpers/centrifugo-raw";

/**
 * IDOR / cross-tenant isolation regression suite.
 *
 * Centrifugo's user-limited subscriptions and #<email> suffix protect routing
 * namespaces. Approved endpoint encryption independently protects application
 * contents and execution authority. A valid user B token cannot subscribe to
 * user A's protected channels, and raw commands cannot drive A's bridge even
 * when published with A's own broker token.
 *
 * This is DEFENSIVE regression testing. For the four SUBSCRIBE walls we assert
 * REJECTION only (a well-formed probe so the rejection is the authorization
 * layer's doing, not a malformed frame's). The command-channel PUBLISH case is
 * different: Centrifugo intentionally ACCEPTS a cross-user client publish
 * (allow_user_limited_channels gates subscribe, not publish), so the wall there
 * is enforced by the bridge's authenticated envelope and publisher checks. Raw
 * B and A probes establish no execution; only an approved browser's encrypted
 * command provides the positive control. These probes do not isolate which
 * independent bridge check rejects B.
 *
 * "Walled" outcome model (see helpers/centrifugo-raw.ts docstring):
 *   - resolve { ok:false, error.code === 103 }  → per-channel authz denial. WALLED.
 *   - throw (connect/subscribe refused entirely) → B never entered the namespace.
 *                                                  Also WALLED (accepted here).
 *   - resolve { ok:true }                        → THE WALL IS OPEN. Test FAILS
 *                                                  loudly, naming the channel.
 *
 * User A must be the shared-email user because the bridge only serves that
 * identity, and a real shell session can only be created against an online
 * bridge (the "create session" button is disabled otherwise). User B is a fresh,
 * isolated account in a second browser context.
 */

interface TenantA {
  email: string;
  sid: string;
  token: string;
}

let contextA: BrowserContext;
let contextB: BrowserContext;
let tenantA: TenantA;
let userB: UserCreds;
let tokenB: string;

/**
 * Assert that a subscribe/publish attempt by B against one of A's channels is
 * walled. A thrown rejection is accepted (connect/subscribe refused outright);
 * a resolved outcome MUST be ok:false — an ok:true means the wall is open and is
 * surfaced as a loud failure naming the exposed channel. Where the denial
 * resolves, we additionally require Centrifugo permission-denied code 103.
 */
async function expectWalled(
  channel: string,
  attempt: () => Promise<CentrifugoAttempt>,
): Promise<void> {
  let result: CentrifugoAttempt;
  try {
    result = await attempt();
  } catch {
    // Connect or subscribe/publish was refused entirely — B never reached into
    // A's namespace. This is a "walled" outcome; nothing resolved ok:true.
    return;
  }
  expect(
    result.ok,
    `SECURITY WALL OPEN: user B (${userB.email}) reached A's channel "${channel}" ` +
      `with B's own valid Centrifugo token — it resolved ok:true. Cross-tenant ` +
      `isolation is breached (allow_user_limited_channels / #email suffix regression).`,
  ).toBe(false);
  expect(
    result.error?.code,
    `"${channel}" was denied but not with Centrifugo permission-denied code 103 ` +
      `(got ${JSON.stringify(result.error)})`,
  ).toBe(103);
}

test.describe("IDOR: cross-tenant channel isolation", () => {
  test.beforeAll(async ({ browser }) => {
    // --- User A: the bridge-served shared-email user, in its own context. ---
    contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    const emailA = sharedEmail();
    await login(pageA, emailA);
    await waitForBridgeOnline(pageA);

    // Create a REAL shell session and capture its transport-independent sid via
    // the terminal-input:<sid>#<email> channel the bridge subscribes on create.
    const before = await sessionIdsFor(emailA);
    await createShellSession(pageA, `idor-A-${Date.now()}`);
    const sid = await waitForNewSessionId(emailA, before);
    const tokenA = await getCentrifugoToken(pageA);
    tenantA = { email: emailA, sid, token: tokenA };

    // --- User B: a fresh, isolated tenant in a second context. ---
    contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    userB = await registerAndLogin(pageB); // mints a fresh makeUser() identity
    tokenB = await getCentrifugoToken(pageB);
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  test("B cannot subscribe to A's session events channel", async () => {
    const channel = `events:${tenantA.sid}#${tenantA.email}`;
    await expectWalled(channel, () => attemptSubscribe(tokenB, channel));
  });

  test("B cannot subscribe to A's terminal output channel", async () => {
    const channel = `terminal:${tenantA.sid}#${tenantA.email}`;
    await expectWalled(channel, () => attemptSubscribe(tokenB, channel));
  });

  test("B cannot subscribe to A's terminal-input (keystroke-injection) channel", async () => {
    const channel = `terminal-input:${tenantA.sid}#${tenantA.email}`;
    await expectWalled(channel, () => attemptSubscribe(tokenB, channel));
  });

  test("B cannot subscribe to A's bridge presence channel", async () => {
    const channel = `bridges:presence#${tenantA.email}`;
    await expectWalled(channel, () => attemptSubscribe(tokenB, channel));
  });

  test("raw B and owner commands cannot drive A's bridge; an approved encrypted browser can", async ({ browser }) => {
    // The command channel is the ONE place Centrifugo does NOT wall B out:
    // allow_user_limited_channels gates SUBSCRIBE only, and allow_publish_for_client
    // lets any authenticated client PUBLISH to another user's channel — so B's
    // publish to commands:rpc#<A> is accepted by this broker configuration. The wall
    // is at the bridge: both the authenticated publisher and approved encrypted
    // endpoint are checked. A raw B create_session must never spawn a session.
    const channel = `commands:rpc#${tenantA.email}`;
    const bridgeClientsBefore = await commandsRpcClients(tenantA.email);
    const before = await sessionIdsFor(tenantA.email);

    // B publishes a REAL create_session to A's command channel. Centrifugo accepts
    // the publish (that acceptance is no longer the security boundary); the bridge
    // must ignore it. This does not isolate publisher checking from HPKE checks.
    const foreignResult = await attemptPublish(tokenB, channel, {
      type: "create_session",
      payload: { command: "/bin/zsh -l", shellType: "shell", name: `idor-B-inject-${Date.now()}` },
      requestId: `idor-B-${Date.now()}`,
    });
    expect(foreignResult.ok, "the broker accepted B's raw command probe").toBe(true);

    // Give A's bridge a beat to (not) act, then assert A's live-session inventory
    // is unchanged — the bridge dropped B's foreign publication, so no session was
    // spawned. sessionIdsFor is a transport-independent inventory (one
    // terminal-input:<sid>#<A> channel per live session the bridge serves).
    await new Promise((r) => setTimeout(r, 3000));
    const afterInject = await sessionIdsFor(tenantA.email);
    expect(
      [...afterInject].filter((id) => !before.has(id)),
      `SECURITY: B's create_session published to ${channel} caused A's bridge to spawn a ` +
        `session — a foreign plaintext command crossed the execution boundary.`,
    ).toEqual([]);

    // A's bridges must remain subscribed — B's publish must not knock them off.
    const bridgeClientsAfter = await commandsRpcClients(tenantA.email);
    expect(bridgeClientsAfter, `A's bridge should still be listening on ${channel}`).toBeGreaterThanOrEqual(1);
    expect(bridgeClientsBefore).toBeGreaterThanOrEqual(1);

    // The owner's valid broker token alone must not grant application authority.
    // Preserve the same raw command probe and verify encryption is mandatory.
    const ownResult = await attemptPublish(tenantA.token, channel, {
      type: "create_session",
      payload: { command: "/bin/zsh -l", shellType: "shell", name: `idor-A-control-${Date.now()}` },
      requestId: `idor-A-${Date.now()}`,
    });
    expect(
      ownResult.ok,
      `A's raw publish to ${channel} must reach the broker for the envelope-enforcement probe`,
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 3000));
    const afterOwnerPlaintext = await sessionIdsFor(tenantA.email);
    expect([...afterOwnerPlaintext].filter(id => !before.has(id)), "owner plaintext commands must not spawn sessions").toEqual([]);

    // Real browser approval and the production UI issue an encrypted command on
    // the same cloud channel. Its effect and opaque wire packet prove the path
    // remains usable without admitting either raw command above.
    // Approval lifetime is per test; the beforeAll setup browser's endpoint has
    // already been revoked by the common cleanup after the first channel probe.
    const controlContext = await browser.newContext();
    try {
      const controlPage = await controlContext.newPage();
      const ownerFrames: string[] = [];
      controlPage.on("websocket", socket => socket.on("framesent", ({ payload }) => {
        ownerFrames.push(typeof payload === "string" ? payload : payload.toString());
      }));
      await login(controlPage, tenantA.email);
      await waitForBridgeOnline(controlPage);
      const beforeEncryptedFrames = ownerFrames.length;
      const controlName = `idor-A-encrypted-${Date.now()}`;
      await createShellSession(controlPage, controlName);
      const newId = await waitForNewSessionId(tenantA.email, before);
      expect(newId, "the approved browser's encrypted command should spawn a session").toBeTruthy();
      await expect(controlPage.getByRole("button", { name: new RegExp(controlName) })).toBeVisible();
      const encryptedFrames = ownerFrames.slice(beforeEncryptedFrames);
      const encryptedCommandOnSameChannel = encryptedFrames.some(frame => frame.split("\n").some(line => {
        try {
          const command = JSON.parse(line) as { publish?: { channel?: string; data?: { type?: string; purpose?: string; enc?: string; ciphertext?: string } } } | null;
          const data = command?.publish?.data;
          return command?.publish?.channel === channel && data?.type === "ftown_encrypted" && data.purpose === "application"
            && typeof data.enc === "string" && typeof data.ciphertext === "string";
        } catch { return false; }
      }));
      expect(encryptedCommandOnSameChannel, "approved browser publishes an encrypted application envelope to the same command channel").toBe(true);
      expect(encryptedFrames.join("\n")).not.toContain(controlName);
      expect(encryptedFrames.join("\n")).not.toContain('"type":"create_session"');
    } finally {
      await controlContext.close();
    }
  });

  test("positive control: B CAN subscribe to B's OWN command/RPC channel", async () => {
    // Proves the raw client + B's token work and that the rejections above are
    // authorization, not a broken helper: B on its own user-limited channel is
    // allowed and must resolve ok:true.
    const channel = `commands:rpc#${userB.email}`;
    const result = await attemptSubscribe(tokenB, channel);
    expect(
      result.ok,
      `positive control failed: B could not subscribe to its OWN channel "${channel}" ` +
        `(${JSON.stringify(result.error)}) — the rejections above may be a broken client, not authz`,
    ).toBe(true);
  });
});
