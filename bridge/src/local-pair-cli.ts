import type { Command } from 'commander';
import type { BridgePointer } from './wire-types.js';
import type { BridgeInvitation } from './security/protocol.js';
import { securityCommand } from './cli-client.js';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveDefaultDataDir, resolveFtownHome } from './ftown-home.js';

type Pointer = BridgePointer & { apiUrl?: string };
type Pairing = { id: string; code: string; origin: string; remember: boolean; expiresAt: string };

export function readLocalPointer(dataDir?: string): Pointer {
  dataDir ??= process.env.FTOWN_DATA_DIR;
  const defaultDir = resolveDefaultDataDir();
  const home = resolveFtownHome(dataDir ? resolve(dataDir) : defaultDir, defaultDir);
  let pointer: Pointer;
  try { pointer = JSON.parse(readFileSync(join(home, 'bridge.json'), 'utf8')); }
  catch { throw new Error('No running bridge found. Start ftown-bridge --local (or your cloud bridge) first.'); }
  if (!Number.isInteger(pointer.port) || pointer.port < 1 || pointer.port > 65535 || typeof pointer.token !== 'string' || !pointer.token) {
    throw new Error('Invalid bridge pointer. Restart the bridge and try again.');
  }
  return pointer;
}

export async function localAdminRequest<T>(pointer: Pointer, path: string, method = 'GET', body?: unknown): Promise<T> {
  if (path === 'devices' && method === 'GET') return await securityCommand(pointer, 'security_devices') as T;
  const revoke = /^devices\/([A-Za-z0-9_-]+)$/.exec(path);
  if (revoke && method === 'DELETE') return await securityCommand(pointer, 'security_revoke', { endpointId: revoke[1] }) as T;
  throw new Error('Upgrade required: use ftown security invite/devices/revoke');
}

export async function pairLocalBrowser(pointer: Pointer): Promise<void> {
  const invitation = await securityCommand(pointer, 'security_invite', { label: 'Browser' }) as unknown as BridgeInvitation;
  const url = new URL('/connect', pointer.apiUrl ?? 'https://ftown.ia.br');
  url.hash = `invite=${encodeURIComponent(JSON.stringify(invitation))}`;
  console.log(url.href);
}

export function registerLocalBrowserCommands(program: Command): void {
  const pointerFor = (command: Command) => readLocalPointer(command.optsWithGlobals().dataDir as string | undefined);
  program.command('pair').description('Approve a browser for direct local control (no cloud login)')
    .option('--data-dir <path>', 'Data directory of the running bridge')
    .action(async (_opts, command: Command) => { await pairLocalBrowser(pointerFor(command)); });
  program.command('devices').description('List browsers approved for local control')
    .option('--data-dir <path>', 'Data directory of the running bridge')
    .action(async (_opts, command: Command) => {
      const { devices } = await localAdminRequest<{ devices: { id: string; origin: string; createdAt: string }[] }>(pointerFor(command), 'devices');
      if (!devices.length) console.log('No browsers are approved.');
      for (const device of devices) console.log(`${device.id}  ${device.origin}  ${device.createdAt}`);
    });
  program.command('revoke <device-id>').description('Revoke an approved local browser and disconnect local terminals')
    .option('--data-dir <path>', 'Data directory of the running bridge')
    .action(async (id: string, _opts, command: Command) => {
      await localAdminRequest(pointerFor(command), `devices/${encodeURIComponent(id)}`, 'DELETE');
      console.log('Browser access revoked.');
    });
}
