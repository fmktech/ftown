import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";

const execute = promisify(execFile);
export const DEMO_WORKSPACE = "/home/user/demo-workspace";
export const AI_NAME = "Build duration formatter";
export const AI_MODEL = "gpt-6.1-terra";
export const INITIAL_PROMPT = "Fix only duration.mjs so non-negative integer minutes format as 0m, 5m, 1h, or 1h 05m. Run node --test and briefly explain the change. Work only in this directory; do not delegate.";
const initialSource = `export function formatDuration(minutes) {\n  return \`${"${minutes}"}m\`;\n}\n`;
const tests = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatDuration } from './duration.mjs';\nfor (const [minutes, expected] of [[0, '0m'], [5, '5m'], [60, '1h'], [65, '1h 05m']]) {\n  test(\`formats ${"${minutes}"} minutes\`, () => assert.equal(formatDuration(minutes), expected));\n}\n`;
const digest = (data: string) => createHash("sha256").update(data).digest("hex");

/** Create only the dedicated fixture; failed setup cleans its own directory. */
export async function prepareDemo(): Promise<void> {
  await mkdir(DEMO_WORKSPACE, { mode: 0o700 });
  try {
    await writeFile(join(DEMO_WORKSPACE, "duration.mjs"), initialSource, { flag: "wx" });
    await writeFile(join(DEMO_WORKSPACE, "duration.test.mjs"), tests, { flag: "wx" });
    let failed = false;
    try { await execute(process.execPath, ["--test", "--test-reporter=tap", "duration.test.mjs"], { cwd: DEMO_WORKSPACE, timeout: 20_000 }); }
    catch (error) {
      const result = error as { code?: number; stdout?: string };
      failed = result.code === 1 && /# tests 4\b/.test(result.stdout ?? "") && /# fail [1-9]/.test(result.stdout ?? "");
    }
    if (!failed) throw new Error("Demo baseline did not fail as expected");
  } catch (error) {
    await rm(DEMO_WORKSPACE, { recursive: true, force: true });
    throw error;
  }
}

/** Login only in the newly created bridge HOME; the key is never put in argv/env. */
export async function provisionCodex(bridgeHome: string, outputDirectory: string): Promise<void> {
  const keyPath = process.env.FTOWN_CAPTURE_OPENAI_KEY_FILE;
  if (!keyPath || !isAbsolute(keyPath) || resolve(keyPath) !== keyPath || await realpath(keyPath) !== keyPath
    || keyPath === outputDirectory || keyPath.startsWith(`${outputDirectory}/`)
    || keyPath === "/home/user/ftown" || keyPath.startsWith("/home/user/ftown/")) throw new Error("Invalid private provider key file");
  const codexDir = join(bridgeHome, ".codex");
  await mkdir(codexDir, { recursive: true, mode: 0o700 });
  const configPath = join(codexDir, "config.toml");
  let existing = "";
  try { existing = await readFile(configPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (/^\s*(model_reasoning_effort|cli_auth_credentials_store)\s*=/m.test(existing)) throw new Error("Unexpected existing Codex configuration");
  await writeFile(configPath, `model_reasoning_effort = "xhigh"\ncli_auth_credentials_store = "file"\n${existing}`, { mode: 0o600 });
  const handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let key: Buffer;
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o7777) !== 0o600 || st.size < 1 || st.size > 16_384) throw new Error("Invalid private provider key file");
    key = await handle.readFile();
  } finally { await handle.close(); }
  const env = { ...process.env, HOME: bridgeHome, USERPROFILE: bridgeHome };
  delete env.CODEX_HOME;
  delete env.OPENAI_API_KEY;
  try {
    await new Promise<void>((resolveLogin, reject) => {
      const child = spawn("codex", ["login", "--with-api-key"], { env, cwd: bridgeHome, stdio: ["pipe", "ignore", "ignore"] });
      let done = false;
      let timedOut = false;
      const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); ok ? resolveLogin() : reject(new Error("Isolated Codex login failed")); };
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20_000);
      child.once("error", () => finish(false));
      child.once("close", code => finish(!timedOut && code === 0));
      child.stdin.on("error", () => { child.kill("SIGKILL"); });
      child.stdin.end(key);
    });
  } finally { key.fill(0); }
}

export async function verifyDemo(): Promise<void> {
  if (digest(await readFile(join(DEMO_WORKSPACE, "duration.test.mjs"), "utf8")) !== digest(tests)
    || (await readFile(join(DEMO_WORKSPACE, "duration.mjs"), "utf8")) === initialSource) throw new Error("Demo source or tests were not correctly updated");
  const names = (await readdir(DEMO_WORKSPACE)).sort();
  if (names.join(",") !== "duration.mjs,duration.test.mjs") throw new Error("Unexpected demo workspace changes");
  try {
    const { stdout } = await execute(process.execPath, ["--test", "--test-reporter=tap", "duration.test.mjs"], { cwd: DEMO_WORKSPACE, timeout: 20_000 });
    if (!/# tests 4\b/.test(stdout) || !/# pass 4\b/.test(stdout) || !/# fail 0\b/.test(stdout)) throw new Error("Unexpected test summary");
  } catch { throw new Error("Independent demo tests did not pass"); }
}

interface RolloutLine { type?: string; payload?: { type?: string; last_agent_message?: string; model?: string; effort?: string; error?: unknown } }
async function rolloutFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const paths = await Promise.all(entries.map(async entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return rolloutFiles(path);
      return entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name) ? [path] : [];
    }));
    return paths.flat();
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Read only the isolated rollout; never print its contents in assertion errors. */
export async function completedTurns(home: string): Promise<string[]> {
  const files = await rolloutFiles(join(home, ".codex", "sessions"));
  if (files.length > 1) throw new Error("Expected one isolated Codex rollout");
  if (!files.length) return [];
  const data = await readFile(files[0], "utf8");
  let lines: RolloutLine[];
  try { lines = data.split("\n").slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as RolloutLine); }
  catch { throw new Error("Unsupported Codex rollout format"); }
  const turns: string[] = [];
  let verifiedContext = false;
  for (const line of lines) {
    if (line.type === "turn_context") {
      if (line.payload?.model !== AI_MODEL || line.payload?.effort !== "xhigh") throw new Error("Codex turn lacks the required model and reasoning effort");
      verifiedContext = true;
    }
    if (line.type === "event_msg" && line.payload?.type === "task_complete") {
      if (!verifiedContext) throw new Error("Completed Codex turn lacks verified model and effort context");
      if (line.payload.error != null) throw new Error("Codex turn completed with an error");
      if (typeof line.payload.last_agent_message !== "string" || !line.payload.last_agent_message.trim()) throw new Error("Codex turn completed without an assistant response");
      turns.push(line.payload.last_agent_message);
      verifiedContext = false;
    }
  }
  return turns;
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Require a completed assistant turn and its actual response visible in xterm. */
export async function waitForTurn(page: Page, home: string, previous: number, timeout = 120_000, prompt = INITIAL_PROMPT): Promise<number> {
  let result: string[] = [];
  await expect.poll(async () => {
    result = await completedTurns(home);
    const response = result[previous];
    if (result.length <= previous || !response || normalize(response).length < 20) return false;
    const screen = compact(await page.locator(".xterm-rows").first().textContent() ?? "");
    const words = normalize(response).split(" ");
    return words.some((_, index) => {
      if (index + 4 > words.length) return false;
      const phrase = compact(words.slice(index, index + 4).join(" "));
      return phrase.length >= 18 && !compact(prompt).includes(phrase) && screen.includes(phrase);
    });
  }, { timeout, intervals: [250, 500, 1000], message: "Expected a completed Codex turn rendered in the terminal" }).toBe(true);
  return result.length;
}

export async function removeDemo(): Promise<void> { await rm(DEMO_WORKSPACE, { recursive: true, force: true }); }
