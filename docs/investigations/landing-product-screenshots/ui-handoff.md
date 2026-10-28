# SITE-UI handoff

Tier 1 `gpt-6.1-terra` / `xhigh`; checkout `/Users/fkesheh/projects/ftown-e2e-performance`.

## Deliverable

- `ui/src/app/page.tsx`: preserve Solo/auth redirect order and lower technical sections; replace both videos with a vertical hero, approved image components and self-host anchor; maintain 44px CTA/nav targets.
- `ui/src/components/ProductScreenshots.tsx`: server-rendered semantic figures consuming the frozen `ui/public/product/manifest.json` with responsive sources, intrinsic dimensions, prescribed copy, priority/lazy loading and same-tab full-size links.
- `e2e/tests/landing-product-screenshots.spec.ts`: focused public checks at 1280, 390 and 320px, image load and sizing, candidates, target size and keyboard focus, WebP navigation/back, self-host navigation, MCP/encryption assertions and authenticated redirect; full-page, hero and supporting screenshots for root review.

## Checks and remaining work

React best-practices checklist reviewed: static server components, no added client JS or data fetching, intrinsic image dimensions and links with accessible names. Manual source review only. No compile or test discovery: UI/E2E `node_modules` and global TypeScript/Playwright binaries are absent; root-owned manifest/assets are not present yet. No runtime, server, E2E, browser, DB, dependency, or Git operations were executed during this implementation assignment.

Root must copy the approved real manifest and WebPs, run build/type checks and the focused Playwright spec against the isolated stack, inspect all screenshots/copy/privacy and check for console errors, then run applicable existing Solo coverage and any required repository checks. Recheck the card layout and overflow at 320px and desktop hero visibility in particular. The Playwright spec collects page errors; console review remains a root runtime gate. Contract changes escalate to root; no placeholder assets were added.

Source and handoff file leases released. Awaiting any concrete review fixes or a separate Git integration lease.

## Responsive sizes review repair

Updated the security image's 900–1167px slot to `calc(100vw - 482px)` and the phone's 280px cap breakpoint to 346px. The focused browser test now also exercises 1000px and resolves the active `sizes` media branch via `matchMedia`, measures that CSS length with a temporary noninteractive probe, removes the probe, and compares it to the actual image box within 2px at each viewport. Manual source review only; root owns browser/E2E execution. Source and handoff leases released again.

## Aspect-ratio test repair

Root's combined E2E run passed 12 of 13 cases; the 320px landing case exposed border-box distortion in the test's ratio calculation. The test now subtracts computed border and padding from the rendered box before comparing the image content's ratio to its intrinsic ratio. The existing strict tolerance and advertised-slot box comparison are unchanged. Manual source review only; root reruns the five focused landing cases, retaining the eight passed MCP/encryption cases. Test and handoff leases released.

## Revision 2 walkthroughs

`ui/src/components/ProductScreenshots.tsx` now consumes the v2 video metadata and adds closed native desktop/mobile disclosures, 44px focus-visible summaries, matching screenshot posters and controls with `preload="none"`, `playsInline`, no autoplay or loop. The videos retain intrinsic metadata dimensions, fit their containers and cap the mobile player at 280px. No client player, extra JavaScript, dependency or placeholder media was added.

`e2e/tests/landing-product-screenshots.spec.ts` preserves the four viewport checks and authenticated redirect, updates their keyboard order for the disclosures, and adds two playback cases at 1280px and 390px. Each checks initial closed/no MP4 request, video attributes/posters, keyboard opening/focus, real MP4 response, advancing playback, pause, dimensions/duration against the manifest, overflow and page/console errors. Screenshots are saved for root review. Manual source review only: the v2 manifest and videos are root-owned and not yet supplied; no compile, E2E, runtime, Git, install or database operations were run. Root must supply approved assets, run build and focused playback/browser tests, and inspect the rendered controls/videos. UI/test/handoff leases released.

## Playback console baseline repair

The playback tests exclude only the two exact previously observed local Vercel Analytics errors: the 404 must originate at the precise `/_vercel/insights/script.js` URL, and the exact MIME error must name that URL and originate at the current root document URL. All other console errors and every page error still fail the test; playback additionally asserts the video has no media error. Exact baseline wording checked against `console-baseline.json` in the saved evidence archive. `node --check e2e/tests/landing-product-screenshots.spec.ts` passed. No E2E/runtime/Git operations. Test and handoff leases released.

## Final integration

Root accepted source, asset and rendered-player review; 701 UI tests, production build and seven focused browser cases passed, with eight unchanged MCP/encryption cases retained. Capture and validation cleanup passed and the dedicated Boat sandbox was deleted. All implementation leases are released. The Git integration lease remains exclusive through commit, push and PR handoff; root records the resulting PR association and final completion.

## AI walkthrough revision

- `ui/src/components/ProductScreenshots.tsx`: server-rendered figures now use one media surface per desktop/phone scene, the frozen genuine-Codex copy/alt text and retained independent image links/security card.
- `ui/src/components/ProductWalkthrough.tsx`: small typed client island, initially one responsive poster and a 64px labeled play button. The mounted native player is activated directly by a user gesture, uses `preload="none"`, retains the intrinsic scene frame, focuses native controls after successful playback and offers a polite error, retry and direct-file fallback on failure. No dependency or manifest interface change.
- `e2e/tests/landing-product-screenshots.spec.ts`: preserves the existing five landing/auth cases, adapts keyboard order and screenshot checks, adds desktop/mobile real activation cases plus one broken-media retry/fallback case. It checks no initial MP4 request, native controls and focus, metadata/MIME/time, single visible scene and stable geometry, no overflow at all four widths, and retains the exact existing Analytics baseline exception.

Static checks passed: `node --check e2e/tests/landing-product-screenshots.spec.ts` and a bounded source assertion of the two client boundaries, preload and playback/error behavior. React best-practices review: metadata and figures stay server-side, only the playback island is client-side, no duplicate visible media or extra dependency, semantic labeled controls and focus styling retained. No build, runtime, E2E, browser, install, Git or credentials were used. Root must supply and visually verify the genuine AI assets before publishing; then execute the build and all eight focused cases, including keyboard/native playback, 320px error/retry geometry and no unhandled rejection. Do not ship the AI copy with previous shell-only assets. UI/test/handoff leases released.

## AI UI independent-review repair

The activated-layout tests now compare document-relative positions, so normal click scrolling cannot look like layout shift. In the error state the same framed native player remains visible with its real poster and controls; the polite retry/file overlay sits at the top, away from the native control bar, and focus moves to Retry after failure. A cascade-safe important inset focus shadow and an inner wrapper focus ring remain visible despite global outline rules and clipping. The existing broken-media case now runs at 320px and asserts retry focus, native player visibility/poster and one visible media surface; keyboard playback checks assert actual `:focus-visible` and computed inset indicators.

`node --check` on the focused spec and bounded static repair assertions passed. No build/browser/E2E/runtime/Git was run; root must verify the generated focus styling and clickable native controls with the genuine media. UI/test/handoff leases released.

## Media-error race repair

Root's isolated focused run passed 7/8; an aborted video request left the error case in Loading. A real media error now immediately invalidates the current attempt, releases its in-flight guard and shows the error controls. Each play attempt has a generation token, so late fulfillment/rejection from an older attempt cannot replace the result of a retry. An error event is acted on only when the current video has a media error, avoiding stale events after `load()` clears it.

The existing 320px test now aborts the first video request, asserts the error/fallback/focus, allows the retry request through, and verifies a successful MP4 response, focused native player, advancing time and cleared media error. `node --check` and bounded static generation/retry assertions passed. No runtime/E2E/Git; root owns the focused isolated reproduction and post-fix run. UI/test/handoff leases released.

### Retry test precision

The broken-media route now aborts all requests while the error, focus and fallback are checked; it is explicitly unblocked immediately before the user's Retry click. The test records the request count and requires a new successful MP4 response and advancing playback afterward. `node --check` passed; no runtime/E2E/Git. Test and handoff leases released.

The 320px failed-media test now saves `ai-error-320.png` after the error/focus/fallback checks and `ai-recovered-320.png` after successful Retry playback is paused, for root visual review. Assertions and application behavior are unchanged. `node --check` passed; no runtime/E2E/Git. Test and handoff leases released.

### Service-worker isolation for failure injection

Root's r2 trace showed the service worker served the video with HTTP 206 and bypassed the route abort; the earlier observation therefore did not prove a player error. Only the broken-network test now uses `test.use({ serviceWorkers: "block" })`, and it asserts a real intercepted attempt before checking the error. The other seven cases retain default PWA behavior. Retry still requires a fresh successful MP4 response and advancing playback, with error/recovery screenshots. `node --check` passed; no runtime/E2E/Git. Test and handoff leases released.
