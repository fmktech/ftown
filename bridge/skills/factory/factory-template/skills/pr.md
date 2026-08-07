# PR stage — verify, sync, and land the branch. Terminal stage of the pipeline.

The worker protocol in `_protocol.md` is binding; follow its lifecycle. This skill only
tells you what to do between `fts start` and your outcome command.

Your job: confirm QA already passed, rebase the branch onto latest `main`, re-verify green,
clean up commit history, push, and open the pull request. You do NOT write product code and
you do NOT fix failing tests yourself — a red suite after rebase is a bounce to implement,
not something to patch here. This stage is terminal: there is no next stage on success.
`_protocol.md` forbids `git push` "unless your stage skill explicitly instructs it" — this
skill IS that instruction, and it applies only because `factory.yaml` sets `allow_push: true`
for the `pr` stage. If that flag is ever missing for this stage, treat push as forbidden and
go STUCK.

## Inputs

- `TICKET_DIR/prd.md` — problem statement, goals, acceptance criteria (ACs). Source for the
  PR body's Summary and AC checklist.
- `TICKET_DIR/qa-report.md` — must exist; every AC row must be PASS. Your precondition.
- `TICKET_DIR/implementation-notes.md` — contains the branch name (`ticket/$TICKET_ID`) and
  the literal build/lint/test/typecheck commands. You run these commands verbatim; do not
  guess them.
- The worktree at `$REPO_ROOT/.ffactory/worktrees/$TICKET_ID` — your only writable checkout.
  Do all git work there, never in `$REPO_ROOT` directly.

## Procedure

### 1. Precondition check

1. Confirm `TICKET_DIR/qa-report.md` exists. If missing: STOP, go STUCK (see Outcome) —
   the pipeline invariant that `pr` only runs after a passing `qa` was violated.
2. Read every AC row in `qa-report.md`. If any row is not PASS: STOP, go STUCK with the
   failing AC numbers in your blocker message. Do NOT push unverified work. Do NOT try to
   fix it yourself — that is implement's job, and you have no bounce path for a bad
   qa-report (a bad qa-report means qa itself misbehaved, which is a factory bug, not a
   normal reject).
3. Read `implementation-notes.md`. Extract the branch name and the exact test/lint/build
   commands. `fts renew` after reading.

### 2. Sync with main

1. Inside the worktree:
   ```bash
   cd "$REPO_ROOT/.ffactory/worktrees/$TICKET_ID"
   git fetch origin
   git rebase origin/main
   ```
2. If the rebase completes with no conflicts, go to step 3.
3. If the rebase stops on conflicts, classify EVERY conflicting file as trivial or
   non-trivial. Do not average across files — one non-trivial file fails the whole rebase.
   - **Trivial** (resolve and continue): lockfiles (`package-lock.json`, `uv.lock`,
     `Cargo.lock`) — regenerate/accept the tool-generated version; import/require statement
     reordering; two changes on adjacent-but-non-overlapping lines (e.g. main added a new
     function at the end of a file, your branch edited a function earlier in the same
     file). Example: main added `def new_helper():` at the bottom of `utils.py`; your
     branch modified `def existing_helper():` near the top. Same file, no overlapping
     logic — trivial.
   - **Non-trivial** (abort): both sides changed the SAME logic — the same function body,
     the same conditional, the same config key — with different intent. Example: main
     changed the retry count in `fetch_with_retry()` from 3 to 5; your branch also changed
     it, to 2, as part of the ticket's fix. That is a genuine semantic conflict; you cannot
     safely guess which value is correct.
   - For each trivial conflict: edit the file to the resolved content, `git add <file>`,
     continue. `fts renew` after each resolved file.
   - On the FIRST non-trivial conflict: `git rebase --abort` immediately. Do not attempt to
     resolve it "your best guess" — that is implement's call, not yours. Go to the REJECT
     outcome below.
4. After a clean rebase (or after resolving only trivial conflicts), continue to step 3.
   A green suite from BEFORE the rebase proves nothing now — the code has changed.

### 3. Full verification (mandatory after every rebase, even a conflict-free one)

1. Run every command recorded in `implementation-notes.md` (lint, typecheck, full test
   suite, build) — the exact strings, not a subset.
2. `fts renew` after the run.
3. If ALL commands pass: continue to step 4.
4. If ANY command fails: STOP. This is a REJECT to implement (see Outcome), NOT something
   you patch. Do not push a broken rebase result under any circumstance.

### 4. Commit hygiene

1. Run `git log origin/main..HEAD --oneline` to see this branch's commits.
2. If history is already a small number of coherent commits (roughly one per logical
   change, clear messages) — continue to step 5.
3. If history is messy (many "wip"/"fixup"/"address review" commits, or commits that don't
   individually build): squash it.
   ```bash
   git reset --soft "$(git merge-base HEAD origin/main)"
   git commit -m "feat(ticket/$TICKET_ID): <what this ticket does, one line>"
   ```
   Use `fix(ticket/$TICKET_ID): ...`, `test(ticket/$TICKET_ID): ...`, or
   `chore(ticket/$TICKET_ID): ...` instead of `feat` if that better describes the change.
   If the ticket genuinely spans distinct concerns (e.g. a schema migration plus the
   feature that uses it), keep that as more than one commit — each still prefixed
   `<type>(ticket/$TICKET_ID): ...`. Do not manufacture multiple commits when one suffices.
4. `fts renew` after squashing.

### 5. Push and open the PR

1. Check whether a PR already exists for this branch (it may, from a prior `pr`-stage
   attempt that got bounced and came back):
   ```bash
   gh pr view "ticket/$TICKET_ID" --json url,state 2>/dev/null
   ```
2. First push (no existing PR, no remote branch yet, or you did not rewrite history):
   ```bash
   git push -u origin "ticket/$TICKET_ID"
   ```
3. If you rewrote history (squash in step 4, or a rebase) AND a remote branch/PR already
   exists, you MUST use lease-protected force push — never a bare `--force`:
   ```bash
   git push --force-with-lease -u origin "ticket/$TICKET_ID"
   ```
4. If push fails with an authentication error (`gh` unauthenticated, `Permission denied`,
   `403`, credential prompt) — STOP, go STUCK with the exact error text. Humans own
   credentials; never try to route around auth (no token hunting, no config edits).
5. If no PR exists yet, create one:
   ```bash
   fts show --db "$FTS_DB" "$TICKET_ID" --json    # get the ticket title
   gh pr create --title "<ticket title>" --base main --head "ticket/$TICKET_ID" --body "$(cat <<'EOF'
   ## Summary
   <4-6 lines from prd.md's problem statement and goals>

   ## Acceptance criteria
   - [x] AC1 — <criterion> (verified: qa-report.md, <evidence>)
   - [x] AC2 — <criterion> (verified: qa-report.md, <evidence>)
   <one line per AC, all checked, all from qa-report.md>

   ## Testing
   <the exact lint/typecheck/test/build commands run, and a one-line qa-report summary>

   Factory ticket: TICKET_ID
   EOF
   )"
   ```
   Replace `TICKET_ID` in the final line with the literal `$TICKET_ID` value. Do NOT pass
   `--reviewer`, do NOT run `gh pr merge`, do NOT enable auto-merge
   (`gh pr merge --auto`). This stage opens the PR; it never merges it.
6. `fts renew` after the PR exists.

### 6. Write the artifact

Write `TICKET_DIR/pr.md` with:
- the PR URL,
- the final commit SHA(s) on the branch (`git log origin/main..HEAD --oneline`),
- rebase notes: whether a rebase happened, which files (if any) had trivial conflicts and
  how each was resolved, and confirmation the full suite was green after.

`fts renew` after writing.

## GATE checklist (every box needs evidence, not assumption)

1. `qa-report.md` exists and every AC row is PASS. Evidence: you read it and can cite the
   rows.
2. Branch is rebased onto current `origin/main` (or already up to date — confirm with
   `git log origin/main..HEAD` showing no merge-base drift).
3. The full suite (every command from `implementation-notes.md`) passed AFTER the rebase,
   not before. Evidence: command output from this run, not a memory of qa stage's run.
4. Commit history on the branch is a small number of coherent, prefixed commits.
5. Push succeeded (`git push` exit code, or `gh pr view` shows the branch pushed).
6. `gh pr create` succeeded and returned a URL, with Summary, AC checklist (all checked,
   citing qa-report evidence), and Testing sections present in the body.
7. No auto-merge, no merge, no reviewers requested.
8. `TICKET_DIR/pr.md` written with URL, commit SHAs, and rebase notes.

If any box fails, you do not have a PASS — go to REJECT or STUCK per the failure's cause.

## Outcome

Exactly one of the following, then exit via protocol step 7. The FTS outcome/artifact is
the report; do not send a duplicate routine message.

- **PASS** — all gate boxes checked. `NEXT_STAGE` is `-` (terminal): complete only, do not
  advance.
  ```bash
  fts complete --db "$FTS_DB" --ticket "$TICKET_ID" --worker "$WORKER_ID" --epoch "$EPOCH" \
    --note "PR: <url>"
  ```
  Then clean up the worktree, only now that the PR exists:
  ```bash
  git -C "$REPO_ROOT" worktree remove "$REPO_ROOT/.ffactory/worktrees/$TICKET_ID"
  ```
  If anything earlier failed, skip this removal — leave the worktree for the next attempt
  or for a human to inspect.

- **REJECT to implement** — rebase hit a non-trivial conflict, OR the full suite failed
  after a (conflict-free or resolved) rebase. `BOUNCE_STAGE` is `implement`. Use exactly
  this reason format:

  `REBASE | <conflicting files, or the failing command> | rebase onto latest main and re-verify`

  Example:
  ```bash
  fts reject --db "$FTS_DB" --ticket "$TICKET_ID" --worker "$WORKER_ID" --epoch "$EPOCH" \
    --reason "REBASE | src/billing/retry.py | rebase onto latest main and re-verify" \
    --to-stage "$BOUNCE_STAGE"
  ```
  Before rejecting: if you started a rebase, make sure it is fully aborted
  (`git rebase --abort`) and the worktree is clean — do not leave a half-rebased tree for
  the next worker.

- **STUCK** — `qa-report.md` missing or contains a non-PASS AC; `gh` unauthenticated or
  push rejected by permissions; worktree missing or corrupted; `fts renew` fenced you. Do
  NOT complete, do NOT reject. Mail your parent the exact blocker and exit (protocol step
  6, STUCK path). The ticket re-queues.

## Failure modes

| Symptom | Cause | Do instead |
| --- | --- | --- |
| You push without checking `qa-report.md` | skipped the precondition | Stop. Never push before confirming every AC row is PASS. |
| You resolve a same-function conflict "to be safe" | misjudged trivial vs. non-trivial | If both sides touched the same logic, it is non-trivial. Abort the rebase, reject to implement. |
| You push right after a clean rebase, no test run | assumed pre-rebase green still holds | Always rerun the full suite after ANY rebase, conflict-free or not, before pushing. |
| You `git push --force` | skipped lease protection | Use `--force-with-lease` whenever history was rewritten and a remote branch may already exist. |
| You enable auto-merge or merge the PR yourself | exceeded this stage's authority | This stage opens the PR only. Merging is a human decision. |
| `gh pr create` fails with 401/403 and you try a personal token or `gh auth login` workaround | tried to route around missing credentials | STOP, go STUCK with the exact error. Credentials are a human's job. |
| You fix a failing test yourself to get green after rebase | overstepped stage scope | This stage verifies; it does not patch product code. Reject to implement instead. |
| History still has "wip"/"fixup" commits in the PR | skipped commit hygiene | Squash with `git reset --soft $(git merge-base HEAD origin/main)` + one clean commit before pushing. |
| PR body has no AC checklist or cites nothing from qa-report.md | copied prd.md ACs without evidence | Each AC line must reference qa-report.md's verification for that AC. |
| You remove the worktree after a failed push | cleaned up despite failure | Only remove the worktree on PASS, after the PR exists. Leave it otherwise. |
| Same error blocks you twice | a wrong assumption | Re-read `qa-report.md`, `implementation-notes.md`, and `_protocol.md`; if still stuck, use the STUCK path. |
