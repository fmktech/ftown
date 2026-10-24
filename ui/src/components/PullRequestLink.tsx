import { parsePullRequestUrl } from "@/lib/pull-request-url";

interface PullRequestLinkProps {
  url?: string;
  /** Session rows are already buttons, so their badge must remain plain text. */
  badge?: boolean;
}

export function PullRequestLink({ url, badge = false }: PullRequestLinkProps) {
  const pr = parsePullRequestUrl(url);
  if (!pr) return null;
  const description = `PR #${pr.number} in ${pr.repository}: ${pr.url}`;
  if (badge) {
    return (
      <span
        title={description}
        className="shrink-0 whitespace-nowrap"
        style={{ color: "var(--accent)", fontSize: 10, border: "1px solid var(--border-muted)", borderRadius: 3, padding: "1px 4px" }}
      >
        <span aria-hidden="true">PR #{pr.number}</span>
        <span className="sr-only">{description}</span>
      </span>
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
