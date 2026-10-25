import { Command, CommanderError } from 'commander';
import { readLocalPointer } from './local-pair-cli.js';
import { apiResponse, securityCommand } from './cli-client.js';
import type { BridgeInvitation } from './security/protocol.js';
import { pendingPairingLink } from './security/bridge/pending-enrollment.js';
import { resolveDefaultDataDir } from './ftown-home.js';

export function invitationLink(invitation: BridgeInvitation, apiUrl = 'https://ftown.ia.br'): string {
  const url = new URL('/connect', apiUrl);
  url.hash = `invite=${encodeURIComponent(JSON.stringify(invitation))}`;
  return url.href;
}

export async function runSecurity(argv: string[]): Promise<number> {
  const program = new Command().name('ftown security').description('Manage this bridge’s encrypted endpoint trust')
    .option('--data-dir <path>', 'Bridge instance data directory').exitOverride();
  const pointer = () => readLocalPointer(program.opts().dataDir as string | undefined);
  program.command('pair-link').description('Display the current private first-computer approval link (explicit local output only)')
    .action(async () => {
      const dataDir = program.opts().dataDir as string | undefined;
      console.log(await pendingPairingLink(dataDir ?? resolveDefaultDataDir()));
    });
  program.command('invite').description('Create a one-use browser invitation (secret is printed only on this explicit request)')
    .option('--label <label>', 'Device label', 'Browser')
    .action(async options => {
      const current = pointer();
      const invite = await securityCommand(current, 'security_invite', { label: String(options.label) }) as unknown as BridgeInvitation;
      console.log(invitationLink(invite, current.apiUrl));
    });
  program.command('devices').description('List locally approved encrypted endpoints').action(async () => {
    const result = await securityCommand(pointer(), 'security_devices'); console.log(JSON.stringify(result));
  });
  program.command('revoke <endpoint-id>').description('Revoke an endpoint on this bridge').action(async endpointId => {
    await securityCommand(pointer(), 'security_revoke', { endpointId: String(endpointId) }); console.log('Endpoint revoked.');
  });
  program.command('proxy').description('Run one encrypted local API request from bounded JSON on stdin').action(async () => {
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      const data = Buffer.from(chunk); bytes += data.length;
      if (bytes > 1_048_576) throw new Error('Local request exceeds limit'); chunks.push(data);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (!request || Array.isArray(request) || Object.keys(request).some(key => !['method', 'path', 'body', 'timeoutMs'].includes(key))
      || typeof request.method !== 'string' || typeof request.path !== 'string'
      || !['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)
      || !request.path.startsWith('/api/')) throw new Error('Invalid local request');
    const timeout = request.timeoutMs ?? 60000;
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error('Invalid timeout');
    const caller = process.env.FTOWN_SESSION_ID;
    const result = await apiResponse(pointer(), request.method, request.path, request.body,
      caller ? { 'x-ftown-session-id': caller } : undefined, AbortSignal.timeout(timeout));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });
  try { await program.parseAsync(['node', 'ftown-security', ...argv]); return 0; }
  catch (error) {
    if (error instanceof CommanderError) return error.code === 'commander.helpDisplayed' ? 0 : error.exitCode;
    console.error('Encrypted local security operation failed. Check that the bridge is running and setup is current.'); return 1;
  }
}
