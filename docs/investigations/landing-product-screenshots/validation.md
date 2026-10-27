# Product media validation

Base: `482662e4a6919d7352aa24d5a496e6e9bfd0115d`; branch: `feat/landing-product-screenshots`. Root executed all runtime and E2E checks. Production and personal sessions were untouched.

## Isolation and repeatability

The dedicated Boat sandbox `bx_9zgq3e5r` was created without inherited environment or snapshots, with a finite two-hour TTL. It used Node 24.22.1, a canonical `/home/user/ftown` checkout and the actual hostname `demo-workstation`.

Before schema or data writes, root and the runner checked inherited deployment/database selectors, exact loopback URLs/database, canonical scratch homes, local Docker context, empty container inventory and required free ports. The capture command created real test accounts, a real account bridge, three shell sessions and two approved browsers. Private approval completed before recording. There were no generated mockups, DOM text replacements or fabricated test results.

The complete repeatable command passed with `WRAPPER_EXIT=0`:

```sh
FTOWN_CAPTURE_ISOLATED=1 FTOWN_CAPTURE_DIR=/tmp/ftown-product-media-v2-tap bash e2e/capture/run.sh
```

It installed dependencies, built the application, created isolated certificates/NSS trust and local infrastructure, ran the opt-in capture, then removed its exact services, browser HOME, Compose containers/network and ownership marker. Earlier failed captures also exercised cleanup and preserved their primary nonzero result and private staging; no final manifest was emitted for incomplete captures. The normal E2E discovery excludes the capture. Setup, refresh, review, publication whitelist and sandbox deletion are documented in `e2e/capture/README.md`.

## Approved media

Only seven WebPs, two MP4s and the version 2 manifest are in `ui/public/product/`. Root and the independent reviewer inspected all three raw screenshots, representative responsive exports and all nine extracted video keyframes. The media shows safe demo labels, real session attention, terminal output, touch controls and verified device access. No credentials or private pairing material were visible.

| Media | Dimensions | Duration | Bytes |
| --- | --- | --- | --- |
| Desktop screenshot, largest | 2240×1400 | — | 157,476 |
| Phone screenshot, largest | 780×1688 | — | 142,474 |
| Security screenshot, largest | 1792×864 | — | 53,958 |
| Desktop walkthrough | 1280×800 | 15.458333 s | 357,634 |
| Phone walkthrough | 390×844 | 14.041667 s | 181,883 |

Largest screenshot variants total 353,908 bytes; all seven variants total 521,848 bytes. Both videos together total 539,517 bytes. `ffprobe` verified H.264, yuv420p, 24 fps and a single video stream without audio. Measured dimensions, durations and bytes match the manifest. Videos load on demand; the initial landing request does not fetch either MP4.

## Checks

All commands ran in the isolated sandbox against the final source/assets unless noted.

- `cd ui && npm test -- --reporter=dot`: **701/701 tests**, 67 files, including Solo client coverage.
- `cd ui && npm run build`: production build and type checking passed.
- `cd bridge && npm run build`: passed during the capture workflow; bridge application source is unchanged.
- `cd e2e && npx playwright test tests/landing-product-screenshots.spec.ts`: **7/7 passed in 12.9 seconds**. Covers widths 320/390/1000/1280, authenticated redirect, real image loading/MIME/full-image navigation, responsive slot sizes, intrinsic ratios, no overflow, touch targets/focus, preserved MCP/encryption/Solo content and both videos playing on demand at desktop/phone widths. Playback verifies advancing time, exact dimensions/duration, valid MP4 MIME, no media/page/unexpected console errors, and keyboard controls.
- Eight existing automation/MCP/encryption browser cases passed during the image implementation and remain valid; their code/content was unchanged by the video addition. The complete local regression suite was not required or run for this change.
- `cd e2e && npx playwright test --list`: **59 tests in 17 files**, capture excluded.
- Opt-in real capture: **1/1 passed in approximately 1.2 minutes**. The recorded shell runs the actual six fixture-boundary tests and requires six passes, zero failures and the returned prompt.
- Existing browser-trust unit checks: **6/6 passed**. Shell syntax, ShellCheck, embedded JavaScript/Node syntax and bounded runner guard checks passed in worker validation.

The final coordinated validation ended with `FINAL_VALIDATION_EXIT=0 CLEANUP_FAILED=0`. Root verified empty Docker inventory, removed PID/browser-home/run-marker resources and archived evidence. The dedicated sandbox was deleted and verified absent from Boat list --all at 18:56 UTC after final review.

## Runtime findings resolved

A strict screencast dimension check exposed a Chromium compositor mismatch after resizing: actual 1280×713 pixels despite 1280×800 metadata. Root reproduced it in a browser-only probe. Taking an unpublished CSS-scale screenshot synchronizes the renderer before recording; every retained video frame still requires exact dimensions. No stretching/cropping or tolerance increase was used.

Chromium emitted about 60 frames per second for a 24 fps export. Retention now samples actual timestamps at no more than 24 fps plus the final actual frame, while acknowledging every frame, validating every received timestamp and preserving the original frame/storage/time caps.

The phone's default TTY reporter intermittently left its visible test summary incomplete. Closing the completed desktop context alone did not resolve it, so competing-resize causation remains unproven. The phone video uses the same real tests with an explicit plain TAP reporter; all original pass/fail/prompt assertions remained and passed. Screenshot and desktop commands retain their original reporter.

Two exact local Vercel Analytics 404/MIME console messages also occur on the unchanged login page because the local Next server lacks the hosted Analytics endpoint. Playback checks exclude only that observed text/location pair; every other console, page and media error remains a failure. Existing Next themeColor metadata warnings remain unchanged.

## Evidence

Private local evidence is under `/tmp/ftown-site-photos-20261027/`: `public-v2-review/` contains approved media and extracted keyframes; `final-media-evidence/` contains browser screenshots/results and logs; `ftown-player-crops/` contains readable excerpts of the actual expanded-player screenshots. Earlier image-only validation and exact baseline-console evidence are retained there. Raw frames, logs and browser screenshots are not published with the site.
