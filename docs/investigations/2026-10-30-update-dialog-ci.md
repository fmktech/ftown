---
type: investigation
symptom: "PR 167 CI bridge update row locator finds no element and session header min-height is auto instead of 32px"
slug: update-dialog-ci
date: 2026-10-30T15:10:59-03:00
investigator: Foad Kesheh
git_commit: bd6d4e3ed63f5e8e31d5502b90cbd581d6b2d710
branch: fix/update-dialog-layout
repository: fmktech/ftown
status: resolved
hypotheses_formed: 4
hypotheses_rejected: 2
hypotheses_proven: 2
---

# CI update dialog and header geometry failures

## Symptom
Observed in run 41102306295, merge revision `50a3223170d04acdda2fb1ea9ea55d4bc50a8214` on Linux Node 24.22.1. Exact excerpts from `/tmp/ftown-update-ci-failure.log`:

```
Locator: getByRole('dialog', { name: 'Bridge updates' }).locator('dl > div').filter({ has: getByRole('dialog', { name: 'Bridge updates' }).getByText('Installed', { exact: true }) }).locator('dd')
Expected: not "Unknown"
Timeout: 30000ms
Error: element(s) not found
```

Both 1280px and 390px update tests fail this way. Two lifecycle tests independently report:

```
Locator: getByTestId('terminal-header').getByRole('button', { name: 'Rerun', exact: true })
Expected: "32px"
Received: "auto"
```

Stop reports the same mismatch. Expected: installed value locator matches a non-Unknown real installed version; lifecycle helper expects computed `min-height` 32px desktop and 44px mobile. Separately, CI's preview refresh test fails and is assigned to R2 for causal investigation; this log does not attribute it to these failures.

## Reproduction
Root will run `docs/investigations/update-dialog/ci-repro.ts` from task root with Node 24.22.1 and installed UI/bridge/E2E dependencies. It renders actual components with static known update status, preserves the exact CI locator and computed CSS assertions, collects their results without aborting before the second symptom, and compares a relative selector and physical dimensions. It opens an ephemeral loopback server and Chromium without bridge, database or deployment. Root ran the command at commit `bd6d4e3`, exit 1 after collecting all 12 failures. At each viewport 1280, 900, 390, 320: exact CI row count `0`, row-relative count `1`, relative installed text `1.0.0`; Stop and Rerun computed min-height `auto`, expected `32px` or `44px`, and physical boxes `32×32` desktop / `44×44` mobile with expected colors. The fixture changes no product source and needs no real bridge. This is a deterministic isolated reproduction of both assertion failures, not proof of CI bridge status itself.

## Hypotheses

#### H1: The update test's dialog-prefixed inner `has` locator cannot match when evaluated relative to a row.
- **Layer**: observation
- **Prediction**: CI locator count 0 despite visible `Installed` and known version; row-relative inner locator count 1 and same version.
- **Verification method**: root-run actual component fixture, exact and alternative Playwright locators at 1280/390.
- **Evidence**: Root reproduction: exact CI row count `0`, relative row count `1`, relative installed `1.0.0` at all four widths.
- **Verdict**: PROVEN for the isolated selector failure.
- **Rationale**: The same rendered row and version are visible with a relative inner locator; the dialog-prefixed inner locator yields no match.

#### H2: The UI never provides a valid installed version due to bridge or data failure.
- **Layer**: state-data
- **Prediction**: Even an unscoped semantic row lookup sees Unknown or absent installed version; no locator correction finds a known value.
- **Verification method**: fixture provides a known installed version and reports positive semantic lookup, falsifying source data absence in isolated failure.
- **Evidence**: Root reproduction `relativeRowCount: 1`, `relativeInstalled: "1.0.0"`, `ciRowCount: 0` at all widths.
- **Verdict**: REJECTED as necessary cause of this selector failure.
- **Rationale**: The failure occurs even with known valid fixture data. This does not claim CI bridge data itself was valid.

#### H3: Header button uses fixed height but omits the explicit minimum required by lifecycle checks.
- **Layer**: code-logic
- **Prediction**: CSS computed min-height is auto while measured height is 32px desktop / 44px mobile; same component classes define fixed heights without minimums.
- **Verification method**: fixture obtains exact lifecycle `toHaveCSS('min-height', ...)` results and bounding boxes on actual Stop/Rerun buttons.
- **Evidence**: CI `Received: "auto"`; root reproduction confirms `auto` computed on both controls at all widths, with `32×32` / `44×44` boxes. `SessionHeaderActions.tsx` `size` classes define `h-11` and `md:h-8` but omit min-height.
- **Verdict**: PROVEN for the distinct CSS assertion failure.
- **Rationale**: Existing explicit dimensions make physical targets correct, while missing minimum leaves computed min-height auto.

#### H4: Header controls physically fail their touch-target geometry because CSS or browser fails to load.
- **Layer**: config-env
- **Prediction**: When min-height is auto, the actual button boxes are not 32px desktop / 44px mobile, or other styles are absent.
- **Verification method**: fixture reads computed styles and box geometry at both viewports, and checks UI font and color.
- **Evidence**: Root reproduction reports expected colors and `32×32` desktop / `44×44` mobile boxes for both controls while computed min-height remains `auto`.
- **Verdict**: REJECTED.
- **Rationale**: Physical geometry and styling are present while the assertion fails.

## 5 Whys and falsification — locator failure
1. CI could not find the installed row because the inner `has` locator starts from the dialog rather than from a candidate row.
2. A row-relative filter evaluates the inner locator within each row; the row does not contain its ancestor dialog.
3. The selector was adapted to the new definition-list markup by reusing the dialog-scoped locator inside `has`.
4. The original isolated visual fixture verified visible versions but did not execute the production E2E selector.
5. The boundary between real E2E selectors and the fixture lacked a shared assertion, so selector scope mismatch escaped pre-PR checks.

Falsification: on the same component, same DOM and viewport, the row-relative inner locator returns one row and its expected `1.0.0` value; exact dialog-prefixed expression returns zero. This isolates scope, rejecting H2's missing-data cause for this reproduction. Immediate root cause is the nested dialog scope; process cause is failure to exercise the real selector in isolation. Repair will keep the positive non-Unknown and stable-version assertions and share the production locator expression with the focused reproduction.

## 5 Whys and falsification — min-height failure
1. Lifecycle checks read `auto` because controls do not declare min-height.
2. The new square icon controls specify fixed height/width but omit prior `min-h-11 md:min-h-8` classes.
3. Fixed height was treated as sufficient for visual hit-target sizing, although the existing E2E explicitly checks min-height.
4. The isolated browser fixture verified bounding boxes only and did not repeat the lifecycle computed-style assertion.
5. Responsive control geometry and CSS contract were not both included in the pre-PR focused browser acceptance.

Falsification: browser reports correct actual dimensions and expected colors at all four widths while min-height is auto. This rejects H4's physical-geometry/environment cause; H3 survives. Root cause is the lost explicit min-height contract. Restore it without changing icon sizes, and add the exact lifecycle style assertion to the focused reproduction.

## Fix authorization
Root authorized `e2e/tests/bridge-updates.spec.ts` row-relative inner locator and `ui/src/components/SessionHeaderActions.tsx` explicit minimum classes, with focused browser reproduction and static/unit checks. Preserve all existing assertions; root owns browser execution. No preview source changes.

## Repair and checks (pending root post-fix browser)

- `e2e/tests/bridge-updates.spec.ts`: row-relative inner `page.getByText` for Installed and Latest; the original non-Unknown and stable-version checks remain.
- `ui/src/components/SessionHeaderActions.tsx`: restored explicit `min-h-11 md:min-h-8` alongside existing fixed sizes.
- `docs/investigations/update-dialog/ci-repro.ts`: pre-fix exact assertions failed as recorded; now extracts actual production `installedRow` expression from the E2E source, asserts known value, retains old dialog-scoped expression as negative control, checks both exact min-height and physical boxes, and collects every viewport before exiting. `visual-smoke.ts` also asserts computed minimum height in addition to box geometry.
- Node 24.22.1: focused UI tests 40/40 passed (jsdom emitted four navigation-not-implemented notices); UI and E2E typechecks passed. Root must run isolated browser reproduction and visual smoke; no worker browser/server/CI execution. Status remains root-cause-proven pending post-fix result.

## Resolution

Root ran the isolated `ci-repro.ts` after repair: exit 0 at all four widths, production row count 1, legacy row count 0, installed `1.0.0`; Stop/Rerun minimums and actual boxes were 32px desktop / 44px mobile. The unchanged original selector/CSS assertions failed before the fix, proving the regression check discriminates. Root also ran the combined `visual-smoke.ts`: exit 0 at 1280, 390 and 320. Both root-owned harnesses closed their ephemeral browser and server. Focused UI tests passed 40/40 and UI/E2E typechecks passed. Real bridge and full CI execution are separate; the independently assigned preview failure remains under investigation.
