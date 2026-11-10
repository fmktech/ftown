import { spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { E2E_DIR, BRIDGE_HOME, UI_BASE_URL } from "./config";
import { sharedAccountId } from "./passkey";
import { waitForBridgePresence } from "./centrifugo";
import { readBridgePointer } from "./bridge-api";
import { isolatedBridgeEnv } from "./ledger-bridge";

/**
 * Stop and restart the shared e2e bridge for resurrection tests.
 * start-services.sh launches it with its absolute dist/index.js entrypoint,
 * HOME/data dir overridden to e2e/.bridge-home and a private tmux socket dir
 * (recorded in e2e/.bridge.tmux), recording its PID in e2e/.bridge.pid. This
 * helper kills that exact PID and relaunches an identical process against the
 * SAME scratch HOME, data dir and tmux dir, so the new bridge resumes its
 * persisted ledger identity (already paired: no link, no passkey) and
 * resurrects its live sessions. The new PID is written back to e2e/.bridge.pid
 * so stop-services.sh still tears down the right process, and the helper waits
 * until the bridge is present on bridges:presence#<accountId>.
 */

export interface RestartBridgeOptions {
  /** e2e dir holding .bridge.pid + .bridge.tmux. Default: this helper's e2e dir. */
  e2eDir?: string;
  /** Scratch HOME for the bridge. Default: e2e/.bridge-home. */
  bridgeHome?: string;
  /** --api-url. Default: the run's public origin. */
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

/**
 * Poll until $bridgeHome/.ftown/bridge.json advertises the NEW bridge's pid.
 * On SIGTERM the old bridge unlinks bridge.json while its Centrifugo presence
 * lingers for the presence TTL, so presence alone could return on the stale
 * entry; gating on pid === expectedPid reads the new bridge's advert.
 */
async function waitForBridgePointer(bridgeHome: string, expectedPid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (readBridgePointer(bridgeHome).pid === expectedPid) return;
    } catch {
      // absent or mid-write — keep polling until the new bridge lands its pointer
    }
    if (Date.now() >= deadline) {
      throw new Error(`new bridge (pid ${expectedPid}) never wrote a readable bridge.json under ${bridgeHome} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Stop the recorded shared bridge, start a fresh one on the same HOME, return the new PID. */
export async function restartBridge(options: RestartBridgeOptions = {}): Promise<number> {
  const e2eDir = options.e2eDir ?? E2E_DIR;
  const bridgeHome = options.bridgeHome ?? BRIDGE_HOME;
  const apiUrl = options.apiUrl ?? UI_BASE_URL;
  const repoDir = resolve(e2eDir, "..");
  const pidPath = join(e2eDir, ".bridge.pid");
  const tmuxDir = readFileSync(join(e2eDir, ".bridge.tmux"), "utf8").trim();

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

  const logFd = openSync(join(e2eDir, "bridge.log"), "a");
  const child = spawn("node", [join(repoDir, "bridge/dist/index.js"), "--api-url", apiUrl], {
    cwd: bridgeHome,
    env: isolatedBridgeEnv(bridgeHome, tmuxDir),
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();
  if (typeof child.pid !== "number") throw new Error("failed to spawn bridge process (no pid)");
  writeFileSync(pidPath, `${child.pid}\n`);

  await waitForBridgePointer(bridgeHome, child.pid, 30_000);
  await waitForBridgePresence(sharedAccountId(), { min: 1, timeoutMs: options.presenceTimeoutMs ?? 40_000 });
  return child.pid;
}
