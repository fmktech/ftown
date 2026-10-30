import type { CSSProperties } from "react";
import { parsePullRequestUrl } from "@/lib/pull-request-url";
import { usePullRequestStatus } from "./PullRequestStatusProvider";
import type { PullRequestStatus } from "../../../bridge/src/pull-request-status-protocol";

interface PullRequestLinkProps { url?: string; badge?: boolean }
const compactStyle: CSSProperties = {
  color: "var(--accent)", fontSize: 10, border: "1px solid var(--border-muted)", borderRadius: 3, padding: "1px 4px",
  display: "inline-block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis",
};
function statusText(status?: PullRequestStatus): string {
  if (!status) return "";
  switch (status.state) {
    case "in_progress": return "CI running";
    case "failed": return "CI failed";
    case "passed": return "CI passed";
    case "merged": return "Merged";
    case "closed": return "Closed";
    case "unknown": return status.checkedAt === null && !status.reason ? "" : status.reason === "no_checks" ? "No checks" : "CI unavailable";
  }
}
function color(status?: PullRequestStatus): string {
  switch (status?.state) {
    case "in_progress": return "var(--status-pending)";
    case "failed": return "var(--status-error)";
    case "passed": return "var(--accent)";
    case "merged": return "var(--text-secondary)";
    case "closed": return "var(--text-muted)";
    default: return status && statusText(status) ? "var(--text-muted)" : "var(--accent)";
  }
}
function StatusIcon({ state }: { state: PullRequestStatus["state"] }) {
  return <svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "inline", verticalAlign: "-1px", marginRight: 4 }}>
    {state === "merged" ? <><circle cx="4" cy="3" r="2"/><circle cx="4" cy="13" r="2"/><circle cx="12" cy="3" r="2"/><path d="M4 5v6M12 5c0 3-8 2-8 6"/></>
      : state === "passed" ? <path d="m3 8 3 3 7-7"/>
      : state === "failed" ? <path d="M4 4l8 8M12 4l-8 8"/>
      : state === "in_progress" ? <><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></>
      : state === "closed" ? <><circle cx="8" cy="8" r="6"/><path d="m4 12 8-8"/></>
      : <><circle cx="8" cy="8" r="6"/><path d="M6.5 6a1.6 1.6 0 1 1 2.5 1.3c-.7.5-1 1-1 1.7M8 11.5h.01"/></>}
  </svg>;
}
function BadgeText({ number, status }: { number: number; status?: PullRequestStatus }) {
  return <>{status && statusText(status) && <StatusIcon state={status.state} />}#{number}</>;
}
function description(number: number, repository: string, url: string, status?: PullRequestStatus) {
  const text = statusText(status);
  if (!text) return `PR #${number} in ${repository}: ${url}`;
  const state = text ? status?.stale ? `Last known ${text}; ${status.reason && status.reason !== "no_checks" ? "update unavailable" : "status may be out of date"}` : text : "";
  const checked = status?.checkedAt ? `Checked ${new Date(status.checkedAt).toLocaleString()}` : "";
  const reason = status?.stale && status.reason && status.reason !== "no_checks" ? `Reason: ${status.reason.replaceAll("_", " ")}` : "";
  return [`PR #${number} in ${repository}`, state, checked, reason, url].filter(Boolean).join("; ");
}
export function PullRequestBadgePlaceholder({ url }: { url?: string }) {
  const pr = parsePullRequestUrl(url);
  const status = usePullRequestStatus(pr?.url ?? "");
  if (!pr) return null;
  return <span aria-hidden="true" data-pull-request-placeholder="" className="min-w-0 whitespace-nowrap" style={{ ...compactStyle, color: color(status), visibility: "hidden" }}><BadgeText number={pr.number} status={status} /></span>;
}
export function PullRequestLink({ url, badge = false }: PullRequestLinkProps) {
  const pr = parsePullRequestUrl(url);
  const status = usePullRequestStatus(pr?.url ?? "");
  if (!pr) return null;
  const label = description(pr.number, pr.repository, pr.url, status);
  if (badge) return <a href={pr.url} target="_blank" rel="noopener noreferrer" aria-label={label} title={label} draggable={false} data-pull-request-badge="" className="min-w-0 whitespace-nowrap focus-visible:!shadow-[var(--focus-ring)]" style={{ ...compactStyle, color: color(status), pointerEvents: "auto" }}><BadgeText number={pr.number} status={status} /></a>;
  return <a href={pr.url} target="_blank" rel="noopener noreferrer" aria-label={label} title={label} className="shrink-0 inline-flex items-center justify-center whitespace-nowrap rounded focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]" style={{ color: color(status), fontSize: 11, minHeight: 44, minWidth: 44, padding: "0 6px" }}><BadgeText number={pr.number} status={status} /></a>;
}
