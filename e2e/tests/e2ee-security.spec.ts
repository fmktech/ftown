import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { join, resolve } from "node:path";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createShellSession, E2E_PASSWORD, login, openSession, runMarkerInTerminal, sharedEmail, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch, readBridgePointer, type BridgePointer } from "../helpers/bridge-api";
import { browserEndpointId, pairBrowser } from "../helpers/secure-browser";
import { sessionIdsFor, waitForNewSessionId } from "../helpers/centrifugo";
import { BRIDGE_HOME, E2E_DIR } from "../helpers/config";

test.setTimeout(180000);
const secondHome = process.env.E2E_SECOND_BRIDGE_HOME ?? join(E2E_DIR, ".bridge-home-2");
async function openSecurity(page: Page) {
  // The dashboard mounts after the browser identity opens. Checking visibility
  // before then can mistake a not-yet-rendered mobile menu for desktop.
  const actions = page.locator("#dashboard-navigation");
  await expect(actions).toBeAttached({ timeout: 30_000 });
  const mobile = await page.evaluate(() => window.matchMedia("(max-width: 767px)").matches);
  if (mobile) {
    const navigation = page.getByRole("button", { name: /^(Open|Close) navigation menu$/ });
    await expect(navigation).toBeVisible({ timeout: 30_000 });
    if (await navigation.getAttribute("aria-expanded") !== "true") await navigation.click();
  }
  await expect(actions).toBeVisible({ timeout: 30_000 });
  const security = actions.getByRole("button", { name: "Open security", exact: true });
  await expect(security).toBeVisible();
  await security.click();
}
async function waitForSecurityLayout(page: Page, width: number) {
  await expect.poll(() => page.getByRole("dialog", { name: "Security", exact: true }).evaluate((element, mobile) => {
    const transitioning = element.getAnimations({ subtree: true }).some(animation => animation instanceof CSSTransition && animation.playState === "running");
    const controls = [...element.querySelectorAll<HTMLElement>("button,select,summary")].filter(control => control.checkVisibility());
    return !transitioning && document.documentElement.scrollWidth <= innerWidth && controls.length > 0 && (!mobile || controls.every(control => control.getBoundingClientRect().height >= 44));
  }, width < 640), { timeout: 2000, intervals: [25, 50, 100], message: "Security responsive transitions and control geometry must settle" }).toBe(true);
}

async function openSeparateApprovals(page: Page, bridgeId: string) {
  const card = page.locator(`[data-computer-access="${bridgeId}"]`);
  if (await card.count()) {
    await card.click();
    const disclosure = page.locator(`[data-computer-details="${bridgeId}"]`).getByText("Separate approvals and recovery", { exact: true });
    if (await disclosure.count()) await disclosure.click();
  }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

// Diagnostics inspect only the test-created session in the isolated E2E home.
// Artifacts contain counts/booleans only: no terminal contents or pointers.
function guardedDiagnosticJson(path: string, maxBytes: number): unknown {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || typeof constants.O_NOFOLLOW !== "number") throw new Error("Invalid diagnostic metadata");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error("Invalid diagnostic metadata");
    const buffer = Buffer.alloc(stat.size);
    if (readSync(fd, buffer, 0, stat.size, 0) !== stat.size) throw new Error("Incomplete diagnostic metadata");
    return JSON.parse(buffer.toString("utf8"));
  } finally { closeSync(fd); }
}

function diagnosticSessionContext(sessionId: string, existingIds: Set<string>, expectedName: string,
  expectedPointer: BridgePointer): { terminalPath: string; pointer: unknown } {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) || existingIds.has(sessionId)) {
    throw new Error("Diagnostic session ownership check failed");
  }
  const e2eDir = resolve(E2E_DIR);
  const home = join(e2eDir, ".bridge-home");
  if (resolve(BRIDGE_HOME) !== home || realpathSync(e2eDir) !== e2eDir) throw new Error("Diagnostic bridge home is not isolated");
  const directories = [home, join(home, ".ftown"), join(home, ".ftown", "data"),
    join(home, ".ftown", "data", "sessions"), join(home, ".ftown", "data", "sessions", sessionId)];
  for (const directory of directories) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error("Diagnostic path is not isolated");
  }
  // A new channel is not sufficient to identify the session. Verify the
  // isolated bridge's current pointer and its authoritative session snapshot;
  // neither JSON object is ever included in an artifact or error message.
  const pointer = guardedDiagnosticJson(join(home, ".ftown", "bridge.json"), 64 * 1024);
  if (!/^LOCALPRIVATE\d+$/.test(expectedName) || !Number.isSafeInteger(expectedPointer.pid) || expectedPointer.pid <= 0 ||
      !Number.isInteger(expectedPointer.port) || expectedPointer.port < 1 || expectedPointer.port > 65535 ||
      typeof expectedPointer.startedAt !== "string" || !Number.isFinite(Date.parse(expectedPointer.startedAt)) ||
      !record(pointer) || typeof pointer.bridgeId !== "string" || pointer.bridgeId !== expectedPointer.bridgeId ||
      typeof pointer.token !== "string" || pointer.token.length === 0 ||
      pointer.pid !== expectedPointer.pid || pointer.startedAt !== expectedPointer.startedAt || pointer.port !== expectedPointer.port ||
      pointer.dataDir !== join(home, ".ftown", "data")) throw new Error("Diagnostic bridge identity check failed");
  const session = guardedDiagnosticJson(join(directories[directories.length - 1], "session.json"), 256 * 1024);
  if (!record(session) || session.id !== sessionId || session.name !== expectedName || session.bridgeId !== pointer.bridgeId) {
    throw new Error("Diagnostic session identity check failed");
  }
  return { terminalPath: join(directories[directories.length - 1], "terminal.log"), pointer };
}

function diagnosticPreStopOffset(sessionId: string, existingIds: Set<string>, expectedName: string, expectedPointer: BridgePointer): number | null {
  try {
    const stat = lstatSync(diagnosticSessionContext(sessionId, existingIds, expectedName, expectedPointer).terminalPath);
    return stat.isFile() && !stat.isSymbolicLink() ? stat.size : null;
  } catch { return null; }
}

const execFileAsync = promisify(execFile);

function terminalSummary(value: string, knownMarker: string) {
  const count = (pattern: RegExp) => [...value.matchAll(pattern)].length;
  const printable = stripVTControlCharacters(value);
  const controls: { kind: string; offset: number }[] = [];
  const pattern = /\x1b\[2J|\x1b\[H|\x1b\[\?1049[hl]|\[lost tty\]/g;
  const kinds: Record<string, string> = { "\x1b[2J": "clear", "\x1b[H": "home",
    "\x1b[?1049h": "alternateEnter", "\x1b[?1049l": "alternateExit", "[lost tty]": "lostTty" };
  for (const match of value.matchAll(pattern)) {
    if (controls.length === 128) break;
    controls.push({ kind: kinds[match[0]], offset: match.index! });
  }
  return { fullClearCount: count(/\x1b\[2J/g), cursorHomeCount: count(/\x1b\[H/g),
    alternateScreenEnterCount: count(/\x1b\[\?1049h/g), alternateScreenExitCount: count(/\x1b\[\?1049l/g),
    lostTtyCount: count(/\[lost tty\]/g), controls, printableLength: printable.length,
    hasKnownMarker: printable.includes(knownMarker), hasPromptCharacter: /[$%#>]/.test(printable) };
}

async function captureRerunFailure(page: Page, info: TestInfo, sessionId: string,
  existingIds: Set<string>, expectedName: string, expectedPointer: BridgePointer, preStopOffset: number | null, knownMarker: string): Promise<void> {
  const evidence: Record<string, unknown> = { preStopOffset };
  let context: { terminalPath: string; pointer: unknown };
  try { context = diagnosticSessionContext(sessionId, existingIds, expectedName, expectedPointer); }
  catch {
    evidence.error = "Diagnostic ownership or isolated-home check failed";
    await info.attach("local-rerun-diagnostics.json", { body: JSON.stringify(evidence), contentType: "application/json" });
    return;
  }

  try {
    const entry = lstatSync(context.terminalPath);
    if (!entry.isFile() || entry.isSymbolicLink() || typeof constants.O_NOFOLLOW !== "number") throw new Error("Invalid terminal log");
    const fd = openSync(context.terminalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error("Terminal log is not a regular file");
      const length = Math.min(stat.size, 128 * 1024);
      const start = stat.size - length;
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, start);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const afterPreStopAvailable = preStopOffset !== null && preStopOffset >= start && preStopOffset <= start + bytesRead;
      const afterPreStop = afterPreStopAvailable ? buffer.subarray(preStopOffset! - start, bytesRead).toString("utf8") : null;
      evidence.terminalLog = { totalBytes: stat.size, start, bytesRead, truncated: start > 0,
        shrunkSincePreStop: preStopOffset !== null && stat.size < preStopOffset,
        entireTail: terminalSummary(text, knownMarker), afterPreStop: afterPreStop === null ? null : terminalSummary(afterPreStop, knownMarker) };
    } finally { closeSync(fd); }
  } catch { evidence.terminalLog = { unavailable: true }; }

  try {
    const cli = await import(pathToFileURL(join(E2E_DIR, "..", "bridge", "dist", "cli-client.js")).href) as {
      apiResponse(pointer: unknown, method: string, path: string, body?: unknown,
        headers?: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; body: unknown }>;
    };
    // Revalidate immediately before the request; use the no-follow-read pointer,
    // never a separate unguarded readBridgePointer() for this diagnostic.
    const current = diagnosticSessionContext(sessionId, existingIds, expectedName, expectedPointer);
    const screen = await cli.apiResponse(current.pointer, "GET", `/api/sessions/${sessionId}/screen?offset=0&limit=120`,
      undefined, undefined, AbortSignal.timeout(5000));
    const body = record(screen.body) ? screen.body : {};
    const lines = Array.isArray(body.lines) ? body.lines.filter((line): line is string => typeof line === "string").slice(0, 120) : [];
    const printableLines = lines.map(stripVTControlCharacters);
    evidence.screen = { status: screen.status, totalLines: typeof body.totalLines === "number" ? body.totalLines : null,
      offset: typeof body.offset === "number" ? body.offset : null, limit: typeof body.limit === "number" ? body.limit : null,
      returnedLines: lines.length, nonblankLines: printableLines.filter(line => line.trim().length > 0).length,
      hasKnownMarker: printableLines.some(line => line.includes(knownMarker)), hasPromptCharacter: printableLines.some(line => /[$%#>]/.test(line)) };
  } catch { evidence.screen = { unavailable: true }; }

  try {
    // Verify the isolated session again before querying only its exact pane.
    // Never pass the rest of the test environment (or its credentials) to tmux.
    diagnosticSessionContext(sessionId, existingIds, expectedName, expectedPointer);
    const env: NodeJS.ProcessEnv = { HOME: resolve(BRIDGE_HOME), PATH: process.env.PATH };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    if (process.env.TMUX_TMPDIR) env.TMUX_TMPDIR = process.env.TMUX_TMPDIR;
    const options = { env, timeout: 2000, maxBuffer: 64 * 1024, encoding: "utf8" as const };
    const name = `ftown-${sessionId}`;
    const format = "#{session_name}\t#{pane_id}\t#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{pane_dead}";
    const listing = await execFileAsync("tmux", ["-L", "ftown", "-f", "/dev/null", "list-panes", "-t", `=${name}:`, "-F", format], options);
    const rows = listing.stdout.trimEnd().split("\n");
    const fields = rows.length === 1 ? rows[0].split("\t") : [];
    if (fields.length !== 7 || fields[0] !== name || !/^%\d+$/.test(fields[1]) ||
        !fields.slice(2, 6).every(field => /^\d{1,6}$/.test(field)) || !/^[01]$/.test(fields[6])) {
      throw new Error("Invalid isolated pane metadata");
    }
    diagnosticSessionContext(sessionId, existingIds, expectedName, expectedPointer);
    const pane = await execFileAsync("tmux", ["-L", "ftown", "-f", "/dev/null", "capture-pane", "-p", "-t", fields[1]], options);
    evidence.nativePane = { width: Number(fields[2]), height: Number(fields[3]), cursorX: Number(fields[4]),
      cursorY: Number(fields[5]), dead: fields[6] === "1", ...terminalSummary(pane.stdout, knownMarker) };
  } catch { evidence.nativePane = { unavailable: true }; }

  try {
    evidence.browser = await page.evaluate(marker => {
      const term = document.querySelector<HTMLElement>(".xterm");
      const rows = term?.querySelector<HTMLElement>(".xterm-rows");
      const text = rows?.innerText ?? "";
      const bounds = term?.getBoundingClientRect();
      return { textLength: text.length, nonblankRows: text.split("\n").filter(line => line.trim().length > 0).length,
        hasKnownMarker: text.includes(marker), hasPromptCharacter: /[$%#>]/.test(text),
        width: bounds?.width ?? null, height: bounds?.height ?? null, rowCount: rows?.children.length ?? 0,
        viewportWidth: innerWidth, viewportHeight: innerHeight };
    }, knownMarker);
  } catch { evidence.browser = { unavailable: true }; }
  await info.attach("local-rerun-diagnostics.json", { body: JSON.stringify(evidence), contentType: "application/json" });
}
function captureBroker(page: Page): string[] {
  const frames: string[] = [];
  page.on("websocket", socket => {
    socket.on("framesent", ({ payload }) => frames.push(typeof payload === "string" ? payload : payload.toString()));
    socket.on("framereceived", ({ payload }) => frames.push(typeof payload === "string" ? payload : payload.toString()));
  });
  return frames;
}

test("real browser pairing persists its non-extractable key; cloud terminal frames stay opaque; mobile security can revoke it", async ({ page }, info) => {
  const pointer = readBridgePointer();
  const originalViewport = page.viewportSize() ?? { width: 1280, height: 900 };
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto("/");
  const diagram = page.getByRole("region", { name: "Follow the data, know the endpoints." });
  await diagram.scrollIntoViewIfNeeded(); await expect(diagram).toBeVisible();
  await expect(diagram.getByRole("heading", { name: "Add a device without copying a private link." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("encryption-main-desktop.png"), fullPage: true });
  await diagram.screenshot({ path: info.outputPath("encryption-diagram-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 }); await diagram.scrollIntoViewIfNeeded();
  await expect(diagram).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("encryption-main-mobile.png"), fullPage: true });
  await diagram.screenshot({ path: info.outputPath("encryption-diagram-mobile.png") });
  await page.setViewportSize(originalViewport);
  const frames = captureBroker(page);
  await page.addInitScript(() => { Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: class { constructor() { throw new Error("Force the encrypted relay path for this test"); } } }); });
  await page.routeWebSocket(url => url.hostname === "127.0.0.1" && url.port === String(pointer.port) && url.pathname === "/ws", socket => socket.close());
  await login(page, sharedEmail()); await waitForBridgeOnline(page);
  const endpointId = await browserEndpointId(page);
  const before = await sessionIdsFor(sharedEmail()); const name = `E2EESESSION${Date.now()}`;
  let sessionId: string | undefined;
  try {
    await createShellSession(page, name); sessionId = await waitForNewSessionId(sharedEmail(), before); await openSession(page, name);
    const marker = `E2EECONTENT${Date.now()}`; await runMarkerInTerminal(page, marker);
    await expect(page.locator("text=/^(P2P|Local|Cloud)$/").first()).toHaveText("Cloud", { timeout: 15000 });
    expect(frames.join("\n")).not.toContain(marker); expect(frames.join("\n")).not.toContain(name);
    expect(frames.some(frame => frame.includes("ftown_encrypted"))).toBe(true);
    await page.reload(); await waitForBridgeOnline(page); expect(await browserEndpointId(page)).toBe(endpointId);
    await openSecurity(page);
    await expect(page.getByRole("dialog", { name: "Security", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    await waitForSecurityLayout(page, 1280);
    await expect(page.getByRole("heading", { name: "Your computers", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("security-access-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForSecurityLayout(page, 390);
    await page.screenshot({ path: info.outputPath("security-access-mobile.png"), fullPage: true });
    await page.getByLabel("Security computer", { exact: true }).selectOption(pointer.bridgeId);
    await openSeparateApprovals(page, pointer.bridgeId);
    await expect(page.getByRole("list", { name: "Approved devices" })).toContainText("This browser");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("security-mobile-devices.png"), fullPage: true });
    await page.getByRole("list", { name: "Approved devices" }).getByRole("button", { name: /\(this browser\):/ }).click();
    await page.getByRole("button", { name: "Revoke E2E browser", exact: true }).click();
    await page.getByRole("button", { name: "Confirm revoke", exact: true }).click();
    await expect(page.getByText(/Access revoked/)).toBeVisible();
    await page.getByRole("button", { name: "Close security" }).click();
    await expect(page.getByRole("banner").getByRole("button", { name: /^(Create a new session|No bridges online — start a bridge first)$/ })).toBeDisabled();
  } finally { if (sessionId) await bridgeApiFetch("DELETE", `/api/sessions/${sessionId}`); }
});

test("two isolated browser installations approve two independent bridges and retain distinct keys", async ({ page, browser }) => {
  await login(page, sharedEmail()); await pairBrowser(page, { bridgeHome: secondHome, label: "E2E browser", email: sharedEmail(), password: E2E_PASSWORD });
  const firstId = await browserEndpointId(page);
  const second = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const phone = await second.newPage(); await login(phone, sharedEmail());
    await pairBrowser(phone, { bridgeHome: secondHome, label: "E2E phone", email: sharedEmail(), password: E2E_PASSWORD });
    expect(await browserEndpointId(phone)).not.toBe(firstId);
    await openSecurity(phone);
    const picker = phone.getByLabel("Security computer", { exact: true });
    await expect(picker.locator(`option[value="${readBridgePointer().bridgeId}"]`)).toHaveCount(1);
    await expect(picker.locator(`option[value="${readBridgePointer(secondHome).bridgeId}"]`)).toHaveCount(1);
    await picker.selectOption(readBridgePointer(secondHome).bridgeId);
    await openSeparateApprovals(phone, readBridgePointer(secondHome).bridgeId);
    await expect(phone.getByRole("list", { name: "Approved devices" })).toContainText("E2E phone");
    await expect(phone.getByRole("list", { name: "Approved devices" })).toContainText("This browser");
  } finally { await second.close(); }
});

test("an approved browser uses encrypted local HTTP control and event polling", async ({ page }, info) => {
  const pointer = readBridgePointer(); const packets: string[] = []; const frames = captureBroker(page);
  page.on("request", request => {
    if (request.url().startsWith(`http://127.0.0.1:${pointer.port}/api/security/`)) packets.push(request.postData() ?? "");
  });
  await login(page, sharedEmail());
  await page.goto(`/local?port=${pointer.port}`); await waitForBridgeOnline(page);
  const before = await sessionIdsFor(sharedEmail()); const name = `LOCALPRIVATE${Date.now()}`; let sessionId: string | undefined;
  let bodyFailed = false;
  try {
    await createShellSession(page, name); sessionId = await waitForNewSessionId(sharedEmail(), before);
    await openSession(page, name); const marker = `LOCALCONTENT${Date.now()}`; await runMarkerInTerminal(page, marker);
    expect(packets.some(packet => packet.includes("ftown_encrypted"))).toBe(true);
    expect(packets.join("\n")).not.toContain(name); expect(packets.join("\n")).not.toContain(marker);
    expect(frames.join("\n")).not.toContain(marker);
    const accountRequests: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/security/account")) accountRequests.push(request.method()); });
    await openSecurity(page);
    await expect(page.getByRole("dialog", { name: "Security", exact: true })).toBeVisible();
    await page.getByLabel("Security computer", { exact: true }).selectOption(pointer.bridgeId);
    await openSeparateApprovals(page, pointer.bridgeId);
    await expect(page.getByRole("list", { name: "Approved devices" })).toContainText("This browser");
    const dialog = page.getByRole("dialog", { name: "Security", exact: true });
    await expect(dialog.getByRole("heading", { name: "Computer access", exact: true })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Account access", exact: true })).toHaveCount(0);
    await expect(dialog.locator(`[data-access-edge="bridge:${pointer.bridgeId}"]`)).toHaveAttribute("data-certainty", "current");
    await expect(dialog.locator(`[data-access-card="bridge:${pointer.bridgeId}"]`)).toHaveAttribute("data-current-device", "bridge");
    for (const size of [{ width: 900, height: 760 }, { width: 390, height: 844 }, { width: 320, height: 760 }]) {
      await page.setViewportSize(size); await waitForSecurityLayout(page, size.width);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await dialog.locator("button button").count()).toBe(0);
      await page.screenshot({ path: info.outputPath(`security-local-map-${size.width}.png`), fullPage: true });
    }
    expect(accountRequests).toHaveLength(0);
    await page.setViewportSize({ width: 900, height: 760 });
    await waitForSecurityLayout(page, 900);
    await dialog.getByRole("button", { name: "Close security" }).click();
    const actions = page.getByRole("group", { name: "Selected session actions", exact: true });
    const runningIds = await sessionIdsFor(sharedEmail());
    expect(runningIds.has(sessionId)).toBe(true);
    // Only a byte count is read before stopping; contents are never attached.
    const preStopOffset = diagnosticPreStopOffset(sessionId, before, name, pointer);
    await actions.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(actions.getByRole("button", { name: "Rerun", exact: true })).toBeVisible({ timeout: 30000 });
    await actions.getByRole("button", { name: "Rerun", exact: true }).click();
    await expect(actions.getByRole("button", { name: "Stop", exact: true })).toBeVisible({ timeout: 30000 });
    await openSession(page, name);
    const rerunMarker = `LOCALRERUN${Date.now()}`;
    try {
      await runMarkerInTerminal(page, rerunMarker);
    } catch (failure) {
      // Collect before the finally block deletes this test-owned session. If a
      // diagnostic itself fails, retain the original assertion failure.
      try { await captureRerunFailure(page, info, sessionId, before, name, pointer, preStopOffset, rerunMarker); } catch { /* preserve failure */ }
      throw failure;
    }
    expect(await sessionIdsFor(sharedEmail())).toEqual(runningIds);
  } catch (failure) {
    bodyFailed = true;
    throw failure;
  } finally {
    if (sessionId) {
      try {
        const cleanup = await bridgeApiFetch("DELETE", `/api/sessions/${sessionId}`);
        if (cleanup.status < 200 || cleanup.status >= 300) throw new Error(`Test session cleanup failed: HTTP ${cleanup.status}`);
      } catch (failure) {
        if (!bodyFailed) throw failure;
        // Keep the original failure; do not expose cleanup error contents.
        console.warn("Test session cleanup failed after the original test failure.");
      }
    }
  }
});

