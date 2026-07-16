import { spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { E2E_DIR, BRIDGE_HOME, UI_BASE_URL } from "./config";
import { mintBridgeBootstrapToken } from "./jwt";
import { sharedEmail } from "./app";
import { waitForBridgePresence } from "./centrifugo";

/**
 * Stop and restart the e2e bridge for resurrection tests. start-services.sh
 * launches the bridge as `node dist/index.js --token <jwt> --api-url <ui>` with
 * HOME overridden to e2e/.bridge-home, recording its PID in e2e/.bridge.pid.
 * This helper kills that exact PID and relaunches an identical process against
 * the SAME scratch HOME and data dir, so the new bridge resumes its persisted
 * identity + rotating refresh token and resurrects its live sessions.
 *
 * A fresh bootstrap --token is minted as a fallback, but the persisted refresh
 * token (in $HOME/.ftown/data) takes precedence on resume, so a plain restart
 * re-onboards without any dashboard interaction. The new PID is written back to
 * e2e/.bridge.pid so stop-services.sh still tears down the right process, and
 * the helper waits until the bridge is present on bridges:presence#<email>
 * before returning.
 */

export interface RestartBridgeOptions {
  /** e2e dir holding .bridge.pid + .run-email. Default: this helper's e2e dir. */
  e2eDir?: string;
  /** Scratch HOME for the bridge. Default: e2e/.bridge-home. */
  bridgeHome?: string;
  /** UI API url passed as --api-url. Default: UI_BASE_URL. */
  apiUrl?: string;
  /** Max ms to wait for the new bridge to reappear online. Default 40s. */
  presenceTimeoutMs?: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`bridge pid ${pid} did not exit within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Stop the recorded bridge, start a fresh one on the same HOME, return new PID. */
export async function restartBridge(options: RestartBridgeOptions = {}): Promise<number> {
  const e2eDir = options.e2eDir ?? E2E_DIR;
  const bridgeHome = options.bridgeHome ?? BRIDGE_HOME;
  const apiUrl = options.apiUrl ?? UI_BASE_URL;
  const repoDir = join(e2eDir, "..");
  const pidPath = join(e2eDir, ".bridge.pid");

  // --- stop the currently recorded bridge ---
  let oldPid: number | undefined;
  try {
    oldPid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  } catch {
    oldPid = undefined;
  }
  if (oldPid && !Number.isNaN(oldPid) && isAlive(oldPid)) {
    process.kill(oldPid, "SIGTERM");
    try {
      await waitForExit(oldPid, 8000);
    } catch {
      if (isAlive(oldPid)) process.kill(oldPid, "SIGKILL");
      await waitForExit(oldPid, 4000);
    }
  }

  // --- start a fresh bridge against the SAME scratch HOME ---
  const email = sharedEmail();
  const token = mintBridgeBootstrapToken(email);
  const logFd = openSync(join(e2eDir, "bridge.log"), "a");

  const child = spawn(
    "node",
    ["dist/index.js", "--token", token, "--api-url", apiUrl],
    {
      cwd: join(repoDir, "bridge"),
      env: { ...process.env, HOME: bridgeHome },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    },
  );
  child.unref();

  if (typeof child.pid !== "number") {
    throw new Error("failed to spawn bridge process (no pid)");
  }
  writeFileSync(pidPath, `${child.pid}\n`);

  // --- wait until the new bridge is online again ---
  await waitForBridgePresence(email, { min: 1, timeoutMs: options.presenceTimeoutMs ?? 40_000 });
  return child.pid;
}
