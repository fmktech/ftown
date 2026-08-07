# DESIGN stage — turn a groomed PRD into a frozen, implementable design.

The worker protocol in `_protocol.md` is binding; follow its lifecycle. This skill only
tells you what to produce between `fts start` and your outcome command.

Your job: read the real codebase, then write ONE artifact — `TICKET_DIR/design.md` — that
an implement agent (a weaker model) can execute with zero questions. You freeze the
interfaces and map every acceptance criterion (AC) to a test. You do NOT write product
code. You do NOT change the PRD.

## Inputs

- `TICKET_DIR/prd.md` — the groomed spec. Its ACs are your contract with the pipeline.
- The repository at `REPO_ROOT` — the source of truth for existing patterns. Read it.
- (Only if bounced back from implement) a reject reason attached to the ticket history.
  Get it with `fts show --db "$FTS_DB" "$TICKET_ID" --json`. Every item in it MUST be
  addressed in this revision (see "Bounce-back handling").

## Procedure

### 1. Recon the codebase (do this before designing — spend real effort here)

You cannot extend patterns you have not read. Produce these findings and keep them; the
implement stage will reuse them, so record them verbatim in `design.md`.

1. Read `prd.md` fully. Name the ONE concern this ticket touches (e.g. "HTTP route",
   "background job", "ORM model", "CLI command").
2. Locate entry points: find where that concern already lives. Use search, not guessing:
   ```bash
   ls "$REPO_ROOT"
   # then search for the concern by name/behavior, e.g.:
   semble search "<concern, described>" "$REPO_ROOT"   # or: grep -rn "<symbol>" "$REPO_ROOT/src"
   ```
3. Find the nearest SIBLING: an existing file that does the same KIND of thing the ticket
   asks for. Read it top to bottom. This sibling defines your naming, layout, error
   handling, and imports. You will copy its shape.
4. Find the test convention: open the sibling's test file. Note the framework, the
   directory, the fixture/factory style, and how tests are named.
5. Find and record the exact build / lint / test / typecheck commands (from
   `Makefile`, `package.json`, `pyproject.toml`, `justfile`, CI config). Record the
   literal command strings — implement will run these.

If you cannot find any sibling for the concern, that is fine — but say so explicitly in
the Approach section and justify the shape you invent by analogy to the closest thing.

### 2. Choose the smallest design that satisfies every AC

The design MUST extend existing patterns, not introduce parallel ones.

- Bad: the repo already has a data-access layer, and you propose a second, differently
  shaped one beside it because you prefer it.
- Good: you add one module that follows the naming, layout, and error style of its
  siblings, wired in the same way they are.

Apply the smallest-design rule. Reject speculative generality:

- No config/flag for a value that has exactly one value today.
- No abstraction (interface, base class, strategy) with a single implementer.
- No new dependency when the stdlib or an already-imported dep does the job.
- Any genuinely-needed new dependency gets a one-line justification in Approach.

Contrast:

- Bad: "Add a `PaymentProvider` abstract base class so we can swap providers later." The
  PRD names one provider. That is one implementer and one speculative future.
- Good: "Add `stripe_charge(amount, token) -> ChargeResult` in `payments.py`, mirroring
  the existing `refund()` alongside it." One function, existing file, existing shape.

If two approaches are genuinely close, pick the one with FEWER new files and note the
alternative in Approach in one line. Do NOT stop to ask.

### Design-in-data

Constants, limits, validation messages, copy strings, and any seed/fixture data are DATA,
not logic. Put them in a data file (a config/constants module, a seed script) and name that
file in the File map — never let the implementer inline them into a code path. Rule: if
changing a value shouldn't require re-reading logic, it belongs in data. If the feature
renders data, the File map MUST include a seed/fixture file so the running product is
non-blank on boot (implement fills it; you name it here).

- Bad: the validation message `"title is required"` hardcoded inside the handler in the File
  map's description.
- Good: a `messages`/`config` file entry the handler reads, named as its own File-map row.

### 3. Trace every AC (this is the core of the job)

Go through `prd.md`'s ACs one at a time, in order. For EACH AC, confirm it is traceable
to three things you will write down:

1. a Contract element (a signature/route/error shape that can produce the behavior),
2. a File map entry (the file where that behavior is added or changed),
3. a Test plan row (a named test whose assertion proves the AC).

If any AC cannot be traced to all three — because the PRD is under-specified,
contradictory, or asks for something the codebase cannot support — do NOT invent a guess
and do NOT silently drop it. That AC is a bounce to groom (see Outcome). Keep going
through the remaining ACs so you can report ALL unsatisfiable ACs in one reject, not one
at a time.

### 3½. Walk the verbs

`prd.md` has a `## Verbs` section. For EACH verb, confirm it resolves to BOTH:

1. a UI surface (a screen or command in your Product direction), AND
2. a route or function in your Contract that actually performs it.

A verb that a screen lists but that has no route/function behind it is the pretty-but-hollow
failure mode — a screen showing data it can never produce. Treat an unresolvable verb exactly
like an untraceable AC: if the PRD demands a verb the codebase or contract cannot support,
reject to groom (Outcome), naming the verb. Do not silently drop it.

### 4. Write `TICKET_DIR/design.md`

Write the file with EXACTLY these sections, in this order:

- **Approach** — the design in a few sentences: why THIS one. Include exactly one rejected
  alternative with a one-line reason. Include any new-dependency justification here.
- **Recon** — the sibling file(s) you copied, and the literal build/lint/test/typecheck
  commands you recorded in step 1. Implement reuses this verbatim.
- **Contract** — the frozen interfaces, written AS CODE wherever the project language
  supports it (a typed block the implementer copies, not prose): exact function/method
  signatures with typed parameters and return types, route method+path+status codes, class
  fields, and error shapes (exception types / error payloads). Prefer precise types over
  loose ones — a string-literal union over a bare string, a typed error payload over "an
  error". Where the language cannot express a piece directly (e.g. an HTTP route table),
  write it as a typed pseudo-declaration precise enough that two people would write the same
  signature. The rule the implementer lives by: **if a route, field, or function is not in
  this section, it does not exist.** Implement MAY NOT change anything here.
- **Product direction** — how the surface must behave and feel, so the implementer builds a
  finished product, not a demo. Direction thin enough to fit in one sentence produces a thin
  product — be specific and opinionated. Cover:
  - **Per screen / user-facing surface:** the layout, the ONE primary action, what the empty
    state shows (icon/label + guidance + an action, never a blank screen), what loading looks
    like (skeletons shaped like the content — not a spinner on white), what the error state
    shows, and one micro-interaction that makes it feel alive (optimistic update, inline
    edit, keyboard shortcut, toast on success).
  - **Per endpoint / command:** the validation rules with their EXACT user-facing error
    messages, the authorization rule (who may call it), and what a malformed or malicious
    request gets back (status + error shape).
  If the ticket has no UI (pure backend/CLI), do the per-endpoint/command half and write "no
  UI surface" for the screen half — do not skip the section.
- **File map** — every file to CREATE or MODIFY, one row each, with a one-line statement of
  what changes in it. This is the implement agent's work order — if a file is not here,
  it does not get touched.
- **Test plan** — a table with one row per AC: `AC# | test name | file | assertion`. EVERY
  AC in `prd.md` must appear at least once. The test name and assertion must be concrete
  enough for implement to write the test without re-reading the PRD.
- **Risks** — at most 3. Each risk gets a one-line mitigation. If you have more than 3,
  keep the 3 most likely to break implement.
- **Self-gauntlet** — the recorded result of step 5 below: one line per lens.

Heartbeat (`fts renew`) after writing the file, per protocol.

### 5. Self-gauntlet — refute your own design before you freeze it

Before the GATE, re-read your own `design.md` adversarially, trying to REFUTE the claim "this
design is sound and ready to implement" through four lenses. This is the last cheap place to
catch a flaw: once implement starts, a design error is inherited by all its code. This is a
lightweight self-check by you, the same worker — the factory's `review` stage is the
independent panel, so do NOT spawn other reviewers here.

1. **Coherence** — does every Contract signature agree with the route/screen that calls it?
   No response type that contradicts the service it must return.
2. **Buildability** — can the existing primitives/siblings you found in Recon actually build
   every screen and endpoint your Product direction describes? Name the gap if not.
3. **Totality** — is every entity and every AC owned by some File-map entry? Nothing readable
   with no route to fetch it; nothing writable with no handler.
4. **Auth/error consistency** — does every endpoint have a stated authorization rule, and are
   all the error shapes it returns drawn from the Contract's error vocabulary?

Record it as the **Self-gauntlet** section: one line per lens — `<lens>: pass`, or
`<lens>: found <X>, fixed by <Y>`. If a lens exposes a flaw you cannot fix without changing
the PRD, that is a reject to groom (Outcome), not a passed gauntlet.

### 6. Bounce-back handling (only if you were rejected from implement)

If the ticket came back from implement, the reject reason lists what was wrong with the
prior design. Add a **Revision notes** section at the TOP of `design.md` (above Approach)
that lists each item from the reject reason and, per item, the exact change you made to
the Contract or File map to resolve it. Do not leave any item unaddressed. Because
artifacts accrete (protocol hard rule), you are updating THIS ticket's `design.md` in
place across revisions — that is expected; you are not rewriting an earlier STAGE's
artifact, you own this one.

## GATE checklist (every box needs evidence, not assumption)

Run through this before your outcome. If any box fails, you FAIL the gate.

1. `design.md` exists in `TICKET_DIR` and has all eight sections (nine if a revision):
   Approach, Recon, Contract, Product direction, File map, Test plan, Risks, Self-gauntlet.
   Evidence: the written file.
2. Recon names a real sibling file that exists in `REPO_ROOT`, and records literal
   build/lint/test/typecheck commands. Evidence: the path exists; the commands are copied,
   not paraphrased.
3. Contract is written as code (typed signatures) — no "TODO", no "something like", no prose
   stand-ins for a signature; loose types tightened where a precise one was a decision.
4. Product direction covers, per screen, the empty/loading/error states + primary action +
   one micro-interaction, and per endpoint the validation messages + auth rule + malformed-
   input response (or "no UI surface" for a pure-backend ticket).
5. File map lists every file implement must create/modify, each with its one-line change,
   including a seed/fixture and any config/constants/copy data file (design-in-data).
6. Test plan maps EVERY AC in `prd.md` to at least one named test. Evidence: count the ACs
   in `prd.md`; count distinct AC numbers in the table; they match.
7. Every verb in `prd.md`'s `## Verbs` resolves to a UI surface AND a contract route/function
   (step 3½). Any that cannot was rejected to groom, not dropped.
8. Smallest-design rule holds: no single-implementer abstraction, no one-value config, no
   unjustified new dependency.
9. Self-gauntlet section records all four lenses (coherence, buildability, totality,
   auth/error consistency) with a pass or a fixed-by line.
10. (Revision only) Every item in the implement reject reason has a matching Revision-notes
    entry.

## Outcome

Exactly one of the following, then exit via protocol step 7. The FTS outcome/artifact is
the report; do not send a duplicate routine message.

- **PASS** — all gate boxes checked. `NEXT_STAGE` is `implement`.
  ```bash
  fts complete --db "$FTS_DB" --ticket "$TICKET_ID" --worker "$WORKER_ID" --epoch "$EPOCH" \
    --note "design.md written; N ACs mapped to tests"
  fts advance  --db "$FTS_DB" --ticket "$TICKET_ID" --worker "$WORKER_ID" --to-stage "$NEXT_STAGE" \
    --note "ready for implement"
  ```

- **REJECT to groom** — one or more ACs cannot be satisfied, or `prd.md` is contradictory.
  `BOUNCE_STAGE` is `groom`. Do NOT write a design that papers over the gap. Put one line
  per unsatisfiable AC in the reason, using EXACTLY this format:

  `AC<n> | why it cannot be satisfied | what the PRD must clarify or change`

  Separate multiple ACs with ` ;; `. Example:

  ```bash
  fts reject --db "$FTS_DB" --ticket "$TICKET_ID" --worker "$WORKER_ID" --epoch "$EPOCH" \
    --reason "AC3 | requires per-tenant rate limits but PRD gives no limit value or scope | specify the limit and whether it is per-tenant or global ;; AC5 | contradicts AC2 (sync vs async delivery) | pick one delivery model" \
    --to-stage "$BOUNCE_STAGE"
  ```

- **STUCK** — missing input (no `prd.md`), broken repo checkout, or fts renew fenced you.
  Do NOT complete, do NOT reject. Mail your parent the exact blocker and exit (protocol
  step 6, STUCK path). The ticket re-queues.

## Failure modes

| Symptom | Cause | Do instead |
| --- | --- | --- |
| You start writing signatures without reading the repo | skipped recon | Stop. Do step 1. Find and read the sibling file first. |
| Design adds a parallel layer beside an existing one | ignored existing pattern | Rewrite to extend the sibling's shape; a second layer is a design smell. |
| An AC has no test-plan row | dropped a requirement | Never drop. Either map it, or reject that AC to groom with the format above. |
| Abstract base class / config flag with one user today | speculative generality | Delete it. Inline the single case. Add abstraction when the second user is real. |
| New dependency added "for convenience" | unjustified dep | Use stdlib / existing deps, or add a justification line — or drop it. |
| PRD says X in one AC and not-X in another | contradictory input | Do NOT guess. Reject to groom naming both AC numbers. |
| Two viable approaches, you paused to ask | uncertainty mishandled | Pick the one with fewer new files, note the other in Approach, continue. |
| Bounced from implement, you rewrote from scratch | ignored the reject reason | Add Revision notes addressing each reject item; adjust Contract/File map. |
| Product direction reads "build the screen, make it clean" | direction too thin | Rewrite it per-screen: empty/loading/error states, primary action, one micro-interaction. Thin direction ships a thin product. |
| A verb lists on a screen but has no route/function | pretty-but-hollow | Add the route/function to the Contract, or reject to groom naming the verb. A screen can't show data it can't produce. |
| Constants/messages/copy inlined into a handler description | design-in-data violated | Move them to a named data file in the File map; the handler reads them. |
| Self-gauntlet skipped or all four lenses stamped "pass" without reading | rubber-stamp | Actually try to refute each lens; record what you found and fixed. A trivially-passing gauntlet caught nothing. |
| Same error blocks you twice | a wrong assumption | Re-read `prd.md` and `_protocol.md`; if still stuck, use the STUCK path. |
