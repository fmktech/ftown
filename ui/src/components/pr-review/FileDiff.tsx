"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile, DiffFileStatus } from "@/lib/pr-diff-types";
import { PR_DIFF_GENERATED_FILE, PR_DIFF_LARGE_FILE_LINES } from "@/lib/pr-diff-types";
import type { FileDiffProps } from "@/lib/pr-review-types";
import { REVIEW_GLYPHS, REVIEW_LABELS, diffBarSegments, prReviewFileBodyDomId, prReviewFileDomId } from "@/lib/pr-review-types";
import { DiffTable } from "./DiffTable";

const STATUS_LABEL: Record<DiffFileStatus, string> = {
  added: "Added",
  deleted: "Deleted",
  modified: "Modified",
  renamed: "Renamed",
  copied: "Copied",
};

const COPIED_MS = 1500;

function splitPath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { dir: "", base: path } : { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
}

function emptyNote(file: DiffFile): string {
  if (file.modeChange) return `File mode changed from ${file.modeChange.oldMode} to ${file.modeChange.newMode}.`;
  if (file.status === "renamed") return "File renamed without changes.";
  if (file.status === "copied") return "File copied without changes.";
  if (file.status === "added") return "Empty file.";
  return "No changes to show.";
}

export const FileDiff = memo(function FileDiff({ file, layout, collapsed, viewed, active, onToggleCollapsed, onToggleViewed }: FileDiffProps) {
  const { index, path, status, binary, additions, deletions, hunks } = file;
  const [forcedFile, setForcedFile] = useState<DiffFile | null>(null);
  const forced = forcedFile === file;
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const markCopied = useCallback(() => {
    if (!mounted.current) return;
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setCopied(false);
    }, COPIED_MS);
  }, []);

  const copyPath = useCallback(() => {
    try {
      const pending = navigator.clipboard?.writeText(path);
      if (pending) pending.then(markCopied, () => {});
    } catch {
      // clipboard unavailable or blocked
    }
  }, [path, markCopied]);

  const { dir, base } = useMemo(() => splitPath(path), [path]);
  const segments = useMemo(() => diffBarSegments(additions, deletions), [additions, deletions]);
  const distinctRename = (status === "renamed" || status === "copied") && file.oldPath !== null && file.newPath !== null && file.oldPath !== file.newPath;

  const changed = additions + deletions;
  let note: string | null = null;
  if (binary) note = "Binary file not shown.";
  else if (hunks.length === 0) note = emptyNote(file);
  else if (!forced) {
    if (PR_DIFF_GENERATED_FILE.test(path)) note = "Generated file not rendered.";
    else if (changed > PR_DIFF_LARGE_FILE_LINES) note = `Large diff not rendered (${changed.toLocaleString()} changed lines).`;
  }
  const canLoad = !binary && hunks.length > 0 && note !== null;

  const bodyId = prReviewFileBodyDomId(index);
  const className = ["pr-review-file", active ? "is-active" : "", viewed ? "is-viewed" : "", collapsed ? "is-collapsed" : ""].filter(Boolean).join(" ");

  return (
    <section id={prReviewFileDomId(index)} className={className} aria-label={path}>
      <div className="pr-review-file-header">
        <button
          type="button"
          className="pr-review-file-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${path}`}
          onClick={() => onToggleCollapsed(index)}
        >
          <span className="pr-review-chevron" aria-hidden="true">{collapsed ? REVIEW_GLYPHS.chevronClosed : REVIEW_GLYPHS.chevronOpen}</span>
        </button>
        <span className={`pr-review-file-status is-${status}`}>{STATUS_LABEL[status]}</span>
        <h3 className="pr-review-file-path" title={path}>
          {distinctRename ? (
            <>
              <span className="pr-review-file-old">{file.oldPath}</span>
              {" → "}
              <span className="pr-review-file-new">{file.newPath}</span>
            </>
          ) : (
            <>
              {dir !== "" && <span className="pr-review-file-dir">{dir}</span>}
              <span className="pr-review-file-base">{base}</span>
            </>
          )}
        </h3>
        <button type="button" className="btn-ghost pr-review-icon pr-review-copy" aria-label={REVIEW_LABELS.copyPath} onClick={copyPath}>
          {copied ? "Copied" : REVIEW_GLYPHS.copy}
        </button>
        {!binary && (
          <span className="pr-review-file-counts">
            <span className="pr-review-add">{`+${additions}`}</span>
            <span className="pr-review-del">{`−${deletions}`}</span>
            <span className="pr-review-bar" aria-hidden="true">
              {segments.map((seg, i) => (
                <span key={i} className={`pr-review-bar-seg is-${seg}`} />
              ))}
            </span>
          </span>
        )}
        <label className="pr-review-viewed-toggle">
          <input type="checkbox" checked={viewed} onChange={() => onToggleViewed(path)} />
          Viewed
        </label>
      </div>
      {!collapsed && (
        <div className="pr-review-file-body" id={bodyId}>
          {note !== null ? (
            <p className="pr-review-file-note">
              {note}
              {canLoad && (
                <>
                  {" "}
                  <button type="button" className="btn-ghost pr-review-button" onClick={() => setForcedFile(file)}>Load diff</button>
                </>
              )}
            </p>
          ) : (
            <div className="pr-review-diff-scroll">
              <DiffTable hunks={hunks} layout={layout} label={path} />
            </div>
          )}
        </div>
      )}
    </section>
  );
});
