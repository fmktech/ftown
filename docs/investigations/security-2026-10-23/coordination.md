# October 23 security dependency updates

User requested review of recent vulnerabilities and a PR with needed upgrades. Shared checkout: `/Users/fkesheh/projects/ftown-simplify-all`; branch `security/dependency-updates-2026-10-23`, base `33eaa04448917cc95a62ad838104f4c632c03a40`. Four unrelated investigation notes must remain byte-identical. No live deployment, production secret change, global runtime installation or merge is authorized by this task.

## Scope and contracts

Keep security remedies in independently reviewable dependency-group commits within one PR. Use npm-generated lockfiles only; do not use force upgrades or refresh unrelated dependencies. Runtime/application behavior remains the same except upstream security rejection of malformed inputs. No schema/data migration. Reverting a group restores its earlier manifest/lock/config, including its vulnerabilities.

Baseline live npm audit: bridge 2 moderate affected packages; UI 14 affected package nodes (4 critical, 6 high, 4 moderate); E2E 0. These counts are dependency nodes, not distinct vulnerabilities. The Neon test shim currently has no lockfile, so its old resolved graph is not reproducible. The public wrapper repacks the bridge and has no separate graph.

Frozen npm remedies, reviewed independently by `/root/npx_review` before mutation:

| Group | Installed | Patched target |
| --- | --- | --- |
| Bridge IP parser | ip-address 10.7.3 | 10.7.4 |
| Protobuf client dependency | bridge 7.6.4 / UI 7.5.4 | protobufjs 7.6.6 and patched UTF-8 helper |
| Next / image decoder | Next 15.5.13 / sharp 0.34.5 | Next 15.5.28, sharp >=0.35.5; retain Next 15 |
| Authentication | next-auth beta.30 / core 0.41.0 | beta.32 / core 0.41.3 |
| CSS/source maps | PostCSS 8.5.16 plus Next's 8.4.31 | 8.5.23 with narrowly scoped `next.postcss: $postcss` override; source-map-js >=1.2.2 and nanoid >=3.3.18 |
| UUID | UI 11.1.0 | 11.1.1 |
| Dev test stack | Vitest 4.1.9 / Vite 8.1.3 / Undici 7.29.0 | Vitest 4.1.12 / Vite >=8.1.6 / Undici >=7.29.1 |

Raise direct manifest minimums while preserving caret conventions. Explicitly verify sharp's resolved version: Next still permits old 0.34.x and a parent bump alone is insufficient. Existing jose 6 / oauth4webapi 3 are not newly introduced major upgrades. Preserve platform optional packages when regenerating locks.

Runtime contract: CI and `.nvmrc` select Node 24.22.1; preserve existing container Node major with patched 22.23.4 or 24.22.1 tags verified in the registry. Bridge engines admit `^22.23.4 || ^24.22.1 || >=26.12.1`. UI admits `^22.23.4 || ^24.22.1` to retain its existing Node 22 container and select the highest matching managed hosting major (24); hosting manages its patch version, so this is not proof of a deployed runtime upgrade. Add explicit setup-node to bridge-version-bump, which currently relies on the runner's ambient Node. Generate/audit a reproducible Neon shim lock and use npm ci. Bridge package-affecting changes require patch release 0.19.50.

Primary security sources: [Node Oct 21](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), [Next Oct 14](https://nextjs.org/blog/nextjs-security-update-october-14-2026), [Auth beta.32](https://github.com/nextauthjs/next-auth/releases/tag/next-auth%405.0.0-beta.32), [IP parser](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-rxp7-6hxx-x8q5), [protobuf parser](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-j3f2-48v5-ccww). Raw audits and all intermediate release notes were read and retained in `/tmp/ftown-bridge-audit-2026-10-23.json` and `/var/folders/ft/gvw3pk8x1w7g7cxhzj50ptyh0000gn/T/ftown-ui-audit-dsztpq2p`.

Relevant upstream changes: Auth fails closed on unsuccessful session responses; FTown uses Credentials/JWT and email-presence checks, not email/OAuth providers. Next App Router and the MCP consent Server Action are used, so RSC/action fixes matter; next/image, next/og and Cache Components are not used directly. CSS loading becomes stricter for external maps; do not enable unsafe map behavior. Vitest uses safer redirect/mock file access. Protobuf rejects malformed schemas/messages; FTown uses the standard JSON Centrifuge client. Sharp 0.35 requires supported Node and platform binaries, which must be verified in the build. Detailed release/diff evidence belongs in the implementation handoff.

## Ownership and dispatch

Root is architect, owner of this file and `ownership.json`, and sole E2E/runtime-service coordinator. All workers retain their verified explicit `gpt-6.1-sol` / `high` selections and use this same checkout. `/root/npx_implementation` is the single dependency installer/lock writer and integration/Git owner. Its exact files are in the ownership manifest. It may stage dependency-group commits only after their checks, but may not push/open PR until root's combined validation gate. No other worker may mutate Git or dependencies.

`/root/npx_review` is read-only independent reviewer; no resource leases. `/root/canonical_start` owns the reviewed Centrifugo migration, including managed Solo, under the exact manifest leases. No simultaneous overlapping writers are allowed. Workers do not start E2E, browsers, service containers, servers, shared DBs or CI reruns.

Root prepared isolated official Node 24.22.1 at `/var/folders/ft/gvw3pk8x1w7g7cxhzj50ptyh0000gn/T/ftown-node-security-fbawq39s/node-v24.22.1-darwin-arm64/bin`, verifying archive SHA256 `89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7` against official release SHASUMS. Use a process-local PATH prefix; the user's global Node is unchanged.

## Validation gate

## Centrifugo migration contract (reviewed and frozen)

Security target is Centrifugo **6.10.2**, including the protocol decoder hardening, later deadlock repair and current image certificate-bundle update. Primary sources: [decoder advisory](https://github.com/centrifugal/centrifugo/security/advisories/GHSA-4r3x-2rwr-6w65), [deadlock advisory](https://github.com/centrifugal/centrifugo/security/advisories/GHSA-xcch-wm46-g65g), [6.10.2 release](https://github.com/centrifugal/centrifugo/releases/tag/v6.10.2). This is an independent dependency-group commit, not a reason to alter application behavior.

- `/root/canonical_start` will own only the exact Centrifugo files in the manifest and its report. Official image digest and all four Solo archive checksums must be verified before pins are written.
- Translate development, E2E, Fly and legacy production configuration into v6 nesting. Preserve every explicit value: JWT audience, owner-scoped channel names, six namespace permission blocks, history, recovery, presence/join events, origin rules, buffer limits, port boundaries, API/admin/TLS settings and memory engine. Named namespaces do not inherit `without_namespace` options; retain existing explicit namespace values. Do not alter the application's publisher-identity checks.
- Keep existing deployment secret names working through a minimal Fly entrypoint alias to v6's nested HMAC environment variable, without printing secrets or placing them in process arguments. Native v6 names take precedence. Fly admin/API remain disabled and its health listener remains private.
- The legacy remote deploy helper must verify a target binary/image version >=6.10.2 **before backup, configuration install or restart**, rejecting an old/unparseable version with clear binary/image upgrade instructions. It does not upgrade or redeploy a live host automatically. Convert the legacy JSON/renderer together, retaining external secret names. Operators must upgrade that host binary/image before deploying the v6 configuration.
- Solo selects a versioned, checksum-verified 6.10.2 cache entry and writes its nested config with mode 0600. Existing bind addresses, auth, proxy, lifecycle and cache-checking rules remain.
- Retain the supported legacy `/api` command/reply envelope used by current clients/tests. Add pure config/permission parity and mocked legacy guard tests. Workers may run these isolated checks; root exclusively validates with the real binary and executes server/browser/Solo runtime tests.
- Rollback must pair matching binary/image and configuration versions. Existing in-memory channel history is lost on a service restart; there is no new persistent data migration.

Independent pre-freeze review approved the revised contract, including the legacy pre-write guard. Root mechanically validated all 43 exact file leases without equal or ancestor overlaps, then released Centrifugo source ownership. Treat unknown-config-key warnings as validation failures; upstream may otherwise warn without exiting nonzero. Preserve explicit namespace values rather than inventing inheritance. The npm writer owns `docker/solo/Dockerfile` and all Node image/CI selectors; Centrifugo worker owns the separate compose files and Centrifugo deployment workflows. Any new shared-file need goes through root.

Accepted bounded additions: the npm/runtime owner also owns `e2e/tests/auth-session.spec.ts`, verifying real Credentials login, authenticated session identity and signout clearing access through existing UI/auth APIs. Root alone executes it. The existing Solo Docker package pin moves from 0.19.41 to this release's 0.19.50 so its image can consume the security fixes after npm publication; keep/document the existing publish-before-build prerequisite. This task does not claim a built/deployed Solo image or an audit of separately installed vendor CLIs.

For each npm group: minimal transitive diff review, exact installed/locked version assertions and audit. Combined: UI and bridge typechecks/full units, build, release/artifact checks, independent source/config review, and root-only real browser login/session/signout, create/terminal, realtime isolation/recovery checks against a task-owned local database and scratch bridge HOME. Root verifies database and deployment selectors before any schema/data writes. New configuration migration requires config validation and unchanged authorization semantics. No newly exposed endpoint or permissions expansion.

Status: audited; npm/runtime and Centrifugo contracts frozen; implementation active; validation/publication pending.

Runtime validation update: root observed sustained CPU saturation on the Mac (two samples 0% idle, load average 108), so heavy suites/builds will use the user's authorized Boat path if available. Workers have no heavy tests running and must defer them. Root remains the only E2E coordinator; exact uncommitted snapshot transfer, private test DB and finite sandbox TTL/cleanup are required. Canonical additionally owns `bridge/scripts/centrifugo-security-smoke.mjs`, a root-executed disposable Solo hub download/config/start/auth/channel/history/stop smoke; no worker execution is permitted.

Scope correction: canonical also owns `centrifugo/.dockerignore` so the required new entrypoint is included in the Fly build context. Mechanically revalidated all 45 file leases without equal/ancestor overlaps.

Validation execution fallback: Boat CLI, documented config, environment and connector are unavailable; root asked for existing connection information and will use the existing GitHub Actions runner if still unavailable. npm/runtime owner may add durable units, release/config guards, real pinned-binary config checks, Fly image build and Solo smoke to owned E2E workflow. Root alone dispatches it after source review and branch push; full existing E2E runs against its disposable local Postgres, never production. Publication gate permits pushing the reviewed branch before validation solely to run workflow_dispatch; PR follows passing focused coverage. No deploy workflows are invoked. A literal next-scoped PostCSS 8.5.31 override is acceptable only if npm-generated resolution proves the $postcss reference unsupported; no global widening is approved.

Boat follow-up: user supplied `/Users/fkesheh/.ascii/bin/boat`; verified CLI 1.0.65 and existing active account. Existing named snapshots are for unrelated legbi projects, not FTown. Root attempted one fresh default (4 vCPU/8GB) sandbox, TTL7200, no account environment/secrets or snapshots, name ftown-security-20261023. API rejected HTTP429 `rate_limited`: daily200starts exhausted. No sandbox ID/resource was created, so no task Boat cleanup is due. Do not upgrade plan or use unrelated active sandboxes; GitHub Actions fallback remains.

Centrifugo handoff accepted for source integration: writer completed23leasedfiles and stopped/released leases. Independent reviewer cleared config/auth/origin/namespace parity, Fly alias, legacy guard and supported legacy API envelope; patched Node selector repaired. Worker evidence:34pure/fake tests and15filteredSolo tests, syntax/YAML/diff checks passed; realruntime pending. Existing native agent completed; retain only for a concrete gate failure repair, no active leases.

PostCSS contract fallback reviewed: exact consumers are root, TailwindCSS/PostCSS, Vite and Next. The first three already resolve8.5.31; a global `postcss: $postcss` override is allowed only if scoped existing-tree resolution cannot be made valid, as its only effective version change is the same accepted Next8.4.31→8.5.31 remedy. Do not refresh unrelated nodes.

PostCSS resolution accepted: global `$postcss` plus targeted npm update removed Next nested8.4.31 with no unrelated nodes. Only rootPostCSS8.5.16→8.5.31, nanoid3.3.15→3.3.20 and source-map-js1.2.1→1.2.2 moved; npm ls is valid and all four consumers dedupe to patchedPostCSS. Scoped existing-lock variants failed; broad fresh-lock churn was rejected.

Npm owner also owns `docker/solo/README.md` solely to align the documented0.19.41 package pin with the approved0.19.50 pin and preserve publish-before-build prerequisite. All46leases mechanically non-overlapping. Dev patched targets remain Vite8.1.6/Undici7.29.1; scoped parent overrides may select those reviewed patched versions instead of unrelated latest minor upgrades, with final compatiblegraph/audit validation.

Integration finding: origin/main advanced to c194a6c with compatible Node/CA security remediation overlapping runtime selectors and Docker files. Sole Git owner will first commit the task snapshot, then merge origin/main preserving its CA update commands and existing changes. No bridgeversion collision (.49 upstream, this task.50). Root coordination files now frozen/released for Git integration; four unrelated dirty notes remain excluded and byte-identical. Source review closes against mergedfinaltree before runtime/PR gate.

Final merged source independently approved at229a90760d26d280aa6c2d43fcbd2a74a9190b42 and pushed withoutforce. All four npm audits reportzero. Root verified E2E localPGselectors(localhost:5432/ftown), localNeonshim URL and scratchHOME before dispatch; no production DB/secrets injected. Root dispatched [E2E39943863194](https://github.com/fmktech/ftown/actions/runs/39943863194) and [Centrifugo39943867710](https://github.com/fmktech/ftown/actions/runs/39943867710) with explicitdeploy=false; legacydeploy notinvoked. Gitleaks39943825478 passed. Runtimechecks pending. Root reacquired coordinatorfiles while Gitowner idle.

Centrifugo validation39943867710 passed allpureguards, real6.10.2 checkconfig for4configs(no unknown-key warnings), Flyimagebuild andendpoint/originruntime smoke; deployjob skipped. CIevidence saved at `/var/folders/ft/gvw3pk8x1w7g7cxhzj50ptyh0000gn/T/ftown-security-ci-rlb6pcvw/centrifugo.log`. Combined E2Ejob advanced past UI/bridge units+builds, releaseartifact checks and actualSolo securitysmoke successfully; browser suite now running.

## Accepted verification and completion gate

At source revision `229a90760d26d280aa6c2d43fcbd2a74a9190b42`, root-managed GitHub Actions passed:

- UI: 343 tests in 37 files and production build/type checks.
- Bridge: 862 passed, 4 existing skips, 0 failures; clean build/type checks.
- Release planning/artifact parity: 17 passed.
- Browser suite: 38 passed, 2 existing skips. Covers real Credentials login/session/signout, all three transport paths, owner/foreign subscription and publisher controls, HTTP IDOR, desktop/mobile session creation, lifecycle and restart recovery. Skips are existing mail PTY nudge and stopped/errored-session retry cases.
- Actual managed Solo 6.10.2: verified archive/cache, mode 0600 config, JWT audience, owner isolation, publish/history/reconnect, disabled API/admin and loopback binding.
- Centrifugo: 34 pure/fake guards, all four real binary configs without unknown-key warnings, Fly image build, and endpoint/origin smoke. Deployment explicitly skipped.
- npm audits: bridge/UI/E2E/shim all zero known vulnerabilities. Gitleaks passed.

[Combined validation](https://github.com/fmktech/ftown/actions/runs/39943863194) and [Centrifugo validation](https://github.com/fmktech/ftown/actions/runs/39943867710) are final runtime evidence for unchanged source. Raw logs are retained in the CI evidence directory above. Recorded-process shutdown and Docker teardown passed; no task local service or Boat sandbox was created. Four unrelated dirty notes remain byte-identical.

Independent review accepted the merged source; source owners and reviewer completed and released leases. Root accepts all implementation/runtime gates and authorizes the existing Git integration owner to commit this evidence, push and open the PR against main. Documentation-only evidence updates do not invalidate source test results. No merge, production deployment, global Node change or npm publication is performed. The legacy host still needs a patched binary/image before guarded configuration deployment; the Solo Docker image requires ftown-bridge 0.19.50 publication before build. Managed hosting patch level is platform-controlled; repository runtime selectors are not deployment proof.
