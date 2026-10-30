"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ManualInputNotice } from "@/lib/hook-events";
import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import type { BridgeInfo } from "@/hooks/useBridges";
import type { Command, CommandResponse, Session } from "@/types";
import { v4 as uuidv4 } from "uuid";

export interface InboxEntry { session: Session; notice: ManualInputNotice; bridgeName: string; replyDisabledReason?: string }
/** Queue exactly one browser reply; ambiguous outcomes require an explicit user decision. */
export async function queueSessionReply(send: (command: Command) => Promise<CommandResponse>, entry: InboxEntry, message: string): Promise<void> {
  let response: CommandResponse;
  try { response = await send({ type: "send_message", requestId: uuidv4(), payload: { bridgeId: entry.session.bridgeId, sessionId: entry.session.id, message } }); }
  catch { throw new Error("Reply may have been queued. Check the session before sending again."); }
  const data = response.data && typeof response.data === "object" && !Array.isArray(response.data) ? response.data as Record<string, unknown> : null;
  if (response.success) {
    if (data?.sessionId === entry.session.id && typeof data.messageId === "string" && data.messageId.trim() && data.status === "queued") return;
    throw new Error("Reply may have been queued. Check the session before sending again.");
  }
  const code = data?.code;
  if (code === "permission_denied" || code === "approval_required") throw new Error("This browser does not have permission to reply to this session.");
  if (code === "unknown_command" || code === "unsupported_command" || response.error === "Unknown command type: send_message") throw new Error("This computer needs a bridge upgrade before replies can be sent.");
  if (code === "invalid_request") throw new Error("Check your reply and try again.");
  if (code === "session_unavailable") throw new Error("This session is no longer running. Open it to check.");
  if (code === "mail_not_ready") throw new Error("Session mail is not ready. Reconnect the computer and try again.");
  throw new Error("Reply may have been queued. Check the session before sending again.");
}
export function noticeKey(sessionId: string, notice: ManualInputNotice): string {
  return JSON.stringify([sessionId, notice.type, notice.attentionId ?? null, notice.attentionSequence ?? null, notice.receivedAt, notice.title, notice.message]);
}
export function inboxEntries(sessions: readonly Session[], activity: ReadonlyMap<string, SessionActivity>, bridges: readonly BridgeInfo[], hiddenSessions: ReadonlySet<string>, hiddenBridges: ReadonlySet<string>, ready: ReadonlySet<string>, canControl: (bridgeId: string) => boolean): InboxEntry[] {
  return sessions.flatMap(session => {
    const notice = activity.get(session.id)?.attention;
    if (!notice || hiddenSessions.has(session.id) || hiddenBridges.has(session.bridgeId)) return [];
    const bridgeName = bridges.find(bridge => bridge.bridgeId === session.bridgeId)?.hostname || session.bridgeId;
    const replyDisabledReason = session.status !== "running" ? "This session is not running." : !ready.has(session.bridgeId) ? "Reconnect this computer before replying." : !canControl(session.bridgeId) ? "This browser does not have control permission for this computer." : undefined;
    return [{ session, notice, bridgeName, replyDisabledReason }];
  }).sort((a, b) => b.notice.receivedAt - a.notice.receivedAt);
}

function InboxItem({ entry, onOpenSession, onDismiss, onReply }: { entry: InboxEntry; onOpenSession: (id: string) => void; onDismiss: (entry: InboxEntry) => Promise<void>; onReply: (entry: InboxEntry, message: string) => Promise<void> }) {
  const [draft, setDraft] = useState(""); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const [sending, setSending] = useState(false); const [dismissing, setDismissing] = useState(false);
  const sendingRef = useRef(false), dismissingRef = useRef(false);
  const name = entry.session.name || entry.session.prompt?.slice(0, 36) || "Session";
  async function send() {
    if (sendingRef.current || entry.replyDisabledReason || !draft.trim() || draft.length > 65536) return;
    sendingRef.current = true; setSending(true); setError(""); setMessage("");
    try { await onReply(entry, draft); setDraft(""); setMessage("Reply queued."); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not send reply. It may have been queued; check before sending again."); }
    finally { sendingRef.current = false; setSending(false); }
  }
  async function dismiss() {
    if (dismissingRef.current) return;
    dismissingRef.current = true; setDismissing(true); setError("");
    try { await onDismiss(entry); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not dismiss this message. Try again."); }
    finally { dismissingRef.current = false; setDismissing(false); }
  }
  return <article data-inbox-entry={entry.session.id} className="min-w-0 space-y-2 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] p-3">
    <div className="min-w-0"><h3 className="break-words text-sm font-semibold [overflow-wrap:anywhere]">{name}</h3><p className="break-words text-xs text-[var(--text-muted)] [overflow-wrap:anywhere]">{entry.bridgeName} · <time dateTime={new Date(entry.notice.receivedAt).toISOString()}>{new Date(entry.notice.receivedAt).toLocaleString()}</time></p></div>
    <p className="break-words text-sm font-semibold [overflow-wrap:anywhere]">{entry.notice.title}</p>
    <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{entry.notice.message}</p>
    <div className="flex flex-wrap gap-2"><button type="button" className="btn-ghost min-h-11" onClick={() => onOpenSession(entry.session.id)}>Open session</button><button type="button" className="btn-ghost min-h-11" disabled={dismissing} onClick={() => void dismiss()}>{dismissing ? "Dismissing…" : "Dismiss"}</button></div>
    <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-muted)]">Reply to {name}<textarea className="min-h-20 w-full min-w-0 rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] p-2 text-sm text-[var(--text-primary)]" maxLength={65536} value={draft} onChange={event => { setDraft(event.target.value); setMessage(""); setError(""); }} disabled={sending || !!entry.replyDisabledReason} /></label>
    {entry.replyDisabledReason && <p className="text-xs text-[var(--text-muted)]">{entry.replyDisabledReason}</p>}
    <button type="button" className="btn-accent min-h-11" disabled={sending || !!entry.replyDisabledReason || !draft.trim()} onClick={() => void send()}>{sending ? "Sending…" : "Send reply"}</button>
    {message && <p role="status" className="text-xs text-[var(--text-muted)]">{message}</p>}{error && <p role="alert" className="text-xs text-[var(--status-error)]">{error}</p>}
  </article>;
}
export function SessionInbox({ entries, collapsed, open, onOpen, onClose, onOpenSession, onDismiss, onReply }: { entries: readonly InboxEntry[]; collapsed: boolean; open: boolean; onOpen: () => void; onClose: () => void; onOpenSession: (id: string) => void; onDismiss: (entry: InboxEntry) => Promise<void>; onReply: (entry: InboxEntry, message: string) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null); const title = useId();
  useEffect(() => {
    if (!open) return;
    const element = dialog.current; const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal(); return () => { if (element?.open) element.close(); previous?.focus(); };
  }, [open]);
  return <>
    <button type="button" aria-label={`Inbox, ${entries.length} ${entries.length === 1 ? "message" : "messages"}`} title="Inbox" className={`flex min-h-11 w-full items-center gap-2 border-b border-[var(--border-muted)] px-3 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] ${collapsed ? "justify-center" : ""}`} onClick={onOpen}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16v16H4zM4 14h5l2 3h2l2-3h5"/></svg>{!collapsed && <span>Inbox</span>}<span aria-hidden="true" className="font-semibold tabular-nums">{entries.length}</span>
    </button>
    <dialog ref={dialog} aria-labelledby={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target !== event.currentTarget) return; const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); }} className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_24px)] max-w-lg overflow-y-auto rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-4 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/70">
      <div className="mb-3 flex items-center justify-between gap-2"><h2 id={title} className="text-base font-semibold">Inbox</h2><button type="button" className="btn-ghost min-h-11" onClick={onClose}>Close</button></div>
      {entries.length ? <div className="space-y-3">{entries.map(entry => <InboxItem key={noticeKey(entry.session.id, entry.notice)} entry={entry} onOpenSession={onOpenSession} onDismiss={onDismiss} onReply={onReply} />)}</div> : <p className="text-sm text-[var(--text-muted)]">No messages.</p>}
    </dialog>
  </>;
}
