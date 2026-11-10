import { generateAuthKey } from "@security/ledger/proof";

const DATABASE = "ftown-device-auth";
const VERSION = 1;
const STORE = "device-auth-v2";
const RECORD_KEY = "device";

interface StoredDeviceAuthKey { key: string; publicKey: string; privateKey: CryptoKey }

function requireStorage(): void {
  if (!globalThis.crypto?.subtle || (typeof window !== "undefined" && !window.isSecureContext)) {
    throw new Error("secure_context_required");
  }
  if (!globalThis.indexedDB) throw new Error("storage_unavailable");
}

function openDatabase(): Promise<IDBDatabase> {
  requireStorage();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("storage_unavailable"));
    request.onblocked = () => reject(new Error("storage_unavailable"));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function validStored(value: StoredDeviceAuthKey): { publicKey: string; privateKey: CryptoKey } {
  const key = value.privateKey;
  if (typeof value.publicKey !== "string" || !key || key.extractable !== false || key.type !== "private"
    || key.algorithm.name !== "ECDSA" || !key.usages.includes("sign")) {
    throw new Error("device_auth_key_invalid");
  }
  return { publicKey: value.publicKey, privateKey: key };
}

/** One nonextractable device auth key per browser profile; concurrent tabs reload the atomic winner. */
export async function loadDeviceAuthKey(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const db = await openDatabase();
  try {
    const existing = await request<StoredDeviceAuthKey | undefined>(db.transaction(STORE).objectStore(STORE).get(RECORD_KEY));
    if (existing) return validStored(existing);
    const created = await generateAuthKey(false);
    const transaction = db.transaction(STORE, "readwrite");
    const done = completed(transaction);
    transaction.objectStore(STORE).add({ key: RECORD_KEY, publicKey: created.publicKey, privateKey: created.privateKey });
    try {
      await done;
      return created;
    } catch {
      const winner = await request<StoredDeviceAuthKey | undefined>(db.transaction(STORE).objectStore(STORE).get(RECORD_KEY));
      if (!winner) throw new Error("storage_unavailable");
      return validStored(winner);
    }
  } finally {
    db.close();
  }
}

export async function clearDeviceAuthKey(): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE, "readwrite");
    const done = completed(transaction);
    transaction.objectStore(STORE).delete(RECORD_KEY);
    await done;
  } finally {
    db.close();
  }
}
