/**
 * Central config for the e2e suite. Values mirror the dev placeholders in
 * centrifugo/config.json (CI-local only — nothing sensitive). Overridable via env
 * so the same constants drive Playwright, the shell scripts, and the shim.
 */

/** MUST equal centrifugo/config.json `token_hmac_secret_key`. */
export const CENTRIFUGO_TOKEN_SECRET =
  process.env.CENTRIFUGO_TOKEN_SECRET ?? "your-centrifugo-token-secret-change-me";

/** MUST equal centrifugo/config.json `api_key`. */
export const CENTRIFUGO_API_KEY =
  process.env.CENTRIFUGO_API_KEY ?? "your-centrifugo-api-key-change-me";

export const CENTRIFUGO_API_URL =
  process.env.CENTRIFUGO_API_URL ?? "http://localhost:8000/api";

export const UI_BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3000";

export const TOKEN_AUDIENCE = "ftown:centrifugo";
