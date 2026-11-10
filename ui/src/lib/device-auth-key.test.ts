import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearDeviceAuthKey, loadDeviceAuthKey } from "./device-auth-key";

type Row = Record<string, unknown>;
interface FakeStore { keyPath: string; rows: Map<unknown, unknown> }
interface FakeRequest { result: unknown; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null }
interface FakeTransaction {
  error: unknown; oncomplete: (() => void) | null; onabort: (() => void) | null; onerror: (() => void) | null;
  pending: number; objectStore: (name: string) => unknown;
}
type FakeFactory = IDBFactory & { databases: Map<string, Map<string, FakeStore>> };

/** Minimal in-memory IndexedDB (get/add/put/delete, completion, ConstraintError abort), in the style of browser-identity.test.ts. */
function createFakeIndexedDB(): FakeFactory {
  const databases = new Map<string, Map<string, FakeStore>>();

  function makeTransaction(stores: Map<string, FakeStore>): FakeTransaction {
    const tx: FakeTransaction = {
      error: null, oncomplete: null, onabort: null, onerror: null, pending: 0,
      objectStore: (name: string) => {
        const store = (): FakeStore => {
          const found = stores.get(name);
          if (!found) throw new Error("NotFoundError");
          return found;
        };
        const run = (op: () => unknown): FakeRequest => {
          const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
          tx.pending++;
          setTimeout(() => {
            try {
              request.result = op();
            } catch (error) {
              request.error = error;
              tx.error = error;
              request.onerror?.();
              tx.onabort?.();
              return;
            }
            request.onsuccess?.();
            tx.pending--;
            if (tx.pending === 0) setTimeout(() => tx.oncomplete?.(), 0);
          }, 0);
          return request;
        };
        return {
          get: (key: unknown) => run(() => store().rows.get(key)),
          add: (value: Row) => run(() => {
            const current = store();
            const key = value[current.keyPath];
            if (current.rows.has(key)) throw Object.assign(new Error("Key already exists"), { name: "ConstraintError" });
            current.rows.set(key, value);
            return key;
          }),
          put: (value: Row) => run(() => {
            const current = store();
            const key = value[current.keyPath];
            current.rows.set(key, value);
            return key;
          }),
          delete: (key: unknown) => run(() => { store().rows.delete(key); return undefined; }),
        };
      },
    };
    return tx;
  }

  function makeDatabase(stores: Map<string, FakeStore>): unknown {
    return {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: (name: string, options: { keyPath: string }) => {
        stores.set(name, { keyPath: options.keyPath, rows: new Map() });
      },
      transaction: () => makeTransaction(stores),
      close: () => undefined,
    };
  }

  const factory = {
    databases,
    open: (name: string) => {
      const request = {
        result: undefined as unknown, error: null as unknown,
        onsuccess: null as (() => void) | null, onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null, onupgradeneeded: null as (() => void) | null,
      };
      setTimeout(() => {
        const isNew = !databases.has(name);
        if (isNew) databases.set(name, new Map());
        request.result = makeDatabase(databases.get(name)!);
        if (isNew) request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  return factory as unknown as FakeFactory;
}

let fake: FakeFactory;

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  fake = createFakeIndexedDB();
  vi.stubGlobal("indexedDB", fake);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("returns the same device auth key across loads", async () => {
  const first = await loadDeviceAuthKey();
  const second = await loadDeviceAuthKey();
  expect(second.publicKey).toBe(first.publicKey);
  expect(second.privateKey).toBe(first.privateKey);
  expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
});

it("keeps the private key nonextractable", async () => {
  const { privateKey } = await loadDeviceAuthKey();
  expect(privateKey.extractable).toBe(false);
  expect(privateKey.usages).toEqual(["sign"]);
  await expect(webcrypto.subtle.exportKey("pkcs8", privateKey)).rejects.toThrow();
});

it("clear removes the stored key so the next load creates a new one", async () => {
  const first = await loadDeviceAuthKey();
  expect(fake.databases.get("ftown-device-auth")!.get("device-auth-v2")!.rows.size).toBe(1);
  await clearDeviceAuthKey();
  expect(fake.databases.get("ftown-device-auth")!.get("device-auth-v2")!.rows.size).toBe(0);
  const next = await loadDeviceAuthKey();
  expect(next.publicKey).not.toBe(first.publicKey);
});
