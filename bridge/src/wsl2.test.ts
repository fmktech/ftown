import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectWsl2,
  isUnderWslMnt,
  soloBannerLines,
  wslMntWorkdirWarning,
  type ReadProcFile,
} from './wsl2.js';

/** Build a fake /proc reader from a path -> contents map. */
function procReader(files: Record<string, string>): ReadProcFile {
  return (path) => files[path] ?? '';
}

describe('detectWsl2 (injected probe)', () => {
  it('detects the WSL marker in /proc/version', () => {
    assert.equal(detectWsl2(procReader({
      '/proc/version': 'Linux version 5.15.90.1-microsoft-standard-WSL2 (gcc ...) #1 SMP',
    })), true);
  });

  it('detects the WSL marker in /proc/sys/kernel/osrelease', () => {
    assert.equal(detectWsl2(procReader({
      '/proc/sys/kernel/osrelease': '5.15.167.4-microsoft-standard-WSL2\n',
    })), true);
  });

  it('matches "microsoft" case-insensitively, with or without WSL', () => {
    assert.equal(detectWsl2(procReader({ '/proc/version': 'Microsoft WSL' })), true);
    assert.equal(detectWsl2(procReader({ '/proc/version': 'microsoft-standard' })), true);
    assert.equal(detectWsl2(procReader({ '/proc/version': 'MICROSOFT' })), true);
  });

  it('returns false for a stock Linux kernel', () => {
    assert.equal(detectWsl2(procReader({
      '/proc/version': 'Linux version 6.6.10-arch1-1 (linux@archlinux) #1 SMP',
      '/proc/sys/kernel/osrelease': '6.6.10-arch1-1',
    })), false);
  });

  it('returns false when the proc files are missing or empty', () => {
    assert.equal(detectWsl2(procReader({})), false);
    assert.equal(detectWsl2(() => ''), false);
  });

  it('tolerates a throwing reader and still checks the other path', () => {
    const reader: ReadProcFile = (path) => {
      if (path === '/proc/version') throw new Error('unreadable');
      return '5.15-microsoft-standard-WSL2';
    };
    assert.equal(detectWsl2(reader), true);
    assert.equal(detectWsl2(() => { throw new Error('no /proc'); }), false);
  });
});

describe('isUnderWslMnt', () => {
  it('flags Windows drives mounted under /mnt', () => {
    for (const dir of ['/mnt/c', '/mnt/c/Users/me/project', '/mnt/d/repos/app', '/mnt/']) {
      assert.equal(isUnderWslMnt(dir), true, dir);
    }
  });

  it('does not flag Linux filesystem paths', () => {
    for (const dir of ['/home/me/project', '/root/repo', '/workspace/app', '/mnt2/data', '/', 'C:\\Users\\me']) {
      assert.equal(isUnderWslMnt(dir), false, dir);
    }
  });
});

describe('wslMntWorkdirWarning', () => {
  it('names the workdir and explains the 9p / file-watching problem', () => {
    const warning = wslMntWorkdirWarning('/mnt/c/Users/me/project');
    assert.match(warning, /WSL2/);
    assert.match(warning, /\/mnt\/c\/Users\/me\/project/);
    assert.match(warning, /9p/);
    assert.match(warning, /file watching/);
  });
});

describe('soloBannerLines', () => {
  const ips = ['10.0.0.5'];

  it('points WSL2 users to localhost and documents port forwarding, not the VM IP', () => {
    const lines = soloBannerLines({ ips, port: 8080, accessKeyRaw: 'key123', isWsl2: true });
    const joined = lines.join('\n');
    assert.match(joined, /http:\/\/localhost:8080\/#k=key123/);
    assert.match(joined, /WSL2/);
    assert.match(joined, /port forwarding|portproxy/i);
    assert.doesNotMatch(joined, /10\.0\.0\.5/);
  });

  it('uses localhost without a key fragment when the key was already issued', () => {
    const lines = soloBannerLines({ ips, port: 8080, isWsl2: true });
    const joined = lines.join('\n');
    assert.match(joined, /http:\/\/localhost:8080\//);
    assert.match(joined, /Key not shown/);
    assert.doesNotMatch(joined, /#k=/);
  });

  it('lists LAN IPs with the key on a normal Linux host', () => {
    const lines = soloBannerLines({ ips, port: 8080, accessKeyRaw: 'key123', isWsl2: false });
    const joined = lines.join('\n');
    assert.match(joined, /http:\/\/10\.0\.0\.5:8080\/#k=key123/);
    assert.doesNotMatch(joined, /localhost/);
    assert.doesNotMatch(joined, /WSL2/);
  });

  it('lists each LAN IP with a keyless URL when the key was already issued', () => {
    const lines = soloBannerLines({ ips: ['10.0.0.5', '10.0.0.6'], port: 8080, isWsl2: false });
    const joined = lines.join('\n');
    assert.match(joined, /http:\/\/10\.0\.0\.5:8080/);
    assert.match(joined, /http:\/\/10\.0\.0\.6:8080/);
    assert.match(joined, /key already paired/);
    assert.equal(lines.filter((line) => line.includes('Key not shown')).length, 1);
  });
});
