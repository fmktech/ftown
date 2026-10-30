"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { PREVIEW_POLL_MS, type PreviewUnavailableReason, type SessionPreviewDescriptor } from '../../../bridge/src/preview-protocol';
import type { MessageClient } from '@/lib/message-client';
import type { BridgeRpc } from '@/hooks/useBridgeRpc';
import { parseChunk, parseStatus, verifyPreview } from '@/lib/session-preview';

type PreviewState =
  | { kind: 'loading' | 'offline' | 'unregistered' | 'error' }
  | { kind: 'unavailable'; reason: PreviewUnavailableReason }
  | { kind: 'ready'; html: string; revision: string; key: string; updating: boolean };
interface Target { bridgeId: string; sessionId: string; preview: SessionPreviewDescriptor }
interface Options { client: MessageClient | null; userId: string; target: Target | null; visible: boolean; readable: boolean; securityGeneration: number; sendCommand: BridgeRpc['sendCommand'] }

export function useSessionPreview({ client, userId, target, visible, readable, securityGeneration, sendCommand }: Options) {
  const identity = target ? JSON.stringify([target.bridgeId, target.sessionId, target.preview.id]) : '';
  const [stored, setStored] = useState<{ epoch: number; state: PreviewState }>({ epoch: -1, state: { kind: 'loading' } });
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const refreshRef = useRef<() => void>(() => {});
  const boundary = useRef({ identity, client, userId, visible, readable, documentVisible, securityGeneration, epoch: 0 });
  const current = boundary.current;
  if (current.identity !== identity || current.client !== client || current.userId !== userId || current.visible !== visible || current.readable !== readable || current.documentVisible !== documentVisible || current.securityGeneration !== securityGeneration) {
    boundary.current = { identity, client, userId, visible, readable, documentVisible, securityGeneration, epoch: current.epoch + 1 };
  }
  const epoch = boundary.current.epoch;
  useEffect(() => {
    const change = () => setDocumentVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    if (!target || !visible || !client || !readable || !documentVisible) return;
    let active = true;
    const isActive = () => active && boundary.current.epoch === epoch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let pendingManual = false;
    let nonce = 0;
    let complete: { html: string; revision: string; totalBytes: number; key: string } | null = null;
    const set = (state: PreviewState) => { if (isActive()) setStored({ epoch, state }); };
    const schedule = () => { if (isActive()) timer = setTimeout(() => void poll(), PREVIEW_POLL_MS); };
    const command = async (type: 'session_preview_status' | 'session_preview_chunk', payload: Record<string, unknown>) => {
      const response = await sendCommand({ type, payload, requestId: uuidv4() });
      if (!response.success) throw new Error('Preview request failed');
      return response.data;
    };
    const poll = async () => {
      if (!isActive() || busy) return;
      busy = true;
      const manual = pendingManual; pendingManual = false;
      try {
        if (complete) set({ kind: 'ready', ...complete, updating: true });
        else set({ kind: 'loading' });
        const base = { bridgeId: target.bridgeId, sessionId: target.sessionId, previewId: target.preview.id };
        const raw = await command('session_preview_status', { ...base, ...(complete ? { knownRevision: complete.revision } : {}) });
        if (!isActive()) return;
        const status = parseStatus(raw, target.preview.id);
        if (status.state === 'unregistered') { complete = null; set({ kind: 'unregistered' }); }
        else if (status.state === 'unavailable') { complete = null; set({ kind: 'unavailable', reason: status.reason }); }
        else if (status.state === 'unchanged') {
          if (!complete || complete.revision !== status.revision || complete.totalBytes !== status.totalBytes) throw new Error('Invalid unchanged response');
          if (manual) complete = { ...complete, key: `${identity}:${status.revision}:${++nonce}` };
          set({ kind: 'ready', ...complete, updating: false });
        } else {
          const bytes = new Uint8Array(status.totalBytes);
          let offset = 0;
          let abandoned = false;
          do {
            const rawChunk = await command('session_preview_chunk', { ...base, revision: status.revision, offset });
            if (!isActive()) return;
            const chunk = parseChunk(rawChunk, target.preview.id, status.revision, status.totalBytes, offset);
            if (chunk.state === 'stale_revision') { abandoned = true; break; }
            if (chunk.state === 'unavailable') { complete = null; set({ kind: 'unavailable', reason: chunk.reason }); abandoned = true; break; }
            bytes.set(chunk.bytes, offset); offset += chunk.bytes.length;
            if (chunk.done) break;
          } while (offset < status.totalBytes);
          if (!abandoned) {
            const html = await verifyPreview(bytes, status.revision);
            if (!isActive()) return;
            complete = { html, revision: status.revision, totalBytes: status.totalBytes, key: `${identity}:${status.revision}:${++nonce}` };
            set({ kind: 'ready', ...complete, updating: false });
          } else if (complete) set({ kind: 'ready', ...complete, updating: false });
        }
      } catch { complete = null; set({ kind: 'error' }); }
      finally {
        busy = false;
        if (isActive()) {
          if (pendingManual) void poll(); else schedule();
        }
      }
    };
    refreshRef.current = () => { pendingManual = true; if (timer) clearTimeout(timer); if (!busy) void poll(); };
    void poll();
    return () => { active = false; clearTimeout(timer); refreshRef.current = () => {}; };
  }, [client, userId, identity, target?.bridgeId, target?.sessionId, target?.preview.id, visible, readable, documentVisible, securityGeneration, sendCommand, epoch]);
  const refresh = useCallback(() => refreshRef.current(), []);
  const state: PreviewState = !target ? { kind: 'unregistered' } : !client || !readable ? { kind: 'offline' } : stored.epoch === epoch ? stored.state : { kind: 'loading' };
  return { state, refresh };
}
export type SessionPreviewView = ReturnType<typeof useSessionPreview>;
