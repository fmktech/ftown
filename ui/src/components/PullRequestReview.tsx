"use client";

import { useMemo } from "react";
import type { Session } from "@/types";
import type { MessageClient } from "@/lib/message-client";
import type { BridgeRpc } from "@/hooks/useBridgeRpc";
import { usePullRequestReview } from "@/hooks/usePullRequestReview";
import { parsePullRequestUrl } from "@/lib/pull-request-url";
import { usePullRequestStatus } from "./PullRequestStatusProvider";

const messages = { unlinked: "No pull request is linked to this session.", unauthenticated: "GitHub authentication is unavailable on this bridge.", rate_limited: "GitHub rate limit reached. Try again later.", not_found_or_forbidden: "Pull request not found or access denied.", timeout: "Pull request request timed out.", too_large: "Pull request is too large to display.", unsupported: "This pull request cannot be displayed.", stale: "The pull request changed while loading. Refresh to try again.", unavailable: "Pull request is unavailable." };

/** Never discard text; ambiguous headers fall back to a single raw view. */
export function reviewDiffSections(diff: string): { name: string; text: string }[] | null {
  if (!diff) return [];
  const lines = diff.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (lines.length > 20000) return null;
  const sections: { name: string; text: string }[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/([^\s]+) b\/([^\s]+)\r?\n?$/.exec(line);
      if (!match) return null;
      sections.push({ name: match[2], text: line });
    } else if (!sections.length) return null;
    else sections[sections.length - 1].text += line;
  }
  return sections.length ? sections : null;
}

export function PullRequestReview({ session, client, userId, visible, readable, securityGeneration, sendCommand, subscribeAuthority, onClose, expanded, onExpand }: {
  session: Session | null; client: MessageClient | null; userId: string; visible: boolean; readable: boolean; securityGeneration: number;
  sendCommand: BridgeRpc["sendCommand"]; subscribeAuthority?: (listener: () => void) => () => void; onClose: () => void; expanded: boolean; onExpand: () => void;
}) {
  const { state, refresh } = usePullRequestReview({ session, client, userId, visible, readable, securityGeneration, sendCommand, subscribeAuthority });
  const pr = parsePullRequestUrl(session?.pullRequestUrl);
  const status = usePullRequestStatus(pr?.url ?? "");
  const sections = useMemo(() => state.kind === "ready" ? reviewDiffSections(state.diff) : [], [state]);
  const statusText = status ? `${status.state.replaceAll("_", " ")}${status.stale ? " · stale" : ""}${status.reason ? ` · ${status.reason.replaceAll("_", " ")}` : ""}${status.checkedAt ? ` · checked ${new Date(status.checkedAt).toLocaleString()}` : ""}` : "unavailable";
  const message = state.kind === "no_link" ? "No pull request is linked to this session." : state.kind === "old_bridge" ? "This bridge needs an update or the pull request must be relinked before review." : state.kind === "offline" ? "Reconnect and restore read access to load this pull request." : state.kind === "loading" ? "Loading pull request…" : state.kind === "error" ? "Could not load pull request." : state.kind === "unavailable" ? messages[state.reason] : null;
  return <section id="session-review-panel" role="tabpanel" aria-label="PR review" hidden={!visible} className="session-review-pane">
    <div className="session-preview-toolbar">
      <strong className="session-preview-filename">PR review{pr ? ` · #${pr.number}` : ""}</strong>
      {pr && <a href={pr.url} target="_blank" rel="noopener noreferrer" className="pr-review-link">Open on GitHub</a>}
      <button type="button" className="btn-ghost session-preview-icon" aria-label={expanded ? "Collapse PR review" : "Expand PR review"} title={expanded ? "Collapse PR review" : "Expand PR review"} onClick={onExpand}>{expanded ? "⊟" : "⊞"}</button>
      <button type="button" className="btn-ghost session-preview-icon" aria-label="Refresh PR review" title="Refresh PR review" onClick={refresh}>↻</button>
      <button type="button" className="btn-ghost session-preview-icon" aria-label="Close PR review" title="Close PR review" onClick={onClose}>×</button>
    </div>
    {message ? <div className="session-preview-message" role="status"><span>{message}</span>{state.kind !== "loading" && state.kind !== "no_link" && <button type="button" className="btn-ghost" onClick={refresh}>Retry</button>}</div> : state.kind === "ready" && <div className="pr-review-content">
      <h2>{state.metadata.title}</h2>
      <p>{state.metadata.author} · {state.metadata.state} · {state.metadata.headRef} → {state.metadata.baseRef}</p>
      <p>Fetched {new Date(state.metadata.fetchedAt).toLocaleString()} · {state.metadata.changedFiles} files · +{state.metadata.additions} −{state.metadata.deletions}</p>
      <p>Cached PR status · commit unverified: {statusText}</p>
      {state.metadata.body && <pre className="pr-review-body">{state.metadata.body}</pre>}
      <h3>Changes</h3>
      {!state.diff ? <p>No diff content.</p> : sections === null ? <><p>File boundaries could not be classified; showing the complete raw diff.</p><pre className="pr-review-diff" tabIndex={0}>{state.diff}</pre></> : <>
        <nav aria-label="Changed files" className="pr-review-files">{sections.map((section, index) => <a key={index} href={`#pr-review-file-${index}`}>{section.name}</a>)}</nav>
        {sections.map((section, index) => <section key={index} id={`pr-review-file-${index}`}><h4>{section.name}</h4><pre className="pr-review-diff" tabIndex={0}>{section.text.split(/(?<=\n)/).map((line, i) => <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "pr-diff-add" : line.startsWith("-") && !line.startsWith("---") ? "pr-diff-delete" : undefined}>{line}</span>)}</pre></section>)}
      </>}
    </div>}
  </section>;
}
