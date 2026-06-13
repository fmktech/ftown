---
name: ftown-workflows
description: >-
  Run deterministic, scripted, resumable multi-session workflows across real
  ftown agent sessions. Activates when the user wants to fan out ftown worker
  sessions over a work list, run a pipeline or parallel batch across ftown
  sessions, perform adversarial-verify (majority-vote) across sessions,
  loop-until-dry over a dataset, or write a repeatable orchestration script
  instead of doing it by hand.
---

# ftown-workflows

`ftown-workflows` is a **scripted orchestration engine** for real ftown sessions.
You write a `.mjs` script using a small API (`agent`, `parallel`, `pipeline`,
`phase`, `log`, `args`, `budget`) and the runner spawns real ftown sessions (claude /
cursor / codex), waits for each to write a result file, cleans up, and returns the
value — all deterministically and repeatably.

This complements the by-hand **ftown-orchestrator** skill (which is the ad-hoc,
human-in-the-loop playbook). Use ftown-workflows when the work is scripted and
repeatable; use ftown-orchestrator when you need to improvise or keep a human in
the loop.

## Running a workflow

You must be **inside an ftown session** — `FTOWN_SESSION_ID` must be set.

```bash
~/.ftown/ftown-workflows run path/to/script.mjs
```

> **Caveat:** run ftown-workflows from a **top-level orchestrator session**. If the
> session running it is itself a child, the bridge flattens the tree so spawned
> workers become **siblings** of the orchestrator rather than its children. Results
> are file-based, so this does not affect correctness — only the dashboard topology.

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

See the runnable template at `skills/ftown-workflows/scripts/example.flow.mjs`.

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
| `schema` | — | JSON Schema; forces JSON result |
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

## Patterns

### Parallel fan-out

```js
export default async function (ctx) {
  const items = ctx.args.items;  // e.g. ["auth.ts", "api.ts", "db.ts"]

  ctx.phase('Review');
  const reviews = await ctx.parallel(
    items.map(f => () => ctx.agent(`Review ${f} for security issues`, {
      label: `review-${f}`,
    }))
  );

  ctx.phase('Synthesise');
  const report = await ctx.agent(
    `Synthesise these security reviews:\n${reviews.filter(Boolean).join('\n---\n')}`,
    { label: 'synthesis' },
  );

  return report;
}
```

### Pipeline (multi-stage per item)

```js
export default async function (ctx) {
  return ctx.pipeline(
    ctx.args.files,
    (file) => ctx.agent(`Lint ${file}`, { label: `lint-${file}` }),
    (lintOut, file) => ctx.agent(`Fix ${file} based on: ${lintOut}`, { label: `fix-${file}` }),
    (fixOut, file) => ctx.agent(`Write tests for ${file}`, { label: `test-${file}` }),
  );
}
```

### Adversarial verify (majority vote)

```js
export default async function (ctx) {
  const claim = ctx.args.claim;
  const REVIEWERS = 3;

  ctx.phase('Verify');
  const verdicts = await ctx.parallel(
    Array.from({ length: REVIEWERS }, (_, i) =>
      () => ctx.agent(
        `You are a skeptical reviewer. Is this claim correct? "${claim}" Reply with just "yes" or "no".`,
        { label: `skeptic-${i}` },
      )
    )
  );

  const yes = verdicts.filter(v => v?.toLowerCase().startsWith('yes')).length;
  return { claim, verdict: yes > REVIEWERS / 2 ? 'accepted' : 'rejected', votes: verdicts };
}
```

### Loop-until-dry

```js
export default async function (ctx) {
  let queue = [...ctx.args.items];
  const done = [];

  while (queue.length > 0 && ctx.budget.remaining() > 0) {
    ctx.phase(`Batch (${queue.length} remaining)`);
    const batch = queue.splice(0, 4);
    const results = await ctx.parallel(
      batch.map(item => () => ctx.agent(`Process: ${item}`, { label: `proc-${item}` }))
    );
    done.push(...results.filter(Boolean));
  }

  return done;
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

## When to use this vs ftown-orchestrator

| | ftown-orchestrator | ftown-workflows |
|---|---|---|
| **style** | ad-hoc, by hand | scripted, deterministic |
| **human in loop** | yes — you direct workers via mail | no — script drives everything |
| **repeatability** | each run is improvised | same script, same steps |
| **resume** | manual | automatic via `--run-id` |
| **best for** | exploratory tasks, escalations, debugging | batch jobs, CI-style pipelines, fan-out reviews |

## If the CLI is missing

Start or restart **ftown-bridge** on this machine. It installs
`~/.ftown/ftown-workflows` and updates this skill under
`~/.ftown/skills/ftown-workflows/` (linked into ~/.agents/skills and ~/.claude/skills).
