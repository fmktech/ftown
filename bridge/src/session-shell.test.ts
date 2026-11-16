import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { HARNESSES } from './harness-registry.js';
import {
  quoteShellArgument,
  resolveSessionShell,
  sessionShellArgs,
  sessionShellCommandLine,
  type SessionShell,
} from './session-shell.js';
import {
  __resetSessionShellResolverForTest,
  __setSessionShellResolverForTest,
  createTmuxSession,
  isTmuxAvailable,
  killTmuxSession,
  readAndClearExitCode,
} from './tmux.js';

const bash: SessionShell = { file: '/bin/bash', kind: 'bash' };
const MARKER = 'FTOWN_SHELL_TMUX_OK';

describe('resolveSessionShell', () => {
  it('prefers an executable $SHELL over the passwd shell', () => {
    assert.deepEqual(resolveSessionShell({
      env: { SHELL: '/bin/zsh' },
      readPasswdShell: () => '/bin/bash',
      isExecutable: () => true,
    }), { file: '/bin/zsh', kind: 'zsh' });
  });

  it('uses the passwd login shell when $SHELL is unset, empty or unsupported', () => {
    for (const shell of [undefined, '', '/usr/bin/env', 'bash', '/usr/sbin/nologin']) {
      assert.deepEqual(resolveSessionShell({
        env: shell === undefined ? {} : { SHELL: shell },
        readPasswdShell: () => '/usr/bin/fish',
        isExecutable: () => true,
      }), { file: '/usr/bin/fish', kind: 'fish' });
    }
  });

  it('skips a non-executable $SHELL and falls through to passwd', () => {
    assert.deepEqual(resolveSessionShell({
      env: { SHELL: '/opt/missing/zsh' },
      readPasswdShell: () => '/bin/bash',
      isExecutable: (file) => file === '/bin/bash',
    }), { file: '/bin/bash', kind: 'bash' });
  });

  it('recognises each supported shell kind from the basename', () => {
    for (const [file, kind] of [
      ['/bin/zsh', 'zsh'],
      ['/usr/local/bin/bash', 'bash'],
      ['/bin/sh', 'sh'],
      ['/usr/bin/dash', 'dash'],
      ['/opt/home/bin/fish', 'fish'],
    ] as const) {
      assert.deepEqual(resolveSessionShell({
        env: { SHELL: file },
        readPasswdShell: () => null,
        isExecutable: () => true,
      }), { file, kind });
    }
  });

  it('falls back to /bin/bash, then /bin/sh', () => {
    assert.deepEqual(resolveSessionShell({
      env: {},
      readPasswdShell: () => null,
      isExecutable: (file) => file === '/bin/bash',
    }), { file: '/bin/bash', kind: 'bash' });
    assert.deepEqual(resolveSessionShell({
      env: {},
      readPasswdShell: () => null,
      isExecutable: () => false,
    }), { file: '/bin/sh', kind: 'sh' });
  });

  it('tolerates a throwing passwd lookup or executable probe', () => {
    assert.deepEqual(resolveSessionShell({
      env: {},
      readPasswdShell: () => { throw new Error('no account entry'); },
      isExecutable: (file) => file === '/bin/bash',
    }), { file: '/bin/bash', kind: 'bash' });
    assert.deepEqual(resolveSessionShell({
      env: { SHELL: '/bin/zsh' },
      readPasswdShell: () => null,
      isExecutable: () => { throw new Error('stat failed'); },
    }), { file: '/bin/sh', kind: 'sh' });
  });

  it('keeps the final fallback unconditional when the account entry is broken', () => {
    assert.deepEqual(resolveSessionShell({
      env: { SHELL: '/nope/false' },
      readPasswdShell: () => '/usr/sbin/nologin',
      isExecutable: (file) => file === '/bin/bash',
    }), { file: '/bin/bash', kind: 'bash' });
  });
});

describe('login shell arguments and quoting', () => {
  it('uses -l and passes the command as one -c argument for every shell', () => {
    for (const kind of ['zsh', 'bash', 'sh', 'dash', 'fish'] as const) {
      const shell: SessionShell = { file: `/bin/${kind}`, kind };
      assert.deepEqual(sessionShellArgs(shell), ['-l']);
      assert.deepEqual(sessionShellArgs(shell, "echo it's ok"), ['-l', '-c', "echo it's ok"]);
    }
  });

  it('renders a login command line with POSIX single quotes', () => {
    assert.equal(sessionShellCommandLine(bash), "'/bin/bash' -l");
    assert.equal(
      sessionShellCommandLine(bash, "echo it's ok"),
      "'/bin/bash' -l -c 'echo it'\\''s ok'",
    );
  });

  it('renders a command that a POSIX sh outer shell can hand to bash', {
    skip: process.platform === 'win32',
  }, () => {
    const line = sessionShellCommandLine(bash, 'printf %s OK');
    assert.equal(execFileSync('/bin/sh', ['-c', line], { encoding: 'utf8' }), 'OK');
  });

  it('quotes spaces, apostrophes, backslashes, newlines and Unicode losslessly', {
    skip: process.platform === 'win32',
  }, () => {
    for (const value of [
      'plain',
      'has spaces',
      "it's a quote",
      'back\\slash',
      'line1\nline2',
      'héllo — 世界',
      'tab\there',
    ]) {
      const rendered = execFileSync(
        '/bin/sh',
        ['-c', `printf '%s' ${quoteShellArgument(value)}`],
        { encoding: 'utf8' },
      );
      assert.equal(rendered, value);
    }
  });

  it('builds the plain shell harness command from the resolver', () => {
    assert.match(HARNESSES.shell.buildCommand({}), /^'\/.+' -l$/);
  });
});

describe('real tmux launch under bash', () => {
  afterEach(() => {
    __resetSessionShellResolverForTest();
  });

  it('starts a tmux session through the resolved bash login shell', {
    skip: process.platform === 'win32' || !isTmuxAvailable(),
  }, async () => {
    __setSessionShellResolverForTest(() => bash);
    const root = mkdtempSync(join(tmpdir(), 'ftown-shell-tmux-'));
    const previousTmpdir = process.env.TMUX_TMPDIR;
    const socketDir = join(root, 'sockets');
    process.env.TMUX_TMPDIR = socketDir;
    mkdirSync(socketDir);
    const out = join(root, 'out.txt');
    const sessionId = `shell-resolver-${process.pid}`;
    try {
      await createTmuxSession({
        sessionId,
        command: `printf '%s\\n' ${MARKER} > ${quoteShellArgument(out)}`,
        cwd: root,
        cols: 80,
        rows: 24,
        // Keep creation on the same isolated socket that cleanup targets.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMUX_TMPDIR: socketDir },
      });

      const deadline = Date.now() + 20_000;
      let code: number | undefined;
      while (Date.now() < deadline) {
        code = readAndClearExitCode(sessionId);
        if (code !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.notEqual(code, undefined, 'tmux session did not exit in time');
      assert.equal(code, 0);
      assert.equal(readFileSync(out, 'utf8').trim(), MARKER);
    } finally {
      await killTmuxSession(sessionId);
      try {
        execFileSync('tmux', ['-L', 'ftown', 'kill-server'], { stdio: 'ignore', env: process.env });
      } catch {
        // The private server is already gone.
      }
      if (previousTmpdir === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previousTmpdir;
      __resetSessionShellResolverForTest();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
