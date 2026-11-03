"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { MessageClient } from '@/lib/message-client';
import type { BridgeRpc } from '@/hooks/useBridgeRpc';
import type { Session } from '@/types';
import { useSessionPreview, type SessionPreviewAuthoritySubscriber } from '@/hooks/useSessionPreview';
import { usePreviewScroll } from '@/hooks/usePreviewScroll';
import { usePreviewConversation } from '@/hooks/usePreviewConversation';
import { PreviewConversation } from './PreviewConversation';
import { PullRequestReview } from './PullRequestReview';
import type { SessionActivity } from '@/hooks/useAllSessionEvents';
import { clampPreviewRatio, previewDocument, previewRatioBounds } from '@/lib/session-preview';

interface Props {
  session: Session | null; client: MessageClient | null; userId: string; readable: boolean;
  sendCommand: BridgeRpc['sendCommand']; subscribeAuthority?: SessionPreviewAuthoritySubscriber; securityGeneration: number; open: boolean; onClose: () => void;
  isDesktop: boolean; mobileTab: 'sessions' | 'terminal' | 'preview' | 'review'; onMobileTab: (tab: 'terminal' | 'preview' | 'review') => void;
  reviewOpen?: boolean; reviewActivation?: number; onCloseReview?: () => void;
  onRefit: () => void; children: ReactNode; sessions?: Session[]; activity?: SessionActivity;
}
const messages = { missing: 'Preview file is missing', too_large: 'Preview exceeds the 1 MiB limit', invalid_utf8: 'Preview file is not valid UTF-8', invalid_file: 'Preview unavailable', unavailable: 'Preview unavailable' };
export function SessionWorkspace({ session, client, userId, readable, sendCommand, subscribeAuthority, securityGeneration, open, onClose, isDesktop, mobileTab, onMobileTab, onRefit, children, sessions = [], activity, reviewOpen = false, reviewActivation = 0, onCloseReview = () => {} }: Props) {
  const mainRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(50);
  const [compactTab, setCompactTab] = useState<'terminal' | 'preview' | 'review'>('preview');
  const [auxTab, setAuxTab] = useState<'preview' | 'review'>('preview');
  const [conversationOpen, setConversationOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; startX: number; startRatio: number; cursor: string; select: string } | null>(null);
  const target = session?.preview ? { bridgeId: session.bridgeId, sessionId: session.id, preview: session.preview } : null;
  const compact = !isDesktop || width < 640;
  const showPreview = !!target && open;
  const rawView = compact ? (isDesktop ? compactTab : mobileTab) : auxTab;
  const view = rawView === 'preview' && !showPreview ? (reviewOpen ? 'review' : 'terminal') : rawView === 'review' && !reviewOpen ? (showPreview ? 'preview' : 'terminal') : rawView;
  // The parent may remove Preview and select Review in one render. Compare the
  // previous committed view so expansion cannot transfer to a fallback panel.
  const previousView = useRef({ showPreview, view });
  const previewDisappeared = previousView.current.showPreview && !showPreview && previousView.current.view === 'preview';
  const activeExpanded = expanded && rawView === view && view !== 'terminal' && !previewDisappeared;
  const previewVisible = !!target && open && view === 'preview';
  const { state, refresh, getHardEpoch } = useSessionPreview({ client, userId, target, visible: previewVisible, readable, securityGeneration, sendCommand, subscribeAuthority });
  const owner = target ? JSON.stringify([userId, target.bridgeId, target.sessionId, target.preview.id]) : '';
  const scroll = usePreviewScroll(state.kind === 'ready' ? state : null, owner, getHardEpoch);
  const conversation = usePreviewConversation({ client, userId, session, sessions: sessions.length ? sessions : session ? [session] : [], enabled: activeExpanded && conversationOpen && open, readable, sendCommand, subscribeAuthority });
  useEffect(() => {
    const node = mainRef.current; if (!node) return;
    const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => { setCompactTab('preview'); setAuxTab('preview'); setExpanded(false); setConversationOpen(false); }, [session?.bridgeId, session?.id]);
  const previewId = session?.preview?.id;
  const previousPreviewId = useRef(previewId);
  useEffect(() => {
    const previous = previousPreviewId.current;
    previousPreviewId.current = previewId;
    if (previous === previewId) return;
    if (rawView === 'preview') setExpanded(false);
    if (previewId && !reviewOpen) { setCompactTab('preview'); setAuxTab('preview'); setConversationOpen(false); }
  }, [previewId, rawView, reviewOpen]);
  useEffect(() => { if (reviewOpen && reviewActivation) { setCompactTab('review'); setAuxTab('review'); } }, [reviewOpen, reviewActivation]);
  useEffect(() => {
    setCompactTab(current => current === 'preview' && !showPreview ? (reviewOpen ? 'review' : 'terminal') : current === 'review' && !reviewOpen ? (showPreview ? 'preview' : 'terminal') : current);
    setAuxTab(current => current === 'preview' && !showPreview && reviewOpen ? 'review' : current === 'review' && !reviewOpen ? 'preview' : current);
    if (!isDesktop && mobileTab === 'preview' && !showPreview) onMobileTab(reviewOpen ? 'review' : 'terminal');
    else if (!isDesktop && mobileTab === 'review' && !reviewOpen) onMobileTab(showPreview ? 'preview' : 'terminal');
  }, [showPreview, reviewOpen, isDesktop, mobileTab, onMobileTab]);
  useEffect(() => {
    if (expanded && (previewDisappeared || rawView !== view || view === 'terminal')) setExpanded(false);
    previousView.current = { showPreview, view };
  }, [expanded, previewDisappeared, rawView, view, showPreview]);
  useEffect(() => { if (!open && !reviewOpen) { setExpanded(false); setConversationOpen(false); } }, [open, reviewOpen]);
  useEffect(() => { onRefit(); }, [open, reviewOpen, compact, view, activeExpanded, width, onRefit]);
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
  const hasAux = showPreview || reviewOpen;
  const tabs: ('terminal' | 'preview' | 'review')[] = [...(compact ? ['terminal' as const] : []), ...(showPreview ? ['preview' as const] : []), ...(reviewOpen ? ['review' as const] : [])];
  const choose = (tab: 'terminal' | 'preview' | 'review') => { if (tab !== 'terminal') { setAuxTab(tab); setCompactTab(tab); } else setCompactTab(tab); if (compact && !isDesktop) onMobileTab(tab); };
  const tabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const index = Math.max(0, tabs.indexOf(view as 'terminal' | 'preview' | 'review'));
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      choose(next); (event.currentTarget.querySelector(`[data-preview-tab="${next}"]`) as HTMLButtonElement | null)?.focus();
    }
  };
  const terminalVisible = !activeExpanded && (!hasAux || !compact || view === 'terminal');
  const frameVisible = showPreview && view === 'preview';
  const reviewVisible = reviewOpen && view === 'review';
  return <div ref={mainRef} className="session-workspace" onKeyDown={event => {
    if (activeExpanded && event.key === 'Escape') { event.preventDefault(); setExpanded(false); }
  }}>
    {hasAux && compact && isDesktop && !activeExpanded && <div role="tablist" aria-label="Session view" onKeyDown={tabKeys} className="session-preview-tabs">
      {tabs.map(tab => <button key={tab} id={`compact-${tab}-tab`} data-preview-tab={tab} role="tab" aria-selected={view === tab} aria-controls={`session-${tab}-panel`} tabIndex={view === tab ? 0 : -1} onClick={() => choose(tab)} className={`mobile-tab ${view === tab ? 'mobile-tab-active' : ''}`}>{tab === 'terminal' ? 'Terminal' : tab === 'preview' ? 'Preview' : 'PR review'}</button>)}
    </div>}
    <div className="session-workspace-panes">
      <div id="session-terminal-panel" role={compact && hasAux ? 'tabpanel' : undefined} aria-label="Terminal" hidden={!terminalVisible} className="session-terminal-pane" style={hasAux && !compact && !activeExpanded ? { flex: `0 0 calc((100% - 8px) * ${actualRatio / 100})` } : undefined}>{children}</div>
      {hasAux && !compact && !activeExpanded && <div role="separator" aria-label="Resize terminal and preview" aria-orientation="vertical" aria-valuemin={Number(min.toFixed(1))} aria-valuemax={Number(max.toFixed(1))} aria-valuenow={Number(actualRatio.toFixed(1))} tabIndex={0} className="session-preview-separator" onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onKeyDown={keyDown} onDoubleClick={() => setSplit(50)} />}
      {hasAux && <div className="session-aux-pane" hidden={compact && view === 'terminal'}>
      {!compact && showPreview && reviewOpen && <div role="tablist" aria-label="Auxiliary view" onKeyDown={tabKeys} className="session-preview-tabs">{tabs.map(tab => <button key={tab} data-preview-tab={tab} role="tab" aria-selected={view === tab} aria-controls={`session-${tab}-panel`} tabIndex={view === tab ? 0 : -1} onClick={() => choose(tab)} className={`mobile-tab ${view === tab ? 'mobile-tab-active' : ''}`}>{tab === 'preview' ? 'Preview' : 'PR review'}</button>)}</div>}
      {showPreview && <section id="session-preview-panel" role={compact || reviewOpen ? 'tabpanel' : 'region'} aria-label="Session preview" hidden={!frameVisible} className="session-preview-pane">
        <div className="session-preview-toolbar">
          <span className="session-preview-filename" title={target.preview.fileName}>{target.preview.fileName}</span>
          <span className="session-preview-auto" role="img" aria-label="Auto-refresh enabled" title="Auto-refresh enabled" />
          <button type="button" className="btn-ghost session-preview-icon" aria-label={activeExpanded ? "Collapse preview" : "Expand preview"} title={activeExpanded ? "Collapse preview" : "Expand preview"} onClick={() => setExpanded(value => !value)}>
            <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {activeExpanded ? <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5M9 9 4 4m11 5 5-5M9 15l-5 5m11-5 5 5" /> : <path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5M4 4l5 5m11-5-5 5M4 20l5-5m11 5-5-5" />}
            </svg>
          </button>
          <button type="button" className="btn-ghost session-preview-icon" aria-label="Refresh preview" title="Refresh preview" onClick={refresh}>
            <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5" /><path d="M20 12a8 8 0 1 0-2.3 5.7" /></svg>
          </button>
          <button type="button" className="btn-ghost session-preview-icon" aria-label="Close preview" title="Close preview" onClick={onClose}>
            <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 5l14 14M19 5 5 19" /></svg>
          </button>
        </div>
        <div className="session-preview-content">
          {state.kind === 'ready' && scroll.display ? <><iframe ref={scroll.iframeRef} key={scroll.display.key} title={`HTML preview: ${target.preview.fileName}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={previewDocument(scroll.display.html, scroll.display.documentId)} />{state.updating && <span className="session-preview-updating">Updating preview…</span>}</> : <div className="session-preview-message" role="status"><span>{state.kind === 'loading' || state.kind === 'ready' ? 'Loading preview…' : state.kind === 'offline' ? 'Reconnect to load preview' : state.kind === 'unregistered' ? 'No preview registered' : state.kind === 'unavailable' ? messages[state.reason] : 'Preview unavailable'}</span>{state.kind !== 'loading' && state.kind !== 'ready' && state.kind !== 'unregistered' && <button type="button" className="btn-ghost" onClick={refresh}>Retry</button>}</div>}
          {scroll.linkPrompt && <div className="session-preview-link-prompt" role="dialog" aria-label="Open external link"><span className="session-preview-link-host">{(() => { try { return new URL(scroll.linkPrompt).host; } catch { return 'link'; } })()}</span><span>Open in a new tab?</span><button type="button" className="btn-ghost" onClick={scroll.confirmLink}>Open</button><button type="button" className="btn-ghost" onClick={scroll.dismissLink}>Cancel</button></div>}
          {activeExpanded && session && <PreviewConversation session={session} activity={activity} open={conversationOpen} onOpen={() => setConversationOpen(true)} onClose={() => setConversationOpen(false)} conversation={conversation} />}
          {dragging && <div className="session-preview-drag-shield" />}
        </div>
      </section>}
      {reviewOpen && <PullRequestReview session={session} client={client} userId={userId} visible={reviewVisible} readable={readable} securityGeneration={securityGeneration} sendCommand={sendCommand} subscribeAuthority={subscribeAuthority} onClose={onCloseReview} expanded={activeExpanded} onExpand={() => setExpanded(value => !value)} />}
      </div>}
    </div>
  </div>;
}
