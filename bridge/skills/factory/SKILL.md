---
name: factory
description: deploy and manage a per-project AI software factory (init/up/down/status/teardown) — FTS ticket pipeline + ftown loops. Trigger on "factory init", "deploy a factory", "factory status", "pause the factory".
---

<!-- Vendored from the ffactory repo (skills/factory + factory-template); sync changes there first. -->

# Factory

You are a capable model helping a human deploy and operate a per-project AI software
factory: a `fticket` (`fts`) ticket pipeline driven by three ftown loops (a dispatcher
that spawns stage workers, a preflight-guarded interval triage sweep, and a daily digest
report). This skill is procedures, not narrative — follow the exact commands. It runs
inside the target project repo (`$REPO` = repo root, resolved via
`git rev-parse --show-toplevel`).

## Layout

- `factory/` — checked into the project repo, the factory's *definition*:
  `factory.yaml` (stages, limits, triage config), `skills/*.md` (stage worker briefings +
  `_protocol.md`), `bin/dispatch.py`.
- `.ffactory/` — gitignored, the factory's *runtime state*: `factory.db` (fts sqlite),
  `tickets/<n>/` (per-ticket artifact folders), `worktrees/` (implement-stage checkouts),
  `dispatch.cursor` (dispatcher bookmark). Disposable — deleting it loses history but not
  the factory's definition.

## init

Idempotent. If `factory/` already exists in `$REPO`, stop and tell the user the factory is
already initialized (point them at `status`/`up`/`down` instead) — do not overwrite.

1. **Preconditions.** Confirm `$REPO` is a git repo. Run `~/.ftown/ftown-sessions list` —
   if it errors, the bridge is down; stop and tell the user to start it first. Confirm
   `uv` is on PATH.
2. **Install fticket.** `uv tool install fticket` (or `uv tool upgrade fticket` if already
   installed). Verify with `fts --help`.
3. **Copy the template.**
   ```bash
   cp -r ~/.ftown/skills/factory/factory-template "$REPO/factory"
   ```
   `factory/bin` moves in as-is (no edits). Ask the user for: project name (default: the
   repo directory's basename), an operator ftown session id (optional — default `-`, no
   operator mail), and any stage routing tweaks (harness/model/max_workers per stage).
   Edit `factory/factory.yaml` with their answers.
4. **Gitignore + state dirs.** Append `.ffactory/` to `$REPO/.gitignore` (create the file
   if absent). `mkdir -p "$REPO/.ffactory/tickets"`.
5. **Init the ticket db**, reading stage order and limits back out of the edited
   `factory.yaml`:
   ```bash
   fts init --db .ffactory/factory.db \
     --stages groom,design,implement,review,qa,pr \
     --bounce-limit 3 --claim-ttl-ms 1800000
   ```
   (substitute the actual stage names in yaml order, `limits.bounce_limit`, and
   `limits.claim_ttl_ms`).
6. **Register the loops, grouped under one factory label.** The `--group` flag folds all
   loops together in the ftown dashboard and requires ftown bridge PR #29. If
   `loop create` rejects `--group` as an unknown flag, tell the user their bridge is out
   of date and needs updating — do not silently drop the flag and register ungrouped.

   Dispatcher (interval loop, runs the Python dispatcher every tick):
   ```bash
   ~/.ftown/ftown-sessions loop create \
     --name "<project>-dispatch" --every 30s --shell shell --workdir "$REPO" \
     --group "Factory: <project>" --max-runtime 10m --retention 10 \
     --preflight "~/.local/bin/fts queues --db $REPO/.ffactory/factory.db --json | python3 -c 'import json,sys; qs=json.load(sys.stdin); sys.exit(0 if any(q.get(\"queued\",0)+q.get(\"claimed\",0)+q.get(\"in_progress\",0)+q.get(\"blocked\",0) for q in qs) else 1)'" \
     --task "uv run --python 3.13 --with fticket,pyyaml python factory/bin/dispatch.py"
   ```
   (`--every` from `limits.dispatch_every`. The preflight skips the tick — no shell
   session — while no ticket is queued/claimed/in_progress/blocked, so an idle factory
   costs nothing. A resting `rejected`/`dead_letter` ticket doesn't wake it: those belong
   to explicit chaining and triage respectively.)

   Triage (interval loop with a preflight skip guard — only spawns a session when there
   is dead-letter/orphan work; requires ftown bridge >= 0.18.0 for cheap preflight skips —
   on 0.17 the preflight still works but bloats run history since a skip still logs a
   run):
   ```bash
   ~/.ftown/ftown-sessions loop create \
     --name "<project>-triage" --every 10m --shell claude --model sonnet \
     --workdir "$REPO" --group "Factory: <project>" --retention 10 \
     --preflight "~/.local/bin/fts triage --db $REPO/.ffactory/factory.db --json | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d[\"dead_letter\"] or d[\"orphans\"] else 1)'" \
     --task "FTS_DB=<abs path to .ffactory/factory.db> REPO_ROOT=<abs $REPO> OPERATOR_SESSION=<value or -> — Read and follow factory/skills/triage.md."
   ```
   (`--every`/`--shell`/`--model` from `triage.every`/`triage.harness`/`triage.model`.)
   The preflight exits 0 (work exists → run the session) when `fts triage --json` reports
   any dead_letter or orphan tickets, and exits 1 (healthy → skip, no session spawned)
   otherwise. The triage briefing must set the three task variables literally;
   `triage.md` treats a missing variable as fatal.

   Digest (daily cron loop, shift report mailed to the operator) — register this loop
   ONLY when `operator_session` in `factory.yaml` is not `-`; skip it entirely otherwise,
   since there is nowhere to mail the digest:
   ```bash
   ~/.ftown/ftown-sessions loop create \
     --name "<project>-digest" --cron "0 9 * * *" --shell claude --model sonnet \
     --workdir "$REPO" --group "Factory: <project>" --retention 5 \
     --task "FTS_DB=<abs path to .ffactory/factory.db> REPO_ROOT=<abs $REPO> OPERATOR_SESSION=<operator> — Read and follow factory/skills/digest.md."
   ```
   (`--cron`/`--shell`/`--model` from `digest.cron`/`digest.harness`/`digest.model`.)
7. **Wrap up.** Suggest the user commit `factory/` (not `.ffactory/`). Show them how to
   create the first ticket:
   ```bash
   mkdir -p .ffactory/tickets/1
   # write .ffactory/tickets/1/request.md with the ask
   fts create --db .ffactory/factory.db --title "<title>" --stage groom \
     --folder .ffactory/tickets/1
   ```
   and how to watch it: `fts serve --db .ffactory/factory.db --port 8377` (dashboard).

## up / down

Resume or pause every registered loop by name. Loops don't expose lookup-by-name
directly, so filter `loops` output for the project's `--group` label (`Factory:
<project>`) to get ids first — this naturally covers whichever loops are actually
registered (dispatch + triage always; digest only if an operator is configured):

```bash
~/.ftown/ftown-sessions loops                      # find ids for all loops in group "Factory: <project>"
~/.ftown/ftown-sessions loop resume <loop-id>      # up — repeat for each loop id found
~/.ftown/ftown-sessions loop pause  <loop-id>      # down — repeat for each loop id found
```

## status

Report all of:

1. `fts board --db .ffactory/factory.db` — ticket counts by stage.
2. `fts queues --db .ffactory/factory.db` — per-stage claim queues.
3. `fts doctor --db .ffactory/factory.db` — health checks (flag any failure first).
4. `~/.ftown/ftown-sessions loop runs <loop-id>` for every loop id registered under
   `Factory: <project>` (dispatch, triage, and digest if present) — last few runs of
   each, success/error. For triage specifically, also check `loop get <triage-id>` for
   `lastSkipAt`/`lastSkipReason` — frequent skips are healthy (the preflight guard found
   no dead-letter/orphan work).
5. Active workers: `~/.ftown/ftown-sessions list` filtered to names starting with
   `<project>-t` (worker sessions the dispatcher spawned, distinct from the loop names
   themselves which start with `<project>-dispatch`/`<project>-triage`/`<project>-digest`).

## run-now

Force an immediate dispatcher tick without waiting for the interval:
```bash
~/.ftown/ftown-sessions loop run <dispatch-loop-id>
```

## teardown

Confirm with the user first — this is destructive to scheduling, distinct from deleting
data.

1. Pause then delete every loop registered under `Factory: <project>`: `loop pause <id>`
   then `loop delete <id>` for dispatch, triage, and digest (if it was registered).
2. Remind the user: `.ffactory/` is disposable runtime state (db, tickets, worktrees) —
   only delete it if they explicitly confirm, since it's the ticket history. `factory/`
   is the checked-in definition — keep it (removing it is a separate, deliberate repo
   change, not part of teardown).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `ftown-sessions list` errors at any step | Bridge is down — start the ftown bridge before retrying. |
| `loop create --group` rejected as unknown flag | Bridge predates ftown PR #29 — tell the user to update the bridge; do not drop `--group` and register loops ungrouped. |
| Workers never spawn even though tickets are queued | Check `loop runs <dispatch-id>` for run status first, then the dispatcher's own stderr (surfaced in the run's session output) for `dispatch.py` errors — e.g. `max_sessions` cap reached, or a claim that keeps expiring. |
| A ticket looks stuck in one stage | `fts why --db .ffactory/factory.db <id>` — gives a stuck diagnosis (expired claim, bounce-limit hit, missing resource lease, etc.) without needing to read the raw db. |
| Triage never fires | Check `loop get <triage-id>` for `lastSkipAt`/`lastSkipReason` — preflight guard skipping is healthy when there are no dead-letter/orphan tickets; only worry if `fts triage --json` shows work but the loop still skips. |
