#!/usr/bin/env node
// ROOT-RUN ONLY: real Claude + copied Mod, entirely synthetic loopback inbox and
// Anthropic API. No user credentials, production sessions or real model calls.
// Run from bridge: node scripts/claude-mod-smoke.mjs
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { spawn } = require('node-pty');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'ftown-claude-mod-smoke-'));
const home = join(temporary, 'home');
const config = join(home, '.claude');
const workspace = join(temporary, 'work');
const mod = join(temporary, 'claude-mod');
const sessionId = randomUUID();
const token = randomUUID();
const dummyApiKey = 'sk-ant-api03-ftown-loopback-smoke-only';
const marker = 'PRIVATE_INBOX_BODY_MUST_NOT_REACH_MODEL';
let messages = [{ id: 'mail-one', body: marker }];
const polls = [];
const wakes = [];
let held;
let terminal;
let terminalExit;
let transcript = '';
let failure;
const servers = [];

function fail(error) { failure ??= error; }
async function waitFor(predicate, description, timeout = 45000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (failure) throw failure;
    if (terminalExit) throw new Error(`Claude exited before ${description}: ${terminalExit.exitCode}`);
    if (Date.now() > end) throw new Error(`Timed out waiting for ${description}; retained terminal tail: ${transcript.slice(-2000)}`);
    await delay(100);
  }
}
async function listen(handler) {
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch((error) => { fail(error); if (!res.headersSent) res.writeHead(500); res.end(); }); });
  servers.push(server);
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return server.address().port;
}
function sendJson(res, body) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function sse(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
function complete(res, model, streaming) {
  if (!streaming) return sendJson(res, { id: randomUUID(), type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'FTOWN_SMOKE_DONE' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'FTOWN_SMOKE_DONE' } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  sse(res, 'message_stop', { type: 'message_stop' }); res.end();
}

try {
  mkdirSync(config, { recursive: true }); mkdirSync(workspace);
  const canonicalWorkspace = realpathSync(workspace);
  cpSync(join(packageRoot, 'claude-mod'), mod, { recursive: true });
  writeFileSync(join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.302', theme: 'dark',
    customApiKeyResponses: { approved: [dummyApiKey.slice(-20)], rejected: [] },
    projects: { [canonicalWorkspace]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [], mcpServers: {} } },
  }), { mode: 0o600 });
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }), { mode: 0o600 });
  const inboxPort = await listen((req, res) => {
    assert.equal(req.method, 'GET');
    const url = new URL(req.url, 'http://127.0.0.1');
    assert.equal(url.pathname, `/api/sessions/${sessionId}/inbox`);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(url.searchParams.get('peek'), '1'); assert.equal(url.searchParams.get('wait'), '0');
    assert.equal(url.searchParams.get('adapter'), 'claude-mod');
    assert.match(url.searchParams.get('nativeSessionId') ?? '', /^[0-9a-f-]{36}$/i);
    polls.push({ nativeId: url.searchParams.get('nativeSessionId'), at: Date.now() });
    sendJson(res, { messages });
  });
  const modelPort = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let text = ''; for await (const chunk of req) text += chunk;
    if (url.pathname.endsWith('/count_tokens')) return sendJson(res, { input_tokens: 32 });
    if (!url.pathname.endsWith('/messages')) return sendJson(res, {});
    const body = JSON.parse(text);
    assert.doesNotMatch(text, new RegExp(marker));
    const visible = JSON.stringify(body.messages);
    const isWake = visible.includes('ftown harness mail read');
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      sse(res, 'message_start', { type: 'message_start', message: { id: randomUUID(), type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    }
    // Count the newest user message, not the retained earlier wake in history.
    const lastUser = [...body.messages].reverse().find((item) => item.role === 'user');
    const newestWake = JSON.stringify(lastUser).includes('ftown harness mail read');
    if (isWake && newestWake) {
      assert.match(JSON.stringify(lastUser), /ftown-mail/);
      wakes.push({ at: Date.now() });
      if (wakes.length === 1) { held = () => complete(res, body.model, body.stream); return; }
    }
    complete(res, body.model, body.stream);
  });
  const env = {
    PATH: process.env.PATH ?? '', SHELL: process.env.SHELL ?? '/bin/sh', TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: dummyApiKey, ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
    DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    FTOWN_SESSION_ID: sessionId, FTOWN_HOOK_PORT: String(inboxPort), FTOWN_HOOK_TOKEN: token,
  };
  terminal = spawn(process.env.FTOWN_SMOKE_CLAUDE_BIN || 'claude', ['--allow-dangerously-skip-permissions', '--plugin-dir', mod, '--model', 'claude-sonnet-4-6'], { cwd: canonicalWorkspace, env, cols: 120, rows: 36 });
  terminal.onData((data) => { transcript = (transcript + data).slice(-30000); });
  terminal.onExit((event) => { terminalExit = event; });
  // No initial prompt or typed message: the first model turn must be native wake.
  await waitFor(() => wakes.length === 1 && held, 'idle Mod wake');
  const initialPolls = polls.length;
  messages = [...messages, { id: 'mail-two', body: marker }];
  await waitFor(() => polls.length >= initialPolls + 3, 'heartbeats while first turn remains busy');
  assert.equal(wakes.length, 1, 'busy follow-up must wait for idle');
  held(); held = undefined;
  await waitFor(() => wakes.length === 2, 'deferred busy Mod wake');
  const afterSecond = polls.length;
  await waitFor(() => polls.length >= afterSecond + 3, 'unread-ID wake suppression');
  assert.equal(wakes.length, 2, 'same unread batch must not wake repeatedly');
  assert.equal(new Set(polls.map((poll) => poll.nativeId)).size, 1);
  console.log(JSON.stringify({ ok: true, realClaudeMod: true, idleWake: true, busyDeferredWake: true, heartbeatPolls: polls.length, wakeTurns: wakes.length, bodyLeak: false }));
} finally {
  if (terminal && !terminalExit) {
    terminal.write('/exit\r');
    const until = Date.now() + 3000;
    while (!terminalExit && Date.now() < until) await delay(50);
    if (!terminalExit) { terminal.kill('SIGTERM'); await delay(250); }
    if (!terminalExit) terminal.kill('SIGKILL');
  }
  for (const server of servers) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  rmSync(temporary, { recursive: true, force: true });
}
