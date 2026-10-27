"use client";

import { useEffect, useRef, useState } from "react";

type Variant = { src: string; width: number; height: number; bytes: number };
type Capture = { src: string; width: number; height: number; variants: Variant[] };
type Video = { src: string; width: number; height: number; durationSeconds: number; bytes: number };
type Props = {
  kind: "desktop" | "mobile";
  image: Capture;
  video: Video;
  alt: string;
  sizes: string;
  loading: "eager" | "lazy";
  fetchPriority?: "high" | "auto" | "low";
};

type PlaybackState = "idle" | "loading" | "playing" | "error";

export function ProductWalkthrough({ kind, image, video, alt, sizes, loading, fetchPriority }: Props) {
  const player = useRef<HTMLVideoElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const attempted = useRef(false);
  const generation = useRef(0);
  const [state, setState] = useState<PlaybackState>("idle");
  const showPlayer = state === "playing" || state === "error";
  const label = kind === "desktop" ? "desktop" : "mobile";

  useEffect(() => {
    if (state === "playing") player.current?.focus({ preventScroll: true });
    if (state === "error") retryButton.current?.focus({ preventScroll: true });
  }, [state]);

  function play() {
    const element = player.current;
    if (!element || inFlight.current) return;
    inFlight.current = true;
    attempted.current = true;
    const attempt = ++generation.current;
    setState("loading");
    if (element.error) element.load();
    void element.play().then(() => {
      if (attempt !== generation.current) return;
      inFlight.current = false;
      setState("playing");
    }).catch(() => {
      if (attempt !== generation.current) return;
      inFlight.current = false;
      setState("error");
    });
  }

  return (
    <div
      data-product-scene={kind}
      className={`relative w-full overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-muted)] bg-[var(--bg-elevated)] after:pointer-events-none after:absolute after:inset-0 after:rounded-[var(--radius-md)] focus-within:after:shadow-[inset_0_0_0_3px_var(--accent)] ${kind === "mobile" ? "mx-auto max-w-[280px]" : ""}`}
      style={{ aspectRatio: `${image.width} / ${image.height}` }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.src}
        srcSet={image.variants.map((variant) => `${variant.src} ${variant.width}w`).join(", ")}
        sizes={sizes}
        width={image.width}
        height={image.height}
        alt={alt}
        loading={loading}
        fetchPriority={fetchPriority}
        className={`absolute inset-0 h-full w-full object-contain ${showPlayer ? "invisible" : ""}`}
      />
      <video
        ref={player}
        aria-label={`FTown ${label} AI demo`}
        controls
        playsInline
        preload="none"
        poster={image.src}
        src={video.src}
        width={video.width}
        height={video.height}
        tabIndex={showPlayer ? 0 : -1}
        onError={(event) => {
          if (attempted.current && event.currentTarget.error) {
            generation.current++;
            inFlight.current = false;
            setState("error");
          }
        }}
        className={`absolute inset-0 h-full w-full object-contain focus-visible:!shadow-[inset_0_0_0_3px_var(--accent)] ${showPlayer ? "" : "invisible"}`}
      />
      {state === "idle" && (
        <button
          type="button"
          aria-label={`Play ${label} AI demo`}
          onClick={play}
          className="absolute bottom-2 left-2 flex min-h-16 max-w-[calc(100%-16px)] items-center gap-2 rounded-full bg-[var(--bg-void)] pr-4 text-left text-[var(--text-primary)] shadow-lg focus-visible:!shadow-[inset_0_0_0_3px_var(--accent)]"
        >
          <span aria-hidden="true" className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-2xl text-[var(--bg-void)]">▶</span>
          <span className="text-[13px] font-semibold leading-tight">Play {kind === "desktop" ? "AI" : "phone"} demo<br /><span className="text-[var(--text-secondary)]">{Math.ceil(video.durationSeconds)} sec</span></span>
        </button>
      )}
      {state === "loading" && <p role="status" className="absolute bottom-2 left-2 rounded-[var(--radius-sm)] bg-[var(--bg-void)] px-3 py-2 text-sm text-[var(--text-primary)]">Loading demo…</p>}
      {state === "error" && (
        <div role="status" aria-live="polite" className="absolute top-2 left-2 right-2 rounded-[var(--radius-md)] bg-[var(--bg-void)] p-3 text-sm text-[var(--text-primary)]">
          <p>The demo could not play.</p>
          <div className="flex flex-wrap items-center gap-x-4">
            <button ref={retryButton} type="button" onClick={play} className="min-h-11 rounded-[var(--radius-sm)] text-[var(--accent)] focus-visible:!shadow-[inset_0_0_0_3px_var(--accent)]">Try again</button>
            <a href={video.src} className="inline-flex min-h-11 items-center rounded-[var(--radius-sm)] text-[var(--accent)] focus-visible:!shadow-[inset_0_0_0_3px_var(--accent)]">Open video file</a>
          </div>
        </div>
      )}
    </div>
  );
}
