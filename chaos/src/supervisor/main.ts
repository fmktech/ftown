// In-guest supervisor: runs one seed end to end and writes the canonical log.
//   node /opt/chaos/src/supervisor/main.ts --seed N --level off|low|high
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTRACT_VERSION, EXIT, FAULT_WINDOW_END_MS, GUEST, PARENT_OF, ROLES, RUN_QUIESCE_MS } from '../contract.ts';
import type { AgentLogLine, ChaosLevel, Clock, MailType, Rec, Role } from '../contract.ts';
import { encodeLog, hashLog } from '../core/canon.ts';
import { realClock, writeT0 } from '../core/clock.ts';
import { deriveRng } from '../core/rng.ts';
import { buildSchedule } from '../core/schedule.ts';
import { takeSnapshot } from '../observe/snapshot.ts';
import { checkpoint, runCheckpoints } from './checkpoints.ts';
import { runFaults } from './faults.ts';
import type { FaultActions } from './faults.ts';
import { canonicalOrder } from './order.ts';
import type { Seq } from './order.ts';
import { judge } from './props.ts';
import { buildScripts } from './scripts.ts';
import { agentPids, asFtown, down, exec, FTOWN_ENV, ftown, isAlive, readBridgePid, up } from './target.ts';
import { normaliseError, planWorkload, runWorkload } from './workload.ts';

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

/** Parsed agent log lines (a truncated last line from a kill -9 is dropped). */
export function parseAgentLog(text: string, role: Role): AgentLogLine[] {
  const out: AgentLogLine[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const j = JSON.parse(line) as AgentLogLine;
      if (typeof j.t === 'number' && j.e && typeof j.e === 'object') out.push({ t: j.t, role, e: j.e });
    } catch {
      /* partial line */
    }
  }
  return out;
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

function makeActions(): FaultActions & { pid(): number | null } {
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
      for (let waited = 0; waited < boundMs; waited += EXIT_POLL_MS) {
        if (!(await isAlive(pid))) return true;
        await new Promise((r) => setTimeout(r, EXIT_POLL_MS));
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

interface EmitFile {
  name: string;
  path: string;
}

/** Hands the output files to the host via chaos/src/guest/emit.ts when it exists; otherwise they stay in outDir. */
async function emitOut(files: readonly EmitFile[], code: number): Promise<void> {
  const modPath = new URL('../guest/emit.ts', import.meta.url);
  if (!existsSync(modPath)) return;
  const mod = (await import(modPath.href)) as Record<string, unknown>;
  const fn = (mod.emitFiles ?? mod.emit) as ((files: readonly EmitFile[], exitCode: number) => unknown) | undefined;
  if (typeof fn === 'function') await fn(files, code);
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
}

const OUT_FILES = ['canon.jsonl', 'verdicts.json', 'side-bridge.log', 'side-tmux.txt', 'side-agents.jsonl'];

async function finish(rec: Recorder, verdicts: Extract<Rec, { k: 'verdict' }>[], exitCode: number, error: string | null): Promise<number> {
  const canon = encodeLog([...rec.canonical(), ...verdicts]);
  await mkdir(GUEST.outDir, { recursive: true });
  await writeFile(join(GUEST.outDir, 'canon.jsonl'), canon);
  const report = { verdicts, exitCode, H_run: hashLog(canon), ...(error === null ? {} : { error }) };
  await writeFile(join(GUEST.outDir, 'verdicts.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeSideFiles().catch(() => undefined);
  await down().catch(() => undefined);
  const files = OUT_FILES.map((name) => ({ name, path: join(GUEST.outDir, name) })).filter((f) => existsSync(f.path));
  await emitOut(files, exitCode);
  return exitCode;
}

export async function runSeed({ seed, level }: { seed: number; level: ChaosLevel }): Promise<number> {
  const clock: Clock = realClock({ t0Ns: writeT0(GUEST.t0File) });
  await chmod(GUEST.t0File, 0o644);
  const rec = new Recorder();
  const schedule = buildSchedule(seed, level, deriveRng(seed, 'faults'));
  rec.log({ k: 'run', seed, level, contract: CONTRACT_VERSION });
  rec.log({ k: 'schedule', faults: schedule });

  const actions = makeActions();
  if (!(await actions.bridgeUp())) return finish(rec, [], EXIT.infra, 'infra:bridge_up');

  try {
    const scripts = buildScripts(seed, deriveRng);
    await mkdir(GUEST.agentScriptDir, { recursive: true });
    for (const role of ROLES) await writeFile(join(GUEST.agentScriptDir, `${role}.json`), `${JSON.stringify(scripts[role])}\n`);

    const ids: Record<Role, string | null> = { root: null, child1: null, child2: null, child3: null };
    const writeIds = async (): Promise<void> => {
      const known: Record<string, string> = {};
      for (const r of ROLES) if (ids[r] !== null) known[r] = ids[r] as string;
      await writeFile(`${GUEST.idsFile}.tmp`, JSON.stringify(known));
      await exec('mv', [`${GUEST.idsFile}.tmp`, GUEST.idsFile], { timeoutMs: 5_000 });
    };
    await writeIds();
    for (const role of ROLES) {
      const parent = PARENT_OF[role];
      const r = await ftown(createArgs(role, parent === null ? null : ids[parent]), { timeoutMs: CREATE_TIMEOUT_MS });
      const id = r.code === 0 ? parseCreatedId(r.stdout) : null;
      rec.log({ k: 'op', t: clock.now(), op: { op: 'session_create', role }, ok: id !== null, error: id !== null ? null : normaliseError(r.code, r.stderr, r.stdout) });
      if (id === null) return await finish(rec, [], EXIT.infra, `infra:session_create:${role}`);
      ids[role] = id;
      await writeIds();
    }

    const take = () =>
      takeSnapshot({
        dataDir: GUEST.dataDir,
        ids,
        bridgePid: actions.pid(),
        bridgeResponsive: async () => (await ftown(['sessions', 'list'], { timeoutMs: CONTROL_TIMEOUT_MS })).code === 0,
        tmux: { user: GUEST.user, env: { HOME: FTOWN_ENV.HOME, TMUX_TMPDIR: FTOWN_ENV.TMUX_TMPDIR } },
      });
    const cpDeps = { clock, take, log: rec.log };
    let stop = false;
    const checkpoints = runCheckpoints(cpDeps, () => stop);

    const workload = runWorkload({
      clock,
      plan: planWorkload(seed, deriveRng, clock.now(), FAULT_WINDOW_END_MS),
      idOf: (r) => ids[r],
      send: (id: string, type: MailType, body: string) => ftown(['harness', 'mail', 'send', id, '--type', type, body], { timeoutMs: CONTROL_TIMEOUT_MS }),
      log: rec.log,
    });
    const faults = runFaults({ clock, schedule, actions, roles: ROLES, log: rec.log });
    await Promise.all([workload, faults]);
    // Quiesce after the last heal (and the end of the workload), then the final checkpoint.
    await clock.sleep(RUN_QUIESCE_MS);
    stop = true;
    await checkpoints;
    await checkpoint(cpDeps, 'final', true);

    for (const role of ROLES) {
      let text = '';
      try {
        text = await readFile(join(GUEST.agentLogDir, `${role}.jsonl`), 'utf8');
      } catch {
        /* agent never logged */
      }
      for (const l of parseAgentLog(text, role)) rec.log({ k: 'agent', t: l.t, role, e: l.e });
    }
    const body = rec.canonical();
    const { verdicts, exitCode } = judge(body);
    return await finish(rec, verdicts, exitCode, null);
  } catch (e) {
    process.stderr.write(`supervisor: ${e instanceof Error ? e.stack : String(e)}\n`);
    return finish(rec, [], EXIT.infra, 'infra:drive');
  }
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
