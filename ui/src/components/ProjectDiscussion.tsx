"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Command, CommandResponse, Session } from "@/types";
import type { DiscussionChannel, DiscussionThread, DiscussionPost, DiscussionAuthor } from "../../../bridge/src/project-discussion-protocol";
import { ProjectDatabaseUpdate, projectDatabaseError } from "./ProjectDatabaseUpdate";
import type { Ticket } from "./ProjectTicketDetail";

type Context = { project: { id: string; bridgeId: string; name: string }; online: boolean; unavailableMessage?: string; send: (cmd: Command) => Promise<CommandResponse> };
type Call = (action: string, fields?: Record<string, unknown>, write?: boolean) => Promise<Record<string, unknown>>;
type Selection = { action: "create" | "rename" | "archive"; channel: DiscussionChannel | null };
const input = "w-full min-w-0 rounded border border-[var(--border-muted)] bg-[var(--bg-base)] px-3 py-2 text-sm";
const muted = "text-xs text-[var(--text-muted)]";
const message = (err: unknown) => err instanceof Error ? err.message : "Discussion request failed";

function validRow(action: string, value: unknown) {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") return false;
  const row = value as Record<string, unknown>;
  if (action === "channels") return typeof row.name === "string" && typeof row.archived === "boolean";
  const author = row.author as Partial<DiscussionAuthor> | null;
  if (!author || typeof author.name !== "string" || (author.bridgeId !== undefined && typeof author.bridgeId !== "string")
    || (author.sessionId !== undefined && typeof author.sessionId !== "string") || typeof row.createdAt !== "string" || !Number.isSafeInteger(row.seq)) return false;
  if (action === "posts") return typeof row.threadId === "string" && typeof row.text === "string";
  return typeof row.channelId === "string" && typeof row.title === "string" && (row.ticketId === null || typeof row.ticketId === "string");
}

function useCall({ project, online, send }: Context): Call {
  return useCallback(async (action, fields = {}, write = false) => {
    if (!online) throw Error("The project's home bridge is offline.");
    const result = await send({ type: write ? "mutate_project_discussion" : "get_project_discussion",
      requestId: crypto.randomUUID(), payload: { bridgeId: project.bridgeId, projectId: project.id, action, ...fields } });
    if (!result.success) throw Error(result.error || "Could not reach the project discussion");
    if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) throw Error("Invalid discussion response");
    return result.data as Record<string, unknown>;
  }, [online, send, project.id, project.bridgeId]);
}

function usePage<T>(call: Call, enabled: boolean, action: string, filter: string, id: string, revision: number, live = false) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const gen = useRef(0);
  const pending = useRef(false);
  const incompatible = useRef(false);
  const cursor = useRef<number | undefined>(undefined);
  const load = useCallback(async (after?: number, background = false) => {
    if (!enabled || pending.current || (background && incompatible.current)) return;
    pending.current = true;
    const token = ++gen.current;
    if (!background) setLoading(true);
    try {
      const page = await call(action, { ...(filter ? { [filter]: id } : {}), ...(after !== undefined ? { after } : {}) });
      const items = page[action];
      if (!Array.isArray(items) || !items.every(row => validRow(action, row)) || (page.nextAfter !== undefined && (!Number.isSafeInteger(page.nextAfter) || Number(page.nextAfter) <= (after ?? 0)))) throw Error("Invalid discussion page");
      if (token !== gen.current) return;
      if (action !== "channels" && items.length) cursor.current = items.at(-1).seq;
      setError("");
      incompatible.current = false;
      setRows(old => after === undefined || old === null ? items : items.length ? [...old, ...items] : old);
      setNext(typeof page.nextAfter === "number" ? page.nextAfter : null);
    } catch (err) {
      if (token === gen.current) {
        const reason = message(err);
        incompatible.current = projectDatabaseError(reason);
        setError(reason);
      }
    }
    finally { if (token === gen.current) { pending.current = false; setLoading(false); } }
  }, [call, enabled, action, filter, id]);
  useEffect(() => {
    setRows(null); setNext(null); setError("");
    incompatible.current = false;
    cursor.current = undefined;
  }, [action, filter, id]);
  useEffect(() => {
    setLoading(false);
    const invalidate = () => { gen.current++; pending.current = false; };
    if (!live || !enabled) {
      void load();
      return invalidate;
    }
    // Each tick requests one bounded page after the last displayed record.
    // Pausing/resuming keeps that cursor and the already loaded pages intact.
    let timer: number | undefined;
    const poll = () => { if (!document.hidden) void load(cursor.current, true); };
    const visibility = () => {
      window.clearInterval(timer);
      if (!document.hidden) {
        poll();
        timer = window.setInterval(poll, 15_000);
      }
    };
    if (!document.hidden) {
      void load(cursor.current);
      timer = window.setInterval(poll, 15_000);
    }
    document.addEventListener("visibilitychange", visibility);
    return () => {
      invalidate();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [load, revision, enabled, live]);
  return { rows: rows ?? [], loaded: rows !== null, next, error, loading, load, loadNew: () => load(cursor.current) };
}

function More({ page }: { page: ReturnType<typeof usePage> }) {
  return <>
    {page.error && !projectDatabaseError(page.error) && <p role="alert" className="text-sm">{page.error} <button className="btn-ghost" onClick={() => void page.loadNew()}>Retry</button></p>}
    {page.next !== null && <button className="btn-ghost" disabled={page.loading} onClick={() => void page.load(page.next!)}>Load more</button>}
  </>;
}

function Modal({ name, close, children }: { name: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = dialog.current; el?.showModal(); return () => el?.close(); }, []);
  return <dialog ref={dialog} aria-label={name} className="computers-dialog p-5"
    onCancel={e => { e.preventDefault(); close(); }}>
    <header className="mb-4 flex items-center justify-between gap-4"><h3 className="text-base font-semibold">{name}</h3>
      <button className="btn-ghost" aria-label={"Close " + name} onClick={close}>×</button></header>
    {children}
  </dialog>;
}

function useMutation() {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(message(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  return { busy, error, run };
}

function ChannelDialog({ selection, call, close, saved }: { selection: Selection; call: Call; close: () => void; saved: (id: string) => void }) {
  const { action, channel } = selection;
  const [name, setName] = useState(channel?.name ?? "");
  const [newId] = useState(() => crypto.randomUUID());
  const { busy, error, run } = useMutation();
  const heading = action === "create" ? "Create channel" : action === "rename" ? "Rename channel" : "Archive channel";
  return <Modal name={heading} close={close}><form className="space-y-3" onSubmit={event => {
    event.preventDefault();
    void run(async () => {
      const id = channel?.id ?? newId;
      await call(action + "_channel", { channelId: id, ...(action === "archive" ? {} : { name: name.trim() }) }, true);
      saved(id); close();
    });
  }}>
    {action === "archive" ? <p>Archive #{channel?.name}? Its threads and ticket links will remain readable.</p> :
      <label className="block text-sm">Channel name<input className={input} required maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,63}" title="Letters, numbers, hyphens and underscores" value={name} onChange={e => setName(e.target.value)} /></label>}
    {error && <p role="alert">{error}</p>}
    <button className={action === "archive" ? "btn-danger" : "btn-accent"} disabled={busy}>{heading}</button>
  </form></Modal>;
}

function Byline({ author, time, bridges }: { author: DiscussionAuthor; time: string; bridges?: ReadonlyMap<string,string> }) {
  return <span className={muted}>
    <span title={author.sessionId}>{author.name}</span>
    {author.bridgeId && <> · {bridges?.get(author.bridgeId) ?? author.bridgeId}</>} · <time dateTime={time}>{new Date(time).toLocaleString()}</time>
  </span>;
}

type ComposerProps = { canPost: boolean; sessions: Session[]; bridges?: ReadonlyMap<string,string>; call: Call; channelId: string; threadId?: string; saved: (id: string) => void };
function Composer({ canPost, sessions, bridges, call, channelId, threadId, saved }: ComposerProps) {
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const ids = useRef<{ thread: string; post: string } | null>(null);
  const { busy, error, run } = useMutation();
  const [mentions, setMentions] = useState<string[]>([]);
  const selected = sessions.filter(s => mentions.includes(s.id));
  const content = [...selected.map(s => "@" + s.name), body.trim()].join(" ");
  const bytes = new TextEncoder().encode(content).length;
  const tag = (s: Session) => "@" + s.id;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canPost || !body.trim() || (!threadId && !title.trim())) return;
    void run(async () => {
      const attempt = ids.current ??= { thread: threadId ?? crypto.randomUUID(), post: crypto.randomUUID() };
      const tokens = new Set(body.split(/\s+/));
      const targets = sessions.filter(s => mentions.includes(s.id) || tokens.has(tag(s)))
        .map(({ id: sessionId, bridgeId }) => ({ sessionId, bridgeId }));
      await call(threadId ? "reply" : "create_thread", { threadId: attempt.thread, postId: attempt.post, text: content, mentions: targets,
        ...(!threadId && { title: title.trim(), channelId }) }, true);
      setBody(""); setTitle(""); setMentions([]); ids.current = null; saved(attempt.thread);
    });
  };
  return <form className="space-y-3" onSubmit={submit}>
    <fieldset className="space-y-2" disabled={busy}>
      {!threadId && <label className="block text-sm">Thread title<input required className={input} maxLength={256}
        value={title} onChange={e => { ids.current = null; setTitle(e.target.value); }} /></label>}
      <label className="block text-sm">{threadId ? "Your reply" : "Message"}<textarea required className={input} rows={3} value={body}
        maxLength={8192} onChange={e => { ids.current = null; setBody(e.target.value); }} /></label>
      {sessions.length > 0 && <label className="block text-sm">Mention a session<select className={input} value="" onChange={e => {
        ids.current = null; setMentions([...mentions, e.target.value]);
      }}><option value="" disabled>Choose a session…</option>{sessions.filter(s => !mentions.includes(s.id)).map(s =>
        <option key={s.id} value={s.id}>{s.name} · {bridges?.get(s.bridgeId) ?? s.bridgeId}</option>)}</select></label>}
      {mentions.map(id => <button key={id} type="button" className="btn-ghost" title="Remove mention" onClick={() => {
        ids.current = null; setMentions(mentions.filter(s => s !== id));
      }}>@{sessions.find(s => s.id === id)?.name ?? id} ×</button>)}
    </fieldset>
    {bytes > 8192 && <p role="alert">Message exceeds 8 KiB.</p>}
    {error && <p role="alert">{error}</p>}
    <button className="btn-accent" disabled={!canPost || busy || !body.trim() || (!threadId && !title.trim()) || bytes > 8192}>{threadId ? "Post reply" : "Post thread"}</button>
  </form>;
}

function TicketLinks({ thread, call, tickets, createEnabled, writable, openTicket, updated }: {
  thread: DiscussionThread; call: Call; tickets: Ticket[]; createEnabled: boolean; writable: boolean;
  openTicket: (id: string) => void; updated: (id: string) => void;
}) {
  const [mode, setMode] = useState<"create" | "link" | null>(null);
  const [title, setTitle] = useState(thread.title);
  const [ticketId, setTicketId] = useState("");
  const newId = useRef<string | null>(null);
  const { busy, error, run } = useMutation();
  if (thread.ticketId) return <button className="btn-ghost" onClick={() => openTicket(thread.ticketId!)}>Open ticket · {tickets.find(t => t.id === thread.ticketId)?.title ?? thread.ticketId}</button>;
  if (!writable || !createEnabled) return null;
  return <><div className="flex flex-wrap gap-2">
    <button className="btn-ghost" onClick={() => setMode("create")}>Create ticket from thread</button>
    {tickets.length > 0 && <button className="btn-ghost" onClick={() => setMode("link")}>Link existing ticket</button>}
  </div>{mode && <Modal name={mode === "create" ? "Create ticket from thread" : "Link existing ticket"} close={() => setMode(null)}>
    <form className="space-y-3" onSubmit={event => {
      event.preventDefault();
      void run(async () => {
        const id = mode === "create" ? (newId.current ??= crypto.randomUUID()) : ticketId;
        await call(mode === "create" ? "create_ticket" : "link_ticket", { threadId: thread.id, ticketId: id,
          ...(mode === "create" && { title: title.trim() }) }, true);
        updated(id); setMode(null);
      });
    }}>
      {mode === "create" ? <label className="block">Ticket title<input className={input} required value={title} maxLength={256} onChange={e => setTitle(e.target.value)} /></label> :
        <label className="block">Ticket<select className={input} value={ticketId} required onChange={e => setTicketId(e.target.value)}>
          <option value="" disabled>Choose a ticket…</option>{tickets.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>}
      {error && <p role="alert">{error}</p>}
      <button className="btn-accent" disabled={busy || (mode === "create" ? !title.trim() : !ticketId)}>{mode === "create" ? "Create ticket" : "Link ticket"}</button>
    </form></Modal>}</>;
}

export function TicketThreads({ ticketId, open, onOpenUpdates, bridgeName, ...ctx }: Context & { ticketId: string; open: (row: DiscussionThread) => void; onOpenUpdates?: () => void; bridgeName?: string }) {
  const [expanded, setExpanded] = useState(false);
  const call = useCall(ctx);
  const page = usePage<DiscussionThread>(call, expanded && ctx.online, "threads", "ticketId", ticketId, 0);
  return <section aria-label="Linked discussions"><button className="btn-ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>Linked discussions</button>
    {expanded && <div className="mt-2 space-y-1">
      {!ctx.online && <p className={muted}>{ctx.unavailableMessage ?? "Home bridge offline"}</p>}
      {page.rows.map(t => <button key={t.id} className="btn-ghost block" onClick={() => open(t)}>{t.title}</button>)}
      {projectDatabaseError(page.error) && <ProjectDatabaseUpdate bridgeName={bridgeName ?? ctx.project.bridgeId} onOpenUpdates={onOpenUpdates} />}
      {ctx.online && page.loaded && !page.rows.length && !page.error && <p className={muted}>No linked threads.</p>}
      <More page={page} />
    </div>}</section>;
}

type Props = Context & {
  sessions: Session[]; bridgeNames?: ReadonlyMap<string, string>; tickets: Ticket[]; boardEnabled: boolean;
  onOpenUpdates?: () => void; initialThread: DiscussionThread | null; onThread: (row: DiscussionThread | null) => void; openTicket: (id: string) => void; onTicketCreated: () => void;
};

export function ProjectDiscussion({ project, online, unavailableMessage = "Home bridge offline", send, sessions, bridgeNames, tickets, boardEnabled, initialThread: thread, onThread, openTicket, onTicketCreated, onOpenUpdates }: Props) {
  const call = useCall({ project, online, send });
  const [channelId, setChannelId] = useState(thread?.channelId ?? "general");
  const [channelRev, setChannelRev] = useState(0);
  const [channelEdit, setChannelEdit] = useState<Selection | null>(null);
  const [compose, setCompose] = useState(false);
  const [error, setError] = useState("");
  const channels = usePage<DiscussionChannel>(call, online, "channels", "", "", channelRev);
  const threads = usePage<DiscussionThread>(call, online && !thread, "threads", "channelId", channelId, 0, true);
  const channel = channels.rows.find(c => c.id === channelId);
  const navigation = useRef(0);
  const [replySaved, setReplySaved] = useState(false);
  const posts = usePage<DiscussionPost>(call, online && !!thread, "posts", "threadId", thread?.id ?? "", 0, true);
  const projectSessions = sessions.filter(s => s.projectName === project.name);
  const versionError = projectDatabaseError(channels.error) || projectDatabaseError(thread ? posts.error : threads.error) || projectDatabaseError(error);
  const writableChannel = !!channel && !channel.archived;
  const canPost = online && !versionError && writableChannel;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function selectChannel(id: string) { navigation.current++; setReplySaved(false); setChannelId(id); onThread(null); setError(""); setCompose(false); }
  async function openById(id: string) {
    const token = ++navigation.current;
    try {
      const { thread: created } = await call("thread", { threadId: id });
      if (!validRow("threads", created) || (created as DiscussionThread).id !== id) throw Error("Invalid thread response");
      if (mounted.current && navigation.current === token) { setError(""); onThread(created as DiscussionThread); }
    } catch (cause) { if (mounted.current && navigation.current === token) setError(message(cause)); }
  }
  const channelButton = (c: DiscussionChannel) => <button key={c.id} aria-pressed={channelId === c.id}
    className={"block w-full truncate rounded px-3 py-2 text-left text-sm hover:bg-[var(--bg-hover)] " + (channelId === c.id ? "bg-[var(--bg-surface)] font-semibold text-[var(--accent)]" : "")}
    onClick={() => selectChannel(c.id)}>#{c.name}</button>;
  return <section aria-label="Project discussion" className="grid min-h-0 flex-1 overflow-auto md:grid-cols-[minmax(11rem,15rem)_1fr]">
    <aside className="min-w-0 border-b border-[var(--border-subtle)] p-4 md:border-b-0 md:border-r md:overflow-auto">
      <header className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">Channels</h3>
        <button className="btn-ghost" disabled={!online || versionError} aria-label="Create channel" onClick={() => setChannelEdit({ action: "create", channel: null })}>＋</button></header>
      <nav aria-label="Discussion channels">{channels.rows.filter(c => !c.archived).map(channelButton)}</nav>
      {channels.rows.some(c => c.archived) && <details open={channel?.archived || undefined} className="mt-3"><summary className={"cursor-pointer " + muted}>Archived channels</summary>
        {channels.rows.filter(c => c.archived).map(channelButton)}</details>}
      <More page={channels} />
    </aside>
    <div className="min-w-0 space-y-4 p-4 md:overflow-auto md:p-6">
      {!online && <p role="status">{unavailableMessage}</p>}
      {versionError && <ProjectDatabaseUpdate bridgeName={bridgeNames?.get(project.bridgeId) ?? project.bridgeId} onOpenUpdates={onOpenUpdates} />}
      {error && !projectDatabaseError(error) && <p role="alert">{error}</p>}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="break-all text-lg font-semibold">#{channel?.name ?? channelId}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {!thread && writableChannel && <button disabled={!canPost} className="btn-accent" onClick={() => setCompose(true)}>New thread</button>}
          {!thread && writableChannel && <button className="btn-ghost" disabled={!canPost} onClick={() => setChannelEdit({ action: "rename", channel })}>Rename</button>}
          {!thread && writableChannel && <button className="btn-ghost" disabled={!canPost} onClick={() => setChannelEdit({ action: "archive", channel })}>Archive</button>}
          <button className="btn-ghost" disabled={!online || channels.loading || posts.loading || threads.loading} onClick={() => {
            setChannelRev(n => n + 1);
            if (thread) { void posts.loadNew(); void openById(thread.id); }
            else void threads.loadNew();
          }}>Refresh</button>
        </div>
      </header>
      {channel?.archived && <p className={muted}>Archived · read only</p>}
      {thread ? <article key={thread.id} className="space-y-4">
        <button className="btn-ghost" onClick={() => { navigation.current++; setReplySaved(false); onThread(null); setError(""); }}>← Threads</button>
        <h4 className="break-words text-xl font-semibold">{thread.title}</h4>
        <TicketLinks thread={thread} call={call} tickets={tickets} createEnabled={boardEnabled} writable={canPost} openTicket={openTicket}
          updated={id => { onThread({ ...thread, ticketId: id }); onTicketCreated(); }} />
        <ol aria-label="Thread messages" className="space-y-3">{posts.rows.map(post => <li key={post.id} className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <Byline author={post.author} time={post.createdAt} bridges={bridgeNames} />
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{post.text}</p></li>)}</ol>
        <More page={posts} />
        {replySaved && <p role="status" className={muted}>Reply posted.</p>}
        {writableChannel && <Composer canPost={canPost} sessions={projectSessions} bridges={bridgeNames} call={call} channelId={channelId} threadId={thread.id} saved={() => {
          setReplySaved(true); if (posts.next === null) void posts.loadNew();
        }} />}
      </article> : <>
        {online && threads.loaded && !threads.error && !threads.rows.length && <p className={muted}>No threads in this channel.</p>}
        <ul className="divide-y divide-[var(--border-subtle)]">{threads.rows.map(t => <li key={t.id} className="py-3">
          <button className="block break-words text-left font-semibold underline decoration-[var(--border-muted)] underline-offset-4" onClick={() => onThread(t)}>{t.title}</button>
          <Byline author={t.author} time={t.createdAt} bridges={bridgeNames} /></li>)}</ul>
        <More page={threads} />
      </>}
    </div>
    {channelEdit && <ChannelDialog selection={channelEdit} call={call} close={() => setChannelEdit(null)} saved={id => { setChannelRev(n => n + 1); selectChannel(id); }} />}
    {compose && <Modal name="New thread" close={() => setCompose(false)}><Composer canPost={canPost} sessions={projectSessions} bridges={bridgeNames} call={call} channelId={channelId}
      saved={id => { setCompose(false); void threads.loadNew(); void openById(id); }} /></Modal>}
  </section>;
}
