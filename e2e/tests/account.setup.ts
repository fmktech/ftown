import { expect, test as setup } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_HOME, UI_BASE_URL } from "../helpers/config";
import { waitForBridgePresence } from "../helpers/centrifugo";
import { tryReadBridgePointer } from "../helpers/bridge-api";
import { parsePairingOutput, readSharedBridgeLog } from "../helpers/ledger-bridge";
import {
  RUN_ACCOUNT_FILE, approvePairLink, createAccountViaUi, readRunAccount, signIn, virtualAuthenticator, writeRunAccount,
  type RunAccount,
} from "../helpers/passkey";

const SECOND_BRIDGE_HOME = process.env.E2E_SECOND_BRIDGE_HOME ?? join(BRIDGE_HOME, "..", ".bridge-home-2");

/** An account that this run already created and the server still holds (re-running Playwright against one stack). */
async function existingAccount(): Promise<RunAccount | null> {
  if (!existsSync(RUN_ACCOUNT_FILE)) return null;
  const account = readRunAccount();
  const response = await fetch(`${UI_BASE_URL}/api/account/ledger?accountId=${account.accountId}`, { headers: { "x-real-ip": "2001:db8::5e7" } });
  if (response.status === 404) throw new Error("e2e/.run-account.json names an account the server does not hold: reset the database (scripts/setup-db.mjs --reset) and restart services");
  if (!response.ok) throw new Error(`ledger read failed: ${response.status}`);
  return account;
}

function paired(home: string): boolean {
  return existsSync(join(home, ".ftown", "data", "security", "ledger.json"));
}

/**
 * The suite's shared account A (the default of every spec), created through the
 * real /login "Create an account" form with a virtual-authenticator passkey and
 * no secret, and both shared bridges paired to it through the real /pair page
 * with the 6-digit code each printed. Idempotent. Specs that need another,
 * unrelated account create their own (helpers/second-account.ts).
 */
setup("account created with a passkey and both shared bridges paired", async ({ page }) => {
  setup.setTimeout(240_000);
  let account = await existingAccount();
  const unpaired = ([["bridge", BRIDGE_HOME], ["bridge-2", SECOND_BRIDGE_HOME]] as const).filter(([, home]) => !paired(home));
  if (account && unpaired.length === 0) {
    await waitForBridgePresence(account.accountId, { min: 2, timeoutMs: 60_000 });
    return;
  }
  if (!account) {
    const accountId = await createAccountViaUi(page, { accountName: "E2E account A", passkey: "E2E passkey", browser: "E2E setup browser" });
    const credentials = await (await virtualAuthenticator(page)).credentials();
    expect(credentials).toHaveLength(1);
    expect(credentials[0].isResidentCredential).toBe(true);
    account = { accountId, origin: UI_BASE_URL, credential: credentials[0] };
    writeRunAccount(account);
  } else {
    await signIn(page, { browserLabel: "E2E setup browser (rerun)" });
  }

  for (const [name] of unpaired) {
    const prompt = parsePairingOutput(readSharedBridgeLog(name));
    if (!prompt) throw new Error(`${name}: no pairing link in e2e/${name}.log (start services first)`);
    expect(new URL(prompt.link).origin).toBe(new URL(UI_BASE_URL).origin);
    await approvePairLink(page, prompt.link, prompt.code);
  }

  await waitForBridgePresence(account.accountId, { min: 2, timeoutMs: 60_000 });
  await expect.poll(() => {
    try { return tryReadBridgePointer(BRIDGE_HOME) !== null && tryReadBridgePointer(SECOND_BRIDGE_HOME) !== null; } catch { return false; }
  }, { timeout: 30_000 }).toBe(true);
});
