/** Shared preview conversation wire contract. No terminal transcript or iframe messages. */
export const PREVIEW_CHAT_TEXT_BYTES = 4096;
export const PREVIEW_CHAT_PAGE_BYTES = 65536;
export const PREVIEW_CHAT_PAGE_TURNS = 25;
export const PREVIEW_CHAT_MAX_TURNS = 1000;
export const PREVIEW_CHAT_STORE_BYTES = 4 * 1024 * 1024;
export const PREVIEW_CHAT_POLL_MS = 1500;
export const PREVIEW_CHAT_AGENT_SHELLS = ['claude', 'cursor', 'codex', 'zai', 'kimi', 'opencode', 'deepseek', 'fireworks', 'grok', 'pi', 'kimi-code', 'muse'] as const;

interface PreviewChatTurnBase {
  id: string;
  sequence: number;
  text: string;
  createdAt: string;
}
export type PreviewChatUserTurn = PreviewChatTurnBase & { role: 'user'; delivery: 'queued' | 'unconfirmed' };
export type PreviewChatAgentTurn = PreviewChatTurnBase & { role: 'agent'; delivery: 'recorded' };
export type PreviewChatTurn = PreviewChatUserTurn | PreviewChatAgentTurn;
export interface PreviewChatInput { id: string; text: string }
/** Opaque to consumers; provider format is `${sessionId}:${lastSequence}`. */
export type PreviewChatCursor = string;
export interface PreviewChatListRequest { bridgeId: string; sessionId: string; cursor?: PreviewChatCursor }
export interface PreviewChatWriteRequest extends PreviewChatInput { bridgeId: string; sessionId: string }
export interface PreviewChatPage {
  sessionId: string;
  turns: PreviewChatTurn[];
  cursor: PreviewChatCursor;
  hasMore: boolean;
}
export interface PreviewChatWriteResult { sessionId: string; turn: PreviewChatTurn }
export type PreviewChatErrorCode = 'invalid' | 'too_large' | 'not_found' | 'not_running' | 'unsupported' | 'conflict' | 'capacity_exceeded' | 'unavailable';
