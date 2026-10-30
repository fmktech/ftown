"use client";

import { HeaderTooltip } from "./HeaderTooltip";

export function SessionHeaderActions({ hasPreview, previewOpen, running, relaunchLabel, onPreview, onStop, onRelaunch }: {
  hasPreview: boolean; previewOpen: boolean; running: boolean; relaunchLabel: string | null;
  onPreview: () => void; onStop: () => void; onRelaunch: () => void;
}) {
  const size = "flex h-11 w-11 items-center justify-center md:h-8 md:w-8";
  return <div role="group" aria-label="Selected session actions" className="flex items-center gap-2">
    {hasPreview && !previewOpen && <HeaderTooltip label="Open preview"><button type="button" className={`btn-ghost ${size}`} style={{ padding: 0 }} aria-label="Open preview" onClick={onPreview}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
    </button></HeaderTooltip>}
    {running && <HeaderTooltip label="Stop session"><button type="button" className={`btn-danger ${size}`} style={{ padding: 0 }} aria-label="Stop" onClick={onStop}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="2" width="12" height="12" rx="2"/></svg>
    </button></HeaderTooltip>}
    {relaunchLabel && <HeaderTooltip label={`${relaunchLabel} session`}><button type="button" className={`btn-warn ${size}`} style={{ padding: 0 }} aria-label={relaunchLabel} title="Relaunch this session using the same command" onClick={onRelaunch}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-1.6 4.5M20 12a8 8 0 0 0-2.3-5.7L15 4"/></svg>
    </button></HeaderTooltip>}
  </div>;
}
