"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, CommandResponse, Session } from "@/types";

import { ProjectTicketDetail, assignmentLabel, type Ticket } from "./ProjectTicketDetail";

const stages = ["Backlog", "In progress", "Blocked", "Review", "Done"] as const;
type Project = { id: string; name: string; bridgeId: string };
type Board = { project: Project; tickets: Ticket[] };
type BoardPage = Board & { nextCursor?: string };
type CachedBoard = { board: Board; blocked: string[] };
type Props = {
  project: Project;
  online: boolean;
  send: (command: Command) => Promise<CommandResponse>;
  sessions: Session[];
  attentionIds: ReadonlySet<string>;
  cacheKey: string;
  bridgeNames?: ReadonlyMap<string, string>;
  onLaunch?: (ticketId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  close: () => void;
};

function parseBoard(value: unknown, project: Project): Board | null {
  if (!value || typeof value !== "object") return null;
  const board = value as Partial<Board>;
  if (board.project?.id !== project.id || board.project.bridgeId !== project.bridgeId ||
      !Array.isArray(board.tickets) || !board.tickets.every(ticket =>
        ticket && typeof ticket.id === "string" && typeof ticket.title === "string" &&
        stages.includes(ticket.stage) && Array.isArray(ticket.sessionIds) && ticket.sessionIds.every(id => typeof id === "string"))) return null;
  return board as Board;
}

function readCache(key: string, project: Project): CachedBoard | null {
  try {
    const entry = JSON.parse(localStorage.getItem(key) ?? "null");
    const board = parseBoard(entry?.board, project);
    return board && Array.isArray(entry.blocked) ? { board, blocked: entry.blocked } : null;
  } catch { return null; }
}

export function ProjectBoardPanel(props: Props) {
  const storageKey = JSON.stringify([props.cacheKey, "project-board", props.project.bridgeId, props.project.id]);
  return <ProjectBoard key={storageKey} {...props} storageKey={storageKey} />;
}

function ProjectBoard({ project, online, send, sessions, attentionIds, bridgeNames, onLaunch, onOpenSession, storageKey, close }: Props & { storageKey: string }) {
  const panel = useRef<HTMLElement>(null);
  const [cached, setCached] = useState(() => readCache(storageKey, project));
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [dragTicket, setDragTicket] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<Ticket["stage"] | null>(null);
  const newTicketId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const mutating = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const projectId = project.id;
  const bridgeId = project.bridgeId;
  const receive = useCallback(async (initial: CommandResponse, current: () => boolean) => {
    const tickets: Ticket[] = [];
    const seen = new Set<string>();
    let response = initial;
    let restarted = false;
    while (current()) {
      if (!response.success) {
        if (!restarted && seen.size > 0 && (response.data as { code?: string } | undefined)?.code === "project_board_changed") {
          restarted = true;
          seen.clear();
          tickets.length = 0;
          response = await send({ type: "get_project_board", requestId: crypto.randomUUID(), payload: { bridgeId, projectId } });
          continue;
        }
        throw Error(response.error || "Board request failed");
      }
      const page = parseBoard(response.data, { id: projectId, bridgeId, name: "" }) as BoardPage | null;
      if (!page) throw Error("Invalid board response");
      tickets.push(...page.tickets);
      if (page.nextCursor === undefined) {
        const board = { project: page.project, tickets };
        setCached(previous => ({ board, blocked: previous?.blocked ?? [] }));
        setFresh(true);
        setError("");
        return;
      }
      const cursor = page.nextCursor;
      if (typeof cursor !== "string" || !cursor || !page.tickets.length || seen.has(cursor)) throw Error("Invalid board cursor");
      seen.add(cursor);
      response = await send({ type: "get_project_board", requestId: crypto.randomUUID(), payload: { bridgeId, projectId, cursor } });
    }
  }, [projectId, bridgeId, send]);
  const mounted = useRef(false);
  useEffect(() => {
    panel.current?.focus();
    mounted.current = true;

    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    setFresh(false);
    if (!online) return;
    let active = true;
    let reading = false;
    async function load() {
      if (reading || mutating.current || document.hidden) return;
      reading = true;
      const token = revision.current;
      try {
        const res = await send({ type: "get_project_board", requestId: crypto.randomUUID(), payload: { bridgeId, projectId } });
        await receive(res, () => active && revision.current === token);
      } catch (err) {
        if (active && revision.current === token) {
          setFresh(false);
          setError(err instanceof Error ? err.message : "Could not load board");
        }
      } finally { reading = false; }
    }
    void load();
    const timer = window.setInterval(load, 15_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [online, send, projectId, bridgeId, receive, refresh]);
  const board = cached?.board;
  const editable = online && fresh && !busy;
  const currentBlocked = board?.tickets.filter(ticket => ticket.blocked || ticket.sessionIds.some(id => attentionIds.has(id))).map(ticket => ticket.id) ?? [];
  const blocked = online && fresh ? currentBlocked : cached?.blocked ?? [];
  const blockedKey = JSON.stringify(blocked);
  useEffect(() => {
    if (!board || !online || !fresh) return;
    const blockedIds = JSON.parse(blockedKey) as string[];
    try { localStorage.setItem(storageKey, JSON.stringify({ board, blocked: blockedIds })); } catch { /* Storage may be full. */ }
    setCached(previous => previous && JSON.stringify(previous.blocked) !== blockedKey ? { board, blocked: blockedIds } : previous);
  }, [storageKey, board, online, fresh, blockedKey]);
  async function change(payload: Record<string, unknown>) {
    if (!editable || mutating.current) return false;
    mutating.current = true;
    revision.current++;
    setBusy(true);
    setError("");
    let acknowledged = false;
    try {
      const response = await send({ type: "mutate_project_board", requestId: crypto.randomUUID(), payload: { bridgeId, projectId, ...payload } });
      acknowledged = response.success;
      await receive(response, () => mounted.current);
      return true;
    } catch (err) {
      if (acknowledged) {
        setFresh(false);
        setError("Saved on the home bridge. Refresh to load the updated board.");
      } else {
        setError(err instanceof Error ? err.message : "Could not confirm the change. Try again.");
      }
      return acknowledged;
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  const ticketById = new Map(board?.tickets.map(ticket => [ticket.id, ticket]));
  const detail = detailId ? ticketById.get(detailId) : undefined;
  const sessionById = new Map(sessions.map(session => [session.id, session]));
  const ticketBySession = new Map<string, string>();
  for (const ticket of board?.tickets ?? []) {
    for (const id of ticket.sessionIds) ticketBySession.set(id, ticket.title);
  }
  return <section ref={panel} tabIndex={-1} aria-labelledby="project-board-title"
    className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-base)] text-[var(--text-primary)] outline-none">
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--border-muted)] px-4 py-3 md:px-6">
      <div><h2 id="project-board-title" className="text-lg font-semibold">{project.name} board</h2>
        <p className="text-xs text-[var(--text-muted)]">Hosted on {bridgeNames?.get(bridgeId) ?? bridgeId}</p></div>
      <button className="btn-ghost" onClick={close} aria-label="Back to workspace">Back</button>
    </header>
    <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
    {!online && <p role="status">{board ? "Home bridge offline · last saved board" : "Home bridge offline · no cached board"}</p>}
    {online && !fresh && !error && <p role="status">Loading board…</p>}
    {error && online && <p role="alert">{error} <button className="btn-ghost" onClick={() => setRefresh(n => n + 1)}>Refresh</button></p>}
    {board && <>
      <form className="mb-4 flex items-center gap-2" onSubmit={async event => {
        event.preventDefault();
        if (!title.trim()) return;
        newTicketId.current ??= crypto.randomUUID();
        if (await change({ action: "create_ticket", ticketId: newTicketId.current, title: title.trim(), stage: "Backlog" })) {
          newTicketId.current = null;
          setTitle("");
        }
      }}>
        <input className="min-w-0 flex-1 rounded border border-[var(--border-muted)] p-2 text-sm" aria-label="Ticket title" placeholder="Ticket title" maxLength={512}
          disabled={!editable} value={title} onChange={event => { newTicketId.current = null; setTitle(event.target.value); }} />
        <button className="btn-accent" disabled={!editable || !title.trim()}>Add ticket</button>
      </form>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {stages.map(stage => {
          const tickets = board.tickets.filter(ticket => (blocked.includes(ticket.id) ? "Blocked" : ticket.stage) === stage);
          return <section aria-label={stage} key={stage}
            onDragOver={event => {
              if (!editable || !dragTicket) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropStage(stage);
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropStage(null);
            }}
            onDrop={event => {
              event.preventDefault();
              if (editable && dragTicket && event.dataTransfer.getData("application/x-ftown-ticket") === dragTicket &&
                  ticketById.get(dragTicket)?.stage !== stage) {
                void change({ action: "update_ticket", ticketId: dragTicket, stage });
              }
              setDragTicket(null); setDropStage(null);
            }}
            className="min-w-0 rounded-lg border border-[var(--border-muted)] bg-[var(--bg-surface)] p-2"
            style={dropStage === stage ? { outline: "2px solid var(--accent)" } : undefined}>
            <h3 className="mb-2 flex justify-between gap-2 text-sm font-semibold">{stage}<span className="text-[var(--text-muted)]">{tickets.length}</span></h3>
            {tickets.map(ticket => <article key={ticket.id} draggable={editable}
              onDragStart={event => {
                event.dataTransfer.setData("application/x-ftown-ticket", ticket.id);
                event.dataTransfer.effectAllowed = "move";
                setDragTicket(ticket.id);
              }}
              onDragEnd={() => { setDragTicket(null); setDropStage(null); }}
              className="mb-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-base)] p-2 text-sm">
              {ticket.parentTicketId && ticketById.has(ticket.parentTicketId) && <button className="mb-1 block truncate text-xs text-[var(--text-muted)] underline"
                onClick={() => setDetailId(ticket.parentTicketId ?? null)} aria-label={"Open parent ticket " + ticketById.get(ticket.parentTicketId)?.title}>
                {ticketById.get(ticket.parentTicketId)?.title}</button>}
              <div className="mb-1 flex items-start justify-between gap-2">
                <h4 className="min-w-0 font-semibold">
                <button className="cursor-pointer break-words text-left underline decoration-[var(--border-muted)] underline-offset-2 hover:text-[var(--accent)]"
                  onClick={() => setDetailId(ticket.id)}>{ticket.title}</button>
                </h4>
                {editable && <span role="img" aria-label={"Drag " + ticket.title} title={"Drag " + ticket.title} draggable
                className="cursor-grab select-none rounded px-1 text-[var(--text-muted)] active:cursor-grabbing">⠿</span>}
              </div>
              <p className="mb-2 flex flex-wrap items-baseline gap-1 text-xs"><span className="text-[var(--text-muted)]">Assignee</span>
                <span>{assignmentLabel(ticket.assignee, bridgeNames)}</span></p>
              {blocked.includes(ticket.id) && <p className="mb-1 text-xs text-[var(--status-pending)]">Session needs attention</p>}
              <label className="flex flex-wrap items-center gap-1 text-xs">Stage
                <select aria-label={'Stage for ' + ticket.title} className="btn-ghost" disabled={!editable} value={ticket.stage}
                  onChange={event => void change({ action: "update_ticket", ticketId: ticket.id, stage: event.target.value })}>
                  {stages.map(item => <option key={item}>{item}</option>)}
                </select>
              </label>
              {onLaunch && <button className="btn-ghost mt-2" disabled={!editable} onClick={() => onLaunch(ticket.id)}>Start session</button>}
              <details className="mt-2"><summary className="cursor-pointer text-xs">Sessions ({ticket.sessionIds.length})</summary>
                <ul>{ticket.sessionIds.map(id => {
                  const linked = sessionById.get(id);
                  return <li className="my-1 flex items-center justify-between gap-1 text-xs" key={id}>
                    {onOpenSession && linked
                      ? <button className="btn-ghost min-w-0 truncate" title={bridgeNames?.get(linked.bridgeId) ?? linked.bridgeId}
                          onClick={() => onOpenSession(id)}>{linked.name}</button>
                      : <span className="break-all">{linked?.name ?? id}</span>}
                    <span className="text-[var(--text-muted)]">{ticket.sessionStatuses?.[id] ?? linked?.status ?? "Unknown status"}</span>
                    <button className="btn-ghost" aria-label={'Unlink ' + (linked?.name ?? id)} disabled={!editable}
                      onClick={() => void change({ action: "update_ticket", ticketId: ticket.id, removeSessionId: id })}>×</button>
                  </li>;
                })}</ul>
                <select className="btn-ghost mt-1 w-full" aria-label={'Link session to ' + ticket.title} disabled={!editable} value="" onChange={event =>
                  void change({ action: "update_ticket", ticketId: ticket.id, addSessionId: event.target.value })}>
                  <option value="" disabled>Link session…</option>
                  {sessions.filter(session => session.projectName === project.name && !ticket.sessionIds.includes(session.id))
                    .map(session => <option key={session.id} value={session.id}>{session.name} · {bridgeNames?.get(session.bridgeId) ?? session.bridgeId}
                      {ticketBySession.has(session.id) ? " (move from " + ticketBySession.get(session.id) + ")" : ""}</option>)}
                </select>
              </details>
            </article>)}
          </section>;
        })}
      </div>
    </>}
    </div>
    {detail && <ProjectTicketDetail key={detail.id} ticket={detail} tickets={board?.tickets ?? []} sessionById={sessionById} openTicket={setDetailId} openSession={onOpenSession} project={project} editable={editable} online={online}
      bridgeNames={bridgeNames} send={send} change={change} error={error} close={() => setDetailId(null)} />}
  </section>;
}
