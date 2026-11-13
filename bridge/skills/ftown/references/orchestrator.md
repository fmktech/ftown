# Worker coordination examples

Read `../SKILL.md` for identity, reporting and cleanup behavior, and
`sessions.md` for the command reference. These examples add only coordination
steps. Use an ordinary session with the requested task and parent link; no
special orchestrator mode is needed.

List existing sessions before creating another worker. Give each worker a
bounded task, clear writable files and acceptance checks; save the returned
`session.id` for follow-up. Omit `--shell` to inherit your current harness, or
set it when the task calls for a different harness. Provider flavors require a
bridge-host token configured with `ftown env set <flavor>`.

Before picking a CLI, model and effort for delegated work, run `ftown quota --json`
and follow the decision procedure in `quota.md` (owner tiers first). Pass the
choice as `--shell <provider>`; add `--model <id>` only with an id from that
harness's model list. Never route to `exhausted`.

```bash
ftown sessions list
ftown sessions create --parent --workdir /path/to/repo --name review-auth \
  --prompt "Review auth; read-only. Report concrete findings and validation."
ftown board --wait --until any-done --timeout 300
ftown board
ftown harness mail send <worker-id> --type task "Check the expired-token case too"
```

Coordinate in a loop: spawn children, wait with
`ftown board --wait --until any-done --timeout 300` (or `any-blocked`,
`any-ready`, `all-done`; `ftown events --wait` waits for the next event), act
on the board and mail, then repeat until every child is done. Children keep
their cards current; progress goes on the card, never as mail. Use
`ftown sessions screen <worker-id> --limit 100` only to investigate terminal
detail. Mail handles directed instructions, results and escalations; read it
with `ftown harness mail read`. Each new batch nudges the recipient at most
once, and a nudge may append a one-line digest of child status. Parallel tasks
need disjoint write ownership and serialized shared resources.

After accepting a worker's result, request any concrete follow-up before
explicit cleanup with `ftown sessions remove <worker-id>`.
