import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { E2E_DIR } from "./config";
import { bridgeApiFetch, readBridgePointer } from "./bridge-api";
import type { PendingBridgeStatus } from "../../bridge/src/security/pending-approval-protocol";

const execute = promisify(execFile);
export interface AccountTestBridge { home: string; dataDir: string; child: ChildProcess; link(): Promise<string>; pendingStatus(): Promise<PendingBridgeStatus>; confirmPending(code: string): Promise<void>; rejectPending(): Promise<void>; stop(): Promise<void> }
/** Authored fixture; only the root's coordinated Playwright run executes processes. */
export async function startAccountTestBridge(origin: string, accountHint?: string): Promise<AccountTestBridge> {
  const home = await mkdtemp(join(E2E_DIR, ".account-bridge-"));
  const dataDir = join(home, ".ftown", "data");
  const environment = { ...process.env, HOME: home, USERPROFILE: home, FTOWN_DATA_DIR: dataDir };
  try {
    // Match the isolated service harness: no system compinit ownership prompt or
    // zsh-newuser-install wizard may consume the terminal's first input.
    await writeFile(join(home, ".zshenv"), "skip_global_compinit=1\n", { mode: 0o600 });
    await writeFile(join(home, ".zshrc"), "autoload -Uz compinit\ncompinit -u\n", { mode: 0o600 });
    await execute(process.execPath, [join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js"), "setup"],
      { cwd: home, env: environment, timeout: 20000, maxBuffer: 65536 });
  } catch {
    await rm(home, { recursive: true, force: true });
    throw new Error("Test-owned virgin bridge shell setup failed");
  }
  const child = spawn(process.execPath, [join(E2E_DIR, "..", "bridge", "dist", "index.js"), "--api-url", origin, "--data-dir", dataDir, ...(accountHint ? ["--account", accountHint] : ["--bootstrap"])], {
    cwd: home, env: environment, stdio: "ignore",
  });
  let exited = false; child.once("exit", () => { exited = true; }); child.once("error", () => { exited = true; });
  const stopped = () => exited || child.exitCode !== null || child.signalCode !== null;
  async function waitExit(timeout: number) {
    const deadline = Date.now() + timeout;
    while (!stopped() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    return stopped();
  }
  return { home, dataDir, child,
    async pendingStatus() {
      const { stdout } = await execute(process.execPath, [join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js"), "security", "--data-dir", dataDir, "pair-status"],
        { cwd: home, env: environment, timeout: 5000, maxBuffer: 32768 });
      return JSON.parse(stdout) as PendingBridgeStatus;
    },
    async confirmPending(code: string) {
      if (!/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(code)) throw new Error("Invalid local verification code");
      try { await execute(process.execPath, [join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js"), "security", "--data-dir", dataDir, "pair-confirm", code],
        { cwd: home, env: environment, timeout: 5000, maxBuffer: 32768 }); } catch { throw new Error("Local test computer confirmation failed"); }
    },
    async rejectPending() {
      try { await execute(process.execPath, [join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js"), "security", "--data-dir", dataDir, "pair-reject"],
        { cwd: home, env: environment, timeout: 5000, maxBuffer: 32768 }); } catch { throw new Error("Local test computer rejection failed"); }
    },
    async link() {
      const deadline = Date.now() + 30000;
      do {
        if (stopped()) throw new Error("Test-owned virgin bridge exited before enrollment");
        try {
          const { stdout } = await execute(process.execPath, [join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js"), "security", "--data-dir", dataDir, "pair-link"],
            { cwd: home, env: environment, timeout: 5000, maxBuffer: 32768 });
          const url = new URL(stdout.trim());
          if (url.origin === new URL(origin).origin && url.pathname === "/pair" && url.searchParams.has("code") && url.hash.startsWith("#account=")) return url.href;
        } catch { /* Pending bridge state is written asynchronously; never expose CLI output. */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      throw new Error("Test-owned virgin bridge did not expose its explicit local pairing link");
    },
    async stop() {
      const failures: string[] = [];
      if (!stopped()) {
        try {
          const sessions = await bridgeApiFetch("GET", "/api/sessions", { bridgeHome: home });
          const body = sessions.body as { sessions?: { id: string }[] };
          for (const session of body.sessions ?? []) await bridgeApiFetch("DELETE", `/api/sessions/${session.id}`, { bridgeHome: home });
        } catch { /* It may still be awaiting first approval and have no pointer. */ }
        child.kill("SIGTERM");
        if (!await waitExit(8000)) { child.kill("SIGKILL"); if (!await waitExit(3000)) failures.push("bridge-exit"); }
      }
      if (!failures.length) await rm(home, { recursive: true, force: true });
      if (failures.length) throw new Error("Test-owned account bridge cleanup failed");
    },
  };
}

export async function usePrivateApprovalLink(page: Page): Promise<void> {
  await page.getByText("First device or another way to connect?", { exact: true }).click();
  await page.getByRole("button", { name: "Use a private approval link", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Approve this device", exact: true })).toBeVisible();
}

/** Only public request coordinates, never candidate credentials or retained keys. */
export async function pendingBrowserRequest(page: Page): Promise<{ requestId: string | null; candidateId: string } | null> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ftown-endpoint-security"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Pending browser storage unavailable")); });
    try { if (!db.objectStoreNames.contains("pending-candidates")) return null;
      const records = await new Promise<{ candidateId: string; request: { requestId: string } | null }[]>((resolve, reject) => { const request = db.transaction("pending-candidates").objectStore("pending-candidates").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Pending browser storage unavailable")); });
      return records.length === 1 ? { requestId: records[0].request?.requestId ?? null, candidateId: records[0].candidateId } : null;
    } finally { db.close(); }
  });
}

export async function approveAccountComputer(page: Page, bridge: AccountTestBridge): Promise<string> {
  const link = await bridge.link();
  try { await page.goto(link); } catch { throw new Error("Private account computer pairing navigation failed"); }
  await expect(page).toHaveURL(/\/pair\?code=[A-Z0-9-]+$/);
  const confirm = page.getByRole("button", { name: "Codes match — connect computer", exact: true });
  await expect(confirm).toBeEnabled({ timeout: 30000 }); await confirm.click();
  await page.waitForURL("**/dashboard", { timeout: 30000 });
  await expect.poll(() => { try { return readBridgePointer(bridge.home).bridgeId; } catch { return ""; } }, { timeout: 30000 }).not.toBe("");
  const bridgeId = readBridgePointer(bridge.home).bridgeId;
  await expect(page.locator(`[data-bridge-row="${bridgeId}"]`)).toBeVisible({ timeout: 45000 });
  return bridgeId;
}

export async function createAccountShell(page: Page, bridgeId: string, name: string): Promise<void> {
  await page.getByRole("button", { name: "Create a new session", exact: true }).click();
  await page.locator("#ns-shell-type").selectOption("shell"); await page.locator("#ns-bridge").selectOption(bridgeId);
  await page.getByPlaceholder("Optional name for this session").fill(name);
  await page.getByRole("button", { name: "Create Session", exact: true }).click();
  const workspace = page.getByRole("tab", { name: "Workspace", exact: true });
  if (await workspace.isVisible()) await workspace.click();
  await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible({ timeout: 30000 });
}

/** Read public IDs and actual native key flags, never extract a private key. */
export async function accountBrowserState(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ftown-endpoint-security"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Browser identity unavailable"));
    });
    const all = <T,>(store: string) => new Promise<T[]>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result as T[]); request.onerror = () => reject(new Error("Browser identity unavailable"));
    });
    try {
      const [identities, signing, trusts] = await Promise.all([
        all<{ endpoint: { id: string; ownerId: string }; keyPair: CryptoKeyPair }>("identities"),
        all<{ ownerId: string; identity: { keyPair: CryptoKeyPair } }>("account-signing"),
        all<{ ownerId: string; trust: { checkpoint: { head: string; revision: number; devices: { endpoint: { id: string } }[]; bridges: { bridgeId: string }[] }; lastServerReadAt: number; lastObservedAt: number } }>("account-trust"),
      ]);
      return identities.map(identity => ({ endpointId: identity.endpoint.id, ownerId: identity.endpoint.ownerId,
        hpkeExtractable: identity.keyPair.privateKey.extractable, signingExtractable: signing.find(key => key.ownerId === identity.endpoint.ownerId)?.identity.keyPair.privateKey.extractable,
        trust: trusts.find(record => record.ownerId === identity.endpoint.ownerId)?.trust ?? null }));
    } finally { db.close(); }
  });
}
