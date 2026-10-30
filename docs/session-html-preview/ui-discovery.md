# P2 — UI and encrypted transport discovery

Base: `9693fbb`; shared checkout `/tmp/ftown-html-preview`. Reviewer `/root/auth_review`, Tier 2, `gpt-6.1-sol`, reasoning `max`. Application files were read-only; no installs, tests, servers, E2E, DB or Git mutations. This report is the only written file.

## Recommendation and contract check

Use the existing Dashboard RPC for bounded, revision-pinned reads and add a small preview hook plus an iframe pane beside the existing Terminal. The draft `contract.md` matches the existing UI/transport seams. Root's subsequent clarification adds compact Terminal/Preview views whenever the **available main width is below 640px**, even at desktop viewport sizes, and requires both split panes to remain at least 240px. No new browser endpoint or terminal wire protocol is needed.

The v1 asset decision is now explicit: one self-contained UTF-8 HTML file, inline CSS/JS/data images, no relative/sibling/external asset packaging. The original broader asset-delivery question is resolved by that product scope.

## Current implementation map

| Responsibility | Existing evidence / implication |
|---|---|
| Shared RPC | `ui/src/components/Dashboard.tsx:194–204` creates **one** `useBridgeRpc(client,userId)` and passes it to domain hooks. Preview must consume `rpc.sendCommand`, not create another command subscription. |
| Current layout | `Dashboard.tsx:883–1034` is sidebar plus one `main`; `:1035–1052` renders Terminal and MobileControlBar. Insert a workspace wrapper inside this main, keeping the Terminal instance stable. |
| Selected session | `Dashboard.tsx:336–339,427–431` derives selection, clears vanished selection, and sends mobile selection to the terminal. New preview visibility belongs here or in an owned workspace controller, keyed by `(bridgeId,sessionId,preview.id)`. |
| Mobile navigation | `Dashboard.tsx:88,458–463,861–880` owns Workspace/Terminal state; sidebar visibility is `:888`, main visibility `:1034`. Preserve Workspace navigation and add a selected-session Preview view rather than replacing navigation. |
| Header actions | `Dashboard.tsx:385–389` builds selected-session actions, passed through `Terminal` at `:1041`; `ui/src/components/Terminal.tsx:22–36,502` already accepts/renders `headerActions`. A Preview toggle requires no Terminal prop redesign. |
| Resize/accessibility | `Dashboard.tsx:479–545,1012–1028` provides pointer capture, cursor cleanup, keyboard arrows/Home/End, separator ARIA, and refit scheduling. `ui/src/lib/sidebar-width.ts:1–17` is a useful **pattern**, not the numeric policy for the new split. |
| Terminal preservation | `Terminal.tsx:202–204` initializes xterm once; `:189–197` exposes `refit`; `:272–275` observes its container. `useTerminal.ts:46–60,73–77` owns the terminal subscription cleanup. Do not key/remount Terminal on preview visibility or revision. |
| Session metadata | `ui/src/types.ts:5–29` defines Session; `useSessions.ts:49–61` validates rows but currently ignores extra fields. Extend row validation for the shared preview descriptor. `mergeSessionSnapshot` at `:64–83` starts from the incoming snapshot, so omission of preview on clear naturally removes old metadata; no spread of the old preview is needed. |
| Domain example | `useBridgeUpdates.ts:46–91,115–129` demonstrates a small controller, per-target generations, coalesced reads and disposal. Reuse the discipline for preview, not its 60-second interval or mutation reconciliation. |
| Styling | `globals.css:6–38,63–70` defines surfaces/borders/text/accent/radii/shadows; `:322–365` supplies mobile-tab and resize-handle patterns. `SecurityPanel.tsx:93–105` demonstrates roving keyboard tab selection. |

## Transport wiring and minimum interfaces

`MessageClient` is already the shared authenticated cloud/local abstraction (`ui/src/lib/message-client.ts:4–37`). `SecureMessageClient` only emits authenticated applications to domain handlers (`secure-message-client.ts:13–24`); explicit bridge routing, deadline checks and sealing occur at `:115–164`. Its response correlation checks bridge ID and request ID at `:196–207`. `LocalBrowserClient.command` routes the same command through encrypted `/api/security/envelope` (`local-browser-client.ts:138–151`), and its encrypted event poll adapts local publications to the same subscription surface (`:160–174`). Preview should work through both without branching in its renderer.

The public `BridgeRpc.sendCommand` signature is currently `(command: Command) => Promise<CommandResponse>` (`useBridgeRpc.ts:62–66,280–284`); data is `unknown` (`ui/src/types.ts:185–189`). Its internal deadline/cancellation is per RPC (`useBridgeRpc.ts:96–114`), with no caller AbortSignal argument. A preview generation fence is sufficient for correctness without widening this transport: stop issuing further chunks after invalidation and discard the single outstanding result when it settles. Do not claim this cancels an already published read.

Use `bridge/src/preview-protocol.ts` as the shared import, following `useBridgeUpdates.ts:5` / `ui/src/types.ts:97` cross-package imports. Suggested exact exported names for root to freeze:

- `SessionPreviewDescriptor = { id: string; fileName: string }` (public only; no private source/path).
- `PreviewStatusRequest`, `PreviewStatusResponse`, `PreviewChunkRequest`, `PreviewChunkResponse`, matching the unions already written in `contract.md`.
- `PREVIEW_MAX_BYTES = 1_048_576`, `PREVIEW_CHUNK_BYTES = 98_304`, `PREVIEW_POLL_MS = 1_000`.
- A shared descriptor validator, or an explicitly equivalent UI validator, must bound the basename and validate the registration ID before enabling the pane.

Add `session_preview_status` and `session_preview_chunk` to `ui/src/types.ts` CommandType/CommandPayload alongside the bridge's command types. Every request supplies the selected session's **explicit** bridgeId, sessionId and previewId, plus a new requestId. Do not use `bridgeExec` to read files or expose a URL for the iframe to fetch.

Suggested new hook interface (proposal, not an existing API):

```ts
interface PreviewTarget {
  bridgeId: string;
  sessionId: string;
  preview: SessionPreviewDescriptor;
}
interface UseSessionPreviewOptions {
  client: MessageClient | null; // identity/generation boundary, not a new subscription
  userId: string;
  target: PreviewTarget | null;
  visible: boolean;
  readable: boolean; // connected command path and approved/ready bridge
  sendCommand: BridgeRpc["sendCommand"];
}
function useSessionPreview(options: UseSessionPreviewOptions): SessionPreviewView;
```

`SessionPreviewView` should discriminate initial loading, ready/refreshing (complete html + revision + document key), unavailable reason, unregistered, offline/approval unavailable, and generic error, plus `refresh(): void`. A document key must include target identity, registration ID and content revision; manual Refresh may add a reload nonce if it is intended to reset unchanged interactive state. Root should explicitly pick that small UX behavior before implementation; normal unchanged status must preserve iframe JS state.

Important reachability distinction: hosted preview RPC still needs the cloud command path even while the terminal has Local/P2P data connectivity. The frozen TerminalTransportApi only carries terminal frames (`direct-transport/contract.ts:65–119`); it is not a generic RPC channel. Local dashboard preview uses its existing encrypted local HTTP command path. Do not infer preview-read availability solely from the terminal's Local/P2P badge.

## Polling, assembly and switching rules

1. Maintain one logical loop for the selected, visible, readable preview while `document.visibilityState === "visible"`. Schedule the next status check after completion; a blind interval must not create overlap. A manual check coalesces with in-flight work.
2. `knownRevision` is the **last fully assembled and verified document for this exact registration**, never a partial download. If no complete document exists, do not ask the server for unchanged. Treat an impossible unchanged result without a cached document as a bounded protocol error.
3. On ready, fetch one chunk at a time for the advertised revision. Validate echoed previewId/revision, exact expected offset, stable totalBytes, 1MiB total bound, at-most-96KiB decoded chunk, canonical base64, and final done/length agreement. Empty HTML is the explicit zero-byte special case. UTF-8 decoding must occur after all bytes are assembled so multibyte characters crossing chunks remain intact; verify final SHA256 and fatal UTF-8 before exposing html.
4. Stale revision discards the entire assembly and waits for the next poll. Do not loop indefinitely trying to finish a changing file. Each await—including digest calculation—must recheck generation before commit or issuing another chunk.
5. Invalidate on client/user/bridge/session/preview ID/security readiness changes, close, document hidden and unmount. Clear the old target's document synchronously on target identity change. On a same-target refresh, retain the previous complete iframe until replacement is fully verified, as the draft contract specifies.
6. Missing/too-large/invalid UTF-8/invalid file/unavailable, authentication loss and offline state remove the old active iframe and show the corresponding state. Retry is available when the command path can read again. A stale descriptor may briefly return unregistered until the existing session-list reconciliation refreshes it (`useSessions.ts:296–325`); do not invent a replacement registration ID from content.
7. Store at most one active document/assembly, not a full HTML cache for every session. Per-session visibility can remain a small map. Prune entries when sessions disappear. No new event channel is required: existing session updates carry registration/clear, while status polling detects content edits.

## Layout and state direction

**Visibility:** first observation of a new `preview.id` opens it once. A user's Close records that same ID as closed. File-content revisions are discovered by status and never reopen a closed pane. New register on the same session creates a new ID and can open again. Switching sessions restores that session's open/closed choice; it must not inherit another session's pane or bytes. Clear removes the registration; Close only changes UI visibility.

**Desktop split:** keep Terminal in the left subtree and Preview in the right. Use a single DOM instance of each rather than separate desktop/mobile render trees. Default terminal share is 50%; store a UI-only ratio, clamped within 30–70%. After subtracting the separator, further constrain the ratio to keep each pane at least 240px. If actual main width is under 640px, use compact Terminal/Preview views; this avoids overflow when the existing sidebar is wide (`Dashboard.tsx:90–91` permits up to the existing sidebar maximum). ResizeObserver should recompute constraints. Pointer capture and a temporary drag shield over the iframe prevent the document from intercepting drag movement; restore cursor/userSelect on pointer cancellation/lost capture/unmount. Call `terminalRef.current?.refit()` on resize/open/close and force refit when returning from a hidden mobile/compact terminal.

The separator needs `role="separator"`, `aria-orientation="vertical"`, an accessible label such as `Resize terminal and preview`, current/min/max values, tab stop, arrows and Home/End. A double-click reset to 50% matches the existing sidebar convention. Keep `min-width:0`/`min-height:0` at every flex boundary, and prevent the iframe's intrinsic 300px default width from forcing overflow (`width:100%;height:100%;border:0`).

**Mobile/compact:** preserve Workspace navigation. When a session has a preview, expose Terminal/Preview as its view tabs with `aria-selected`, associated panel IDs and keyboard arrows/Home/End. New registration selects Preview for the selected session without moving keyboard focus into the frame; Workspace navigation still wins until the user returns to that session. Selecting an existing session restores its view/visibility; a session without registration retains today's terminal layout. Keep Terminal mounted while the preview is open/hidden and tabs change. Show MobileControlBar only when Terminal is the visible selected-session view; preview gestures should stay inside its iframe and must not send PTY input.

**Toolbar and states:** extend `sessionHeaderActions` with an accessible `Preview` reopen/toggle action. The preview toolbar shows a text-escaped/truncated basename, quiet `Auto-refresh` indicator, Refresh and Close buttons, and 44px touch targets with existing `btn-ghost`, border/text/surface tokens. Reuse HeaderTooltip for descriptions. Suggested copy: `Loading preview…`; `Updating preview…` while the prior document remains; `No preview registered`; `Preview file is missing`; `Preview exceeds the 1 MiB limit`; `Preview file is not valid UTF-8`; `Preview unavailable`; `Reconnect to load preview`. Generic errors must not expose source paths. Ready means a verified document was delivered, not that its arbitrary JS ran without error; v1 has no child feedback channel.

## Sandboxed rendering feasibility

Self-contained srcDoc is feasible with no asset service: place the trusted doctype/head/CSP before all untrusted HTML, pass only the HTML text into the isolated document, and keep the sandbox exactly `allow-scripts`, with `referrerPolicy="no-referrer"` and a descriptive title. Do not grant same-origin, use `dangerouslySetInnerHTML` in the dashboard, pass tokens/paths, listen for frame messages, or offer a raw/open-in-new-tab HTML link. The [HTML Standard](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox) specifies opaque origin without allow-same-origin and the script exception supplied by allow-scripts. This supports interactive JS while withholding dashboard origin privileges.

The draft's restrictive CSP blocks ordinary fetch/script/style/resource destinations outside the permitted inline/data content. This is necessary because [srcDoc relative URLs use the embedding page's base URL](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#srcdoc). No Blob URL asset registry, service worker, auth cookie URL or parent-to-child asset RPC is needed for this v1. Relative imports, external fonts/libraries, sibling CSS/images, backend fetch, downloads/popups and persistent origin storage are compatibility limits. As the root contract already states, sandbox/CSP is not a blanket CPU or self-navigation isolation guarantee; P3 owns the final security policy and negative cases.

## Suggested implementation ownership

| Owner responsibility | Exact files / work |
|---|---|
| Shared protocol owner before dependent writers | `bridge/src/preview-protocol.ts`; public Session/wire fields; `ui/src/types.ts` imports/command additions; freeze names/unions/constants centrally |
| UI behavior/data worker | new `ui/src/hooks/useSessionPreview.ts` + tests; optional pure `ui/src/lib/session-preview.ts` parser/assembler + tests; preview descriptor row validation in `useSessions.ts` + focused merge/clear tests |
| UI layout/render worker (same worker is simplest) | `Dashboard.tsx`, new `SessionPreviewPane.tsx` / optional `SessionWorkspace.tsx`, narrow globals.css additions, pure ratio helper/tests if needed. Terminal should need no change beyond a concrete refit defect |
| Root-owned runtime/test execution | one focused `e2e/tests/session-preview.spec.ts`, reusing real encrypted fixture helpers; no worker starts services or E2E |

The two UI ownership rows may be one bounded worker to avoid sharing Dashboard/state files. If split, freeze the hook/pane props first and assign one owner to Dashboard, useSessions, globals.css and shared type files. New pane/assembly names above are proposals, not claims that those files exist.

## Focused acceptance and fixture plan

Reuse `e2e/helpers/fixtures.ts:1–9` so test-created approvals are cleaned up; `app.ts` login/sharedEmail/waitForBridgeOnline; `bridge-api.ts:89–103` for encrypted business requests; and the actual CLI invocation pattern in `session-tools.spec.ts:16–24`. That spec already supplies desktop 1280×900 and touch mobile 390×844 cases (`:128–144`) and records screenshots (`:155–159`). Create HTML under an owned shell session's actual working directory in the scratch bridge HOME, register through the real installed CLI, and remove only task-owned sessions/files in finally. Root must validate actual homes/selectors before running.

- Desktop: terminal-left/preview-right geometry, initial ratio, pointer and keyboard resize, minimum widths, compact fallback after sidebar/viewport reduction; run a real terminal marker before/after opening to prove xterm transport survives. Capture a rendered screenshot.
- Mobile: Workspace → selected session → Terminal/Preview tabs, 44px controls, no horizontal page overflow, no visible desktop handle, real terminal keyboard/controls restored after tab switch. Capture a rendered screenshot.
- Document: inline button increments an iframe counter and data image displays. Atomic replace changes visible version and resets counter; unchanged polls preserve counter. Same-size edits must refresh. Chunk-boundary Unicode, empty file and a near-1MiB file exercise complete revision assembly.
- Lifecycle: Close stays closed across edits, reopen reads latest; registering again opens once; session A/B never cross; missing file hides old frame and recreation recovers; CLI clear removes preview; finished session retains it; restart retains registration; removal cannot resurrect an in-flight frame.
- Security/transport: cloud and LocalBrowserClient retrieval through real approval/encryption; revoked/unapproved device cannot read; inspect broker frames for absence of plaintext HTML; crafted head/base/meta/script cannot disable earliest CSP; parent DOM/storage access and ordinary fetch/img/script egress are blocked. Explicitly test the known unsupported external/relative resource behavior rather than silently fetching them.

Unit commands from package scripts: from ui, `npm test -- --run <new-test-paths>` and `npm exec tsc -- --noEmit`; build `npm run build` with root-provided synthetic build configuration. Root focused runtime command from e2e: `npx playwright test tests/session-preview.spec.ts --project chromium`; broader CI follows repository gates. No commands above were executed during discovery.

Open small contract choice: define whether manual Refresh remounts even an unchanged document (recommended for a control labeled Refresh) or only checks for updated bytes. All other UI questions above are resolved by the draft plus root's main-width clarification. Report write lease released.
