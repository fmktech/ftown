import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const script = resolve(dirname(fileURLToPath(import.meta.url)), 'centrifugo-remote.sh');

function fixture(version, layout = 'docker') {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-cf-guard-'));
  const live = join(dir, 'live.json'), incoming = join(dir, 'incoming.json'), log = join(dir, 'commands.log');
  writeFileSync(live, 'original-live-config'); writeFileSync(incoming, '{}');
  const fake = (name, body) => writeFileSync(join(dir, name), '#!/bin/sh\n' + body, { mode: 0o755 });
  fake('docker', `printf '%s\\n' "$*" >> "$FIXTURE_LOG"
case "$1" in
 ps) ${layout === 'docker' ? "echo 'owned centrifugo/centrifugo:fixture'" : ':'} ;;
 inspect)
  case "$*" in *Mounts*) printf '%s|/centrifugo/config.json\\n' "$FIXTURE_LIVE" ;; *) printf '%s\\n' '-c' '/centrifugo/config.json' ;; esac ;;
 exec) printf '%s\\n' "$FIXTURE_VERSION" ;;
 restart) echo 'UNEXPECTED_RESTART' >> "$FIXTURE_LOG"; exit 8 ;;
esac
`);
  fake('systemctl', `printf 'systemctl %s\\n' "$*" >> "$FIXTURE_LOG"
case "$1" in
 list-unit-files) echo 'centrifugo.service enabled' ;;
 show) printf '{ path=%s ; argv[]=%s -c %s ; }\\n' "$FIXTURE_BINARY" "$FIXTURE_BINARY" "$FIXTURE_LIVE" ;;
 restart) echo 'UNEXPECTED_RESTART' >> "$FIXTURE_LOG"; exit 8 ;;
esac
`);
  fake('fake-centrifugo', 'printf \'%s\\n\' "$FIXTURE_VERSION"\n');
  // A successful guard reaches this sentinel before any real backup/config write.
  fake('cp', 'echo BACKUP_REACHED >> "$FIXTURE_LOG"; exit 77\n');
  const env = { PATH: `${dir}:/usr/bin:/bin`, FIXTURE_LOG: log, FIXTURE_LIVE: live,
    FIXTURE_VERSION: version, FIXTURE_BINARY: join(dir, 'fake-centrifugo') };
  return { dir, live, incoming, log, env };
}
for (const layout of ['docker', 'systemd']) {
  for (const version of ['Centrifugo v5.4.9 (Go version: go1.23.4)', 'Centrifugo v6.10.1', 'Centrifugo v6.10.2-rc1', 'unrecognized runtime', 'Centrifugo v6.10.2\nCentrifugo v5.4.9', '']) {
    test(`${layout}: rejects ${version || 'empty version'} before touching the live config/service`, () => {
      const f = fixture(version, layout);
      try {
        const result = spawnSync('/bin/bash', [script, f.incoming], { env: f.env, encoding: 'utf8', timeout: 5000 });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /manually upgrade.*binary\/image/);
        assert.equal(readFileSync(f.live, 'utf8'), 'original-live-config');
        assert.equal(readdirSync(f.dir).some(name => /\.bak\.|\.new\./.test(name)), false);
        assert.doesNotMatch(readFileSync(f.log, 'utf8'), /BACKUP_REACHED|UNEXPECTED_RESTART/);
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });
  }
  for (const version of ['Centrifugo v6.10.2 (Go version: go1.27.3)', 'Centrifugo v6.11.0', 'Centrifugo v7.0.0']) {
    test(`${layout}: patched runtime ${version} reaches the existing backup path`, () => {
      const f = fixture(version, layout);
      try {
        const result = spawnSync('/bin/bash', [script, f.incoming], { env: f.env, encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 77, result.stderr);
        assert.match(readFileSync(f.log, 'utf8'), /BACKUP_REACHED/);
        assert.doesNotMatch(readFileSync(f.log, 'utf8'), /UNEXPECTED_RESTART/);
        assert.equal(readFileSync(f.live, 'utf8'), 'original-live-config');
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });
  }
}
