// The scripted fake agent: executes AgentScript steps through the real ftown CLI and records
// what it saw and did as AgentEvents. All I/O is injected; time comes only from the Clock.
import { PARENT_OF, ROLES } from '../contract.ts';
import type { AgentEvent, AgentScript, AgentStep, Clock, MailType, Role } from '../contract.ts';
import {
  askTagOf,
  parseAttentionAnswerMail,
  parseChaosMail,
  parseEscalationMail,
  parseMailRead,
  parseNudge,
  parseWaitAnswer,
  normaliseCliError,
  parseWaitEventId,
} from './parse.ts';
import type { EscalationMail } from './parse.ts';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliOpts {
  stdin?: string;
  timeoutMs?: number;
  /** Called with stderr chunks while the process runs (used to see an event id as it is printed). */
  onStderr?: (chunk: string) => void;
}

export interface AgentState {
  nextTag: number;
  cursor: number;
}

export interface StateStore {
  /** Returns null when no state file exists yet; throws on corrupt/unreadable state. */
  load(): AgentState | null;
  save(state: AgentState): void;
}

export interface AgentDeps {
  script: AgentScript;
  clock: Clock;
  /** Runs `node $FTOWN_CLI <args>`. A timeout resolves with code 124. */
  cli: (args: string[], opts?: CliOpts) => Promise<CliResult>;
  /** Posts a hook event through the real hook script; true when it exited 0. */
  hook: (event: string) => Promise<boolean>;
  log: (e: AgentEvent) => void;
  stdinLines: AsyncIterable<string>;
  /** Raw stderr+stdout of a failed call, for the (unhashed) sidecar file. */
  rawFailure?: (cmd: string, r: CliResult) => void;
  /** Session id of another role (from CHAOS_IDS_FILE), or null when unknown. */
  resolveId?: (role: Role) => string | null;
  /** Per-role persistent state ({ nextTag, cursor }). */
  state?: StateStore;
  /** Writes fatal diagnostics. Defaults to process.stderr.write. */
  stderr?: (msg: string) => void;
  /** Ends the process for the `exit` step or fatal error. Defaults to process.exit. */
  exit?: (code: number) => void;
  pid?: number;
}

export interface AgentResult {
  /** Exit code when the script ended with an `exit` step, otherwise null. */
  exitCode: number | null;
}

const MAIL_READ_TIMEOUT_MS = 60_000;
const CLI_TIMEOUT_MS = 60_000;
/** Longer than any run; the bridge or the CLI decides when a wait ends, not the agent. */
const ASK_TIMEOUT_MS = 86_500_000;
const ASK_WAIT_SECONDS = '86400';

function failure(r: CliResult): string {
  return normaliseCliError(r.code, r.stdout, r.stderr);
}

export async function runAgent(deps: AgentDeps): Promise<AgentResult> {
  const { script, clock, cli, hook, log } = deps;
  const role = script.role;
  const resolveId = deps.resolveId ?? (() => null);
  let nextTag = 1000 * (ROLES.indexOf(role) + 1);
  let cursor = 0;
  let exited: number | null = null;
  const persist = (): void => {
    deps.state?.save({ nextTag, cursor });
  };
  const background: Promise<void>[] = [];
  const pendingRouted: EscalationMail[] = [];

  const cliError = (cmd: string, r: CliResult): void => {
    deps.rawFailure?.(cmd, r);
    log({ ev: 'cli_error', cmd, error: failure(r) });
  };

  const answerRouted = async (q: EscalationMail, optionIndex: number): Promise<void> => {
    const askTag = q.askTag ?? q.title;
    const r = await cli(
      ['attention', 'answer', q.childId, q.eventId, '--option', String(optionIndex + 1)],
      { timeoutMs: CLI_TIMEOUT_MS },
    );
    if (r.code === 0) {
      log({ ev: 'routed_answer_sent', askTag, accepted: true, error: null });
    } else {
      log({ ev: 'routed_answer_sent', askTag, accepted: false, error: failure(r) });
      cliError('attention answer', r);
    }
  };

  const doRead = async (): Promise<void> => {
    try {
      await readOnce();
    } catch {
      // A failing read must never reject the chain or end the process.
      log({ ev: 'cli_error', cmd: 'mail read', error: 'exception' });
    }
  };

  const readOnce = async (): Promise<void> => {
    const r = await cli(['harness', '--json', 'mail', 'read'], { timeoutMs: MAIL_READ_TIMEOUT_MS });
    if (r.code !== 0) {
      cliError('mail read', r);
      return;
    }
    const mails = parseMailRead(r.stdout);
    if (mails === null) {
      log({ ev: 'cli_error', cmd: 'mail read', error: 'unparseable output' });
      return;
    }
    for (const mail of mails) {
      const chaos = parseChaosMail(mail.body);
      if (chaos) {
        log({ ev: 'mail_received', tag: chaos.tag, type: mail.type, fromRole: chaos.fromRole });
        continue;
      }
      const esc = parseEscalationMail(mail.body);
      if (esc) {
        if (script.answerRoutedQuestions) await answerRouted(esc, 0);
        else pendingRouted.push(esc);
        continue;
      }
      const ans = parseAttentionAnswerMail(mail.body);
      if (ans) {
        log({ ev: 'answer_received', askTag: ans.askTag ?? ans.title, answer: ans.answer, via: 'mail' });
      }
    }
  };

  // Mail reads are serialised: each one starts only after the previous one finished.
  let readChain: Promise<void> = Promise.resolve();
  const enqueueRead = (): Promise<void> => {
    const run = readChain.then(doRead);
    readChain = run.catch(() => undefined);
    return run;
  };

  const consumeStdin = async (): Promise<void> => {
    for await (const line of deps.stdinLines) {
      if (exited !== null) continue;
      log({ ev: 'stdin_line', text: line });
      const nudge = parseNudge(line);
      if (nudge) {
        log({ ev: 'nudge', n: nudge.n });
        if (script.readMailOnNudge) background.push(enqueueRead());
      }
    }
  };

  const sendMail = async (to: Role | 'parent', type: MailType, body: string): Promise<void> => {
    const target: Role = to === 'parent' ? (PARENT_OF[role] ?? role) : to;
    const tag = `CHAOS-M-${nextTag++}`;
    persist();
    const text = `${tag} from=${role} to=${target}${body ? ` ${body}` : ''}`;
    const record = (accepted: boolean, error: string | null): void => {
      log({ ev: 'mail_sent', tag, to: target, type, accepted, error });
    };
    const base = ['harness', '--json', 'mail', 'send'];
    let args: string[];
    if (to === 'parent' || target === PARENT_OF[role]) {
      if (PARENT_OF[role] === null) return record(false, 'no parent');
      args = [...base, '--parent', '--type', type, text];
    } else {
      const id = resolveId(target);
      if (!id) return record(false, 'unknown recipient');
      args = [...base, id, '--type', type, text];
    }
    const r = await cli(args, { timeoutMs: CLI_TIMEOUT_MS });
    if (r.code === 0) {
      record(true, null);
    } else {
      record(false, failure(r));
      cliError('mail send', r);
    }
  };

  const startAsk = (): { sent: Promise<void>; done: Promise<void> } => {
    const title = `CHAOS-Q-${nextTag++} from=${role}`;
    persist();
    const askTag = askTagOf(title) ?? title;
    let seen = '';
    let sent = false;
    let resolveSent!: () => void;
    const sentPromise = new Promise<void>((r) => {
      resolveSent = r;
    });
    const markSent = (accepted: boolean, error: string | null): void => {
      if (sent) return;
      sent = true;
      log({ ev: 'ask_sent', askTag, accepted, error });
      resolveSent();
    };
    const done = cli(
      [
        'sessions', 'attention',
        '--title', title,
        '--message', title,
        '--option', 'yes',
        '--option', 'no',
        '--wait',
        '--timeout', ASK_WAIT_SECONDS,
      ],
      {
        timeoutMs: ASK_TIMEOUT_MS,
        onStderr: (chunk) => {
          if (sent) return;
          seen += chunk;
          if (parseWaitEventId(seen) !== null) {
            markSent(true, null);
          }
        },
      },
    ).then(
      (r) => {
        if (!sent) {
          if (parseWaitEventId(r.stderr) !== null) markSent(true, null);
          else markSent(false, failure(r));
        }
        if (r.code === 0) {
          const answer = parseWaitAnswer(r.stdout) ?? r.stdout.trim();
          log({ ev: 'answer_received', askTag, answer, via: 'waiter' });
        } else {
          cliError('attention', r);
        }
      },
      () => {
        if (!sent) {
          sent = true;
          resolveSent();
        }
        log({ ev: 'cli_error', cmd: 'attention', error: 'exception' });
      },
    );
    return { sent: sentPromise, done };
  };

  const runStep = async (step: AgentStep): Promise<void> => {
    switch (step.do) {
      case 'sleep':
        await clock.sleep(step.ms);
        return;
      case 'mail_send':
        await sendMail(step.to, step.type, step.body);
        return;
      case 'mail_read':
        await enqueueRead();
        return;
      case 'ask': {
        const { sent, done } = startAsk();
        background.push(done);
        await sent;
        return;
      }
      case 'answer_routed': {
        const q = pendingRouted.shift();
        if (!q) {
          log({ ev: 'cli_error', cmd: 'attention answer', error: 'no routed question pending' });
          return;
        }
        await answerRouted(q, step.optionIndex);
        return;
      }
      case 'hook': {
        const ok = await hook(step.event);
        log({ ev: 'hook_sent', event: step.event, ok });
        return;
      }
      case 'status': {
        const args = ['status', 'set', '--state', step.state, '--headline', step.headline];
        if (step.state === 'blocked') args.push('--on', 'external', '--text', step.headline);
        const r = await cli(args, { timeoutMs: CLI_TIMEOUT_MS });
        if (r.code !== 0) cliError('status set', r);
        return;
      }
      case 'exit':
        exited = step.code;
        log({ ev: 'exit', code: step.code });
        cursor += 1;
        persist();
        (deps.exit ?? ((c: number) => process.exit(c)))(step.code);
        return;
    }
  };

  log({ ev: 'start', pid: deps.pid ?? process.pid });
  if (deps.state) {
    try {
      const loaded = deps.state.load();
      if (loaded !== null) {
        nextTag = loaded.nextTag;
        cursor = loaded.cursor;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log({ ev: 'cli_error', cmd: 'state', error: 'corrupt state file' });
      (deps.stderr ?? ((m: string) => process.stderr.write(m)))(`corrupt state file for ${role}: ${msg}\n`);
      (deps.exit ?? ((c: number) => process.exit(c)))(1);
      return { exitCode: 1 };
    }
  }
  const stdinDone = consumeStdin();

  for (let i = cursor; i < script.steps.length; i++) {
    if (exited !== null) break;
    const step = script.steps[i];
    try {
      await runStep(step);
    } catch {
      log({ ev: 'cli_error', cmd: step.do, error: 'exception' });
    }
    if (exited === null) {
      cursor = i + 1;
      persist();
    }
  }

  await stdinDone;
  // Background work (reads triggered by nudges, outstanding asks) may still be in flight.
  for (let i = 0; i < background.length; i++) await background[i];
  await readChain;
  return { exitCode: exited };
}
