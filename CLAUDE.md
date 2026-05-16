# CLAUDE.md — getbeyond

Project-specific instructions for Claude working in this repo. The full plan and
engineering context lives one level up at `../gtm_teammates_plan.md`. Read that
before doing non-trivial work.

---

## What this repo is

The open-source AI GTM teammates platform. AGPLv3 for the platform, MIT for SDKs
and the Chrome extension. Multi-user from day 1 (one Org, multiple Users, RLS
scoped on `orgId`). v1 ships Researcher + SDR Drafter + Content Drafter
teammates with HubSpot/Salesforce/Apollo/ZoomInfo/CSV connectors and
HubSpot/Salesforce write-back actions.

The trust positioning IS the moat: every claim a teammate writes has a citation,
the runtime drops uncited claims at synthesis, and the prompts are readable in
source.

## Engineering preferences

- **DRY is important** — flag repetition aggressively.
- **Well-tested code is non-negotiable** — prefer too many tests over too few.
  Default approach: write the failing test first, implement minimum code to pass,
  refactor, commit.
- **"Engineered enough"** — not fragile/hacky, not premature abstraction.
- **Handle more edge cases, not fewer** — thoughtfulness over speed.
- **Explicit over clever** — always.

## Architecture invariants (do not violate)

Read the full version in `../gtm_teammates_plan.md`. The non-negotiable ones:

1. **Teammates never touch the DB directly.** They call `packages/shared/teammate-tools`.
2. **Teammates never call adapters or connectors directly.** Data flows in via
   `Contact` / `ContactList` (read), out via `Draft` → `DraftAction` (write).
3. **All LLM calls go through one `callModel(prompt, tools, opts)` function.**
   Single chokepoint for logging, retries, budget enforcement, model routing.
4. **Every Claim has a `citationId` OR `abstained=true`.** Runtime drops violations.
5. **Vendor SDKs only in adapter files** (`apps/api/src/modules/connectors/adapters/<vendor>/*.ts`).
   ESLint enforces.
6. **Credentials never leave the adapter layer.** `EncryptedCredentials` decrypts
   only inside `adapter.execute()`.
7. **DraftAction is an outbox.** Strict ordering via `dependsOnId`. Worker
   advances state machine atomically. Idempotency keys on all CRM writes.
8. **Hard cost budget per AgentRun.** Exceeding aborts the run; user must raise it.

## NestJS dependency injection — pitfall

**Use explicit `@Inject(TypeName)` on constructor parameters, not the
parameter-property shorthand `constructor(private readonly svc: Type)`.**

vitest's TypeScript transform (esbuild) does NOT emit `design:paramtypes`
decorator metadata. NestJS DI reads that metadata to map a parameter type
to a provider — without it, parameter properties inject `undefined`. The
test passes via the production build (tsc + `emitDecoratorMetadata: true`)
but fails on every vitest integration run.

```typescript
// ❌ Works under tsc, breaks under vitest+esbuild — silent undefined injection.
constructor(private readonly prisma: PrismaService) {}

// ✅ Works in both. Manual assignment because @Inject can't decorate a
//    parameter-property in TS.
private readonly prisma: PrismaService;
constructor(@Inject(PrismaService) prisma: PrismaService) {
  this.prisma = prisma;
}
```

Same rule applies to services, controllers, workers, and any other DI-wired
class. The verbosity is a tax we pay so test + prod paths agree.

## Local development

**Local servers are managed by the user, not Claude.**

- Do NOT start dev servers (`pnpm dev`, `docker compose up`, etc.)
- Do NOT run migrations against running databases without explicit user request.
- Focus on code changes, tests, and builds only.

## Markdown file rules

Before creating any `.md` file:
1. Check if a relevant `.md` already exists.
2. If yes — ask the user whether to update it instead.
3. If no — ask before creating.

## Code quality

```typescript
// DO: explicit types, validation, error handling.
async findUser(id: string): Promise<User | null> { ... }
class CreateUserDto { @IsEmail() email: string; }
if (!user) throw new NotFoundException('User not found');

// DON'T: any, swallowed errors, magic strings.
async findUser(id): any { ... }                    // ❌
try { ... } catch (e) { }                          // ❌
if (status === 'pending') { ... }                  // ❌ — use enum
```

- No magic strings — constants or enums.
- No hardcoded secrets — env vars only.
- No commented-out code — git has history.
- No `console.log` in production code — use the project logger.
- No `any` unless truly unavoidable (and comment why).
- No skipped tests — fix or remove.

## Testing

- Unit: `*.spec.ts` co-located with source.
- Integration: `*.integration.spec.ts`.
- E2E: `test/*.e2e-spec.ts`.
- **95%+ line coverage** on `src/**/*.ts`, excluding:
  - `**/main.ts` (NestJS bootstrap entry; verified via E2E)
  - `**/*.module.ts` (module wiring, no logic)
  - `**/dto/**/*.ts` (decorator-only DTOs)
  - generated files (`prisma/generated/**`, `**/__generated__/**`)
  - Framework wrappers around third-party library clients where the substantive
    logic has been extracted to a tested pure function (e.g. `prisma.service.ts`
    delegates to `org-scope.ts`). The wrapper's runtime integration with the
    library is verified via integration tests against a real instance, not unit
    coverage. Add each excluded file individually to `vitest.config.ts` with a
    per-file comment explaining the integration-test plan.
- **100% coverage** on the 10 `REGRESSION-IF-BROKEN` paths from the eng-review pass-2 test plan: cross-source dedup, email normalization, tiered field precedence, OAuth refresh + token rotation, DraftAction strict ordering, BYO-key isolation, HubSpot idempotency-key, Apollo 401 mid-sync, refresh-rotation-lost (silent brick), advisory-lock concurrency.
- **CI coverage gate**: `pnpm test:coverage` runs vitest with `--coverage`. PR merge is blocked when global coverage <95% OR any `REGRESSION-IF-BROKEN` path drops below 100%. Configured in `vitest.config.ts` + GitHub Actions.
- Mock external services in unit tests; hit real test instances in integration.
- TDD by default: write the failing test first, implement minimum code to pass, refactor while green, commit.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool.

- Product ideas / brainstorming → `/office-hours`
- Strategy / scope → `/plan-ceo-review`
- Architecture → `/plan-eng-review`
- Full review pipeline → `/autoplan`
- Bugs / errors → `/investigate`
- QA / testing site behavior → `/qa` or `/qa-only`
- Code review / diff check → `/review`
- Visual polish → `/design-review`
- Ship / deploy / PR → `/ship` or `/land-and-deploy`
- Save progress → `/context-save`
- Resume context → `/context-restore`

## Definition of done

- [ ] Implementation matches requirements
- [ ] All new code has corresponding tests
- [ ] All tests pass (`pnpm test`)
- [ ] No linting errors (`pnpm lint`)
- [ ] No type errors (`pnpm typecheck`)
- [ ] Architecture invariants above are upheld (dependency-cruiser CI passes)
- [ ] Commit message describes WHY, not just WHAT
