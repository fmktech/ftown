import { Fragment, type ReactNode } from "react";
import { REVIEW_LABELS, REVIEW_STATE_COPY, REVIEW_UNAVAILABLE_COPY } from "@/lib/pr-review-types";
import type { ReviewStatusViewProps } from "@/lib/pr-review-types";

/** Backtick-delimited segments render as inline code; everything else stays plain text. */
function renderDetail(text: string): ReactNode[] {
  return text.split("`").map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>));
}

const SKELETON_CARDS = [0, 1, 2] as const;
const SKELETON_LINES = [0, 1, 2, 3] as const;

export function ReviewStatusView({ state, pullRequestUrl, onRetry }: ReviewStatusViewProps) {
  if (state.kind === "loading") {
    return (
      <div className="pr-review-skeleton" role="status" aria-busy="true">
        <span className="pr-review-sr-only">{REVIEW_STATE_COPY.loading.title}</span>
        <div className="pr-review-skel-line is-title" aria-hidden="true" />
        <div className="pr-review-skel-line is-short" aria-hidden="true" />
        {SKELETON_CARDS.map((card) => (
          <div key={card} className="pr-review-skel-card" aria-hidden="true">
            {SKELETON_LINES.map((line) => (
              <div key={line} className="pr-review-skel-line" />
            ))}
          </div>
        ))}
      </div>
    );
  }

  const copy = state.kind === "unavailable" ? REVIEW_UNAVAILABLE_COPY[state.reason] : REVIEW_STATE_COPY[state.kind];
  const showRetry = state.kind === "error" || (state.kind === "unavailable" && state.reason !== "unlinked");
  const showViewOnGitHub = Boolean(pullRequestUrl) && state.kind !== "no_link" && !(state.kind === "unavailable" && state.reason === "unlinked");
  const showActions = showRetry || showViewOnGitHub;

  return (
    <div className="pr-review-empty" role="status">
      <span className="pr-review-empty-glyph" aria-hidden="true">
        {copy.glyph}
      </span>
      <p className="pr-review-empty-title">{copy.title}</p>
      <p className="pr-review-empty-detail">{renderDetail(copy.detail)}</p>
      {showActions ? (
        <div className="pr-review-empty-actions">
          {showRetry ? (
            <button type="button" className="btn-ghost pr-review-button" onClick={onRetry}>
              Retry
            </button>
          ) : null}
          {showViewOnGitHub && pullRequestUrl ? (
            <a className="pr-review-link" href={pullRequestUrl} target="_blank" rel="noopener noreferrer">
              {REVIEW_LABELS.viewOnGitHub}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
