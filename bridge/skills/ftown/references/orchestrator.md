# ftown orchestrator playbook

You are running inside an ftown session (your id is in `$FTOWN_SESSION_ID`) and
can coordinate worker agent sessions on this machine using the
`~/.ftown/ftown-sessions` CLI.

See `references/sessions.md` for the full session CLI reference.

## Coordination priority: FTS first

FTS (`fticket`) is the primary coordination plane whenever the task supplies an
`FTS_DB`/`TICKET_ID` or the repository already has `.ffactory/factory.db`. Read the
installed `fticket` skill before operating it.

- **Context:** read `fts show --db "$FTS_DB" "$TICKET_ID" --json` and the ticket's
  immutable artifact folder. Write durable handoffs there instead of sending them in chat.
- **Status:** use claims, lifecycle transitions, renewals, notes, `fts board`, and
  `fts events`; these are the shared source of truth for every worker and orchestrator.
- **Resources:** register named shared surfaces once, then require workers to acquire an
  exclusive/shared lease before use and release it afterward. A waitlisted lease means
  the worker must not touch that resource; the FTS scheduler promotes it FIFO.
- **Dependencies:** express ordering with ticket dependencies rather than messages such as
  "wait until worker A is done."

Do not initialize a new FTS database merely because one is absent unless creating that
control plane is within the user's requested scope. When no FTS database/ticket exists,
or when a fenced worker cannot write to FTS, ftown mail is the fallback. Use mail for
urgent escalation that needs to wake a human/agent; do not duplicate routine context and
status in both systems.

Useful inspection commands:

```bash
fts board --db "$FTS_DB"
fts show --db "$FTS_DB" "$TICKET_ID" --json
fts resources --db "$FTS_DB" --json
fts events --db "$FTS_DB" --after <cursor>
```

## Spawning workers

`--shell` accepts `claude`, `cursor`, `codex`, `shell`, `opencode`, and Claude
Code provider flavors such as `zai`, `kimi`, `deepseek`, `fireworks`; `--parent`
sets the worker's parent to `$FTOWN_SESSION_ID`.

```bash
~/.ftown/ftown-sessions create \
  --shell claude \
  --parent \
  --workdir /path/to/repo \
  --name review-auth \
  --prompt "Review the auth module and summarize findings"
```

Returns JSON containing `session.id` — save it to inspect the worker later. For
FTS-backed work, put `FTS_DB`, `TICKET_ID`, `WORKER_ID`, and the claim fence in the
worker briefing; the ticket/artifacts remain the durable handoff. Workers spawned with
`--parent` are also auto-briefed about the FTS-first policy and mail fallback.
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

For FTS-backed work, observe `fts events --after <cursor>`, `fts show`, and
`fts resources` rather than asking every worker for status. Use `screen` / `grep` to
investigate a worker whose ticket/claim has gone quiet. When operating without FTS, end
your turn and let fallback mail wake you instead of running a polling loop.

## Messaging fallback (mail)

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

Without FTS, children report back with `mail send --parent --type result` (or
`--type escalation` when blocked). With FTS, use this only for an urgent escalation or
when a fenced/unavailable database prevents recording the outcome. Fan-out still works via
`~/.ftown/ftown-sessions tell --children "pause and report status"` (now mail
under the hood; one of `--parent | --children | --siblings`).

If a worker is idle and must be woken right now, terminal keystroke injection
(`ftown-harness send <id> "..." -s` or `tell --keys`) is the **last resort** —
prefer an FTS update/event, then fallback mail, which arrives at the next turn boundary.

## Cleanup

```bash
# Archive a finished worker (kept as a tombstone)
~/.ftown/ftown-sessions remove <session-id>

# Bring it back — resumes the agent conversation if its agent session id was
# recorded before removal; otherwise restarts fresh with a new id
~/.ftown/ftown-sessions revive <session-id>
```

Clean up workers you no longer need to keep the session list tidy.

## Recurring work

For unattended recurring work, create a scheduled loop instead of keeping an
orchestrator alive to poll or sleep. See `references/loops.md` for the full loop
workflow:

```bash
~/.ftown/ftown-sessions loop create \
  --name repo-watch \
  --every 30m \
  --shell codex \
  --workdir /path/to/repo \
  --task "Inspect recent changes, run the focused checks, and report issues"
```

Loop runs show as normal ftown sessions grouped under their loop in the
dashboard. Use `~/.ftown/ftown-sessions loop runs <loop-id>` to inspect run
sessions from the CLI.

## Practical guidance

- **Parallelize** independent tasks: spawn multiple workers before waiting for any.
- **Observe shared state**: prefer `fts events`/`show`/`resources`; use `screen` / `grep`
  for diagnosis and mail only as fallback.
- **Name workers clearly**: `--name` shows in `list` output and as the sender
  name on incoming mail.
- **Check `list` first**: see what's already running before spawning duplicates.

## If the CLI is missing

Start or restart **ftown-bridge** on this machine. It installs
`~/.ftown/ftown-sessions` and updates the unified skill under
`~/.ftown/skills/ftown/` (linked into ~/.agents/skills and ~/.claude/skills).
