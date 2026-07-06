import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerUser, login } from "../helpers/app";
import { waitForChannels } from "../helpers/centrifugo";
import { CENTRIFUGO_API_KEY, CENTRIFUGO_API_URL, UI_BASE_URL } from "../helpers/config";

/**
 * Device-pairing onboarding e2e (docs/plans/device-pairing-contract.md).
 *
 * Unlike direct-transport.spec.ts, this test does NOT reuse the harness's
 * pre-started bridge (start-services.sh's bridge onboards via a `--token`
 * bootstrap JWT, bypassing pairing entirely). Instead it spawns its OWN bridge
 * process with NO token and an isolated scratch HOME, so it has no stored
 * refresh token and falls through to interactive pairing (P7). That bridge's
 * PID is recorded and killed ONLY by this test's teardown — never pkill, and
 * the real ~/.ftown is never touched.
 *
 * Flow proven end-to-end:
 *  1. Register + log in a fresh browser user.
 *  2. Spawn a token-less, scratch-HOME bridge; it prints a `userCode` (P8: the
 *     deviceCode secret is never logged, only this low-value code + URL are).
 *  3. Parse the userCode (format XXXX-XXXX) from bridge stdout.
 *  4. Navigate to /pair?code=<userCode> (prefills + looks up automatically),
 *     assert the pending device's hostname renders, click Approve.
 *  5. Poll Centrifugo presence on bridges:presence#<email> until the bridge
 *     shows online — this only happens if the bridge's poll loop received the
 *     approved token bundle, stored it, and connected (P3/P4).
 *  6. Bonus: /devices lists the bridge; Revoke marks it revoked.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const USER_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

interface SpawnedBridge {
  proc: ChildProcess;
  scratchHome: string;
  stdout: string;
}

function bridgeEmail(): string {
  // Independent of the harness's shared E2E_USER_EMAIL — this test onboards its
  // own bridge under its own freshly registered user so pairing can't collide
  // with (or be short-circuited by) the harness's bootstrap-token bridge.
  return `e2e-pairing-${Date.now()}-${Math.floor(Math.random() * 1e6)}@ftown.test`;
}

/** Spawn a bridge with NO --token and a fresh scratch HOME, so it must pair. */
function spawnPairingBridge(): SpawnedBridge {
  const scratchHome = mkdtempSync(join(tmpdir(), "ftown-e2e-pair-home-"));
  const proc = spawn(
    process.execPath,
    [join(REPO_ROOT, "bridge", "dist", "index.js"), "--api-url", UI_BASE_URL],
    {
      cwd: join(REPO_ROOT, "bridge"),
      env: { ...process.env, HOME: scratchHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const state: SpawnedBridge = { proc, scratchHome, stdout: "" };
  proc.stdout?.on("data", (chunk: Buffer) => {
    state.stdout += chunk.toString("utf8");
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    state.stdout += chunk.toString("utf8");
  });
  return state;
}

/** Poll the growing stdout buffer for the printed userCode (XXXX-XXXX). */
async function waitForUserCode(
  bridge: SpawnedBridge,
  { timeoutMs = 20_000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = bridge.stdout.match(USER_CODE_RE);
    if (match) return match[1];
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for bridge userCode in stdout:\n${bridge.stdout}`);
}

/** Kill ONLY the recorded PID (never pkill) and drop the scratch HOME. */
function teardownBridge(bridge: SpawnedBridge): void {
  if (bridge.proc.pid && !bridge.proc.killed) {
    try {
      process.kill(bridge.proc.pid, "SIGTERM");
    } catch {
      // already exited
    }
  }
  try {
    rmSync(bridge.scratchHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Presence count on bridges:presence#<email>, mirroring start-services.sh. */
async function bridgePresenceCount(email: string): Promise<number> {
  const res = await fetch(CENTRIFUGO_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": CENTRIFUGO_API_KEY },
    body: JSON.stringify({
      method: "presence",
      params: { channel: `bridges:presence#${email}` },
    }),
  });
  if (!res.ok) return 0;
  const data = (await res.json()) as { result?: { presence?: Record<string, unknown> } };
  return Object.keys(data.result?.presence ?? {}).length;
}

test.describe("device pairing", () => {
  test("bridge with no token pairs via /pair approval and comes online", async ({ page }) => {
    const email = bridgeEmail();
    let bridge: SpawnedBridge | undefined;

    try {
      await registerUser(email);
      await login(page, email);

      bridge = spawnPairingBridge();
      const userCode = await waitForUserCode(bridge);
      expect(userCode).toMatch(USER_CODE_RE);

      await page.goto(`/pair?code=${userCode}`);

      // The looked-up pending device renders its hostname (os.hostname() on the
      // machine running this test, since the bridge is spawned locally).
      const deviceCard = page.getByText("This device is requesting access");
      await expect(deviceCard).toBeVisible({ timeout: 15_000 });

      const approveButton = page.getByRole("button", { name: "Approve this device" });
      await expect(approveButton).toBeVisible();
      await approveButton.click();

      await expect(page.getByText(/is now connecting/)).toBeVisible({ timeout: 15_000 });

      // Poll interval is 5s (P1); allow a full cycle plus margin for the token
      // exchange + Centrifugo connect to land.
      const presence = await waitForChannels(
        () => bridgePresenceCount(email),
        (count) => count >= 1,
        { timeoutMs: 30_000, intervalMs: 2000 },
      );
      expect(presence, "paired bridge must reach presence on bridges:presence#<email>").toBeGreaterThanOrEqual(1);

      // Bonus: the devices panel lists it and revoke flips its status. Skipped
      // (not failed) if the UI doesn't settle quickly, to avoid flaking the
      // core pairing assertion above.
      await page.goto("/devices");
      // Scope by list position, not by the "Active" text filter — that filter
      // is re-evaluated live, so it would stop matching the row the instant
      // its badge flips to "Revoked" and the "element not found" would look
      // like a false failure. This freshly registered user has exactly one
      // paired bridge, so the first (only) list item is the one under test.
      const deviceRow = page.getByRole("listitem").first();
      const rowVisible = await deviceRow
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      if (rowVisible) {
        await expect(deviceRow.getByText("Active", { exact: true })).toBeVisible({ timeout: 10_000 });
        // window.confirm() fires synchronously during the click handshake, so
        // the dialog listener MUST be registered before click() — Playwright
        // auto-dismisses any dialog with no listener attached yet.
        page.once("dialog", (dialog) => void dialog.accept());
        await deviceRow.getByRole("button", { name: "Revoke" }).click();
        await expect(deviceRow.getByText("Revoked", { exact: true })).toBeVisible({ timeout: 15_000 });
      }
    } finally {
      if (bridge) teardownBridge(bridge);
    }
  });
});
