# Prospects — UI/UX Plan

Status: draft, 2026-06-02. Owns the redesign of the "Campaign" workspace into a
three-zone **Prospects** workspace. Extends `../product-workflow-spec.md` §6
(app shell / IA). When this and the workflow spec disagree on product motion, the
workflow spec wins; this doc refines its app-shell section into a concrete screen.

Decisions locked with the user (2026-06-02):

- **Name:** "Campaign" → **Prospects** (nav section + the noun for one unit).
- **ICP model:** "Add ICP" attaches a **seed contact list** (your best /
  closed-won accounts); the system derives the ICP and finds lookalikes. Matches
  today's wins-list → derived-ICP model.

---

## 0. The core reframe

Today the workspace mixes three things in one center column
(`CampaignTranscript`): narration, live tool lines, and result cards — while the
right rail (`ConnectedToolsSidebar`) is a static, decorative list. This plan does
two structural things:

1. **Renames** the concept from "Campaign" (a blast metaphor the workflow spec
   explicitly rejects) to **Prospects** (people, not blasts).
2. **Splits the workspace into three zones** so each answers one question:
   - **Left** — *where am I?* (app nav)
   - **Center** — *what's the conversation?* (chatbox + result cards)
   - **Right rail** — *what's it working with, and what's it doing right now?*
     (ICP inputs **+** a real progress indicator)

The "what's happening" tool activity **moves out of the center transcript into a
dedicated progress panel** in the right rail. That is the heart of this redesign:
a clear, glanceable progress indicator instead of tool lines buried inline.

---

## 1. Layout — the three-zone workspace

```
┌──────────────────────────────────────────────────────────────────────────┐
│  getbeyond ai   Prospects · Contacts · Researcher · SDR Drafter · Drafts  ⌄│  ← AppNav (relabeled)
├───────────────────────────────────────────────┬──────────────────────────┤
│  ← All prospects                               │  RIGHT RAIL (sticky)      │
│                                                │                           │
│  "SaaS founders like my best accounts" ●running│  ┌ ICP ────────────────┐ │
│                                                │  │ + Add ICP            │ │
│  ┌─ chat / transcript ───────────────────────┐ │  │  ↳ Best Customers 24 │ │
│  │ You: Find more like my closed-won accounts │ │  │     ◍ ◍ ◍ +21        │ │
│  │ ↳ Derived your ICP from 24 wins            │ │  │  Derived ICP:        │ │
│  │ ↳ Sourcing lookalikes…                     │ │  │   [B2B SaaS][50–200] │ │
│  │                                            │ │  │   [RevOps buyer]     │ │
│  │ ┌ Acme Corp           82% fit ┐            │ │  └──────────────────────┘ │
│  │ │ rationale + cited claims¹ ² │            │ │                           │
│  │ └─────────────────────────────┘            │ │  ┌ Progress ───────────┐ │
│  │ ┌ Globex              74% fit ┐            │ │  │ ① Derive ICP    ✓    │ │
│  │ │ …                            │            │ │  │ ② Source         ✓    │ │
│  │ └─────────────────────────────┘            │ │  │ ③ Research ●  7/24    │ │
│  │                                            │ │  │    ⟳ Searching "Acme  │ │
│  │ [ Ask a follow-up / refine… ]              │ │  │      funding"…        │ │
│  └────────────────────────────────────────────┘ │  │ ④ Done           ·    │ │
│                                                │  │  ───────────────────  │ │
│                                                │  │  7 qualified · 4¢ · 38s│ │
│                                                │  └──────────────────────┘ │
└───────────────────────────────────────────────┴──────────────────────────┘
```

- Grid widens from today's `[1fr_18rem]` to **`[1fr_20rem]`** (the rail now
  carries real content).
- Right rail is **sticky** (`lg:sticky lg:top-8`) so progress stays in view while
  the transcript scrolls.
- **Center column = the conversation**: your goal message, short agent narration
  lines, and the **qualified-prospect result cards**. Stays chat-shaped (composer
  at entry, follow-up box at the bottom).
- **Right rail = the machine view**: ICP inputs on top, live progress below.

---

## 2. Right rail — Panel A: ICP (seed contact list)

The single, prominent affordance. One clear level: **+ Add ICP**.

| State | What shows |
|---|---|
| **Empty** | A dashed `+ Add ICP` button + one-line hint: *"Pick a list of your best customers — we'll find lookalikes."* This is the rail's hero when a run starts. |
| **Picking** | Opens a contact-list picker (reuse the `SourcePicker` pattern — lists are picked, never pasted). Lists come from `/contacts`. Inline "Import CSV →" escape hatch if they have none. |
| **Attached** | A list card: **list name + count** ("Best Customers · 24"), a row of 3–4 contact avatars/initials + "+21", and a **× remove / replace** control. |
| **Deriving** | Below the list: *"Deriving ICP…"* skeleton chips. |
| **Derived** | The derived ICP as **keyword chips** (`B2B SaaS`, `50–200`, `RevOps buyer`) + the one-line summary — bound to the existing `icp_derived` event / `detail.icp`. |

This makes input→output legible in one place: **the contacts you gave it** (seed)
and **the ICP it inferred** (derived). The cite-or-abstain ethos applied to
targeting — you can see *why* it's looking for what it's looking for.

Below ICP, a secondary, smaller **Source / candidate pool** row (where lookalikes
are drawn from) — kept from today's sidebar but demoted, since the seed list is
now the headline.

---

## 3. Right rail — Panel B: Progress (the clear indicator)

Replaces the static `RUNTIME_TOOLS` list and absorbs the tool lines currently
inline in the transcript. A **vertical phase stepper with live tool activity
nested under the active step**.

Four phases (derived from the existing event stream — `icp_derived`,
`sourcing_started`/`sourcing_completed`, `candidate_qualified`, terminal):

```
① Derive ICP        ✓ done
② Source candidates  ✓ 24 found
③ Research & qualify  ● active   7 / 24
     ⟳ Searching "Acme funding"…
     ✓ Fetched acme.com/about · 280ms
④ Done                · pending
─────────────────────────────────
7 qualified · 4¢ · 38s            ← live counters footer
```

Design rules:

- Each phase row has a **state**: pending (·, muted) / active (● + spinner) / done
  (✓ green) / error (⚠ red). Reuse the icon vocabulary already in
  `CampaignTranscript` (`Loader2`, `Check`, `CircleAlert`).
- Under the **active** phase only, show the **last 1–3 live tool lines** — a
  started line collapses into its completed line in place (the existing
  `toolRowIndex` collapsing logic already does this; it just renders in the rail
  now). Older tool lines fold away so the panel stays glanceable, not a scrolling
  log.
- A **counter footer**: `N qualified · cost · elapsed`, always visible — the
  at-a-glance "is it working" signal.
- **Terminal state**: the active dot resolves to a success (`Sparkles` green) or
  failure (`CircleAlert` red) summary line, mirroring today's terminal row.
- Optional thin **progress bar** at the panel top driven by `qualified / total`
  once sourcing reports a total — concrete % movement, not just a spinner.
- A quiet **"View activity log (N steps)"** disclosure at the panel base
  (Pass 7 decision). The live view stays calm (last 1-3 lines); expanding shows
  the **complete, ordered tool history** — every search/fetch with args,
  duration, and cost — from the same event stream. This keeps the "audit every
  tool call" trust promise visible in the UI, not just readable in source. The
  expanded log is the canonical home for the full trail that the live tail and
  the `aria-hidden` tool lines (§6b) deliberately don't retain.

Why split it out of the center: a chat transcript scrolls; progress shouldn't.
Pinning the stepper in the sticky rail means "what's happening right now" is
always one glance away, while the center column stays a clean conversation of
results.

### Rail ordering across the run lifecycle

The two rail panels invert in importance as the run progresses, so the rail
**reorders by run state** rather than pinning a fixed order (Pass 1 decision):

| Phase | Top panel | Below |
|---|---|---|
| **Setup** (no run yet / draft) | **ICP** — expanded, the thing you act on. `+ Add ICP` is the rail hero. | Progress — hidden or a single muted "Not started" line. |
| **Running** | **Progress** — jumps to top, expanded, live stepper + counters. | ICP — collapses to a one-line summary chip ("Best Customers · 24 · B2B SaaS") that re-expands on click. |
| **Completed / failed** | Results dominate the center; both rail panels collapse to one-line summaries (ICP chip + "7 qualified · 4¢"). | — |

Reorder transitions are driven by `campaign.status` (draft → running →
completed/failed), so the rail never needs its own state machine — it reads the
status that already exists. The collapse animation must not reflow the center
column (rail is fixed-width); only the rail's internal panels move. Avoid moving
a panel out from under the cursor mid-edit: if the user is actively in the ICP
picker when the run starts, defer the collapse until the picker closes.

---

## 4. Center column — the conversation (slimmed)

`CampaignTranscript` → a **conversation transcript** that keeps:

- the **phase narration** lines (short: "Derived your ICP from 24 wins",
  "Sourcing lookalikes…") — context, not progress,
- the **result cards** (`CandidateCard` — name, fit score, cited claims)
  unchanged,
- a **terminal summary** line.

It **loses** the granular tool lines (`tool_activity` rows) — those now live in
the progress panel. The reducer (`buildCampaignTranscript`) splits into two
derivations off the same event array: `conversationRows` (center) and
`progressModel` (rail). One event stream, two views — keeps it DRY and
unit-testable.

A **follow-up composer** sits at the bottom of the center column (chat
convention) for refine/re-run, complementing the hero composer that started the
run.

---

## 4b. Interaction states — Progress panel & transcript

The ICP panel states live in §2. These cover the two streaming surfaces (Pass 2
decision). For each, what the user *sees* — not backend behavior.

| Surface | Loading / connecting | Empty | Stream drop (transient) | Error / failed | Partial | Complete |
|---|---|---|---|---|---|---|
| **Progress panel** | "Starting…" with phase ① pending; no fake steps. | Run created, no events yet: ① shown pending, rest muted. | Active step keeps last state + muted "⋯ Reconnecting…" hint (no red). Auto-retry. | After N failed retries: active step → ⚠, "Connection lost" + **Retry** button (re-opens stream + re-fetches detail). Run-level failure: terminal step red with message. | Counters reflect last known ("7 / 24"); stepper holds at active step. | All steps ✓; footer shows final "N qualified · cost · elapsed". |
| **Center transcript** | `Loader2` + "Connecting to the run…" (today's behavior, reworded). | Terminated with nothing: "No activity recorded for this run." | No banner in the transcript — the rail owns connection status; transcript just stops appending until events resume. | Terminal failure row (red), message inline. | Cards rendered so far stay; no spinner implying more unless still running. | Terminal success row + all cards. |

**Reconnect contract (drives the "transient" column):**

1. `useCampaignStream` already auto-retries the `EventSource`. Surface its
   `connectionState` as a typed UI state, not the raw string (kill the
   `stream: {connectionState}` debug label).
2. On `reconnecting`: show the muted hint on the active step only. Do **not**
   reset counters or clear the transcript.
3. On `reconnected`: re-fetch the persisted campaign detail (the page already
   does this on `terminated`; extend it to reconnect) so counters and any
   candidates that arrived during the gap catch up in one snapshot.
4. Escalate to the error state only after the retry budget is exhausted. The
   **Retry** action re-opens the stream and re-fetches; it never re-runs the
   campaign (that's the separate Re-run button).

---

## 5. Naming migration (design-level map)

| Today | Becomes |
|---|---|
| Nav label "Campaigns" | **Prospects** (home/primary surface) |
| `/campaigns`, `/campaigns/[id]`, `/campaigns/new` | `/prospects`, `/prospects/[id]`, `/prospects/new` |
| `CampaignComposer` | `ProspectComposer` — button "Start campaign →" → **"Find prospects →"** |
| `CampaignTranscript` | `ProspectTranscript` (conversation rows only) |
| `ConnectedToolsSidebar` | `ProspectRail` (= `IcpPanel` + `RunProgressPanel`) |
| Copy: "Your campaigns", "Start a campaign" | "Your prospects", "Describe who you want to reach" |
| List-row metric | "12 prospects · 2h" |
| `Megaphone` nav icon | swap to `Users`/`Target` (drop the blast metaphor) |

Per-unit noun in copy: a **prospect run** (*verb: "find prospects"*) that produces
**prospects**. Avoid the word "campaign" in user-facing strings entirely. Internal
types (`CampaignEvent`, `CampaignStatus`, API routes) rename in a separate
mechanical pass — this plan is UI/UX scope.

---

## 5b. First-run journey (no contacts, no runs)

The redesign must not recreate the setup-gate the workflow spec rejects
("nothing blocks the first win"). For a brand-new user the empty state is
**composer-first**, ICP as a post-result upgrade (Pass 3 decision), mapping
directly onto spec Beats 1→3:

| Step | User does | User feels | Screen supports it |
|---|---|---|---|
| 1 | Lands on Prospects, no contacts/runs | "What is this?" | Center hero = warm composer: *"Who do you want to reach?"* Rail ICP panel is present but **quiet/secondary** with a one-line hint, not the hero. No "attach a list to begin" dead end. |
| 2 | Types a goal, hits **Find** | "Let's see" | Run starts goal-only (today's `sourcing: null` path already allows this). Rail Progress takes over per §3.5. |
| 3 | Watches the stepper, first cited result lands | "Oh — it actually works, and it's sourced" | Cited result card + citation chips. The 60-second win. |
| 4 | Sees the sharpen nudge | "I can make this mine" | Once the first result lands, the ICP panel raises its hand: *"Add your best customers to sharpen this →"* — the single highest-leverage onboarding action (spec Beat 3). |
| 5 | Adds a seed list, re-runs | "Now it's tuned to me" | Derived-ICP chips appear; the before/after quality jump motivates the Brain investment by showing it. |

Key rule: the `+ Add ICP` affordance is **always available** in the rail, but it
is only the *visual hero* once the user has lists worth attaching or has seen a
first result. For the empty first run it is calm and secondary so the composer
owns the moment.

---

## 6. States & edge cases

- **First run, no ICP yet** — rail leads with the big `+ Add ICP`; center composer
  hint nudges. Run can still start goal-only (today's behavior preserved) —
  progress panel skips phase ① or shows "ICP from goal text."
- **No contacts at all** — ICP picker shows "Import CSV →" inline (links
  `/contacts/import`).
- **Reopened completed run** — no live stream: rail progress shows all phases ✓
  with final counters; center shows persisted cards (today's `PersistedCandidates`
  path).
- **Failed run** — phase ③/④ goes red with the error message; center terminal row
  red; **Re-run** button stays where it is today.
- **Mobile** (`< lg`) — rail moves below the chat. Progress collapses to a sticky
  top strip: `③ Research · 7/24 · 4¢` that expands on tap. ICP becomes a
  collapsible card above the transcript.

---

## 6b. Responsive & accessibility

**Responsive (per viewport, not just "stacked"):**

| Viewport | Layout |
|---|---|
| **Desktop ≥ lg** | Three-zone grid `[1fr_20rem]`; rail sticky, reorders per §3.5. |
| **Tablet (md)** | Rail narrows; if cramped, rail drops below center but the **Progress** panel hoists to a sticky strip under the nav while running. |
| **Mobile (< md)** | Single column. While running: a **sticky top strip** under the nav shows the compact active phase + counters (`③ Research · 7/24 · 4¢`), tappable to expand the full stepper in a sheet. ICP becomes a collapsed card above the transcript; `+ Add ICP` opens the picker as a full-screen sheet (not a cramped popover). Follow-up composer pins to the bottom. |

**Accessibility (Pass 6 decision + best-practice baseline):**

- **Live region:** the Progress panel wraps a single `aria-live="polite"`
  region that announces **milestones only** — phase transitions, a throttled
  running count, reconnect, and the terminal result. Rapid tool lines
  (search/fetch) are `aria-hidden` visual detail. Never `assertive` (it would
  interrupt the user mid-task).
- **Stepper semantics:** phases are an ordered list; the active step carries
  `aria-current="step"`; status conveyed by text/`aria-label` ("done",
  "in progress", "failed"), never color alone (color-blind safety — the
  emerald/red icons already pair with distinct shapes ✓/⚠).
- **Keyboard:** ICP picker is fully keyboard-operable (open, arrow/type-ahead
  through lists, Enter to attach, Esc to close, focus returns to `+ Add ICP`).
  Composer: Enter submits, Shift+Enter newline (already the convention).
  Rail collapse toggles are real buttons with `aria-expanded`.
- **Touch targets:** ≥ 44px on the mobile progress strip, picker rows, and
  collapse toggles.
- **Motion:** the §3.5 reorder/collapse animations and any spinners respect
  `prefers-reduced-motion` — reduce to instant state swaps, no sliding. (Also
  the standing motion spec absent a DESIGN.md — keep durations ≤ 200ms, ease-out.)
- **Contrast:** body text ≥ 16px and ≥ 4.5:1 (the existing `--muted-foreground`
  on `--card` already clears this; hold new secondary text to the same bar).

---

## 7. Build map (design-level — no code here)

New / changed components:

- `ProspectRail` (container, sticky, **reorders by `campaign.status`** per §3.5)
  → `IcpPanel` (Add-ICP + seed list + derived chips, collapsible) +
  `RunProgressPanel` (phase stepper + live tool tail + counter footer +
  **"View activity log" disclosure** + `aria-live` milestone region).
- `buildCampaignTranscript` → emits `{ conversationRows, progressModel, icp,
  activityLog }` from one event array (activityLog = full ordered tool history
  for the disclosure).
- `ProspectComposer`, `ProspectTranscript`, route + nav relabels.
- Reused as-is: `CandidateCard`, `CitationChip`, `SourcePicker` (for the ICP
  picker), the SSE `use-campaign-stream` hook.

---

## 8. Open questions (remaining after design review 2026-06-02)

1. **Progress bar denominator** — `sourcing_completed` gives a total; until it
   fires, phase ③ has no %. Spinner-only until total known, or estimate?
   (Lean: spinner until total known.)
2. **Seed list vs. candidate pool** — when both are set, the rail shows two list
   rows. Is that ever confusing enough to merge into one "Targeting" disclosure?
3. **Fit-brief scoring numeric vs qualitative** — inherited from
   `../product-workflow-spec.md` §8.4; affects the fit-score badge on cards.

*Resolved in the 2026-06-02 design review:* rail ordering (§3.5, reorder by
state), stream-drop UX (§4b, quiet reconnect), first-run hero (§5b,
composer-first), SR announcements (§6b, polite milestones-only), audit-trail home
(§3, expandable activity log).

*Out of design scope:* the internal type rename (`CampaignEvent`,
`CampaignStatus`, API routes) is a separate mechanical PR, not a UX decision.

---

## NOT in scope (considered, deferred)

- **Criteria-based ICP** (type industry/size/role instead of a seed list) —
  decided seed-list-only for v1 (matches today's derive-from-wins model). Revisit
  if users have no list to seed from.
- **Per-run extra-context slot** (workflow spec §3) — Brain corpus is the v1
  context home; per-run escape hatch deferred.
- **Inline send / write-back from the Prospects screen** — sending lives in the
  Drafts outbox; Prospects ends at qualified results + "draft outreach →".
- **Internal type/route rename** — mechanical follow-up PR.

## What already exists (reuse, don't rebuild)

- **Design tokens:** shadcn/zinc HSL vars in `apps/web/src/app/globals.css`
  (`--radius: 0.5rem`, `--muted`, `--primary`, `--destructive`, light+dark) plus
  Geist Sans/Mono. Now codified in **`DESIGN.md`** (2026-06-02), which also adds
  the new **motion tokens** (`--ease-out`, `--dur-micro/short/medium`,
  reduced-motion) and the **stepper spacing rhythm** this redesign needs. Build
  the rail against those tokens, not ad-hoc values.
- **Components:** `SourcePicker` (→ ICP picker), `CandidateCard`, `CitationChip`,
  `Badge`, `Button`, the `Loader2`/`Check`/`CircleAlert`/`Sparkles` icon set.
- **Logic:** `buildCampaignTranscript` reducer (split into two views),
  `use-campaign-stream` SSE hook (extend for reconnect re-fetch), `AppNav`
  (relabel), the persisted-detail re-fetch path (extend to reconnect).

---

## 9. Next step

The `ProspectRail` split (ICP panel + progress panel) is the highest-leverage
build and should land first. Run `/plan-eng-review` next to validate the
architectural implications (the `buildCampaignTranscript` split, the reconnect
re-fetch contract, and the activity-log data path), then `/design-consultation`
to set motion/spacing tokens before implementation.

---

## 10. Implementation Tasks

Synthesized from the 2026-06-02 design review. Each derives from a specific
finding/section above. P1 = build-blocking; P2 = same branch; P3 = follow-up.

- [ ] **T1 (P1, human: ~1d / CC: ~30min)** — `ProspectRail` — rail container that reorders panels by `campaign.status`
  - Surfaced by: Pass 1 / §3.5 — rail must serve current task (ICP-first setup, Progress-first running).
  - Files: new `components/ProspectRail.tsx`, `app/prospects/[id]/page.tsx`
  - Verify: setup shows ICP top; starting a run hoists Progress; no center reflow on collapse.
- [ ] **T2 (P1, human: ~1d / CC: ~30min)** — `RunProgressPanel` — phase stepper + live tail + counter footer + `aria-live` milestone region
  - Surfaced by: §3, §6b, Pass 2/6 — the core progress indicator with polite SR announcements.
  - Files: new `components/RunProgressPanel.tsx`
  - Verify: 4 phases render correct states; SR announces milestones only; tool lines `aria-hidden`.
- [ ] **T3 (P1, human: ~0.5d / CC: ~20min)** — Stream reconnect contract — typed `connectionState`, quiet reconnect, re-fetch detail on reconnect, escalate after retry budget
  - Surfaced by: §4b / Pass 2 — frozen "7/24" must not read as a crash.
  - Files: `lib/use-campaign-stream.ts`, `app/prospects/[id]/page.tsx`
  - Verify: kill network mid-run → muted "Reconnecting…"; restore → counters catch up; exhaust retries → Retry button.
- [ ] **T4 (P1, human: ~0.5d / CC: ~20min)** — `buildCampaignTranscript` split → `{ conversationRows, progressModel, icp, activityLog }`
  - Surfaced by: §4, §7 — one event stream, two views; activityLog feeds the disclosure.
  - Files: `lib/campaign-transcript.ts` (+ rename), unit tests
  - Verify: existing reducer tests pass; new assertions for progressModel + activityLog separation.
- [ ] **T5 (P2, human: ~0.5d / CC: ~20min)** — `IcpPanel` — Add-ICP picker, seed list card, derived chips, collapse
  - Surfaced by: §2 — the single "Add ICP" affordance.
  - Files: new `components/IcpPanel.tsx`, reuse `SourcePicker`
  - Verify: empty/picking/attached/deriving/derived states all render; keyboard-operable picker.
- [ ] **T6 (P2, human: ~0.5d / CC: ~20min)** — First-run empty state — composer-first hero + post-result "Add best customers to sharpen →" nudge
  - Surfaced by: §5b / Pass 3 — no setup-gate on the first win.
  - Files: `app/prospects/page.tsx`, `IcpPanel`
  - Verify: new user (no contacts) sees composer hero; ICP nudge appears only after first result.
- [ ] **T7 (P2, human: ~0.5d / CC: ~20min)** — Activity-log disclosure — expandable full ordered tool history
  - Surfaced by: §3 / Pass 7 — keep the audit-trail promise in the UI.
  - Files: `RunProgressPanel`, `campaign-transcript.ts`
  - Verify: disclosure shows N steps with args/duration/cost; collapsed by default.
- [ ] **T8 (P2, human: ~0.5d / CC: ~20min)** — Responsive — mobile sticky progress strip + full-screen ICP picker sheet
  - Surfaced by: §6b / Pass 6 — intentional mobile, not just stacked.
  - Files: `ProspectRail`, `IcpPanel`, layout
  - Verify: < md shows sticky `③ Research · 7/24` strip; picker opens as sheet; 44px targets.
- [ ] **T9 (P2, human: ~0.5d / CC: ~20min)** — Naming migration — routes/components/nav/copy Campaign → Prospects
  - Surfaced by: §5 — kill the blast metaphor in user-facing strings.
  - Files: `app/campaigns/** → app/prospects/**`, `AppNav.tsx`, composer/transcript renames, copy
  - Verify: nav reads "Prospects"; no "campaign" in user-facing copy; routes redirect/relabel.
- [ ] **T10 (P3, human: ~0.5d / CC: ~20min)** — a11y baseline — keyboard picker, `aria-current` stepper, `prefers-reduced-motion`, contrast hold
  - Surfaced by: §6b / Pass 6 — baseline that the live region (T2) sits on.
  - Files: `IcpPanel`, `RunProgressPanel`, `ProspectRail`
  - Verify: full keyboard pass; reduced-motion swaps instantly; axe clean.
- [x] **T11 (P3) — DONE 2026-06-02** — `/design-consultation` ran: seeded `DESIGN.md` (codified system + new motion/easing/reduced-motion tokens + stepper spacing rhythm), wired `CLAUDE.md` to read it.
  - Surfaced by: Pass 5/7 / D7 — prevent animation drift on the new rail.
  - Remaining for the build: apply `--ease-out` + `--dur-short` to the rail reorder/collapse and add the motion CSS vars to `globals.css` (DESIGN.md specifies the values).

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) — **stale** | 10 issues, 1 critical gap (commit f00be1f, predates this plan) |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (FULL) | score 7/10 → 9/10, 6 decisions, 0 unresolved |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **UNRESOLVED:** 0 design decisions open (3 minor open questions logged in §8, none blocking).
- **STALE:** the Eng Review on record (2026-05-29, f00be1f) predates this plan — it did not see the `ProspectRail` split, the reconnect re-fetch contract, or the `buildCampaignTranscript` refactor. Re-run `/plan-eng-review` before implementing.
- **VERDICT:** DESIGN CLEARED (9/10). Eng Review required and currently stale — re-run before code.

Design review summary (2026-06-02): initial 7/10 → 9/10. Six decisions resolved
into the plan — rail reorders by run state (§3.5), quiet stream reconnect (§4b),
composer-first first run (§5b), polite milestones-only SR announcements (§6b),
expandable audit-trail activity log (§3), and the DESIGN.md/motion-token TODO
(D7, being built now via `/design-consultation`). Per-pass: IA 6→9, States 5→9,
Journey 6→9, AI-slop 8 (clean), Design-system 7 (DESIGN.md pending), Responsive/
a11y 3→9.
