# Contract — integrate the `grok` build CLI as a first-class ftown agent

FROZEN. Implementers conform to this exactly; do not renegotiate. Mirror how
`codex` / `cursor` are already wired — grok is a new **top-level agent**, NOT a
claude flavor (it is its own binary `grok`, xAI Grok Build TUI v0.2.93).

All edits happen in the worktree:
`/Users/fkesheh/projects/ftown/.claude/worktrees/grok-agent`
Edit ONLY the worktree copies (absolute paths under that dir). Never touch the
main repo checkout at `/Users/fkesheh/projects/ftown/<same-relative-path>`.

## grok invocation facts (verified on this machine)
- Binary: `~/.local/bin/grok`, on PATH as `grok`. Auth: OAuth session in
  `~/.grok/auth.json` — already logged in, launches unattended, no API key needed.
- Interactive TUI launch: `grok [OPTIONS] [PROMPT]`. Bare `grok` starts the TUI.
- Positional `[PROMPT]` seeds + auto-submits the first turn (the `claude "<prompt>"`
  / codex positional analog). So the prompt is passed as a CLI arg, never typed.
- `-m, --model <MODEL>` — model select. Valid ids: `grok-4.5` (default),
  `grok-composer-2.5-fast`.
- `--always-approve` — auto-approve all tool executions (unattended). This is the
  grok analog of claude's `--allow-dangerously-skip-permissions` / codex's
  `--dangerously-bypass-approvals-and-sandbox`.
- Working dir: inherited from the process cwd (the runner sets cwd), like codex —
  so we do NOT pass `--cwd`.
- Resume (`-r`/`--continue`/`-s`) EXISTS but is OUT OF SCOPE for v1 (see below).

## Canonical grok launch command (THE frozen string form)
Built identically in the bridge and the UI. New session only (v1):

    grok --always-approve [-m <model>] [<initialPrompt>]

Rules:
- Always start with `grok --always-approve`.
- If a model is provided AND non-empty, append `-m <shellQuoted model>`.
  (Default model `grok-4.5` may be sent explicitly or omitted — both fine; omit
  when the picker value is empty/default.)
- If an initial prompt is provided AND non-empty, append it as a single
  shell-quoted positional arg (auto-submitted by the TUI).
- Shell-escape every interpolated value with the existing `shellQuote`.

## v1 scope decisions (do NOT exceed)
- NO resume: grok gets no session-id field and no `-r` branch in v1 (like
  `opencode`/`shell`). Deterministic resume + live status ride on the separate
  hooks-compatibility investigation and are a fast-follow. Do not add a
  `grokSessionId` field anywhere.
- Auth: rely on the existing OAuth session; add NO provider-env mapping (grok is
  not Anthropic-shaped and does not use `ANTHROPIC_*`). It inherits `process.env`
  through the normal `buildEnv` path, which is sufficient.

## Type / registry changes (the shared root)
1. `bridge/src/types.ts` — add `'grok'` to the `ShellType` union.
2. `ui/src/types.ts` — add `'grok'` to: the `ShellType` union, the `TopShell`
   union (top-level picker), and the `LoopHarness` union.
3. `bridge/src/loop-scheduler.ts` — add `'grok'` to the `LOOP_HARNESSES` set.
4. `bridge/src/create-ftown-session.ts` — include `'grok'` in the set/predicate
   that decides `promptAsCliArg` (grok takes the prompt as a positional CLI arg,
   so it belongs with claude/codex/cursor, NOT the "type into TUI" path).

## Builder signatures (frozen)
Bridge `bridge/src/agent-commands.ts` — add:

    export function buildGrokCommand(options: {
      model?: string;
      initialPrompt?: string;
    }): string

and a `if (shellType === 'grok') return buildGrokCommand({ model: input.model,
initialPrompt: input.initialPrompt });` branch inside `buildSessionCommand`,
placed alongside the `codex` branch. `BuildSessionCommandInput` needs no new field.

UI `ui/src/lib/agent-commands.ts` — add the mirror:

    export function buildGrokCommand(options: {
      model?: string;
      initialPrompt?: string;   // include the param even if the current UI
                                // builders omit it; the UI createSession path
                                // must produce the SAME string as the bridge.
    }): string

Both builders MUST emit byte-identical output for the same inputs.

## UI wiring
- `ui/src/hooks/useSessions.ts` — in `createSession`, add a `grok` branch that
  builds the launch command via the UI `buildGrokCommand` (mirroring the
  codex/cursor branches) and sets `shellType: 'grok'` on the payload.
- `ui/src/components/NewSessionModal.tsx` — add `grok` to the agent picker
  (`TopShell` options) with a sensible label (e.g. "Grok"), and a model dropdown
  offering `grok-4.5` (default) and `grok-composer-2.5-fast`. Place the model
  options exactly where codex/cursor model options are defined.
- `ui/src/components/SessionList.tsx` — extend the shellType badge ternary/switch
  to render a `grok` badge (pick a distinct color consistent with the existing
  per-agent styling).
- `ui/src/components/LoopFormModal.tsx` — add `grok` to the loop-harness picker
  so scheduled loops can run grok.

## Definition of done (gates)
- Bridge: `npx tsc -p bridge/tsconfig.json --noEmit` (or the bridge build script)
  passes clean; bridge unit tests pass, including new grok cases.
- UI: `npx tsc -p ui/tsconfig.json --noEmit` passes clean.
- No change to any file outside this contract's ownership list.
- The two `buildGrokCommand` implementations produce identical strings (asserted
  by the bridge test; the UI mirror is verified by inspection against it).
