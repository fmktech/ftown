import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { E2E_DIR } from "./config";
import type { AccountTestBridge } from "./account-pairing";
import type { PendingBridgeStatus } from "../../bridge/src/security/pending-approval-protocol";

const execute = promisify(execFile);
const BRIDGE_DIST = join(E2E_DIR, "..", "bridge", "dist");
const CLI = join(BRIDGE_DIST, "ftown-cli.js");
const MAX_OUTPUT = 4 * 1024 * 1024;

/** An account bridge whose output, identity files and tmux server the test can observe across its own re-exec. */
export interface RevocableAccountBridge extends AccountTestBridge {
  /** Everything the spawned process wrote to stdout and stderr; a re-exec keeps the same pipes. */
  output(): string;
  /** Trimmed <dataDir>/bridge-id, or null when the file is absent. */
  bridgeIdFile(): string | null;
  /** Trimmed <dataDir>/refresh-token, or null when the file is absent. */
  refreshTokenFile(): string | null;
  /** True while the spawned PID is running; a re-exec replaces the image but keeps the PID. */
  running(): boolean;
  /** Whether this bridge's private tmux server still holds the session. */
  hasTmuxSession(sessionId: string): Promise<boolean>;
}

function readTrimmed(path: string): string | null {
  try { return readFileSync(path, "utf8").trim() || null; } catch { return null; }
}

/**
 * Like startAccountTestBridge, but with captured output and a private tmux socket directory.
 * Inherited FTOWN_* and tmux variables are dropped: they could name another bridge instance,
 * session or tmux server on the machine running the suite.
 */
export async function startRevocableAccountBridge(origin: string): Promise<RevocableAccountBridge> {
  const home = await mkdtemp(join(E2E_DIR, ".account-bridge-"));
  // Kept short: tmux places its socket at <dir>/tmux-<uid>/ftown, and socket paths are length-limited.
  const tmuxDir = await mkdtemp(join(tmpdir(), "ftrv-"));
  const dataDir = join(home, ".ftown", "data");
  const inherited: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("FTOWN_") || key === "TMUX" || key === "TMUX_PANE" || key === "TMUX_TMPDIR") continue;
    inherited[key] = value;
  }
  const environment: NodeJS.ProcessEnv = { ...inherited, HOME: home, USERPROFILE: home, FTOWN_DATA_DIR: dataDir, TMUX_TMPDIR: tmuxDir };
  const removeScratch = async () => {
    await rm(home, { recursive: true, force: true });
    await rm(tmuxDir, { recursive: true, force: true });
  };
  try {
    await writeFile(join(home, ".zshenv"), "skip_global_compinit=1\n", { mode: 0o600 });
    await writeFile(join(home, ".zshrc"), "autoload -Uz compinit\ncompinit -u\n", { mode: 0o600 });
    await execute(process.execPath, [CLI, "setup"], { cwd: home, env: environment, timeout: 20000, maxBuffer: 65536 });
  } catch {
    await removeScratch();
    throw new Error("Test-owned revocable bridge shell setup failed");
  }
  const child = spawn(process.execPath, [join(BRIDGE_DIST, "index.js"), "--api-url", origin, "--data-dir", dataDir, "--bootstrap"], {
    cwd: home, env: environment, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  let exited = false; child.once("exit", () => { exited = true; }); child.once("error", () => { exited = true; });
  const stopped = () => exited || child.exitCode !== null || child.signalCode !== null;
  async function waitExit(timeout: number) {
    const deadline = Date.now() + timeout;
    while (!stopped() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    return stopped();
  }
  const cli = (args: string[], timeout = 5000) => execute(process.execPath, [CLI, "security", "--data-dir", dataDir, ...args],
    { cwd: home, env: environment, timeout, maxBuffer: 32768 });
  const tmux = (args: string[]) => execute("tmux", ["-L", "ftown", ...args], { env: environment, timeout: 5000, maxBuffer: 32768 });

  return { home, dataDir, child,
    output: () => output,
    bridgeIdFile: () => readTrimmed(join(dataDir, "bridge-id")),
    refreshTokenFile: () => readTrimmed(join(dataDir, "refresh-token")),
    running: () => !stopped(),
    async hasTmuxSession(sessionId: string) {
      try { await tmux(["has-session", "-t", `=ftown-${sessionId}`]); return true; } catch { return false; }
    },
    async pendingStatus() {
      const { stdout } = await cli(["pair-status"]);
      return JSON.parse(stdout) as PendingBridgeStatus;
    },
    async confirmPending(code: string) {
      if (!/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(code)) throw new Error("Invalid local verification code");
      try { await cli(["pair-confirm", code]); } catch { throw new Error("Local test computer confirmation failed"); }
    },
    async rejectPending() {
      try { await cli(["pair-reject"]); } catch { throw new Error("Local test computer rejection failed"); }
    },
    async link() {
      const deadline = Date.now() + 30000;
      do {
        if (stopped()) throw new Error("Test-owned revocable bridge exited before enrollment");
        try {
          const { stdout } = await cli(["pair-link"]);
          const url = new URL(stdout.trim());
          if (url.origin === new URL(origin).origin && url.pathname === "/pair" && url.searchParams.has("code") && url.hash.startsWith("#account=")) return url.href;
        } catch { /* Pairing state is written asynchronously; never expose CLI output. */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      throw new Error("Test-owned revocable bridge did not expose its explicit local pairing link");
    },
    async stop() {
      const failures: string[] = [];
      if (!stopped()) {
        child.kill("SIGTERM");
        if (!await waitExit(8000)) { child.kill("SIGKILL"); if (!await waitExit(3000)) failures.push("bridge-exit"); }
      }
      // The bridge keeps tmux sessions alive by design. This server is reachable only through this test's private socket directory.
      try { await tmux(["kill-server"]); } catch { /* No session was ever started. */ }
      if (!failures.length) await removeScratch();
      if (failures.length) throw new Error("Test-owned revocable bridge cleanup failed");
    },
  };
}

/** The bridgeId named by a fragment pairing link's encrypted enrollment request, or null when it does not decode. */
export function enrollmentLinkBridgeId(link: string): string | null {
  try {
    const hash = new URL(link).hash;
    if (!hash.startsWith("#account=")) return null;
    const decoded = JSON.parse(Buffer.from(hash.slice("#account=".length), "base64url").toString("utf8")) as { request?: { kind?: unknown; bridgeId?: unknown } };
    return decoded.request?.kind === "bridge" && typeof decoded.request.bridgeId === "string" ? decoded.request.bridgeId : null;
  } catch { return null; }
}

/** The browser's stored, verified account roster: member and tombstoned bridgeIds. Null when it holds no account trust. */
export async function browserAccountRoster(page: Page): Promise<{ bridges: string[]; revokedBridgeIds: string[] } | null> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ftown-endpoint-security"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Browser account trust unavailable"));
    });
    try {
      if (!db.objectStoreNames.contains("account-trust")) return null;
      const records = await new Promise<{ trust?: { checkpoint?: { bridges?: { bridgeId: string }[]; revokedBridgeIds?: string[] } } }[]>((resolve, reject) => {
        const request = db.transaction("account-trust").objectStore("account-trust").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Browser account trust unavailable"));
      });
      const checkpoint = records.length === 1 ? records[0].trust?.checkpoint : undefined;
      return checkpoint ? { bridges: (checkpoint.bridges ?? []).map(bridge => bridge.bridgeId), revokedBridgeIds: checkpoint.revokedBridgeIds ?? [] } : null;
    } finally { db.close(); }
  });
}
