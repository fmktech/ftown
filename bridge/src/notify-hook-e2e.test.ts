import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { LocalApiServer, type HookEvent } from './local-api-server.js';
import { installNotifyScript } from './install-notify-script.js';
import { packageRoot, performSetup } from './setup.js';

const FTOWN_CLI = fileURLToPath(new URL('../src/ftown-cli.ts', import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/**
 * Real end-to-end proof for the installed notify hook.
 *
 * 1. `ftown setup` (performSetup) installs the bundled notify.sh into a scratch
 *    HOME through the same installer production uses. The runtime-copy step is
 *    replaced by a source-based `ftown-harness` shim so the proof runs without
 *    a prior `npm run build` (and therefore in the no-jq unit-minimal job).
 * 2. A real LocalApiServer — the production POST /hook handler — binds an
 *    ephemeral loopback port and writes its port/token to that HOME's
 *    bridge.json, exactly as a booted bridge does.
 * 3. The INSTALLED ~/.ftown/notify.sh is fired by bash with a real
 *    Claude-style payload and no FTOWN_HOOK_PORT/FTOWN_HARNESS overrides: the
 *    wrapper must discover the canonical harness, the adapter must read the
 *    pointer, and the bridge must emit the event.
 */
describe('installed notify hook end to end', () => {
  it('delivers a real notify event from the setup-installed wrapper to a scratch bridge', async () => {
    // Isolate HOME and drop every inherited selector so nothing can reach the
    // developer's real bridge, tmux server or opencode config.
    const previousEnv = { ...process.env };
    const scratch = mkdtempSync(join(tmpdir(), 'notify-e2e-'));
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

    // Setup, with only the dist-copy step swapped for a source-based harness.
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
          const installed = installNotifyScript(join(packageRoot(), 'hooks', 'notify.sh'));
          return [{ name: 'claude/cursor/pi', status: 'installed', detail: installed }];
        },
        skillAndPath: () => {},
        migrate: () => [],
      },
    });

    const installedHook = join(home, '.ftown', 'notify.sh');
    assert.ok(installedHook.endsWith('/notify.sh'));

    // Scratch bridge: the real /hook handler plus a production-shaped pointer.
    const server = new LocalApiServer();
    const token = 'notify-e2e-token';
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

    // Fire the INSTALLED wrapper as a harness would: no FTOWN_HARNESS or
    // FTOWN_HOOK_PORT override, so discovery of both the harness and the bridge
    // goes through the canonical paths an installed hook relies on.
    const payload = {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'notify e2e proof',
      session_id: 'claude-native-e2e',
    };
    // Async spawn keeps this process's event loop free so the in-process
    // bridge can answer the POST while the hook child is running.
    const child = spawn('/bin/bash', [installedHook], {
      env: {
        HOME: home,
        PATH: join(scratch, 'empty-bin'),
        FTOWN_SESSION_ID: 'notify-e2e-session',
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

    assert.equal(childResult.code, 0, `installed hook failed: ${childResult.stderr}`);
    assert.equal(childResult.stdout, '');
    assert.equal(childResult.stderr, '', `installed hook logged an error: ${childResult.stderr}`);
    assert.equal(events.length, 1, 'scratch bridge did not receive the notify event');
    const [event] = events;
    assert.equal(event.eventName, 'Notification');
    assert.equal(event.sessionId, 'notify-e2e-session');
    assert.equal(event.source, 'env');
    assert.equal((event.data as Record<string, unknown>).notification_type, 'permission_prompt');
    assert.equal((event.data as Record<string, unknown>).session_id, 'claude-native-e2e');
  });
});
