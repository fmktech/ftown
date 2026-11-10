import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_BASE_URL } from "./config";
import { createShellSessionWhenAccepted, getCentrifugoToken, waitForBridgeOnline } from "./app";
import { tryReadBridgePointer, type BridgePointer } from "./bridge-api";
import { sessionIdsFor, waitForBridgePresence, waitForNewSessionId } from "./centrifugo";
import { startIsolatedBridge, type IsolatedBridge } from "./ledger-bridge";
import { approvePairLink, browserEndpointId, createAccountViaUi, readRunAccount, virtualAuthenticator, type RunAccount } from "./passkey";

/**
 * A REAL second account ("B"), unrelated to the shared account A: created through the real /login "Create an account"
 * form in its OWN browser context, with its OWN Chrome virtual authenticator (so its own passkey), its own first device
 * (that context's browser) and, on request, its own paired isolated bridge. Nothing is minted or shared with A: every
 * token B holds comes from B's own session or keys.
 *
 * Cleanup (`close`) stops only the bridge process this helper spawned (its recorded child PID, via IsolatedBridge.stop)
 * and that bridge's private tmux server, then closes the context. The account itself stays in the throwaway database.
 */

/** A bridge paired to B, with its published local API pointer. */
export interface PairedBridge {
  bridge: IsolatedBridge;
  bridgeId: string;
  pointer: BridgePointer;
  /** The bridge's ECDSA auth private key (JWK) from its ledger identity file. */
  authPrivateKey: JsonWebKey;
}

export interface SecondAccount {
  /** B's passkey (exported from B's virtual authenticator) in the shape the ledger-admin helpers take. */
  readonly account: RunAccount;
  readonly accountId: string;
  /** The "Account name" typed on /login (the passkey's WebAuthn user name). */
  readonly name: string;
  readonly context: BrowserContext;
  /** Signed in as B on /dashboard right after creation. */
  readonly page: Page;
  /** B's first device: this context's browser endpoint id. */
  readonly endpointId: string;
  /** Every websocket frame B's page received (Centrifugo and others), newest last, bounded. */
  readonly receivedFrames: string[];
  /** B's paired bridge, once pairBridge() ran. */
  readonly paired: PairedBridge | null;
  /** Start an isolated bridge and pair it to B through B's own /pair approval; waits for its pointer and relay presence. */
  pairBridge(): Promise<PairedBridge>;
  /** Create a shell session named `name` on B's paired bridge through B's dashboard; returns its session id. */
  createSession(name: string): Promise<string>;
  /** B's relay (Centrifugo) token from B's own session (POST /api/auth/token). */
  relayToken(): Promise<string>;
  /** Stop B's bridge (own PID only) and keep the context. Idempotent. */
  stopBridge(): Promise<void>;
  /** stopBridge() + close the context. Idempotent. */
  close(): Promise<void>;
}

const MAX_FRAMES = 5000;

interface LedgerIdentityFile { authPrivateKey: JsonWebKey }

export async function createSecondAccount(browser: Browser, options: { name?: string; passkeyLabel?: string; browserLabel?: string } = {}): Promise<SecondAccount> {
  const name = options.name ?? `E2E account B ${randomBytes(3).toString("hex")}`;
  const passkeyLabel = options.passkeyLabel ?? `${name} passkey`;
  const browserLabel = options.browserLabel ?? `${name} browser`;
  const context = await browser.newContext();
  const receivedFrames: string[] = [];
  let paired: PairedBridge | null = null;
  let closed = false;
  try {
    const page = await context.newPage();
    page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
      receivedFrames.push(typeof payload === "string" ? payload : payload.toString("utf8"));
      if (receivedFrames.length > MAX_FRAMES) receivedFrames.splice(0, receivedFrames.length - MAX_FRAMES);
    }));
    const accountId = await createAccountViaUi(page, { accountName: name, passkey: passkeyLabel, browser: browserLabel });
    if (accountId === readRunAccount().accountId) throw new Error("the second account must not be the shared account A");
    const credentials = await (await virtualAuthenticator(page)).credentials();
    if (credentials.length !== 1 || !credentials[0].isResidentCredential) throw new Error("expected exactly B's own resident passkey in B's authenticator");
    const account: RunAccount = { accountId, origin: UI_BASE_URL, credential: credentials[0] };
    const endpointId = await browserEndpointId(page, accountId);

    const stopBridge = async (): Promise<void> => {
      const current = paired;
      paired = null;
      if (current) await current.bridge.stop();
    };
    const self: SecondAccount = {
      account, accountId, name, context, page, endpointId, receivedFrames,
      get paired() { return paired; },
      async pairBridge() {
        if (paired) return paired;
        const bridge = await startIsolatedBridge();
        try {
          const prompt = await bridge.pairing({ timeoutMs: 40_000 });
          expect(new URL(prompt.link).origin).toBe(new URL(UI_BASE_URL).origin);
          await approvePairLink(page, prompt.link, prompt.code, account);
          await expect.poll(() => bridge.output(), { timeout: 30_000 }).toContain(`Paired with account ${accountId.slice(0, 8)}`);
          // "Paired with account" precedes the account startup after which the bridge writes its local API pointer.
          let pointer: BridgePointer | null = null;
          await expect.poll(() => {
            try { pointer = tryReadBridgePointer(bridge.home); } catch { pointer = null; }
            return pointer !== null;
          }, { timeout: 30_000 }).toBe(true);
          const published = pointer as BridgePointer | null;
          if (!published) throw new Error("B's bridge published no pointer");
          const bridgeId = bridge.bridgeIdFile();
          if (!bridgeId || bridgeId !== published.bridgeId) throw new Error("B's bridge id does not match its pointer");
          await waitForBridgePresence(accountId, { min: 1, timeoutMs: 40_000 });
          const identity = JSON.parse(readFileSync(join(bridge.dataDir, "security", "ledger-identity.json"), "utf8")) as LedgerIdentityFile;
          paired = { bridge, bridgeId, pointer: published, authPrivateKey: identity.authPrivateKey };
          return paired;
        } catch (error) {
          await bridge.stop().catch(() => {});
          throw error;
        }
      },
      async createSession(sessionName) {
        if (!paired) throw new Error("pair B's bridge first");
        const bridgeId = paired.bridgeId;
        await page.goto("/dashboard");
        await waitForBridgeOnline(page);
        const before = await sessionIdsFor(accountId);
        // The computer was just paired: its first encrypted requests from this browser may be refused for a few seconds.
        await createShellSessionWhenAccepted(page, sessionName, bridgeId);
        return waitForNewSessionId(accountId, before);
      },
      relayToken: () => getCentrifugoToken(page),
      stopBridge,
      async close() {
        if (closed) return;
        closed = true;
        try { await stopBridge(); } finally { await context.close(); }
      },
    };
    return self;
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}
