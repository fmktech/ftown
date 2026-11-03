// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageClient } from "@/lib/message-client";
import type { Command, CommandResponse, Session } from "@/types";
import { parseReviewChunk, parseReviewMetadata, resetPullRequestReviewCache, usePullRequestReview } from "./usePullRequestReview";

const generation = "a".repeat(64);
const url = "https://github.com/owner/repo/pull/12";
const session: Session = { id: "one", bridgeId: "bridge", name: "one", status: "running", createdAt: "", updatedAt: "v1", pullRequestUrl: url, pullRequestReviewGeneration: generation };
const metadata = { url, title: "<img src=x onerror=alert(1)>", body: "<script>bad()</script>", author: "alice", state: "open", baseRef: "main", headRef: "topic", baseOid: "a".repeat(40), headOid: "b".repeat(40), additions: 1, deletions: 0, changedFiles: 1, fetchedAt: "2026-11-01T00:00:00.000Z" };
const diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n+hello\n";
const encoded = new TextEncoder().encode(diff);
const digest = async (value: Uint8Array) => Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", value))).map(n => n.toString(16).padStart(2, "0")).join("");
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => { resetPullRequestReviewCache(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup() {
  vi.stubGlobal("crypto", webcrypto);
  const listeners = new Set<() => void>();
  let allowed = true; let status = "ready";
  let endpoint = { version: 1, id: "bridge-key", ownerId: "owner", kind: "bridge", publicKey: "key" };
  const runtime = { identity: { endpoint: { ...endpoint, kind: "browser", id: "browser" } }, bridge: () => ({ bridgeId: "bridge", endpoint, permissions: ["read"] }), state: () => ({ status }), assertCanSend: () => { if (!allowed) throw new Error("denied"); }, onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const client = { securityRuntime: runtime } as unknown as MessageClient;
  return { client, revoke: () => { allowed = false; listeners.forEach(f => f()); }, offline: () => { status = "offline"; listeners.forEach(f => f()); }, rotate: () => { endpoint = { ...endpoint, publicKey: "rotated" }; listeners.forEach(f => f()); }, setStatus: (next: string) => { status = next; listeners.forEach(f => f()); }, notify: () => listeners.forEach(f => f()) };
}
it("loads the complete verified snapshot through session-scoped commands", async () => {
  const { client, offline } = setup(); const revision = await digest(encoded);
  const send = vi.fn(async (command: Command): Promise<CommandResponse> => ({ requestId: command.requestId, success: true, data: command.type === "get_pull_request_review" ? { state: "ready", linkGeneration: generation, metadata, revision, totalBytes: encoded.length } : { state: "chunk", revision, totalBytes: encoded.length, offset: 0, dataBase64: btoa(diff), done: true } }));
  const { result } = renderHook(() => usePullRequestReview({ session, client, userId: "user", visible: true, readable: true, securityGeneration: 0, sendCommand: send }));
  await waitFor(() => expect(result.current.state.kind).toBe("ready"));
  expect(result.current.state).toEqual({ kind: "ready", metadata, diff, refreshing: false, refreshFailed: null });
  expect(send.mock.calls.map(call => call[0].payload)).toEqual([{ bridgeId: "bridge", sessionId: "one", linkGeneration: generation }, { bridgeId: "bridge", sessionId: "one", linkGeneration: generation, revision, offset: 0 }]);
  act(() => offline()); expect(result.current.state.kind).toBe("offline");
});
it("rejects corrupted chunks and never displays a partial diff", async () => {
  const { client } = setup(); const revision = "c".repeat(64);
  const send = vi.fn(async (command: Command): Promise<CommandResponse> => ({ requestId: command.requestId, success: true, data: command.type === "get_pull_request_review" ? { state: "ready", linkGeneration: generation, metadata, revision, totalBytes: encoded.length } : { state: "chunk", revision, totalBytes: encoded.length, offset: 0, dataBase64: btoa(diff), done: true } }));
  const { result } = renderHook(() => usePullRequestReview({ session, client, userId: "user", visible: true, readable: true, securityGeneration: 0, sendCommand: send }));
  await waitFor(() => expect(result.current.state.kind).toBe("error"));
  expect(() => parseReviewChunk({ state: "chunk", revision, totalBytes: 1, offset: 0, dataBase64: "YR==", done: true }, revision, 1, 0)).toThrow();
});
it("discards a late reply on revocation and clears on disconnect or link change", async () => {
  const { client, revoke } = setup(); const revision = await digest(encoded);
  let resolve!: (response: CommandResponse) => void;
  const send = vi.fn(() => new Promise<CommandResponse>(r => { resolve = r; }));
  const { result, rerender } = renderHook(({ selected, readable }) => usePullRequestReview({ session: selected, client, userId: "user", visible: true, readable, securityGeneration: 0, sendCommand: send }), { initialProps: { selected: session, readable: true } });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  act(() => revoke());
  await act(async () => resolve({ requestId: "old", success: true, data: { state: "ready", linkGeneration: generation, metadata, revision, totalBytes: encoded.length } }));
  expect(result.current.state.kind).toBe("offline"); expect(send).toHaveBeenCalledTimes(1);
  rerender({ selected: { ...session, pullRequestReviewGeneration: "b".repeat(64) }, readable: false });
  expect(result.current.state.kind).toBe("offline");
});
it("does not fetch without a link, generation or a readable connection", () => {
  const { client } = setup(); const send = vi.fn();
  const { result, rerender } = renderHook(({ selected, readable }) => usePullRequestReview({ session: selected, client, userId: "user", visible: true, readable, securityGeneration: 0, sendCommand: send }), { initialProps: { selected: { ...session, pullRequestUrl: undefined } as Session, readable: true } });
  expect(result.current.state.kind).toBe("no_link");
  rerender({ selected: { ...session, pullRequestReviewGeneration: undefined }, readable: true }); expect(result.current.state.kind).toBe("old_bridge");
  rerender({ selected: session, readable: false }); expect(result.current.state.kind).toBe("offline"); expect(send).not.toHaveBeenCalled();
});

it("accepts the empty chunk and rejects mismatched metadata and chunk boundaries", () => {
  const revision = "c".repeat(64);
  expect(parseReviewChunk({ state: "chunk", revision, totalBytes: 0, offset: 0, dataBase64: "", done: true }, revision, 0, 0)).toEqual(new Uint8Array());
  expect(() => parseReviewChunk({ state: "chunk", revision, totalBytes: 0, offset: 0, dataBase64: "", done: false }, revision, 0, 0)).toThrow();
  expect(() => parseReviewMetadata({ ...metadata, url: "https://evil.example/" }, url)).toThrow();
  expect(() => parseReviewMetadata({ ...metadata, title: "x".repeat(1025) }, url)).toThrow();
  expect(() => parseReviewMetadata({ ...metadata, state: ["open"] }, url)).toThrow();
  expect(() => parseReviewMetadata({ ...metadata, state: { toString: () => "open" } }, url)).toThrow();
});

it("does not apply an old session response after the link generation changes", async () => {
  const { client } = setup(); const revision = await digest(encoded);
  const pending: Array<(response: CommandResponse) => void> = [];
  const send = vi.fn(() => new Promise<CommandResponse>(resolve => pending.push(resolve)));
  const { result, rerender } = renderHook(({ selected }) => usePullRequestReview({ session: selected, client, userId: "user", visible: true, readable: true, securityGeneration: 0, sendCommand: send }), { initialProps: { selected: session } });
  await waitFor(() => expect(pending).toHaveLength(1));
  rerender({ selected: { ...session, pullRequestReviewGeneration: "b".repeat(64) } });
  await waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => pending[0]({ requestId: "old", success: true, data: { state: "ready", linkGeneration: generation, metadata, revision, totalBytes: encoded.length } }));
  expect(send).toHaveBeenCalledTimes(2); expect(result.current.state.kind).toBe("loading");
});

// ---------------------------------------------------------------------------
// Regression and behavior tests (invariants H0-H10)

interface Doc { metadata: typeof metadata; text: string; bytes: Uint8Array; revision: string }
let one!: Doc; let two!: Doc;
beforeAll(async () => {
  const make = async (text: string, extra: Partial<typeof metadata>): Promise<Doc> => { const bytes = new TextEncoder().encode(text); return { metadata: { ...metadata, ...extra }, text, bytes, revision: await digest(bytes) }; };
  one = await make(diff, {});
  two = await make("diff --git a/b b/b\n--- a/b\n+++ b/b\n+second\n", { title: "second", headOid: "d".repeat(40), fetchedAt: "2026-11-01T00:05:00.000Z" });
});
const readyData = (d: Doc) => ({ state: "ready", linkGeneration: generation, metadata: d.metadata, revision: d.revision, totalBytes: d.bytes.length });
const chunkData = (d: Doc) => ({ state: "chunk", revision: d.revision, totalBytes: d.bytes.length, offset: 0, dataBase64: btoa(d.text), done: true });
class Deny { constructor(readonly code: string) {} }
function server() {
  const doc = { cur: one }; const queue = { get: [] as unknown[], chunk: [] as unknown[] }; const hold: { promise: Promise<void> | null } = { promise: null };
  const send = vi.fn(async (command: Command): Promise<CommandResponse> => {
    const isGet = command.type === "get_pull_request_review";
    const data = (isGet ? queue.get.shift() : queue.chunk.shift()) ?? (isGet ? readyData(doc.cur) : chunkData(doc.cur));
    if (hold.promise) await hold.promise;
    if (data instanceof Deny) return { requestId: command.requestId, success: false, data: { code: data.code } };
    return { requestId: command.requestId, success: true, data };
  });
  const gate = () => { let release!: () => void; hold.promise = new Promise<void>(r => { release = () => { hold.promise = null; r(); }; }); return release; };
  return { doc, queue, send, gate };
}
const gets = (send: { mock: { calls: Array<[Command]> } }) => send.mock.calls.filter(call => call[0].type === "get_pull_request_review").length;
const chunks = (send: { mock: { calls: Array<[Command]> } }) => send.mock.calls.filter(call => call[0].type === "get_pull_request_review_chunk").length;
type Props = Parameters<typeof usePullRequestReview>[0];
const baseProps = (client: MessageClient, sendCommand: Props["sendCommand"]): Props => ({ session, client, userId: "user", visible: true, readable: true, securityGeneration: 0, sendCommand });
const mount = (props: Props) => renderHook((p: Props) => usePullRequestReview(p), { initialProps: props });
const tick = () => new Promise<void>(r => realSetTimeout(r, 5));
/** Lets real async work (crypto digest, promise chains) finish, advancing fake timers by 0 when they are installed. */
async function drain(times = 8) { for (let i = 0; i < times; i++) await act(async () => { if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0); await tick(); }); }
async function settle(done: () => boolean) { for (let i = 0; i < 200; i++) { if (done()) return; await drain(1); } throw new Error("settle timed out"); }
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await drain(); };
const readyOf = (d: Doc, refreshing = false, refreshFailed: string | null = null) => ({ kind: "ready", metadata: d.metadata, diff: d.text, refreshing, refreshFailed });

describe("usePullRequestReview stability and caching", () => {
  it("R1 keeps the same state object and sends nothing when only non-identity session fields change", async () => {
    const { client } = setup(); const s = server();
    const { result, rerender } = mount(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const before = result.current.state; const sent = s.send.mock.calls.length;
    rerender({ ...baseProps(client, s.send), session: { ...session, updatedAt: "v2", name: "renamed", status: "completed" } });
    await drain();
    expect(s.send.mock.calls.length).toBe(sent); expect(result.current.state).toBe(before);
  });

  it("R2 ignores a new sendCommand identity and uses it for later work without refetching", async () => {
    const { client } = setup(); const s = server();
    const { result, rerender } = mount(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const before = result.current.state; const sent = s.send.mock.calls.length;
    const next = vi.fn((c: Command) => s.send(c));
    rerender(baseProps(client, next)); await drain();
    expect(s.send.mock.calls.length).toBe(sent); expect(next).not.toHaveBeenCalled();
    expect(result.current.state).toBe(before); expect(result.current.state.kind).toBe("ready");
  });

  it("R3 does not refetch or clear when visibility toggles after ready", async () => {
    const { client } = setup(); const s = server();
    const { result, rerender } = mount(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const sent = s.send.mock.calls.length;
    rerender({ ...baseProps(client, s.send), visible: false }); await drain();
    rerender(baseProps(client, s.send)); await drain();
    expect(s.send.mock.calls.length).toBe(sent); expect(result.current.state).toMatchObject({ kind: "ready", refreshing: false });
  });

  it("R4 sends nothing while mounted hidden and fetches once shown", async () => {
    const { client } = setup(); const s = server();
    const { result, rerender } = mount({ ...baseProps(client, s.send), visible: false });
    await drain();
    expect(s.send).not.toHaveBeenCalled();
    rerender(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(gets(s.send)).toBe(1);
  });

  it("R5 lets an in-flight fetch finish while hidden and shows it when visible again", async () => {
    const { client } = setup(); const s = server(); const release = s.gate();
    const { result, rerender } = mount(baseProps(client, s.send));
    await waitFor(() => expect(gets(s.send)).toBe(1));
    rerender({ ...baseProps(client, s.send), visible: false });
    release(); await drain();
    rerender(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(gets(s.send)).toBe(1); expect(chunks(s.send)).toBe(1);
    expect(result.current.state).toEqual(readyOf(one));
  });

  it("R6 refresh keeps the old diff while refreshing, then shows the new one", async () => {
    const { client } = setup(); const s = server();
    const { result } = mount(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    s.doc.cur = two; const release = s.gate();
    act(() => result.current.refresh());
    expect(result.current.state).toEqual(readyOf(one, true));
    release();
    await waitFor(() => expect(result.current.state).toEqual(readyOf(two, false)));
    expect(gets(s.send)).toBe(2);
  });

  it("R7 soft refresh failures keep data with refreshFailed and hard failures become unavailable", async () => {
    const { client } = setup(); const s = server();
    const { result } = mount(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    s.queue.get.push({ state: "unavailable", reason: "timeout" });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state).toEqual(readyOf(one, false, "timeout")));
    s.queue.get.push({ state: "unavailable", reason: "not_found_or_forbidden" });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state).toEqual({ kind: "unavailable", reason: "not_found_or_forbidden" }));
  });

  it("R7b hard refresh failure evicts the cache entry", async () => {
    const { client } = setup(); const s = server();
    const first = mount(baseProps(client, s.send));
    await waitFor(() => expect(first.result.current.state.kind).toBe("ready"));
    s.queue.get.push({ state: "unavailable", reason: "not_found_or_forbidden" });
    act(() => first.result.current.refresh());
    await waitFor(() => expect(first.result.current.state.kind).toBe("unavailable"));
    first.unmount();
    const second = mount(baseProps(client, s.send));
    expect(second.result.current.state.kind).toBe("loading");
    await waitFor(() => expect(second.result.current.state.kind).toBe("ready"));
  });

  it("R8 refresh while a fetch is in flight is a no-op", async () => {
    const { client } = setup(); const s = server(); const release = s.gate();
    const { result } = mount(baseProps(client, s.send));
    await waitFor(() => expect(gets(s.send)).toBe(1));
    act(() => result.current.refresh()); act(() => result.current.refresh()); await drain();
    expect(gets(s.send)).toBe(1);
    release();
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(gets(s.send)).toBe(1);
  });

  it("R9 retries a stale result once after 750ms, and surfaces a second stale", async () => {
    vi.useFakeTimers();
    const { client } = setup(); const s = server();
    s.queue.get.push({ state: "unavailable", reason: "stale" });
    const { result } = mount(baseProps(client, s.send));
    await settle(() => gets(s.send) === 1);
    await advance(500);
    expect(gets(s.send)).toBe(1);
    await advance(400);
    await settle(() => result.current.state.kind === "ready");
    expect(gets(s.send)).toBe(2); expect(result.current.state).toEqual(readyOf(one));
    cleanup();
    resetPullRequestReviewCache();
    const t = setup(); const s2 = server();
    s2.queue.get.push({ state: "unavailable", reason: "stale" }, { state: "unavailable", reason: "stale" });
    const second = mount(baseProps(t.client, s2.send));
    await settle(() => gets(s2.send) === 1);
    await advance(900);
    await settle(() => second.result.current.state.kind === "unavailable");
    expect(second.result.current.state).toEqual({ kind: "unavailable", reason: "stale" });
    await advance(5000);
    expect(gets(s2.send)).toBe(2);
  });

  it("R9b retries a stale_revision chunk once", async () => {
    vi.useFakeTimers();
    const { client } = setup(); const s = server();
    s.queue.chunk.push({ state: "stale_revision" });
    const { result } = mount(baseProps(client, s.send));
    await settle(() => chunks(s.send) === 1);
    await advance(900);
    await settle(() => result.current.state.kind === "ready");
    expect(gets(s.send)).toBe(2); expect(result.current.state).toEqual(readyOf(one));
  });

  it("R10 remount with identical props starts ready from cache and revalidates only after 60s", async () => {
    vi.useFakeTimers();
    const { client } = setup(); const s = server();
    const first = mount(baseProps(client, s.send));
    await settle(() => first.result.current.state.kind === "ready");
    first.unmount();
    await advance(30_000);
    const second = mount(baseProps(client, s.send));
    expect(second.result.current.state).toEqual(readyOf(one));
    await drain();
    expect(gets(s.send)).toBe(1);
    second.unmount();
    await advance(35_000);
    const third = mount(baseProps(client, s.send));
    expect(third.result.current.state).toEqual(readyOf(one, true));
    await settle(() => third.result.current.state.kind === "ready" && !third.result.current.state.refreshing);
    expect(gets(s.send)).toBe(2);
  });

  it("R11 a different client object is a cache miss but a different securityGeneration with unchanged authority is a hit", async () => {
    const a = setup(); const s = server();
    const first = mount(baseProps(a.client, s.send));
    await waitFor(() => expect(first.result.current.state.kind).toBe("ready"));
    first.unmount();
    const generationHit = mount({ ...baseProps(a.client, s.send), securityGeneration: 1 });
    expect(generationHit.result.current.state).toEqual(readyOf(one));
    await drain();
    expect(gets(s.send)).toBe(1);
    generationHit.unmount();
    const b = setup();
    const clientMiss = mount(baseProps(b.client, s.send));
    expect(clientMiss.result.current.state.kind).toBe("loading");
    await waitFor(() => expect(clientMiss.result.current.state.kind).toBe("ready"));
    expect(gets(s.send)).toBe(2);
  });

  it("R15 a securityGeneration bump neither resets nor refetches, but a real authority change still goes offline", async () => {
    const a = setup(); const s = server();
    const { result, rerender } = mount(baseProps(a.client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const before = result.current.state; const sent = s.send.mock.calls.length;
    rerender({ ...baseProps(a.client, s.send), securityGeneration: 1 }); await drain();
    expect(s.send.mock.calls.length).toBe(sent); expect(result.current.state).toBe(before);
    rerender({ ...baseProps(a.client, s.send), securityGeneration: 2 });
    act(() => a.rotate());
    expect(result.current.state.kind).toBe("offline");

    const b = setup(); const t = server(); const release = t.gate();
    const flight = mount(baseProps(b.client, t.send));
    await waitFor(() => expect(gets(t.send)).toBe(1));
    flight.rerender({ ...baseProps(b.client, t.send), securityGeneration: 1 });
    release();
    await waitFor(() => expect(flight.result.current.state).toEqual(readyOf(one)));
    expect(gets(t.send)).toBe(1); expect(chunks(t.send)).toBe(1);
  });

  it("R12 readable false shows offline and recovers instantly from cache", async () => {
    const { client } = setup(); const s = server();
    const { result, rerender } = mount(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const sent = s.send.mock.calls.length;
    rerender({ ...baseProps(client, s.send), readable: false });
    expect(result.current.state.kind).toBe("offline");
    rerender(baseProps(client, s.send));
    expect(result.current.state).toEqual(readyOf(one));
    await drain();
    expect(s.send.mock.calls.length).toBe(sent);
  });

  it("R13 an authority fingerprint change clears the cache so a remount starts loading", async () => {
    const { client, rotate } = setup(); const s = server();
    const first = mount(baseProps(client, s.send));
    await waitFor(() => expect(first.result.current.state.kind).toBe("ready"));
    act(() => rotate());
    expect(first.result.current.state.kind).toBe("offline");
    first.unmount();
    const second = mount(baseProps(client, s.send));
    expect(second.result.current.state.kind).toBe("loading");
    await waitFor(() => expect(second.result.current.state.kind).toBe("ready"));
    expect(gets(s.send)).toBe(2);
  });

  it("R13b resetPullRequestReviewCache clears the cache", async () => {
    const { client } = setup(); const s = server();
    const first = mount(baseProps(client, s.send));
    await waitFor(() => expect(first.result.current.state.kind).toBe("ready"));
    first.unmount(); resetPullRequestReviewCache();
    const second = mount(baseProps(client, s.send));
    expect(second.result.current.state.kind).toBe("loading");
    await waitFor(() => expect(second.result.current.state.kind).toBe("ready"));
  });

  it("R14 refresh keeps a stable identity across rerenders and state changes", async () => {
    const { client } = setup(); const s = server();
    const { result, rerender } = mount(baseProps(client, s.send));
    const initial = result.current.refresh;
    rerender({ ...baseProps(client, vi.fn((c: Command) => s.send(c))), session: { ...session, updatedAt: "v9" } });
    expect(result.current.refresh).toBe(initial);
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(result.current.refresh).toBe(initial);
    act(() => result.current.refresh()); await drain();
    expect(result.current.refresh).toBe(initial);
  });

  it("H11 a bridge denial during the initial load gives offline and is never cached", async () => {
    for (const code of ["permission_denied", "account_revoked"]) {
      resetPullRequestReviewCache();
      const { client } = setup(); const s = server();
      s.queue.get.push(new Deny(code));
      const first = mount(baseProps(client, s.send));
      await waitFor(() => expect(first.result.current.state.kind).toBe("offline"));
      first.unmount();
      const second = mount(baseProps(client, s.send));
      expect(second.result.current.state.kind).not.toBe("ready");
      await waitFor(() => expect(second.result.current.state.kind).toBe("ready"));
      expect(gets(s.send)).toBe(2);
    }
  });

  it("H11 a thrown denial error also gives offline", async () => {
    const { client } = setup();
    const send = vi.fn(async (): Promise<CommandResponse> => { throw Object.assign(new Error("denied"), { code: "key_changed" }); });
    const { result } = mount(baseProps(client, send));
    await waitFor(() => expect(result.current.state.kind).toBe("offline"));
  });

  it("H11 a bridge denial during refresh drops the data, gives offline and evicts the cache", async () => {
    for (const code of ["permission_denied", "account_policy_changed", "endpoint_revoked"]) {
      resetPullRequestReviewCache();
      const { client } = setup(); const s = server();
      const first = mount(baseProps(client, s.send));
      await waitFor(() => expect(first.result.current.state.kind).toBe("ready"));
      s.queue.get.push(new Deny(code));
      act(() => first.result.current.refresh());
      await waitFor(() => expect(first.result.current.state.kind).toBe("offline"));
      expect(first.result.current.state).toEqual({ kind: "offline" });
      first.unmount();
      const second = mount(baseProps(client, s.send));
      expect(second.result.current.state.kind).not.toBe("ready");
      await waitFor(() => expect(second.result.current.state.kind).toBe("ready"));
    }
  });

  it("H12 recovers without a remount when a new valid fingerprint appears after a trip", async () => {
    const { client, rotate } = setup(); const s = server();
    s.queue.get.push(new Deny("permission_denied"));
    const { result } = mount(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("offline"));
    act(() => rotate());
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(gets(s.send)).toBe(2); expect(result.current.state).toEqual(readyOf(one));
  });

  it("H12 recovers from an authority-change trip without a remount", async () => {
    const { client, rotate } = setup(); const s = server();
    const { result } = mount(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    act(() => rotate());
    expect(result.current.state.kind).toBe("offline");
    act(() => rotate());
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(gets(s.send)).toBe(2);
  });

  it("H13 an authority change while readable is false misses the cache afterwards", async () => {
    const { client, rotate } = setup(); const s = server();
    const { result, rerender } = mount(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    rerender({ ...baseProps(client, s.send), readable: false });
    expect(result.current.state.kind).toBe("offline");
    act(() => rotate());
    rerender(baseProps(client, s.send));
    expect(result.current.state.kind).not.toBe("ready");
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(gets(s.send)).toBe(2);
  });

  it("H13 after revoke a remount refuses a cache hit", async () => {
    const { client, revoke } = setup(); const s = server();
    const first = mount(baseProps(client, s.send));
    await waitFor(() => expect(first.result.current.state.kind).toBe("ready"));
    act(() => revoke());
    first.unmount();
    const second = mount(baseProps(client, s.send));
    await drain();
    expect(second.result.current.state.kind).toBe("offline");
    expect(gets(s.send)).toBe(1);
  });

  it("a client swap while a fetch is in flight never applies or caches the late reply", async () => {
    const a = setup(); const b = setup();
    const pending: Array<(response: CommandResponse) => void> = [];
    const send = vi.fn(() => new Promise<CommandResponse>(resolve => pending.push(resolve)));
    const { result, rerender } = mount(baseProps(a.client, send));
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender(baseProps(b.client, send));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[0]({ requestId: "old", success: true, data: readyData(one) }));
    await drain();
    expect(result.current.state.kind).toBe("loading"); expect(send).toHaveBeenCalledTimes(2);
    cleanup();
    const again = mount(baseProps(a.client, send));
    expect(again.result.current.state.kind).toBe("loading");
  });

  it("a runtime swap on the same client while a fetch is in flight never applies or caches the late reply", async () => {
    const a = setup(); const b = setup();
    const pending: Array<(response: CommandResponse) => void> = [];
    const send = vi.fn(() => new Promise<CommandResponse>(resolve => pending.push(resolve)));
    const { result, rerender } = mount(baseProps(a.client, send));
    await waitFor(() => expect(pending).toHaveLength(1));
    (a.client as unknown as { securityRuntime: unknown }).securityRuntime = (b.client as unknown as { securityRuntime: unknown }).securityRuntime;
    rerender(baseProps(a.client, send));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[0]({ requestId: "old", success: true, data: readyData(one) }));
    await drain();
    expect(result.current.state.kind).toBe("loading"); expect(send).toHaveBeenCalledTimes(2);
  });

  it("a revoke during the chunk loop applies and caches nothing", async () => {
    const { client, revoke } = setup();
    let resolveChunk!: (response: CommandResponse) => void;
    const send = vi.fn((command: Command) => command.type === "get_pull_request_review"
      ? Promise.resolve<CommandResponse>({ requestId: command.requestId, success: true, data: readyData(one) })
      : new Promise<CommandResponse>(r => { resolveChunk = r; }));
    const { result } = mount(baseProps(client, send));
    await waitFor(() => expect(chunks(send)).toBe(1));
    act(() => revoke());
    await act(async () => resolveChunk({ requestId: "c", success: true, data: chunkData(one) }));
    await drain();
    expect(result.current.state.kind).toBe("offline");
    cleanup();
    const again = mount(baseProps(client, send));
    await drain();
    expect(again.result.current.state.kind).toBe("offline");
  });

  it("a revoke during the 750ms stale-retry wait applies nothing and sends no retry", async () => {
    vi.useFakeTimers();
    const { client, revoke } = setup(); const s = server();
    s.queue.get.push({ state: "unavailable", reason: "stale" });
    const { result } = mount(baseProps(client, s.send));
    await settle(() => gets(s.send) === 1);
    await advance(300);
    act(() => revoke());
    await advance(2000);
    expect(gets(s.send)).toBe(1); expect(result.current.state.kind).toBe("offline");
  });

  it("H14 a cache hit is ready after the initial render with no commands and no loading observed", async () => {
    const { client } = setup(); const s = server();
    const first = mount(baseProps(client, s.send));
    await waitFor(() => expect(first.result.current.state.kind).toBe("ready"));
    first.unmount();
    const sent = s.send.mock.calls.length;
    const seen: string[] = [];
    const second = renderHook((p: Props) => { const r = usePullRequestReview(p); seen.push(r.state.kind); return r; }, { initialProps: baseProps(client, s.send) });
    expect(second.result.current.state).toEqual(readyOf(one));
    expect(seen[seen.length - 1]).toBe("ready");
    await drain();
    expect(s.send.mock.calls.length).toBe(sent); expect(second.result.current.state).toEqual(readyOf(one));
  });

  it("approval_required during refresh is a soft error that keeps the data and the cache", async () => {
    const { client } = setup(); const s = server();
    const first = mount(baseProps(client, s.send));
    await waitFor(() => expect(first.result.current.state.kind).toBe("ready"));
    s.queue.get.push(new Deny("approval_required"));
    act(() => first.result.current.refresh());
    await waitFor(() => expect(first.result.current.state).toEqual(readyOf(one, false, "error")));
    first.unmount();
    const sent = s.send.mock.calls.length;
    const second = mount(baseProps(client, s.send));
    expect(second.result.current.state).toEqual(readyOf(one));
    await drain();
    expect(s.send.mock.calls.length).toBe(sent);
  });

  it("a denial on one bridge does not evict another bridge's cached entry", async () => {
    const { client } = setup(); const s = server();
    const sessionB: Session = { ...session, id: "two", bridgeId: "bridge2" };
    const b = mount({ ...baseProps(client, s.send), session: sessionB });
    await waitFor(() => expect(b.result.current.state.kind).toBe("ready"));
    b.unmount();
    s.queue.get.push(new Deny("permission_denied"));
    const a = mount(baseProps(client, s.send));
    await waitFor(() => expect(a.result.current.state.kind).toBe("offline"));
    a.unmount();
    const sent = s.send.mock.calls.length;
    const again = mount({ ...baseProps(client, s.send), session: sessionB });
    expect(again.result.current.state).toEqual(readyOf(one));
    await drain();
    expect(s.send.mock.calls.length).toBe(sent);
  });

  it("after a denial trip the 1s poll sends nothing, but a runtime change notification reloads", async () => {
    vi.useFakeTimers();
    const { client, notify } = setup(); const s = server();
    s.queue.get.push(new Deny("permission_denied"));
    const { result } = mount(baseProps(client, s.send));
    await settle(() => result.current.state.kind === "offline");
    const sent = s.send.mock.calls.length;
    await advance(5000);
    expect(s.send.mock.calls.length).toBe(sent); expect(result.current.state.kind).toBe("offline");
    act(() => notify());
    await settle(() => result.current.state.kind === "ready");
    expect(gets(s.send)).toBe(2);
  });

  it("a bridge offline then ready again with the same authority recovers from cache without commands", async () => {
    const { client, setStatus } = setup(); const s = server();
    const { result } = mount(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    act(() => setStatus("offline"));
    expect(result.current.state.kind).toBe("offline");
    act(() => setStatus("ready"));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    await drain();
    expect(gets(s.send)).toBe(1);
  });

  it("bridge offline, authority rotated, then ready misses the cache and loads fresh", async () => {
    const { client, setStatus, rotate } = setup(); const s = server();
    const { result } = mount(baseProps(client, s.send));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    act(() => setStatus("offline"));
    act(() => rotate());
    act(() => setStatus("ready"));
    expect(result.current.state).not.toEqual(readyOf(one));
    await waitFor(() => expect(result.current.state).toEqual(readyOf(one)));
    expect(gets(s.send)).toBe(2);
  });
});
