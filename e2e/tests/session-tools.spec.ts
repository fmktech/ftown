import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedEmail, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { BRIDGE_HOME, E2E_DIR } from "../helpers/config";

const execute = promisify(execFile);
interface SessionResult { session: { id: string; pullRequestUrl?: string } }
interface AttentionEvent { id: string; title: string; message: string; resolvedAt?: string; resolution?: string }
interface AttentionResult { event: AttentionEvent }
interface AttentionPage { events: AttentionEvent[] }

/** Use the real installed-command entry point and the scratch bridge pointer. */
async function sessionCommand<T>(sessionId: string, args: string[]): Promise<T> {
  const { stdout } = await execute(process.execPath, [join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js"), "sessions", ...args], {
    env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: sessionId },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

function originalRow(page: Page, name: string) {
  return page.locator('#dashboard-sidebar button[draggable="true"]')
    .filter({ has: page.getByText(name, { exact: true }) });
}

function sessionRow(page: Page, name: string) {
  return originalRow(page, name).locator("..");
}

async function expectBadgeGeometry(row: Locator) {
  const metrics = await row.evaluate((element) => {
    const link = element.querySelector<HTMLAnchorElement>("a[data-pull-request-badge]");
    const placeholder = element.querySelector<HTMLElement>("[data-pull-request-placeholder]");
    const button = element.querySelector<HTMLButtonElement>('button[draggable="true"]');
    if (!link || !placeholder || !button) throw new Error("Missing PR badge geometry elements");
    const rect = (target: Element) => {
      const box = target.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const css = (target: Element) => {
      const style = getComputedStyle(target);
      return { fontSize: style.fontSize, borderWidth: style.borderWidth, borderColor: style.borderColor,
        borderRadius: style.borderRadius, padding: style.padding, color: style.color };
    };
    return { link: rect(link), placeholder: rect(placeholder), row: rect(element), button: rect(button),
      linkStyle: css(link), placeholderStyle: css(placeholder), placeholderVisibility: getComputedStyle(placeholder).visibility };
  });
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(metrics.link[key] - metrics.placeholder[key]), `badge ${key}`).toBeLessThanOrEqual(1);
  }
  expect(metrics.linkStyle).toEqual(metrics.placeholderStyle);
  expect(metrics.linkStyle.fontSize).toBe("10px");
  expect(metrics.linkStyle.borderWidth).toBe("1px");
  expect(metrics.linkStyle.borderRadius).toBe("3px");
  expect(metrics.linkStyle.padding).toBe("1px 4px");
  expect(metrics.placeholderVisibility).toBe("hidden");
  expect(metrics.link.x).toBeGreaterThanOrEqual(metrics.row.x);
  expect(metrics.link.x + metrics.link.width).toBeLessThanOrEqual(metrics.row.x + metrics.row.width);
  expect(metrics.link.y).toBeGreaterThanOrEqual(metrics.button.y);
  expect(metrics.link.y + metrics.link.height).toBeLessThanOrEqual(metrics.button.y + metrics.button.height);
}

interface ReceivedHook { channel: string; eventName: string; notificationType?: string; toolName?: string }

async function observeHooks(page: Page): Promise<{ received: ReceivedHook[]; brokerFrames: string[] }> {
  const received: ReceivedHook[] = [];
  const brokerFrames: string[] = [];
  page.on("websocket", socket => socket.on("framereceived", frame => {
    const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8");
    brokerFrames.push(payload);
  }));
  await page.exposeFunction("__recordDecryptedHook", (event: ReceivedHook) => { received.push(event); });
  await page.addInitScript(() => {
    const subtle = crypto.subtle;
    const decrypt = subtle.decrypt.bind(subtle);
    const object = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    // Passive test observation: native authentication, arguments, result and
    // rejection remain unchanged. Only bounded hook metadata leaves the page.
    Object.defineProperty(subtle, "decrypt", { configurable: true, value: async (...args: Parameters<SubtleCrypto["decrypt"]>) => {
      const result = await decrypt(...args);
      try {
        const algorithm = args[0];
        if (typeof algorithm === "string" || algorithm.name !== "AES-GCM") return result;
        const additionalData = (algorithm as AesGcmParams).additionalData;
        if (!additionalData) return result;
        const header: unknown = JSON.parse(new TextDecoder().decode(additionalData));
        if (!Array.isArray(header) || header.length !== 13 || header[0] !== "ftown/e2ee/v1"
          || header[1] !== "ftown_encrypted" || header[2] !== 1 || header[8] !== "application"
          || typeof header[7] !== "string" || !/^events:[^#]+#.+$/.test(header[7])) return result;
        const application: unknown = JSON.parse(new TextDecoder().decode(result));
        if (!object(application) || application.type !== "application" || !object(application.route)
          || application.route.kind !== "publication" || !object(application.data)) return result;
        const event = application.data;
        if (event.type !== "hook_event" || typeof event.eventName !== "string" || !object(event.data)) return result;
        const observer = globalThis as unknown as { __recordDecryptedHook: (event: {
          channel: string; eventName: string; notificationType?: string; toolName?: string;
        }) => Promise<void> };
        await observer.__recordDecryptedHook({ channel: header[7], eventName: event.eventName,
          notificationType: typeof event.data.notification_type === "string" ? event.data.notification_type : undefined,
          toolName: typeof event.data.tool_name === "string" ? event.data.tool_name : undefined });
      } catch { /* Observer parsing/binding failures cannot change native crypto behavior. */ }
      return result;
    } });
  });
  return { received, brokerFrames };
}

async function tabIntoHeaderLink(page: Page, link: Locator, mobile: boolean) {
  // These are the actual preceding controls in the visible DOM. Tab forward
  // proves the link is keyboard reachable without entering xterm, where
  // Shift+Tab intentionally sends a terminal escape sequence.
  const precedingControl = mobile
    ? page.getByRole("button", { name: "Terminal", exact: true })
    : page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await precedingControl.focus();
  await expect(precedingControl).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  expect(await link.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe("none");
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test.describe(`${viewport.name} session tools`, () => {
  test.use({ hasTouch: viewport.name === "mobile" });
  test(`agent CLI attention and session PR association on ${viewport.name}`, async ({ page, context }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { received: receivedHooks, brokerFrames } = await observeHooks(page);
    // Clicking the real link must open its canonical destination while keeping
    // this integration test entirely independent of GitHub/network availability.
    await context.route("https://github.com/**", route => route.fulfill({
      status: 200, contentType: "text/html", body: "<!doctype html><title>PR destination intercepted</title>",
    }));
    await login(page, sharedEmail());
    await waitForBridgeOnline(page);

    const suffix = `${testInfo.workerIndex}-${Date.now().toString(36)}`;
    const targetName = `PR review ${suffix} with a deliberately long session name`;
    const otherName = `Unchanged observer ${suffix}`;
    const childName = `Nested check ${suffix}`;
    const created: string[] = [];
    const mobile = viewport.name === "mobile";
    const showWorkspace = async () => {
      if (mobile) await page.getByRole("button", { name: "Workspace", exact: true }).click();
    };
    const screenshot = async (name: string) => {
      const path = testInfo.outputPath(`${name}-${viewport.name}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`${name} ${viewport.name}`, { path, contentType: "image/png" });
    };
    const prOne = "https://github.com/fmktech/ftown/pull/123";
    const prTwo = "https://github.com/fmktech/ftown/pull/456";

    try {
      for (const name of [targetName, otherName]) {
        const response = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name } });
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        const id = (response.body as SessionResult).session?.id;
        expect(id).toBeTruthy();
        created.push(id);
      }
      const [targetId, otherId] = created;
      const child = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name: childName, parentSessionId: targetId } });
      expect(child.status, JSON.stringify(child.body)).toBe(201);
      const childId = (child.body as SessionResult).session?.id;
      expect(childId).toBeTruthy();
      created.push(childId);
      const capabilities = await bridgeApiFetch("GET", `/api/sessions/${targetId}`);
      expect(capabilities.status, JSON.stringify(capabilities.body)).toBe(200);
      expect(capabilities.body).toMatchObject({ capabilities: { attention: { version: 1, request: true }, sessionMetadata: { pullRequest: true } } });
      await showWorkspace();
      await expect(originalRow(page, targetName)).toBeVisible({ timeout: 30_000 });
      await originalRow(page, targetName).getByText(targetName, { exact: true }).click();

      const attached = await sessionCommand<SessionResult>(targetId, ["pr", `${prOne}/?tab=files#review`]);
      expect(attached.session.id).toBe(targetId);
      expect(attached.session.pullRequestUrl).toBe(prOne);
      const headerLink = page.locator("main").getByRole("link", { name: /^PR #123 in fmktech\/ftown(?:[:;])/ });
      await expect(headerLink).toBeVisible();
      await expect(headerLink).toHaveAttribute("href", prOne);
      await expect(headerLink).toHaveAttribute("aria-label", /^PR #123 in fmktech\/ftown(?:[:;]).*https:\/\/github\.com\/fmktech\/ftown\/pull\/123$/);
      await expect(headerLink).toHaveAttribute("target", "_blank");
      await expect(headerLink).toHaveAttribute("rel", "noopener noreferrer");
      const box = await headerLink.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      await tabIntoHeaderLink(page, headerLink, mobile);
      const [destination] = await Promise.all([context.waitForEvent("page"), headerLink.click()]);
      await expect(destination).toHaveURL(prOne);
      await expect(destination).toHaveTitle("PR destination intercepted");
      await destination.close();
      await showWorkspace();
      const expand = originalRow(page, targetName).getByRole("button", { name: "Expand children", exact: true });
      await expect(expand).toBeVisible();
      await expand.click();
      await expect(originalRow(page, targetName).getByRole("button", { name: "Collapse children", exact: true })).toBeVisible();
      await expect(originalRow(page, childName)).toBeVisible();
      const collapse = originalRow(page, targetName).getByRole("button", { name: "Collapse children", exact: true });
      await collapse.click();
      await expect(originalRow(page, targetName).getByRole("button", { name: "Expand children", exact: true })).toBeVisible();
      await expect(originalRow(page, targetName).locator('[title="1 hidden child session"]')).toBeVisible();
      await expectBadgeGeometry(sessionRow(page, targetName));
      await screenshot("selected-long-name-with-child-count");

      // The full list on reload must retain persisted metadata, even before
      // another live update has occurred.
      await page.reload();
      await waitForBridgeOnline(page);
      await showWorkspace();
      await expect(sessionRow(page, targetName).getByRole("link", { name: /^PR #123 in fmktech\/ftown(?:[:;])/ })).toBeVisible();
      await expect(sessionRow(page, otherName).getByRole("link")).toHaveCount(0);
      await originalRow(page, targetName).getByText(targetName, { exact: true }).click();
      await expect(headerLink).toBeVisible();

      // Explicit identity overrides a different self env. Only target changes.
      const replaced = await sessionCommand<SessionResult>(otherId, ["pr", prTwo, "--session-id", targetId]);
      expect(replaced.session.id).toBe(targetId);
      expect(replaced.session.pullRequestUrl).toBe(prTwo);
      const replacementLink = page.locator("main").getByRole("link", { name: /^PR #456 in fmktech\/ftown(?:[:;])/ });
      await expect(replacementLink).toBeVisible();
      await expect(headerLink).toHaveCount(0);
      await showWorkspace();
      const sidebarBadge = sessionRow(page, targetName).getByRole("link", { name: /^PR #456 in fmktech\/ftown(?:[:;])/ });
      await expect(sidebarBadge).toBeVisible();
      await expect(sidebarBadge).toHaveAttribute("href", prTwo);
      await expect(sidebarBadge).toHaveAttribute("aria-label", /^PR #456 in fmktech\/ftown(?:[:;]).*https:\/\/github\.com\/fmktech\/ftown\/pull\/456$/);
      await expect(sidebarBadge).toHaveAttribute("target", "_blank");
      await expect(sidebarBadge).toHaveAttribute("rel", "noopener noreferrer");
      await expect(originalRow(page, targetName).locator("a")).toHaveCount(0);
      await expect(sessionRow(page, targetName).getByRole("link")).toHaveCount(1);
      await expect(originalRow(page, targetName)).toHaveAttribute("draggable", "true");
      await expectBadgeGeometry(sessionRow(page, targetName));
      await originalRow(page, otherName).getByText(otherName, { exact: true }).click();
      await expect(page.locator("main").getByRole("link", { name: /PR #/ })).toHaveCount(0);
      await showWorkspace();

      const title = "PR review requested";
      const message = "Please inspect the associated pull request before I continue.";
      // The dashboard is closed at creation, including on mobile: restoration
      // must come from the bridge snapshot, not a previously delivered notice.
      await page.goto("about:blank");
      const attention = await sessionCommand<AttentionResult>(targetId, ["attention", "--title", title, "--message", message]);
      expect(attention.event).toMatchObject({ title, message });
      expect(attention.event.id).toBeTruthy();
      const targetAttention = await bridgeApiFetch("GET", `/api/sessions/${targetId}/attention`);
      expect(targetAttention.status, JSON.stringify(targetAttention.body)).toBe(200);
      expect((targetAttention.body as AttentionPage).events).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: attention.event.id, title, message }),
      ]));
      const observerAttention = await bridgeApiFetch("GET", `/api/sessions/${otherId}/attention`);
      expect(observerAttention.status, JSON.stringify(observerAttention.body)).toBe(200);
      expect((observerAttention.body as AttentionPage).events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: attention.event.id }),
      ]));
      await page.goto("/dashboard");
      await waitForBridgeOnline(page);
      await showWorkspace();
      const region = page.getByRole("region", { name: "Needs attention", exact: true });
      const shortcut = region.getByRole("button", { name: `${targetName}: ${title}. ${message}`, exact: true });
      await expect(shortcut).toBeVisible();
      await expect(region.getByRole("button", { name: new RegExp(otherName) })).toHaveCount(0);
      await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
      await screenshot("restored-attention-with-pr");
      await page.reload();
      await waitForBridgeOnline(page);
      await showWorkspace();
      await expect(shortcut).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
      await originalRow(page, otherName).getByText(otherName, { exact: true }).click();
      await showWorkspace();

      // The requesting agent's completion hook must not dismiss its explicit
      // request. Wait for actual browser delivery before checking React state.
      for (const hook of [
        { eventName: "PostToolUse", data: { tool_name: "exec_command" } },
        { eventName: "postToolUseFailure", data: { tool_name: "exec_command" } },
        { eventName: "Notification", data: { notification_type: "elicitation_complete" } },
        { eventName: "Notification", data: { notification_type: "elicitation_response" } },
      ]) {
        const before = receivedHooks.length;
        const beforeFrames = brokerFrames.length;
        const result = await bridgeApiFetch("POST", "/hook", { body: {
          ftown_session_id: targetId, hook_event_name: hook.eventName, ...hook.data,
        } });
        expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(200);
        expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
        await expect.poll(() => receivedHooks.slice(before).some(event =>
          event.channel.startsWith(`events:${targetId}#`) && event.eventName === hook.eventName
          && event.notificationType === hook.data.notification_type && event.toolName === hook.data.tool_name,
        )).toBe(true);
        const wire = brokerFrames.slice(beforeFrames).join("\n");
        const encryptedPublication = wire.split("\n").some(line => {
          try {
            const reply = JSON.parse(line) as { push?: { pub?: { data?: unknown } } } | null;
            const packet = reply?.push?.pub?.data;
            const envelope = (value: unknown): boolean => value !== null && typeof value === "object"
              && "type" in value && value.type === "ftown_encrypted" && "version" in value && value.version === 1
              && "enc" in value && typeof value.enc === "string" && "ciphertext" in value && typeof value.ciphertext === "string";
            return envelope(packet) || (packet !== null && typeof packet === "object" && "type" in packet
              && packet.type === "ftown_encrypted_batch" && "version" in packet && packet.version === 1
              && "envelopes" in packet && Array.isArray(packet.envelopes) && packet.envelopes.length > 0 && packet.envelopes.every(envelope));
          } catch { return false; }
        });
        expect(encryptedPublication, "Browser received an encrypted hook publication").toBe(true);
        expect(wire).not.toContain("hook_event");
        expect(wire).not.toContain("notification_type");
        expect(wire).not.toContain("tool_name");
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect(shortcut).toBeVisible();
        await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
      }

      // The native sibling link opens without selecting the requesting session
      // or resolving its independent attention request.
      await expect(sidebarBadge).toBeVisible();
      await expect(sessionRow(page, targetName).getByRole("link")).toHaveCount(1);
      await expectBadgeGeometry(sessionRow(page, targetName));
      const menuControl = originalRow(page, targetName).getByRole("button", { name: "Session actions", exact: true });
      const triggerBox = await menuControl.boundingBox();
      expect(triggerBox).not.toBeNull();
      if (mobile) {
        expect(triggerBox!.height).toBeGreaterThanOrEqual(44);
        expect(triggerBox!.width).toBeGreaterThanOrEqual(44);
        expect(await menuControl.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(20);
      } else {
        expect(triggerBox!.height).toBeLessThan(44);
        expect(await menuControl.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBe(16);
      }
      await menuControl.focus();
      await page.keyboard.press("Tab");
      await expect(sidebarBadge).toBeFocused();
      expect(await sidebarBadge.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe("none");
      const [badgeKeyboardDestination] = await Promise.all([context.waitForEvent("page"), page.keyboard.press("Enter")]);
      await expect(badgeKeyboardDestination).toHaveURL(prTwo);
      await expect(badgeKeyboardDestination).toHaveTitle("PR destination intercepted");
      await badgeKeyboardDestination.close();
      await expect(shortcut).toBeVisible();
      await expect(page.locator("main").getByText(otherName, { exact: true })).toHaveCount(1);
      if (mobile) await expect(page.getByRole("button", { name: "Workspace", exact: true })).toHaveClass(/mobile-tab-active/);
      const [badgePointerDestination] = await Promise.all([context.waitForEvent("page"), mobile ? sidebarBadge.tap() : sidebarBadge.click()]);
      await expect(badgePointerDestination).toHaveURL(prTwo);
      await expect(badgePointerDestination).toHaveTitle("PR destination intercepted");
      await badgePointerDestination.close();
      await expect(shortcut).toBeVisible();
      await expect(page.locator("main").getByText(otherName, { exact: true })).toHaveCount(1);
      if (mobile) await expect(page.getByRole("button", { name: "Workspace", exact: true })).toHaveClass(/mobile-tab-active/);
      await screenshot("unselected-session-pr-badge");

      await menuControl.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu", { name: "Session actions", exact: true });
      const prAction = menu.getByRole("menuitem", { name: `Open pull request: PR #456 in fmktech/ftown: ${prTwo}`, exact: true });
      await expect(menu).toBeVisible();
      await expect(prAction).toHaveAttribute("href", prTwo);
      await expect(prAction).toHaveAttribute("target", "_blank");
      await expect(prAction).toHaveAttribute("rel", "noopener noreferrer");
      await expect(menu.getByRole("menuitem").first()).toHaveAccessibleName(`Open pull request: PR #456 in fmktech/ftown: ${prTwo}`);
      const menuBox = await menu.boundingBox();
      expect(menuBox).not.toBeNull();
      expect(menuBox!.x).toBeGreaterThanOrEqual(0);
      expect(menuBox!.y).toBeGreaterThanOrEqual(0);
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width);
      expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport.height);
      if (mobile) {
        expect(menuBox!.width).toBeGreaterThanOrEqual(200);
        expect(menuBox!.width).toBeLessThanOrEqual(viewport.width - 16);
        for (const action of await menu.getByRole("menuitem").all()) {
          const actionBox = await action.boundingBox();
          expect(actionBox).not.toBeNull();
          expect(actionBox!.height).toBeGreaterThanOrEqual(44);
          expect(await action.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
        }
      }
      await expect(menu).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(prAction).toBeFocused();
      expect(await prAction.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe("none");
      await expect(shortcut).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
      await screenshot("attention-with-pr-menu");
      const [keyboardDestination] = await Promise.all([context.waitForEvent("page"), page.keyboard.press("Enter")]);
      await expect(keyboardDestination).toHaveURL(prTwo);
      await expect(keyboardDestination).toHaveTitle("PR destination intercepted");
      await keyboardDestination.close();
      await expect(menu).toHaveCount(0);
      if (mobile) await menuControl.tap();
      else await menuControl.click();
      await expect(prAction).toBeVisible();
      const [pointerDestination] = await Promise.all([context.waitForEvent("page"), mobile ? prAction.tap() : prAction.click()]);
      await expect(pointerDestination).toHaveURL(prTwo);
      await expect(pointerDestination).toHaveTitle("PR destination intercepted");
      await pointerDestination.close();
      await expect(menu).toHaveCount(0);
      await expect(page.locator("main").getByText(otherName, { exact: true })).toHaveCount(1);
      await expect(page.locator("main").getByRole("link", { name: /PR #/ })).toHaveCount(0);
      await expect(shortcut).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
      if (mobile) await expect(page.getByRole("button", { name: "Workspace", exact: true })).toHaveClass(/mobile-tab-active/);
      expect(await sessionRow(page, targetName).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await screenshot("attention-with-associated-pr");
      await shortcut.click();
      await expect(replacementLink).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
      if (mobile) await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveClass(/mobile-tab-active/);
      await tabIntoHeaderLink(page, replacementLink, mobile);
      await screenshot("selected-session-pr-link");
      const beforeThinking = receivedHooks.length;
      const thinkingHook = await bridgeApiFetch("POST", "/hook", { body: {
        ftown_session_id: targetId, hook_event_name: "PostToolUse", tool_name: "exec_command",
      } });
      expect(thinkingHook.status, JSON.stringify(thinkingHook.body)).toBeGreaterThanOrEqual(200);
      expect(thinkingHook.status, JSON.stringify(thinkingHook.body)).toBeLessThan(300);
      await expect.poll(() => receivedHooks.slice(beforeThinking).some(event =>
        event.channel.startsWith(`events:${targetId}#`) && event.eventName === "PostToolUse",
      )).toBe(true);
      await showWorkspace();
      await expect(originalRow(page, targetName).getByText(/^◌\s*thinking\.\.\.$/)).toBeVisible();
      await expectBadgeGeometry(sessionRow(page, targetName));
      await screenshot("selected-thinking-pr-badge");
      await expect(shortcut).toBeVisible();
      await expect(shortcut.getByText(message, { exact: true })).toBeVisible();
      await expect(originalRow(page, targetName).getByText(message, { exact: true })).toHaveCount(0);
      await originalRow(page, otherName).getByText(otherName, { exact: true }).click();
      await showWorkspace();
      const dismissControl = region.getByRole("button", { name: `Dismiss attention for ${targetName}`, exact: true });
      const dismissBox = await dismissControl.boundingBox();
      expect(dismissBox).not.toBeNull();
      expect(dismissBox!.width).toBeGreaterThanOrEqual(44);
      expect(dismissBox!.height).toBeGreaterThanOrEqual(44);
      if (mobile) await dismissControl.tap();
      else {
        await shortcut.focus();
        await page.keyboard.press("Tab");
        await expect(dismissControl).toBeFocused();
        await page.keyboard.press("Enter");
      }
      await expect(page.locator("main").getByText(otherName, { exact: true })).toHaveCount(1);
      await expect(page.locator("main").getByRole("link", { name: /PR #/ })).toHaveCount(0);
      if (mobile) await expect(page.getByRole("button", { name: "Workspace", exact: true })).toHaveClass(/mobile-tab-active/);
      await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
      await expect(region.getByRole("button", { name: new RegExp(targetName) })).toHaveCount(0);
      const dismissed = await bridgeApiFetch("GET", `/api/sessions/${targetId}/attention?includeResolved=true`);
      expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);
      const dismissedEvent = (dismissed.body as AttentionPage).events.find(event => event.id === attention.event.id);
      expect(dismissedEvent?.resolvedAt).toBeTruthy();
      expect(dismissedEvent?.resolution).toBe("manual");
      await page.reload();
      await waitForBridgeOnline(page);
      await showWorkspace();
      await expect(originalRow(page, targetName)).toBeVisible();
      await expect(region.getByRole("button", { name: new RegExp(targetName) })).toHaveCount(0);
      await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);

      const unchanged = await bridgeApiFetch("GET", `/api/sessions/${otherId}`);
      expect(unchanged.status).toBe(200);
      expect((unchanged.body as SessionResult).session).not.toHaveProperty("pullRequestUrl");
      const cleared = await sessionCommand<SessionResult>(targetId, ["pr", "--clear"]);
      expect(cleared.session.id).toBe(targetId);
      expect(cleared.session).not.toHaveProperty("pullRequestUrl");
      await expect(originalRow(page, targetName).getByText(/PR #/)).toHaveCount(0);
      await expect(sessionRow(page, targetName).getByRole("link")).toHaveCount(0);
      if (mobile) await menuControl.tap();
      else await menuControl.click();
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^Open pull request:/ })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await originalRow(page, targetName).getByText(targetName, { exact: true }).click();
      await expect(replacementLink).toHaveCount(0);
      await page.reload();
      await waitForBridgeOnline(page);
      await showWorkspace();
      await expect(originalRow(page, targetName)).toBeVisible();
      await expect(originalRow(page, targetName).getByText(/PR #/)).toHaveCount(0);
      await expect(sessionRow(page, targetName).getByRole("link")).toHaveCount(0);
      await originalRow(page, targetName).getByText(targetName, { exact: true }).click();
      await expect(page.locator("main").getByRole("link", { name: /PR #/ })).toHaveCount(0);
    } finally {
      // Session IDs are recorded only after this test created them.
      for (const id of created.reverse()) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined);
    }
  });
  });
}
