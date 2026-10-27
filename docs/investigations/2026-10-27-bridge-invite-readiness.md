---
type: investigation
symptom: "Bridge advertises encrypted invite readiness before encrypted command readiness"
slug: bridge-invite-readiness
date: 2026-10-27T13:00:00Z
git_commit: acf5a180039d04753f7d79433477b1bcde938a32
branch: codex/navigation-consolidation
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Bridge invitation readiness

## Symptom
User recalls `local security operation failed` from `ftown security invite` on first startup, followed by success after restart. Exact original output and timing relative to the final Ready line are unavailable, so the user's specific cause is unproven.

Distinct observed code defect: index.ts:554 prints `[Bridge] Encrypted endpoint ready. Run ftown security invite to pair a browser.` before publishing its pointer (:838–856), installing local security handlers (:929), and opening the encrypted command readiness gate (:954). Expected: advertised invitation readiness implies the supported local CLI path can dispatch its command. Delta: the advertised phase permits deterministic rejection as bridge_offline.

## Reproduction
1. Read actual source at commit above with installed TypeScript compiler.
2. Parse and extract the exact encrypted dispatcher, startup timer, invite-ready log, and cli-client.securityCommand statements into `/tmp/ftown-bridge-invite-readiness-repro.mjs`.
3. Transpile and execute those statements with inert initialized command dependencies and a controlled timer. Call the exact dispatcher and CLI command before/after firing its existing readiness callback.
4. Run `rtk proxy node /tmp/ftown-bridge-invite-readiness-repro.mjs`.

Verified deterministic output:
```
"actualSourceOrder": [
  "advertises invite ready",
  "publishes bridge pointer",
  "installs security handler",
  "opens command gate after 2000ms"
]
"before": {"type":"command_response","response":{"requestId":"isolated-command","success":false,"error":"bridge_offline"}}
"beforeCliError": "Encrypted security command failed"
"after": {"type":"command_response","response":{"requestId":"isolated-command","success":true,"data":{"invitation":"inert"}}}
"afterCli": {"invitation":"inert"}
PASS: deterministic false-ready rejection and absence-test success with the same dispatcher/CLI and no live resources.
```

The harness uses no live bridge, server, native process, DB, network request, user file or identity key. It proves the source dispatcher readiness mismatch, not the exact user's historical execution. Initially the harness selector also matched a containing Commander expression; restricting extraction to the exact console.log expression fixed that observation artifact before obtaining results.

## Hypotheses
### H1: The invite readiness advertisement precedes the encrypted dispatcher readiness gate.
- **Layer**: state-data / startup ordering.
- **Prediction**: a valid command after the advertisement but before the controlled readiness callback returns success:false/error:bridge_offline; same input succeeds after callback.
- **Verification method**: actual-source extraction and controlled timer harness plus source position assertions.
- **Evidence**: deterministic before/after output above. index.ts:914 explicitly returns bridge_offline while ready is false; :954 sets ready true only in the later 2000ms callback.
- **Verdict**: PROVEN.
- **Rationale**: the actual dispatcher rejects a valid security_invite in an advertised-ready phase and succeeds after the only changed condition, the readiness callback.

### H2: Missing local identity or pointer is necessary for the advertised-ready dispatcher rejection.
- **Layer**: dependency/integration.
- **Prediction**: with initialized security/command dependencies, the advertised-ready rejection disappears.
- **Verification method**: isolate exact dispatcher with security installed and command handler able to return success.
- **Evidence**: harness initializes security and registers the dispatch context, yet before response is bridge_offline; same context returns success after callback. index.ts:543 provisions local identity before advertisement, pointer is published at :842 and handler installed at :929 before the 2second ready gate opens.
- **Verdict**: REJECTED.
- **Rationale**: missing identity/pointer can cause other startup failures but is unnecessary for this proven false-readiness rejection. This verdict does not rule out an unrelated identity/pointer error in the user's unreproduced historical attempt.

### H3: CLI securityCommand reports failure even for a successful encrypted command response.
- **Layer**: code logic / error presentation.
- **Prediction**: returning response.success:true still throws the generic error.
- **Verification method**: execute actual securityCommand source with inert localApplication failure then success responses.
- **Evidence**: beforeCliError is Encrypted security command failed, while afterCli returns the inert invitation object with the same actual CLI function. cli-client.ts:66 requires response.success===true; security-cli.ts:65 collapses thrown causes into generic local security operation failed text.
- **Verdict**: REJECTED.
- **Rationale**: the CLI correctly discriminates success. Its coarse error presentation obscures the reason, but is not what creates the capability rejection.

## 5 Whys
1. The advised invite can fail because the encrypted command dispatcher still returns bridge_offline.
2. The dispatcher still rejects because its shared ready boolean stays false until a later 2000ms callback.
3. The invite advice runs earlier because it is emitted after identity/directory initialization rather than actual command readiness.
4. Security initialization and command readiness have separate user-facing Ready messages with different guarantees.
5. Startup capability advice is not tied to the single authoritative command-readiness milestone; this wiring gap allows the interface to promise an operation before the operation is enabled.

## Falsification
- **Isolation**: initialized command/security mocks and no filesystem/network dependency still yield the rejection while ready is false.
- **Absence test**: fire the actual existing readiness callback without changing any identity, command, package, transport or application input. The dispatcher and CLI then succeed.
- **Adjacent cause**: security-cli collapses pointer, transport and command exceptions into the same message, so the user's recalled generic error cannot identify this race. We explicitly retain that uncertainty.
- **Result**: H1 survives for the distinct false-advertisement defect.

## Root Cause
The invite-ready console line at index.ts:554 promises encrypted CLI command readiness before the actual shared dispatcher gate at :954. The implementation treats initialization and usable command readiness as independently named Ready phases. H2 was rejected by initialized-context rejection; H3 by successful response handling. The exact source dispatcher and CLI switch from failure to success after only the readiness callback changes.

## Proposed fix and scope (not yet authorized)
- `bridge/src/index.ts`: move the invite-ready advice into the existing ready=true callback after command readiness is established. Retain the existing timer, readiness gate, resurrection sequencing and authority checks.
- `bridge/src/index-readiness.test.ts` (new): discriminating actual-source startup wiring regression ensuring invite advice is emitted only after the shared gate opens, plus isolated actual dispatcher/CLI before/after behavior. It must fail before and pass after the move.
- No protocol, cryptography, enrollment, key deletion, live restart or broad retry behavior change.
- Do not change generic CLI error text without a separate scoped decision; its failure is not the proven source of this rejection.

## Ownership
/root/navigation_review (gpt-6.1-sol/high) exclusively owns this report and /tmp investigation harness. Source/test scope is not yet granted. Two UI workers continue in disjoint files. Root owns E2E/server/DB/CI/Git.

## Resolution
Root accepted the investigation gate and granted exclusive `bridge/src/index.ts` and new `bridge/src/index-readiness.test.ts` ownership.

- The invitation-ready advice moved into the existing callback immediately after `ready = true` and the established command-ready log. No readiness delay, authorization, cryptography, enrollment, session resurrection or command behavior changed.
- The regression parses the actual composition-root dispatcher, timer and advice statements, plus the actual CLI securityCommand implementation, and executes them with inert dependencies. It invokes the actual encrypted CLI command at the instant the advice is emitted. This is a behavioral assertion on the real gate/wiring; it does not merely compare source positions.
- RED on unmodified index.ts: one of two tests failed with actual `[{ok:false,error:"Encrypted security command failed"}]` versus expected `[{ok:true}]`; the existing2second gate test passed.
- GREEN after the move: both tests passed; early dispatch still returns bridge_offline and post-timer dispatch succeeds.
- Relevant local checks: `node --import tsx --test src/index-readiness.test.ts`2/2; `node --import tsx --test src/security-cli.test.ts src/cli-client.test.ts src/local-pair-cli.test.ts src/cli-entry.test.ts`9/9; `npx tsc --noEmit`PASS; scoped diffcheckPASS.
- The baseline /tmp harness records the old before/after trace; after repair the durable test is the reproduction recipe and proves advice-time success against current actual source.
- No live bridge, server, browser/E2E, DB, CI or Git operation was run. No user data/keys were read or changed. The user's historical generic first-start error remains unattributed because its timing/output is insufficient.

## Independent review: pointer publication failure

The initial repair still advertised the local CLI command when the current startup failed to write its bridge pointer. The pointer-write exception is deliberately logged and startup continues; no successful pointer publication is guaranteed in that case. This is a separate, concrete condition from the original readiness-gate race. It does not establish why the user's historical generic error occurred.

- The isolated actual-source regression simulates a throw from the existing pointer write, invokes the existing delayed ready callback, and invokes the real CLI dispatcher when the advice is printed. RED before the guard: 2 tests passed, 1 failed because the advice still invoked the mocked CLI after pointer publication failure.
- The bridge now records whether this startup's pointer write returned successfully and emits the invitation advice only when that is true and the existing command-ready callback runs. The existing pointer error log remains, and the dispatcher gate, 2-second delay, session resurrection, authorization, cryptography and retry behavior are unchanged. This is not a guarantee against later filesystem or connection failures.
- GREEN after the guard: all 3 readiness tests pass, including the pointer failure case, while the pre-ready command still rejects and the ready dispatcher remains available on pointer failure. Nine security/CLI tests and bridge TypeScript noEmit passed. The bridge TypeScript build was emitted to task-owned /tmp/ftown-readiness-bridge-build to avoid removing or overwriting shared dist; the canonical npm build remains a CI gate.
- The bridge package and root lockfile package entries were bumped from 0.19.55 to 0.19.56 with the prescribed npm version patch command. No dependencies changed.
- The user's original generic error has not been attributed because its exact timing and underlying error remain unknown.
