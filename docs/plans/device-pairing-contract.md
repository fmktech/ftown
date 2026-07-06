# Device Pairing (bridge onboarding) — Contract (FROZEN)

Replaces copy-paste bearer-token onboarding with an OAuth-device-authorization-style
flow: the bridge gets a short **user code**, the logged-in user **approves the named
device** in the browser, and the bridge polls for its tokens. No long-lived bearer
secret is ever copy-pasted. Also adds an **approved-devices list with revoke** (the
per-device kill capability from the #26 follow-up).

Builds on F1/F3 (auth-hardening, already deployed): `/api/auth/bridge` requires aud
`ftown:bridge-bootstrap`; per-bridge refresh rotation lives in `bridge_refresh`.

## Flow (happy path)

1. Bridge starts with NO `--token` and NO stored refresh token → enters pairing.
   POST `/api/auth/bridge/pair/start` `{ bridgeId, hostname, platform }` (UNauth).
   ← `{ deviceCode, userCode, verificationUri, intervalMs, expiresInMs }`.
2. Bridge prints: `Approve this machine at <verificationUri> — code <userCode>` and
   polls POST `/api/auth/bridge/pair/poll` `{ deviceCode }` every `intervalMs`.
3. User (logged in) opens `verificationUri` (`/pair`, optionally `?code=USERCODE`),
   sees the requesting device (hostname/platform/bridgeId), clicks **Approve**.
   POST `/api/auth/bridge/pair/approve` `{ userCode }` (SESSION-gated) binds the
   request to `session.user.email` and mints the bridge tokens.
4. Bridge's next poll returns `{ token, refreshToken, centrifugoUrl, userId }`
   (same shapes `/api/auth/bridge` returns today). Bridge stores the refresh token
   (`~/.ftown/data/refresh-token`, 0600) and connects. deviceCode is now consumed.

## Rules

P1. Codes: `deviceCode` = 32-byte base64url (high-entropy secret, the poll credential).
    `userCode` = 8 chars from an unambiguous alphabet (Crockford base32 minus I/L/O/U),
    formatted `XXXX-XXXX`, UNIQUE among pending requests. Pairing request TTL =
    `PAIR_REQUEST_TTL_MS` (600_000). Poll `intervalMs` = 5_000.
P2. `/pair/start` and `/pair/poll` are UNauthenticated (the bridge has no session) but
    rate-limited (reuse the scope-keyed limiter: scope `pair-start` keyed by IP,
    scope `pair-poll` keyed by deviceCode). `/pair/approve` and `/pair/lookup` and the
    devices/revoke routes are SESSION-gated (`auth()`), 401 otherwise.
P3. `/pair/poll` responses (200 body, never leak other requests): `{status:"pending"}`
    while unapproved; `{status:"expired"}` past TTL; `{status:"denied"}` if denied;
    `{status:"approved", token, refreshToken, centrifugoUrl, userId}` exactly once —
    on first approved poll the tokens are returned and the row marked consumed;
    subsequent polls with the same deviceCode return `{status:"consumed"}`. Unknown
    deviceCode → `{status:"unknown"}`. Slow-down protection: polling faster than
    `intervalMs` may return `{status:"slow_down"}` (advisory; bridge respects intervalMs).
P4. Approval binds `sub = session.user.email`, mints a connect token (aud
    `ftown:centrifugo`, 24h) + refresh token (aud `ftown:bridge-refresh`, 30d, with a
    `jti`), and upserts `bridge_refresh(bridge_id, sub, current_jti, hostname,
    last_seen)` for the request's bridgeId — identical token semantics to the current
    `/api/auth/bridge`. A user may only approve/deny requests; a request is bound to
    the FIRST approver and cannot be re-bound.
P5. `/pair/lookup` `{ userCode }` (session-gated) → `{ bridgeId, hostname, platform,
    createdAt }` for the pending request, so the approve page can show what it's
    approving. Unknown/expired → 404.
P6. Devices list: GET `/api/bridges/devices` (session-gated) → the caller's
    `bridge_refresh` rows: `{ bridgeId, hostname, lastSeen, revoked }[]`. Revoke: POST
    `/api/bridges/devices/revoke` `{ bridgeId }` (session-gated, owner-scoped) sets
    `current_jti` to a tombstone sentinel `"revoked"` → the bridge's next refresh gets
    401 and exits (F3 already 401s on jti mismatch; `"revoked"` never matches a real
    jti). Bridge-side already persists+resumes the rotated refresh token, so revoke
    kills it within one refresh cycle.
P7. Bridge onboarding precedence (bridge/src/index.ts): stored refresh token → else
    `--token` (exchange at `/api/auth/bridge`, still supported for CI/scripts) → else
    interactive pairing (this flow). Pairing only runs on a TTY-less-safe path: it
    prints the code+URL to stdout and polls; on `expired`/`denied` it exits non-zero
    with a clear message. `hostname` = `os.hostname()`, `platform` = `process.platform`.
P8. No secret is logged (deviceCode, tokens, refresh). userCode MAY be printed (it is
    low-value and single-use, useless without the deviceCode the bridge holds).

## DB (migration 0002_device_pairing.sql, idempotent, tracked by migrate.mjs)

```
CREATE TABLE IF NOT EXISTS pairing_requests (
  device_code   text PRIMARY KEY,          -- high-entropy secret (poll credential)
  user_code     text NOT NULL UNIQUE,      -- human code, XXXX-XXXX
  bridge_id     text NOT NULL,
  hostname      text,
  platform      text,
  status        text NOT NULL DEFAULT 'pending', -- pending|approved|denied|consumed
  sub           text,                       -- set on approve
  refresh_jti   text,                       -- set on approve
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  approved_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pairing_user_code ON pairing_requests(user_code);
ALTER TABLE bridge_refresh ADD COLUMN IF NOT EXISTS hostname  text;
ALTER TABLE bridge_refresh ADD COLUMN IF NOT EXISTS last_seen timestamptz;
```
(Also mirror into ui/schema.sql for fresh installs and e2e/scripts/setup-db.mjs.)

## Route response types (frozen; shared shape, duplicated per file — no shared pkg)

- POST /api/auth/bridge/pair/start → `{ deviceCode:string; userCode:string;
  verificationUri:string; intervalMs:number; expiresInMs:number }`
- POST /api/auth/bridge/pair/poll → `{ status:'pending'|'approved'|'denied'|'expired'|
  'consumed'|'unknown'|'slow_down' } & (status==='approved' ? { token:string;
  refreshToken:string; centrifugoUrl:string; userId:string } : {})`
- POST /api/auth/bridge/pair/approve → `{ ok:true }` | 4xx `{ error }`
- POST /api/auth/bridge/pair/deny → `{ ok:true }`
- POST /api/auth/bridge/pair/lookup → `{ bridgeId; hostname; platform; createdAt }` | 404
- GET  /api/bridges/devices → `{ devices: { bridgeId; hostname; lastSeen:string|null;
  revoked:boolean }[] }`
- POST /api/bridges/devices/revoke → `{ ok:true }` | 4xx `{ error }`

## Task DAG (all depend ONLY on this frozen contract)

- T1 migration: ui/migrations/0002_device_pairing.sql + ui/schema.sql + e2e/scripts/setup-db.mjs
- T2 lib: ui/src/lib/pairing.ts (code generation: genDeviceCode, genUserCode, format;
  a pairing DB helper module ui/src/lib/pairing-store.ts with create/getByDevice/
  getByUserCode/approve/deny/consume/expire — the ONLY module that touches
  pairing_requests; typed) — the shared root all routes import.
- T3 route pair/start ; T4 pair/poll ; T5 pair/approve + pair/deny ; T6 pair/lookup
  (each its own file, all import T2's store)
- T7 devices routes: /api/bridges/devices + /revoke (import a small bridge_refresh
  helper — extend ui/src/lib/bridge-refresh.ts)
- T8 /pair UI page: ui/src/app/pair/page.tsx (+ a client component): code input
  (prefilled from ?code=), calls lookup → shows device → Approve/Deny buttons.
- T9 devices UI panel: a "Bridges" section listing devices with Revoke (mount in
  Dashboard settings/menu — coordinate file ownership: its own component file).
- T10 bridge pairing flow: bridge/src/index.ts onboarding precedence + poll loop +
  bridge/src/pairing-client.ts (the poll/print logic, injectable fetch for tests).
- T11 route tests (node/vitest as appropriate) ; T12 bridge pairing-client tests ;
  T13 e2e pairing scenario.
- Reviews: one per landed diff (routes as a group by a security reviewer; bridge flow;
  UI).

Gates: ui `npx tsc --noEmit` + `npx vitest run`; bridge `npm run build` + `npm test`
(+ bridge version bump for any bridge/** change); migration validated idempotent via
migrate.mjs against throwaway postgres; e2e green.
