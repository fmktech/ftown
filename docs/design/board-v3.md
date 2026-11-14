# Board v3 — design note

Mock: `.ftown-previews/board-v3.html` (self-contained, no network, light + dark, phone-safe).
Tabs: **live** (real `ftown board --json --all` + `ftown events --since 0` snapshot: 4 children,
44 events) and **all states (sample)** — invented data, because the real tree has no failed /
blocked / question / PR / worktree / planned rows right now.

Answer to "very heavy, lacks minimalism, details should be hidden": v2 printed every fact about
every child all the time (fact line, next line, segmented bar, boxed lane, timeline column). v3
prints one line per child and nothing else. The default sample view is 8 rows and 4 folded group
lines; the live view is 2 rows and 3 folded lines.

## Shown by default

1. **Manager line** — `ftown_1  ◷ waiting review · <headline>`: name + the italic mono coloured
   status line, same shape as the hook activity line. No rollup, no bar (group labels carry counts).
2. **needs attention · n** — only rendered when non-empty. Rows that are failed, blocked, or carry a
   question escalated to the human. Same one-line row as everything else; the only differences are
   bolder name, primary-coloured headline, and an always-visible owner on the right: `you` in amber
   or the manager's name in grey. `you` rows sort first. This group label and the `you` tag are the
   single accent on the page. Rows listed here do not repeat lower down.
3. **active · n** — `glyph · name · headline`, order: waiting review → working (newest first) → no card.
   A stale working row only loses its glyph colour (grey `▸`); nothing else is printed.
4. Four folded group lines, each one faint mono line with a short peek:
   - `▸ planned · 4  next: timeline-hook` — **the future todo list**. Sits between active and done so
     the page reads now → next → finished. Expanded: numbered rows in precedence order
     (`1 name headline`); expanding a planned row shows `after <names>` or `ready to start`.
   - `▸ done · 3  final-verify, flake-fix, chip-placement`
   - `▸ events · 44  last 23:51 <name> <summary>`
   - `▸ brief  updated 12m ago` (only when a brief exists)

## Hidden until asked for

- **Row expand** (click, Enter/Space, or the `details` toggle / `d` for every row): a key/value block
  under the row, mono 11px, only the keys that have a value — `state` (label, progress, updated age,
  stale), `blocked`, `question` (title, routing, escalation note, options), `next`, `activity`
  (`⚙ using Bash`, `◌ thinking…`, `◦ idle 9m`, `■ session exited`), `pr` (number + checks), `worktree`
  (branch, dirty, ↑n, retained reason), `mail`, `preview`, `agent` (harness · model), `events` (that
  session's last 3). The headline un-truncates when the row is open.
- **Age** — right-aligned, appears on row hover/focus and when open; never shown at rest.
- **Events** — folded. Open: newest first, 12 lines, `HH:MM` once per minute, identical repeats as
  `×2`, `A | B | C` results cut to the first segment; click a line to unwrap it; `show n older`.
- Keyboard: `j`/`k` or arrows move, `enter` expands, `d` details for all, `e` events, `esc` collapses.

## Tokens

Existing dashboard tokens only; no backgrounds, borders, pills or bars anywhere. Row hover is a
3.5% wash.

| Use | Token |
|---|---|
| name | `--text-primary` (500; 600 in needs attention) |
| headline | `--text-muted` (`--text-primary` in needs attention) |
| labels, age, detail keys, done rows | `--text-faint` |
| detail values | `--text-secondary` |
| the one accent: `needs attention` label, `you`, `?` | `--status-pending` |
| glyphs `▸` working / `⚠` blocked / `◷` review / `✓` done / `✗` failed / `○` no card | `--accent` / `--status-pending` / `--shell-generic` / `--text-muted` / `--status-error` / `--text-faint` |
| PR merged (detail only) | `--pr-merged` |

Type: sans 13px for name + headline, `--font-mono` 11px for labels and details, 12px italic mono for
the manager line. Spacing: 28px between groups, 36px under the manager line, rows 5px vertical
padding, column max-width 760px. In the mock `--text-muted` / `--text-faint` are darker than the
dashboard's (`#8585a3`, `#5c5c78`) so three grey steps are distinguishable; faint is used for
non-essential text only. The light palette is mine (the dashboard has no light theme).

## Changes needed in `SessionOverview.tsx`

1. Replace the `<table>` with three pieces: `OverviewRow` (one button line + collapsible detail
   block, `aria-expanded`), `OverviewFold` (label button + peek + body), and a pure
   `partitionChildren(children, attention)` → `{ attention, active, done }`.
2. Local state only: `openRows: Set<sessionId>`, `allOpen: boolean`, `openFolds`. No new data is
   needed for the default view — name, `card.state`, `card.headline` are already on `Session`.
3. Export `CHIP_ICONS` / `CHIP_COLORS` from `SessionCardChip.tsx` (or a `cardStateStyle(state)`
   helper) and reuse them for the row glyph; the manager line is `<SessionCardChip card={session.card} />`
   as is. Drop the compact chip cell and `formatCardRollup` from this view.
4. Needs-attention derivation: `card.state === 'failed'`, `card.state === 'blocked'`, or
   `openAttentionBySession[id].open - withParent > 0`. Owner = `you` when the question is
   human-routed or `blockedOn.kind === 'human'`, else the parent's name.
5. Detail block from what the component already receives (`activityBySession`,
   `openAttentionBySession`, `child.pullRequestUrl` + PR status hook, `child.worktree`, previews,
   shell/model). Question title/note/options need a new optional prop
   `attentionItems?: ReadonlyArray<{ sessionId; event: AttentionItem }>`; without it show the count.
   `stale` is not on the wire card: derive `now - card.updatedAt > CARD_STALE_MS` for `working`.
6. Events fold needs `events?: ReadonlyArray<TreeEvent>` (hook over `COORDINATION_ROUTES.events`).
   Until it exists, omit the fold; nothing else depends on it. The per-row `events` key is the same
   list filtered by session.
7. Planned fold needs a contract that does not exist yet: `planned?: ReadonlyArray<{ id; title;
   headline?; after: string[] }>` in precedence order. Render the fold only when the prop is passed.
8. Brief: keep the sandboxed iframe, inside a fold closed by default. Remove the Notes section
   (notes become `✎` events).
9. Tests: `SessionOverview.test.tsx` table-cell assertions get rewritten around rows, the attention
   group (present / absent), fold toggles, and expand.

## Open questions

- Blocked on another session (owner = manager) is listed under needs attention in grey. If only
  human-owned items should be loud, those rows move to the top of `active` instead.
- `done` is always folded. Alternative: keep it open while it has 3 or fewer rows.
