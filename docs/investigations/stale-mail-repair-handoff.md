# MAIL-RED handoff

Tier 1 `gpt-6.1-terra` / `xhigh`; shared checkout `/Users/fkesheh/projects/ftown-e2e-performance`.

## Tests and isolated red evidence

`bridge/src/mail-delivery.test.ts` adds three controlled fake-clock/native-waker cases: a busy Codex turn drains the same inbox before idle without leaving a queued pointer; unread busy-turn mail remains live and wakes once after idle; and a fresh unread batch after a prior read still wakes. Existing `:834` probe-barrier/drain test and `:790`/`:185` unknown-admission suppression remain intact. `bridge/src/native-mail.test.ts` was not changed.

Root ran the exact revision in isolated Boat `bx_pd45k3hb` with Node 24.22.1 and installed bridge dependencies:

```sh
cd bridge
node --import tsx --test '--test-name-pattern=busy native wake regression' src/mail-delivery.test.ts
```

Of the three matching cases, **two failed and the fresh-arrival control passed**. The first failure observed the generic native wake in the fake queue after the busy turn consumed its inbox, where the assertion required no queued pointer (`a consumed busy-turn inbox must not leave a native prompt queued`). The second failed `busy native sessions should not be queued before idle`. These results reproduce FTown's controlled scheduling defect, not the unobserved exact order of the previously captured screenshot. The targeted command's unmatched tests were not run; no tests in the three-case selection were skipped.

The existing test `queues native wake while busy, sends no payload and leaves inbox unread; each batch wakes once` encodes the previous behavior and conflicts with the newly requested no-stale-busy-wake behavior. Its intent must be revised only after the repair contract is reviewed and frozen; retain privacy, same-batch deduplication, fresh-arrival, unknown-admission and liveness checks.

`node --check bridge/src/mail-delivery.test.ts` and a bounded static whitespace/regression-presence check passed locally. No application bodies, provider calls, E2E, services, DB, install or Git operations were performed by the worker. Root owns the isolated runtime and cleanup. Test-file lease retained; no writes until root freezes and assigns the reviewed repair contract.


## MAIL-GREEN handoff

Implemented the frozen contract in `bridge/src/mail-delivery.ts` and `bridge/src/mail-delivery.test.ts`; `bridge/src/native-mail.test.ts` was not changed. A shared recent-busy predicate now defers before the native attempt, is rechecked after the native callback's awaited session/inbox reads, and replaces both legacy busy predicates. Deferred mail retains the existing 60-second recheck and 30-minute stale-marker escape; native acceptance/unknown suppression, identity/epoch/running/unread fences and fallback logic remain intact. Native wake and Codex PTY fallback share the exact hook-aware conditional pointer; other PTY harnesses retain their existing copy. Already admitted native pointers remain uncancellable, and the final check is not atomic with queue admission.

Replaced the old busy-native acceptance assertion with deferred-until-idle behavior while retaining no payload, unread mailbox, batch coalescing and fresh-arrival checks. Added capability-probe busy transition with later liveness, refreshed and stale busy marker, and native/Codex versus other-harness pointer checks. Retained the three prior RED regressions and existing drain, unknown-admission and identity/shutdown coverage.

Static checks: `node --check bridge/src/mail-delivery.ts` and `node --check bridge/src/mail-delivery.test.ts` passed locally. No dependencies were installed and no runtime unit, type, E2E, provider or service checks were run by this worker. Root should sync these files to its isolated environment and run `cd bridge && node --import tsx --test src/mail-delivery.test.ts src/native-mail.test.ts`, followed by the repository's bridge type/build checks. The original isolated RED result above remains valid only for the pre-fix source. Runtime green and genuine capture remain pending root verification.

All MAIL-GREEN source, test and handoff write leases are released to root for review/validation. No Git or other shared resources used.


## MAIL-BASE handoff

Created and switched to `fix/stale-mail-wake-demo` at current `origin/main` / `881d7044fc137b286251abad03f1014d12e1a62a`; no pre-existing local or tracked remote branch with that name was found. Index was empty before switching. Git carried the existing modified mail source/tests and capture README, runner and spec, and all untracked investigation/capture files remained present. SHA-256 comparisons before and after the switch confirmed every carried task file was byte-identical. Main's other changes came in through the normal switch; no reset, stash, rebase, merge, commit or push was used.

Ran `npm version patch --no-git-tag-version --ignore-scripts` in `bridge`: `package.json` and both root lockfile version fields are now `0.19.57`; their diff contains only those three version fields and no dependency graph changes. Explicit `npm view` queries against `https://registry.npmjs.org` for `ftown@0.19.57` and `ftown-bridge@0.19.57` both returned `E404 No match found for version 0.19.57`, not a network error. Availability is time-sensitive.

No installs, tests, services or E2E were run. Exclusive Git branch/index and bridge package metadata leases are released to root; handoff report lease released as well. Root owns resync and validation of current main and the task overlay.


## MAIL-LAND integration

The final landing is based on `fix/stale-mail-wake-demo` at `881d7044fc137b286251abad03f1014d12e1a62a`, with bridge `0.19.57`. Root reports the final current-main validation, genuine capture, independent media/source review and sandbox cleanup in the main investigation. Integration stages only the 25 paths in `stale-mail-ownership.json`; the hook remains enabled. Git and this report lease are released at successful PR handoff. The actual commit, PR and automatic CI status are reported to root separately, since they do not exist until after this file is committed.
