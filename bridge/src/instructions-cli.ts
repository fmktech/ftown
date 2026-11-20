import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { apiResponse, loadPointer, setPeerTarget } from './cli-client.js';
import { extractBridgeOption } from './peers-cli.js';
import { INSTRUCTIONS_LOCAL, instructionLimit, instructionPath, readInstructions } from './instructions.js';

const usage = 'Usage: ftown instructions show <global|bridge> [--bridge <peer>]\n       ftown instructions pull global --bridge <peer>';

export async function runInstructions(raw: string[]): Promise<number> {
  if (!raw.length || raw.includes('--help') || raw.includes('-h')) { console.log(usage); return 0; }
  try {
    const { args, target } = extractBridgeOption(raw);
    const [action, scope] = args;
    if (args.length !== 2 || (scope !== 'global' && scope !== 'bridge')
      || (action !== 'show' && !(action === 'pull' && scope === 'global' && target))) throw new Error(usage);
    if (!target) { process.stdout.write(readInstructions(scope)); return 0; }
    const prior = action === 'pull' ? readInstructions(scope) : '';
    setPeerTarget(null);
    const result = await apiResponse(loadPointer(), 'POST', INSTRUCTIONS_LOCAL, { bridge: target, scope });
    const body = result.body as { text?: unknown; error?: string } | null;
    if (result.status !== 200 || typeof body?.text !== 'string' || Buffer.byteLength(body.text) > instructionLimit)
      throw new Error(body?.error ?? 'Invalid peer instructions');
    if (action === 'show') process.stdout.write(body.text);
    else if (prior !== body.text) {
      const file = instructionPath(scope);
      const temp = file + '.' + randomUUID();
      try {
        writeFileSync(temp, body.text, { flag: 'wx', mode: 0o600 });
        if (readInstructions(scope) !== prior) throw new Error('Local instructions changed during pull');
        if (prior) {
          const backup = temp + '.bak';
          writeFileSync(backup, prior, { flag: 'wx', mode: 0o600 });
          console.error('Previous instructions saved to ' + backup);
        }
        renameSync(temp, file);
      } finally { rmSync(temp, { force: true }); }
    }
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
