import { CENTRIFUGO_WS_URL } from "./config";

/**
 * Raw Centrifugo bidirectional client (JSON protocol) over the Node global
 * WebSocket — no `centrifuge` dependency, no `ws`. The security-critical probe:
 * given a connect token, attempt to subscribe to / publish on an ARBITRARY
 * channel and report exactly how Centrifugo responded.
 *
 * Centrifugo v5 wire protocol (bidirectional JSON): each command is a JSON
 * object `{ id, <method>: {...} }`; replies correlate by `id` and are either
 * `{ id, <method>: {...} }` on success or `{ id, error: { code, message } }` on
 * rejection. Frames may batch several newline-delimited objects; an empty object
 * `{}` from the server is a ping we answer with `{}`.
 *
 * Outcome model — a channel-authorization decision vs a connection failure are
 * DELIBERATELY distinct:
 *   - resolve { ok: true }                          → Centrifugo accepted it.
 *   - resolve { ok: false, error: { code, message }} → Centrifugo rejected the
 *       subscribe/publish itself (e.g. code 103 "permission denied" for a
 *       user-limited channel `ch#otherUser` whose owner ≠ the token's `sub`).
 *   - reject (throw)                                → the connection never
 *       established: transport error, timeout, or the CONNECT command itself was
 *       refused (bad/foreign/expired token). A rejected connect is a precondition
 *       failure, surfaced as a throw so tests never mistake it for a per-channel
 *       authz denial.
 */

/** A Centrifugo protocol-level error (subscribe/publish rejection). */
export interface CentrifugoError {
  code: number;
  message: string;
}

/** Outcome of an attempted subscribe/publish against a channel. */
export interface CentrifugoAttempt {
  ok: boolean;
  error?: CentrifugoError;
}

const CONNECT_TIMEOUT_MS = 10_000;
const OP_TIMEOUT_MS = 8_000;

interface Reply {
  id?: number;
  error?: CentrifugoError;
  connect?: unknown;
  subscribe?: unknown;
  publish?: unknown;
}

/**
 * One short-lived raw connection. Opens the socket, sends CONNECT, and exposes a
 * single command round-trip. Callers use `attemptSubscribe` / `attemptPublish`
 * rather than this class directly.
 */
class RawCentrifugoConnection {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, (reply: Reply) => void>();
  private buffer = "";

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(ev));
  }

  /** Open a socket and complete the CONNECT handshake, or throw. */
  static async open(token: string): Promise<RawCentrifugoConnection> {
    const ws = new WebSocket(CENTRIFUGO_WS_URL);
    const conn = new RawCentrifugoConnection(ws);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("centrifugo connect timeout")), CONNECT_TIMEOUT_MS);
      const fail = (err: Error): void => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closing */ }
        reject(err);
      };
      ws.addEventListener("error", () => fail(new Error("centrifugo websocket error")), { once: true });
      ws.addEventListener("close", (ev: CloseEvent) => fail(new Error(`centrifugo socket closed before connect (code ${ev.code})`)), { once: true });
      ws.addEventListener("open", () => {
        conn
          .send<{ connect: unknown }>("connect", { token, name: "e2e-raw" })
          .then(() => { clearTimeout(timer); resolve(); })
          .catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
      }, { once: true });
    });

    return conn;
  }

  /** Send one command and await its correlated reply; rejects on a reply `error`. */
  private send<T extends Reply>(method: "connect" | "subscribe" | "publish", params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`centrifugo ${method} timeout`));
      }, OP_TIMEOUT_MS);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        if (reply.error) {
          reject(new CentrifugoReplyError(reply.error));
          return;
        }
        resolve(reply as T);
      });
      try {
        this.ws.send(JSON.stringify({ id, [method]: params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Attempt a subscribe; a reply error resolves as { ok:false, error }. */
  async subscribe(channel: string): Promise<CentrifugoAttempt> {
    return this.attempt("subscribe", { channel });
  }

  /** Attempt a publish; a reply error resolves as { ok:false, error }. */
  async publish(channel: string, data: unknown): Promise<CentrifugoAttempt> {
    return this.attempt("publish", { channel, data });
  }

  private async attempt(method: "subscribe" | "publish", params: Record<string, unknown>): Promise<CentrifugoAttempt> {
    try {
      await this.send(method, params);
      return { ok: true };
    } catch (err) {
      if (err instanceof CentrifugoReplyError) {
        return { ok: false, error: err.centrifugoError };
      }
      throw err;
    }
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closing */ }
  }

  private onMessage(ev: MessageEvent): void {
    const text = typeof ev.data === "string" ? ev.data : String(ev.data);
    // Frames may batch newline-delimited JSON objects; accumulate partials.
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.dispatch(line);
    }
    // A single, un-terminated object (the common case) is a complete frame.
    if (this.buffer.trim().length > 0 && !this.buffer.includes("\n")) {
      const whole = this.buffer;
      this.buffer = "";
      this.dispatch(whole);
    }
  }

  private dispatch(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let reply: Reply;
    try {
      reply = JSON.parse(trimmed) as Reply;
    } catch {
      return;
    }
    // Server ping is an empty object; answer with an empty pong to stay alive.
    if (Object.keys(reply).length === 0) {
      try { this.ws.send("{}"); } catch { /* socket gone */ }
      return;
    }
    if (typeof reply.id === "number") {
      const resolver = this.pending.get(reply.id);
      if (resolver) {
        this.pending.delete(reply.id);
        resolver(reply);
      }
    }
    // Pushes (no id) are ignored — the probe only cares about command replies.
  }
}

class CentrifugoReplyError extends Error {
  readonly centrifugoError: CentrifugoError;
  constructor(error: CentrifugoError) {
    super(`centrifugo error ${error.code}: ${error.message}`);
    this.centrifugoError = error;
  }
}

/**
 * Open a raw connection with `token`, attempt to subscribe to `channel`, then
 * close. See the module docstring for the outcome model. Code 103 =
 * "permission denied" (e.g. user-limited-channel sub mismatch).
 */
export async function attemptSubscribe(token: string, channel: string): Promise<CentrifugoAttempt> {
  const conn = await RawCentrifugoConnection.open(token);
  try {
    return await conn.subscribe(channel);
  } finally {
    conn.close();
  }
}

/**
 * Open a raw connection with `token`, attempt to publish `data` to `channel`,
 * then close. See the module docstring for the outcome model. Code 103 =
 * "permission denied".
 */
export async function attemptPublish(token: string, channel: string, data: unknown): Promise<CentrifugoAttempt> {
  const conn = await RawCentrifugoConnection.open(token);
  try {
    return await conn.publish(channel, data);
  } finally {
    conn.close();
  }
}
