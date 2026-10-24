import { generateEndpoint, exportPublicKey, importPublicKey, SecurityError } from "@security/crypto";
import type { ApprovedBridge, BridgeInvitation, EndpointIdentity, EndpointPublic } from "@security/protocol";

const DATABASE = "ftown-endpoint-security";
const VERSION = 1;
interface PinRecord { key: string; ownerId: string; bridge: ApprovedBridge }

function requireStorage(): void {
  if (!globalThis.crypto?.subtle || (typeof window !== "undefined" && !window.isSecureContext)) {
    throw new SecurityError("secure_context_required", "Use HTTPS or trustworthy localhost for encrypted controls");
  }
  if (!globalThis.indexedDB) throw new SecurityError("storage_unavailable", "Browser key storage is unavailable");
}
async function database(): Promise<IDBDatabase> {
  requireStorage();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("identities")) request.result.createObjectStore("identities", { keyPath: "endpoint.ownerId" });
      if (!request.result.objectStoreNames.contains("pins")) request.result.createObjectStore("pins", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new SecurityError("storage_unavailable", "Browser key storage is unavailable"));
    request.onblocked = () => reject(new SecurityError("storage_unavailable", "Close older FTown tabs to open browser key storage"));
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); transaction.onerror = () => reject(transaction.error); });
}
async function validIdentity(identity: EndpointIdentity, ownerId: string): Promise<EndpointIdentity> {
  if (identity?.endpoint?.ownerId !== ownerId || identity.endpoint.kind !== "browser" || !identity.keyPair?.privateKey
    || identity.keyPair.privateKey.extractable || identity.keyPair.privateKey.type !== "private"
    || identity.keyPair.privateKey.algorithm.name !== "ECDH" || !identity.keyPair.privateKey.usages.includes("deriveBits")
    || await exportPublicKey(identity.keyPair.publicKey) !== identity.endpoint.publicKey) {
    throw new SecurityError("key_unavailable", "Stored browser identity is invalid; recover with a fresh invitation");
  }
  await validatePublicEndpoint(identity.endpoint);
  return identity;
}
/** Atomic add-and-reload-winner keeps independently opened tabs on one identity. */
export async function loadBrowserIdentity(ownerId: string): Promise<EndpointIdentity> {
  const db = await database();
  try {
    const existing = await result(db.transaction("identities").objectStore("identities").get(ownerId)) as EndpointIdentity | undefined;
    if (existing) return validIdentity(existing, ownerId);
    const identity = await generateEndpoint(ownerId, "browser", false);
    const transaction = db.transaction("identities", "readwrite");
    const done = completed(transaction);
    transaction.objectStore("identities").add(identity);
    try { await done; return identity; }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== "ConstraintError") throw error;
      const winner = await result(db.transaction("identities").objectStore("identities").get(ownerId)) as EndpointIdentity | undefined;
      if (!winner) throw error;
      return validIdentity(winner, ownerId);
    }
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw new SecurityError("storage_unavailable", "Browser encryption identity could not be stored");
  } finally { db.close(); }
}

export async function readPinnedBridges(ownerId: string): Promise<ApprovedBridge[]> {
  const db = await database();
  try {
    const pins = await result(db.transaction("pins").objectStore("pins").getAll()) as PinRecord[];
    const owned = pins.filter(pin => pin.ownerId === ownerId).map(pin => pin.bridge);
    for (const pin of owned) {
      if (pin.endpoint.ownerId !== ownerId || pin.endpoint.kind !== "bridge") throw new SecurityError("key_unavailable", "Stored bridge trust is invalid");
      await validatePublicEndpoint(pin.endpoint);
    }
    return owned;
  } finally { db.close(); }
}

export async function pinApprovedBridge(ownerId: string, bridge: ApprovedBridge, replace = false): Promise<void> {
  if (bridge.endpoint.ownerId !== ownerId || bridge.endpoint.kind !== "bridge") throw new SecurityError("wrong_context", "Invitation belongs to another account");
  await validatePublicEndpoint(bridge.endpoint);
  const db = await database();
  try {
    const key = `${ownerId}:${bridge.bridgeId}`;
    const transaction = db.transaction("pins", "readwrite");
    const done = completed(transaction);
    const request = transaction.objectStore("pins").get(key);
    let changed = false;
    request.onsuccess = () => {
      const previous = request.result as PinRecord | undefined;
      if (previous && previous.bridge.endpoint.id !== bridge.endpoint.id && !replace) { changed = true; transaction.abort(); return; }
      transaction.objectStore("pins").put({ key, ownerId, bridge } satisfies PinRecord);
    };
    try { await done; } catch (error) { if (changed) throw new SecurityError("key_changed", "Verify the changed bridge key with a fresh invitation"); throw error; }
  } finally { db.close(); }
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export async function validatePublicEndpoint(value: unknown): Promise<EndpointPublic> {
  if (!object(value) || Object.keys(value).sort().join(",") !== "id,kind,ownerId,publicKey,version"
    || value.version !== 1 || typeof value.ownerId !== "string" || typeof value.id !== "string" || typeof value.publicKey !== "string"
    || !["bridge", "browser", "mcp", "local-cli"].includes(String(value.kind))) throw new SecurityError("invitation_invalid", "Invalid endpoint identity");
  const publicKey = await importPublicKey(value.publicKey);
  const raw = await crypto.subtle.exportKey("raw", publicKey);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const id = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  if (value.id !== id) throw new SecurityError("invitation_invalid", "Invalid endpoint fingerprint");
  return value as unknown as EndpointPublic;
}

export async function parseInvitation(value: unknown): Promise<BridgeInvitation> {
  if (!object(value) || Object.keys(value).sort().join(",") !== "bridge,bridgeId,expiresAt,invitationId,localOrigin,ownerId,relayUrl,secret,version"
    || value.version !== 1 || typeof value.invitationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.invitationId)
    || typeof value.ownerId !== "string" || typeof value.bridgeId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.bridgeId)
    || typeof value.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new SecurityError("invitation_invalid", "This invitation is invalid");
  }
  const expires = Date.parse(value.expiresAt);
  if (expires <= Date.now()) throw new SecurityError("invitation_expired", "This invitation expired; create a new one");
  if (expires > Date.now() + 330_000) throw new SecurityError("invitation_invalid", "This invitation has an invalid lifetime");
  const bridge = await validatePublicEndpoint(value.bridge);
  if (bridge.kind !== "bridge" || bridge.ownerId !== value.ownerId) throw new SecurityError("invitation_invalid", "Invitation identity does not match");
  for (const field of ["relayUrl", "localOrigin"] as const) {
    if (value[field] === null) continue;
    if (typeof value[field] !== "string") throw new SecurityError("invitation_invalid", "Invalid connection metadata");
    const url = new URL(value[field]);
    if (url.username || url.password || url.hash || url.search || (field === "relayUrl"
      ? url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      : url.origin !== value[field] || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new SecurityError("invitation_invalid", "Invalid connection metadata");
    }
  }
  return { version: 1, invitationId: value.invitationId, ownerId: value.ownerId, bridgeId: value.bridgeId, bridge,
    secret: value.secret, expiresAt: value.expiresAt, relayUrl: value.relayUrl as string | null, localOrigin: value.localOrigin as string | null };
}

/** Capture synchronously before any awaited crypto, auth, navigation or telemetry. */
export function captureInvitation(): unknown {
  const fragment = window.location.hash;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  if (!fragment || fragment.length > 16_384) throw new SecurityError("invitation_invalid", "Open a fresh bridge invitation");
  const params = new URLSearchParams(fragment.slice(1));
  if ([...params.keys()].some(key => key !== "invite") || params.getAll("invite").length !== 1) throw new SecurityError("invitation_invalid", "Open a fresh bridge invitation");
  try { return JSON.parse(params.get("invite")!); } catch { throw new SecurityError("invitation_invalid", "This invitation is invalid"); }
}
