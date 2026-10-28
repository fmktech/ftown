"use client";

import { useEffect, useRef, useState } from "react";

const valid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value);
export function AppUpdateNotice({ reload = () => window.location.reload(), buildId = process.env.FTOWN_UI_BUILD_ID }: { reload?: () => void; buildId?: string } = {}) {
  const [newBuild, setNewBuild] = useState<string | null>(null);
  const suppressed = useRef<string | null>(null);
  const current = buildId;
  useEffect(() => {
    if (!valid(current)) return;
    let alive = true; let pending = false; let controller: AbortController | null = null;
    const check = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true; controller = new AbortController();
      try {
        const response = await fetch("/api/version", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) return;
        const value: unknown = await response.json();
        if (!alive || !value || typeof value !== "object" || !("buildId" in value) || !valid(value.buildId)) return;
        let later = ""; try { later = sessionStorage.getItem("ftown:app-update-later") ?? ""; } catch { /* storage is optional */ }
        setNewBuild(value.buildId !== current && value.buildId !== later && value.buildId !== suppressed.current ? value.buildId : null);
      } catch { /* Offline and malformed responses do not announce an update. */ }
      finally { pending = false; }
    };
    void check(); const timer = setInterval(() => void check(), 300_000);
    const visibility = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { alive = false; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [current]);
  if (!newBuild) return null;
  return <div role="status" className="flex flex-wrap items-center gap-2 border-b border-[var(--border-muted)] bg-[var(--bg-elevated)] px-3 py-2 text-sm">
    <span className="font-semibold">App update available</span><span>Reloading reconnects the terminal; unsent dialog input may be lost.</span>
    <button type="button" className="min-h-11 rounded border border-[var(--border-muted)] px-3" onClick={reload}>Reload</button>
    <button type="button" className="min-h-11 px-3" onClick={() => { suppressed.current = newBuild; try { sessionStorage.setItem("ftown:app-update-later", newBuild); } catch { /* keep this tab quiet in memory */ } setNewBuild(null); }}>Later</button>
  </div>;
}
