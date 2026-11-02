// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MessageClient } from "@/lib/message-client";
import type { Command, CommandResponse, Session } from "@/types";
import { parseReviewChunk, parseReviewMetadata, usePullRequestReview } from "./usePullRequestReview";

const generation = "a".repeat(64);
const url = "https://github.com/owner/repo/pull/12";
const session: Session = { id: "one", bridgeId: "bridge", name: "one", status: "running", createdAt: "", updatedAt: "v1", pullRequestUrl: url, pullRequestReviewGeneration: generation };
const metadata = { url, title: "<img src=x onerror=alert(1)>", body: "<script>bad()</script>", author: "alice", state: "open", baseRef: "main", headRef: "topic", baseOid: "a".repeat(40), headOid: "b".repeat(40), additions: 1, deletions: 0, changedFiles: 1, fetchedAt: "2026-11-01T00:00:00.000Z" };
const diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n+hello\n";
const encoded = new TextEncoder().encode(diff);
const digest = async (value: Uint8Array) => Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", value))).map(n => n.toString(16).padStart(2, "0")).join("");
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup() {
  vi.stubGlobal("crypto", webcrypto);
  const listeners = new Set<() => void>();
  let allowed = true; let status = "ready";
  const endpoint = { version: 1, id: "bridge-key", ownerId: "owner", kind: "bridge", publicKey: "key" };
  const runtime = { identity: { endpoint: { ...endpoint, kind: "browser", id: "browser" } }, bridge: () => ({ bridgeId: "bridge", endpoint, permissions: ["read"] }), state: () => ({ status }), assertCanSend: () => { if (!allowed) throw new Error("denied"); }, onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const client = { securityRuntime: runtime } as unknown as MessageClient;
  return { client, revoke: () => { allowed = false; listeners.forEach(f => f()); }, offline: () => { status = "offline"; listeners.forEach(f => f()); } };
}
it("loads the complete verified snapshot through session-scoped commands", async () => {
  const { client, offline } = setup(); const revision = await digest(encoded);
  const send = vi.fn(async (command: Command): Promise<CommandResponse> => ({ requestId: command.requestId, success: true, data: command.type === "get_pull_request_review" ? { state: "ready", linkGeneration: generation, metadata, revision, totalBytes: encoded.length } : { state: "chunk", revision, totalBytes: encoded.length, offset: 0, dataBase64: btoa(diff), done: true } }));
  const { result } = renderHook(() => usePullRequestReview({ session, client, userId: "user", visible: true, readable: true, securityGeneration: 0, sendCommand: send }));
  await waitFor(() => expect(result.current.state.kind).toBe("ready"));
  expect(result.current.state).toEqual({ kind: "ready", metadata, diff });
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
