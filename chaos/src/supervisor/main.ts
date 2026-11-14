// In-guest supervisor: runs one seed end to end and writes the canonical log.
//   node /opt/chaos/src/supervisor/main.ts --seed N --level off|low|high
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTRACT_VERSION, EXIT, FAULT_WINDOW_END_MS, GUEST, PARENT_OF, ROLES, RUN_QUIESCE_MS } from '../contract.ts';
import type { AgentLogLine, ChaosLevel, Clock, MailType, Rec, Role } from '../contract.ts';
import { encodeLog, hashLog } from '../core/canon.ts';
import { realClock, writeT0 } from '../core/clock.ts';
import { deriveRng } from '../core/rng.ts';
import { buildSchedule } from '../core/schedule.ts';
import { takeSnapshot } from '../observe/snapshot.ts';
import { emitFile, FRAME_PORT } from '../guest/emit.ts';
import { checkpoint, runCheckpoints } from './checkpoints.ts';
import { runFaults } from './faults.ts';
import type { FaultActions } from './faults.ts';
import { canonicalOrder } from './order.ts';
import type { Seq } from './order.ts';
import { judge } from './props.ts';
import { buildScripts, sleepTotal } from './scripts.ts';
import { agentPids, asFtown, down, exec, FTOWN_ENV, ftown, isAlive, readBridgePid, up } from './target.ts';
import { normaliseError, planWorkload, runWorkload, WORKLOAD_START_MS } from './workload.ts';
import { sanitizeAgentEvent } from './agentcanon.ts';
import { applyDrop, parseDropFaults } from './drop.ts';

const CONTROL_TIMEOUT_MS = 20_000;
const CREATE_TIMEOUT_MS = 60_000;
const EXIT_POLL_MS = 200;

export function agentCommand(role: Role): string {
  return `node ${GUEST.chaosDir}/src/fake-agent/main.ts --role ${role} --script ${join(GUEST.agentScriptDir, `${role}.json`)}`;
}

/** Exact argv of `ftown sessions create` per chaos/factsheet.md. */
export function createArgs(role: Role, parentId: string | null): string[] {
  const a = ['sessions', 'create', '--shell', 'claude', '--command', agentCommand(role), '--name', role, '--workdir', GUEST.repoDir];
  if (parentId !== null) a.push('--parent-id', parentId);
  return a;
}

export function parseCreatedId(stdout: string): string | null {
  try {
    const j = JSON.parse(stdout) as { session?: { id?: unknown } };
    return typeof j.session?.id === 'string' ? j.session.id : null;
  } catch {
    return null;
  }
}

/**
 * Agent log lines for the canonical log: a truncated last line (kill -9) is dropped, raw
 * 'stdin_line' events are left out (they stay in side-agents.jsonl), and every event is rebuilt
 * through the whitelist (sanitizeAgentEvent). invalid counts the fields replaced by 'invalid'.
 */
export function parseAgentLog(text: string, role: Role): { lines: AgentLogLine[]; invalid: number } {
  const lines: AgentLogLine[] = [];
  let invalid = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let j: { t?: unknown; e?: unknown };
    try {
      j = JSON.parse(line) as { t?: unknown; e?: unknown };
    } catch {
      continue; // partial line
    }
    if (typeof j.t !== 'number' || !Number.isSafeInteger(j.t)) {
      invalid++;
      continue;
    }
    const s = sanitizeAgentEvent(j.e);
    invalid += s.invalid;
    if (s.e !== null) lines.push({ t: j.t, role, e: s.e });
  }
  return { lines, invalid };
}

class Recorder {
  private items: Seq[] = [];
  private head: Rec[] = [];
  log = (rec: Rec): void => {
    if (rec.k === 'run' || rec.k === 'schedule') this.head.push(rec);
    else this.items.push({ rec, seq: this.items.length });
  };
  canonical(): Rec[] {
    return [...this.head, ...canonicalOrder(this.items)];
  }
}

function makeActions(clock: Clock): FaultActions & { pid(): number | null } {
  let pid: number | null = null;
  const refresh = async (): Promise<number | null> => (pid = await readBridgePid());
  const sigAll = async (role: Role, sig: NodeJS.Signals): Promise<boolean> => {
    const pids = await agentPids(role);
    let any = false;
    for (const p of pids) {
      try {
        process.kill(p, sig);
        any = true;
      } catch {
        /* gone */
      }
    }
    return any;
  };
  return {
    pid: () => pid,
    async signalBridge(sig) {
      const p = await refresh();
      if (!(await isAlive(p)) || p === null) return false;
      try {
        process.kill(p, sig);
        return true;
      } catch {
        return false;
      }
    },
    async waitBridgeExit(boundMs) {
      const start = clock.now();
      while (clock.now() - start < boundMs) {
        if (!(await isAlive(pid))) return true;
        await clock.sleep(EXIT_POLL_MS);
      }
      return !(await isAlive(pid));
    },
    bridgeAlive: async () => isAlive(await refresh()),
    async bridgeUp() {
      const r = await up();
      pid = r.pid;
      return r.ok;
    },
    signalAgent: (role, sig) => sigAll(role, sig),
    async jumpClock(jumpMs) {
      if (process.env.CHAOS_ALLOW_CLOCK !== '1') return false;
      const now = await exec('date', ['+%s%N'], { timeoutMs: 5_000 });
      if (now.code !== 0 || !/^\d+$/.test(now.stdout.trim())) return false;
      const ns = BigInt(now.stdout.trim()) + BigInt(jumpMs) * 1_000_000n;
      const secs = `${ns / 1_000_000_000n}.${(ns % 1_000_000_000n).toString().padStart(9, '0')}`;
      const r = await exec('date', ['-s', `@${secs}`], { timeoutMs: 5_000 });
      return r.code === 0;
    },
  };
}

/**
 * Sends the output files to the host as frames (guest/emit.ts). The port is $CHAOS_FRAMES (Docker
 * bring-up) or /dev/ttyS1; when neither exists the files stay in GUEST.outDir only. The guest
 * entry point sends CHAOS-EXIT itself.
 */
async function emitOut(names: readonly string[]): Promise<void> {
  const port = process.env.CHAOS_FRAMES || FRAME_PORT;
  if (!process.env.CHAOS_FRAMES && !existsSync(port)) return;
  for (const name of names) emitFile(name, await readFile(join(GUEST.outDir, name)), port);
}

async function writeSideFiles(): Promise<void> {
  const tm = await asFtown(['tmux', '-L', 'ftown', 'ls'], { timeoutMs: 10_000 });
  await writeFile(join(GUEST.outDir, 'side-tmux.txt'), tm.stdout + tm.stderr);
  let agents = '';
  for (const role of ROLES) {
    try {
      agents += await readFile(join(GUEST.agentLogDir, `${role}.jsonl`), 'utf8');
    } catch {
      /* no log */
    }
  }
  await writeFile(join(GUEST.outDir, 'side-agents.jsonl'), agents);
  // Raw stderr of the agents' CLI calls (<role>.stderr.log), copied as side-<role>.stderr.log.
  for (const role of ROLES) {
    try {
      await writeFile(join(GUEST.outDir, `side-${role}.stderr.log`), await readFile(join(GUEST.agentLogDir, `${role}.stderr.log`)));
    } catch {
      /* none */
    }
  }
}

let procsChain: Promise<void> = Promise.resolve();
/** Appends `ps -eo pid,ppid,stat,etime,args` under a header naming the checkpoint (serialised). */
function appendProcs(name: string, t: number): Promise<void> {
  procsChain = procsChain.then(async () => {
    try {
      const r = await exec('ps', ['-eo', 'pid,ppid,stat,etime,args'], { timeoutMs: 10_000 });
      await mkdir(GUEST.outDir, { recursive: true });
      await appendFile(join(GUEST.outDir, 'side-procs.txt'), `=== ${name} t=${t}\n${r.stdout}${r.stderr}\n`);
    } catch {
      /* sidecar only */
    }
  });
  return procsChain;
}

const OUT_FILES = ['canon.jsonl', 'verdicts.json', 'side-bridge.log', 'side-tmux.txt', 'side-agents.jsonl', 'side-procs.txt', ...ROLES.map((r) => `side-${r}.stderr.log`)];

interface Outcome {
  verdicts: Extract<Rec, { k: 'verdict' }>[];
  exitCode: number;
  error: string | null;
  invalidAgentFields: number;
  /** Experiment marker: CHAOS_DROP_FAULTS tokens, or null for a plain seed run. */
  dropFaults: string[] | null;
}

/** Writes outputs, stops the bridge and emits frames. Each step is isolated; it never throws. */
async function finish(rec: Recorder, o: Outcome): Promise<number> {
  const step = async (name: string, f: () => Promise<unknown>): Promise<void> => {
    try {
      await f();
    } catch (e) {
      process.stderr.write(`supervisor: finish ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };
  let canon = '';
  await step('canon', async () => {
    canon = encodeLog([...rec.canonical(), ...o.verdicts]);
    await mkdir(GUEST.outDir, { recursive: true });
    await writeFile(join(GUEST.outDir, 'canon.jsonl'), canon);
  });
  await step('verdicts', async () => {
    const report = { verdicts: o.verdicts, exitCode: o.exitCode, H_run: hashLog(canon), invalidAgentFields: o.invalidAgentFields, dropFaults: o.dropFaults, ...(o.error === null ? {} : { error: o.error }) };
    await writeFile(join(GUEST.outDir, 'verdicts.json'), `${JSON.stringify(report, null, 2)}\n`);
  });
  await step('procs', () => procsChain);
  await step('side', writeSideFiles);
  await step('down', down);
  await step('emit', () => emitOut(OUT_FILES.filter((name) => existsSync(join(GUEST.outDir, name)))));
  return o.exitCode;
}

class Infra extends Error {}

/** Bound for the ids file to list every role before root's first mail is due. */
export function idsDeadline(rootCreateStartMs: number, rootFirstSleepMs: number): number {
  return rootCreateStartMs + rootFirstSleepMs;
}

async function drive(seed: number, level: ChaosLevel, clock: Clock, rec: Recorder, schedule: ReturnType<typeof buildSchedule>): Promise<Omit<Outcome, 'dropFaults'>> {
  const actions = makeActions(clock);
  if (!(await actions.bridgeUp())) throw new Infra('infra:bridge_up');

  const scripts = buildScripts(seed, deriveRng);
  await mkdir(GUEST.agentScriptDir, { recursive: true });
  for (const role of ROLES) await writeFile(join(GUEST.agentScriptDir, `${role}.json`), `${JSON.stringify(scripts[role])}\n`);

  const ids: Record<Role, string | null> = { root: null, child1: null, child2: null, child3: null };
  const writeIds = async (): Promise<void> => {
    const known: Record<string, string> = {};
    for (const r of ROLES) if (ids[r] !== null) known[r] = ids[r] as string;
    await writeFile(`${GUEST.idsFile}.tmp`, JSON.stringify(known));
    await rename(`${GUEST.idsFile}.tmp`, GUEST.idsFile);
  };
  await writeIds();
  const firstStep = scripts.root.steps[0];
  const rootFirstSleep = firstStep?.do === 'sleep' ? firstStep.ms : 0;
  let rootCreateAt = 0;
  for (const role of ROLES) {
    const parent = PARENT_OF[role];
    const t = clock.now();
    if (role === 'root') rootCreateAt = t;
    const r = await ftown(createArgs(role, parent === null ? null : ids[parent]), { timeoutMs: CREATE_TIMEOUT_MS });
    const id = r.code === 0 ? parseCreatedId(r.stdout) : null;
    rec.log({ k: 'op', t, op: { op: 'session_create', role }, ok: id !== null, error: id !== null ? null : normaliseError(r.code, r.stderr, r.stdout) });
    if (id === null) throw new Infra(`infra:session_create:${role}`);
    ids[role] = id;
    await writeIds();
  }
  // Root's first mail comes after its first sleep; the ids file must be complete before then.
  if (clock.now() > idsDeadline(rootCreateAt, rootFirstSleep)) throw new Infra('infra:ids_late');

  const take = () =>
    takeSnapshot({
      dataDir: GUEST.dataDir,
      ids,
      bridgePid: actions.pid(),
      bridgeResponsive: async () => (await ftown(['sessions', 'list'], { timeoutMs: CONTROL_TIMEOUT_MS })).code === 0,
      tmux: { user: GUEST.user, env: { HOME: FTOWN_ENV.HOME, TMUX_TMPDIR: FTOWN_ENV.TMUX_TMPDIR } },
    });
  // Each checkpoint also appends a process listing to side-procs.txt (sidecar, never hashed).
  const cpLog = (r: Rec): void => {
    rec.log(r);
    if (r.k === 'checkpoint') void appendProcs(r.name, r.t);
  };
  const cpDeps = { clock, take, log: cpLog };
  let stop = false;
  const stopped = () => stop;
  // Every loop gets its handler at creation: the first failure stops the others.
  const guard = <T>(p: Promise<T>): Promise<T> =>
    p.catch((e: unknown) => {
      stop = true;
      throw e;
    });
  const checkpoints = guard(runCheckpoints(cpDeps, stopped));
  checkpoints.catch(() => undefined);
  const work = guard(
    runWorkload({
      clock,
      // Starts once every session exists; under icount that instant is itself deterministic.
      plan: planWorkload(seed, deriveRng, Math.max(WORKLOAD_START_MS, clock.now()), FAULT_WINDOW_END_MS),
      idOf: (r) => ids[r],
      send: (id: string, type: MailType, body: string) => ftown(['harness', 'mail', 'send', id, '--type', type, body], { timeoutMs: CONTROL_TIMEOUT_MS }),
      log: rec.log,
      stopped,
    }),
  );
  const faults = guard(runFaults({ clock, schedule, actions, roles: ROLES, log: rec.log, stopped }));
  // Rejects as soon as any loop (checkpoints included) rejects.
  await Promise.race([Promise.all([work, faults]), checkpoints.then(() => new Promise<never>(() => undefined))]);
  await clock.sleep(RUN_QUIESCE_MS);
  stop = true;
  await checkpoints;
  await checkpoint(cpDeps, 'final', true);

  let invalid = 0;
  for (const role of ROLES) {
    let text = '';
    try {
      text = await readFile(join(GUEST.agentLogDir, `${role}.jsonl`), 'utf8');
    } catch {
      /* agent never logged */
    }
    const parsed = parseAgentLog(text, role);
    invalid += parsed.invalid;
    for (const l of parsed.lines) rec.log({ k: 'agent', t: l.t, role, e: l.e });
  }
  const { verdicts, exitCode } = judge(rec.canonical());
  return { verdicts, exitCode, error: null, invalidAgentFields: invalid };
}

export async function runSeed({ seed, level }: { seed: number; level: ChaosLevel }): Promise<number> {
  const clock: Clock = realClock({ t0Ns: writeT0(GUEST.t0File) });
  await chmod(GUEST.t0File, 0o644);
  const rec = new Recorder();
  // The seed's schedule is generated in full (same rng draws), then experiment drops are applied.
  const dropFaults = parseDropFaults(process.env.CHAOS_DROP_FAULTS);
  const dropped = applyDrop(buildSchedule(seed, level, deriveRng(seed, 'faults')), dropFaults ?? []);
  const schedule = dropped.faults;
  rec.log({ k: 'run', seed, level, contract: CONTRACT_VERSION });
  rec.log({ k: 'schedule', faults: schedule });
  if (dropped.unknown.length > 0) {
    process.stderr.write(`supervisor: CHAOS_DROP_FAULTS has unknown ids/kinds: ${dropped.unknown.join(',')}\n`);
    return finish(rec, { verdicts: [], exitCode: EXIT.usage, error: 'usage:drop_faults', invalidAgentFields: 0, dropFaults });
  }
  let outcome: Outcome;
  try {
    outcome = { ...(await drive(seed, level, clock, rec, schedule)), dropFaults };
  } catch (e) {
    process.stderr.write(`supervisor: ${e instanceof Error ? e.stack : String(e)}\n`);
    outcome = { verdicts: [], exitCode: EXIT.infra, error: e instanceof Infra ? e.message : 'infra:drive', invalidAgentFields: 0, dropFaults };
  }
  return finish(rec, outcome);
}

export function parseCli(argv: readonly string[]): { seed: number; level: ChaosLevel } | null {
  let seed: number | null = null;
  let level: ChaosLevel | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seed' && /^\d+$/.test(argv[i + 1] ?? '')) seed = Number(argv[++i]);
    else if (argv[i] === '--level' && ['off', 'low', 'high'].includes(argv[i + 1] ?? '')) level = argv[++i] as ChaosLevel;
    else return null;
  }
  return seed === null || level === null ? null : { seed, level };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseCli(process.argv.slice(2));
  if (args === null) {
    process.stderr.write('usage: main.ts --seed <int> --level off|low|high\n');
    process.exit(EXIT.usage);
  }
  runSeed(args).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`supervisor: ${e instanceof Error ? e.stack : String(e)}\n`);
      process.exit(EXIT.infra);
    },
  );
}
