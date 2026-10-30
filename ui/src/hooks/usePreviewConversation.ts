"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { PREVIEW_CHAT_AGENT_SHELLS, PREVIEW_CHAT_MAX_TURNS, PREVIEW_CHAT_PAGE_BYTES, PREVIEW_CHAT_PAGE_TURNS, PREVIEW_CHAT_POLL_MS, PREVIEW_CHAT_TEXT_BYTES, type PreviewChatTurn, type PreviewChatPage } from '../../../bridge/src/preview-chat-protocol';
import type { Session } from '@/types';
import type { MessageClient } from '@/lib/message-client';
import type { BridgeRpc } from '@/hooks/useBridgeRpc';
import type { SessionPreviewAuthoritySubscriber } from './useSessionPreview';
import { sessionAuthority } from '@/lib/session-authority';

const definiteSendRejections = new Set(['invalid', 'too_large', 'not_found', 'not_running', 'unsupported', 'conflict', 'capacity_exceeded']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bytes = (text: string) => new TextEncoder().encode(text).length;
const textValid = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && bytes(value) <= PREVIEW_CHAT_TEXT_BYTES && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(value);
function turn(value: unknown): PreviewChatTurn | null {
  if (!object(value) || typeof value.id !== 'string' || !uuid.test(value.id) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !textValid(value.text) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null;
  if (value.role === 'user' && (value.delivery === 'queued' || value.delivery === 'unconfirmed')) return { id: value.id, sequence: Number(value.sequence), text: value.text, createdAt: value.createdAt, role: 'user', delivery: value.delivery };
  if (value.role === 'agent' && value.delivery === 'recorded') return { id: value.id, sequence: Number(value.sequence), text: value.text, createdAt: value.createdAt, role: 'agent', delivery: 'recorded' };
  return null;
}
function page(value: unknown, sessionId: string, previous?: string): PreviewChatPage | null {
  if (!object(value) || value.sessionId !== sessionId || typeof value.cursor !== 'string' || !value.cursor || value.cursor.length > 250 || typeof value.hasMore !== 'boolean' || !Array.isArray(value.turns) || value.turns.length > PREVIEW_CHAT_PAGE_TURNS) return null;
  try { if (bytes(JSON.stringify(value)) > PREVIEW_CHAT_PAGE_BYTES) return null; } catch { return null; }
  const turns = value.turns.map(turn); if (turns.some(item => !item)) return null;
  const valid = turns.filter((item): item is PreviewChatTurn => item !== null);
  if (valid.some((item, index) => index > 0 && valid[index - 1].sequence >= item.sequence) || new Set(valid.map(item => item.id)).size !== valid.length || (value.hasMore && (!valid.length || value.cursor === previous))) return null;
  return { sessionId, turns: valid, cursor: value.cursor, hasMore: value.hasMore };
}
interface Pending { id: string; text: string; revision: number; mode: 'uncertain' | 'unconfirmed' }
interface Entry { draft: string; revision: number; turns: PreviewChatTurn[]; cursor?: string; readSequence: number; fingerprint: string; epoch: number; pending?: Pending; pendingByText: Map<string, Pending>; sending: boolean; error: string | null; }
interface Options { client: MessageClient | null; userId: string; session: Session | null; sessions: Session[]; enabled: boolean; readable: boolean; sendCommand: BridgeRpc['sendCommand']; subscribeAuthority?: SessionPreviewAuthoritySubscriber }
export function usePreviewConversation({ client, userId, session, sessions, enabled, readable, sendCommand, subscribeAuthority }: Options) {
  const [, redraw] = useState(0); const [documentVisible, setDocumentVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const records = useRef(new Map<string, Entry>()); const boundary = useRef({ client, runtime: client?.securityRuntime, userId, subscribeAuthority });
  const key = session ? JSON.stringify([session.bridgeId, session.id]) : '';
  if (boundary.current.client !== client || boundary.current.runtime !== client?.securityRuntime || boundary.current.userId !== userId || boundary.current.subscribeAuthority !== subscribeAuthority) {
    records.current.clear(); boundary.current = { client, runtime: client?.securityRuntime, userId, subscribeAuthority };
  }
  const validKeys = new Set(sessions.map(row => JSON.stringify([row.bridgeId, row.id])));
  for (const old of records.current.keys()) if (!validKeys.has(old)) records.current.delete(old);
  const selectedRef = useRef(key); selectedRef.current = key;
  const set = () => redraw(n => n + 1);
  useEffect(() => { const change = () => setDocumentVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change); }, []);
  useEffect(() => {
    if (!client?.securityRuntime) return;
    let active = true; let checking = false; let nested = false;
    const check = () => {
      if (!active) return;
      if (checking) { nested = true; return; }
      checking = true; let changed = false;
      try {
        nested = false;
        for (const [entryKey, entry] of records.current) {
          const [bridgeId] = JSON.parse(entryKey) as [string, string];
          let fingerprint: string | null = null;
          try { fingerprint = sessionAuthority(client, bridgeId); } catch { /* fail closed */ }
          if (!fingerprint || entry.fingerprint !== fingerprint || nested) { entry.epoch++; records.current.delete(entryKey); changed = true; }
        }
        if (nested) { for (const entry of records.current.values()) entry.epoch++; records.current.clear(); changed = true; }
      } finally { checking = false; }
      if (changed && active) set();
    };
    const offRuntime = client.securityRuntime.onChange(check); const offAccount = subscribeAuthority?.(check); check();
    const timer = setInterval(check, 1000);
    return () => { active = false; clearInterval(timer); offRuntime(); offAccount?.(); };
  }, [client, userId, subscribeAuthority]);
  const entryFor = useCallback((): Entry | null => {
    if (!client || !session || !client.securityRuntime) return null;
    let fingerprint: string | null = null; try { fingerprint = sessionAuthority(client, session.bridgeId); } catch { return null; }
    if (!fingerprint) return null;
    const current = records.current.get(key);
    if (current && current.fingerprint === fingerprint) { records.current.delete(key); records.current.set(key, current); return current; }
    if (current) current.epoch++;
    const next: Entry = { draft: '', revision: 0, turns: [], readSequence: 0, fingerprint, epoch: 0, pendingByText: new Map(), sending: false, error: null };
    records.current.delete(key); records.current.set(key, next);
    while (records.current.size > 32) records.current.delete(records.current.keys().next().value!);
    return next;
  }, [client, session?.bridgeId, session?.id, key]);
  const merge = (entry: Entry, incoming: PreviewChatTurn[]) => {
    const byId = new Map(entry.turns.map(item => [item.id, item]));
    for (const item of incoming) {
      const prior = byId.get(item.id);
      if (prior && (prior.sequence !== item.sequence || prior.role !== item.role || prior.text !== item.text)) throw new Error('Invalid conversation history');
      if ([...byId.values()].some(other => other.sequence === item.sequence && other.id !== item.id)) throw new Error('Invalid conversation history');
      byId.set(item.id, item);
    }
    if (byId.size > PREVIEW_CHAT_MAX_TURNS) throw new Error('Invalid conversation history');
    entry.turns = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
  };
  useEffect(() => {
    if (!enabled || !documentVisible || !readable || !client || !session) return;
    const entry = entryFor(); if (!entry) return;
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined; const epoch = entry.epoch;
    const valid = () => {
      if (!active || records.current.get(key) !== entry || entry.epoch !== epoch || selectedRef.current !== key) return false;
      try { return sessionAuthority(client, session.bridgeId) === entry.fingerprint; } catch { return false; }
    };
    const poll = async () => {
      try {
        let cursor = entry.cursor; let pages = 0;
        do {
          const result = await sendCommand({ type: 'preview_chat_list', requestId: uuidv4(), payload: { bridgeId: session.bridgeId, sessionId: session.id, ...(cursor ? { cursor } : {}) } });
          if (!valid()) return;
          if (!result.success) { const code = object(result.data) ? result.data.code : undefined; entry.error = (code === 'unknown_command' || result.error === 'Unknown command type: preview_chat_list') ? 'Update this bridge to use conversation.' : 'Conversation unavailable.'; break; }
          const next = page(result.data, session.id, cursor); if (!next) throw new Error('Invalid conversation history');
          if (next.turns.length && next.turns[0].sequence <= entry.readSequence) throw new Error('Invalid conversation history');
          merge(entry, next.turns); if (next.turns.length) entry.readSequence = next.turns[next.turns.length - 1].sequence; entry.cursor = next.cursor; cursor = next.cursor; if (!entry.pending) entry.error = null;
          if (!next.hasMore) break;
          if (++pages > PREVIEW_CHAT_MAX_TURNS / PREVIEW_CHAT_PAGE_TURNS + 1) throw new Error('Invalid conversation history');
        } while (valid());
      } catch { if (valid()) entry.error = 'Conversation unavailable.'; }
      if (valid()) { set(); timer = setTimeout(() => void poll(), PREVIEW_CHAT_POLL_MS); }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [enabled, documentVisible, readable, client, userId, session?.id, session?.bridgeId, key, sendCommand, entryFor]);
  const setDraft = useCallback((value: string) => { const entry = entryFor(); if (!entry) return; entry.draft = value; entry.revision++; entry.pending = entry.pendingByText.get(value); entry.error = null; set(); }, [entryFor]);
  const send = useCallback(async () => {
    const entry = entryFor(); if (!entry || !client || !session || !readable || session.status !== 'running' || !session.shellType || !PREVIEW_CHAT_AGENT_SHELLS.some(shell => shell === session.shellType) || !client.securityRuntime?.bridge(session.bridgeId)?.permissions.includes('control') || entry.sending || !textValid(entry.draft)) return;
    const pending = entry.pending?.mode === 'uncertain' && entry.pending.text === entry.draft ? entry.pending : { id: uuidv4(), text: entry.draft, revision: entry.revision, mode: 'uncertain' as const };
    entry.pending = pending; entry.pendingByText.set(pending.text, pending); entry.sending = true; entry.error = null; const epoch = entry.epoch; set();
    const valid = () => {
      if (records.current.get(key) !== entry || entry.epoch !== epoch) return false;
      try { return sessionAuthority(client, session.bridgeId) === entry.fingerprint; } catch { return false; }
    };
    try {
      const result = await sendCommand({ type: 'preview_chat_send', requestId: uuidv4(), payload: { bridgeId: session.bridgeId, sessionId: session.id, id: pending.id, text: pending.text } });
      if (!valid()) return;
      if (!result.success) {
        const code = object(result.data) ? result.data.code : undefined;
        const olderBridge = result.error === 'Unknown command type: preview_chat_send';
        const definite = olderBridge || (typeof code === 'string' && definiteSendRejections.has(code));
        if (definite) {
          entry.error = olderBridge ? 'Update this bridge to use conversation.' : 'Message could not be sent.';
          if (entry.pendingByText.get(pending.text) === pending) entry.pendingByText.delete(pending.text);
          if (entry.pending === pending) entry.pending = undefined;
        } else {
          entry.pendingByText.set(pending.text, pending);
          if (entry.draft === pending.text) entry.pending = pending;
          entry.error = 'Delivery uncertain. Retry to check this message.';
        }
      }
      else {
        const body = result.data; const item = object(body) && body.sessionId === session.id ? turn(body.turn) : null;
        if (!item || item.role !== 'user' || item.id !== pending.id || item.text !== pending.text) throw new Error('Invalid response');
        merge(entry, [item]);
        if (item.delivery === 'queued') { if (entry.revision === pending.revision && entry.draft === pending.text) { entry.draft = ''; entry.revision++; } if (entry.pendingByText.get(pending.text) === pending) entry.pendingByText.delete(pending.text); if (entry.pending === pending) entry.pending = undefined; }
        else { const uncertain: Pending = { ...pending, mode: 'unconfirmed' }; entry.pendingByText.set(pending.text, uncertain); if (entry.draft === pending.text) entry.pending = uncertain; entry.error = 'Delivery unconfirmed. This message may already have reached the agent.'; }
      }
    } catch { if (valid()) { entry.pendingByText.set(pending.text, pending); if (entry.draft === pending.text) entry.pending = pending; entry.error = 'Delivery uncertain. Retry to check this message.'; } }
    finally { if (valid()) { entry.sending = false; set(); } }
  }, [client, session, readable, sendCommand, entryFor, key]);
  const entry = records.current.get(key);
  const canSend = !!client && !!session && readable && session.status === 'running' && !!session.shellType && PREVIEW_CHAT_AGENT_SHELLS.some(shell => shell === session.shellType) && !!client.securityRuntime?.bridge(session.bridgeId)?.permissions.includes('control');
  return { draft: entry?.draft ?? '', turns: entry?.turns ?? [], error: entry?.error ?? null, sending: entry?.sending ?? false, pendingMode: entry?.pending && entry.pending.text === entry.draft ? entry.pending.mode : null, draftValid: textValid(entry?.draft ?? ''), canSend, setDraft, send };
}
export type PreviewConversationView = ReturnType<typeof usePreviewConversation>;
