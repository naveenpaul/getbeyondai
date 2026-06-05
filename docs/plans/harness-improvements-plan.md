# Plan: Teammate Harness Improvements — quality, cost, guardrails (provider-neutral)

**Status:** Draft for review
**Scope:** Improve the teammate runtime (`apps/api/src/modules/teammates/runtime/`) for better output quality and lower LLM cost, and add guardrails + tools — **without** breaking provider neutrality.
**Builds on:** [llm-provider-abstraction.md](./llm-provider-abstraction.md) (locked 2026-05-29). Honors its decision #5 (neutral Anthropic-shaped superset, adapters down-convert) and #7 (providers declare capabilities; assert/degrade at run start).

---

## Governing principle: capability-gated, provider-neutral

The LLM can be **anything** — Anthropic, OpenAI, future Gemini/Mistral/local/OpenAI-compatible. So every model-side optimization here is expressed as:

1. A **neutral parameter** on `CreateMessageParams` / `ToolDefinition` (no vendor type leaks — decision #5), and
2. A **capability flag** on `ProviderCapabilities` the loop checks before using it, with **graceful degradation** when false (decision #7).

Adding a provider stays "add a case to `providers/registry.ts` + a factory + declare its capabilities." No optimization may introduce a vendor-specific branch outside `providers/`.

### Capabilities to add to `ProviderCapabilities`

Today: `toolUse`, `parallelToolUse`, `caching`. Add:

| Capability | Meaning | Anthropic | OpenAI | Local/unknown |
|---|---|---|---|---|
| `caching` (exists) | honors prompt-cache hints | explicit `cache_control` | **automatic** (server-side) | usually none |
| `reasoningControl` | accepts an effort/thinking knob | `effort` + adaptive thinking | `reasoning_effort` (o-series) | none |
| `strictTools` | guarantees schema-valid tool args | strict tools / `output_config` | strict function calling | none |
| `batch` | async 50%-off batch submission | Message Batches API | Batch API | none |

Degradation rule: when a capability is false, the neutral param is **ignored** by that adapter and the loop behaves as it does today. Nothing errors; you just don't get the saving on that provider.

---

## Cost levers (highest ROI first)

### C1 — Prompt caching (the #1 win), expressed neutrally
**Problem:** the loop re-sends the full growing transcript uncached every turn → input cost scales ~**O(turns²)**. `AnthropicProvider.createMessage` never sends `cache_control` (the doc-comment describes it, but the code doesn't; `capabilities.caching: false`, blocked on `@anthropic-ai/sdk@0.30.1`). OpenAI caches automatically but the adapter doesn't read the cached-token split, so it over-prices.

**Neutral design:**
- Add cache *hints* to the neutral params — mark the **stable prefix** (system + tools) and a **rolling breakpoint** on the last message block each turn. Hints, not vendor syntax.
- `AnthropicProvider`: translate hints → `cache_control: {type: ephemeral}` on the system block, last tool, and the rolling message block.
- `OpenAIProvider`: **no-op for hints** (caching is automatic) but read `usage.prompt_tokens_details.cached_tokens` so cost is correct.
- Structuring the prompt cache-friendly (stable content first, volatile last) helps OpenAI's automatic cache *and* Anthropic's explicit cache — do it regardless of provider.

**Capability gate:** `caching`. Providers without it: full price, no behavior change.
**Impact:** 50–90% input-token reduction on multi-turn runs (both providers, different mechanisms).
**Files:** `llm-types.ts` (hint fields), `providers/anthropic.provider.ts`, `providers/openai.provider.ts`, `call-model.ts` (set hints), `cost.ts` (see C6).
**Prereq:** bump Anthropic SDK off 0.30.1 (see Sequencing).
**Tests:** characterization test that hints produce `cache_control` for Anthropic and are absent for OpenAI; cost test for cached-token pricing per provider.

### C2 — Use the `modelFast` tier you already resolve
**Problem:** `resolve-llm.ts` returns `modelFast` per provider, but the workers pass only `modelPrimary` into `runAgent`. Every sub-step runs on the expensive model.

**Neutral design:** thread `modelFast` through `RunAgentParams`. Run cheap sub-steps on it; reserve `modelPrimary` for the `emit_draft` synthesis turn.

| Sub-step | → tier |
|---|---|
| query/plan generation, per-page summarize, relevance + claim-citation matching | `modelFast` |
| final synthesis + `emit_draft` | `modelPrimary` |

This is already provider-neutral — `(modelPrimary, modelFast)` come from the per-`(org,teammate)` routing for *whatever* provider is configured.
**Caveat:** switching models mid-run breaks the prompt cache (C1). Run the cheap task as a **Haiku/mini subagent** (its own short context) and keep the main loop on one model, so C1 and C2 compose instead of fighting.
**Impact:** 60–80% cheaper on the offloaded steps, often equal/better quality (small model, narrow task).
**Files:** `tool-use-loop.ts`, both workers, `researcher.service.ts` / `sdr-drafter.service.ts`.

### C3 — Compress what re-enters context
**Problem:** `fetch_url` dumps full page text into a `tool_result` that rides along in *every later turn's* prompt.
**Design (provider-neutral):** summarize/extract each fetched page (via `modelFast`, C2) to relevant spans before it enters the transcript; stash full text in `Citation` with a `get_more`/`read_section` tool for on-demand expansion. Lowers cost **and** improves results (less distraction).
**Files:** `runtime/tools/fetch-url.ts`, content providers, `tool-use-loop.ts`.

### C4 — Reasoning effort per turn (capability-gated)
**Neutral design:** add `reasoningEffort?: 'low'|'medium'|'high'` to `CreateMessageParams`. `low` on cheap turns, `high` only for synthesis. Anthropic adapter → `effort` (+ adaptive thinking on the synthesis turn); OpenAI reasoning models → `reasoning_effort`; others → ignored.
**Capability gate:** `reasoningControl`.

### C5 — Batch lane for latency-tolerant runs (capability-gated)
**Neutral design:** a `batch` submission path on the provider interface. "Research 200 prospects overnight" → provider batch (Anthropic Message Batches / OpenAI Batch API, both ~50% off). When `capabilities.batch` is false, fall back to the normal async pg-boss path (no discount). Fits the existing producer/consumer model — add a batch queue lane.
**Capability gate:** `batch`.

### C6 — Per-provider cache & token pricing
**Problem:** `cost.ts` hardcodes `CACHE_WRITE_MULTIPLIER=1.25` / `CACHE_READ_MULTIPLIER=0.1` globally — those are Anthropic economics. OpenAI cached input is ~0.5× and the write is free/automatic.
**Design:** move cache multipliers into the per-model/per-provider `ModelRate` (or a per-provider cache-pricing struct). Keep the flat `MODEL_PRICING` map keyed by globally-unique model name; add cache semantics per entry. Keeps cost transparency accurate as providers multiply.
**Files:** `cost.ts`, `providers/*` (ensure each reports the tokens its pricing needs).

---

## Quality levers

### Q1 — Per-turn `tool_choice` control
The loop always lets the model choose (`auto`). Drive `tool_choice` from the loop: require a search before drafting on early turns; force `emit_draft` once enough citations exist. The neutral `ToolChoice` type + `toAnthropicToolChoice` already exist (OpenAI maps to `tool_choice`/`function_call`) — just unused by the loop. Stops spinning and ungrounded drafts. Capability: relies on `toolUse` (already asserted).

### Q2 — Cheap verification pass before `emit_draft`
A `modelFast` critic that checks claim↔citation grounding, tone, and (SDR) deliverability flags, feeding one round of corrections back. Strengthens the trust contract that is the category wedge. Provider-neutral.

### Q3 — Lightweight plan step
One cheap `modelFast` call up front to decompose the target into sub-questions before the free-run loop. Improves completeness, reduces aimless tool calls.

### Q4 — Strict structured output for `emit_draft` (capability-gated)
Today args are Zod-validated *after* the call; failures bounce back as retry turns (extra cost). When `capabilities.strictTools` is true, mark the `emit_draft` tool `strict` so args are valid by construction (Anthropic strict tools / OpenAI strict functions). When false, keep the current Zod-retry path. **Keep the Zod check regardless** — it's the trust backstop, provider-independent.
**Neutral design:** `strict?: boolean` on `ToolDefinition`; adapters honor or ignore.

---

## Guardrails

### Security (real gaps today)
- **G1 — SSRF on `fetch_url`.** The model picks arbitrary URLs. Block private/link-local ranges, `file://`, and cloud-metadata IPs (`169.254.169.254`); validate post-redirect targets too. Highest-priority missing guardrail. Provider-independent.
- **G2 — Treat fetched/tool content as untrusted.** Page text re-enters the model — a prompt-injection vector. Delimit tool output, keep authority in the system role, never let fetched content override instructions. Applies to every provider equally.

### Reliability
- **G3 — No-progress / loop detection.** Detect repeated identical tool calls (same URL/query) and short-circuit, beyond the blunt `maxToolCalls`.
- **G4 — Per-tool timeout + output-size cap.** Only a global `maxWallSecs` exists; one slow/huge page can dominate a run. Cap tool-result size (also feeds C3).
- **G5 — Context-window guard / compaction.** With full-text tool results, long runs approach the window. Compact/summarize old turns past a threshold. Note: window size is **per model/provider** — read it from capabilities/config, don't hardcode.
- **G6 — Retry re-spend.** pg-boss retries re-run `runAgent` from scratch, re-spending budget; a job that died after spending could double-charge. Carry `costCents` forward / resume, or cap retried spend.

### Org-level (only per-run budget exists today)
- **G7 — Daily/monthly spend cap + concurrent-run cap per org.** A runaway org shouldn't rack up an unbounded BYO bill across many runs.
- **G8 — Do-not-contact / suppression enforcement** before `emit_draft` for SDR drafts (ties to the deliverability moat).

---

## Tools to add (all provider-neutral `AgentTool`s)

- **`get_company_enrichment`** — structured firmographics via the PDL seam instead of scraping (cheaper, more reliable than `fetch_url` for firmographic facts).
- **`crm_lookup`** — pull prior interactions (HubSpot connector exists) so drafts personalize on real history.
- **`get_person_signals`** — person-level hooks via `ext-client`/LinkedIn for the SDR drafter.
- **`search_prior_drafts`** — reuse winning messaging across runs (cheap retrieval over past `Draft`s).
- **`ask_for_clarification`** — first-class "abstain with a question" instead of guessing on ambiguous targets; improves trust over confident-but-wrong.
- **`calculator` / structured extractor** — precise figures without LLM arithmetic.

---

## Sequencing

1. **Provider-adapter capability work** — bump `@anthropic-ai/sdk` off 0.30.1 (unblocks explicit caching, effort/thinking, strict tools, newer models incl. Opus 4.8); confirm OpenAI adapter reads `cached_tokens`. Extend `ProviderCapabilities` (`reasoningControl`, `strictTools`, `batch`).
2. **C1 prompt caching + C2 `modelFast` threading + C6 per-provider pricing** — the biggest cost wins; mostly wiring already stubbed. Compose via the subagent pattern.
3. **G1 + G2 `fetch_url` SSRF + untrusted-content** — close the security gap.
4. **C3 tool-result compression + G4 per-tool caps** — cost and quality together.
5. **Q1 tool_choice + Q2 verification + Q4 strict output** — quality / trust.
6. **G5–G8 guards, C4 effort, C5 batch lane, new tools** — roadmap.

Every capability-gated item must ship with: the neutral param, both adapters (honor + no-op), the `capabilities` flag, and a degradation test proving a non-supporting provider still runs.

---

## Open questions

1. Cache-hint shape: explicit breakpoint markers on message blocks vs a single "cache the prefix" flag the adapter expands? (Affects how the rolling per-turn breakpoint is expressed neutrally.)
2. `modelFast` for sub-steps: subagent (separate context, preserves main-loop cache) vs same-loop tier-switch (simpler, breaks cache). Recommend subagent.
3. Per-provider cache pricing: extend `ModelRate`, or a separate per-provider cache-pricing table?
4. Batch lane: worth it for v1, or defer until interactive cost is handled?
5. Context-window source: read from a provider/model capability field vs a config map — needs a home as providers multiply.
