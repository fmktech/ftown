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

`--shell` accepts `claude`, `cursor`, `codex`, `shell`, `opencode`, …; `--parent`
sets the worker's parent to `$FTOWN_SESSION_ID`.

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
`mail send --parent`; their reports arrive in **your** inbox and are delivered
automatically as `[ftown mail]` context at your turn boundaries.

## Monitoring workers

```bash
# See what's on screen right now
~/.ftown/ftown-sessions screen <session-id> --limit 100

# Search for errors / completion markers
~/.ftown/ftown-sessions grep <session-id> --pattern 'FAIL|done|error'

# Check if the process is still alive
~/.ftown/ftown-sessions running <session-id>
```

The best wait pattern: **end your turn**. Worker mail blocks your Stop hook
and wakes you with the messages — no polling loop needed. Use `screen` /
`grep` to investigate workers that have gone quiet for too long.

## Messaging (mail)

Each session has an inbox. Claude and codex sessions receive mail automatically
at turn boundaries via hooks — no keystroke injection. Cursor and shell sessions
have no hooks: when idle they get a one-line nudge telling them to run
`ftown-harness mail read`, so expect slightly slower pickup there.

```bash
# Send work / instructions to a child
ftown-harness mail send <child> --type task "implement the API client"

# Reply in a thread, or escalate
ftown-harness mail send <child> --thread <id> "use the v2 endpoint"

# Read your own inbox on demand (you also get mail automatically)
ftown-harness mail read
```

Children report back with `mail send --parent --type result` (or
`--type escalation` when blocked). Fan-out still works via
`~/.ftown/ftown-sessions tell --children "pause and report status"` (now mail
under the hood; one of `--parent | --children | --siblings`).

If a worker is idle and must be woken right now, terminal keystroke injection
(`ftown-harness send <id> "..." -s` or `tell --keys`) is the **last resort** —
prefer mail, which arrives at the next turn boundary.

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
- **Poll, don't block**: use `screen` / `grep` to check progress; mail from
  workers reaches you automatically at turn boundaries, so keep working.
- **Name workers clearly**: `--name` shows in `list` output and as the sender
  name on incoming mail.
- **Check `list` first**: see what's already running before spawning duplicates.

## If the CLI is missing

Start or restart **ftown-bridge** on this machine. It installs
`~/.ftown/ftown-sessions` and updates this skill under
`~/.ftown/skills/ftown-orchestrator/` (linked into ~/.agents/skills and ~/.claude/skills).
