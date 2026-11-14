// Whitelist for agent events entering the canonical log: each event is rebuilt from the
// contract's AgentEvent fields only, and every string is checked against what the contract
// allows. Anything else becomes 'invalid' and is counted (the count goes to verdicts.json).
import { ASK_TAG_RE, MAIL_TAG_RE, ROLES } from '../contract.ts';
import type { AgentEvent, MailType, Role } from '../contract.ts';

const MAIL_TYPES: readonly string[] = ['message', 'task', 'result', 'escalation', 'fyi'];
const HOOKS: readonly string[] = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const ANSWERS: readonly string[] = ['yes', 'no'];
/** Fixed lowercase tokens, optionally followed by more words or a number ("exit 1", "unparseable output"). */
const TOKEN_RE = /^[a-z_]+( [a-z_0-9]+){0,3}$/;
export const INVALID = 'invalid';

export interface Sanitized {
  /** null when the event is not canonical (stdin_line, unknown ev). */
  e: AgentEvent | null;
  invalid: number;
}

export function sanitizeAgentEvent(raw: unknown): Sanitized {
  let invalid = 0;
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, ok: (s: string) => boolean): string => {
    if (typeof v === 'string' && ok(v)) return v;
    invalid++;
    return INVALID;
  };
  const tag = (v: unknown) => str(v, (s) => MAIL_TAG_RE.test(s) && s === `CHAOS-M-${MAIL_TAG_RE.exec(s)?.[1]}`);
  const askTag = (v: unknown) => str(v, (s) => ASK_TAG_RE.test(s) && s === `CHAOS-Q-${ASK_TAG_RE.exec(s)?.[1]}`);
  const type = (v: unknown) => str(v, (s) => MAIL_TYPES.includes(s)) as MailType;
  const role = (v: unknown) => str(v, (s) => (ROLES as readonly string[]).includes(s)) as Role;
  const from = (v: unknown) => str(v, (s) => (ROLES as readonly string[]).includes(s) || s === 'external' || s === 'unknown') as Role | 'external' | 'unknown';
  const bool = (v: unknown): boolean => {
    if (typeof v === 'boolean') return v;
    invalid++;
    return false;
  };
  const int = (v: unknown): number => {
    if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
    invalid++;
    return 0;
  };
  const error = (v: unknown): string | null => (v === null ? null : str(v, (s) => s.length <= 40 && TOKEN_RE.test(s)));
  let e: AgentEvent | null;
  switch (o.ev) {
    case 'stdin_line':
      return { e: null, invalid: 0 };
    case 'start':
      e = { ev: 'start', pid: 0 };
      break;
    case 'nudge':
      e = { ev: 'nudge', n: int(o.n) };
      break;
    case 'mail_received':
      e = { ev: 'mail_received', tag: tag(o.tag), type: type(o.type), fromRole: from(o.fromRole) };
      break;
    case 'mail_sent':
      e = { ev: 'mail_sent', tag: tag(o.tag), to: role(o.to), type: type(o.type), accepted: bool(o.accepted), error: error(o.error) };
      break;
    case 'ask_sent':
      e = { ev: 'ask_sent', askTag: askTag(o.askTag), accepted: bool(o.accepted), error: error(o.error) };
      break;
    case 'answer_received':
      e = { ev: 'answer_received', askTag: askTag(o.askTag), answer: str(o.answer, (s) => ANSWERS.includes(s)), via: str(o.via, (s) => s === 'waiter' || s === 'mail') as 'waiter' | 'mail' };
      break;
    case 'routed_answer_sent':
      e = { ev: 'routed_answer_sent', askTag: askTag(o.askTag), accepted: bool(o.accepted), error: error(o.error) };
      break;
    case 'hook_sent':
      e = { ev: 'hook_sent', event: str(o.event, (s) => HOOKS.includes(s)), ok: bool(o.ok) };
      break;
    case 'cli_error':
      e = { ev: 'cli_error', cmd: str(o.cmd, (s) => s.length <= 24 && /^[a-z_]+( [a-z_]+)?$/.test(s)), error: str(o.error, (s) => s.length <= 40 && TOKEN_RE.test(s)) };
      break;
    case 'exit':
      e = { ev: 'exit', code: int(o.code) };
      break;
    default:
      return { e: null, invalid: 1 };
  }
  return { e, invalid };
}
