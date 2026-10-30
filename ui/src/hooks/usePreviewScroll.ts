"use client";
import { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { PREVIEW_SCROLL_CHANNEL, PREVIEW_SCROLL_MAX, PREVIEW_SCROLL_SNAPSHOT_MS, type PreviewScrollPosition } from '@/lib/preview-scroll-protocol';

interface Candidate { html: string; key: string }
interface Display extends Candidate { documentId: string; owner: string; hardEpoch: number }
interface Pending { requestId: string; candidate: Candidate; owner: string; hardEpoch: number; timer: ReturnType<typeof setTimeout> }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function position(value: Record<string, unknown>): PreviewScrollPosition | null {
  if (typeof value.x !== 'number' || typeof value.y !== 'number' || !Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.y < 0 || value.x > PREVIEW_SCROLL_MAX || value.y > PREVIEW_SCROLL_MAX) return null;
  return { x: value.x, y: value.y };
}
export function usePreviewScroll(candidate: Candidate | null, owner: string, getHardEpoch: () => number) {
  const iframeRef = useRef<HTMLIFrameElement>(null); const [display, setDisplay] = useState<Display | null>(null);
  const displayRef = useRef<Display | null>(null); const latest = useRef(candidate); latest.current = candidate;
  const coords = useRef<PreviewScrollPosition>({ x: 0, y: 0 }); const restored = useRef(false); const pending = useRef<Pending | null>(null);
  const hardEpoch = getHardEpoch();
  const discardPending = () => { if (pending.current) clearTimeout(pending.current.timer); pending.current = null; };
  const commit = (next: Candidate, nextOwner: string, generation: number) => {
    if (getHardEpoch() !== generation || latest.current?.key !== next.key) return;
    discardPending(); restored.current = false;
    const result: Display = { ...next, documentId: uuidv4(), owner: nextOwner, hardEpoch: generation };
    displayRef.current = result; setDisplay(result);
  };
  useEffect(() => {
    const current = displayRef.current;
    if (!candidate || !owner) { discardPending(); displayRef.current = null; coords.current = { x: 0, y: 0 }; restored.current = false; setDisplay(null); return; }
    if (!current || current.owner !== owner || current.hardEpoch !== hardEpoch) {
      discardPending(); coords.current = { x: 0, y: 0 }; commit(candidate, owner, hardEpoch); return;
    }
    if (current.key === candidate.key) return;
    discardPending(); const requestId = uuidv4();
    const timer = setTimeout(() => commit(candidate, owner, hardEpoch), PREVIEW_SCROLL_SNAPSHOT_MS);
    pending.current = { requestId, candidate, owner, hardEpoch, timer };
    iframeRef.current?.contentWindow?.postMessage({ channel: PREVIEW_SCROLL_CHANNEL, documentId: current.documentId, kind: 'snapshot-request', requestId }, '*');
    return discardPending;
  }, [candidate?.key, owner, hardEpoch, getHardEpoch]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const current = displayRef.current;
      if (!current || current.hardEpoch !== getHardEpoch() || event.source !== iframeRef.current?.contentWindow || event.origin !== 'null' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
      const data = event.data as Record<string, unknown>;
      if (data.channel !== PREVIEW_SCROLL_CHANNEL || data.documentId !== current.documentId || typeof data.kind !== 'string') return;
      if (data.kind === 'ready' && !restored.current && exact(data, ['channel', 'documentId', 'kind'])) {
        iframeRef.current?.contentWindow?.postMessage({ channel: PREVIEW_SCROLL_CHANNEL, documentId: current.documentId, kind: 'restore', ...coords.current }, '*');
      } else if ((data.kind === 'restored' || data.kind === 'position') && exact(data, ['channel', 'documentId', 'kind', 'x', 'y'])) {
        const value = position(data); if (!value || (data.kind === 'position' && !restored.current)) return;
        if (data.kind === 'restored') restored.current = true;
        coords.current = value;
      } else if (data.kind === 'snapshot' && exact(data, ['channel', 'documentId', 'kind', 'requestId', 'x', 'y'])) {
        const value = position(data); const item = pending.current;
        if (!value || !restored.current || !item || data.requestId !== item.requestId || item.hardEpoch !== getHardEpoch()) return;
        coords.current = value; commit(item.candidate, item.owner, item.hardEpoch);
      }
    };
    window.addEventListener('message', receive); return () => { window.removeEventListener('message', receive); discardPending(); };
  }, [getHardEpoch]);
  return { iframeRef, display: candidate && display?.owner === owner && display.hardEpoch === hardEpoch ? display : null };
}
