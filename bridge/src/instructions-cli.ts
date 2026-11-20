import { apiResponse, loadPointer, setPeerTarget } from './cli-client.js';
import { extractBridgeOption } from './peers-cli.js';
import { INSTRUCTIONS_LOCAL, instructionLimit, pullGlobal, readInstructions } from './instructions.js';

const usage = 'Usage: ftown instructions show <global|bridge> [--bridge <peer>]\n       ftown instructions pull global --bridge <peer>';

export async function runInstructions(raw: string[]): Promise<number> {
  if (!raw.length || raw.includes('--help') || raw.includes('-h')) { console.log(usage); return 0; }
  try {
    const { args, target } = extractBridgeOption(raw);
    const [action, scope] = args;
    if (args.length !== 2 || (scope !== 'global' && scope !== 'bridge')
      || (action !== 'show' && !(action === 'pull' && scope === 'global' && target))) throw new Error(usage);
    if (!target) { process.stdout.write(readInstructions(scope)); return 0; }
    setPeerTarget(null);
    const result = await apiResponse(loadPointer(), 'POST', INSTRUCTIONS_LOCAL, { bridge: target, scope });
    const body = result.body as { text?: unknown; version?: number; error?: string } | null;
    if (result.status !== 200 || typeof body?.text !== 'string' || Buffer.byteLength(body.text) > instructionLimit)
      throw new Error(body?.error ?? 'Invalid peer instructions');
    if (action === 'show') process.stdout.write(body.text);
    else {
      if (typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 0
        || !Number.isFinite(new Date(body.version).getTime())) throw new Error('Peer did not supply a valid instruction version');
      pullGlobal({ text: body.text, version: body.version });
    }
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
