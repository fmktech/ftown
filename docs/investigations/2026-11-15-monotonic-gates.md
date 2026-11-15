# Monotonic elapsed-time gates (chaos F3)

Root cause and reproduction are supplied by the task: seeds 6 and 10, soak/high,
step the wall clock back 600 seconds; monotonic timers fire but wall deadlines
re-arm for approximately ten minutes. Forward steps prematurely expire gates.
The debug skill's proven-root-cause exception applies; regression tests must
independently discriminate fixed and unfixed mail code.

## Contract and ownership

Shared checkout: `/Users/fkesheh/projects/ftown/.claude/worktrees/fix-monotonic-gates`.
Existing public signatures, persisted formats, log wording and duration constants
remain unchanged. Add optional `monotonicNow?: () => number` to existing clock
options, default `() => performance.now()`. Existing `now` remains wall time.
Each existing fake clock must explicitly inject both clocks for elapsed tests.
Keep wall timestamps in public injection records; track a separate monotonic
injection age internally. No BigInt literals. No chaos source edits.

| Task | Exclusive writable files | Dependencies / resources |
| --- | --- | --- |
| M: mail | bridge/src/mail-delivery.ts, bridge/src/mail-delivery.test.ts | Frozen clock contract; isolated unit tests only |
| A: attention | bridge/src/attention-store.ts, bridge/src/attention-store.test.ts | Frozen clock contract; isolated unit tests only |
| R: review/audit | Read-only source; findings returned to architect | Reviews contract first, then audit and final diff |
| Root: integration/landing | This document, bridge/package.json, bridge/package-lock.json | Sole npm install, version, Git, E2E/chaos and CI owner |

Ownership sets are pairwise disjoint (exact paths); no parallel shared writes.
M and A are independent; R reviews contract before M/A dispatch, then their
combined result. Root integrates only after writers release leases. Additional
audit findings require explicit ownership transfer before implementation.
Workers: Tier 1 development gpt-6.1-terra / medium; independent review Tier 2
gpt-6.1-sol / max (bounded multi-clock correctness). Workers never recursively
delegate, run E2E, start services, install packages, or mutate Git.

## M brief

Move legacyReadyAt (accept and recovery), lastNudgeAt, busySince (both stale
windows), native lease, codexRetryAt (all paths), and injection age to monotonic
time. Retain wall `now` for nudge tokens and exposed injection `at`. Preserve
cleanup, cancellation, idempotence and native/PTY selection behavior. No change
to timeouts or wake semantics. Add deterministic injected-clock cases for both
±600,000 ms wall steps for every gate (including both busy windows and retry
paths); assert just-before and exact deadline behavior through public behavior
where practical. No real sleeps. Before implementation, run at least the legacy
and rate-limit regressions against unfixed source, recording names/commands and
failure output. Then implement and run `node --import tsx --test
src/mail-delivery.test.ts` from bridge. Consume existing types/interfaces only.

## A brief

Move waiter TTL, poller expiry, wait and waitForItem deadlines and idle timer
rechecks to monotonic time. For a newly armed idle cycle, use its duration and
monotonic arm time; for restart recovery compute remaining once from persisted
wall dueAt, then retain that monotonic deadline across rechecks. Keep persisted
startedAt/dueAt/notifiedAt unchanged. Handle async reads, spurious wakes, aborts,
timer caps, and replacing/canceling cycles without extending budgets. Use the
existing injected schedule/cancel for long polls too. Keep hasLiveWaiter's
optional numeric argument/signature compatible; internal callers must never
feed wall timestamps into a monotonic comparison. Explicitly flag any semantic
contract concern before editing. Add deterministic ±600,000 ms cases for idle,
restart/recheck, TTL/expiry, and each poll deadline; no real sleeps. Run
`node --import tsx --test src/attention-store.test.ts` in bridge.

## R brief

Independently review clock contract before implementation. Audit every literal
Date.now / clock subtraction occurrence across bridge/src mail, attention,
hooks and coordination (Semble for discovery, rg for exhaustive occurrences).
List analogous in-memory gates needing changes and deliberate wall-time
exclusions with reasons. Do not edit source; architect assigns any additions.
After implementation review both clocks, all set/check pairs, public/persisted
compatibility, cleanup, deterministic tests, exact boundaries and no-step
behavior. Report concrete defects only with file/line and reproduction.

## Acceptance and handoff

Every worker reads AGENTS.md and bridge/AGENTS.md, uses RTK and Semble per user
instructions, and remembers others share this checkout: never revert others'
edits or edit outside ownership. Escalate contract changes to root. Handoff:
changed files, unit commands/results, unfixed regression evidence (M), audit
findings/remaining limitations, and explicit release of file/resource leases.
Root owns npm ci/build/test and CI-equivalent checks, bridge patch version bump,
focused runtime/chaos runs, task-owned process cleanup, commits/push/PR and CI
until green. Chaos: one VM, seeds 6 and 10 times 2, then drop clock_jump_back
times 1 for each, record fingerprint, summary, M5 and hashes. No production
bridge or ~/.ftown mutations. Report to requested session, associate PR.

## Additional audit scope (frozen)

M additionally owns bridge/src/native-mail.ts and bridge/src/native-mail.test.ts:
move the 60s capability probe TTL write/check pair to optional monotonicNow
(performance.now default), preserving the existing now option shape. Test both
wall step directions and supported/unsupported cache expiry as practical.
A additionally owns bridge/src/ask-question-hook.ts and its .test.ts: add optional
monotonicNow, preserve now, drive overall deadline and outage window from mono;
CLI wires performance.now. Both directions, no sleeps, original constants.

C (Tier 1 gpt-6.1-terra/medium, dispatch pending) exclusively owns these exact
files: bridge/src/coordination-cli.ts, bridge/src/coordination-cli.test.ts,
bridge/src/sessions-commands.ts, bridge/src/sessions-commands.test.ts,
bridge/src/push-notifier.ts, bridge/src/push-notifier.test.ts,
bridge/src/spawn-stagger.ts, bridge/src/spawn-stagger.test.ts,
ui/src/components/SessionOverview.test.tsx. Independent of M/A; root integration
owner, no resource mutations except isolated unit/static checks. No overlaps.
Read existing interfaces/tests and AGENTS instructions. Preserve existing now
seams and wall timestamps/output. Add optional monotonicNow seams for duration
checks (default performance.now), including coordination board/events budgets,
attentionClock answer timeout, push queue TTL and retry scheduling, spawn slot
reservations. Existing tests must explicitly supply the monotonic clock where
they formerly supplied wall time. Spawn opts.now is a preexisting elapsed-clock
seam; retain backwards-compatible injection while defaulting to performance.now
if adding another option would needlessly disrupt callers. Push deps.now likewise
is exclusively an elapsed seam; keep its injection semantics while changing the
default to performance.now and document it. Do not change durations, log text,
retry counts, empty-page accounting, output timestamps, or formatting now.
Test each gate with deterministic ±600s wall steps and monotonic advancement;
use mocked Date only if production seam is otherwise not injectable, no real
sleeps. Correct the preexisting UI type error at SessionOverview.test.tsx:165
by supplying question, multiSelect and allowText on the test fixture; no UI
runtime changes. Unit checks: corresponding node --import tsx --test files;
UI npx tsc --noEmit and focused npm test -- SessionOverview.test.tsx. Follow
common handoff, shared checkout, no Git/install/server/E2E and escalation rules.

## Dispatch and results

- Contract independently approved by `/root/review` (gpt-6.1-sol/max): frozen.
  Preserve `hasLiveWaiter(eventId, explicitWallNow)` with separate lastPollWallAt;
  default TTL uses lastPollAt monotonic. `answer` omits numeric override. Capture
  new idle cycle monotonic deadline before persistence; repeated restore and
  capped/spurious rechecks must reuse it. Keep exact comparison boundaries.
- Initial checkout clean; branch fix/monotonic-elapsed-gates.
- Native inventory: root only before dispatch.
- M dispatched native `/root/mail`, Tier 1 gpt-6.1-terra/medium; A dispatched
  `/root/attention`, Tier 1 gpt-6.1-terra/medium, exact files/resources above.
  R `/root/review`, Tier 2 gpt-6.1-sol/max, read-only. All share this checkout.
- Docker inventory: three unrelated ftown-e2e-local containers; no chaos VM.
- M complete and released all four files: 106 focused tests passed. Against
  unfixed mail source, `node --import tsx --test --test-name-pattern='(legacy
  deadline|rate limit) ignores wall jump' src/mail-delivery.test.ts` failed four
  cases: backward legacy 0 vs 1, backward rate 1 vs 2 at deadline; forward legacy
  1 vs 0 and rate 2 vs 1 before deadline. Both jump directions discriminated.
- A complete/released: 46 attention-store and 28 ask-hook tests passed.
- C contract approved by R. Native thread limit prevented a fourth child;
  reassigned C to existing `/root/attention`, same Tier 1 terra/medium, after A
  release. R recalled for independent M/A review during C implementation.
- Baseline UI: npm test 123 files / 2210 tests passed; tsc --noEmit failed at
  SessionOverview.test.tsx:165 (fixture missing required question fields), C
  includes minimal fixture repair. CI bridge-version/trust helper tests 8 passed.
- AT repair assigned `/root/mail` Tier 1 terra/medium, exclusive
  bridge/src/attention-store.test.ts after A release: replace old global mock
  assumptions with explicit clocks, strengthen poll boundary/spurious recheck
  assertions. No overlap with C (current `/root/attention` files).
- Bridge version bumped 0.30.2 -> 0.30.3 by root using npm version patch.
- Review accepted all runtime source; test repair rounds MT/CT improved
  discriminating defaults, exact boundaries, and bounded failures.
- First full bridge test run: 3161 tests, 3146 passed, 11 failed, 4 skipped.
  Root reproduced four inbox-durable failures in isolation: old fixture lacked
  monotonicNow while its timers advanced fake time. IT assigned `/root/mail`
  exclusive bridge/src/inbox-durable.test.ts; same worker owns AT2 in
  attention-store.test.ts (remove negative fake mono advance and fixed IO tick
  deadline). No source writes or shared runtime resources delegated.
- Seven other full-suite failures reproduced with isolated agent-commands
  Claude model tests: real installed plugin added --plugin-dir. Minimal test
  isolation repair pending; no changes to the owner's installation.

### Last bounded audit/fixture repair

CM (Tier 1 gpt-6.1-terra/medium, `/root/attention`, pending dispatch) exact files:
bridge/src/claude-mod-installer.ts, bridge/src/claude-mod-installer.test.ts,
bridge/src/agent-commands.test.ts. Other workers own neither these nor parent
directories. Root remains integration/Git/install/E2E owner. No dependencies
except independent review approval. claudeModLaunchPath's 60s process-local
compatibility-probe cache uses its existing elapsed-only opts.now seam; default
it to performance.now, preserving signature/injection, constants, subprocess
and install behavior. Add deterministic default-clock ±600s cache boundary
tests with mocked Date/performance and isolated fixture assets/CLI. Isolate the
Claude model command test suite from real HOME plugin assets with task-owned
temporary fixture directory, restoring environment after the suite. Do not read
or mutate the owner's install or change production command behavior. Run both
node --import tsx --test files; common lease/handoff/escalation rules apply.

## Final elapsed gate inventory

Moved: mail legacy accept/recovery readiness; last nudge minimum interval;
busy markers (30min and hooked 120s); native wake lease; both Codex retry paths;
injection fallback 15s age; native capability probe TTL; attention new/recovered
idle deadlines/rechecks; waiter TTL/poller pruning; page/item long-poll budgets;
ask-hook deadline/outage; CLI attention answer/board/events budgets; push queue
TTL/retry/request budgets; spawn slots; Claude Mod capability probe TTL.

Deliberately left wall time:

- mail-store message identity, persisted mail/nudge timestamps and nudge tokens;
  mail delivery's public injection `at` is also wall time.
- mail-store/file-stamp filesystem epoch comparisons (including the race/cache
  window) must compare against filesystem wall timestamps.
- attention persisted idle startedAt/dueAt/notifiedAt, answer/resolution and
  activity timestamps; restart converts remaining delay once. Explicit numeric
  hasLiveWaiter override retains historical wall-time test/API compatibility;
  all normal runtime TTL checks and answer selection are monotonic.
- coordination attention-routing, card-store, tree-events and plan persisted
  event timestamps, plus Date.now wiring in index/local-api-server; board stale
  classification and displayed ages compare persisted wall epochs.
- hook-usage collectedAt is persisted calendar time.
- tree-events waits, native subprocess timers and harness mail-pump timeout
  already use relative timers with no wall deadline recheck.
- Other modules found by exhaustive `rg` (PR diff snapshot retention, direct
  transport/browser access, bridge updates, usage/quota/jsonl-fold budgets and
  update handoff) are outside this mail/attention/hooks/coordination change.
  Ledger reoffer/token provider already use monotonic elapsed seams. Calendar
  token/security envelope expiry remains wall time. No whole-repository clock
  immunity is claimed.

## Validation record

Node 24.22.1 for final checks. Unit/install/build output retained in task-local
terminal logs, including `/tmp/ftown-f3-bridge-tests.log` (initial failed suite).
All failures were reproduced in isolation before repair; no CI reruns requested.
AT2/IT passed 46 attention and 25 inbox tests; MT passed 120 mail/ask tests; CT
passed 76 CLI/push/spawn tests and default-push followup 8 tests; CM passed 34
Claude cache/command tests. All implementation workers released their leases.
UI type-check passed; UI baseline suite 2210 passed and focused fixture 23
passed. CI version/trust helpers 8, fixtures 9 and release helpers 23 passed;
both npm names available at 0.30.3. Final full bridge and chaos results pending.

Final local gates: npm ci (83 packages, clean audit), npm run build, npm test
all passed on Node24.22.1. Full suite: 3163 tests, 3159 passed, 4 platform skips,
0 failures, 59.04s; log `/tmp/ftown-f3-bridge-tests-final.log`. UI tsc --noEmit
passed and final fixture test23 passed. Independent reviewer approved all23
changed source/test/version files after repairs. Native inventory confirms M,
A/C/CM and R completed with no leases; no close control is available/needed
for these completed native turns. Code frozen; root owns remaining execution.
