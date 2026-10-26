---
type: investigation
symptom: "Authenticated pending browsers cannot reach normal sign-out or push opt-in"
slug: pending-account-controls-ci
date: 2026-10-25T23:35:12Z
git_commit: 88145564477fa117d3af8b0bddb6d46ef017aca4
branch: feat/pending-device-approvals
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Pending approval hides authenticated account controls

## Symptom and reproduction

CI run40243860762 on PR138 passed48 cases, skipped2 and failed2. New pending desktop/mobile cases passed. The failures are real product regressions, not evidence that an unapproved device should receive session authority.

- `auth-session.spec.ts:13`: `waiting for getByTitle(..., { exact: true })`, then `Test timeout of 90000ms exceeded.` Expected the normal account menu and Disconnect action after real registration/login.
- `push-notifications.spec.ts:47`: `getByRole('button', { name: 'Enable push notifications' })`, `element(s) not found`. Expected the existing explicit notification opt-in after real registration/login and reload.
- Both artifact snapshots show `region "Waiting for device approval"`, the signed-in email, Check approval and Cancel request. Neither contains account controls.

Reproduction observed in the root-owned CI evidence under `/tmp/ftown-pr138-ci-40243860762/test-results`: register a fresh account in an empty browser, navigate to dashboard, remain correctly unapproved, then attempt normal UI sign-out or push opt-in. Root independently rendered the failure screenshot. Worker inspected both error-context files and trace network records; no worker runtime/E2E was started.

## Hypotheses

### H1: Authentication or account API failure prevented dashboard initialization

- Layer: state/integration.
- Prediction: the failed cases show401/5xx, an anonymous session or login screen.
- Verification: inspect trace network records and error-context snapshots.
- Evidence: auth/session GET200, auth/token POST200, security/account GET200 and pending create POST200; signed-in email is rendered. The auth test passed its session email and authorized-token assertions before line13.
- Verdict: REJECTED. Authenticated account state was present; login failure cannot explain the missing controls.

### H2: Push permission or server configuration made the opt-in unavailable

- Layer: configuration/browser boundary.
- Prediction: the push fixture fails secure-context/permission/config assertions, or a mounted disabled control explains the failure.
- Verification: inspect test execution and snapshot; read PushNotificationsControl.tsx46–80.
- Evidence: lines42–46 completed: secure=true, synthetic Notification permission=default, fixture requests=0, Permissions API=granted, GET/api/push200 and enabled=true. Failure is `element(s) not found`, not a disabled button. Snapshot contains only approval UI.
- Verdict: REJECTED. Permission/configuration cannot account for the component not mounting.

### H3: The unapproved early return omits account controls together with encrypted content

- Layer: component composition.
- Prediction: unapproved/no-pin browsers render DeviceApproval but never the Dashboard-owned account menu or PushNotificationsControl, while the admitted branch retains them.
- Verification: DashboardClient.tsx35–40 and Dashboard.tsx674–773; compare the exact artifact snapshots.
- Evidence: line39 returns `<main ...><DeviceApproval ... /></main>` before EncryptedDashboardClient. Dashboard owns both the user title/menu and `detachPushSubscription().catch(() => {}).finally(onDisconnect)`; it also owns the existing push control. Both traces display exactly the early-return content.
- Verdict: PROVEN. The direct branch and observed DOM match; admitted-branch controls are below the bypassed component boundary.

## 5 Whys

1. Sign-out and push opt-in cannot be found because neither control is rendered.
2. Neither is rendered because the pending gate replaces the complete Dashboard with DeviceApproval.
3. Account controls lived inside Dashboard alongside encrypted session controls.
4. The new trust gate correctly prevents mounting encrypted hooks but reused that component boundary as the account UI boundary.
5. Composition lacked a small authenticated-only shell and a regression asserting that account actions remain available without encrypted authority.

## Falsification

Adjacent-cause checks rejected auth/session and push configuration failures using successful independent API/permission assertions. The same source retains the normal Dashboard on the admitted branch, so this is conditional on the early-return boundary rather than a universal account-menu or push implementation failure. The actual pending snapshot contains neither control. Root and an independent security reviewer confirmed the same boundary. Hypothesis H3 survives these checks.

## Repair and acceptance

Write scope: DashboardClient.tsx, new DashboardClient.test.tsx and this report only. Add a private authenticated-only pending shell with the current email/title menu, Disconnect after existing push cleanup (including cleanup failure), and the existing PushNotificationsControl. Keep DeviceApproval unchanged. Keep Dashboard, EncryptedDashboardClient, SecureEndpointRuntime and connection/session hooks unmounted until the existing admission check passes. No protocol, API, grant or E2E assertion changes.

Regression tests must fail against the unmodified source for missing controls, then pass after repair; prove cleanup ordering/failure behavior, no encrypted instantiation on the gate and unchanged admitted dispatch. Worker runs only isolated units and UI/E2E static checks on supported Node24.22.1. Root owns automatic CI/runtime validation.

## Verification

Before source repair, Node24.22.1 focused regression:3 FAIL (missing email/title control in all pending cases),1 PASS (existing admitted branch). This discriminates the reported early-return regression.

After repair:4 new DashboardClient regressions PASS; together with12 unchanged DeviceApproval tests,16 PASS. UI and E2E noEmit checks PASS on Node24.22.1. The tests assert existing push account ownership, exact DeviceApproval props, delayed cleanup before sign-out, sign-out despite cleanup failure, no pending runtime/connection/Dashboard instantiation, and unchanged admitted encrypted dispatch.

Source repair adds only the private authenticated shell, using existing push opt-in/cleanup and auth signOut. New account actions have44px touch targets, a truncated responsive email header, keyboard Escape/focus restoration and blur closing. Existing protocol/E2E assertions are unchanged. Root-owned automatic CI must confirm the two original browser failures; no worker browser/server/DB/CI run or runtime-success claim.
