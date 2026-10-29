# Account device display names: pre-freeze review

**Verdict: changes required before freeze.** Owner scoping, session-only authentication, explicit origin enforcement, verified roster eligibility, separation of cosmetic labels from signed identity, strict unknown-key validation, optional-schema fallback and preserving original details are appropriate. Three contract gaps affect correctness:

1. **Concurrent revocation:** A conditional SQL `EXISTS` guard on the previously verified head and active refresh row checks a statement snapshot. Under PostgreSQL READ COMMITTED it does not lock those rows against a concurrent revocation; the revocation may commit before a nickname write that observed the old state. The absence-of-history case has no row to lock. Define an enforceable serialization/locking strategy that includes the absent-history case and the existing history/refresh writers, or explicitly relax the stated guarantee to snapshot-time eligibility and document the race. The existing Neon HTTP query adapter does not by itself expose a callback-style transaction, so the implementation needs a concrete supported transactional boundary rather than pseudocode.
2. **Existing bridge identifier contract:** The signed bridge schema allows 1–200 `[A-Za-z0-9_-]` characters (`bridge/src/security/bridge/account-state.ts`). The proposed API's 128-character maximum rejects valid existing targets. Match the 200-character bridge limit (browser IDs remain naturally bounded by signed membership), and test the edge and rejection beyond it.
3. **Concurrent save ordering:** GET fencing after save does not handle two simultaneous PUTs whose replies arrive in a different order from their database commits. Specify one active mutation per hook/owner with a synchronous admission guard, or a request/commit reconciliation strategy that converges to server state, including reset-vs-rename and identity change. Cover these races in tests.

Additionally, verified-read filtering of GET must address a checkpoint change between verification and reading metadata; recheck the verified head and retry/fail conflict, or explicitly document snapshot-time semantics. This prevents claims that every response reflects membership at response time without an enforced boundary. A missing names table must retain the documented 503/fallback and never be conflated with an empty successful list.

No source edits or tests were performed. Report lease released for pre-freeze; available for post-change review.

## Pre-freeze closure

Root accepted the 200-character ID bound and synchronous single-PUT guard, and explicitly chose snapshot-time eligibility rather than a claim of serialization against concurrent revocation. A concurrent post-snapshot revocation may leave an inert alias row; later lists filter it against current verified membership and it never grants access. GET uses the same snapshot-time semantics. With these decisions the identified blockers are resolved; no additional pre-freeze blocker remains.

## Post-change review

**Source review: pass; no blocking findings.** The store derives targets from the verified checkpoint and owner-bound active refresh rows, excludes revoked bridge IDs, scopes alias reads/writes by owner and kind, and checks the verified head and legacy binding in the write statement. As agreed, these are snapshot-time semantics rather than serialization with concurrent revocation. Nicknames never alter signed history, refresh records or permission decisions. The route uses the authenticated session, checks trusted mutation origin, enforces bounded strict input and no-store, and maps database failures to sanitized 503 responses.

The client maintains independent owner/read/write generation fences, synchronously rejects concurrent PUTs, and fences an older GET when saving. Editors are keyed by account and selected target; original names and fingerprints remain visible, generic explicit browser aliases bypass the fallback transform, and failed loads retain the access map with edits unavailable. Focus/reopen refresh provides eventual cross-browser updates, not realtime push. The focused E2E spec checks two approved browsers, both device types, another owner's denied writes, resets, and unchanged signed trust and bridge grants.

This was read-only source/test inspection. The implementation handoffs report backend and frontend unit checks passing; root owns integrated tests, isolated database migration verification, rendered review, and E2E/CI evidence. No claim is made here that those runtime gates have passed. Report lease released.

## Final incremental review

**Pass; no blocking findings.** The editor disables its input during an active save/reset and when editing becomes unavailable, preventing a draft from being changed while a save is pending. Its live success message now uses a neutral text color; errors retain error styling. The added focused test checks the pending input and success styling. The isolated database script resolves the actual `pg` runtime from the E2E package, where `pg` is a declared dependency, avoiding the UI tsconfig's declaration-file alias; its connection selector and generated-schema safeguards remain in place. Root reports the isolated database acceptance passed. Browser and visual evidence remain root-owned and were not inspected in this review.

Report lease released.

## Final test-only closure

**Pass; no concrete blocker.** On narrow viewports the access helper now waits for the mobile navigation button before clicking, avoiding an immediate visibility check during hydration. The fixture waits until the phone's account grant and original signed label are observable on the actual bridge before capturing the grants baseline. The final full equality assertions for both account trust and bridge device grants remain intact, as do the cross-account denial and reset assertions. Root owns the current E2E rerun; its result was not available to this review.

Report lease released.

## Runtime closure

The final spec establishes an encrypted shell from the approved phone, reconnects, confirms the same phone identity and restored access, and waits for the bridge's original account grant before recording the comparison baseline. Rename, cross-browser sync, reset, foreign-account denial, and full trust and grant equality assertions remain present. Root reports the focused Chromium test passed in 46.5 seconds, including overflow/touch checks and visual review of 1280, 390, and 320 pixel screenshots. This review inspected the final spec; runtime execution and visual review were performed by root. No blocking findings; report lease released.

## CI fixture guard repair review

**Pass; no blocking findings.** The guard now requires the exact three configured isolated specs in their canonical order and checks each canonical path against every other pattern. Existing unknown, nested, adjacent, prefix and suffix rejection checks, shared/isolated lane settings, and browser security assertions remain intact. This updates the stale roster without widening accepted paths or weakening isolation. Root recorded the baseline `3 !== 2` reproduction; the worker reports the fixture suite passing 6/6 after repair. No tests were rerun in this read-only review. Report lease released.
