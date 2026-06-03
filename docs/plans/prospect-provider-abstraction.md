# Plan: Apollo Contact Sourcing (verified-people connector)

**Status:** Reference adapter scaffolded + tested, 2026-06-02. Not yet
eng-reviewed — run `/plan-eng-review` before wiring the sync worker / UI.
**Scope:** Source verified B2B people (name, title, company, **email +
email_status**) from Apollo into `Contact`, behind the existing `SourceAdapter`
seam — the same contract HubSpot and CSV use. ZoomInfo and other vendors follow
the same shape later.

**Related:**
- `packages/shared/src/connector-contracts.ts` — the `SourceAdapter` /
  `NormalizedContact` contract this implements.
- `apps/api/src/modules/connectors/adapters/{csv,hubspot}.source.ts` — sibling
  adapters this mirrors.
- `apps/api/src/modules/connectors/sourcing/sourcing-provider.ts` — the
  *company-centric* discovery seam (a separate, complementary path; see §4).
- `../prospects-ux-plan.md` — the UX consumer.

> **Correction note (2026-06-02):** an earlier draft of this doc placed the
> connector under `teammates/runtime/prospect/` with env-var keys and a bespoke
> person model. That violated architecture invariants #2 (teammates never call
> connectors) and #5 (vendor code only in `connectors/adapters/`). The as-built
> design below conforms to the existing connector seam instead.

---

## Why

The Prospects workspace needs net-new, contactable people that match a derived
ICP. Apollo returns verified/guessed **emails directly**, so it is the
"verified contacts" source. Two drivers, same as every connector:

1. **Open-source self-hosting.** Clone getbeyond, paste an Apollo API key, sync.
2. **Hosted cloud.** The user brings their own Apollo key; we never front
   contact-data spend **and never pool/resell vendor data** (see §2).

---

## The decision that shapes everything: data ≠ tokens

BYOK is the universal mechanism, but contact data is **not** symmetric with the
LLM seam on two axes — these, not the code, drive the design.

### A1 — You can resell tokens; you (generally) cannot resell contact data

Reselling Anthropic tokens is normal. Apollo / ZoomInfo / PDL ToS typically
**prohibit pooling one account across third parties or redistributing enriched
records** without a reseller agreement. So the "hold the contract, meter, mark
up" managed-credits model that's fine for LLMs is **blocked by default** for
contact data → **BYOK is the default in hosted cloud too**, via the encrypted
`ConnectorAccount` credential the platform already has.

### A2 — BYOK lowers the barrier very unevenly per vendor

| Vendor | Self-serve key? | Status |
|---|---|---|
| **Apollo** | ✅ 5-min signup | **Reference adapter — built.** |
| People Data Labs | ✅ pay-as-you-go | Next adapter (most API-first). |
| Hunter / Prospeo | ✅ cheap | Email find/verify layer. |
| **ZoomInfo** | ❌ enterprise contract + OAuth | Loud-failing enterprise stub. |
| Clay | — aggregator UI, not an API | Don't build on it. |

---

## Locked decisions (as built)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Seam | **`SourceAdapter`** (read: pull contacts in) — NOT a teammate tool and NOT the company-centric `SourcingProvider`. Teammates consume the resulting `Contact` (invariant #2). |
| 2 | Output shape | **Verified people** → `NormalizedContact` (email included), streamed via `syncContacts` async-iterable. |
| 3 | Email provenance | **`email_status` rides in `NormalizedContact.rawPayload`** → persisted as `ContactSource.rawPayload`. No new column; verified/guessed is preserved per-contact. |
| 4 | Invariant #4 (cite-or-abstain) | **Not triggered here.** A vendor-asserted email is Contact *data* with connector provenance (like a HubSpot contact), not a teammate Claim. #4 bites only when a teammate writes about the contact. |
| 5 | Auth | **`authMode: 'byo_key'`.** Key stored encrypted on `ConnectorAccount`, decrypted only inside the adapter (invariant #6). No OAuth/refresh. |
| 6 | Vendor quarantine | **All Apollo HTTP in `connectors/adapters/apollo/apollo.source.ts`** (invariant #5). Injected `fetch`; no SDK dependency. |
| 7 | 401 mid-sync | **`onVendorFailure('auth_invalid')` + throw** — byo_key can't refresh. This is the `REGRESSION-IF-BROKEN` "Apollo 401 mid-sync" path (100% covered). |
| 8 | Pagination | **Cursor = 1-based page**, resumable; stops at `total_pages` / empty page / `maxContacts` / hard 500-page ceiling. |
| 9 | Email gating | People with a credit-locked (`email_not_unlocked`) address or no stable id are **skipped** (not actionable; upsert keys on email). |
| 10 | Managed/pooled credits | **Declined by default** (A1). Revisit only per-vendor partner agreement. |

---

## Architecture (as built)

```
ConnectorAccount.credentials (encrypted {apiKey})
        │  decrypted by CredentialManager, only inside the adapter
        ▼
ApolloSourceAdapter implements SourceAdapter<ApolloSourceConfig>   (invariant #5)
  ├─ ping(creds)              → GET /v1/auth/health
  └─ syncContacts(params)     → POST /v1/mixed_people/search, paginated
        │  yields NormalizedContact (email + email_status in rawPayload)
        ▼
  connectors/registry.ts  →  getSourceAdapter('apollo')
        │
        ▼
  (next) sync worker → contact-upsert → Contact / ContactSource
        │
        ▼
  Teammates read Contact / ContactList  (invariant #2 — never the adapter)
```

`ApolloSourceConfig` carries the People Search criteria (`titles`,
`seniorities`, `industries`, `companyHeadcount`, `locations`, `keywords`,
`domains`) — the user's saved Apollo search, expressed as config.

---

## §4 — The complementary company-centric path (not built here)

`SourcingProvider` (`connectors/sourcing/`) is a *different* seam: ICP →
`CandidateCompany[]` for campaign lookalike discovery, where the Researcher then
derives + **cites** contacts from the web. `buildSourcingProvider()` in
`campaigns/campaign.worker.ts` already reserves an `apollo` case. An
`ApolloSourcingProvider` (firmographic search → companies) can reuse the same
`apollo.source.ts` HTTP layer when campaign discovery needs Apollo. The two are
complementary: this doc's adapter pulls *people you can email now*; the sourcing
provider pulls *companies to qualify*.

---

## Compliance (personal data — not optional)

- **BYO key, encrypted `ConnectorAccount`** — never bundled, never logged.
- **Per-vendor retention** — respect Apollo's storage ToS before GA.
- **GDPR/CCPA** — verified B2B contacts are personal data; needs a
  suppression/deletion list and a documented lawful-basis stance before GA.

---

## Build order

1. ✅ `ApolloSourceAdapter` (`connectors/adapters/apollo/apollo.source.ts`) —
   `ping` + `syncContacts` (search→people, pagination, cursor, email gating,
   circuit-breaker + 401 path). Registered in `connectors/registry.ts`.
   Tested (31 specs, 100% line coverage).
2. ⬜ Sync worker wiring + `ConnectorAccount` (byo_key) setup endpoint + the
   "Apollo 401 mid-sync" integration test against the real `getbeyond_test` DB.
3. ⬜ `ApolloSourceConfig` UI (saved-search builder) in the Prospects workspace.
4. ⬜ PDL adapter (second vendor validates the seam), Hunter verifier.
5. ⬜ ZoomInfo loud-failing stub.
6. ⬜ (Optional) `ApolloSourcingProvider` for the company-centric campaign path.
