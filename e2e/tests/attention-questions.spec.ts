import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedEmail, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { BRIDGE_HOME, E2E_DIR } from "../helpers/config";

const execute = promisify(execFile);
const FTOWN_CLI = join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js");
const HARNESS_CLI = join(E2E_DIR, "..", "bridge", "dist", "harness-cli.js");

interface AttentionEvent { id: string; resolvedAt?: string; resolution?: string; answer?: { answers: Array<{ selected: number[]; text?: string }> } }
interface AttentionResult { event: AttentionEvent }
interface InboxPage { messages: Array<{ body: string; from: string; threadId?: string }> }
interface ChildResult { code: number | null; stdout: string; stderr: string }

function childEnv(sessionId: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: sessionId };
}

/** Real installed-command entry point against the scratch bridge. */
async function attentionCommand(sessionId: string, args: string[]): Promise<AttentionResult> {
  const { stdout } = await execute(process.execPath, [FTOWN_CLI, "sessions", "attention", ...args], { env: childEnv(sessionId), timeout: 30_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout) as AttentionResult;
}

/** Start a long-running child and collect its output; optional stdin text. */
function startChild(args: string[], sessionId: string, stdin?: string): { done: Promise<ChildResult>; kill: () => void; output: () => { stdout: string; stderr: string } } {
  const child = spawn(process.execPath, args, { env: childEnv(sessionId), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const done = new Promise<ChildResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
  done.catch(() => undefined);
  if (stdin !== undefined) child.stdin.write(stdin);
  child.stdin.end();
  let closed = false;
  void done.then(() => { closed = true; }, () => { closed = true; });
  const kill = () => {
    if (closed) return;
    child.kill("SIGTERM");
    setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 2000).unref();
  };
  return { done, kill, output: () => ({ stdout, stderr }) };
}

/** Wait for a child to exit, failing with its output after 30 s. */
async function finish(child: { done: Promise<ChildResult>; output: () => { stdout: string; stderr: string } }): Promise<ChildResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { const { stdout, stderr } = child.output(); reject(new Error(`child did not exit within 30s\nstdout: ${stdout}\nstderr: ${stderr}`)); }, 30_000);
    timer.unref();
  });
  try { return await Promise.race([child.done, timeout]); } finally { if (timer) clearTimeout(timer); }
}

async function createSession(name: string): Promise<string> {
  const created = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = (created.body as { session: { id: string } }).session.id;
  expect(id).toBeTruthy();
  return id;
}

async function openInboxEntry(page: Page, id: string, mobile: boolean, timeout?: number): Promise<{ inbox: Locator; item: Locator }> {
  if (mobile) await page.getByRole("tab", { name: "Workspace", exact: true }).click();
  const trigger = page.getByRole("button", { name: /^Inbox, \d+ messages?$/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const item = inbox.locator(`[data-inbox-entry="${id}"]`);
  await expect(item).toBeVisible(timeout === undefined ? undefined : { timeout });
  return { inbox, item };
}

async function attentionItem(sessionId: string, eventId: string): Promise<AttentionEvent> {
  const result = await bridgeApiFetch("GET", `/api/sessions/${sessionId}/attention/${eventId}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return (result.body as { event: AttentionEvent }).event;
}

async function inboxMessages(sessionId: string): Promise<InboxPage["messages"]> {
  const mail = await bridgeApiFetch("GET", `/api/sessions/${sessionId}/inbox?peek=1&all=1`);
  expect(mail.status).toBe(200);
  return (mail.body as InboxPage).messages;
}

test("mail question: pick an option, add a note, answer is mailed and recorded", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, sharedEmail()); await waitForBridgeOnline(page);
  const name = `Attention mail ${Date.now().toString(36)}`; let id = "";
  try {
    id = await createSession(name);
    const question = "Which deploy target should I use?";
    const { event } = await attentionCommand(id, ["--title", "Deploy target", "--message", question, "--option", "A", "--option", "B"]);
    expect(event.id).toBeTruthy();
    const { item } = await openInboxEntry(page, id, false);
    await expect(item.getByText(question)).toBeVisible();
    await expect(item.getByRole("radio")).toHaveCount(2);
    await expect(item.getByRole("button", { name: "Send answer" })).toBeDisabled();
    await item.getByRole("radio", { name: /^B/ }).check();
    const note = `Use the blue one ${Date.now().toString(36)}`;
    await item.getByLabel("Other answer or note (optional)").fill(note);
    await item.getByRole("button", { name: "Send answer" }).click();
    await expect(item).toHaveCount(0);

    await expect.poll(async () => (await inboxMessages(id)).some(message => message.body.startsWith("[ftown attention answer id="))).toBe(true);
    const mail = (await inboxMessages(id)).find(message => message.body.startsWith("[ftown attention answer id="));
    expect(mail?.body).toContain(`id=${event.id}`);
    expect(mail?.body).toContain("A: B");
    expect(mail?.body).toContain(`Note: ${note}`);
    expect(mail?.from).toBe("browser");
    expect(mail?.threadId).toBe(`attention:${event.id}`);

    const stored = await attentionItem(id, event.id);
    expect(stored.resolution).toBe("answered");
    expect(stored.resolvedAt).toBeTruthy();
    expect(stored.answer?.answers).toEqual([{ selected: [1], text: note }]);
  } finally { if (id) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined); }
});

test("waiting CLI receives a multi-select answer directly and no mail is queued", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, sharedEmail()); await waitForBridgeOnline(page);
  const name = `Attention wait ${Date.now().toString(36)}`; let id = ""; let waiter: ReturnType<typeof startChild> | undefined;
  try {
    id = await createSession(name);
    const labels = ["Lint", "Unit tests", "Docs"];
    waiter = startChild([FTOWN_CLI, "sessions", "attention", "--title", "Checks", "--message", "Which checks should I run?", "--multi", "--wait", "--timeout", "120", ...labels.flatMap(label => ["--option", label])], id);
    const { item } = await openInboxEntry(page, id, false, 45_000);
    await expect(item.getByRole("checkbox")).toHaveCount(3);
    await item.getByRole("checkbox", { name: /^Lint/ }).check();
    await item.getByRole("checkbox", { name: /^Docs/ }).check();
    await item.getByRole("button", { name: "Send answer" }).click();
    await expect(item).toHaveCount(0);
    const result = await finish(waiter);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Lint");
    expect(result.stdout).toContain("Docs");
    expect(result.stdout).not.toContain("Unit tests");
    const waitingLine = /Waiting for an answer \(attention ([^)\s]+)\)/.exec(result.stderr);
    expect(waitingLine, result.stderr).not.toBeNull();
    expect((await attentionItem(id, waitingLine![1]!)).resolution).toBe("answered");
    const messages = await inboxMessages(id);
    expect(messages.filter(message => message.threadId?.startsWith("attention:"))).toHaveLength(0);
    expect(messages.some(message => message.body.startsWith("[ftown attention answer id="))).toBe(false);
  } finally { waiter?.kill(); await waiter?.done.catch(() => undefined); if (id) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined); }
});

test("AskUserQuestion hook blocks until the dashboard answers it", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, sharedEmail()); await waitForBridgeOnline(page);
  const name = `Attention hook ${Date.now().toString(36)}`; let id = ""; let hook: ReturnType<typeof startChild> | undefined;
  try {
    id = await createSession(name);
    const question = "Which database should the service use?";
    const toolInput = { questions: [{ question, header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite", description: "Embedded" }] }] };
    // Same payload shape Claude Code sends to a PreToolUse command hook. Assumes the built bridge (bridge/dist) is present, as for the other CLI-driven specs.
    const stdin = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: `toolu_e2e_${Date.now().toString(36)}`, tool_input: toolInput });
    hook = startChild([HARNESS_CLI, "ask-hook"], id, stdin);
    const { item } = await openInboxEntry(page, id, false, 45_000);
    await expect(item.getByText(question)).toBeVisible();
    await expect(item.getByRole("radio")).toHaveCount(2);
    await expect(item.getByText("The agent is waiting for this answer.")).toBeVisible();
    await expect(item.getByRole("button", { name: "Answer in terminal" })).toBeVisible();
    await item.getByRole("radio", { name: /^SQLite/ }).check();
    await item.getByRole("button", { name: "Send answer" }).click();
    await expect(item).toHaveCount(0);
    const result = await finish(hook);
    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; updatedInput: { answers: Record<string, string>; questions: unknown[] } } };
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(output.hookSpecificOutput.updatedInput.answers[question]).toBe("SQLite");
    expect(output.hookSpecificOutput.updatedInput.questions).toEqual(toolInput.questions);
  } finally { hook?.kill(); await hook?.done.catch(() => undefined); if (id) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined); }
});

test("answer form has no horizontal overflow at 320 px", async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 320, height: 844 });
  await login(page, sharedEmail()); await waitForBridgeOnline(page);
  const name = `Attention narrow ${Date.now().toString(36)}`; let id = "";
  try {
    id = await createSession(name);
    const longLabel = `UnbrokenOptionLabel${"Long".repeat(15)}`;
    const questions = [
      { question: `Pick one. ${"LongUnbrokenReference".repeat(12)}`, header: "Narrow", options: [{ label: longLabel, description: `Description ${"Wide".repeat(30)}` }, { label: "Short" }], multiSelect: false, allowText: true },
      { question: "Which of these apply?", options: [{ label: "One" }, { label: "Two" }], multiSelect: true, allowText: true },
    ];
    await attentionCommand(id, ["--title", "Narrow check", "--message", "Narrow check", "--questions-json", JSON.stringify(questions)]);
    const { inbox, item } = await openInboxEntry(page, id, true);
    await expect(item.getByRole("button", { name: "Send answer" })).toBeVisible();
    expect(await inbox.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await item.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("attention-questions-mobile.png"), fullPage: true });
  } finally { if (id) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined); }
});
