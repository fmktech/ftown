# CI E2E failure and repeated empty-mail nudges

Shared checkout `/Users/fkesheh/projects/ftown-bridge-updates`, branch
`feat/bridge-update-flow`, PR150 HEAD678c716123e3b799273428cab50c11d5993553e5.
Root is architect and sole E2E/runtime/DB/CI execution owner. No code writes until
proven causes and exact implementation ownership. Existing dirty checkouts/stashes
remain preserved. Follow debug skill evidence gate, scaled to two bounded symptoms.

## M1 — mail evidence and source diagnosis

Tier1 `gpt-6.1-terra`, `xhigh`, `/root/update_runtime`. Sole writable file
`docs/investigations/2026-10-28-empty-mail-nudges.md`; all application/tests read-only.
No dependencies or shared mutation leases. Others share checkout; never revert or
edit outside scope. No Git mutations, installs, E2E, browsers, services, DB, mail
consumption, messages to live sessions, setup/update/restart or recursive delegation.

Outcome: explain user's screenshot showing generic new-mail nudge immediately
followed by `ftown harness mail read` -> `(no mail)`, reportedly frequent. Separate
old-runtime/version skew from an actual surviving delivery/consumption race. Root
verified current local bridge PID86247, started2026-10-26T14:53:29.499Z; main's
latest commit ce62d9d is Fix stale native mail wakes and refresh demos (#149).
Do not assume screenshot belongs to current session or machine without evidence.

Use Semble first for code discovery (`/Users/fkesheh/.local/bin/semble`, fallback
uvx if needed), then direct reads of returned exact functions. Read #149 change
and installed source/version metadata as needed without dumping tokens/keys/mail
contents. Read debug SKILL.md; record at least3 hypotheses across layers, rejected
alternative, evidence, 5Whys/falsification when cause proven. Root supplies live
version/start metadata. May author a scratch inert unit reproduction or propose
exact minimal fixture but do not run any live/native subprocess E2E or consume
mail. No suspected-source edits yet.

Trace nudge generation, native adapter cancellation/consumption, CLI recipient
identity and unread-state transitions. Identify exact APIs and candidate code/test
files for a minimal change if current source can reproduce a residual bug, or
prove why runtime upgrade is needed if source already fixes it. Preserve unread
mail semantics and avoid hiding valid notifications. Handoff detailed cause,
file/line evidence, exact proposed reproduction command/expected result and
smallest fix scope, uncertainties, report lease released. Root assigns any repair
only after reviewing cause and user impact.

## C1 — desktop bridge header regression diagnosis

Tier1 `gpt-6.1-terra`, `xhigh`, `/root/site_integration`. Sole writable report
`docs/investigations/2026-10-28-bridge-header-ci.md`; app/tests read-only initially.
Shared checkout and no-revert rule apply. Root owns E2E/provider/runtime/Git for now.
No tests needing browser/server/DB, installs, Git mutations or source edits.

CI run40702236812, job122864818824, HEAD678c716 failed only
`e2e/tests/session-needs-attention.spec.ts:27` desktop manual attention shortcuts:
line156 bridgeHeader.boundingBox().height expected<52, got59. Other60 passed,2
existing skips; builds/units passed. Node24.22.1, ubuntu-latest, Chromium; workflow
`.github/workflows/e2e.yml`. Failure log private commonGit agent-receipts/pr150-e2e-failed.log.

Use Semble for discovery then direct exact reads. Trace SessionList bridge header
row and new Updates More44px button versus existing vertical padding. Preserve
compact desktop header<52, desktop font11px, allnew/old mobile touch areas and
new More button>=44px at both widths. Do not weaken old/new E2E assertions or add
retries. Root reproduces exact failing browser test before implementation.

Record debug hypotheses (layout logic vs viewport/breakpoint vs async/data artifact),
evidence and proposed precise minimal CSS scope. Read debugskill requirements;
report root-cause status only when actual evidence sufficient, root supplies
rendered reproduction. Suggest a scoped real geometry probe if fullfixtureexpensive.
Handoff exact classes/files, computed expected geometry, negative/regression checks,
no interfacechange, report lease release. Root then grants repair files after proof.

## C1 repair authorization after isolated reproduction

Root reproduced the untouched exact desktop test on fresh isolated Linux
`bx_7affq75a` at2026-10-28T16:41UTC, Node24.22.1/npm11.19.1, source678c716:
`cd e2e && npx playwright test tests/session-needs-attention.spec.ts --grep
"navigate on desktop"` fails line156 Expected<52 Received59 in2.1s.
Logs `/home/user/pr150-repair-evidence/red-desktop-e2e.log` and original CI agree.
Fresh DB/HOME/registry state reproduces, excluding CI-only viewport/state causes.
The already verified real action target44 plus unconditional inline padding7+7
and expanded border1 impose a59px lower bound irrespective of single-line version
text. This adjacent-cause/fresh-environment falsification supports H1; do not claim
a DOM counterfactual measurement that was not run. Root will verify actual51px
postfix via the unchanged threshold and rendered view.

Same Tier1 Terra/xhigh `/root/site_integration` now owns only
`ui/src/components/SessionList.tsx` and its C1 investigation report. First complete
the debug log gate (proven/rejected evidence, bounded5Whys and falsification), then
replace the bridge-header inline all-sides padding with paddingInline9 and
`py-[7px] md:py-[3px]`; preserve exact existing breakpoints, all44px targets and
drag borders/fonts/actions. Expanded normal desktop51, collapsed50; mobile59.
No interface changes, no othersource/tests changes. Existing failing E2E is the
regression test; root runs desktop/mobile attention plus bridge-updates afterfix.
Run scoped SessionList/menu unit tests and UI no-emit only. No E2E/build servers,
Git, installs or source outsideownership. Otherssharecheckout/no reverts.
Handoff exactfiles, checks/results, remainingissues, releaseleases. Root then
owns productionbuild/browser validation; independentreview and landing follow.

## V2 — independent bounded UI repair review

Tier1 `gpt-6.1-terra` / `xhigh`, native `/root/header_review`. Source read-only; sole
writable `docs/investigations/2026-10-28-bridge-header-review.md`. C1 handed off and
stopped writing. Others share checkout; never revert or edit outside this report.
No dependency installs, Git mutations, tests, runtime, browser, servers, DB or CI.

Review the two-line SessionList bridge-row padding change relative to HEAD678c716,
C1 investigation and unchanged attention/update E2E geometry assertions. Contract:
normal desktop expanded header<52 and font11, More>=44x44 both widths; mobile
320/390 retains >=52 row and >=44 controls without overflow. Check md breakpoint,
inline style precedence, drag borders and menu/focus behavior remain sound. No
shared interface changes. Root reproduced exact original59px failure in isolated
Linux and owns post-fix production build and focused browser checks. Worker C1
passed25 scoped tests and UI typecheck. Do not claim root checks passed before
evidence arrives. Return concise accept/blockers with exactline/reason, any concrete
missing check; report lease released. No broad redesign or unrelated mail changes.

## L2 — publish the verified CI repair

Tier1 `gpt-6.1-terra` / `xhigh`, same `/root/site_integration`. All source/report
writers stopped; review accepted; root exactred then5 focusedgreen E2E passed and
UI production build passed. Root supplies rendered approval before dispatch.
Exclusive Git/index/history/push/PR lease in the shared feature checkout. Writable
coordination only this brief and C1 investigation if a final landing note is needed.
No app/test changes, runtime, installations, E2E or CI reruns. Others share checkout;
preserve existing dirty originalworktrees/stashes and unrelated files.

Stage exactly SessionList.tsx plus the four new dated CI/mail investigation/brief/
review documents from this repair. No secrets/runtime artifacts/private receipts.
Inspect staged diff/check, preserve hooks, commit and push to existing
feat/bridge-update-flow/PR150. No version bump for this UI-only source fix. Update
PR body to mention the CI59px failure, desktop-only padding correction, unchanged
assertions, exact isolated red and5 focusedgreen,25 scopedunit/typecheck/build.
Mail work is diagnosis only: installed0.19.55 predates #149, screenshotorigin
unconfirmed; do not claim mail bug fixed by this commit or promise zero admitted
wake races. No merge/packagepublication/usernotifications. Automatic CI is allowed
from push; root alone monitors/troubleshoots/reruns. Handoff SHA, URL, clean status,
checks, preserved unrelatedstate and released Git/file leases.
