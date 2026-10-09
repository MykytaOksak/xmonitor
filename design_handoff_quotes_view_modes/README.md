# Handoff: Quotes view modes (One pair / All pairs / Parallel)

## Overview

Adds three interchangeable layouts to the **Quotes** view of XARB (cross-chain arbitrage
monitor), switched from a floating menu in the bottom-right corner:

1. **One pair** — the existing layout: one pair's full per-network quote table.
2. **All pairs** — a single scroll of every pair, each with its own pair header and an
   expandable per-network table.
3. **Parallel** — 2, 3 or 4 pair panes visible at once.

Nothing about the quote engine, providers or store shape changes. This is a presentation
layer addition to `src/components/QuotesView.tsx` plus a few new fields in
`src/state/store.ts`.

## About the design files

`Quotes View Modes.dc.html` (+ `support.js`, its runtime) is a **design reference created
in HTML** — a prototype showing the intended look and behavior with hardcoded fixtures. It
is not production code to copy. Recreate it inside the existing app: **React 18 + Vite +
TypeScript, inline styles, tokens from `src/theme.ts`, zustand store in
`src/state/store.ts`** — exactly the patterns `QuotesView.tsx` already uses.

Open it in a browser to interact with it. Keys `1` / `2` / `3` / `4` switch modes.

## Fidelity

**High-fidelity.** Every color, font size, padding and border in the prototype was lifted
from `src/theme.ts`, `src/components/QuotesView.tsx`, `src/components/ui.tsx`,
`src/components/Rail.tsx` and `src/styles.css`. Recreate it pixel-perfectly using the
existing `C`, `mono()`, `sans()`, `capsLabel()`, `NetLogo`, `StatusDot`, `NetChip`,
`UnitInput` helpers rather than new values. Anything in the prototype that duplicates an
existing token is there only because the prototype cannot import from the app.

---

## New state

Add to the app store (`src/state/store.ts`), persisted alongside the existing keys:

| Key | Type | Default | Notes |
|---|---|---|---|
| `quotesMode` | `'single' \| 'scroll' \| 'parallel'` | `'single'` | active view mode |
| `paneCount` | `2 \| 3 \| 4` | `3` | parallel pane count |
| `panePairs` | `string[]` | first N enabled pair ids | pair id per parallel pane |
| `viewMenuOpen` | `boolean` | `true` | floating menu expanded |
| `expandedPairs` | `Record<string, boolean>` | `{}` | All-pairs rows expanded |
| `scrollSettingsFor` | `string \| null` | `null` | which pair's settings drawer is open in All pairs |

The existing `sel`, `amounts`, `disabledPairs`, `disabledNets`, `threshold`,
`feedCollapsed`, `sortKey`, `sortDir` are reused unchanged.

**Opportunities feed:** `feedCollapsed` gains an "auto" behavior — collapsed to the 44px
rail while `quotesMode === 'parallel'`, docked at 360px in `single` and `scroll`, with the
existing manual collapse/expand still winning once the user touches it. In the prototype
this is a three-state local value (`'auto' | 'open' | 'rail'`); in the app, keep
`feedCollapsed` as the manual override and derive the default from the mode.

---

## Screen 1 — One pair (unchanged)

Current `QuotesView` layout, with one addition: **each network row shows a small green
`BUY` / `SELL` tag immediately after the network name** marking the legs of the best route
(`computeBest()` → `best.buyNet` / `best.sellNet`). The row itself is **not** tinted.

- Tag: `mono(8, 500)`, `letter-spacing: .06em`, `color: C.green`, `flex: none`, sits in the
  existing 9px-gap flex row after the name span.

Everything else — header bar, sync banners, pair settings drawer, sortable BUY/SELL
headers, `1.5fr 1fr 1fr 1.1fr .8fr` grid, 360px Opportunities feed — stays as it is today.

---

## Screen 2 — All pairs

A single vertical scroll. **The main header bar is not rendered in this mode** — it names
one specific pair, which would be misleading above a list of all of them. Each pair carries
its own header instead.

### Sticky column header

`display: grid`, same template as the pair headers below,
`padding: 9px 18px 9px 15px`, `border-bottom: 1px solid C.borderFaint`,
`background: C.surface` (#0B0B0B). Cells use `capsLabel()`:

`(empty, 12px)` · `PAIR` · `NOTIONAL` · `BEST BUY` · `BEST SELL` · `(empty)`

### Grid template (shared by header and pair rows)

```
grid-template-columns: 12px minmax(215px, 1.5fr) minmax(72px, .9fr)
                       minmax(96px, 1fr) minmax(96px, 1fr) minmax(228px, auto);
gap: 14px;
```

The 215px floor on the PAIR column fits the longest name + tag (`sUSDnr/USDnr
STAKE/UNSTAKE`). The name span is `min-width: 0; overflow: hidden` with
`text-overflow: ellipsis` on the name and `flex: none` on the tag badge, so the name
truncates and the badge never escapes its column.

### Pair header row (one per pair)

`padding: 12px 18px 12px 15px`, `background: C.header` (#0D0D0D),
`border-bottom: 1px solid C.border`, `border-left: 3px solid` (`C.green` when this pair is
`sel`, else transparent), `cursor: pointer`, hover `.hoverrow`.
Clicking anywhere on the row toggles expansion.

Cells, left to right:

1. **Caret** — `mono(9, 500)`; `▾` when expanded (`C.green`), `▸` when collapsed
   (`C.label`), `·` when the pair is disabled (disabled pairs don't expand).
2. **Pair** — 6×6px square status dot (`C.green` live / `C.red` has-error /
   `C.label` disabled) · pair name `sans(16, 600)`, `white-space: nowrap`, color `C.text`
   (`C.label` when disabled) · route tag badge (`CROSS`, `CEX/DEX`, `MINT/REDEEM`,
   `SAME-CHAIN`, `STAKE/UNSTAKE` — from `tagFor(best)` / the mint-redeem and stake-unstake
   overrides already in `QuotesView.tsx`): `mono(8.5, 500)`, `color: C.secondary`,
   `background: rgba(255,255,255,.05)`, `padding: 2px 5px`.
3. **Notional** — `fmtNotional(amount, pair.unit)`, `.tnum`, 14px.
4. **Best buy** — 15×15px `NetLogo` of `best.buyNet` + `fmtPrice(best.buy, pair.dp)`,
   `.tnum` 14px, 7px gap.
5. **Best sell** — same with `best.sellNet` / `best.sell`.
6. **Actions**, right-aligned, 14px gap:
   - `enabled` / `disabled` — `mono(11, 500)`, `color: C.secondary`, dashed underline,
     `text-underline-offset: 3px`. Calls `togglePair(id)`. **stopPropagation.**
   - `⚙ Pair settings` — same button as the main header: `padding: 6px 11px`,
     `mono(11, 500)`; idle `background: rgba(255,255,255,.04)`, `border: 1px solid
     C.borderMid`, `color: #bcbcbc`; active `C.greenBg14` / `C.greenBorder45` / `C.green`.
     Toggles that pair's inline drawer. **stopPropagation.**
   - `⤢` — 24×24px, `border: 1px solid rgba(255,255,255,.12)`, `color: C.secondary`.
     Sets `sel = pair.id` and `quotesMode = 'single'`. **stopPropagation.**

Spread and profit are deliberately **not** in this row — they live in the Opportunities
feed, which stays docked in this mode.

### Inline pair settings drawer (when ⚙ is active)

Identical content to the existing drawer, rendered directly under that pair's header:
`background: C.drawer` (#090909), `border-bottom: 1px solid C.border`,
`padding: 12px 18px 16px`, `display: flex; gap: 28px; align-items: flex-start`.

- Left, 220px fixed: label "Amount (trade size — priced at this volume)" (11px,
  `C.secondary`, 8px bottom margin) + the existing `<UnitInput prefix={pair.unit}>`.
- Right, flex 1: label "Networks enabled for this pair" + wrapped `NetChip`s
  (6px gap) with the existing `toggleNet(pairId, net)` behavior and the
  `mint/redeem` / `stake/unstake` suffixes.

Reuse the real components; the prototype fakes them as static spans.

### Expanded per-network table (when the row is expanded)

Exactly the One-pair table, full width: column header row (`NETWORK` `BUY` `SELL` `ROUTER`
`STATUS`, `capsLabel()`, `padding: 9px 18px`, `border-bottom: 1px solid C.borderFaint`)
then rows at `padding: 9px 18px`, `border-bottom: 1px solid C.dividerFaint`, grid
`1.5fr 1fr 1fr 1.1fr .8fr`, gap 14px — 16px `NetLogo`, name at 12.5px `C.chipText`, the
green `BUY`/`SELL` tag, prices `.tnum` 13px (`C.text` live / `C.label` otherwise), router
12px `C.secondary`, `StatusDot` + `LIVE`/`ERR`/`LOADING`/`SYNC` at `mono(9.5, 500)`.

Multiple pairs can be expanded simultaneously. Sorting inside an expanded table should use
the existing `sortKey` / `sortDir`.

---

## Screen 3 — Parallel

`flex: 1; min-height: 0; overflow: auto; display: grid` over the pane count:

| Panes | `grid-template-columns` | `grid-auto-rows` | Spans |
|---|---|---|---|
| 2 | `1fr 1fr` | `minmax(0, 1fr)` | — |
| 3 | `1fr 1fr` | `minmax(0, 1fr) minmax(0, 1fr)` | 3rd pane `grid-column: span 2` |
| 4 | `1fr 1fr` | `minmax(0, 1fr) minmax(0, 1fr)` | — |

So 3 panes = two on the top row, one full-width beneath.

The main header bar stays, showing `{paneCount} pairs · parallel` as the title and a
`MONITORED` stat (`{PAIRS.length} pairs · {opps.length} live opps`) in place of `NOTIONAL`.
The Opportunities feed collapses to its 44px rail.

### Pane

`display: flex; flex-direction: column; min-width: 0; min-height: 0`,
`background: C.surface`, `border-right` + `border-bottom: 1px solid C.border`.

1. **Pane header** — `padding: 10px 13px`, `background: C.header`,
   `border-bottom: 1px solid C.borderFaint`, 9px gap: 6×6px status square · pair name
   `sans(13, 600)` with a `▾` (opens the same pair dropdown as the main header, scoped to
   this pane → writes `panePairs[k]`) · spread `.tnum` 13px 600 right-aligned, colored
   `C.green` when `>= threshold`, `C.secondary` when `0 … threshold`, `C.red` when negative
   · `⚙` (opens that pane's pair settings) · `✕` (removes the pane, min 2).
2. **Notional strip** — `padding: 7px 13px`, `border-bottom: 1px solid C.dividerFaint`:
   `NOTIONAL` `capsLabel(9)` · `fmtNotional(...)` 11px `C.secondary` · profit
   `fmtProfit(...)` 11px right-aligned in the spread color.
3. **Compressed table** — grid `1.4fr 1fr 1fr`, `gap: 8px`, `padding: 8px 13px`. Header
   labels `NETWORK` `BUY` `SELL` at `capsLabel(9)`. Rows: 13px `NetLogo`, name 11.5px
   `C.chipText` (ellipsized), green `BUY`/`SELL` tag, prices `.tnum` 12px.
   ROUTER and STATUS are dropped for width — status is carried by the price color
   (`C.label` = not live) and the pane header dot. Rows scroll inside the pane.

---

## Floating view-mode menu

Fixed to the bottom-right of the Quotes view: `position: absolute; right: 18px;
bottom: 18px; z-index: 60`, `display: flex; flex-direction: column;
align-items: flex-end; gap: 8px`. It floats over content by design.

### Collapsed trigger (always visible)

`padding: 9px 12px`, `background: C.dropdown` (#111), `border: 1px solid` —
`C.greenBorder45` when the panel is open, `rgba(255,255,255,.14)` when closed —
`box-shadow: 0 10px 30px rgba(0,0,0,.6)`, 9px gap:

- **Mode glyph**, 16×12px, `border: 1px solid C.green`, `padding: 1px`, `gap: 1.5px`,
  `display: grid` with as many columns as the mode implies: 1 cell for One pair,
  3 stacked-looking cells for All pairs, `min(paneCount, 3)` cells for Parallel; cell
  opacities step down `.9, .7, .5`.
- **Label** — `mono(10, 500)`, `letter-spacing: .1em`, `color: C.chipText`:
  `ONE PAIR` / `ALL PAIRS` / `PARALLEL ×{n}`.
- **Caret** — 9px `C.label`: `▾` when open, `▴` when closed.

### Expanded panel (246px wide, opens upward)

`background: C.dropdown`, `border: 1px solid rgba(255,255,255,.14)`,
`box-shadow: 0 18px 50px rgba(0,0,0,.7)`.

- **Title row** — `padding: 8px 11px`, `border-bottom: 1px solid C.borderFaint`:
  `VIEW MODE` left, `⌥ 1–3` right, both `mono(9, 500)`, `color: C.label`.
- **Three mode rows** — `padding: 10px 11px`, `border-bottom: 1px solid C.divider`,
  10px gap, hover `rgba(255,255,255,.05)`, active row `background: C.greenBg08`:
  - 20×14px wireframe glyph, `border: 1px solid` (`C.green` active / `C.body` idle),
    inner cells at stepped opacity — 3 stacked rows for **ONE PAIR**, 4 tighter rows for
    **ALL PAIRS**, 2 columns for **PARALLEL**.
  - Title `mono(11, 500)`, `letter-spacing: .06em` — `C.green` active, `C.chipText` idle.
  - Subtitle `sans(10)`, `C.label`: "Full network table" / "One scroll, best route each" /
    "Watch {paneCount} pairs at once".
  - Shortcut digit right-aligned, `mono(9, 500)`, `C.label`.
- **Pane-count segment** — under the PARALLEL row, sharing its background,
  `padding: 0 11px 10px 41px` (indented to align with the label), 6px gap. Three equal
  buttons `2` `3` `4`, `padding: 5px 0`, `mono(10, 500)`, styled with the existing `seg()`
  helper from `theme.ts`. Picking one also switches the mode to parallel.

### Keyboard

`1` One pair · `2` All pairs · `3` Parallel · `4` Parallel ×4. Ignore the event when the
target is an `input` or `textarea`.

---

## Interactions summary

| Action | Result |
|---|---|
| Click trigger | toggle `viewMenuOpen` |
| Click a mode row | set `quotesMode` |
| Click `2`/`3`/`4` | `quotesMode = 'parallel'`, `paneCount = n` |
| Keys `1`–`4` | as above |
| All pairs: click pair row / caret | toggle `expandedPairs[id]` |
| All pairs: `enabled`/`disabled` | `togglePair(id)`, stopPropagation |
| All pairs: `⚙` | toggle `scrollSettingsFor`, stopPropagation |
| All pairs: `⤢` | `sel = id`, `quotesMode = 'single'`, stopPropagation |
| Parallel: pane `▾` | pick that pane's pair → `panePairs[k]` |
| Parallel: pane `✕` | `paneCount = max(2, paneCount - 1)` |
| Opportunities row click | `sel = id`, `quotesMode = 'single'` (existing behavior) |

No new animations or transitions. Mode changes are instant, matching the app's current
zero-transition feel.

## Responsive

The prototype is desktop-only. In the app, respect the existing `useIsNarrow()` /
`useIsPhone()`:

- **narrow** — Parallel should cap at 2 panes stacked vertically; All pairs drops the
  `NOTIONAL` column (`12px minmax(200px,1.5fr) minmax(96px,1fr) minmax(96px,1fr) auto`).
- **phone** — offer One pair and All pairs only; All pairs shows caret · pair · best buy ·
  best sell, and the expanded table drops ROUTER + STATUS as it already does. Move the
  floating menu to `right: 12px; bottom: 12px`.

## Design tokens

All from `src/theme.ts` — no new tokens. Used here: `page` `surface` `header` `panel`
`drawer` `dropdown` · `text` `chipText` `secondary` `body` `label` `navIdle` · `green`
`red` · `border` `borderFaint` `borderInput` `borderMid` `divider` `dividerFaint` ·
`greenBg06` `greenBg08` `greenBg14` `greenBorder40` `greenBorder45`.

Type: `IBM Plex Sans` for names and body, `IBM Plex Mono` for labels, numbers (`.tnum`,
tabular figures) and status. Sizes used: 8 / 8.5 / 9 / 9.5 / 10 / 11 / 11.5 / 12 / 12.5 /
13 / 14 / 15 / 16 / 17px. Zero border radius everywhere (`button { border-radius: 0 }`).
Spacing steps: 2 / 5 / 6 / 7 / 8 / 9 / 10 / 11 / 12 / 13 / 14 / 16 / 18 / 28px.

## Assets

None new. The rail logo is `src/components/Logo.tsx` (copied verbatim into the prototype),
network marks are the existing `NetLogo` monogram squares with `NETWORKS[id].color`. The
prototype's fixtures are drawn from `src/config/pairs.ts` and `src/config/networks.ts`;
replace them with the live store.

## Files

- `Quotes View Modes.dc.html` — the design reference. Open in a browser; keys 1–4 switch
  modes. Fixture data is at the top of the script block (`PAIRS`, `ROWS`, `N`).
- `support.js` — runtime for the reference file. Not part of the handoff to implement.

Files to change in the app:

- `src/components/QuotesView.tsx` — the three layouts + the floating menu.
- `src/state/store.ts` — the new persisted keys above.
- `src/components/ui.tsx` — optional: a `ViewModeMenu` and a `PairHeaderRow` if you want
  `QuotesView.tsx` to stay readable.
- `src/theme.ts`, `src/styles.css` — unchanged.
