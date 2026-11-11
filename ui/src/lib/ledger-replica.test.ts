import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEndpoint } from "@security/crypto";
import {
  accountIdOf, ledgerChallenge, ledgerHeads, ledgerLastIssuedAt, nextTransition, resolutionPlan, resolveForkTransition, verifyLedger,
} from "@security/ledger/ledger";
import { generateAuthKey } from "@security/ledger/proof";
import type { Ledger, LedgerBridge, LedgerDevice, LedgerGenesis, LedgerOperation } from "@security/ledger/protocol";
import { createSoftPasskey } from "@security/ledger/testing";
import type { SoftPasskey } from "@security/ledger/testing";
import { indexedDbReplicaStorage, LedgerReplica, memoryReplicaStorage } from "./ledger-replica";
import type { LedgerReplicaStorage, ReplicaRecord } from "./ledger-replica";

const ORIGIN = "https://ftown.example";
const RP_ID = "ftown.example";
const BIND = { bind: true } as const;

function b64url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}
interface Account { passkey: SoftPasskey; ledger: Ledger; accountId: string }
async function account(): Promise<Account> {
  const passkey = await createSoftPasskey({ rpId: RP_ID, origin: ORIGIN });
  const createdAt = Date.now() - 60_000;
  const genesis: LedgerGenesis = {
    type: "ftown_account_genesis", version: 2, rpId: RP_ID, origins: [ORIGIN], handle: b64url(crypto.getRandomValues(new Uint8Array(32))),
    createdAt, authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: "Key", addedAt: createdAt },
  };
  const ledger: Ledger = { genesis: { payload: genesis, signature: await passkey.sign(await ledgerChallenge(genesis)) }, transitions: [] };
  return { passkey, ledger, accountId: await accountIdOf(genesis) };
}
async function extend(ledger: Ledger, passkey: SoftPasskey, operation: LedgerOperation): Promise<Ledger> {
  const checkpoint = await verifyLedger(ledger);
  const payload = nextTransition(checkpoint, passkey.credentialId, operation, Date.now(), ledgerLastIssuedAt(ledger));
  return { genesis: ledger.genesis, transitions: [...ledger.transitions, { payload, signature: await passkey.sign(await ledgerChallenge(payload)) }] };
}
async function device(accountId: string): Promise<LedgerDevice> {
  const endpoint = await generateEndpoint(accountId, "browser", false);
  return { endpoint: endpoint.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label: "Device", approvedAt: Date.now() - 1000 };
}
async function bridge(accountId: string, bridgeId: string): Promise<LedgerBridge> {
  const endpoint = await generateEndpoint(accountId, "bridge", false);
  return { bridgeId, endpoint: endpoint.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label: "Bridge", approvedAt: Date.now() - 1000 };
}
const addDevice = async (a: Account, ledger: Ledger) => extend(ledger, a.passkey, { type: "add_device", device: await device(a.accountId) });
const addBridge = async (a: Account, ledger: Ledger, bridgeId: string) => extend(ledger, a.passkey, { type: "add_bridge", bridge: await bridge(a.accountId, bridgeId) });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** `chosen` + every record the plan carries from `other` + the owner's resolve_fork discarding `other`, all signed by `passkey`. */
async function resolved(chosen: Ledger, other: Ledger, passkey: SoftPasskey): Promise<Ledger> {
  let chain = chosen;
  for (const operation of (await resolutionPlan(chosen, other)).carry) chain = await extend(chain, passkey, operation);
  const payload = await resolveForkTransition(chain, other, passkey.credentialId, Date.now());
  return { genesis: chain.genesis, transitions: [...chain.transitions, { payload, signature: await passkey.sign(await ledgerChallenge(payload)) }] };
}
const NONE = { decision: "reject", relation: null, discarded: [], covered: false };

/** Counts commits. */
function counting(inner: LedgerReplicaStorage): LedgerReplicaStorage & { commits: number } {
  const storage: LedgerReplicaStorage & { commits: number } = {
    commits: 0,
    bound: () => inner.bound(),
    read: accountId => inner.read(accountId),
    commit: async (record: ReplicaRecord, expected: number | null) => { storage.commits += 1; return inner.commit(record, expected); },
    clear: () => inner.clear(),
  };
  return storage;
}
/** A record exactly as the previous code (format version 1) stored it: no pending write, no divergent chains, no confirmed revision. */
async function versionOneRecord(ledger: Ledger, sticky: { deviceIds: string[]; bridgeIds: string[] }, extra: Record<string, unknown> = {}): Promise<unknown> {
  const checkpoint = await verifyLedger(ledger);
  return { version: 1, accountId: checkpoint.accountId, serial: 7, ledger, checkpoint, sticky, discarded: [], ...extra };
}
function fixedStorage(value: unknown): LedgerReplicaStorage & { committed: ReplicaRecord[] } {
  const inner = memoryReplicaStorage();
  let record = value;
  const committed: ReplicaRecord[] = [];
  const accountId = (value as { accountId: string }).accountId;
  return {
    committed,
    bound: async () => accountId,
    read: async () => clone(record),
    commit: async (next, expected) => {
      if (expected !== (record as { serial: number }).serial) return false;
      committed.push(clone(next));
      record = clone(next);
      return true;
    },
    clear: () => inner.clear(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LedgerReplica", () => {
  it("binds only on an explicit bind offer, persists, and re-verifies the record on load", async () => {
    const a = await account();
    const chain = await addDevice(a, a.ledger);
    const storage = memoryReplicaStorage();
    const replica = new LedgerReplica(storage);
    expect(await replica.load()).toBeNull();
    expect(await replica.offer(chain)).toEqual(NONE);
    expect(await replica.offer(chain, { bind: false })).toEqual(NONE);
    expect(await storage.bound()).toBeNull();
    expect(await replica.offer(chain, BIND)).toEqual({ decision: "adopt", relation: null, discarded: [], covered: false });
    expect(replica.trusted()?.accountId).toBe(a.accountId);
    expect(replica.trusted()?.devices).toHaveLength(1);
    expect(await storage.bound()).toBe(a.accountId);
    expect(((await storage.read(a.accountId)) as ReplicaRecord).version).toBe(2);

    const reloaded = new LedgerReplica(storage);
    const trusted = await reloaded.load();
    expect(trusted?.head).toBe(replica.raw()?.checkpoint.head);
    expect(reloaded.raw()?.ledger).toEqual(chain);
    expect(reloaded.heads()).toEqual(await ledgerHeads(chain));
  });

  it("binds only to the expected account, and a bound replica rejects a different expected account", async () => {
    const a = await account();
    const b = await account();
    const replica = new LedgerReplica(memoryReplicaStorage());
    await replica.load();
    expect((await replica.offer(await addDevice(a, a.ledger), { bind: true, expectAccountId: b.accountId })).decision).toBe("reject");
    expect(replica.trusted()).toBeNull();
    await replica.offer(await addDevice(a, a.ledger), { bind: true, expectAccountId: a.accountId });
    const longer = await addDevice(a, await addDevice(a, a.ledger));
    expect((await replica.offer(longer, { expectAccountId: b.accountId })).decision).toBe("reject");
    expect((await replica.offer(longer, { expectAccountId: a.accountId })).decision).toBe("keep");
  });

  it("adopts an extension, keeps the same or a shorter chain without writing, and reports the relation", async () => {
    const a = await account();
    const one = await addDevice(a, a.ledger);
    const two = await addDevice(a, one);
    const storage = counting(memoryReplicaStorage());
    const replica = new LedgerReplica(storage);
    await replica.load();
    await replica.offer(one, BIND);
    const before = replica.heads();
    expect(await replica.offer(two)).toEqual({ decision: "adopt", relation: "ahead", discarded: [], covered: false });
    expect(storage.commits).toBe(2);
    // ledgerHeads of the adopted chain, recomputed only by the adoption.
    expect(replica.heads()).toEqual(await ledgerHeads(two));
    expect(replica.heads()).not.toBe(before);
    expect(await replica.offer(one)).toEqual({ decision: "keep", relation: "behind", discarded: [], covered: false });
    expect(await replica.offer(two)).toEqual({ decision: "keep", relation: "same", discarded: [], covered: false });
    expect(storage.commits).toBe(2);
    expect(replica.raw()?.checkpoint.revision).toBe(2);
    const heads = replica.heads();
    await replica.noteConfirmed({ version: 1, head: (await verifyLedger(two)).head, revision: 2, revokedDeviceIds: [], revokedBridgeIds: [] });
    expect(replica.heads()).toBe(heads);
  });

  it("refuses another account once bound, and an invalid candidate, without writing", async () => {
    const a = await account();
    const b = await account();
    const storage = counting(memoryReplicaStorage());
    const replica = new LedgerReplica(storage);
    await replica.load();
    await replica.offer(await addDevice(a, a.ledger), BIND);
    expect(await replica.offer(await addDevice(b, b.ledger), BIND)).toEqual(NONE);
    const longer = await addDevice(a, await addDevice(a, a.ledger));
    const forged = clone(longer);
    forged.transitions[1].signature = longer.transitions[0].signature;
    expect(await replica.offer(forged, { source: "relay" })).toEqual({ decision: "reject", relation: "diverged", discarded: [], covered: false });
    expect(await replica.offer({ nonsense: true })).toEqual(NONE);
    expect(storage.commits).toBe(1);
    expect(replica.trusted()?.accountId).toBe(a.accountId);
    expect(replica.divergence()).toEqual({});
  });

  it("an unbound replica rejects invalid chains even with bind", async () => {
    const replica = new LedgerReplica(memoryReplicaStorage());
    await replica.load();
    expect((await replica.offer({ genesis: 1, transitions: [] }, BIND)).decision).toBe("reject");
    expect(replica.trusted()).toBeNull();
  });

  it("never adopts a valid different history, however long; keeps it per source; adopts the owner's resolution and forgets it", async () => {
    const a = await account();
    const base = await addBridge(a, await addDevice(a, a.ledger), "b1");
    const mine = await extend(base, a.passkey, { type: "revoke_bridge", bridgeId: "b1" });
    const theirs = await addDevice(a, await addDevice(a, await addDevice(a, base)));
    const storage = counting(memoryReplicaStorage());
    const replica = new LedgerReplica(storage);
    await replica.load();
    await replica.offer(mine, BIND);
    const local = JSON.stringify(replica.raw());
    expect(await replica.offer(theirs)).toEqual({ decision: "keep", relation: "diverged", discarded: [], covered: false });
    // Without a source nothing is kept, not even the other chain.
    expect(storage.commits).toBe(1);
    expect(await replica.offer(theirs, { source: "server" })).toEqual({ decision: "keep", relation: "diverged", discarded: [], covered: false });
    expect(JSON.stringify(replica.raw())).toBe(local);
    expect(replica.sticky()).toEqual({ deviceIds: [], bridgeIds: ["b1"] });
    const kept = replica.divergence().server;
    expect(kept?.ledger).toEqual(theirs);
    // The same chain again: no write; the same branch grown: replaced, first-seen time kept.
    const commits = storage.commits;
    await replica.offer(theirs, { source: "server" });
    expect(storage.commits).toBe(commits);
    const grown = await addDevice(a, theirs);
    await replica.offer(grown, { source: "server" });
    expect(replica.divergence().server).toEqual({ version: 1, ledger: grown, firstSeen: kept?.firstSeen });
    await replica.offer(theirs, { source: "relay" });
    expect(Object.keys(replica.divergence()).sort()).toEqual(["relay", "server"]);
    // Kept across a reload (re-verified).
    const reloaded = new LedgerReplica(storage);
    await reloaded.load();
    expect(reloaded.divergence().server?.ledger).toEqual(grown);

    // The owner kept the other history: it carries this branch's removal first, then the resolution; adopted, the branch is discarded.
    const resolution = await resolved(grown, mine, a.passkey);
    expect(resolution.transitions.slice(-2).map(item => item.payload.operation.type)).toEqual(["revoke_bridge", "resolve_fork"]);
    const result = await reloaded.offer(resolution, { source: "server" });
    expect(result).toEqual({ decision: "adopt", relation: "diverged", discarded: [mine.transitions[2]], covered: false });
    expect(reloaded.raw()?.ledger).toEqual(resolution);
    expect(reloaded.raw()?.checkpoint.revokedBridgeIds).toEqual(["b1"]);
    // Both kept chains are prefixes of (or the branch resolved by) the adopted one: nothing diverges any more.
    expect(reloaded.divergence()).toEqual({});
    expect(reloaded.discarded()).toEqual([]);
    // The discarded branch never comes back.
    expect((await reloaded.offer(mine)).decision).toBe("keep");
  });

  it("stores the chain chooseLedger verified, never the bytes offered: local's own prefix records, then the candidate's new ones", async () => {
    const a = await account();
    const one = await addDevice(a, await addDevice(a, a.ledger));
    const local = clone(one);
    const replica = new LedgerReplica(memoryReplicaStorage());
    await replica.offer(one, BIND);
    // The candidate's copy of the shared prefix carries other (unverifiable) signature bytes; only its new record is verified.
    const grown = clone(await addDevice(a, one));
    grown.transitions[0].signature = grown.transitions[1].signature;
    expect((await replica.offer(grown)).decision).toBe("adopt");
    expect(replica.raw()?.ledger.transitions.slice(0, 2)).toEqual(local.transitions);
    expect(replica.raw()?.ledger.transitions[2]).toEqual(grown.transitions[2]);
    // A kept different history is spliced the same way: local's verified prefix, then the other branch.
    const branch = clone(await addDevice(a, { genesis: local.genesis, transitions: local.transitions.slice(0, 1) }));
    branch.transitions[0].signature = local.transitions[1].signature;
    expect(await replica.offer(branch, { source: "peer" })).toEqual({ decision: "keep", relation: "diverged", discarded: [], covered: false });
    expect(replica.divergence().peer?.ledger.transitions).toEqual([local.transitions[0], branch.transitions[1]]);
  });

  it("an invalid different history is rejected and never kept", async () => {
    const a = await account();
    const base = await addDevice(a, a.ledger);
    const mine = await addDevice(a, base);
    const theirs = clone(await addDevice(a, await addDevice(a, base)));
    theirs.transitions[2].signature = theirs.transitions[1].signature;
    const replica = new LedgerReplica(memoryReplicaStorage());
    await replica.offer(mine, BIND);
    expect(await replica.offer(theirs, { source: "peer" })).toEqual({ decision: "reject", relation: "diverged", discarded: [], covered: false });
    expect(replica.divergence()).toEqual({});
    expect(replica.raw()?.ledger).toEqual(mine);
  });

  it("a removal seen on a valid other history becomes sticky at once (whatever the source); an adopted chain's revocations too; trusted() excludes them", async () => {
    const a = await account();
    const withBridges = await addBridge(a, await addBridge(a, a.ledger, "b1"), "b2");
    const other = await extend(withBridges, a.passkey, { type: "revoke_bridge", bridgeId: "b1" });
    const local = await addDevice(a, withBridges);
    const storage = counting(memoryReplicaStorage());
    const replica = new LedgerReplica(storage);
    await replica.load();
    await replica.offer(local, BIND);
    // Kept (never adopted), but its removal by an authority of the fork point is enforced here (chooseLedger's `seen`).
    expect((await replica.offer(other)).decision).toBe("keep");
    expect(replica.sticky()?.bridgeIds).toEqual(["b1"]);
    expect(replica.raw()?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(["b1", "b2"]);
    expect(replica.trusted()?.bridges.map(item => item.bridgeId)).toEqual(["b2"]);
    // Not part of the chain: the chain-only view and what is sent are unchanged.
    expect(replica.raw()?.ledger).toEqual(local);

    const revoked = await extend(local, a.passkey, { type: "revoke_bridge", bridgeId: "b2" });
    expect((await replica.offer(revoked)).decision).toBe("adopt");
    expect(replica.sticky()?.bridgeIds).toEqual(["b1", "b2"]);
    expect(replica.trusted()?.bridges).toEqual([]);
    const reloaded = new LedgerReplica(storage);
    await reloaded.load();
    expect(reloaded.trusted()?.revokedBridgeIds.slice().sort()).toEqual(["b1", "b2"]);
  });

  it("loads a version-1 record of the previous code: sticky ids stay enforced, the next write stores version 2", async () => {
    const a = await account();
    const chain = await addBridge(a, await addDevice(a, a.ledger), "b1");
    const head = (await verifyLedger(chain)).head;
    // Sticky b1 came from a fork the old code lost; the old confirmed state has no revision.
    const storage = fixedStorage(await versionOneRecord(chain, { deviceIds: [], bridgeIds: ["b1"] }, {
      confirmed: { version: 1, head, revokedDeviceIds: [], revokedBridgeIds: [] },
    }));
    const replica = new LedgerReplica(storage);
    const trusted = await replica.load();
    expect(trusted?.bridges).toEqual([]);
    expect(trusted?.revokedBridgeIds).toEqual(["b1"]);
    expect(replica.raw()?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(["b1"]);
    expect(replica.confirmed()).toEqual({ version: 1, head, revokedDeviceIds: [], revokedBridgeIds: [] });
    expect(replica.pendingWrite()).toBeNull();
    expect(replica.divergence()).toEqual({});
    // Still on the RAW chain: its removal can be signed (and adopted) on chain.
    expect((await replica.offer(await extend(chain, a.passkey, { type: "revoke_bridge", bridgeId: "b1" }))).decision).toBe("adopt");
    expect(storage.committed.at(-1)).toMatchObject({ version: 2, serial: 8, sticky: { deviceIds: [], bridgeIds: ["b1"] } });
  });

  it("persists one pending write next to the chain (compare-and-set), never in the chain, across reloads and adoptions", async () => {
    const a = await account();
    const one = await addDevice(a, a.ledger);
    const signed = (await addDevice(a, one)).transitions[1];
    const other = (await addDevice(a, one)).transitions[1];
    const storage = memoryReplicaStorage();
    const replica = new LedgerReplica(storage);
    expect(await replica.setPendingWrite({ version: 1, record: signed, since: 5 }, null)).toBe(false);
    await replica.offer(one, BIND);
    expect(await replica.setPendingWrite({ version: 1, record: signed, since: 5 }, null)).toBe(true);
    expect(replica.pendingWrite()).toEqual({ version: 1, record: signed, since: 5 });
    expect(replica.raw()?.ledger).toEqual(one);
    // Another record is pending already: refused.
    expect(await replica.setPendingWrite({ version: 1, record: other, since: 6 }, null)).toBe(false);
    const reloaded = new LedgerReplica(storage);
    await reloaded.load();
    expect(reloaded.pendingWrite()?.record).toEqual(signed);
    // An adoption keeps it (the client decides whether it was delivered or overtaken).
    await reloaded.offer({ genesis: one.genesis, transitions: [...one.transitions, signed] });
    expect(reloaded.pendingWrite()?.record).toEqual(signed);
    expect(await reloaded.setPendingWrite(null, other)).toBe(false);
    expect(await reloaded.setPendingWrite(null, signed)).toBe(true);
    expect(reloaded.pendingWrite()).toBeNull();
    // An unreadable stored pending write is tolerated as none.
    const stored = await storage.read(a.accountId) as ReplicaRecord;
    await storage.commit({ ...stored, serial: stored.serial + 1, pending: { version: 1, record: { nonsense: true }, since: 1 } as unknown as ReplicaRecord["pending"] }, stored.serial);
    const damaged = new LedgerReplica(storage);
    await damaged.load();
    expect(damaged.pendingWrite()).toBeNull();
    expect(damaged.raw()).not.toBeNull();
    await damaged.setPendingWrite({ version: 1, record: other, since: 7 }, null);
    await damaged.clear();
    expect(damaged.pendingWrite()).toBeNull();
    // Kept with the account across clear() (nothing is sent while unbound), and back when the same account is bound again.
    expect(await storage.read(a.accountId)).toMatchObject({ ledger: null, pending: { version: 1, record: other, since: 7 } });
    expect((await damaged.offer(one, BIND)).decision).toBe("adopt");
    expect(damaged.pendingWrite()?.record).toEqual(other);
  });

  it("blocks a removal the owner signed at once, locally only: pending, then discarded, until it is in the chain or dismissed", async () => {
    const a = await account();
    const base = await addBridge(a, await addBridge(a, a.ledger, "b1"), "b2");
    const revoke = (await extend(base, a.passkey, { type: "revoke_bridge", bridgeId: "b1" })).transitions[2];
    const storage = memoryReplicaStorage();
    const replica = new LedgerReplica(storage);
    await replica.offer(base, BIND);
    expect(await replica.setPendingWrite({ version: 1, record: revoke, since: 1 }, null)).toBe(true);
    // Enforced here at once; not in the chain, not sticky, not in the chain-only view.
    expect(replica.trusted()?.bridges.map(item => item.bridgeId)).toEqual(["b2"]);
    expect(replica.trusted()?.revokedBridgeIds).toEqual(["b1"]);
    expect(replica.chainTrusted()?.bridges.map(item => item.bridgeId)).toEqual(["b1", "b2"]);
    expect(replica.raw()?.ledger).toEqual(base);
    expect(replica.sticky()).toEqual({ deviceIds: [], bridgeIds: [] });
    expect(replica.blocked()).toEqual({ deviceIds: [], bridgeIds: ["b1"] });
    // Clearing the pending write does not lift it; dropping it into discarded keeps it; a reload and clear() keep it.
    expect(await replica.setPendingWrite(null, revoke)).toBe(true);
    expect(replica.blocked()).toEqual({ deviceIds: [], bridgeIds: ["b1"] });
    await replica.noteDiscarded([revoke]);
    const reloaded = new LedgerReplica(storage);
    await reloaded.load();
    expect(reloaded.trusted()?.bridges.map(item => item.bridgeId)).toEqual(["b2"]);
    // Only the owner's dismissal of that entry lifts it.
    await reloaded.dismissDiscarded([revoke]);
    expect(reloaded.blocked()).toEqual({ deviceIds: [], bridgeIds: [] });
    expect(reloaded.trusted()?.bridges.map(item => item.bridgeId)).toEqual(["b1", "b2"]);
    // Or the removal reaching the chain.
    await reloaded.setPendingWrite({ version: 1, record: revoke, since: 2 }, null);
    await reloaded.clear();
    expect(await storage.read(a.accountId)).toMatchObject({ blocked: { deviceIds: [], bridgeIds: ["b1"] } });
    await reloaded.offer(base, BIND);
    expect(reloaded.trusted()?.bridges.map(item => item.bridgeId)).toEqual(["b2"]);
    expect((await reloaded.offer({ genesis: base.genesis, transitions: [...base.transitions, revoke] })).decision).toBe("adopt");
    expect(reloaded.blocked()).toEqual({ deviceIds: [], bridgeIds: [] });
    expect(reloaded.raw()?.checkpoint.revokedBridgeIds).toEqual(["b1"]);
  });

  it("a chain its own resolve_fork discarded exactly is covered: never kept again; a grown or sibling copy is a new divergence", async () => {
    const a = await account();
    const base = await addDevice(a, a.ledger);
    const mine = await addBridge(a, base, "mine");
    const theirs = await addDevice(a, base);
    const replica = new LedgerReplica(memoryReplicaStorage());
    await replica.offer(mine, BIND);
    expect((await replica.offer(theirs, { source: "server" })).relation).toBe("diverged");
    const resolution = await resolved(mine, theirs, a.passkey);
    expect((await replica.offer(resolution, { source: "server" })).decision).toBe("adopt");
    expect(replica.divergence()).toEqual({});
    // The exact discarded branch again, from anyone: covered, nothing kept.
    for (const source of ["server", "relay", "peer"] as const) {
      expect(await replica.offer(theirs, { source })).toEqual({ decision: "keep", relation: "diverged", discarded: [], covered: true });
    }
    expect(replica.divergence()).toEqual({});
    // That branch grown with a record the signer never saw, or a sibling that starts the same way: not covered.
    const grown = await addDevice(a, theirs);
    expect((await replica.offer(grown, { source: "peer" })).covered).toBe(false);
    expect(Object.keys(replica.divergence())).toEqual(["peer"]);
  });

  it("forgets a source's divergent chain once that source offers the same chain, a prefix, or an extension of the local one", async () => {
    const a = await account();
    const base = await addDevice(a, a.ledger);
    const mine = await addBridge(a, base, "mine");
    const theirs = await addDevice(a, base);
    const replica = new LedgerReplica(memoryReplicaStorage());
    await replica.offer(mine, BIND);
    for (const [source, agreeing] of [["server", mine], ["relay", base], ["peer", await addDevice(a, mine)]] as const) {
      await replica.offer(theirs, { source });
      expect(replica.divergence()[source]).toBeDefined();
      await replica.offer(agreeing, { source });
      expect(replica.divergence()[source]).toBeUndefined();
    }
  });

  it("sync(): follows another tab's write, and an unbinding, with one read when nothing changed", async () => {
    const a = await account();
    const one = await addDevice(a, a.ledger);
    const two = await addDevice(a, one);
    const storage = counting(memoryReplicaStorage());
    const tabA = new LedgerReplica(storage);
    const tabB = new LedgerReplica(storage);
    await tabA.offer(one, BIND);
    await tabB.load();
    await tabB.sync();
    expect(tabB.raw()?.ledger).toEqual(one);
    await tabA.offer(two);
    expect(tabB.raw()?.ledger).toEqual(one);
    await tabB.sync();
    expect(tabB.raw()?.ledger).toEqual(two);
    await tabA.clear();
    await tabB.sync();
    expect(tabB.raw()).toBeNull();
    expect(storage.commits).toBe(2);
  });

  it("throws ledger_replica_corrupt on a corrupted record and never resets it; a tampered divergent chain is only dropped", async () => {
    const a = await account();
    const chain = await addDevice(a, a.ledger);
    const source = memoryReplicaStorage();
    const replica = new LedgerReplica(source);
    await replica.load();
    await replica.offer(chain, BIND);
    const good = (await source.read(a.accountId)) as ReplicaRecord;
    const variants: unknown[] = [
      null,
      { ...good, version: 3 },
      { ...good, serial: 0 },
      { ...good, accountId: "x" },
      { ...good, checkpoint: { ...good.checkpoint, head: good.accountId } },
      { ...good, sticky: { deviceIds: [1], bridgeIds: [] } },
      { ...good, sticky: { deviceIds: [] } },
      { ...good, ledger: null, checkpoint: null },
      { ...good, ledger: { ...good.ledger, transitions: [{ ...good.ledger.transitions[0], signature: good.ledger.genesis.signature }] } },
    ];
    for (const value of variants) {
      const commit = vi.fn(async () => true);
      const broken = new LedgerReplica({ bound: async () => a.accountId, read: async () => value, commit, clear: async () => {} });
      await expect(broken.load()).rejects.toThrow("ledger_replica_corrupt");
      expect(broken.trusted()).toBeNull();
      expect(commit).not.toHaveBeenCalled();
    }
    const theirs = clone(await addDevice(a, a.ledger));
    theirs.transitions[0].signature = chain.transitions[0].signature;
    const tampered = new LedgerReplica(fixedStorage({ ...good, divergence: { relay: { version: 1, ledger: theirs, firstSeen: 1 } } }));
    await tampered.load();
    expect(tampered.raw()?.ledger).toEqual(chain);
    expect(tampered.divergence()).toEqual({});
  });

  it("re-decides against another tab's write instead of rolling it back", async () => {
    const a = await account();
    const one = await addDevice(a, a.ledger);
    const two = await addDevice(a, one);
    const three = await addDevice(a, two);
    const shared = counting(memoryReplicaStorage());
    const tabA = new LedgerReplica(shared);
    const tabB = new LedgerReplica(shared);
    await tabA.load();
    await tabA.offer(one, BIND);
    await tabB.load();
    await tabB.offer(three);
    // tabA still holds `one`; its write of `two` loses the compare-and-set, re-reads `three` and keeps it.
    expect(await tabA.offer(two)).toEqual({ decision: "keep", relation: "behind", discarded: [], covered: false });
    expect(tabA.raw()?.checkpoint.revision).toBe(3);
    expect(tabA.heads()).toEqual(await ledgerHeads(three));
    expect(((await shared.read(a.accountId)) as ReplicaRecord).checkpoint.revision).toBe(3);
    // A storage that keeps losing the race surfaces a conflict.
    const stuck = new LedgerReplica({ bound: async () => null, read: async () => null, commit: async () => false, clear: async () => {} });
    await stuck.load();
    await expect(stuck.offer(one, BIND)).rejects.toThrow("ledger_replica_conflict");
  });

  it("a stale tab never re-binds an account another tab cleared, unless it binds explicitly", async () => {
    const a = await account();
    const one = await addDevice(a, a.ledger);
    const two = await addDevice(a, one);
    const shared = memoryReplicaStorage();
    const tabA = new LedgerReplica(shared);
    const tabB = new LedgerReplica(shared);
    await tabA.load();
    await tabA.offer(one, BIND);
    await tabB.load();
    await tabB.clear();
    expect((await tabA.offer(two)).decision).toBe("reject");
    expect(await shared.bound()).toBeNull();
    expect(tabA.trusted()).toBeNull();
    expect(tabA.heads()).toBeNull();
  });

  it("serializes concurrent offers", async () => {
    const a = await account();
    const one = await addDevice(a, a.ledger);
    const two = await addDevice(a, one);
    const replica = new LedgerReplica(memoryReplicaStorage());
    await replica.load();
    const results = await Promise.all([replica.offer(one, BIND), replica.offer(two), replica.offer(one)]);
    expect(results.map(item => item.decision)).toEqual(["adopt", "adopt", "keep"]);
  });

  it("clear() unbinds and drops the chain but keeps the account's sticky set for its next binding", async () => {
    const a = await account();
    const b = await account();
    const withBridge = await addBridge(a, a.ledger, "b1");
    const revoking = await extend(withBridge, a.passkey, { type: "revoke_bridge", bridgeId: "b1" });
    const storage = memoryReplicaStorage();
    const replica = new LedgerReplica(storage);
    await replica.load();
    await replica.offer(withBridge, BIND);
    await replica.offer(revoking);
    await replica.clear();
    expect(replica.trusted()).toBeNull();
    expect(await storage.bound()).toBeNull();
    expect(await storage.read(a.accountId)).toMatchObject({ ledger: null, checkpoint: null, sticky: { deviceIds: [], bridgeIds: ["b1"] } });

    expect((await replica.offer(await addDevice(b, b.ledger), BIND)).decision).toBe("adopt");
    expect(replica.trusted()?.accountId).toBe(b.accountId);
    await replica.clear();
    // Binding to `a` again, from a chain that never revoked b1, still distrusts b1.
    expect((await replica.offer(withBridge, BIND)).decision).toBe("adopt");
    expect(replica.raw()?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(["b1"]);
    expect(replica.trusted()?.bridges).toEqual([]);
    expect(replica.sticky()?.bridgeIds).toEqual(["b1"]);
  });

  it("persists the confirmed server state with the record: across reloads and adopts, unreadable means unknown, clear() drops it", async () => {
    const a = await account();
    const one = await addDevice(a, a.ledger);
    const storage = memoryReplicaStorage();
    const replica = new LedgerReplica(storage);
    await replica.offer(one, BIND);
    expect(replica.confirmed()).toBeNull();
    const confirmed = { version: 1 as const, head: (await verifyLedger(one)).head, revision: 1, revokedDeviceIds: ["d".repeat(43)], revokedBridgeIds: ["studio"] };
    await replica.noteConfirmed(confirmed);
    const serial = (await storage.read(a.accountId) as ReplicaRecord).serial;
    // Unchanged: no write.
    await replica.noteConfirmed(clone(confirmed));
    expect((await storage.read(a.accountId) as ReplicaRecord).serial).toBe(serial);
    const reloaded = new LedgerReplica(storage);
    await reloaded.load();
    expect(reloaded.confirmed()).toEqual(confirmed);
    // Adopting a longer chain keeps it (it describes the server, not the local chain).
    expect((await reloaded.offer(await addBridge(a, one, "b1"))).decision).toBe("adopt");
    expect(reloaded.confirmed()).toEqual(confirmed);
    // A damaged value is no corruption: the record loads, the server state is unknown.
    const stored = await storage.read(a.accountId) as ReplicaRecord;
    expect(await storage.commit({ ...stored, serial: stored.serial + 1, confirmed: { version: 2, head: 5 } as unknown as ReplicaRecord["confirmed"] }, stored.serial)).toBe(true);
    const damaged = new LedgerReplica(storage);
    await damaged.load();
    expect(damaged.raw()).not.toBeNull();
    expect(damaged.confirmed()).toBeNull();
    await damaged.noteConfirmed(confirmed);
    await damaged.noteConfirmed(null);
    expect(damaged.confirmed()).toBeNull();
    await damaged.noteConfirmed(confirmed);
    await damaged.clear();
    expect(damaged.confirmed()).toBeNull();
    await damaged.offer(one, BIND);
    expect(damaged.confirmed()).toBeNull();
  });

  it("reports secure_context_required without WebCrypto", async () => {
    vi.stubGlobal("crypto", undefined);
    await expect(new LedgerReplica(memoryReplicaStorage()).load()).rejects.toThrow("secure_context_required");
  });
});

/** Minimal in-memory IndexedDB: keyPath stores, get/put/delete, multi-store transactions, abort and atomic completion. */
function fakeIndexedDB(): IDBFactory {
  const databases = new Map<string, Map<string, { keyPath: string; rows: Map<unknown, unknown> }>>();
  function transaction(stores: Map<string, { keyPath: string; rows: Map<unknown, unknown> }>) {
    let pending = 0;
    let finished = false;
    const writes: (() => void)[] = [];
    const tx = {
      error: null as unknown,
      oncomplete: null as (() => void) | null, onabort: null as (() => void) | null, onerror: null as (() => void) | null,
      abort: () => { if (!finished) { finished = true; setTimeout(() => tx.onabort?.(), 0); } },
      objectStore: (name: string) => {
        const store = stores.get(name);
        if (!store) throw new Error("NotFoundError");
        const run = (operation: () => unknown) => {
          const request = { result: undefined as unknown, error: null as unknown, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
          pending += 1;
          setTimeout(() => {
            if (finished) return;
            request.result = operation();
            request.onsuccess?.();
            pending -= 1;
            setTimeout(() => {
              if (pending === 0 && !finished) { finished = true; for (const write of writes) write(); tx.oncomplete?.(); }
            }, 0);
          }, 0);
          return request;
        };
        return {
          get: (key: unknown) => run(() => structuredClone(store.rows.get(key))),
          put: (value: Record<string, unknown>) => run(() => { const copy = structuredClone(value); writes.push(() => store.rows.set(copy[store.keyPath], copy)); }),
          delete: (key: unknown) => run(() => { writes.push(() => store.rows.delete(key)); }),
        };
      },
    };
    return tx;
  }
  return {
    open: (name: string) => {
      const request = {
        result: undefined as unknown, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null, onupgradeneeded: null as (() => void) | null,
      };
      setTimeout(() => {
        const created = !databases.has(name);
        if (created) databases.set(name, new Map());
        const stores = databases.get(name)!;
        request.result = {
          objectStoreNames: { contains: (store: string) => stores.has(store) },
          createObjectStore: (store: string, options: { keyPath: string }) => { stores.set(store, { keyPath: options.keyPath, rows: new Map() }); },
          transaction: () => transaction(stores),
          close: () => undefined,
        };
        if (created) request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  } as unknown as IDBFactory;
}

describe("indexedDbReplicaStorage", () => {
  it("round-trips the bound record, enforces the serial and the bound account, and keeps sticky on clear", async () => {
    vi.stubGlobal("indexedDB", fakeIndexedDB());
    const a = await account();
    const b = await account();
    const storage = indexedDbReplicaStorage();
    expect(await storage.bound()).toBeNull();
    const replica = new LedgerReplica(storage);
    await replica.load();
    await replica.offer(await addDevice(a, a.ledger), BIND);
    expect(await storage.bound()).toBe(a.accountId);
    const stored = (await storage.read(a.accountId)) as ReplicaRecord;
    expect(stored.serial).toBe(1);
    expect(await storage.commit({ ...stored, serial: 2 }, null)).toBe(false);
    expect(await storage.commit({ ...stored, serial: 2 }, 5)).toBe(false);
    expect(await storage.commit({ ...stored, accountId: b.accountId, serial: 1 }, null)).toBe(false);
    expect(await storage.commit({ ...stored, serial: 2 }, 1)).toBe(true);
    expect(((await storage.read(a.accountId)) as ReplicaRecord).serial).toBe(2);

    const reloaded = new LedgerReplica(storage);
    expect((await reloaded.load())?.accountId).toBe(a.accountId);
    await storage.clear();
    expect(await storage.bound()).toBeNull();
    expect(await storage.read(a.accountId)).toMatchObject({ serial: 3, ledger: null, checkpoint: null, sticky: { deviceIds: [], bridgeIds: [] } });
    expect(await storage.read(b.accountId)).toBeNull();
    // A stale writer that still expects serial 2 loses.
    expect(await storage.commit({ ...stored, serial: 3 }, 2)).toBe(false);
  });

  it("reports storage_unavailable without IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(new LedgerReplica(indexedDbReplicaStorage()).load()).rejects.toThrow("storage_unavailable");
  });
});
