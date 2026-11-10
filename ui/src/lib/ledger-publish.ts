import { after } from 'next/server';
import jwt from 'jsonwebtoken';
import { Centrifuge } from 'centrifuge';
import { getRequiredSecret } from '@/lib/secrets';
import { accountChannel } from '@security/ledger/channels';
import { ledgerHead } from '@security/ledger/ledger';
import type { Ledger } from '@security/ledger/protocol';

const TIMEOUT_MS = 3000;
export const LEDGER_PUBLISH_MAX_BYTES = 60 * 1024;

export type LedgerPublication =
  | { type: 'ledger'; ledger: Ledger }
  | { type: 'ledger_head'; head: string; revision: number };

export interface LedgerPublishDeps {
  signToken?: (accountId: string) => string;
  centrifugoUrl?: () => string | null;
  createClient?: (url: string, token: string) => Centrifuge;
}

function defaultSignToken(accountId: string): string {
  return jwt.sign({ sub: accountId }, getRequiredSecret('CENTRIFUGO_TOKEN_SECRET'), { audience: 'ftown:centrifugo', expiresIn: '60s' });
}

/** The full ledger when the serialized message fits in 60 KB, otherwise only its head and revision. */
export async function ledgerPublication(ledger: Ledger): Promise<LedgerPublication> {
  const full: LedgerPublication = { type: 'ledger', ledger };
  if (Buffer.byteLength(JSON.stringify(full), 'utf8') <= LEDGER_PUBLISH_MAX_BYTES) return full;
  const last = ledger.transitions[ledger.transitions.length - 1];
  return { type: 'ledger_head', head: await ledgerHead(last ? last.payload : ledger.genesis.payload), revision: ledger.transitions.length };
}

/** Best-effort: never throws; failures are logged. */
export async function publishLedger(accountId: string, ledger: Ledger, deps: LedgerPublishDeps = {}): Promise<void> {
  let client: Centrifuge | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = (deps.centrifugoUrl ?? (() => process.env.NEXT_PUBLIC_CENTRIFUGO_URL || null))();
    if (!url || !accountId) return;
    const token = (deps.signToken ?? defaultSignToken)(accountId);
    const channel = accountChannel('bridges:ledger', accountId);
    const message = await ledgerPublication(ledger);
    const created = (deps.createClient ?? ((u, t) => new Centrifuge(u, { token: t, websocket: WebSocket })))(url, token);
    client = created;
    await new Promise<void>(resolve => {
      timer = setTimeout(resolve, TIMEOUT_MS);
      created.on('connected', () => {
        created.publish(channel, message).then(() => resolve(), error => { console.error('[ledger] publish failed', error); resolve(); });
      });
      created.on('error', () => { /* the timeout or a later connect decides */ });
      created.connect();
    });
  } catch (error) {
    console.error('[ledger] publish failed', error);
  } finally {
    if (timer) clearTimeout(timer);
    try { client?.disconnect(); } catch { /* already closed */ }
  }
}

/** `after()` throws outside a request scope; run inline there instead of losing the publish. */
export function afterLedgerResponse(work: () => Promise<void>): void {
  try { after(work); } catch { void work(); }
}
