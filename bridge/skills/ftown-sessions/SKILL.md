---
name: ftown-sessions
description: >-
  Observe and control other ftown CLI agent sessions on the same machine. Use the
  ftown-sessions CLI (~/.ftown/ftown-sessions) to list, create, read, and drive
  sibling sessions while running inside a ftown-managed Claude Code or Cursor Agent
  session.
---

# ftown cross-session CLI

**Prefer the CLI** — installed to `~/.ftown/ftown-sessions` whenever `ftown-bridge` is running. It reads `~/.ftown/bridge.json` automatically.

```bash
~/.ftown/ftown-sessions --help
```

Skill copy (same binary via wrapper): `scripts/ftown-sessions` in this skill directory.

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

# Terminal output (plain lines; add --json for structured)
~/.ftown/ftown-sessions screen <session-id> --limit 200

# Search output
~/.ftown/ftown-sessions grep <session-id> --pattern 'error|failed'

# Type into another running session
~/.ftown/ftown-sessions keys <session-id> 'y'

# Liveness
~/.ftown/ftown-sessions running <session-id>
```

## Messaging

Send a short text line into another session's terminal. The message is sanitized
(control characters stripped, capped at 2000 chars) and delivered as
`[ftown msg from <sender>] <text>` followed by submit, so the target agent reads it
as a normal prompt.

```bash
# Tell a specific session
~/.ftown/ftown-sessions tell <session-id> "tests are green, ship it"

# Tell my parent / children / siblings (resolved via FTOWN_SESSION_ID)
~/.ftown/ftown-sessions tell --parent "child finished phase 1"
~/.ftown/ftown-sessions tell --children "pause and report status"
~/.ftown/ftown-sessions tell --siblings "I grabbed the lock, stand by"
```

Sender is resolved from `FTOWN_SESSION_ID` (falls back to `unknown` when unset).
Fan-out targets are messaged sequentially, one JSON result line per target.

### Create options

| Flag | Description |
|------|-------------|
| `--shell` | `cursor`, `claude`, `shell`, `opencode`, … (default `claude`) |
| `--prompt` | Initial message sent after spawn |
| `--workdir` | Working directory |
| `--name` | Dashboard label |
| `--command` | Full command override (skips `--shell` builder) |
| `--parent` | Set parent to `$FTOWN_SESSION_ID` |
| `--parent-id` | Explicit parent session UUID |
| `--orchestrator` | Brief the new agent (non-`shell`) to spawn and coordinate sibling sessions |
| `--model` | Cursor model name |

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
- `FTOWN_HOOK_PORT` / `FTOWN_HOOK_TOKEN` — hook forwarding (not for cross-session control)

Agent children (any `--shell` except `shell`) spawned with a parent also get an
automatic one-paragraph briefing prepended to their first input: it states their
name/id and parent name/id, and how to reach parent and siblings via `tell`. The
creator's `--prompt` follows after a `Task:` line.

An agent session created with `--orchestrator` additionally gets a one-paragraph
briefing teaching it to spawn worker sessions with `create --parent`, that those
children report back via `tell` (arriving as `[ftown msg from <name>]` lines in its
terminal), and how to inspect/message any session with `list` / `screen` / `grep` /
`tell`. When both apply, the child paragraph comes first, then the orchestrator
paragraph, separated by a blank line.

## HTTP API (optional)

The CLI wraps the loopback API. Raw access if needed:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | List |
| POST | `/api/sessions` | Create |
| GET | `/api/sessions/:id/screen` | Terminal lines |
| POST | `/api/sessions/:id/grep` | Search |
| POST | `/api/sessions/:id/keys` | Send keys |
| POST | `/api/sessions/:id/message` | Deliver a message line (`{ text, from? }`) |

## If the CLI is missing

Start or restart **ftown-bridge** on this machine. It installs `~/.ftown/ftown-sessions`, `~/.ftown/notify.sh`, and updates this skill under `~/.agents/skills/ftown-sessions/`.
