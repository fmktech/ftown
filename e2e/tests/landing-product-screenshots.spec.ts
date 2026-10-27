import { expect, test } from "@playwright/test";
import { registerAndLogin } from "../helpers/app";

const captures = [
  {
    alt: "FTown desktop dashboard with a session sidebar and an open shell terminal.",
    link: "Open desktop screenshot",
    loading: "eager",
    widths: [640, 1120, 2240],
  },
  {
    alt: "FTown mobile terminal with Workspace and Terminal navigation and touch controls.",
    link: "Open mobile screenshot",
    loading: "lazy",
    widths: [390, 780],
  },
  {
    alt: "FTown Security Access panel showing approved browsers and verified computer access.",
    link: "Open security screenshot",
    loading: "lazy",
    widths: [],
  },
] as const;

for (const viewport of [{ width: 1280, height: 900 }, { width: 1000, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
  test(`public landing shows real product captures at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Command every coding agent from one browser.");
    await expect(page.getByRole("heading", { name: "Your workspace, wherever you are." })).toBeVisible();
    await expect(page.locator("video[autoplay]")).toHaveCount(0);
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
      const link = page.getByRole("link", { name: capture.link });
      const href = await link.getAttribute("href");
      expect(href).toMatch(/^\/product\/.*\.webp$/);
      await expect(link).not.toHaveAttribute("target", "_blank");
    }
    await expect(hero).toHaveAttribute("fetchpriority", "high");
    await expect(page.getByAltText(captures[1].alt)).not.toHaveAttribute("fetchpriority", "high");
    await expect(page.getByAltText(captures[2].alt)).not.toHaveAttribute("fetchpriority", "high");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    for (const name of ["Sign In", "Try Hosted", "Self-host (Open Source)", ...captures.map((capture) => capture.link)]) {
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
      page.getByRole("link", { name: captures[0].link }),
      page.locator("summary").filter({ hasText: "Watch desktop walkthrough" }),
      page.getByRole("link", { name: captures[1].link }),
      page.locator("summary").filter({ hasText: "Watch mobile walkthrough" }),
      page.getByRole("link", { name: captures[2].link }),
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

    for (const capture of captures) {
      const link = page.getByRole("link", { name: capture.link });
      const href = (await link.getAttribute("href"))!;
      const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === href);
      await link.click();
      const response = await responsePromise;
      expect(response.ok()).toBe(true);
      expect(response.headers()["content-type"]).toMatch(/^image\/webp\b/);
      expect(new URL(page.url()).pathname).toBe(href);
      await page.goBack();
      await expect(page.getByRole("link", { name: capture.link })).toBeVisible();
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
  test(`desktop and mobile walkthroughs play on demand at ${viewport.width}px`, async ({ page }, info) => {
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
      videos: Record<"desktop" | "mobile", { src: string; width: number; height: number; durationSeconds: number }>;
    };
    expect(manifest.version).toBe(2);
    expect(mediaRequests).toEqual([]);
    await expect(page.locator("video")).toHaveCount(2);

    for (const item of [
      { kind: "desktop", label: "Watch desktop walkthrough", alt: captures[0].alt, link: captures[0].link, path: "/product/desktop-workspace.mp4", width: 1280, height: 800 },
      { kind: "mobile", label: "Watch mobile walkthrough", alt: captures[1].alt, link: captures[1].link, path: "/product/mobile-terminal.mp4", width: 390, height: 844 },
    ] as const) {
      const summary = page.locator("summary").filter({ hasText: item.label });
      const details = summary.locator("..");
      const video = details.locator("video");
      const metadata = manifest.videos[item.kind];
      await expect(details).not.toHaveAttribute("open", "");
      await expect(video).toHaveAttribute("controls", "");
      await expect(video).toHaveAttribute("playsinline", "");
      await expect(video).toHaveAttribute("preload", "none");
      await expect(video).not.toHaveAttribute("autoplay", "");
      await expect(video).not.toHaveAttribute("loop", "");
      await expect(video).toHaveAttribute("poster", (await page.getByAltText(item.alt).getAttribute("src"))!);
      await expect(video).toHaveAttribute("src", item.path);
      expect(metadata.src).toBe(item.path);
      expect(metadata.width).toBe(item.width);
      expect(metadata.height).toBe(item.height);
      const target = await summary.boundingBox();
      expect(target).not.toBeNull();
      expect(target!.height).toBeGreaterThanOrEqual(44);
      expect(target!.width).toBeGreaterThanOrEqual(44);
      await page.getByRole("link", { name: item.link }).focus();
      await page.keyboard.press("Tab");
      await expect(summary).toBeFocused();
      expect(await summary.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
      await page.keyboard.press("Enter");
      await expect(details).toHaveAttribute("open", "");
      await expect(video).toBeVisible();
      const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === item.path);
      await video.evaluate(async (element: HTMLVideoElement) => { await element.play(); });
      const response = await responsePromise;
      expect(response.ok()).toBe(true);
      expect(response.headers()["content-type"]).toMatch(/^video\/mp4\b/);
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.2);
      const playback = await video.evaluate((element: HTMLVideoElement) => {
        element.pause();
        return { width: element.videoWidth, height: element.videoHeight, duration: element.duration, paused: element.paused, errorCode: element.error?.code ?? null };
      });
      expect(playback.width).toBe(item.width);
      expect(playback.height).toBe(item.height);
      expect(playback.duration).toBeGreaterThan(0);
      expect(playback.duration).toBeLessThanOrEqual(60);
      expect(Math.abs(playback.duration - metadata.durationSeconds)).toBeLessThan(0.15);
      expect(playback.paused).toBe(true);
      expect(playback.errorCode).toBeNull();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`walkthroughs-${viewport.width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}
