import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBridgeCommand } from './bridge-command';

describe('canonical bridge command', () => {
  it('explicitly sets up and starts the latest canonical package at the current origin', () => {
    expect(buildBridgeCommand({ apiUrl: 'https://ftown.example:8443' })).toBe(
      "npx -y ftown@latest setup && \"$HOME/.ftown/ftown\" --api-url 'https://ftown.example:8443'",
    );
  });
  it('quotes shell metacharacters and embedded single quotes as one literal argument', () => {
    expect(buildBridgeCommand({ apiUrl: "https://example/'$(touch /tmp/never); space" })).toBe(
      "npx -y ftown@latest setup && \"$HOME/.ftown/ftown\" --api-url 'https://example/'\\''$(touch /tmp/never); space'",
    );
  });
  it('uses the same explicit setup and default-start convention for Solo', () => {
    expect(buildBridgeCommand({ solo: true })).toBe('npx -y ftown@latest setup && "$HOME/.ftown/ftown" --solo');
  });
});

describe('generated bridge command in a shell', () => {
  function withFixture(run: (fixture: { home: string; bin: string; setupLog: string; launchLog: string; staleLog: string; dir: string }) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'ftown-command-'));
    const home = join(dir, 'home with spaces'), bin = join(dir, 'bin');
    const setupLog = join(dir, 'setup.log'), launchLog = join(dir, 'launch.log'), staleLog = join(dir, 'stale.log');
    try {
      mkdirSync(home); mkdirSync(bin);
      writeFileSync(join(bin, 'npx'), `#!/bin/sh
printf '%s\\n' "$@" > "$SETUP_LOG"
if [ "$#" -ne 3 ] || [ "$1" != '-y' ] || [ "$2" != 'ftown@latest' ] || [ "$3" != 'setup' ]; then exit 41; fi
if [ "\${FAIL_SETUP:-}" = 1 ]; then exit 29; fi
/bin/mkdir -p "$HOME/.ftown"
/bin/cat > "$HOME/.ftown/ftown" <<'LAUNCHER'
#!/bin/sh
printf '%s\\n' "$@" > "$LAUNCH_LOG"
LAUNCHER
/bin/chmod +x "$HOME/.ftown/ftown"
`, { mode: 0o755 });
      writeFileSync(join(bin, 'ftown'), '#!/bin/sh\nprintf stale > "$STALE_LOG"\n', { mode: 0o755 });
      run({ home, bin, setupLog, launchLog, staleLog, dir });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  function execute(command: string, f: { home: string; bin: string; setupLog: string; launchLog: string; staleLog: string }, failSetup = false) {
    return spawnSync('/bin/sh', ['-c', command], {
      env: { NODE_ENV: 'test', HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin`, SETUP_LOG: f.setupLog, LAUNCH_LOG: f.launchLog, STALE_LOG: f.staleLog, FAIL_SETUP: failSetup ? '1' : '0' },
      encoding: 'utf8', timeout: 5000,
    });
  }

  it('runs only npx setup then starts the installed launcher with the exact literal API argument', () => {
    withFixture(f => {
      const injected = join(f.dir, 'injected');
      const apiUrl = `https://example/'$(touch ${injected}); space`;
      const result = execute(buildBridgeCommand({ apiUrl }), f);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(f.setupLog, 'utf8')).toBe('-y\nftown@latest\nsetup\n');
      expect(readFileSync(f.launchLog, 'utf8')).toBe(`--api-url\n${apiUrl}\n`);
      expect(existsSync(injected)).toBe(false);
      expect(existsSync(f.staleLog)).toBe(false);
    });
  });

  it('starts the installed Solo launcher and does not start anything when setup fails', () => {
    withFixture(f => {
      const command = buildBridgeCommand({ solo: true });
      const failed = execute(command, f, true);
      expect(failed.error).toBeUndefined();
      expect(failed.status).toBe(29);
      expect(existsSync(f.launchLog)).toBe(false);
      expect(existsSync(f.staleLog)).toBe(false);
      const success = execute(command, f);
      expect(success.error).toBeUndefined();
      expect(success.status, success.stderr).toBe(0);
      expect(readFileSync(f.setupLog, 'utf8')).toBe('-y\nftown@latest\nsetup\n');
      expect(readFileSync(f.launchLog, 'utf8')).toBe('--solo\n');
      expect(existsSync(f.staleLog)).toBe(false);
    });
  });
});
