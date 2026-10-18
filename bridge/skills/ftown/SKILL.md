---
name: ftown
description: >-
  Control ftown sessions: create/list/read/drive sibling sessions, send ftown
  mail, and coordinate worker agents. Use for ftown sessions, child/sibling
  agents, bridge mail/inbox, or explicitly requested orchestration.
---

# ftown

Use `ftown sessions`, `ftown harness`, and `ftown env`. Run `ftown --help`
for command discovery; if it is missing from PATH, use `~/.ftown/ftown`.
The bridge installs this skill at `~/.ftown/skills/ftown`, linked from the agent
skill directories. Startup checks setup readiness and never rewrites global
integrations. Before the installed command exists, run setup from the package:

```bash
npx ftown setup
```

For upgrades, use the exact new version named by the startup readiness hint:

```bash
npx ftown@<new-version> setup
```

The installed alias uses its copied version and does not discover newer packages.
Use `ftown setup --repair` to repair that current copied version or detect new
optional harnesses. If the copied runtime is incomplete, use the matching package
entrypoint with `--repair`.

## Commands and references

```bash
ftown sessions list
ftown sessions create --prompt "Review the auth module" --workdir "$PWD" --parent
ftown sessions screen <session-id> --limit 200
ftown harness mail send <session-id> --type task "review the API client"
ftown harness mail read
ftown env --help
ftown setup --help
```

Read `references/sessions.md` for the session, mail and terminal command
reference. Read `references/orchestrator.md` for practical worker coordination
examples. Each command group also has `--help`.

## Identity and reporting

Your id is `$FTOWN_SESSION_ID`; children also receive `$FTOWN_PARENT_SESSION_ID`.
A child's initial briefing identifies it and its parent and explains reporting:

```bash
ftown harness mail send --parent --type result "Done; checks passed"
ftown harness mail send --parent --type escalation "Blocked: need the API contract"
```

Mail arrives as `[ftown mail]` context through harness hooks/extensions where
available. Cursor and shell sessions receive an idle nudge to read their inbox.
Prefer mail for agent communication; use terminal key injection only when the
task needs it. Inspect peers with `ftown sessions list` and
`ftown sessions screen <id> --limit 100`.

## Cleanup

Session cleanup is an explicit user or orchestrator action. Reporting a result
does not remove a child automatically. Keep sessions available for follow-up
until cleanup is requested or the coordinating task calls for it.

```bash
ftown sessions remove <finished-session-id>
ftown sessions archive
ftown sessions revive <archived-session-id>
```

Removal archives the session; revival creates a new session id and resumes its
agent conversation when supported. Preserve useful results before cleanup.

## Connection and compatibility

The commands read `~/.ftown/bridge.json`. Anyone who can read that file can
control the bridge's sessions. Existing `ftown-sessions`, `ftown-harness`, and
`ftown-env` launchers remain compatible; use the grouped commands above in new
instructions. ftown does not install a ticket system or provide a workflow
runner. Independently installed coordination tools remain yours to manage.
