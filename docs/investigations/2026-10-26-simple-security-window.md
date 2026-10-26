# Security window simplification — 2026-10-26

## Product contract (frozen)
User wants the Security window extremely simple after confusing per-computer versus account approval caused missing remote sessions.
Default to Access (existing internal devices view key), Activity secondary. Both global and computer-specific entrypoints start Access; explicit pending-review entrypoint still works. Correct keyboard tab order.
First screen: concise current-browser access summary, eligible pending approvals as high priority, then Your computers BEFORE the browser roster. Each computer shows its name, plain-language access state separately from connection state, and one relevant next action.
Independent computer primary action: Share with my other browsers, invoking ONLY existing explicit client.migrate. Explain that account-approved browsers gain control and old separate browser approvals/invitations are replaced; browsers outside account approval lose access. Keep all existing ready/offline/history/busy gates. Never auto-approve or auto-migrate.
Shared status requires successful adoption or security_devices current identity source=account for the matching computer. Roster membership alone is insufficient (add_bridge can precede failed adoption). Roster-only means setup awaiting confirmation; errors never become success. Revoked/key-changed/invalid account state overrides stale confirmations. Offline is distinct and qualified.
Read-only verification probes must be bounded/deduplicated per open/connection/refresh and ignore stale async results after context change. No protocol/client/hook/crypto/schema changes.
Below computers: compact expandable Browsers with access, current browser first. Display This browser only for matching identity. Normalize misleading stored generic This device labels on noncurrent rows for display only, never rename persisted identities. Fingerprints and detailed metadata collapsed. Remove access wording may replace Revoke, with explicit confirmation, last-admin protection, offline/busy gates and offline propagation meaning retained.
Add-browser instructions short and available. Advanced recovery, independent invitation management and technical warnings behind disclosures. Do not hide required approval consequences.
Activity uses plain labels (Computer, Source, MCP actions, Computer actions); technical IDs and detailed explanations collapsed but retained, including unknown-outcome warning, retention, pagination, and error allowlist.
Mobile: 44px touch targets, no horizontal overflow at390px, safe-area scrolling and compact header. No decorative redesign outside security.

## Ownership and sequencing
Shared checkout /Users/fkesheh/projects/ftown-simplify-all; main checkout unrelated dirty. Existing four investigation notes protected by baseline /tmp/ftown-e2ee-notes-before.json.
Native implementation/integration owner /root/existing_pwa_access explicitly gpt-6.1-sol/high owns exact files:
- ui/src/components/SecurityPanel.tsx
- ui/src/components/SecurityDevices.tsx
- ui/src/components/SecurityActivity.tsx
- ui/src/components/Dashboard.tsx
- ui/src/components/security-panel.test.tsx
- e2e/tests/account-trust.spec.ts
- e2e/tests/e2ee-security.spec.ts
Root owns this report only. Reviewer /root/rate_window_review explicitly gpt-6.1-sol/high read-only. One implementation writer, exact paths disjoint. No generated/shared resources assigned to workers.
Preimplementation independent UX/security contract review PASS with confirmation safeguards above.
Worker Git setup lease: fetch main and create codex/simplify-security-window from latest origin/main (PR140 merged). No commits/push until reviewed handoff. Preserve protected notes.
Worker implements and authors browser assertions/screenshots, runs isolated units/noEmit only. Root sole E2E/CI/server/DB/browser executor; root verifies deployment selectors and downloads/screenshots for rendered desktop/mobile review. No dependency installs/migrations.
Handoff: exact changed files, unit/static evidence, released leases. Same reviewer closes source, same worker repairs any findings, then root focused browser/runtime/visual gate; commit/push/PR by designated integration owner. No merge/deploy authorization.

## Acceptance
Default Access and prominent computer sharing action solve the user's discoverability issue; account devices no longer bury computer actions.
Tests cover approved/current, pending/unapproved, legacy sharing, partial adoption/failure, revoked/key change/offline, last-admin removal restriction and context-stale probes.
Existing real browser desktop/mobile account approval/migration and independent device scenarios updated for new visible labels/disclosures. Capture Access desktop/mobile and activity view for root visual review. Keep existing security assertions.

Scope amendment before writes: implementation owner also owns ui/src/components/PendingDeviceApprovals.tsx only to change three Security → Devices directions to Security → Access, and docs/mcp.md for the matching navigation instruction. Approval controls and behavior unchanged.

## Reviewed implementation handoff
Branch codex/simplify-security-window based on main53cd97174baef0c1da7a80d83edfb54dcfab1553. Nine source/test/doc files implemented. Independent UX/security/React closure PASS after correcting verification-failure labels, revoked state override, per-computer stale probe invalidation and checking cleanup. Focused18/18, fullUI650/650, UI/E2E type checks and whitespace checks passed on Node24.22.1. Protected notes hash-identical. All writers stopped and released source leases.
Root runtime gate uses existing e2e workflow: e2e/env.sh selects ftown@localhost/ftown, Docker-owned test infrastructure and always-cleanup. No live account mutation or production schema/deployment for this task. Root will inspect desktop/mobile Access and Activity screenshots from CI. Integration owner may commit/push only nine scoped files plus this report, then release Git lease; PR after runtime/visual evidence.

## First browser/visual gate
CI40369243483:49 browser scenarios passed,2 skipped,1 failed because the MCP scenario asserted a collapsed Account devices list without opening Browsers with access. Root downloaded artifacts and reviewed actual1280/390 Access and multi-computer sharing screenshots: no horizontal overflow, prominent sharing action, secondary details collapsed. Root found early connecting state incorrectly instructed finishing sharing; repair should say Checking access while connecting/verifying.
Repair owner same worker explicitly owns only SecurityDevices.tsx, security-panel.test.tsx, account-trust.spec.ts and e2ee-security.spec.ts for this batch. Others frozen; root report disjoint. Adapt collapsed list assertion, accurate transient copy and settled ready screenshots; preserve security checks. Root reruns CI after review.

Four-file repair independently reviewed PASS: transient checking/waiting copy replaces premature action guidance; failed checks advise reconnect/refresh; actual independent results retain sharing action. Browser test opens disclosure before count+visibility, and screenshots await verified sharing. Two new RED regressions passed after repair; focused20/20, fullUI652/652, UI/E2E noEmit passed. Root reruns existing CI for final runtime and updated visuals.
