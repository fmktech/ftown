# ftown orchestrator playbook

You are running inside an ftown session (your id is in `$FTOWN_SESSION_ID`) and
can coordinate worker agent sessions on this machine using the
`~/.ftown/ftown-sessions` CLI.

See `references/sessions.md` for the full session CLI reference.

## Spawning workers

Omit `--shell` to inherit the orchestrator's current harness. Use `--shell` only
when the user or task explicitly requests a different harness (`claude`, `cursor`,
`codex`, `grok`, `muse`, `pi`, `kimi-code`, `shell`, `opencode`, or a Claude Code provider
flavor such as `zai`, `kimi`, `deepseek`, `fireworks`). `--parent` sets the worker's
parent to `$FTOWN_SESSION_ID`.

```bash
~/.ftown/ftown-sessions create \
  --parent \
  --workdir /path/to/repo \
  --name review-auth \
  --prompt "Review the auth module and summarize findings"
```

Returns JSON containing `session.id` — save it to inspect the worker later.
Workers spawned with `--parent` are auto-briefed about reporting results and
escalations through mail, then removing themselves when finished.
Provider-flavored workers require a bridge-host token configured with
`ftown env set <flavor> <token>`; the bridge supplies their endpoint/model
environment when it spawns them.

## Monitoring workers

```bash
# See what's on screen right now
~/.ftown/ftown-sessions screen <session-id> --limit 100

# Search for errors / completion markers
~/.ftown/ftown-sessions grep <session-id> --pattern 'FAIL|done|error'

# Check if the process is still alive
~/.ftown/ftown-sessions running <session-id>
```

Use `screen` / `grep` to investigate a worker that has gone quiet. When waiting for
results, end your turn and let mail wake you instead of running a polling loop.

## Messaging (mail)

Each session has an inbox. Claude and codex receive mail automatically at turn
boundaries via hooks. Pi's bundled extension maintains a long-poll and wakes idle
Pi sessions with a native follow-up turn. Muse's installed `ftown` plugin
reports the native session id on SessionStart and pumps pending mail as
context on Stop. None of these paths inject terminal
keystrokes. Cursor and shell sessions have no hooks: when idle they get a one-line
nudge telling them to run `ftown-harness mail read`, so expect slightly slower
pickup there.

```bash
# Send work / instructions to a child
ftown-harness mail send <child> --type task "implement the API client"

# Reply in a thread, or escalate
ftown-harness mail send <child> --thread <id> "use the v2 endpoint"

# Read your own inbox on demand (you also get mail automatically)
ftown-harness mail read
```

Children report back with `mail send --parent --type result` (or
`--type escalation` when blocked). Fan-out works via
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

Child briefings normally make workers report first and then remove themselves. Explicitly
ask a worker to stay open when you need follow-up interaction; otherwise, clean up any
worker that exits without honoring the self-removal instruction.

## Practical guidance

- **Parallelize** independent tasks: spawn multiple workers before waiting for any.
- **Follow worker results**: read incoming mail and use `screen` / `grep` for diagnosis.
- **Name workers clearly**: `--name` shows in `list` output and as the sender
  name on incoming mail.
- **Check `list` first**: see what's already running before spawning duplicates.

## If the CLI is missing

Start or restart **ftown-bridge** on this machine. It installs
`~/.ftown/ftown-sessions` and updates the unified skill under
`~/.ftown/skills/ftown/` (linked into ~/.agents/skills and ~/.claude/skills).
