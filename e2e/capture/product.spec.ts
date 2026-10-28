import { expect, type BrowserContext, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { test } from "../helpers/fixtures";
import { login, makeUser, registerUser } from "../helpers/app";
import { approveAccountComputer, startAccountTestBridge, usePrivateApprovalLink, type AccountTestBridge } from "../helpers/account-pairing";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { E2E_DIR } from "../helpers/config";
import { recordScenes, recordVideo, type Video } from "./record-video";
import { AI_MODEL, AI_NAME, DELEGATION_PROMPT, DEMO_WORKSPACE, INITIAL_PROMPT, PiProofDiagnosticError, findParentSynthesis, prepareDemo, provisionCodex, removeDemo, verifyChildTranscripts, verifyDemo, verifyParentCreation, verifyParentMailQuality, waitForTurn, type FleetMail, type FleetSession } from "./ai-demo";

const origin = process.env.FTOWN_PUBLIC_URL ?? "https://localhost:8444";
const names = [AI_NAME, "Claude review", "Pi test check"] as const;
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
async function expandChildren(page: Page) {
  await openWorkspace(page);
  const toggle = sessionRow(page, AI_NAME).getByRole("button", { name: /^(Expand|Collapse) children$/ });
  await expect(toggle).toBeVisible({ timeout: 45_000 });
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
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
  await page.keyboard.type(prompt, { delay: 12 });
  await page.keyboard.press("Enter");
  return waitForTurn(page, home, previous, 55_000, prompt);
}
async function showChildResult(page: Page, name: string, body: string) {
  await expandChildren(page);
  await sessionRow(page, name).click();
  const terminal = page.locator(".xterm").first();
  await expect(terminal).toBeVisible();
  const words = body.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ");
  await expect.poll(async () => {
    const screen = (await page.locator(".xterm-rows").first().textContent() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return words.some((_, index) => {
      const phrase = words.slice(index, index + 4).join("");
      return index + 4 <= words.length && phrase.length >= 15 && screen.includes(phrase);
    });
  }, { timeout: 20_000, message: `Actual ${name} result was not visible in its terminal` }).toBe(true);
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
    await openAgent(desktop);
    let turns = await waitForTurn(desktop, bridge.home, 0);
    await verifyDemo();
    const initialSessions = await bridgeApiFetch("GET", "/api/sessions", { bridgeHome: bridge.home });
    expect(initialSessions.status).toBe(200);
    const initialList = (initialSessions.body as { sessions?: FleetSession[] }).sessions ?? [];
    expect(initialList.map(item => item.id)).toEqual([sessions[0]]);
    await expect(sessionRow(desktop, AI_NAME).getByRole("img", { name: "Codex agent", exact: true })).toBeVisible();
    await noOverflow(desktop);

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
    await openAgent(desktop);
    await waitForTurn(desktop, bridge.home, 0);
    let desktopPhase = "initial view";
    let desktopVideo: Video;
    let children: FleetSession[] = [];
    let replies: FleetMail[] = [];
    let claudeModel = "";
    const initialTurnCount = turns;
    let synthesisTurn: number | undefined;
    try {
    desktopVideo = await recordScenes(desktop, directory, "desktop-workspace", { width: 1280, height: 800 }, [{ record: async () => {
      const startedAt = performance.now();
      await hold(1800);
      desktopPhase = "parent creates children";
      await desktop.locator(".xterm").first().click();
      await desktop.keyboard.type(DELEGATION_PROMPT, { delay: 12 });
      await desktop.keyboard.press("Enter");
      await expandChildren(desktop);
      for (const name of names.slice(1)) await expect(sessionRow(desktop, name)).toBeVisible({ timeout: 45_000 });
      await holdResult(startedAt);
    } }, { before: async () => {
      desktopPhase = "child identities and replies";
      await expect.poll(async () => {
        const result = await bridgeApiFetch("GET", "/api/sessions", { bridgeHome: bridge!.home });
        const list = (result.body as { sessions?: FleetSession[] }).sessions ?? [];
        children = list.filter(item => item.parentSessionId === sessions[0]);
        return result.status === 200 && children.length === 2 && children.some(item => item.name === names[1] && item.shellType === "claude" && item.model === "sonnet" && item.bridgeId === bridgeId) && children.some(item => item.name === names[2] && item.shellType === "pi" && item.model === "openai/gpt-6.1-terra:xhigh" && item.bridgeId === bridgeId);
      }, { timeout: 120_000, intervals: [1000] }).toBe(true);
      await expect.poll(async () => {
        const result = await bridgeApiFetch("GET", `/api/sessions/${sessions[0]}/inbox?peek=1&all=1`, { bridgeHome: bridge!.home });
        replies = ((result.body as { messages?: FleetMail[] }).messages ?? []).filter(mail => mail.type === "result" && mail.to === sessions[0] && children.some(child => child.id === mail.from) && mail.body.trim().length >= 20);
        return result.status === 200 && replies.length === 2 && new Set(replies.map(mail => mail.from)).size === 2;
      }, { timeout: 120_000, intervals: [1000] }).toBe(true);
      let childDiagnostic = "native transcript unavailable or unsupported";
      try { await expect.poll(async () => {
        const result = await bridgeApiFetch("GET", "/api/sessions", { bridgeHome: bridge!.home });
        children = ((result.body as { sessions?: FleetSession[] }).sessions ?? []).filter(item => item.parentSessionId === sessions[0]);
        try { claudeModel = await verifyChildTranscripts(bridge!.home, children.find(item => item.name === names[1])!, children.find(item => item.name === names[2])!, replies); return true; }
        catch (error) {
          const safe = error instanceof Error ? error.message : "";
          if (error instanceof PiProofDiagnosticError) childDiagnostic = error.message;
          if (["Child native session identities are missing", "Pi transcript is outside the scratch home", "Claude Sonnet completion or successful mail tool trace missing", "Pi Terra xhigh completion, passing native test, or successful mail tool trace missing"].includes(safe)) childDiagnostic = safe;
          return false;
        }
      }, { timeout: 30_000, intervals: [1000], message: "Child native completion or mail trace missing" }).toBe(true); }
      catch (error) { throw new Error(`Child proof failed: ${childDiagnostic}`, { cause: error }); }
      desktopPhase = "parent completes delegation turn";
      turns = await waitForTurn(desktop, bridge!.home, turns, 55_000, DELEGATION_PROMPT);
      await verifyParentCreation(bridge!.home, children);
      const inbox = await bridgeApiFetch("GET", `/api/sessions/${sessions[0]}/inbox?peek=1&all=1`, { bridgeHome: bridge!.home });
      if (inbox.status !== 200) throw new Error("Parent inbox unavailable");
      const all = (inbox.body as { messages?: FleetMail[] }).messages ?? [];
      replies = replies.map(reply => all.find(mail => mail.id === reply.id) ?? reply);
      synthesisTurn = await findParentSynthesis(bridge!.home, replies, initialTurnCount);
    }, record: async () => {
      const startedAt = performance.now();
      desktopPhase = "show child replies";
      for (const child of children) { await showChildResult(desktop, child.name, replies.find(mail => mail.from === child.id)!.body); await hold(3500); }
      await openAgent(desktop);
      desktopPhase = "show parent synthesis";
      if (synthesisTurn === undefined) {
        const previous = turns;
        turns = await followUp(desktop, bridge!.home, previous, 'Use the child results already received through hooks or earlier reads. Only if a needed reply has not been received, read mail with "$HOME/.ftown/ftown" harness mail read; then summarize each child\'s actual finding in two short bullets.');
        await expect.poll(async () => {
          const result = await bridgeApiFetch("GET", `/api/sessions/${sessions[0]}/inbox?peek=1&all=1`, { bridgeHome: bridge!.home });
          const all = (result.body as { messages?: FleetMail[] }).messages ?? [];
          const delivered = replies.map(reply => all.find(mail => mail.id === reply.id && Boolean(mail.deliveredAt)));
          if (result.status === 200 && delivered.every(Boolean)) replies = delivered as FleetMail[];
          return result.status === 200 && delivered.every(Boolean);
        }, { timeout: 30_000 }).toBe(true);
        synthesisTurn = await findParentSynthesis(bridge!.home, replies, previous);
        if (synthesisTurn === undefined) throw new Error("Parent synthesis does not establish both delivered replies");
      } else {
        turns = await waitForTurn(desktop, bridge!.home, synthesisTurn - 1, 20_000, DELEGATION_PROMPT);
      }
      await holdResult(startedAt);
    } }]);
    await desktop.evaluate(() => document.fonts.ready);
    await desktop.screenshot({ path: join(directory, "desktop.png"), animations: "disabled" });
    await verifyParentMailQuality(bridge.home);
    } catch (error) {
      const detail = error instanceof Error && error.message.startsWith("Child proof failed: ") ? `; ${error.message}` : "";
      throw new Error(`Desktop walkthrough failed at phase: ${desktopPhase}${detail}`, { cause: error });
    }
    await desktopContext.close();
    contexts.splice(contexts.indexOf(desktopContext), 1);

    const touchControls = phone.locator(".touch-control-bar");
    await openWorkspace(phone);
    await expandChildren(phone);
    for (const name of names) await expect(sessionRow(phone, name)).toBeVisible();
    let mobilePhase = "workspace";
    let mobileVideo: Video;
    try {
      mobileVideo = await recordVideo(phone, directory, "mobile-terminal", { width: 390, height: 844 }, async () => {
        const startedAt = performance.now();
        await hold(2200);
        for (const child of children) { await showChildResult(phone, child.name, replies.find(mail => mail.from === child.id)!.body); await hold(2000); await openWorkspace(phone); }
        await openAgent(phone);
        await expect(phone.getByRole("button", { name: "Terminal", exact: true })).toHaveClass(/mobile-tab-active/);
        await hold(1200);
        mobilePhase = "clear terminal view";
        await phone.locator(".xterm").first().click();
        await phone.keyboard.press("Control+L");
        mobilePhase = "follow-up response";
        turns = await followUp(phone, bridge!.home, turns, "Summarize the Claude review and Pi test check replies in two short bullets.");
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
    const mailQuality = await verifyParentMailQuality(bridge.home);
    await writeFile(join(directory, "fleet-proof.json"), JSON.stringify({ parent: sessions[0], children: children.map(({ id, name, shellType, model, parentSessionId }) => ({ id, name, shellType, model, parentSessionId })), claudeModel, replies: replies.map(({ id, from, to, ts, deliveredAt, body }) => ({ id, from, to, ts, deliveredAt, bodySha256: createHash("sha256").update(body).digest("hex") })), mailQuality, checks: ["parent-create-tool-results", "child-native-provider-and-mail-tool-results", "parent-delivered-mail-and-synthesis", "parent-mail-quality-through-mobile"] }, null, 2), { flag: "wx", mode: 0o600 });
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
    // The parent is stopped first so it cannot create another child during the
    // final inventory. The bridge and every session on it belong to this test.
    if (bridge && sessions.length) try {
      const inventory = await bridgeApiFetch("GET", "/api/sessions", { bridgeHome: bridge.home });
      if (inventory.status !== 200) throw new Error("inventory failed");
      for (const child of (inventory.body as { sessions?: FleetSession[] }).sessions ?? []) {
        const result = await bridgeApiFetch("DELETE", `/api/sessions/${child.id}`, { bridgeHome: bridge.home });
        if (result.status < 200 || result.status >= 300) throw new Error("child removal failed");
      }
      const remaining = await bridgeApiFetch("GET", "/api/sessions", { bridgeHome: bridge.home });
      if (remaining.status !== 200 || ((remaining.body as { sessions?: FleetSession[] }).sessions ?? []).length) throw new Error("sessions remain");
    } catch { failures.push("descendant sessions"); }
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
