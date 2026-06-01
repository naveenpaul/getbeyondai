# Plan: LLM Provider Abstraction (provider-agnostic teammate runtime)

**Status:** Architecture locked via `/plan-eng-review` (2026-05-29). Ready to implement.
**Scope:** Make the teammate runtime provider-agnostic (Anthropic + OpenAI), with
org-scoped configuration and bring-your-own-key (BYO) support, while serving
open-source self-hosters via env config.

---

## Why

Two concrete drivers (not "multi-provider for its own sake"):

1. **Open-source self-hosting.** Someone clones getbeyond and must point it at
   *their* LLM (provider + model + key) quickly — via env vars at deploy time,
   no multi-tenant UI, no DB provisioning.
2. **Hosted cloud.** A user **brings their own key** (they pay their own LLM
   bill) — we never front LLM spend.

Today the runtime is hardwired to Anthropic: the SDK *import* is quarantined to
`call-model.ts`, but the SDK *types* leak into every caller, and the model is a
hardcoded `'claude-sonnet-4-6'` default that ignores the existing (unused)
`TeammateConfig` table.

This upholds architecture invariant #3 ("All LLM calls go through one
`callModel()` ... model routing") and the system-design stance ("LLM provider
should be easy to swap; do not leak model-vendor types deep into feature code").

---

## Locked decisions (10)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Provider routing | **Explicit `provider`, sourced from DB config** — no model-name inference |
| 2 | Config source | **Org-scoped config + BYO keys** (not global, not request-param) |
| 3 | Hosted fallback | **Require BYO in hosted** (no platform fallback); self-host via env flag |
| 4 | Data model | **Split**: credential per `(org,provider)` + routing per `(org,teammate)` |
| 5 | Neutral message model | **Anthropic-shaped superset**; adapters down-convert; no escape hatch (YAGNI) |
| 6 | Error handling | **Normalize to neutral error classes** at the adapter; **no retry** (declined) |
| 7 | Capabilities | **Providers declare capabilities; assert at run start (fail-fast)** |
| 8 | Credential reuse | **Reuse `credential-encryption.ts` primitives** + thin `LlmCredentialManager` |
| 9 | Spec migration | **Rewrite specs against neutral types** + Anthropic characterization test |
| 10 | Resolution lifetime | **Resolve once at run start**; per-run provider bound to the decrypted key |

---

## Architecture

### Resolution chain (the heart — one chain serves both audiences)

```
resolveLlm(org, teammate) → { provider, model, apiKey }

  ┌─ 1. Org BYO config in DB?         ── hosted user brought their own key
  │      (OrgLlmCredential, sealed)      provider+model+key from their rows
  │
  ├─ 2. else: env fallback allowed?   ── SELF-HOST: instance-wide env key
  │      LLM_ALLOW_ENV_FALLBACK=true     LLM_PROVIDER / LLM_MODEL / *_API_KEY
  │
  └─ 3. else: block run              ── HOSTED default: "configure your LLM key"
```

- **Self-host:** ships `LLM_ALLOW_ENV_FALLBACK=true`. Set env, done in 2 minutes.
  The env key is *theirs*, so "we never pay" is not violated (there is no "we").
- **Hosted, no BYO:** ships `LLM_ALLOW_ENV_FALLBACK=false`. Run blocked until BYO.
- **Hosted, BYO:** step 1; sealed key decrypted **only inside the provider adapter**.

### Provider boundary

```
runtime callers (tool-use-loop, call-model)
        │  neutral types only — no SDK types
        ▼
  LlmProvider.createMessage(neutralParams) → neutralResult
        │
        ├── AnthropicProvider  ── @anthropic-ai/sdk (quarantined here)
        │      ~passthrough + cache_control + usage cache-tokens
        │
        └── OpenAIProvider     ── openai sdk (quarantined here)
               down-convert: tool_use→tool_calls (input→JSON string),
               tool_result→N× role:tool, isError→content envelope,
               stop_reason/usage mapping
```

`dependency-cruiser` quarantine tightens: SDK imports allowed only under
`apps/api/src/modules/teammates/runtime/providers/` (was: the whole `runtime/`).

### Neutral types (`llm-types.ts`)

```ts
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: object }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

interface Message { role: 'user' | 'assistant'; content: ContentBlock[]; }

interface ToolDefinition { name: string; description: string; inputSchema: object; }

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;   // Anthropic prompt caching — priced by cost.ts
  cacheWriteTokens?: number;
}

type StopReason = 'tool_use' | 'end' | 'max_tokens';

interface ProviderCapabilities {
  toolUse: boolean;
  parallelToolUse: boolean;
  caching: boolean;
}

interface LlmProvider {
  readonly capabilities: ProviderCapabilities;
  createMessage(params: CreateMessageParams): Promise<CreateMessageResult>;
}
```

### Neutral error classes (normalized at the adapter; never leak SDK error types)

```
LlmProviderError            (base)
 ├── LlmAuthError           bad/missing/rotated key
 ├── LlmRateLimitError      429
 └── LlmOverloadedError     529 / 503 transient
```

No retry in this PR (declined). Errors stay terminal: run → failed, as today.

---

## Data model (Prisma)

```prisma
enum Provider { anthropic openai }

// Mirrors ConnectorAccount: sealed secret + version CAS, unique per (org,provider)
model OrgLlmCredential {
  id         String   @id @default(cuid())
  orgId      String
  provider   Provider
  apiKey     Bytes    // libsodium-sealed via credential-encryption.ts; decrypts only in adapter
  keyVersion Int      @default(1)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  org        Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@unique([orgId, provider])
  @@map("org_llm_credentials")
}

// Org-scoped version of the (currently dead) TeammateConfig routing fields
model OrgTeammateConfig {
  id           String   @id @default(cuid())
  orgId        String
  teammate     String
  provider     Provider @default(anthropic)
  modelPrimary String   @default("claude-sonnet-4-6")
  modelFast    String   @default("claude-haiku-4-5-20251001")
  updatedAt    DateTime @updatedAt
  org          Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@unique([orgId, teammate])
  @@map("org_teammate_configs")
}
```

RLS-scoped on `orgId` via the existing `org-scope.ts`. `ModelCall` gains a
`provider` column so the audit log records which provider ran each call.

> Note: the global `TeammateConfig` table's routing role is superseded by
> `OrgTeammateConfig`. Decide during P3 whether to drop it or keep it as a
> platform-default seed source.

---

## Phases (each independently green + committable)

### P1 — Provider core + Anthropic + caller migration *(Anthropic-only, behavior identical)*
- New: `llm-types.ts`, `llm-provider.ts`, `providers/anthropic.provider.ts`
  (SDK moves here; applies `cache_control` to system + tools; normalizes errors;
  declares capabilities).
- Change: `call-model.ts` → neutral types, calls `provider.createMessage`;
  cost computed from neutral `Usage` incl. cache tokens.
- Change: `tool-use-loop.ts` → neutral `Message`/`ContentBlock` throughout
  (the bulk of the churn: build `ToolDefinition[]`, push neutral messages,
  filter `tool_use` blocks, build `tool_result` blocks).
- Tests: rewrite `call-model.spec.ts` + `tool-use-loop.spec.ts` against neutral
  types; **add `AnthropicProvider` characterization test** asserting the
  neutral→SDK `messages.create` payload matches the previous wire shape.

### P2 — OpenAI adapter + registry
- New: `providers/openai.provider.ts` (full down-conversion), `providers/registry.ts`
  (provider enum → instance; clear throw on unconfigured).
- Tests: down-convert matrix — parallel tool_use → multiple tool_calls + ordered
  `role:tool` messages; object↔JSON-string args round-trip; `isError` envelope;
  `stop_reason`/`usage` mapping incl. unknown values.

### P3 — Persistence + credential manager
- New: `OrgLlmCredential` + `OrgTeammateConfig` + migration; `ModelCall.provider`.
- New: `LlmCredentialManager` (seal on save, unseal on load — **reuses
  `credential-encryption.ts`**; no OAuth/circuit; load scoped to `orgId`).
- Tests **(100% — REGRESSION-IF-BROKEN, BYO-key isolation class):** seal/unseal
  round-trip; wrong key → `decrypt_failed` → `LlmAuthError`; **cross-org
  isolation — org A's key never resolves for org B**.

### P4 — Resolver + dual-mode config
- New: `resolve-llm.ts` (the chain above) + `LLM_ALLOW_ENV_FALLBACK` env.
- Wire services to read config (fixes the latent gap: today they ignore it).
- Tests **(100% branch):** org BYO → org key; no BYO + fallback ON → env;
  no BYO + fallback OFF → block.

### P5 — DI cutover + migration cleanup
- DI: `ANTHROPIC_CLIENT` → registry/`LLM_PROVIDER`; factory builds per-run
  provider bound to the resolved key (resolve once at run start).
- Migrate `researcher.service/worker`, `sdr-drafter.service/worker`.
- `cost.ts` → per-provider `MODEL_PRICING[provider][model]` + cache-token rates;
  provider-aware `UnknownModelError`.
- `.dependency-cruiser.cjs` → quarantine SDK to `providers/` only.
- Update stale comment `agent-tool.ts:33` ("Must match the Anthropic Tool.name").

---

## Test coverage map

```
[+] providers/openai.provider.ts (RISKIEST)
  ├── tool_use → tool_calls (input→JSON string)        ★★★ round-trip
  ├── tool_result → N× role:tool (parallel, ordered)   ★★★
  ├── isError → content envelope                        ★★
  ├── stop_reason map (tool_calls/stop/length/unknown)  ★★
  └── usage map                                         ★★
[+] providers/anthropic.provider.ts
  ├── passthrough + cache_control + characterization    ★★★
  ├── usage cache-token extraction                      ★★
  └── SDK error → neutral class (auth/rate/overload)    ★★★
[+] providers/registry.ts  configured/unconfigured      ★★
[+] resolve-llm.ts            ← 100% REGRESSION-IF-BROKEN
  ├── org BYO → org key                                 ★★★
  ├── no BYO + fallback ON → env                        ★★★
  ├── no BYO + fallback OFF → block                     ★★★
  └── cross-org isolation                               ★★★ CRITICAL
[+] llm-credential-manager.ts ← 100% REGRESSION-IF-BROKEN
  ├── seal/unseal round-trip                            ★★★
  ├── wrong key → decrypt_failed                        ★★★
  └── load scoped to orgId                              ★★★
[+] capability assert at run start                      ★★★
[~] cost.ts per-provider + cache pricing                ★★

Target: 95% global; 100% on resolve-llm + llm-credential-manager.
```

---

## Failure modes

| Path | Failure | Test | Handling | Silent? |
|---|---|---|---|---|
| `resolveLlm` no BYO + fallback off | run blocked | ✅ 100% | clear message | No |
| cross-org key resolve | A gets B's key | ✅ 100% | orgId-scoped query | **would be silent → CRITICAL** |
| OpenAI down-convert | malformed args | ✅ ★★★ | parse guard → neutral error | No |
| BYO key decrypt | wrong/rotated key | ✅ ★★★ | `decrypt_failed` → `LlmAuthError` | No |
| capability mismatch | model lacks tool use | ✅ ★★★ | fail-fast at run start | No |
| cache-token cost | usage missing cache split | ✅ ★★ | default 0, priced | mis-bill risk if untested |

---

## NOT in scope

- **Provider-agnostic retry/backoff** — declined; rely on normalized terminal errors.
- **Settings UI for LLM config** — this is API + data + resolver only.
- **Per-org LLM usage caps** — require-BYO means orgs spend their own money.
- **LLM token streaming** — runtime wraps whole calls in `RunEvent`s.
- **3rd+ providers (Gemini, Bedrock)** — additive later; interface proven by 2.
- **Generalizing `CredentialManager`** — protects connector REGRESSION paths.

## What already exists (reused, not rebuilt)

- `call-model.ts` chokepoint + dependency-cruiser quarantine (widened, not invented).
- `credential-encryption.ts` (generic seal/unseal) — reused directly.
- `ConnectorAccount` pattern (`@@unique([orgId,kind])`, `credentialsVersion` CAS) — the `OrgLlmCredential` template.
- `TeammateConfig` (currently dead) — routing fields fold into `OrgTeammateConfig`.
- `cost.ts` (already model-keyed, neutral-usage-shaped) — extended.
- `org-scope.ts` RLS — reused for tenant scoping.

---

## Worktree parallelization

| Lane | Phase | Modules | Depends on |
|---|---|---|---|
| A | P1 | `teammates/runtime/` | — |
| B | P2 | `teammates/runtime/providers/` | A (interface) |
| C | P3 | `prisma/`, `credential-*` (read-only reuse) | — |
| D | P4–P5 | `teammates/`, `teammates.module.ts` | A, B, C |

Lanes **A and C are independent → parallel worktrees.** B waits on A's interface.
D integrates all. Only D touches services/workers/module — no A/C overlap.
