# Worker coordination examples

Read `../SKILL.md` for identity, reporting and cleanup behavior, and
`sessions.md` for the command reference. Use an ordinary session with the
requested task and parent link; no special orchestrator mode is needed.

List existing sessions before creating another worker. Give each worker a
bounded task, clear writable files and acceptance checks; save the returned
`session.id`. Omit `--shell` to inherit your harness. Provider flavors require
a bridge-host token configured with `ftown env set <flavor>`. Before picking a
CLI, model and effort, run `ftown quota --json` and follow `quota.md` (owner
tiers first); never route to `exhausted`.

```bash
ftown brief set --file brief.md
ftown sessions create --parent --worktree --workdir /path/to/repo --name fix-auth \
  --prompt "Fix the auth bug; run the checks; report findings."
ftown board --wait --until any-done --timeout 300
ftown brief note "First worker done; reviewing"
ftown attention list
ftown harness mail send <worker-id> --type task "Check the expired-token case too"
```

Loop: spawn children, `ftown board --wait --until any-done --timeout 300`
(or `any-blocked`/`any-ready`/`all-done`), act, repeat until all are done.
Children keep cards current; progress goes on the card, never as mail. A
child's question comes to you first: answer from facts you hold with
`ftown attention answer`, or escalate preferences and irreversible choices
with `ftown attention escalate --note`. Mail is for directed instructions,
results and escalations; read it with `ftown harness mail read`. Each new
batch nudges the recipient at most once, and a nudge may append a one-line
digest of child status. Use `ftown sessions screen <worker-id> --limit 100`
only to investigate terminal detail. Parallel tasks need disjoint write
ownership and serialized shared resources. Children set their card to done
and mail their result; you raise one "Work complete" notice for the whole job.

After accepting a result, follow up before explicit cleanup with
`ftown sessions remove <worker-id>`, which retires a clean, merged or pushed
bridge worktree and otherwise keeps it and says why.
