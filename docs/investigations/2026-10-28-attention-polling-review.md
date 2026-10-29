
> Historical investigation of logging noise. The user clarified that the target is unnecessary transmissions; the logging-only patch was reverted. See [the transmission investigation](2026-10-28-attention-transmissions.md) and [its final review](2026-10-28-attention-transport-review.md) for the final change.
# Attention logging: independent review

## Pre-freeze verdict (2026-10-28)

The bounded logging contract is sound for the demonstrated cause: the handler currently logs before rejecting foreign targets, and the attention read shares the same receipt logger as other commands. Moving the log below the unchanged target filter and suppressing only `get_session_attention` by default preserves the command switch, response and error paths. The proposed acceptance cases cover the material routing and logging distinctions.

Two corrections are needed before delivery:

1. **Required release metadata:** `bridge/AGENTS.md` requires a patch version bump and synchronized `bridge/package-lock.json` for a bridge runtime change. Task B's file ownership does not include those files. Assign both to one owner after the dependency install lease is released, and validate the version gate.
2. **Documentation precision:** Describe event-driven hydration as behavior of the inspected current UI source. The investigation explicitly does not establish the deployed UI revision or the cause or interval of each observed read; avoid asserting those facts for the deployed system.

Review basis: `bridge/src/command-rpc.ts` target filter and attention case, its exception and publish error paths, `bridge/src/command-rpc.test.ts` existing attention/target tests, `bridge/AGENTS.md` versioning rule, and the investigation and Task B brief. No source edits or runtime tests were performed in this review.

## Post-change review (2026-10-28)

**Verdict: pass; no blocking findings.** The diff preserves the existing bridge target predicate, switch, authorization, response construction, and publish-error handling. The only behavioral change is receipt logging after that predicate, with attention reads gated on the exact environment value `1`. No payload or attention content is added to logs. The package and lockfile both advance to 0.19.59, and the new documentation qualifies the observed lifecycle as current-source behavior.

The new regression checks the successful default response and silence, non-`1` values, foreign read and mutation silence with debug enabled, exactly one owned debug receipt, continued mutation logging, failed-read response, and publication-error logging. Its test context restores console mocks and the environment. The implementation handoff reports a baseline RED and 9/9 focused tests plus build GREEN; this review independently inspected the diff and assertions but did not rerun them. Root owns the separate runtime smoke check.

All assigned review work is complete; report file lease released.
