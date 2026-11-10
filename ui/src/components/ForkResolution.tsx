"use client";

import { useEffect, useId, useRef } from "react";
import type { LedgerAuthority, LedgerBridge, LedgerCheckpoint, LedgerDevice, LedgerOperation, LedgerTransition } from "@security/ledger/protocol";
import type { LedgerDivergence, LedgerDivergenceSide } from "@/lib/ledger-client";
import type { AccountSecurity } from "@/hooks/useAccountSecurity";
import { securityErrorMessage } from "./SecurityPanel";

/*
 * The two-histories screen (CONTRACT §12): shown while snapshot.divergence is set. It lists what each history holds after the fork,
 * what keeping either one re-signs (carry) and what it discards, and offers "Keep this history" under each. Every string below comes
 * from a signed chain and is rendered as text only (never as HTML).
 */

export const FORK_HEADING = "Two different histories of this account exist";
export const FORK_INTRO = "They cannot both be kept. Review what each one contains and keep one. Nothing changes until you confirm.";
export const FORK_BLOCKED = "Other changes to your account are turned off until you choose one history.";
export const FORK_KEPT = "History kept. Other replicas will follow.";
export const FORK_NO_CHANGES = "No changes after the common part.";
export const FORK_NOTHING_LOST = "Nothing will be lost.";
const SOURCES: Record<LedgerDivergence["source"], string> = {
  server: "The server holds the other history.",
  peer: "One of your computers holds the other history.",
  relay: "Another replica announced the other history.",
};

/** Names by id from every chain record in reach: the checkpoint, the other chain (it holds the shared prefix) and both sides after the fork. */
type Names = { devices: Map<string, string>; bridges: Map<string, string> };

function learn(names: Names, operation: LedgerOperation): void {
  if (operation.type === "add_device") names.devices.set(operation.device.endpoint.id, operation.device.label);
  else if (operation.type === "add_bridge") names.bridges.set(operation.bridge.bridgeId, operation.bridge.label);
}

export function memberNames(divergence: LedgerDivergence, checkpoint: LedgerCheckpoint | null): Names {
  const names: Names = { devices: new Map(), bridges: new Map() };
  const devices: readonly LedgerDevice[] = checkpoint?.devices ?? [];
  const bridges: readonly LedgerBridge[] = checkpoint?.bridges ?? [];
  for (const item of devices) names.devices.set(item.endpoint.id, item.label);
  for (const item of bridges) names.bridges.set(item.bridgeId, item.label);
  for (const record of divergence.other.transitions) learn(names, record.payload.operation);
  for (const transition of [...divergence.fork.mine, ...divergence.fork.theirs]) learn(names, transition.operation);
  return names;
}

const clean = (value: string | undefined, fallback: string): string => (value && value.trim() ? value : fallback);
const quote = (value: string) => `“${value}”`;

/** One plain sentence for an operation; `label` is the text to quote for a member added or removed. */
export function describeOperation(operation: LedgerOperation, names: Names): { text: string; label: string | null } {
  switch (operation.type) {
    case "add_device": { const label = clean(operation.device.label, "Browser"); return { text: `Added browser ${quote(label)}`, label }; }
    case "add_bridge": { const label = clean(operation.bridge.label, "Computer"); return { text: `Added computer ${quote(label)}`, label }; }
    case "add_authority": { const label = clean((operation.authority as LedgerAuthority).label, "Passkey"); return { text: `Added passkey ${quote(label)}`, label }; }
    case "revoke_device": { const label = clean(names.devices.get(operation.endpointId), operation.endpointId.slice(0, 8)); return { text: `Removed browser ${quote(label)}`, label }; }
    case "revoke_bridge": { const label = clean(names.bridges.get(operation.bridgeId), operation.bridgeId.slice(0, 8)); return { text: `Removed computer ${quote(label)}`, label }; }
    case "resolve_fork": return { text: "Chose this history over another one", label: null };
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function carryText(side: LedgerDivergenceSide): string {
  if (side.carry.length === 0) return "Keeping this history discards the other one's changes listed opposite.";
  const removals = side.carry.filter(item => item.type === "revoke_device" || item.type === "revoke_bridge").length;
  const passkeys = side.carry.filter(item => item.type === "add_authority").length;
  const parts = [removals > 0 ? plural(removals, "removal", "removals") : null, passkeys > 0 ? plural(passkeys, "passkey", "passkeys") : null].filter(Boolean);
  const re = parts.length ? parts.join(" and ") : plural(side.carry.length, "change", "changes");
  return `Keeping this history re-applies ${re} from the other one, then discards the rest. You will confirm ${plural(side.carry.length + 1, "time", "times")}.`;
}

function Records({ transitions, names, empty }: { transitions: LedgerTransition[]; names: Names; empty: string }) {
  if (!transitions.length) return <p className="text-xs text-[var(--text-muted)]">{empty}</p>;
  return <ol className="space-y-2">
    {transitions.map(item => {
      const { text, label } = describeOperation(item.operation, names);
      const when = new Date(item.issuedAt);
      return <li key={item.revision} className="min-w-0 text-sm">
        <span className="block truncate" title={label ?? text}>{text}</span>
        {Number.isFinite(when.getTime()) && <time dateTime={when.toISOString()} className="block text-xs text-[var(--text-muted)]">{when.toLocaleString()}</time>}
      </li>;
    })}
  </ol>;
}

function Column({ title, transitions, other, side, names, busy, running, steps, onKeep }: {
  title: string; transitions: LedgerTransition[]; other: LedgerTransition[]; side: LedgerDivergenceSide; names: Names;
  busy: boolean; running: boolean; steps: number; onKeep: () => void;
}) {
  const titleId = useId();
  /** What this choice loses: the other history's added browsers and computers. Removals and passkeys are carried, never lost. */
  const lost = other.filter(item => item.operation.type === "add_device" || item.operation.type === "add_bridge");
  return <section aria-labelledby={titleId} className="min-w-0 space-y-3 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] p-3">
    <h4 id={titleId} className="text-sm font-semibold">{title}</h4>
    <Records transitions={transitions} names={names} empty={FORK_NO_CHANGES} />
    <p className="text-xs leading-relaxed text-[var(--text-muted)]">{carryText(side)}</p>
    {side.carry.length > 0 && <ul aria-label="Re-applied from the other history" className="list-disc space-y-1 pl-4 text-xs">
      {side.carry.map((operation, index) => <li key={index} className="min-w-0 truncate" title={describeOperation(operation, names).text}>{describeOperation(operation, names).text}</li>)}
    </ul>}
    <div role="note" className="space-y-1 rounded-md border-2 border-[var(--status-error)] p-2 text-xs">
      {lost.length ? <>
        <p className="font-semibold"><span aria-hidden="true">⚠ </span>Will be discarded:</p>
        <ul className="list-disc space-y-1 pl-4">
          {lost.map(item => { const text = describeOperation(item.operation, names).text; return <li key={item.revision} className="min-w-0 truncate" title={text}>{text}</li>; })}
        </ul>
      </> : <p className="font-semibold">{FORK_NOTHING_LOST}</p>}
    </div>
    <button type="button" className="btn-accent min-h-11 sm:min-h-8" disabled={busy || !side.canKeep} onClick={onKeep}>Keep this history</button>
    {!side.canKeep && <p className="text-xs text-[var(--text-muted)]">{side.reason === "ledger_limit" ? "This history cannot be kept: it would exceed the limit of passkeys." : "This history cannot be kept."}</p>}
    {running && <p role="status" className="text-xs">Confirm with your passkey. You may be asked {steps} times.</p>}
  </section>;
}

export function ForkResolution({ divergence, security, checkpoint, onKept }: {
  divergence: LedgerDivergence; security: AccountSecurity; checkpoint: LedgerCheckpoint | null; onKept?: () => void;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const names = memberNames(divergence, checkpoint);
  const { busy, error } = security;
  const keep = (which: "mine" | "theirs") => void security.run(`fork:${which}`, client => client.resolveDivergence(which), { signs: true }).then(done => { if (done) onKept?.(); });
  const steps = (side: LedgerDivergenceSide) => side.carry.length + 1;
  const errorText = error === null ? null : error === "resolution_outdated" ? "The other history changed. Review it again."
    : error === "passkey_cancelled" ? "Cancelled. Nothing was changed." : securityErrorMessage({ code: error });
  return <section aria-labelledby={headingId} className="space-y-3 rounded-md border border-[var(--status-error)] p-3">
    <h3 id={headingId} ref={heading} tabIndex={-1} className="text-sm font-semibold">{FORK_HEADING}</h3>
    <p className="text-xs leading-relaxed">{FORK_INTRO}</p>
    <p className="text-xs text-[var(--text-muted)]">{SOURCES[divergence.source]}</p>
    <p className="text-xs text-[var(--text-muted)]">{FORK_BLOCKED}</p>
    <p className="text-xs">{plural(divergence.fork.fork.revision, "earlier change is", "earlier changes are")} identical.</p>
    {security.needsSigner && <div className="space-y-1">
      <p className="text-xs text-[var(--text-muted)]">Your account has several passkeys. Choose the passkey on this device first, then keep a history.</p>
      <button type="button" className="btn-accent min-h-11 sm:min-h-8" disabled={!!busy} onClick={() => void security.chooseSigner()}>{busy === "signer" ? "Waiting for passkey…" : "Choose passkey"}</button>
    </div>}
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Column title="This browser's history" transitions={divergence.fork.mine} other={divergence.fork.theirs} side={divergence.mine} names={names}
        busy={!!busy} running={busy === "fork:mine"} steps={steps(divergence.mine)} onKeep={() => keep("mine")} />
      <Column title="The other history" transitions={divergence.fork.theirs} other={divergence.fork.mine} side={divergence.theirs} names={names}
        busy={!!busy} running={busy === "fork:theirs"} steps={steps(divergence.theirs)} onKeep={() => keep("theirs")} />
    </div>
    {errorText && <p role="alert" className="text-sm text-[var(--status-error)]">{errorText}</p>}
  </section>;
}
