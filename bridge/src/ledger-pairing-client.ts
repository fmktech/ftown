/**
 * Bridge side of passkey-ledger pairing (DESIGN 3.3). One attempt, bounded by the link lifetime:
 * create the link, print it, poll the pair mailbox, open the sealed approval, fetch the ledger from the server, accept it only through
 * confirmPairedLedger, then bind the identity and adopt the ledger. A bad bundle is terminal. The link secret appears only inside the
 * URL fragment of the printed link.
 */
import type { EndpointIdentity } from './security/protocol.js';
import type { LedgerBridgeIdentity } from './security/bridge/ledger-identity.js';
import type { BridgeLedgerStore } from './security/bridge/ledger-store.js';
import {
  PAIR_FRAGMENT_PREFIX, PAIR_LIFETIME_MS, createBridgePairRequest, encodePairLink, openPairApproval, pairComparisonCode,
} from './security/ledger/pairing.js';
import { LEDGER_LIMITS } from './security/ledger/protocol.js';
import type { Ledger, LedgerCheckpoint } from './security/ledger/protocol.js';

export interface LedgerPairingDeps {
  apiUrl: string;
  dataDir: string;
  bridgeId: string;
  label: string;
  /** From loadOrCreateLedgerIdentity (unbound). */
  identity: LedgerBridgeIdentity;
  /** Empty store. */
  store: BridgeLedgerStore;
  /** Wraps bindLedgerIdentity. */
  bindIdentity: (accountId: string) => Promise<LedgerBridgeIdentity>;
  print: (line: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default 5000. */
  pollIntervalMs?: number;
  /** Default 600000 (PAIR_LIFETIME_MS). */
  lifetimeMs?: number;
}

export const PAIRING_EXPIRED_HINT = 'Pairing link expired. Run `ftown start` to try again.';

/** Strips control, zero-width and bidi characters, trims, caps the length. Built from code points, not literals. */
function sanitizeLabel(label: string, fallback: string): string {
  let out = '';
  for (const ch of label) {
    const code = ch.codePointAt(0) as number;
    const bad = code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2060 && code <= 0x2064) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff || code === 0x061c;
    if (!bad) out += ch;
  }
  out = out.trim().slice(0, LEDGER_LIMITS.maxLabelLength).trim();
  return out === '' ? fallback : out;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type Step<T> = { kind: 'value'; value: T } | { kind: 'retry' } | { kind: 'expired' } | { kind: 'rejected' };

export async function runLedgerPairing(deps: LedgerPairingDeps): Promise<{ accountId: string; checkpoint: LedgerCheckpoint }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? 5000;
  const lifetimeMs = deps.lifetimeMs ?? PAIR_LIFETIME_MS;
  const origin = new URL(deps.apiUrl).origin;

  const link = createBridgePairRequest({
    bridgeId: deps.bridgeId,
    endpointPublicKey: deps.identity.endpointPublicKey,
    authPublicKey: deps.identity.authPublicKey,
    label: sanitizeLabel(deps.label, 'ftown bridge'),
    now: now(),
    lifetimeMs,
  });
  const request = link.request;
  const code = await pairComparisonCode(request);
  deps.print('Open this link on a device that has your ftown passkey:');
  deps.print(`${origin}/pair${PAIR_FRAGMENT_PREFIX}${encodePairLink(link)}`);
  deps.print(`Type this code on the page to confirm it is this computer: ${code}`);

  const expire = (): never => {
    deps.print(PAIRING_EXPIRED_HINT);
    throw new Error('pairing_expired');
  };
  const mailboxUrl = `${origin}/api/pair/${encodeURIComponent(request.requestId)}`;

  // The receiver identity: the bridge's own endpoint key, rebound to the account inside openPairApproval.
  const receiver: EndpointIdentity = {
    endpoint: { version: 1, id: deps.identity.endpointId, ownerId: `solo:${deps.bridgeId}`, kind: 'bridge', publicKey: deps.identity.endpointPublicKey },
    keyPair: deps.identity.keyPair,
  };

  async function pollOnce(): Promise<Step<string>> {
    let response: Response;
    try {
      response = await fetchImpl(mailboxUrl, { method: 'GET', headers: { accept: 'application/json' } });
    } catch {
      return { kind: 'retry' };
    }
    if (response.status === 410) return { kind: 'expired' };
    if (response.status !== 200) return { kind: 'retry' };
    try {
      const body: unknown = await response.json();
      const sealed = (body as { sealed?: unknown } | null)?.sealed;
      if (typeof sealed !== 'string') return { kind: 'rejected' };
      return { kind: 'value', value: sealed };
    } catch {
      return { kind: 'rejected' };
    }
  }
  async function fetchLedger(accountId: string): Promise<Step<Ledger>> {
    let response: Response;
    try {
      response = await fetchImpl(`${origin}/api/account/ledger?accountId=${encodeURIComponent(accountId)}`, { method: 'GET', headers: { accept: 'application/json' } });
    } catch {
      return { kind: 'retry' };
    }
    if (response.status === 429 || response.status >= 500) return { kind: 'retry' };
    if (response.status !== 200) return { kind: 'rejected' };
    try {
      const body: unknown = await response.json();
      const ledger = (body as { ledger?: unknown } | null)?.ledger;
      if (typeof ledger !== 'object' || ledger === null) return { kind: 'rejected' };
      return { kind: 'value', value: ledger as Ledger };
    } catch {
      return { kind: 'rejected' };
    }
  }

  // Phase 1: wait for the sealed approval. A bad bundle is terminal.
  let sealed: string | null = null;
  while (sealed === null) {
    if (now() >= request.expiresAt) return expire();
    const step = await pollOnce();
    if (step.kind === 'expired') return expire();
    if (step.kind === 'rejected') throw new Error('pairing_rejected');
    if (step.kind === 'value') sealed = step.value;
    else await sleep(pollIntervalMs);
  }

  let approval;
  try {
    approval = await openPairApproval(sealed, link, receiver, now());
  } catch {
    throw new Error('pairing_rejected');
  }

  // Phase 2: the approval is consumed, so only transient failures of the ledger read are retried, until the deadline.
  let ledger: Ledger | null = null;
  while (ledger === null) {
    if (now() >= request.expiresAt) return expire();
    const step = await fetchLedger(approval.accountId);
    if (step.kind === 'rejected') throw new Error('pairing_rejected');
    if (step.kind === 'value') ledger = step.value;
    else await sleep(pollIntervalMs);
  }

  // adoptPaired verifies (confirmPairedLedger) and persists; only then is the identity bound.
  let checkpoint: LedgerCheckpoint;
  try {
    checkpoint = await deps.store.adoptPaired(link, approval, ledger, now());
  } catch {
    throw new Error('pairing_rejected');
  }
  await deps.bindIdentity(approval.accountId);

  // The label of the passkey that signed this bridge's add_bridge (confirmPairedLedger guarantees one exists).
  let credentialId = '';
  for (const record of ledger.transitions) {
    const operation = record.payload.operation;
    if (operation.type === 'add_bridge' && operation.bridge.bridgeId === request.bridgeId) credentialId = record.payload.credentialId;
  }
  const authority = checkpoint.authorities.filter(item => item.credentialId === credentialId)[0];
  const passkeyLabel = sanitizeLabel(authority === undefined ? '' : authority.label, 'unknown');
  deps.print(`Paired with account ${approval.accountId.slice(0, 8)} (passkey "${passkeyLabel}")`);
  return { accountId: approval.accountId, checkpoint };
}
