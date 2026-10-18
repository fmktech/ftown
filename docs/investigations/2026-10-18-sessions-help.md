---
type: investigation
symptom: "ftown sessions create --help sends a create request"
slug: sessions-help
date: 2026-10-18T02:00:00Z
git_commit: 957d90bbd265b90d60f54848a26a13a74722ccca
branch: feat/simplify-cli-release-and-notifications
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Sessions subcommand help opens transport

Worker `/root/npx_implementation`, explicit `gpt-6.1-sol` / `high`.
Scope and shared-checkout leases: `simplification-push/ownership.json`.

Observed: `runSessions(['create', '--help'])` returns zero but invokes the
creation transport. Expected: describe create options without transport.
Reproduction uses a temporary HOME/pointer and stub global fetch; no server,
real session or network is used. Run from bridge:
`node --import tsx --test src/sessions-commands.test.ts`.

Before parser edits the regression fails:

```text
AssertionError [ERR_ASSERTION]: help must not POST /api/sessions
1 !== 0
actual: 1
expected: 0
```

## Hypotheses

- H1, command dispatch: help is recognized only before selecting the subcommand.
  Prediction: create --help follows create's ordinary request path. Evidence:
  `sessions-commands.ts:211` tests only argv[0]; `:228` selects create and `:253`
  posts regardless of a --help token. Stub regression recorded one request.
  **PROVEN**.
- H2, Commander integration: a library parser runs the action while rendering
  help. Prediction: a Commander parser exists in this module. Evidence: the
  unmodified module imports the API and wire types only, and manual flag/
  positional helpers feed a switch. **REJECTED**; no Commander parser ran.
- H3, backend behavior: the server returned a misleading result to a help read.
  Prediction: the client issues a read-only/help request. Evidence: the stub
  captured one create POST without a backend. **REJECTED**.

## 5 Whys and falsification

1. Help created a session because the create handler executed.
2. The handler received --help as an ignored unknown flag.
3. Manual top-level help handling did not cover command-specific options.
4. Help text, flag parsing and dispatch were maintained separately.
5. The command boundary lacked declarative validation before transport effects.

Isolation/falsification: a stub transport reproduces the request without any
bridge/server; changing the fixture's success payload cannot prevent the POST.
Root cause is dispatch, independently of transport response behavior.

## Fix contract

Use Commander declarations for sessions parsing and generated command help,
matching the existing harness parser convention. Preserve public command forms,
aliases, legacy flags, request bodies and output defaults. Unknown options,
missing required arguments and help finish before transport opens. Existing
runSessions(argv):Promise<number> remains the entrypoint. This gate is recorded
before modifying suspected parser source. Regression must turn green and gain
coverage for invalid arguments and preserved ordinary requests.

Resolution: Commander declarations now generate root/subcommand help and parse
all supported options before handlers open transport. The pre-edit regression
is green. Four stub-transport tests cover every command's help, missing values/
arguments, unknown options, create payload (including no-op --orchestrator),
terminal/mail requests and inbox alias output. No actual session/network/server
was created. Combined TypeScript build and focused unit checks passed; see
`simplification-push/cli-handoff.md` for the integration handoff.

Bounded review follow-up: a missing fanout message still resolved targets before
checking text. With FTOWN_SESSION_ID set, a stub regression for tell --parent,
--children and --siblings captured three GETs before the expected errors:
`missing message must not fetch sessions for fanout`, actual3 expected0. This
is the same validation-boundary cause above; move the empty-message check
before resolveFanout. Root authorized this focused repair after its full suite
and initial fixture smoke exited. No new runtime/server reproduction needed.
The targeted regression is now green (zero requests), parser suite5/5 passed,
and the combined bridge build passed again at unchanged version0.19.45. Root
received the dist lease before repeating its runtime smoke.
