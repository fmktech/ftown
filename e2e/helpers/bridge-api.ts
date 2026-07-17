import { request as httpRequest, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BRIDGE_HOME } from "./config";

/**
 * Direct access to the bridge's loopback HTTP API (127.0.0.1:<port>) for testing
 * its Host / Origin / bearer guards (LocalApiServer in bridge/src). Uses raw
 * node:http rather than fetch/undici because those forbid overriding the `Host`
 * header, which the 421 (Misdirected Request) guard test needs to spoof.
 *
 * The bridge advertises its loopback port + in-memory bearer token by writing
 * $HOME/.ftown/bridge.json on startup (index.ts). Under the e2e scratch HOME
 * (e2e/.bridge-home) that pointer is the discovery source for both.
 */

/** Shape the bridge writes to $HOME/.ftown/bridge.json. */
export interface BridgePointer {
  port: number;
  token: string;
  bridgeId: string;
  pid: number;
  startedAt: string;
  harness?: string;
  harnessCli?: string;
}

/**
 * Read the running bridge's self-advert pointer ($bridgeHome/.ftown/bridge.json).
 * Carries the loopback API `port` and bearer `token` (regenerated every bridge
 * start — never persisted, so always read it fresh). Throws if the file is
 * absent (bridge not running) or malformed.
 */
export function readBridgePointer(bridgeHome: string = BRIDGE_HOME): BridgePointer {
  const path = join(bridgeHome, ".ftown", "bridge.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`bridge pointer not found at ${path} (is the bridge running?)`);
  }
  const parsed = JSON.parse(raw) as Partial<BridgePointer>;
  if (typeof parsed.port !== "number" || typeof parsed.token !== "string") {
    throw new Error(`bridge pointer at ${path} is malformed: ${raw}`);
  }
  return parsed as BridgePointer;
}

export interface BridgeApiResult<T = unknown> {
  status: number;
  /** Parsed JSON body when the response is JSON; otherwise the raw text. */
  body: T;
}

export interface BridgeApiOptions {
  /** Override the `Origin` header. Omit to send none (the common legit case). */
  origin?: string;
  /**
   * Override the `Host` header (the request still connects to 127.0.0.1:<port>).
   * Use a non-loopback value to drive the 421 guard. Defaults to
   * `127.0.0.1:<port>`.
   */
  host?: string;
  /**
   * Bearer token. Omit (undefined) to use the pointer's token (legit call).
   * Pass `null` to send NO Authorization header (drives the 401 guard). Pass a
   * string to send an explicit (e.g. wrong) token.
   */
  bearer?: string | null;
  /** JSON request body; serialized and sent with Content-Type: application/json. */
  body?: unknown;
  /** Scratch HOME to read the pointer from. Defaults to e2e/.bridge-home. */
  bridgeHome?: string;
}

/**
 * Perform one request against the bridge loopback HTTP API and return its status
 * + parsed body. NEVER throws on a non-2xx status — the status IS the assertion
 * target (expect 421 for a spoofed Host, 403 for a non-localhost Origin, 401 for
 * a missing/wrong bearer, and 2xx/4xx business codes for legit calls).
 *
 * @param method HTTP method, e.g. "GET" | "POST" | "DELETE".
 * @param path   API path beginning with "/", e.g. "/api/sessions".
 */
export function bridgeApiFetch(
  method: string,
  path: string,
  options: BridgeApiOptions = {},
): Promise<BridgeApiResult> {
  const pointer = readBridgePointer(options.bridgeHome);
  const hostHeader = options.host ?? `127.0.0.1:${pointer.port}`;
  const bearer = options.bearer === undefined ? pointer.token : options.bearer;

  const headers: Record<string, string> = { Host: hostHeader };
  if (options.origin !== undefined) headers.Origin = options.origin;
  if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;

  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }

  return new Promise<BridgeApiResult>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: pointer.port, method, path, headers },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          const contentType = res.headers["content-type"] ?? "";
          let body: unknown = text;
          if (contentType.includes("application/json") && text) {
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
          }
          resolve({ status, body });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
