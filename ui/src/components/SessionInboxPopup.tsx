"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { AttentionAnswerSubmitResult } from "./AttentionAnswerForm";
import type { AttentionAnswerEntry } from "../../../bridge/src/attention-prompt-protocol";
import { InboxItemBody, noticeKey, type InboxEntry } from "./SessionInbox";

export function popupKey(entry: InboxEntry): string {
  return entry.notice.attentionId ? `att:${entry.notice.attentionId}` : `sess:${entry.session.id}@${entry.notice.receivedAt}`;
}

interface SessionInboxPopupProps {
  entry: InboxEntry | null;
  onOpenSession: (id: string) => void;
  onDismiss: (entry: InboxEntry) => Promise<void>;
  onReply: (entry: InboxEntry, message: string) => Promise<void>;
  onAnswer: (entry: InboxEntry, answers: AttentionAnswerEntry[]) => Promise<AttentionAnswerSubmitResult>;
  onReturnFocus: () => void;
}

export function SessionInboxPopup({ entry, onOpenSession, onDismiss, onReply, onAnswer, onReturnFocus }: SessionInboxPopupProps) {
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(new Set());
  const regionRef = useRef<HTMLDivElement>(null);
  if (!entry) return null;
  const key = popupKey(entry);
  const collapsed = collapsedKeys.has(key);
  const collapse = () => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };
  const expand = () => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };
  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!regionRef.current?.contains(document.activeElement)) return;
    event.preventDefault();
    collapse();
    onReturnFocus();
  };
  if (collapsed) {
    return <button type="button" className="session-inbox-popup-pill" onClick={expand} aria-label="Waiting for you">1 waiting</button>;
  }
  return <div ref={regionRef} role="region" aria-label="Waiting for you" className="session-inbox-popup" onKeyDown={onEscape}>
    <div className="min-w-0 space-y-2" data-inbox-popup-entry={entry.session.id} key={noticeKey(entry.session.id, entry.notice)}>
      <InboxItemBody entry={entry} onOpenSession={onOpenSession} onDismiss={onDismiss} onReply={onReply} onAnswer={onAnswer} />
    </div>
    <button type="button" className="session-inbox-popup-hide btn-ghost min-h-11" onClick={collapse}>Hide</button>
  </div>;
}
