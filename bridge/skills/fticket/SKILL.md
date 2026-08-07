---
name: fticket
description: >-
  Operate fticket (FTS, the Factory Ticket System) through its `fts` CLI: tickets,
  atomic claims, dependencies, resource leases with FIFO waitlists, scheduler sweeps,
  status/history/events, and stuck-work diagnosis. Use whenever work mentions FTS,
  factory.db, factory tickets, worker claims, resource leases, or factory pipelines.
---

# fticket — transactional coordination for agent teams

FTS is the durable control plane for concurrent agents. It owns task status, atomic
claims, dependencies, resource leases, and an immutable history/event stream in one
SQLite database (WAL mode with race-free write transactions). Ticket folders hold
durable artifacts; FTS holds who owns work, what is blocked, and what happens next.

Prefer FTS over direct agent messages whenever an existing database/ticket is available:

- use the ticket and artifact folder for shared context;
- use claims, lifecycle transitions, notes, board/history/events for status;
- use dependencies for ordering;
- use resource leases for shared mutable surfaces;
- use direct messages only when FTS is unavailable/fenced or for urgent escalation.

## Runtime

- CLI: `fts` (also `python -m fticket`)
- Python: 3.13+
- Install: `uv tool install fticket` or `uv tool upgrade fticket`
- Without installing: `uvx --python 3.13 fticket ...`
- Database: `--db PATH`, default `factory.db`; the flag may precede or follow a subcommand.
- Configuration lives in the database; there are no fticket environment variables.

Never open or edit the SQLite file directly. Use the CLI/API so fencing, leases, events,
and invariants remain transactional.

## Ticket lifecycle

Statuses are `queued`, `claimed`, `in_progress`, `done`, `rejected`, `blocked`, and
`dead_letter`.

```bash
fts init --db factory.db --stages code,review,qa,deploy
fts create --db factory.db --title "build parser" --stage code --folder tasks/0001
fts claim --db factory.db --stage code --worker coder-1
fts start --db factory.db --ticket 1 --worker coder-1 --epoch 2
fts renew --db factory.db --ticket 1 --worker coder-1 --epoch 2
fts complete --db factory.db --ticket 1 --worker coder-1 --epoch 2 \
  --note "implementation-notes.md written; checks green"
fts advance --db factory.db --ticket 1 --worker coder-1 --to-stage review \
  --note "ready for review"
```

Claims expire unless renewed (default five minutes). Always pass the epoch returned by
`claim` when the command offers `--epoch`; it fences stale workers after reassignment.
Run `fts scheduler` continuously, or `fts tick` periodically, so expired claims/leases
are swept and waitlists/dependencies are promoted.

Legal flow:

- `queued` → `claimed` only via `claim`
- `claimed` → `in_progress` via `start`
- `in_progress` → `done` via `complete`
- `done` → `queued` at a different stage via `advance`
- `reject` bounces work according to the pipeline; repeated bounces dead-letter
- operator escape hatches: `transition`, `dead-letter`, and `revive`

Dependencies are durable ordering, not messages:

```bash
fts add-dep --db factory.db --ticket 8 --depends-on 7 --until review
fts dag --db factory.db --format ascii
```

## Resources (leases with FIFO waitlists)

Register stable names once, then acquire before touching the shared surface:

```bash
fts register-resource --db factory.db --name staging --policy exclusive_only
fts register-resource --db factory.db --name test-db --policy both

fts acquire --db factory.db --resource staging --ticket 8 --worker coder-1 \
  --mode exclusive
fts resources --db factory.db --json
fts release --db factory.db --ticket 8 --resource staging
```

Policies: `both`, `exclusive_only`, `shared_only`. Modes: `exclusive`, `shared`.
If acquisition is waitlisted, the ticket becomes blocked on that resource. Do not touch
the resource until the scheduler grants the lease. Waitlists are FIFO, and leases expire
after their TTL (default ten minutes), so long operations must renew their ticket claim
and finish/release the resource promptly.

Acquire multiple resources in alphabetical order to avoid team-level deadlock patterns.
Plan a release for every acquired lease and run it even when later work fails.

`fts release` is overloaded and accepts exactly one release target:

```bash
# Release a ticket claim back to the queue
fts release --db factory.db --ticket 8 --worker coder-1 --epoch 2 --note "reason"

# Release a resource lease
fts release --db factory.db --ticket 8 --resource staging
```

Never combine `--worker` and `--resource` in one release command.

## Shared context and status

Use `fts show --json` first, then read the ticket's artifact folder. Artifacts accrete:
do not delete or rewrite another stage's handoff. Name the artifact in concise completion,
advance, or rejection notes so later workers can locate it from immutable history.

```bash
fts show --db factory.db 8 --json
fts board --db factory.db
fts queues --db factory.db
fts events --db factory.db --after 120
fts why --db factory.db 8
```

FTS does not provide free-form chat. That is deliberate: substantive context belongs in
artifacts and status belongs in lifecycle/history. Use ftown mail only for urgent
questions or escalation that cannot be represented durably, and summarize the answer in
the ticket artifact before continuing.

## Scheduler

```bash
fts tick --db factory.db --verbose
fts scheduler --db factory.db --interval-ms 1000
```

Nothing else expires claims/leases or promotes resource waitlists. A factory dispatcher
may call `tick` itself; otherwise run one scheduler process per database.

## Diagnosis and observability

```bash
fts board --db factory.db --json
fts show --db factory.db 8 --json
fts why --db factory.db 8
fts resources --db factory.db --json
fts dag --db factory.db --format ascii
fts triage --db factory.db --json
fts doctor --db factory.db
fts events --db factory.db --after 0 --follow
fts serve --db factory.db --port 8787
```

For a stuck ticket: run `why`, then `show`, then `resources`; use `triage` for
dead-letters/orphans and `doctor` for systemic invariant failures. The events cursor is
the integration hook for orchestrators—persist the last cursor and poll after it.

## Operational gotchas

- `claimed` is reachable only via `claim`; `transition --to claimed` is invalid.
- `advance` must change stage.
- `blocked` is driven by resource/dependency mechanics, not an arbitrary worker status.
- Ticket folders are immutable identities and never move.
- History, events, and reached stages are append-only.
- Read commands are safe for observers; write commands require the correct worker/epoch.
- One FTS object/CLI process uses one connection; SQLite serializes concurrent writers.
- If `uvx fticket` is shadowed by a 0.1.0 installed tool, run `uv tool upgrade fticket`.
