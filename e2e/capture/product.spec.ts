import { expect, type BrowserContext, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { test } from "../helpers/fixtures";
import { login, makeUser, registerUser } from "../helpers/app";
import { approveAccountComputer, startAccountTestBridge, usePrivateApprovalLink, type AccountTestBridge } from "../helpers/account-pairing";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { E2E_DIR } from "../helpers/config";
import { recordVideo, type Video } from "./record-video";
import { AI_MODEL, AI_NAME, DEMO_WORKSPACE, INITIAL_PROMPT, prepareDemo, provisionCodex, removeDemo, verifyDemo, waitForTurn } from "./ai-demo";

const origin = process.env.FTOWN_PUBLIC_URL ?? "https://localhost:8444";
const names = [AI_NAME, "Review test results", "Explore workspace"] as const;
const repo = resolve(E2E_DIR, "..");
const sharp = createRequire(join(repo, "ui/package.json"))("sharp");

type Variant = { src: string; width: number; height: number; bytes: number };
type Capture = { src: string; width: number; height: number; variants: Variant[] };

async function outputDirectory(): Promise<string> {
  const requested = process.env.FTOWN_CAPTURE_DIR;
  if (!requested || !isAbsolute(requested)) throw new Error("FTOWN_CAPTURE_DIR must be an absolute staging directory outside the checkout");
  const root = await realpath(repo);
  const outside = (path: string) => {
    const rel = relative(root, path);
    return Boolean(rel && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)));
  };
  const target = resolve(requested);
  if (!outside(target)) throw new Error("FTOWN_CAPTURE_DIR must be outside the checkout");
  let ancestor = target;
  for (;;) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  if (!outside(ancestor)) throw new Error("FTOWN_CAPTURE_DIR resolves inside the checkout");
  await mkdir(target, { recursive: true });
  const directory = await realpath(target);
  if (!outside(directory)) throw new Error("FTOWN_CAPTURE_DIR resolves inside the checkout");
  return directory;
}

function sessionRow(page: Page, name: string) {
  return page.locator('#dashboard-sidebar button[draggable="true"]').filter({ has: page.getByText(name, { exact: true }) });
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function openWorkspace(page: Page) {
  const workspace = page.getByRole("button", { name: "Workspace", exact: true });
  if (await workspace.isVisible()) await workspace.click();
}
async function openAgent(page: Page) {
  await openWorkspace(page);
  const row = sessionRow(page, names[0]);
  await expect(row).toBeVisible({ timeout: 45_000 });
  await row.click();
  await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 45_000 });
}
async function followUp(page: Page, home: string, previous: number, prompt: string): Promise<number> {
  await page.locator(".xterm").first().click();
  await page.keyboard.type(prompt, { delay: 45 });
  await page.keyboard.press("Enter");
  return waitForTurn(page, home, previous, 55_000, prompt);
}

async function exportImages(directory: string): Promise<Record<string, Capture>> {
  const definitions = [
    { key: "desktop", stem: "desktop-workspace", master: "desktop.png", widths: [640, 1120, 2240] },
    { key: "mobile", stem: "mobile-terminal", master: "mobile.png", widths: [390, 780] },
    { key: "security", stem: "device-access", master: "security.png", widths: [] },
  ] as const;
  let images: Record<string, Capture> = {};
  let largestBytes = 0;
  for (const quality of [90, 85, 80]) {
    images = {}; largestBytes = 0;
    for (const definition of definitions) {
      const input = join(directory, definition.master);
      const metadata = await sharp(input).metadata();
      if (!metadata.width || !metadata.height) throw new Error(`Invalid screenshot: ${definition.master}`);
      const widths: number[] = definition.key === "security"
        ? [...new Set([Math.min(896, metadata.width), metadata.width])].sort((a, b) => a - b)
        : [...definition.widths];
      if (widths.some(width => width > metadata.width)) throw new Error(`Capture too small: ${definition.master}`);
      const variants: Variant[] = [];
      for (const width of widths) {
        const filename = `${definition.stem}-${width}.webp`;
        const destination = join(directory, filename);
        const info = await sharp(input).resize({ width, withoutEnlargement: true }).webp({ quality }).toFile(destination);
        variants.push({ src: `/product/${filename}`, width: info.width, height: info.height, bytes: (await stat(destination)).size });
      }
      const largest = variants[variants.length - 1];
      largestBytes += largest.bytes;
      images[definition.key] = { src: largest.src, width: largest.width, height: largest.height, variants };
    }
    if (largestBytes <= 750 * 1024) break;
  }
  if (largestBytes > 2 * 1024 * 1024) throw new Error("Largest WebP variants exceed the 2 MiB hard limit");
  return images;
}

// Deliberate viewing holds give people time to see each real state.
const hold = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const holdResult = (startedAt: number) => hold(Math.max(2500, 12_000 - (performance.now() - startedAt)));

test("capture real isolated workspace, phone and access panel", async ({ browser }) => {
  const directory = await outputDirectory();
  const user = makeUser("demo");
  await registerUser(user.email, user.password);
  const contexts: BrowserContext[] = [];
  const sessions: string[] = [];
  let bridge: AccountTestBridge | undefined;
  let demoOwned = false;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let images: Record<string, Capture> | undefined;
  let videos: { desktop: Video; mobile: Video } | undefined;
  try {
    const desktopContext = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    contexts.push(desktopContext);
    const desktop = await desktopContext.newPage();
    await login(desktop, user.email, user.password, { pairBridge: false });
    bridge = await startAccountTestBridge(origin);
    const bridgeId = await approveAccountComputer(desktop, bridge);
    await expect(desktop.locator(`[data-bridge-row="${bridgeId}"]`)).toContainText("demo-workstation");

    const phoneContext = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    contexts.push(phoneContext);
    const phone = await phoneContext.newPage();
    await login(phone, user.email, user.password, { pairBridge: false });
    await usePrivateApprovalLink(phone);
    await phone.getByRole("textbox", { name: "Device name", exact: true }).fill("Demo phone");
    await phone.getByRole("button", { name: "Create approval link", exact: true }).click();
    const privateLink = await phone.getByRole("textbox", { name: "Private approval link", exact: true }).inputValue();
    const comparison = await phone.getByLabel("Comparison code", { exact: true }).textContent();
    try { await desktop.goto(privateLink); } catch { throw new Error("Private device approval navigation failed"); }
    await expect(desktop).toHaveURL(`${origin}/devices/approve`);
    const desktopCode = await desktop.getByLabel("Comparison code", { exact: true }).textContent();
    expect(Boolean(comparison && desktopCode && comparison === desktopCode)).toBe(true);
    await desktop.getByRole("button", { name: "Codes match — approve device", exact: true }).click();
    await expect(desktop.getByText(/Device approved\. It can now finish connecting/)).toBeVisible({ timeout: 45_000 });
    await expect(phone.locator(`[data-bridge-row="${bridgeId}"]`)).toBeVisible({ timeout: 60_000 });
    await desktop.goto("/dashboard");
    await expect(desktop.locator(`[data-bridge-row="${bridgeId}"]`)).toBeVisible({ timeout: 45_000 });

    await prepareDemo();
    demoOwned = true;
    await provisionCodex(bridge.home, directory);
    const agent = await bridgeApiFetch("POST", "/api/sessions", { bridgeHome: bridge.home, body: {
      shellType: "codex", model: AI_MODEL, name: AI_NAME, workingDir: DEMO_WORKSPACE, prompt: INITIAL_PROMPT,
    } });
    expect(agent.status).toBe(201);
    const agentSession = (agent.body as { session?: { id?: string; shellType?: string; model?: string } }).session;
    expect(agentSession?.id).toBeTruthy();
    sessions.push(agentSession!.id!);
    expect(agentSession?.shellType).toBe("codex");
    expect(agentSession?.model).toBe(AI_MODEL);
    for (const name of names.slice(1)) {
      const result = await bridgeApiFetch("POST", "/api/sessions", { bridgeHome: bridge.home, body: { shellType: "shell", name } });
      expect(result.status).toBe(201);
      const id = (result.body as { session?: { id?: string; bridgeId?: string } }).session?.id;
      expect(id).toBeTruthy();
      sessions.push(id!);
    }
    await openAgent(desktop);
    let turns = await waitForTurn(desktop, bridge.home, 0);
    await verifyDemo();
    const attention = await bridgeApiFetch("POST", `/api/sessions/${sessions[0]}/attention`, {
      bridgeHome: bridge.home, body: { title: "Review formatter", message: "Four formatter tests passed. Review the change." },
    });
    expect(attention.status).toBe(200);
    const region = desktop.getByRole("region", { name: "Needs attention", exact: true });
    await expect(region.getByRole("button", { name: /^Build duration formatter: Review formatter/ })).toBeVisible({ timeout: 30_000 });
    for (const name of names) await expect(sessionRow(desktop, name)).toBeVisible();
    await expect(sessionRow(desktop, AI_NAME).getByRole("img", { name: "Codex agent", exact: true })).toBeVisible();
    await noOverflow(desktop);
    await desktop.evaluate(() => document.fonts.ready);
    await desktop.screenshot({ path: join(directory, "desktop.png"), animations: "disabled" });

    await desktop.setViewportSize({ width: 1280, height: 900 });
    await desktop.getByRole("button", { name: "Open security", exact: true }).click();
    const dialog = desktop.getByRole("dialog", { name: "Security", exact: true });
    await expect(dialog.getByRole("tab", { name: "Access", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("heading", { name: "Your computers", exact: true })).toBeVisible();
    await expect(dialog.locator(`[data-computer-access="${bridgeId}"]`)).toContainText("Shared with your approved browsers", { timeout: 60_000 });
    await expect(dialog.locator(`[data-access-edge="bridge:${bridgeId}"]`)).toHaveAttribute("data-certainty", "current");
    await expect(dialog.getByRole("list", { name: "Account devices", exact: true })).toContainText("Demo phone");
    await expect(dialog.getByRole("button", { name: /\(this browser\):/ })).toBeVisible();
    await expect.poll(() => dialog.evaluate(element => !element.getAnimations({ subtree: true }).some(animation => animation instanceof CSSTransition && animation.playState === "running")), { timeout: 5_000 }).toBe(true);
    await noOverflow(desktop);
    await dialog.screenshot({ path: join(directory, "security.png"), animations: "disabled" });
    await dialog.getByRole("button", { name: "Close security", exact: true }).click();
    await desktop.setViewportSize({ width: 1280, height: 800 });
    await expect(desktop).toHaveURL(`${origin}/dashboard`);
    await expect(phone).toHaveURL(`${origin}/dashboard`);
    await expect(region.getByRole("button", { name: /^Build duration formatter: Review formatter/ })).toBeVisible();
    await openAgent(desktop);
    await waitForTurn(desktop, bridge.home, 0);
    let desktopPhase = "initial view";
    let desktopVideo: Video;
    try {
    desktopVideo = await recordVideo(desktop, directory, "desktop-workspace", { width: 1280, height: 800 }, async () => {
      const startedAt = performance.now();
      await hold(1800);
      desktopPhase = "follow-up response";
      turns = await followUp(desktop, bridge!.home, turns, "Why are minutes padded after an hour? Answer briefly.");
      desktopPhase = "completed response";
      await holdResult(startedAt);
    });
    } catch (error) { throw new Error(`Desktop walkthrough failed at phase: ${desktopPhase}`, { cause: error }); }
    await desktopContext.close();
    contexts.splice(contexts.indexOf(desktopContext), 1);

    const touchControls = phone.locator(".touch-control-bar");
    await openWorkspace(phone);
    for (const name of names) await expect(sessionRow(phone, name)).toBeVisible();
    let mobilePhase = "workspace";
    let mobileVideo: Video;
    try {
      mobileVideo = await recordVideo(phone, directory, "mobile-terminal", { width: 390, height: 844 }, async () => {
        const startedAt = performance.now();
        await hold(2200);
        await openAgent(phone);
        await expect(phone.getByRole("button", { name: "Terminal", exact: true })).toHaveClass(/mobile-tab-active/);
        await hold(1200);
        mobilePhase = "clear terminal view";
        await phone.locator(".xterm").first().click();
        await phone.keyboard.press("Control+L");
        mobilePhase = "follow-up response";
        turns = await followUp(phone, bridge!.home, turns, "Summarize the fix and test results in three short bullets.");
        mobilePhase = "touch controls";
        await expect(touchControls).toBeVisible();
        await expect(touchControls.getByRole("button", { name: "Show keyboard", exact: true })).toBeVisible();
        await expect(touchControls.getByRole("button", { name: "Paste clipboard into terminal", exact: true })).toBeVisible();
        await holdResult(startedAt);
      });
    } catch (error) {
      throw new Error(`Mobile walkthrough failed at phase: ${mobilePhase}`, { cause: error });
    }
    await noOverflow(phone);
    await phone.evaluate(() => document.fonts.ready);
    await phone.screenshot({ path: join(directory, "mobile.png"), animations: "disabled" });
    videos = { desktop: desktopVideo, mobile: mobileVideo };
    await verifyDemo();
    images = await exportImages(directory);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    const failures: string[] = [];
    if (bridge) for (const id of sessions.reverse()) {
      try {
        const result = await bridgeApiFetch("DELETE", `/api/sessions/${id}`, { bridgeHome: bridge.home });
        if (result.status < 200 || result.status >= 300) failures.push("session");
      } catch { failures.push("session"); }
    }
    for (const context of contexts.reverse()) try { await context.close(); } catch { failures.push("browser context"); }
    if (bridge) try { await bridge.stop(); } catch { failures.push("account bridge"); }
    if (demoOwned) try { await removeDemo(); } catch { failures.push("demo workspace"); }
    if (failures.length) {
      const cleanupError = new Error(`Capture cleanup failed: ${failures.join(", ")}`);
      if (hasPrimaryError) throw new AggregateError([primaryError, cleanupError], "Capture failed and cleanup also failed", { cause: primaryError });
      throw cleanupError;
    }
  }
  if (hasPrimaryError) throw primaryError;
  if (!images || !videos) throw new Error("Capture assets are incomplete");
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify({ version: 2, images, videos }, null, 2)}\n`, { flag: "wx" });
});
