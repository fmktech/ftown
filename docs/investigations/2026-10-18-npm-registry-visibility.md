---
type: investigation
symptom: "Release publication succeeded but immediate tag verification saw npm E404"
slug: npm-registry-visibility
date: 2026-10-18T00:40:00Z
git_commit: 60c19453a3910ab920f55c56836b8afc1e4e5436
branch: fix/npm-registry-visibility
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Postpublication registry visibility

Worker `/root/npx_implementation`, explicitly `gpt-6.1-sol` / `high`, uses shared
checkout `/Users/fkesheh/projects/ftown-simplify-all`. Fresh branch from fetched
main `60c19453...`; four older modified investigation notes remain untouched.
Exclusive writable scope: `bridge/scripts/publish-packages.mjs`, its test,
`bridge/package.json`, `bridge/package-lock.json`, and this investigation.
Worker owns Git/index/lock/build leases until review handoff. Root owns runtime
and automatic CI/recovery execution. No other file, live npm publish, E2E,
server, manual CI action or recursive delegation is authorized.

## Symptom and reproduction

Release `39082912140` published both packages, then failed at tag verification:
`Both npm packages must exist from this commit before tagging`.
Root's CI timestamps: publish started `00:30:46.379Z`; tag started
`00:30:59.383Z` and failed `00:31:00.287Z`. Root's exact-version npm reads at
`00:31:23Z` returned E404 for both versions. Expected: successful publication
becomes verifiable and the immutable same-commit tag is created.

Deterministic test reproduction: make exact-version lookups return undefined
(the existing structured-E404 interpretation) immediately after publication,
then return the expected gitHead. The current tag branch fails on the first
lookup before the successful later response. This models the recorded live
transition without production writes or an E2E environment.

## Hypotheses

### H1: public registry reads lag successful publication

- Layer: dependency/integration.
- Prediction: identical read-only queries eventually expose both versions
  with the expected source gitHead without another publication.
- Verification: worker read exact-version and full registry metadata; root
  independently read both packages. No writes occurred during the transition.
- Evidence: `npm view ftown@0.19.43 version gitHead --json` changed from E404 to
  `{"version":"0.19.43","gitHead":"60c19453a3910ab920f55c56836b8afc1e4e5436"}`.
  The bridge remained E404 at `00:32:32Z`, then the identical query succeeded.
  npm-registry-fetch read-only exact endpoints returned both same-commit
  manifests; full package metadata then returned both versions with
  `cache-control: public, max-age=300`. npm12 view source already sets
  `preferOnline: true`, so adding that flag cannot guarantee fresh visibility.
- Verdict: PROVEN. No republish/retry occurred before the observed transition.

### H2: npm12 silently staged the packages or authorization prevented publication

- Layer: configuration/authentication.
- Prediction: no public versions appear; authenticated stage listings contain
  pending artifacts, or direct publish fails authorization.
- Verification: root read authenticated stage lists; worker inspected installed
  npm12 `lib/commands/publish.js` and `libnpmpublish/lib/publish.js`.
- Evidence: both stage lists were `[]`. Publish sets `static stage = false` and
  awaits registry PUT; only the separate stage command uses staging. Both
  packages subsequently became publicly readable at the intended commit.
- Verdict: REJECTED by public availability without intervention.

### H3: registry metadata exists but has the wrong source commit or malformed shape

- Layer: state/data.
- Prediction: later reads fail the existing shape/gitHead checks.
- Verification: inspect successful exact-version records after visibility.
- Evidence: both `ftown/0.19.43` and `ftown-bridge/0.19.43` returned version
  `0.19.43`, gitHead `60c19453a3910ab920f55c56836b8afc1e4e5436`; root confirmed
  the complete npm view responses too.
- Verdict: REJECTED. Existing shape and commit checks succeed once visible.

## 5 Whys and falsification

1. Tagging failed because its immediate lookup still returned E404.
2. Successful registry publication preceded public metadata visibility.
3. The tag guard interpreted a transient missing read as a terminal result.
4. It reused preflight absence semantics without a postpublication deadline.
5. Release verification assumed read-after-write consistency at an external
   registry boundary; tests lacked a delayed-visibility sequence.

Falsification: unchanged read-only queries first failed, then succeeded for both
packages without republishing; successful exact endpoints and full packuments
also agree on source commit. This rejects staged/auth/data alternatives and
isolates delayed visibility. Root separately owns same-commit recovery retry.

## Fix contract (recorded before source changes)

Only the tag step waits, for at most five minutes of polling, only while exact
versions are missing/E404. Cache confirmed records so only still-missing names
are polled. Never republish while waiting. Wrong/missing gitHead, malformed
metadata and non-E404 auth/network failures retain immediate failure. Check
the immutable tag before waiting and again before pushing. Injectable sleep
and clock keep regression tests fast. Log pending versions and a clear finite
timeout. Bump package/lock patch to `0.19.44` as required for bridge changes.

The investigation gate is satisfied before modifying release source.

## Resolution and handoff

The tag command now checks its immutable remote tag, awaits bounded exact-version
visibility, then rechecks the tag before creating it. The helper caches confirmed
same-commit records and only requests still-missing names. It logs pending names
and a remaining budget; expiration gives same-commit retry guidance. It contains
no publication operation. Malformed/auth/network errors propagate immediately,
and existing gitHead checks reject wrong or missing source identity.

Added injected-clock/sleep regressions for immediate visibility, the observed
both-missing → one-visible → both-visible sequence, finite deadline/clamped
sleep, wrong/missing commit, malformed metadata and non-E404 registry failures.
Package and lock both advance to `0.19.44`; bins/dependencies/content stay intact.

Checks: `npm run build` passed. Release suite 13/13 passed under local
npm11.6.2 and isolated Node24.15.0/npm12.2.0, including real packed file/mode/
normalized manifest parity. No real sleeps are needed for timing tests.
`git diff --check` passed. Worker has not run E2E/setup/server/database, manual
CI/release actions or npm publication.

Root reports release `39082912140` same-commit retry succeeded, both `.43`
packages and tag are available, and main E2E passed. Actual public-registry
`npx --yes ftown setup` also passed in a fresh isolated HOME/USERPROFILE/cwd/
npm cache with setup state `.43`; root removed its temporary home/cache without
touching user configuration. No repeated runtime check is needed for this
release-only helper change. Root mechanically validated six disjoint exact
leases: these five files plus one reviewer report.

Implementation writes and Git/lock/build leases are released to root for
independent review and acceptance. Four unrelated modified notes are preserved;
no commit/push was made. Landing remains pending root authorization.

Independent review caught a deadline edge: an in-flight lookup could complete
after the polling budget, or a fresh request could start exactly at expiry.
Root authorized the bounded correction in the same ownership scope. The tag
path now checks remaining time before and after each lookup and bounds the
actual npm subprocess to that remaining budget. Subprocess expiry terminates
the wait with retry guidance. Preflight/publish retain normal lookup behavior.
Added fast tests for slow successful lookup crossing the deadline, no next
request after expiry, per-request remaining budgets and subprocess timeout.
Final affected release suite passed 13/13 under both npm11.6.2 and isolated
Node24.15.0/npm12.2.0, including real artifact parity; whitespace check passed.
Implementation writes stopped and all leases are released again for closure.

## Accepted landing and retirement handoff

Independent reviewer accepted the deadline correction and final source/tests
with no unresolved findings. Root accepted all gates and assigned the sole
Git/index lease for committing these five files plus the reviewer report,
pushing `fix/npm-registry-visibility` and opening a PR to main. Fresh fetch
confirmed main remains `60c19453...` / `0.19.43`, so patch `0.19.44` does not
collide. The four pre-existing modified notes remain excluded.

After returning the commit SHA and PR URL, this worker stops and releases all
file/Git/lock/build leases for retirement. Root alone monitors automatic PR
artifact checks and E2E. No merge, live npm publish or manual CI execution is
part of this landing. This handoff is recorded before committing; no later
documentation-only push is needed.
