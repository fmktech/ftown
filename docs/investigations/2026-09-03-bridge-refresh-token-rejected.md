---
type: investigation
symptom: "The bridge repeatedly fails Centrifugo token refresh with HTTP 401: Refresh token has been rotated or revoked"
slug: bridge-refresh-token-rejected
date: 2026-09-03T08:28:06-03:00
investigator: Foad Kesheh
git_commit: c7f6c26
branch: fix/bridge-refresh-token-retry
repository: fmktech/ftown
status: resolved
hypotheses_formed: 4
hypotheses_rejected: 3
hypotheses_proven: 1
related: []
---

# Bridge refresh token is repeatedly rejected

## Symptom

- **Observed**:
  ```text
  [Bridge] Refreshing Centrifugo token...
  [Centrifugo] Error: {
    code: 5,
    message: 'Error: Token refresh failed (401): {"error":"Refresh token has been rotated or revoked"}'
  }
  ```
  The pair repeats.
- **Expected**: The bridge exchanges its current refresh token for a new Centrifugo connection token and the next rotating refresh token.
- **Delta**: The server accepts the JWT structurally but rejects its `jti` as non-current; the client then retries that permanently rejected credential.

## Reproduction

The supplied trace is the observed production reproduction. The deterministic protocol-level reproduction implied by the route is:

1. Bootstrap a bridge to establish refresh token `R1` and `current_jti = J1`.
2. Submit `R1` once. The atomic update replaces `J1` with `J2`, and the response returns token `R2` containing `J2`.
3. Submit `R1` again, or revoke/re-bootstrap the bridge before submitting it. The update predicate `current_jti = J1` affects zero rows.
4. The route returns the exact reported 401 at `ui/src/app/api/auth/bridge/refresh/route.ts:95-99`.
5. During a connection attempt, centrifuge-js converts the ordinary thrown `Error` into client error code 5 and schedules another reconnect at `bridge/node_modules/centrifuge/build/index.js:4560-4580`.

Verified 2026-09-03 from the exact mutually exclusive route branches and the supplied repeated trace. A live replay was not performed because it would rotate or invalidate the user's real credential.

The failure was additionally reproduced without external state using
`bridge/src/bridge-auth.test.ts`, which stubs the refresh endpoint to return the
reported 401 and asserts that the bridge classifies it as permanent:

```text
✖ classifies a rejected rotating credential as permanent authorization failure
AssertionError [ERR_ASSERTION]: 401 must be terminal so centrifuge-js does not retry the stale token forever
ℹ tests 2
ℹ pass 1
ℹ fail 1
```

Command: `cd bridge && node --import tsx --test src/bridge-auth.test.ts`.
The user's follow-up that restarting the bridge restored service is also
consistent with this state split: startup reloads the persisted token and, if
that is rejected, enters the bootstrap/pairing fallback
(`bridge/src/index.ts:400-415`), while the live refresh callback does neither.

## Hypotheses

#### H1: The bridge is submitting a structurally valid refresh JWT whose `jti` is no longer the current `bridge_refresh.current_jti` for that bridge and subject.

- **Layer**: state-data
- **Prediction**: JWT verification, token-type, bridge-ID, and `jti` presence checks all pass, but the conditional database update affects zero rows and produces the exact reported body.
- **Verification method**: Inspect the route's mutually exclusive error branches and the atomic rotation predicate.
- **Evidence**:
  ```text
  ui/src/app/api/auth/bridge/refresh/route.ts:55-83 validates the JWT, type, bridge ID, and jti with distinct error bodies.
  ui/src/app/api/auth/bridge/refresh/route.ts:94 calls rotateBridgeRefreshJti(...).
  ui/src/app/api/auth/bridge/refresh/route.ts:95-99 is the sole source of "Refresh token has been rotated or revoked".
  ui/src/lib/bridge-refresh.ts:70-77 updates only WHERE bridge_id, sub, and current_jti all match, and returns false when no row matches.
  Regression test before the fix: 1 failed, 1 passed; the 401 was not an UnauthorizedError.
  ```
- **Verdict**: PROVEN
- **Rationale**: The exact response body can only be reached after all token-shape checks pass and the current-JTI compare-and-swap returns false.

#### H2: The JWT expired or the server's signing secret changed.

- **Layer**: config-env
- **Prediction**: `jwt.verify` fails and the response body says `Invalid or expired refresh token`.
- **Verification method**: Inspect the verification catch branch and compare it byte-for-byte with the supplied response.
- **Evidence**:
  ```text
  ui/src/app/api/auth/bridge/refresh/route.ts:55-62 returns {"error":"Invalid or expired refresh token"}.
  Reported: {"error":"Refresh token has been rotated or revoked"}.
  ```
- **Verdict**: REJECTED
- **Rationale**: The reported message is downstream of successful signature, audience, and expiry verification.

#### H3: The bridge sent the wrong bridge ID or a malformed refresh request.

- **Layer**: code-logic
- **Prediction**: The route returns `bridgeId mismatch` (401) or the required-fields error (400), rather than the reported body.
- **Verification method**: Inspect request-validation branches and compare response bodies.
- **Evidence**:
  ```text
  ui/src/app/api/auth/bridge/refresh/route.ts:48-52 returns the required-fields 400.
  ui/src/app/api/auth/bridge/refresh/route.ts:72-76 returns {"error":"bridgeId mismatch"}.
  ```
- **Verdict**: REJECTED
- **Rationale**: Neither branch can emit the supplied error text.

#### H4: A transient Centrifugo/WebSocket failure generated the 401.

- **Layer**: dependency
- **Prediction**: The failure originates from the WebSocket transport and does not contain the bridge refresh HTTP route's exact application error body.
- **Verification method**: Trace the bridge callback and SDK error mapping.
- **Evidence**:
  ```text
  bridge/src/bridge-auth.ts:58 posts to /api/auth/bridge/refresh.
  bridge/src/bridge-auth.ts:70-72 embeds that HTTP response status/body in a normal Error.
  bridge/node_modules/centrifuge/build/index.js:4568-4573 maps that callback error to clientConnectToken code 5.
  ```
- **Verdict**: REJECTED
- **Rationale**: Code 5 is the wrapper around the failed application token callback; it is not a server WebSocket error.

## 5 Whys

Symptom: The bridge logs the same refresh 401 repeatedly.

1. **Why?** Its `getToken` callback submits a refresh token whose `jti` does not match the server's current row.
2. **Why?** Refresh tokens are single-current-value credentials: a successful use, explicit revoke, same-owner re-bootstrap/re-pair, missing row, or another process using the same bridge identity changes/removes the accepted state.
3. **Why does this bridge keep the old value?** Before the fix, the in-memory and persisted token were replaced only after a successful response (former `bridge/src/index.ts:435-439`); once the server rejected the token, the live path did not reload the persisted state.
4. **Why does it keep retrying?** Before the fix, every non-2xx response, including 401, became an ordinary `Error` (former `bridge/src/bridge-auth.ts:70-72`).
5. **Why is that significant?** centrifuge-js treats ordinary token callback errors as transient and schedules reconnect forever; only `UnauthorizedError` is terminal (`bridge/node_modules/centrifuge/build/index.js:4560-4580`). The bridge authentication state machine does not distinguish permanent credential rejection from transient refresh failure during a live connection.

## Falsification

- **Check performed**: Adjacent-cause search across every preceding 400/401 branch.
- **Result**: Expiry/secret mismatch, wrong type, bridge-ID mismatch, missing `jti`, and malformed advert each produce a different response. Only a false current-JTI compare-and-swap produces the supplied response text.
- **Conclusion**: H1 survives. The trace proves stale/revoked/superseded server state, but does not distinguish which state-changing event caused it; that would require server audit history or the current database row.

## Root Cause

- **Immediate cause**: The presented refresh JWT is valid but its `jti` is not the one currently stored for `(bridge_id, sub)`; therefore the atomic rotation affects zero rows and the route returns the reported 401 (`ui/src/lib/bridge-refresh.ts:69-77`, `ui/src/app/api/auth/bridge/refresh/route.ts:91-99`).
- **Repeated-log cause**: Before the fix, the bridge threw a generic `Error` for this permanent 401, and centrifuge-js code 5 retried generic connection-token errors (former `bridge/src/bridge-auth.ts:70-72`, `bridge/node_modules/centrifuge/build/index.js:4560-4580`).
- **Architectural root**: A single-use rotating credential is shared through persisted/in-memory state without a terminal rejection/re-onboarding state or audit reason that identifies who superseded it.
- **Rejected H2**: Expiry/secret mismatch has a different response body.
- **Rejected H3**: Malformed/wrong bridge identity has a different response body/status.
- **Rejected H4**: The WebSocket client merely wraps the HTTP callback failure as code 5.

## Fix

Changes planned before source editing and subsequently applied:

- `bridge/src/bridge-auth.ts`: classify HTTP 401 as centrifuge-js's terminal
  `UnauthorizedError`; retain ordinary `Error` for transient 5xx responses.
- `bridge/src/index.ts`: when a live refresh is rejected, reload the persisted
  token once and retry it if it differs from the stale in-memory value. This
  reproduces the successful part of restart recovery without requiring a
  restart. If no newer persisted token exists, allow `UnauthorizedError` to stop
  the retry loop instead of hammering the endpoint forever.
- Regression coverage: preserve the failing 401-classification test and add
  focused tests for recovery from a newer persisted rotating token and
  single-flight serialization of concurrent refresh requests.

## Resolution

- `bridge/src/bridge-auth.ts:71-80` now maps HTTP 401 to
  `UnauthorizedError`, the terminal error contract expected by centrifuge-js;
  5xx responses remain ordinary retryable errors.
- `bridge/src/rotating-token-refresher.ts` now owns token rotation, shares one
  in-flight exchange across concurrent callers, and retries once from a newer
  persisted token after a stale in-memory token is rejected.
- `bridge/src/index.ts:418-458` wires the refresher to the existing token file.
  A truly revoked token with no newer disk state stops instead of looping; a
  newer disk token recovers without restarting.
- Regression tests:
  - `bridge/src/bridge-auth.test.ts`
  - `bridge/src/rotating-token-refresher.test.ts`
- Before the fix, the focused test suite reported `pass 1, fail 1`, with the
  permanent-authorization classification assertion failing.
- After the fix, the focused suite reports `tests 5, pass 5, fail 0`.
- Full bridge suite reports `tests 742, pass 742, fail 0`.
- `npm run build` completes successfully (`tsc`, exit 0).
- `git diff --check` reports no whitespace errors.
