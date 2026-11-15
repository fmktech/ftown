import { spawn } from "node:child_process";
import { join } from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { BRIDGE_HOME, E2E_DIR } from "../helpers/config";

const FTOWN_CLI = join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js");

interface AttentionEvent {
  id: string;
  route?: string;
  resolvedAt?: string;
  resolution?: string;
  answeredBy?: { kind?: string };
  answer?: { answers: Array<{ selected: number[]; text?: string }> };
}
interface ChildResult { code: number | null; stdout: string; stderr: string }

function childEnv(sessionId: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: sessionId };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Keep a non-shell parent process alive so a child question routes to the parent. */
function runningParentCommand(): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote("setInterval(() => {}, 1e9)")}`;
}

function startWaiter(sessionId: string, args: string[]): { done: Promise<ChildResult>; kill: () => void; output: () => { stdout: string; stderr: string } } {
  const child = spawn(process.execPath, [FTOWN_CLI, "sessions", "attention", ...args], { env: childEnv(sessionId), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const done = new Promise<ChildResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
  done.catch(() => undefined);
  let closed = false;
  void done.then(() => { closed = true; }, () => { closed = true; });
  const kill = () => {
    if (closed) return;
    child.kill("SIGTERM");
    setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 2000).unref();
  };
  return { done, kill, output: () => ({ stdout, stderr }) };
}

async function finish(child: { done: Promise<ChildResult>; output: () => { stdout: string; stderr: string } }): Promise<ChildResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const { stdout, stderr } = child.output();
      reject(new Error(`child did not exit within 45s\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 45_000);
    timer.unref();
  });
  try { return await Promise.race([child.done, timeout]); } finally { if (timer) clearTimeout(timer); }
}

async function createSession(name: string, body: Record<string, unknown>): Promise<string> {
  const created = await bridgeApiFetch("POST", "/api/sessions", { body: { name, ...body } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = (created.body as { session?: { id?: string } }).session?.id;
  expect(id).toBeTruthy();
  return id!;
}

async function sessionStatus(id: string): Promise<string> {
  const got = await bridgeApiFetch("GET", `/api/sessions/${id}`);
  return (got.body as { session?: { status?: string } }).session?.status ?? "";
}

async function openAttention(sessionId: string): Promise<AttentionEvent[]> {
  const listed = await bridgeApiFetch("GET", `/api/sessions/${sessionId}/attention`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return (listed.body as { events?: AttentionEvent[] }).events ?? [];
}

async function selectSession(page: Page, name: string): Promise<void> {
  const workspace = page.getByRole("tab", { name: "Workspace", exact: true });
  if (await workspace.isVisible()) await workspace.click();
  await page.locator("#dashboard-sidebar button[draggable='true']").filter({ has: page.getByText(name, { exact: true }) }).getByText(name, { exact: true }).click();
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("parent overview lists a child question, opens it, and the child receives the answer", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await waitForBridgeOnline(page);

  const suffix = Date.now().toString(36);
  const parentName = `Overview parent ${suffix}`;
  const childName = `Overview child ${suffix}`;
  const question = "Which database should the service use?";
  let parentId = "";
  let childId = "";
  let waiter: ReturnType<typeof startWaiter> | undefined;

  try {
    parentId = await createSession(parentName, { shellType: "codex", command: runningParentCommand() });
    await expect.poll(() => sessionStatus(parentId), { timeout: 30_000 }).toBe("running");
    childId = await createSession(childName, { shellType: "shell", parentSessionId: parentId });
    waiter = startWaiter(childId, ["--title", "Database", "--message", question, "--option", "Postgres", "--option", "SQLite", "--wait", "--timeout", "120"]);

    let eventId = "";
    const deadline = Date.now() + 20_000;
    let last = "";
    while (!eventId && Date.now() < deadline) {
      const events = await openAttention(childId);
      last = JSON.stringify(events);
      const open = events.find(event => !event.resolvedAt);
      if (open?.route === "human") {
        throw new Error(`child question routed to human; parent must be a running non-shell session\n${last}\nstderr: ${waiter.output().stderr}`);
      }
      if (open?.route === "parent" && open.id) eventId = open.id;
      else {
        if (waiter.output().stderr.includes("Error")) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    if (!eventId) throw new Error(`parent-routed question was not stored within 20s\n${last}\nstderr: ${waiter.output().stderr}`);

    await selectSession(page, parentName);
    const overview = page.getByRole("region", { name: `Overview: ${parentName}` });
    await expect(overview).toBeVisible({ timeout: 30_000 });
    const panel = overview.getByRole("region", { name: "Child attention requests" });
    await expect(panel).toContainText(childName);
    await expect(panel).toContainText("Waiting on coordinator");
    await expect(panel).toContainText("Database");
    await expect(panel.getByRole("button", { name: "Send answer" })).toHaveCount(0);

    await overview.getByRole("button", { name: childName, exact: true }).click();
    const questionButton = overview.locator(`[data-attention-open="${eventId}"]`);
    await expect(questionButton).toBeVisible();
    await expect(questionButton).toContainText("Database");
    await expect(questionButton).toContainText(`with ${parentName}`);
    await expect(questionButton).toContainText("Postgres / SQLite");
    await questionButton.click();

    await expect(panel.getByRole("button", { name: "Send answer" })).toBeVisible();
    await expect(panel.getByText(question)).toBeVisible();
    await expect(panel.getByRole("radio", { name: /^SQLite/ })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBe(parentId);
    await expect.poll(() => new URL(page.url()).searchParams.get("attention")).toBe(eventId);
    await shot(page, testInfo, "attention-overview-desktop");

    await page.setViewportSize({ width: 320, height: 844 });
    await page.reload();
    const mobileOverview = page.getByRole("region", { name: `Overview: ${parentName}` });
    await expect(mobileOverview).toBeVisible({ timeout: 30_000 });
    const mobilePanel = mobileOverview.getByRole("region", { name: "Child attention requests" });
    await expect(mobilePanel.getByRole("button", { name: "Send answer" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await mobilePanel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await shot(page, testInfo, "attention-overview-mobile");

    await mobilePanel.getByRole("radio", { name: /^SQLite/ }).check();
    await mobilePanel.getByRole("button", { name: "Send answer" }).click();
    await expect(mobilePanel.getByRole("button", { name: "Send answer" })).toHaveCount(0);

    const result = await finish(waiter);
    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain("A: SQLite");
    expect(result.stdout).not.toContain("A: Postgres");

    const stored = await bridgeApiFetch("GET", `/api/sessions/${childId}/attention/${eventId}`);
    expect(stored.status, JSON.stringify(stored.body)).toBe(200);
    const event = (stored.body as { event: AttentionEvent }).event;
    expect(event.route).toBe("parent");
    expect(event.resolution).toBe("answered");
    expect(event.answeredBy).toMatchObject({ kind: "human" });
    expect(event.answer?.answers).toEqual([{ selected: [1] }]);
  } finally {
    waiter?.kill();
    await waiter?.done.catch(() => undefined);
    if (childId) await bridgeApiFetch("DELETE", `/api/sessions/${childId}`).catch(() => undefined);
    if (parentId) await bridgeApiFetch("DELETE", `/api/sessions/${parentId}`).catch(() => undefined);
  }
});
