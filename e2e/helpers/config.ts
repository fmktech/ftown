/**
 * Central config for the e2e suite. CI-local only — nothing sensitive — but
 * realistic: getRequiredSecret rejects the shipped placeholder values, so e2e
 * must exercise a real-shaped secret. Overridable via env so the same constants
 * drive Playwright, the shell scripts, and the shim.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** MUST equal e2e/centrifugo.config.json `token_hmac_secret_key`. */
export const CENTRIFUGO_TOKEN_SECRET =
  process.env.CENTRIFUGO_TOKEN_SECRET ?? "e2e-centrifugo-token-secret-0123456789abcdef";

/** MUST equal e2e/centrifugo.config.json `api_key`. */
export const CENTRIFUGO_API_KEY =
  process.env.CENTRIFUGO_API_KEY ?? "e2e-centrifugo-api-key-0123456789abcdef";

export const CENTRIFUGO_API_URL =
  process.env.CENTRIFUGO_API_URL ?? "http://localhost:8000/api";

/**
 * Bidirectional Centrifugo client websocket endpoint (the `/connection/websocket`
 * rung the browser and the raw-client helper connect to). Mirrors env.sh's
 * NEXT_PUBLIC_CENTRIFUGO_URL; the e2e stack listens on :8000.
 */
export const CENTRIFUGO_WS_URL =
  process.env.CENTRIFUGO_WS_URL ??
  process.env.NEXT_PUBLIC_CENTRIFUGO_URL ??
  "ws://127.0.0.1:8000/connection/websocket";

export const UI_BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3000";

/** The e2e directory (this file lives in e2e/helpers/). */
export const E2E_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The bridge's scratch HOME. start-services.sh launches the bridge with HOME
 * overridden to e2e/.bridge-home so it never touches the real ~/.ftown; its
 * self-advert pointer, transcript dirs, data dir and refresh token all live
 * under here.
 */
export const BRIDGE_HOME = process.env.E2E_BRIDGE_HOME ?? join(E2E_DIR, ".bridge-home");

export const TOKEN_AUDIENCE = "ftown:centrifugo";
// F1: /api/auth/bridge now requires a distinct bootstrap audience.
export const BRIDGE_BOOTSTRAP_AUDIENCE = "ftown:bridge-bootstrap";
