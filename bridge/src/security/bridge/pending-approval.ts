import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { PendingBridgeDecision, PendingBridgeStatus } from '../pending-approval-protocol.js';
import { normalizePendingAccountHint } from '../pending-approval-crypto.js';
import { AtomicSnapshot } from './snapshot.js';
import { BridgeSecurityError } from './errors.js';

const hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const code = z.string().regex(/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
const common = { version: z.literal(1), requestId: hash, processNonce: hash, expiresAt: z.string().datetime() };
const statusSchema: z.ZodType<PendingBridgeStatus> = z.union([
  z.object({ ...common, phase: z.literal('waiting'), offerHash: hash.nullable(), comparisonCode: z.null() }).strict(),
  z.object({ ...common, phase: z.enum(['comparing', 'confirming']), offerHash: hash, comparisonCode: code }).strict(),
  z.object({ ...common, phase: z.enum(['approved', 'rejected', 'cancelled', 'expired', 'conflict']), offerHash: hash.nullable(), comparisonCode: z.null() }).strict(),
]);
const decisionSchema: z.ZodType<PendingBridgeDecision> = z.union([
  z.object({ ...common, decision: z.literal('confirm'), offerHash: hash, comparisonCode: code }).strict(),
  z.object({ ...common, decision: z.literal('reject'), offerHash: hash.nullable() }).strict(),
]);
const terminal = (state: PendingBridgeStatus) => ['approved', 'rejected', 'cancelled', 'expired', 'conflict'].includes(state.phase);

/** The bridge is the only writer. CLI reads never modify this snapshot. */
export async function writePendingBridgeStatus(dataDir: string, status: PendingBridgeStatus): Promise<void> {
  const store = new AtomicSnapshot(join(dataDir, 'security', 'pending-approval-status.json'),
    z.object({ status: statusSchema }).strict(), () => ({ status }));
  await store.transact(state => { state.status = status; });
}
export async function readPendingBridgeStatus(dataDir: string): Promise<PendingBridgeStatus> {
  const store = new AtomicSnapshot(join(dataDir, 'security', 'pending-approval-status.json'),
    z.object({ status: statusSchema }).strict().nullable(), () => null);
  const saved = await store.read(state => state?.status ?? null);
  if (!saved) throw new BridgeSecurityError('account_approval_required');
  return saved;
}
/** Called only by explicit OS-local CLI action, never by server status. */
export async function submitPendingBridgeDecision(dataDir: string, decision: 'confirm' | 'reject', comparisonCode?: string, now = Date.now()): Promise<void> {
  const status = await readPendingBridgeStatus(dataDir);
  if (terminal(status) || Date.parse(status.expiresAt) <= now) throw new BridgeSecurityError('account_enrollment_expired');
  const base = { version: 1 as const, requestId: status.requestId, processNonce: status.processNonce, expiresAt: status.expiresAt };
  let value: PendingBridgeDecision;
  if (decision === 'confirm') {
    if (status.phase !== 'comparing' || comparisonCode !== status.comparisonCode) throw new BridgeSecurityError('account_enrollment_invalid');
    value = { ...base, decision, offerHash: status.offerHash, comparisonCode };
  } else value = { ...base, decision, offerHash: status.offerHash };
  const store = new AtomicSnapshot(join(dataDir, 'security', 'pending-approval-confirmation.json'),
    z.object({ decision: decisionSchema }).strict(), () => ({ decision: value }));
  await store.transact(state => { state.decision = value; });
}
export function matchesPendingBridgeDecision(status: PendingBridgeStatus, decision: PendingBridgeDecision, now = Date.now()): boolean {
  return !terminal(status) && Date.parse(status.expiresAt) > now && decision.requestId === status.requestId
    && decision.processNonce === status.processNonce && decision.offerHash === status.offerHash && decision.expiresAt === status.expiresAt
    && (decision.decision === 'reject' || (status.phase === 'comparing' && decision.comparisonCode === status.comparisonCode));
}
/** Reads a separate CLI-owned message file; never edits or deletes it. */
export async function waitForPendingBridgeDecision(dataDir: string, status: PendingBridgeStatus, signal: AbortSignal): Promise<PendingBridgeDecision> {
  const store = new AtomicSnapshot(join(dataDir, 'security', 'pending-approval-confirmation.json'),
    z.object({ decision: decisionSchema }).strict().nullable(), () => null);
  for (;;) {
    signal.throwIfAborted();
    if (Date.parse(status.expiresAt) <= Date.now()) throw new BridgeSecurityError('account_enrollment_expired');
    const decision = await store.read(state => state?.decision ?? null);
    if (decision && matchesPendingBridgeDecision(status, decision)) return decision;
    await delay(100, undefined, { signal });
  }
}

export type BridgePairingMode = { method: 'pending-v1'; accountHint: string } | { method: 'bootstrap' };
export async function selectBridgePairingMode(options: { account?: string; bootstrap?: boolean; interactive: boolean; previousPending?: boolean },
  prompt: () => Promise<string>): Promise<BridgePairingMode> {
  if (options.account !== undefined && options.bootstrap) throw new Error('--account and --bootstrap cannot be combined');
  if (options.account !== undefined) return { method: 'pending-v1', accountHint: normalizePendingAccountHint(options.account) };
  if (options.previousPending && !options.bootstrap && !options.interactive) throw new Error('Previous inbox approval was interrupted. Restart with --account <email>, or select --bootstrap explicitly.');
  if (options.bootstrap || !options.interactive) return { method: 'bootstrap' };
  const entered = await prompt();
  return entered.trim() === '' ? { method: 'bootstrap' } : { method: 'pending-v1', accountHint: normalizePendingAccountHint(entered) };
}
