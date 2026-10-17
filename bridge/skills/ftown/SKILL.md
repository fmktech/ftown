---
name: ftown
description: >-
  Control ftown from inside agent sessions: create/list/read/drive sibling
  sessions, send ftown mail, and coordinate worker agent sessions. Use when a task
  mentions ftown, ftown sessions, bridge sessions, child/sibling agents, mail/inbox,
  orchestration, or fan-out.
---

# ftown

Use the local bridge CLIs installed under `~/.ftown`. They read
`~/.ftown/bridge.json`; anyone who can read that file can control the bridge's
sessions.

## Pick The Reference

- Session control, mail, terminal output, archive/revive, or local API:
  read `references/sessions.md`.
- Ad-hoc multi-agent coordination from an orchestrator session:
  read `references/orchestrator.md`.

## Quick Commands

```bash
# Sessions
~/.ftown/ftown-sessions list
~/.ftown/ftown-sessions create --prompt "Run tests" --workdir "$PWD" --parent
~/.ftown/ftown-sessions screen <session-id> --limit 200
~/.ftown/ftown-sessions tell <session-id> --type task "continue with the API client"
```

Use orchestrator guidance for ad-hoc multi-agent coordination.
