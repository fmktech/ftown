import { CENTRIFUGO_API_KEY, CENTRIFUGO_API_URL } from "./config";

interface ChannelInfo {
  num_clients?: number;
}
interface ChannelsResult {
  result?: { channels?: Record<string, ChannelInfo> };
  error?: { message?: string; code?: number };
}

/**
 * Centrifugo server API `channels` method. Returns a map of every active channel
 * (>=1 subscriber) to its info. presence config is irrelevant for `channels`.
 */
export async function listChannels(
  pattern?: string,
): Promise<Record<string, ChannelInfo>> {
  const res = await fetch(CENTRIFUGO_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": CENTRIFUGO_API_KEY,
    },
    body: JSON.stringify({
      method: "channels",
      params: pattern ? { pattern } : {},
    }),
  });
  if (!res.ok) {
    throw new Error(`Centrifugo channels API failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as ChannelsResult;
  if (data.error) {
    throw new Error(`Centrifugo API error: ${JSON.stringify(data.error)}`);
  }
  return data.result?.channels ?? {};
}

/** All active channels named `terminal:<sessionId>#<email>` for this user. */
export async function terminalChannelsFor(email: string): Promise<string[]> {
  const channels = await listChannels();
  return Object.keys(channels).filter(
    (c) => c.startsWith("terminal:") && c.endsWith(`#${email}`),
  );
}

/**
 * Whether `terminal:<sessionId>#<email>` currently has any subscriber. On the
 * direct path neither the client (R3) nor the bridge (no watcher ⇒ no publish ⇒
 * no self-subscribe) subscribe, so the channel is ABSENT. On the fallback path
 * both do, so it is PRESENT. Scoped to one session to ignore stale channels.
 */
export async function terminalChannelPresent(
  sessionId: string,
  email: string,
): Promise<boolean> {
  const channels = await listChannels();
  const info = channels[`terminal:${sessionId}#${email}`];
  return !!info && (info.num_clients ?? 0) > 0;
}

/**
 * Active session ids for this user, derived from `terminal-input:<sid>#<email>`
 * channels — the bridge subscribes to one per session on create, regardless of
 * transport, so this is a transport-independent inventory of live sessions.
 */
export async function sessionIdsFor(email: string): Promise<Set<string>> {
  const channels = await listChannels();
  const ids = new Set<string>();
  const suffix = `#${email}`;
  for (const c of Object.keys(channels)) {
    if (c.startsWith("terminal-input:") && c.endsWith(suffix)) {
      ids.add(c.slice("terminal-input:".length, c.length - suffix.length));
    }
  }
  return ids;
}

/** Wait until a session id not present in `before` appears; return it. */
export async function waitForNewSessionId(
  email: string,
  before: Set<string>,
  { timeoutMs = 20_000, intervalMs = 300 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await sessionIdsFor(email);
    for (const id of now) if (!before.has(id)) return id;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timed out waiting for a new session id to appear");
}

/** Subscriber count on the control-plane channel commands:rpc#<email>. */
export async function commandsRpcClients(email: string): Promise<number> {
  const channels = await listChannels();
  return channels[`commands:rpc#${email}`]?.num_clients ?? 0;
}

interface PresenceResult {
  result?: { presence?: Record<string, unknown> };
  error?: { message?: string; code?: number };
}

/**
 * Number of bridge clients currently present on `bridges:presence#<email>` (0 if
 * none / bridge offline). Uses the Centrifugo server `presence` API — the same
 * signal start-services.sh polls to decide the bridge is online, so it is the
 * authoritative liveness probe for restart/resurrection tests.
 */
export async function bridgePresenceCount(email: string): Promise<number> {
  const res = await fetch(CENTRIFUGO_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": CENTRIFUGO_API_KEY,
    },
    body: JSON.stringify({
      method: "presence",
      params: { channel: `bridges:presence#${email}` },
    }),
  });
  if (!res.ok) {
    throw new Error(`Centrifugo presence API failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as PresenceResult;
  if (data.error) return 0;
  return Object.keys(data.result?.presence ?? {}).length;
}

/** Poll until `bridges:presence#<email>` has >= `min` clients, or throw on timeout. */
export async function waitForBridgePresence(
  email: string,
  { min = 1, timeoutMs = 40_000, intervalMs = 1000 }: { min?: number; timeoutMs?: number; intervalMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await bridgePresenceCount(email);
    if (n >= min) return n;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for bridge presence >= ${min} on bridges:presence#${email} (last=${n})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Poll until `predicate(state)` is true or timeout. Returns final state. */
export async function waitForChannels<T>(
  produce: () => Promise<T>,
  predicate: (state: T) => boolean,
  { timeoutMs = 8000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let state = await produce();
  while (!predicate(state) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    state = await produce();
  }
  return state;
}
