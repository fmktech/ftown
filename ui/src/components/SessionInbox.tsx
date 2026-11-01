"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { ManualInputNotice } from "@/lib/hook-events";
import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import type { BridgeInfo } from "@/hooks/useBridges";
import type { Command, CommandResponse, Session } from "@/types";
import { v4 as uuidv4 } from "uuid";
import type { AttentionAnswerEntry } from "../../../bridge/src/attention-prompt-protocol";
import type { AnswerSessionAttentionResult } from "@/hooks/useAllSessionEvents";
import { AttentionAnswerForm, type AttentionAnswerSubmitResult } from "./AttentionAnswerForm";

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
/** Turn the bridge's answer outcome into the one-line result the answer form shows. */
export function attentionAnswerSubmitResult(name: string, result: AnswerSessionAttentionResult): AttentionAnswerSubmitResult {
  if (result.ok) {
    if (result.delivery === "waiter") return { ok: true, message: `Answer delivered to ${name}.` };
    if (result.delivery === "mail") return { ok: true, message: `Answer sent to ${name}.` };
    return { ok: true, message: "Answer saved, but mail delivery failed. The agent can read it with ftown sessions attention-status." };
  }
  switch (result.code) {
    case "attention_already_resolved": return { ok: false, message: "This question was already answered or dismissed." };
    case "attention_not_found": return { ok: false, message: "This question no longer exists." };
    case "answer_waiter_gone": return { ok: false, message: "The agent stopped waiting here. Open the session to answer in the terminal." };
    case "invalid_answer": return { ok: false, message: `The answer was rejected: ${result.message}` };
    case "permission_denied": case "approval_required": return { ok: false, message: "This browser does not have permission to answer this session." };
    case "session_unavailable": return { ok: false, message: "This session is no longer running. Open it to check." };
    default: return { ok: false, message: result.message };
  }
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

function InboxItem({ entry, onOpenSession, onDismiss, onReply, onAnswer }: { entry: InboxEntry; onOpenSession: (id: string) => void; onDismiss: (entry: InboxEntry) => Promise<void>; onReply: (entry: InboxEntry, message: string) => Promise<void>; onAnswer: (entry: InboxEntry, answers: AttentionAnswerEntry[]) => Promise<AttentionAnswerSubmitResult> }) {
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
  async function dismiss(): Promise<boolean> {
    if (dismissingRef.current) return false;
    dismissingRef.current = true; setDismissing(true); setError("");
    try { await onDismiss(entry); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not dismiss this message. Try again."); return false; }
    finally { dismissingRef.current = false; setDismissing(false); }
  }
  async function answerInTerminal() { if (await dismiss()) onOpenSession(entry.session.id); }
  const prompt = entry.notice.attentionId ? entry.notice.prompt : undefined;
  const hookPrompt = prompt?.channel === "hook";
  return <article data-inbox-entry={entry.session.id} className="min-w-0 space-y-2 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] p-3">
    <div className="min-w-0"><h3 className="break-words text-sm font-semibold [overflow-wrap:anywhere]">{name}</h3><p className="break-words text-xs text-[var(--text-muted)] [overflow-wrap:anywhere]">{entry.bridgeName} · <time dateTime={new Date(entry.notice.receivedAt).toISOString()}>{new Date(entry.notice.receivedAt).toLocaleString()}</time></p></div>
    <p className="break-words text-sm font-semibold [overflow-wrap:anywhere]">{entry.notice.title}</p>
    <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{entry.notice.message}</p>
    <div className="flex flex-wrap gap-2"><button type="button" className="btn-ghost min-h-11" onClick={() => onOpenSession(entry.session.id)}>Open session</button>{!hookPrompt && <button type="button" className="btn-ghost min-h-11" disabled={dismissing} onClick={() => void dismiss()}>{dismissing ? "Dismissing…" : "Dismiss"}</button>}</div>
    {prompt ? <AttentionAnswerForm key={noticeKey(entry.session.id, entry.notice)} prompt={prompt} sessionName={name} disabledReason={entry.replyDisabledReason} onSubmit={answers => onAnswer(entry, answers)} onAnswerInTerminal={hookPrompt ? () => void answerInTerminal() : undefined} /> : <>
    <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-muted)]">Reply to {name}<textarea className="min-h-20 w-full min-w-0 rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] p-2 text-sm text-[var(--text-primary)]" maxLength={65536} value={draft} onChange={event => { setDraft(event.target.value); setMessage(""); setError(""); }} disabled={sending || !!entry.replyDisabledReason} /></label>
    {entry.replyDisabledReason && <p className="text-xs text-[var(--text-muted)]">{entry.replyDisabledReason}</p>}
    <button type="button" className="btn-accent min-h-11" disabled={sending || !!entry.replyDisabledReason || !draft.trim()} onClick={() => void send()}>{sending ? "Sending…" : "Send reply"}</button>
    </>}
    {message && <p role="status" className="text-xs text-[var(--text-muted)]">{message}</p>}{error && <p role="alert" className="text-xs text-[var(--status-error)]">{error}</p>}
  </article>;
}
export function SessionInboxTrigger({ count, collapsed, open, onOpen, buttonRef }: { count: number; collapsed: boolean; open: boolean; onOpen: () => void; buttonRef?: RefObject<HTMLButtonElement | null> }) {
  return <button ref={buttonRef} type="button" aria-label={`Inbox, ${count} ${count === 1 ? "message" : "messages"}`} aria-pressed={open} title="Inbox" className={`flex min-h-11 w-full items-center gap-2 border-b border-[var(--border-muted)] px-3 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] ${collapsed ? "justify-center" : ""}`} onClick={onOpen}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16v16H4zM4 14h5l2 3h2l2-3h5"/></svg>{!collapsed && <span>Inbox</span>}<span aria-hidden="true" className="font-semibold tabular-nums">{count}</span>
  </button>;
}

export function SessionInboxPage({ entries, open, onClose, onOpenSession, onDismiss, onReply, onAnswer }: { entries: readonly InboxEntry[]; open: boolean; onClose: () => void; onOpenSession: (id: string) => void; onDismiss: (entry: InboxEntry) => Promise<void>; onReply: (entry: InboxEntry, message: string) => Promise<void>; onAnswer: (entry: InboxEntry, answers: AttentionAnswerEntry[]) => Promise<AttentionAnswerSubmitResult> }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [answerNotice, setAnswerNotice] = useState<{ message: string; warn: boolean } | null>(null);
  useEffect(() => { if (open) heading.current?.focus(); setAnswerNotice(null); }, [open]);
  useEffect(() => { if (!answerNotice) return; const timer = setTimeout(() => setAnswerNotice(null), 6000); return () => clearTimeout(timer); }, [answerNotice]);
  // The notice clears on success and unmounts the entry, so its own status line is never seen; keep the outcome here.
  const answer = async (entry: InboxEntry, answers: AttentionAnswerEntry[]) => {
    const result = await onAnswer(entry, answers);
    if (result.ok) setAnswerNotice({ message: result.message, warn: result.message.startsWith("Answer saved, but") });
    return result;
  };
  return <section aria-label="Inbox" hidden={!open} className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-[var(--bg-surface)] text-[var(--text-primary)]">
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h1 ref={heading} tabIndex={-1} className="text-lg font-semibold">Inbox</h1><button type="button" aria-label="Back to workspace" title="Back to workspace" className="btn-ghost inline-flex h-11 w-11 items-center justify-center sm:h-8 sm:w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11" style={{ padding: 0 }} onClick={onClose}><svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5m7-7-7 7 7 7" /></svg></button></div>
      {answerNotice && <p role="status" className={`mb-3 rounded-md border border-[var(--border-muted)] p-2 text-sm ${answerNotice.warn ? "text-[var(--status-pending)]" : "text-[var(--text-primary)]"}`}>{answerNotice.message}</p>}
      {entries.length ? <div className="space-y-3">{entries.map(entry => <InboxItem key={noticeKey(entry.session.id, entry.notice)} entry={entry} onOpenSession={onOpenSession} onDismiss={onDismiss} onReply={onReply} onAnswer={answer} />)}</div> : <p className="text-sm text-[var(--text-muted)]">No messages.</p>}
    </div>
  </section>;
}
