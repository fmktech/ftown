"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { PR_REVIEW_CHUNK_BYTES, PR_REVIEW_MAX_BODY_BYTES, PR_REVIEW_MAX_DIFF_BYTES, PR_REVIEW_MAX_TITLE_BYTES, type PrReviewMetadata, type PrReviewUnavailableReason } from "../../../bridge/src/pull-request-review-protocol";
import type { BridgeRpc } from "@/hooks/useBridgeRpc";
import type { MessageClient } from "@/lib/message-client";
import { sessionAuthority } from "@/lib/session-authority";
import { parsePullRequestUrl } from "@/lib/pull-request-url";
import type { Session } from "@/types";

const hex = /^[0-9a-f]{64}$/;
const oid = /^[0-9a-f]{40}$/i;
const reasons = new Set<PrReviewUnavailableReason>(["unlinked", "unauthenticated", "rate_limited", "not_found_or_forbidden", "timeout", "too_large", "unsupported", "stale", "unavailable"]);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const bytes = (v: string) => new TextEncoder().encode(v).length;
const limited = (v: unknown, max: number): v is string => typeof v === "string" && bytes(v) <= max;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export type ReviewState = { kind: "no_link" | "old_bridge" | "offline" | "loading" | "error" } | { kind: "unavailable"; reason: PrReviewUnavailableReason } | { kind: "ready"; metadata: PrReviewMetadata; diff: string };

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

interface Options { session: Session | null; client: MessageClient | null; userId: string; visible: boolean; readable: boolean; securityGeneration: number; sendCommand: BridgeRpc["sendCommand"]; subscribeAuthority?: (listener: () => void) => () => void }
export function usePullRequestReview({ session, client, userId, visible, readable, securityGeneration, sendCommand, subscribeAuthority }: Options) {
  const url = parsePullRequestUrl(session?.pullRequestUrl)?.url;
  const generation = session?.pullRequestReviewGeneration;
  const identity = JSON.stringify([userId, session?.bridgeId, session?.id, session?.pullRequestUrl, generation, session?.updatedAt]);
  const [attempt, setAttempt] = useState(0);
  const epoch = useRef(0);
  const [snapshot, setSnapshot] = useState<{ identity: string; epoch: number; state: ReviewState }>({ identity, epoch: 0, state: { kind: "loading" } });
  const current = useRef({ identity, client, runtime: client?.securityRuntime, securityGeneration, readable });
  if (current.current.identity !== identity || current.current.client !== client || current.current.runtime !== client?.securityRuntime || current.current.securityGeneration !== securityGeneration || current.current.readable !== readable) {
    epoch.current++; current.current = { identity, client, runtime: client?.securityRuntime, securityGeneration, readable };
  }
  const refresh = useCallback(() => { epoch.current++; setSnapshot({ identity, epoch: epoch.current, state: { kind: "loading" } }); setAttempt(n => n + 1); }, [identity]);
  useEffect(() => {
    let active = true;
    const runtime = client?.securityRuntime;
    let fingerprint: string | null = null;
    const authority = () => {
      try { return client && session ? sessionAuthority(client, session.bridgeId) : null; } catch { return null; }
    };
    const check = () => {
      if (!active) return;
      const now = runtime && session && runtime.state(session.bridgeId).status === "ready" ? authority() : null;
      if (!now || (fingerprint && fingerprint !== now)) {
        epoch.current++; fingerprint = now;
        setSnapshot({ identity, epoch: epoch.current, state: { kind: "offline" } });
      } else fingerprint = now;
    };
    fingerprint = authority();
    const offRuntime = runtime?.onChange(check); const offAccount = subscribeAuthority?.(check);
    const timer = setInterval(check, 1000);
    const stop = () => { active = false; clearInterval(timer); offRuntime?.(); offAccount?.(); };
    if (!visible || !session || !url || !generation || !hex.test(generation) || !client || !runtime || !readable || !fingerprint || runtime.state(session.bridgeId).status !== "ready") return stop;
    const captured = fingerprint; const token = ++epoch.current;
    const valid = () => active && epoch.current === token && !!readable && runtime.state(session.bridgeId).status === "ready" && authority() === captured;
    const commit = (state: ReviewState) => { if (valid()) setSnapshot({ identity, epoch: token, state }); };
    const run = async () => {
      commit({ kind: "loading" });
      try {
        const base = { bridgeId: session.bridgeId, sessionId: session.id, linkGeneration: generation };
        const response = await sendCommand({ type: "get_pull_request_review", payload: base, requestId: uuid() });
        if (!valid()) return;
        if (!response.success || !obj(response.data)) throw new Error("Review unavailable");
        const reason = unavailable(response.data);
        if (reason) { commit({ kind: "unavailable", reason }); return; }
        const data = response.data;
        if (!keys(data, ["state", "linkGeneration", "metadata", "revision", "totalBytes"]) || data.state !== "ready" || data.linkGeneration !== generation || typeof data.revision !== "string" || !hex.test(data.revision) || !count(data.totalBytes) || data.totalBytes > PR_REVIEW_MAX_DIFF_BYTES) throw new Error("Invalid review response");
        const metadata = parseReviewMetadata(data.metadata, url);
        const revision = data.revision; const total = data.totalBytes; const buffer = new Uint8Array(total);
        let offset = 0;
        do {
          const chunk = await sendCommand({ type: "get_pull_request_review_chunk", payload: { ...base, revision, offset }, requestId: uuid() });
          if (!valid()) return;
          if (!chunk.success || !obj(chunk.data)) throw new Error("Review unavailable");
          const reason = unavailable(chunk.data);
          if (reason) { commit({ kind: "unavailable", reason }); return; }
          if (chunk.data.state === "stale_revision" && keys(chunk.data, ["state"])) { commit({ kind: "unavailable", reason: "stale" }); return; }
          const part = parseReviewChunk(chunk.data, revision, total, offset); buffer.set(part, offset); offset += part.length;
        } while (offset < total);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))).map(n => n.toString(16).padStart(2, "0")).join("");
        if (digest !== revision) throw new Error("Invalid review digest");
        const diff = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        commit({ kind: "ready", metadata, diff });
      } catch { commit({ kind: "error" }); }
    };
    void run();
    return () => { epoch.current++; stop(); };
  }, [identity, client, client?.securityRuntime, userId, visible, readable, securityGeneration, sendCommand, subscribeAuthority, attempt]);
  let state: ReviewState;
  if (!url) state = { kind: "no_link" };
  else if (!generation || !hex.test(generation)) state = { kind: "old_bridge" };
  else if (!readable || !client?.securityRuntime || !session || client.securityRuntime.state(session.bridgeId).status !== "ready") state = { kind: "offline" };
  else state = snapshot.identity === identity && snapshot.epoch === epoch.current ? snapshot.state : { kind: "loading" };
  return { state, refresh };
}
