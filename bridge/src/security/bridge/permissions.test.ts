import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCommand, classifyHttp, classifyTerminal } from './permissions.js';

test('reads cannot consume inboxes or register native wake targets, while POST history search remains read-only', () => {
  assert.equal(classifyHttp('GET', '/api/sessions/session/inbox').permission, 'control');
  assert.equal(classifyHttp('GET', '/api/sessions/session/inbox?peek=1').permission, 'read');
  assert.equal(classifyHttp('GET', '/api/sessions/session/inbox?peek=1&peek=0').permission, 'control');
  assert.equal(classifyHttp('GET', '/api/sessions/session/inbox?peek=1&adapter=opencode&nativeSessionId=agent').permission, 'control');
  assert.equal(classifyHttp('POST', '/api/sessions/session/grep').permission, 'read');
});

test('preview reads require read authority and registration cannot be tunneled', () => {
  assert.equal(classifyCommand('session_preview_status', { sessionId: 'session' }).permission, 'read');
  assert.equal(classifyCommand('session_preview_chunk', { sessionId: 'session' }).permission, 'read');
  assert.equal(classifyHttp('PUT', '/api/sessions/session/preview').permission, 'control');
  assert.equal(classifyHttp('DELETE', '/api/sessions/session/preview').permission, 'control');
  assert.throws(() => classifyCommand('session_preview_chunk', { sessionId: '../session' }), { code: 'permission_denied' });
  assert.throws(() => classifyHttp('GET', '/api/sessions/session/preview'), { code: 'permission_denied' });
  assert.throws(() => classifyHttp('PUT', '/api/sessions/session/preview?x=1'), { code: 'permission_denied' });
});

test('preview conversation reads require read and sends/replies require control', () => {
  assert.equal(classifyCommand('preview_chat_list', { sessionId: 'session' }).permission, 'read');
  for (const type of ['preview_chat_send', 'preview_chat_reply']) assert.equal(classifyCommand(type, { sessionId: 'session' }).permission, 'control');
  assert.equal(classifyHttp('GET', '/api/sessions/session/preview-chat?cursor=session%3A0').permission, 'read');
  assert.equal(classifyHttp('POST', '/api/sessions/session/preview-chat/reply').permission, 'control');
  assert.throws(() => classifyHttp('POST', '/api/sessions/session/preview-chat/reply?x=1'), { code: 'permission_denied' });
  assert.throws(() => classifyCommand('preview_chat_send', { sessionId: '../bad' }), { code: 'permission_denied' });
});

test('attention item routes classify ask, single-item read and keep ack/resolve unchanged', () => {
  assert.deepEqual(classifyHttp('POST', '/api/sessions/session/attention/ask'), { permission: 'control', mutating: true, operation: 'attention_ask', sessionId: 'session' });
  assert.deepEqual(classifyHttp('GET', '/api/sessions/session/attention/event-1_2?waitSeconds=25'), { permission: 'read', mutating: false, operation: 'attention_get', sessionId: 'session' });
  assert.equal(classifyHttp('POST', '/api/sessions/session/attention/ack').operation, 'attention_ack');
  assert.equal(classifyHttp('POST', '/api/sessions/session/attention/resolve').operation, 'attention_resolve');
  assert.equal(classifyHttp('POST', '/api/sessions/session/attention/ack').permission, 'control');
  assert.equal(classifyHttp('POST', '/api/sessions/session/attention/resolve').permission, 'control');
  for (const [method, path] of [
    ['GET', '/api/sessions/session/attention/ack'], ['GET', '/api/sessions/session/attention/resolve'], ['GET', '/api/sessions/session/attention/ask'],
    ['POST', '/api/sessions/session/attention/event-1'], ['DELETE', '/api/sessions/session/attention/event-1'],
    ['GET', '/api/sessions/session/inbox/event-1'], ['GET', `/api/sessions/session/attention/${'e'.repeat(101)}`],
    ['GET', '/api/sessions/session/attention/event-1/extra'],
  ]) assert.throws(() => classifyHttp(method, path), { code: 'permission_denied' }, `${method} ${path}`);
  assert.equal(classifyCommand('answer_session_attention', { sessionId: 'session' }).permission, 'control');
});

test('actual operations determine permission and unknown methods/routes/frames deny by default', () => {
  assert.equal(classifyCommand('get_bridge_update').permission, 'read');
  assert.equal(classifyCommand('get_pull_request_statuses').permission, 'read');
  assert.equal(classifyCommand('update_bridge').permission, 'control');
  assert.equal(classifyCommand('get_history', { sessionId: 'session' }).permission, 'read');
  assert.equal(classifyCommand('bridge_exec', { mutating: false }).permission, 'control');
  assert.equal(classifyCommand('security_devices').permission, 'admin');
  assert.equal(classifyTerminal('attach').permission, 'read');
  assert.equal(classifyTerminal('input').permission, 'control');
  assert.equal(classifyTerminal('resize').permission, 'control');
  for (const [method, path] of [
    ['GET', '//evil/api/sessions'], ['GET', '/api/sessions/../archive'], ['GET', '/api/sessions/%73ession'],
    ['POST', '/api/sessions/session/usage'], ['PUT', '/api/sessions/session'], ['GET', '/api/browser/devices'],
    ['DELETE', '/api/sessions/session/attention'],
  ]) assert.throws(() => classifyHttp(method, path), { code: 'permission_denied' });
  for (const command of ['unknown', 'mcp_request', 'security_activity', 'security_activate_mcp', 'security_update_policy', 'security_account_adopt']) assert.throws(() => classifyCommand(command), { code: 'permission_denied' });
  for (const frame of ['screen', 'output', 'arbitrary']) assert.throws(() => classifyTerminal(frame), { code: 'permission_denied' });
});

test('coordination card, board and events routes classify per method and deny extras', () => {
  assert.deepEqual(classifyHttp('GET', '/api/sessions/session/card'), { permission: 'read', mutating: false, operation: 'card_get', sessionId: 'session' });
  assert.deepEqual(classifyHttp('PUT', '/api/sessions/session/card'), { permission: 'control', mutating: true, operation: 'card_set', sessionId: 'session' });
  assert.deepEqual(classifyHttp('DELETE', '/api/sessions/session/card'), { permission: 'control', mutating: true, operation: 'card_clear', sessionId: 'session' });
  assert.deepEqual(classifyHttp('GET', '/api/sessions/session/board'), { permission: 'read', mutating: false, operation: 'board_get', sessionId: 'session' });
  assert.deepEqual(classifyHttp('GET', '/api/sessions/session/board?since=4&ready=1&all=1'), { permission: 'read', mutating: false, operation: 'board_get', sessionId: 'session' });
  assert.deepEqual(classifyHttp('GET', '/api/sessions/session/events'), { permission: 'read', mutating: false, operation: 'events_get', sessionId: 'session' });
  assert.deepEqual(classifyHttp('GET', '/api/sessions/session/events?since=2&limit=100&waitSeconds=25'), { permission: 'read', mutating: false, operation: 'events_get', sessionId: 'session' });
  for (const [method, path] of [
    ['POST', '/api/sessions/session/card'], ['PATCH', '/api/sessions/session/card'],
    ['GET', '/api/sessions/session/card?since=1'], ['PUT', '/api/sessions/session/card?x=1'],
    ['GET', '/api/sessions/session/board/extra'], ['DELETE', '/api/sessions/session/board'], ['GET', '/api/sessions/session/board?cursor=1'],
    ['POST', '/api/sessions/session/events'], ['GET', '/api/sessions/session/events/extra'],
    ['GET', '/api/sessions/session/events?cursor=1'], ['GET', '/api/sessions/session/events?since=1&since=2'],
    ['GET', `/api/sessions/${'e'.repeat(201)}/card`],
  ]) assert.throws(() => classifyHttp(method, path), { code: 'permission_denied' }, `${method} ${path}`);
});

test('model routing reads need read authority and saving it needs control', () => {
  assert.deepEqual(classifyCommand('get_model_routing', { bridgeId: 'bridge' }), { permission: 'read', mutating: false, operation: 'get_model_routing', sessionId: null });
  assert.deepEqual(classifyCommand('set_model_routing', { bridgeId: 'bridge', config: {} }), { permission: 'control', mutating: true, operation: 'set_model_routing', sessionId: null });
  for (const command of ['model_routing', 'get_model_routing_x', 'SET_MODEL_ROUTING']) assert.throws(() => classifyCommand(command), { code: 'permission_denied' });
});

test('phase-B attention routes classify answer/escalate as control and routed as read without shadowing', () => {
  assert.deepEqual(classifyHttp('POST', '/api/sessions/session/attention/event-1_2/answer'), { permission: 'control', mutating: true, operation: 'attention_answer', sessionId: 'session' });
  assert.deepEqual(classifyHttp('POST', '/api/sessions/session/attention/event-1_2/escalate'), { permission: 'control', mutating: true, operation: 'attention_escalate', sessionId: 'session' });
  assert.deepEqual(classifyHttp('GET', '/api/sessions/session/attention/routed'), { permission: 'read', mutating: false, operation: 'attention_routed', sessionId: 'session' });
  for (const [method, path] of [
    ['GET', '/api/sessions/session/attention/event-1/answer'], ['PUT', '/api/sessions/session/attention/event-1/escalate'],
    ['DELETE', '/api/sessions/session/attention/event-1/answer'], ['POST', '/api/sessions/session/attention/routed'],
    ['DELETE', '/api/sessions/session/attention/routed'], ['GET', '/api/sessions/session/attention/routed?x=1'],
    ['POST', '/api/sessions/session/attention/event-1/answer?x=1'], ['GET', '/api/sessions/session/attention/routed/extra'],
  ]) assert.throws(() => classifyHttp(method, path), { code: 'permission_denied' }, `${method} ${path}`);
  // Body keys (to, worktree) are not classified here: classifyHttp sees no body.
  assert.equal(classifyHttp('POST', '/api/sessions').permission, 'control');
  assert.equal(classifyHttp('POST', '/api/sessions/session/attention/ask').permission, 'control');
});

test('phase-B brief routes classify per method and deny extras', () => {
  assert.deepEqual(classifyHttp('GET', '/api/sessions/session/brief'), { permission: 'read', mutating: false, operation: 'brief_get', sessionId: 'session' });
  assert.deepEqual(classifyHttp('PUT', '/api/sessions/session/brief'), { permission: 'control', mutating: true, operation: 'brief_set', sessionId: 'session' });
  assert.deepEqual(classifyHttp('DELETE', '/api/sessions/session/brief'), { permission: 'control', mutating: true, operation: 'brief_clear', sessionId: 'session' });
  assert.deepEqual(classifyHttp('POST', '/api/sessions/session/brief/notes'), { permission: 'control', mutating: true, operation: 'brief_note', sessionId: 'session' });
  for (const [method, path] of [
    ['POST', '/api/sessions/session/brief'], ['PATCH', '/api/sessions/session/brief'],
    ['GET', '/api/sessions/session/brief?x=1'], ['DELETE', '/api/sessions/session/brief?x=1'],
    ['GET', '/api/sessions/session/brief/notes'], ['PUT', '/api/sessions/session/brief/notes'],
    ['DELETE', '/api/sessions/session/brief/notes'], ['POST', '/api/sessions/session/brief/notes?x=1'],
    ['GET', `/api/sessions/${'e'.repeat(201)}/brief`], ['GET', '/api/sessions/session/brief/extra'],
  ]) assert.throws(() => classifyHttp(method, path), { code: 'permission_denied' }, `${method} ${path}`);
});

test('phase-B worktree routes classify list as read and prune as control', () => {
  assert.deepEqual(classifyHttp('GET', '/api/worktrees'), { permission: 'read', mutating: false, operation: 'worktrees_list', sessionId: null });
  assert.deepEqual(classifyHttp('POST', '/api/worktrees/prune'), { permission: 'control', mutating: true, operation: 'worktrees_prune', sessionId: null });
  for (const [method, path] of [
    ['POST', '/api/worktrees'], ['DELETE', '/api/worktrees'], ['GET', '/api/worktrees?x=1'],
    ['GET', '/api/worktrees/prune'], ['PUT', '/api/worktrees/prune'], ['POST', '/api/worktrees/prune?x=1'],
    ['GET', '/api/worktrees/other'],
  ]) assert.throws(() => classifyHttp(method, path), { code: 'permission_denied' }, `${method} ${path}`);
});

test('phase-C plan routes classify per method, validate the item id and deny extras', () => {
  assert.deepEqual(classifyHttp('GET', '/api/sessions/session/plan'), { permission: 'read', mutating: false, operation: 'plan_get', sessionId: 'session' });
  assert.deepEqual(classifyHttp('POST', '/api/sessions/session/plan'), { permission: 'control', mutating: true, operation: 'plan_add', sessionId: 'session' });
  assert.deepEqual(classifyHttp('PATCH', '/api/sessions/session/plan/p12'), { permission: 'control', mutating: true, operation: 'plan_patch', sessionId: 'session' });
  assert.deepEqual(classifyHttp('DELETE', '/api/sessions/session/plan/p123456'), { permission: 'control', mutating: true, operation: 'plan_remove', sessionId: 'session' });
  assert.deepEqual(classifyCommand('get_session_board', { bridgeId: 'bridge', sessionId: 'session' }), { permission: 'read', mutating: false, operation: 'get_session_board', sessionId: 'session' });
  for (const [method, path] of [
    ['PUT', '/api/sessions/session/plan'], ['PATCH', '/api/sessions/session/plan'], ['DELETE', '/api/sessions/session/plan'],
    ['GET', '/api/sessions/session/plan/p1'], ['POST', '/api/sessions/session/plan/p1'], ['PUT', '/api/sessions/session/plan/p1'],
    ['GET', '/api/sessions/session/plan?x=1'], ['POST', '/api/sessions/session/plan?x=1'],
    ['PATCH', '/api/sessions/session/plan/p1?x=1'], ['DELETE', '/api/sessions/session/plan/p1?x=1'],
    ['GET', '/api/sessions/session/plan/extra'], ['PATCH', '/api/sessions/session/plan/x1'],
    ['PATCH', '/api/sessions/session/plan/P1'], ['PATCH', '/api/sessions/session/plan/p'],
    ['PATCH', '/api/sessions/session/plan/p1234567'], ['PATCH', '/api/sessions/session/plan/p1a'],
    ['PATCH', '/api/sessions/session/plan/p1/extra'], ['GET', `/api/sessions/${'e'.repeat(201)}/plan`],
  ]) assert.throws(() => classifyHttp(method, path), { code: 'permission_denied' }, `${method} ${path}`);
});

test('session removal allows the worktree query once with keep or force', () => {
  assert.equal(classifyHttp('DELETE', '/api/sessions/session').operation, 'sessions_remove');
  assert.equal(classifyHttp('DELETE', '/api/sessions/session?worktree=keep').permission, 'control');
  assert.equal(classifyHttp('DELETE', '/api/sessions/session?worktree=force').permission, 'control');
  for (const path of [
    '/api/sessions/session?worktree=bogus', '/api/sessions/session?worktree=keep&worktree=force',
    '/api/sessions/session?worktree=', '/api/sessions/session?other=1', '/api/sessions/session?worktree=keep&other=1',
  ]) assert.throws(() => classifyHttp('DELETE', path), { code: 'permission_denied' }, path);
});
