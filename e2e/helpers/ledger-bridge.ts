import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { E2E_DIR, UI_BASE_URL } from "./config";

const execute = promisify(execFile);
const BRIDGE_DIST = join(E2E_DIR, "..", "bridge", "dist");
const CLI = join(BRIDGE_DIST, "ftown-cli.js");
const MAX_OUTPUT = 4 * 1024 * 1024;

/** What an unpaired bridge prints: the private /pair link and the 6-digit code the owner must TYPE on the page. */
export interface PairingPrompt {
  link: string;
  code: string;
}

/** The LAST pairing prompt in a bridge's output (a revoked re-exec prints a new one), or null. */
export function parsePairingOutput(output: string): PairingPrompt | null {
  const links = [...output.matchAll(/(https?:\/\/\S+\/pair#req=\S+)/g)];
  const codes = [...output.matchAll(/Type this code on the page to confirm it is this computer: (\d{6})/g)];
  if (!links.length || !codes.length) return null;
  const link = links[links.length - 1];
  const code = codes[codes.length - 1];
  // The code line follows its own link line.
  if ((code.index ?? 0) < (link.index ?? 0)) return null;
  return { link: link[1], code: code[1] };
}

/** Polls `read()` until it contains a pairing prompt that appears after `afterOffset` characters. */
export async function waitForPairingPrompt(read: () => string, options: { afterOffset?: number; timeoutMs?: number; alive?: () => boolean } = {}): Promise<PairingPrompt> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  for (;;) {
    const prompt = parsePairingOutput(read().slice(options.afterOffset ?? 0));
    if (prompt) return prompt;
    if (options.alive && !options.alive()) throw new Error("bridge exited before printing a pairing link");
    if (Date.now() >= deadline) throw new Error("bridge did not print a pairing link in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/** Log of a shared bridge started by scripts/start-services.sh. */
export function readSharedBridgeLog(name: "bridge" | "bridge-2"): string {
  try { return readFileSync(join(E2E_DIR, `${name}.log`), "utf8"); } catch { return ""; }
}

/** Environment for a test bridge: inherited FTOWN_* / tmux variables dropped (they could name the real bridge or tmux server). */
export function isolatedBridgeEnv(home: string, tmuxDir: string): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("FTOWN_") || key === "TMUX" || key === "TMUX_PANE" || key === "TMUX_TMPDIR") continue;
    inherited[key] = value;
  }
  return { ...inherited, HOME: home, USERPROFILE: home, FTOWN_DATA_DIR: join(home, ".ftown", "data"), TMUX_TMPDIR: tmuxDir };
}

/** The bridge's private tmux server, always by its explicit socket path (never the default socket). */
export function tmuxSocket(tmuxDir: string): string {
  if (!/^\/(private\/)?tmp\/ftpk-[A-Za-z0-9]{6}$/.test(tmuxDir)) throw new Error("unexpected test tmux dir");
  return join(tmuxDir, `tmux-${process.getuid?.() ?? 0}`, "ftown");
}

export interface IsolatedBridge {
  home: string;
  dataDir: string;
  tmuxDir: string;
  pid: number;
  /** Everything the process wrote to stdout/stderr; a revoked re-exec keeps the PID and the pipes. */
  output(): string;
  running(): boolean;
  /** Trimmed <dataDir>/bridge-id, or null. */
  bridgeIdFile(): string | null;
  /** The last pairing prompt printed after `afterOffset` characters of output. */
  pairing(options?: { afterOffset?: number; timeoutMs?: number }): Promise<PairingPrompt>;
  hasTmuxSession(sessionId: string): Promise<boolean>;
  stop(): Promise<void>;
}

/**
 * A test-owned, UNPAIRED account bridge: private HOME, data dir and tmux socket
 * dir under e2e/.isolated-bridges/ and /tmp/ftpk-*, captured output, recorded
 * PID (stop-services.sh kills leftovers by that exact record only).
 */
export async function startIsolatedBridge(options: { apiUrl?: string } = {}): Promise<IsolatedBridge> {
  const root = join(E2E_DIR, ".isolated-bridges");
  mkdirSync(root, { recursive: true });
  const home = await mkdtemp(join(root, "b-"));
  const tmuxDir = await mkdtemp("/tmp/ftpk-");
  const dataDir = join(home, ".ftown", "data");
  const env = isolatedBridgeEnv(home, tmuxDir);
  const removeScratch = async () => {
    // Retried: a login shell killed with the tmux server may still be saving ~/.zsh_sessions (ENOTEMPTY mid-removal).
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await rm(tmuxDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  try {
    await writeFile(join(home, "tmux"), `${tmuxDir}\n`);
    await writeFile(join(home, ".zshenv"), "skip_global_compinit=1\n", { mode: 0o600 });
    await writeFile(join(home, ".zshrc"), "autoload -Uz compinit\ncompinit -u\n", { mode: 0o600 });
    await execute(process.execPath, [CLI, "setup"], { cwd: home, env, timeout: 20_000, maxBuffer: 65536 });
  } catch {
    await removeScratch();
    throw new Error("test-owned bridge setup failed");
  }
  const child: ChildProcess = spawn(process.execPath, [join(BRIDGE_DIST, "index.js"), "--api-url", options.apiUrl ?? UI_BASE_URL], {
    cwd: home, env, stdio: ["ignore", "pipe", "pipe"],
  });
  if (typeof child.pid !== "number") { await removeScratch(); throw new Error("failed to spawn the test bridge"); }
  const pid = child.pid;
  await writeFile(join(home, "pid"), `${pid}\n`);
  let output = "";
  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  let exited = false;
  child.once("exit", () => { exited = true; });
  child.once("error", () => { exited = true; });
  const stopped = () => exited || child.exitCode !== null || child.signalCode !== null;
  const waitExit = async (timeout: number) => {
    const deadline = Date.now() + timeout;
    while (!stopped() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    return stopped();
  };
  const tmux = (args: string[]) => execute("tmux", ["-S", tmuxSocket(tmuxDir), ...args], { env, timeout: 5000, maxBuffer: 32768 });
  return {
    home, dataDir, tmuxDir, pid,
    output: () => output,
    running: () => !stopped(),
    bridgeIdFile() {
      try { return readFileSync(join(dataDir, "bridge-id"), "utf8").trim() || null; } catch { return null; }
    },
    pairing: (opts = {}) => waitForPairingPrompt(() => output, { ...opts, alive: () => !stopped() }),
    async hasTmuxSession(sessionId: string) {
      try { await tmux(["has-session", "-t", `=ftown-${sessionId}`]); return true; } catch { return false; }
    },
    async stop() {
      let failed = false;
      if (!stopped()) {
        child.kill("SIGTERM");
        if (!await waitExit(8000)) { child.kill("SIGKILL"); if (!await waitExit(3000)) failed = true; }
      }
      // tmux sessions outlive the bridge by design; this server is reachable only through the private socket.
      if (existsSync(tmuxSocket(tmuxDir))) { try { await tmux(["kill-server"]); } catch { /* already gone */ } }
      if (failed) throw new Error("test-owned bridge did not exit");
      await removeScratch();
    },
  };
}
