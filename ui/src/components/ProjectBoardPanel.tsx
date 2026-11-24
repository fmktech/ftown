"use client";

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import type { Command, CommandResponse, Session } from "@/types";

import { ProjectTicketDetail, assignmentLabel, type Ticket } from "./ProjectTicketDetail";
import { projectDatabaseError, ProjectDatabaseUpdate } from "./ProjectDatabaseUpdate";
import { ProjectIcon } from "./ProjectIcon";
import "./project-workspace.css";
import { ProjectBoardSettingsDialog } from "./ProjectBoardSettingsDialog";
import { ProjectDiscussion, TicketThreads } from "./ProjectDiscussion";
import type { DiscussionThread } from "../../../bridge/src/project-discussion-protocol";
import { defaultBoardColumns, type BoardColumn } from "../../../bridge/src/board-columns";

type Project = { id: string; name: string; bridgeId: string };
type Board = { project: Project; tickets: Ticket[]; columns?: BoardColumn[]; boardEnabled?: boolean };
type BoardPage = Board & { nextCursor?: string };
type CachedBoard = { board: Board; blocked: string[] };
type Props = {
  project: Project;
  online: boolean;
  unavailableMessage?: string;
  send: (command: Command) => Promise<CommandResponse>;
  sessions: Session[];
  attentionIds: ReadonlySet<string>;
  cacheKey: string;
  bridgeNames?: ReadonlyMap<string, string>;
  onOpenUpdates?: () => void;
  onLaunch?: (ticketId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  close: () => void;
};

function parseBoard(value: unknown, project: Project): Board | null {
  if (!value || typeof value !== "object") return null;
  const board = value as Partial<Board>;
  const columns = board.columns ?? defaultBoardColumns;
  if (!Array.isArray(columns) || !columns.every(c => c && typeof c.id === "string" && typeof c.label === "string") ||
      (board.boardEnabled !== undefined && typeof board.boardEnabled !== "boolean") ||
      (board.boardEnabled === false ? columns.length !== 0 : !columns.length)) return null;
  const ids = new Set(columns.map(c => c.id));
  if (board.project?.id !== project.id || board.project.bridgeId !== project.bridgeId ||
      !Array.isArray(board.tickets) || !board.tickets.every(ticket =>
        ticket && typeof ticket.id === "string" && typeof ticket.title === "string" &&
        ids.has(ticket.stage) && Array.isArray(ticket.sessionIds) && ticket.sessionIds.every(id => typeof id === "string"))) return null;
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

function ProjectBoard({ project, online, unavailableMessage = "Home bridge offline", send, sessions, attentionIds, bridgeNames, onOpenUpdates, onLaunch, onOpenSession, storageKey, close }: Props & { storageKey: string }) {
  const panel = useRef<HTMLElement>(null);
  const [cached, setCached] = useState(() => readCache(storageKey, project));
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<"Tickets" | "Discussion">("Tickets");
  const [thread, setThread] = useState<DiscussionThread | null>(null);
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
        const board = { project: page.project, tickets, columns: page.columns, boardEnabled: page.boardEnabled };
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
    if (!online) { setFresh(false); return; }
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
    if (tab === "Discussion") return () => { active = false; };
    const timer = window.setInterval(load, 15_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [online, send, projectId, bridgeId, receive, refresh, tab]);
  const board = cached?.board;
  const columns = board?.columns ?? defaultBoardColumns;
  const columnNames = new Map(columns.map(c => [c.id, c.label]));
  useEffect(() => {
    if (board?.boardEnabled === false) { setSettingsOpen(false); setDetailId(null); setTitle(""); newTicketId.current = null; }
  }, [board?.boardEnabled]);
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
    className="project-workspace flex min-h-0 min-w-0 flex-1 flex-col outline-none">
    <header className="project-workspace-header">
      <div className="project-workspace-identity">
        <span className="project-workspace-mark"><ProjectIcon name="project" size={22} /></span>
        <div className="min-w-0">
          <h2 id="project-board-title" className="project-workspace-title">{project.name}<span className="sr-only"> board</span></h2>
          <p className="project-workspace-host" title={bridgeNames?.get(bridgeId) ?? bridgeId}>
            <ProjectIcon name="bridge" size={13} /><span>Hosted on {bridgeNames?.get(bridgeId) ?? bridgeId}</span>
          </p>
        </div>
      </div>
      <div className="project-workspace-actions">
        {tab === "Tickets" && board?.boardEnabled === true &&
          <button className="project-header-action" disabled={!editable} onClick={() => setSettingsOpen(true)} aria-label="Board settings" title="Board settings">
            <ProjectIcon name="settings" /><span>Board settings</span>
          </button>}
        <button className="project-header-action" onClick={close} aria-label="Back to workspace" title="Back to workspace">
          <ProjectIcon name="back" /><span>Back</span>
        </button>
      </div>
    </header>
    <nav aria-label="Project views" className="project-workspace-tabs">
      {(["Tickets", "Discussion"] as const).map(view => <button key={view} aria-pressed={tab === view} onClick={() => setTab(view)}>
        <ProjectIcon name={view === "Tickets" ? "tickets" : "discussion"} /><span>{view}</span>
      </button>)}
    </nav>
    {tab === "Discussion" ? <ProjectDiscussion project={project} sessions={sessions} bridgeNames={bridgeNames}
      online={online} unavailableMessage={unavailableMessage} onOpenUpdates={onOpenUpdates} send={send} boardEnabled={board?.boardEnabled !== false} tickets={board?.tickets ?? []}
      initialThread={thread} onThread={setThread} openTicket={id => {
        setDetailId(id); setTab("Tickets"); setRefresh(n => n + 1);
      }} onTicketCreated={() => setRefresh(n => n + 1)} /> : <div className="ticket-board">
    {!online && <p role="status" className="ticket-board-notice">{unavailableMessage} · {board ? "last saved board" : "no cached board"}</p>}
    {online && !board && !error && <p role="status" className="ticket-board-notice">Loading board…</p>}
    {error && online && (projectDatabaseError(error)
      ? <ProjectDatabaseUpdate bridgeName={bridgeNames?.get(bridgeId) ?? bridgeId} onOpenUpdates={onOpenUpdates} />
      : <p role="alert" className="ticket-board-notice">{error} <button className="btn-ghost" onClick={() => setRefresh(n => n + 1)}>Refresh</button></p>)}
    {board?.boardEnabled === false && <div className="ticket-board-empty"><ProjectIcon name="tickets" size={24} /><p>This project has no board.</p>
      <button className="btn-accent" disabled={!editable} onClick={() => void change({ action: "create_board" })}>Create board</button></div>}
    {board && board.boardEnabled !== false && <>
      <div className="ticket-board-toolbar">
        <p className="ticket-board-total"><span>{board.tickets.length}</span> {board.tickets.length === 1 ? "ticket" : "tickets"}</p>
        <form className="ticket-board-compose" onSubmit={async event => {
          event.preventDefault();
          if (!title.trim()) return;
          newTicketId.current ??= crypto.randomUUID();
          if (await change({ action: "create_ticket", ticketId: newTicketId.current, title: title.trim() })) {
            newTicketId.current = null;
            setTitle("");
          }
        }}>
          <input aria-label="Ticket title" placeholder="New ticket title…" maxLength={512}
            disabled={!editable} value={title} onChange={event => { newTicketId.current = null; setTitle(event.target.value); }} />
          <button className="ticket-primary" disabled={!editable || !title.trim()}><ProjectIcon name="plus" size={15} />Add ticket</button>
        </form>
      </div>
      <div className="ticket-board-scroll">
        <div className="ticket-board-lanes" style={{ "--board-columns": columns.length } as CSSProperties}>
          {columns.map(({ id: stage, label }) => {
            const tickets = board.tickets.filter(ticket => (columnNames.has("Blocked") && blocked.includes(ticket.id) ? "Blocked" : ticket.stage) === stage);
            return <section aria-label={label} key={stage} className="ticket-lane" data-stage={stage} data-drop={dropStage === stage}
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
              }}>
              <h3 className="ticket-lane-heading"><span className="ticket-stage-mark" aria-hidden="true" />
                <span className="min-w-0 break-words">{label}</span><span className="ticket-lane-count">{tickets.length}</span>
              </h3>
              <div className="ticket-lane-cards">
                {!tickets.length && <p className="ticket-lane-empty">{dragTicket ? "Drop ticket here" : "No tickets"}</p>}
                {tickets.map(ticket => <article key={ticket.id} draggable={editable}
                  onDragStart={event => {
                    event.dataTransfer.setData("application/x-ftown-ticket", ticket.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDragTicket(ticket.id);
                  }}
                  onDragEnd={() => { setDragTicket(null); setDropStage(null); }}
                  className="project-ticket-card" data-dragging={dragTicket === ticket.id}>
                  {ticket.parentTicketId && ticketById.has(ticket.parentTicketId) && <button className="ticket-parent" title={ticketById.get(ticket.parentTicketId)?.title}
                    onClick={() => setDetailId(ticket.parentTicketId ?? null)} aria-label={"Open parent ticket " + ticketById.get(ticket.parentTicketId)?.title}>
                    <ProjectIcon name="link" size={12} /><span className="truncate">{ticketById.get(ticket.parentTicketId)?.title}</span></button>}
                  <div className="flex items-start justify-between gap-1">
                    <h4 className="min-w-0">
                      <button className="ticket-card-title" onClick={() => setDetailId(ticket.id)}>{ticket.title}</button>
                    </h4>
                    {editable && <span role="img" aria-label={"Drag " + ticket.title} title={"Drag " + ticket.title} draggable
                      className="ticket-drag"><ProjectIcon name="grip" size={15} /></span>}
                  </div>
                  {ticket.body && <p className="ticket-card-body">{ticket.body}</p>}
                  {blocked.includes(ticket.id) && <p className="ticket-attention">Session needs attention</p>}
                  <div className="ticket-card-meta">
                    <span className="ticket-assignee" title={"Assignee · " + assignmentLabel(ticket.assignee, bridgeNames)}>
                      <ProjectIcon name={ticket.assignee?.kind === "bridge" ? "bridge" : "person"} size={13} />
                      <span className="sr-only">Assignee </span><span className="truncate">{assignmentLabel(ticket.assignee, bridgeNames)}</span>
                    </span>
                    {!!ticket.commentCount && <span className="ticket-comment-count" title={ticket.commentCount + " comments"}>
                      <ProjectIcon name="discussion" size={13} /><span>{ticket.commentCount}</span><span className="sr-only"> comments</span>
                    </span>}
                  </div>
                  <div className="ticket-card-actions">
                    <select aria-label={'Stage for ' + ticket.title} title="Change stage" className="ticket-select" disabled={!editable} value={ticket.stage}
                      onChange={event => void change({ action: "update_ticket", ticketId: ticket.id, stage: event.target.value })}>
                      {columns.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                    {onLaunch && <button className="ticket-start" disabled={!editable} aria-label="Start session" title="Start session" onClick={() => onLaunch(ticket.id)}>
                      <ProjectIcon name="session" size={14} />
                    </button>}
                  </div>
                  <details className="ticket-sessions"><summary>Sessions ({ticket.sessionIds.length})</summary>
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
                    <select className="ticket-select mt-1 w-full" aria-label={'Link session to ' + ticket.title} disabled={!editable} value="" onChange={event =>
                      void change({ action: "update_ticket", ticketId: ticket.id, addSessionId: event.target.value })}>
                      <option value="" disabled>Link session…</option>
                      {sessions.filter(session => session.projectName === project.name && !ticket.sessionIds.includes(session.id))
                        .map(session => <option key={session.id} value={session.id}>{session.name} · {bridgeNames?.get(session.bridgeId) ?? session.bridgeId}
                          {ticketBySession.has(session.id) ? " (move from " + ticketBySession.get(session.id) + ")" : ""}</option>)}
                    </select>
                  </details>
                </article>)}
              </div>
            </section>;
          })}
        </div>
      </div>
    </>}
    </div>}
    {settingsOpen && board?.boardEnabled === true && <ProjectBoardSettingsDialog
      columns={columns} tickets={board.tickets} projectName={project.name} editable={editable} error={error}
      change={change} close={() => setSettingsOpen(false)} />}
    {tab === "Tickets" && detail && <ProjectTicketDetail discussion={<TicketThreads project={project} ticketId={detail.id} bridgeName={bridgeNames?.get(bridgeId)}
      online={online} unavailableMessage={unavailableMessage} onOpenUpdates={onOpenUpdates} send={send} open={row => { setThread(row); setDetailId(null); setTab("Discussion"); }} />} columnNames={columnNames} key={detail.id} ticket={detail} tickets={board?.tickets ?? []} sessionById={sessionById} openTicket={setDetailId} openSession={onOpenSession} project={project} editable={editable} online={online}
      bridgeNames={bridgeNames} send={send} change={change} error={error} close={() => setDetailId(null)} />}
  </section>;
}
