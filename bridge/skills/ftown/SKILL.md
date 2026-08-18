---
name: ftown
description: >-
  Control ftown from inside agent sessions: create/list/read/drive sibling
  sessions, send ftown mail, manage recurring scheduled loops, coordinate worker
  agents through fticket when available, and run deterministic ftown-workflows. Use when a task mentions ftown,
  ftown sessions, bridge sessions, child/sibling agents, mail/inbox, scheduled
  loops, recurring agent runs, orchestration, fan-out, or ftown-workflows.
---

# ftown

Use the local bridge CLIs installed under `~/.ftown`. They read
`~/.ftown/bridge.json`; anyone who can read that file can control the bridge's
sessions and loops.

## Pick The Reference

- Session control, mail, terminal output, archive/revive, or local API:
  read `references/sessions.md`.
- Recurring scheduled work, cron/interval loops, loop run history:
  read `references/loops.md`.
- Ad-hoc multi-agent coordination from an orchestrator session:
  read `references/orchestrator.md`.
- Ticket-backed multi-agent coordination, durable status/context, dependencies, and
  resource leases: read the installed `fticket` skill. Prefer FTS over direct messages
  whenever an existing `FTS_DB`/ticket is available.
- Scripted, resumable, deterministic multi-session fan-out:
  read `references/workflows.md`.

## Quick Commands

```bash
# Sessions
~/.ftown/ftown-sessions list
~/.ftown/ftown-sessions create --prompt "Run tests" --workdir "$PWD" --parent
~/.ftown/ftown-sessions screen <session-id> --limit 200
~/.ftown/ftown-sessions tell <session-id> --type task "continue with the API client"

# Loops
~/.ftown/ftown-sessions loops
~/.ftown/ftown-sessions loop create --name repo-watch --every 30m --shell codex --workdir "$PWD" --task "Review recent changes"
~/.ftown/ftown-sessions loop run <loop-id>

# Workflows
~/.ftown/ftown-workflows run path/to/script.mjs --workdir "$PWD"

# FTS-backed coordination (when FTS_DB/TICKET_ID are supplied)
fts show --db "$FTS_DB" "$TICKET_ID" --json
fts resources --db "$FTS_DB" --json
```

Prefer loops for unattended recurrence. Prefer workflows for deterministic
control flow inside one run. Prefer orchestrator guidance for ad-hoc
human-in-the-loop multi-agent coordination.
