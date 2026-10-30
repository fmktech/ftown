import { join } from "node:path";
import { symlink, unlink, writeFile } from "node:fs/promises";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedEmail, waitForBridgeOnline, runMarkerInTerminal } from "../helpers/app";
import { bridgeApiFetch, readBridgePointer } from "../helpers/bridge-api";
import { UI_BASE_URL } from "../helpers/config";
import { assertSanitized, atomicHtml, createPreviewFixture, observePreviewTransport, previewHtml, sessionRecord } from "../helpers/session-preview";

const iframe = (page: Page, fileName: string) => page.locator(`iframe[title="HTML preview: ${fileName}"]`);
const documentFrame = (page: Page, fileName: string) => page.frameLocator(`iframe[title="HTML preview: ${fileName}"]`);
const previewRegion = (page: Page) => page.locator('[aria-label="Session preview"]');
const separator = (page: Page) => page.getByRole("separator", { name: "Resize terminal and preview", exact: true });

async function selectSession(page: Page, name: string): Promise<void> {
  const workspace = page.getByRole("tab", { name: "Workspace", exact: true });
  if (await workspace.isVisible()) await workspace.click();
  const row = page.locator('#dashboard-sidebar button[draggable="true"]')
    .filter({ has: page.getByText(name, { exact: true }) });
  await expect(row).toBeVisible();
  await row.getByText(name, { exact: true }).click();
}

async function screenshot(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("real CLI preview is encrypted, interactive, revision-consistent and isolated across sessions", async ({ page, context }, info) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await createPreviewFixture();
  const suffix = `${info.workerIndex}-${Date.now().toString(36)}`;
  const marker = `PREVIEW_PRIVATE_${suffix}`;
  let targetName = `Preview target ${suffix}`;
  const otherName = `Preview other ${suffix}`;
  const fileName = "preview.html";
  const otherFileName = "other.html";
  const path = join(fixture.directory, fileName);
  const otherPath = join(fixture.directory, otherFileName);
  const first = previewHtml(marker, 1, true);
  const second = previewHtml(marker, 2, true);
  expect(Buffer.byteLength(first)).toBeGreaterThan(98_304);
  expect(Buffer.byteLength(first)).toBe(Buffer.byteLength(second));
  let prohibitedRequests = 0;
  const externalHeaders: Record<string, string>[] = [];
  await context.route("https://preview.example.test/**", async route => {
    externalHeaders.push(route.request().headers());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><h1>External preview destination</h1>" });
  });
  await context.route(`${UI_BASE_URL}/__e2e-preview-probe/**`, async (route) => {
    prohibitedRequests++;
    await route.fulfill({ status: 200, contentType: "text/plain", body: "intercepted forbidden preview request" });
  });
  const pointer = readBridgePointer();
  const transport = await observePreviewTransport(page, pointer.port);
  transport.markers.add(marker); transport.markers.add(path); transport.markers.add('"previewSource"');
  try {
    await atomicHtml(path, first);
    await atomicHtml(otherPath, previewHtml(`OTHER_${suffix}`, 1));
    const target = await fixture.create(targetName);
    const other = await fixture.create(otherName);
    await login(page, sharedEmail());
    await waitForBridgeOnline(page);
    await selectSession(page, targetName);
    await expect(separator(page)).toHaveCount(0);
    await runMarkerInTerminal(page, `TERMINAL_BEFORE_${suffix}`);
    await page.locator(".xterm").evaluate((element, value) => element.setAttribute("data-preview-fixture-terminal", value), suffix);

    const registration = await fixture.register(target, fileName);
    await expect(documentFrame(page, fileName).getByRole("heading", { name: `${marker} version 1`, exact: true })).toBeVisible();
    await expect(iframe(page, fileName)).toHaveAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    await expect(iframe(page, fileName)).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(await documentFrame(page, fileName).locator("#unicode").evaluate((element) => element.textContent?.endsWith("😀 boundary ✓"))).toBe(true);
    expect(await documentFrame(page, fileName).locator("#data-image").evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth === 2)).toBe(true);
    await expect(documentFrame(page, fileName).locator("#security")).toHaveAttribute("data-parent", "blocked");
    await expect(documentFrame(page, fileName).locator("#security")).toHaveAttribute("data-storage", "blocked");
    await expect(documentFrame(page, fileName).locator("#security")).toHaveAttribute("data-fetch", "blocked");
    expect(await page.locator("body").getAttribute("data-preview-escaped")).toBeNull();
    expect(prohibitedRequests).toBe(0);
    await expect.poll(() => transport.reads.filter((entry) => entry.previewId === registration && entry.state === "chunk" && entry.transport === "cloud").length).toBeGreaterThan(1);
    expect(transport.encryptedCloudPublications).toBeGreaterThan(0);
    expect(transport.leaked).toBe(false);

    const count = documentFrame(page, fileName).getByRole("button", { name: /^Count:/ });
    await count.click(); await expect(count).toHaveText("Count: 1");
    await iframe(page, fileName).evaluate((element, value) => element.setAttribute("data-preview-node", value), suffix);
    const originalUrl = page.url();
    for (const linkId of ["external-link", "dynamic-link"]) {
      const popupPromise = context.waitForEvent("page");
      await documentFrame(page, fileName).locator(`#${linkId}`).click();
      const popup = await popupPromise;
      await expect(popup.getByRole("heading", { name: "External preview destination" })).toBeVisible();
      expect(new URL(popup.url()).hostname).toBe("preview.example.test");
      expect(await popup.evaluate(() => window.opener)).toBeNull();
      await popup.close();
      expect(page.url()).toBe(originalUrl);
      await expect(iframe(page, fileName)).toHaveAttribute("data-preview-node", suffix);
      await expect(count).toHaveText("Count: 1");
    }
    expect(externalHeaders).toHaveLength(2);
    for (const headers of externalHeaders) expect(headers.referer).toBeUndefined();
    for (const linkId of ["relative-link", "javascript-link", "data-link", "file-link"]) {
      await documentFrame(page, fileName).locator(`#${linkId}`).click();
      expect(page.url()).toBe(originalUrl);
      await expect(iframe(page, fileName)).toHaveAttribute("data-preview-node", suffix);
      await expect(count).toHaveText("Count: 1");
    }
    expect(await documentFrame(page, fileName).locator("body").getAttribute("data-preview-javascript")).toBeNull();
    await documentFrame(page, fileName).locator("#hash-link").click();
    await expect.poll(() => documentFrame(page, fileName).locator("body").evaluate(element => element.ownerDocument.location.hash)).toBe("#inside");
    await expect(iframe(page, fileName)).toHaveAttribute("data-preview-node", suffix);
    await expect(count).toHaveText("Count: 1");
    await iframe(page, fileName).evaluate((element, value) => {
      element.setAttribute("data-preview-node", value);
      // Test-local observation catches a transient hide/removal even if it
      // resolves before Playwright's next assertion.
      const observer = new MutationObserver(records => {
        const removed = records.some(record => Array.from(record.removedNodes).some(node => node === element || node.contains(element)));
        const blocked = records.some(record => Array.from(record.addedNodes).some(node => /Checking preview access|Reconnect to load preview/.test(node.textContent ?? "")));
        if (removed || blocked || getComputedStyle(element).visibility === "hidden") element.setAttribute("data-preview-interrupted", "true");
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "hidden", "class"] });
    }, suffix);
    // The account client refreshes every 30s. Ignore an immediate focus-triggered
    // read so this observes the subsequent periodic account-history response.
    const interactedAt = Date.now();
    await page.waitForResponse(response => {
      const url = new URL(response.url());
      return Date.now() - interactedAt >= 20_000 && url.pathname === "/api/security/account"
        && response.request().method() === "GET" && response.status() === 200;
    }, { timeout: 60_000 });
    const afterTrustRefresh = transport.reads.filter(entry => entry.previewId === registration && entry.state === "unchanged").length;
    await expect.poll(() => transport.reads.filter(entry => entry.previewId === registration && entry.state === "unchanged").length,
      { timeout: 15_000 }).toBeGreaterThan(afterTrustRefresh);
    await expect(iframe(page, fileName)).toBeVisible();
    await expect(iframe(page, fileName)).toHaveAttribute("data-preview-node", suffix);
    await expect(iframe(page, fileName)).not.toHaveAttribute("data-preview-interrupted", "true");
    await expect(previewRegion(page)).not.toContainText(/Checking preview access|Reconnect to load preview/);
    await expect(count).toHaveText("Count: 1");
    const cloudState = page.locator('[role="img"][aria-label^="Cloud "]').first();
    try {
      await context.setOffline(true);
      await expect(cloudState).toHaveAttribute("aria-label", /^Cloud (connecting|disconnected|error)/, { timeout: 15_000 });
      await expect(iframe(page, fileName)).toBeVisible();
      await expect(iframe(page, fileName)).toHaveAttribute("data-preview-node", suffix);
      await expect(count).toHaveText("Count: 1");
    } finally { await context.setOffline(false); }
    await expect(cloudState).toHaveAttribute("aria-label", /^Cloud connected/, { timeout: 30_000 });
    const afterReconnect = transport.reads.filter(entry => entry.previewId === registration && entry.state === "unchanged").length;
    await expect.poll(() => transport.reads.filter(entry => entry.previewId === registration && entry.state === "unchanged").length,
      { timeout: 30_000 }).toBeGreaterThan(afterReconnect);
    await expect(iframe(page, fileName)).toHaveAttribute("data-preview-node", suffix);
    await expect(iframe(page, fileName)).not.toHaveAttribute("data-preview-interrupted", "true");
    await expect(count).toHaveText("Count: 1");
    const unchanged = transport.reads.filter((entry) => entry.previewId === registration && entry.state === "unchanged").length;
    await expect.poll(() => transport.reads.filter((entry) => entry.previewId === registration && entry.state === "unchanged").length).toBeGreaterThan(unchanged);
    await expect(count).toHaveText("Count: 1");

    await expect(separator(page)).toBeVisible();
    const mainBox = await page.locator("main").boundingBox();
    const previewBox = await previewRegion(page).boundingBox();
    const splitBox = await separator(page).boundingBox();
    expect(mainBox && previewBox && splitBox).toBeTruthy();
    if (!mainBox || !previewBox || !splitBox) throw new Error("Preview split geometry unavailable");
    expect(splitBox.x).toBeLessThan(previewBox.x + 1);
    expect(splitBox.x - mainBox.x).toBeGreaterThanOrEqual(239);
    expect(previewBox.width).toBeGreaterThanOrEqual(239);
    expect(Math.abs((splitBox.x - mainBox.x) / (splitBox.x - mainBox.x + previewBox.width) - 0.5)).toBeLessThan(0.03);
    await separator(page).focus();
    const initialRatio = Number(await separator(page).getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => Number(await separator(page).getAttribute("aria-valuenow"))).toBeGreaterThan(initialRatio);
    await page.keyboard.press("Home");
    expect(Number(await separator(page).getAttribute("aria-valuenow"))).toBeCloseTo(Number(await separator(page).getAttribute("aria-valuemin")), 1);
    const drag = await separator(page).boundingBox();
    if (!drag) throw new Error("Preview drag target unavailable");
    const beforeDrag = Number(await separator(page).getAttribute("aria-valuenow"));
    await page.mouse.move(drag.x + drag.width / 2, drag.y + 60);
    await page.mouse.down();
    try { await page.mouse.move(drag.x + 100, drag.y + 60, { steps: 5 }); }
    finally { await page.mouse.up(); }
    await expect.poll(async () => Number(await separator(page).getAttribute("aria-valuenow"))).toBeGreaterThan(beforeDrag);
    const savedRatio = await separator(page).getAttribute("aria-valuenow");
    if (savedRatio === null) throw new Error("Preview split ratio unavailable");
    const expand = page.getByRole("button", { name: "Expand preview", exact: true });
    await expand.click();
    await expect(page.getByRole("button", { name: "Collapse preview", exact: true })).toBeFocused();
    await expect(separator(page)).toHaveCount(0);
    await expect(page.locator("#dashboard-sidebar")).toBeVisible();
    const expandedMain = await page.locator("main").boundingBox();
    const expandedPreview = await previewRegion(page).boundingBox();
    if (!expandedMain || !expandedPreview) throw new Error("Expanded preview geometry unavailable");
    expect(Math.abs(expandedPreview.x - expandedMain.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(expandedPreview.width - expandedMain.width)).toBeLessThanOrEqual(2);
    await screenshot(page, info, "preview-expanded");
    await expect(page.locator(`.xterm[data-preview-fixture-terminal="${suffix}"]`)).toHaveCount(1);
    await expect(page.locator(".xterm")).not.toBeVisible();
    await expect(iframe(page, fileName)).toHaveAttribute("data-preview-node", suffix);
    await expect(count).toHaveText("Count: 1");
    await page.getByRole("button", { name: "Collapse preview", exact: true }).click();
    await expect(separator(page)).toHaveAttribute("aria-valuenow", savedRatio);
    await expect(page.locator(".xterm")).toBeVisible();
    await expect(iframe(page, fileName)).toHaveAttribute("data-preview-node", suffix);
    await expect(count).toHaveText("Count: 1");
    await separator(page).focus();
    await atomicHtml(path, second);
    await expect(documentFrame(page, fileName).getByRole("heading", { name: `${marker} version 2`, exact: true })).toBeVisible();
    await expect(documentFrame(page, fileName).getByRole("button", { name: "Count: 0", exact: true })).toBeVisible();
    await expect(separator(page)).toBeFocused();
    await noHorizontalOverflow(page);
    await screenshot(page, info, "preview-desktop");

    await documentFrame(page, fileName).getByRole("button", { name: "Count: 0", exact: true }).click();
    await page.getByRole("button", { name: "Refresh preview", exact: true }).click();
    await expect(documentFrame(page, fileName).getByRole("button", { name: "Count: 0", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    await expect(iframe(page, fileName)).not.toBeVisible();
    await atomicHtml(path, previewHtml(marker, 3, true));
    targetName += " closed";
    expect((await bridgeApiFetch("PATCH", `/api/sessions/${target}`, { body: { name: targetName } })).status).toBe(200);
    await expect(page.getByText(targetName, { exact: true }).first()).toBeVisible();
    await expect(iframe(page, fileName)).not.toBeVisible();
    const registered = await bridgeApiFetch("GET", `/api/sessions/${target}`);
    expect(sessionRecord(registered.body).preview).toEqual({ id: registration, fileName });
    assertSanitized(registered.body, path);
    await page.getByRole("button", { name: "Open preview", exact: true }).click();
    await expect(documentFrame(page, fileName).getByRole("heading", { name: `${marker} version 3`, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    const replacement = await fixture.register(target, fileName);
    expect(replacement).not.toBe(registration);
    await expect(documentFrame(page, fileName).getByRole("heading", { name: `${marker} version 3`, exact: true })).toBeVisible();

    await fixture.register(other, otherFileName);
    await selectSession(page, otherName);
    await expect(documentFrame(page, otherFileName).getByRole("heading", { name: `OTHER_${suffix} version 1`, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    await selectSession(page, targetName);
    await expect(documentFrame(page, fileName).getByRole("heading", { name: `${marker} version 3`, exact: true })).toBeVisible();
    await selectSession(page, otherName);
    await expect(iframe(page, otherFileName)).not.toBeVisible();
    await selectSession(page, targetName);
    await unlink(path);
    await expect(previewRegion(page)).toContainText("Preview file is missing");
    await expect(iframe(page, fileName)).not.toBeVisible();
    await atomicHtml(path, previewHtml(marker, 4, true));
    await expect(documentFrame(page, fileName).getByRole("heading", { name: `${marker} version 4`, exact: true })).toBeVisible();
    await expect(page.locator(`.xterm[data-preview-fixture-terminal="${suffix}"]`)).toHaveCount(1);
    await runMarkerInTerminal(page, `TERMINAL_AFTER_${suffix}`);

    const outside = join(fixture.outside, "outside.html");
    await writeFile(outside, "<!doctype html><p>outside fixture</p>");
    await symlink(outside, join(fixture.directory, "linked.html"));
    await writeFile(join(fixture.directory, "oversized.html"), "x".repeat(1_048_577));
    for (const invalid of ["../outside/outside.html", "linked.html", "oversized.html"]) {
      const rejected = await fixture.cli(target, ["preview", invalid]);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stdout.includes(outside) || rejected.stderr.includes(outside)).toBe(false);
    }
    expect(sessionRecord((await bridgeApiFetch("GET", `/api/sessions/${target}`)).body).preview).toEqual({ id: replacement, fileName });

    const localBefore = transport.reads.filter((entry) => entry.transport === "local").length;
    await page.goto(`/local?port=${pointer.port}`);
    await waitForBridgeOnline(page);
    await selectSession(page, targetName);
    await expect(documentFrame(page, fileName).getByRole("heading", { name: `${marker} version 4`, exact: true })).toBeVisible();
    await expect.poll(() => transport.reads.filter((entry) => entry.transport === "local").length).toBeGreaterThan(localBefore);
    expect(transport.encryptedLocalRequests).toBeGreaterThan(0);
    expect(transport.leaked).toBe(false);
    await selectSession(page, otherName);
    const clear = await fixture.cli(other, ["preview", "--clear"]);
    expect(clear.code).toBe(0);
    assertSanitized(JSON.parse(clear.stdout), otherPath);
    await expect(iframe(page, otherFileName)).not.toBeVisible();
    expect(sessionRecord((await bridgeApiFetch("GET", `/api/sessions/${other}`)).body).preview).toBeUndefined();
    await selectSession(page, targetName);
    expect((await bridgeApiFetch("DELETE", `/api/sessions/${target}`)).status).toBe(200);
    await expect(iframe(page, fileName)).not.toBeVisible();
    const archive = await bridgeApiFetch("GET", "/api/archive");
    expect(archive.status).toBe(200);
    expect(JSON.stringify(archive.body).includes(target)).toBe(true);
    assertSanitized(archive.body, path);
    expect(prohibitedRequests).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test.describe("mobile preview", () => {
  test.use({ hasTouch: true });
  test("keeps Workspace navigation, terminal identity and compact pane controls usable", async ({ page }, info) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await createPreviewFixture();
    const suffix = `${info.workerIndex}-${Date.now().toString(36)}`;
    const name = `Mobile preview ${suffix}`;
    const fileName = "mobile-preview-with-a-long-file-name-for-truncation.html";
    try {
      await atomicHtml(join(fixture.directory, fileName), previewHtml(`MOBILE_${suffix}`, 1));
      const session = await fixture.create(name);
      await login(page, sharedEmail());
      await waitForBridgeOnline(page);
      await selectSession(page, name);
      await page.locator(".xterm").evaluate((element, value) => element.setAttribute("data-preview-fixture-terminal", value), suffix);
      await fixture.register(session, fileName);
      const terminalTab = page.getByRole("tab", { name: "Terminal", exact: true });
      const previewTab = page.getByRole("tab", { name: "Preview", exact: true });
      await expect(previewTab).toHaveAttribute("aria-selected", "true");
      await expect(documentFrame(page, fileName).getByRole("heading", { name: `MOBILE_${suffix} version 1`, exact: true })).toBeVisible();
      await expect(separator(page)).not.toBeVisible();
      for (const control of [previewTab, page.getByRole("button", { name: "Refresh preview", exact: true }), page.getByRole("button", { name: "Close preview", exact: true })]) {
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
      await noHorizontalOverflow(page);
      await screenshot(page, info, "preview-mobile");
      await iframe(page, fileName).evaluate((element, value) => element.setAttribute("data-preview-node", value), suffix);
      const count = documentFrame(page, fileName).getByRole("button", { name: "Count: 0", exact: true });
      await count.click();
      await terminalTab.click();
      await expect(page.locator(".xterm")).toBeVisible();
      await expect(page.locator(".touch-control-bar")).toBeVisible();
      await previewTab.click();
      await expect(page.locator(".touch-control-bar")).not.toBeVisible();
      await expect(iframe(page, fileName)).toHaveAttribute("data-preview-node", suffix);
      await expect(documentFrame(page, fileName).getByRole("button", { name: "Count: 1", exact: true })).toBeVisible();
      await expect(page.locator(`.xterm[data-preview-fixture-terminal="${suffix}"]`)).toHaveCount(1);
      await page.getByRole("tab", { name: "Workspace", exact: true }).click();
      await expect(page.locator("#dashboard-sidebar")).toBeVisible();
      await selectSession(page, name);
      await previewTab.click();
      await page.setViewportSize({ width: 1024, height: 844 });
      await expect(separator(page)).toBeVisible();
      const sidebar = page.getByRole("separator", { name: "Resize sidebar", exact: true });
      await sidebar.focus(); await page.keyboard.press("End");
      await expect(separator(page)).not.toBeVisible();
      await expect(previewTab).toBeVisible();
      await noHorizontalOverflow(page);
      await screenshot(page, info, "preview-compact-desktop");
    } finally {
      await fixture.cleanup();
    }
  });
});
