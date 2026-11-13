"use client";

import type { Session, SessionStatus } from "@/types";
import { markdownPreviewDocument } from "@/lib/session-preview";
import { relativeTime } from "@/lib/relative-time";
import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import { SessionCardChip, formatCardRollup, rollupChildCards } from "./SessionCardChip";
import { PullRequestLink } from "./PullRequestLink";
import { SessionStateIndicator } from "./SessionStateIndicator";

export interface OpenAttentionCount { open: number; withParent: number }

export interface SessionOverviewProps {
  /** The selected manager session whose children are summarised. */
  session: Session;
  /** All known sessions; children are derived (parentSessionId === session.id). */
  sessions: ReadonlyArray<Session>;
  /** Live activity per session id, when the caller has the dashboard map. */
  activityBySession?: ReadonlyMap<string, Pick<SessionActivity, "activity" | "attention">>;
  /** Open attention items per session id; withParent counts items still waiting with the parent. */
  openAttentionBySession?: ReadonlyMap<string, OpenAttentionCount>;
  /** Clock for deterministic card-age rendering in tests. */
  now?: number;
}

/** Children of `session`, oldest first (the order the tree was built in). */
export function childSessionsOf(session: Session, sessions: ReadonlyArray<Session>): Session[] {
  return sessions
    .filter(candidate => candidate.parentSessionId === session.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** Live-state label matching SessionStateIndicator's rules; the activity map carries no idle-since timestamp. */
function activityLabel(status: SessionStatus, activity?: SessionActivity["activity"]): string {
  if (status === "running") {
    return activity === "thinking" ? "Thinking" : activity === "tool_use" ? "Using a tool" : activity === "idle" ? "Idle" : "Running";
  }
  return status === "completed" ? "Completed" : status === "error" ? "Error" : status === "disconnected" ? "Disconnected" : "Pending";
}

/** `10:05` in the viewer's local time; "" when the timestamp is unparseable. */
function noteTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const cellStyle = { padding: "4px 8px", borderBottom: "1px solid var(--border-subtle)", fontSize: 12, textAlign: "left" as const, verticalAlign: "middle" as const };
const mutedStyle = { color: "var(--text-muted)", fontSize: 11 };

/** Manager view for a session with children: brief, recent notes and one row per child. */
export function SessionOverview({ session, sessions, activityBySession, openAttentionBySession, now }: SessionOverviewProps) {
  const children = childSessionsOf(session, sessions);
  if (children.length === 0) return null;
  const brief = session.brief;
  const notes = (brief?.notes ?? []).slice(-10);
  const rollup = formatCardRollup(rollupChildCards(sessions, session.id));
  return (
    <section aria-label={`Overview: ${session.name || session.id}`} style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg-base)", color: "var(--text-primary)" }}>
      <div style={{ padding: "12px 16px 24px", maxWidth: 860, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <header style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Overview</h2>
          <span style={mutedStyle}>{children.length} {children.length === 1 ? "child" : "children"}{rollup ? ` · ${rollup}` : ""}</span>
        </header>

        <section aria-label="Brief" style={{ display: "flex", flexDirection: "column", gap: 6, minHeight: 0 }}>
          <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>Brief</h3>
          {brief?.text
            ? <iframe title={`Brief: ${session.name || session.id}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={markdownPreviewDocument(brief.text, `${session.name || session.id} brief`)}
                style={{ width: "100%", height: 360, border: "1px solid var(--border-muted)", borderRadius: 8, background: "var(--bg-surface)" }} />
            : <p style={{ ...mutedStyle, margin: 0 }}>No brief yet — set one with <code>ftown brief set --file brief.md</code>.</p>}
        </section>

        <section aria-label="Brief notes" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>Notes</h3>
          {notes.length > 0
            ? <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 2 }}>
                {notes.map((note, index) => (
                  <li key={`${note.ts}-${index}`} style={{ fontSize: 12 }}>
                    {noteTime(note.ts) && <span style={mutedStyle}>{noteTime(note.ts)} </span>}{note.text}
                  </li>
                ))}
              </ul>
            : <p style={{ ...mutedStyle, margin: 0 }}>No notes yet — add one with <code>ftown brief note "…"</code>.</p>}
        </section>

        <section aria-label="Children" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>Children</h3>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {["Child", "Card", "Activity", "Questions", "PR", "Worktree", "Updated"].map(label => (
                  <th key={label} scope="col" style={{ ...cellStyle, borderBottom: "1px solid var(--border-muted)", color: "var(--text-muted)", fontSize: 11, fontWeight: 600 }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {children.map(child => {
                const activity = activityBySession?.get(child.id);
                const attention = openAttentionBySession?.get(child.id);
                return (
                <tr key={child.id}>
                  <td style={{ ...cellStyle, fontWeight: 600 }}>{child.name || child.prompt?.slice(0, 48) || child.id}</td>
                  <td style={cellStyle}>{child.card ? <SessionCardChip card={child.card} compact /> : <span style={mutedStyle}>—</span>}</td>
                  <td style={cellStyle}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <SessionStateIndicator status={child.status} activity={activity?.activity} needsInput={!!activity?.attention} />
                      <span style={mutedStyle}>{activityLabel(child.status, activity?.activity)}</span>
                    </span>
                  </td>
                  <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>{attention
                    ? <span title={`${attention.open} open question(s); ${attention.withParent} still with the parent`}>
                        {attention.open}{attention.withParent > 0 ? ` (${attention.withParent} with parent)` : ""}
                      </span>
                    : <span style={mutedStyle}>—</span>}</td>
                  <td style={cellStyle}>{child.pullRequestUrl ? <PullRequestLink url={child.pullRequestUrl} badge /> : <span style={mutedStyle}>—</span>}</td>
                  <td style={cellStyle}>{child.worktree
                    ? <code title={`${child.worktree.branch} · ${child.worktree.path}`} style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{child.worktree.branch}</code>
                    : <span style={mutedStyle}>—</span>}</td>
                  <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                    {child.card ? <span title={child.card.updatedAt}>updated {relativeTime(child.card.updatedAt, now)}</span> : <span style={mutedStyle}>—</span>}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
    </section>
  );
}
