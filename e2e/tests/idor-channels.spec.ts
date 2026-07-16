import { test, expect, type BrowserContext } from "@playwright/test";
import {
  sharedEmail,
  registerUser,
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
 * The ENTIRE cross-tenant wall in this system is two things working together:
 *   1. Centrifugo's `allow_user_limited_channels`, and
 *   2. the mandatory `#<email>` suffix on every per-user channel.
 * A user-limited channel `ch#<owner>` may only be subscribed/published by a
 * connection whose token `sub` equals `<owner>`. If that config or the suffix
 * convention ever regresses, one tenant can read another tenant's terminal,
 * inject keystrokes, or drive another tenant's bridge. This suite proves the
 * wall holds by having a fully-valid user B — its OWN, accepted Centrifugo
 * token — attempt to reach into user A's namespace and be refused every time.
 *
 * This is DEFENSIVE regression testing: we assert REJECTION only. We never try
 * to actually exfiltrate data or execute a command; a well-formed probe is used
 * purely so the rejection is the authorization layer's doing, not a malformed
 * frame's.
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
    await registerUser(emailA);
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

  test("B cannot PUBLISH to A's command/RPC channel", async () => {
    // The load-bearing wall: the bridge executes any command arriving on
    // commands:rpc#<email> with no per-caller payload check, so publish-authz is
    // the ONLY thing stopping B from driving A's bridge. A well-formed-ish
    // envelope is used so the rejection is authorization's doing, not a bad frame.
    const channel = `commands:rpc#${tenantA.email}`;
    const bridgeClientsBefore = await commandsRpcClients(tenantA.email);

    await expectWalled(channel, () =>
      attemptPublish(tokenB, channel, { type: "list_sessions", requestId: "idor-probe" }),
    );

    // Defense in depth: because Centrifugo rejected the publish, the envelope
    // never reached A's bridge, so it cannot have acted. The observable proxy is
    // that A's bridge remains the sole, undisturbed subscriber on its command
    // channel — B's rejected publish neither joined it nor knocked the bridge off.
    const bridgeClientsAfter = await commandsRpcClients(tenantA.email);
    expect(
      bridgeClientsAfter,
      `A's bridge subscriber count on ${channel} changed after B's rejected publish ` +
        `(${bridgeClientsBefore} → ${bridgeClientsAfter}) — the bridge may have reacted`,
    ).toBe(bridgeClientsBefore);
    expect(bridgeClientsAfter, `A's bridge should still be listening on ${channel}`).toBeGreaterThanOrEqual(1);
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
