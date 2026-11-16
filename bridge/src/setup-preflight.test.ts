import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  assertPreflightReady,
  detectDistro,
  detectShell,
  formatPreflight,
  installHint,
  nodeStatus,
  runPreflight,
  which,
  type PackageManager,
  type PreflightEnv,
} from './setup-preflight.js';
import { runSetup } from './setup.js';

interface Fixture {
  dir: string;
  bin: string;
  osRelease: string;
  passwd: string;
  env: PreflightEnv;
  setRelease: (text: string) => void;
  setPasswd: (text: string) => void;
  cleanup: () => void;
}

/** Faked PATH, /etc/os-release and /etc/passwd: no file outside the fixture exists. */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-preflight-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const osRelease = join(dir, 'os-release');
  const passwd = join(dir, 'passwd');
  let releaseText = 'ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu"\n';
  let passwdText = '';
  const env: PreflightEnv = {
    env: { PATH: bin },
    platform: 'linux',
    nodeVersion: 'v24.12.0',
    osReleasePath: osRelease,
    passwdPath: passwd,
    uid: 1000,
    exists: (path) => path.startsWith(dir) && existsSync(path),
    readFile: (path) => {
      if (path === osRelease) return releaseText;
      if (path === passwd) return passwdText;
      throw new Error(`unexpected read: ${path}`);
    },
  };
  return {
    dir, bin, osRelease, passwd, env,
    setRelease: (text) => { releaseText = text; },
    setPasswd: (text) => { passwdText = text; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function withFixture(run: (f: Fixture) => void): void {
  const f = fixture();
  try { run(f); } finally { f.cleanup(); }
}

function fakeBinary(bin: string, name: string): string {
  const path = join(bin, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

/** Fixture with a usable shell and git, but no tmux/jq/curl (all optional). */
function readyFixture(): Fixture {
  const f = fixture();
  const shell = fakeBinary(f.bin, 'bash');
  f.setPasswd(`user:x:1000:1000:user:/home/user:${shell}\n`);
  f.env.env.SHELL = shell;
  fakeBinary(f.bin, 'git');
  return f;
}

describe('detectDistro — per-distro package manager', () => {
  const cases: Array<[raw: string, distro: string, manager: PackageManager]> = [
    ['ID=ubuntu\n', 'ubuntu', 'apt'],
    ['ID=debian\nID_LIKE=ubuntu\n', 'debian', 'apt'],
    ['ID=linuxmint\nID_LIKE="ubuntu debian"\n', 'linuxmint', 'apt'],
    ['ID=fedora\n', 'fedora', 'dnf'],
    ['ID=rocky\nID_LIKE="rhel fedora"\n', 'rocky', 'dnf'],
    ['ID=arch\n', 'arch', 'pacman'],
    ['ID=manjaro\nID_LIKE=archlinux\n', 'manjaro', 'pacman'],
    ['ID=alpine\n', 'alpine', 'apk'],
    ['ID=opensuse-leap\nID_LIKE="suse opensuse"\n', 'opensuse-leap', 'zypper'],
  ];

  for (const [raw, distro, manager] of cases) {
    it(`maps ${distro} to ${manager}`, () => withFixture((f) => {
      f.setRelease(raw);
      assert.deepEqual(detectDistro(f.env), { distro, packageManager: manager });
    }));
  }

  it('uses brew on macOS and reports unknown distros honestly', () => withFixture((f) => {
    assert.deepEqual(detectDistro({ ...f.env, platform: 'darwin' }), { distro: 'darwin', packageManager: 'brew' });
    f.setRelease('ID=some-unknown-distro\n');
    assert.deepEqual(detectDistro(f.env), { distro: 'some-unknown-distro', packageManager: 'unknown' });
    f.setRelease('');
    assert.deepEqual(detectDistro(f.env), { distro: 'unknown', packageManager: 'unknown' });
  }));
});

describe('installHint', () => {
  it('renders a command for every supported manager', () => {
    const expected: Record<PackageManager, RegExp> = {
      apt: /apt-get install -y tmux jq/,
      dnf: /dnf install -y tmux jq/,
      pacman: /pacman -S --noconfirm tmux jq/,
      apk: /apk add --no-cache tmux jq/,
      brew: /brew install tmux jq/,
      zypper: /zypper install -y tmux jq/,
    };
    for (const [manager, pattern] of Object.entries(expected)) {
      assert.match(installHint(manager as PackageManager, ['tmux', 'jq']), pattern);
    }
    assert.match(installHint('unknown', ['jq']), /install jq with your system package manager/);
    assert.equal(installHint('apt', []), '');
  });
});

describe('which — faked PATH', () => {
  it('finds only binaries on PATH and respects an empty PATH', () => withFixture((f) => {
    const git = fakeBinary(f.bin, 'git');
    assert.equal(which('git', f.env), git);
    assert.equal(which('tmux', f.env), undefined);
    assert.equal(which('git', { ...f.env, env: { PATH: '' } }), undefined);
  }));
});

describe('nodeStatus', () => {
  it('requires Node 22+ and reports the version', () => {
    assert.equal(nodeStatus('v18.20.0').ok, false);
    assert.equal(nodeStatus('22.23.4').ok, true);
    assert.equal(nodeStatus('v24.12.0').ok, true);
    assert.equal(nodeStatus('not-a-version').ok, false);
    assert.match(nodeStatus('v18.20.0').detail, /Node\.js 22\+ required/);
  });
});

describe('detectShell — $SHELL / passwd / bash / sh', () => {
  it('prefers $SHELL when it is a usable shell', () => withFixture((f) => {
    const shell = fakeBinary(f.bin, 'bash');
    f.env.env.SHELL = shell;
    f.setPasswd(`user:x:1000:1000:user:/home/user:${join(f.bin, 'sh')}\n`);
    assert.deepEqual(detectShell(f.env), { path: shell, source: '$SHELL' });
  }));

  it('falls back to the passwd login shell', () => withFixture((f) => {
    const shell = fakeBinary(f.bin, 'zsh');
    f.setPasswd(`root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000:user:/home/user:${shell}\n`);
    assert.deepEqual(detectShell(f.env), { path: shell, source: '/etc/passwd' });
  }));

  it('falls back to bash on PATH, then sh on PATH', () => withFixture((f) => {
    f.setPasswd('user:x:1000:1000:user:/home/user:/nonexistent/fish\n');
    const bash = fakeBinary(f.bin, 'bash');
    assert.deepEqual(detectShell(f.env), { path: bash, source: 'bash on PATH' });
    rmSync(bash);
    const sh = fakeBinary(f.bin, 'sh');
    assert.deepEqual(detectShell(f.env), { path: sh, source: 'sh on PATH' });
    rmSync(sh);
    assert.equal(detectShell(f.env), undefined);
  }));

  it('prefers /bin/zsh when the runtime shell is present', () => withFixture((f) => {
    f.env.exists = (path) => path === '/bin/zsh' || (path.startsWith(f.dir) && existsSync(path));
    assert.deepEqual(detectShell(f.env), { path: '/bin/zsh', source: 'default shell' });
  }));
});

describe('runPreflight', () => {
  it('passes required checks and warns about missing optional tools', () => {
    const f = readyFixture();
    try {
      const report = runPreflight(f.env);
      assert.equal(report.ok, true);
      assert.deepEqual(report.problems, []);
      assert.deepEqual({ distro: report.distro, packageManager: report.packageManager }, { distro: 'ubuntu', packageManager: 'apt' });
      const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
      assert.equal(byName.node.status, 'ok');
      assert.equal(byName.shell.status, 'ok');
      assert.equal(byName.git.status, 'ok');
      assert.equal(byName.tmux.status, 'missing');
      assert.equal(byName.jq.status, 'missing');
      assert.equal(byName.curl.status, 'missing');
      assert.equal(byName.tmux.required, false);
      assert.equal(byName.node.required, true);
      assert.match(report.warnings.join('\n'), /jq: not found on PATH/);
      assert.match(report.hint, /apt-get install -y tmux jq curl/);
      assert.doesNotThrow(() => assertPreflightReady(report));
    } finally { f.cleanup(); }
  });

  it('fails hard only on required checks', () => {
    const f = readyFixture();
    try {
      f.env.nodeVersion = 'v18.0.0';
      delete f.env.env.SHELL;
      f.setPasswd('user:x:1000:1000:user:/home/user:/nonexistent/fish\n');
      rmSync(join(f.bin, 'bash')); // no usable shell on PATH either
      rmSync(join(f.bin, 'git')); // optional, so its install hint is still shown
      const report = runPreflight(f.env);
      assert.equal(report.ok, false);
      assert.match(report.problems.join('\n'), /required node check failed/);
      assert.match(report.problems.join('\n'), /required shell check failed/);
      assert.doesNotMatch(report.problems.join('\n'), /required tmux check failed/);
      assert.match(report.hint, /apt-get install -y git tmux jq curl/);
      assert.doesNotMatch(report.hint, /\bnode\b/);
      assert.doesNotMatch(report.hint, /\bshell\b/);
      assert.throws(() => assertPreflightReady(report), /required node check failed/);
    } finally { f.cleanup(); }
  });

  it('formats a shared report with required markers and an install hint', () => {
    const f = readyFixture();
    try {
      const lines = formatPreflight(runPreflight(f.env));
      assert.match(lines[0], /ftown preflight \(ubuntu, apt\)/);
      assert.ok(lines.some((line) => line.includes('node:') && line.includes('[required]')));
      assert.ok(lines.some((line) => line.startsWith('  WARN  jq:')));
      assert.ok(lines.some((line) => line.includes('install hint:')));
    } finally { f.cleanup(); }
  });
});

describe('setup CLI preflight integration', () => {
  async function silent(run: () => Promise<number>): Promise<number> {
    const out = process.stdout.write;
    const err = process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { return await run(); } finally { process.stdout.write = out; process.stderr.write = err; }
  }

  it('blocks the installer when a required check fails', async () => {
    const f = fixture();
    try {
      f.env.nodeVersion = 'v18.0.0';
      let performed = false;
      const code = await silent(() => runSetup([], {
        preflightEnv: f.env,
        perform: async () => { performed = true; throw new Error('installer must not run'); },
      }));
      assert.equal(code, 1);
      assert.equal(performed, false);
    } finally { f.cleanup(); }
  });

  it('runs the installer when every required check passes', async () => {
    const f = readyFixture();
    try {
      let performed = false;
      const code = await silent(() => runSetup([], {
        preflightEnv: f.env,
        perform: async () => { performed = true; return { version: '1.2.3', action: 'installed', migrations: [], integrations: [] }; },
      }));
      assert.equal(code, 0);
      assert.equal(performed, true);
    } finally { f.cleanup(); }
  });
});
