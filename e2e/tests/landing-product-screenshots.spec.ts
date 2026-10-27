import { expect, test, type Page } from "@playwright/test";
import { registerAndLogin } from "../helpers/app";

const captures = [
  {
    alt: "FTown desktop showing Codex receiving replies from its Claude Code and Pi sessions.",
    loading: "eager",
    widths: [640, 1120, 2240],
  },
  {
    alt: "FTown on a phone-sized screen showing Codex's summary of replies from Claude Code and Pi, with touch controls.",
    loading: "lazy",
    widths: [390, 780],
  },
  {
    alt: "FTown Security Access panel showing approved browsers and verified computer access.",
    loading: "lazy",
    widths: [],
  },
] as const;

const desktopCaption = "Codex opens Claude Code and Pi, delegates two checks and reads their replies. Waiting time omitted.";
function sceneBoundary(page: Page, kind: "desktop" | "mobile") {
  return kind === "desktop" ? page.getByText(desktopCaption, { exact: true }) : page.locator("#solo");
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 1000, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
  test(`public landing shows real product captures at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Command every coding agent from one browser.");
    await expect(page.getByRole("heading", { name: "Your workspace, wherever you are." })).toBeVisible();
    await expect(page.locator("video[autoplay], video[loop]")).toHaveCount(0);
    await expect(page.locator("details")).toHaveCount(0);
    await expect(page.getByText(/Watch (desktop|mobile) walkthrough/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Open .*screenshot/i })).toHaveCount(0);
    await expect(page.locator('a[href*=".webp"]')).toHaveCount(0);
    await expect(page.getByText(desktopCaption, { exact: true })).toBeVisible();
    await expect(page.getByText("Follow the same agents and their replies from your phone.", { exact: true })).toBeVisible();
    for (const label of ["Play desktop AI demo", "Play mobile AI demo"]) {
      const button = page.getByRole("button", { name: label });
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByRole("link", { name: "Sign In" })).toHaveAttribute("href", "/login");
    await expect(page.getByRole("link", { name: "Try Hosted" }).first()).toHaveAttribute("href", "/register");
    const selfHost = page.getByRole("link", { name: "Self-host (Open Source)" }).first();
    await expect(selfHost).toHaveAttribute("href", "#solo");
    const hero = page.getByAltText(captures[0].alt);
    if (viewport.width === 1280) {
      const rect = await hero.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.y).toBeLessThan(viewport.height);
    }

    for (const capture of captures) {
      const image = page.getByAltText(capture.alt);
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
      await expect(image).toHaveAttribute("loading", capture.loading);
      await expect(image).toHaveAttribute("sizes", /.+/);
      const metrics = await image.evaluate((element: HTMLImageElement) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const contentWidth = rect.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
          - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const contentHeight = rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)
          - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        const sizeEntry = element.sizes.split(",").map((entry) => entry.trim()).find((entry) => {
          const match = entry.match(/^\(([^)]+)\)\s+(.+)$/);
          return !match || matchMedia(`(${match[1]})`).matches;
        });
        if (!sizeEntry) throw new Error("No matching sizes entry");
        const sizeMatch = sizeEntry.match(/^\(([^)]+)\)\s+(.+)$/);
        const probe = document.createElement("div");
        probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;height:0;padding:0;border:0";
        probe.style.width = sizeMatch ? sizeMatch[2] : sizeEntry;
        document.body.appendChild(probe);
        const advertisedWidth = probe.getBoundingClientRect().width;
        probe.remove();
        return {
          advertisedWidth,
          renderedWidth: rect.width,
          width: element.width,
          height: element.height,
          intrinsicWidth: Number(element.getAttribute("width")),
          intrinsicHeight: Number(element.getAttribute("height")),
          displayedRatio: contentWidth / contentHeight,
          source: new URL(element.currentSrc).pathname,
          candidates: element.srcset,
          objectFit: style.objectFit,
        };
      });
      expect(Math.abs(metrics.advertisedWidth - metrics.renderedWidth)).toBeLessThanOrEqual(2);
      expect(metrics.intrinsicWidth).toBeGreaterThan(0);
      expect(metrics.intrinsicHeight).toBeGreaterThan(0);
      expect(Math.abs(metrics.displayedRatio - metrics.intrinsicWidth / metrics.intrinsicHeight)).toBeLessThan(0.015);
      expect(metrics.source).toMatch(/^\/product\/.*\.webp$/);
      expect(metrics.objectFit).not.toBe("cover");
      const expectedWidths: readonly number[] = capture.widths.length ? capture.widths : [...new Set([Math.min(896, metrics.intrinsicWidth), metrics.intrinsicWidth])];
      for (const width of expectedWidths) expect(metrics.candidates).toContain(` ${width}w`);
      const response = await page.request.get(metrics.source);
      expect(response.ok()).toBe(true);
      expect(response.headers()["content-type"]).toMatch(/^image\/webp\b/);
      expect((await response.body()).byteLength).toBeGreaterThan(0);
    }
    await expect(hero).toHaveAttribute("fetchpriority", "high");
    await expect(page.getByAltText(captures[1].alt)).not.toHaveAttribute("fetchpriority", "high");
    await expect(page.getByAltText(captures[2].alt)).not.toHaveAttribute("fetchpriority", "high");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    for (const name of ["Sign In", "Try Hosted", "Self-host (Open Source)"]) {
      const target = page.getByRole("link", { name, exact: true }).first();
      const box = await target.boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
      expect(box!.width, name).toBeGreaterThanOrEqual(44);
    }

    await page.getByRole("link", { name: "Try Hosted" }).first().focus();
    const focusOrder = [
      page.getByRole("link", { name: "Self-host (Open Source)", exact: true }).first(),
      page.getByRole("link", { name: "GitHub", exact: true }).first(),
      page.getByRole("button", { name: "Play desktop AI demo" }),
      page.getByRole("button", { name: "Play mobile AI demo" }),
    ];
    for (const focused of focusOrder) {
      await page.keyboard.press("Tab");
      await expect(focused).toBeFocused();
      expect(await focused.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
    }

    await expect(page.getByRole("region", { name: "Follow the data, know the endpoints." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your fleet, in your MCP client." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Keep questions in view" })).toBeVisible();
    await expect(page.getByText("https://ftown-mcp.fly.dev/mcp", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "MCP setup & capabilities" })).toHaveAttribute("href", "https://github.com/fmktech/ftown/blob/main/docs/mcp.md");
    await expect(page.locator("body")).not.toContainText(/Scheduled loops|Cron for agents|Per-loop controls/);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /MCP fleet control/);
    await expect(page.getByRole("link", { name: "Read the Solo guide →" })).toHaveAttribute("href", "https://github.com/fmktech/ftown/blob/main/docs/solo.md");
    await expect(page.locator("#solo code").first()).not.toBeEmpty();
    await selfHost.click();
    await expect(page).toHaveURL(/#solo$/);
    await expect(page.locator("#solo")).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`landing-${viewport.width}.png`), fullPage: true });
    await hero.scrollIntoViewIfNeeded();
    await hero.screenshot({ path: info.outputPath(`hero-${viewport.width}.png`) });
    await page.getByRole("region", { name: "Your workspace, wherever you are." }).screenshot({ path: info.outputPath(`supporting-${viewport.width}.png`) });

    if (viewport.width === 320 || viewport.width === 1000) {
      for (const item of [
        { kind: "desktop", button: "Play desktop AI demo" },
        { kind: "mobile", button: "Play mobile AI demo" },
      ] as const) {
        const scene = page.locator(`[data-product-scene="${item.kind}"]`);
        const next = sceneBoundary(page, item.kind);
        const before = await scene.boundingBox();
        const nextBefore = await next.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
        await scene.getByRole("button", { name: item.button }).click();
        const video = scene.locator("video");
        await expect(video).toBeVisible();
        const after = await scene.boundingBox();
        const nextAfter = await next.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
        expect(before).not.toBeNull();
        expect(after).not.toBeNull();
        expect(Math.abs(after!.width - before!.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
        expect(Math.abs(nextAfter - nextBefore)).toBeLessThanOrEqual(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await video.evaluate((element: HTMLVideoElement) => element.pause());
        await scene.screenshot({ path: info.outputPath(`ai-playing-${item.kind}-${viewport.width}.png`) });
      }
    }
    expect(pageErrors).toEqual([]);
  });
}

test("authenticated visitors still redirect from the public landing page", async ({ page }) => {
  await registerAndLogin(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/dashboard$/);
});


for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`AI demos play on demand at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const mediaRequests: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/product/desktop-workspace.mp4" || path === "/product/mobile-terminal.mp4") mediaRequests.push(path);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const documentUrl = page.url();
      const analyticsUrl = `${new URL(documentUrl).origin}/_vercel/insights/script.js`;
      const missingAnalytics = message.text() === "Failed to load resource: the server responded with a status of 404 (Not Found)"
        && message.location().url === analyticsUrl;
      const analyticsMime = message.text() === `Refused to execute script from '${analyticsUrl}' because its MIME type ('text/html') is not executable, and strict MIME type checking is enabled.`
        && message.location().url === documentUrl;
      if (!missingAnalytics && !analyticsMime) errors.push(message.text());
    });
    await page.goto("/");
    await page.waitForLoadState("load");
    const manifestResponse = await page.request.get("/product/manifest.json");
    expect(manifestResponse.ok()).toBe(true);
    const manifest = await manifestResponse.json() as {
      version: number;
      videos: Record<"desktop" | "mobile", { src: string; width: number; height: number; durationSeconds: number; bytes: number }>;
    };
    expect(manifest.version).toBe(2);
    expect(mediaRequests).toEqual([]);
    await expect(page.locator("video")).toHaveCount(2);
    await page.screenshot({ path: info.outputPath(`ai-idle-${viewport.width}.png`), fullPage: true });

    for (const item of [
      { kind: "mobile", button: "Play mobile AI demo", alt: captures[1].alt, path: "/product/mobile-terminal.mp4", width: 390, height: 844, maxDuration: 60, maxBytes: 5 * 1024 * 1024 },
      { kind: "desktop", button: "Play desktop AI demo", alt: captures[0].alt, path: "/product/desktop-workspace.mp4", width: 1280, height: 800, maxDuration: 120, maxBytes: 10 * 1024 * 1024 },
    ] as const) {
      const scene = page.locator(`[data-product-scene="${item.kind}"]`);
      const poster = scene.getByAltText(item.alt);
      const video = scene.locator("video");
      const button = scene.getByRole("button", { name: item.button });
      const next = sceneBoundary(page, item.kind);
      const metadata = manifest.videos[item.kind];
      await expect(poster).toBeVisible();
      await expect(video).not.toBeVisible();
      await expect(button).toBeVisible();
      await expect(video).toHaveAttribute("controls", "");
      await expect(video).toHaveAttribute("playsinline", "");
      await expect(video).toHaveAttribute("preload", "none");
      await expect(video).not.toHaveAttribute("autoplay", "");
      await expect(video).not.toHaveAttribute("loop", "");
      await expect(video).toHaveAttribute("src", item.path);
      expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBe(0);
      expect(metadata.src).toBe(item.path);
      expect(metadata.width).toBe(item.width);
      expect(metadata.height).toBe(item.height);
      expect(metadata.bytes).toBeGreaterThan(0);
      expect(metadata.bytes).toBeLessThanOrEqual(item.maxBytes);
      expect(mediaRequests).not.toContain(item.path);
      await button.scrollIntoViewIfNeeded();
      const before = await scene.boundingBox();
      const nextBefore = await next.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
      expect(before).not.toBeNull();
      const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === item.path);
      if (item.kind === "mobile") {
        await page.getByRole("link", { name: "GitHub", exact: true }).first().focus();
        await page.keyboard.press("Tab");
        const desktopButton = page.getByRole("button", { name: "Play desktop AI demo" });
        await expect(desktopButton).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(button).toBeFocused();
        expect(await button.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        expect(await button.evaluate((element) => getComputedStyle(element).boxShadow)).toContain("inset");
        await page.keyboard.press("Enter");
      } else {
        await button.click();
      }
      const response = await responsePromise;
      expect(response.ok()).toBe(true);
      expect(response.headers()["content-type"]).toMatch(/^video\/mp4\b/);
      const fullVideoResponse = await page.request.get(item.path);
      expect(fullVideoResponse.ok()).toBe(true);
      expect(fullVideoResponse.headers()["content-type"]).toMatch(/^video\/mp4\b/);
      expect((await fullVideoResponse.body()).byteLength).toBe(metadata.bytes);
      if (item.kind === "mobile") expect(mediaRequests).not.toContain("/product/desktop-workspace.mp4");
      await expect(video).toBeVisible();
      await expect(video).toBeFocused();
      if (item.kind === "mobile") {
        expect(await video.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        expect(await scene.evaluate((element) => getComputedStyle(element, "::after").boxShadow)).toContain("inset");
      }
      await expect(poster).not.toBeVisible();
      await expect(scene.locator("img:visible")).toHaveCount(0);
      await expect(scene.getByRole("button", { name: item.button })).toHaveCount(0);
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.2);
      const playback = await video.evaluate((element: HTMLVideoElement) => {
        element.pause();
        return { width: element.videoWidth, height: element.videoHeight, duration: element.duration, paused: element.paused, errorCode: element.error?.code ?? null };
      });
      expect(playback.width).toBe(item.width);
      expect(playback.height).toBe(item.height);
      expect(playback.duration).toBeGreaterThanOrEqual(10);
      expect(playback.duration).toBeLessThanOrEqual(item.maxDuration);
      expect(Math.abs(playback.duration - metadata.durationSeconds)).toBeLessThan(0.15);
      expect(playback.paused).toBe(true);
      expect(playback.errorCode).toBeNull();
      const after = await scene.boundingBox();
      const nextAfter = await next.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
      expect(after).not.toBeNull();
      expect(Math.abs(after!.width - before!.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(nextAfter - nextBefore)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await scene.screenshot({ path: info.outputPath(`ai-playing-${item.kind}-${viewport.width}.png`) });
    }
    expect(errors).toEqual([]);
  });
}

test.describe("video network failure", () => {
  test.use({ serviceWorkers: "block" });

  test("a failed AI demo offers retry and recovers when the video is available", async ({ page }, info) => {
    await page.setViewportSize({ width: 320, height: 844 });
    let attempts = 0;
    let blocked = true;
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/product/desktop-workspace.mp4", async (route) => {
      attempts++;
      if (blocked) await route.abort("failed");
      else await route.continue();
    });
    await page.goto("/");
    const scene = page.locator('[data-product-scene="desktop"]');
    const before = await scene.boundingBox();
    await scene.getByRole("button", { name: "Play desktop AI demo" }).click();
    await expect.poll(() => attempts).toBeGreaterThanOrEqual(1);
    await expect(scene.getByRole("status")).toContainText("The demo could not play.");
    const retry = scene.getByRole("button", { name: "Try again" });
    await expect(retry).toBeFocused();
    const video = scene.locator("video");
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute("controls", "");
    await expect(video).toHaveAttribute("poster", (await scene.locator("img").getAttribute("src"))!);
    await expect(scene.locator("img")).not.toBeVisible();
    const fallback = scene.getByRole("link", { name: "Open video file" });
    await expect(fallback).toHaveAttribute("href", "/product/desktop-workspace.mp4");
    for (const control of [retry, fallback]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await scene.screenshot({ path: info.outputPath("ai-error-320.png") });
    expect(attempts).toBeGreaterThanOrEqual(1);
    const attemptsBeforeRetry = attempts;
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/product/desktop-workspace.mp4");
    blocked = false;
    await retry.click();
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toMatch(/^video\/mp4\b/);
    await expect.poll(() => attempts).toBeGreaterThan(attemptsBeforeRetry);
    await expect(video).toBeVisible();
    await expect(video).toBeFocused();
    await expect(scene.getByText("The demo could not play.")).toHaveCount(0);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.2);
    expect(await video.evaluate((element: HTMLVideoElement) => element.error)).toBeNull();
    await video.evaluate((element: HTMLVideoElement) => element.pause());
    await scene.screenshot({ path: info.outputPath("ai-recovered-320.png") });
    const after = await scene.boundingBox();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.width - before!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
    expect(pageErrors).toEqual([]);
  });
});
