import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertCleanCheckconfigOutput, checkConfigurations, CONFIGURATIONS, IMAGE_REFERENCES, validateConfiguration } from './check-centrifugo-config.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = kind => JSON.parse(readFileSync(join(root, CONFIGURATIONS[kind]), 'utf8'));

test('all committed configs preserve the reviewed permissions/retention/boundaries and image pin', () => checkConfigurations(root));
test('E2E accepts its HTTPS fixture origin and rejects unexpected origins', () => {
  const config = load('e2e');
  assert.ok(config.client.allowed_origins.includes('https://localhost:8444'));
  validateConfiguration(config, 'e2e');
  config.client.allowed_origins.push('https://unexpected.example');
  assert.throws(() => validateConfiguration(config, 'e2e'));
});
test('the executed CI validator script must retain the reviewed image pin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-cf-pin-'));
  try {
    for (const file of [...Object.values(CONFIGURATIONS), ...IMAGE_REFERENCES]) {
      const dest = join(dir, file);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(root, file), dest);
    }
    checkConfigurations(dir);
    const script = join(dir, 'scripts/ci/validate-centrifugo.sh');
    const original = readFileSync(script, 'utf8');
    writeFileSync(script, original.replace(/centrifugo\/centrifugo:v6\.10\.2@sha256:[0-9a-f]{64}/, 'centrifugo/centrifugo:unreviewed'));
    assert.throws(() => checkConfigurations(dir), /scripts\/ci\/validate-centrifugo\.sh: patched image pin drifted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
for (const [name, change] of [
  ['unknown root key', c => { c.token_audience = 'ftown:centrifugo'; }],
  ['unknown nested key', c => { c.client.token.hmac_secret = 'typo'; }],
  ['missing audience', c => { delete c.client.token.audience; }],
  ['anonymous tokens enabled', c => { c.client.disallow_anonymous_connection_tokens = false; }],
  ['public health listener', c => { c.http_server.internal_address = '0.0.0.0'; }],
  ['API enabled', c => { c.http_api.disabled = false; }],
  ['missing namespace', c => { c.channel.namespaces.pop(); }],
  ['publish permission changed', c => { c.channel.namespaces[0].allow_publish_for_client = false; }],
  ['history policy changed', c => { c.channel.namespaces[0].history_size = 10000; }],
  ['accidental namespace inheritance', c => { c.channel.namespaces[1].force_recovery = true; }],
]) test(`rejects ${name}`, () => {
  const config = load('fly'); change(config);
  assert.throws(() => validateConfiguration(config, 'fly'));
});
test('unknown-key warnings fail even when upstream checkconfig exits successfully', () => {
  assertCleanCheckconfigOutput('config successfully validated');
  assert.throws(() => assertCleanCheckconfigOutput('WRN unknown key in config: token_audience'));
});

for (const [name, values, expected, status] of [
  ['legacy alias', { CENTRIFUGO_TOKEN_HMAC_SECRET_KEY: 'fixture-legacy' }, 'fixture-legacy', 0],
  ['native precedence', { CENTRIFUGO_TOKEN_HMAC_SECRET_KEY: 'fixture-legacy', CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY: 'fixture-native' }, 'fixture-native', 0],
  ['explicit empty native fails closed', { CENTRIFUGO_TOKEN_HMAC_SECRET_KEY: 'fixture-legacy', CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY: '' }, '', 1],
  ['missing secret fails closed', {}, '', 1],
]) test(`Fly entrypoint ${name} without secret output or arguments`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-cf-alias-'));
  try {
    writeFileSync(join(dir, 'centrifugo'), `#!${process.execPath}\nconst assert=require('node:assert/strict');assert.equal(process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY,${JSON.stringify(expected)});assert.deepEqual(process.argv.slice(2),['-c','fixture.json']);console.log('alias verified');\n`, { mode: 0o755 });
    const result = spawnSync('/bin/sh', [join(root, 'centrifugo/entrypoint.sh'), '-c', 'fixture.json'], {
      env: { PATH: dir, ...values }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, status, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-legacy|fixture-native/);
    if (!status) assert.equal(result.stdout.trim(), 'alias verified');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
