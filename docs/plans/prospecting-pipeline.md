# Plan: Prospecting Pipeline — ICP → Discover → Source → Research → Persist

**Status:** Flow locked + eng-reviewed 2026-06-03. Architecture resolved to
*extend the campaign pipeline with a contact-sourcing tail* (see "Resolved
architecture"). Ready to implement.
**Scope:** Turn a user's ICP *criteria* into researched, contactable people in
the DB. Discovery finds matching companies; a cost-aware waterfall pulls
contacts + emails across connectors; the Researcher adds cited company research;
results upsert as `Contact`s with tiered provenance. Buying-**signals** are
designed-for but **not built** in this pass.

**Related:**
- `apps/api/src/modules/campaigns/campaign-orchestrator.ts` — the existing
  *company-centric* pipeline this evolves from (ICP → candidate companies →
  research+score). Reuse its building blocks; the output model differs.
- `apps/api/src/modules/connectors/sourcing/sourcing-provider.ts` — the
  company-discovery seam (`findCandidates(icp)`).
- `apps/api/src/modules/connectors/adapters/{snov,apollo}/*` — enrichment +
  discovery adapters.
- `apps/api/src/modules/contacts/{contact-upsert,field-resolver}.ts` — persist +
  cross-source dedup + tiered precedence.
- `./prospect-provider-abstraction.md` — connector `SourceAdapter` seam.
- `./prospects-ux-plan.md` — the UX consumer.

---

## Locked decisions (2026-06-03)

1. **ICP input = criteria → we discover.** User supplies an ICP *description* +
   "what they're looking for"; we run discovery to find matching companies, then
   enrich contacts. (A pasted target list is a possible later shortcut, not v1.)
2. **Multi-connector = waterfall, chase-verified.** Per person, try connectors in
   priority order; **stop early on the first verified email**; hold any unverified
   email as a fallback and continue; if none verify, keep the best unverified one
   (labelled); skip the person only if no connector returns any email. Threshold
   is configurable (default = chase-verified). [eng-review A3]
3. **Scope = extend the campaign pipeline (reduced).** Add contact-sourcing as a
   tail stage; reuse discovery, the Researcher, dedup, and upsert. signalSpec and
   any new parallel run-model are **deferred** (no consumer yet). [eng-review D1]
4. **Signals = deferred entirely this pass.** Defined-at-ICP / detected-per-company
   remains the intended shape, but **no `signalSpec` field is added now** — it has
   no reader yet; add it cheaply when the signal feature is built. [eng-review D1]

## Resolved architecture (eng-review 2026-06-03)

This is **not** a separate pipeline. It **extends the existing
`campaign-orchestrator`** with a contact-sourcing tail. Company research already
happens in the campaign's qualify step (the Researcher runs per candidate),
so contacts attach to an already-researched, already-ranked company — **no
per-contact research stage** (that would re-research the same company N times).

```
Campaign pipeline (extended):
  1. deriveIcp(goal + ICP criteria)                              [extend intake]
  2. discover companies → SourcingProvider.findCandidates(icp)   [reuse: Apollo/ZoomInfo]
  3. qualify + rank → Researcher brief + fitScore →              [reuse: research LIVES here]
     CampaignCandidate
  4. rank, set status                                            [reuse]
  5. [NEW] contact pull → for QUALIFIED + fit-ranked + capped    [NEW: waterfall]
     companies, waterfall over SourceAdapters (priority order,
     chase-verified) per domain → Contacts upserted + linked
     to the CampaignCandidate (+ company brief)
```

Genuinely-new code = **Stage 5 waterfall** + **ICP-criteria intake in deriveIcp**.
Everything else is reuse.

- **A2 — Stage 5 gate:** pull contacts only for *qualified* candidates, top-N by
  `fitScore`, with a `contactsPerCompany` cap, all under the per-run budget
  (invariant #8). Skip domainless candidates.
- **Connector config:** per-org connector priority + threshold; default order
  `[zoominfo, snov]` (ZoomInfo verifies better for the verified-chase), default
  threshold = verified. Tunable.
- **Discovery dependency unchanged:** discovery = the campaign's existing
  `SourcingProvider` (Apollo self-host now / ZoomInfo when ready). The waterfall
  is contact *enrichment* over discovered domains — a different seam
  (`SourceAdapter.syncContacts`), so no new discovery work is required to start.

---

## The pipeline

```
[0] INTENT      ICP criteria + intent + signalSpec        (extend deriveIcp)
                    ↓
[1] DISCOVERY   criteria → matching companies              (needs ZoomInfo/Apollo;
                                                             Snov CANNOT discover)
                    ↓
[2] SOURCING    per company: waterfall connectors →        (Snov built; ZoomInfo WIP)
                contacts + emails (stop at first usable)
                    ↓
[3] DEDUP/MERGE collapse same person/company across        (reuse cross-source
                connectors; tiered field precedence         dedup + field-resolver)
                    ↓
[4] RESEARCH    per UNIQUE company: Researcher → cited      (reuse runResearch +
                brief; budget-capped                         AgentRun + callModel)
                    ↓
[5] PERSIST     upsert Contact + ContactSource + research   (reuse upsertContact)
                    ↓
[6] SIGNALS     brain monitors companies for buying         ← NOT BUILT (seam only)
                signals → re-engagement
```

| Stage | Status | Notes |
|---|---|---|
| 0 Intent | extend | `deriveIcp` exists; add explicit ICP-criteria input + `signalSpec` |
| 1 Discovery | **dependency** | requires a discovery connector — ZoomInfo (WIP) or Apollo (deferred) |
| 2 Sourcing | extend | Snov `syncContacts` built; waterfall orchestration is new |
| 3 Dedup/merge | exists | cross-source dedup + tiered precedence (REGRESSION-IF-BROKEN) |
| 4 Research | exists | the Researcher (`runResearch`), cite-or-abstain, per-run budget |
| 5 Persist | exists | `upsertContact` + `ContactSource` provenance |
| 6 Signals | new | deferred; model leaves room |

---

## ⚠️ Critical-path dependency

This flow's discovery stage (ICP criteria → companies) needs a **discovery-capable
connector**. **Snov is enrichment-only** (domain-driven; it cannot search by ICP).
The discovery legs available are:

- **Apollo org-search** — built + tested (`apollo-sourcing.provider.ts`) but
  **self-host-gated** (ToS) and currently deferred.
- **ZoomInfo** — adapter in progress (uncommitted, parallel work).

**Therefore the end-to-end loop cannot ship until ZoomInfo (or Apollo) discovery
is wired.** Sequencing options for eng-review:
- (a) Build the orchestrator against the `SourcingProvider` seam now, using
  Apollo org-search behind a self-host flag, ZoomInfo when ready.
- (b) Land the waterfall + research + persist against a **stub/target-list**
  discovery first, swap in the real discovery connector after.

---

## Stage detail

### 0 — Intent capture
- Input: ICP criteria (firmographics: industry, size, geo, funding, keywords) +
  free-text intent + an optional `signalSpec` (declared timing signals).
- `deriveIcp` already synthesizes an `IcpCriteria`; extend it to accept explicit
  user criteria (not only a wins-list seed) and to emit `signalSpec`.
- **Signal definition lives here and only here** — a signal is the user's
  "what I'm looking for", captured once.

### 1 — Discovery
- `SourcingProvider.findCandidates(icp)` → `CandidateCompany[]` (domain, name,
  size, …). Connector = ZoomInfo/Apollo.
- **Filterable signals** the discovery connector supports (e.g. "raised in last
  12mo") are pushed down here to narrow the pull.

### 2 — Sourcing (waterfall, chase-verified) [resolved: A3]
- For each candidate company/domain, iterate connectors in configured priority
  order (default `[zoominfo, snov]`); call each adapter's `syncContacts`.
- **Threshold = chase-verified (configurable):** stop early on the first verified
  email; hold any unverified email as a fallback and continue; if none verify,
  keep the best unverified one (labelled with `smtp_status`); skip the person only
  if no connector returns any email. We keep all statuses — the threshold governs
  whether to *spend more* chasing verification.
- Only QUALIFIED + fit-ranked + capped companies are pulled [A2]. Honour
  per-connector `dailyBudgetCents` + the per-run cost budget (invariant #8).

### 3 — Dedup / merge
- The same person across connectors collapses via the existing cross-source
  dedup (email-normalized identity); conflicting fields resolve by
  `TIER_PRECEDENCE` (snov/zoominfo/apollo = tier 25). No new logic.

### 4 — Research (per unique company)
- Dedup companies first so we research each company **once**, not per contact.
- Reuse the Researcher: mint an `AgentRun`, `runResearch` → cited brief Draft,
  under the per-run/per-pipeline budget (invariant #8). **Derived signals**
  (web-read, cited) are produced here.
- Attach research output to the company; surface on its contacts.

### 5 — Persist
- `upsertContact` per contact (+ `ContactSource` with `rawPayload`/`smtp_status`
  provenance). Company research stored at company level, linked.

### 6 — Signals (deferred — seam only)
- Reserve: `signalSpec` on the ICP/campaign (Stage 0); a company-level
  signal-event shape (`type`, `value`, `citationId`, `detectedAt`, `source`).
- Three usage modes the model must accommodate: **filter** (Stage 1),
  **derive** (Stage 4), **monitor** (future brain). Do **not** build the monitor.

---

## Data-model deltas (resolved)
- **Run/output model:** extend `Campaign`/`CampaignCandidate`; contacts persist as
  `Contact` linked to the candidate. No new `ProspectingRun`. [D1, A1]
- **Waterfall config:** per-org connector priority + threshold (default
  `[zoominfo, snov]`, chase-verified). [A3]
- **Deferred (not built this pass):** `signalSpec` on the ICP and the company-level
  signal-event table — no consumer yet; additive when signals ship. [D1]

## Invariants to honour
- #2 teammates never call connectors — sourcing stays behind `SourcingProvider` /
  `SourceAdapter`; the Researcher only touches the runtime.
- #3 all LLM calls via `callModel`. #4 cite-or-abstain (read from the Researcher's
  Draft). #5 vendor SDKs only in adapters. #6 creds decrypt only in adapters.
  #8 hard per-run cost budget.

## Resolved questions (eng-review 2026-06-03)
1. Discovery sequencing → **non-issue**: discovery is the campaign's existing
   `SourcingProvider` seam; the waterfall is a separate enrichment seam. Start with
   Apollo (self-host) / ZoomInfo when ready, injected behind the seam.
2. Run/output model → **extend the campaign pipeline** with a contact-sourcing
   tail (not a separate `ProspectingRun`). [D1, A1]
3. Waterfall threshold → **chase-verified**, configurable, best-unverified
   fallback. [A3]
4. Research granularity → **reused from the campaign qualify step** (per-company,
   once); contacts link to the existing company brief. No new research stage.
5. Stage 5 gate → qualified + fit-ranked + `contactsPerCompany` cap + per-run
   budget. [A2]

## Build increments (post-review)
1. **Refactor:** extract shared glue if needed; extend `deriveIcp` to accept
   explicit ICP criteria (not only a wins seed). TDD.
2. **Stage 5 — `WaterfallSourcingService`** over `SourceAdapter`s (priority order,
   chase-verified threshold, best-unverified fallback, per-company cap, budget +
   breaker fall-through). TDD — this is the bulk of the new code.
3. **Orchestrator wiring:** Stage 5 after rank; pull contacts for qualified +
   fit-ranked + capped candidates; `upsertContact` linked to `CampaignCandidate`.
4. **Tests:** the two CRITICAL regression tests + the waterfall unit matrix
   (below).
5. **UX:** ICP-criteria input + run progress (consumes `prospects-ux-plan.md`).
6. **(Deferred)** signalSpec + signal-event model + brain monitor.

---

## Test plan (eng-review)

Framework: **vitest**. Target 95% line; **100%** on the dedup/precedence + budget
paths. Co-located `*.spec.ts`; integration `*.integration.spec.ts`.

**CRITICAL (IRON RULE — regression, no skipping):**
- **Existing campaign output unchanged** — extending the orchestrator must not
  alter the current company discovery+rank output (`CampaignCandidate`s).
- **Cross-source dedup + tier precedence** — Stage 5 feeds new sources
  (snov/zoominfo, tier 25) into the dedup path already flagged
  REGRESSION-IF-BROKEN; same person via two connectors → one contact, precedence
  holds.

**Waterfall unit matrix (`WaterfallSourcingService`):** priority order respected;
stop early on first verified; unverified held as fallback then continue; none
verify → keep best unverified (labelled); no email anywhere → skip person;
connector circuit-broken/down → fall through gracefully; `contactsPerCompany`
cap; per-run budget exhausted → stop; domainless company → skip.

**Intake:** `deriveIcp` with explicit criteria → `IcpCriteria`; empty criteria
AND no wins seed → guard/error.

**Integration / E2E:** only qualified + fit-ranked + capped companies get pulled;
contacts upserted + linked to the `CampaignCandidate`.

## NOT in scope (deferred, with rationale)
- **signalSpec field + signal-event model + brain monitor** — no consumer yet;
  add when the signal feature is built (cheap additive migration then).
- **Separate `ProspectingRun` model/orchestrator** — superseded by extending the
  campaign pipeline.
- **Per-contact research stage** — company research already exists in the qualify
  step; re-researching per contact would burn budget.
- **Pasted target-list input (skip discovery)** — possible later shortcut; v1 is
  ICP-criteria → discover.
- **"verified-only, drop unverified" gate** — threshold is configurable; default
  keeps best-unverified labelled rather than dropping contacts.

## What already exists (reuse, not rebuild)
- `campaign-orchestrator.ts` — the fixed pipeline being extended (Stages 1-4).
- `sourcing/sourcing-provider.ts` (+ apollo/contact-list providers) — discovery.
- Researcher (`runResearch`) — company research, cite-or-abstain.
- `contact-upsert.ts` + `field-resolver.ts` — dedup + tiered precedence + persist.
- Snov + Apollo `SourceAdapter`s — Stage 5 connector calls.
- AgentRun + `callModel` + per-run budget (invariant #8) — reused by Stage 5.

## Failure modes (Stage 5)
| Failure | Test? | Error handling | User sees |
|---|---|---|---|
| Connector 5xx / down mid-waterfall | yes (fall-through) | breaker + fall through to next connector | degraded coverage, not a hard fail |
| All connectors exhausted, no verified | yes | keep best unverified, labelled | contact present, status flagged |
| Per-run budget hit mid-pull | yes | stop pulling, partial result persisted | fewer contacts + budget notice |
| Domainless qualified company | yes | skip Stage 5 for it | company ranked, no contacts |
| Connector key rejected (401) | yes (adapter) | `SourcingUnavailable`-style surfaced | actionable reconnect message |

No silent-failure critical gaps: every Stage 5 failure path has a test + handling
+ a visible outcome.

## Parallelization
Sequential within a run (Stage 5 depends on ranked candidates). Across candidates,
reuse the campaign's bounded concurrency. Implementation lanes:
`Lane A: deriveIcp intake` and `Lane B: WaterfallSourcingService` are independent
(different modules) and can be built in parallel worktrees; orchestrator wiring +
tests depend on both (Lane C, sequential).

## Implementation Tasks
- [ ] **T1 (P1, human: ~3h / CC: ~30min)** — connectors — `WaterfallSourcingService`
  (priority, chase-verified, best-unverified fallback, per-company cap, budget +
  breaker fall-through)
  - Surfaced by: Architecture A3 — waterfall semantics
  - Files: `apps/api/src/modules/connectors/sourcing/waterfall-sourcing.service.ts` (+ spec)
  - Verify: `pnpm vitest run` waterfall unit matrix
- [ ] **T2 (P1, human: ~2h / CC: ~20min)** — campaigns — Stage 5 wiring (qualified +
  fit-ranked + capped → pull → `upsertContact` linked to `CampaignCandidate`)
  - Surfaced by: Architecture A1/A2
  - Files: `apps/api/src/modules/campaigns/campaign-orchestrator.ts` (+ spec)
  - Verify: integration test + existing-campaign regression test
- [ ] **T3 (P1, human: ~1h / CC: ~10min)** — campaigns — extend `deriveIcp` for
  explicit ICP criteria
  - Files: `campaign-orchestrator.ts` / `campaign.prompts.ts` (+ spec)
- [ ] **T4 (P1, human: ~1h / CC: ~10min)** — contacts — CRITICAL regression tests
  (campaign output unchanged; cross-source dedup/precedence with snov/zoominfo)
- [ ] **T5 (P2, human: ~30min / CC: ~5min)** — config — per-org connector priority +
  threshold (default `[zoominfo, snov]`, verified)
- [ ] **T6 (P2, human: ~half day / CC: ~1h)** — web — ICP-criteria input + run
  progress (consumes `prospects-ux-plan.md`)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 3 issues (scope reduced), 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | (UX deferred to `prospects-ux-plan.md`) |
| Outside Voice | `/codex review` | Independent 2nd opinion | 0 | skipped | — |

- **Scope:** SCOPE_REDUCED — deferred signalSpec + a separate run-model; extend the
  campaign pipeline with a contact-sourcing tail instead.
- **Decisions:** D1 reduced scope; A1 extend campaign pipeline (research reused from
  qualify step); A2 Stage-5 gate = qualified + fit-ranked + capped + budgeted;
  A3 waterfall = chase-verified, configurable, best-unverified fallback.
- **Critical regression tests:** existing-campaign-output-unchanged;
  cross-source dedup + tier precedence with snov/zoominfo.
- **UNRESOLVED:** none.
- **VERDICT:** ENG CLEARED — ready to implement. Outside voice skipped (plan-stage,
  user-driven). UX gaps tracked separately in `prospects-ux-plan.md`.
