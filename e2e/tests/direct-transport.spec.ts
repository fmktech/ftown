import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  sharedEmail,
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
 * Transport-ladder e2e: loopback WS → WebRTC → Centrifugo.
 * See docs/plans/direct-transport-contract.md + docs/plans/loopback-transport-addendum.md.
 *
 * On a same-machine stack the loopback rung always wins, so each test pins the
 * ladder to one rung via two browser-side knobs (no product code involved):
 *
 *  - BLOCK LOOPBACK: LoopbackPeer connects with the browser-global
 *    `new WebSocket("ws://127.0.0.1:{port}/ws?nonce=…")` (loopback-peer.ts),
 *    while the Centrifuge client targets `ws://localhost:8000/...` — the
 *    hostnames differ, so we wrap window.WebSocket and redirect ONLY
 *    `ws://127.0.0.1` URLs to a dead port (127.0.0.1:1). The socket fails with
 *    natural WebSocket error/close semantics (connection refused), which the
 *    ladder treats as a rung failure (addendum L4) and falls through.
 *    Centrifugo traffic is untouched.
 *  - BLOCK WEBRTC: RTCPeerConnection undefined ⇒ pairing throws ⇒ next rung.
 *
 * | Test | loopback | WebRTC | expected badge | terminal:<sid> subscriber |
 * |------|----------|--------|----------------|---------------------------|
 * | A    | blocked  | on     | P2P            | absent                    |
 * | B'   | on       | off    | Local          | absent                    |
 * | C    | blocked  | off    | Cloud          | PRESENT                   |
 *
 * B' is the WARP-immunity headline: the loopback rung is pure TCP on 127.0.0.1
 * and must work even where VPN endpoint filters kill WebRTC's UDP.
 *
 * Assertions are scoped to the session id (derived from the transport-
 * independent terminal-input:<sid> channel the bridge creates on every
 * session), so stale channels from earlier sessions never confound the result.
 */

async function blockLoopbackWs(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const NativeWS = window.WebSocket;
    const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      let target = String(url);
      if (target.startsWith("ws://127.0.0.1")) {
        // Dead port ⇒ immediate connection refused ⇒ rung falls through (L4).
        target = "ws://127.0.0.1:1/e2e-blocked";
      }
      return new NativeWS(target, protocols);
    } as unknown as typeof WebSocket;
    Wrapped.prototype = NativeWS.prototype;
    Object.defineProperties(Wrapped, {
      CONNECTING: { value: NativeWS.CONNECTING },
      OPEN: { value: NativeWS.OPEN },
      CLOSING: { value: NativeWS.CLOSING },
      CLOSED: { value: NativeWS.CLOSED },
    });
    window.WebSocket = Wrapped;
  });
}

async function blockWebRtc(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(window, "RTCPeerConnection", { value: undefined });
  });
}

/** Login → create shell session → prove the terminal round-trips a marker. */
async function terminalFlow(page: Page, sessionName: string, marker: string): Promise<string> {
  const email = sharedEmail();
  await login(page, email);
  await waitForBridgeOnline(page);

  const before = await sessionIdsFor(email);
  await createShellSession(page, sessionName);
  const sessionId = await waitForNewSessionId(email, before);
  await openSession(page, sessionName);
  await runMarkerInTerminal(page, marker);
  return sessionId;
}

/** The transport badge pill renders exactly one of P2P / Local / Cloud ("…" while connecting). */
async function expectBadge(page: Page, label: "P2P" | "Local" | "Cloud"): Promise<void> {
  await expect(page.locator("text=/^(P2P|Local|Cloud)$/").first()).toHaveText(label, {
    timeout: 15_000,
  });
}

test.describe("transport ladder", () => {
  test("A: WebRTC rung — loopback blocked ⇒ badge P2P, no terminal:<sid> subscriber", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await blockLoopbackWs(context);
    const page = await context.newPage();
    const email = sharedEmail();

    try {
      const sessionId = await terminalFlow(page, `webrtc-${Date.now()}`, `E2EDIRECT${Date.now()}`);
      await expectBadge(page, "P2P");

      const present = await waitForChannels(
        () => terminalChannelPresent(sessionId, email),
        (p) => p === false,
        { timeoutMs: 3000 },
      );
      expect(present, `P2P rung must leave terminal:${sessionId} unsubscribed (R3)`).toBe(false);
      expect(await commandsRpcClients(email)).toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  test("B': loopback rung — WebRTC disabled ⇒ badge Local, no terminal:<sid> subscriber", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await blockWebRtc(context);
    const page = await context.newPage();
    const email = sharedEmail();

    try {
      const sessionId = await terminalFlow(page, `local-${Date.now()}`, `E2ELOCAL${Date.now()}`);
      await expectBadge(page, "Local");

      const present = await waitForChannels(
        () => terminalChannelPresent(sessionId, email),
        (p) => p === false,
        { timeoutMs: 3000 },
      );
      expect(present, `Local rung must leave terminal:${sessionId} unsubscribed (R3/L5)`).toBe(false);
      expect(await commandsRpcClients(email)).toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  test("C: cloud fallback — WebRTC disabled AND loopback blocked ⇒ badge Cloud, subscriber present", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await blockWebRtc(context);
    await blockLoopbackWs(context);
    const page = await context.newPage();
    const email = sharedEmail();

    try {
      // Long fast-typed marker (30+ chars, keyboard.type at full speed): live
      // regression check on the cloud input path's keystroke-ordering fix — the
      // exact string must round-trip; any transposition fails the assert.
      const longMarker = `E2ECLOUD${Date.now()}${String(Math.random()).slice(2, 14)}`;
      const sessionId = await terminalFlow(page, `cloud-${Date.now()}`, longMarker);
      await expectBadge(page, "Cloud");

      const present = await waitForChannels(
        () => terminalChannelPresent(sessionId, email),
        (p) => p === true,
        { timeoutMs: 8000 },
      );
      expect(present, `Cloud fallback must subscribe terminal:${sessionId} (R2)`).toBe(true);
      expect(await commandsRpcClients(email)).toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });
});
