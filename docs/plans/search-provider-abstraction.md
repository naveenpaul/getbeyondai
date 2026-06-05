# Requirements: Search Provider Abstraction (Brave → SearXNG)

**Status:** Draft / requirements
**Owner:** TBD
**Related:** `llm-provider-abstraction.md`, `prospect-provider-abstraction.md`,
the `ContentProvider` seam (`apps/api/src/modules/teammates/runtime/content/`)

---

## 1. Motivation

Web search is the Researcher's primary discovery tool, but it is currently
**hardcoded to the Brave Search API** in
`apps/api/src/modules/teammates/runtime/tools/brave-search.ts`. This created two
problems we have observed live:

1. **Single point of failure / silent expiry.** An invalid/expired
   `BRAVE_SEARCH_API_KEY` (`SUBSCRIPTION_TOKEN_INVALID`, HTTP 422) makes **every**
   `brave_search` call fail, so the Researcher abstains on every company in every
   search. One bad secret breaks all qualification.
2. **Misalignment with the open-core / self-host thesis.** getbeyond is OSS-led
   and BYO-everything (BYO LLM key, local extraction, self-hostable stack).
   Requiring a paid Brave subscription is the one remaining hard dependency a
   self-hoster cannot avoid for the research loop.

**SearXNG** — a self-hostable, keyless metasearch engine — removes both: no key
to expire, and a fully keyless research stack for self-hosters (SearXNG + local
extraction + their own LLM).

This document specifies replacing the hardcoded Brave dependency with a
**swappable `SearchProvider` seam** (Brave + SearXNG), mirroring the existing
`ContentProvider` and `LlmProvider` abstractions. SearXNG does **not** replace
Brave outright; it becomes the self-host default while Brave remains the Cloud
default (see §6).

## 2. Goals / Non-goals

**Goals**
- Make web search a swappable provider behind a neutral interface; Brave and
  SearXNG are the first two implementations.
- A self-hoster can run the entire research loop **keyless** via SearXNG.
- Zero change to the trust chain: `fetch_url` + the Citation/`emit_draft`
  contract are untouched. Search still only *discovers* sources; only fetched
  pages become Citations.
- Provider selection is config/deployment-mode driven, fails loudly on
  misconfiguration, and is observable (provider name in logs/audit).

**Non-goals**
- Changing what the Researcher does with results, or the cite-or-abstain rule.
- Removing Brave (it stays as the Cloud-grade option).
- Building a SearXNG cluster / load balancer (operability beyond a single
  instance is out of scope for v1; see §11 risks).
- Crawling/extraction changes — that's the separate `ContentProvider` seam.

## 3. Current state (what exists)

- `tools/brave-search.ts` — the `brave_search` `AgentTool`. Input
  `{ query, count? }`; output `BraveSearchOutput { query, results }` where
  `BraveSearchResult = { title, url, description, age: string | null }`. Throws
  on missing key or non-200. Default singleton `braveSearchTool`.
- The Researcher wires `tools = [braveSearchTool, fetchUrlTool]`
  (`researcher/researcher.service.ts`); the SDR Drafter wires the same plus
  contact/brief tools.
- **Precedent to mirror:** `content/content-provider.ts` (neutral interface +
  `FetchedContent` + `ContentProviderError`) and `content/registry.ts`
  (`createContentProvider(config)`, `resolveContentProviderConfig(env)`,
  `contentProviderFromEnv()`, exhaustive `switch` with a `never` check, env
  default = the keyless `local`).

## 4. Functional requirements

### FR1 — Neutral `SearchProvider` seam
New directory `apps/api/src/modules/teammates/runtime/search/` mirroring
`content/`:

- `search-provider.ts` defines:
  - `SearchResult { title: string; url: string; description: string; age: string | null }`
    (identical to today's `BraveSearchResult`, so downstream is unchanged).
  - `SearchOutput { query: string; results: SearchResult[] }`.
  - `interface SearchProvider { readonly name: string; search(query: string, opts?: { count?: number }): Promise<SearchOutput>; }`
  - `class SearchProviderError extends Error` (neutral; wraps vendor/transport
    failures so no provider-specific error escapes the seam — same quarantine
    discipline as `ContentProviderError`).
  - `type SearchProviderName = 'brave' | 'searxng'`.

### FR2 — Brave provider (extract existing logic)
- `search/providers/brave.provider.ts` implements `SearchProvider` (`name='brave'`)
  by moving the HTTP + mapping logic out of `brave-search.ts` verbatim
  (X-Subscription-Token header, `web.results` → `SearchResult[]`, non-200 →
  `SearchProviderError`). Behavior must be byte-for-byte equivalent to today.

### FR3 — SearXNG provider
- `search/providers/searxng.provider.ts` implements `SearchProvider`
  (`name='searxng'`). Requirements:
  - Call `GET {SEARXNG_URL}/search?q=<query>&format=json` (+ `count` honored via
    pagination/`pageno` as available; SearXNG returns ~10/page).
  - Map SearXNG result fields → neutral `SearchResult`:
    `title`→`title`, `url`→`url`, `content`→`description`,
    `publishedDate`→`age` (ISO-8601 or null).
  - Configurable timeout (default 10s) and `categories`/`engines` query params so
    operators can scope which upstream engines are used.
  - On non-200 / non-JSON / empty engine errors → `SearchProviderError`.
  - **No API key**; auth (if the instance is protected) via an optional bearer
    token / basic-auth from config, never logged.
  - MUST validate `SEARXNG_URL` is set when selected (clear construction-time
    error otherwise, mirroring `crawl4ai` requiring `CRAWL4AI_URL`).

### FR4 — Registry + env config
- `search/registry.ts` with `createSearchProvider(config)`,
  `resolveSearchProviderConfig(env)`, `searchProviderFromEnv()`, and an exhaustive
  `switch` over `SearchProviderName` with a `never` fallthrough.
- Env vars:
  - `SEARCH_PROVIDER` = `brave | searxng` (explicit override).
  - `SEARXNG_URL` (required when `searxng`).
  - `SEARXNG_AUTH_TOKEN` (optional).
  - `BRAVE_SEARCH_API_KEY` (required when `brave`).
- **Default resolution (decision in §6):** explicit `SEARCH_PROVIDER` wins; else
  if `SEARXNG_URL` is set → `searxng`; else `brave`. Unknown non-empty
  `SEARCH_PROVIDER` → loud error (no silent fallback), matching the
  `ContentProvider` rule.

### FR5 — `web_search` tool backed by the provider
- Replace the `brave_search` tool with a provider-neutral `web_search`
  `AgentTool` (`tools/web-search.ts`) that delegates to the configured
  `SearchProvider`, exactly as `fetch_url` delegates to `ContentProvider`.
  - Same input schema (`{ query, count? }`) and same output shape
    (`{ query, results: [{title,url,description,age}] }`).
  - Tool description stays provider-agnostic ("Web search. Returns results with
    title, url, description, age. Use fetch_url on results you want to cite.").
- **Backward-compat:** keep the tool's model-facing **name** stable to avoid
  reprompting churn. Decision: rename to `web_search` AND update all prompts that
  reference `brave_search`, OR keep `brave_search` as the name with a neutral
  body. Prefer `web_search` + a prompt sweep (grep `brave_search` across
  `**/prompts.ts`).

### FR6 — Wiring
- `researcher.service.ts` and `sdr-drafter.service.ts` swap `braveSearchTool` →
  `webSearchTool` (the env-configured default). No other call sites should
  reference Brave directly (enforce via dependency-cruiser / grep).

## 5. Non-functional requirements

- **NFR1 Reliability.** SearXNG proxies upstream engines that rate-limit/block
  automated traffic. The provider MUST: set a hard timeout; retry transient
  failures with bounded backoff (e.g. 2 retries); and surface a clear
  `SearchProviderError` on exhaustion. A run-level **circuit breaker** and an
  optional **fallback provider** (e.g. searxng→brave when configured) SHOULD be
  supported so one flaky instance doesn't fail every search. (Reuse the existing
  breaker pattern from `connectors/circuit-breaker.ts` if practical.)
- **NFR2 Cost/economy.** The Researcher's per-run search budget assumptions are
  unchanged. SearXNG is free per query; Brave stays ~$0.005/call. No new
  per-query billing path.
- **NFR3 Security.** `SEARXNG_URL` SHOULD point at an internal/self-hosted
  instance, not a public one (public instances are unreliable + privacy-leaking).
  Any SearXNG auth token is config-only and never logged. No credentials cross
  the `search/` boundary (same rule as content providers).
- **NFR4 Observability.** Log the active provider name + result count + HTTP
  status per call; record provider in the audit trail so an operator can see
  which backend served a search. A misconfigured provider fails loudly at
  construction, not silently at first query.
- **NFR5 Determinism in tests.** Providers take an injectable `httpFetch`
  (default global `fetch`), as Brave does today, so unit tests need no network.

## 6. Deployment & gating (decision)

SearXNG scrapes upstream engines, which violates those engines' ToS. This is the
**same self-host-vs-Cloud tension** as Apollo/PDL credentials
(`common/deployment.ts`):

| Deployment | Default provider | Rationale |
|---|---|---|
| **Self-host** | **SearXNG** (keyless) | Operator runs their own instance on their own infra — their ToS risk, BYO posture. Keyless = the open-core promise. |
| **getbeyond Cloud** | **Brave** | Paid, ToS-clean, stable under programmatic load. Running SearXNG-scraping-Google at Cloud scale is the same legally-dubious territory Apollo is gated on. |

- Provide an `isSearxngAllowed(mode)` helper (parallel to `isApolloAllowed`) if we
  decide to **bar** SearXNG on Cloud; otherwise allow operator override but
  default per the table. Decision required: hard-gate SearXNG off on Cloud, or
  allow-with-default. **Recommendation:** default per table, no hard gate (an
  operator who points Cloud at *their own* licensed search instance is fine);
  document the ToS caveat.

## 7. Architecture invariants (must uphold)

- Vendor/transport HTTP lives **only** in `search/providers/*` (invariant #5
  analogue — ESLint/dependency-cruiser should keep Brave/SearXNG HTTP out of
  teammate code).
- The seam is provider-neutral; teammates and the `web_search` tool depend only
  on `SearchProvider` + neutral types.
- The trust chain is unchanged: search results are NOT Citations; only
  `fetch_url`-ed pages are (invariant #4).

## 8. Testing requirements

- **Unit** (`*.spec.ts`, co-located, injected `httpFetch`, no network):
  - SearXNG provider: field mapping (`content`→description, `publishedDate`→age,
    missing fields → defaults), non-200 → `SearchProviderError`, non-JSON →
    error, empty results, timeout, auth header set when token configured.
  - Brave provider: parity with current `brave-search.spec.ts` (port the cases).
  - Registry: env resolution + default rules + loud error on unknown value +
    `never` exhaustiveness.
  - `web_search` tool: delegates to the injected provider; output shape stable.
- **Integration / live probe** (throwaway, like `scripts/*-probe.ts`): stand up a
  real SearXNG instance and run representative Researcher queries to verify the
  JSON API shape and behavior **under realistic volume** (see §10) — do NOT
  assume the docs; verify live.
- **Coverage:** ≥95% line coverage on new `src/**` files per CLAUDE.md; port
  Brave's existing coverage so the extraction loses none.

## 9. Migration / rollout

1. Introduce the `SearchProvider` seam + Brave provider (behavior-preserving
   extraction). `web_search` tool wraps it. Brave stays the default everywhere →
   **no behavior change**, all tests green.
2. Add the SearXNG provider + registry env wiring + tests.
3. Stand up SearXNG (Docker) in dev; run the live probe under load; tune
   timeouts/retries/engines from real results.
4. Flip the **self-host default** to SearXNG (per §6); Cloud stays Brave.
5. Document setup (compose service, `SEARXNG_URL`, recommended engines) in the
   deployment docs.

## 10. Open questions / must-verify-live

- **Does a single SearXNG instance hold up under the Researcher's query volume**
  (10–20 searches/prospect × N prospects) without upstream blocks/CAPTCHA? This is
  the make-or-break NFR — verify before flipping the self-host default.
- Which **engines/categories** give Brave-comparable recall + freshness for B2B
  company research (and which to disable to reduce blocks)?
- Result **freshness/`age`**: does SearXNG reliably populate `publishedDate`? If
  sparse, `age`-dependent prompt logic degrades gracefully.
- Hard-gate SearXNG on Cloud, or allow-with-default? (§6)
- Tool **rename** `brave_search`→`web_search` + prompt sweep, vs keep the name.
  (FR5)

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| SearXNG instance gets rate-limited/blocked by upstreams under agent load | Self-hosted instance + retry/backoff + circuit breaker + optional fallback to Brave; tune enabled engines; §10 load probe before default-flip |
| Result quality/recall below Brave | Keep Brave as a configurable option; per-engine tuning; measure with the live probe |
| ToS exposure on Cloud | Default Cloud→Brave; document SearXNG as self-host BYO posture (§6) |
| Silent misconfiguration | Loud construction-time error on unknown/unset provider (FR4); provider name in logs (NFR4) |

## 12. Acceptance criteria

- [ ] `SearchProvider` seam + Brave + SearXNG providers + registry, mirroring
      `ContentProvider`.
- [ ] `web_search` tool replaces `brave_search`; Researcher + SDR Drafter wired to
      the env-configured provider; no direct Brave references remain (grep clean).
- [ ] Self-host can run research **keyless** via `SEARCH_PROVIDER=searxng` +
      `SEARXNG_URL`; Cloud unchanged on Brave.
- [ ] Brave-path behavior byte-for-byte unchanged; all existing research tests
      pass; new code ≥95% coverage.
- [ ] Live probe confirms SearXNG returns usable results for representative
      research queries (documented in the probe output).
- [ ] Deployment docs cover the SearXNG compose service + env + ToS caveat.
