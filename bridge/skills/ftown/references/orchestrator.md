# Worker coordination examples

Read `../SKILL.md` for identity, reporting and cleanup behavior, and
`sessions.md` for the command reference. These examples add only coordination
steps.

List existing sessions before creating another worker. Give each worker a
bounded task, clear writable files and acceptance checks; save the returned
`session.id` for follow-up. Omit `--shell` to inherit your current harness, or
set it when the task calls for a different harness. Provider flavors require a
bridge-host token configured with `ftown env set <flavor>`.

```bash
ftown sessions list
ftown sessions create --parent --workdir /path/to/repo --name review-auth \
  --prompt "Review auth; read-only. Report concrete findings and validation."
ftown sessions screen <worker-id> --limit 100
ftown sessions running <worker-id>
ftown harness mail send <worker-id> --type task "Check the expired-token case too"
ftown sessions tell --children "Pause and report status"
```

Use terminal output to investigate a quiet worker. Mail handles results and
escalations; read them with `ftown harness mail read`. When waiting, let incoming
mail resume the conversation rather than repeatedly polling. Parallel tasks need
disjoint write ownership and serialized shared resources.

After accepting a worker's result, request any concrete follow-up before
explicit cleanup with `ftown sessions remove <worker-id>`.
