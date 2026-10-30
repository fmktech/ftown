import type { ApplicationJson, EndpointPermission } from '../protocol.js';
import { BridgeSecurityError } from './errors.js';

export interface OperationPermission { permission: EndpointPermission; mutating: boolean; operation: string; sessionId: string | null }
const session = /^[A-Za-z0-9_-]+$/;
const readCommands = new Set(['get_pull_request_statuses', 'get_bridge_update', 'list_sessions', 'get_history', 'get_session_usage', 'get_sessions_usage', 'get_session_attention']);
const controlCommands = new Set(['update_bridge', 'create_session', 'stop_session', 'retry_session', 'send_message', 'rename_session', 'remove_session',
  'bridge_exec', 'clear_terminal', 'update_session_parent', 'resolve_session_attention']);
const adminCommands = new Set(['security_devices', 'security_invite', 'security_revoke', 'security_approve_mcp', 'security_activity', 'security_account_adopt']);
const result = (permission: EndpointPermission, operation: string, sessionId: string | null = null): OperationPermission =>
  ({ permission, mutating: permission === 'control' || ['security_invite', 'security_revoke', 'security_approve_mcp', 'security_account_adopt'].includes(operation), operation, sessionId });
const deny = (): never => { throw new BridgeSecurityError('permission_denied'); };
const object = (value: ApplicationJson | undefined): { [key: string]: ApplicationJson } | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

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
  if (url.pathname === '/api/loops' || /^\/api\/loops\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname)) {
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return deny();
    return { permission: method === 'GET' ? 'read' : 'control', mutating: false, operation: 'automation_removed', sessionId: null };
  }
  const match = /^\/api\/sessions\/([A-Za-z0-9_-]+)(?:\/(screen|grep|keys|message|inbox|resize|usage|running|revive|stop|retry|attention)(?:\/(ack|resolve))?)?$/.exec(url.pathname);
  if (!match) return deny();
  const [, id, suffix, attentionAction] = match;
  if (attentionAction && suffix !== 'attention') return deny();
  if (!suffix) {
    if (method === 'GET') return result('read', 'sessions_get', id);
    if (method === 'PATCH') return result('control', 'sessions_update', id);
    if (method === 'DELETE') return result('control', 'sessions_remove', id);
    return deny();
  }
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
  if (command === 'mcp_request') {
    const request = object(body?.request);
    if (typeof request?.method !== 'string' || typeof request.path !== 'string') return deny();
    return classifyHttp(request.method, request.path);
  }
  if (readCommands.has(command)) return result('read', command, sessionId);
  if (controlCommands.has(command)) return result('control', command, sessionId);
  if (adminCommands.has(command)) return result('admin', command, sessionId);
  if (command === 'terminal_watch' || command === 'terminal_unwatch' || command === 'webrtc_offer'
    || command === 'webrtc_answer' || command === 'webrtc_ice' || command === 'webrtc_close') return result('read', command, sessionId);
  // Activation has a separate exact-pending-grant check; it is never granted by a generic permission.
  return deny();
}

export function classifyTerminal(frameType: string): OperationPermission {
  if (['attach', 'detach', 'init', 'ping', 'pong', 'hello'].includes(frameType)) return result('read', `terminal_${frameType}`);
  if (frameType === 'input' || frameType === 'resize') return result('control', `terminal_${frameType}`);
  return deny();
}
