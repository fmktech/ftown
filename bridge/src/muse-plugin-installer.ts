import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

/** Plugin id of the bundled ftown Muse plugin (bridge/muse-plugin). */
export const MUSE_PLUGIN_ID = 'ftown';

/** Outcome of one spawned child process. Never thrown — failures surface as exitCode. */
export interface MuseRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Child-process runner, injectable so tests can stub `muse plugins` calls
 * (the real CLI is never spawned in unit tests).
 */
export type MuseRunFn = (file: string, args: string[]) => Promise<MuseRunResult>;

async function defaultRunMuseCommand(file: string, args: string[]): Promise<MuseRunResult> {
  // spawn (not execFile): stdin MUST be /dev/null so `muse plugins approve`
  // can never block on an interactive prompt — execFile leaves stdin a pipe
  // that a stdin reader blocks on until timeout.
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number, errText?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr || errText || '', exitCode });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(1, `timed out after 15000ms: ${file} ${args.join(' ')}`);
    }, 15000);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 1024 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => finish(1, err.message));
    child.on('close', (code: number | null) => finish(code ?? 1));
  });
}

/** True when the `muse` binary is reachable on PATH (cheap probe). */
export async function museBinaryAvailable(run: MuseRunFn = defaultRunMuseCommand): Promise<boolean> {
  try {
    const result = await run('sh', ['-c', 'command -v muse']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Deterministic content hash of a plugin bundle directory: sorted relative
 * paths plus file bytes (modes excluded — the install cache may normalize
 * them). Used to detect bundle drift across bridge upgrades.
 */
export function hashMuseBundle(bundledDir: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(bundledDir);
  files.sort();
  const hash = createHash('sha256');
  for (const full of files) {
    hash.update(relative(bundledDir, full));
    hash.update('\0');
    hash.update(readFileSync(full));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export interface MusePluginCapabilityState {
  capabilityId: string;
  stableId: string;
  status: string;
}

export interface MusePluginInspection {
  sourcePath: string | null;
  capabilities: MusePluginCapabilityState[];
}

type InspectParse =
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; inspection: MusePluginInspection };

/** Parse `muse plugins inspect ftown --json` stdout (pure — unit-tested). */
export function parseMuseInspectOutput(stdout: string): InspectParse {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { kind: 'error', message: 'unparseable inspect output' };
  }
  const error = parsed.error as { code?: unknown } | undefined;
  if (error && typeof error === 'object') {
    if (error.code === 'unknown-plugin') return { kind: 'missing' };
    return { kind: 'error', message: `inspect error: ${String((error as { message?: unknown }).message ?? error.code)}` };
  }
  const record = parsed.record as { source?: { path?: unknown } } | undefined;
  const sourcePath = typeof record?.source?.path === 'string' ? record.source.path : null;
  const rawCaps = Array.isArray(parsed.runtime_capabilities) ? parsed.runtime_capabilities : [];
  const capabilities: MusePluginCapabilityState[] = rawCaps.map((entry) => {
    const candidate = (entry as { candidate?: { capability_id?: unknown; stable_id?: unknown } })
      ?.candidate ?? {};
    const stableId = typeof candidate.stable_id === 'string' ? candidate.stable_id : '';
    const capabilityId = typeof candidate.capability_id === 'string' && candidate.capability_id
      ? candidate.capability_id
      : stableId.split(':').pop() ?? '';
    const status = typeof (entry as { status?: unknown }).status === 'string'
      ? (entry as { status: string }).status
      : 'unknown';
    return { capabilityId, stableId, status };
  });
  return { kind: 'ok', inspection: { sourcePath, capabilities } };
}

async function inspectMusePlugin(run: MuseRunFn): Promise<MusePluginInspection | null> {
  const result = await run('muse', ['plugins', 'inspect', MUSE_PLUGIN_ID, '--json']);
  const parsed = parseMuseInspectOutput(result.stdout);
  if (parsed.kind === 'missing') return null;
  if (parsed.kind === 'error') {
    throw new Error(
      `muse plugins inspect ${MUSE_PLUGIN_ID} failed: ${parsed.message}` +
      (result.exitCode !== 0 ? ` (exit ${result.exitCode})` : ''),
    );
  }
  return parsed.inspection;
}

function snippet(text: string, max = 200): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/**
 * Run `muse plugins approve <target> --json` (stdin ignored ⇒ non-interactive)
 * and verify every reported capability landed enabled:true.
 */
async function approveMuseCapabilities(
  run: MuseRunFn,
  target: string,
): Promise<{ approved: boolean; warning?: string }> {
  const result = await run('muse', ['plugins', 'approve', target, '--json']);
  if (result.exitCode !== 0) {
    return {
      approved: false,
      warning: `muse plugins approve ${target} failed (exit ${result.exitCode}): ${snippet(result.stderr) || 'no details'}`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      decision?: unknown;
      runtime_capabilities?: Array<{ stable_id?: unknown; enabled?: unknown }>;
    };
    const caps = Array.isArray(parsed.runtime_capabilities) ? parsed.runtime_capabilities : [];
    const verified = parsed.decision === 'approve'
      && caps.length > 0
      && caps.every((cap) => cap.enabled === true);
    if (!verified) {
      return { approved: false, warning: `muse plugins approve ${target} could not be verified from its output` };
    }
    return { approved: true };
  } catch {
    return { approved: false, warning: `muse plugins approve ${target} returned unparseable output` };
  }
}

function musePluginStatePath(home: string): string {
  return join(home, '.ftown', 'muse-plugin.json');
}

function readMusePluginState(home: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(musePluginStatePath(home), 'utf8')) as { bundleHash?: unknown };
    return typeof parsed.bundleHash === 'string' ? parsed.bundleHash : null;
  } catch {
    return null;
  }
}

function writeMusePluginState(home: string, bundleHash: string): void {
  const path = musePluginStatePath(home);
  mkdirSync(join(home, '.ftown'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ bundleHash })}\n`, { mode: 0o600 });
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export type MusePluginEnsureAction =
  | 'skipped'
  | 'installed'
  | 'reinstalled'
  | 'updated'
  | 'approved'
  | 'none'
  | 'failed';

export interface MusePluginEnsureResult {
  action: MusePluginEnsureAction;
  /** True when every hook capability is trusted+enabled (best-effort). */
  approved: boolean;
  /** Human-readable warning for the bridge log; set instead of throwing. */
  warning?: string;
}

const NEEDS_REVIEW = new Set(['review_needed', 'modified']);

/**
 * Install the bundled ftown Muse plugin (`muse plugins install <dir>
 * --scope user`) on first run, refresh it on content drift (`muse plugins
 * update ftown` + re-approve), and otherwise verify the approval state.
 *
 * User-rejected (`trusted_disabled`) capabilities are left alone — only
 * `review_needed`/`modified` capabilities are approved.
 *
 * Never rejects: every failure surfaces as `{action:'failed'|'…', warning}`
 * so the bridge still boots when `muse` is absent or broken. Callers log
 * `result.warning` (and the action) to the bridge log.
 */
export async function ensureMusePlugin(
  bundledDir: string,
  home: string = homedir(),
  run: MuseRunFn = defaultRunMuseCommand,
): Promise<MusePluginEnsureResult> {
  try {
    if (!(await museBinaryAvailable(run))) {
      return { action: 'skipped', approved: false };
    }

    const bundleHash = hashMuseBundle(bundledDir);
    let inspection: MusePluginInspection | null;
    try {
      inspection = await inspectMusePlugin(run);
    } catch (err) {
      return {
        action: 'failed',
        approved: false,
        warning: err instanceof Error ? err.message : String(err),
      };
    }

    // First run (or a record that vanished): install, then approve.
    if (!inspection) {
      const installed = await run(
        'muse',
        ['plugins', 'install', bundledDir, '--scope', 'user', '--json'],
      );
      if (installed.exitCode !== 0) {
        // A concurrent bridge boot may have won the race — re-inspect before
        // reporting failure so the loser still converges on approve/verify.
        const retry = await inspectMusePlugin(run).catch(() => null);
        if (!retry) {
          return {
            action: 'failed',
            approved: false,
            warning: `muse plugins install failed (exit ${installed.exitCode}): ${snippet(installed.stderr) || 'no details'}`,
          };
        }
      }
      const approval = await approveMuseCapabilities(run, MUSE_PLUGIN_ID);
      try {
        writeMusePluginState(home, bundleHash);
      } catch (err) {
        return {
          action: 'installed',
          approved: approval.approved,
          warning: [
            approval.warning,
            `could not persist muse plugin state: ${err instanceof Error ? err.message : String(err)}`,
          ].filter(Boolean).join('; '),
        };
      }
      void inspection;
      return { action: 'installed', approved: approval.approved, ...(approval.warning ? { warning: approval.warning } : {}) };
    }

    // The bridge moved (or the record points elsewhere): `update` refreshes
    // from the RECORDED source, so reinstall from this bundle instead.
    if (inspection.sourcePath !== null && inspection.sourcePath !== safeRealpath(bundledDir)) {
      await run('muse', ['plugins', 'remove', MUSE_PLUGIN_ID, '--json']);
      const installed = await run(
        'muse',
        ['plugins', 'install', bundledDir, '--scope', 'user', '--json'],
      );
      if (installed.exitCode !== 0) {
        return {
          action: 'failed',
          approved: false,
          warning: `muse plugins reinstall failed (exit ${installed.exitCode}): ${snippet(installed.stderr) || 'no details'}`,
        };
      }
      const approval = await approveMuseCapabilities(run, MUSE_PLUGIN_ID);
      try {
        writeMusePluginState(home, bundleHash);
      } catch (err) {
        return {
          action: 'reinstalled',
          approved: approval.approved,
          warning: [
            approval.warning,
            `could not persist muse plugin state: ${err instanceof Error ? err.message : String(err)}`,
          ].filter(Boolean).join('; '),
        };
      }
      return { action: 'reinstalled', approved: approval.approved, ...(approval.warning ? { warning: approval.warning } : {}) };
    }

    // Content drift (bridge upgrade changed the bundle): update + re-approve.
    // A missing/corrupt state file reads as drift — one self-healing cycle.
    if (readMusePluginState(home) !== bundleHash) {
      const updated = await run('muse', ['plugins', 'update', MUSE_PLUGIN_ID, '--json']);
      if (updated.exitCode !== 0) {
        return {
          action: 'failed',
          approved: false,
          warning: `muse plugins update ${MUSE_PLUGIN_ID} failed (exit ${updated.exitCode}): ${snippet(updated.stderr) || 'no details'}`,
        };
      }
      const approval = await approveMuseCapabilities(run, MUSE_PLUGIN_ID);
      try {
        writeMusePluginState(home, bundleHash);
      } catch (err) {
        return {
          action: 'updated',
          approved: approval.approved,
          warning: [
            approval.warning,
            `could not persist muse plugin state: ${err instanceof Error ? err.message : String(err)}`,
          ].filter(Boolean).join('; '),
        };
      }
      return { action: 'updated', approved: approval.approved, ...(approval.warning ? { warning: approval.warning } : {}) };
    }

    // No drift: verify the approval state, approving only what needs review.
    if (inspection.capabilities.length === 0) {
      return {
        action: 'none',
        approved: false,
        warning: `installed ${MUSE_PLUGIN_ID} plugin reports no hook capabilities`,
      };
    }
    const needsReview = inspection.capabilities.filter((cap) => NEEDS_REVIEW.has(cap.status));
    const rejected = inspection.capabilities.filter((cap) => cap.status === 'trusted_disabled');
    if (needsReview.length === 0) {
      if (rejected.length > 0) {
        return {
          action: 'none',
          approved: false,
          warning: `muse plugin ${MUSE_PLUGIN_ID} has user-rejected hook capabilities; leaving them disabled`,
        };
      }
      return { action: 'none', approved: true };
    }
    if (rejected.length === 0) {
      const approval = await approveMuseCapabilities(run, MUSE_PLUGIN_ID);
      return { action: 'approved', approved: approval.approved, ...(approval.warning ? { warning: approval.warning } : {}) };
    }
    // Mixed: approve granularly so user rejects are not stomped.
    const warnings: string[] = [
      `muse plugin ${MUSE_PLUGIN_ID} has user-rejected hook capabilities; leaving them disabled`,
    ];
    let approved = true;
    for (const cap of needsReview) {
      const target = cap.capabilityId ? `${MUSE_PLUGIN_ID}:hook:${cap.capabilityId}` : cap.stableId;
      const approval = await approveMuseCapabilities(run, target);
      approved = approved && approval.approved;
      if (approval.warning) warnings.push(approval.warning);
    }
    return { action: 'approved', approved, warning: warnings.join('; ') };
  } catch (err) {
    return {
      action: 'failed',
      approved: false,
      warning: `muse plugin install failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
