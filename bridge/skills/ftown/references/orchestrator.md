# Worker coordination examples

Read `../SKILL.md` for identity, reporting and cleanup, and
`sessions.md` for commands.

List sessions first. Scope each task, files and checks; save `session.id`. Omit `--shell` to inherit your harness. Before picking a CLI,
model and effort, run `ftown quota --json` and follow `quota.md` (owner
tiers first); never route to `exhausted`.

For cross-bridge delegation, use `ftown bridges --resources --json` to compare host capacity. If the destination needs files, follow **Copy a folder and launch a worker** in `sessions.md`.

Keep the plan on the manager, not in a ticket system.
Add steps with `ftown plan add` (`--after`/`--priority` set precedence;
ready = every `after` done or dropped) and create each child with
`--plan-item`, so its item starts and completes with the child:

```bash
ftown brief set --file brief.md
ftown plan add "Fix the auth bug" --priority 1
ftown sessions create --parent --plan-item p1 --worktree --workdir /path/to/repo --name fix-auth --prompt "Fix auth; run checks."
ftown board --wait --until any-done --timeout 300
ftown attention list
ftown harness mail send <worker-id> --type task "Check the expired-token case"
```

Wait on the board for `any-done`, `any-blocked`, `any-ready` or `all-done`; act and repeat. Children keep cards current;
progress goes on the card, never as mail. A child's question comes to you
first: answer from facts you hold with `ftown attention answer`, or
escalate preferences and irreversible choices
with `ftown attention escalate --note`. Mail is for directed
instructions, results and escalations; read it with
`ftown harness mail read`. Use `ftown sessions screen <worker-id> --limit 100`
only to investigate. Parallel tasks need disjoint write
ownership and serialized shared resources. Children set their card to
done and report to the parent; you raise one "Work complete" notice
for the whole job.

After accepting a result, clean up with
`ftown sessions remove <worker-id>`, which retires a clean, merged or pushed
worktree and otherwise keeps it and says why.

Use `--require-green-pr` for PR-opening children.
