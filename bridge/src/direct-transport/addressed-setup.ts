import { createSocket } from 'node:dgram';
import { readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { AddressedListener, type AddressedListenerOptions } from './addressed-listener.js';
import { MAX_DIRECT_ADDRESSES, type DirectAddress } from './contract.js';
import { loadOrCreateDtlsIdentity } from './dtls-identity.js';

/** The bridge's current non-loopback IPv4 addresses: what a browser on the same network or VPN can try. */
export function localAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      // Link-local addresses (169.254/16) are per-link and never the same machine twice.
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) found.add(entry.address);
    }
  }
  return [...found].slice(0, MAX_DIRECT_ADDRESSES);
}

/** A UDP port nothing was bound to a moment ago. */
async function freeUdpPort(): Promise<number> {
  const socket = createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '0.0.0.0', resolve); });
    return socket.address().port;
  } finally { await new Promise<void>(resolve => socket.close(() => resolve())); }
}

async function portIsFree(port: number): Promise<boolean> {
  const socket = createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(port, '0.0.0.0', resolve); });
    return true;
  } catch { return false; }
  finally { await new Promise<void>(resolve => { try { socket.close(() => resolve()); } catch { resolve(); } }); }
}

export interface AddressedSetup {
  listener: AddressedListener;
  /** What `get_direct_address` answers: read at call time, since addresses change with the network. */
  address(): DirectAddress;
}

/**
 * Starts the fixed-address listener. The port is kept under `dataDir` so the address a browser remembers stays valid across
 * restarts; if another program has taken it, a new one is chosen and remembered (browsers learn it the next time they ask).
 */
export async function startAddressedListener(dataDir: string, adopt: AddressedListenerOptions['adopt'],
  options: Pick<AddressedListenerOptions, 'muxFactory' | 'connectionFactory' | 'log'> & { interfaces?: () => ReturnType<typeof networkInterfaces> } = {}): Promise<AddressedSetup> {
  const identity = loadOrCreateDtlsIdentity(dataDir);
  const portPath = join(dataDir, 'direct-udp-port');
  let port = 0;
  try {
    const saved = Number(readFileSync(portPath, 'utf8').trim());
    if (Number.isInteger(saved) && saved > 0 && saved <= 65_535 && await portIsFree(saved)) port = saved;
  } catch { /* first start */ }
  if (!port) port = await freeUdpPort();
  const listener = new AddressedListener({ port, identity, adopt, ...options });
  writeFileSync(portPath, `${port}\n`, { mode: 0o600 });
  return { listener, address: () => ({ port, fingerprint: identity.fingerprint, addresses: localAddresses(options.interfaces?.()) }) };
}
