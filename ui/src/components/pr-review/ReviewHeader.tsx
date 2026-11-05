import {
  REVIEW_CHECKS_LABEL,
  REVIEW_GLYPHS,
  REVIEW_LABELS,
  REVIEW_PR_STATE_LABEL,
  diffBarSegments,
  type ReviewHeaderProps,
} from "@/lib/pr-review-types";
import { relativeTime } from "@/lib/relative-time";

const CHECK_CLASS = {
  passed: "is-passed",
  failed: "is-failed",
  in_progress: "is-running",
  unknown: "is-unknown",
} as const;

function DiffBar({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="pr-review-bar" aria-hidden="true">
      {diffBarSegments(additions, deletions).map((segment, index) => (
        <span key={index} className={`pr-review-bar-seg is-${segment}`} />
      ))}
    </span>
  );
}

function isValidDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function ReviewHeader({
  metadata,
  pullRequest,
  checks,
  refreshing,
  canRefresh,
  expanded,
  now,
  onRefresh,
  onToggleExpand,
  onClose,
}: ReviewHeaderProps) {
  const title = metadata?.title ?? (pullRequest ? `Pull request #${pullRequest.number}` : "Pull request");
  const expandLabel = expanded ? REVIEW_LABELS.collapse : REVIEW_LABELS.expand;

  const checkState = checks ? checks.state : "unknown";
  const checkedAt = checks?.checkedAt ?? null;
  const reason = checks?.reason;
  let chipTitle = checkedAt && isValidDate(checkedAt) ? `Checked ${new Date(checkedAt).toLocaleString()}` : "Not checked yet";
  if (reason) chipTitle += ` · ${reason.replaceAll("_", " ")}`;
  const chip =
    checkState === "merged" || checkState === "closed"
      ? null
      : {
          cls: CHECK_CLASS[checkState],
          label: REVIEW_CHECKS_LABEL[checkState] + (checks?.stale ? " · stale" : ""),
        };

  return (
    <header className="pr-review-header">
      <div className="pr-review-header-top">
        {metadata && <span className={`pr-review-state is-${metadata.state}`}>{REVIEW_PR_STATE_LABEL[metadata.state]}</span>}
        <h2 className="pr-review-title" title={title}>
          {title}
        </h2>
        {metadata && pullRequest && <span className="pr-review-number">{`#${pullRequest.number}`}</span>}
        <div className="pr-review-actions">
          {pullRequest && (
            <a href={pullRequest.url} target="_blank" rel="noopener noreferrer" className="pr-review-link">
              {REVIEW_LABELS.openOnGitHub}
              <span className="pr-review-glyph" aria-hidden="true">
                {REVIEW_GLYPHS.external}
              </span>
            </a>
          )}
          <button
            type="button"
            className="btn-ghost pr-review-icon"
            aria-label={REVIEW_LABELS.refresh}
            title={REVIEW_LABELS.refresh}
            disabled={!canRefresh || refreshing}
            onClick={onRefresh}
          >
            <span className={`pr-review-glyph${refreshing ? " is-spinning" : ""}`} aria-hidden="true">
              {REVIEW_GLYPHS.refresh}
            </span>
          </button>
          <button
            type="button"
            className="btn-ghost pr-review-icon"
            aria-label={expandLabel}
            title={expandLabel}
            aria-pressed={expanded}
            onClick={onToggleExpand}
          >
            <span className="pr-review-glyph" aria-hidden="true">
              {expanded ? REVIEW_GLYPHS.collapse : REVIEW_GLYPHS.expand}
            </span>
          </button>
          <button
            type="button"
            className="btn-ghost pr-review-icon"
            aria-label={REVIEW_LABELS.close}
            title={REVIEW_LABELS.close}
            onClick={onClose}
          >
            <span className="pr-review-glyph" aria-hidden="true">
              {REVIEW_GLYPHS.close}
            </span>
          </button>
        </div>
      </div>
      {metadata && (
        <div className="pr-review-meta">
          <span className="pr-review-meta-item pr-review-author">{`@${metadata.author}`}</span>
          <span className="pr-review-meta-item pr-review-branches">
            <code className="pr-review-branch" title={metadata.headRef}>
              {metadata.headRef}
            </code>
            <span className="pr-review-arrow" aria-hidden="true">
              {REVIEW_GLYPHS.arrow}
            </span>
            <code className="pr-review-branch" title={metadata.baseRef}>
              {metadata.baseRef}
            </code>
          </span>
          {chip && (
            <span className={`pr-review-meta-item pr-review-checks ${chip.cls}`} title={chipTitle}>
              <span className="pr-review-dot" aria-hidden="true" />
              {chip.label}
            </span>
          )}
          <span className="pr-review-meta-item pr-review-stat">
            <span className="pr-review-add">{`+${metadata.additions.toLocaleString()}`}</span>
            <span className="pr-review-del">{`−${metadata.deletions.toLocaleString()}`}</span>
            <DiffBar additions={metadata.additions} deletions={metadata.deletions} />
          </span>
          <span className="pr-review-meta-item">
            {metadata.changedFiles === 1 ? "1 file" : `${metadata.changedFiles} files`}
          </span>
          {isValidDate(metadata.fetchedAt) && (
            <time
              className="pr-review-meta-item pr-review-fetched"
              dateTime={metadata.fetchedAt}
              title={new Date(metadata.fetchedAt).toLocaleString()}
            >
              {`Fetched ${relativeTime(metadata.fetchedAt, now)}`}
            </time>
          )}
        </div>
      )}
      {refreshing && <div className="pr-review-progress" aria-hidden="true" />}
    </header>
  );
}
