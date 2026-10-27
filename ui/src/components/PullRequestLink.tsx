import type { CSSProperties } from "react";
import { parsePullRequestUrl } from "@/lib/pull-request-url";

interface PullRequestLinkProps {
  url?: string;
  /** Compact session-row link. */
  badge?: boolean;
}

const compactStyle: CSSProperties = {
  color: "var(--accent)", fontSize: 10, border: "1px solid var(--border-muted)", borderRadius: 3, padding: "1px 4px",
};

function CompactBadgeText({ number }: { number: number }) {
  return <>PR #{number}</>;
}

export function PullRequestBadgePlaceholder({ url }: { url?: string }) {
  const pr = parsePullRequestUrl(url);
  if (!pr) return null;
  return (
    <span aria-hidden="true" data-pull-request-placeholder="" className="inline-flex shrink-0 whitespace-nowrap" style={{ ...compactStyle, visibility: "hidden" }}>
      <CompactBadgeText number={pr.number} />
    </span>
  );
}

export function PullRequestLink({ url, badge = false }: PullRequestLinkProps) {
  const pr = parsePullRequestUrl(url);
  if (!pr) return null;
  const description = `PR #${pr.number} in ${pr.repository}: ${pr.url}`;
  if (badge) {
    return (
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={description}
        title={description}
        draggable={false}
        data-pull-request-badge=""
        className="inline-flex shrink-0 whitespace-nowrap focus-visible:!shadow-[var(--focus-ring)]"
        style={{ ...compactStyle, pointerEvents: "auto" }}
      >
        <CompactBadgeText number={pr.number} />
      </a>
    );
  }
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={description}
      title={description}
      className="shrink-0 inline-flex items-center justify-center whitespace-nowrap rounded focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
      style={{ color: "var(--accent)", fontSize: 11, minHeight: 44, minWidth: 44, padding: "0 6px" }}
    >
      PR #{pr.number}
    </a>
  );
}
