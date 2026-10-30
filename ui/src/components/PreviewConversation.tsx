"use client";
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { Session } from '@/types';
import type { SessionActivity } from '@/hooks/useAllSessionEvents';
import type { PreviewConversationView } from '@/hooks/usePreviewConversation';

interface Props { open: boolean; onOpen: () => void; onClose: () => void; session: Session; activity?: SessionActivity; conversation: PreviewConversationView }
function status(session: Session, activity?: SessionActivity): string {
  if (session.status === 'pending') return 'Starting';
  if (session.status === 'completed') return 'Completed';
  if (session.status === 'error') return 'Failed';
  if (session.status === 'disconnected') return 'Offline';
  if (activity?.attention) return 'Waiting for you';
  if (activity?.activity === 'thinking') return 'Thinking';
  if (activity?.activity === 'tool_use') return activity.toolName ? `Using ${activity.toolName}` : 'Working';
  return 'Running';
}
export function PreviewConversation({ open, onOpen, onClose, session, activity, conversation }: Props) {
  const list = useRef<HTMLDivElement>(null); const pinned = useRef(true);
  useEffect(() => { if (pinned.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [conversation.turns]);
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !event.repeat) { event.preventDefault(); void conversation.send(); }
  };
  if (!open) return <button type="button" className="btn-ghost preview-chat-launcher" aria-label="Open conversation" aria-expanded="false" aria-controls="preview-conversation" title="Open conversation" onClick={onOpen}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16v11H9l-5 4V5Z" /></svg></button>;
  return <section id="preview-conversation" className="preview-chat" aria-label="Preview conversation">
    <header className="preview-chat-header"><div><strong>Conversation</strong><div className="preview-chat-status" role="status">{status(session, activity)}</div></div><button type="button" className="btn-ghost preview-chat-icon" aria-label="Collapse conversation" title="Collapse conversation" aria-expanded="true" aria-controls="preview-conversation" onClick={onClose}>×</button></header>
    <div ref={list} className="preview-chat-history" aria-label="Conversation history" onScroll={event => { const node = event.currentTarget; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32; }}>
      {conversation.turns.length === 0 ? <p className="preview-chat-empty">No messages yet.</p> : conversation.turns.map(item => <div key={item.id} className={`preview-chat-turn preview-chat-${item.role}`}><div className="preview-chat-role">{item.role === 'agent' ? 'Agent' : 'You'}{item.role === 'user' && item.delivery === 'queued' ? ' · Queued' : item.role === 'user' && item.delivery === 'unconfirmed' ? ' · Delivery unconfirmed' : ''}</div><pre>{item.text}</pre></div>)}
    </div>
    <div className="preview-chat-compose"><label htmlFor="preview-chat-input">Message the agent</label><textarea id="preview-chat-input" rows={2} value={conversation.draft} onChange={event => conversation.setDraft(event.target.value)} onKeyDown={keyDown} placeholder="Write a message…" />
      {conversation.error && <p role="alert" className="preview-chat-error">{conversation.error}</p>}
      {conversation.pendingMode === 'unconfirmed' && <p className="preview-chat-error">Sending again may duplicate this message.</p>}
      {!conversation.canSend && <p className="preview-chat-hint">Sending is unavailable for this session.</p>}
      <button type="button" className="btn-accent preview-chat-send" disabled={!conversation.canSend || conversation.sending || !conversation.draftValid} onClick={() => void conversation.send()}>{conversation.sending ? 'Sending…' : conversation.pendingMode === 'unconfirmed' ? 'Send again' : conversation.pendingMode === 'uncertain' ? 'Retry' : 'Send'}</button>
    </div>
  </section>;
}
