import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSocket } from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localAddresses, startAddressedListener } from './addressed-setup.js';
import type { AddressedMux } from './addressed-listener.js';

const mux = (): AddressedMux => ({ onUnhandledStunRequest: () => {}, stop: () => {} });
function home(t: { after(fn: () => unknown): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-addressed-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('only usable IPv4 addresses are offered: no loopback, no link-local, no duplicates', () => {
  const entry = (address: string, family: 'IPv4' | 'IPv6', internal = false) => ({ address, family, internal, netmask: '', mac: '', cidr: null }) as never;
  assert.deepEqual(localAddresses({
    lo: [entry('127.0.0.1', 'IPv4', true), entry('::1', 'IPv6', true)],
    wlan0: [entry('192.168.1.20', 'IPv4'), entry('fe80::1', 'IPv6')],
    tailscale0: [entry('100.64.0.7', 'IPv4')],
    odd: [entry('169.254.3.4', 'IPv4'), entry('192.168.1.20', 'IPv4')],
    gone: undefined,
  }), ['192.168.1.20', '100.64.0.7']);
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`eth${n}`, [entry(`10.0.0.${n + 1}`, 'IPv4')]]));
  assert.equal(localAddresses(many).length, 16);
});

test('the port and identity stay the same across restarts, and the address is read fresh each time', async t => {
  const dir = home(t);
  let addresses = ['192.168.1.20'];
  const interfaces = () => ({ eth0: addresses.map(address => ({ address, family: 'IPv4', internal: false })) }) as never;
  const first = await startAddressedListener(dir, () => true, { muxFactory: mux, log: () => {}, interfaces });
  const address = first.address();
  assert.ok(Number.isInteger(address.port) && address.port > 0);
  assert.match(address.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.deepEqual(address.addresses, ['192.168.1.20']);
  assert.equal(readFileSync(join(dir, 'direct-udp-port'), 'utf8').trim(), String(address.port));
  first.listener.stop();

  addresses = ['10.9.9.9'];
  const second = await startAddressedListener(dir, () => true, { muxFactory: mux, log: () => {}, interfaces });
  assert.deepEqual(second.address(), { port: address.port, fingerprint: address.fingerprint, addresses: ['10.9.9.9'] });
  second.listener.stop();
});

test('a remembered port another program has taken is replaced, and junk in the port file is ignored', async t => {
  const dir = home(t);
  const taken = createSocket('udp4');
  await new Promise<void>(resolve => taken.bind(0, '0.0.0.0', resolve));
  t.after(() => new Promise<void>(resolve => taken.close(() => resolve())));
  const busy = taken.address().port;
  writeFileSync(join(dir, 'direct-udp-port'), `${busy}\n`);
  const moved = await startAddressedListener(dir, () => true, { muxFactory: mux, log: () => {} });
  assert.notEqual(moved.address().port, busy);
  assert.equal(readFileSync(join(dir, 'direct-udp-port'), 'utf8').trim(), String(moved.address().port));
  moved.listener.stop();

  writeFileSync(join(dir, 'direct-udp-port'), 'not a port\n');
  const fresh = await startAddressedListener(dir, () => true, { muxFactory: mux, log: () => {} });
  assert.ok(fresh.address().port > 0);
  fresh.listener.stop();
});
