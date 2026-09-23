import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureMusePlugin,
  hashMuseBundle,
  museBinaryAvailable,
  parseMuseInspectOutput,
  type MuseRunFn,
  type MuseRunResult,
} from './muse-plugin-installer.js';

const PROBE_KEY = 'sh -c command -v muse';
const OK_PROBE: MuseRunResult = { stdout: '/usr/local/bin/muse\n', stderr: '', exitCode: 0 };
const MISSING_PROBE: MuseRunResult = { stdout: '', stderr: '', exitCode: 1 };
const UNKNOWN_PLUGIN = JSON.stringify({
  error: { code: 'unknown-plugin', message: 'plugin `ftown` is not installed' },
});

function inspectJson(sourcePath: string | null, statuses: Array<[string, string]>): string {
  return JSON.stringify({
    record: { id: 'ftown', source: { provenance: 'native-local', path: sourcePath } },
    runtime_capabilities: statuses.map(([id, status]) => ({
      candidate: {
        kind: 'hook',
        plugin_id: 'ftown',
        capability_id: id,
        stable_id: `plugin:ftown:hook:${id}`,
        definition_hash: 'sha256:abc',
      },
      status,
      diagnostic: null,
    })),
  });
}

function approveJson(ids: string[], enabled = true): string {
  return JSON.stringify({
    decision: 'approve',
    runtime_capabilities: ids.map((id) => ({
      stable_id: `plugin:ftown:hook:${id}`,
      trusted_definition_hash: 'sha256:abc',
      enabled,
    })),
  });
}

interface RecordedCall {
  file: string;
  args: string[];
}

function makeFakeRun(handlers: Record<string, MuseRunResult>): { run: MuseRunFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: MuseRunFn = async (file, args) => {
    calls.push({ file, args });
    const key = `${file} ${args.join(' ')}`;
    const hit = handlers[key];
    if (!hit) throw new Error(`unexpected muse invocation in test: ${key}`);
    return hit;
  };
  return { run, calls };
}

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'ftown-muse-installer-'));
}

function makeBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-muse-bundle-'));
  const files: Record<string, string> = {
    '.muse-plugin/plugin.json': '{"schemaVersion":1,"id":"ftown","name":"ftown"}\n',
    'hooks/ftown-session-start.sh': '#!/bin/sh\nexit 0\n',
    'hooks/ftown-stop.sh': '#!/bin/sh\nexit 0\n',
    'lib/ftown-hook.sh': '#!/bin/sh\nexit 0\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function statePath(home: string): string {
  return join(home, '.ftown', 'muse-plugin.json');
}

describe('museBinaryAvailable', () => {
  it('is true when the probe finds muse on PATH', async () => {
    const { run } = makeFakeRun({ [PROBE_KEY]: OK_PROBE });
    assert.equal(await museBinaryAvailable(run), true);
  });

  it('is false when the probe fails or throws', async () => {
    const { run } = makeFakeRun({ [PROBE_KEY]: MISSING_PROBE });
    assert.equal(await museBinaryAvailable(run), false);
    const throwing: MuseRunFn = async () => { throw new Error('spawn ESRCH'); };
    assert.equal(await museBinaryAvailable(throwing), false);
  });
});

describe('hashMuseBundle', () => {
  it('is deterministic for identical trees', () => {
    assert.equal(hashMuseBundle(makeBundle()), hashMuseBundle(makeBundle()));
  });

  it('changes when file contents change', () => {
    const dir = makeBundle();
    const before = hashMuseBundle(dir);
    writeFileSync(join(dir, 'lib', 'ftown-hook.sh'), '#!/bin/sh\nexit 1\n');
    assert.notEqual(hashMuseBundle(dir), before);
  });

  it('changes when files are added', () => {
    const dir = makeBundle();
    const before = hashMuseBundle(dir);
    writeFileSync(join(dir, 'hooks', 'extra.sh'), '#!/bin/sh\n');
    assert.notEqual(hashMuseBundle(dir), before);
  });
});

describe('parseMuseInspectOutput', () => {
  it('reports missing for the unknown-plugin error', () => {
    assert.deepEqual(parseMuseInspectOutput(UNKNOWN_PLUGIN), { kind: 'missing' });
  });

  it('reports error for unparseable output', () => {
    const parsed = parseMuseInspectOutput('not json');
    assert.equal(parsed.kind, 'error');
  });

  it('extracts the source path and capability statuses', () => {
    const parsed = parseMuseInspectOutput(
      inspectJson('/some/dir', [['ftown-stop', 'trusted_enabled'], ['ftown-session-start', 'modified']]),
    );
    assert.deepEqual(parsed, {
      kind: 'ok',
      inspection: {
        sourcePath: '/some/dir',
        capabilities: [
          { capabilityId: 'ftown-stop', stableId: 'plugin:ftown:hook:ftown-stop', status: 'trusted_enabled' },
          { capabilityId: 'ftown-session-start', stableId: 'plugin:ftown:hook:ftown-session-start', status: 'modified' },
        ],
      },
    });
  });
});

describe('ensureMusePlugin', () => {
  it('skips silently when the muse binary is missing', async () => {
    const home = makeHome();
    const { run, calls } = makeFakeRun({ [PROBE_KEY]: MISSING_PROBE });

    const result = await ensureMusePlugin(makeBundle(), home, run);

    assert.deepEqual(result, { action: 'skipped', approved: false });
    assert.equal(calls.length, 1);
    assert.equal(existsSync(statePath(home)), false);
  });

  it('installs and approves on first run', async () => {
    const home = makeHome();
    const bundle = makeBundle();
    const { run, calls } = makeFakeRun({
      [PROBE_KEY]: OK_PROBE,
      'muse plugins inspect ftown --json': { stdout: UNKNOWN_PLUGIN, stderr: '', exitCode: 1 },
      [`muse plugins install ${bundle} --scope user --json`]: { stdout: '{}', stderr: '', exitCode: 0 },
      'muse plugins approve ftown --json': {
        stdout: approveJson(['ftown-session-start', 'ftown-stop']), stderr: '', exitCode: 0,
      },
    });

    const result = await ensureMusePlugin(bundle, home, run);

    assert.deepEqual(result, { action: 'installed', approved: true });
    assert.deepEqual(
      calls.map((call) => `${call.file} ${call.args.join(' ')}`),
      [
        PROBE_KEY,
        'muse plugins inspect ftown --json',
        `muse plugins install ${bundle} --scope user --json`,
        'muse plugins approve ftown --json',
      ],
    );
    assert.equal(
      (JSON.parse(readFileSync(statePath(home), 'utf8')) as { bundleHash: string }).bundleHash,
      hashMuseBundle(bundle),
    );
  });

  it('repairs drift with update + re-approve when the bundle changed', async () => {
    const home = makeHome();
    const bundle = makeBundle();
    mkdirSync(join(home, '.ftown'), { recursive: true });
    writeFileSync(statePath(home), '{"bundleHash":"sha256:stale"}\n');
    const { run, calls } = makeFakeRun({
      [PROBE_KEY]: OK_PROBE,
      'muse plugins inspect ftown --json': {
        stdout: inspectJson(realpathSync(bundle), [['ftown-session-start', 'trusted_enabled'], ['ftown-stop', 'trusted_enabled']]),
        stderr: '',
        exitCode: 0,
      },
      'muse plugins update ftown --json': { stdout: '{}', stderr: '', exitCode: 0 },
      'muse plugins approve ftown --json': {
        stdout: approveJson(['ftown-session-start', 'ftown-stop']), stderr: '', exitCode: 0,
      },
    });

    const result = await ensureMusePlugin(bundle, home, run);

    assert.deepEqual(result, { action: 'updated', approved: true });
    assert.ok(calls.some((call) => call.args.join(' ').includes('plugins update ftown')));
    assert.ok(calls.some((call) => call.args.join(' ') === 'plugins approve ftown --json'));
    assert.equal(
      (JSON.parse(readFileSync(statePath(home), 'utf8')) as { bundleHash: string }).bundleHash,
      hashMuseBundle(bundle),
    );
  });

  it('is idempotent — no drift and approved runs no mutating commands', async () => {
    const home = makeHome();
    const bundle = makeBundle();
    mkdirSync(join(home, '.ftown'), { recursive: true });
    writeFileSync(statePath(home), `${JSON.stringify({ bundleHash: hashMuseBundle(bundle) })}\n`);
    const { run, calls } = makeFakeRun({
      [PROBE_KEY]: OK_PROBE,
      'muse plugins inspect ftown --json': {
        stdout: inspectJson(realpathSync(bundle), [['ftown-session-start', 'trusted_enabled'], ['ftown-stop', 'trusted_enabled']]),
        stderr: '',
        exitCode: 0,
      },
    });

    const result = await ensureMusePlugin(bundle, home, run);

    assert.deepEqual(result, { action: 'none', approved: true });
    assert.deepEqual(calls.map((call) => `${call.file} ${call.args.join(' ')}`), [
      PROBE_KEY,
      'muse plugins inspect ftown --json',
    ]);
  });

  it('approves capabilities awaiting review without reinstalling', async () => {
    const home = makeHome();
    const bundle = makeBundle();
    mkdirSync(join(home, '.ftown'), { recursive: true });
    writeFileSync(statePath(home), `${JSON.stringify({ bundleHash: hashMuseBundle(bundle) })}\n`);
    const { run, calls } = makeFakeRun({
      [PROBE_KEY]: OK_PROBE,
      'muse plugins inspect ftown --json': {
        stdout: inspectJson(realpathSync(bundle), [['ftown-session-start', 'review_needed'], ['ftown-stop', 'modified']]),
        stderr: '',
        exitCode: 0,
      },
      'muse plugins approve ftown --json': {
        stdout: approveJson(['ftown-session-start', 'ftown-stop']), stderr: '', exitCode: 0,
      },
    });

    const result = await ensureMusePlugin(bundle, home, run);

    assert.deepEqual(result, { action: 'approved', approved: true });
    assert.ok(!calls.some((call) => call.args.includes('install') || call.args.includes('update')));
  });

  it('leaves user-rejected capabilities disabled', async () => {
    const home = makeHome();
    const bundle = makeBundle();
    mkdirSync(join(home, '.ftown'), { recursive: true });
    writeFileSync(statePath(home), `${JSON.stringify({ bundleHash: hashMuseBundle(bundle) })}\n`);
    const { run, calls } = makeFakeRun({
      [PROBE_KEY]: OK_PROBE,
      'muse plugins inspect ftown --json': {
        stdout: inspectJson(realpathSync(bundle), [['ftown-session-start', 'trusted_enabled'], ['ftown-stop', 'trusted_disabled']]),
        stderr: '',
        exitCode: 0,
      },
    });

    const result = await ensureMusePlugin(bundle, home, run);

    assert.equal(result.action, 'none');
    assert.equal(result.approved, false);
    assert.match(result.warning ?? '', /rejected/);
    assert.ok(!calls.some((call) => call.args.includes('approve')));
  });

  it('approves granularly when some capabilities are rejected', async () => {
    const home = makeHome();
    const bundle = makeBundle();
    mkdirSync(join(home, '.ftown'), { recursive: true });
    writeFileSync(statePath(home), `${JSON.stringify({ bundleHash: hashMuseBundle(bundle) })}\n`);
    const { run, calls } = makeFakeRun({
      [PROBE_KEY]: OK_PROBE,
      'muse plugins inspect ftown --json': {
        stdout: inspectJson(realpathSync(bundle), [['ftown-session-start', 'trusted_disabled'], ['ftown-stop', 'modified']]),
        stderr: '',
        exitCode: 0,
      },
      'muse plugins approve ftown:hook:ftown-stop --json': {
        stdout: approveJson(['ftown-stop']), stderr: '', exitCode: 0,
      },
    });

    const result = await ensureMusePlugin(bundle, home, run);

    assert.equal(result.action, 'approved');
    assert.equal(result.approved, true);
    assert.match(result.warning ?? '', /rejected/);
    assert.deepEqual(
      calls.filter((call) => call.args.includes('approve')).map((call) => call.args.join(' ')),
      ['plugins approve ftown:hook:ftown-stop --json'],
    );
  });

  it('warns instead of throwing when approve fails', async () => {
    const home = makeHome();
    const bundle = makeBundle();
    const { run } = makeFakeRun({
      [PROBE_KEY]: OK_PROBE,
      'muse plugins inspect ftown --json': { stdout: UNKNOWN_PLUGIN, stderr: '', exitCode: 1 },
      [`muse plugins install ${bundle} --scope user --json`]: { stdout: '{}', stderr: '', exitCode: 0 },
      'muse plugins approve ftown --json': { stdout: '', stderr: 'boom', exitCode: 1 },
    });

    const result = await ensureMusePlugin(bundle, home, run);

    assert.equal(result.action, 'installed');
    assert.equal(result.approved, false);
    assert.match(result.warning ?? '', /approve/);
  });

  it('warns instead of throwing when update fails', async () => {
    const home = makeHome();
    const bundle = makeBundle();
    mkdirSync(join(home, '.ftown'), { recursive: true });
    writeFileSync(statePath(home), '{"bundleHash":"sha256:stale"}\n');
    const { run } = makeFakeRun({
      [PROBE_KEY]: OK_PROBE,
      'muse plugins inspect ftown --json': {
        stdout: inspectJson(realpathSync(bundle), [['ftown-stop', 'trusted_enabled']]),
        stderr: '',
        exitCode: 0,
      },
      'muse plugins update ftown --json': { stdout: '', stderr: 'gone', exitCode: 1 },
    });

    const result = await ensureMusePlugin(bundle, home, run);

    assert.equal(result.action, 'failed');
    assert.equal(result.approved, false);
    assert.match(result.warning ?? '', /update/);
    assert.equal(readFileSync(statePath(home), 'utf8'), '{"bundleHash":"sha256:stale"}\n');
  });

  it('reinstalls when the recorded source moved', async () => {
    const home = makeHome();
    const bundle = makeBundle();
    mkdirSync(join(home, '.ftown'), { recursive: true });
    writeFileSync(statePath(home), `${JSON.stringify({ bundleHash: hashMuseBundle(bundle) })}\n`);
    const { run, calls } = makeFakeRun({
      [PROBE_KEY]: OK_PROBE,
      'muse plugins inspect ftown --json': {
        stdout: inspectJson('/elsewhere/muse-plugin', [['ftown-stop', 'trusted_enabled']]),
        stderr: '',
        exitCode: 0,
      },
      'muse plugins remove ftown --json': { stdout: '{}', stderr: '', exitCode: 0 },
      [`muse plugins install ${bundle} --scope user --json`]: { stdout: '{}', stderr: '', exitCode: 0 },
      'muse plugins approve ftown --json': {
        stdout: approveJson(['ftown-session-start', 'ftown-stop']), stderr: '', exitCode: 0,
      },
    });

    const result = await ensureMusePlugin(bundle, home, run);

    assert.deepEqual(result, { action: 'reinstalled', approved: true });
    assert.deepEqual(
      calls.map((call) => `${call.file} ${call.args.join(' ')}`),
      [
        PROBE_KEY,
        'muse plugins inspect ftown --json',
        'muse plugins remove ftown --json',
        `muse plugins install ${bundle} --scope user --json`,
        'muse plugins approve ftown --json',
      ],
    );
  });

  it('converges when a concurrent boot wins the install race', async () => {
    const home = makeHome();
    const bundle = makeBundle();
    let inspects = 0;
    const calls: RecordedCall[] = [];
    const run: MuseRunFn = async (file, args) => {
      calls.push({ file, args });
      const key = `${file} ${args.join(' ')}`;
      if (key === PROBE_KEY) return OK_PROBE;
      if (key === 'muse plugins inspect ftown --json') {
        inspects += 1;
        return inspects === 1
          ? { stdout: UNKNOWN_PLUGIN, stderr: '', exitCode: 1 }
          : {
            stdout: inspectJson(realpathSync(bundle), [['ftown-stop', 'review_needed']]),
            stderr: '',
            exitCode: 0,
          };
      }
      if (key === `muse plugins install ${bundle} --scope user --json`) {
        return { stdout: '', stderr: 'already installed', exitCode: 1 };
      }
      if (key === 'muse plugins approve ftown --json') {
        return { stdout: approveJson(['ftown-stop']), stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected muse invocation in test: ${key}`);
    };

    const result = await ensureMusePlugin(bundle, home, run);

    assert.deepEqual(result, { action: 'installed', approved: true });
  });

  it('warns instead of throwing when the bundle is unreadable', async () => {
    const { run } = makeFakeRun({ [PROBE_KEY]: OK_PROBE });

    const result = await ensureMusePlugin(join(tmpdir(), 'ftown-muse-no-such-bundle'), makeHome(), run);

    assert.equal(result.action, 'failed');
    assert.equal(result.approved, false);
    assert.match(result.warning ?? '', /muse plugin install failed/);
  });
});
