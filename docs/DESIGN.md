# Dashboard design

How the React dashboard (`src/dashboard`) looks and moves. Read this before you build or restyle a screen. The tokens
live in `src/dashboard/styles.css` and `tailwind.config.js`; the components in `src/dashboard/components/ui/`
(import them from `components/ui`).

The look is quiet: dark is the main theme, light is equally finished, and depth comes from hairlines and small lifts
rather than color. A screen earns attention with its numbers. Brand mint appears only where FounderData itself speaks
(the logo, sign-in, live moments).

## Color

Use the Tailwind names below. Each reads a CSS variable, so one class works in both themes; never write a hex value or
a `dark:` color variant for anything these cover.

| Role | Class | Notes |
|---|---|---|
| Page | `bg-paper` | The bottom layer. A faint navy wash sits at the top of every page (`--backdrop`). |
| Card | `bg-white` | In dark this is near-black. `.card` sets it with its border and shadow. |
| Inset, hover | `bg-stone-50` | Row hover, a well inside a card. |
| Raised control | `bg-stone-100` | Active tab chip, segmented thumb, menu item hover. |
| Hairline | `border-stone-200/80` or plain `border` | Card edges and dividers. `border-stone-200/60` inside a card. |
| Text | `text-ink` | Headings, numbers, labels that matter. |
| Secondary text | `text-stone-500` | Descriptions, column headers. |
| Muted text | `text-stone-400` | The lightest shade that may carry text (AA 4.5:1 on card and page in both themes). |
| Decoration | `text-stone-300`, `bg-stone-300` | Dashes for "not measured", off dots. Never text a person must read. |
| On a fill | `text-onFill` | Text on a solid coral, blue or mint fill (live pills, heatmap cells). Dark in both themes: white on these fills is 3:1 or less. |
| Visitors | `visitors`, `visitorsSoft` | Blue. Every visitor, session or traffic series. |
| Revenue | `revenue`, `revenueSoft` | Coral. Every money series. |
| Brand | `brand`, `brand-text`, `brand-soft`, `brand-navy` | Mint and navy from the logo. `brand-text` for mint text (AA), `brand` for dots and glows. |
| Status | `emerald-*`, `amber-*`, `red-*`, `sky-*` | Good, warning, bad, info. `-50` chip background, `-700` chip text. |
| Focus | `focus` | The ring color. Global `:focus-visible` already draws it. |

Blue and coral are data colors and mean the same thing on every screen. A third series takes `stone-400` or a chart
note color (`--note-*`), never brand mint. Brand mint never draws data, with one exception.

**The live globe may draw live visitors in brand mint.** `components/live/GlobeView.tsx` and its flat map fallback
draw each person online now as a mint glow, and the places of the window picked on the live page (30 min, 1 h, 24 h)
as a dimmer mint glow. Trials, signups and the primary goal of the last hour are mint dots; payments stay coral. The
land grid is gray and draws no data. Mint is the color of the `live` status chip, so the globe uses it for people
online now. No other chart, map or table takes mint for data.

## Type

Inter Variable, self-hosted (latin subset, `font-display: swap`, a metric-matched Arial fallback so the swap moves
nothing). Figures are tabular everywhere; add `normal-nums` to prose where tabular hyphens or digits look spaced out.

| Use | Class |
|---|---|
| Page title | `text-display` (28/34, 600, tight) |
| Card or section title | `text-title` (17/24, 600) |
| Headline number | `text-stat` (26/32, 600, tight) |
| Body | `text-sm` (14) |
| Controls, table cells | `text-[13px]` |
| Fine print, axis labels | `text-xs` (12), `text-[11px]` |
| Group labels | `text-micro uppercase text-stone-400` |

Sentence case everywhere. One weight step between a label and its value: `font-medium` label, `font-semibold` number.

## Icons and avatars

No emoji anywhere in the dashboard. They render differently on each OS and ignore the theme. Channels, devices,
browsers and platforms without a favicon use `Glyph` from `components/Icons.tsx`: 24-unit paths, a 1.75 stroke, in the
text color. A visitor's avatar (`Avatar`, or `AvatarMark` inside an SVG chart) shows the person's initials when the
site named them, or a 5 by 5 pattern from the visitor id, in a stone tone. Country flags are the one exception: a flag
names a country, so it stays, and an unknown country shows the globe glyph. `test/dashboard-ia.test.ts` fails on an
emoji in `src/dashboard`.

## Space, radius, elevation

- Spacing follows Tailwind's 4 px scale. Cards pad `p-5` (20) or `p-3` for a breakdown list; gaps between cards are `gap-4`.
- Radii: card `rounded-2xl` (16), control `rounded-[10px]`, chip inside a control `rounded-[7px]` or `rounded-lg`, pill `rounded-full`.
- Elevation, lowest first: `shadow-card` (resting card, button), `shadow-raised` (hover lift, `.card-hover`),
  `shadow-pop` (menus, tooltips, `.pop`), `shadow-overlay` (dialogs). In dark each level is a lit top edge plus a
  darker drop. Do not stack two levels on one element.

## Motion

Fast, and only where it explains a change. Animate `transform` and `opacity` only, so the browser composites them.

| Token | Value | For |
|---|---|---|
| `duration-fast`, `--dur-fast` | 120 ms | Hover, press, color changes |
| `duration-base`, `--dur-base` | 180 ms | Menus, fades, tooltips |
| `duration-slow`, `--dur-slow` | 240 ms | Entrances, sliding thumbs, theme crossfade |
| `duration-slower`, `--dur-slower` | 320 ms | Dialogs, number ticks, bar growth, chart draw-in |
| `ease-out`, `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | Default for everything that arrives |
| `ease-spring`, `--ease-spring` | `cubic-bezier(0.34, 1.36, 0.64, 1)` | Dialogs and toasts, a slight overshoot |
| `ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Loops (shimmer, the sign-in glow) |

Rules:

- Entrances play once, on first mount. Data refreshes do not replay them; numbers tick and bars glide instead.
- Exits are instant. A closing menu or dialog disappears; nobody waits for it.
- Nothing blocks input while it animates.
- `prefers-reduced-motion` collapses every animation and transition to its end state (a rule in `styles.css`). In
  JavaScript, check `prefersReducedMotion()` before you start one.
- Two sanctioned exceptions to transform-only: the sliding thumb of `Tabs` and `Segmented` animates its width (one
  small absolutely placed element), and Recharts animates the series shape on draw-in (`chartAnim()`).

Ready-made animations: `animate-rise`, `animate-fade`, `animate-pop-in`, `animate-dialog-in`, `animate-spin`,
`animate-shake`, and the classes `.fd-reveal`, `.fd-stagger`, `.pop-in`.

## Charts

Every Recharts chart uses the helpers in `components/ui/chart.tsx`, so all charts share one look:

```tsx
import { chartDefs, chartGrid, chartXAxis, chartYAxis, chartTooltip, chartAnim, chartLine, ChartTooltip, SERIES } from '../components/ui';

<ComposedChart data={rows}>
  {chartDefs()}
  <CartesianGrid {...chartGrid} />
  <XAxis dataKey="day" {...chartXAxis} />
  <YAxis {...chartYAxis} />
  <Tooltip {...chartTooltip} content={({ active, payload, label }) => active && payload?.length ? (
    <ChartTooltip title={label} rows={[{ label: 'Visitors', value: fmtNumber(payload[0].payload.v), color: SERIES.visitors }]} />
  ) : null} />
  <Area dataKey="v" type="monotone" fill="url(#fd-visitors)" {...chartLine(SERIES.visitors)} {...chartAnim()} />
  <Bar dataKey="r" fill="url(#fd-revenue-bar)" radius={[4, 4, 0, 0]} {...chartAnim()} />
</ComposedChart>
```

- Horizontal hairline grid only, no axis lines, 11 px muted ticks.
- Lines 2 px with a soft gradient area under them (`fd-visitors`, `fd-revenue`). Bars round their top corners 4 px.
- One tooltip style (`ChartTooltip`): a muted title, rows with a square swatch and right-aligned tabular values.
- Call `chartDefs()` as a function inside the chart; Recharts drops unknown components.
- Inline SVG charts take the same CSS variables: `--chart-grid`, `--chart-axis`, `--chart-cursor`, `--chart-dot-ring`.

## Loading, empty, error

- **Loading.** Show the shape of what is coming: `SkeletonTile`, `SkeletonChart`, `SkeletonRows`, `SkeletonText`, sized
  like the real content so nothing jumps. When old data is on screen and new data loads, keep the old data and dim it
  to `opacity-60`. No spinners for page content; `Spinner` is for a button that is working.
- **Empty.** `EmptyState`: say what is missing, then the one next step. "No visits in this period", "Connect Search
  Console to see queries". Never a bare 0 standing in for "not measured"; show a `–` in `text-stone-300` with a title.
- **Error.** Next to its cause, in `text-red-600`, with the server's message. Forms use `FormError` (from
  `ui/AuthShell`) and mark the field `aria-invalid`. A toast is for the result of an action, never for a lasting problem.

## States every control has

Hover, active (press scales to 0.97 on buttons), `focus-visible` (the global ring), disabled (`opacity-50`, no pointer
events), and where it applies loading (`Spinner` plus a verb: "Saving") and error. The base classes `.btn`, `.btn-dark`,
`.btn-ghost`, `.input`, `.tab`, `.seg` already carry all of them; add only what is specific to your control.

## Do and don't

- Do reuse `.card`, `.btn`, `.btn-dark`, `.btn-ghost`, `.input`, `.label`, `.tabs`, `.tab`, `.seg`, `.pop`, `.kbd`,
  `.code` and the `ui/` components before writing a new style.
- Do keep blue for visitors and coral for money on every screen, including tooltips and legends.
- Do put a page's header in `StickyBar`.
- Do use `NumberTicker` for a headline number that changes with the period, and plain text for numbers in tables.
- Keep glow for brand moments (sign-in, live). Data cards stay flat.
- Write copy in sentence case, one idea per sentence, numbers over adjectives, no em dashes.

## Components

All in `src/dashboard/components/ui/`, exported from `components/ui/index.ts`.

**Skeleton** `Skeleton`, `SkeletonText`, `SkeletonTile`, `SkeletonChart`, `SkeletonRows`. Each group announces
"Loading" once.

```tsx
{data ? <Chart data={data} /> : <SkeletonChart height={240} />}
```

**NumberTicker** counts to each new value in 320 ms, holds the wider of the old and new widths, skips the first paint and reduced motion.

```tsx
<NumberTicker value={overview.visitors} format={fmtNumber} className="text-stat" />
```

**Reveal, Stagger** first-mount entrance. `Stagger` (or the class `fd-stagger`) staggers direct children 35 ms apart without wrapping them.

```tsx
<Stagger className="grid gap-4 lg:grid-cols-3">{cards}</Stagger>
<Reveal delay={60} className="card p-5">...</Reveal>
```

**Sparkline** a small line with a soft fill and a dot on the last value; nulls are gaps.

```tsx
<Sparkline values={weeks} tone="revenue" height={28} label="Revenue, last 8 weeks" />
```

**StatTile** label, ticking value, change badge, optional sparkline and loading state. `value={null}` shows a dash.

```tsx
<StatTile label="Visitors" tone="visitors" value={o?.visitors} format={fmtNumber} change={o?.change.visitors} spark={series} loading={loading} />
```

**ChangeBadge** arrow and percent against the period before. `change` is a fraction; `invert` where lower is better.

```tsx
<ChangeBadge change={0.32} />  <ChangeBadge change={-0.04} invert />
```

**StatusChip** a state in a word or two: `ok`, `warn`, `error`, `info`, `neutral`, `live` (pulses in mint).

```tsx
<StatusChip tone="ok">Connected</StatusChip>
```

**Segmented, SegTrack** a choice that switches a whole view, with a sliding thumb. `SegTrack` wraps your own buttons (any child with `aria-pressed`).

```tsx
<Segmented label="Platform" options={[{ value: 'web', label: 'Web' }, { value: 'app', label: 'App' }]} value={p} onChange={setP} />
```

**Tabs, TabRow** tabs inside a card with a sliding chip and arrow-key movement. `TabRow` wraps your own `.tab` buttons.

```tsx
<Tabs label="Breakdown" items={[{ value: 'channel', label: 'Channel' }, { value: 'referrer', label: 'Referrer' }]} value={t} onChange={setT} />
```

**Tooltip** a word or a line on hover (350 ms) or focus. One child element that takes a ref. Fine print goes in `InfoTip`.

```tsx
<Tooltip content="Visitors in the last 5 minutes"><button className="btn-ghost">...</button></Tooltip>
```

**EmptyState** what is missing and the next step; `compact` inside a card. Icons in `EmptyIcons`.

```tsx
<EmptyState compact icon={EmptyIcons.chart} title="No visits in this period" />
```

**toast** a 4 second confirmation at the bottom. It mounts itself; call it from anywhere.

```tsx
toast('Copied the summary', 'ok');
```

**LiveDot** a pulsing dot for something live; `on={false}` is a still gray dot.

```tsx
<LiveDot on={online > 0} />
```

**Spinner** for a busy button. **StickyBar** a page header that stays on top with a translucent backing and a hairline after scrolling (in the flow on phones).

```tsx
<button className="btn-dark" disabled={busy}>{busy ? <><Spinner /> Saving</> : 'Save'}</button>
<StickyBar><div className="flex items-center gap-2">...</div></StickyBar>
```

**AuthShell, FormError** the frame of the screens before sign-in (`pages/Login.tsx`, `pages/Join.tsx`).

**Charts** `chartDefs`, `chartGrid`, `chartXAxis`, `chartYAxis`, `chartTooltip`, `chartLineCursor`, `chartAnim`, `chartLine`, `ChartTooltip`, `SERIES`: see Charts above.

**Motion helpers** `prefersReducedMotion`, `useReducedMotion`, `useIndicator`, `DUR`, `EASE_OUT`, `EASE_SPRING`.

Shared components outside `ui/` follow the same rules: `Modal` (springs in, traps focus, returns it), `InfoTip`
(fine print), `CommandPalette` (⌘K), `ThemeToggle` (crossfades the theme through a view transition), `LogoMark`
(`animated` draws the trail in), `Panel` (breakdown rows whose bars grow by transform).
