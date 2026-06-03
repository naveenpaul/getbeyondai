# Plan: Rename `Campaign` → `ProspectSearch` / `Prospect` (backend + contract)

**Status:** Planned, NOT started. Deferred by decision (2026-06-03): UI display
copy is already relabeled; the backend/DB/contract rename waits until the open
branches merge.
**Decision (2026-06-03):** workspace = "Prospects"; the run entity
`Campaign` → **`ProspectSearch`**; the candidate company
`CampaignCandidate` → **`Prospect`**. Rationale: "prospect" already describes the
candidate *company*, not the run — so the child takes the noun and the parent
becomes the search that produces them ("a ProspectSearch finds Prospects").

**Already done (shipped on main, commit `c6fa024`):** all user-facing *display
copy* in `apps/web` ("Campaigns"→"Prospects", a run→"search", a company→
"prospect"). Identifiers, routes, events, and types were intentionally left as
`Campaign*` to match the backend. This plan is the rest.

---

## Why this is deferred (do NOT start early)

A model-wide rename touches **~991 references across 53 files**, **3 DB tables**,
the **`CampaignStatus` enum**, the **`/campaigns` API route**, the **SSE event
names**, and the **`@getbeyond/shared` contract**. As of 2026-06-03 every other
branch has campaign files open (`auth/email-password` 26, three branches 17,
`feat/llm-routing…` 11). Renaming on `main` now would force brutal rebases on all
of them and could corrupt in-flight work — exactly the collision that already
produced one broken mid-edit state during the UI relabel.

**Preconditions to start:**
1. The open feature branches have merged (or been abandoned).
2. A short coordination window where no other session is editing `campaigns/*`,
   `connectors/sourcing/*`, or `packages/shared`.
3. Done as **one atomic PR** — a partial rename breaks the API↔web contract.

---

## Rename map

### Entities / Prisma models (`apps/api/prisma/schema.prisma`)
| From | To |
|---|---|
| `model Campaign` | `model ProspectSearch` |
| `model CampaignCandidate` | `model Prospect` |
| `model CampaignCandidateContact` | `model ProspectContact` |
| `enum CampaignStatus` | `enum ProspectSearchStatus` |

### DB tables / enum (the `@@map` targets — **rename, don't drop+create**)
| From | To |
|---|---|
| `campaigns` | `prospect_searches` |
| `campaign_candidates` | `prospects` |
| `campaign_candidate_contacts` | `prospect_contacts` |
| type `"CampaignStatus"` | `"ProspectSearchStatus"` |

Also: `CompanySignal.candidateId` → `prospectId` (FK now → `prospects`), and its
FK/index names follow. Update `company_signals` accordingly.

### API surface (`apps/api/src/modules/campaigns/`)
- Rename the module dir `modules/campaigns` → `modules/prospect-search`.
- `campaign-orchestrator.ts` → `prospect-search-orchestrator.ts` (+ worker, dtos,
  prompts, specs).
- Route `@Controller('campaigns')` → **`@Controller('prospect-searches')`**
  (REST resource = the search). Workspace URL in web stays `/prospects` — see
  Open decisions.
- SSE stays `:id/stream`.

### SSE event names (`packages/shared/src/campaign-contracts.ts` → `prospect-search-contracts.ts`)
| From | To | Note |
|---|---|---|
| `campaign_started` | `search_started` | |
| `campaign_completed` | `search_completed` | |
| `campaign_failed` | `search_failed` | |
| `candidate_qualified` | `prospect_qualified` | |
| `sourcing_started` / `sourcing_completed` | *(unchanged — generic)* | |
| `icp_derived` | *(unchanged)* | |

### `@getbeyond/shared` types (rename file → `prospect-search-contracts.ts`)
`CampaignStatus`→`ProspectSearchStatus`, `CreateCampaignRequest`→
`CreateProspectSearchRequest`, `CreateCampaignResponse`→…`Response`,
`CampaignSummary`→`ProspectSearchSummary`, `CampaignListResponse`→
`ProspectSearchListResponse`, `CampaignContact`→`ProspectContact`,
`CampaignDetailResponse`→`ProspectSearchDetailResponse`, `CampaignEventType`→
`ProspectSearchEventType`, `CampaignEvent`→`ProspectSearchEvent`.

### Web (`apps/web`) — identifiers + route (display copy already done)
- Route folder `src/app/campaigns` → `src/app/prospects`; update every
  `/campaigns/...` link + `router.push` + the `AppNav` `match`.
- `api-client.ts`: `listCampaigns`→`listProspectSearches`, `/campaigns` fetch
  paths → `/prospect-searches`, `campaignStreamUrl`→…, etc.
- Components/libs: `CampaignComposer`→`ProspectSearchComposer`,
  `CampaignTranscript`→`ProspectSearchTranscript`, `use-campaign-stream`→
  `use-prospect-search-stream`, `campaign-transcript.ts`→
  `prospect-search-transcript.ts`. (Their *display strings* are already correct.)

---

## Migration strategy (data-preserving)

Prisma's default for a changed `@@map` is **DROP + CREATE** — that destroys data.
Hand-author the migration to **RENAME** instead:

```sql
ALTER TABLE "campaigns" RENAME TO "prospect_searches";
ALTER TABLE "campaign_candidates" RENAME TO "prospects";
ALTER TABLE "campaign_candidate_contacts" RENAME TO "prospect_contacts";
ALTER TYPE "CampaignStatus" RENAME TO "ProspectSearchStatus";
ALTER TABLE "company_signals" RENAME COLUMN "candidateId" TO "prospectId";
-- then rename PK/FK constraints + indexes to match Prisma's expected names
-- (e.g. campaign_candidates_pkey → prospects_pkey, *_campaignId_fkey, etc.)
```

Generate with `prisma migrate dev --create-only`, then **replace the generated
drop/create SQL with the RENAME statements above** before applying. Verify
`prisma migrate status` is clean and integration tests pass on `getbeyond_test`.
Renaming constraints/indexes to the names Prisma expects avoids perpetual drift.

---

## Execution order (one PR, on a fresh branch off a settled `main`)

1. **shared** — rename `campaign-contracts.ts` + all exported types + event
   literals. (Breaks everything downstream — do first, fix outward.)
2. **prisma** — rename models/enum/maps; hand-author the RENAME migration; apply
   to dev + test DBs.
3. **api** — rename module dir, orchestrator/worker/dtos/services, controller
   route, event emitters, and every `prisma.campaign*` call → `prospectSearch` /
   `prospect`. Fix `field-resolver`/`contact-upsert`/`company-signal` references.
4. **web** — rename route folder, api-client fns + paths, components/hooks/libs.
   Display copy already correct.
5. **tests** — update + run full unit suite + integration; the
   REGRESSION-IF-BROKEN paths (cross-source dedup, tier precedence) must stay
   green.
6. **deploy** — API + web ship **in lockstep** (the route + SSE event rename is a
   breaking contract change; no rolling skew).

Mostly mechanical find/replace, but case-by-case (don't blanket-replace
substrings — `candidate` appears in unrelated contexts).

---

## Risks
- **Data loss** if the migration drops/creates instead of renaming → mitigated by
  the hand-authored RENAME migration above. Back up before applying.
- **Contract break** (route + SSE events + response shapes) → API and web must
  deploy together.
- **Merge conflicts** with any still-open branch → only start once they've landed.
- **Partial rename** leaving mixed vocab → enforce by doing it in one PR + a full
  `tsc`/dependency-cruiser pass before merge.

## Open decisions (settle at execution)
1. **API resource path:** `/prospect-searches` (matches the entity, recommended)
   vs `/prospects` (matches the workspace). If `/prospects`, a child "prospect"
   resource gets awkward (`/prospects/:id/prospects`) — prefer `/prospect-searches`.
2. **Keep the module dir name** `campaigns` for git-history continuity, or rename
   to `prospect-search`? Recommend rename for consistency; accept the history hop.

## Not in scope
- The signal layer (`modules/signals/*`) already uses neutral naming — only its
  `CompanySignal.candidateId` FK column rename (above) is affected.
- No behavior change — this is a pure rename.
