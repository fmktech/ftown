# ftown cross-session CLI

**Prefer the CLI** — installed to `~/.ftown/ftown-sessions` whenever `ftown-bridge` is running. It reads `~/.ftown/bridge.json` automatically.

```bash
~/.ftown/ftown-sessions --help
```

Unified skill wrapper: `scripts/ftown` in this skill directory delegates to the
top-level `~/.ftown/ftown` dispatcher.

**Trust model:** anyone who can read `bridge.json` can control **every** ftown session on that bridge.

## Commands

```bash
# List sessions (JSON)
~/.ftown/ftown-sessions list

# Spawn a child agent (uses FTOWN_SESSION_ID for --parent)
~/.ftown/ftown-sessions create \
  --shell cursor \
  --prompt "Review the auth module and summarize" \
  --workdir /path/to/repo \
  --name auth-review \
  --parent

# Metadata
~/.ftown/ftown-sessions get <session-id>

# Terminal output (JSON by default; add --plain for raw lines)
~/.ftown/ftown-sessions screen <session-id> --limit 200

# Search output (--offset/--limit paginate screen and grep)
~/.ftown/ftown-sessions grep <session-id> --pattern 'error|failed' --offset 0 --limit 100

# Type into another running session
~/.ftown/ftown-sessions keys <session-id> 'y'

# Liveness
~/.ftown/ftown-sessions running <session-id>

# Stop and remove a session (kept as a tombstone in the archive)
~/.ftown/ftown-sessions remove <session-id>

# List archived (removed) sessions: id, name, removedAt, shellType
~/.ftown/ftown-sessions archive

# Recreate a removed session from its tombstone (resumes the agent
# conversation when a claude/cursor/codex session id was recorded; the revived
# session gets a NEW id)
~/.ftown/ftown-sessions revive <session-id>
```

## Scheduled loops

Loop runs are normal sessions tagged with `loopId`. For loop creation,
schedule syntax, manual runs, pause/resume, and run history, read
`references/loops.md`.

## Messaging (mail)

`tell` posts to the target session's **inbox**. Mail is delivered into the
recipient's context automatically at turn boundaries (as `[ftown mail]`
context), so there is no keystroke injection by default. Claude and codex
sessions get this hook-based delivery; cursor and shell sessions rely on an
idle one-line nudge to run `ftown-harness mail read` instead.

```bash
# Tell a specific session
~/.ftown/ftown-sessions tell <session-id> "tests are green, ship it"

# Mail type / threading
~/.ftown/ftown-sessions tell <session-id> --type task "implement the API client"
~/.ftown/ftown-sessions tell <session-id> --type result --thread <id> "done, 0 failures"

# Tell my parent / children / siblings (resolved via FTOWN_SESSION_ID)
~/.ftown/ftown-sessions tell --parent "child finished phase 1"
~/.ftown/ftown-sessions tell --children "pause and report status"
~/.ftown/ftown-sessions tell --siblings "I grabbed the lock, stand by"

# Last resort: inject as terminal keystrokes instead of mail
~/.ftown/ftown-sessions tell <session-id> --keys "wake up"

# Read my own inbox (requires FTOWN_SESSION_ID; alias: mail)
~/.ftown/ftown-sessions inbox            # --peek / --limit N / --all / --json
```

Sender is resolved from `FTOWN_SESSION_ID` (omitted when unset).
Fan-out targets are messaged sequentially, one JSON result line per target.

### Create options

| Flag | Description |
|------|-------------|
| `--shell` | `cursor`, `claude`, `codex`, `shell`, `opencode`, or Claude Code provider flavors `zai`, `kimi`, `deepseek`, `fireworks` (default `claude`) |
| `--prompt` | Initial task — passed as a CLI launch argument to `claude`/Claude provider flavors/`cursor`/`codex` (typed after boot for other shells) |
| `--workdir` | Working directory |
| `--name` | Dashboard label |
| `--command` | Full command override (skips `--shell` builder) |
| `--parent` | Set parent to `$FTOWN_SESSION_ID` |
| `--parent-id` | Explicit parent session UUID |
| `--orchestrator` | Brief the new agent (non-`shell`) to spawn and coordinate sibling sessions |
| `--model` | Cursor / codex model name |

Provider-flavored shells (`zai`, `kimi`, `deepseek`, `fireworks`) run Claude
Code with provider-specific default endpoint/model environment. They require a
machine token on the bridge host, e.g. `ftown env set zai <token>`.

Returns JSON with the new `session.id` — use that id for `screen` / `grep` / `keys`.

## Typical workflow

```bash
CLI=~/.ftown/ftown-sessions

$CLI list
$CLI create --shell cursor --prompt "Run tests and report" --workdir "$PWD" --parent
# -> note session.id from JSON

$CLI screen <child-id> --limit 100
$CLI grep <child-id> --pattern 'FAIL|Error'
```

## Environment

Spawned ftown sessions receive:

- `FTOWN_SESSION_ID` — this session (use with `--parent`)
- `FTOWN_PARENT_SESSION_ID` — the parent session id, set on children spawned with `--parent` / `--parent-id`
- `FTOWN_ORCHESTRATOR` — set to `1` on sessions created with `--orchestrator`
- `FTOWN_HOOK_PORT` / `FTOWN_HOOK_TOKEN` — hook forwarding (not for cross-session control)

Agent children (any `--shell` except `shell`) spawned with a parent also get an
automatic one-paragraph briefing prepended to their first input: it states their
name/id and parent name/id. When the task provides `FTS_DB` and `TICKET_ID`, the
briefing makes fticket the primary coordination plane for context, status, and
resource leases; mail is reserved for fallback/urgent escalation. Without FTS,
it explains how to report via `ftown-harness mail send --parent`. The creator's
`--prompt` follows after a `Task:` line.

An agent session created with `--orchestrator` additionally gets `FTOWN_ORCHESTRATOR=1`
in its environment and a compact pointer briefing directing it to the unified
**ftown** skill, whose `references/orchestrator.md` contains the full
orchestrator playbook for spawning workers, monitoring them, and cleaning up.
When both apply, the child paragraph comes first, then the orchestrator pointer,
separated by a blank line.

## HTTP API (optional)

The CLI wraps the loopback API. Raw access if needed:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | List |
| POST | `/api/sessions` | Create |
| PATCH | `/api/sessions/:id` | Rename and/or move (`{ name?, parentSessionId? }`; `null` moves to the root) |
| GET | `/api/sessions/:id/screen` | Terminal lines |
| POST | `/api/sessions/:id/grep` | Search |
| POST | `/api/sessions/:id/keys` | Send keys |
| GET | `/api/sessions/:id/running` | PTY liveness |
| POST | `/api/sessions/:id/inbox` | Send mail (`{ body, from?, fromName?, type?, threadId? }`) |
| GET | `/api/sessions/:id/inbox` | Read mail (`?wait=&peek=&limit=&all=`) |
| POST | `/api/sessions/:id/message` | Inject a message line as keystrokes (`{ text, from? }`) |
| DELETE | `/api/sessions/:id` | Remove (tombstone-archived) |
| GET | `/api/archive` | List removed-session tombstones |
| POST | `/api/sessions/:id/revive` | Recreate a removed session (new id) |
| GET | `/api/loops` | List scheduled loops |
| POST | `/api/loops` | Create a scheduled loop on this bridge |
| GET/PATCH/DELETE | `/api/loops/:id` | Inspect, update, or delete a loop |
| POST | `/api/loops/:id/run-now` | Request an immediate loop run; returns 404 `reason: not_found` if the loop no longer exists |
| GET | `/api/loops/:id/runs` | List run sessions for a loop |

To move a session under a different parent, PATCH it with the new parent's id:

```json
{ "parentSessionId": "new-parent-session-id" }
```

Set `parentSessionId` to `null` to detach it from its current parent and move it
back to the bridge root. Parent and child must belong to the same bridge.

## If the CLI is missing

Start or restart **ftown-bridge** on this machine. It installs
`~/.ftown/ftown-sessions`, `~/.ftown/notify.sh`, and updates the unified skill
under `~/.ftown/skills/ftown/` (linked into ~/.agents/skills and
~/.claude/skills).
