# Independent review — simplification and Web Push

Reviewer: `/root/canonical_start`, `gpt-6.1-sol` / `high`. Review scope is the other workers' release, installation, sessions-parser and notification files. Source read-only except the root-requested repair to the previously owned CLI smoke fixture; this report is reviewer-owned. Status: complete; all material findings closed. Root owns remaining integrated runtime/browser gates.

## Threat model

Push endpoints handle account identity, signed bridge credentials, browser subscription encryption keys and agent question text. Authenticated browsers manage their own subscriptions; internet callers can reach event ingest but require a valid signed bridge JWT and an active matching owner record. An attacker would seek cross-account subscription/delivery access, forged notifications, internal-network requests through subscription URLs, secret exposure or unbounded database/provider work. Boundaries are HTTP input → authentication/ownership, input → SQL, subscription URL → outbound HTTPS, and agent text → browser/OS notification. Explicit local setup additionally copies executable packages into the user's trusted runtime; review checks closure fidelity, cache independence and symlink confinement.

## Findings and closure

1. **Compatibility gap, closed:** `bridge/src/sessions-commands.ts:146` originally declared create options without legacy `--orchestrator`. Commander rejected a formerly accepted no-op flag. Owner restored its declaration; the stub-transport parity regression proves accepted input and an unchanged create payload. Four sessions tests independently passed.
2. **Production dependency placement, closed:** npm-shaped package root `/cache/node_modules/ftown` originally placed its local dependencies at unreachable `cli/node_modules/ftown/node_modules/*`. A flatten-only correction would also conflate root-local `a@1` with an outer-hoisted `b → a@2`. Owner replaced source-relative remapping with requester-aware placement. Independent tiny fixture now returns `node_modules/demo`; the three production-closure tests pass, including effective `require` checks for local Commander and both conflicting versions, native binary bytes/modes, optional/peer dependencies, dev exclusion, and source/destination symlink confinement.
3. **Medium privacy finding, closed:** `ui/public/sw.js` originally displayed accepted push payloads without checking an active account binding. Account A could enable push, log out or switch to B while an accepted message was in flight, exposing A's question text to B despite unsubscribe. Owner added IndexedDB account-hash binding, server-authenticated owner hash in payloads, same-origin acknowledged binding messages, and serialized binding/display work. Logout/disable clears binding and closes displayed notifications; switching clears mismatched binding even when the browser subscription is already absent. Storage failure suppresses display. Regression proves logout/account-switch suppression, concurrent identity dedup and fixed session navigation. Thirteen focused SW/component/event-route tests independently passed.
4. **Validation ordering, closed:** fanout `tell --parent` / `--children` / `--siblings` without a message originally fetched sessions before rejecting the missing message. Owner moved validation before target resolution; the regression tests all three fanout modes with a caller identity and proves zero transport requests. Five sessions tests independently passed after repair.
5. **Medium privacy concurrency finding, closed:** `ui/src/components/PushNotificationsControl.tsx` originally allowed a slow successful opt-in POST to rebind the worker/LocalStorage after logout cleared them. Owner added a shared generation fence invalidated synchronously at detach/unmount, POST cancellation, checks after registration/crypto and before worker postMessage/LocalStorage, and cleanup restricted to the stale operation's still-owned endpoint. Reviewed the exact source and deferred successful POST → detach → unmount regression. Six component tests independently passed after repair.

## Reviewed so far

- Release classifier includes shipped trees, runtime sources, package/lock/build configuration and npm's automatic README/license inputs. New unknown package inputs fail conservatively. Excludes tests, unshipped prose and external release tooling. Rename/deletion handling uses Git `--no-renames`.
- Relocated release helpers resolve `bridge/` from their own location. Existing immutable `gitHead`, dual-package parity, npm11/12 parsing, registry wait and tag checks remain intact.
- Push authentication requires HS256, `ftown:centrifugo`, signed `sub` and `info.bridgeId`, plus a matching non-revoked `bridge_refresh` row. Event body cannot select another recipient.
- Subscription writes require an authenticated browser plus exact same-origin `Origin`; all subscription mutations are owner scoped.
- Subscription outbound URLs require HTTPS and a small browser-vendor hostname allowlist, reject credentials/custom ports/fragments, and use raw HTTPS without redirect following. Request and provider time are bounded.
- Event identity includes owner, bridge, session and event key. First ingest atomically fixes recipients whose subscription existed by `occurredAt`; retries retain original payload and never append later subscribers. Idle's literal key intentionally gives once-per-agent lifetime semantics.
- Attention callbacks run after durable save and contain observer exceptions. Initial idle and snapshots do not trigger idle notices. Notifier queue/time/retry resources are bounded and `stop` clears/aborts them. Local/Solo exclusion is wired in the separately reviewed startup deliverable.
- Service-worker receipt claims are one IndexedDB readwrite transaction, including check and insert, so concurrent duplicate event IDs serialize atomically across worker connections. Notification tags and receipt IDs use the complete server event identity. Click handling constructs a fixed same-origin URL and validates its session ID.
- Server delivery claims exclude successful recipients, use bounded leases and complete only a matching lease token. Remaining-delivery count includes rows leased to another request, so retries receive a pending response rather than treating another in-flight claim as success.

## Security absence checklist (interim)

| Item | Verdict | Evidence / boundary |
| --- | --- | --- |
| Authentication | checked-clean | Browser session auth; signed audience/algorithm-specific bridge auth |
| Function authorization | checked-clean | Browser-only subscription operations; bridge-only event ingest |
| Object authorization / IDOR | checked-clean | Owner predicates on subscriptions/events; bridge-refresh ownership binds recipient |
| Input validation | checked-clean | Bounded JSON stream; validated IDs, kinds, keys, timestamps, lengths and endpoints |
| Injection / parameterized sinks | checked-clean | SQL uses positional bound parameters; outbound request avoids shell |
| Output encoding / XSS | checked-clean | React text rendering; OS notification strings; fixed same-origin click destination |
| Secrets | checked-clean | VAPID private key comes from server env; GET exposes only public key; generic API failures |
| Unsafe deserialization | checked-clean | JSON parsed and explicitly validated; no executable deserialization |
| SSRF | checked-clean | Known vendor HTTPS allowlist; no redirects, credentials or custom ports |
| File uploads | n.a. | No upload entrypoint introduced |
| Rate limits / abuse | checked-clean | Per-owner subscription slots/rate and bridge event rate; payload/fanout/time bounds |
| Error handling / information leaks | checked-clean | Generic API errors; account binding and async cancellation suppress logout/switch leakage |
| CORS | checked-clean | No permissive CORS added; cookie writes separately require exact Origin |
| Security headers / CSRF | checked-clean | Existing auth cookie boundary retained; state-changing cookie routes require Origin |
| Dependency risk | checked-clean | Locked official `web-push`3.6.7 / types3.6.4; legitimate upstream, bounded cryptographic use; no published upstream advisories |

The new dependency matches the [official Web Push library](https://github.com/web-push-libs/web-push); its [upstream security page](https://github.com/web-push-libs/web-push/security) listed no published advisories at review time. Reviewed resolved immediate versions include jws4.0.1, minimist1.2.8 and https-proxy-agent7.0.6. This is a scoped dependency review, not an exhaustive registry audit.

## Least privilege

- No new IAM grants, OAuth scopes or long-lived agent credentials. Existing signed bridge identity is narrowed by current owner/revocation lookup before notification use.
- Browser permission is explicit, subscriptions belong to one owner, and VAPID private material stays server-side. Raw shells, local and Solo exclude remote push.

## Pending review / verification limits

- No unresolved material source finding. Ordinary once-per-agent idle semantics, no-backlog recipient capture and best-effort in-memory queue match the frozen contract.
- Lease-pending/no-resend route regression now passes. The authored real database E2E replays a pre-subscription event after later opt-in and asserts zero deliveries, without contacting a provider; root still owns its execution.
- Independent reviewer checks passed: production closure3/3, final sessions5/5, release classifier3/3, SW/component/event-route13/13 before the final component race repair, and final component6/6 after that repair, plus a temporary placement fixture. No shared resources used.
- Root's initial CLI smoke exposed the reviewer's fixture asset list omitting newly required `bin`. Root authorized the bounded repair: smoke now imports `RUNTIME_DIRECTORIES` from the built installation manifest rather than duplicating its list. Syntax check passed; root owns re-execution.
- No runtime/E2E, browser, server, database, build/dependency or Git mutations executed by this reviewer. Root owns runtime verification.
