# Design System — getbeyond ai

Source of truth for visual + interaction decisions. Codified 2026-06-02 by
`/design-consultation`. Most of this system already existed in code
(`apps/web/src/app/globals.css`, `tailwind.config.ts`); this file makes it
explicit and adds the **motion** and **stepper-spacing** tokens the Prospects
workspace redesign needs (see `docs/plans/prospects-ux-plan.md`).

## Product Context
- **What this is:** Open-source AI GTM teammates (Researcher + SDR Drafter) for
  solo founders. Research → draft → approve → send, every claim cited.
- **Who it's for:** Solo founders / very small GTM teams who can't afford a
  weeks-long RevOps setup.
- **Space/industry:** AI GTM / sales tooling, a category in trust collapse.
- **Project type:** **APP UI** (a workspace), with a thin marketing surface.
  App UI rules govern: calm surface hierarchy, minimal chrome, cards only when
  the card is the interaction.

## Aesthetic Direction
- **Direction:** Industrial / utilitarian — precise, engineered, trust-forward.
  The interface should read as *auditable software*, not a marketing funnel.
- **Decoration level:** Minimal. Typography, spacing, and a single neutral
  surface system do the work. No gradients, no decorative blobs, no
  icons-in-colored-circles.
- **Mood:** Quiet confidence. The product earns trust at the pixel level — every
  element is legible, sourced, and intentional. Nothing shouts.
- **Memorable thing:** "This is serious, auditable software — I can see exactly
  what it did and why." Every decision serves that.

## Typography
- **Display/Hero:** Geist Sans (`var(--font-geist-sans)`) — clean, neutral
  grotesque; carries headings without ornament.
- **Body:** Geist Sans — same family; hierarchy via size/weight, not typeface.
- **UI/Labels:** Geist Sans (uppercase tracking-wide for section eyebrows, as
  already used in the sidebar/headers).
- **Data/Tables/IDs:** Geist Mono (`var(--font-geist-mono)`) with `tabular-nums`
  for counts, costs, fit scores, durations, campaign/contact IDs.
- **Code:** Geist Mono.
- **Loading:** self-hosted via `next/font` (already wired in `layout.tsx`);
  fallbacks `system-ui`/`ui-monospace`.
- **Scale (Tailwind):** `text-xs` 12 · `text-sm` 14 (default body) · `text-base`
  16 · `text-lg` 18 · `text-2xl` 24 (page H1) · `text-4xl`/`5xl` marketing hero.
  Body text never below 14px in dense UI, 16px+ in prose; contrast ≥ 4.5:1.

## Color
shadcn-style HSL custom properties in `globals.css` (`:root` light + dark). Do
not hardcode hex in components — use the token classes (`bg-card`,
`text-muted-foreground`, etc.).
- **Approach:** Restrained. Neutral zinc surfaces; color is rare and semantic.
- **Neutrals (light):** `--background` 0 0% 100% · `--foreground` 240 10% 3.9% ·
  `--card` 0 0% 100% · `--muted` 240 4.8% 95.9% · `--muted-foreground`
  240 3.8% 46.1% · `--border` 240 5.9% 90%.
- **Primary:** `--primary` 240 5.9% 10% (near-black) / inverts in dark.
- **Semantic:** `--destructive` 0 84.2% 60.2% (errors/failed). Success uses
  `emerald-600` (the existing ✓ / completed-badge convention); warning the
  amber `warning` badge variant. Keep success/error paired with a distinct icon
  shape (✓ / ⚠), never color alone — color-blind safety.
- **Dark mode:** full surface redesign in `:root` dark block (already present);
  reduced-saturation neutrals, same semantic hues.

## Spacing
- **Base unit:** 4px (Tailwind default scale).
- **Density:** Comfortable-but-dense — an audit tool shows a lot without feeling
  cramped.
- **Scale:** `1`(4) `2`(8) `3`(12) `4`(16) `6`(24) `8`(32) `12`(48) `16`(64).
- **Workspace metrics:** content container max ~3xl for lists; the Prospects
  workspace grid is `[1fr_20rem]` (rail = 20rem / 320px); rail panel padding 16
  (`p-4`); panel-to-panel gap 24 (`space-y-6`).

### Stepper spacing rhythm (Prospects progress panel)
- Phase rows: `space-y-3` (12px) between steps.
- Status icon: `h-3.5 w-3.5` (14px), aligned to the first text line (matches the
  existing `Loader2`/`Check`/`CircleAlert` rows).
- Nested live tool line: indented `ml-6` (24px) under its active step, `text-xs
  text-muted-foreground`.
- Counter footer: separated by a hairline `border-t` + `pt-3` (12px); mono,
  tabular-nums.
- "View activity log" disclosure: `text-xs`, muted, at panel base, `pt-3` above.

## Layout
- **Approach:** Hybrid — grid-disciplined for the app, a touch more open for the
  marketing surface.
- **App shell:** persistent top `AppNav` (12px-tall row, `h-12`), current section
  highlighted; workspace below.
- **Border radius:** `--radius: 0.5rem` base → `rounded-md` (6px) cards/rows,
  `rounded-lg` (8px) result cards, `rounded-xl` (12px) the composer, `rounded-full`
  badges/avatars.

## Motion
New as of 2026-06-02 (was undefined — only `animate-spin` + `transition-colors`
existed). Restrained, ≤200ms, ease-out. Define as CSS variables and reference
them; do not scatter raw ms.

- **Easing:** `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)` (entrances/appear) ·
  `--ease-in: cubic-bezier(0.4, 0, 1, 1)` (exits) · `--ease-move:
  cubic-bezier(0.4, 0, 0.2, 1)` (reflow/move).
- **Duration:** `--dur-micro: 100ms` (hover, color, `transition-colors`) ·
  `--dur-short: 160ms` (rail panel collapse/reorder, chip/derived-ICP appear,
  step state change) · `--dur-medium: 240ms` (mobile picker/activity-log sheet).
  Avoid > 250ms in-app.
- **Patterns:**
  - Rail reorder/collapse (§3.5 of the plan): cross-fade + small vertical slide,
    `--dur-short` / `--ease-out`. Never reflow the center column (rail is
    fixed-width); animate only the rail's internal panels.
  - Spinner: existing `animate-spin` (Tailwind) for in-flight tool/loaders.
  - Step status transitions (pending→active→done): opacity/color only,
    `--dur-short`.
- **Reduced motion (required):** under `@media (prefers-reduced-motion: reduce)`,
  all of the above collapse to instant state swaps (0ms) — opacity allowed, no
  translate/slide. Spinners may keep spinning (essential progress affordance) but
  prefer a static "working" indicator if feasible.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-02 | Codified existing system into DESIGN.md | First design source of truth; system already lived in `globals.css`/`tailwind.config.ts`. |
| 2026-06-02 | Added motion tokens (ease-out, micro/short/medium, reduced-motion) | Prospects redesign introduces rail reorder/collapse; motion was previously undefined. Restrained ≤200ms ease-out chosen to match the precise/auditable feel (D8). |
| 2026-06-02 | Added stepper spacing rhythm | The new progress stepper needed a canonical vertical rhythm to avoid per-component drift. |
