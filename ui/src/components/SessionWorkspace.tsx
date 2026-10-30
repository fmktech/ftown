"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { MessageClient } from '@/lib/message-client';
import type { BridgeRpc } from '@/hooks/useBridgeRpc';
import type { Session } from '@/types';
import { useSessionPreview, type SessionPreviewAuthoritySubscriber } from '@/hooks/useSessionPreview';
import { clampPreviewRatio, previewDocument, previewRatioBounds } from '@/lib/session-preview';

interface Props {
  session: Session | null; client: MessageClient | null; userId: string; readable: boolean;
  sendCommand: BridgeRpc['sendCommand']; subscribeAuthority?: SessionPreviewAuthoritySubscriber; securityGeneration: number; open: boolean; onClose: () => void;
  isDesktop: boolean; mobileTab: 'sessions' | 'terminal' | 'preview'; onMobileTab: (tab: 'terminal' | 'preview') => void;
  onRefit: () => void; children: ReactNode;
}
const messages = { missing: 'Preview file is missing', too_large: 'Preview exceeds the 1 MiB limit', invalid_utf8: 'Preview file is not valid UTF-8', invalid_file: 'Preview unavailable', unavailable: 'Preview unavailable' };
export function SessionWorkspace({ session, client, userId, readable, sendCommand, subscribeAuthority, securityGeneration, open, onClose, isDesktop, mobileTab, onMobileTab, onRefit, children }: Props) {
  const mainRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(50);
  const [compactTab, setCompactTab] = useState<'terminal' | 'preview'>('preview');
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; startX: number; startRatio: number; cursor: string; select: string } | null>(null);
  const target = session?.preview ? { bridgeId: session.bridgeId, sessionId: session.id, preview: session.preview } : null;
  const compact = !isDesktop || width < 640;
  const view = isDesktop ? compactTab : mobileTab;
  const previewVisible = !!target && open && (expanded || !compact || view === 'preview');
  const { state, refresh } = useSessionPreview({ client, userId, target, visible: previewVisible, readable, securityGeneration, sendCommand, subscribeAuthority });
  useEffect(() => {
    const node = mainRef.current; if (!node) return;
    const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => { setCompactTab('preview'); setExpanded(false); }, [session?.bridgeId, session?.id, session?.preview?.id]);
  useEffect(() => { if (!open) setExpanded(false); }, [open]);
  useEffect(() => { onRefit(); }, [open, compact, view, expanded, width, onRefit]);
  const finish = () => {
    const current = drag.current; if (!current) return;
    document.body.style.cursor = current.cursor; document.body.style.userSelect = current.select;
    drag.current = null; setDragging(false); onRefit();
  };
  useEffect(() => () => {
    if (drag.current) { document.body.style.cursor = drag.current.cursor; document.body.style.userSelect = drag.current.select; }
  }, []);
  const setSplit = (next: number) => { setRatio(clampPreviewRatio(next, width)); onRefit(); };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, startX: event.clientX, startRatio: clampPreviewRatio(ratio, width), cursor: document.body.style.cursor, select: document.body.style.userSelect };
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; setDragging(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => { const d = drag.current; if (d?.id === event.pointerId) setSplit(d.startRatio + (event.clientX - d.startX) / (width - 8) * 100); };
  const [min, max] = previewRatioBounds(width);
  const actualRatio = clampPreviewRatio(ratio, width);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === 'ArrowLeft' ? actualRatio - 2 : event.key === 'ArrowRight' ? actualRatio + 2 : event.key === 'Home' ? min : event.key === 'End' ? max : null;
    if (next !== null) { event.preventDefault(); setSplit(next); }
  };
  const choose = (tab: 'terminal' | 'preview') => { if (isDesktop) setCompactTab(tab); else onMobileTab(tab); };
  const tabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 'terminal' : event.key === 'End' ? 'preview' : view === 'terminal' ? 'preview' : 'terminal';
      choose(next); (event.currentTarget.querySelector(`[data-preview-tab="${next}"]`) as HTMLButtonElement | null)?.focus();
    }
  };
  const showPreview = !!target && open;
  const terminalVisible = !expanded && (!showPreview || !compact || view === 'terminal');
  const frameVisible = showPreview && (expanded || !compact || view === 'preview');
  return <div ref={mainRef} className="session-workspace" onKeyDown={event => {
    if (expanded && event.key === 'Escape') { event.preventDefault(); setExpanded(false); }
  }}>
    {showPreview && compact && isDesktop && !expanded && <div role="tablist" aria-label="Session view" onKeyDown={tabKeys} className="session-preview-tabs">
      {(['terminal', 'preview'] as const).map(tab => <button key={tab} id={`compact-${tab}-tab`} data-preview-tab={tab} role="tab" aria-selected={view === tab} aria-controls={`session-${tab}-panel`} tabIndex={view === tab ? 0 : -1} onClick={() => choose(tab)} className={`mobile-tab ${view === tab ? 'mobile-tab-active' : ''}`}>{tab === 'terminal' ? 'Terminal' : 'Preview'}</button>)}
    </div>}
    <div className="session-workspace-panes">
      <div id="session-terminal-panel" role={compact && showPreview ? 'tabpanel' : undefined} aria-label="Terminal" hidden={!terminalVisible} className="session-terminal-pane" style={showPreview && !compact && !expanded ? { flex: `0 0 calc((100% - 8px) * ${actualRatio / 100})` } : undefined}>{children}</div>
      {showPreview && !compact && !expanded && <div role="separator" aria-label="Resize terminal and preview" aria-orientation="vertical" aria-valuemin={Number(min.toFixed(1))} aria-valuemax={Number(max.toFixed(1))} aria-valuenow={Number(actualRatio.toFixed(1))} tabIndex={0} className="session-preview-separator" onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onKeyDown={keyDown} onDoubleClick={() => setSplit(50)} />}
      {showPreview && <section id="session-preview-panel" role={compact ? 'tabpanel' : 'region'} aria-label="Session preview" hidden={!frameVisible} className="session-preview-pane">
        <div className="session-preview-toolbar"><span className="session-preview-filename" title={target.preview.fileName}>{target.preview.fileName}</span><span className="session-preview-auto">Auto-refresh</span><button type="button" className="btn-ghost" aria-label={expanded ? "Collapse preview" : "Expand preview"} onClick={() => setExpanded(value => !value)}>{expanded ? "Collapse" : "Expand"}</button><button type="button" className="btn-ghost" aria-label="Refresh preview" onClick={refresh}>Refresh</button><button type="button" className="btn-ghost" aria-label="Close preview" onClick={onClose}>Close</button></div>
        <div className="session-preview-content">
          {state.kind === 'ready' ? <><iframe key={state.key} style={{ visibility: state.verifying ? "hidden" : "visible" }} aria-hidden={state.verifying || undefined} title={`HTML preview: ${target.preview.fileName}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={previewDocument(state.html)} />{state.verifying && <div className="session-preview-verifying" role="status">Checking preview access…</div>}{state.updating && !state.verifying && <span className="session-preview-updating">Updating preview…</span>}</> : <div className="session-preview-message" role="status"><span>{state.kind === 'loading' ? 'Loading preview…' : state.kind === 'offline' ? 'Reconnect to load preview' : state.kind === 'unregistered' ? 'No preview registered' : state.kind === 'unavailable' ? messages[state.reason] : 'Preview unavailable'}</span>{state.kind !== 'loading' && state.kind !== 'unregistered' && <button type="button" className="btn-ghost" onClick={refresh}>Retry</button>}</div>}
          {dragging && <div className="session-preview-drag-shield" />}
        </div>
      </section>}
    </div>
  </div>;
}
