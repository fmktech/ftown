import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { apiResponse, loadPointer, setPeerTarget } from './cli-client.js';
import { TRANSFER_LOCAL } from './folder-transfer-protocol.js';
import { extractBridgeOption } from './peers-cli.js';

const usage = `Usage: ftown transfer receive <destination> --bridge <sender>
       ftown transfer send <source> --bridge <recipient> --id <receive-id>
       ftown transfer list
       ftown transfer status|cancel|retry|discard <receive-id>

Run receive on the recipient to authorize an unused destination. Pass the
printed ID to send on the sender. Use list or status on either bridge.
Retry and discard manage a retained snapshot on the recipient.`;

export async function runTransfer(raw: string[]): Promise<number> {
  if (!raw.length || raw.includes('--help') || raw.includes('-h')) {
    console.log(usage);
    return 0;
  }
  let body: Record<string, string>;
  try {
    const { args, target } = extractBridgeOption(raw);
    const { positionals: [action, operand, extra], values } = parseArgs({
      args, allowPositionals: true, options: { id: { type: 'string' } },
    });
    if (extra !== undefined) throw new Error();
    if (action === 'receive' || action === 'send') {
      const bridge = target ?? process.env.FTOWN_BRIDGE?.trim();
      if (!operand || !bridge || (action === 'send' ? !values.id : values.id !== undefined)) throw new Error();
      body = { action, bridge, path: resolve(operand), ...(values.id === undefined ? {} : { id: values.id }) };
    } else if (!target && values.id === undefined && (action === 'list' ? operand === undefined
      : !!operand && ['status', 'cancel', 'retry', 'discard'].includes(action))) {
      body = { action, ...(operand === undefined ? {} : { id: operand }) };
    } else throw new Error();
  } catch {
    console.error(usage);
    return 2;
  }
  setPeerTarget(null);
  const result = await apiResponse(loadPointer(), 'POST', TRANSFER_LOCAL, body);
  if (result.status !== 200) {
    const detail = result.body as { error?: string } | null;
    console.error(detail?.error ?? 'Transfer request failed.');
    return 1;
  }
  console.log(JSON.stringify(result.body, null, 2));
  return 0;
}
