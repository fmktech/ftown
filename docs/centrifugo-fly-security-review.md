# Security review — Centrifugo Fly rollout

## Threat model

The public boundary is the Fly TLS endpoint forwarding WebSocket traffic to
Centrifugo. It handles signed connection tokens and live terminal/session
messages; the signing secret enters only through Fly's secret store. Anonymous
internet clients may reach the listener, while authenticated browser and bridge
clients cross into user-scoped channels. Relevant attacker goals are stealing a
signing secret, reaching admin/API/health surfaces, exhausting the broker, or
crossing from one authenticated account into another account's live state.

## Findings

1. **Medium — concurrent requests can exceed the login/registration limit** —
   `ui/src/lib/login-rate-limit.ts:38`

   - Attack: an anonymous internet client sends a burst of parallel login
     attempts for one account; separate read/check/write queries observe the
     same counter and overwrite increments, allowing more password guesses than
     the intended ten-per-hour limit.
   - Severity: internet reachable, but impact is limited to weakening a brute
     force control rather than bypassing authentication directly.
   - Remediation: replace the split check and record operations with one atomic
     PostgreSQL upsert/conditional increment that returns the allow/deny result.

2. **Medium — an additional authenticated account can spoof another user's UI
   session state** — `centrifugo/config.fly.json:35`,
   `ui/src/hooks/useSessions.ts:122`

   - Attack: a user with a valid Centrifugo token publishes a fabricated
     `session_update` to `sessions:updates#<victim-email>`; client publication
     is allowed and the victim UI applies the payload without checking
     `ctx.info.user`, allowing fake, changed, or removed dashboard rows.
   - Severity: authenticated cross-account integrity/availability impact. The
     bridge separately rejects foreign terminal-input and command publishers,
     so this path does not establish command execution.
   - Remediation: require `ctx.info?.user === userId` in every browser-side
     publication consumer and cover foreign-publisher rejection with tests;
     for true multi-tenancy, issue publish-scoped subscription tokens or proxy
     publication through an authorizing server.

Production registration is now fail-closed by default, which removes the easy
path to creating a second account for the intended single-user deployment. The
second finding remains relevant if an untrusted account already exists or if an
operator explicitly re-enables registration.

## Hardening suggestions (not confirmed vulnerabilities)

- Keep Centrifugo at one Fly Machine while it uses the memory engine. Scaling
  horizontally without Redis would split presence/history and reconnect state.
- After the rollback window, delete the legacy AWS API/admin/SSH secrets and
  disable its deployment workflow instead of retaining dormant credentials.

## Least-privilege review

- GitHub Actions has `contents: read` only and deploys only after an explicit
  checked manual input.
- `FLY_API_TOKEN` is documented as a short-lived app-scoped deploy token, not an
  organization token.
- The runtime receives only `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY`; Fly has no need
  for an API key, admin password, admin secret, volume, database, or AWS access.
- The container runs as the upstream non-root `centrifugo` user.

## Absence checklist

| # | Item | Verdict | Note |
| --- | --- | --- | --- |
| 1 | Authentication | checked-clean | Anonymous connect and anonymous connection tokens are disabled; signed tokens retain the existing audience. |
| 2 | Function authorization | checked-clean | Admin and HTTP API are disabled; only the WebSocket route is intended public functionality. |
| 3 | Object authorization / IDOR | Finding 2 | User-limited subscriptions prevent foreign reads, but client publication still needs consumer-side publisher checks for multi-user use. |
| 4 | Input validation | checked-clean | Message size, connection, channel, queue, origin, and token constraints are explicit and CI asserted. |
| 5 | Injection | n.a. | The Fly package adds no request-built SQL, shell input, templates, or filesystem paths. Workflow values are constants or trusted repository configuration. |
| 6 | Output encoding / XSS | n.a. | No HTML rendering is introduced. Finding 2 affects structured UI state, not an unescaped HTML sink. |
| 7 | Secrets | checked-clean | No runtime secret or placeholder is in the image/config; CI scans required key absence and secrets come from Fly/GitHub. |
| 8 | Unsafe deserialization | checked-clean | JSON config and fixed WebSocket smoke-test responses do not instantiate arbitrary types or use eval-like behavior. |
| 9 | SSRF | n.a. | No user-controlled server-side fetch is introduced. |
| 10 | File uploads | n.a. | No upload surface exists in this change. |
| 11 | Rate limiting / abuse | Finding 1 | Broker limits are hardened; the existing application limiter is not atomic. |
| 12 | Error handling / info leak | checked-clean | Public auxiliary paths return 404; registration-disabled response is generic; secret values are never printed. |
| 13 | CORS / origin | checked-clean | Exact production origin allowlist; smoke test proves allowed origin 101 and unrelated origin 403. |
| 14 | Security headers / CSRF | n.a. | Fly terminates TLS for a token-authenticated WebSocket endpoint; no cookie-authenticated Fly HTTP mutation is exposed. |
| 15 | Dependency risk | checked-clean | No package is added; Centrifugo and both GitHub actions are pinned to immutable digests/commit SHAs. |

## Open risks / rollout verification

- The Fly app, runtime secret, certificate state, DNS records, and production
  account count cannot be proven from the repository. Verify them against the
  go/no-go checklist before DNS cutover.
- The AWS broker intentionally keeps its legacy admin/API configuration only
  during the rollback window. It must remain network-restricted and be removed
  after the Fly soak period.
