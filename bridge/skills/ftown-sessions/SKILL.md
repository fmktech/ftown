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
- `FTOWN_HOOK_PORT` / `FTOWN_HOOK_TOKEN` — hook forwarding (not for cross-session control)

## HTTP API (optional)

The CLI wraps the loopback API. Raw access if needed:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | List |
| POST | `/api/sessions` | Create |
| GET | `/api/sessions/:id/screen` | Terminal lines |
| POST | `/api/sessions/:id/grep` | Search |
| POST | `/api/sessions/:id/keys` | Send keys |

## If the CLI is missing

Start or restart **ftown-bridge** on this machine. It installs `~/.ftown/ftown-sessions`, `~/.ftown/notify.sh`, and updates this skill under `~/.agents/skills/ftown-sessions/`.
