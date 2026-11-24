import { legacyDiscussionReplyHint } from './wire-types.js';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { GrokHookPayload, HookAdapter, HookEnvironment, JsonObject, JsonValue } from './hook-contract.js';

const POINTER = '[ftown mail truncated: run `ftown sessions inbox --all --peek` to read the full messages]';

async function findFtown(env: HookEnvironment): Promise<string | undefined> {
  const paths = (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir || '.', 'ftown'));
  if (env.HOME) paths.push(join(env.HOME, '.ftown', 'bin', 'ftown'));
  for (const path of paths) {
    try { await access(path, constants.X_OK); return path; } catch { /* try next */ }
  }
  return undefined;
}

function jqString(value: JsonValue | undefined, fallback: string): string {
  if (value === undefined || value === null || value === false) return fallback;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Read delivered mail through the authenticated local proxy. Any failure permits Stop. */
async function drainMail(env: HookEnvironment, sessionId: string): Promise<string | undefined> {
  const cli = await findFtown(env);
  if (!cli) return undefined;
  const request = JSON.stringify({ method: 'GET', path: `/api/sessions/${encodeURIComponent(sessionId).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}/inbox?wait=0`, timeoutMs: 2000 });
  const response = await new Promise<string | undefined>((resolve) => {
    const child = spawn(cli, ['security', 'proxy'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 4000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 10 * 1024 * 1024) chunks.push(chunk);
      else child.kill();
    });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined); });
    child.stdin.on('error', () => {});
    child.stdin.end(request);
  });
  if (!response) return undefined;
  try {
    const data = JSON.parse(response) as { status?: number; body?: { messages?: JsonValue[] } };
    if (typeof data.status !== 'number' || data.status < 200 || data.status >= 300 || !Array.isArray(data.body?.messages) || !data.body.messages.length) return undefined;
    const lines = data.body.messages.map((entry) => {
      const msg = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      return `[${jqString(msg.ts, '')}] ${jqString(msg.fromName, jqString(msg.from, 'external'))} (${jqString(msg.type, 'message')}): ${jqString(msg.body, '')}${legacyDiscussionReplyHint(msg)}`;
    });
    let reason = `[ftown mail]\n${lines.join('\n')}`;
    const chars = Array.from(reason);
    if (chars.length > 9500) reason = `${chars.slice(0, 9500).join('')}\n${POINTER}`;
    return JSON.stringify({ decision: 'block', reason });
  } catch { return undefined; }
}

export const grokHookAdapter: HookAdapter = async ({ input, env, post }) => {
  if (!env.FTOWN_SESSION_ID) return { status: 'ok' };
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch {
    return { status: 'error', error: { kind: 'invalid-json', message: 'native hook payload is not valid JSON' } };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'error', error: { kind: 'invalid-input', message: 'native hook payload must be a JSON object' } };
  }
  const native = parsed as JsonObject;
  if (typeof native.hook_event_name !== 'string' || !native.hook_event_name) return { status: 'ok' };
  const event = native.hook_event_name;
  if (event === 'Stop' && (native.reason === 'shutdown' || native.reason === 'channel_closed')) return { status: 'ok' };
  const payload: GrokHookPayload = {
    ftown_session_id: env.FTOWN_SESSION_ID,
    ftown_session_source: 'env',
    hook_event_name: event,
    session_id: typeof native.session_id === 'string' && native.session_id ? native.session_id : env.GROK_SESSION_ID ?? '',
    cwd: typeof native.cwd === 'string' ? native.cwd : '',
  };
  for (const key of ['tool_name', 'tool_input', 'tool_use_id'] as const) {
    if (native[key] != null) payload[key] = native[key];
  }
  if (event === 'Stop' && native.reason === 'end_turn') {
    const decision = await drainMail(env, env.FTOWN_SESSION_ID);
    if (decision) return { status: 'ok', stdout: decision };
  }
  const result = await post(payload);
  return result.ok ? { status: 'ok' } : { status: 'error', error: { kind: result.error.kind, message: result.error.message } };
};
