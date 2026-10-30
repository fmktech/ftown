# Independent review

Reviewer: `/root/auth_review`, Tier 2, `gpt-6.1-sol`, `max`.

## Contract gate: approved

No blocking corrections to the proposed contract in `coordination.md`.

- Defaulting assisted-update availability on is consistent with an explicit update action and confirmation. Preserve the existing control authorization, supported-launch, active-operation, busy and restart-admission gates. The canonical-install, POSIX, non-solo and default-data-directory restrictions remain enforced by `bridge/src/index.ts:879`.
- Discovery must report a valid release even when the running Node version cannot install it. Metadata parsing and runtime admission are separate decisions: retain fixed package/origin/version/hash/integrity checks in the parser, and retain the strict runtime check in `validateStableMetadata`. `prepareRelease` invokes that strict validator before creating staging directories or downloading a tarball (`bridge/src/update-release.ts:142`). An unrecognized engine range must remain non-installable.
- A known incompatible release must retain its version and version comparison, expose `node_incompatible`, disable the update action, and reject a request before acceptance/persistence. Preserve genuine lookup failures as `unknown`/`release_unavailable`; the resolver failure path currently clears the cached release (`bridge/src/bridge-update.ts:65`). Authorization, launch and active-operation reasons retain precedence.
- Optional, bounded Node fields and the additive reason preserve acceptance of old bridge statuses. Reject malformed supplied fields, keep the incompatible update button disabled, and explain the Node requirement separately from update availability. The status parser boundary is `ui/src/hooks/useBridgeUpdates.ts:29`.

Clarification incorporated in the approval sent to root: option ordering means **last occurrence wins**. `--allow-updates --no-allow-updates` is false; the reverse is true. Avoid describing this as unconditional negative precedence. Test the actual Commander wiring, including the default and both orders.

Acceptance should retain the specified incompatible/supported runtime pair, strict staging rejection, genuine registry failure, old/new UI status parsing and existing unsupported-launch checks. No actual release installation or user-bridge restart is required for this change.

This is the pre-implementation contract approval, based on read-only source inspection. It does not substitute for the subsequent implementation review or root-owned runtime/CI checks. No application files changed and no tests, services, E2E, installs or Git mutations were run by this reviewer. Report lease released pending the assigned code-review follow-up.

## Final implementation gate: approved

Reviewed the final working diff and the new option module/tests against the frozen contract after the implementation writer released its leases. **No blocking findings.**

- `configureUpdateOptions` defaults the actual Commander option to true and registers the negative option (`bridge/src/update-options.ts:3`). `runBridge` uses that configuration (`bridge/src/index.ts:114`); the existing `ftown start` forwarding path passes the arguments through unchanged (`bridge/src/ftown-cli.ts:36`, `bridge/src/start-commands.ts:25`). The parser regression covers default, positive, negative and both explicit orders.
- Discovery now calls `parseStableMetadata` (`bridge/src/update-release.ts:139`). Fixed-origin/name/version/commit/integrity checks remain, engine text is bounded and rejects C0/C1 controls, and unsupported range syntax fails closed. The strict validator still checks runtime compatibility, and `prepareRelease` invokes it before filesystem staging or tarball download (`bridge/src/update-release.ts:145`).
- Status retains a known incompatible release and its version comparison, includes the Node fields only when a release is known, and preserves control/launch/active-operation precedence. Request compatibility is checked before receipt persistence and before an acceptance ticket can start staging (`bridge/src/bridge-update.ts:111`). Existing control authorization, supported-launch restrictions, delivery gating, reservation, drain and restart checks remain intact.
- Optional wire fields preserve acceptance of existing bridge statuses. New fields are typed and bounded, including C1 rejection (`ui/src/hooks/useBridgeUpdates.ts:29`). The new block/error code is handled by both the status parser and request-response controller. The dialog shows the known release and current/required Node, gives Node-upgrade guidance, and keeps the explicit confirmation and eligibility gates (`ui/src/components/BridgeUpdatesDialog.tsx:30`). Ordinary startup guidance uses `ftown start`; legacy opt-in appears only in the older-bridge explanation.
- Regression assertions cover incompatible discovery, strict preparation rejection, rejection before receipts/staging, supported-runtime eligibility, authorization/launch precedence, malformed wire fields and the disabled incompatible button. The existing desktop/mobile E2E gains an assertion for the retained unsupported development-launch guard. Version/lock changes are limited to the patch bump.

Verification evidence is recorded in `implementation.md`: 19 bridge tests on Node 24.12.0; 18 on Node 24.22.1 with the documented existing npm-layout-dependent test excluded there and passed on 24.12.0; 10 UI tests; bridge build and UI typecheck. Root additionally reports that the compiled live resolver under Node 24.12.0 returns the known release and range while strict validation rejects it. These results were supplied by the implementation/integration owners; this reviewer performed source review only. Root-owned runtime and CI gates remain separate.

Only this report was changed by the reviewer. No application edits or tests, services, E2E, installs or Git mutations were performed. Review lease released.
