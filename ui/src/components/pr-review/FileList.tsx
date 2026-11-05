"use client";

import { memo, useRef, type KeyboardEvent } from "react";
import type { DiffFileStatus } from "@/lib/pr-diff-types";
import { REVIEW_GLYPHS, REVIEW_LABELS, type FileListProps } from "@/lib/pr-review-types";

const STATUS_LETTER: Record<DiffFileStatus, string> = { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C" };

export const FileList = memo(function FileList({ files, activeIndex, viewed, onSelect }: FileListProps) {
  const navRef = useRef<HTMLElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const nav = navRef.current;
    if (!nav || !(event.target instanceof HTMLButtonElement)) return;
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>("button.pr-review-filelist-item"));
    const current = buttons.indexOf(event.target);
    if (current === -1) return;
    const next = event.key === "ArrowDown" ? Math.min(current + 1, buttons.length - 1) : Math.max(current - 1, 0);
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <nav ref={navRef} className="pr-review-filelist" aria-label={REVIEW_LABELS.fileNav} onKeyDown={onKeyDown}>
      <ul>
        {files.map((file) => {
          const slash = file.path.lastIndexOf("/");
          const dir = slash === -1 ? "" : file.path.slice(0, slash);
          const base = file.path.slice(slash + 1);
          const isViewed = viewed.has(file.path);
          const isActive = activeIndex === file.index;
          const showCounts = !file.binary && (file.additions > 0 || file.deletions > 0);
          return (
            <li key={file.index}>
              <button
                type="button"
                className={isViewed ? "pr-review-filelist-item is-viewed" : "pr-review-filelist-item"}
                aria-label={file.path}
                title={file.path}
                aria-current={isActive ? "true" : undefined}
                onClick={() => onSelect(file.index)}
              >
                <span className={`pr-review-status-letter is-${file.status}`}>{STATUS_LETTER[file.status]}</span>
                <span className="pr-review-filelist-name">
                  <span className="pr-review-filelist-base">{base}</span>
                  {dir ? <span className="pr-review-filelist-dir">{dir}</span> : null}
                </span>
                {showCounts ? (
                  <span className="pr-review-filelist-counts">
                    {file.additions > 0 ? <span className="pr-review-add">{`+${file.additions}`}</span> : null}
                    {file.deletions > 0 ? <span className="pr-review-del">{`−${file.deletions}`}</span> : null}
                  </span>
                ) : null}
                {isViewed ? (
                  <span className="pr-review-filelist-viewed" aria-hidden="true">
                    {REVIEW_GLYPHS.check}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
});
