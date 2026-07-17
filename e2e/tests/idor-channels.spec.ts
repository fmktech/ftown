import { test, expect, type BrowserContext } from "@playwright/test";
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
 * This is DEFENSIVE regression testing. For the four SUBSCRIBE walls we assert
 * REJECTION only (a well-formed probe so the rejection is the authorization
 * layer's doing, not a malformed frame's). The command-channel PUBLISH case is
 * different: Centrifugo intentionally ACCEPTS a cross-user client publish
 * (allow_user_limited_channels gates subscribe, not publish), so the wall there
 * is DEFENSE-IN-DEPTH AT THE BRIDGE — that test asserts A's bridge never ACTS on
 * B's published command, not that Centrifugo rejects it.
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

  test("B cannot DRIVE A's bridge by publishing a command (bridge ignores foreign publisher)", async () => {
    // The command channel is the ONE place Centrifugo does NOT wall B out:
    // allow_user_limited_channels gates SUBSCRIBE only, and allow_publish_for_client
    // lets any authenticated client PUBLISH to another user's channel — so B's
    // publish to commands:rpc#<A> is ACCEPTED (may resolve ok:true). The real wall
    // is now DEFENSE-IN-DEPTH AT THE BRIDGE, not at Centrifugo: the bridge drops
    // any publication whose authenticated publisher (ctx.info.user) != the channel
    // owner. So we assert the behavioral truth — B's create_session never causes
    // A's bridge to actually spawn a session.
    const channel = `commands:rpc#${tenantA.email}`;
    const bridgeClientsBefore = await commandsRpcClients(tenantA.email);
    const before = await sessionIdsFor(tenantA.email);

    // B publishes a REAL create_session to A's command channel. Centrifugo accepts
    // the publish (that acceptance is no longer the security boundary); the bridge
    // must ignore it because ctx.info.user == B != A.
    await attemptPublish(tokenB, channel, {
      type: "create_session",
      payload: { command: "/bin/zsh -l", shellType: "shell", name: `idor-B-inject-${Date.now()}` },
      requestId: `idor-B-${Date.now()}`,
    });

    // Give A's bridge a beat to (not) act, then assert A's live-session inventory
    // is unchanged — the bridge dropped B's foreign publication, so no session was
    // spawned. sessionIdsFor is a transport-independent inventory (one
    // terminal-input:<sid>#<A> channel per live session the bridge serves).
    await new Promise((r) => setTimeout(r, 3000));
    const afterInject = await sessionIdsFor(tenantA.email);
    expect(
      [...afterInject].filter((id) => !before.has(id)),
      `SECURITY: B's create_session published to ${channel} caused A's bridge to spawn a ` +
        `session — the bridge acted on a FOREIGN publisher. Cross-tenant RCE via command publish.`,
    ).toEqual([]);

    // The bridge must remain the sole, undisturbed subscriber — B's publish must
    // not have joined the channel or knocked the bridge off.
    const bridgeClientsAfter = await commandsRpcClients(tenantA.email);
    expect(bridgeClientsAfter, `A's bridge should still be listening on ${channel}`).toBeGreaterThanOrEqual(1);
    expect(bridgeClientsBefore).toBeGreaterThanOrEqual(1);

    // Positive control + fail-CLOSED validation: A's OWN publish to the SAME
    // channel — carrying info.user == A — MUST still drive the bridge. This proves
    // (a) the guard is not a globally-broken command path, and (b) Centrifugo
    // actually populates ctx.info.user for client publishes, so the owner's own
    // commands are not silently broken by the fail-closed guard.
    const ownResult = await attemptPublish(tenantA.token, channel, {
      type: "create_session",
      payload: { command: "/bin/zsh -l", shellType: "shell", name: `idor-A-control-${Date.now()}` },
      requestId: `idor-A-${Date.now()}`,
    });
    expect(
      ownResult.ok,
      `A's own publish to ${channel} was rejected by Centrifugo (${JSON.stringify(ownResult.error)}) — ` +
        `the positive control cannot run`,
    ).toBe(true);
    const newId = await waitForNewSessionId(tenantA.email, before);
    expect(newId, "A's own create_session (info.user == A) should have spawned a new session").toBeTruthy();
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
