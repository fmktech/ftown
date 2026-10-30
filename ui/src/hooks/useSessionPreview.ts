"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { PREVIEW_POLL_MS, type PreviewUnavailableReason, type SessionPreviewDescriptor } from '../../../bridge/src/preview-protocol';
import type { MessageClient } from '@/lib/message-client';
import type { BridgeRpc } from '@/hooks/useBridgeRpc';
import { parseChunk, parseStatus, verifyPreview } from '@/lib/session-preview';

export type SessionPreviewAuthoritySubscriber = (listener: () => void) => () => void;
type PreviewState =
  | { kind: 'loading' | 'offline' | 'unregistered' | 'error' }
  | { kind: 'unavailable'; reason: PreviewUnavailableReason }
  | { kind: 'ready'; html: string; revision: string; key: string; updating: boolean; verifying: boolean };
interface Target { bridgeId: string; sessionId: string; preview: SessionPreviewDescriptor }
interface Options { client: MessageClient | null; userId: string; target: Target | null; visible: boolean; readable: boolean; securityGeneration: number; sendCommand: BridgeRpc['sendCommand']; subscribeAuthority?: SessionPreviewAuthoritySubscriber }
type Complete = { html: string; revision: string; totalBytes: number; key: string };
interface Store {
  identity: string; client: MessageClient | null; runtime: MessageClient['securityRuntime']; userId: string; readable: boolean; subscriber?: SessionPreviewAuthoritySubscriber;
  visible: boolean; documentVisible: boolean; securityGeneration: number; epoch: number; nonce: number;
  complete: Complete | null; status: PreviewState; verifying: boolean; fingerprint: string | null;
}

/** Fingerprint all selected endpoint fields, browser identity and sorted permissions. */
function authority(client: MessageClient, bridgeId: string): string | null {
  const runtime = client.securityRuntime;
  if (!runtime) return null;
  const pin = runtime.bridge(bridgeId); const state = runtime.state(bridgeId);
  if (!pin || state.status !== 'ready' || !pin.permissions.includes('read')) return null;
  runtime.assertCanSend(bridgeId);
  const endpoint = (value: typeof pin.endpoint) => [value.version, value.id, value.ownerId, value.kind, value.publicKey];
  return JSON.stringify([endpoint(runtime.identity.endpoint), endpoint(pin.endpoint), [...pin.permissions].sort()]);
}

export function useSessionPreview({ client, userId, target, visible, readable, securityGeneration, sendCommand, subscribeAuthority }: Options) {
  const identity = target ? JSON.stringify([target.bridgeId, target.sessionId, target.preview.id]) : '';
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const [, redraw] = useState(0);
  const refreshRef = useRef<() => void>(() => {});
  const storeRef = useRef<Store>({ identity, client, runtime: client?.securityRuntime, userId, readable, subscriber: subscribeAuthority, visible, documentVisible, securityGeneration,
    epoch: 0, nonce: 0, complete: null, status: { kind: 'loading' }, verifying: false, fingerprint: null });
  const store = storeRef.current;
  const clear = () => { store.epoch++; store.complete = null; store.verifying = false; store.fingerprint = null; store.status = { kind: 'loading' }; };
  if (store.identity !== identity || store.client !== client || store.runtime !== client?.securityRuntime || store.userId !== userId || store.readable !== readable || store.subscriber !== subscribeAuthority) {
    clear(); store.identity = identity; store.client = client; store.runtime = client?.securityRuntime; store.userId = userId; store.readable = readable; store.subscriber = subscribeAuthority;
  }
  if (store.visible !== visible || store.documentVisible !== documentVisible) {
    store.epoch++; store.visible = visible; store.documentVisible = documentVisible;
    if (store.complete) store.status = { kind: 'ready', ...store.complete, updating: false, verifying: store.verifying };
  }
  if (store.securityGeneration !== securityGeneration) {
    store.securityGeneration = securityGeneration;
    // Unobservable clients cannot prove that authority survived the notification.
    if (!client?.securityRuntime) clear();
    else {
      store.epoch++;
      if (store.complete) { store.verifying = true; store.status = { kind: 'ready', ...store.complete, updating: false, verifying: true }; }
    }
  }
  const epoch = store.epoch;
  useEffect(() => {
    const change = () => {
      const next = document.visibilityState === 'visible';
      if (store.documentVisible !== next) { store.epoch++; store.documentVisible = next; }
      setDocumentVisible(next);
    };
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, [store]);
  useEffect(() => {
    if (!target || !client || !readable) return;
    const runtime = client.securityRuntime;
    if (!runtime && !subscribeAuthority) return;
    let active = true; let checking = false; let recheck = false;
    const check = (notification: boolean) => {
      if (!active) return;
      if (checking) { recheck = true; return; }
      checking = true;
      try {
        recheck = false;
        let fingerprint: string | null = null;
        try { fingerprint = authority(client, target.bridgeId); } catch { fingerprint = null; }
        // A nested authority update means the snapshot was not stable. Fail closed.
        if (recheck) fingerprint = null;
        const changed = !fingerprint || (store.fingerprint !== null && store.fingerprint !== fingerprint);
        if (changed) {
          store.epoch++; store.complete = null; store.verifying = false; store.status = { kind: 'offline' }; store.fingerprint = fingerprint;
        } else {
          store.fingerprint = fingerprint;
          if (notification) {
            store.epoch++;
            if (store.complete) { store.verifying = true; store.status = { kind: 'ready', ...store.complete, updating: false, verifying: true }; }
          }
        }
      } finally { checking = false; }
      if (active && (notification || store.fingerprint === null)) redraw(value => value + 1);
    };
    const onChange = () => check(true);
    const offRuntime = runtime?.onChange(onChange);
    const offAccount = subscribeAuthority?.(onChange);
    check(false);
    return () => { active = false; offRuntime?.(); offAccount?.(); };
  }, [client, client?.securityRuntime, userId, identity, target?.bridgeId, readable, subscribeAuthority, store]);
  useEffect(() => {
    if (!target || !visible || !client || !readable || !documentVisible || (client.securityRuntime && !store.fingerprint)) return;
    let active = true; let busy = false; let pendingManual = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isActive = () => active && store.epoch === epoch;
    const render = () => { if (isActive()) redraw(value => value + 1); };
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
        let complete = store.complete;
        if (complete && manual) { store.status = { kind: 'ready', ...complete, updating: true, verifying: store.verifying }; render(); }
        else if (!complete) { store.status = { kind: 'loading' }; render(); }
        const base = { bridgeId: target.bridgeId, sessionId: target.sessionId, previewId: target.preview.id };
        const raw = await command('session_preview_status', { ...base, ...(complete ? { knownRevision: complete.revision } : {}) });
        if (!isActive()) return;
        const status = parseStatus(raw, target.preview.id);
        if (status.state === 'unregistered' || status.state === 'unavailable') {
          store.complete = null; store.verifying = false;
          store.status = status.state === 'unregistered' ? { kind: 'unregistered' } : { kind: 'unavailable', reason: status.reason };
        } else if (status.state === 'unchanged') {
          if (!complete || complete.revision !== status.revision || complete.totalBytes !== status.totalBytes) throw new Error('Invalid unchanged response');
          if (manual) complete = { ...complete, key: `${identity}:${status.revision}:${++store.nonce}` };
          store.complete = complete; store.verifying = false; store.status = { kind: 'ready', ...complete, updating: false, verifying: false };
        } else {
          if (complete) { store.status = { kind: 'ready', ...complete, updating: true, verifying: store.verifying }; render(); }
          const bytes = new Uint8Array(status.totalBytes);
          let offset = 0; let abandoned = false;
          do {
            const rawChunk = await command('session_preview_chunk', { ...base, revision: status.revision, offset });
            if (!isActive()) return;
            const chunk = parseChunk(rawChunk, target.preview.id, status.revision, status.totalBytes, offset);
            if (chunk.state === 'stale_revision') { abandoned = true; break; }
            if (chunk.state === 'unavailable') { store.complete = null; store.verifying = false; store.status = { kind: 'unavailable', reason: chunk.reason }; abandoned = true; break; }
            bytes.set(chunk.bytes, offset); offset += chunk.bytes.length;
            if (chunk.done) break;
          } while (offset < status.totalBytes);
          if (!abandoned) {
            const html = await verifyPreview(bytes, status.revision);
            if (!isActive()) return;
            complete = { html, revision: status.revision, totalBytes: status.totalBytes, key: `${identity}:${status.revision}:${++store.nonce}` };
            store.complete = complete; store.verifying = false; store.status = { kind: 'ready', ...complete, updating: false, verifying: false };
          } else if (store.complete) store.status = { kind: 'ready', ...store.complete, updating: false, verifying: store.verifying };
        }
        render();
      } catch {
        if (isActive()) { store.complete = null; store.verifying = false; store.status = { kind: 'error' }; render(); }
      } finally {
        busy = false;
        if (isActive()) { if (pendingManual) void poll(); else schedule(); }
      }
    };
    refreshRef.current = () => { pendingManual = true; if (timer) clearTimeout(timer); if (!busy) void poll(); };
    void poll();
    return () => { active = false; clearTimeout(timer); refreshRef.current = () => {}; };
  }, [client, userId, identity, target?.bridgeId, target?.sessionId, target?.preview.id, visible, readable, documentVisible, sendCommand, epoch, store]);
  const refresh = useCallback(() => refreshRef.current(), []);
  const state: PreviewState = !target ? { kind: 'unregistered' } : !client || !readable ? { kind: 'offline' } : store.status;
  return { state, refresh };
}
export type SessionPreviewView = ReturnType<typeof useSessionPreview>;
