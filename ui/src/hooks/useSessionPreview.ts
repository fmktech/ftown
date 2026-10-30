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
  | { kind: 'ready'; html: string; revision: string; key: string; updating: boolean };
interface Target { bridgeId: string; sessionId: string; preview: SessionPreviewDescriptor }
interface Options { client: MessageClient | null; userId: string; target: Target | null; visible: boolean; readable: boolean; securityGeneration: number; sendCommand: BridgeRpc['sendCommand']; subscribeAuthority?: SessionPreviewAuthoritySubscriber }
type Complete = { html: string; revision: string; totalBytes: number; key: string };
interface Store {
  identity: string; client: MessageClient | null; runtime: MessageClient['securityRuntime']; userId: string; readable: boolean; subscriber?: SessionPreviewAuthoritySubscriber;
  visible: boolean; documentVisible: boolean; securityGeneration: number; epoch: number; nonce: number; manualRequested: number; manualApplied: number;
  complete: Complete | null; status: PreviewState; fingerprint: string | null;
}

function isTransient(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'code' in value
    && (value.code === 'bridge_offline' || value.code === 'epoch_changed');
}
function isAuthorityDenial(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('code' in value) || typeof value.code !== 'string') return false;
  return ['permission_denied', 'endpoint_revoked', 'key_changed', 'approval_required'].includes(value.code) || value.code.startsWith('account_');
}

/** Fingerprint all selected endpoint fields, browser identity and sorted permissions. */
function authority(client: MessageClient, bridgeId: string): string | null {
  const runtime = client.securityRuntime;
  if (!runtime) return null;
  const pin = runtime.bridge(bridgeId); const state = runtime.state(bridgeId);
  if (!pin || !['ready', 'offline', 'connecting'].includes(state.status) || !pin.permissions.includes('read')) return null;
  runtime.assertCanSend(bridgeId);
  const endpoint = (value: typeof pin.endpoint) => [value.version, value.id, value.ownerId, value.kind, value.publicKey];
  return JSON.stringify([endpoint(runtime.identity.endpoint), endpoint(pin.endpoint), [...pin.permissions].sort()]);
}

export function useSessionPreview({ client, userId, target, visible, readable, securityGeneration, sendCommand, subscribeAuthority }: Options) {
  const identity = target ? JSON.stringify([target.bridgeId, target.sessionId, target.preview.id]) : '';
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const [, redraw] = useState(0);
  const refreshRef = useRef<() => void>(() => {});
  const authorityCheckRef = useRef<() => void>(() => {});
  const storeRef = useRef<Store>({ identity, client, runtime: client?.securityRuntime, userId, readable, subscriber: subscribeAuthority, visible, documentVisible, securityGeneration,
    epoch: 0, nonce: 0, manualRequested: 0, manualApplied: 0, complete: null, status: { kind: 'loading' }, fingerprint: null });
  const store = storeRef.current;
  const clear = () => { store.epoch++; store.manualApplied = store.manualRequested; store.complete = null; store.fingerprint = null; store.status = { kind: 'loading' }; };
  if (store.identity !== identity || store.client !== client || store.runtime !== client?.securityRuntime || store.userId !== userId || store.subscriber !== subscribeAuthority) {
    clear(); store.identity = identity; store.client = client; store.runtime = client?.securityRuntime; store.userId = userId; store.subscriber = subscribeAuthority;
  }
  if (store.readable !== readable) {
    store.readable = readable;
    if (!client?.securityRuntime) clear();
    else { store.epoch++; if (store.complete) store.status = { kind: 'ready', ...store.complete, updating: false }; }
  }
  if (store.visible !== visible || store.documentVisible !== documentVisible) {
    store.epoch++; store.visible = visible; store.documentVisible = documentVisible;
    if (store.complete) store.status = { kind: 'ready', ...store.complete, updating: false };
  }
  if (store.securityGeneration !== securityGeneration) {
    store.securityGeneration = securityGeneration;
    // Unobservable clients cannot prove that authority survived the notification.
    if (!client?.securityRuntime) clear();
    else {
      store.epoch++;
      if (store.complete) store.status = { kind: 'ready', ...store.complete, updating: false };
    }
  }
  const epoch = store.epoch;
  useEffect(() => {
    const change = () => {
      const next = document.visibilityState === 'visible';
      if (store.documentVisible !== next) { store.epoch++; store.documentVisible = next; }
      if (next) authorityCheckRef.current();
      setDocumentVisible(next);
    };
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, [store]);
  useEffect(() => {
    if (!target || !client) return;
    const runtime = client.securityRuntime;
    if (!runtime && !subscribeAuthority) return;
    let active = true; let checking = false; let recheck = false;
    const check = (notification: boolean) => {
      if (!active || store.identity !== identity || store.client !== client || store.runtime !== runtime || store.userId !== userId || store.subscriber !== subscribeAuthority) return;
      if (checking) { recheck = true; return; }
      checking = true;
      let invalidated = false;
      try {
        recheck = false;
        let fingerprint: string | null = null;
        try { fingerprint = authority(client, target.bridgeId); } catch { fingerprint = null; }
        // A nested authority update means the snapshot was not stable. Fail closed.
        if (recheck) fingerprint = null;
        const changed = !fingerprint || (store.fingerprint !== null && store.fingerprint !== fingerprint);
        if (changed) {
          invalidated = true;
          store.epoch++; store.manualApplied = store.manualRequested; store.complete = null; store.status = { kind: 'offline' }; store.fingerprint = fingerprint;
        } else {
          store.fingerprint = fingerprint;
          if (notification) {
            store.epoch++;
            if (store.complete) store.status = { kind: 'ready', ...store.complete, updating: false };
          }
        }
      } finally { checking = false; }
      if (active && (notification || invalidated)) redraw(value => value + 1);
    };
    const onChange = () => check(true);
    const offRuntime = runtime?.onChange(onChange);
    const offAccount = subscribeAuthority?.(onChange);
    authorityCheckRef.current = () => check(false);
    check(false);
    const timer = setInterval(() => check(false), PREVIEW_POLL_MS);
    return () => { active = false; clearInterval(timer); authorityCheckRef.current = () => {}; offRuntime?.(); offAccount?.(); };
  }, [client, client?.securityRuntime, userId, identity, target?.bridgeId, subscribeAuthority, store]);
  useEffect(() => {
    if (!target || !visible || !client || !readable || !documentVisible || (client.securityRuntime && (!store.fingerprint || client.securityRuntime.state(target.bridgeId).status !== 'ready'))) return;
    let active = true; let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isActive = () => active && store.epoch === epoch;
    const mayCommit = () => {
      if (!isActive()) return false;
      if (!client.securityRuntime) return true;
      let authorized = false;
      try { authorized = !!store.fingerprint && authority(client, target.bridgeId) === store.fingerprint; } catch { authorized = false; }
      if (!isActive()) return false;
      if (!authorized) {
        store.epoch++; store.manualApplied = store.manualRequested; store.complete = null; store.fingerprint = null; store.status = { kind: 'offline' };
        redraw(value => value + 1); return false;
      }
      return true;
    };
    const render = () => { if (isActive()) redraw(value => value + 1); };
    const schedule = () => { if (isActive()) timer = setTimeout(() => void poll(), PREVIEW_POLL_MS); };
    const command = async (type: 'session_preview_status' | 'session_preview_chunk', payload: Record<string, unknown>) => {
      const response = await sendCommand({ type, payload, requestId: uuidv4() });
      if (!response.success) {
        if (typeof response.data === 'object' && response.data !== null && 'code' in response.data) throw response.data;
        throw new Error('Preview request failed');
      }
      return response.data;
    };
    const poll = async () => {
      if (!isActive() || busy) return;
      busy = true;
      const manualVersion = store.manualRequested;
      const manual = manualVersion > store.manualApplied;
      try {
        let complete = store.complete;
        if (complete && manual) { store.status = { kind: 'ready', ...complete, updating: true }; render(); }
        else if (!complete) { store.status = { kind: 'loading' }; render(); }
        const base = { bridgeId: target.bridgeId, sessionId: target.sessionId, previewId: target.preview.id };
        const raw = await command('session_preview_status', { ...base, ...(complete ? { knownRevision: complete.revision } : {}) });
        if (!mayCommit()) return;
        const status = parseStatus(raw, target.preview.id);
        if (status.state === 'unregistered' || status.state === 'unavailable') {
          store.complete = null;
          if (status.state === 'unregistered') store.manualApplied = store.manualRequested;
          store.status = status.state === 'unregistered' ? { kind: 'unregistered' } : { kind: 'unavailable', reason: status.reason };
        } else if (status.state === 'unchanged') {
          if (!complete || complete.revision !== status.revision || complete.totalBytes !== status.totalBytes) throw new Error('Invalid unchanged response');
          if (manual) { complete = { ...complete, key: `${identity}:${status.revision}:${++store.nonce}` }; store.manualApplied = manualVersion; }
          store.complete = complete; store.status = { kind: 'ready', ...complete, updating: false };
        } else {
          if (complete) { store.status = { kind: 'ready', ...complete, updating: true }; render(); }
          const bytes = new Uint8Array(status.totalBytes);
          let offset = 0; let abandoned = false;
          do {
            const rawChunk = await command('session_preview_chunk', { ...base, revision: status.revision, offset });
            if (!mayCommit()) return;
            const chunk = parseChunk(rawChunk, target.preview.id, status.revision, status.totalBytes, offset);
            if (chunk.state === 'stale_revision') { abandoned = true; break; }
            if (chunk.state === 'unavailable') { store.complete = null; store.status = { kind: 'unavailable', reason: chunk.reason }; abandoned = true; break; }
            bytes.set(chunk.bytes, offset); offset += chunk.bytes.length;
            if (chunk.done) break;
          } while (offset < status.totalBytes);
          if (!abandoned) {
            const html = await verifyPreview(bytes, status.revision);
            if (!mayCommit()) return;
            complete = { html, revision: status.revision, totalBytes: status.totalBytes, key: `${identity}:${status.revision}:${++store.nonce}` };
            if (manual) store.manualApplied = manualVersion;
            store.complete = complete; store.status = { kind: 'ready', ...complete, updating: false };
          } else if (store.complete) store.status = { kind: 'ready', ...store.complete, updating: false };
        }
        render();
      } catch (error) {
        if (isActive()) {
          let retain = false;
          if (isTransient(error) && store.complete && client.securityRuntime && store.fingerprint) {
            try { retain = authority(client, target.bridgeId) === store.fingerprint; } catch { retain = false; }
          }
          if (!isActive()) return;
          if (retain && store.complete) store.status = { kind: 'ready', ...store.complete, updating: false };
          else {
            if (isAuthorityDenial(error)) store.manualApplied = store.manualRequested;
            store.complete = null; store.status = { kind: 'error' };
          }
          render();
        }
      } finally {
        busy = false;
        if (isActive()) { if (store.manualRequested > manualVersion) void poll(); else schedule(); }
      }
    };
    refreshRef.current = () => { store.manualRequested++; if (timer) clearTimeout(timer); if (!busy) void poll(); };
    void poll();
    return () => { active = false; clearTimeout(timer); refreshRef.current = () => {}; };
  }, [client, userId, identity, target?.bridgeId, target?.sessionId, target?.preview.id, visible, readable, documentVisible, sendCommand, epoch, store]);
  const refresh = useCallback(() => refreshRef.current(), []);
  const state: PreviewState = !target ? { kind: 'unregistered' } : !client || (!readable && !store.complete) ? { kind: 'offline' } : store.status;
  return { state, refresh };
}
export type SessionPreviewView = ReturnType<typeof useSessionPreview>;
