import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAttentionHook, sanitizeAttentionText } from './attention-events.js';

test('attention requires allowlisted genuine Notification or ask-user hooks', () => {
  assert.deepEqual(classifyAttentionHook('Notification', { notification_type: 'idle_prompt', message: 'permission required' }), {});
  assert.equal(classifyAttentionHook('Stop', { message: 'please approve' }).attention, undefined);
  assert.equal(classifyAttentionHook('PostToolUse', { tool_name: 'AskUserQuestion' }).attention, undefined);
  for (const tool_name of ['AskUserQuestion', 'functions.request_user_input', 'mcp__ftown__ask_user']) {
    const result = classifyAttentionHook('PreToolUse', { tool_name, tool_input: { questions: [{ question: 'Which branch?' }] }, secret: 'never-copy-this' });
    assert.equal(result.attention?.type, 'ask_user');
    assert.equal(result.attention?.message, 'Which branch?');
    assert.ok(!JSON.stringify(result).includes('never-copy-this'));
  }
  assert.equal(classifyAttentionHook('Notification', { notification_type: 'permission_prompt' }).attention?.type, 'permission_prompt');
});

test('excerpts are bounded plain text with common credential formats redacted', () => {
  const result = classifyAttentionHook('Notification', {
    notification_type: 'agent_needs_input', title: 'x'.repeat(300),
    message: '\x1b[31mQuestion\x1b[0m\x00 API_KEY=topsecret Bearer abc.def.ghi ' + 'z'.repeat(3000),
    env: { SUPER_SECRET: 'never-copy-this' },
  });
  assert.equal(result.attention?.title.length, 200);
  assert.equal(result.attention?.message.length, 2000);
  assert.ok(!JSON.stringify(result).includes('topsecret'));
  assert.ok(!JSON.stringify(result).includes('abc.def.ghi'));
  assert.ok(!JSON.stringify(result).includes('never-copy-this'));
  assert.equal(sanitizeAttentionText('\x1b]8;;https://evil\x07hello\x1b]8;;\x07', 200), 'hello');
});

test('unrelated tools and Stop do not resolve questions; explicit continuation does', () => {
  assert.equal(classifyAttentionHook('PostToolUse', {}).resolve, undefined);
  assert.equal(classifyAttentionHook('Stop', {}).resolve, undefined);
  assert.equal(classifyAttentionHook('UserPromptSubmit', {}).resolve, 'user_prompt');
  assert.equal(classifyAttentionHook('Notification', { notification_type: 'elicitation_complete' }).resolve, 'elicitation_complete');
  assert.equal(classifyAttentionHook('SessionEnd', {}).resolve, 'session_end');
});
