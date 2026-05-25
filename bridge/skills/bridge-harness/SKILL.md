---
name: bridge-harness
description: Control local ftown-bridge sessions via auto-deployed ~/.ftown/bin/ftown-harness. Triggers on bridge harness, /bridge-harness, bridge sessions.
---

# bridge-harness

## Entry (auto-deployed)

```bash
~/.ftown/bin/ftown-harness <cmd>
```

Read `~/.ftown/harness-agent.md` on each bridge start. Never curl/lsof the local bridge API.

## Playbook

```bash
ftown-harness status
ftown-harness here -n 25    # tails log even if process dead (status=error)
ftown-harness ls --tail 3   # log=N on each row; previews dead sessions with logs
ftown-harness grep ftown "error|FAIL" -C 2
```

## Commands

| Cmd | Notes |
|-----|-------|
| `here -n N` | Workspace walk-up; **tails when dead** if log exists |
| `ls --tail N` | Shows `log=lines`; preview any session with logs |
| `tail` / `grep` | ANSI+OSC stripped; `grep -C 2` context |
| `send` | `--dry-run` first; `-s` submit; only when user asks |
| `--json` | `ftown-harness --json ls` etc. |

Lookup: exact name → substring → id prefix.

## Dead vs error

`status=error` + `alive=false` does **not** mean no logs. Use `here`/`tail` — they read persisted terminal logs.

## context-mode

Use `ftown-harness` in Bash only. No curl/wget to 127.0.0.1.
