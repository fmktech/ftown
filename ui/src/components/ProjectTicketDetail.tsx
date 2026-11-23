"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, CommandResponse, Session } from "@/types";

export type TicketAssignee = { kind: "user" } | { kind: "bridge"; bridgeId: string } | null;
export type Ticket = {
  id: string; title: string; stage: string;
  blocked?: boolean; sessionIds: string[]; body?: string; assignee?: TicketAssignee; commentCount?: number;
  parentTicketId?: string | null; sessionStatuses?: Record<string, Session["status"]>;
};
export function assignmentLabel(assignee: TicketAssignee | undefined, names?: ReadonlyMap<string, string>) {
  if (assignee?.kind === "user") return "You";
  if (assignee?.kind === "bridge") return names?.get(assignee.bridgeId) ?? assignee.bridgeId;
  return "Unassigned";
}

type Props = {
  discussion?: React.ReactNode;
  project: { id: string; name: string; bridgeId: string };
  ticket: Ticket;
  tickets: Ticket[];
  sessionById: ReadonlyMap<string, Session>;
  openTicket: (id: string) => void;
  openSession?: (id: string) => void;
  bridgeNames?: ReadonlyMap<string,string>;
  columnNames: ReadonlyMap<string, string>;
  editable: boolean;
  online: boolean;
  error: string;
  send: (cmd: Command) => Promise<CommandResponse>;
  change: (payload: Record<string, unknown>) => Promise<boolean>;
  close: () => void;
};
type TicketComment = { id: string; text: string; author: string; createdAt: string };
function readPage(data: unknown) {
  const page = data as {comments?: TicketComment[]; nextAfter?: number} | undefined;
  if (!Array.isArray(page?.comments) || !page.comments.every(c => c && typeof c.id === "string" &&
      typeof c.author === "string" && typeof c.text === "string" && typeof c.createdAt === "string") ||
      (page.nextAfter !== undefined && !Number.isSafeInteger(page.nextAfter))) throw Error("Invalid comment history");
  return { comments: page.comments, nextAfter: page.nextAfter };
}

export function ProjectTicketDetail({ discussion, ticket, tickets, columnNames, sessionById, openTicket, openSession, project, bridgeNames, editable, online, send, change, error, close }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<{title?: string; body?: string; assignee?: TicketAssignee}>({});
  const [comment, setComment] = useState("");
  const commentId = useRef<string | null>(null);
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [commentsError, setCommentsError] = useState("");
  const [nextAfter, setNextAfter] = useState<number | undefined>();
  const generation = useRef(0);
  const [subtask, setSubtask] = useState("");
  const subtaskId = useRef<string | null>(null);
  const parent = tickets.find(t => t.id === ticket.parentTicketId);
  const subtasks = tickets.filter(t => t.parentTicketId === ticket.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const stageLabel = (t: Ticket) => columnNames.get(t.blocked && columnNames.has("Blocked") ? "Blocked" : t.stage) ?? t.stage;
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const title = draft.title ?? ticket.title;
  const body = draft.body ?? ticket.body ?? "";
  const assignee = draft.assignee === undefined ? ticket.assignee : draft.assignee;
  const selection = assignee?.kind === "bridge" ? "bridge/" + assignee.bridgeId : assignee?.kind ?? "";
  const bridges = new Map(bridgeNames);
  if (!bridges.has(project.bridgeId)) bridges.set(project.bridgeId, project.bridgeId);
  if (assignee?.kind === "bridge" && !bridges.has(assignee.bridgeId)) bridges.set(assignee.bridgeId, assignee.bridgeId);
  const validBody = new TextEncoder().encode(body).byteLength <= 32 * 1024;
  const validComment = new TextEncoder().encode(comment).byteLength <= 8 * 1024;
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  const load = useCallback(async (after?: number) => {
    const request = ++generation.current;
    setLoading(true);
    setCommentsError("");
    try {
      const response = await send({ type: "get_ticket_comments", requestId: crypto.randomUUID(), payload: {
        bridgeId: project.bridgeId, projectId: project.id, ticketId: ticket.id, ...(after === undefined ? {} : { after }),
      } });
      if (request !== generation.current) return;
      if (!response.success) throw Error(response.error || "Could not load comments");
      const page = readPage(response.data);
      if (page.nextAfter !== undefined && (page.nextAfter === after || !page.comments.length)) throw Error("Invalid comment cursor");
      setComments(previous => after === undefined ? page.comments : [...previous, ...page.comments]);
      setNextAfter(page.nextAfter);
    } catch (cause) {
      if (request === generation.current) setCommentsError(cause instanceof Error ? cause.message : "Could not load comments");
    } finally { if (request === generation.current) setLoading(false); }
  }, [send, project.id, project.bridgeId, ticket.id]);
  useEffect(() => {
    if (online) void load();
    else setLoading(false);
    return () => { generation.current++; };
  }, [load, ticket.commentCount, online, refresh]);
  const commonInput = "w-full rounded border border-[var(--border-muted)] bg-[var(--bg-base)] px-3 py-2 text-sm";
  return <dialog ref={dialog} aria-labelledby="ticket-detail-heading" className="computers-dialog p-0" style={{ width: "min(42rem,95vw)" }}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-3">
      <div className="min-w-0">
        <p className="text-xs text-[var(--text-muted)]">{project.name} / {stageLabel(ticket)}</p>
        <h2 id="ticket-detail-heading" className="break-words text-lg font-semibold">{ticket.title}</h2>
      </div>
      <button className="btn-ghost shrink-0" aria-label="Close ticket" onClick={close}>×</button>
    </header>
    <div className="space-y-5 p-5">
      {!online && <p role="status" className="text-xs">Home bridge offline · read-only</p>}
      {error && <p role="alert">{error}</p>}
      {parent && <p className="text-xs">Parent ticket <button className="btn-ghost" onClick={() => openTicket(parent.id)}>{parent.title}</button></p>}
      <form className="space-y-3" onSubmit={async event => {
        event.preventDefault();
        if (!title.trim() || !validBody) return;
        if (await change({ action: "update_ticket", ticketId: ticket.id, ...draft })) setDraft({});
      }}>
        <label className="block text-sm font-semibold">Title
          <input className={commonInput} maxLength={512} value={title} disabled={!editable}
            onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <label className="block text-sm font-semibold">Description
          <textarea className={commonInput} rows={5} value={body} disabled={!editable}
            onChange={event => setDraft({ ...draft, body: event.target.value })} /></label>
        {!validBody && <p role="alert">Description exceeds 32 KiB.</p>}
        <label className="block text-sm font-semibold">Assignee
          <select className={commonInput} disabled={!editable} value={selection} onChange={event => {
            const value = event.target.value;
            setDraft(previous => ({ ...previous, assignee: !value ? null : value === "user" ? { kind: "user" } : { kind: "bridge", bridgeId: value.slice(7) } }));
          }}>
            <option value="">Unassigned</option><option value="user">You</option>
            <optgroup label="Bridges">{[...bridges].map(([id, name]) => <option key={id} value={"bridge/" + id}>{name}</option>)}</optgroup>
          </select></label>
        <button className="btn-accent" disabled={!editable || !title.trim() || !validBody || !Object.keys(draft).length}>Save changes</button>
      </form>
      <section aria-label="Subtasks" className="space-y-2 border-t border-[var(--border-subtle)] pt-4">
        <h3 className="text-sm font-semibold">Subtasks</h3>
        <ul>{subtasks.map(t => <li key={t.id} className="mb-1 flex items-center gap-2 text-xs">
          <button className="btn-ghost" onClick={() => openTicket(t.id)}>{t.title}</button>
          <span>{stageLabel(t)}</span>
        </li>)}</ul>
        <form className="flex gap-2" onSubmit={async event => {
          event.preventDefault();
          if (!subtask.trim()) return;
          subtaskId.current ??= crypto.randomUUID();
          if (await change({ action: "create_ticket", ticketId: subtaskId.current, parentTicketId: ticket.id, title: subtask.trim() })) {
            subtaskId.current = null; setSubtask("");
          }
        }}>
          <input aria-label="Subtask title" placeholder="Subtask title" maxLength={512} className={commonInput} disabled={!editable}
            value={subtask} onChange={e => { subtaskId.current = null; setSubtask(e.target.value); }} />
          <button className="btn-ghost shrink-0" disabled={!editable || !subtask.trim()}>Add subtask</button>
        </form>
      </section>
      {ticket.sessionIds.length > 0 && <section aria-label="Linked sessions" className="space-y-2 border-t border-[var(--border-subtle)] pt-4">
        <h3 className="text-sm font-semibold">Linked sessions</h3>
        <ul>{ticket.sessionIds.map(id => {
          const session = sessionById.get(id);
          return <li key={id} className="mb-1 flex flex-wrap items-center gap-2 text-xs">
            {session && openSession ? <button className="btn-ghost" onClick={() => openSession(id)}>{session.name}</button> : session?.name || id}
            {session && <span>{bridgeNames?.get(session.bridgeId) ?? session.bridgeId}</span>}
            <span>{ticket.sessionStatuses?.[id] ?? session?.status ?? "Unknown status"}</span>
          </li>;
        })}</ul>
      </section>}
      {discussion}
      <section aria-label="Comments" className="space-y-2 border-t border-[var(--border-subtle)] pt-4">
        <h3 className="text-sm font-semibold">Comments{ticket.commentCount ? " (" + ticket.commentCount + ")" : ""}</h3>
        {commentsError && <p role="alert">{commentsError} <button className="btn-ghost" onClick={() => setRefresh(value => value + 1)}>Retry</button></p>}
        <ol>{comments.map(c => <li key={c.id} className="mb-2 rounded border border-[var(--border-subtle)] p-2 text-sm">
          <p className="mb-1 text-xs text-[var(--text-muted)]">{c.author} · <time dateTime={c.createdAt}>{new Date(c.createdAt).toLocaleString()}</time></p>
          <p className="whitespace-pre-wrap break-words">{c.text}</p>
        </li>)}</ol>
        {nextAfter !== undefined && <button className="btn-ghost" disabled={!online || loading} onClick={() => void load(nextAfter)}>Load more comments</button>}
        <form onSubmit={async event => {
          event.preventDefault();
          if (!comment.trim() || !validComment) return;
          commentId.current ??= crypto.randomUUID();
          if (await change({ action: "add_ticket_comment", ticketId: ticket.id, commentId: commentId.current, text: comment.trim() })) {
            commentId.current = null;
            setComment("");
            setRefresh(value => value + 1);
          }
        }}>
          <textarea aria-label="New comment" className={commonInput} rows={2} placeholder="Write a comment…" value={comment} disabled={!editable}
            onChange={event => { setComment(event.target.value); commentId.current = null; }} />
          {!validComment && <p role="alert">Comment exceeds 8 KiB.</p>}
          <button className="btn-ghost mt-1" disabled={!editable || !validComment || !comment.trim()}>Add comment</button>
        </form>
      </section>
      <section className="border-t border-[var(--border-subtle)] pt-4">
        {confirmDelete ? <div className="space-y-2">
          <p>Delete “{ticket.title}” and its comments?{subtasks.length > 0 && " Its subtasks will become top-level tickets."}</p>
          <div className="flex gap-2"><button className="btn-danger" disabled={!editable} onClick={async () => {
            if (await change({ action: "delete_ticket", ticketId: ticket.id })) close();
          }}>Confirm delete ticket</button><button className="btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button></div>
        </div> : <button className="btn-danger" disabled={!editable} onClick={() => setConfirmDelete(true)}>Delete ticket</button>}
      </section>
    </div>
  </dialog>;
}
