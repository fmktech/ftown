"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { Session } from "@/types";
import type { MessageClient } from "@/lib/message-client";
import type { BridgeRpc } from "@/hooks/useBridgeRpc";
import { usePullRequestReview } from "@/hooks/usePullRequestReview";
import { parsePullRequestUrl } from "@/lib/pull-request-url";
import { parseUnifiedDiff } from "@/lib/pr-diff";
import { relativeTime } from "@/lib/relative-time";
import { REVIEW_LABELS, REVIEW_REFRESH_FAILED_COPY } from "@/lib/pr-review-types";
import { usePullRequestStatus } from "./PullRequestStatusProvider";
import { ReviewHeader } from "./pr-review/ReviewHeader";
import { ReviewStatusView } from "./pr-review/ReviewStatusView";
import { FilesView } from "./pr-review/FilesView";

type ReviewSection = "files" | "description";
const RAW_LINE_LIMIT = 20_000;
const TAB_IDS: Record<ReviewSection, string> = { files: "pr-review-tab-files", description: "pr-review-tab-description" };

function RawDiff({ diff }: { diff: string }) {
  const lines = useMemo(() => {
    let newlines = 0;
    for (let at = diff.indexOf("\n"); at !== -1; at = diff.indexOf("\n", at + 1)) if (++newlines > RAW_LINE_LIMIT) return null;
    return diff.split(/(?<=\n)/);
  }, [diff]);
  return <div className="pr-review-raw-wrap">
    <p className="pr-review-raw-notice">This diff couldn&apos;t be parsed, so it&apos;s shown as raw text.</p>
    <pre className="pr-review-raw" tabIndex={0}>{lines === null ? diff : lines.map((line, i) => <span key={i} className={line.startsWith("@@") ? "pr-diff-hunk" : line.startsWith("+") && !line.startsWith("+++") ? "pr-diff-add" : line.startsWith("-") && !line.startsWith("---") ? "pr-diff-delete" : undefined}>{line}</span>)}</pre>
  </div>;
}

export function PullRequestReview({ session, client, userId, visible, readable, securityGeneration, sendCommand, subscribeAuthority, onClose, expanded, onExpand }: {
  session: Session | null; client: MessageClient | null; userId: string; visible: boolean; readable: boolean; securityGeneration: number;
  sendCommand: BridgeRpc["sendCommand"]; subscribeAuthority?: (listener: () => void) => () => void; onClose: () => void; expanded: boolean; onExpand: () => void;
}) {
  const { state, refresh } = usePullRequestReview({ session, client, userId, visible, readable, securityGeneration, sendCommand, subscribeAuthority });
  const pr = parsePullRequestUrl(session?.pullRequestUrl);
  const checks = usePullRequestStatus(pr?.url ?? "");
  const [now, setNow] = useState(() => Date.now());
  const [section, setSection] = useState<ReviewSection>("files");
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [visible]);
  const diff = state.kind === "ready" ? state.diff : null;
  const parsed = useMemo(() => (diff === null ? null : parseUnifiedDiff(diff)), [diff]);
  const canRefresh = state.kind !== "loading" && state.kind !== "no_link" && state.kind !== "old_bridge" && state.kind !== "offline";
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: ReviewSection = section === "files" ? "description" : "files";
    setSection(next);
    document.getElementById(TAB_IDS[next])?.focus();
  };
  return <section id="session-review-panel" role="tabpanel" aria-label="PR review" hidden={!visible} className="session-review-pane pr-review-root">
    <ReviewHeader metadata={state.kind === "ready" ? state.metadata : null} pullRequest={pr} checks={checks} refreshing={state.kind === "ready" && state.refreshing} canRefresh={canRefresh} expanded={expanded} now={now} onRefresh={refresh} onToggleExpand={onExpand} onClose={onClose} />
    {state.kind === "ready" ? <>
      {state.refreshFailed && <div className="pr-review-banner" role="status">
        <span className="pr-review-banner-text">{`Couldn't refresh: ${REVIEW_REFRESH_FAILED_COPY[state.refreshFailed]}. Showing the version fetched ${relativeTime(state.metadata.fetchedAt, now)}.`}</span>
        <button type="button" className="btn-ghost pr-review-button" onClick={refresh}>Retry</button>
      </div>}
      <div className="pr-review-sections" role="tablist" aria-label={REVIEW_LABELS.sections}>
        <button type="button" role="tab" id={TAB_IDS.files} className="pr-review-section-tab" aria-selected={section === "files"} aria-controls="pr-review-section-panel" tabIndex={section === "files" ? 0 : -1} onClick={() => setSection("files")} onKeyDown={onTabKeyDown}>{REVIEW_LABELS.filesTab} <span className="pr-review-count">{parsed ? parsed.files.length : state.metadata.changedFiles}</span></button>
        <button type="button" role="tab" id={TAB_IDS.description} className="pr-review-section-tab" aria-selected={section === "description"} aria-controls="pr-review-section-panel" tabIndex={section === "description" ? 0 : -1} onClick={() => setSection("description")} onKeyDown={onTabKeyDown}>{REVIEW_LABELS.descriptionTab}</button>
      </div>
      <div className="pr-review-main" id="pr-review-section-panel" role="tabpanel" aria-labelledby={TAB_IDS[section]}>
        {section === "files" ? (parsed ? <FilesView diff={parsed} viewedScopeKey={`${state.metadata.url}@${state.metadata.headOid}`} /> : <RawDiff diff={state.diff} />) : <div className="pr-review-description">
          {state.metadata.body.trim() ? <div className="pr-review-body">{state.metadata.body}</div> : <p className="pr-review-empty-note">No description provided.</p>}
        </div>}
      </div>
    </> : <div className="pr-review-main">
      <ReviewStatusView state={state} pullRequestUrl={pr?.url ?? null} onRetry={refresh} />
    </div>}
  </section>;
}
