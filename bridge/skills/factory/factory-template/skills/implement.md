# IMPLEMENT stage skill

Purpose: turn the frozen design into working, tested code on a ticket branch, one
Test-plan row at a time, using strict TDD. You are the IMPLEMENT worker.

**The Worker Protocol (`_protocol.md`) is binding. Read it first. This skill only adds
detail; it never overrides the protocol.** You come after `design` and before `review`.
Your `NEXT_STAGE` is `review`. Your `BOUNCE_STAGE` is `design`. You may run on a
codex-class harness, so follow every command literally and do not improvise.

---

## 1. Inputs

Read these before touching code. They live in `TICKET_DIR`.

- `prd.md` — what the ticket must achieve, in product terms. Background only.
- `design.md` — your work order. It has three parts that mean different things to you:
  - **Contract** (signatures, types, error shapes, public API). **IMMUTABLE for you.**
    You implement it exactly. If it is wrong, you BOUNCE (see step 8). You never edit it.
  - **File map** — the exact list of files you may create or change. This is your scope.
    Touch nothing outside it except those files' own test files.
  - **Test plan** — the ordered list of tests you must write. One row = one TDD cycle.
- If you arrived here from a bounce (`review` or `qa`), the reject reason lines are in the
  `fts show --json` history. For a `review` bounce, `TICKET_DIR/review.md` also holds the
  full findings; for a `qa` bounce, `TICKET_DIR/qa-report.md` holds the failing checks.
  Treat the reject lines as an additional, mandatory work order (see step 9).

If any of prd.md or design.md is missing, or design.md has no File map or no Test plan:
that is STUCK. Follow the protocol STUCK path (mail parent, exit). Do not guess.

---

## 2. Start and set variables

1. `fts start` per the protocol. If it fails, STOP and exit — you do not own this ticket.
2. Read context: `fts show --db "$FTS_DB" "$TICKET_ID" --json`, then read the artifacts above.

---

## 3. Create your isolated worktree

ALL work happens inside a dedicated git worktree on branch `ticket/$TICKET_ID`.
**Never commit to `main`.** Run exactly:

```bash
git -C "$REPO_ROOT" worktree add "$REPO_ROOT/.ffactory/worktrees/$TICKET_ID" -b "ticket/$TICKET_ID" main 2>/dev/null \
  || git -C "$REPO_ROOT" worktree add "$REPO_ROOT/.ffactory/worktrees/$TICKET_ID" "ticket/$TICKET_ID"
```

The first form creates the branch fresh. The second form runs only after a bounce, when
the branch already exists, and resumes it. Then set your working directory:

```bash
WORK="$REPO_ROOT/.ffactory/worktrees/$TICKET_ID"
cd "$WORK"
```

Every `git`, test, lint, and typecheck command from now on runs inside `$WORK`.
**Leave the worktree in place when you exit.** The `review` stage needs it. Do not remove
it, do not `git worktree remove`.

---

## 4. Discover the project gates ONCE

You must know the exact commands to run tests, lint, and typecheck. Find them one time,
at the start, and write them down.

1. If `design.md` already lists the test / lint / typecheck commands, reuse those verbatim.
2. Otherwise inspect, in this order, whichever exist: `pyproject.toml`, `package.json`
   (scripts), `Makefile`, `justfile`, `.github/workflows/*.yml`, `tox.ini`, `noxfile.py`.
3. Record the exact commands in `TICKET_DIR/implementation-notes.md` under a `Gates`
   heading. Example rows: `test: uv run pytest`, `test-one: uv run pytest <path>::<name>`,
   `lint: uv run ruff check .`, `typecheck: uv run mypy --strict .`.

If you cannot find how to run tests at all, that is STUCK. Do not invent a command.

---

## 5. The TDD loop — one Test-plan row at a time

Do the Test-plan rows in order. For EACH row, run this exact cycle. Never skip a step,
never batch rows together.

1. **Write the one named failing test** for this row, in its test file, asserting the
   observable behavior the AC describes.
2. **Run only that test. Confirm it FAILS for the RIGHT reason** — a real assertion
   failure, not an import error, syntax error, or "file not found". If it fails for the
   wrong reason, fix the test scaffolding until the failure is a genuine assertion, THEN
   continue. A test that errors instead of asserting proves nothing.
3. **Write the smallest implementation** that makes that test pass. No extra features,
   no speculative code, no "while I'm here" helpers.
4. **Run that test again. Confirm it is GREEN.**
5. **Run the whole affected test file** (not just the one test) to confirm you broke
   nothing next to it.
6. **Commit** just this cycle's change:

   ```bash
   git add -A && git commit -m "feat(ticket/$TICKET_ID): <what this test now covers>"
   ```

7. **Heartbeat:** `fts renew --db "$FTS_DB" --ticket "$TICKET_ID" --worker "$WORKER_ID" --epoch "$EPOCH"`
   after EVERY cycle. If renew fails (`ClaimExpired`/`ClaimFenced`/`NotClaimOwner`), STOP
   immediately per the protocol — mail parent, exit. Do not commit anything more.

Repeat until every Test-plan row is done.

### Forbidden in the loop (these fail review — do not do them)

- Writing implementation code before its test exists.
- Weakening, deleting, `skip`-ing, or `xfail`-ing a failing test to make the suite green.
- Asserting on implementation details (private internals, call counts, log strings) instead
  of the AC's observable behavior.
- One giant commit at the end. Commit per cycle.
- Adding files, refactors, renames, or "cleanups" not required by the current row.

Contrast:

- RIGHT: `assert charge(cart) == Money("12.00", "USD")` — checks the AC's stated result.
- WRONG: `assert cart._apply_tax_called == 1` — checks internals; the AC never mentioned it.
- RIGHT: test file has `def test_rejects_negative_amount(): with pytest.raises(ValueError): ...`
- WRONG: deleting `test_rejects_negative_amount` because it is red, then shipping green.

### The product bar — a finished product, not a demo

The design's **Product direction** is a work order, not a suggestion. As you build each row,
meet this bar:

- **Zero stubs.** No `TODO`, no placeholder screen, no handler that returns fake or empty
  data "for now". Every state the direction names is really built: an empty list shows the
  designed empty state, a failed request shows the error state, an unauthorized caller gets
  the specified rejection. If it renders, it renders finished.
- **Seed data exists.** If the feature renders data, make sure the dev seed/fixture file the
  design named in the File map actually contains realistic rows, so the feature is NON-BLANK
  the moment the app boots. A blank first screen makes finished work look like a stub. Do not
  invent a new seed mechanism — fill the one the File map points to.
- **Data, not logic.** Put constants, limits, copy strings, and seed rows in the data file the
  design named — never inline them into a code path.

Contrast:

- RIGHT: the empty ticket list renders the designed empty state ("No tickets yet — create
  one"), and the seed file ships three demo tickets so the list is alive on first boot.
- WRONG: the list handler returns `[]` with a `# TODO: real empty state` and no seed rows, so
  the first screen is a blank panel.

---

## 6. Contract discipline (immutable)

The design **Contract** — every signature, type, and error shape — is frozen. You match it
exactly. You never silently change a name, argument, return type, or raised error to make
your code easier.

If the Contract is genuinely wrong or impossible to implement (contradicts itself, names a
type that cannot exist, specifies an error that the language cannot raise there): STOP
implementing and BOUNCE to design (step 8). Do not patch around it.

---

## 7. Scope discipline

Touch ONLY files in the design **File map**, plus those files' own test files. Nothing else.

- A tempting improvement in a neighboring file is FORBIDDEN. Not now, not "quickly".
- If making this ticket work genuinely requires changing a file outside the File map, that
  is a design gap → BOUNCE to design (step 8). Do not expand scope on your own authority.

---

## 8. When to bounce to design

Bounce when the frozen input is wrong: an impossible Contract, or a required change outside
the File map. Do NOT bounce for your own bugs or for tests you can make pass.

Use the protocol `fts reject` with `--to-stage "$BOUNCE_STAGE"` and one of these exact
reason formats (one line per problem):

- Contract problem:
  `CONTRACT | <the exact signature/type> | why it cannot work | smallest change that would`
- Scope/file-map gap:
  `SCOPE | <file needed but not in map> | why it is required | add it to the File map`

Example:
`CONTRACT | def parse(x: int) -> Date | int cannot carry a timezone the AC requires | take x: str (ISO-8601)`

Before rejecting: verify the branch is committed clean so the partial work survives the
bounce. Then reject, mail parent, exit.

---

## 9. Handling a bounce-back (from review or qa)

If you resumed after a rejection, read the reject reason lines from the `fts show --json`
history. They come in one of two shapes, depending on which stage bounced you:

- From **review** (one line per finding):
  ```
  [blocker] file:line | problem | required fix
  ```
- From **qa** (one line per failing AC, lines separated by ` ;; `):
  ```
  AC<n> | repro: <command/steps> | expected: <...> | got: <...>
  ```

Address EVERY line. For a review `[blocker]`, make the required fix. For a qa failure, run
the given repro to reproduce it, then fix the code so the expected result is produced. In
both cases TDD still applies: first write or fix a test that captures the missed behavior
(see it RED), then make it GREEN, then commit each fix on its own:

```bash
git commit -m "fix(ticket/$TICKET_ID): <what was fixed> (addresses <file:line or AC#>)"
```

**Minimal fix only.** Change exactly what the finding names — nothing more. Do NOT refactor,
rename, reorganize, or "clean up while I'm here" during a bounce fix. A refactor in the fix
phase reintroduces the very scope creep review just cleared, and risks breaking code that
already passed. One finding, one focused fix, one commit.

Do not fix things not listed. After all lines are addressed, rerun the full finish
sequence (step 10) from the top. Then advance.

---

## 10. Finish sequence

Run all of this inside `$WORK`. Do not skip a step.

1. **Full test suite** — the `test` command from your notes. Must be fully green.
2. **Lint** — the `lint` command. Must pass clean.
3. **Typecheck** — the `typecheck` command. Must pass clean.
4. Paste the summary line of each command's output into `implementation-notes.md`.
5. **Self-review the whole diff:**

   ```bash
   git -C "$WORK" diff main...HEAD
   ```

   Remove any debug prints, commented-out code, `TODO` you introduced, `.only`/focused
   tests, and stray/temp files. Confirm every changed file is inside the File map.
6. **Write `TICKET_DIR/implementation-notes.md`** with: branch name (`ticket/$TICKET_ID`);
   the Gates commands and their pasted output summaries; per-AC / per-Test-plan-row status
   (done / how it is covered); and a Deviations line that is either `Deviations: none` or a
   note that you bounced (you would not be finishing if you bounced).
7. `fts renew` one last time.

---

## 11. GATE checklist — every box needs evidence, not assumption

Do not advance until ALL are true. "Evidence" means you can point to the command output or
file you just produced.

- [ ] Work is in `$WORK` on branch `ticket/$TICKET_ID`; `main` has zero new commits from you.
- [ ] Every Test-plan row has a corresponding test that was seen RED then GREEN.
- [ ] No test was skipped, weakened, or deleted to pass.
- [ ] Every assertion targets observable AC behavior, not internals.
- [ ] Full test suite green (summary line pasted in notes).
- [ ] Lint clean (summary line pasted in notes).
- [ ] Typecheck clean (summary line pasted in notes).
- [ ] Every changed file is inside the design File map (or its test file).
- [ ] No stub shipped: no `TODO`/placeholder screen or handler; every empty/loading/error/
      unauthorized state named in the design's Product direction is actually built.
- [ ] If the feature renders data, the seed/fixture file has realistic rows so the running
      product is non-blank on boot.
- [ ] Contract implemented exactly as written — no silent deviation.
- [ ] `git diff main...HEAD` has no debug prints, commented code, or stray files.
- [ ] `implementation-notes.md` written with branch, gates+outputs, per-AC status, deviations.
- [ ] Commits are per-cycle with `feat(ticket/$TICKET_ID): ...` messages, no giant commit.
- [ ] If this was a bounce-back: every reject line addressed by its own commit.

If any box cannot be checked honestly: do NOT advance. Fix it, or bounce (step 8), or take
the STUCK path.

---

## 12. Outcome protocol

Exactly one of:

- **PASS** — all GATE boxes checked:
  ```bash
  fts complete --db "$FTS_DB" --ticket "$TICKET_ID" --worker "$WORKER_ID" --epoch "$EPOCH" --note "implemented; all gates green"
  fts advance  --db "$FTS_DB" --ticket "$TICKET_ID" --worker "$WORKER_ID" --to-stage "$NEXT_STAGE" --note "ready for review on ticket/$TICKET_ID"
  ```
- **REJECT to design** — impossible Contract or needed file outside the File map. Use
  `fts reject ... --to-stage "$BOUNCE_STAGE"` with a `CONTRACT|...` or `SCOPE|...` reason
  line (step 8).
- **STUCK** — missing input, unrunnable environment, contradictory requirements you cannot
  turn into a bounce. Do NOT complete, do NOT reject. Mail parent the exact blocker, exit;
  the claim expires and the ticket re-queues.

Then mail the result summary and exit, per the protocol.

**Never `git push`, never open a PR** — later stages do that. **Never run destructive git**
(`reset --hard`, `push --force`, `branch -D`, `worktree remove`) outside your own branch,
and never on `main`.

---

## 13. Failure modes

| Symptom | Cause | Do this |
|---|---|---|
| Test fails with ImportError / SyntaxError, not an assertion | Test scaffolding wrong; not a real red | Fix scaffolding until failure is a genuine assertion, then continue the cycle |
| Suite is red and you want it green fast | Temptation to skip/delete a test | FORBIDDEN. Fix the implementation, or bounce if the Contract is impossible |
| Contract signature makes the AC impossible | Design error | BOUNCE with `CONTRACT \| ... ` (step 8). Do not patch around it |
| You need to edit a file not in the File map | Scope gap in design | BOUNCE with `SCOPE \| ...` (step 8). Do not touch it silently |
| `fts renew` returns ClaimExpired/Fenced/NotClaimOwner | You lost the claim | STOP now, write nothing more, mail parent, exit (protocol step 4) |
| You committed to `main` | Wrong directory | Stop. You are not in `$WORK`. Do NOT amend main; take STUCK, mail parent |
| Same error beats you twice | An assumption is wrong | Re-read design.md + this skill; do not retry a third time. If still stuck, STUCK path |
| Can't find test/lint/typecheck command | No recorded gates | STUCK. Do not invent a command |
| Tempted to add a nice refactor nearby | Scope creep | FORBIDDEN. Only File-map files, only what the current row needs |
| Tempted to leave a `TODO`/placeholder screen or empty-data handler | Shipping a demo, not a product | Build the state the Product direction names; a stub fails review. Seed the data file so it is non-blank |
| On a bounce, tempted to refactor while fixing the finding | Fix-phase scope creep | Minimal fix only — change exactly what the finding names, nothing else, one commit |
