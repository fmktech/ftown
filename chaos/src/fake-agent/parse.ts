// Pure parsers for the text the real ftown CLI and bridge produce. No I/O.
// Each format names the bridge source it was copied from.
import { ASK_TAG_RE, MAIL_TAG_RE, ROLES } from '../contract.ts';
import type { MailType, Role } from '../contract.ts';

const MAIL_TYPE_SET: ReadonlySet<string> = new Set(['message', 'task', 'result', 'escalation', 'fyi']);

// Strip terminal escapes (bracketed paste markers, colours) and a trailing CR before matching.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function cleanLine(raw: string): string {
  return raw.replace(ANSI_RE, '').replace(/\r/g, '').trim();
}

/**
 * Nudge line. Source: bridge/src/mail-delivery.ts formatNudgeText (74-87):
 *   `[ftown] ${total} new mail (${parts}) — run: ftown harness mail read` + optional ` | digest`.
 */
// The bridge types the nudge into the session's PTY with a sender prefix
// (bridge/src/mail-delivery.ts:455-456, injectPtyLine; prefix text at :40):
//   agent shells: `[ftown msg from <sender>] <nudge>`
//   plain shells: `: '[ftown msg from <sender>] <nudge>'`
// Only the start of the line is accepted, so a line that merely quotes the text mid-line is not a nudge.
const NUDGE_RE = /^(?:: ')?(?:\[ftown msg from [^\]]*\] )?\[ftown\] (\d+) new mail \(/;

export function parseNudge(line: string): { n: number } | null {
  const m = NUDGE_RE.exec(cleanLine(line));
  if (!m) return null;
  return { n: Number(m[1]) };
}

export interface ParsedMail {
  id: string;
  from: string;
  type: MailType;
  body: string;
}

/**
 * `ftown harness --json mail read` output. Source: bridge/src/harness-commands.ts cmdMailRead
 * (emit(true, { sessionId, messages }) with MailMessage from bridge/src/types.ts:90).
 */
export function parseMailRead(stdout: string): ParsedMail[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const messages = (raw as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  const out: ParsedMail[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const m = entry as Record<string, unknown>;
    if (typeof m.body !== 'string') continue;
    const type = typeof m.type === 'string' && MAIL_TYPE_SET.has(m.type) ? (m.type as MailType) : 'message';
    out.push({
      id: typeof m.id === 'string' ? m.id : '',
      from: typeof m.from === 'string' ? m.from : '',
      type,
      body: m.body,
    });
  }
  return out;
}

/** Body convention from the contract: `CHAOS-M-<n> from=<role|external> to=<role>`. */
export function parseChaosMail(body: string): { tag: string; fromRole: Role | 'external' | 'unknown' } | null {
  const m = MAIL_TAG_RE.exec(body);
  if (!m) return null;
  const from = /(?:^|\s)from=(\S+)/.exec(body)?.[1];
  let fromRole: Role | 'external' | 'unknown' = 'unknown';
  if (from === 'external') fromRole = 'external';
  else if (from && (ROLES as readonly string[]).includes(from)) fromRole = from as Role;
  return { tag: `CHAOS-M-${m[1]}`, fromRole };
}

export function askTagOf(title: string): string | null {
  const m = ASK_TAG_RE.exec(title.trim());
  return m ? `CHAOS-Q-${m[1]}` : null;
}

export interface EscalationMail {
  eventId: string;
  childName: string;
  childId: string;
  title: string;
  askTag: string | null;
}

/**
 * Parent-escalation mail for a child question. Source: bridge/src/coordination/attention-routing.ts
 * formatParentQuestionMail (header, 44):
 *   `[ftown question id=<event> from=<child name> (<child id>)] <title>\n<message>\n…`
 * with PARENT_QUESTION_PREFIX = '[ftown question' (bridge/src/coordination/contract-b.ts:55).
 * The test in bridge/src/local-api-server.test.ts:1524 pins the same shape.
 */
export function parseEscalationMail(body: string): EscalationMail | null {
  const first = body.split('\n', 1)[0] ?? '';
  const m = /^\[ftown question id=(\S+) from=(.*?) \(([A-Za-z0-9_-]+)\)\] (.*)$/.exec(first);
  if (!m) return null;
  const title = m[4].trim();
  return { eventId: m[1], childName: m[2], childId: m[3], title, askTag: askTagOf(title) };
}

export interface AttentionAnswerMail {
  eventId: string;
  title: string;
  askTag: string | null;
  answer: string;
}

/**
 * Answer delivered as mail. Source: bridge/src/attention-prompt.ts formatAttentionAnswerMail
 * (314-324): `[ftown attention answer id=<id>]\nRe: <title>\n\nQ: <question>\nA: <labels>`.
 */
export function parseAttentionAnswerMail(body: string): AttentionAnswerMail | null {
  const lines = body.split('\n');
  const m = /^\[ftown attention answer id=(\S+?)\]$/.exec(lines[0] ?? '');
  if (!m) return null;
  let title = '';
  for (const line of lines.slice(1)) {
    if (line.startsWith('Re: ')) {
      title = line.slice(4).trim();
      break;
    }
  }
  const answer = parseAnswerText(body);
  return { eventId: m[1], title, askTag: askTagOf(title), answer: answer ?? '' };
}

/** First `A: <text>` line (bridge/src/attention-prompt.ts formatAttentionAnswerText, 297-312). */
export function parseAnswerText(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.startsWith('A: ')) return line.slice(3).trim();
  }
  return null;
}

/**
 * `ftown sessions attention --wait` stdout on success: the formatted answer text
 * (bridge/src/sessions-commands.ts reportAttentionItem, 281-286): `Q: <message>\nA: <label>`.
 */
export function parseWaitAnswer(stdout: string): string | null {
  return parseAnswerText(stdout);
}

/**
 * `ftown sessions attention --wait` prints the event id on stderr as soon as it is created:
 * `Waiting for an answer (attention <id>)...` (bridge/src/sessions-commands.ts:307).
 * Without --wait the line is `Event id: <id>. Check later: …` (same file, ~line 446).
 */
export function parseWaitEventId(stderr: string): string | null {
  const m = /Waiting for an answer \(attention (\S+?)\)\.\.\./.exec(stderr) ?? /Event id: (\S+?)\. /.exec(stderr);
  return m ? m[1] : null;
}

/**
 * Normalised reason for a failed CLI call. The first matching rule wins; the result never
 * contains ids, ports, paths or times. Rules come from the real CLI error paths:
 *  - bridge/src/security/bridge/local-client.ts:27  `Bridge security: bridge_offline` (envelope POST not ok)
 *    and :12-32 other typed codes (upgrade_required, wrong_context, expired); errors.ts:8 message shape
 *    `Bridge security: <code>`; identity.ts:27 key_unavailable; execute.ts:37 outcome_unknown/permission_denied
 *  - bridge/src/cli-client.ts:20,22  `Bridge not running (no valid <path>)…` / `Invalid <path> — missing port or token`
 *  - bridge/src/cli-client.ts:35  `HTTP <status>` or the bridge's `error` string (local-api-server.ts:651,975:
 *    `Session not found`, `Unauthorized`)
 *  - bridge/src/attention-cli.ts:278  `Attention item <id> is already resolved` (exit 5; 403 => exit 4 at :354)
 *  - Node fetch failures (`fetch failed`, ECONNREFUSED/ECONNRESET/UND_ERR_*) when the bridge socket is down
 *  - the agent's own timeout (exit code 124 from cli.ts run())
 */
export function normaliseCliError(code: number, stdout: string, stderr: string): string {
  const text = `${stderr}\n${stdout}`;
  const rules: [RegExp, string][] = [
    [/Bridge security: bridge_offline|bridge_offline/, 'bridge_offline'],
    [/Bridge not running|missing port or token|ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR|fetch failed|cannot connect|socket hang up/i, 'bridge_unreachable'],
    [/\bUnauthorized\b|\bHTTP 40[13]\b|\b401\b|invalid token/i, 'unauthorized'],
    [/already resolved|already answered/i, 'attention_already_resolved'],
    [/permission_denied|\bForbidden\b|\bHTTP 403\b/i, 'permission_denied'],
    [/not found|unknown_session|\bHTTP 404\b|No session matching/i, 'not_found'],
    [/Bridge security: (expired|wrong_context|key_unavailable|outcome_unknown|upgrade_required)/, ''],
    [/timed out|\bTimeoutError\b|\bETIMEDOUT\b/i, 'timeout'],
  ];
  if (code === 124) return 'timeout';
  for (const [re, reason] of rules) {
    const m = re.exec(text);
    if (!m) continue;
    return reason === '' ? m[1] : reason;
  }
  return `exit ${code}`;
}
