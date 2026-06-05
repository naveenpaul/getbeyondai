# GetBeyond Product Audit Findings

Date: 2026-06-04

Scope: repository audit of `getbeyond` for product gaps, likely bugs, and dead-end code that may need removal or either a product owner decision.

## Executive summary

The codebase is in a coherent pre-launch state, but several surfaces described as v1 product capability are not actually usable end to end yet. The largest product gaps are: no Company Brain surface/API despite schema and positioning, no Content Drafter runtime despite README claims, a read-only Drafts inbox with no approve/edit/reject/send controller, and a prospect-search source-attachment flow that is described in comments but not implemented in the workspace.

The strongest confirmed bug is CI/build hygiene: `pnpm typecheck` currently fails in API spec files. Unit tests pass.

## Verification run

- `pnpm test`: passed. `@getbeyond/shared` 9 tests, `@getbeyond/api` 762 tests.
- `pnpm typecheck`: failed in `@getbeyond/api`.
- `pnpm depcruise`: completed with 6 warnings and 0 errors. The app/component warnings inspected here are mostly false positives from Next/app entry points and alias imports.

## Findings

### 1. Typecheck currently fails

Severity: High

`pnpm typecheck` exits non-zero in `@getbeyond/api`, so a normal CI quality gate would fail even though the unit suite passes.

Evidence:

- `apps/api/src/modules/prospect-search/prospect-search-orchestrator.spec.ts:231` casts a fake capabilities object that lacks the current `ProviderCapabilities` fields `parallelToolUse` and `caching`.
- `apps/api/src/modules/teammates/runtime/providers/openai.provider.spec.ts:87` indexes the last mock call without guarding the empty-call case.
- `apps/api/src/modules/teammates/runtime/providers/openai.provider.spec.ts:251` assumes `tool_calls[0].function`, but the OpenAI SDK type is now a union where not every tool call has `function`.

Recommendation: update the test fakes/type guards to match `ProviderCapabilities` and the current OpenAI SDK union types. This is likely low-risk because failures are in specs, not production paths, but it blocks typecheck.

### 2. README promises v1 capabilities that are not wired

Severity: High

The README says v1 includes Content Drafter, Salesforce, Gmail/Resend/Smartlead, LinkedIn/Twitter posting, and HubSpot/Salesforce write-back. The shipped routes/modules do not support those end-to-end.

Evidence:

- README v1 claims are at `README.md:22-29`.
- `apps/api/src/modules/teammates/teammates.module.ts:26-43` registers only `ResearcherController`, `SdrDrafterController`, `ResearcherWorker`, and `SdrDrafterWorker`.
- Content Drafter currently appears only as prompts/specs under `apps/api/src/modules/teammates/content-drafter/`; there is no controller, worker, web route, or nav item.
- Draft destination registry notes that only `ArchiveDestination` is real and `EchoDestination` is test-only for other action kinds in `apps/api/src/modules/drafts/destination-registry.ts:28-39`.

Recommendation: either downgrade README wording to "planned" or complete the missing v1 paths. Leaving this as-is will mislead testers and contributors.

### 3. Company Brain exists in schema and positioning but has no usable surface

Severity: High

The product positioning says every teammate reads from a shared Company Brain. The schema has `CompanyBrain` and `Voice`, but there is no Brain module, controller, web route, or nav item.

Evidence:

- README positions shared Company Brain as core at `README.md:11`.
- `apps/api/prisma/schema.prisma:204-238` defines `CompanyBrain` and `Voice`.
- `apps/web/src/components/AppNav.tsx:51-58` exposes Prospects, Contacts, Researcher, SDR Drafter, and Drafts, but no Brain.
- `apps/api/src/app.module.ts:37-39` still lists `company-brain` as a future module.
- `rg` only finds Company Brain usage in schema, docs, and tests/truncation lists, not in application controllers/services.

Recommendation: treat this as a product-blocking gap if Brain is part of the MVP. Otherwise, remove or soften Brain claims until the module and UI exist.

### 4. Draft review is a dead end for users

Severity: High

Drafts can be listed and viewed, but the approval queue cannot actually approve, edit, reject, or send from the product UI/API.

Evidence:

- `apps/api/src/modules/drafts/drafts.controller.ts:18-27` explicitly documents the controller as read-only and says edit/approve/reject/send are future work.
- `apps/web/src/app/drafts/page.tsx` only filters and links to detail views.
- `apps/web/src/app/drafts/[id]/page.tsx` renders content and claims but provides no mutation controls.
- `apps/api/src/modules/drafts/draft-action.worker.ts` can process existing `DraftAction` rows, but no DraftAction creation controller was found.

Recommendation: add a DraftAction controller and UI controls for at least reject/archive and approve/send, or relabel Drafts as an audit/read-only output list. This is the clearest loop break against "draft -> approval -> send -> learning."

### 5. Prospect search starts without a source, then has no in-workspace source attachment path

Severity: Medium-High

The composer always submits `sourcing: null`; comments say the source is attached later in the Prospects workspace. The workspace does not expose that attachment path, and the orchestrator completes gracefully with zero prospects when no source is available.

Evidence:

- `apps/web/src/components/ProspectSearchComposer.tsx:54-59` hardcodes `sourcing: null`.
- `apps/api/src/modules/prospect-search/prospect-search-orchestrator.ts:262-268` completes with "No prospect source attached..." and zero prospects.
- `apps/web/src/app/prospects/[id]/page.tsx:158-163` passes `sourcing={null}` to `ConnectedToolsSidebar` because detail does not echo source config yet.
- `apps/web/src/app/prospects/[id]/page.tsx` has re-run controls, but no "attach source/import list/connect Apollo and resume" action.

Recommendation: either let the composer select a source before first run, or implement source attachment/rerun from the detail workspace. Today, a user can create a completed search with zero prospects and only infer the next action from banners or transcript text.

### 6. Production invite flow throws instead of sending email

Severity: Medium

Org invites work in development by printing links to stdout, but non-development delivery is intentionally unwired and throws.

Evidence:

- `apps/api/src/modules/invites/invites.service.ts:40-69` documents "prod = Resend (later)" and throws in production.

Recommendation: wire Resend or hide/disable org invites in production until delivery exists. This is acceptable in pre-launch, but it is a known product gap for any hosted environment.

### 7. `TeammateConfig` appears to be a dead schema model

Severity: Medium

`TeammateConfig` remains in the Prisma schema but is superseded by `OrgTeammateConfig` and has no application code usage.

Evidence:

- `apps/api/prisma/schema.prisma:408-420` defines `TeammateConfig`.
- `docs/plans/llm-provider-abstraction.md` calls it "currently dead" and notes routing moved to `OrgTeammateConfig`.
- `rg` finds application usage of `OrgTeammateConfig` in LLM settings/resolution, but no production usage of `TeammateConfig`.

Recommendation: remove the model and migration/table if no longer needed, or add a clear comment that it is retained for backward compatibility. Right now it is schema noise that suggests a routing path that no longer exists.

### 8. Content Drafter prompt code is currently a dead-end implementation slice

Severity: Medium

Content Drafter prompt builders and tests exist, but there is no runtime integration.

Evidence:

- `apps/api/src/modules/teammates/content-drafter/content-drafter.prompts.ts` and its spec exist.
- `apps/api/src/modules/teammates/teammates.module.ts:26-43` does not register a Content Drafter controller or worker.
- `apps/web/src/components/AppNav.tsx:51-58` has no Content Drafter route.

Recommendation: either finish the teammate slice or move the prompt-only code into a clearly marked experimental/plans area. If the README keeps claiming Content Drafter as v1, this should be implemented rather than removed.

### 9. Dependency-cruiser orphan warnings need pruning or config tuning

Severity: Low

`pnpm depcruise` reports six warnings:

- `apps/web/src/lib/prospect-search-transcript.ts`
- `apps/web/src/lib/csv-preview.ts`
- `apps/web/src/components/ConnectedToolsSidebar.tsx`
- `apps/api/vitest.coverage.config.ts`
- `apps/api/scripts/snov-probe.ts`
- `apps/api/scripts/apollo-people-probe.ts`

Inspection showed the first three are actually imported through the app/component graph, so these are likely dependency-cruiser config limitations with Next aliases or route entry points. The probe scripts may be useful operational tools, but they are not part of product runtime.

Recommendation: tune dependency-cruiser config for Next app entry points and path aliases. For scripts, either keep under an explicitly ignored `scripts/` policy or archive/remove probes that are no longer maintained.

## Suggested cleanup order

1. Fix `pnpm typecheck` failures.
2. Decide whether README describes current shipped product or target v1; update wording or implementation.
3. Close the Drafts dead end with at least reject/archive and approve/send action creation.
4. Add a real Brain module/surface or remove Brain from current-product messaging.
5. Add prospect source attachment in the workspace or make source selection part of the initial composer.
6. Remove or explicitly retain `TeammateConfig`.
7. Either complete Content Drafter runtime integration or mark prompt code as planned/experimental.

