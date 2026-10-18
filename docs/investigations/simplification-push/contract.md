# Simplification and Web Push — frozen contract
Date: 2026-10-18. User authorized items 1–3 with one worker, item 4 with another, plus push for questions and idle once per agent. Shared checkout and exact ownership: ownership.json. Root owns all E2E/resources; workers may isolated unit/static checks. No production migration/configuration or merge is authorized by this implementation task.

## CLI/release
- Worker npx_implementation owns release tooling, shared installation inventory, dependency closure and sessions Commander parsing, plus Git landing after handoffs.
- Move release helpers outside bridge; a shared path classifier covers all shipped/build inputs. Tests/docs/tooling-only changes run relevant validation without requiring a new npm version or release. Include published skills/hooks/plugins and package/lock/build config. Keep dual package immutable gitHead protections, npm11/12 support and registry visibility wait.
- One manifest drives runtime directories, copied assets, aliases and required readiness paths. Install full compiled bridge and production dependency closure, including native payload and nested/scoped/hoisted resolution. No unrelated development packages, cache paths, runtime npm/downloads. Retain dependency metadata for installed repair.
- Preserve setup locking, downgrade guard, symlink rejection and read-only startup readiness. Fail clearly for incomplete runtime.
- Sessions parser uses Commander declarations and generated help. Preserve command forms, aliases, request/output behavior and legacy flags. Help/error validation cannot open transport. Record bounded debug proof and red/green regression for create --help before parser edit.
- Bump package and lock once at integration; preserve four unrelated dirty notes.

## Canonical startup
- canonical_start owns runStart(argv):Promise<number>, runBridge(argv,commandName='ftown-bridge'):Promise<number>, canonical dispatch and legacy index guard. runStart lazy-loads bridge after setup-readiness for ordinary startup. Help discovery does not start/authenticate/write. Fresh Commander instance and mapped exit codes; no parse/start on import.
- npm ftown start and installed ftown start work with the same options as ftown-bridge; compatibility retained.
- Root validates fresh/current/repair setup and startup after deleting original package/cache. Installer/start worker dependencies are frozen above.

## Push
- Real Web Push via existing hosted Next API + Neon + service worker; explicit user opt-in. No automatic permission prompt. Unsupported/local/no-config states explained; ordinary in-app attention remains.
- PushNotice: {kind:'question'|'idle';eventKey:string;title:string;message:string;occurredAt:string}.
- BridgePushNotifier options: {apiUrl:string;bridgeId:string;getToken:()=>string|Promise<string>;getSession:(id:string)=>Promise<{name:string;shellType?:string}|null|undefined>}. notify(sessionId,notice):void; stop():void.
- AttentionStore optional third constructor callback (sessionId,notice)=>void, after durable save and isolated from observer failure. New questions use durable UUID question:<id>. Idle uses literal idle scoped to owner+bridge+session, emitted only observed thinking/tool_use -> idle, never initial/snapshot idle. Raw shell sessions excluded.
- index.ts belongs canonical_start: nullable notifier for hosted mode only, cached initial auth token updated by existing refresh, store callback notifier?.notify, stop during shutdown. No new token rotation per notification.
- Queue max100, concurrency1, finite fetch timeout and transient retry budget <=5min; stop aborts/clears. Delivery across bridge process crash is best-effort. Root chose bounded queue over durable local outbox.
- GET /api/push session-auth returns {enabled,publicKey?}. POST/DELETE session-auth plus same-origin Origin; bounded validated subscription; user owns only own records. Missing configuration is unavailable before requesting browser permission.
- POST /api/push/events bearer bridge JWT verifies audience, signed sub/bridge identity and active matching bridge_refresh owner. Browser tokens/wrong owner/revoked bridge rejected; no caller-selected recipient.
- Three additive tables: subscriptions, immutable events keyed(owner,bridge,session,eventKey), per-event/subscription deliveries with atomic leases and sent states. Freeze recipients at first ingest and require subscription.created_at <= occurredAt; no backfill on later subscriptions. Durable dedup survives reconnect/restart. Successes do not resend; transient failures retry; expired404/410 removed.
- Bound request/payload/rate/queue work. Restrict outgoing subscription HTTPS endpoints to known browser push vendors, no credentials/custom ports/redirects/internal hosts. Do not log endpoint keys/tokens.
- SW push shows notification with full owner/bridge/session/event identity dedup (not eventKey alone), fixed same-origin session link; click focuses/opens appropriate session. Remove old native Dashboard notification effect to avoid duplicate channels.
- Add web-push and types only under exclusive ui dependency lease. Add migration0005 + schema/e2e fixture. Do not run migrations against production. Document VAPID env and deployment/migration steps, browser constraints, opt-out and best-effort limits.

## Gates and handoffs
- Peer architecture review completed: canonical_start reviewed runtime/install and notifier boundary; root reviewed auth/store, request scope and once-per-agent semantics.
- Each worker reports changed files, checks, unresolved findings and released leases in its unique handoff note; no independent Git operations except designated integration owner.
- After writers finish, independent review across another worker's changes, root focused real CLI and browser E2E, builds/unit gates; route fixes to existing owners. Root monitors automatic PR CI, no worker reruns.
- Commit/push/open PR by default after focused checks, no merge. Preserve source evidence, exact checks and retirement state. Finished native agents count as retired once no pending assignment/leases.
