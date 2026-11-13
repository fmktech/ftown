# Quota-aware routing

Read `../SKILL.md` for identity and reporting. This reference covers choosing the
CLI, model and effort for delegated work. The owner sets up tiers; you choose.
`ftown quota` reports data and never chooses for you.

## When to use

- Before `ftown sessions create` for a child whose harness you are free to pick.
- When a worker stopped on a usage limit, before re-routing its task.
- Not needed when the user named the harness or model. Keep their choice.

## What to run

```bash
ftown quota --json                    # full report
ftown quota claude codex --json       # only the named harnesses
ftown quota --json --no-models        # skip model lists (picks become unchecked)
ftown quota --json --timeout 30       # per-harness limit, 1-600 s, default 15
```

Harnesses: `claude`, `codex`, `grok`, `muse`, `agy`, `opencode`. If `ftown` is
not on PATH, use `~/.ftown/ftown quota`. `--models` only affects table mode.

A run takes several seconds. It launches hidden local CLIs to read their usage
and model lists. It makes no model turns. The numbers describe the owner's
subscription plans (5-hour and weekly windows), not API spend.

## Decision procedure

The owner configures tiers in the dashboard ("Model routing..." on a bridge).
Each tier has a `name`, a `description` of the work it is for, an ordered list of
`picks` (CLI + model + effort), and free-text `guidance`. The report also has a
global free-text `steering`.

1. Read `routingConfig.status`. If it is not `ok`, see "When things are missing".
2. Match the task to a tier by the tier `description`s. Pick the closest one.
3. Walk that tier's `picks` in order. Skip any pick whose `problem` is not null:
   the model is gone or the effort is unsupported.
4. Weigh each remaining pick: `availability`, `leftPercent` (null when `unknown`),
   `resetsAt` (null when `unknown`), and `scopedLimits`. A scoped limit (for example
   one model family) can be tighter than the plan-wide figure. Scopes usually name a
   model family that appears in the model id or name, so matching a scope to a pick
   is your judgment; when several match use the one with most used.
5. `checked: false` means the harness's model list could not be read, so the pick
   was not verified. It is usable with care: expect a possible launch failure.
6. Apply the tier's `guidance` and the global `steering`. They are the owner's
   instructions and outrank the pick order when they conflict. Example: if
   steering says "don't fully exhaust Claude", skip a Claude pick that is `low`
   even when it is first.
7. Guidance is free text and may name a class, such as "otherwise any free
   opencode model". Resolve it against `models`: filter that provider's
   `models[].models[]` by `pricing` and choose one that fits the task. If that
   provider's list is empty you cannot resolve the class, so fall back to `routing[]`
   and say so. `pricing` is `free` (zero-priced), `included` (covered by a plan the
   owner holds) or `paid` (billed per use). It is omitted when unknown.
8. Launch the choice (next section). Report to the user which tier and pick you
   used, and why if you departed from the pick order.

## Availability values

Each pick carries its provider's `availability`. The same values appear in `routing[]`.

- `available`: enough left for normal work. Use it.
- `low`: `leftPercent` below 15 in the binding (tightest) window, or `runway`
  below 0.5 when `runway` is not null. Use only for small tasks, when guidance
  allows it, or when nothing `available` fits.
- `exhausted`: `leftPercent` 1 or less. Never use it before `resetsAt`.
- `unknown`: no usable numbers. It is not proof of empty or full quota. It ranks
  below `low` and above `exhausted`; use it as a fallback after `available` and
  `low`, and say so.

If a window resets within 10 minutes it is reported as `available` with `leftPercent`
100 and `runway` null, even if `usedPercent` was high. `routing[]` is ordered best
first as available, then low, then unknown, then exhausted.

`leftPercent` is percent left in the binding (tightest) window. `windows[].usedPercent`
in `providers` is percent used. Do not mix them up.

## Turning a pick into a launch

Find the provider's entry in `models`. It gives `modelFlag` (for example
`--model <id>`) and `effortFlag` (for example `--effort <level>`, or null when
the harness has no effort flag). Use the pick's `model` as the id, verbatim, and
its `effort` as the level. `effort: null` means omit the effort flag.

opencode takes effort as a `#variant` suffix on the model, for example
`provider/model#high`. Check its `effortFlag` and the model's `efforts` in the report.

```bash
ftown sessions create --shell <provider> --model <id> --parent \
  --workdir "$PWD" --name review-auth --prompt "..."
```

Where `ftown sessions create` has no flag for the effort, apply `effortFlag` as
the harness documents it. Omit `--model` to take the harness default.

## When things are missing

- `routingConfig.status` is `missing`: the owner has set no tiers. `tiers` is
  empty. Walk `routing[]` in order (already best first: available, low, unknown,
  exhausted): take the first `available`, else `low` only for small tasks, else
  `unknown` with disclosure, and never use `exhausted` before its `resetsAt`.
  Pick a model from `models` and tell the user no tiers are configured.
- `routingConfig.status` is `invalid`: `routingConfig.errors` lists the problems.
  Treat it like `missing`, and tell the user the file at `routingConfig.path`
  needs fixing. Still honor `steering` if it is non-empty.
- An empty tier (no `picks`): use its `guidance` if it has any; otherwise fall
  back to `routing[]`.
- Every pick unusable (all have a `problem`, or are `exhausted`): follow the
  guidance if it names an alternative. Otherwise try the next closest tier, then
  `routing[]`. If nothing is usable, stop and ask the user rather than launching
  on an exhausted plan.
- A provider with `status` other than `ok` (`no_data`, `auth`, `unavailable`,
  `error`): read its `message`. Its routing is `unknown`. For `auth`, tell the
  user what to fix. A `models` entry with status other than `ok` has an empty
  `models` list, so its picks are `checked: false`.
- opencode may expose no plan usage at all, so when it reports no windows its
  availability will be `unknown`. That is expected when it happens. Judge it by
  `pricing` (`free` models are safe to use) and by the owner's guidance, not by
  quota.

## JSON field reference

| Field | Meaning |
|---|---|
| `generatedAt` | ISO time of the report |
| `providers[]` | raw readings: `provider`, `status`, `plan`, `windows[]`, `source`, `observedAt`, `message`, optional `scopedLimits[]` |
| `providers[].windows[]` | `kind` (`five_hour`/`weekly`), `usedPercent` (used, may be null), `resetsAt`, `windowMinutes`, `note` |
| `scopedLimits[]` | partial limit: `scope` (e.g. a model family), `kind`, `usedPercent`, `resetsAt` |
| `routing[]` | per provider, best first: `provider`, `availability`, `leftPercent`, `bindingWindow`, `resetsAt`, `resetsInMinutes`, `runway` (1 = on pace, >1 spare, <1 will run out early, null when length or reset unknown), `reason` |
| `models[]` | per provider: `provider`, `status` (`ok`/`unavailable`/`error`; empty `models` unless `ok`), `models[]`, `source` (`live`/`cached`), `observedAt`, `message`, `modelFlag`, `effortFlag` |
| `models[].models[]` | `id`, `name`, `isDefault`, `description`, `contextTokens`, `efforts[]`, `defaultEffort`, optional `pricing` |
| `routingConfig` | `status` (`ok`/`missing`/`invalid`), `path`, `errors[]` |
| `tiers[]` | `name`, `description`, `picks[]`, `guidance`. Empty unless status is `ok` |
| `tiers[].picks[]` | `provider`, `model`, `effort`, `modelName`, `availability`, `leftPercent`, `resetsAt`, `scopedLimits[]`, `problem`, `checked` |
| `steering` | global owner instructions, verbatim, `""` when none |

Trimmed example (invented values):

```json
{
  "routingConfig": { "status": "ok", "path": "/home/u/.ftown/model-routing.json", "errors": [] },
  "steering": "Don't fully exhaust Claude.",
  "tiers": [
    {
      "name": "complex",
      "description": "Hard development and debugging",
      "guidance": "Otherwise any free opencode model.",
      "picks": [
        { "provider": "claude", "model": "model-a", "effort": "high", "modelName": "Model A",
          "availability": "low", "leftPercent": 9, "resetsAt": "2026-01-05T00:00:00Z",
          "scopedLimits": [], "problem": null, "checked": true },
        { "provider": "codex", "model": "model-b", "effort": "medium", "modelName": null,
          "availability": "available", "leftPercent": 70, "resetsAt": "2026-01-06T00:00:00Z",
          "scopedLimits": [], "problem": null, "checked": true }
      ]
    }
  ],
  "models": [
    { "provider": "codex", "status": "ok", "modelFlag": "--model <id>", "effortFlag": "--effort <level>",
      "models": [ { "id": "model-b", "efforts": ["low", "medium", "high"], "pricing": "included" } ] }
  ]
}
```

Here the first pick is `low` and steering says not to exhaust Claude, so choose
the second pick: `codex`, `model-b`, effort `medium`.

## Limits

- Grok has only a weekly window. `FTOWN_QUOTA_GROK_NO_REFRESH=1` skips its hidden
  refresh and uses the last logged value.
- opencode lists only its subscription providers by default. Override with
  `FTOWN_QUOTA_OPENCODE_PROVIDERS=a,b`.
- The tool does not rank models by capability. The owner's tiers and your
  judgment decide.
