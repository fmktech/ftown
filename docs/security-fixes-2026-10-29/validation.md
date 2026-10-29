# Validation evidence

Task base 8244d6d, shared checkout /tmp/ftown-security-fixes. Root owns Git and all runtime/E2E. Existing dirty checkout remains untouched.

## In progress

- Independent contract review approved before implementations. Exact ownership overlaps mechanically rejected.
- UI worker: 52 focused tests; full UI 80 files/819 tests; TypeScript passed. Narrow helper correction: 39 tests passed; comment-only correction required no repeat.
- Root isolated Boat development sandbox bx_x24g7vg8: default4CPU/8GB, TTL7200s, no-env/no-snapshots; root sole owner. No suitable ftown reusable snapshot available (existing snapshots are another project).
- Verified fresh sandbox has no inherited deployment/database selectors; exact fixture DATABASE_URL postgresql://ftown:ftown@localhost/ftown and localhost service origins checked before Docker startup. Empty Docker inventory confirmed. No production/shared database used.
- Docker infrastructure healthy (Postgres16, Neon HTTPS shim, Centrifugo pinned6.10.2). Node24.22.1, browsers and system prerequisites installed. Generated certificates exist only in sandbox. Runtime tests await final source handoffs.
- Repository existing CI routes trusted jobs through Boat; this task preserves routing and does not claim Agent37 migration.

## Root runtime results (before datetime compatibility repair)

- Linux UI unit suite and production build passed; bridge build and full unit suite passed (1089 passed, 4 pre-existing skips); release suite17 passed.
- Real PostgreSQL concurrency harness passed: 7/24 independent backend connections admitted; saturation, fixed/non-extending expiry, reset expired/null rows, max1, scope isolation and legacy reset verified. Owned temporary schema removal confirmed. Initial harness DDL extraction omitted UNLOGGED; repaired and identical isolated run passed.
- Real TLS MCP consent parser accepted normal compressed JSON and survived delayed trailing gzip/deflate/br payloads; subsequent health checks passed.
- Focused Playwright security-admission:9/9 passed (13.9s), including bytes vs characters, declared/streamed limits, auth ordering, exact concurrent registration threshold, victim login and successful-login budget retention.
- Advisory standalone E2E tsc: introduced request-factory/route-Promise type issues fixed; remaining failures are UI aliases reached by existing device-display-name DB script. Baseline reproduction pending; this standalone command is not a repository CI gate. UI tsc/build and bridge build passed.
Baseline standalone E2E tsc confirmed: exact same17 alias/implicit-type diagnostics on untouched8244d6d source archive using same installed compiler. This is a pre-existing non-CI gate limitation, not masked or weakened. Introduced type errors repaired; focused HTTP9/9 passed afterward.

## Final pre-PR gate

After the datetime compatibility repair and independent approval, root refreshed the shared-source checks in the isolated sandbox: full UI suite820 tests, UI TypeScript and production build, bridge build/full unit suite, real compressed-parser smoke and all9 focused HTTP tests passed (runner exited0). Prior release17 tests and real-DB concurrency evidence remain valid: those source paths did not change in the timestamp repair. Dependency full/production audits remain zero with unchanged lockfiles.

Repository changes are split into reviewable commits: coupled body-parser/qs, fast-uri, dev undici, shared Zod migration, auth behavior, runtime tests/CI wiring and timestamp compatibility. No tests were weakened, disabled or retried to obtain passing results; test-harness failures and their isolated repairs are documented above. Original feature checkout untouched.

Final full CI results belong to the PR head and are linked from the PR. The development sandbox stays root-owned only while CI is running so any failure can be reproduced in isolation; cleanup must complete before final handoff. All implementation/review workers completed and released their leases; no application writers remain active.
