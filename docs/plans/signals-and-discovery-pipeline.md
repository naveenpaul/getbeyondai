# Plan: Signals + Search-Discovery Pipeline (wins → ICP/brain → discover → score → contacts)

**Status:** Eng-reviewed 2026-06-06. Decisions locked (F1 = durable CompanyBrain,
F2 = build order **B → A → C**). Ready to implement.
**Supersedes:** the "Signals = deferred entirely" decision in
[`prospecting-pipeline.md`](./prospecting-pipeline.md) (locked 2026-06-03). The
signals engine was subsequently **built** (`apps/api/src/modules/signals/`,
unit-tested) but never wired into the orchestrator. This plan wires it in, adds a
keyless **search-discovery** front-end, and grounds the ICP in **research of the
user's won companies**.

**Scope:** Turn an uploaded list of won contacts into a researched, maintained
ICP, discover *similar* companies the user does NOT already own (web search +
structured vendors, routed by the signal registry), score them with the buying-
signals engine, and hand the ranked companies to the existing contact waterfall.

---

## The vision (user's words, decomposed)

> upload won contacts → research these companies, study their products → build an
> ICP → search the web for similar companies, or PDL, once we have the ICP
> (companies NOT in the uploaded list) → pass to the signals engine for scoring →
> return the companies → find which contacts to reach out to.

```
 [upload won contacts]                                            EXISTS (ContactList)
        │
        ▼
 [research the won companies] ── Researcher, cite-or-abstain ──▶  products/offer/firmographics
        │                                                         NEW use of an EXISTING tool
        ▼
 [build ICP + signalSpec]  ──────────────────────────────────▶  durable CompanyBrain.icp  (F1)
        │                                                         EXTEND deriveIcp
        ▼
 [discover SIMILAR companies, excluding the won list]
   ├─ search-discovery (searxng + growing source registry)       NEW
   └─ vendor discovery (PDL/ZoomInfo) for filter-mode signals    EXISTS (findCandidates)
   ─ normalize raw → CandidateCompany ─ exclude-wins dedup ─▶
        │                                                         NEW normalize + dedup
        ▼
 [signals engine scores]  ── fit / timing / reachability, decay ▶ ranked
        │                                                         WIRE IN existing signals/
        ▼
 [contact discovery] ── Stage 5 waterfall ──────────────────────▶ contacts to reach out to
                                                                  EXISTS (built)
```

**Punchline:** the only genuinely-new code is (1) a **search-discovery provider +
source registry**, (2) **normalize + exclude-wins**, (3) **wiring the built signals
engine** into scoring, and (4) **researching the won companies** to ground the ICP.
Everything else is reuse.

---

## What already exists (reuse, not rebuild)

| Capability | Where | Reuse |
|---|---|---|
| Won-contacts upload | `ContactList` + `readWins()` | intake (reads names today; we add research) |
| ICP derivation | `deriveIcp()` → `IcpCriteria` | extend: ground in wins-research; emit `signalSpec` |
| **Signals engine** | `signals/` — registry, `signalSpec`, `signal-scoring` (weights + freshness/decay + disqualify), `CompanySignal` table | **WIRE IN** — built + unit-tested, never integrated |
| Researcher | `runResearch` (cite-or-abstain, AgentRun, budget) | research wins (new use) + derive-mode signals (Stage 4) |
| Vendor discovery | PDL/Apollo/ZoomInfo `findCandidates(icp)` | discovery for `connector_filter` signals |
| Search abstraction | `search/` `createSearchProvider` (searxng/brave) | the search-discovery backend |
| Enrichment (Stage 2.5) | `CompanyEnrichmentProvider.enrich` (domain/firmographics, null-only) | domain backfill for search-discovered companies (D1) |
| Contact waterfall | Stage 5 `WaterfallSourcingService` | unchanged |
| Dedup / field precedence | `contact-upsert` / `field-resolver` | reuse for exclude-wins entity resolution |
| Durable brain | `CompanyBrain` (icp/offer/productInfo, **unused**) | home for the maintained ICP (F1) |

Built on the 2026-06-05/06 fixes: the Apollo-expired chain-abort fix, the
empty-result fall-through in `FallbackSourcingProvider`, and the contacts
empty-state hint (`CONTACT_SOURCING_MIN_FIT_SCORE`).

---

## The key insight — routing falls out of the signal registry

There is **no `hasFundingRecencyIntent` and no hardcoded per-dimension branch.**
Each `SignalDefinition` already declares how it is acquired:

```
acquisition: { kind: 'connector_filter', param }  → push down into vendor discovery (PDL/ZoomInfo)
acquisition: { kind: 'research', question }        → searxng + Researcher derive + cite (Stage 4)
acquisition: { kind: 'feed' | 'computed' }         → future / pipeline-internal
```

So "find companies that raised in the last 3 months" is just a `signalSpec`
entry `{ key: 'recently_funded', weight, params: { withinMonths: 3 } }`. The
pipeline reads the spec, pushes `connector_filter` signals into whatever vendor
discovery supports them, and routes the rest to search-discovery + research.
Adding "hiring SDRs", "on Shopify", "expanded to US" later = **add a
`SignalDefinition`** — no orchestrator edit. Funding is one row in a growing list.

---

## Resolved decisions (2026-06-06)

- **F1 — ICP durability → DURABLE `CompanyBrain`.** Populate the per-org
  `CompanyBrain` (`icp` + `offer` + `productInfo`) from wins-research; reuse +
  maintain it across searches; user can override. The ICP compounds instead of
  being re-guessed every run. Uses the existing unused table (adds read/write +
  freshness/override).
- **F2 — Build order → `B → A → C`.** Search-discovery first: it's what makes
  "funded startups in Bengaluru" return companies (PDL can't), so it's the fastest
  unblock for the stated goal. Until Phase A lands, discovered companies are ranked
  by the **current** `scoreCandidate`; Phase A then swaps in the signal-scoring
  engine. C (wins-research-grounded ICP) last.
  - **Interim consequence (B before A):** in Phase B the ICP still carries no
    `signalSpec`, so search-discovery query construction reads `research`-mode
    signal questions from the spec only once A/C populate it. For B-alone, queries
    are built from the ICP criteria + wins exemplars + free-text intent (e.g.
    "funded … last 3 months" parsed from the goal). Funding becomes a *registered,
    weighted* signal at A; in B it rides the query text. This keeps B shippable
    without the registry-routing being fully populated, and A upgrades it cleanly.
- **F3 — Feedback loop scope → v1 now + reserve seam.** Ship the near-free v1 loop
  with Phase C (won discovered prospect → promoted into the wins `ContactList` →
  sharper next ICP). Reserve the v2/v3 seam (outcome labels on `ContactList`,
  learnable weights on `CompanyBrain.icp`, prospect→signal attribution). Do NOT
  build the v2 correlation UI / v3 auto-tuner until outcome data flows.

---

## Phases

### Phase A — Wire the signals engine into scoring
- `deriveIcp` emits a `signalSpec` (LLM-derived from goal + wins; weights/required;
  validated against the registry). Persist on `CompanyBrain.icp` (F1=A) or run
  context (F1=B).
- Stage 4: the Researcher's cited findings for `derive`-mode signals are written as
  `CompanySignal` rows (status/value/citationId/detectedAt/source) via
  `company-signal.repository`.
- Ranking: replace the one-shot `scoreCandidate` with `signal-scoring` (weighted
  contribution, freshness/decay, required→disqualify). `fitScore` becomes the
  normalized signal score; rationale lists signal contributions.
- **Reuses** the entire `signals/` module; new code is orchestrator wiring + the
  signalSpec emission prompt.
- **Signal isolation (review #2):** `CompanySignal` is keyed by `prospectId` (a
  per-search `Prospect`, `onDelete: Cascade`), so signals are physically isolated
  per run today — no cross-run leakage — and `signal-scoring` already enforces
  freshness/decay. **GATE on future work:** the moment durable-brain reuse (F1)
  starts *sharing* company research/signals across searches, isolation can no
  longer rely on `prospectId`. At that point add a stable `companyKey` + a
  `runContextId` (or `CompanyBrain.icp` version) tag on `CompanySignal`, and have
  the scorer read only `{ current context } ∪ { within decay window }`. Do NOT add
  cross-run signal reuse without this guard.

### Phase B — Search-discovery (single front-end) + source registry
- `DiscoverySource` registry — data-not-code, `searxng` first, more later (the
  "growing maintained list"). Mirrors the connectors/signals registries.
- A `SearchDiscoverySourcingProvider implements SourcingProvider`:
  1. Build queries from ICP + **wins as exemplars** ("companies like X, Y, Z") +
     `research`-mode signal questions. Recency windows go in query text (D2:
     LLM date-filter, not `time_range`). **Exemplar + query caps (review #3):**
     pass at most **5 representative wins** (not all — `readWins` may hold 50) and
     emit at most **3 search vectors** per run, to avoid prompt bloat + searxng
     query explosion + overlapping results. Early on the 5 are a simple sample;
     after Phase C (enriched wins) they're chosen by firmographic variance.
  2. Query the source registry; collect raw results.
  3. **Normalize + resolve domain inline** raw → vendor-neutral
     `CandidateCompany[]` via `callModel` (drops funds/ecosystem noise; one
     audited AgentRun, phase `news_discovery`). **No "ghost domains" (review #1):**
     resolve the corporate domain *here*, via the D1 searxng enrichment seam,
     BEFORE exclusion + before the expensive research/score. A candidate whose
     domain cannot be resolved is dropped (can't research or source contacts).
  4. **Exclude-wins on name OR domain** — drop candidates already in the uploaded
     list, matching on normalized **name** AND resolved **domain** (name-match is
     the guard for any residual domain miss), via the existing dedup/field-resolver
     helpers. Runs on clean domains (step 3 guaranteed one), before research/score
     so we never spend research tokens on a company we'd suppress.
  5. (Domain already resolved in step 3; the generic Stage 2.5 enrichment still
     runs later for firmographic backfill — headcount etc. — null-only, no clobber.)
- Wire into `buildSourcingProvider`: `connector_filter` signals → vendor discovery;
  otherwise search-discovery leads. No hardcoded intent check (registry-routed).

### Phase C — Wins-research → grounded ICP
- Research the uploaded won companies (Researcher: products, firmographics, what
  they have in common), under budget. Feed that into a richer ICP + signalSpec and
  into `CompanyBrain.productInfo`/`offer`.
- Turns the ICP from "guess from names" into "derived from what your winners
  actually are."

### Phase D — Outcome feedback loop (the moat; staged, mostly deferred)
The flow today ends at "here are contacts" and learns nothing from what happens
after outreach. The closed loop — outcomes (won / lost / meeting / no-reply)
feeding back into ICP + signal weights + ranking — is what turns automated
prospecting into a system that compounds. It is the payoff that justifies the
durable `CompanyBrain` (F1): a brain that only caches is barely worth it; one
that learns is the defensibility.

Staged so we never learn blind on noisy/sparse data:
- **v1 (cheap, near-free — can land with Phase C):** a won discovered prospect is
  **promoted into the wins `ContactList`**, which `deriveIcp` already reads. The
  winners set grows with companies the system surfaced and the user closed; the
  ICP re-derives off the richer set. A real closed loop using only existing
  primitives. No new model.
- **v2 (deferred — reserve seam now):** capture outcomes as `ContactList` labels
  (won / lost / meeting-booked / no-reply) and **surface correlation** to the user
  ("prospects with `hiring_sdrs` converted 3× — raise its weight?"). User accepts
  the weight change; nothing auto-tunes. Signal weights live on
  `CompanyBrain.icp` (already the home for the `signalSpec`).
- **v3 (deferred):** auto-tune signal weights / ICP from accumulated outcomes —
  only once there is enough outcome volume to learn reliably. Attribution is
  noisy (deals close for reasons orthogonal to the surfacing signal), so this
  stays gated behind a sample-size + human-review guard.

Reserved seam (cheap, additive): outcome labels on `ContactList` membership;
learnable signal weights persisted on `CompanyBrain.icp`; a prospect→scoring-
signals link so an outcome can be attributed back to the signals that ranked it.
**Do not build v2/v3 until there is outcome data flowing** — reserving the seam
is the in-scope part.

---

## Data-model deltas
- **F1=A:** start using `CompanyBrain` (icp/offer/productInfo); add read/write +
  org-scoping (RLS helper already references it). No new table.
- `CompanySignal` rows written in Stage 4 (table exists).
- `signalSpec` stored as JSON inside `CompanyBrain.icp` (no column).
- No new run model; extend the existing prospect-search orchestrator.

## Invariants to honour
#2 teammates never call connectors (search-discovery stays behind
`SourcingProvider`/`SearchProvider`); #3 all LLM via `callModel` (normalize +
signalSpec + research); #4 cite-or-abstain (derive signals carry `citationId`);
#5 vendor SDKs only in adapters; #6 creds in adapters; #8 hard per-run budget
(wins-research ×N, normalize, per-company derive all counted + capped).

## NOT in scope (deferred)
- **Outcome-learning v2/v3** (correlation-surfacing + auto-tuned weights, Phase D) —
  reserve the seam (outcome labels on `ContactList`, weights on `CompanyBrain.icp`,
  prospect→signal attribution link); do NOT build the learner until outcome data
  flows. The v1 loop (promote won prospects into the wins list) MAY land with C.
- **Monitor-mode signals / brain re-engagement** (Stage 6 `monitor`) — seam only.
- **Lookalike-by-embedding** discovery — exemplars-in-query first; vectors later.
- **Non-search structured discovery sources beyond PDL/ZoomInfo/Apollo** — registry
  leaves room; none added now.
- **User-editable signalSpec UI** — LLM-derived first; editing is a UX follow-up
  (`prospects-ux-plan.md`).

## Test plan (target 95%; 100% on budget + dedup/exclude-wins paths)
- **Pure/unit:** signalSpec emission parse; query construction (incl. exemplars +
  recency-in-text); normalize parser (drops noise, maps fields); exclude-wins
  entity resolution; signal-scoring already covered.
- **Integration:** search-discovery provider against a stubbed SearchProvider;
  CompanySignal write from a stub research brief; end-to-end rank via signal-scoring.
- **Regression (IRON RULE):** existing prospect-search output unchanged when
  signalSpec is empty (Phase A must not alter today's behavior for specless runs);
  exclude-wins never drops a non-won company.
- **Operational:** searxng keyless path works with no vendor creds; PDL-out-of-
  credits + Apollo-expired still degrade gracefully (the shipped fixes).

## Failure modes
| Failure | Test | Handling | User sees |
|---|---|---|---|
| searxng down / non-JSON | yes | SearchProviderError → provider returns empty → fall-through | other sources / actionable empty |
| Normalize LLM returns junk | yes | strict parse, drop unparseable, abstain | fewer candidates, no crash |
| Exclude-wins false-positive (drops a real company) | yes | conservative name+domain match | — (tested to not over-drop) |
| Budget hit mid-discovery/research | yes | stop, partial persisted | fewer candidates + budget notice |
| No discovery source connected | yes | empty + actionable message (shipped fallback) | "connect a source / out of credits" |

## Parallelization
- Lane A: signalSpec emission + scoring wiring (orchestrator + prompts).
- Lane B: `SearchDiscoverySourcingProvider` + source registry + normalize (connectors).
- Lane C: wins-research intake (orchestrator/prompts).
Lanes A and B are independent modules (parallel worktrees); C depends on A's
signalSpec shape. Orchestrator wiring + integration tests are the sequential join.
Build order is B → A → C (F2), but A and B touch different modules so the lane
independence still holds if revisited.

## Implementation Tasks
Synthesized from this review. Build order B → A → C.

- [ ] **T1 (P1, human: ~1d / CC: ~1h)** — connectors — `SearchDiscoverySourcingProvider`
  + `DiscoverySource` registry (searxng first); query build from ICP criteria +
  wins exemplars + intent; recency-in-text.
  - Surfaced by: Phase B / D2 / source-registry gap
  - Files: `apps/api/src/modules/connectors/sourcing/search-discovery.provider.ts` (+ registry, + specs)
  - Verify: provider unit tests against a stubbed `SearchProvider`
- [ ] **T2 (P1, human: ~3h / CC: ~30min)** — connectors — normalize raw results →
  `CandidateCompany[]` via `callModel` (drops noise), on an audited AgentRun.
  - Surfaced by: Phase B normalize step; invariants #3/#8
  - Files: same module + a prompts file (+ spec)
- [ ] **T3 (P1, human: ~3h / CC: ~30min)** — connectors — exclude-wins entity
  resolution (name/domain normalize) reusing dedup/field-resolver.
  - Surfaced by: "companies NOT in the uploaded list"; 100%-coverage path
- [ ] **T4 (P1, human: ~2h / CC: ~20min)** — enrichment — keyless searxng-backed
  `CompanyEnrichmentProvider` for domain backfill (D1), composes with PDL.
  - Files: `apps/api/src/modules/connectors/enrichment/*`
- [ ] **T5 (P1, human: ~half day / CC: ~45min)** — prospect-search — wire the built
  `signals/` engine: emit `signalSpec`, write `CompanySignal` from research, rank
  via `signal-scoring` (replaces `scoreCandidate`). **(Phase A)**
  - Surfaced by: signals-engine-unwired gap
  - Verify: specless-run regression (output unchanged) + signal-scored-run integration
- [ ] **T6 (P1, human: ~half day / CC: ~45min)** — prospect-search — durable
  `CompanyBrain` (icp/offer/productInfo) read/write + override/freshness. **(F1)**
- [ ] **T7 (P1, human: ~3h / CC: ~30min)** — prospect-search — wins-research →
  grounded ICP + signalSpec + productInfo. **(Phase C)**
- [ ] **T8 (P2, human: ~half day / CC: ~1h)** — web — show why-ranked (signal
  contributions + funding citation); consumes `prospects-ux-plan.md`.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 8 decisions (D1–D2, F1–F3, registry-routing) + 3 hardenings (ghost-domain, signal-isolation, query-explosion); Phase D loop seam reserved; 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | (deferred to `prospects-ux-plan.md`) |
| Outside Voice | `/codex review` | Independent 2nd opinion | 0 | skipped | — |

- **Scope:** EXTEND, don't rebuild — the signals engine, `CompanyBrain`, Researcher,
  discovery seam, and contact waterfall already exist; this wires them together and
  adds a search-discovery front-end. Complexity gate not tripped (phased; each
  increment is module-local).
- **Decisions:** D1 domain via the Stage 2.5 enrichment seam; D2 recency via
  query-text + LLM date-filter (not `time_range`); routing via the signal
  registry's `acquisition` kind (no `hasFundingRecencyIntent`); F1 durable
  `CompanyBrain`; F2 build order B → A → C; F3 feedback loop v1-now + reserve seam.
- **Review hardenings (product/arch pass):** #1 resolve domain inline + exclude on
  name|domain before research (no "ghost domains" / wasted tokens); #2 signal
  isolation is `prospectId`-scoped today (no leak) — gated `companyKey`+context
  guard required before any cross-run signal reuse; #3 exemplar cap ≤5 + ≤3 query
  vectors (no searxng query explosion).
- **Product loop (Phase D):** outcome feedback is the moat + the payoff of F1;
  staged v1 (promote wins, near-free) → v2 (surfaced correlation, user-tuned) →
  v3 (auto-tune, data-gated). Seam reserved; learner deferred.
- **Critical regression test:** specless run (empty `signalSpec`) must leave today's
  prospect-search output unchanged; exclude-wins must never drop a non-won company.
- **UNRESOLVED:** none.
- **VERDICT:** ENG CLEARED — ready to implement, starting Phase B. Outside voice
  skipped (plan-stage, user-driven). UX tracked in `prospects-ux-plan.md`.
