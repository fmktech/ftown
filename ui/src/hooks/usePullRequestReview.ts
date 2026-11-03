"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useState } from "react";
import { v4 as uuid } from "uuid";
import { PR_REVIEW_CHUNK_BYTES, PR_REVIEW_MAX_BODY_BYTES, PR_REVIEW_MAX_DIFF_BYTES, PR_REVIEW_MAX_TITLE_BYTES, type PrReviewMetadata, type PrReviewUnavailableReason } from "../../../bridge/src/pull-request-review-protocol";
import type { BridgeRpc } from "@/hooks/useBridgeRpc";
import type { MessageClient } from "@/lib/message-client";
import type { ReviewRefreshFailure, ReviewState } from "@/lib/pr-review-types";
import { sessionAuthority } from "@/lib/session-authority";
import { parsePullRequestUrl } from "@/lib/pull-request-url";
import type { Session } from "@/types";

export type { ReviewState } from "@/lib/pr-review-types";

const hex = /^[0-9a-f]{64}$/;
const oid = /^[0-9a-f]{40}$/i;
const reasons = new Set<PrReviewUnavailableReason>(["unlinked", "unauthenticated", "rate_limited", "not_found_or_forbidden", "timeout", "too_large", "unsupported", "stale", "unavailable"]);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const bytes = (v: string) => new TextEncoder().encode(v).length;
const limited = (v: unknown, max: number): v is string => typeof v === "string" && bytes(v) <= max;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function parseReviewMetadata(value: unknown, url: string): PrReviewMetadata {
  if (!obj(value) || !keys(value, ["url", "title", "body", "author", "state", "baseRef", "headRef", "baseOid", "headOid", "additions", "deletions", "changedFiles", "fetchedAt"]) || value.url !== url || !limited(value.url, 2048)
    || !limited(value.title, PR_REVIEW_MAX_TITLE_BYTES) || !limited(value.body, PR_REVIEW_MAX_BODY_BYTES) || !limited(value.author, 256) || !limited(value.baseRef, 512) || !limited(value.headRef, 512)
    || (typeof value.state !== "string" || !["open", "closed", "merged"].includes(value.state)) || typeof value.baseOid !== "string" || !oid.test(value.baseOid) || typeof value.headOid !== "string" || !oid.test(value.headOid)
    || !count(value.additions) || !count(value.deletions) || !count(value.changedFiles) || typeof value.fetchedAt !== "string" || !Number.isFinite(Date.parse(value.fetchedAt)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.fetchedAt)) throw new Error("Invalid review metadata");
  return value as unknown as PrReviewMetadata;
}
function unavailable(value: Record<string, unknown>): PrReviewUnavailableReason | null {
  return value.state === "unavailable" && keys(value, ["state", "reason"]) && typeof value.reason === "string" && reasons.has(value.reason as PrReviewUnavailableReason) ? value.reason as PrReviewUnavailableReason : null;
}
export function parseReviewChunk(value: unknown, revision: string, total: number, offset: number): Uint8Array {
  if (!obj(value) || !keys(value, ["state", "revision", "totalBytes", "offset", "dataBase64", "done"]) || value.state !== "chunk" || value.revision !== revision || value.totalBytes !== total || value.offset !== offset || typeof value.dataBase64 !== "string" || typeof value.done !== "boolean") throw new Error("Invalid review chunk");
  const expected = Math.min(PR_REVIEW_CHUNK_BYTES, total - offset);
  if (value.dataBase64.length !== 4 * Math.ceil(expected / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.dataBase64)) throw new Error("Invalid base64");
  const decoded = atob(value.dataBase64);
  if (btoa(decoded) !== value.dataBase64 || decoded.length !== expected || value.done !== (offset + expected === total)) throw new Error("Invalid review chunk length");
  return Uint8Array.from(decoded, c => c.charCodeAt(0));
}

/** Cached reviews older than this are shown at once and revalidated in the background. */
const CACHE_FRESH_MS = 60_000;
const CACHE_MAX = 5;
const STALE_RETRY_MS = 750;
const AUTHORITY_CHECK_MS = 1000;
// Shared constants so an unchanged state never allocates a new object.
const NO_LINK: ReviewState = { kind: "no_link" };
const OLD_BRIDGE: ReviewState = { kind: "old_bridge" };
const OFFLINE: ReviewState = { kind: "offline" };
const LOADING: ReviewState = { kind: "loading" };
const ERROR: ReviewState = { kind: "error" };

type Runtime = NonNullable<MessageClient["securityRuntime"]>;
type Ready = Extract<ReviewState, { kind: "ready" }>;
type Failure = PrReviewUnavailableReason | "error";
type Outcome = { failure: Failure } | { denied: true } | { metadata: PrReviewMetadata; diff: string };
/** `authority` binds the entry to the fingerprint it was verified under; a hit requires the same one. */
interface Entry { state: Ready; storedAt: number; authority: string; bridgeId: string }
interface Target { session: Session; url: string; generation: string; client: MessageClient; runtime: Runtime }
interface Fetch { epoch: number; key: string; authority: string; client: MessageClient; runtime: Runtime; url: string; base: { bridgeId: string; sessionId: string; linkGeneration: string }; prev: Ready | null; retried: boolean }
interface Options {
  session: Session | null; client: MessageClient | null; userId: string; visible: boolean; readable: boolean;
  /** Bumps on every runtime change of any bridge: triggers an authority re-check only (never a reset, not part of the cache key). */
  securityGeneration: number;
  sendCommand: BridgeRpc["sendCommand"]; subscribeAuthority?: (listener: () => void) => () => void;
}
interface Store {
  // Latest props, synced every render (callbacks are latest-ref: their identity never resets anything).
  session: Session | null; url: string | undefined; generation: string | undefined; visible: boolean; send: BridgeRpc["sendCommand"]; redraw: () => void;
  // Security boundary: any change bumps `epoch`, which hides shown data and voids in-flight replies.
  parts: ReadonlyArray<string | undefined>; identity: string; client: MessageClient | null; runtime: Runtime | undefined; readable: boolean;
  epoch: number; shown: number; state: ReviewState; fingerprint: string | null; started: boolean; live: Fetch | null; retry: ReturnType<typeof setTimeout> | null; mounted: boolean;
  /** Set while `offline` is shown because of a trip; `blocked` is the fingerprint a bridge denial happened under. */
  tripped: { blocked: string | null } | null;
}

const ids = new WeakMap<object, number>();
let nextId = 0;
function objectId(value: object | null | undefined): number | undefined {
  if (!value) return undefined;
  let id = ids.get(value);
  if (id === undefined) { id = ++nextId; ids.set(value, id); }
  return id;
}
const cache = new Map<string, Entry>();
/** Drops every cached review (tests, sign-out). */
export function resetPullRequestReviewCache(): void { cache.clear(); }
function remember(key: string, state: Ready, authority: string, bridgeId: string) {
  cache.delete(key); cache.set(key, { state, storedAt: Date.now(), authority, bridgeId });
  for (const old of cache.keys()) { if (cache.size <= CACHE_MAX) break; cache.delete(old); }
}
/** A bridge denial only invalidates that bridge's reviews; other sessions' entries stay. */
function evictBridge(bridgeId: string) { for (const [key, entry] of cache) if (entry.bridgeId === bridgeId) cache.delete(key); }

/**
 * Mirrors `isAuthorityDenial` in `@/hooks/useSessionPreview` (not exported), plus `wrong_context`, minus
 * `approval_required`: the bridge never sends that code, while useBridgeRpc synthesizes it for any local publish
 * failure (queue deadline, Centrifugo error), so it stays a soft `error`. Real local denials already fail `valid()`.
 */
function isAuthorityDenial(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("code" in value) || typeof value.code !== "string") return false;
  return ["permission_denied", "endpoint_revoked", "key_changed", "wrong_context"].includes(value.code) || value.code.startsWith("account_");
}
const soft = (reason: Failure): reason is ReviewRefreshFailure => reason === "timeout" || reason === "rate_limited" || reason === "unavailable" || reason === "error";
const authorityOf = (client: MessageClient, bridgeId: string) => { try { return sessionAuthority(client, bridgeId); } catch { return null; } };
const keyOf = (store: Store, t: Target) => JSON.stringify([objectId(t.client), objectId(t.runtime) ?? 0, ...store.parts]);
const inFlight = (store: Store) => !!store.live && store.live.epoch === store.epoch;
function stopRetry(store: Store) { if (store.retry) { clearTimeout(store.retry); store.retry = null; } }
function settle(store: Store, state: ReviewState) {
  store.shown = store.epoch;
  if (store.state !== state) { store.state = state; store.redraw(); }
}

function sync(store: Store, o: Options, url: string | undefined, parts: ReadonlyArray<string | undefined>, identity: string) {
  store.session = o.session; store.url = url; store.generation = o.session?.pullRequestReviewGeneration; store.visible = o.visible; store.send = o.sendCommand;
  const runtime = o.client?.securityRuntime;
  if (store.identity !== identity || store.client !== o.client || store.runtime !== runtime || store.readable !== o.readable) {
    store.epoch++; store.parts = parts; store.identity = identity; store.client = o.client; store.runtime = runtime; store.readable = o.readable;
    store.started = false; store.fingerprint = null; store.tripped = null;
  }
}
/** Linked, readable and the bridge is ready: the only situation in which data may be shown or fetched. */
function target(store: Store): Target | null {
  const { session, url, generation, client, runtime } = store;
  if (!session || !url || !generation || !hex.test(generation) || !client || !runtime || !store.readable || runtime.state(session.bridgeId).status !== "ready") return null;
  return { session, url, generation, client, runtime };
}
/** First look at a new epoch: a verified cache hit under the current authority, else `loading`. */
function adopt(store: Store, t: Target) {
  if (store.shown === store.epoch) return;
  store.shown = store.epoch; store.state = LOADING;
  const now = authorityOf(t.client, t.session.bridgeId);
  if (!now || (store.fingerprint && store.fingerprint !== now)) return;
  const key = keyOf(store, t); const entry = cache.get(key);
  if (!entry || entry.authority !== now) return;
  cache.delete(key); cache.set(key, entry);
  store.fingerprint = now; store.state = entry.state;
  if (Date.now() - entry.storedAt <= CACHE_FRESH_MS) store.started = true;
}
/** Render-phase view: pure reads only (no authority checks, H14); a new epoch shows `loading` until `reveal`. */
function present(store: Store): ReviewState {
  if (!store.url) return NO_LINK;
  if (!store.generation || !hex.test(store.generation)) return OLD_BRIDGE;
  if (!target(store)) return OFFLINE;
  return store.shown === store.epoch ? store.state : LOADING;
}
/** Layout-phase adoption: a cache hit replaces the committed `loading` before paint. */
function reveal(store: Store) {
  if (!store.mounted || store.shown === store.epoch) return;
  const t = target(store);
  if (!t) return;
  adopt(store, t);
  if (store.state !== LOADING) store.redraw();
}

/**
 * Authority lost or changed, or the bridge denied the read: void everything for this epoch and show `offline`
 * until a boundary change, a refresh or `recover` moves on. `clear` (whole cache) is true for every authority-loss
 * trip; false only while the bridge is merely offline/connecting (a reconnect: entries stay bound to their
 * fingerprint) and for a bridge denial (the caller evicts that bridge's entries). `blocked` marks a bridge denial.
 */
function trip(store: Store, now: string | null, clear: boolean, blocked: string | null = null) {
  if (clear) cache.clear();
  store.fingerprint = now; store.tripped = { blocked };
  if (store.shown === store.epoch && store.state === OFFLINE && !inFlight(store)) return;
  store.epoch++; store.shown = store.epoch; store.state = OFFLINE; store.started = true; store.live = null; stopRetry(store);
  store.redraw();
}
/**
 * `event` is true for change notifications (runtime, account, securityGeneration) and false for the 1 s poll.
 * After a bridge denial only an event or a new fingerprint recovers, so a denying bridge is not polled every second.
 */
function check(store: Store, event: boolean) {
  if (!store.mounted) return;
  const { session, client, runtime } = store;
  const status = session && client && runtime ? runtime.state(session.bridgeId).status : null;
  const now = status === "ready" && session && client ? authorityOf(client, session.bridgeId) : null;
  if (now && (!store.fingerprint || store.fingerprint === now)) {
    store.fingerprint = now;
    if (store.tripped && (event || store.tripped.blocked !== now)) recover(store);
    return;
  }
  trip(store, now, status !== "offline" && status !== "connecting");
}
/** H12: valid authority is back while a tripped `offline` is shown: open a new epoch and load again. */
function recover(store: Store) {
  if (!store.tripped || store.shown !== store.epoch || store.state !== OFFLINE || inFlight(store) || !target(store)) return;
  store.epoch++; store.started = false; store.tripped = null;
  drive(store);
}
function valid(store: Store, f: Fetch) {
  return store.mounted && store.live === f && store.epoch === f.epoch && store.readable && f.runtime.state(f.base.bridgeId).status === "ready" && authorityOf(f.client, f.base.bridgeId) === f.authority;
}
/** A reply arrived for the live fetch but its authority no longer holds: never apply it, go offline. */
function discard(store: Store, f: Fetch) {
  if (!store.mounted || store.live !== f || store.epoch !== f.epoch) return;
  check(store, false);
  if (store.live === f && store.epoch === f.epoch) trip(store, store.fingerprint, true, store.fingerprint);
}

function start(store: Store) {
  if (!store.mounted || inFlight(store)) return;
  const t = target(store);
  if (!t) return;
  adopt(store, t);
  const now = authorityOf(t.client, t.session.bridgeId);
  if (!now || (store.fingerprint && store.fingerprint !== now)) { trip(store, now, true); return; }
  stopRetry(store);
  const current = store.state; const prev = current.kind === "ready" ? current : null;
  const fetch: Fetch = { epoch: store.epoch, key: keyOf(store, t), authority: now, client: t.client, runtime: t.runtime, url: t.url, base: { bridgeId: t.session.bridgeId, sessionId: t.session.id, linkGeneration: t.generation }, prev, retried: false };
  store.fingerprint = now; store.started = true; store.tripped = null; store.live = fetch;
  settle(store, prev ? { ...prev, refreshing: true, refreshFailed: null } : LOADING);
  void attempt(store, fetch);
}
function drive(store: Store) {
  if (store.live && store.live.epoch !== store.epoch) { store.live = null; stopRetry(store); }
  const t = target(store);
  if (!t) return;
  const before = store.state;
  adopt(store, t);
  if (!store.started && store.visible) start(store);
  else if (store.state !== before) store.redraw();
}

async function load(store: Store, f: Fetch): Promise<Outcome | null> {
  const response = await store.send({ type: "get_pull_request_review", payload: f.base, requestId: uuid() });
  if (!valid(store, f)) return null;
  if (!response.success) return isAuthorityDenial(response.data) ? { denied: true } : { failure: "error" };
  if (!obj(response.data)) return { failure: "error" };
  const reason = unavailable(response.data);
  if (reason) return { failure: reason };
  const data = response.data;
  if (!keys(data, ["state", "linkGeneration", "metadata", "revision", "totalBytes"]) || data.state !== "ready" || data.linkGeneration !== f.base.linkGeneration || typeof data.revision !== "string" || !hex.test(data.revision) || !count(data.totalBytes) || data.totalBytes > PR_REVIEW_MAX_DIFF_BYTES) return { failure: "error" };
  const metadata = parseReviewMetadata(data.metadata, f.url);
  const revision = data.revision; const total = data.totalBytes; const buffer = new Uint8Array(total);
  let offset = 0;
  do {
    const chunk = await store.send({ type: "get_pull_request_review_chunk", payload: { ...f.base, revision, offset }, requestId: uuid() });
    if (!valid(store, f)) return null;
    if (!chunk.success) return isAuthorityDenial(chunk.data) ? { denied: true } : { failure: "error" };
    if (!obj(chunk.data)) return { failure: "error" };
    const reason = unavailable(chunk.data);
    if (reason) return { failure: reason };
    if (chunk.data.state === "stale_revision" && keys(chunk.data, ["state"])) return { failure: "stale" };
    const part = parseReviewChunk(chunk.data, revision, total, offset); buffer.set(part, offset); offset += part.length;
  } while (offset < total);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))).map(n => n.toString(16).padStart(2, "0")).join("");
  if (digest !== revision) return { failure: "error" };
  return { metadata, diff: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
}
async function attempt(store: Store, f: Fetch) {
  let outcome: Outcome | null;
  try { outcome = await load(store, f); } catch (error) { outcome = isAuthorityDenial(error) ? { denied: true } : { failure: "error" }; }
  if (outcome) finish(store, f, outcome); else discard(store, f);
}
function finish(store: Store, f: Fetch, outcome: Outcome) {
  if (!valid(store, f)) { discard(store, f); return; }
  // H11: the bridge refused the read. Hard: drop data (never a soft refreshFailed), evict this bridge's entries, go offline.
  if ("denied" in outcome) { store.live = null; evictBridge(f.base.bridgeId); trip(store, f.authority, false, f.authority); return; }
  if ("failure" in outcome) {
    const reason = outcome.failure;
    if (reason === "stale" && !f.retried) {
      f.retried = true;
      store.retry = setTimeout(() => { store.retry = null; if (valid(store, f)) void attempt(store, f); else discard(store, f); }, STALE_RETRY_MS);
      return;
    }
    store.live = null;
    if (f.prev && soft(reason)) { settle(store, { ...f.prev, refreshing: false, refreshFailed: reason }); return; }
    if (!soft(reason)) cache.delete(f.key);
    settle(store, reason === "error" ? ERROR : { kind: "unavailable", reason });
    return;
  }
  const ready: Ready = { kind: "ready", metadata: outcome.metadata, diff: outcome.diff, refreshing: false, refreshFailed: null };
  remember(f.key, ready, f.authority, f.base.bridgeId); store.live = null;
  settle(store, ready);
}

function createStore(o: Options, parts: ReadonlyArray<string | undefined>, identity: string, redraw: () => void): Store {
  return { session: o.session, url: undefined, generation: undefined, visible: o.visible, send: o.sendCommand, redraw, parts, identity, client: o.client, runtime: o.client?.securityRuntime, readable: o.readable,
    epoch: 0, shown: -1, state: LOADING, fingerprint: null, started: false, live: null, retry: null, mounted: false, tripped: null };
}

export function usePullRequestReview(options: Options): { state: ReviewState; refresh: () => void } {
  const { session, client, userId, visible, readable, securityGeneration, subscribeAuthority } = options;
  const url = parsePullRequestUrl(session?.pullRequestUrl)?.url;
  const parts = [userId, session?.bridgeId, session?.id, session?.pullRequestUrl, session?.pullRequestReviewGeneration];
  const identity = JSON.stringify(parts);
  const runtime = client?.securityRuntime;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [store] = useState(() => createStore(options, parts, identity, redraw));
  sync(store, options, url, parts, identity);
  useLayoutEffect(() => {
    store.mounted = true;
    return () => { store.mounted = false; store.epoch++; store.started = false; store.live = null; store.tripped = null; stopRetry(store); };
  }, [store]);
  // Every commit: adopt a new epoch (authority read + cache hit) before paint, never during render (H14).
  useLayoutEffect(() => { reveal(store); });
  useEffect(() => {
    const offRuntime = runtime?.onChange(() => check(store, true)); const timer = setInterval(() => check(store, false), AUTHORITY_CHECK_MS);
    return () => { offRuntime?.(); clearInterval(timer); };
  }, [store, runtime]);
  // A new subscriber identity only re-subscribes; the immediate check resets solely if the fingerprint changed.
  useEffect(() => {
    if (!subscribeAuthority) return;
    const offAccount = subscribeAuthority(() => check(store, true)); check(store, true);
    return offAccount;
  }, [store, subscribeAuthority]);
  // securityGeneration: re-check authority now; an unchanged fingerprint changes nothing (H3′).
  useEffect(() => { check(store, true); }, [store, securityGeneration]);
  useEffect(() => { drive(store); }, [store, identity, client, runtime, readable, visible]);
  const refresh = useCallback(() => { if (store.visible || store.started) start(store); }, [store]);
  return { state: present(store), refresh };
}
