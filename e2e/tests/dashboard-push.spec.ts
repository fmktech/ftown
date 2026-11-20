import { spawn } from "node:child_process";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { BRIDGE_HOME, E2E_DIR } from "../helpers/config";

const FTOWN_CLI = join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js");
interface CliResult { code: number | null; stdout: string; stderr: string }

function startCli(sessionId: string, args: string[]) {
  const child = spawn(process.execPath, [FTOWN_CLI, ...args], {
    env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: sessionId }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", closed = false;
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const done = new Promise<CliResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
  void done.then(() => { closed = true; }, () => { closed = true; });
  const kill = () => {
    if (closed) return;
    child.kill("SIGTERM");
    setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 2000).unref();
  };
  const finish = async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([done, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { kill(); reject(new Error(`CLI did not exit within 45s\n${stdout}\n${stderr}`)); }, 45_000);
        timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  return { done, kill, finish };
}

async function createSession(name: string, extra: Record<string, unknown>): Promise<string> {
  const created = await bridgeApiFetch("POST", "/api/sessions", { body: { projectName: "E2E", name, ...extra } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = (created.body as { session?: { id?: string } }).session?.id;
  expect(id).toBeTruthy(); return id!;
}

function sessionRow(page: Page, name: string) {
  return page.locator("#dashboard-sidebar button[draggable='true']")
    .filter({ has: page.getByText(name, { exact: true }) });
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

test("connected dashboard receives external session changes, plan changes, and new child attention", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await waitForBridgeOnline(page);
  const suffix = Date.now().toString(36);
  const parentName = `Push parent ${suffix}`, childName = `Push child ${suffix}`;
  const planTitle = `Live plan ${suffix}`, attentionTitle = `Live question ${suffix}`;
  let parentId = "", childId = "", externalId = "";
  const processes: ReturnType<typeof startCli>[] = [];
  const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  try {
    // The custom persistent process uses no model or provider credentials. A
    // non-shell parent keeps child questions routed to the coordinator.
    parentId = await createSession(parentName, { shellType: "codex",
      command: `${shellQuote(process.execPath)} -e ${shellQuote("setInterval(() => {}, 1e9)")}` });
    await expect(sessionRow(page, parentName)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => {
      const result = await bridgeApiFetch("GET", `/api/sessions/${parentId}`);
      return (result.body as { session?: { status?: string } }).session?.status;
    }, { timeout: 30_000 }).toBe("running");
    childId = await createSession(childName, { shellType: "shell", parentSessionId: parentId });
    await sessionRow(page, parentName).getByText(parentName, { exact: true }).click();
    const overview = page.getByRole("region", { name: `Overview: ${parentName}` });
    await expect(overview).toBeVisible({ timeout: 20_000 });
    await expect(overview.getByRole("button", { name: childName, exact: true })).toBeVisible({ timeout: 20_000 });
    const planned = overview.getByRole("region", { name: "planned", exact: true });
    await expect(planned).toHaveCount(0);

    // Mutate after Overview is already loaded: initial hydration cannot make
    // this assertion pass. The plan is carried by board publications.
    const plan = startCli(parentId, ["plan", "add", planTitle, "--note", "Created after Overview opened", "--session-id", parentId, "--json"]);
    processes.push(plan);
    const planResult = await plan.finish();
    expect(planResult.code, `${planResult.stderr}\n${planResult.stdout}`).toBe(0);
    const planSummary = planned.getByRole("button", { name: /^planned ·/ });
    await expect(planSummary).toContainText(planTitle, { timeout: 12_000 });
    await expect(planSummary).toHaveAttribute("aria-expanded", "false");
    await planSummary.click();
    await expect(planSummary).toHaveAttribute("aria-expanded", "true");
    await expect(planned.getByText(planTitle, { exact: true })).toBeVisible();

    const waiter = startCli(childId, ["sessions", "attention", "--title", attentionTitle,
      "--message", "Choose the live push result.", "--option", "Verified", "--option", "Retry", "--wait", "--timeout", "90"]);
    processes.push(waiter);
    const panel = overview.getByRole("region", { name: "Child attention requests" });
    await expect(panel).toContainText(attentionTitle, { timeout: 12_000 });
    await expect(panel).toContainText("Waiting on coordinator");
    const item = panel.locator("[data-child-attention]").filter({ hasText: attentionTitle });
    const questionSummary = item.getByRole("button", { name: new RegExp(attentionTitle) });
    await expect(questionSummary).toHaveAttribute("aria-expanded", "false");
    await questionSummary.click();
    await expect(questionSummary).toHaveAttribute("aria-expanded", "true");
    await item.getByRole("radio", { name: /^Verified/ }).check();
    await item.getByRole("button", { name: "Send answer" }).click();
    const answered = await waiter.finish();
    expect(answered.code, `${answered.stderr}\n${answered.stdout}`).toBe(0);
    expect(answered.stdout).toContain("A: Verified");

    const externalName = `External push ${suffix}`, renamedName = `Renamed push ${suffix}`;
    externalId = await createSession(externalName, { shellType: "shell" });
    await expect(sessionRow(page, externalName)).toBeVisible({ timeout: 12_000 });
    const renamed = await bridgeApiFetch("PATCH", `/api/sessions/${externalId}`, { body: { name: renamedName } });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    await expect(sessionRow(page, renamedName)).toBeVisible({ timeout: 12_000 });
    await expect(sessionRow(page, externalName)).toHaveCount(0);
    const removed = await bridgeApiFetch("DELETE", `/api/sessions/${externalId}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    await expect(sessionRow(page, renamedName)).toHaveCount(0, { timeout: 12_000 });
    externalId = "";
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentTimeOrigin);
    await expect(overview).toBeVisible();
    await testInfo.attach("dashboard-live-push", { body: await overview.screenshot(), contentType: "image/png" });
  } finally {
    for (const process of processes) process.kill();
    await Promise.all(processes.map(process => process.done.catch(() => undefined)));
    for (const id of [externalId, childId, parentId]) if (id) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined);
  }
});
