"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { PREVIEW_SCROLL_CHANNEL, PREVIEW_SCROLL_MAX, PREVIEW_SCROLL_SNAPSHOT_MS, PREVIEW_LINK_CHANNEL, parsePreviewLinkMessage, type PreviewScrollPosition } from '@/lib/preview-scroll-protocol';

interface Candidate { html: string; key: string }
interface Display extends Candidate { documentId: string; owner: string; hardEpoch: number }
interface Pending { requestId: string; candidate: Candidate; owner: string; hardEpoch: number; timer: ReturnType<typeof setTimeout> }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function position(value: Record<string, unknown>): PreviewScrollPosition | null {
  if (typeof value.x !== 'number' || typeof value.y !== 'number' || !Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.y < 0 || value.x > PREVIEW_SCROLL_MAX || value.y > PREVIEW_SCROLL_MAX) return null;
  return { x: value.x, y: value.y };
}
export function usePreviewScroll(candidate: Candidate | null, owner: string, getHardEpoch: () => number, onSwitchFile?: (fileName: string) => void) {
  const iframeRef = useRef<HTMLIFrameElement>(null); const [display, setDisplay] = useState<Display | null>(null);
  // A pending external-link request from the untrusted preview. Never opened
  // directly: the user must confirm in the parent before a window is created.
  const [linkPrompt, setLinkPrompt] = useState<string | null>(null);
  // The exact target the user is looking at. While a prompt is shown the frame
  // cannot replace it, and confirm opens precisely this value — never React's
  // possibly-replayed state updater, and never a newer queued request.
  const linkPromptRef = useRef<string | null>(null);
  const clearLinkPrompt = useCallback(() => { linkPromptRef.current = null; setLinkPrompt(null); }, []);
  const confirmLink = useCallback(() => {
    const target = linkPromptRef.current;
    linkPromptRef.current = null;
    setLinkPrompt(null);
    if (target) window.open(target, '_blank', 'noopener,noreferrer');
  }, []);
  const displayRef = useRef<Display | null>(null); const latest = useRef(candidate); latest.current = candidate;
  const switchFileRef = useRef(onSwitchFile); switchFileRef.current = onSwitchFile;
  const coords = useRef<PreviewScrollPosition>({ x: 0, y: 0 }); const restored = useRef(false); const pending = useRef<Pending | null>(null);
  // Coordinates are keyed by owner (which encodes the file id): each file keeps
  // its own position while the dashboard is open. A hard-epoch loss forgets
  // only the affected owner's entry.
  const coordsByOwner = useRef(new Map<string, PreviewScrollPosition>());
  const saveCoords = (key: string) => { coordsByOwner.current.set(key, { ...coords.current }); };
  const hardEpoch = getHardEpoch();
  const discardPending = () => { if (pending.current) clearTimeout(pending.current.timer); pending.current = null; };
  const commit = (next: Candidate, nextOwner: string, generation: number) => {
    if (getHardEpoch() !== generation || latest.current?.key !== next.key) return;
    discardPending(); restored.current = false; clearLinkPrompt();
    const result: Display = { ...next, documentId: uuidv4(), owner: nextOwner, hardEpoch: generation };
    displayRef.current = result; setDisplay(result);
  };
  useEffect(() => {
    const current = displayRef.current;
    if (!candidate || !owner) {
      if (current) saveCoords(current.owner);
      discardPending(); displayRef.current = null; coords.current = coordsByOwner.current.get(owner) ?? { x: 0, y: 0 }; restored.current = false; clearLinkPrompt(); setDisplay(null); return;
    }
    if (!current || current.owner !== owner) {
      if (current) saveCoords(current.owner);
      discardPending(); coords.current = coordsByOwner.current.get(owner) ?? { x: 0, y: 0 }; commit(candidate, owner, hardEpoch); return;
    }
    if (current.hardEpoch !== hardEpoch) {
      discardPending(); coordsByOwner.current.delete(owner); coords.current = { x: 0, y: 0 }; commit(candidate, owner, hardEpoch); return;
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
      // Link intent (selection + external confirmation) is validated by
      // origin/source/parse only: it must be honored from the currently
      // mounted frame even while display lifecycle state is settling.
      // Scroll state keeps strict display/epoch/document checks below.
      if (event.origin !== 'null' || event.source !== iframeRef.current?.contentWindow || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
      const data = event.data as Record<string, unknown>;
      if (data.channel === PREVIEW_LINK_CHANNEL) {
        const message = parsePreviewLinkMessage(data);
        if (!message) return;
        // A relative link to another registered file just selects it in the
        // parent; the parent validates the name against the current set.
        if (message.kind === 'switch-file') { switchFileRef.current?.(message.fileName); return; }
        // Show a parent confirmation; do not open the URL here. A message from
        // untrusted preview code is not proof of a trusted user click.
        if (message.url.length > 2048) return;
        if (linkPromptRef.current !== null) return; // freeze the shown target
        try {
          const url = new URL(message.url);
          if (url.protocol === 'http:' || url.protocol === 'https:') { linkPromptRef.current = url.href; setLinkPrompt(url.href); }
        } catch { /* Invalid URLs are ignored. */ }
        return;
      }
      const current = displayRef.current;
      if (!current || current.hardEpoch !== getHardEpoch()) return;
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
  return { iframeRef, display: candidate && display?.owner === owner && display.hardEpoch === hardEpoch ? display : null, linkPrompt, confirmLink, dismissLink: clearLinkPrompt };
}
