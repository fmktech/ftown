import type { CDPSession, Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { E2E_DIR } from "../helpers/config";

const execute = promisify(execFile);
const sharp = createRequire(join(E2E_DIR, "..", "ui", "package.json"))("sharp");
const MAX_FRAMES = 2000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_SECONDS = 60;

type Frame = { filename: string; timestamp: number };
export type Video = { src: string; width: number; height: number; durationSeconds: number; bytes: number };

/** Record only the already-approved dashboard; no setup or browser-context video. */
export async function recordVideo(page: Page, directory: string, name: "desktop-workspace" | "mobile-terminal", size: { width: number; height: number }, actions: () => Promise<void>): Promise<Video> {
  await page.bringToFront();
  const viewport = page.viewportSize();
  if (!viewport || viewport.width !== size.width || viewport.height !== size.height) throw new Error("Recording viewport differs from export dimensions");
  // Chromium's first screencast frame can retain the previous viewport after
  // resize. A CSS-scale screenshot synchronizes the actual renderer without
  // altering or publishing the page; keep the frame invariant below strict.
  const settled = await sharp(await page.screenshot({ scale: "css" })).metadata();
  if (settled.width !== size.width || settled.height !== size.height) {
    throw new Error(`Pre-recording screenshot dimensions ${settled.width ?? "unavailable"}x${settled.height ?? "unavailable"} do not match expected ${size.width}x${size.height}`);
  }
  const frameDirectory = join(directory, `frames-${name}`);
  await mkdir(frameDirectory); // Fail instead of overwriting any prior recording.
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const frames: Frame[] = [];
  let totalBytes = 0;
  let pending: Promise<void> = Promise.resolve();
  let lastObserved: number | undefined;
  let latestUnsampled: { data: Buffer; timestamp: number; metadata: { deviceWidth?: number; deviceHeight?: number; pageScaleFactor?: number } } | undefined;
  const acknowledgements = new Set<Promise<void>>();
  let failure: Error | undefined;
  let started = false;
  let stopTimestamp = 0;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  // A frame can arrive before startScreencast resolves and before the race is installed.
  void deadline.catch(() => {});
  const fail = (error: unknown) => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error("Screencast failed");
    rejectDeadline(failure);
  };
  const retain = (frame: { data: Buffer; timestamp: number; metadata: { deviceWidth?: number; deviceHeight?: number; pageScaleFactor?: number } }) => {
    if (frames.length >= MAX_FRAMES || totalBytes + frame.data.length > MAX_BYTES) {
      fail(new Error("Screencast frame or storage limit exceeded")); return;
    }
    totalBytes += frame.data.length;
    const filename = `frame-${String(frames.length).padStart(6, "0")}.jpg`;
    frames.push({ filename, timestamp: frame.timestamp });
    pending = pending.then(async () => {
      const metadata = await sharp(frame.data).metadata();
      if (metadata.width !== size.width || metadata.height !== size.height) {
        const safeNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? String(value) : "unavailable";
        throw new Error(`Screencast frame dimensions ${safeNumber(metadata.width)}x${safeNumber(metadata.height)} do not match expected ${size.width}x${size.height}; deviceWidth=${safeNumber(frame.metadata.deviceWidth)} deviceHeight=${safeNumber(frame.metadata.deviceHeight)} pageScaleFactor=${safeNumber(frame.metadata.pageScaleFactor)}`);
      }
      await writeFile(join(frameDirectory, filename), frame.data, { flag: "wx" });
    }).catch(fail);
  };
  const onFrame = (frame: { data: string; sessionId: number; metadata: { timestamp?: number; deviceWidth?: number; deviceHeight?: number; pageScaleFactor?: number } }) => {
    // Acknowledge without waiting for disk, to avoid stalling Chromium.
    const acknowledgement = cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).then(() => {}, fail);
    acknowledgements.add(acknowledgement);
    void acknowledgement.then(() => acknowledgements.delete(acknowledgement));
    if (failure) return;
    const timestamp = frame.metadata.timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0
      || Math.abs(timestamp - Date.now() / 1000) > 5 || (lastObserved !== undefined && timestamp <= lastObserved)) {
      fail(new Error("Invalid or out-of-order screencast timestamp")); return;
    }
    lastObserved = timestamp;
    const data = Buffer.from(frame.data, "base64");
    if (!data.length || data.length > MAX_BYTES) {
      fail(new Error("Screencast frame or storage limit exceeded")); return;
    }
    const candidate = { data, timestamp, metadata: frame.metadata };
    const lastRetained = frames.at(-1)?.timestamp;
    if (lastRetained === undefined || timestamp - lastRetained >= 1 / 24) {
      latestUnsampled = undefined;
      retain(candidate);
    } else latestUnsampled = candidate;
  };
  cdp.on("Page.screencastFrame", onFrame);
  try {
    started = true;
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
    timer = setTimeout(() => fail(new Error("Screencast exceeded 60 seconds")), MAX_SECONDS * 1000);
    await Promise.race([actions(), deadline]);
    if (failure) throw failure;
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    if (timer) clearTimeout(timer);
    if (started) {
      try { await cdp.send("Page.stopScreencast"); } catch (error) { cleanupErrors.push(error); }
      stopTimestamp = Date.now() / 1000;
    }
    try { cdp.off("Page.screencastFrame", onFrame); } catch (error) { cleanupErrors.push(error); }
    try { await Promise.all(acknowledgements); } catch (error) { cleanupErrors.push(error); }
    if (!hasPrimaryError && !failure && cleanupErrors.length === 0 && latestUnsampled) retain(latestUnsampled);
    latestUnsampled = undefined;
    try { await pending; } catch (error) { cleanupErrors.push(error); }
    try { await cdp.detach(); } catch (error) { cleanupErrors.push(error); }
    if (failure && failure !== primaryError) {
      if (!hasPrimaryError) { primaryError = failure; hasPrimaryError = true; }
      else cleanupErrors.push(failure);
    }
    if (hasPrimaryError && cleanupErrors.length) {
      throw new AggregateError([primaryError, ...cleanupErrors], "Screencast failed and cleanup also failed", { cause: primaryError });
    }
    if (hasPrimaryError) throw primaryError;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Screencast cleanup failed");
  }
  if (!frames.length) throw new Error("Screencast produced no frames");
  const last = frames[frames.length - 1];
  if (!Number.isFinite(stopTimestamp) || stopTimestamp < last.timestamp || stopTimestamp - frames[0].timestamp > MAX_SECONDS) throw new Error("Invalid screencast stop timestamp");
  const durations = frames.map((frame, index) => (frames[index + 1]?.timestamp ?? stopTimestamp) - frame.timestamp);
  if (durations.some(duration => !Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS)) throw new Error("Invalid screencast frame duration");
  // Frame names are generated locally and relative to the concat file's cwd.
  const concat = frames.map((frame, index) => `file '${frame.filename}'\nduration ${durations[index].toFixed(6)}\n`).join("") + `file '${last.filename}'\n`;
  await writeFile(join(frameDirectory, "frames.txt"), concat, { flag: "wx" });
  const output = join(directory, `${name}.mp4`);
  await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "1", "-i", "frames.txt", "-an", "-r", "24", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-n", output], { cwd: frameDirectory, timeout: 120_000, maxBuffer: 1024 * 1024 });
  const { stdout } = await execute("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,pix_fmt,width,height:format=duration", "-of", "json", output], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  const probe = JSON.parse(stdout) as { streams?: { codec_name?: string; pix_fmt?: string; width?: number; height?: number }[]; format?: { duration?: string } };
  const stream = probe.streams?.[0];
  const duration = Number(probe.format?.duration);
  const bytes = (await stat(output)).size;
  if (probe.streams?.length !== 1 || !stream || stream.codec_name !== "h264" || stream.pix_fmt !== "yuv420p" || stream.width !== size.width || stream.height !== size.height
    || !Number.isFinite(duration) || duration < 10 || duration > MAX_SECONDS || bytes <= 0 || bytes > 5 * 1024 * 1024) throw new Error("Encoded video violates capture contract");
  return { src: `/product/${name}.mp4`, width: stream.width, height: stream.height, durationSeconds: duration, bytes };
}
