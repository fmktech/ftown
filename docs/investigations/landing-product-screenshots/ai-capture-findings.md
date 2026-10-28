# Genuine AI capture discovery

Read-only source discovery; no provider, browser, runtime, credential content, installation, E2E or Git operation was performed. The root confirmed an API key is available and its model-list response includes `gpt-6.1-terra`; actual account inference, CLI availability in the sandbox and successful TUI behavior remain to be verified there.

## Supported FTown path

Use the existing real Codex harness, not a shell impersonating an AI or a prerecorded transcript. `bridge/src/harness-registry.ts:91,310` builds `codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -m <model> <initialPrompt>` for `shellType: "codex"`. `bridge/src/create-ftown-session.ts:517` gives the initial prompt to the native TUI as a positional launch argument; explicit custom `command` would bypass this path and is unnecessary. The bridge marks the workdir trusted in its own `~/.codex/config.toml` (`create-ftown-session.ts:536`, `codex-installer.ts:209`). Because the runner disables its own sandbox, constrain the whole task to the disposable Boat VM and task-owned demo workspace; never mount a personal workspace or reusable personal Codex home.

After the real account bridge and browser approvals already in `e2e/capture/product.spec.ts`, create one actual session via the existing encrypted helper:

```ts
const result = await bridgeApiFetch("POST", "/api/sessions", {
  bridgeHome: bridge.home,
  body: {
    shellType: "codex",
    name: "Build duration formatter",
    workingDir: "/home/user/demo-workspace",
    model: "gpt-6.1-terra",
    prompt: "Fix formatDuration in duration.mjs so non-negative integer minutes are formatted as 0m, 5m, 1h, or 1h 05m. Run node --test and explain the change briefly.",
  },
});
// Assert 201; record result.body.session.id and assert shellType/model.
```

Use no `env`, token, custom command or pasted transcript in the session request. The API accepts these fields and returns 201 (`local-api-server.ts:510`, `create-ftown-session.ts:565`); `running` is persisted before `runner.run`, so 201 alone is not a provider-response or process-readiness guarantee. Session `env` is stored server-side (`bridge/src/session-wire.ts:1`), making it inappropriate for a key even though stripped from browser responses.

Prepare `/home/user/demo-workspace` as a new task-owned directory outside the FTown checkout. Seed a tiny public example: `duration.mjs` exports an intentionally incomplete `formatDuration(minutes)` and `duration.test.mjs` uses Node's built-in test/assert for 0, 5, 60 and 65 minutes; the starting tests must fail for the documented bug. Run a real fix, not a static example of the answer. After the agent finishes, root independently runs the actual tests and requires all four pass, and checks the file changed only within the demo workspace. This verifies work independently of anything the model claims. Avoid requiring specific prose or a canned answer from the model.

## Credentials and configuration

The actual Codex CLI must be on the sandbox PATH *before* the scratch bridge's `ftown setup`: `bridge/src/setup.ts:41` detects and installs its hook integration during setup. Use the CLI version root already verified compatible, with no global or personal home mounts. `e2e/helpers/account-pairing.ts` creates a fresh per-run HOME and invokes setup before the bridge child starts; after `startAccountTestBridge()` returns, root-owned capture code can provision that exact HOME before session creation. No need to send provider credentials through FTown API. Keep inherited `CODEX_HOME` unset (or explicitly aligned to the scratch `.codex`), because FTown's trust helper writes `homedir()/.codex/config.toml` rather than consulting an unrelated `CODEX_HOME`.

Official [Codex authentication documentation](https://learn.chatgpt.com/docs/auth) supports `codex login --with-api-key` receiving the key on stdin. Have the root-owned harness read a root-provisioned 0600 task-owned private key file **outside the checkout, staging and public artifacts**, feed it directly to the login child on stdin with scratch `HOME`/`USERPROFILE`, and suppress sanitized stdout/stderr. Never put the key in an argv, shell command, prompt, Playwright assertion, session `env`, trace, screenshot, logs or manifest. Reject missing, symlinked, non-regular, wrong-owner, broadly accessible or noncanonical key file, and reject extra provider/base-URL/config selectors; do not dump contents during validation. `run.sh` currently rejects arbitrary `FTOWN_*` input and does not install Codex, so this needs a narrowly defined explicit key-file input and CLI prerequisite/version check. The parent capture process should remove the secret from child environments after authentication; the fixture bridge's `ProcessRunner.buildEnv` inherits its process environment (`claude-runner.ts:210`), while tmux serializes session environment into a short-lived 0600 file (`tmux.ts:96`); avoid exporting the provider key globally to bridge, UI, other sessions or subprocesses.

Set top-level `model_reasoning_effort = "xhigh"` in the fresh scratch `.codex/config.toml` **before** creating the Codex session, preserving any setup-generated config and ensuring it is top-level (not appended inside a `[projects]` table). FTown passes the model via `-m` but has no effort field in the session API. The [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents this key; [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra) supports xhigh. Root must verify the installed client actually honors these settings and the provider accepts a real request; API model listing alone proves neither. Fail explicitly rather than silently changing model, reasoning effort or provider.

## Capture and evidence

1. Use the existing actual dashboard, isolated browser approvals and `openSession`/draggable sidebar selection. Open the named Codex session and wait for a real Codex terminal, then poll the real encrypted `GET /api/sessions/<id>/screen?limit=200` (`local-api-server.ts:870` returns `{lines,totalLines,offset,limit}`). Do not log screen data, which could contain secrets or private paths. Assert visible Codex/model/session identity, meaningful agent turn and independently verified fixture/test outcome. A screen containing only the user prompt, a startup/auth error, or an echoed marker is insufficient; inspect the finished rendered frame for an actual assistant response before publication.
2. Take the desktop poster only after this real response is present. For a short video, start CDP recording only after all private pairing, auth and the first completed agent task; show the selected actual Codex TUI and type a genuinely new bounded follow-up into its real terminal (for example, ask why the formatter pads minutes). Wait for an actual new assistant response, compare its rendered content to the pre-input state, and visually review that it is the response rather than the prompt or a tool log. Same phone view opens the same real agent session through Workspace/Terminal, with actual mobile controls. A real AI request may take longer than existing 60-second video limit; obtain the initial result before recording and fail the follow-up if it cannot complete within the existing bounded recording, rather than filling time with synthetic output.
3. Retain existing security dialog proof, original pairing and cleanup. Record only reviewed dashboard content, never login/approval screens or secret-bearing terminals; review every screenshot and sampled video frame before publication. Preserve exact task-owned contexts, session IDs, screenshot/MP4 metadata and manifest contracts until root freezes any new revision.

Candidate implementation ownership for root to freeze: `e2e/capture/product.spec.ts` (real fixture/session/readiness/walkthrough), `e2e/capture/run.sh` and `README.md` (explicit safe key-file/real CLI prereq and cleanup), optional dedicated `e2e/capture/` auth helper; `record-video.ts` remains reusable unless the video contract changes. Root alone provisions and deletes the external secret file, executes the provider/capture and copies only inspected public outputs. Session deletion/bridge stop removes task-created PTYs and scratch HOME including CLI auth; explicitly inspect and remove any task-owned leftover tmux environment/credentials on failures, and dispose the private demo workspace and sandbox. Do not delete unrelated resources. Keep private raw recordings and staging out of Git and published assets.

No application/capture code changed. `ai-capture-findings.md` lease released on handoff.
