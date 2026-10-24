import { parsePullRequestUrl } from "@/lib/pull-request-url";

interface PullRequestLinkProps {
  url?: string;
  /** Compact styling for a link placed beside the session selection button. */
  badge?: boolean;
}

export function PullRequestLink({ url, badge = false }: PullRequestLinkProps) {
  const pr = parsePullRequestUrl(url);
  if (!pr) return null;
  const description = `PR #${pr.number} in ${pr.repository}: ${pr.url}`;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      draggable={badge ? false : undefined}
      aria-label={description}
      title={description}
      className="shrink-0 inline-flex items-center justify-center whitespace-nowrap rounded focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
      style={{
        color: "var(--accent)", fontSize: badge ? 10 : 11,
        minHeight: 44, minWidth: 44, padding: "0 6px",
        border: badge ? "1px solid var(--border-muted)" : undefined,
        alignSelf: badge ? "center" : undefined,
        marginRight: badge ? 6 : undefined,
      }}
    >
      PR #{pr.number}
    </a>
  );
}
