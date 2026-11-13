---
type: investigation
symptom: "Isolated-stack e2e verification of feat/inbox-durable@863f5e4 (SPEC-C side-pane rework) left unfinished: step2 28 pass/3 fail, step3 82 pass/12 fail/3 skip — 5 distinct tests failing deterministically x3 — plus PR #201 direct-transport-e2e FAILURE on run 43222973630"
slug: inbox-sidepane-e2e-failures
date: 2026-11-12T12:38:15-03:00
investigator: Foad Kesheh
git_commit: 863f5e4
branch: feat/inbox-durable
repository: fmktech/ftown
status: root-cause-proven
hypotheses_formed: 22
hypotheses_rejected: 16
hypotheses_proven: 6
related: docs/investigations/2026-10-27-local-rerun-ci.md
---

# Inbox side-pane e2e failures (feat/inbox-durable@863f5e4) and PR #201

No source-code edits, test runs, service start/stop, or commits were made for this log. Every
file:line below was opened by the investigator; where a prior coordinator summary gave a wrong
line, the corrected line is used and the correction is flagged inline and in the return summary.

## Symptom

### Observed

Isolated-stack e2e verification of `feat/inbox-durable@863f5e4` (SPEC-C side-pane rework) was
left unfinished by a prior coordinator. Two recorded runs exist (see Reproduction):

- step2 (`../inbox-logs/step2.log`, 31 tests = 10 distinct + setup, `--repeat-each=3` shape):
  **28 passed / 3 failed**. All 3 failures are the same test x3:
  `tests/session-inbox.spec.ts:362:1 › preview showing switches to the waiting item, file back, reply returns to file`.
- step3 (`../inbox-logs/step3.log`, 97 tests): **82 passed / 12 failed / 3 skipped**. The 12
  failures are 4 distinct tests x3:
  `session-needs-attention.spec.ts:14:5` (mobile only), `session-preview.spec.ts:583:1`,
  `session-tools.spec.ts:141:3` (desktop), `session-tools.spec.ts:141:3` (mobile).
- Together: **5 distinct tests failing deterministically x3** (F1–F5 below).
- Separately, PR #201 (`perf/bridge-idle-cost`, worktree `wt-bridge-perf@1e45845`) has CI check
  `direct-transport-e2e` FAILURE on run `43222973630`, whose only failing unit test is claimed
  to be `answer liveness` (`bridge/src/attention-store.test.ts:532`, assertion at `:536`).

Verbatim log excerpts (ANSI stripped; wording unchanged):

step2, F1 (identical x3, only the stamp differs):

```
Running 31 tests using 1 worker
  ✘  11 [chromium] › tests/session-inbox.spec.ts:362:1 › preview showing switches to the waiting item, file back, reply returns to file (37.4s)
    Error: expect(locator).toBeVisible() failed
    Locator:  locator('iframe[title="Preview: a.html"]').contentFrame().locator('text=Pane mwdkm8tm').first()
    Expected: visible
    Received: hidden
    Timeout:  30000ms
      - waiting for locator('iframe[title="Preview: a.html"]').contentFrame().locator('text=Pane mwdkm8tm').first()
        61 × locator resolved to <title>Pane mwdkm8tm v1</title>
           - unexpected value "hidden"
  3 failed
  28 passed (5.3m)
```

step3 tail:

```
  12 failed
    [chromium] › tests/session-needs-attention.spec.ts:14:5 › mobile attention controls › manual notices retain originals and navigate on mobile (x3)
    [chromium] › tests/session-preview.spec.ts:583:1 › five or more files use a native select to switch the preview (x3)
    [chromium] › tests/session-tools.spec.ts:141:3 › desktop session tools › agent CLI attention and session PR association on desktop (x3, interleaved)
    [chromium] › tests/session-tools.spec.ts:141:3 › mobile session tools › agent CLI attention and session PR association on mobile (x3, interleaved)
  3 skipped
  82 passed (13.2m)
```

### Expected

Per `../viewer-inbox/SPEC-C-sidepane.md` + `SPEC-A-preview.md` (as superseded by SPEC-C) and
`../viewer-inbox/COMMON.md` gate: the named e2e specs pass on the isolated stack; SPEC-C's own
new e2e scenarios (side-pane switch, file-back, reply-returns-to-file; mobile Waiting landing)
pass; pre-existing specs pass except where SPEC-C deliberately changes the encoded behaviour,
in which case the spec test is updated in the same branch (COMMON.md: "Update existing tests
that encode the old behavior … instead of deleting them").

### Delta

5 distinct tests fail deterministically (x3 each) at HEAD `863f5e4` (verified:
`git -C wt-inbox rev-parse HEAD` → `863f5e4e70723edb22afa4e84eb8db41e974bbce`, branch
`feat/inbox-durable`). The failures are not one bug: they split into three stale-test
(SPEC-BUG) groups, one product bug, one pre-branch terminal flake signature, plus the
unrelated PR #201 timing flake. Each group is proven separately below.

## Reproduction

The recorded runs are the reproduction record. Deterministic x3 counts as the repro: each of
the 5 distinct tests failed all 3 repeats with the same assertion (F5/mobile has one repeat
that progressed one assertion further — see F5 — which is itself evidence of the claimed race).

Run headers prove the tree under test:

```
[run-env] pwd=/private/tmp/claude-501/-Users-fkesheh-projects-ftown/99a20ec3-eacc-48b8-849e-8dba56f1eaba/scratchpad/wt-inbox/e2e head=863f5e4
```

(identical first line in both `step2.log` and `step3.log`).

Exact rerun commands (from the logs' working directory `wt-inbox/e2e`, the isolated stack per
`e2e/README.md`/`e2e/env.sh` and COMMON.md's safety rules — isolated stack only, own
`.bridge-home`, never production). The logs themselves do not record the literal invocation;
the commands below reconstruct it from the run shape (31 = setup + 10 tests x3; 97-test suite
run) and COMMON.md gate item 3. **Rerun happens after fixes** — this log runs nothing:

```bash
# step2 equivalent (inbox spec only, x3):
cd wt-inbox/e2e && npx playwright test tests/session-inbox.spec.ts --project=chromium --repeat-each=3
# step3 equivalent (full recorded suite):
cd wt-inbox/e2e && npx playwright test --project=chromium --repeat-each=3   # subset recorded: 97 tests
# per-group discriminators after fixes:
cd wt-inbox/e2e && npx playwright test tests/session-preview.spec.ts tests/session-tools.spec.ts tests/session-needs-attention.spec.ts --project=chromium --repeat-each=3
```

Supporting artifacts opened: `../inbox-logs/step2-results/` (F1 `error-context.md`),
`wt-inbox/e2e/test-results/` (`error-context.md` for F2/F3/F4/F5), specs in
`../viewer-inbox/SPEC-C-sidepane.md` + `SPEC-A-preview.md`.

---

## F1 — `session-inbox.spec.ts:362` preview marker resolves to `<title>` (SPEC-BUG)

### H-F1.1 (observation/test-artifact) — `text=Pane ${stamp}`.first() hits the iframe `<title>`, which is always hidden

- **Prediction:** The fixture HTML puts the marker in both `<title>` and `<h1>`; Playwright's
  `text=` engine matches `<title>` first in document order; `<title>` is never visible, so
  `toBeVisible` times out even though the preview rendered. The error-context accessibility
  snapshot will show the `<h1>` present.
- **Verification method:** Open the fixture helper, the spec lines, `step2.log`, and the
  step2-results `error-context.md`.
- **Evidence:**
  - Fixture (correction to prior summary: the file is `e2e/helpers/session-preview.ts`, not a
    bare `session-preview.ts`; line 199–200):
    ```
    199: export function previewSimpleHtml(marker: string, version: number): string {
    200:   return `<!doctype html><html><head><title>${marker} v${version}</title></head><body><h1>${marker} version ${version}</h1><p>Simple HTML</p></body></html>`;
    ```
  - Spec `e2e/tests/session-inbox.spec.ts`:
    ```
    370:     await writeFile(join(fixture.directory, "a.html"), previewSimpleHtml(`Pane ${stamp}`, 1), "utf8");
    376:     const iframe = page.frameLocator('iframe[title="Preview: a.html"]');
    377:     await expect(iframe.locator(`text=Pane ${stamp}`).first()).toBeVisible({ timeout: 30_000 });
    ```
    The same locator recurs at `:388`, `:393`, `:406` (all opened).
  - `step2.log` (verbatim, x3): `61 × locator resolved to <title>Pane mwdkm8tm v1</title>` /
    `unexpected value "hidden"`; stamps `mwdkm8tm`, `mwdkohgt`, `mwdkqpel`.
  - `step2-results/session-inbox-preview-show-e57c6--back-reply-returns-to-file-chromium/error-context.md`
    accessibility snapshot of the frame:
    ```
    - heading "Pane mwdkm8tm version 1" [level=1]
    - paragraph: Simple HTML
    ```
- **Verdict: PROVEN.** Rationale: marker is in `<title>` (first match, hidden by definition)
  and `<h1>` (rendered, per snapshot). The test never reaches the SPEC-C behaviour it exists
  to verify (pane switch at `:380` onward).

### H-F1.2 (code-logic, product) — SPEC-C side pane fails to show the preview file at all

- **Prediction:** If the product failed to render the preview, the frame snapshot would lack
  the heading and the locator would resolve to nothing (element(s) not found), not to `<title>`.
- **Verification method:** Same error-context snapshot + call log as H-F1.1.
- **Evidence:** Locator resolved 61× (to `<title>`); snapshot shows heading + paragraph
  rendered inside the frame.
- **Verdict: REJECTED.** The preview product path rendered; only the locator is wrong.

### H-F1.3 (config-env/tooling) — isolated-stack/bridge failure prevented preview registration

- **Prediction:** Registration failure would fail earlier (`fixture.register` asserts CLI exit
  0 and response shape, `helpers/session-preview.ts:138-143`) or the row/iframe would never
  appear; other preview tests in step3 would fail the same way.
- **Verification method:** step2 log ordering (failure is at `:377`, after register + row
  click); step3 preview results (only the 5-file select test fails; other preview tests pass).
- **Evidence:** step2 failure stack is at `session-inbox.spec.ts:377:64`, past `:372`
  `await fixture.register(id, "a.html")` and `:375 await row.click()`.
- **Verdict: REJECTED.**

### 5 Whys (F1)

1. Why does the test time out? `.first()` is the `<title>` element, which is hidden.
2. Why does the marker exist in `<title>`? `previewSimpleHtml` (shared helper) puts
   `${marker} v${version}` in `<title>` and `${marker} version ${version}` in `<h1>`.
3. Why did the new SPEC-C test use a bare `text=` locator? It copied a "marker visible"
   idiom without scoping to body/heading, unlike `session-preview.spec.ts` which polls
   `body.querySelector("h1")` via `inPreviewFrame` (`:622`).
4. Why wasn't this caught before the x3 run? SPEC-C's gate for the implementing worker was
   `tsc` in e2e only ("do NOT run the stack or playwright (I run them)" — SPEC-C Tests
   section); first execution was this verification run.
   → Root (process): new e2e locators against a dual-location fixture marker were never
   executed before the gate run; the discriminating fix is a body-scoped locator.

### Falsification attempt (F1)

Absence/adjacent-cause: if `<title>` matching were not the cause, removing the title text (or
scoping to `h1`) would not change the outcome; but the call log names the exact resolved
element (`<title>Pane … v1</title>`) 61 times and the snapshot independently shows the `h1`
rendered — two independent artifacts agree. Adjacent cause "iframe not loaded yet" is excluded
because the locator *resolved* (to title) rather than waiting for an element.

---

## F2 — `session-needs-attention` mobile: blank `.xterm-rows`, `[lost tty]` (KNOWN-FLAKE signature, pre-branch; root-cause identity NOT proven)

Honest scoping: what is proven here is narrower than "same root cause as main". See H-F2.1.

### H-F2.1 (state-data/tooling, scoped) — failure occurs before any branch (SPEC-C) behaviour runs: fresh mobile session's terminal never prints a prompt

- **Prediction:** The failing assertion is the *first* terminal interaction, before any
  attention hook exists; the desktop twin (same test body) passes; the page snapshot shows a
  terminal with `[lost tty]` and no selected-session content.
- **Verification method:** Open `session-needs-attention.spec.ts`, `helpers/app.ts` (via log
  stack), step3 log, and `e2e/test-results/session-needs-attention-mo-46bc4-…/error-context.md`.
- **Evidence:**
  - Spec flow (`e2e/tests/session-needs-attention.spec.ts`):
    ```
    28:         await workspace(); await expect(originalRow(page, firstName)).toBeVisible({ timeout: 30_000 }); await originalRow(page, firstName).click();
    29:         const marker = `REQUESTED${suffix}`; await runMarkerInTerminal(page, marker); …
    ```
    No `postHook`/attention call happens until `:30` (`Stop` on idle) and `:32-33`
    (`agent_needs_input`) — i.e. after the failing line. SPEC-C behaviour (side pane, C1
    no-auto-resolve) cannot have run yet.
  - step3 log (verbatim, x3):
    ```
    Error: expect(locator).toContainText(expected) failed
    Locator: locator('.xterm-rows').first()
    Expected pattern: /[$%#>]/
    Received string:  "                               "
        at ../helpers/app.ts:109
      > 109 |   await expect(rows).toContainText(/[$%#>]/, { timeout: 30_000 });
        at …/e2e/tests/session-needs-attention.spec.ts:29:46
    ```
  - error-context page snapshot (verbatim fragments): `tab "Terminal" [selected]`,
    `textbox "Terminal input"`, `generic: "[lost tty]"`,
    `paragraph: No session selected`, `region "Session workspace: Session"`.
  - Desktop twin passed x3 in the same run: step3 lines for
    `desktop attention controls › manual notices retain originals and navigate on desktop (3.2s / 3.4s / 3.8s)` — all `✓`.
- **Verdict: PROVEN (scoped).** Rationale: the failure precedes every SPEC-C code path the
  test later exercises, and the identical test body passes on desktop x3. What is **not**
  proven: that the underlying terminal-blanking mechanism is identical to the one in the
  related investigation (see H-F2.3) — signature match is not identity proof.

### H-F2.2 (code-logic, product) — SPEC-C regression breaks mobile session selection/terminal attach

- **Prediction:** If SPEC-C broke selection, the click at `:28` would not land on the
  terminal tab / workspace would not mount, and other mobile selection tests (e.g.
  `session-inbox.spec.ts:304` phone Waiting landing, `:339` mobile tab) would fail too.
- **Verification method:** error-context snapshot + step2/step3 pass list.
- **Evidence:** Snapshot shows `tab "Terminal" [selected]` and a mounted
  `region "Session workspace: …"` with `textbox "Terminal input"` — selection/navigation
  machinery ran; the terminal content is blank/`[lost tty]`. In step2, mobile inbox tests
  `:304` and `:339` passed x3; in step3 the desktop twin of this very test passed x3.
  (Correction/nuance vs prior summary: the snapshot's workspace is labelled
  `Session workspace: Session` with `No session selected` text present alongside the terminal
  textbox — so "selection proven worked via trace aria-label" is **not** corroborated by the
  error-context snapshot alone; the trace.zip was not opened for this log. The rejection
  rests on ordering (failure before branch behaviour) + desktop/mobile neighbours passing,
  not on a trace aria-label claim.)
- **Verdict: REJECTED** (as a SPEC-C regression explanation).

### H-F2.3 (observation) — root-cause identity with the documented main-branch blank-terminal defect

- **Prediction:** If identical, the documented signature (`runMarkerInTerminal` waits 30s for
  `/[$%#>]/`, `.xterm-rows` blank, literal `[lost tty]` frame) matches this failure exactly.
- **Verification method:** Open `docs/investigations/2026-10-27-local-rerun-ci.md` at the
  cited lines.
- **Evidence:**
  - `:23`: "runMarkerInTerminal waits30seconds for /[$%#>]/ but .xterm-rows stays blank"
    (CI40515139967, on the pre-branch code line `codex/navigation-consolidation`, commit
    `87549bc…` per its frontmatter).
  - `:136`: "-Frame489540 contains literal `[lost tty]`; frame489607 is blank…".
  - `:18`: that report's own scope note — its proven defect "did not resolve early prompt
    erasure" and "the real browser/CI regression must still pass before declaring the
    original failure resolved" — i.e. the blanking mechanism was left not fully proven there
    either.
- **Verdict: REJECTED as proven identity; retained as signature match.** Same observable
  signature on a pre-branch commit proves the failure mode predates this branch; it does not
  prove the same mechanism (geometry/repaint vs lost-tty vs attach race) fired here. No
  terminal bytes/bridge screen are in these artifacts to discriminate (cf. that report
  `:141`).

### H-F2.4 (config-env) — mobile viewport/touch config in this branch's test harness broke the terminal

- **Prediction:** A harness/config change would affect all mobile terminal tests, not one.
- **Verification method:** step2/step3 mobile pass list.
- **Evidence:** step2 mobile tests (`session-inbox` mobile x3, `:304`, `:339`) passed; step3
  has 82 passes including other mobile-viewport tests. Only this test's *first* prompt wait
  fails, x3, while its desktop twin passes x3.
- **Verdict: REJECTED.**

### 5 Whys (F2)

1. Why does the mobile test fail? `.xterm-rows` never contains a shell prompt within 30s.
2. Why is it blank? Snapshot shows `[lost tty]` and blank rows — the attached terminal
   produced no prompt paint for the selected fresh session.
3. Why only mobile here? Unknown from these artifacts; desktop twin (same body, larger
   viewport/geometry) passes x3 — consistent with the geometry/attach-sensitive blanking
   family documented pre-branch, not proven identical.
4. Why is it in this branch's failure list at all? The verification run swept the full suite;
   the test was updated for C1 (`:44` comment) but fails at `:29`, before the updated part.
   → Root (process/architecture): a pre-existing, not-yet-root-caused terminal-blanking
   mode in the shared stack; this branch neither introduced nor can fix it on this evidence.

### Falsification attempt (F2)

Isolation: desktop twin = same test body, same run, same stack → passes x3; the only
difference is viewport/touch. Absence: with no attention item in existence at `:29`, removing
all SPEC-C behaviour cannot change this assertion. Adjacent cause "session creation failed"
is rejected because `:24-25` asserts HTTP 201 + truthy id for all three sessions before `:28`.

---

## F3 — `session-preview.spec.ts:583` expects a combobox at 5 files (SPEC-BUG)

### H-F3.1 (observation/test-artifact) — test still encodes the old SPEC-A boundary; product implements SPEC-C's entry-count boundary

- **Prediction:** SPEC-A says tablist up to 4 files, select above that; SPEC-C redefines the
  selector over *entries* (attention 0/1 + files) with tablist for 2–5 entries. At 5 files
  and no attention entry, SPEC-C product shows a 5-tab tablist, while the un-updated test
  demands a combobox. The error-context will show the tablist with all 5 files.
- **Verification method:** Open SPEC-A, SPEC-C, `SessionWorkspace.tsx` selector code, the
  spec test, step3 log, F3 error-context.
- **Evidence:**
  - SPEC-A (old rule), `../viewer-inbox/SPEC-A-preview.md:59`:
    "- Selector in the preview toolbar of `SessionWorkspace.tsx`, shown only when the set has
    ≥ 2 files: up to 4 files → a `role="tablist"` …; more → a native `<select aria-label="Preview file">`."
  - SPEC-C (new rule; correction to prior summary: the toolbar-selector bullet is `:39`, not
    `:38` — `:38` is "View shown in the pane…"), `SPEC-C-sidepane.md:39`:
    "Entries = attention (0/1) + files. 1 entry → plain label …; 2–5 entries → the
    `role="tablist"` …; more → the native `<select>` with the attention option first."
  - Product, `ui/src/components/SessionWorkspace.tsx` (correction: tablist branch condition
    is `:247`, the `<div role="tablist">` is `:248`):
    ```
    240:   const entryCount = slotFiles.length + (attention ? 1 : 0);
    247:     ) : entryCount <= 5 ? (
    248:       <div role="tablist" aria-label={selectorName} className="session-preview-file-tablist" onKeyDown={fileTabKeys}>
    264:     ) : (
    265:       <select
    ```
    With 5 files, no attention: `entryCount = 5` → tablist. That is SPEC-C conformant.
  - Test, `e2e/tests/session-preview.spec.ts` (failure line is `:618`; `:583` is the test
    declaration, `:590-592` builds exactly 5 files, `:617` defines the locator):
    ```
    583: test("five or more files use a native select to switch the preview", …
    590:   const htmlFiles = ["one.html", "two.html", "three.html", "four.html"];
    592:   const files = [...htmlFiles, mdName];   // 5 files
    617:     const select = page.getByRole("combobox", { name: "Preview file" });
    618:     await expect(select).toBeVisible({ timeout: 15_000 });
    619:     await expect(page.getByRole("tablist", { name: "Preview file" })).toHaveCount(0);
    ```
  - step3 log (verbatim, x3): `Locator: getByRole('combobox', { name: 'Preview file' })` /
    `Error: element(s) not found` at `session-preview.spec.ts:618:26`.
  - F3 error-context snapshot shows exactly the SPEC-C rendering:
    ```
    - tablist "Preview file":
      - tab "one.html" [selected]
      - tab "two.html"
      - tab "three.html"
      - tab "four.html"
      - tab "notes.md"
    ```
- **Verdict: PROVEN.** Test encodes SPEC-A's superseded boundary (select at 5 files);
  product encodes SPEC-C's (tablist through 5 entries). SPEC-C's Tests section required UI
  selector tests at "1 / 2–5 / 6+", confirming 5 = tablist is intended.

### H-F3.2 (code-logic, product) — product regressed: 5+ files should still be a native select

- **Prediction:** If product were wrong, SPEC-C would still state the SPEC-A boundary.
- **Verification method:** SPEC-C:39 vs SPEC-A:59 (above); SPEC-C header says it "SUPERSEDES
  Spec B6 and changes the B2 table" and the branch "now CONTAINS the preview feature".
- **Evidence:** SPEC-C:39 explicitly redefines the boundary over entries including the
  attention slot. Product matches it arithmetically at `SessionWorkspace.tsx:240,247`.
- **Verdict: REJECTED.**

### H-F3.3 (state-data) — a phantom attention entry inflated/deflated the count in this run

- **Prediction:** With an attention entry, the selector name would be "Side pane view"
  (`SessionWorkspace.tsx:241`) and a "Waiting for you" tab would appear first.
- **Verification method:** F3 error-context snapshot.
- **Evidence:** Snapshot tablist is named "Preview file" with exactly the 5 file tabs, no
  attention tab; sidebar shows `button "Inbox, 0 messages"`. Count is purely 5 files.
- **Verdict: REJECTED.**

### 5 Whys (F3)

1. Why no combobox? Product renders a tablist at `entryCount = 5`.
2. Why tablist at 5? SPEC-C:39 moved the boundary from files (SPEC-A:59, tablist ≤4) to
   entries (tablist 2–5) to make room for the attention slot.
3. Why does the test still expect a select at 5? The SPEC-C work updated the UI selector and
   its unit tests but not this e2e boundary test, whose title ("five or more files…") is
   itself the old rule.
4. Why missed? SPEC-C's e2e instructions list `session-inbox.spec.ts` edits only; nobody
   re-derived `session-preview.spec.ts` boundaries from the new entry-count rule, and the
   implementing gate was e2e `tsc`, not execution.
   → Root (process): a boundary-changing spec did not enumerate the existing e2e boundary
   test as encoding the old behaviour (COMMON.md requires updating, not deleting, such tests).

### Falsification attempt (F3)

Adjacent-cause: at 6 files the product *would* render the select (`entryCount <= 5` false →
`:265 <select>`), so the test's later `selectOption` flow is testing a real product mode —
just at the wrong file count. Increasing the fixture to 6 files (or 5 files + attention =
6 entries) discriminates: H-F3.1 predicts pass; a product-bug hypothesis predicts the select
is broken at every count. The snapshot's working 5-tab tablist already excludes "selector
broken".

---

## F4 — `session-tools.spec.ts` desktop: PR-review tabpanel never selected (PRODUCT-BUG)

### H-F4.1 (code-logic, product) — unguarded attention effects overwrite the review activation in the same commit

- **Prediction:** Opening PR review for a session that also has a shown waiting item sets
  `auxTab='review'` (review effect) and then, in the same commit, the SPEC-C attention
  effects set `auxTab='preview'` unconditionally (desktop only), so the Waiting panel stays
  selected and no `tabpanel "PR review"` exists. Mobile is unaffected because both
  attention effects are gated on `isDesktop` and mobile tab state lives in Dashboard.
- **Verification method:** Open `SessionWorkspace.tsx` effects in source order, the spec at
  the failing lines, step3 log, F4 desktop error-context.
- **Evidence:**
  - Product, `ui/src/components/SessionWorkspace.tsx` (all opened; note source order —
    effects run in order within a commit):
    ```
    158:     if (previewId && !reviewOpen) { setCompactTab('preview'); setAuxTab('preview'); setConversationOpen(false); }
    160:   useEffect(() => { if (reviewOpen && reviewActivation) { setCompactTab('review'); setAuxTab('review'); } }, [reviewOpen, reviewActivation]);
    170:   const shownKey = attention?.shown ? `${sessionKey}|${inboxItemKey(attention.entry)}` : null;
    172:   useEffect(() => {
    175:     if (shownKey && shownKey !== previous && isDesktop) { setCompactTab('preview'); setAuxTab('preview'); }
    176:   }, [shownKey, isDesktop]);
    178:   useEffect(() => {
    179:     if (sessionActivation && isDesktop && attentionShown) { setCompactTab('preview'); setAuxTab('preview'); }
    182:   }, [sessionActivation]);
    ```
    (Prior summary cited `:171-177` / `:178-182`; opened lines: first effect body `:172-176`
    with `previousShownKey` ref at `:171`, second effect `:178-182` — substantively correct.)
    Crucially `:158` already guards `!reviewOpen`; neither `:175` nor `:179` does. The test's
    entry points both *select the session* (bumping `sessionActivation` via
    `Dashboard.tsx:577 setSessionActivation(count => count + 1)` inside
    `handleSelectSession`, called by `handleReviewPullRequest` at `Dashboard.tsx:594`)
    and activate review (`:595`) together — so `:179` fires in the same commit as `:160`
    and wins by source order.
  - Test, `e2e/tests/session-tools.spec.ts` (failing assertion is `:352`; prior summary's
    ":350 desktop" is the `Enter` press):
    ```
    350:       await page.keyboard.press("Enter");
    351:       const reviewPanel = page.getByRole("tabpanel", { name: "PR review" });
    352:       await expect(reviewPanel).toBeVisible();
    ```
    Comment at `:331-332`: "Both entry points select the requesting session and open its
    review without resolving the independent attention request." — i.e. the session under
    test *has* a live attention item by design.
  - step3 log (verbatim, desktop x3): `Locator: getByRole('tabpanel', { name: 'PR review' })`
    / `Error: element(s) not found` at `session-tools.spec.ts:352:33`.
  - F4 desktop error-context snapshot (verbatim fragments) — the smoking gun:
    ```
    - tablist "Auxiliary view":
      - tab "Waiting" [selected]
      - tab "PR review"
    - tabpanel "Waiting":
      - region "Waiting for you":
        - paragraph: PR review requested
        - paragraph: Please inspect the associated pull request before I continue.
    ```
    Review *is* open (its tab exists) but the Waiting panel is selected — exactly the
    overwrite prediction, not a failure to open review.
- **Verdict: PROVEN.** Product bug: SPEC-C's "bring the slot forward" effects lack the
  `!reviewOpen` guard their sibling at `:158` already has.

### H-F4.2 (observation/test-artifact) — stale test: SPEC-C intends Waiting to win over PR review

- **Prediction:** If intended, SPEC-C would state attention precedence over an explicitly
  opened review; the mobile path would behave the same.
- **Verification method:** SPEC-C text; mobile behaviour in step3.
- **Evidence:** SPEC-C:44 precedence language is only about the compact/mobile tab switch
  "when `attentionShown` becomes true … and the current tab is the terminal tab" — nothing
  overrides an explicit Review action, and nothing mentions desktop aux-tab precedence over
  review. On mobile the same test *passes* `:352` (its failures are at `:420`/`:421`, see
  F5) — so the product's own mobile path treats explicit review as winning. (Scope
  correction to prior summary: "mobile twin passes :352" is true for that assertion; the
  mobile *test* as a whole fails later — it is F5, not a pass.)
- **Verdict: REJECTED.**

### H-F4.3 (state-data) — PR association data missing, so review never opens

- **Prediction:** No `PR review` tab would exist; earlier badge/link assertions would fail.
- **Verification method:** F4 snapshot + step3 ordering (failure is at `:352`, after badge
  focus/Enter at `:348-350` passed).
- **Evidence:** Snapshot shows `tab "PR review"` present (unselected) and
  `button "Review pull request: PR #456 in fmktech/ftown…"` in the sidebar. Review opened;
  selection was stolen.
- **Verdict: REJECTED.**

### H-F4.4 (tooling) — keyboard Enter on the badge never triggered (focus flake)

- **Prediction:** Intermittent across repeats and no review tab in the snapshot.
- **Verification method:** x3 determinism + snapshot.
- **Evidence:** Desktop fails identically x3 with the review tab present and Waiting
  selected each time (error-contexts in `…-desktop-chromium`, `-repeat1`, `-repeat2`).
- **Verdict: REJECTED.**

### 5 Whys (F4)

1. Why is there no PR-review tabpanel? `auxTab` ends as `'preview'` (Waiting), not `'review'`.
2. Why? Effects at `:175`/`:179` run after `:160` in the same commit and unconditionally
   `setAuxTab('preview')`.
3. Why do they fire on Review? Review entry points select the session
   (`sessionActivation` bump, `Dashboard.tsx:594,577`) for a session whose waiting item is
   shown (`attentionShown`) — precisely `:179`'s trigger condition.
4. Why no guard? SPEC-C added these effects mirroring the preview auto-switch but omitted
   the `!reviewOpen` guard the preview effect at `:158` already carries; no unit test
   combined "shown item + review activation in one commit" on desktop.
   → Root (architecture): three independent effects write the same `auxTab` state with
   precedence defined only by source order; the newest writers don't know about review.

### Falsification attempt (F4)

Isolation: mobile — same test, same commit pattern, but `:175`/`:179` are `isDesktop`-gated
and Dashboard sets `setMobileTab("review")` (`Dashboard.tsx:596`) — passes `:352` x3
(failures move to F5's later assertion), exactly as H-F4.1 predicts. Absence: sessions
without a shown item don't satisfy `:179` (`attentionShown` false) — H-F4.1 predicts review
works there; no contrary failure exists in step3. Adjacent cause "review activation counter
broken" is excluded by the snapshot: the PR-review tab exists, so `reviewOpen` became true.

---

## F5 — `session-tools.spec.ts:420` mobile: expects Terminal tab active after Inbox "Open session" (SPEC-BUG + small product cleanup)

### H-F5.1 (observation/test-artifact) — test encodes pre-SPEC-C landing (Terminal); SPEC-C lands a waiting session on Waiting

- **Prediction:** SPEC-C's entering-a-waiting-session rule lands mobile on the side-pane
  (Waiting) tab; the branch's own new inbox test already asserts that; the old
  session-tools assertion still demands Terminal.
- **Verification method:** SPEC-C:44, `session-inbox.spec.ts:29`, `session-tools.spec.ts:416-420`,
  `Dashboard.tsx` selection code, step3 log.
- **Evidence:**
  - SPEC-C `SPEC-C-sidepane.md:44`: "When `attentionShown` becomes true for the selected
    session (session selected, or new item while in it) and the current tab is the terminal
    tab, switch to that tab…" (the "Preview"/"Waiting" side-pane tab).
  - Branch's new rule already encoded, `e2e/tests/session-inbox.spec.ts:29`:
    ```
    if (viewport.name === "mobile") { await expect(page.getByRole("tab", { name: "Waiting", exact: true })).toHaveAttribute("aria-selected", "true"); … }
    ```
    — after the same Inbox "Open session" action (`:27`).
  - Stale assertion, `e2e/tests/session-tools.spec.ts`:
    ```
    416:       await shortcut.click();
    417:       await inboxEntry.getByRole("button", { name: "Open session", exact: true }).click();
    420:       if (mobile) await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toHaveClass(/mobile-tab-active/);
    ```
  - Product selection rule, `ui/src/components/Dashboard.tsx:584-586`:
    ```
    // Entering a session lands on its side pane when there is something in it: the waiting item first, else an open preview.
    const waiting = inboxRef.current.some(entry => entry.session.id === id);
    setMobileTab(waiting || … ? "preview" : "terminal");
    ```
  - step3 log (verbatim, mobile repeats 0 and 2):
    ```
    Locator: getByRole('tab', { name: 'Terminal', exact: true })
    Expected pattern: /mobile-tab-active/
    Received string:  "mobile-tab "
        34 × locator resolved to <button role="tab" tabindex="-1" class="mobile-tab " aria-selected="false" …>Terminal</button>
    ```
- **Verdict: PROVEN.** The session opened at `:417` has a waiting item (the test's whole
  setup), so SPEC-C landing is Waiting/`preview`, and Terminal is correctly unselected.

### H-F5.2 (code-logic, product) — landing is nondeterministic: `setMobileTab("terminal")` after `handleSelectSession` races the shown-attention effect

- **Prediction:** Inbox "Open session" both (a) selects the session (which sets
  `"preview"` when waiting) and (b) force-sets `"terminal"` immediately after; a later
  effect may flip terminal→preview only if its trigger still sees `mobileTab==="terminal"`
  and a *changed* shown-marker. Outcome depends on render/effect ordering, so repeats may
  diverge past `:420`.
- **Verification method:** Open `Dashboard.tsx:1271`, `:575-588`, `:605-613`; compare the
  three mobile repeats in step3.
- **Evidence:**
  ```
  1271: onOpenSession={id => { focusOpenedSessionRef.current = true; handleSelectSession(id); setMobileTab("terminal"); scheduleTerminalRenderAdjustment(); }}
  586:  setMobileTab(waiting || … ? "preview" : "terminal");   // inside handleSelectSession
  612:    if (shownAttention && shownAttention !== previous && !isDesktop && mobileTab === "terminal") setMobileTab("preview");
  ```
  (Prior summary cited the effect as `:610-614`; opened: effect `:609-613`, condition
  `:612`.) The `:1271` force-to-terminal contradicts `:586`'s waiting→preview in the same
  handler. Step3 corroborates nondeterminism: mobile repeats 0 and 2 fail at `:420`
  (Terminal not active — effect/selection won), while **repeat1 passes `:420` and fails one
  step later** at `tabIntoHeaderLink` (`session-tools.spec.ts:131`, via `:421`:
  `expect(locator).toBeFocused() failed … element(s) not found` for the PR header link) —
  consistent with landing in different tabs across repeats, changing what's focusable.
- **Verdict: PROVEN (as a contributing product defect, secondary to H-F5.1).** This is the
  one group with two proven clauses by design of the brief ("SPEC-BUG + small product
  cleanup"): the test is stale *and* `:1271` makes the landing racy. For the frontmatter
  counter, F5's single PROVEN slot is H-F5.1; H-F5.2 is recorded here as a proven
  contributing cause, not a second root — counters count it under formed/rejected as
  "rejected as *the* root cause" to keep exactly one PROVEN per group. (See Root Cause
  table note.)

### H-F5.3 (code-logic) — SPEC-C mobile auto-switch itself is the bug; Terminal landing is correct product intent

- **Prediction:** SPEC-C would keep "Open session → Terminal"; the new inbox test would
  assert Terminal.
- **Verification method:** SPEC-C:44 + `session-inbox.spec.ts:29,:323` (phone test asserts
  `Waiting` selected, `Preview` count 0).
- **Evidence:** Both the spec text and two branch tests encode Waiting landing; only the
  older session-tools line encodes Terminal. `git diff origin/main...HEAD --stat` shows
  `session-tools.spec.ts | 2 +-` on this branch — essentially untouched, i.e. pre-SPEC-C
  expectation carried over.
- **Verdict: REJECTED.**

### H-F5.4 (tooling) — `mobile-tab-active` class renamed/removed by SPEC-C styling

- **Prediction:** Class would be absent everywhere; tab would show a different active marker.
- **Verification method:** `Dashboard.tsx:1106` still emits
  `mobile-tab ${mobileTab === "terminal" ? "mobile-tab-active" : ""}` with
  `aria-selected={mobileTab === "terminal"}`; log shows `aria-selected="false"` — the tab
  genuinely isn't selected.
- **Evidence:** As above (opened `:1106-1112`).
- **Verdict: REJECTED.**

### 5 Whys (F5)

1. Why isn't Terminal active? The opened session is waiting, so selection lands on the
   side-pane (`preview`/Waiting) tab.
2. Why does it land there? SPEC-C:44 + `Dashboard.tsx:586` (waiting → `"preview"`).
3. Why does the test expect Terminal? It predates SPEC-C and was not in SPEC-C's e2e edit
   list; the branch's replacement expectation lives in `session-inbox.spec.ts:29`.
4. Why do repeats diverge (repeat1 past `:420`)? `Dashboard.tsx:1271` force-sets
   `"terminal"` right after `handleSelectSession` set `"preview"`, and the `:612` effect
   flips back only on a changed marker while on terminal — ordering-dependent.
   → Root (process + architecture): stale e2e expectation for a deliberately changed
   landing rule, compounded by two writers of `mobileTab` in one handler with opposite
   intents (the `:1271` override is a leftover of the pre-SPEC-C "Open session shows the
   terminal" behaviour).

### Falsification attempt (F5)

Adjacent-cause: if the opened session had *no* waiting item, H-F5.1 predicts Terminal active
(`:586` else-branch) and `:420` would pass — the test's own setup guarantees a waiting item
(shortcut/inboxEntry at `:411-417` require it), so the assertion as written can only pass via
the `:1271` race winning, which repeat1 demonstrates. That repeat divergence falsifies any
single-writer deterministic explanation and supports H-F5.2.

---

## PR201 — `answer liveness` failure on run 43222973630 (pre-existing timing flake; no edit in this branch)

Scope: PR #201 = `perf/bridge-idle-cost` (verified via `gh pr view 201`:
title "perf(bridge): cut idle cost (heartbeat, listing, terminal log, sealing)", state OPEN,
head `perf/bridge-idle-cost`; worktree `wt-bridge-perf@1e45845`). This investigation does
not dispatch anything; a separately dispatched re-run was only observed (see H-PR.1).

### H-PR.1 (tooling/timing) — 30 ms `waitForItem` can return at deadline before its poller (liveness) record is created, so `hasLiveWaiter` is false on a slow runner

- **Prediction:** In `waitForItem`, the poller/liveness record is created only *after* the
  first `await readItem` and only if the deadline hasn't already passed; with `waitMs=30`,
  a first read slower than ~30 ms returns the item without ever creating a poller, and the
  test's very next assertion `hasLiveWaiter(id) === true` fails. Failure probability rises
  with runner latency; the test passes when the first read is fast.
- **Verification method:** Open `wt-bridge-perf/bridge/src/attention-store.ts` `waitForItem`
  and `attention-store.test.ts:532-546`; check branch diff scope; check CI run states via
  `gh` (read-only).
- **Evidence:**
  - Test (`bridge/src/attention-store.test.ts`, opened):
    ```
    532: test('answer liveness: mail needs an active wait (no TTL), hook accepts a recent poll', async t => {
    535:   await f.store.waitForItem('s1', mail.id, 30);
    536:   assert.equal(f.store.hasLiveWaiter(mail.id), true);
    ```
  - Product (`bridge/src/attention-store.ts`, opened):
    ```
    451:   async waitForItem(id: string, eventId: string, waitMs: number, signal?: AbortSignal): Promise<AttentionItem> {
    468:         const item = await this.readItem(id, eventId);
    469:         if (item.resolvedAt || Date.now() >= deadline) return item;
    470:         if (!poller) {
    474:           poller = this.pollers.get(eventId) ?? { active: 0, lastPollAt: nowMs };
    475:           poller.active++; poller.lastPollAt = nowMs;
    ```
    So the liveness record (`pollers`, read by `hasLiveWaiter` at `:99`) exists only if the
    first `readItem` (lock + load from disk, `:443-449`) completes before `deadline =
    start + 30 ms`. On a loaded CI runner that is a genuine race, by construction.
  - Diff scope: `git -C wt-bridge-perf diff --stat origin/main...HEAD` — 29 files
    (centrifugo, direct-transport, mail-store, session-store, terminal-*, security sealing,
    …). **Neither `attention-store.ts` nor `attention-store.test.ts` appears.** The branch
    cannot have changed this test's behaviour; it can only have changed runner timing
    indirectly (more parallel load), which is the flake mechanism itself.
  - CI states observed read-only at investigation time: run `43222973630` attempt 2
    (the separately dispatched `--failed` re-run) was `in_progress`
    (`direct-transport-e2e` job started `2026-11-12T15:31:54Z`) — **not finished, so no
    re-run verdict is recorded here**. Prior runs `43161843323` and `42876344044` both show
    overall `conclusion: failure` with the single job `direct-transport-e2e failure`
    (correction to prior summary: those runs did **not** "pass" overall; the claimed
    103 ms / 306 ms vs 325 ms per-test timings were not corroborated from run logs in this
    investigation and are not relied on — the proof rests on the code-level race + diff
    scope, which need no timing numbers).
- **Verdict: PROVEN** (mechanism + pre-existence). The 30 ms wait vs first-read latency race
  is in code untouched by PR #201; the failing assertion is exactly the one the mechanism
  predicts (`:536 hasLiveWaiter === true`).

### H-PR.2 (code-logic) — PR #201's idle-cost changes broke attention liveness

- **Prediction:** The diff would touch `attention-store.ts`, its pollers/TTL, or shared
  timing it depends on.
- **Verification method:** Diff stat above (full 29-file list opened).
- **Evidence:** No attention file in the diff; nearest neighbours are mail/session stores,
  which `waitForItem`/`hasLiveWaiter` do not call (`readItem` → `withLock`+`load` inside
  `attention-store.ts` itself).
- **Verdict: REJECTED.**

### H-PR.3 (observation) — this is the documented "Unhide" flake

- **Prediction:** Same test/layer as the documented flake.
- **Verification method:** Open `../viewer-inbox/pr-perf.md:34` and
  `session-needs-attention.spec.ts:49-50`.
- **Evidence:** `pr-perf.md:34`: "All six failures are one known flake that also fails on
  `main` (`session-needs-attention.spec.ts:49`, "Unhide" menu item not stable)" — an e2e
  Playwright stability flake at the Hide/Unhide menu (`session-needs-attention.spec.ts:49-50`
  opened: Hidden/Unhide clicks). PR201's failure is a bridge *unit* test
  (`attention-store.test.ts:536`) run inside the `direct-transport-e2e` CI job — different
  test, different layer, different mechanism. Conflating them would mislabel a code-level
  timing race as a UI-stability flake.
- **Verdict: REJECTED.**

### H-PR.4 (config-env) — CI environment change (runner image/clock) broke a previously sound test

- **Prediction:** Test logic would be sound for any first-read latency; only environment
  changed.
- **Verification method:** Code reading (H-PR.1): for *any* environment, a first read ≥30 ms
  skips poller creation — the test is latency-sensitive by construction, environment only
  modulates probability.
- **Evidence:** `attention-store.ts:468-470` ordering. No environment makes the assertion
  guaranteed; fast local runs merely hide it (cf. `pr-perf.md:32`: local whole unit suite
  "1823 passed, 0 failed").
- **Verdict: REJECTED** as sole cause (environment is the trigger, the race is the cause).

### 5 Whys (PR201)

1. Why did `hasLiveWaiter` return false? No poller record existed for the item.
2. Why? `waitForItem(…, 30)` returned at the deadline check (`:469`) before reaching
   poller creation (`:470-477`).
3. Why did it hit the deadline first? The first `readItem` (lock + disk load) took ≥30 ms
   on that CI runner at that moment.
4. Why does the test assume otherwise? It uses a fixed 30 ms wait as a proxy for "a recent
   poll happened", assuming first-read ≪ 30 ms — true locally, not guaranteed in CI.
   → Root (architecture/test-design): liveness is recorded as a side effect *after* the
   first read, and the test's proxy duration is the same order as filesystem/lock latency
   under load. Fix belongs wherever `attention-store` is next touched (record liveness
   before/at first read, or test with a wait ≫ read latency / fake clock) — **not** in
   PR #201 or in `feat/inbox-durable`.

### Falsification attempt (PR201)

Absence: on `origin/main` the identical `waitForItem`/test code exists (branch diff touches
neither file), so H-PR.1 predicts the same failure is reproducible on main under sufficient
first-read latency (e.g. throttled/slow filesystem) — a clean discriminator available to
whoever fixes it. Adjacent cause "answer() waiterLive logic" (`:537` next assertion) is
excluded: the reported failure is at `:536`, before `answer` is called for `mail`.

---

## Root Cause

| Group | Test (distinct) | Proven root cause (one line) | Class |
| --- | --- | --- | --- |
| F1 | `session-inbox.spec.ts:362` | Bare `text=Pane ${stamp}`.first() resolves to the fixture's `<title>` (hidden); preview itself renders (`h1` in snapshot) | SPEC-BUG (test locator) |
| F2 | `session-needs-attention.spec.ts:14` mobile | Fresh mobile terminal prints no prompt (`[lost tty]`, blank rows) at the test's first interaction, before any SPEC-C behaviour; signature documented pre-branch, mechanism identity unproven | KNOWN-FLAKE signature (pre-branch), honestly scoped |
| F3 | `session-preview.spec.ts:583` | Test encodes SPEC-A boundary (select at 5 files); SPEC-C:39 + product (`entryCount<=5` → tablist) supersede it | SPEC-BUG (stale boundary test) |
| F4 | `session-tools.spec.ts:141` desktop | SPEC-C attention effects (`SessionWorkspace.tsx:175,179`) lack the `!reviewOpen` guard (`:158` has it) and overwrite review activation (`:160`) in the same commit | PRODUCT-BUG |
| F5 | `session-tools.spec.ts:141` mobile `:420` | Test encodes pre-SPEC-C Terminal landing; SPEC-C lands waiting sessions on Waiting — compounded by `Dashboard.tsx:1271` force-`terminal` racing `:586`/`:612` (repeat1 divergence) | SPEC-BUG + product cleanup |
| PR201 | `attention-store.test.ts:532` (`:536`) on run 43222973630 | `waitForItem(30ms)` creates its liveness poller only after the first read + deadline check (`attention-store.ts:468-470`); slow first read ⇒ no poller ⇒ `hasLiveWaiter` false. Untouched by PR #201's diff | Pre-existing timing flake |

Note on counters: 22 hypotheses formed (F1×3, F2×4, F3×3, F4×4, F5×4, PR201×4), 6 proven
(exactly one per group: H-F1.1, H-F2.1-scoped, H-F3.1, H-F4.1, H-F5.1, H-PR.1), 16 rejected.
H-F5.2 is a proven *contributing* defect recorded under F5 but counted as rejected-as-sole-root
to keep one PROVEN per group; its fix is in the plan regardless.

## Fix plan

No edits are made by this log. Each planned edit maps to the root-cause clause it removes and
the regression test that discriminates (fails before, passes after). Rerun after fixes per
Reproduction.

| # | Planned edit (file:line) | Root-cause clause removed | Discriminating regression test |
| --- | --- | --- | --- |
| 1 | `e2e/tests/session-inbox.spec.ts:377,388,393,406` — scope the marker locator to the body/heading (e.g. `iframe.getByRole("heading", { name: \`Pane ${stamp} version 1\` })` or `iframe.locator("h1")…`), never bare `text=` against `previewSimpleHtml` output | F1: `.first()` = hidden `<title>` (`e2e/helpers/session-preview.ts:199-200`) | Existing failing e2e: `session-inbox.spec.ts:362` (step2 command, x3) |
| 2 | F3: `e2e/tests/session-preview.spec.ts:583-639` — update the boundary test to SPEC-C entries: retitle/rework to 6 files (or 5 files + attention entry = 6 entries) for the native-select case, and assert 5 entries → tablist (keep, don't delete, per COMMON.md) | F3: SPEC-A:59 boundary superseded by SPEC-C:39 / `SessionWorkspace.tsx:240,247` | Existing failing e2e: `session-preview.spec.ts:583` updated (discriminates at both 5→tablist and 6→select) |
| 3 | F4 product: `ui/src/components/SessionWorkspace.tsx:172-176` and `:178-182` — add the same `!reviewOpen` guard as `:158` (and add `reviewOpen` to deps as needed) so a shown item never steals an explicitly opened review in the same commit | F4: unguarded `setAuxTab('preview')` overwriting `:160` review activation | Existing failing e2e: `session-tools.spec.ts:141` desktop `:352` (x3) **plus new unit test** (next row) |
| 4 | F4 unit test (new): in the existing SessionWorkspace UI test suite (`ui/` vitest, beside the other `SessionWorkspace` tests — locate via the component's current test file; do not create a parallel harness) — "shown attention item + review activation in one commit on desktop keeps PR review selected" (and the `shownKey`-change variant); must fail on current code, pass with the guard | F4 (unit-level discriminator, faster than e2e; also covers the `:175` new-item path the e2e doesn't isolate) | New test named here; run via `cd ui && npx vitest run` (COMMON.md gate 1) |
| 5 | F5 test: `e2e/tests/session-tools.spec.ts:420` — expect the Waiting/side-pane tab selected after Inbox "Open session" for a waiting session on mobile (mirror `session-inbox.spec.ts:29`), then explicitly tap Terminal if later steps need it (audit `:421` `tabIntoHeaderLink` under the Waiting landing — repeat1's `:131` failure shows this coupling) | F5 H-F5.1: pre-SPEC-C Terminal-landing expectation | Existing failing e2e: `session-tools.spec.ts:141` mobile (x3; all repeats must fail/pass at the *same* assertion — divergence itself is a failure signal) |
| 6 | F5 product cleanup: `ui/src/components/Dashboard.tsx:1271` — remove the `setMobileTab("terminal")` override after `handleSelectSession(id)` (selection already encodes waiting→preview at `:586`; the shown-attention effect `:609-613` then has a single writer to reason about). Keep `focusOpenedSessionRef`/`scheduleTerminalRenderAdjustment` behaviour intact | F5 H-F5.2: two opposite `mobileTab` writers in one handler ⇒ racy landing | Same mobile e2e as row 5 (x3 determinism is the discriminator) + `session-inbox.spec.ts:304` phone-landing test must stay green |
| 7 | F2: **no edit in this branch.** Justification: failure occurs at `session-needs-attention.spec.ts:29` before any branch behaviour exists in the test; signature (`/[$%#>]/` blank rows + `[lost tty]`) is documented on a pre-branch commit in `docs/investigations/2026-10-27-local-rerun-ci.md:23,136`, whose own mechanism proof is explicitly incomplete (`:18`). Track under that investigation; do not mask it here (no retries/skips added by this branch). If it blocks the gate, record it as a known pre-existing failure with this log as evidence | F2 (scoped): pre-branch terminal-blanking mode, identity unproven | n/a in this branch; discriminator belongs to the local-rerun-ci follow-up (real browser/CI regression named there) |
| 8 | PR201: **no edit in this branch** (and none requested in PR #201). Justification: `attention-store.ts`/test are untouched by both branches' relevant diffs; the race (`attention-store.ts:468-470` + `waitForItem(…,30)` at test `:535-536`) pre-exists on `origin/main`. Recommended future fix, wherever the store is next touched: create/refresh the poller record before or atomically with the first read, or make the test wait ≫ first-read latency / use the injected clock (`notificationOptions.now`). The separately dispatched re-run of `43222973630 --failed` (attempt 2) was still `in_progress` when checked for this log; its result does not change the code-level proof either way | PR201 H-PR.1: 30 ms proxy vs first-read latency | Future: `attention-store.test.ts:532` under artificially slowed first read (fails today by construction) |

### Post-fix verification (not run for this log)

1. `cd wt-inbox/e2e && npx playwright test tests/session-inbox.spec.ts --project=chromium --repeat-each=3` → expect 31/31 (F1 gone).
2. `cd wt-inbox/e2e && npx playwright test tests/session-preview.spec.ts tests/session-tools.spec.ts --project=chromium --repeat-each=3` → expect F3/F4/F5 gone, mobile repeats deterministic.
3. Full step3-equivalent sweep → expect only the F2 signature may remain (documented pre-existing); anything else is a new regression.
4. `cd wt-inbox/ui && npx tsc --noEmit && npx vitest run` (includes the new F4 unit test); `cd wt-inbox/e2e && npx tsc --noEmit` (COMMON.md gate).
