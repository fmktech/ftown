import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ProcessRunner } from './claude-runner.js';
import { isTmuxAvailable } from './tmux.js';
import { createFtownSession } from './create-ftown-session.js';
import { AttentionStore } from './attention-store.js';
import { LocalApiServer } from './local-api-server.js';
import { SessionStore } from './session-store.js';
import { TerminalManager } from './terminal-manager.js';
import { createTerminalOutput } from './terminal-output.js';
import type { CentrifugoClient } from './centrifugo-client.js';

const MODEL = 'opencode-go/kimi-k3.1-pro';
const PROMPT = 'say pong';

function writeFakeOpencode(dir: string): void {
  const poster = join(dir, 'post-stop.js');
  writeFileSync(poster, `
const http = require('node:http');
const body = JSON.stringify({
  ftown_session_id: process.env.FTOWN_SESSION_ID,
  hook_event_name: 'Stop',
});
const req = http.request({
  host: '127.0.0.1',
  port: process.env.FTOWN_HOOK_PORT,
  method: 'POST',
  path: '/hook',
  headers: {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    authorization: 'Bearer ' + (process.env.FTOWN_HOOK_TOKEN || ''),
  },
}, (res) => {
  res.resume();
  res.on('end', () => {
    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
      console.error('hook status ' + res.statusCode);
      process.exitCode = 1;
    }
  });
});
req.on('error', (err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
req.end(body);
`);
  writeFileSync(join(dir, 'opencode'), `#!/bin/sh
receipt="$OPENCODE_LAUNCH_RECEIPT"
{
  printf 'argv:'
  printf ' %s' "$@"
  printf '\\nconfig:%s\\n' "\${OPENCODE_CONFIG_CONTENT-}"
} > "$receipt"
if [ "\${OPENCODE_FAKE_EXIT-}" != "" ]; then
  echo "fake opencode failed" >&2
  exit "$OPENCODE_FAKE_EXIT"
fi
node ${JSON.stringify(poster)} >> "$receipt" 2>&1 || printf 'hook_error\\n' >> "$receipt"
printf 'hook_posted\\n' >> "$receipt"
while true; do sleep 30; done
`, { mode: 0o755 });
}

async function pollUntil<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
  const started = Date.now();
  let last = 'pending';
  while (Date.now() - started < 20_000) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out: ${last}`);
}

describe('opencode child launch', { concurrency: 1 }, () => {
  // The unit CI job does not install tmux. The same launch is covered there by
  // the command tests, and by e2e/tests/opencode-launch.spec.ts where tmux and
  // zsh are installed. Locally this process test is the proof.
  it('stays up, receives the prompt, reaches idle, and records a failed launch', {
    skip: isTmuxAvailable() ? false : 'tmux is not installed',
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-launch-'));
    const fakeDir = join(root, 'bin');
    const workDir = join(root, 'work');
    const socketDir = mkdtempSync(join(root, 'sock-'));
    mkdirSync(fakeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFakeOpencode(fakeDir);
    const previousTmux = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = socketDir;

    const dataDir = join(root, 'data');
    const store = new SessionStore(dataDir);
    const runner = new ProcessRunner();
    const output = createTerminalOutput({
      store,
      terminalManager: new TerminalManager(),
      runner,
      router: {
        hasAttachedPeers: () => false,
        publishTerminalData: () => {},
        publishTerminalScreen: () => {},
      },
      watchRegistry: { hasWatchers: () => false },
      lifecycle: {
        publishSessionUpdate: async () => {},
        publishHookEvent: async () => {},
        unregisterSession: () => {},
        collectUsage: async () => null,
      },
    });
    const attention = new AttentionStore((id) => store.sessionDir(id));
    const server = new LocalApiServer();
    const token = 'opencode-launch-token';
    server.setAuthToken(token);
    server.setDependencies(store, runner, { publishSessionUpdate: async () => {} } as CentrifugoClient, 'user');
    server.setAttentionStore(attention);
    const port = await server.start();
    const liveReceipt = join(root, 'live.txt');
    const deadReceipt = join(root, 'dead.txt');
    const ids: string[] = [];
    try {
      const live = await createFtownSession({
        store,
        runner,
        centrifugo: { publishSessionUpdate: async () => {} } as CentrifugoClient,
        userId: 'user',
        bridgeId: 'bridge',
        hookPort: port,
        hookToken: token,
        notifyScriptPath: '',
        wireTerminalInput: () => {},
      }, {
        shellType: 'opencode',
        model: MODEL,
        prompt: PROMPT,
        name: 'opencode-launch-live',
        workingDir: workDir,
        env: {
          PATH: `${fakeDir}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
          OPENCODE_LAUNCH_RECEIPT: liveReceipt,
        },
      });
      ids.push(live.id);
      assert.equal(live.command, 'opencode --standalone --auto');
      assert.equal(live.command.includes(' -m '), false);
      assert.equal(live.env?.OPENCODE_CONFIG_CONTENT, `{"model":"${MODEL}"}`);

      const receipt = await pollUntil('prompt receipt', async () => {
        try {
          const text = readFileSync(liveReceipt, 'utf8');
          if (!text.includes('hook_posted') && !text.includes('hook_error')) return undefined;
          return text;
        } catch {
          return undefined;
        }
      });
      assert.match(receipt, /argv: --standalone --auto --prompt say pong/);
      assert.match(receipt, new RegExp(`config:\\{"model":"${MODEL}"\\}`));
      assert.equal(receipt.includes(' -m '), false);
      assert.equal(receipt.includes('hook_error'), false);

      await pollUntil('idle', async () => {
        const page = await attention.list(live.id);
        return page.activity.state === 'idle' ? page.activity.state : undefined;
      });
      const running = await store.loadSession(live.id);
      assert.equal(running?.status, 'running');
      assert.equal(running?.errorReason, undefined);

      const dead = await createFtownSession({
        store,
        runner,
        centrifugo: { publishSessionUpdate: async () => {} } as CentrifugoClient,
        userId: 'user',
        bridgeId: 'bridge',
        hookPort: port,
        hookToken: token,
        notifyScriptPath: '',
        wireTerminalInput: () => {},
      }, {
        shellType: 'opencode',
        model: MODEL,
        prompt: PROMPT,
        name: 'opencode-launch-dead',
        workingDir: workDir,
        env: {
          PATH: `${fakeDir}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
          OPENCODE_LAUNCH_RECEIPT: deadReceipt,
          OPENCODE_FAKE_EXIT: '1',
        },
      });
      ids.push(dead.id);
      const failed = await pollUntil('error status', async () => {
        const session = await store.loadSession(dead.id);
        if (session?.status === 'error' && session.errorReason) return session.errorReason;
        return undefined;
      });
      const stored = await store.loadSession(dead.id);
      assert.equal(typeof stored?.errorReason, 'string');
      assert.ok(stored?.errorReason && stored.errorReason.length > 0);
      assert.equal(stored?.errorReason, failed);
      assert.match(failed, /Process exited with code 1/);
    } finally {
      for (const id of ids) runner.stop(id);
      await output.stop();
      server.getHttpServer()?.closeAllConnections();
      server.stop();
      try {
        execFileSync('tmux', ['-L', 'ftown', 'kill-server'], { env: process.env, stdio: 'ignore' });
      } catch {
        // The private server is already gone.
      }
      if (previousTmux === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previousTmux;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
