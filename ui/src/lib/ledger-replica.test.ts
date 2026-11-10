import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEndpoint } from "@security/crypto";
import { accountIdOf, ledgerChallenge, ledgerLastIssuedAt, nextTransition, verifyLedger } from "@security/ledger/ledger";
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LedgerReplica", () => {
  it("binds only on an explicit bind offer, persists, and re-verifies the record on load", async () => {
    const a = await account();
    const chain = await addDevice(a, a.ledger);
    const storage = memoryReplicaStorage();
    const replica = new LedgerReplica(storage);
    expect(await replica.load()).toBeNull();
    expect(await replica.offer(chain)).toEqual({ decision: "reject", discarded: [] });
    expect(await replica.offer(chain, { bind: false })).toEqual({ decision: "reject", discarded: [] });
    expect(await storage.bound()).toBeNull();
    expect(await replica.offer(chain, BIND)).toEqual({ decision: "adopt", discarded: [] });
    expect(replica.trusted()?.accountId).toBe(a.accountId);
    expect(replica.trusted()?.devices).toHaveLength(1);
    expect(await storage.bound()).toBe(a.accountId);

    const reloaded = new LedgerReplica(storage);
    const trusted = await reloaded.load();
    expect(trusted?.head).toBe(replica.raw()?.checkpoint.head);
    expect(reloaded.raw()?.ledger).toEqual(chain);
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
    expect((await replica.offer(longer, { expectAccountId: a.accountId })).decision).toBe("adopt");
  });

  it("adopts an extension and keeps a shorter chain without writing", async () => {
    const a = await account();
    const one = await addDevice(a, a.ledger);
    const two = await addDevice(a, one);
    const storage = counting(memoryReplicaStorage());
    const replica = new LedgerReplica(storage);
    await replica.load();
    await replica.offer(one, BIND);
    expect(await replica.offer(two)).toEqual({ decision: "adopt", discarded: [] });
    expect(storage.commits).toBe(2);
    expect(await replica.offer(one)).toEqual({ decision: "keep", discarded: [] });
    expect(await replica.offer(two)).toEqual({ decision: "keep", discarded: [] });
    expect(storage.commits).toBe(2);
    expect(replica.raw()?.checkpoint.revision).toBe(2);
  });

  it("refuses another account once bound, and an invalid candidate, without writing", async () => {
    const a = await account();
    const b = await account();
    const storage = counting(memoryReplicaStorage());
    const replica = new LedgerReplica(storage);
    await replica.load();
    await replica.offer(await addDevice(a, a.ledger), BIND);
    expect(await replica.offer(await addDevice(b, b.ledger), BIND)).toEqual({ decision: "reject", discarded: [] });
    const longer = await addDevice(a, await addDevice(a, a.ledger));
    const forged = clone(longer);
    forged.transitions[1].signature = longer.transitions[0].signature;
    expect((await replica.offer(forged)).decision).toBe("reject");
    expect(await replica.offer({ nonsense: true })).toEqual({ decision: "reject", discarded: [] });
    expect(storage.commits).toBe(1);
    expect(replica.trusted()?.accountId).toBe(a.accountId);
  });

  it("an unbound replica rejects invalid chains even with bind", async () => {
    const replica = new LedgerReplica(memoryReplicaStorage());
    await replica.load();
    expect((await replica.offer({ genesis: 1, transitions: [] }, BIND)).decision).toBe("reject");
    expect(replica.trusted()).toBeNull();
  });

  it("follows the fork order and reports the discarded local records", async () => {
    const a = await account();
    const base = await addDevice(a, a.ledger);
    const mine = await addDevice(a, base);
    const theirs = await addDevice(a, await addDevice(a, base));
    const replica = new LedgerReplica(memoryReplicaStorage());
    await replica.load();
    await replica.offer(mine, BIND);
    const result = await replica.offer(theirs);
    expect(result.decision).toBe("adopt");
    expect(result.discarded).toEqual([mine.transitions[1]]);
    expect(replica.raw()?.ledger).toEqual(theirs);
    // The shorter fork never comes back.
    expect((await replica.offer(mine)).decision).toBe("keep");
  });

  it("keeps sticky revocations from a losing candidate and from the winner; trusted() excludes them", async () => {
    const a = await account();
    const withBridges = await addBridge(a, await addBridge(a, a.ledger, "b1"), "b2");
    const losing = await extend(withBridges, a.passkey, { type: "revoke_bridge", bridgeId: "b1" });
    const winning = await addDevice(a, await addDevice(a, withBridges));
    const storage = counting(memoryReplicaStorage());
    const replica = new LedgerReplica(storage);
    await replica.load();
    await replica.offer(winning, BIND);
    expect((await replica.offer(losing)).decision).toBe("keep");
    expect(replica.sticky()?.bridgeIds).toEqual(["b1"]);
    expect(replica.raw()?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(["b1", "b2"]);
    expect(replica.trusted()?.bridges.map(item => item.bridgeId)).toEqual(["b2"]);
    expect(replica.trusted()?.revokedBridgeIds).toEqual(["b1"]);
    expect(storage.commits).toBe(2);

    const revoked = await extend(winning, a.passkey, { type: "revoke_bridge", bridgeId: "b2" });
    expect((await replica.offer(revoked)).decision).toBe("adopt");
    expect(replica.sticky()?.bridgeIds).toEqual(["b1", "b2"]);
    expect(replica.trusted()?.bridges).toEqual([]);

    // The sticky set survives a reload; a rejected candidate contributes nothing.
    const reloaded = new LedgerReplica(storage);
    await reloaded.load();
    expect(reloaded.trusted()?.revokedBridgeIds.slice().sort()).toEqual(["b1", "b2"]);
    expect(reloaded.trusted()?.bridges).toEqual([]);
    const other = await account();
    const foreign = await extend(await addBridge(other, other.ledger, "b9"), other.passkey, { type: "revoke_bridge", bridgeId: "b9" });
    expect((await reloaded.offer(foreign)).decision).toBe("reject");
    expect(reloaded.sticky()?.bridgeIds).toEqual(["b1", "b2"]);
  });

  it("extends from the RAW checkpoint: a chain-present but sticky-revoked bridge can still be revoked on chain", async () => {
    const a = await account();
    const withBridge = await addBridge(a, a.ledger, "b1");
    const losing = await extend(withBridge, a.passkey, { type: "revoke_bridge", bridgeId: "b1" });
    const winning = await addDevice(a, await addDevice(a, withBridge));
    const replica = new LedgerReplica(memoryReplicaStorage());
    await replica.load();
    await replica.offer(winning, BIND);
    await replica.offer(losing);
    expect(replica.trusted()?.bridges).toEqual([]);
    const resigned = await extend(winning, a.passkey, { type: "revoke_bridge", bridgeId: "b1" });
    expect((await replica.offer(resigned)).decision).toBe("adopt");
    expect(replica.raw()?.checkpoint.revokedBridgeIds).toEqual(["b1"]);
  });

  it("throws ledger_replica_corrupt on a corrupted record and never resets it", async () => {
    const a = await account();
    const chain = await addDevice(a, a.ledger);
    const source = memoryReplicaStorage();
    const replica = new LedgerReplica(source);
    await replica.load();
    await replica.offer(chain, BIND);
    const good = (await source.read(a.accountId)) as ReplicaRecord;
    const variants: unknown[] = [
      null,
      { ...good, version: 2 },
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
    expect((await tabA.offer(two)).decision).toBe("keep");
    expect(tabA.raw()?.checkpoint.revision).toBe(3);
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
    const losing = await extend(withBridge, a.passkey, { type: "revoke_bridge", bridgeId: "b1" });
    const winning = await addDevice(a, await addDevice(a, withBridge));
    const storage = memoryReplicaStorage();
    const replica = new LedgerReplica(storage);
    await replica.load();
    await replica.offer(winning, BIND);
    await replica.offer(losing);
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
