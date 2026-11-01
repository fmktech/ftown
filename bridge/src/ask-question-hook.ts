/**
 * Claude Code PreToolUse hook for AskUserQuestion (`ftown-harness ask-hook`).
 * Records the question with the bridge, blocks until the human answers in the
 * dashboard, then returns the answer so Claude Code skips the terminal picker.
 *
 * Installed globally, so it runs for every Claude Code session on the machine:
 * outside ftown sessions it must exit immediately and silently. It always exits
 * 0 and writes to stdout only when it has an answer; any other outcome lets the
 * normal terminal picker run.
 */
import {
  ASK_HOOK_DEADLINE_MS,
  ATTENTION_ITEM_WAIT_MAX_SECONDS,
  type AttentionAnswerEntry,
  type AttentionAskRequest,
} from './attention-prompt-protocol.js';
import { apiResponse, loadPointer } from './cli-client.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const RETRY_DELAY_MS = 2_000;
const OUTAGE_LIMIT_MS = 60_000;
const STDIN_TIMEOUT_MS = 10_000;

export interface AskUserQuestionHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow';
    updatedInput: Record<string, unknown> & { answers: Record<string, string> };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Claude Code's documented updatedInput for AskUserQuestion: the full original
 * tool input plus `answers` keyed by the exact question text. Returns undefined
 * when the answers do not line up with the original questions.
 */
export function buildAskUserQuestionHookOutput(
  toolInput: Record<string, unknown>,
  answers: AttentionAnswerEntry[],
): AskUserQuestionHookOutput | undefined {
  const questions = toolInput.questions;
  if (!Array.isArray(questions) || questions.length !== answers.length) return undefined;
  // Claude Code keys answers by question text, so duplicate question texts collide (last one wins).
  const byQuestion: Record<string, string> = {};
  for (let i = 0; i < questions.length; i += 1) {
    const question: unknown = questions[i];
    const entry = answers[i];
    if (!isRecord(question) || typeof question.question !== 'string' || !entry || !Array.isArray(entry.selected)) return undefined;
    const options: unknown[] = Array.isArray(question.options) ? question.options : [];
    const parts: string[] = [];
    for (const index of entry.selected) {
      const option = Number.isInteger(index) ? options[index] : undefined;
      if (!isRecord(option) || typeof option.label !== 'string') return undefined;
      parts.push(option.label);
    }
    if (typeof entry.text === 'string' && entry.text.length > 0) parts.push(entry.text);
    byQuestion[question.question] = parts.join(', ');
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...toolInput, answers: byQuestion },
    },
  };
}

export interface AskHookResponse {
  status: number;
  body: unknown;
}

export interface AskHookDeps {
  readStdin: () => Promise<string>;
  env: Record<string, string | undefined>;
  /** Local bridge API. Rejects when the bridge is unreachable. */
  request: (method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal) => Promise<AskHookResponse>;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  signal?: AbortSignal;
  deadlineMs?: number;
}

function ok(response: AskHookResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

/** Always resolves 0. Writes stdout only when there is an answer to hand back. */
export async function runAskHook(deps: AskHookDeps): Promise<0> {
  const { signal } = deps;
  const aborted = (): boolean => signal?.aborted === true;
  try {
    const sessionId = deps.env.FTOWN_SESSION_ID;
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return 0;

    const input: unknown = JSON.parse(await deps.readStdin());
    if (!isRecord(input) || input.tool_name !== 'AskUserQuestion' || !isRecord(input.tool_input) || typeof input.tool_use_id !== 'string') return 0;
    const toolInput = input.tool_input;
    if (aborted()) return 0;

    const base = `/api/sessions/${sessionId}`;
    const session = await deps.request('GET', base, undefined, signal);
    if (!ok(session) || !isRecord(session.body)) return 0;
    const capabilities = session.body.capabilities;
    const attention = isRecord(capabilities) ? capabilities.attention : undefined;
    if (!isRecord(attention) || attention.prompt !== true) return 0;

    const askBody: AttentionAskRequest = { toolName: 'AskUserQuestion', toolUseId: input.tool_use_id, toolInput };
    let asked: AskHookResponse;
    try {
      asked = await deps.request('POST', `${base}/attention/ask`, askBody, signal);
    } catch {
      if (aborted()) return 0;
      // Transport failure: retry once. Safe because the store dedups unresolved items by tool_use_id.
      await deps.sleep(RETRY_DELAY_MS, signal);
      if (aborted()) return 0;
      asked = await deps.request('POST', `${base}/attention/ask`, askBody, signal);
    }
    if (!ok(asked) || !isRecord(asked.body) || !isRecord(asked.body.event) || typeof asked.body.event.id !== 'string') return 0;
    const itemPath = `${base}/attention/${encodeURIComponent(asked.body.event.id)}`;

    const deadlineAt = deps.now() + (deps.deadlineMs ?? ASK_HOOK_DEADLINE_MS);
    let lastSuccess = deps.now();
    while (!aborted()) {
      const remaining = deadlineAt - deps.now();
      if (remaining <= 0) return 0;
      const waitSeconds = Math.max(1, Math.min(ATTENTION_ITEM_WAIT_MAX_SECONDS, Math.ceil(remaining / 1000)));
      let response: AskHookResponse | undefined;
      try {
        response = await deps.request('GET', `${itemPath}?waitSeconds=${waitSeconds}`, undefined, signal);
      } catch {
        if (aborted()) return 0;
      }
      if (response && response.status === 404) return 0;
      if (response && ok(response) && isRecord(response.body) && isRecord(response.body.event)) {
        lastSuccess = deps.now();
        const item = response.body.event;
        if (item.resolution === 'answered' && isRecord(item.answer) && Array.isArray(item.answer.answers)) {
          const output = buildAskUserQuestionHookOutput(toolInput, item.answer.answers as AttentionAnswerEntry[]);
          if (output && !aborted()) deps.writeStdout(JSON.stringify(output));
          return 0;
        }
        if (item.resolution !== undefined || item.resolvedAt !== undefined) return 0;
        continue;
      }
      if (deps.now() - lastSuccess > OUTAGE_LIMIT_MS) return 0;
      await deps.sleep(RETRY_DELAY_MS, signal);
    }
    return 0;
  } catch (error) {
    if (!aborted()) deps.writeStderr(`ftown ask-hook: ${error instanceof Error ? error.message : String(error)}\n`);
    return 0;
  }
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  const killer = setTimeout(() => { process.stdin.destroy(); }, STDIN_TIMEOUT_MS);
  killer.unref();
  try {
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  } finally {
    clearTimeout(killer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Wires real stdin/stdout, the bridge local API (same pointer + auth as the other harness commands) and signals. */
export async function runAskHookCli(): Promise<number> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await runAskHook({
      readStdin: readStdinText,
      env: process.env,
      request: async (method, path, body, requestSignal) => {
        const result = await apiResponse(loadPointer(), method, path, body, undefined, requestSignal);
        return { status: result.status, body: result.body };
      },
      now: () => Date.now(),
      sleep: abortableSleep,
      writeStdout: (text) => { process.stdout.write(text); },
      writeStderr: (text) => { process.stderr.write(text); },
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
