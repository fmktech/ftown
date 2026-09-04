/**
 * Solo-mode client helpers — the browser side of the frozen wire shapes in
 * bridge/src/solo/contract.ts (SOLO_CONTRACT_REVISION 5).
 *
 * Solo auth carries NO cookies (contract S8): every authenticated call sends
 * `Authorization: Bearer <access-key>` against /api/solo/*. The raw key lives
 * ONLY in localStorage under SOLO_KEY_STORAGE — never in a cookie, never in a
 * URL after the initial #k= handshake fragment is consumed (see
 * captureKeyFromHash).
 */

/** localStorage slot holding the raw access key (this device only). */
export const SOLO_KEY_STORAGE = "ftown:soloKey";

/** GET /api/solo/bootstrap — everything the panel needs to connect. */
export interface SoloBootstrapResponse {
  /** Fixed solo subject (contract: SOLO_USER_ID). */
  userId: string;
  /** Absolute websocket URL of the proxied hub. */
  centrifugoUrl: string;
  /** Fresh hub JWT (same as POST /api/solo/token returns). */
  token: string;
}

/** POST /api/solo/token — a freshly minted hub JWT. */
export interface SoloTokenResponse {
  token: string;
  /** ISO timestamp — informational only; JWT exp remains source of truth. */
  expiresAt: string;
}

/** GET /healthz — UNAUTHENTICATED liveness of front children. */
export interface SoloHealthStatus {
  ok: true;
  hub: "up" | "down";
  panel: "up" | "down";
}

/** Thrown when /api/solo/* rejects the presented access key (HTTP 401). */
export class SoloAuthError extends Error {
  constructor(message = "Invalid ftown access key.") {
    super(message);
    this.name = "SoloAuthError";
  }
}

/**
 * Access keys are 32 random bytes, hex-encoded (contract ACCESS_KEY_BYTES):
 * exactly 64 lowercase-insensitive hex characters.
 */
const ACCESS_KEY_PATTERN = /^[0-9a-f]{64}$/i;

function isAccessKeyFormat(value: string): boolean {
  return ACCESS_KEY_PATTERN.test(value);
}

function browserWindow(): Window | null {
  return typeof window === "undefined" ? null : window;
}

/** Persists the raw key for this device. Callers validate before storing. */
export function storeKey(key: string): void {
  browserWindow()?.localStorage.setItem(SOLO_KEY_STORAGE, key);
}

/** The stored raw key, or null when this device has not connected yet. */
export function getStoredKey(): string | null {
  return browserWindow()?.localStorage.getItem(SOLO_KEY_STORAGE) ?? null;
}

/** Forgets the key on this device (sign-out, or a rejected cached key). */
export function clearKey(): void {
  browserWindow()?.localStorage.removeItem(SOLO_KEY_STORAGE);
}

/**
 * Consumes the one-time `#k=<hex>` fragment printed on the ftown-bridge --solo
 * banner: stores a well-formed key and scrubs the fragment from the address
 * bar via history.replaceState (no reload — the fragment never hits the
 * network, referrers, or history entries). Unrelated or malformed hashes are
 * left untouched. Returns the captured key, or null when no valid `#k=` was
 * present.
 */
export function captureKeyFromHash(): string | null {
  const win = browserWindow();
  if (!win) return null;
  const match = /^#k=(\S+)$/.exec(win.location.hash);
  if (!match || !isAccessKeyFormat(match[1])) return null;
  const key = match[1].toLowerCase();
  storeKey(key);
  win.history.replaceState(null, "", win.location.pathname + win.location.search);
  return key;
}

/**
 * GET /api/solo/bootstrap with the Bearer key. Resolves with the connection
 * payload; throws SoloAuthError on a rejected key (401) and surfaces network
 * failures verbatim so callers can fall back to the healthz starting screen
 * (children may still be booting, contract S12).
 */
export async function bootstrap(
  key: string,
  signal?: AbortSignal
): Promise<SoloBootstrapResponse> {
  const response = await fetch("/api/solo/bootstrap", {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
    signal,
  });
  if (response.status === 401) throw new SoloAuthError();
  if (!response.ok) throw new Error(`Solo bootstrap failed (${response.status}).`);
  return (await response.json()) as SoloBootstrapResponse;
}

/**
 * POST /api/solo/token — mints a fresh hub JWT for an established device.
 * Used as the tokenRefresher by useCentrifugo when the 12h JWT nears expiry
 * (HUB_JWT_TTL_SECONDS).
 */
export async function mintToken(
  key: string,
  signal?: AbortSignal
): Promise<SoloTokenResponse> {
  const response = await fetch("/api/solo/token", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
    signal,
  });
  if (response.status === 401) throw new SoloAuthError();
  if (!response.ok) throw new Error(`Solo token refresh failed (${response.status}).`);
  return (await response.json()) as SoloTokenResponse;
}

/**
 * GET /healthz — unauthenticated child liveness. Throws on non-OK responses;
 * network failures surface verbatim for the polling starting screen.
 */
export async function getHealth(signal?: AbortSignal): Promise<SoloHealthStatus> {
  const response = await fetch("/healthz", { method: "GET", cache: "no-store", signal });
  if (!response.ok) throw new Error(`healthz failed (${response.status}).`);
  return (await response.json()) as SoloHealthStatus;
}
