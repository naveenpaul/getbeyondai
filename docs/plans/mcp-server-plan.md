# MCP Server Plan — getbeyond as a remote connector for ChatGPT & Claude

**Status:** Draft for review
**Author:** (spec generated for review per CLAUDE.md "spec first")
**Decisions locked:** Target **both** ChatGPT and Claude surfaces · **Full OAuth 2.1** authorization server · spec before code.

---

## 1. Goal

Let an end user open their own ChatGPT or Claude account, add getbeyond as a connector, authenticate as themselves, and use getbeyond's GTM capabilities (prospect search, company research, contact lookup, email drafting) as tools — without leaving the chat.

Non-goals (v1): UI components / Apps SDK rendering, write-back to external CRMs via MCP, multi-org token switching inside one connection.

---

## 2. What "remote connector" requires

Both platforms drive the **client** side of MCP. To be addable from a hosted ChatGPT/Claude account, the server must satisfy all of:

1. **Streamable HTTP transport** (single endpoint, e.g. `POST /mcp`). The legacy HTTP+SSE transport is deprecated — do not build on it.
2. **Public HTTPS** with valid TLS (fits existing nginx + Let's Encrypt; add `/mcp` + `/.well-known/*` locations).
3. **OAuth 2.1 authorization** per the MCP Authorization spec:
   - Protected Resource Metadata at `/.well-known/oauth-protected-resource`
   - Authorization Server Metadata at `/.well-known/oauth-authorization-server`
   - Authorization Code flow with **PKCE** (S256)
   - **Dynamic Client Registration** (RFC 7591) — both clients register themselves; we cannot pre-provision their client IDs.
   - Bearer access tokens on every `/mcp` request; `401` + `WWW-Authenticate` pointing at the metadata when missing/expired.
4. **ChatGPT connector contract:** expose tools named exactly `search` and `fetch` (thin wrappers over our domain tools) so ChatGPT's connector/deep-research mode works. Richer domain tools are additive and ignored by that mode but used by Claude and the Apps surface.

---

## 3. Architecture

Add a single NestJS module inside `apps/api` (not a separate process). Reuses existing services via DI, shares DB/session model, deploys in the API container.

```
apps/api/src/modules/mcp/
├── mcp.module.ts
├── mcp.controller.ts            # POST /mcp — bridges Fastify req/res to the SDK transport
├── mcp-server.factory.ts        # builds McpServer, registers tools per-request (scoped to user)
├── mcp-auth.guard.ts            # validates bearer access token -> CurrentUser
├── tools/
│   ├── search.tool.ts           # ChatGPT contract
│   ├── fetch.tool.ts            # ChatGPT contract
│   ├── search-prospects.tool.ts
│   ├── research-company.tool.ts
│   ├── list-contacts.tool.ts
│   ├── get-contact.tool.ts
│   └── draft-email.tool.ts      # write — scope-gated, off by default
└── oauth/
    ├── well-known.controller.ts # protected-resource + AS metadata
    ├── register.controller.ts   # RFC 7591 dynamic client registration
    ├── authorize.controller.ts  # /oauth/authorize -> reuse existing login/consent
    ├── token.controller.ts      # /oauth/token — PKCE exchange + refresh
    └── consent.*                # consent screen + scope grant persistence
```

**SDK:** `@modelcontextprotocol/sdk` (TypeScript). Use `McpServer` + the Streamable HTTP transport, adapted to a Fastify route handler. Protocol framing handled by the SDK; auth handled by our NestJS guard.

**Token model:** the OAuth access token IS (or maps 1:1 to) an existing getbeyond session/JWT. The AS issues it; `mcp-auth.guard` resolves it to `CurrentUser` exactly like the existing `auth.guard`. Reuse `CurrentUser` decorator so tools get the authenticated user with zero new plumbing inside services.

---

## 4. The async-job problem (important)

`prospect-search`, `researcher`, and `sdr-drafter` are **enqueue → poll/stream** jobs. MCP tool calls are request/response (with optional progress notifications). Three options per tool:

| Pattern | When | Tradeoff |
|---|---|---|
| **Block-and-poll inside the tool** | jobs that finish in seconds (contact lookup, cached research) | simplest UX; risks hitting client timeouts on long jobs |
| **Progress notifications** | medium jobs; SDK supports `notifications/progress` | better UX, more code; client support varies |
| **Two-call (start + get_result)** | long jobs (full prospect search, deep research) | robust; the model calls `start_*` then `get_*_result` later |

**Decision for v1:** read-only lookups (`get_contact`, `list_contacts`, ChatGPT `fetch`) block-and-poll with a hard timeout. Long jobs (`search_prospects`, `research_company`) use the **two-call pattern** (`start_*` returns a job id; `get_*` returns status/result), with a convenience single-call wrapper that polls up to ~25s then returns "still running, call get_* with id=…". This keeps us under connector timeouts and degrades gracefully.

---

## 5. Tool catalog (v1)

All inputs are JSON Schema; all tools run as the authenticated user (org-scoped, ownership-checked by the underlying service — no new auth logic in tools).

### ChatGPT contract
- `search({ query: string })` → `{ results: [{ id, title, url, snippet }] }`. Routes to prospect/contact/company search depending on query; ids are opaque getbeyond URIs.
- `fetch({ id: string })` → full record for an id returned by `search`. Read-only.

### Domain tools (Claude + Apps)
- `search_prospects` — wraps `ProspectSearchService.create` + result fetch (two-call pattern). Inputs mirror the create DTO (ICP/filters). Read-only.
- `research_company` — wraps `researcher` enqueue + getRun. Inputs: company name/domain. Two-call. Read-only.
- `list_contacts` / `get_contact` — wrap `ContactsService.list` / `lookup`. Block-and-poll. Read-only.
- `draft_email` — wraps `sdr-drafter` enqueue + getRun. **Write-class** (produces a draft; does not send). Behind the `drafts:write` scope, **off by default**; user must grant at consent.

> Map each tool 1:1 to an existing service method. No new business logic in the MCP layer — it is a protocol + auth adapter only.

---

## 6. OAuth 2.1 authorization server (the bulk of the work)

Endpoints:
- `GET /.well-known/oauth-protected-resource` — advertises the resource + its AS.
- `GET /.well-known/oauth-authorization-server` — issuer, endpoints, supported PKCE/grant types, scopes.
- `POST /oauth/register` — RFC 7591 dynamic client registration; store client metadata, issue `client_id` (public client, no secret for these connectors).
- `GET /oauth/authorize` — PKCE; if not logged in, reuse existing login (email+password baseline / magic-link); then **consent screen** listing requested scopes; issue auth code.
- `POST /oauth/token` — exchange code+verifier → access token (+ refresh). Also handles refresh grant.

**Scopes (v1):** `prospects:read`, `research:read`, `contacts:read`, `drafts:write`. Default-grant the read scopes; `drafts:write` opt-in on the consent screen.

**Self-host vs Cloud:** the MCP module + tools live in the **open core**. The AS runs in a simplified single-tenant mode for self-hosters (one org, minimal consent UI) and a hardened mode for Cloud (rate limiting, client management, full consent/audit). Same code path, config-gated — same pattern as the Apollo self-host/Cloud split.

**Consider:** front the AS with a vetted OAuth library or IdP rather than hand-rolling token issuance/crypto, to cut footguns. Evaluate before building from scratch.

---

## 7. Security

- Every `/mcp` request passes `mcp-auth.guard`; expired/missing → `401` + `WWW-Authenticate`.
- Tools never widen access: they call services that already enforce org ownership. Add an explicit test that user A cannot read user B's prospects via any tool.
- Write tool (`draft_email`) gated by scope AND never sends — produces a draft only. No send/sync tools in v1 (matches trust posture; the category's failure mode is silent autonomous action).
- Rate-limit `/oauth/*` (Cloud) — reuse existing auth rate-limiting posture.
- No secrets in tool outputs or logs. PKCE S256 only; reject `plain`.
- DCR abuse: cap registrations, expire unused clients (Cloud).

---

## 8. Testing strategy (per CLAUDE.md, ≥95% on src)

- **Unit:** each tool's input validation + service-call mapping (mocked services). Error cases: invalid input, job failure, timeout.
- **Integration:** full OAuth dance (register → authorize → token → call `/mcp`) against the test DB; the ownership-isolation test; the two-call async pattern; ChatGPT `search`/`fetch` shape conformance.
- **Protocol conformance:** `initialize`, `tools/list`, `tools/call` happy paths via the SDK transport.
- Flag the OAuth token-exchange + ownership-isolation paths `REGRESSION-IF-BROKEN` (100% coverage).

---

## 9. Effort / phasing

- **Phase 1 — Tool surface (read-only) behind a static dev token.** Build the `mcp` module, transport mount, `search`/`fetch` + read tools, async two-call pattern, tests. Validates the whole tool layer without OAuth. *Small.*
- **Phase 2 — OAuth 2.1 AS.** Discovery, DCR, PKCE, authorize/consent/token, guard. *The bulk.*
- **Phase 3 — Connect & verify** from a real Claude connector and a real ChatGPT connector; fix the platform-specific shape issues; harden Cloud mode.
- **Phase 4 — `draft_email` write tool** behind `drafts:write`, with consent + audit.

---

## 10. Open questions

1. Front the AS with a library/IdP, or hand-roll? (Recommend evaluating a library first.)
2. Single convenience wrapper vs strict two-call for long jobs — pick per measured job latency.
3. Cloud consent screen scope: minimal vs full audit log in v1.
4. Do we also expose this via the Claude API `mcp_servers` param to our own backend (dogfood), or only to external accounts?
