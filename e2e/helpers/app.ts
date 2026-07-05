import { expect, type Page } from "@playwright/test";
import { UI_BASE_URL } from "./config";

const PASSWORD = "e2e-password-123";

/**
 * The run-scoped user email. The bridge's token `sub` and the dashboard user MUST
 * match, because bridge presence rides the user-limited channel
 * bridges:presence#<email>. The launcher generates it once and exports it here so
 * the bridge and both tests agree.
 */
export function sharedEmail(): string {
  const email = process.env.E2E_USER_EMAIL;
  if (!email) throw new Error("E2E_USER_EMAIL is not set (start-services must export it)");
  return email;
}

/**
 * Register via the same endpoint the app exposes. Idempotent: F4 made register
 * non-enumerating, so it returns a generic 200 for both new and existing
 * accounts — any 2xx is success.
 */
export async function registerUser(email: string): Promise<void> {
  const res = await fetch(`${UI_BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`register failed: ${res.status} ${body}`);
  }
}

/** Fill the /login credentials form and land on /dashboard. */
export async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
}

/**
 * Wait until at least one bridge is online. The "create session" button is
 * `disabled={!hasBridges}`, so its becoming enabled is the authoritative signal.
 */
export async function waitForBridgeOnline(page: Page): Promise<void> {
  const createBtn = page.locator('button[title="Create a new session"]');
  await expect(createBtn).toBeEnabled({ timeout: 30_000 });
}

/**
 * Open the New Session modal, choose a plain zsh shell (so no claude binary / API
 * key is needed), name it, and submit. Returns the session name.
 */
export async function createShellSession(page: Page, name: string): Promise<void> {
  await page.locator('button[title="Create a new session"]').click();
  await expect(page.getByText("New Session", { exact: true })).toBeVisible();
  await page.locator("#ns-shell-type").selectOption("shell");
  await page.locator('input[placeholder="Optional name for this session"]').fill(name);
  await page.getByRole("button", { name: "Create Session" }).click();
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
  // xterm has NO local echo — the marker only renders once the PTY echoes the
  // typed line and/or command output back over the active transport, proving a
  // working bidirectional data plane.
  await expect(rows).toContainText(marker, { timeout: 20_000 });
}
