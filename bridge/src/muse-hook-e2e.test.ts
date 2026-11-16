import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { LocalApiServer, type HookEvent } from './local-api-server.js';
import { packageRoot, performSetup } from './setup.js';

const FTOWN_CLI = fileURLToPath(new URL('../src/ftown-cli.ts', import.meta.url));
const BUNDLED_PLUGIN = fileURLToPath(new URL('../muse-plugin', import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/**
 * Real end-to-end proof for the installed Muse hook.
 *
 * 1. `ftown setup` (performSetup) installs a source-based `ftown-harness` shim
 *    into a scratch HOME (no prior `npm run build` needed) and "installs" the
 *    bundled Muse plugin by copying it there, as `muse plugins install` does.
 * 2. A real LocalApiServer — the production POST /hook handler — binds an
 *    ephemeral loopback port and writes its port/token to that HOME's
 *    bridge.json, exactly as a booted bridge does.
 * 3. The INSTALLED ftown-session-start.sh is fired by /bin/sh with a real Muse
 *    payload, MUSE_PLUGIN_ROOT pointed at the installed bundle, and no
 *    FTOWN_HARNESS / FTOWN_HOOK_PORT / jq / curl overrides: the wrapper must
 *    discover the canonical harness and the adapter must read the pointer.
 */
describe('installed muse hook end to end', () => {
  it('delivers a real SessionStart from the installed wrapper to a scratch bridge', async () => {
    const previousEnv = { ...process.env };
    const scratch = mkdtempSync(join(tmpdir(), 'muse-e2e-'));
    cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
    const home = join(scratch, 'home');
    mkdirSync(home);
    for (const key of Object.keys(process.env)) {
      if (key === 'HOME' || key === 'PATH' || key.startsWith('FTOWN_')
        || key.startsWith('TMUX') || key === 'XDG_CONFIG_HOME' || key === 'OPENCODE_CONFIG_DIR') {
        delete process.env[key];
      }
    }
    process.env.HOME = home;
    cleanups.push(() => {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
    });

    const installedPlugin = join(scratch, 'muse-plugin');
    await performSetup({
      root: packageRoot(),
      dependencies: {
        installRuntime: () => {
          const bin = join(home, '.ftown', 'bin');
          mkdirSync(bin, { recursive: true });
          const shim = join(bin, 'ftown-harness');
          writeFileSync(
            shim,
            [
              '#!/bin/bash',
              'if [ "${1:-}" = hook ] && [ "${2:-}" = "--help" ]; then echo "hook help"; exit 0; fi',
              `exec ${process.execPath} --import tsx ${JSON.stringify(FTOWN_CLI)} harness "$@"`,
              '',
            ].join('\n'),
            { mode: 0o755 },
          );
          chmodSync(shim, 0o755);
        },
        integrations: async () => {
          cpSync(BUNDLED_PLUGIN, installedPlugin, { recursive: true });
          return [{ name: 'muse', status: 'installed', detail: installedPlugin }];
        },
        skillAndPath: () => {},
        migrate: () => [],
      },
    });

    const installedHook = join(installedPlugin, 'hooks', 'ftown-session-start.sh');
    assert.ok(installedHook.endsWith('/hooks/ftown-session-start.sh'));

    // Scratch bridge: the real /hook handler plus a production-shaped pointer.
    const server = new LocalApiServer();
    const token = 'muse-e2e-token';
    server.setAuthToken(token);
    const events: HookEvent[] = [];
    server.on('event', (event) => events.push(event));
    const port = await server.start(0);
    cleanups.push(() => server.getHttpServer()?.closeAllConnections());
    cleanups.push(() => server.stop());
    writeFileSync(
      join(home, '.ftown', 'bridge.json'),
      JSON.stringify({ port, token, pid: process.pid }),
      { mode: 0o600 },
    );

    const payload = {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'muse-native-e2e',
      cwd: '/work/muse-e2e',
    };
    const emptyBin = join(scratch, 'empty-bin');
    mkdirSync(emptyBin);
    symlinkSync('/bin/sh', join(emptyBin, 'sh'));
    // Async spawn keeps this process's event loop free so the in-process
    // bridge can answer the POST while the hook child is running. PATH has no
    // jq, curl or ftown-harness; discovery goes through the installed paths.
    const child = spawn('/bin/sh', [installedHook], {
      env: {
        HOME: home,
        PATH: emptyBin,
        MUSE_PLUGIN_ROOT: installedPlugin,
        FTOWN_SESSION_ID: 'muse-e2e-session',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const childResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.stdin.end(JSON.stringify(payload));
    });

    assert.equal(childResult.code, 0, `installed muse hook failed: ${childResult.stderr}`);
    assert.equal(childResult.stdout, '');
    assert.equal(childResult.stderr, '', `installed muse hook logged an error: ${childResult.stderr}`);
    assert.equal(events.length, 1, 'scratch bridge did not receive the SessionStart event');
    const [event] = events;
    assert.equal(event.eventName, 'SessionStart');
    assert.equal(event.sessionId, 'muse-e2e-session');
    assert.equal(event.source, 'env');
    assert.equal((event.data as Record<string, unknown>).session_id, 'muse-native-e2e');
    assert.equal((event.data as Record<string, unknown>).cwd, '/work/muse-e2e');
  });
});
