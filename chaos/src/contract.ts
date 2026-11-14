// FROZEN CONTRACT for the ftown chaos test type. Types, constants and tables only: no logic.
// Every task implements against this file. Do not edit it in a task; if it is wrong or
// incomplete, report that to the manager session, which owns it.
//
// Runtime rules that follow from this file:
//  - Node 24 runs these .ts files directly (type stripping). Use erasable syntax only:
//    no enums, no namespaces, no parameter properties, no decorators. Relative imports
//    carry the .ts extension. No runtime dependencies beyond Node built-ins.
//  - Everything under "in-guest" executes inside the QEMU guest and may read time only
//    through the Clock passed to it. Host code never contributes to the canonical log.

// ───────────────────────────── seeds and streams ─────────────────────────────

/** One owner per label. Adding a label is allowed; renaming or reusing one breaks seeds. */
export type StreamLabel =
  | 'faults'
  | 'workload.sessions'
  | 'workload.mail'
  | 'workload.attention'
  | `agent.${string}`;

/** Deterministic generator. deriveRng(seed, label) = SHA-256(`${seed}:${label}`) keyed stream. A label containing ':' throws. */
export interface Rng {
  /** Uniform unsigned 32-bit integer. */
  u32(): number;
  /** Uniform in [0, 1). */
  float(): number;
  /** Uniform integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number;
  /** Uniform element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
}

export type DeriveRng = (seed: number, label: StreamLabel) => Rng;

/**
 * Guest time source. now() is whole milliseconds since the supervisor started (monotonic).
 * All processes share one epoch: the supervisor writes its start instant, taken from
 * process.hrtime.bigint() (CLOCK_MONOTONIC, comparable across processes), as a decimal
 * nanosecond string to GUEST.t0File before anything else starts. Every other process (the
 * fake agents) computes now() = floor((process.hrtime.bigint() - t0) / 1e6). A process that
 * cannot read the file must fail loudly, not fall back to its own epoch.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

// ───────────────────────────── roles ─────────────────────────────

/** Sessions are named by role in every record. Session ids never appear in the canonical log. */
export type Role = 'root' | 'child1' | 'child2' | 'child3';
export const ROLES: readonly Role[] = ['root', 'child1', 'child2', 'child3'];
/** root is the parent of every child. */
export const PARENT_OF: Readonly<Record<Role, Role | null>> = {
  root: null,
  child1: 'root',
  child2: 'root',
  child3: 'root',
};

export type ChaosLevel = 'off' | 'low' | 'high';

// ───────────────────────────── FAULTS table ─────────────────────────────
// THE WHOLE TABLE (order, length, ranges) IS PART OF THE SEED CONTRACT. Any change, including an
// appended row, changes the schedule of every seed: bump CONTRACT_VERSION and re-record known seeds.
// A golden-schedule test in core pins this.

export type FaultKind =
  | 'bridge_kill9'
  | 'bridge_sigstop'
  | 'bridge_sigterm'
  | 'agent_kill9'
  | 'agent_sigstop'
  | 'parent_kill9'
  | 'clock_jump_fwd'
  | 'clock_jump_back';

export interface FaultSpec {
  kind: FaultKind;
  /** What it acts on. 'agent' picks a child role from the faults stream; 'parent' is root. */
  target: 'bridge' | 'agent' | 'parent' | 'clock';
  /** Duration range in ms for the short form: time until heal (restart, SIGCONT). 0 = instantaneous. */
  short: readonly [number, number];
  /** Duration range in ms for the long form, or null when the fault has none. */
  long: readonly [number, number] | null;
  /** For clock faults: jump size range in ms (short, long). Otherwise null. */
  jump: { short: readonly [number, number]; long: readonly [number, number] } | null;
  /** Which bridge timeouts the long form is sized to outlast (documentation; file:line in the plan). */
  outlasts: string;
}

export const FAULTS: readonly FaultSpec[] = [
  { kind: 'bridge_kill9', target: 'bridge', short: [1_000, 3_000], long: [75_000, 75_000], jump: null,
    outlasts: 'ask-hook OUTAGE_LIMIT_MS 60s; CLI timeoutMs 60s; envelope fetch 65s; MAX_MAIL_WAIT_SECONDS 30' },
  { kind: 'bridge_sigstop', target: 'bridge', short: [2_000, 2_000], long: [40_000, 40_000], jump: null,
    outlasts: 'hub ping 10s + pong 5s; maxServerPingDelay 20s; ATTENTION_WAITER_TTL_MS 10s; hook curl --max-time 2' },
  { kind: 'bridge_sigterm', target: 'bridge', short: [1_000, 3_000], long: null, jump: null,
    outlasts: 'graceful shutdown path' },
  { kind: 'agent_kill9', target: 'agent', short: [0, 0], long: null, jump: null,
    outlasts: 'event-driven exit path' },
  { kind: 'agent_sigstop', target: 'agent', short: [3_000, 3_000], long: [150_000, 150_000], jump: null,
    outlasts: 'HOOKED_BUSY_STALE_MS 120s; SUBAGENT_IDLE_DELAY_MS 120s; MAIL_NUDGE_BUSY_RECHECK_MS 60s' },
  { kind: 'parent_kill9', target: 'parent', short: [0, 0], long: null, jump: null,
    outlasts: 'parent-exit escalation trigger' },
  { kind: 'clock_jump_fwd', target: 'clock', short: [0, 0], long: null,
    jump: { short: [90_000, 90_000], long: [2_100_000, 2_100_000] },
    outlasts: 'AGENT_BUSY_STALE_MS 30min; CARD_STALE_MS 10min' },
  { kind: 'clock_jump_back', target: 'clock', short: [0, 0], long: null,
    jump: { short: [30_000, 30_000], long: [600_000, 600_000] },
    outlasts: 'MAIL_NUDGE_MIN_INTERVAL_MS 30s and every Date.now() difference' },
];

/** One entry of a schedule produced from (seed, level). Times are guest ms (Clock.now()). */
export interface ScheduledFault {
  /** f1, f2, … in schedule order. */
  id: string;
  kind: FaultKind;
  /** Role hit, 'bridge', or 'clock'. */
  target: Role | 'bridge' | 'clock';
  atMs: number;
  /** Time from start to heal. 0 = no heal step. */
  durationMs: number;
  /** Clock faults only: signed jump applied to the guest realtime clock. */
  jumpMs: number | null;
  long: boolean;
}

/**
 * Schedule rules (implemented by the scheduler, stated here so every task agrees):
 *  - level 'off': no faults.
 *  - level 'low': 2–4 short faults.
 *  - level 'high': 3–5 short faults plus exactly one long fault. Only valid with profile 'soak':
 *    a long fault outlasts bridge timeouts of 40–150 s and does not fit a short run. The scheduler
 *    throws on (profile 'short', level 'high'); the host CLI rejects it as a usage error.
 *  - Faults are drawn from FAULTS in table order using only the 'faults' stream.
 *  - Faults never overlap on the same target. Bridge faults never overlap each other, and a
 *    bridge fault never starts less than BRIDGE_RESTART_BUDGET_MS after the scheduled heal
 *    (atMs + durationMs) of the previous bridge fault: restarting the bridge takes tens of
 *    seconds of guest time, and a fault that arrives while the previous heal is still running
 *    is delayed behind it and hits nothing. Clock faults are exempt: a clock jump during a
 *    restart is a case worth testing.
 *  - Every fault starts inside [faultWindowStartMs, faultWindowEndMs] of the run's profile and
 *    is healed by faultWindowEndMs, so the quiesce period that follows has no active fault.
 *  - The same (seed, level, profile) always yields the same schedule.
 *  - The FAULTS table is validated before use: duplicate kinds, a clock fault without a jump
 *    range, a non-clock fault with one, or an empty/inverted range are rejected with an error.
 *  - After the last scheduled fault the executor always performs one final heal: SIGCONT anything
 *    still stopped and start the bridge if it is not running. It is logged as a fault record with
 *    id 'heal', phase 'heal', kind of the last fault, target 'all'.
 */
/** Minimum gap between a bridge fault's scheduled heal and the start of the next bridge fault. */
export const BRIDGE_RESTART_BUDGET_MS = 30_000;

export type BuildSchedule = (seed: number, level: ChaosLevel, profile: RunProfile, rng: Rng) => ScheduledFault[];

/**
 * Run length. 'short' is the default: about 3 minutes of guest time, for many seeds and quick
 * determinism pairs. 'soak' is the long form (about 8 minutes) and the only one that carries
 * long faults (level 'high'); it is for occasional and overnight runs.
 */
export type RunProfile = 'short' | 'soak';
export const RUN_PROFILES: readonly RunProfile[] = ['short', 'soak'];
export const DEFAULT_PROFILE: RunProfile = 'short';

export interface ProfileTiming {
  /**
   * The window opens only after bring-up is complete: under the instruction-counted guest,
   * creating the four sessions through the CLI takes about 45 s of guest time, and root's first
   * mail and the guaranteed early ask and its answer follow. All of that precedes the first fault.
   */
  faultWindowStartMs: number;
  /** Last instant a fault may start; every fault is also healed by this instant. */
  faultWindowEndMs: number;
  /** After faultWindowEndMs the supervisor waits this long with no faults, then takes the final checkpoint. */
  quiesceMs: number;
  /** Interval between periodic checkpoints. "After heal" properties are judged at the final one. */
  checkpointEveryMs: number;
  /**
   * By this instant (guest ms since t0) every workload op has begun and every agent has COMPLETED
   * its final 'Stop' hook. The bound counts the agent's start offset, its sleeps and the guest time
   * its CLI calls take (seconds each under the instruction-counted guest), not sleeps alone.
   *
   * Agent scripts are organised in turns, like a real agent: a 'UserPromptSubmit' hook, a few
   * actions, a 'Stop' hook, then an idle sleep. The bridge treats a session as busy between those
   * hooks and defers mail nudges while it is busy, re-checking every 60 s; it nudges an idle hooked
   * session 60 s after a mail. A script that stays busy from its first prompt to its last step is
   * never nudged during the run, so nudge delivery would go untested and mail would still be
   * pending at the final checkpoint.
   *
   * Sizing rule: the final checkpoint must come more than 60 s after the last Stop and after the
   * last waking mail, with margin for timer slip and a bridge restart:
   * faultWindowEndMs + quiesceMs >= max(workloadEndMs, faultWindowEndMs) + 80_000.
   */
  workloadEndMs: number;
}

export const PROFILE: Record<RunProfile, ProfileTiming> = {
  short: { faultWindowStartMs: 75_000, faultWindowEndMs: 115_000, quiesceMs: 135_000, checkpointEveryMs: 15_000, workloadEndMs: 170_000 },
  soak: { faultWindowStartMs: 90_000, faultWindowEndMs: 330_000, quiesceMs: 150_000, checkpointEveryMs: 30_000, workloadEndMs: 330_000 },
};

// ───────────────────────────── fake agent ─────────────────────────────
// The fake agent is the session command. It is a scripted stand-in for an LLM CLI.
// It is started as:  node /opt/chaos/src/fake-agent/main.ts --role <role> --script <path.json>
// and may receive extra arguments from the bridge (ignore unknown arguments).

export type AgentStep =
  | { do: 'sleep'; ms: number }
  | { do: 'mail_send'; to: Role | 'parent'; type: MailType; body: string }
  | { do: 'mail_read' }
  | { do: 'ask'; title: string; message: string; options: string[] }
  | { do: 'answer_routed'; optionIndex: number }
  | { do: 'hook'; event: 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' }
  | { do: 'status'; state: 'working' | 'blocked' | 'done'; headline: string }
  | { do: 'exit'; code: number };

export interface AgentScript {
  role: Role;
  /** Executed in order. After the last step the agent stays alive, idle, until killed. */
  steps: AgentStep[];
  /** When a nudge line arrives on stdin the agent runs `ftown harness mail read`. */
  readMailOnNudge: boolean;
  /** When an escalation mail about a child question arrives, the agent answers it (parent only). */
  answerRoutedQuestions: boolean;
}

export type MailType = 'message' | 'task' | 'result' | 'escalation' | 'fyi';

/**
 * Agent log: one JSON object per line appended to `${AGENT_LOG_DIR}/${role}.jsonl`.
 * This is the unfaulted truth of what the agent saw and did. The supervisor merges it
 * into the canonical log as { k: 'agent' } records.
 */
export type AgentEvent =
  | { ev: 'start'; pid: number }
  | { ev: 'stdin_line'; text: string }
  /** A stdin line recognised as a mail nudge (`[ftown] N new mail …`). n = the N in the line. */
  | { ev: 'nudge'; n: number }
  /** One per mail returned by a read. tag = the CHAOS tag in the body, see MAIL_TAG_RE. */
  | { ev: 'mail_received'; tag: string; type: MailType; fromRole: Role | 'external' | 'unknown' }
  | { ev: 'mail_sent'; tag: string; to: Role; type: MailType; accepted: boolean; error: string | null }
  | { ev: 'ask_sent'; askTag: string; accepted: boolean; error: string | null }
  | { ev: 'answer_received'; askTag: string; answer: string; via: 'waiter' | 'mail' }
  | { ev: 'routed_answer_sent'; askTag: string; accepted: boolean; error: string | null }
  | { ev: 'hook_sent'; event: string; ok: boolean }
  | { ev: 'cli_error'; cmd: string; error: string }
  | { ev: 'exit'; code: number };

export interface AgentLogLine {
  /** Clock.now() at the time of the event. */
  t: number;
  role: Role;
  e: AgentEvent;
}

/**
 * Mail bodies and question titles are self-describing so that no component needs a session id:
 *   mail body      = `CHAOS-M-<n> from=<role|external> to=<role>`   (n unique per run)
 *   question title = `CHAOS-Q-<n> from=<role>`                       (n unique per run)
 *   question message = the title again; options are always ['yes', 'no'].
 * The workload allocates n from 1; agent `role` allocates from 1000 * (index of role in ROLES + 1).
 */
/**
 * In every record and observation, `tag` is the full text `CHAOS-M-<n>` and `askTag` is the full
 * text `CHAOS-Q-<n>` (not the bare number).
 */
/** Every mail body sent by the workload or an agent starts with this tag: `CHAOS-M-<n> `. */
export const MAIL_TAG_RE = /^CHAOS-M-(\d+)\b/;
/** Every question title starts with this tag: `CHAOS-Q-<n> `. */
export const ASK_TAG_RE = /^CHAOS-Q-(\d+)\b/;

// ───────────────────────────── observations ─────────────────────────────
// Snapshots are read by the supervisor from the unfaulted view: files under DATA_DIR,
// /proc, and `tmux -L ftown ls`. Never through a faulted hop.

export interface MailObs {
  tag: string;
  type: MailType;
  fromRole: Role | 'external' | 'unknown';
  delivered: boolean;
  deliveredVia: 'poll' | 'drain' | 'nudge' | 'cli' | null;
  nudged: boolean;
}

export interface AttentionObs {
  askTag: string;
  route: 'parent' | 'human' | null;
  resolved: boolean;
  resolution: string | null;
  escalated: boolean;
}

export interface SessionObs {
  role: Role;
  /** Bridge's record: status field of session.json, or 'missing' / 'unparseable'. */
  status: 'pending' | 'running' | 'completed' | 'error' | 'missing' | 'unparseable';
  /** Truth: the tmux session ftown-<id> exists on socket `ftown`. */
  tmuxAlive: boolean;
  /** Truth: the fake agent process for this role exists (any state, including stopped). */
  procAlive: boolean;
  inbox: MailObs[];
  /**
   * Number of inbox lines that are waking mail (type != 'fyi') WITHOUT a CHAOS-M tag: mail the
   * bridge or the attention flow generated (question escalations, attention answers, PR mail).
   * They are counted, not listed, because their bodies carry ids.
   */
  untaggedWakingMail: number;
  /** false when inbox.jsonl has a line that does not parse. */
  inboxParses: boolean;
  attention: AttentionObs[];
  attentionParses: boolean;
}

export interface TreeEventObs {
  seq: number;
  kind: string;
  /** Role the event is about, when it can be resolved. */
  role: Role | null;
}

export interface Snapshot {
  bridgeAlive: boolean;
  /** Bridge answered an unfaulted `ftown sessions list` within the control timeout. */
  bridgeResponsive: boolean;
  sessions: SessionObs[];
  /** Events of the root's tree-events.jsonl in file order (unparseable lines omitted). */
  treeEvents: TreeEventObs[];
  /** Number of lines in tree-events.jsonl that do not parse. */
  treeEventsCorruptLines: number;
}

// ───────────────────────────── canonical log ─────────────────────────────
// One JSON object per line, keys in the order written here, no whitespace.
// H_run = sha256 of the file bytes. Two runs of one seed must produce identical bytes.

export type Rec =
  | { k: 'run'; seed: number; level: ChaosLevel; profile: RunProfile; contract: number }
  | { k: 'schedule'; faults: ScheduledFault[] }
  /**
   * t is when the action began, doneT when it finished (for a bridge heal: when the start script
   * returned). ok on a start means the fault hit a live target; ok on a heal means the target was
   * verified running again when the heal returned.
   */
  | { k: 'fault'; t: number; doneT: number; id: string; phase: 'start' | 'heal'; kind: FaultKind; target: string; ok: boolean }
  | { k: 'op'; t: number; op: WorkloadOp; ok: boolean; error: string | null }
  | { k: 'agent'; t: number; role: Role; e: AgentEvent }
  | { k: 'checkpoint'; t: number; name: string; final: boolean; snap: Snapshot }
  | { k: 'verdict'; prop: string; kind: PropKind; status: PropStatus; evidence: string[] };

export const CONTRACT_VERSION = 9;

/** Operations the supervisor's workload driver performs through the real ftown CLI. */
export type WorkloadOp =
  | { op: 'session_create'; role: Role }
  | { op: 'mail_send'; tag: string; to: Role; type: MailType }
  | { op: 'session_stop'; role: Role };

// ───────────────────────────── properties ─────────────────────────────

export type PropKind = 'always' | 'sometimes' | 'unreachable';
/**
 * always:      pass | violated | unexercised (never evaluated on any relevant record)
 * unreachable: pass | violated
 * sometimes:   hit | not_hit
 */
export type PropStatus = 'pass' | 'violated' | 'unexercised' | 'hit' | 'not_hit';

export interface PropResult {
  status: PropStatus;
  /** Short, normalised lines (roles and tags, never ids or times) that identify the violation. */
  evidence: string[];
}

export interface Property {
  id: string;
  kind: PropKind;
  /** The ftown rule this checks, with file:line. */
  source: string;
  title: string;
  /** Pure function of the canonical log (all records except verdicts). */
  check(log: readonly Rec[]): PropResult;
}

/** v1 property ids. Each one is implemented by exactly one task (see chaos/AGENTS.md). */
export const PROPERTY_IDS = [
  'M1', // always: accepted mail is in the recipient inbox at the final checkpoint
  'M2', // always: a mail tag is received by an agent at most once
  'M4', // always: nudge-once (a waking mail is covered by at most one nudge; fyi never nudges)
  'M5', // always: after heal, a live idle recipient has no undelivered un-nudged waking mail
  'A1', // always: an ask gets at most one answer and one resolution
  'A2', // always: a parent-routed open ask is human-routed at the final checkpoint if the parent is dead
  'T1', // always: tree-event seq strictly increasing, no gaps, no duplicates, no regression
  'S1', // unreachable: session shown running/pending while its tmux session and process are gone
  'R1', // always: bridge alive and responsive at the final checkpoint
  'R2', // unreachable: bridge dead at a checkpoint while no bridge fault is active (30 s grace after heal)
  'C1', // sometimes: bridge restarted while mail was pending
  'C2', // sometimes: a parent died with an open child ask
] as const;
export type PropertyId = (typeof PROPERTY_IDS)[number];

// ───────────────────────────── guest layout and host protocol ─────────────────────────────

export const GUEST = {
  /** Built bridge (package root containing dist/ and node_modules/). */
  bridgeDir: '/opt/ftown/bridge',
  /** This chaos directory, copied as is. */
  chaosDir: '/opt/chaos',
  /** Bridge data dir (--data-dir) and HOME for the bridge and agents. */
  dataDir: '/data',
  home: '/home/ftown',
  /** Git repo the sessions use as workdir. */
  repoDir: '/work/repo',
  agentLogDir: '/run/chaos/agents',
  /** Shared clock epoch, see Clock. */
  t0File: '/run/chaos/t0',
  /** JSON {role: sessionId} written by the supervisor; read by agents to address other roles. */
  idsFile: '/run/chaos/ids.json',
  agentScriptDir: '/run/chaos/scripts',
  /** Where the supervisor writes its outputs before they are sent to the host. */
  outDir: '/run/chaos/out',
  soloPort: 8040,
  /** Unprivileged user that runs the bridge and agents. The supervisor runs as root. */
  user: 'ftown',
} as const;

/**
 * Kernel command line parameters read by the guest init:
 *   chaos.cmd=selftest|run   chaos.seed=<int>   chaos.level=off|low|high
 *
 * Results leave the guest on the second serial port (/dev/ttyS1), framed as text:
 *   CHAOS-FILE <name> <byteLength>\n
 *   <base64, 76 columns>\n
 *   CHAOS-END <name>\n
 *   …
 *   CHAOS-EXIT <code>\n
 * The host sends nothing to the guest while it runs.
 * Files the supervisor emits: canon.jsonl (hashed), verdicts.json, and sidecar files whose
 * names start with `side-` (bridge log, tmux log; not hashed).
 */
export const HOST_PROTOCOL = {
  fileBegin: 'CHAOS-FILE',
  fileEnd: 'CHAOS-END',
  exit: 'CHAOS-EXIT',
} as const;

/**
 * Exit codes of the in-guest supervisor and of the host runner.
 *  - violation: an always is violated, an unreachable was reached, or a declared always was
 *    never evaluated (unexercised). A green run cannot be vacuous.
 *  - infra: bring-up, drive or collect threw; the report then carries the infra error and no properties.
 *  - reproDiverged: two runs of one seed produced different canonical logs.
 *  - usage: bad command line (for example a malformed --seeds value).
 * worst(codes): infra > reproDiverged > violation > ok; worst([]) = ok.
 * Seed lists: "1-3,2,7" = [1,2,3,7] (sorted, de-duplicated); "", "3-1", "a", "1,,2" are rejected.
 */
export const EXIT = {
  ok: 0,
  violation: 1,
  infra: 3,
  reproDiverged: 4,
  usage: 64,
} as const;

/** Selftest output: one JSON object in the file `selftest.json`. Compared byte for byte across boots. */
export interface SelftestReport {
  hasNetworkInterfaceOtherThanLo: boolean;
  cpuHasRdrand: boolean;
  cpuHasRdseed: boolean;
  clocksource: string;
  /** new Date().toISOString() at supervisor start. */
  wallClockAtStart: string;
  bootId: string;
  /** hex of 32 bytes from crypto.randomBytes. */
  random32: string;
  /** crypto.randomUUID(). */
  uuid: string;
  /** performance.now() rounded to µs after each of 20 steps of: 1 ms sleep, 10k-iteration loop, one child spawn of /bin/true. */
  timingProbe: number[];
  /** readdir of a directory populated with files named 0..49 created in a fixed shuffled order. */
  readdirOrder: string[];
  nodeVersion: string;
}
