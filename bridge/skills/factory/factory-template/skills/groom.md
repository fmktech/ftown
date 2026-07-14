# GROOM

Turn a raw request into a `prd.md` with testable acceptance criteria, splitting it into
smaller tickets if it is too big. The worker protocol in `_protocol.md` is binding; follow
its lifecycle.

## Inputs you will find

- `TICKET_DIR/request.md` — the raw request. This is the thing you are grooming. Never
  edit it.
- A bounce reason in the ticket history — present if `design` rejected this ticket back to
  groom. It is NOT a file; read it from `fts show --json` (the latest reject event, shaped
  `AC<n> | why it cannot be satisfied | what the PRD must clarify or change`). You MUST
  address every reason in your revised PRD.
- `TICKET_DIR/triage-notes.md` — present ONLY if the triage loop revived this ticket to
  groom. It contains the guidance triage left; if present, read it fully before writing and
  address every point it raises too.
- Otherwise nothing else exists yet — you are the first real worker on this ticket.

## Extra commands granted to this stage

In addition to the protocol's base commands, groom may split work:

```bash
fts create --db "$FTS_DB" --title "<child title>" --stage groom \
  --folder "<parent TICKET_DIR>/../N-<slug>"
fts add-dep --db "$FTS_DB" --ticket <dependent-id> --depends-on <prerequisite-id> \
  --until <stage>
```

Do not use any other new subcommand. Everything else is exactly the protocol's list.

## Step-by-step procedure

1. `fts start --db "$FTS_DB" --ticket "$TICKET_ID" --worker "$WORKER_ID" --epoch "$EPOCH"`.
   If this fails, STOP and exit.
2. `fts show --db "$FTS_DB" "$TICKET_ID" --json`. Read `TICKET_DIR/request.md`.
3. Determine if this is a bounce revision: check the `fts show --json` history for a
   `design`→`groom` reject event, and check whether `TICKET_DIR/triage-notes.md` exists. If
   either is present, collect every reason from both sources — all must be addressed in your
   revised PRD (see step 8).
4. Resolve ambiguity from the repo BEFORE asking anyone. Read `REPO_ROOT/README.md`, any
   `docs/` folder, and the relevant source files the request touches. Many "unknowns" are
   answered by existing code or docs — use them.
5. `fts renew` (you just did real work reading files).
6. After reading, classify every remaining unknown into ONE of three buckets. The split that
   matters is **intent vs taste**:
   - **Answerable from repo/docs** → resolve it yourself, cite where you got the answer
     (file path) in your own notes, move on.
   - **INTENT gap** (what problem, for whom, what data, which business rule — a choice only
     a human/parent can make, where the wrong guess builds the wrong thing) → this is a STUCK
     condition. Do NOT guess. Do NOT invent a requirement to fill the gap. Go to the STUCK
     path in Outcome protocol below, listing the exact questions. Do not write a partial
     `prd.md` first.
   - **TASTE gap** (UX feel, a default value, a name, edge-case behavior — anything where any
     reasonable choice is fine and only a human's *preference* is missing) → do NOT go STUCK.
     Decide it opinionatedly, commit to ONE way, and record the choice in `prd.md` under a
     `## Decisions` heading (one line: what you chose and why). Never write a both-ways or
     configurable hedge, and never ask about it. Decisiveness reads as quality; hedging reads
     as a demo.
7. Estimate the work. Ask: "can one implementer finish this in ~2 days, and is it a single
   shippable thing?"
   - If YES to both → continue to step 8, write one `prd.md`.
   - If NO to either (>~2 days OR it bundles independently shippable deliverables) → go to
     the **Split procedure** below instead of writing a single PRD.
8. Write `TICKET_DIR/prd.md` (see Required PRD structure below). If this is a bounce
   revision (design reject reason in history and/or `triage-notes.md`), add a
   `## Revision notes` heading at the top listing each reason from both sources and how you
   addressed it.
9. `fts renew`.
10. Run the GATE checklist. Fix anything unchecked before proceeding.
11. Follow Outcome protocol.

## Required PRD structure (`TICKET_DIR/prd.md`)

```markdown
# <ticket title>

[## Revision notes                       <- only on a bounce-back revision
- <triage reason 1> -> <what you changed>
- <triage reason 2> -> <what you changed>
]

## Problem
<2-4 sentences. State what is wrong or missing today and why it matters. NO solution
language — no mention of endpoints, functions, UI components, or "we will build X".>

## Goals
- <outcome-oriented bullet>
- <outcome-oriented bullet>

## Non-goals
- <at least 2 bullets. Cutting scope is your main job — name things a reader would
  reasonably assume are included, and explicitly exclude them.>

[## Decisions                             <- only when you resolved a TASTE gap (step 6)
- <the choice you made> — <one-line why>
]

## First three minutes
<5-8 sentences narrating what a user does in their first three minutes with the delivered
feature and what they SEE at each step, in order. Concrete and sequential, present-tense,
grounded in the seeded/starting state. This is the definition of "finished": qa replays it
against the running product as a driven task, and a stall in it is a reject. Write the
happy path a real first-time user walks — not a feature list.>

## Verbs
<Every user-facing verb the feature involves, one per line — the actions and feedback a user
experiences in a full first session (e.g. "create a ticket", "filter the list", "mark a
ticket paid", "see a success toast"). Each verb MUST appear in some AC below; a verb with no
AC is either dead scope to cut or a missing requirement to add.>
- <verb>
- <verb>

## Functional requirements

### FR1: <name>
- AC1: <falsifiable, black-box-testable, observable-behavior statement>
- AC2: ...

### FR2: <name>
- AC1: ...
```

### AC quality bar

Every AC must pass all three checks:
1. **Independently testable** — a black-box tester with no code access could verify it by
   exercising the system.
2. **Observable behavior, not implementation** — describes inputs/outputs/state changes,
   never a class name, function name, middleware, or library.
3. **Falsifiable** — has a clear pass/fail, not a vague adjective ("fast", "robust",
   "user-friendly").

Good AC: `AC1: When a user submits a ticket with an empty "title" field, the API responds
with HTTP 422 and a body containing "title is required".`

Bad AC: `AC1: Use validation middleware to check the title field.` (names implementation,
not observable behavior, not falsifiable as written.)

## Split procedure (only when step 7 says split)

1. Decide the slices. Each child is one independently shippable deliverable, or one
   coherent ≤2-day chunk. The **parent ticket becomes the last slice** — the integration
   piece that ties children together (or simply the smallest remaining piece if there is
   no integration work).
2. For each child, `mkdir` its folder first, then seed it:
   ```bash
   mkdir -p "<parent TICKET_DIR>/../N-<slug>"
   ```
   Write that child's own `request.md` slice into
   `<parent TICKET_DIR>/../N-<slug>/request.md` — a focused excerpt of the original
   request scoped to just that slice. Do not put a `prd.md` there; the child's own groom
   worker will write it.
3. Create the child ticket:
   ```bash
   fts create --db "$FTS_DB" --title "<child title>" --stage groom \
     --folder "<parent TICKET_DIR>/../N-<slug>"
   ```
4. Wire the dependency so the dependent doesn't start early:
   ```bash
   fts add-dep --db "$FTS_DB" --ticket <dependent-id> --depends-on <prerequisite-id> \
     --until <stage>
   ```
   Choose `--until`:
   - `review` — the usual choice. The dependent can start once the prerequisite's code
     has been reviewed (its shape is stable), even before it's fully QA'd/merged.
   - `qa` — only when the dependent needs the prerequisite's feature actually *running* to
     build or test against (e.g. it calls a live endpoint the prerequisite adds).
5. Repeat for every child, in dependency order.
6. Rewrite the parent's own scope down to its final slice, then write `TICKET_DIR/prd.md`
   for that remaining slice following the Required PRD structure above. The parent's PRD
   must NOT re-describe the children's scope — reference their ticket IDs instead.
7. Continue to the GATE checklist for the parent's own (now-reduced) PRD.

## GATE checklist

Check every box with concrete evidence — do not check a box because it "should" be true.

- [ ] `TICKET_DIR/prd.md` exists and I printed/read it back after writing.
- [ ] Problem section has 2-4 sentences and contains zero solution language (no
      component/function/endpoint names).
- [ ] Goals section is present and non-empty.
- [ ] Non-goals section has at least 2 bullets.
- [ ] `## First three minutes` section exists with 5-8 concrete, sequential sentences a qa
      worker could replay against the running product.
- [ ] `## Verbs` section lists every user-facing verb, and I confirmed EACH verb appears in
      at least one AC (walk the list; a verb with no AC gets cut or given an AC).
- [ ] Every TASTE gap I resolved (step 6) is recorded in a `## Decisions` line; no both-ways
      or configurable hedge was written to dodge a decision.
- [ ] Every FR has at least one AC, and every AC is numbered ACn under its FR.
- [ ] I re-read each AC against the 3-point quality bar (testable, observable, falsifiable)
      and rewrote any that failed.
- [ ] If this was a bounce revision (design reject reason in history and/or
      `triage-notes.md`), `prd.md` has a `## Revision notes` section addressing every reason
      from both sources by name.
- [ ] If I split: every child folder exists (`ls` confirms it), every child has a seeded
      `request.md`, every `fts create` and `fts add-dep` call returned success, and the
      parent's `prd.md` covers only its own remaining slice.
- [ ] No requirement in `prd.md` was invented to paper over an unanswerable question —
      any such question went the STUCK route instead.
- [ ] I ran `fts renew` after each substantial step and none failed.

If any box is unchecked, fix it before calling `fts complete`. Do not rationalize a
skipped box.

## Outcome protocol

- **PASS** (single PRD, gate fully checked):
  ```bash
  fts complete --db "$FTS_DB" --ticket "$TICKET_ID" --worker "$WORKER_ID" --epoch "$EPOCH" \
    --note "prd.md written: N FRs, M ACs"
  fts advance --db "$FTS_DB" --ticket "$TICKET_ID" --worker "$WORKER_ID" \
    --to-stage "$NEXT_STAGE" --note "ready for design"
  ```
- **PASS after split** (parent's own reduced PRD gate fully checked, all children created):
  same two commands as above, note should mention the child ticket IDs created.
- **Groom never rejects.** `BOUNCE_STAGE` for groom is `-`. There is no reject path at this
  stage — if the request is unworkable, that is STUCK, not reject.
- **STUCK** (unanswerable question, broken environment, contradictory request): do NOT
  `fts complete`, do NOT write a partial `prd.md`. Mail your parent:
  ```bash
  ~/.ftown/ftown-sessions tell --parent --type result \
    "ticket $TICKET_ID groom: STUCK — <exact question 1>; <exact question 2>"
  ```
  Then exit. Your claim expires and the ticket re-queues.

## Failure modes table

| Symptom | Exact action |
|---|---|
| `fts start` fails | STOP immediately, do not read further, exit. You do not own this ticket. |
| `request.md` missing or empty | STUCK. Mail parent: "request.md missing/empty, cannot groom." Exit. |
| Bounce reason present (design reject in history or `triage-notes.md`) but you wrote prd.md without a Revision notes section | Stop, add the section addressing every reason, re-run the GATE checklist before completing. |
| A requirement's INTENT is genuinely unclear after reading repo/docs (what/for-whom/what-data) | STUCK — list the exact question(s), do not guess, do not write a placeholder AC. |
| A TASTE point is unspecified (a default, a name, a UX feel, an edge-case) | Do NOT go STUCK. Decide it, build one way, record it under `## Decisions`. Bad: add a config flag "to be safe". Good: pick the sensible default and write down why. |
| A verb in `## Verbs` maps to no AC | Either add an AC that exercises it, or cut the verb as out of scope. Do not ship a verb the ACs never test. |
| Estimate is borderline (~2 days, unsure) | Default to NOT splitting only if it is a single shippable unit; if it bundles 2+ shippable deliverables, split regardless of size. |
| `fts renew` fails with `ClaimExpired`/`ClaimFenced`/`NotClaimOwner` | STOP writing immediately. Do not finish the current file. Mail parent you were fenced. Exit. |
| You wrote an AC that names a function/class/endpoint | Rewrite it to describe observable input/output behavior only, before the GATE check. |
| Split child folder already exists from a prior partial attempt | Reuse it; do not create a duplicate ticket. Verify its `request.md` slice is correct before calling `fts create` again (skip create if a ticket already exists for that folder). |
| Same blocker on 2nd attempt at the same step | Your assumption is wrong. Re-read `request.md`, `triage-notes.md`, and this file before trying a third approach; if still stuck, go STUCK. |
| Tempted to write `prd.md` twice (draft then final) | Don't. Do all thinking first, write the file once, then read it back for the GATE check. |
