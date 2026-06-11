---
name: ftown-orchestrator
description: >-
  Spawn and coordinate worker ftown agent sessions on this machine. Activates when
  the session env has FTOWN_ORCHESTRATOR=1, the first input contains an [ftown]
  orchestrator briefing, or the user asks to orchestrate, coordinate, or spawn
  worker agent sessions. Teaches spawning and coordinating sibling ftown agent
  sessions via ~/.ftown/ftown-sessions CLI.
---

# ftown orchestrator playbook

You are running inside an ftown session (your id is in `$FTOWN_SESSION_ID`) and
can coordinate worker agent sessions on this machine using the
`~/.ftown/ftown-sessions` CLI.

See the **ftown-sessions** skill for the full CLI reference.

## Spawning workers

`--shell` accepts `claude`, `cursor`, `shell`, `opencode`, …; `--parent` sets the
worker's parent to `$FTOWN_SESSION_ID`.

```bash
~/.ftown/ftown-sessions create \
  --shell claude \
  --parent \
  --workdir /path/to/repo \
  --name review-auth \
  --prompt "Review the auth module and summarize findings"
```

Returns JSON containing `session.id` — save it to poll the worker later.
Workers spawned with `--parent` are auto-briefed to report back via
`tell --parent`; their reports arrive in **your** terminal as lines like:
`[ftown msg from review-auth] done, found 3 issues`.

## Monitoring workers

```bash
# See what's on screen right now
~/.ftown/ftown-sessions screen <session-id> --limit 100

# Search for errors / completion markers
~/.ftown/ftown-sessions grep <session-id> --pattern 'FAIL|done|error'

# Check if the process is still alive
~/.ftown/ftown-sessions running <session-id>
```

Poll `screen` or `grep` rather than waiting blindly — workers don't always
remember to `tell` you when they finish.

## Messaging

```bash
~/.ftown/ftown-sessions tell <session-id> "clarification or new task"
~/.ftown/ftown-sessions tell --children "pause and report status"
~/.ftown/ftown-sessions tell --siblings "I grabbed the lock, stand by"
```

## Cleanup

```bash
# Archive a finished worker (kept as a tombstone)
~/.ftown/ftown-sessions remove <session-id>

# Bring it back — resumes the agent conversation if its agent session id was
# recorded before removal; otherwise restarts fresh with a new id
~/.ftown/ftown-sessions revive <session-id>
```

Clean up workers you no longer need to keep the session list tidy.

## Practical guidance

- **Parallelize** independent tasks: spawn multiple workers before waiting for any.
- **Poll, don't block**: use `screen` / `grep` to check progress; avoid issuing a
  long blocking `tell --children "report when done"` and then stalling.
- **Name workers clearly**: `--name` shows in `list` output and in `[ftown msg from …]` lines.
- **Check `list` first**: see what's already running before spawning duplicates.

## If the CLI is missing

Start or restart **ftown-bridge** on this machine. It installs
`~/.ftown/ftown-sessions` and updates this skill under
`~/.ftown/skills/ftown-orchestrator/` (linked into ~/.agents/skills and ~/.claude/skills).
