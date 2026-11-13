"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { MessageClient } from '@/lib/message-client';
import type { BridgeRpc } from '@/hooks/useBridgeRpc';
import type { Session } from '@/types';
import { useSessionPreview, type SessionPreviewAuthoritySubscriber } from '@/hooks/useSessionPreview';
import { usePreviewScroll } from '@/hooks/usePreviewScroll';
import { usePreviewConversation } from '@/hooks/usePreviewConversation';
import { PreviewConversation } from './PreviewConversation';
import { PullRequestReview } from './PullRequestReview';
import type { SessionActivity } from '@/hooks/useAllSessionEvents';
import type { AttentionAnswerEntry } from '../../../bridge/src/attention-prompt-protocol';
import type { AttentionAnswerSubmitResult } from './AttentionAnswerForm';
import { InboxItemBody, inboxItemKey, type InboxEntry } from './SessionInbox';
import { SessionOverview, childSessionsOf, type OpenAttentionCount } from './SessionOverview';
import { clampPreviewRatio, isPreviewDescriptor, markdownPreviewDocument, previewDocument, previewRatioBounds } from '@/lib/session-preview';
import { previewScrollOwnerKey } from '@/lib/preview-scroll-protocol';

/** One slot of the workspace view switcher. "overview" only exists for sessions with children. */
export type WorkspaceTab = 'terminal' | 'overview' | 'preview' | 'review';

interface Props {
  session: Session | null; client: MessageClient | null; userId: string; readable: boolean;
  sendCommand: BridgeRpc['sendCommand']; subscribeAuthority?: SessionPreviewAuthoritySubscriber; securityGeneration: number; open: boolean; onClose: () => void;
  isDesktop: boolean; mobileTab: 'sessions' | WorkspaceTab; onMobileTab: (tab: 'terminal' | 'preview' | 'review') => void;
  reviewOpen?: boolean; reviewActivation?: number; onCloseReview?: () => void;
  /** Bumped every time the owner selects the session, including the one already open. */
  sessionActivation?: number;
  attention?: {
    entry: InboxEntry;
    shown: boolean;
    onShow(): void;
    /** Hide this item. Close and Escape ask the owner of the layout to move focus on (the terminal, or the tab left selected when the terminal is not on screen); choosing another view keeps focus where it is. */
    onHide(moveFocus: boolean): void;
    onDismiss(entry: InboxEntry): Promise<void>;
    onReply(entry: InboxEntry, message: string): Promise<void>;
    onAnswer(entry: InboxEntry, answers: AttentionAnswerEntry[]): Promise<AttentionAnswerSubmitResult>;
  };
  onRefit: () => void; children: ReactNode; sessions?: Session[]; activity?: SessionActivity;
  /** Live activity per session id (the dashboard's map), shown in the overview's children table. */
  activityBySession?: ReadonlyMap<string, SessionActivity>;
  /** Open attention items per session id; withParent counts items still waiting with the parent. */
  openAttentionBySession?: ReadonlyMap<string, OpenAttentionCount>;
}
type PreviewErrorReason = 'missing' | 'too_large' | 'invalid_utf8' | 'invalid_file' | 'unavailable';
function previewErrorMessage(reason: PreviewErrorReason, fileName: string): string {
  switch (reason) {
    case 'missing': return `${fileName} is missing`;
    case 'too_large': return `${fileName} exceeds the 1 MiB limit`;
    case 'invalid_utf8': return `${fileName} is not valid UTF-8`;
    case 'invalid_file':
    case 'unavailable': return `${fileName} is unavailable`;
  }
}
export function SessionWorkspace({ session, client, userId, readable, sendCommand, subscribeAuthority, securityGeneration, open, onClose, isDesktop, mobileTab, onMobileTab, onRefit, children, sessions = [], activity, activityBySession, openAttentionBySession, reviewOpen = false, reviewActivation = 0, onCloseReview = () => {}, sessionActivation = 0, attention }: Props) {
  const mainRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(50);
  const [compactTab, setCompactTab] = useState<WorkspaceTab>('preview');
  const [auxTab, setAuxTab] = useState<WorkspaceTab>('preview');
  const [conversationOpen, setConversationOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; startX: number; startRatio: number; cursor: string; select: string } | null>(null);

  const descriptor = session?.preview && isPreviewDescriptor(session.preview) ? session.preview : null;
  const files = descriptor?.files ?? [];
  const fileNames = files.map(f => f.fileName);
  const sessionKey = session ? `${session.bridgeId}:${session.id}` : '';

  // Per-session selection stored internally (persisted while Dashboard is open because SessionWorkspace stays mounted and sessionKey changes).
  const [internalSelections, setInternalSelections] = useState<Record<string, string>>({});
  const previousRecordByKey = useRef<Record<string, { id: string | null; names: string[] }>>({});
  const descriptorId = descriptor?.id ?? null;

  const storedSelection = sessionKey ? internalSelections[sessionKey] : undefined;
  let effectiveFileName: string | undefined;
  if (files.length > 0) {
    const prev = sessionKey ? previousRecordByKey.current[sessionKey] : undefined;
    const prevNames = prev?.names;
    const hasPrevNonEmpty = !!prevNames && prevNames.length > 0;
    const kept = hasPrevNonEmpty ? prevNames.some(n => fileNames.includes(n)) : false;
    const newNames = hasPrevNonEmpty ? fileNames.filter(n => !prevNames.includes(n)) : [];
    const isAdd = hasPrevNonEmpty && kept && newNames.length > 0;
    if (isAdd) {
      effectiveFileName = newNames[newNames.length - 1];
    } else if (storedSelection && fileNames.includes(storedSelection)) {
      effectiveFileName = storedSelection;
    } else {
      effectiveFileName = fileNames[0];
    }
  }

  const selectedFile = files.find(f => f.fileName === effectiveFileName) ?? files[0];

  const target = descriptor && selectedFile ? { bridgeId: session!.bridgeId, sessionId: session!.id, preview: descriptor, file: selectedFile } : null;

  const handleSelectFile = useCallback((fileName: string) => {
    setInternalSelections(prev => ({ ...prev, [sessionKey]: fileName }));
  }, [sessionKey]);

  // Keep previous set tracking and sync storage when the effective selection is derived from a set change (new file added, selected removed, or initial fallback).
  useEffect(() => {
    if (!sessionKey) return;
    const prev = previousRecordByKey.current[sessionKey];
    const namesChanged = !prev || prev.id !== descriptorId || prev.names.length !== fileNames.length || prev.names.some((n, i) => n !== fileNames[i]);
    if (namesChanged) {
      previousRecordByKey.current = { ...previousRecordByKey.current, [sessionKey]: { id: descriptorId, names: [...fileNames] } };
    }
    if (effectiveFileName === undefined) return;
    if (internalSelections[sessionKey] !== effectiveFileName) {
      setInternalSelections(prevSel => prevSel[sessionKey] === effectiveFileName ? prevSel : { ...prevSel, [sessionKey]: effectiveFileName });
    }
    // Include fileNames identity via joined string to detect order changes; effectiveFileName captures derived choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, effectiveFileName, descriptorId, fileNames.join('|'), internalSelections[sessionKey]]);

  const compact = !isDesktop || width < 640;
  const showPreview = !!target && open;
  // The "preview" tab is one slot: it shows the waiting item while attention.shown, otherwise the selected preview file.
  const attentionShown = !!attention?.shown;
  const slotOpen = showPreview || attentionShown;
  // Manager sessions (≥1 child) open on the Overview instead of the terminal; the terminal stays one click away.
  const childSessions = useMemo(() => session ? childSessionsOf(session, sessions) : [], [session, sessions]);
  const hasChildSessions = childSessions.length > 0;
  // Where a slot-less view lands: manager sessions return to their Overview, others to the terminal.
  // On a phone the tab belongs to Dashboard, whose fallback rule stays terminal.
  const fallbackView: WorkspaceTab = compact && !isDesktop ? (reviewOpen ? 'review' : 'terminal') : hasChildSessions ? 'overview' : 'terminal';
  const rawView = compact ? (isDesktop ? compactTab : mobileTab) : auxTab;
  const view = rawView === 'preview' && !slotOpen ? (reviewOpen ? 'review' : fallbackView) : rawView === 'review' && !reviewOpen ? (slotOpen ? 'preview' : fallbackView) : rawView;
  const attentionVisible = attentionShown && view === 'preview';
  const previousView = useRef({ showPreview, view });
  const previewDisappeared = previousView.current.showPreview && !showPreview && previousView.current.view === 'preview';
  const activeExpanded = expanded && rawView === view && view !== 'terminal' && view !== 'overview' && !attentionVisible && !previewDisappeared;
  const previewVisible = showPreview && !attentionShown && view === 'preview';
  const { state, refresh, getHardEpoch } = useSessionPreview({ client, userId, target, visible: previewVisible, readable, securityGeneration, sendCommand, subscribeAuthority });
  const owner = target ? previewScrollOwnerKey({ userId, bridgeId: target.bridgeId, sessionId: target.sessionId, previewId: target.preview.id, fileId: target.file.id }) : '';

  const onSwitchFile = useCallback((fileName: string) => {
    const match = files.find(f => f.fileName === fileName);
    if (!match) return;
    handleSelectFile(fileName);
  }, [files, handleSelectFile]);

  const scroll = usePreviewScroll(state.kind === 'ready' && !attentionShown ? state : null, owner, getHardEpoch, onSwitchFile);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const focusLinkPrompt = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (document.activeElement !== node) node.focus();
    } else {
      const previous = previouslyFocused.current;
      previouslyFocused.current = null;
      if (previous && previous.isConnected) previous.focus();
    }
  }, []);
  const conversation = usePreviewConversation({ client, userId, session, sessions: sessions.length ? sessions : session ? [session] : [], enabled: activeExpanded && conversationOpen && open, readable, sendCommand, subscribeAuthority });
  useEffect(() => {
    const node = mainRef.current; if (!node) return;
    const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => { setCompactTab('preview'); setAuxTab('preview'); setExpanded(false); setConversationOpen(false); }, [session?.bridgeId, session?.id]);
  const previewId = descriptor?.id;
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
    setCompactTab(current => current === 'preview' && !slotOpen ? (reviewOpen ? 'review' : fallbackView) : current === 'review' && !reviewOpen ? (slotOpen ? 'preview' : fallbackView) : current);
    setAuxTab(current => current === 'preview' && !slotOpen && reviewOpen ? 'review' : current === 'review' && !reviewOpen ? 'preview' : current);
    if (!isDesktop && mobileTab === 'preview' && !slotOpen) onMobileTab(reviewOpen ? 'review' : 'terminal');
    else if (!isDesktop && mobileTab === 'review' && !reviewOpen) onMobileTab(slotOpen ? 'preview' : 'terminal');
    else if (!isDesktop && mobileTab === 'overview' && !hasChildSessions) onMobileTab('terminal');
  }, [slotOpen, reviewOpen, isDesktop, mobileTab, hasChildSessions, fallbackView, onMobileTab]);
  // A newly shown item (session entered, item arrived, item re-shown) brings the slot forward on desktop without moving focus.
  // Keyed by the item, so a new item is brought forward even when the previous one was still shown behind another tab.
  // The mobile tab belongs to Dashboard, which applies its own rule.
  const shownKey = attention?.shown ? `${sessionKey}|${inboxItemKey(attention.entry)}` : null;
  const previousShownKey = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousShownKey.current;
    previousShownKey.current = shownKey;
    if (shownKey && shownKey !== previous && isDesktop && !reviewOpen) { setCompactTab('preview'); setAuxTab('preview'); }
  }, [shownKey, isDesktop, reviewOpen]);
  // Selecting the session again brings its shown item forward too, as entering it does.
  useEffect(() => {
    if (sessionActivation && isDesktop && attentionShown && !reviewOpen) { setCompactTab('preview'); setAuxTab('preview'); }
    // Only a new selection triggers this; the item and layout are read as they are at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionActivation]);
  useEffect(() => {
    if (expanded && (previewDisappeared || rawView !== view || view === 'terminal' || view === 'overview' || attentionVisible)) setExpanded(false);
    previousView.current = { showPreview, view };
  }, [expanded, previewDisappeared, rawView, view, showPreview, attentionVisible]);
  useEffect(() => { if (!open && !reviewOpen) { setExpanded(false); setConversationOpen(false); } }, [open, reviewOpen]);
  useEffect(() => {
    // While the overview overlay covers the terminal (compact layouts) the terminal must not be refitted
    // (it is out of sight); returning to it re-runs this effect and refits it. On a desktop the overview
    // sits beside the terminal in its own column, so the terminal stays fitted and the effect re-runs.
    if (compact && view === 'overview') return;
    onRefit();
  }, [open, reviewOpen, compact, view, activeExpanded, width, onRefit]);
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
  const hasAux = slotOpen || reviewOpen;
  // Manager sessions get a workspace column on the desktop even without a side-pane slot: it hosts the
  // view switcher (Overview/Terminal) and the Overview panel itself, so the terminal stays mounted beside it.
  const switcherColumn = !compact && hasChildSessions;
  // The switcher's slots: manager sessions switch between Overview and Terminal, the side-pane slots follow.
  const tabs: WorkspaceTab[] = [
    ...(hasChildSessions ? (['overview', 'terminal'] as const) : compact ? (['terminal'] as const) : []),
    ...(slotOpen ? (['preview'] as const) : []),
    ...(reviewOpen ? (['review'] as const) : []),
  ];
  const tabLabel = (tab: WorkspaceTab) => tab === 'terminal' ? 'Terminal' : tab === 'overview' ? 'Overview' : tab === 'preview' ? (attentionShown ? 'Waiting' : 'Preview') : 'PR review';
  const choose = (tab: WorkspaceTab) => { setAuxTab(tab); setCompactTab(tab); if (compact && !isDesktop && (tab === 'preview' || tab === 'review')) onMobileTab(tab); };
  const tabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const index = Math.max(0, tabs.indexOf(view as WorkspaceTab));
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      choose(next); (event.currentTarget.querySelector(`[data-preview-tab="${next}"]`) as HTMLButtonElement | null)?.focus();
    }
  };
  const fileTabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      if (buttons.length === 0) return;
      const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let nextIndex: number;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = buttons.length - 1;
      else if (event.key === 'ArrowRight') nextIndex = (Math.max(0, currentIndex) + 1) % buttons.length;
      else nextIndex = (Math.max(0, currentIndex) - 1 + buttons.length) % buttons.length;
      buttons[nextIndex]?.focus();
      buttons[nextIndex]?.click();
    }
  };
  // One selector for the slot on every layout: the waiting item first, then the open preview's files.
  // Leaving the item for a file is a hide of that item, so the next item (a different key) is shown again.
  const slotFiles = showPreview ? files : [];
  const selectFileEntry = (fileName: string) => { if (attentionShown) attention?.onHide(false); handleSelectFile(fileName); };
  const entryCount = slotFiles.length + (attention ? 1 : 0);
  const selectorName = attention ? 'Side pane view' : 'Preview file';
  const attentionLabel = <><span aria-hidden="true" className="session-attention-dot" />Waiting for you</>;
  const viewSelector = (
    entryCount < 2 ? (
      attention && slotFiles.length === 0 ? <span className="session-preview-filename">{attentionLabel}</span>
      : selectedFile ? <span className="session-preview-filename" title={selectedFile.fileName}>{selectedFile.fileName}</span> : null
    ) : entryCount <= 5 ? (
      <div role="tablist" aria-label={selectorName} className="session-preview-file-tablist" onKeyDown={fileTabKeys}>
        {attention && <button key="attention" role="tab" aria-selected={attentionShown} title="Waiting for you" tabIndex={attentionShown ? 0 : -1} onClick={() => attention.onShow()} className={`session-preview-file-tab ${attentionShown ? 'is-selected' : ''}`}>{attentionLabel}</button>}
        {slotFiles.map(file => (
          <button
            key={file.id}
            role="tab"
            aria-selected={!attentionShown && file.fileName === effectiveFileName}
            title={file.fileName}
            tabIndex={!attentionShown && file.fileName === effectiveFileName ? 0 : -1}
            onClick={() => selectFileEntry(file.fileName)}
            className={`session-preview-file-tab ${!attentionShown && file.fileName === effectiveFileName ? 'is-selected' : ''}`}
          >
            {file.fileName}
          </button>
        ))}
      </div>
    ) : (
      <select
        aria-label={selectorName}
        className="session-preview-file-select"
        value={attentionShown ? '' : effectiveFileName ?? ''}
        onChange={e => { if (e.target.value === '') attention?.onShow(); else selectFileEntry(e.target.value); }}
      >
        {attention && <option value="">Waiting for you</option>}
        {slotFiles.map(file => <option key={file.id} value={file.fileName}>{file.fileName}</option>)}
      </select>
    )
  );
  const tabbed = compact || reviewOpen;
  const terminalVisible = !activeExpanded && (!hasAux || !compact || view === 'terminal' || view === 'overview');
  const reviewVisible = reviewOpen && view === 'review';
  return <div ref={mainRef} className="session-workspace" onKeyDown={event => {
    if (activeExpanded && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setExpanded(false); }
  }}>
    {(hasAux || hasChildSessions) && compact && isDesktop && !activeExpanded && <div role="tablist" aria-label="Session view" onKeyDown={tabKeys} className="session-preview-tabs">
      {tabs.map(tab => <button key={tab} id={`compact-${tab}-tab`} data-preview-tab={tab} role="tab" aria-selected={view === tab} aria-controls={`session-${tab}-panel`} tabIndex={view === tab ? 0 : -1} onClick={() => choose(tab)} className={`mobile-tab ${view === tab ? 'mobile-tab-active' : ''}`}>{tabLabel(tab)}</button>)}
    </div>}
    <div className="session-workspace-panes">
      <div id="session-terminal-panel" role={compact && (hasAux || hasChildSessions) ? 'tabpanel' : undefined} aria-label="Terminal" hidden={!terminalVisible} className="session-terminal-pane" style={{ position: 'relative', ...((hasAux || switcherColumn) && !compact && !activeExpanded ? { flex: `0 0 calc((100% - 8px) * ${actualRatio / 100})` } : {}) }}>
        {children}
        {/* Compact layouts cover the still-mounted terminal with the Overview; on a desktop the Overview has its own column beside it. */}
        {compact && view === 'overview' && session && <div id="session-overview-panel" role="tabpanel" aria-label="Overview" style={{ position: 'absolute', inset: 0, zIndex: 5, display: 'flex', background: 'var(--bg-base)' }}>
          <SessionOverview session={session} sessions={sessions} activityBySession={activityBySession} openAttentionBySession={openAttentionBySession} />
        </div>}
      </div>
      {(hasAux || switcherColumn) && !compact && !activeExpanded && <div role="separator" aria-label="Resize terminal and preview" aria-orientation="vertical" aria-valuemin={Number(min.toFixed(1))} aria-valuemax={Number(max.toFixed(1))} aria-valuenow={Number(actualRatio.toFixed(1))} tabIndex={0} className="session-preview-separator" onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onKeyDown={keyDown} onDoubleClick={() => setSplit(50)} />}
      {(hasAux || attention || switcherColumn) && <div className="session-aux-pane" hidden={(!hasAux && !switcherColumn) || (compact && (view === 'terminal' || view === 'overview'))}>
      {!compact && (hasChildSessions || (slotOpen && reviewOpen)) && <div role="tablist" aria-label="Auxiliary view" onKeyDown={tabKeys} className="session-preview-tabs">{tabs.map(tab => <button key={tab} data-preview-tab={tab} role="tab" aria-selected={view === tab} aria-controls={`session-${tab}-panel`} tabIndex={view === tab ? 0 : -1} onClick={() => choose(tab)} className={`mobile-tab ${view === tab ? 'mobile-tab-active' : ''}`}>{tabLabel(tab)}</button>)}</div>}
      {(slotOpen || attention) && <section id="session-preview-panel" role={!slotOpen ? undefined : tabbed ? 'tabpanel' : attentionShown ? undefined : 'region'} aria-label={!slotOpen ? undefined : attentionShown ? (tabbed ? 'Waiting' : undefined) : 'Session preview'} hidden={!slotOpen || view !== 'preview'} className="session-preview-pane">
        <div className="session-preview-toolbar">
          {viewSelector}
          {attention && attentionShown ? <button type="button" className="btn-ghost session-preview-icon" aria-label="Close waiting" title="Close waiting" onClick={() => attention.onHide(true)}>
            <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 5l14 14M19 5 5 19" /></svg>
          </button> : <>
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
          </>}
        </div>
        {/* The item body stays mounted, hidden, while its item exists, so a reply draft or half-filled answer survives a peek at a file. It is keyed by the item: nothing typed for one item can reach another. */}
        {attention && <div key={inboxItemKey(attention.entry)} hidden={!attentionShown} role={attentionShown ? 'region' : undefined} aria-label={attentionShown ? 'Waiting for you' : undefined} className="session-preview-content p-3" style={{ overflowY: 'auto' }} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); attention.onHide(true); } }}>
          <div className="min-w-0 space-y-2">
            <InboxItemBody entry={attention.entry} onOpenSession={() => {}} onDismiss={attention.onDismiss} onReply={attention.onReply} onAnswer={attention.onAnswer} hideOpenSession />
          </div>
        </div>}
        {showPreview && !attentionShown && <div className="session-preview-content">
          {state.kind === 'ready' && scroll.display ? (() => {
            const docId = scroll.display.documentId;
            const html = scroll.display.html;
            const srcDoc = selectedFile?.kind === 'markdown'
              ? markdownPreviewDocument(html, selectedFile.fileName, docId, fileNames)
              : previewDocument(html, docId, fileNames);
            return <><iframe ref={scroll.iframeRef} key={scroll.display.key} title={`Preview: ${selectedFile?.fileName ?? ''}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} />{state.updating && <span className="session-preview-updating">Updating preview…</span>}</>;
          })() : <div className="session-preview-message" role="status"><span>{state.kind === 'loading' || state.kind === 'ready' ? 'Loading preview…' : state.kind === 'offline' ? 'Reconnect to load preview' : state.kind === 'unregistered' ? 'No preview registered' : state.kind === 'unavailable' ? previewErrorMessage(state.reason, selectedFile?.fileName ?? '') : selectedFile ? previewErrorMessage('unavailable', selectedFile.fileName) : 'Preview unavailable'}</span>{state.kind !== 'loading' && state.kind !== 'ready' && state.kind !== 'unregistered' && <button type="button" className="btn-ghost" onClick={refresh}>Retry</button>}</div>}
          {scroll.linkPrompt && <div ref={focusLinkPrompt} tabIndex={-1} className="session-preview-link-prompt" role="dialog" aria-label="Open external link" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); scroll.dismissLink(); } }}><div className="session-preview-link-scroll" tabIndex={0} role="group" aria-label="Destination URL"><span className="session-preview-link-host" title={scroll.linkPrompt}>{scroll.linkPrompt}</span></div><div className="session-preview-link-actions"><span>Open in a new tab?</span><button type="button" className="btn-ghost" onClick={scroll.confirmLink}>Open</button><button type="button" className="btn-ghost" onClick={scroll.dismissLink}>Cancel</button></div></div>}
          {activeExpanded && session && <PreviewConversation session={session} activity={activity} open={conversationOpen} onOpen={() => setConversationOpen(true)} onClose={() => setConversationOpen(false)} conversation={conversation} />}
          {dragging && <div className="session-preview-drag-shield" />}
        </div>}
      </section>}
      {switcherColumn && view === 'overview' && session && <div id="session-overview-panel" role="tabpanel" aria-label="Overview" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <SessionOverview session={session} sessions={sessions} activityBySession={activityBySession} openAttentionBySession={openAttentionBySession} />
      </div>}
      {reviewOpen && <PullRequestReview session={session} client={client} userId={userId} visible={reviewVisible} readable={readable} securityGeneration={securityGeneration} sendCommand={sendCommand} subscribeAuthority={subscribeAuthority} onClose={onCloseReview} expanded={activeExpanded} onExpand={() => setExpanded(value => !value)} />}
      </div>}
    </div>
  </div>;
}
