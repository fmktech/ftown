import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCommand, classifyHttp, classifyTerminal } from './permissions.js';

test('reads cannot consume inboxes or register native wake targets, while POST history search remains read-only', () => {
  assert.equal(classifyHttp('GET', '/api/sessions/session/inbox').permission, 'control');
  assert.equal(classifyHttp('GET', '/api/sessions/session/inbox?peek=1').permission, 'read');
  assert.equal(classifyHttp('GET', '/api/sessions/session/inbox?peek=1&peek=0').permission, 'control');
  assert.equal(classifyHttp('GET', '/api/sessions/session/inbox?peek=1&adapter=opencode&nativeSessionId=agent').permission, 'control');
  assert.equal(classifyHttp('POST', '/api/sessions/session/grep').permission, 'read');
  assert.equal(classifyCommand('mcp_request', { request: { method: 'GET', path: '/api/sessions/session/inbox' } }).permission, 'control');
});

test('actual operations determine permission and unknown methods/routes/frames deny by default', () => {
  assert.equal(classifyCommand('get_history', { sessionId: 'session' }).permission, 'read');
  assert.equal(classifyCommand('bridge_exec', { mutating: false }).permission, 'control');
  assert.equal(classifyCommand('security_activity').permission, 'admin');
  assert.equal(classifyTerminal('attach').permission, 'read');
  assert.equal(classifyTerminal('input').permission, 'control');
  assert.equal(classifyTerminal('resize').permission, 'control');
  for (const [method, path] of [
    ['GET', '//evil/api/sessions'], ['GET', '/api/sessions/../archive'], ['GET', '/api/sessions/%73ession'],
    ['POST', '/api/sessions/session/usage'], ['PUT', '/api/sessions/session'], ['GET', '/api/browser/devices'],
    ['DELETE', '/api/sessions/session/attention'],
  ]) assert.throws(() => classifyHttp(method, path), { code: 'permission_denied' });
  for (const command of ['unknown', 'security_activate_mcp', 'security_update_policy']) assert.throws(() => classifyCommand(command), { code: 'permission_denied' });
  for (const frame of ['screen', 'output', 'arbitrary']) assert.throws(() => classifyTerminal(frame), { code: 'permission_denied' });
});
