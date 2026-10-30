/** Encrypted browser command: queue durable mail, not terminal keystrokes. */
export interface SendSessionMessagePayload {
  bridgeId: string;
  sessionId: string;
  message: string;
}

/** Acceptance means durable enqueue, not that the agent has read the reply. */
export interface SessionMessageAccepted {
  sessionId: string;
  messageId: string;
  status: "queued";
}

export type SessionMessageErrorCode =
  | "invalid_request"
  | "session_unavailable"
  | "mail_not_ready"
  | "enqueue_failed";
