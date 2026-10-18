# ftown cross-session CLI

Use `ftown sessions`, installed by explicit `ftown setup` before the bridge starts. It reads `~/.ftown/bridge.json` automatically.

```bash
ftown sessions --help
```

Unified skill wrapper: `scripts/ftown` in this skill directory delegates to the
top-level `~/.ftown/ftown` dispatcher.

**Trust model:** anyone who can read `bridge.json` can control **every** ftown session on that bridge.

## Commands

```bash
# List sessions (JSON)
ftown sessions list

# Spawn a child agent (uses FTOWN_SESSION_ID for --parent)
ftown sessions create \
  --prompt "Review the auth module and summarize" \
  --workdir /path/to/repo \
  --name auth-review \
  --parent

# Metadata
ftown sessions get <session-id>

# Terminal output (JSON by default; add --plain for raw lines)
ftown sessions screen <session-id> --limit 200

# Search output (--offset/--limit paginate screen and grep)
ftown sessions grep <session-id> --pattern 'error|failed' --offset 0 --limit 100

# Type into another running session
ftown sessions keys <session-id> 'y'

# Liveness
ftown sessions running <session-id>

# Stop and remove a session (kept as a tombstone in the archive)
ftown sessions remove <session-id>

# List archived (removed) sessions: id, name, removedAt, shellType
ftown sessions archive

# Recreate a removed session from its tombstone (resumes the agent
# conversation when a claude/cursor/codex/Pi session id was recorded; Kimi Code
# continues by working directory; the revived session gets a NEW id)
ftown sessions revive <session-id>
```

## Messaging (mail)

`tell` posts to the target session's **inbox**. Mail is delivered into the
recipient's context automatically (as `[ftown mail]` context), so there is no
keystroke injection by default. Claude and codex use turn-boundary hooks. Pi's
bundled extension keeps a cancellable long-poll open and starts a native
follow-up turn when mail arrives, including while Pi is idle. opencode's
installed plugin delivers pending mail as a new prompt when a turn goes idle.
Muse's installed `ftown` plugin reports the native session id on SessionStart
and pumps pending mail as context on Stop.
Cursor and shell sessions rely on an idle one-line nudge to run `ftown harness
mail read` instead.

```bash
# Tell a specific session
ftown sessions tell <session-id> "tests are green, ship it"

# Mail type / threading
ftown sessions tell <session-id> --type task "implement the API client"
ftown sessions tell <session-id> --type result --thread <id> "done, 0 failures"

# Tell my parent / children / siblings (resolved via FTOWN_SESSION_ID)
ftown sessions tell --parent "child finished phase 1"
ftown sessions tell --children "pause and report status"
ftown sessions tell --siblings "I grabbed the lock, stand by"

# Last resort: inject as terminal keystrokes instead of mail
ftown sessions tell <session-id> --keys "wake up"

# Read my own inbox (requires FTOWN_SESSION_ID; alias: mail)
ftown sessions inbox            # --peek / --limit N / --all / --json
```

Sender is resolved from `FTOWN_SESSION_ID` (omitted when unset).
Fan-out targets are messaged sequentially, one JSON result line per target.

### Create options

| Flag | Description |
|------|-------------|
| `--shell` | Explicit harness override: `claude`, `cursor`, `codex`, `grok`, `muse`, `pi`, `kimi-code`, `opencode`, `shell`, or Claude Code provider flavors `zai`, `kimi`, `deepseek`, `fireworks`. When omitted inside a session, inherits that session's harness; outside a session, defaults to `claude`. |
| `--prompt` | Initial task — passed as a CLI launch argument to `claude`/Claude provider flavors/`cursor`/`codex`/`grok`/`muse`/`pi` (typed after boot for other shells) |
| `--workdir` | Working directory |
| `--name` | Dashboard label |
| `--command` | Full command override (skips `--shell` builder) |
| `--parent` | Set parent to `$FTOWN_SESSION_ID` |
| `--parent-id` | Explicit parent session UUID |
| `--model` | Harness model name or provider/model pattern (when supported) |

Provider-flavored shells (`zai`, `kimi`, `deepseek`, `fireworks`) run Claude
Code with provider-specific default endpoint/model environment. They require a
machine token on the bridge host, e.g. `ftown env set zai <token>`.

Returns JSON with the new `session.id` — use that id for `screen` / `grep` / `keys`.

## Typical workflow

```bash
ftown sessions list
ftown sessions create --prompt "Run tests and report" --workdir "$PWD" --parent
# -> note session.id from JSON

ftown sessions screen <child-id> --limit 100
ftown sessions grep <child-id> --pattern 'FAIL|Error'
```

## Environment

Spawned ftown sessions receive:

- `FTOWN_SESSION_ID` — this session (use with `--parent`)
- `FTOWN_PARENT_SESSION_ID` — the parent session id, set on children spawned with `--parent` / `--parent-id`
- `FTOWN_HOOK_PORT` / `FTOWN_HOOK_TOKEN` — hook forwarding (not for cross-session control)

Agent children (any `--shell` except `shell`) spawned with a parent also get an
automatic one-paragraph briefing prepended to their first input: it states their
name/id and parent name/id. It explains how to report via
`ftown harness mail send --parent --type result` (or `--type escalation` when blocked).
The creator's `--prompt` follows after a `Task:` line. Session cleanup is an
explicit user or orchestrator action; see the ftown skill.

A task and optional parent link are sufficient for coordination. Legacy
`--orchestrator` and request booleans are accepted as ignored compatibility inputs;
there is no role briefing or injected role environment. Explicit user-supplied
environment variables remain untouched.

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

To move a session under a different parent, PATCH it with the new parent's id:

```json
{ "parentSessionId": "new-parent-session-id" }
```

Set `parentSessionId` to `null` to detach it from its current parent and move it
back to the bridge root. Parent and child must belong to the same bridge.

## If the CLI is missing

Run `npx ftown@<version> setup`, using the
version in the bridge readiness hint. This works before the installed alias
exists and installs the `ftown` command, compatible
launchers, `~/.ftown/notify.sh`, and updates the unified skill
under `~/.ftown/skills/ftown/` (linked into ~/.agents/skills and
~/.claude/skills).
