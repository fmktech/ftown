// Pure comparison, summary and exit-code logic for the host runner.
import { createHash } from 'node:crypto';
import { EXIT } from '../contract.ts';
import { worst } from '../core/evaluate.ts';

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Outcome of one boot. infraError is set when the boot produced no usable result. */
export interface BootResult {
  exitCode: number;
  infraError: string | null;
  /** sha256 of canon.jsonl (run) or selftest.json (selftest); null on infra error. */
  hash: string | null;
  /** Hashed file contents, kept to show differences. */
  content: string | null;
  wallMs: number;
}

export interface SeedSummary {
  seed: number;
  hRun: string | null;
  violated: string[];
  wallSec: number;
  /** Wall seconds of each boot, in run order. */
  bootWallSec: number[];
  exitCode: number;
  nondeterminism: string | null;
  infraError: string | null;
}

/** First differing line of two texts (1-based), or null when equal. */
export function firstDiffLine(a: string, b: string): { line: number; a: string; b: string } | null {
  if (a === b) return null;
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return { line: i + 1, a: la[i] ?? '<eof>', b: lb[i] ?? '<eof>' };
  }
  return { line: la.length, a: '<eof>', b: '<eof>' };
}

/** Keys whose JSON values differ between two objects (sorted). Non-objects compare as key "<root>". */
export function differingKeys(a: unknown, b: unknown): string[] {
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (!isObj(a) || !isObj(b)) return JSON.stringify(a) === JSON.stringify(b) ? [] : ['<root>'];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** Property ids with a verdict record of status 'violated' in a canonical log. Sorted, unique. */
export function violatedProps(canon: string): string[] {
  const out = new Set<string>();
  for (const line of canon.split('\n')) {
    if (line === '') continue;
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }
    if (typeof rec === 'object' && rec !== null) {
      const r = rec as { k?: unknown; prop?: unknown; status?: unknown };
      if (r.k === 'verdict' && r.status === 'violated' && typeof r.prop === 'string') out.add(r.prop);
    }
  }
  return [...out].sort();
}

/**
 * Worst exit code. usage (64) wins outright: the guest rejected its input (e.g. a bad
 * --drop-faults token), so no other result is meaningful. Otherwise core worst():
 * infra > reproDiverged > violation > ok; unknown guest codes count as infra.
 */
export function worstExit(codes: readonly number[]): number {
  if (codes.includes(EXIT.usage)) return EXIT.usage;
  const known: readonly number[] = [EXIT.ok, EXIT.violation, EXIT.reproDiverged, EXIT.infra];
  return worst(codes.map((c) => (known.includes(c) ? c : EXIT.infra)));
}

/** Combines the boots of one seed. */
export function summarizeSeed(seed: number, boots: readonly BootResult[]): SeedSummary {
  const wallSec = boots.reduce((s, b) => s + b.wallMs, 0) / 1000;
  const bootWallSec = boots.map((b) => Math.round(b.wallMs / 100) / 10);
  const infra = boots.find((b) => b.infraError !== null);
  if (infra) {
    return { seed, hRun: null, violated: [], wallSec, bootWallSec, exitCode: EXIT.infra, nondeterminism: null, infraError: infra.infraError };
  }
  const first = boots[0];
  let nondeterminism: string | null = null;
  for (let k = 1; k < boots.length && nondeterminism === null; k++) {
    const b = boots[k];
    if (b.hash !== first.hash) {
      const d = firstDiffLine(first.content ?? '', b.content ?? '');
      nondeterminism = d ? `run1 vs run${k + 1} differ at line ${d.line}:\n  run1: ${d.a}\n  run${k + 1}: ${d.b}` : `run1 vs run${k + 1} hashes differ`;
    } else if (b.exitCode !== first.exitCode) {
      nondeterminism = `run1 exit ${first.exitCode} vs run${k + 1} exit ${b.exitCode}`;
    }
  }
  return {
    seed,
    hRun: first.hash,
    violated: violatedProps(first.content ?? ''),
    wallSec,
    bootWallSec,
    exitCode: nondeterminism !== null ? EXIT.reproDiverged : worstExit([first.exitCode]),
    nondeterminism,
    infraError: null,
  };
}

export function formatSeedLine(s: SeedSummary): string {
  const h = s.hRun === null ? '-'.repeat(12) : s.hRun.slice(0, 12);
  const v = s.violated.length === 0 ? '-' : s.violated.join(',');
  const tag = s.infraError !== null ? ` INFRA: ${s.infraError}` : s.nondeterminism !== null ? ' NONDETERMINISTIC' : '';
  return `seed ${s.seed}  H_run=${h}  violated=${v}  wall=${s.wallSec.toFixed(1)}s (${s.bootWallSec.map((w) => w.toFixed(1)).join('+')})  exit=${s.exitCode}${tag}`;
}

/** Removes kernel printk timestamps so console logs compare on content only. */
export function normalizeConsole(text: string): string {
  return text.replace(/\r/g, '').replace(/^\[\s*\d+\.\d+\] /gm, '');
}

/** Reason a guest died, read from its console log, or null. Pure. */
export function consoleFailure(consoleText: string): string | null {
  const lines = normalizeConsole(consoleText).split('\n');
  const find = (re: RegExp) => lines.find((l) => re.test(l));
  const failed = find(/^chaos-init: FAILED /);
  if (failed) return failed.trim();
  const panic = find(/Kernel panic/);
  if (panic) return panic.trim();
  const oom = find(/Out of memory|oom-kill|invoked oom-killer/);
  if (oom) return `guest out of memory: ${oom.trim()}`;
  return null;
}

/** Assertions a selftest report must satisfy; returns the failed ones. Pure. */
export function selftestAssertions(rep: Record<string, unknown>, rtcBaseDate: string): string[] {
  const failed: string[] = [];
  for (const k of ['hasNetworkInterfaceOtherThanLo', 'cpuHasRdrand', 'cpuHasRdseed']) {
    if (rep[k] !== false) failed.push(`${k} must be false, got ${JSON.stringify(rep[k])}`);
  }
  if (rep.clocksource !== 'tsc') failed.push(`clocksource must be tsc, got ${JSON.stringify(rep.clocksource)}`);
  if (typeof rep.wallClockAtStart !== 'string' || !rep.wallClockAtStart.startsWith(rtcBaseDate)) {
    failed.push(`wallClockAtStart must start with ${rtcBaseDate}, got ${JSON.stringify(rep.wallClockAtStart)}`);
  }
  return failed;
}
