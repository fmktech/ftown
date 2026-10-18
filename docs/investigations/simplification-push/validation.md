# Validation and resource ledger

Root executed all runtime/E2E checks for bridge 0.19.45 on branch
feat/simplify-cli-release-and-notifications, based on main
957d90bbd265b90d60f54848a26a13a74722ccca. Four pre-existing modified investigation
notes were preserved and excluded from landing.

## Passed checks
- Final combined bridge build; full bridge suite: 797 passed, 4 skipped.
- Final UI production build; full UI suite: 307 passed across 37 files.
- Release/classifier/artifact tests: 16/16 on npm 11.6.2 and npm 12.2.0, including
  actual dual-package payload parity (worker evidence in cli-handoff.md).
- Root CLI smoke: real npm-shaped package entry and installed ftown start --local
  both started; installed runtime worked after deleting the original npm-cache
  fixture. Fresh/current/repair/incomplete/downgrade guards, legacy aliases,
  session operations and read-only help passed. All scratch processes, sessions
  and HOME data removed in finally.
- Solo argument forwarding verified by offline key rotation; full Solo panel/hub
  download/start was not exercised before the new version is published.
- Focused Playwright notification suite: 2/2 passed. Real authenticated routes,
  local PostgreSQL, opt-in/out UI, service worker after closing the app page,
  duplicate display suppression, session link navigation, duplicate idle/question
  storage, frozen recipients, browser-token/wrong-owner/revoked-bridge rejection.
- Browser OS permission, PushManager/provider delivery, showNotification and
  window-opening boundary were simulated. No external push service or real OS
  notification was sent. Actual web-push encryption was exercised by isolated
  unit tests without network. These tests do not prove vendor delivery.
- Root viewed the enabled-control screenshot; control is legible, visible at the
  bottom of the sidebar and fits the existing dashboard. Screenshot retained in
  ignored e2e/test-results/.../notifications-enabled.png.
- Final diff check passed. Independent review closed all five material findings;
  see independent-review.md. Root reviewed startup and notification wiring;
  notification worker independently reviewed canonical startup too.

## Bounded findings resolved during validation
- Fixture omitted the newly declared bin directory: smoke now copies the shared
  installation manifest. Product setup correctly rejected the incomplete fixture.
- Local command runner ended background servers after launcher exit: root ran
  launcher, Playwright and cleanup under one managed command.
- Chromium independently reported Notification.permission=denied while its
  Permissions API reported the automation grant=granted, on a plain local health
  page without FTown. Fixture explicitly simulates the OS permission boundary;
  product denial checks remain unchanged.
- Synthetic notificationclick has no trusted user activation; fixture captures
  the real handler's requested same-origin URL and explicitly navigates it.
- Runtime output prompted the final copy-only change to advertise ftown start and
  use the invoked command for pairing. Bridge rebuilt and updated setup output
  was observed in passing focused E2E startup.

## Environment isolation and cleanup
- Before setup, ports 443, 3000, 5432 and 8000 were free. Root created only Docker
  Compose project ftown-simplification-push. Exact database was its local
  PostgreSQL ftown database/user, confirmed before DDL; commands explicitly used
  127.0.0.1:5432. UI selectors used checked-in local Neon shim/Centrifugo settings.
  No production migration, configuration or deployment ran.
- Applied additive migration 0005 only to the task database and confirmed all
  three push tables. Test VAPID keys existed only in the test server environment.
- Test script used scratch cwd, HOME and USERPROFILE. Trap stopped recorded
  UI/bridge PIDs. Removed task containers, network, anonymous volume, scratch HOME,
  test certificates and PID/account markers. Verified test ports have no listeners.
- Docker Desktop was initially stopped; root restored that state after removing
  the task project. Unrelated container definitions and data were preserved.
- Ignored test reports/logs and installed e2e dependencies remain for evidence and
  reuse; no task servers remain.

## Orchestration and landing
- Ownership validated before parallel writes and after bounded extensions:
  67 disjoint paths. All workers explicitly used gpt-6.1-sol/high in one checkout.
- canonical_start and npx_review handoffs accepted; both native agents completed,
  stopped writing and released all leases. npx_implementation source accepted;
  its only pending assignment is Git landing. No separate native close API exists.
- PR creation and automatic CI remain. Do not merge or configure production push
  from this task. Production activation requires migration 0005 and stable VAPID
  configuration as documented in docs/push-notifications.md.

## Landing completion
- [PR119](https://github.com/fmktech/ftown/pull/119) targets main from
  feat/simplify-cli-release-and-notifications. Implementation commit
  f933e54969b9506d074ba4c6e8998e0829517b6c contains the accepted combined change.
- Fresh origin/main remained957d90 before landing; no conflict or version
  collision appeared. Mechanically verified67 disjoint allowlisted paths and
  excluded all4 pre-existing dirty notes. Staged whitespace check passed after
  trimming one trailing blank line in the contract under explicit ownership.
- Root transferred final coordination files to the integration owner. This
  final coordination commit records the PR and retirement state; it changes no
  application source or validation evidence.
- canonical_start and npx_review are accepted/native-completed with no leases.
  Integration owner stops writing and releases its Git lease on final handoff;
  no pending worker assignment or task server remains. Root monitors automatic
  PR CI. No merge, production migration/configuration or package publication ran.

## CI clean-install repair
- CI39089624759 failed UI npm ci on Node24.21.0/npm11.19.0 because the optional
  @emnapi/runtime1.11.3 hoisted record was missing. The notification worker
  restored exactly that generated ten-line lock entry; no existing entry,
  manifest, dependency version or application source changed.
- Original lock failed and the minimal repaired lock passed actual scratch
  clean installations with exact CI Node24.21.0/npm11.19.0 targeting Linux/x64/
  glibc. npm12.2.0/Linux and npm11.6.2/Darwin also passed with the lock unchanged.
  Scripts were disabled; this establishes graph/install portability, not Linux
  native execution. See ci-lockfile-repair.md for reproduction and cleanup.
- Independent canonical_start review closed with no findings: exactly one new
  record and zero altered existing entries. Both repair author and reviewer
  stopped writing and released leases. Root accepted this bounded metadata fix;
  prior builds/tests/runtime evidence remains valid without repetition.
- Ownership revalidated68 disjoint paths. Integration stages only the repaired
  lock, investigation and final coordination/evidence; all4 prior dirty notes
  stay excluded. Integration worker releases its Git/coordination lease and
  retires on final handoff. Root monitors new automatic PR119 CI; no manual
  rerun, merge, version bump, production action or additional runtime check ran.
