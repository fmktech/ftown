import { expect, test, type Page } from "@playwright/test";
import { UI_BASE_URL } from "./config";
import { readBridgePointer } from "./bridge-api";
import { sharedAccountId, signIn } from "./passkey";

export { sharedAccountId };

/**
 * Sign `page` in to the shared account A with its synced passkey and land on
 * /dashboard. A fresh browser context enrols itself (passkey identify + "Add
 * this browser"); a context that already enrolled signs in with its device key.
 */
export async function login(page: Page, options: { browserLabel?: string } = {}): Promise<void> {
  await signIn(page, options);
}

/**
 * Fetch the relay (Centrifugo) token for whoever `page` is signed in as, from
 * POST /api/auth/token: HS256, aud "ftown:centrifugo", sub = accountId, 1 h —
 * the token the browser connects with. Uses the page context's session cookie.
 * Throws on non-2xx (e.g. 401 when the page is not signed in).
 */
export async function getCentrifugoToken(page: Page): Promise<string> {
  const res = await page.request.post(`${UI_BASE_URL}/api/auth/token`);
  if (!res.ok()) {
    throw new Error(`/api/auth/token failed: ${res.status()} ${await res.text()}`);
  }
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error("/api/auth/token returned no token");
  return json.token;
}

/**
 * Wait until at least one bridge is online. The "create session" button is
 * `disabled={!hasBridges}`, so its becoming enabled is the authoritative signal.
 */
export async function waitForBridgeOnline(page: Page): Promise<void> {
  const createBtn = page.getByRole("button", { name: "Create a new session", exact: true });
  await expect(createBtn).toBeEnabled({ timeout: 30_000 });
}

/**
 * Open the New Session modal, choose a plain zsh shell (so no claude binary / API
 * key is needed) on `bridgeId` (default: the shared bridge e2e/.bridge-home), name it, and submit.
 */
export async function createShellSession(page: Page, name: string, bridgeId: string = readBridgePointer().bridgeId): Promise<void> {
  await page.getByRole("button", { name: "Create a new session", exact: true }).click();
  await expect(page.getByText("New Session", { exact: true })).toBeVisible();
  await page.locator("#ns-shell-type").selectOption("shell");
  await page.locator("#ns-bridge").selectOption(bridgeId);
  await page.locator('input[placeholder="Optional name for this session"]').fill(name);
  await page.getByRole("button", { name: "Create Session" }).click();
}

/**
 * createShellSession for a browser that was JUST enrolled or a computer that was JUST paired: for a few seconds the
 * computer refuses that browser's encrypted requests ("Encrypted request rejected") until it has the new ledger. That is a
 * product race (reported), not what the caller tests, so this retries the precondition, bounded, and records every
 * refusal as a test annotation ("create_session refused while the computer catches up") so it stays visible.
 */
export async function createShellSessionWhenAccepted(page: Page, name: string, bridgeId: string = readBridgePointer().bridgeId): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (let refusals = 0; ; refusals += 1) {
    await createShellSession(page, name, bridgeId);
    const created = page.getByRole("button", { name: new RegExp(name) });
    const rejected = page.getByText("Encrypted request rejected", { exact: true });
    const outcome = await Promise.race([
      created.waitFor({ timeout: 15_000 }).then(() => "created" as const),
      rejected.waitFor({ timeout: 15_000 }).then(() => "rejected" as const),
    ]).catch(() => "timeout" as const);
    if (outcome === "created") return;
    if (outcome === "timeout" || Date.now() > deadline) throw new Error(`create_session was not accepted (${outcome} after ${refusals} refusal(s))`);
    try { test.info().annotations.push({ type: "create_session refused while the computer catches up", description: `${name} on ${bridgeId}` }); } catch { /* outside a test */ }
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForTimeout(2000);
  }
}

/** Select the session row by its displayed name in the sidebar. */
export async function openSession(page: Page, name: string): Promise<void> {
  const row = page.getByRole("button", { name: new RegExp(name) });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
}

/**
 * Focus the xterm terminal, type `echo <marker>`, and assert the marker shows up
 * in the rendered terminal output. xterm has NO local echo — the characters only
 * appear once the PTY echoes them back over the active transport, so any
 * appearance proves a working bidirectional data plane.
 */
export async function runMarkerInTerminal(page: Page, marker: string): Promise<void> {
  const term = page.locator(".xterm").first();
  await expect(term).toBeVisible({ timeout: 30_000 });
  // Wait for the shell prompt to render before typing. The prompt only appears
  // once the data plane is fully up (direct DataChannel opened, or the Centrifugo
  // fallback subscribed after the 4s pair timeout) and the PTY has spawned — so
  // this also guards against typing into a not-yet-attached terminal.
  const rows = page.locator(".xterm-rows").first();
  await expect(rows).toContainText(/[$%#>]/, { timeout: 30_000 });
  await term.click();
  await page.keyboard.type(`echo ${marker}`);
  await page.keyboard.press("Enter");
  await expect(rows).toContainText(marker, { timeout: 20_000 });
}
