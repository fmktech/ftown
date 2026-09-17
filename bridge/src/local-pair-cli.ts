import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveDefaultDataDir, resolveFtownHome } from './ftown-home.js';

type Pointer = { port: number; token: string; apiUrl?: string };
type Pairing = { id: string; code: string; origin: string; remember: boolean; expiresAt: string };

export function readLocalPointer(dataDir?: string): Pointer {
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
  const response = await fetch(`http://127.0.0.1:${pointer.port}/api/browser/${path}`, {
    method,
    headers: { Authorization: `Bearer ${pointer.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Local bridge returned ${response.status}`);
  return result;
}

export async function pairLocalBrowser(pointer: Pointer): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('Browser approval requires an interactive terminal. Run ftown-bridge pair in your terminal.');
  const window = await localAdminRequest<{ expiresAt: string }>(pointer, 'window', 'POST', {});
  const url = new URL('/local', pointer.apiUrl ?? 'https://ftown.ia.br');
  url.searchParams.set('port', String(pointer.port));
  console.log(`Open ${url.href}`);
  console.log(`Local port: ${pointer.port}. Waiting for a browser request (two minutes).`);
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (Date.now() < Date.parse(window.expiresAt)) {
      const { pairings } = await localAdminRequest<{ pairings: Pairing[] }>(pointer, 'pairings');
      const pairing = pairings[0];
      if (!pairing) { await delay(500); continue; }
      console.log(`\nBrowser origin: ${pairing.origin}\nMatching code: ${pairing.code}`);
      console.log(`Access: create and remove sessions, run commands, and control terminals on this computer.`);
      console.log(pairing.remember ? 'This browser requested remembered access.' : 'This browser requested access for this session.');
      const remaining = Date.parse(pairing.expiresAt) - Date.now();
      if (remaining <= 0) continue;
      let answer: string;
      try {
        answer = await input.question('Does the code match your browser? Approve [y/N]: ', { signal: AbortSignal.timeout(remaining) });
      } catch { console.log('\nApproval expired. Run ftown-bridge pair again.'); return; }
      const approve = /^y(es)?$/i.test(answer.trim());
      await localAdminRequest(pointer, `pairings/${encodeURIComponent(pairing.id)}/decision`, 'POST', { approve });
      console.log(approve ? 'Browser approved. Local access is ready.' : 'Browser request denied.');
      return;
    }
    console.log('No browser approved before the window expired. Run ftown-bridge pair to try again.');
  } finally { input.close(); }
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
