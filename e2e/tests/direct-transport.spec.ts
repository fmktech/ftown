import { test, expect } from "@playwright/test";
import {
  sharedEmail,
  registerUser,
  login,
  waitForBridgeOnline,
  createShellSession,
  openSession,
  runMarkerInTerminal,
} from "../helpers/app";
import {
  terminalChannelPresent,
  commandsRpcClients,
  sessionIdsFor,
  waitForNewSessionId,
  waitForChannels,
} from "../helpers/centrifugo";

/**
 * Direct-transport e2e. Exercises the real browser data plane against a real
 * bridge + Centrifugo. See docs/plans/direct-transport-contract.md.
 *
 * Assertions are scoped to the specific session id (derived from the
 * transport-independent terminal-input:<sid> channel the bridge creates on every
 * session), so stale channels from earlier sessions never confound the result.
 *
 * Test A proves the WebRTC direct path: terminal works while the session's
 * Centrifugo terminal:<sid> channel has NO subscriber (R3). Test B disables
 * WebRTC and proves the watcher-gated Centrifugo fallback: terminal works AND
 * terminal:<sid> HAS a subscriber (R2).
 */

test.describe("direct-transport", () => {
  test("A: direct path — terminal works with no Centrifugo terminal:<sid> subscriber", async ({
    page,
  }) => {
    const email = sharedEmail();
    const marker = `E2EDIRECT${Date.now()}`;
    const sessionName = `direct-${Date.now()}`;

    await registerUser(email);
    await login(page, email);
    await waitForBridgeOnline(page);

    // Control plane must be alive on commands:rpc#<email>.
    const rpc = await waitForChannels(
      () => commandsRpcClients(email),
      (n) => n >= 1,
    );
    expect(rpc, "commands:rpc#<email> should have a subscriber").toBeGreaterThanOrEqual(1);

    const before = await sessionIdsFor(email);
    await createShellSession(page, sessionName);
    const sessionId = await waitForNewSessionId(email, before);

    await openSession(page, sessionName);
    await runMarkerInTerminal(page, marker);

    // Terminal is demonstrably working. On the direct path the client MUST NOT
    // subscribe to terminal:<sid>#<email> (R3) and the bridge never publishes
    // there (no watcher), so the channel must have NO subscriber. Poll briefly to
    // let any transient settle, then assert absence holds.
    const present = await waitForChannels(
      () => terminalChannelPresent(sessionId, email),
      (p) => p === false,
      { timeoutMs: 3000 },
    );
    expect(
      present,
      `direct path must have NO subscriber on terminal:${sessionId}#${email}`,
    ).toBe(false);

    expect(await commandsRpcClients(email)).toBeGreaterThanOrEqual(1);
  });

  test("B: fallback path — WebRTC disabled ⇒ Centrifugo terminal:<sid> subscriber active", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    // Force the transport's silent fallback: any pairing attempt throws because
    // RTCPeerConnection is undefined, so HybridTerminalTransport goes to Centrifugo.
    await context.addInitScript(() => {
      Object.defineProperty(window, "RTCPeerConnection", { value: undefined });
    });
    const page = await context.newPage();

    const email = sharedEmail();
    const marker = `E2EFALLBACK${Date.now()}`;
    const sessionName = `fallback-${Date.now()}`;

    try {
      await registerUser(email);
      await login(page, email);
      await waitForBridgeOnline(page);

      const before = await sessionIdsFor(email);
      await createShellSession(page, sessionName);
      const sessionId = await waitForNewSessionId(email, before);

      await openSession(page, sessionName);
      await runMarkerInTerminal(page, marker);

      // Fallback path: the client subscribes to terminal:<sid>#<email> and sends
      // terminal_watch, so the bridge publishes there (R2). The channel must have
      // a subscriber.
      const present = await waitForChannels(
        () => terminalChannelPresent(sessionId, email),
        (p) => p === true,
        { timeoutMs: 8000 },
      );
      expect(
        present,
        `fallback path must have a subscriber on terminal:${sessionId}#${email}`,
      ).toBe(true);

      expect(await commandsRpcClients(email)).toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });
});
