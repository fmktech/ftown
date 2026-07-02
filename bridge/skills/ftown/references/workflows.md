# ftown-workflows

`ftown-workflows` is a **scripted orchestration engine** for real ftown sessions.
You write a `.mjs` script using a small API (`agent`, `parallel`, `pipeline`,
`phase`, `log`, `args`, `budget`) and the runner spawns real ftown sessions (claude /
cursor / codex), waits for each to write a result file, cleans up, and returns the
value — all deterministically and repeatably.

This complements the by-hand orchestrator playbook in
`references/orchestrator.md`. Use ftown-workflows when the work is scripted and
repeatable; use orchestrator guidance when you need to improvise or keep a
human in the loop.

This is separate from **scheduled loops** managed by `~/.ftown/ftown-sessions
loop ...`. Scheduled loops create recurring ftown sessions over time. A workflow
loop is control flow inside one deterministic workflow run.

## Operating Contract

Use ftown-workflows to encode deterministic multi-session control flow: fan-out,
verification, synthesis, loops, retries, and resumable handoffs. The workflow
script is where the structure lives: which workers run independently, which
results are verified, where a barrier is necessary, and what gets returned.

Do not infer workflow permission just because a task might benefit from
parallelism. Run a workflow only when the user explicitly asks for one, asks for
multi-agent orchestration, asks to fan out workers, names `ftown-workflows`, asks
to run a specific workflow, or invokes a skill/command whose instructions require
this skill. Otherwise, answer inline or describe the workflow you would run and
ask before spending the user's tokens.

If the user explicitly says this task **must use ftown-workflows**, a manual
simulation is not enough. Create a `.flow.mjs` script and run it with
`~/.ftown/ftown-workflows`.

## Scout First

Start with a cheap inline scout before writing the workflow script: list relevant
files, search call sites, scope the diff, read key modules, and identify whether
the task is understanding, design, review, research, migration, or greenfield
build. You do not need the final DAG before starting the task; you need the
work-list and shape before orchestration.

Common single-phase shapes:

| Intent | Shape |
| --- | --- |
| Understand | readers over subsystems -> structured map |
| Design | independent approaches -> judge panel -> scored synthesis |
| Review or audit | dimensions -> find -> adversarial verify -> synthesis |
| Research | search/read sweep -> deep read -> verify -> cited synthesis |
| Migrate | discover sites -> transform isolated slices -> verify |
| Greenfield build | scout stack -> contract-first prep -> modules -> compile/review |

For large work, run several small workflows in sequence instead of one giant
script. Read each result before deciding the next phase. A practical split is:

```text
discovery-design.flow.mjs -> implementation-review.flow.mjs
```

The discovery/design workflow discovers constraints, compares approaches, writes
a durable handoff (`discovery-design.handoff.json`, `plan.json`, `specs/`, a
rubric), and stops. The implementation/review workflow consumes that handoff,
implements the work-list, integrates, verifies, and repairs against the rubric.

## Pipeline By Default

Default to `ctx.pipeline(...)` for multi-stage work. Each item should advance as
soon as its previous stage finishes; do not make fast items wait for the slowest
item unless the next stage genuinely needs all prior results at once.

A barrier with `ctx.parallel(...)` is correct when a later stage needs
cross-item context:

- deduping or merging all findings before expensive verification
- early exit when the full result set is empty
- comparing one finding against the other findings

A barrier is not justified by ordinary mapping/filtering, by conceptual phase
boundaries, or by code tidiness. Put per-item transforms inside a pipeline stage.
When unsure, pipeline.

Use explicit `phase` names in `ctx.agent(..., { phase })` inside pipelines and
parallel stages so progress groups are stable even when stages interleave.

## Quality Patterns

Pick and compose these patterns based on the user's request:

- **Adversarial verify:** for each claim/finding, spawn independent skeptics
  asked to refute it. Keep a finding only if it survives the vote.
- **Perspective-diverse verify:** use distinct verifier lenses such as
  correctness, security, performance, reproducibility, and UX instead of cloned
  prompts.
- **Judge panel:** generate multiple independent solutions, have judges score
  them, then synthesize from the winner while preserving useful ideas from
  runners-up.
- **Loop-until-dry:** for unknown-size discovery, keep launching finder rounds
  until a fixed number of consecutive rounds returns nothing new.
- **Multi-modal sweep:** search by different axes (file path, call graph,
  content, timestamp, dependency, runtime behavior) and merge findings.
- **Completeness critic:** end with a worker that asks what was missed: unread
  sources, unverified claims, uncovered modalities, or dropped work.
- **No silent caps:** if you cap coverage, sampling, retries, or result counts,
  log what was skipped with `ctx.log()`.

Scale to the wording. "Find any bugs" can be a small finder set and one verifier.
"Thoroughly audit" or a large explicit budget should increase finder diversity,
verification votes, and loop-until-dry depth.

## Dependent Phases

`ctx.agent()` returns `null` instead of throwing when a worker times out, exits
without a result, exhausts budget, or writes `{ "ok": false }`. That is useful
for optional fan-out, but dangerous for dependent phases. Fail fast before
implementation, verification, or synthesis depends on a missing result.

Use this guard in workflow scripts:

```js
function requireAgentResult(value, label) {
  if (value == null) {
    throw new Error(`${label} failed; aborting dependent workflow phases`);
  }
  return value;
}
```

Optional fan-out may filter failures with `.filter(Boolean)`. Required handoffs,
module implementations, verifiers, and final synthesis should use the guard.

## Greenfield Builds

When a workflow is building a whole app, game, service, library, or system from
scratch, the discovery/design phase should include contract-first prep before
implementation fan-out. Read and apply:

```text
~/.claude/skills/contract-first-prep/SKILL.md
~/.claude/skills/contract-first-prep/references/contract-guide.md
```

The prep worker should produce the parallel-safe handoff:

- minimal scaffold with a strict typecheck/build gate
- immutable type/interface contract for cross-module boundaries
- pure-data config plus shared low-level helpers
- disjoint module decomposition (`plan.json`) and per-module specs

The later implementation/review workflow treats that contract, config, and shared
helpers as frozen. Workers adapt their modules to the contract; only the
integrator performs broad wiring. If review finds a design flaw, launch a new
discovery/design workflow instead of letting implementers redesign in parallel.

Skip contract-first prep for small edits, single-file scripts, or established
codebases that already have their own architecture.

## Running a workflow

You must be **inside an ftown session** — `FTOWN_SESSION_ID` must be set.

```bash
~/.ftown/ftown-workflows run path/to/script.mjs
```

> **Caveat:** run ftown-workflows from a **top-level orchestrator session**. If the
> session running it is itself a child, the bridge flattens the tree so spawned
> workers become **siblings** of the orchestrator rather than its children. Results
> are file-based, so this does not affect correctness — only the dashboard topology.

Child/subagent sessions **can run workflows**. Do not refuse just because
`FTOWN_PARENT_SESSION_ID` is set or because the current session was spawned by
another agent. The only hard requirement is `FTOWN_SESSION_ID` plus a reachable
bridge. The parent/child caveat above is about dashboard topology, not
capability: results still flow through files under `~/.ftown/workflows/<run-id>/`.

Full options:

```bash
~/.ftown/ftown-workflows run <script.mjs> \
  [--args <json>]          # parsed and available as ctx.args in the script
  [--workdir <path>]       # default working dir for spawned child sessions
  [--shell claude|cursor|codex|opencode|shell]
  [--concurrency <n>]      # max simultaneous live sessions (default 4)
  [--timeout <ms>]         # per-agent timeout (default 1 800 000 = 30 min)
  [--max-agents <n>]       # hard budget cap on total spawns
  [--run-id <id>]          # resume a previous run (skip completed steps)
  [--json]                 # print final result as raw JSON
```

The runner prints the **run directory** (`~/.ftown/workflows/<run-id>/`) at start.
For long runs, launch in the background and tail the run dir:

```bash
~/.ftown/ftown-workflows run script.mjs --args '{"pr":42}' &
tail -f ~/.ftown/workflows/<run-id>/*.json
```

See the runnable template at `scripts/example.flow.mjs` in this skill directory.

## Script API

A workflow script is an ES module. Its **default export** (or named `run` export)
is an async function that receives a `WorkflowContext`:

```js
// my-workflow.mjs
export default async function (ctx) {
  ctx.phase('Gather');
  ctx.log(`args: ${JSON.stringify(ctx.args)}`);

  const summary = await ctx.agent('Summarise the repo README', {
    label: 'summarise',
    workdir: '/path/to/repo',
  });

  ctx.log(`summary: ${summary}`);
  return summary;
}
```

### `ctx.agent(prompt, opts?)`

Spawns one real ftown session. Blocks until the session writes its result file,
then removes the session and returns the result.

- Without `schema`: returns a **string** (or `null` on failure/timeout). A string
  `result` is returned as-is; a non-string `result` is returned as a JSON string.
- With `schema`: returns the child's `result` JSON value **as-is** (parsed from the
  result file), or `null` on failure. The engine does **not** validate `result`
  against the schema — the schema is embedded in the child's prompt as guidance only.
  Treat conformance as best-effort and validate it yourself if you depend on it.

Returns `null` — never throws — for: timeout, session exits without a result,
`ok: false` in the result, budget exhausted.

Key options:

| option | default | meaning |
|---|---|---|
| `label` | `step-<n>` | step key used for the result file and resume |
| `phase` | — | progress grouping shown in logs |
| `schema` | — | JSON Schema embedded in the worker prompt; requests JSON result |
| `shell` | run-level default | `claude` / `cursor` / `codex` / `opencode` / `shell` |
| `model` | — | model override passed to the session |
| `workdir` | run-level default | working directory for the child session |
| `timeoutMs` | 1 800 000 | wall-clock cap for this step |
| `pollIntervalMs` | 2000 | how often to check for the result file |

### `ctx.parallel(thunks)`

Run an array of thunks concurrently (barrier: waits for all). Respects the
run-level `--concurrency` cap. A thunk that errors → `null` entry; the call
never rejects.

```js
const reviews = await ctx.parallel(
  files.map(f => () => ctx.agent(`Review ${f}`, { label: `review-${f}` }))
);
```

### `ctx.pipeline(items, ...stages)`

Thread each item through a sequence of stages independently (no barrier between
stages). A stage that throws drops that item to `null` and skips its remaining
stages.

```js
const results = await ctx.pipeline(
  files,
  async (file) => ctx.agent(`lint ${file}`, { label: `lint-${file}` }),
  async (lintResult, file) => ctx.agent(`fix issues in ${file}: ${lintResult}`, { label: `fix-${file}` }),
);
```

### `ctx.phase(title)` / `ctx.log(message)`

Emit progress events to stderr. Use `phase` for major milestones, `log` for
detail lines.

### `ctx.args`

The value passed via `--args <json>` (parsed). `undefined` if not provided.

### `ctx.budget`

```js
ctx.budget.maxAgents   // null = unbounded
ctx.budget.spent()     // spawns so far (cached don't count)
ctx.budget.remaining() // maxAgents - spent(), or Infinity
```

## Result-file contract

Each child session receives a prompt that ends with a protocol block instructing
it to write its final result as JSON to a specific file path and then stop:

```json
{ "ok": true, "result": "...anything..." }
```

or on failure:

```json
{ "ok": false, "error": "reason" }
```

The engine polls the file every `pollIntervalMs` ms. A partial write (incomplete
JSON) is silently ignored until it is valid. The child session is removed (archived)
once the result is read, or on timeout/exit.

**You do not write this file yourself** — the child agent is instructed to do it.
The prompt injected by the engine tells the child agent exactly what to write.

## Script Patterns

Scripts are plain JavaScript modules. Avoid nondeterministic labels or control
flow (`Date.now()`, `Math.random()`, timestamp-derived labels) when you care
about resume, because cached results are matched by step order and label.

### Canonical Pipeline

Each item moves through review and verification independently. One file can be
verifying while another is still reviewing.

```js
export default async function (ctx) {
  const results = await ctx.pipeline(
    ctx.args.files,
    (file) => ctx.agent(`Find bugs in ${file}`, {
      label: `find-${file}`,
      phase: 'Find',
      schema: FINDINGS_SCHEMA,
    }),
    (review, file) => ctx.parallel(
      (review?.findings ?? []).map((finding, i) => () => ctx.agent(
        `Try to refute this finding:\n${JSON.stringify(finding)}`,
        { label: `verify-${file}-${i}`, phase: 'Verify', schema: VERDICT_SCHEMA },
      ).then((verdict) => ({ file, finding, verdict })))
    ),
  );

  return results.flat().filter(Boolean).filter((r) => r.verdict?.isReal);
}
```

### Correct Barrier

Use a barrier when deduplication or comparison needs every prior result.

```js
export default async function (ctx) {
  ctx.phase('Find');
  const reviews = await ctx.parallel(
    ctx.args.dimensions.map((d) => () => ctx.agent(d.prompt, {
      label: `find-${d.key}`,
      schema: FINDINGS_SCHEMA,
    })),
  );

  const allFindings = reviews.filter(Boolean).flatMap((r) => r.findings ?? []);
  const deduped = dedupeByFileAndTitle(allFindings);
  if (deduped.length === 0) return { confirmed: [] };

  ctx.phase('Verify');
  const verified = await ctx.parallel(
    deduped.map((finding, i) => () => ctx.agent(
      `Verify this deduped finding:\n${JSON.stringify(finding)}`,
      { label: `verify-${i}`, schema: VERDICT_SCHEMA },
    ).then((verdict) => ({ finding, verdict }))),
  );

  return { confirmed: verified.filter(Boolean).filter((r) => r.verdict?.isReal) };
}
```

### Loop Until Dry

Use this for unknown-size searches. Dedup against everything seen, including
rejected findings, so the loop converges.

```js
export default async function (ctx) {
  const seen = new Set();
  const confirmed = [];
  let dryRounds = 0;

  while (dryRounds < 2 && ctx.budget.remaining() > 0) {
    ctx.phase(`Find round ${dryRounds + 1}`);
    const found = await ctx.agent('Find more bugs not already covered.', {
      label: `find-round-${confirmed.length}-${dryRounds}`,
      schema: FINDINGS_SCHEMA,
    });

    const fresh = (found?.findings ?? []).filter((finding) => {
      const key = `${finding.file}:${finding.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (fresh.length === 0) {
      dryRounds += 1;
      ctx.log(`dry round ${dryRounds}/2`);
      continue;
    }
    dryRounds = 0;

    const judged = await ctx.parallel(
      fresh.map((finding, i) => () => ctx.agent(
        `Try to refute this finding:\n${JSON.stringify(finding)}`,
        { label: `judge-${seen.size}-${i}`, phase: 'Verify', schema: VERDICT_SCHEMA },
      ).then((verdict) => ({ finding, verdict }))),
    );
    confirmed.push(...judged.filter(Boolean).filter((r) => r.verdict?.isReal));
  }

  return { confirmed };
}
```

### Budget-Bounded Depth

Guard loops with a real cap. With no `--max-agents`, `ctx.budget.remaining()` is
`Infinity`, so add an explicit round limit or require a max-agent budget.

```js
export default async function (ctx) {
  const rounds = ctx.budget.maxAgents == null ? 3 : ctx.budget.maxAgents;
  const results = [];

  for (let i = 0; i < rounds && ctx.budget.remaining() > 0; i += 1) {
    const result = await ctx.agent(`Research angle ${i + 1}`, {
      label: `research-${i + 1}`,
      schema: RESEARCH_SCHEMA,
    });
    if (result) results.push(result);
    ctx.log(`${i + 1}/${rounds} research rounds complete`);
  }

  return results;
}
```

## Resume

Every step is keyed by its `label` (or `step-<n>`). If a result file already
exists for a step, the engine returns the cached result without spawning a new
session. To resume a partial run:

```bash
~/.ftown/ftown-workflows run script.mjs --run-id <the-previous-run-id>
```

The run id and run directory are printed at startup.

## When to use this vs orchestrator guidance

| | orchestrator guidance | ftown-workflows |
|---|---|---|
| **style** | ad-hoc, by hand | scripted, deterministic |
| **human in loop** | yes — you direct workers via mail | no — script drives everything |
| **repeatability** | each run is improvised | same script, same steps |
| **resume** | manual | automatic via `--run-id` |
| **best for** | exploratory tasks, escalations, debugging | batch jobs, CI-style pipelines, fan-out reviews |

## If the CLI is missing

Start or restart **ftown-bridge** on this machine. It installs
`~/.ftown/ftown-workflows` and updates the unified skill under
`~/.ftown/skills/ftown/` (linked into ~/.agents/skills and ~/.claude/skills).
