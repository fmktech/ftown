import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

const execute = promisify(execFile);
export const DEMO_WORKSPACE = "/home/user/demo-workspace";
export const AI_NAME = "Codex coordinator";
export const AI_MODEL = "gpt-6.1-terra";
export const INITIAL_PROMPT = `Fix only duration.mjs so non-negative integer minutes format as 0m, 5m, 1h, or 1h 05m. Run node --test and briefly explain the change. Work only in this directory. Do not delegate or create sessions yet. For every FTown command use the installed launcher "$HOME/.ftown/ftown". When I later ask you to delegate, use "$HOME/.ftown/ftown" sessions create --parent to start exactly two children in this directory: Claude review with --shell claude --model sonnet, to review zero and hour boundaries; and Pi test check with --shell pi --model openai/gpt-6.1-terra:xhigh, to run node --test --test-reporter=tap duration.test.mjs. In each child prompt explicitly instruct it to use "$HOME/.ftown/ftown" for FTown commands and report its actual findings once via "$HOME/.ftown/ftown" harness mail send --parent --type result, without creating children or editing files. Then read both replies and summarize their findings.`;
export const DELEGATION_PROMPT = "Ask Claude Code to review the fix and Pi to test it. Have both report back.";
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
  let keyIdentity: { dev: number; ino: number };
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o7777) !== 0o600 || st.size < 1 || st.size > 16_384) throw new Error("Invalid private provider key file");
    keyIdentity = { dev: st.dev, ino: st.ino };
    key = await handle.readFile();
  } finally { await handle.close(); }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: bridgeHome, USERPROFILE: bridgeHome };
  delete env.CODEX_HOME;
  delete env.OPENAI_API_KEY;
  try {
    const piDir = join(bridgeHome, ".pi", "agent");
    await mkdir(piDir, { recursive: true, mode: 0o700 });
    await writeFile(join(piDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: key.toString("utf8").trim() } }), { flag: "wx", mode: 0o600 });
    await writeFile(join(piDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: AI_MODEL, defaultThinkingLevel: "xhigh" }), { flag: "wx", mode: 0o600 });
    await writeFile(join(piDir, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses", models: [{ id: AI_MODEL, name: "GPT-6.1 Terra", reasoning: true, thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh", max: "max" }, input: ["text", "image"], contextWindow: 1050000, maxTokens: 128000, cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25, tiers: [{ inputTokensAbove: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }] } }] } } }), { flag: "wx", mode: 0o600 });
    const claudePath = process.env.FTOWN_CAPTURE_CLAUDE_TOKEN_FILE;
    if (!claudePath || claudePath === keyPath || !isAbsolute(claudePath) || resolve(claudePath) !== claudePath || await realpath(claudePath) !== claudePath || claudePath === outputDirectory || claudePath.startsWith(`${outputDirectory}/`) || claudePath === "/home/user/ftown" || claudePath.startsWith("/home/user/ftown/")) throw new Error("Invalid private provider key file");
    const claudeHandle = await open(claudePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let claudeToken: Buffer;
    try {
      const st = await claudeHandle.stat();
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o7777) !== 0o600 || st.size < 1 || st.size > 16_384 || (st.dev === keyIdentity.dev && st.ino === keyIdentity.ino)) throw new Error("Invalid private provider key file");
      claudeToken = await claudeHandle.readFile();
    } finally { await claudeHandle.close(); }
    try {
      const token = claudeToken.toString("utf8").trim();
      if (!token) throw new Error("Invalid private provider key file");
      const settingsPath = join(bridgeHome, ".claude", "settings.json");
      const settingsHandle = await open(settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let settings: Record<string, unknown>;
      try {
        const st = await settingsHandle.stat();
        if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o7777) !== 0o600) throw new Error("Invalid scratch Claude settings");
        const value: unknown = JSON.parse(await settingsHandle.readFile("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid scratch Claude settings");
        settings = value as Record<string, unknown>;
      } catch { throw new Error("Invalid scratch Claude settings"); }
      finally { await settingsHandle.close(); }
      if (Object.keys(settings).some(name => name !== "hooks" && name !== "env") || !settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) throw new Error("Unexpected scratch Claude provider settings");
      const originalEnv = settings.env;
      if (originalEnv !== undefined && (!originalEnv || typeof originalEnv !== "object" || Array.isArray(originalEnv))) throw new Error("Invalid scratch Claude settings");
      const claudeEnv = (originalEnv ?? {}) as Record<string, unknown>;
      if (Object.keys(claudeEnv).length) throw new Error("Unexpected scratch Claude provider settings");
      const temporary = `${settingsPath}.capture-tmp`;
      await writeFile(temporary, JSON.stringify({ ...settings, env: { ...claudeEnv, CLAUDE_CODE_OAUTH_TOKEN: token } }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, settingsPath);
    } finally { claudeToken.fill(0); }
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

interface RolloutLine { timestamp?: string; type?: string; payload?: { type?: string; last_agent_message?: string; model?: string; effort?: string; error?: unknown } }
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
async function completedTurnRecords(home: string): Promise<{ text: string; timestamp: string | undefined }[]> {
  const files = await rolloutFiles(join(home, ".codex", "sessions"));
  if (files.length > 1) throw new Error("Expected one isolated Codex rollout");
  if (!files.length) return [];
  const data = await readFile(files[0], "utf8");
  let lines: RolloutLine[];
  try { lines = data.split("\n").slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as RolloutLine); }
  catch { throw new Error("Unsupported Codex rollout format"); }
  const turns: { text: string; timestamp: string | undefined }[] = [];
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
      turns.push({ text: line.payload.last_agent_message, timestamp: line.timestamp });
      verifiedContext = false;
    }
  }
  return turns;
}
export async function completedTurns(home: string): Promise<string[]> {
  return (await completedTurnRecords(home)).map(turn => turn.text);
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

export type FleetSession = { id: string; name: string; shellType?: string; model?: string; parentSessionId?: string; bridgeId?: string; claudeSessionId?: string; piSessionFile?: string };
export type FleetMail = { id: string; from: string; to: string; type: string; body: string; ts: string; deliveredAt?: string };
type NativeEntry = { type?: string; message?: { role?: string; model?: string; provider?: string; thinkingLevel?: string; providerThinkingLevel?: string; stopReason?: string; content?: { type?: string; id?: string; name?: string; input?: unknown; arguments?: unknown; tool_use_id?: string; is_error?: boolean; text?: string }[]; toolCallId?: string; isError?: boolean } };
export class PiProofDiagnosticError extends Error {
  constructor(diagnostic: string) { super(`Pi proof diagnostic: ${diagnostic}`); }
}

/** Read an actual shell tool's command field, never arbitrary prompt/JSON text. */
function toolCommand(value: unknown): string | undefined {
  if (typeof value === "string") {
    try { value = JSON.parse(value) as unknown; } catch { return undefined; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.command === "string" ? record.command : typeof record.cmd === "string" ? record.cmd : undefined;
}

/** Match a launcher as the executable of a simple shell command, respecting quotes. */
function ftownCommands(command: string | undefined, home: string, subcommand: readonly string[]): string[][] {
  if (!command) return [];
  const segments: string[][] = [];
  let words: string[] = [], word = "", active = false, quote = "", comment = false;
  const endWord = () => { if (active) words.push(word); word = ""; active = false; };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (comment) { if (char === "\n") { comment = false; endSegment(); } continue; }
    if (quote === "'") { if (char === "'") quote = ""; else word += char === "$" ? "\0$" : char; active = true; continue; }
    if (char === "\\") { if (++index >= command.length) return []; const escaped = command[index]; word += escaped === "$" ? "\0$" : escaped; active = true; continue; }
    if (quote === '"') { if (char === '"') quote = ""; else word += char; active = true; continue; }
    if (char === "'" || char === '"') { quote = char; active = true; continue; }
    if (char === "#" && !active) { comment = true; continue; }
    // A here-document body is not executable shell input; do not mistake its
    // contents for commands without implementing a full shell parser.
    if (char === "<" && command[index + 1] === "<") return [];
    if (char === "\n" || char === ";" || char === "&" || char === "|") {
      if ((char === "&" || char === "|") && command[index + 1] === char) index++;
      endSegment(); continue;
    }
    if (/\s/.test(char)) { endWord(); continue; }
    word += char; active = true;
  }
  if (quote) return [];
  endSegment();
  const launcherPaths = new Set(["ftown", `${home}/.ftown/ftown`, "$HOME/.ftown/ftown", "${HOME}/.ftown/ftown", "~/.ftown/ftown"]);
  return segments.filter(segment => launcherPaths.has(segment[0]) && subcommand.every((part, index) => segment[index + 1] === part));
}

/** Validate native transcripts, without copying them or their content to staging. */
export async function verifyChildTranscripts(home: string, claude: FleetSession, pi: FleetSession, replies: FleetMail[]): Promise<string> {
  if (!claude.claudeSessionId || !/^[a-zA-Z0-9-]+$/.test(claude.claudeSessionId) || !pi.piSessionFile) throw new Error("Child native session identities are missing");
  const claudeFile = join(home, ".claude", "projects", DEMO_WORKSPACE.replace(/[^a-zA-Z0-9]/g, "-"), `${claude.claudeSessionId}.jsonl`);
  const piFile = await realpath(pi.piSessionFile);
  if (!piFile.startsWith(`${await realpath(join(home, ".pi"))}${sep}`)) throw new Error("Pi transcript is outside the scratch home");
  const readEntries = async (file: string): Promise<NativeEntry[]> => {
    const data = await readFile(file, "utf8");
    return data.split("\n").filter(Boolean).map(line => JSON.parse(line) as NativeEntry);
  };
  const [claudeEntries, piEntries] = await Promise.all([readEntries(claudeFile), readEntries(piFile)]);
  const matchesMail = (value: unknown, sender: string) => {
    const mail = replies.find(reply => reply.from === sender);
    if (!mail) return false;
    const callWords = new Set(normalize(JSON.stringify(value)).split(" "));
    const bodyWords = [...new Set(normalize(mail.body).split(" ").filter(word => word.length >= 4))];
    return bodyWords.length >= 2 && bodyWords.filter(word => callWords.has(word)).length >= Math.min(3, bodyWords.length);
  };
  const matchesMailCommand = (value: unknown, sender: string) => ftownCommands(toolCommand(value), home, ["harness", "mail", "send"]).some(segment => segment.includes("--parent") && segment.some((part, index) => (part === "--type" && segment[index + 1] === "result") || part === "--type=result") && matchesMail(segment, sender));
  const claudeAssistant = (entry: NativeEntry) => entry.type === "assistant" && /^claude-sonnet-[a-z0-9.-]+$/i.test(entry.message?.model ?? "");
  let claudeModel: string | undefined;
  const claudeMailCompleted = claudeEntries.some((entry, callIndex) => claudeAssistant(entry) && (entry.message?.content ?? []).some(call => {
    if (call.type !== "tool_use" || !call.id || !matchesMailCommand(call.input, claude.id)) return false;
    const resultIndex = claudeEntries.findIndex((candidate, index) => index > callIndex && (candidate.message?.content ?? []).some(result => result.type === "tool_result" && result.tool_use_id === call.id && result.is_error !== true));
    const completed = resultIndex > callIndex && claudeEntries.some((candidate, index) => index > resultIndex && claudeAssistant(candidate) && candidate.message?.model === entry.message?.model && (candidate.message?.content ?? []).some(content => content.type === "text" && Boolean(content.text?.trim())));
    if (completed) claudeModel = entry.message?.model;
    return completed;
  }));
  if (!claudeMailCompleted || !claudeModel) throw new Error("Claude Sonnet completion or successful mail tool trace missing");
  // Pi's Responses adapter records providerThinkingLevel only for its optional
  // mid-conversation configuration-update transport; ordinary requests carry
  // the mapped effort in reasoning.effort and record the loop thinkingLevel.
  const piAssistant = (entry: NativeEntry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.provider === "openai" && entry.message.model === AI_MODEL && entry.message.thinkingLevel === "xhigh" && (entry.message.providerThinkingLevel === undefined || entry.message.providerThinkingLevel === "xhigh") && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted";
  const piMailCompleted = piEntries.some((entry, callIndex) => piAssistant(entry) && (entry.message?.content ?? []).some(call => {
    if (call.type !== "toolCall" || !call.id || !matchesMailCommand(call.arguments, pi.id)) return false;
    const resultIndex = piEntries.findIndex((candidate, index) => index > callIndex && candidate.type === "message" && candidate.message?.role === "toolResult" && candidate.message.toolCallId === call.id && candidate.message.isError === false);
    if (resultIndex <= callIndex || !piEntries.some((candidate, index) => index > resultIndex && piAssistant(candidate) && candidate.message?.stopReason === "stop" && (candidate.message.content ?? []).some(content => content.type === "text" && Boolean(content.text?.trim())))) return false;
    return piEntries.some((testEntry, testCallIndex) => testCallIndex < callIndex && piAssistant(testEntry) && (testEntry.message?.content ?? []).some(testCall => {
      const command = JSON.stringify(testCall.arguments);
      if (testCall.type !== "toolCall" || !testCall.id || !/node\s+--test\b/.test(command) || !command.includes("duration.test.mjs")) return false;
      return piEntries.some((candidate, index) => {
        if (index <= testCallIndex || index >= callIndex || candidate.type !== "message" || candidate.message?.role !== "toolResult" || candidate.message.toolCallId !== testCall.id || candidate.message.isError !== false) return false;
        const output = (candidate.message.content ?? []).filter(content => content.type === "text").map(content => content.text ?? "").join("\n");
        return /(?:#|ℹ)\s*tests\s+4\b/.test(output) && /(?:#|ℹ)\s*pass\s+4\b/.test(output) && /(?:#|ℹ)\s*fail\s+0\b/.test(output);
      });
    }));
  }));
  if (!piMailCompleted) {
    // Diagnostics are independently counted from the native records and do
    // not affect the acceptance predicate above or expose transcript content.
    const assistants = piEntries.filter(entry => entry.type === "message" && entry.message?.role === "assistant");
    const calls = piEntries.flatMap((entry, index) => piAssistant(entry)
      ? (entry.message?.content ?? []).filter(call => call.type === "toolCall" && Boolean(call.id)).map(call => ({ call, index })) : []);
    const tests = calls.filter(({ call }) => {
      const command = JSON.stringify(call.arguments);
      return /node\s+--test\b/.test(command) && command.includes("duration.test.mjs");
    });
    const isPassingResult = (candidate: NativeEntry, id: string | undefined) => {
      if (candidate.type !== "message" || candidate.message?.role !== "toolResult" || candidate.message.toolCallId !== id || candidate.message.isError !== false) return false;
      const output = (candidate.message.content ?? []).filter(content => content.type === "text").map(content => content.text ?? "").join("\n");
      return /(?:#|ℹ)\s*tests\s+4\b/.test(output) && /(?:#|ℹ)\s*pass\s+4\b/.test(output) && /(?:#|ℹ)\s*fail\s+0\b/.test(output);
    };
    const testResults = tests.flatMap(test => piEntries.flatMap((entry, index) => index > test.index && isPassingResult(entry, test.call.id) ? [{ callIndex: test.index, resultIndex: index }] : []));
    const mailCommands = calls.filter(({ call }) => ftownCommands(toolCommand(call.arguments), home, ["harness", "mail", "send"]).length > 0);
    const mailWithFlags = mailCommands.filter(({ call }) => ftownCommands(toolCommand(call.arguments), home, ["harness", "mail", "send"]).some(segment => segment.includes("--parent") && segment.some((part, index) => (part === "--type" && segment[index + 1] === "result") || part === "--type=result")));
    const matchedMail = mailCommands.filter(({ call }) => matchesMailCommand(call.arguments, pi.id));
    const mailResults = matchedMail.flatMap(mail => piEntries.flatMap((entry, index) => index > mail.index && entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === mail.call.id && entry.message.isError === false ? [{ callIndex: mail.index, resultIndex: index }] : []));
    const completedMail = mailResults.filter(mail => piEntries.some((entry, index) => index > mail.resultIndex && piAssistant(entry) && entry.message?.stopReason === "stop" && (entry.message.content ?? []).some(content => content.type === "text" && Boolean(content.text?.trim()))));
    const count = (value: number) => Math.min(value, 999);
    const diagnostic = [
      `assistant=${count(assistants.length)}`,
      `provider=${count(assistants.filter(entry => entry.message?.provider === "openai").length)}`,
      `model=${count(assistants.filter(entry => entry.message?.model === AI_MODEL).length)}`,
      `effort=${count(assistants.filter(entry => entry.message?.thinkingLevel === "xhigh" && (entry.message.providerThinkingLevel === undefined || entry.message.providerThinkingLevel === "xhigh")).length)}`,
      `context=${count(assistants.filter(piAssistant).length)}`,
      `testCommand=${count(tests.length)}`,
      `testResult=${count(testResults.length)}`,
      `testBeforeMail=${count(testResults.filter(test => matchedMail.some(mail => test.resultIndex < mail.index)).length)}`,
      `mailCommand=${count(mailCommands.length)}`,
      `mailFlags=${count(mailWithFlags.length)}`,
      `mailBody=${count(matchedMail.length)}`,
      `mailResult=${count(mailResults.length)}`,
      `postMailCompletion=${count(completedMail.length)}`,
    ].join(" ");
    throw new PiProofDiagnosticError(diagnostic);
  }
  return claudeModel;
}

function parentOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output.flatMap(block => block && typeof block === "object" && !Array.isArray(block) && (block.type === "input_text" || block.type === "output_text") && typeof block.text === "string" ? [block.text] : []).join("\n");
}

type ParentRecord = { type?: string; payload?: { type?: string; call_id?: string; arguments?: string; output?: unknown; item?: { type?: string; id?: string; command?: unknown; cwd?: unknown; status?: string; exit_code?: number; aggregated_output?: unknown } } };

function demoWorkingDirectory(cwd: unknown): boolean {
  if (typeof cwd !== "string" || !cwd.startsWith("file:///") || cwd.includes("?") || cwd.includes("#")) return false;
  try {
    const url = new URL(cwd);
    return url.protocol === "file:" && !url.host && !url.search && !url.hash && resolve(fileURLToPath(url)) === DEMO_WORKSPACE;
  } catch { return false; }
}

function isChildCreation(command: string | undefined, home: string, child: FleetSession): boolean {
  return ftownCommands(command, home, ["sessions", "create"]).some(segment => segment.includes("--parent") && segment.some((part, index) => (part === "--name" && segment[index + 1] === child.name) || part === `--name=${child.name}`));
}

/** Correlate the parent's actual creation tool calls with later returned child IDs. */
function hasParentCreation(lines: ParentRecord[], home: string, child: FleetSession): boolean {
  if (!child.id) return false;
  if (lines.some(line => {
    const item = line.payload?.item;
    return line.type === "event_msg" && line.payload?.type === "item_completed" && item?.type === "CommandExecution"
      && typeof item.id === "string" && Boolean(item.id.trim()) && item.status === "completed" && item.exit_code === 0
      && typeof item.aggregated_output === "string" && item.aggregated_output.includes(child.id) && demoWorkingDirectory(item.cwd)
      && Array.isArray(item.command) && item.command.length === 3 && item.command[0] === "/bin/bash" && item.command[1] === "-lc"
      && typeof item.command[2] === "string" && isChildCreation(item.command[2], home, child);
  })) return true;
  return lines.some((line, callIndex) => {
    const payload = line.payload;
    if (line.type !== "response_item" || payload?.type !== "function_call" || typeof payload.call_id !== "string" || !payload.call_id.trim() || !isChildCreation(toolCommand(payload.arguments), home, child)) return false;
    return lines.some((result, index) => index > callIndex && result.type === "response_item" && result.payload?.type === "function_call_output" && result.payload.call_id === payload.call_id && parentOutputText(result.payload.output).includes(child.id));
  });
}

export async function verifyParentCreation(home: string, children: FleetSession[]): Promise<void> {
  const files = await rolloutFiles(join(home, ".codex", "sessions"));
  if (files.length !== 1) throw new Error("Parent rollout identity missing");
  const lines = (await readFile(files[0], "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as ParentRecord);
  for (const child of children) {
    if (!hasParentCreation(lines, home, child)) throw new Error("Parent creation tool call or returned child identity missing");
  }
}

/** Return a completed matching synthesis only if it follows delivery of both mails. */
export async function findParentSynthesis(home: string, replies: FleetMail[], afterTurn: number): Promise<number | undefined> {
  const turns = await completedTurnRecords(home);
  const timestamps = turns.map(turn => Date.parse(turn.timestamp ?? ""));
  if (timestamps.some(timestamp => !Number.isFinite(timestamp))) throw new Error("Parent completion timestamps unavailable");
  if (replies.length !== 2 || replies.some(reply => !reply.deliveredAt)) return undefined;
  const delivered = replies.map(reply => Date.parse(reply.deliveredAt!));
  if (delivered.some(timestamp => !Number.isFinite(timestamp))) throw new Error("Parent mail delivery timestamps unavailable");
  const deliveredAt = Math.max(...delivered);
  const excluded = new Set(["that", "this", "with", "from", "your", "were", "have", "their", "test", "tests", "minutes", "result", "results", "format", "code", "file", "check", "review", "parent", "ftown"]);
  for (let index = afterTurn; index < turns.length; index++) {
    const summary = normalize(turns[index].text);
    if (timestamps[index] >= deliveredAt && summary.includes("claude") && summary.includes("pi") && replies.every(reply => normalize(reply.body).split(" ").some(word => word.length >= 4 && !excluded.has(word) && summary.split(" ").includes(word)))) return index + 1;
  }
  return undefined;
}
