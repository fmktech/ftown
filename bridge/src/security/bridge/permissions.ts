import type { ApplicationJson, EndpointPermission } from '../protocol.js';
import { BridgeSecurityError } from './errors.js';

export interface OperationPermission { permission: EndpointPermission; mutating: boolean; operation: string; sessionId: string | null }
const session = /^[A-Za-z0-9_-]+$/;
const readCommands = new Set(['get_pull_request_statuses', 'session_preview_status', 'session_preview_chunk', 'get_bridge_update', 'list_sessions', 'get_history', 'get_session_usage', 'get_sessions_usage', 'get_session_attention',
  'ledger_head', 'ledger_chain',
  'get_model_routing', 'get_session_board']);
const controlCommands = new Set(['update_bridge', 'create_session', 'stop_session', 'retry_session', 'send_message', 'rename_session', 'remove_session',
  'bridge_exec', 'clear_terminal', 'update_session_parent', 'resolve_session_attention', 'answer_session_attention',
  'set_model_routing']);
const adminCommands = new Set(['security_devices', 'security_invite', 'security_revoke']);
const result = (permission: EndpointPermission, operation: string, sessionId: string | null = null): OperationPermission =>
  ({ permission, mutating: permission === 'control' || ['security_invite', 'security_revoke'].includes(operation), operation, sessionId });
const deny = (): never => { throw new BridgeSecurityError('permission_denied'); };
const object = (value: ApplicationJson | undefined): { [key: string]: ApplicationJson } | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
/** Every query key must be allowed and appear at most once. */
const queryAllows = (url: URL, allowed: string[]): boolean =>
  [...url.searchParams.keys()].every(key => allowed.includes(key)) && allowed.every(key => url.searchParams.getAll(key).length <= 1);

/** Deliberately semantic: GET inbox consumes mail unless explicitly non-consuming. */
export function classifyHttp(method: string, path: string): OperationPermission {
  if (path.length > 16_384 || !path.startsWith('/api/') || path.includes('#') || path.includes('\\') || path.split('?')[0].includes('%')) return deny();
  const url = new URL(path, 'http://bridge.invalid');
  if (url.origin !== 'http://bridge.invalid' || url.pathname.split('/').some(part => part === '.' || part === '..')
    || path.split('?')[0] !== url.pathname) return deny();
  if (url.pathname === '/api/sessions') {
    if (method === 'GET') return result('read', 'sessions_list');
    if (method === 'POST') return result('control', 'sessions_create');
    return deny();
  }
  if (method === 'GET' && url.pathname === '/api/archive') return result('read', 'archive_list');
  if (method === 'GET' && url.pathname === '/api/inbox/resolve') return result('read', 'inbox_resolve');
  if (method === 'GET' && url.pathname === '/api/browser/events') return result('read', 'local_events');
  const chat = /^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/preview-chat(?:\/(send|reply))?$/.exec(url.pathname);
  if (chat) {
    if (!chat[2] && method === 'GET' && [...url.searchParams.keys()].every(key => key === 'cursor') && url.searchParams.getAll('cursor').length <= 1) return result('read', 'preview_chat_list', chat[1]);
    if (chat[2] && method === 'POST' && !url.search) return result('control', `preview_chat_${chat[2]}`, chat[1]);
    return deny();
  }
  const preview = /^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/preview$/.exec(url.pathname);
  if (preview) return !url.search && (method === 'PUT' || method === 'DELETE') ? result('control', 'session_preview_register', preview[1]) : deny();
  const card = /^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/card$/.exec(url.pathname);
  if (card) {
    if (url.search) return deny();
    if (method === 'GET') return result('read', 'card_get', card[1]);
    if (method === 'PUT') return result('control', 'card_set', card[1]);
    if (method === 'DELETE') return result('control', 'card_clear', card[1]);
    return deny();
  }
  const board = /^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/board$/.exec(url.pathname);
  if (board) return method === 'GET' && queryAllows(url, ['since', 'ready', 'all']) ? result('read', 'board_get', board[1]) : deny();
  const events = /^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/events$/.exec(url.pathname);
  if (events) return method === 'GET' && queryAllows(url, ['since', 'limit', 'waitSeconds']) ? result('read', 'events_get', events[1]) : deny();
  const planItem = /^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/plan\/(p\d{1,6})$/.exec(url.pathname);
  if (planItem) {
    if (url.search) return deny();
    if (method === 'PATCH') return result('control', 'plan_patch', planItem[1]);
    if (method === 'DELETE') return result('control', 'plan_remove', planItem[1]);
    return deny();
  }
  const plan = /^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/plan$/.exec(url.pathname);
  if (plan) {
    if (url.search) return deny();
    if (method === 'GET') return result('read', 'plan_get', plan[1]);
    if (method === 'POST') return result('control', 'plan_add', plan[1]);
    return deny();
  }
  if (url.pathname === '/api/loops' || /^\/api\/loops\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname)) {
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return deny();
    return { permission: method === 'GET' ? 'read' : 'control', mutating: false, operation: 'automation_removed', sessionId: null };
  }
  const brief = /^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/brief(?:\/(notes))?$/.exec(url.pathname);
  if (brief) {
    if (url.search) return deny();
    if (!brief[2]) {
      if (method === 'GET') return result('read', 'brief_get', brief[1]);
      if (method === 'PUT') return result('control', 'brief_set', brief[1]);
      if (method === 'DELETE') return result('control', 'brief_clear', brief[1]);
      return deny();
    }
    return method === 'POST' ? result('control', 'brief_note', brief[1]) : deny();
  }
  if (url.pathname === '/api/worktrees')
    return method === 'GET' && !url.search ? result('read', 'worktrees_list') : deny();
  if (url.pathname === '/api/worktrees/prune')
    return method === 'POST' && !url.search ? result('control', 'worktrees_prune') : deny();
  const match = /^\/api\/sessions\/([A-Za-z0-9_-]+)(?:\/(screen|grep|keys|message|inbox|resize|usage|running|revive|stop|retry|attention)(?:\/(ack|resolve|ask)|\/([A-Za-z0-9_-]{1,100})(?:\/(answer|escalate))?)?)?$/.exec(url.pathname);
  if (!match) return deny();
  const [, id, suffix, attentionAction, eventId, attentionVerb] = match;
  if ((attentionAction || eventId || attentionVerb) && suffix !== 'attention') return deny();
  if (!suffix) {
    if (method === 'GET') return result('read', 'sessions_get', id);
    if (method === 'PATCH') return result('control', 'sessions_update', id);
    if (method === 'DELETE') {
      if (!queryAllows(url, ['worktree'])) return deny();
      const worktree = url.searchParams.get('worktree');
      if (worktree !== null && worktree !== 'keep' && worktree !== 'force') return deny();
      return result('control', 'sessions_remove', id);
    }
    return deny();
  }
  if (suffix === 'attention' && eventId === 'routed')
    return method === 'GET' && !url.search ? result('read', 'attention_routed', id) : deny();
  // Parent answer/escalate act on an open item; only the parent-facing POST is allowed.
  if (attentionVerb)
    return method === 'POST' && !url.search ? result('control', `attention_${attentionVerb}`, id) : deny();
  // Single attention item read (long-poll). ack/resolve/ask are matched above and never reach here.
  if (eventId) return method === 'GET' ? result('read', 'attention_get', id) : deny();
  if (suffix === 'inbox' && method === 'GET') {
    // Native wake registration mutates the delivery target even when peek=1.
    const peek = url.searchParams.getAll('peek');
    const readOnly = peek.length === 1 && peek[0] === '1'
      && !url.searchParams.has('adapter') && !url.searchParams.has('nativeSessionId');
    return result(readOnly ? 'read' : 'control', readOnly ? 'messages_peek' : 'messages_read', id);
  }
  if (method === 'GET' && ['screen', 'usage', 'running', 'attention'].includes(suffix) && !attentionAction) return result('read', `${suffix}_get`, id);
  if (method === 'POST' && suffix === 'grep' && !attentionAction) return result('read', 'history_search', id);
  if (method === 'POST' && ['keys', 'message', 'inbox', 'resize', 'revive', 'stop', 'retry', 'attention'].includes(suffix)) {
    return result('control', attentionAction ? `attention_${attentionAction}` : `${suffix}_send`, id);
  }
  if (method === 'DELETE' && suffix === 'screen') return result('control', 'screen_clear', id);
  return deny();
}

export function classifyCommand(command: string, payload?: ApplicationJson): OperationPermission {
  const body = object(payload);
  const sessionId = typeof body?.sessionId === 'string' && session.test(body.sessionId) ? body.sessionId : null;
  if (command === 'get_pull_request_review' || command === 'get_pull_request_review_chunk') return sessionId && sessionId.length <= 200 ? result('read', command, sessionId) : deny();
  if (command === 'session_preview_status' || command === 'session_preview_chunk') return sessionId && sessionId.length <= 200 ? result('read', command, sessionId) : deny();
  if (command === 'preview_chat_list' || command === 'preview_chat_send' || command === 'preview_chat_reply') return sessionId && sessionId.length <= 200 ? result(command === 'preview_chat_list' ? 'read' : 'control', command, sessionId) : deny();
  if (readCommands.has(command)) return result('read', command, sessionId);
  if (controlCommands.has(command)) return result('control', command, sessionId);
  if (adminCommands.has(command)) return result('admin', command, sessionId);
  if (command === 'terminal_watch' || command === 'terminal_unwatch' || command === 'webrtc_offer'
    || command === 'webrtc_answer' || command === 'webrtc_ice' || command === 'webrtc_close') return result('read', command, sessionId);
  // Unknown commands are denied by default.
  return deny();
}

export function classifyTerminal(frameType: string): OperationPermission {
  if (['attach', 'detach', 'init', 'ping', 'pong', 'hello'].includes(frameType)) return result('read', `terminal_${frameType}`);
  if (frameType === 'input' || frameType === 'resize') return result('control', `terminal_${frameType}`);
  return deny();
}
