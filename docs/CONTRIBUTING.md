# Contributing to getbeyond

Thanks for your interest in contributing. getbeyond is open source (AGPL-3.0-or-later
for the platform; MIT for the SDKs, clients, and the Chrome extension), and the whole
point of being open is that you can read every prompt and tool scope — and improve them.

You do **not** need write access to this repository. All contributions land through the
standard GitHub fork-and-pull-request flow described below.

---

## The contribution flow

1. **Fork** `naveenpaul/getbeyondai` on GitHub (the "Fork" button, or `gh repo fork`).
   This creates a copy under your own account that you *can* push to.

2. **Clone your fork and add the upstream remote:**

   ```bash
   gh repo fork naveenpaul/getbeyondai --clone   # forks + clones + sets up remotes
   cd getbeyondai
   # (manual equivalent:)
   # git clone https://github.com/<you>/getbeyondai.git
   # git remote add upstream https://github.com/naveenpaul/getbeyondai.git
   ```

3. **Branch off `main`** with a descriptive name:

   ```bash
   git checkout main
   git pull upstream main
   git checkout -b feat/zoominfo-adapter      # or fix/…, docs/…, chore/…
   ```

4. **Make your change**, with tests (see [Testing](#testing)).

5. **Push to your fork and open a PR against upstream `main`:**

   ```bash
   git push -u origin feat/zoominfo-adapter
   gh pr create --repo naveenpaul/getbeyondai --base main
   ```

> If you push directly to `naveenpaul/getbeyondai` and get
> `remote: Permission to naveenpaul/getbeyondai.git denied … 403`, that's expected —
> you're meant to push to **your fork**, not upstream. Re-check that `origin` points at
> your fork (`git remote -v`).

Keep your branch current by rebasing on upstream as needed:

```bash
git fetch upstream
git rebase upstream/main
```

---

## Local development

**Prerequisites:** Node `>=20.11`, pnpm `>=9` (`packageManager` is pinned to
`pnpm@9.12.0`), and Docker.

```bash
# 1. Bring up Postgres + MinIO
docker compose up -d

# 2. Install dependencies (pnpm workspace / turbo monorepo)
pnpm install

# 3. Configure env
cp .env.example .env                       # ANTHROPIC_API_KEY, BRAVE_SEARCH_API_KEY,
                                           # CREDENTIAL_MASTER_KEY, AUTH_SECRET, …
cp apps/web/.env.example apps/web/.env.local

# 4. Run migrations
pnpm --filter @getbeyond/api prisma:migrate

# 5. Run API (:3000) + web (:3001) in watch mode
pnpm dev
```

See the [README](../README.md) for the full quickstart, including the magic-link
sign-in and the optional `seed:dev` dev-org shortcut.

### Repo layout

| Path                       | What it is                                                  |
| -------------------------- | ----------------------------------------------------------- |
| `apps/api`                 | NestJS backend + Prisma (Postgres). Teammate runtime lives here. |
| `apps/web`                 | Next.js 15 web client.                                      |
| `extension`                | Chrome extension (LinkedIn). MIT-licensed.                  |
| `packages/shared`          | Types/contracts shared across apps.                         |
| `packages/ext-client`, `packages/personality-client` | Client SDKs. MIT-licensed.      |

---

## Writing an adapter (the common contribution)

The adapter architecture is designed so that adding a new **contact source** or
**write-back destination** is *one file plus one registry line, with zero changes
elsewhere*. If your CRM, outreach tool, or data vendor isn't supported yet, that's the
ideal first PR:

1. Implement the adapter file following an existing one as a template.
2. Add the single registry line that exposes it.
3. Add tests covering the happy path and the failure/empty-result cases.

---

## Testing

Well-tested code is non-negotiable here — prefer too many tests over too few.

```bash
pnpm test          # run the suite (turbo, all packages)
pnpm typecheck     # TypeScript type checks
pnpm lint          # lint
pnpm build         # full build
```

- Unit tests are co-located as `*.spec.ts`; integration tests as `*.integration.spec.ts`.
- Cover the happy path **and** error/edge cases. Tests must be independent and deterministic.
- New code is expected to meet the project's coverage bar (95% line coverage on
  `src/**/*.ts`, excluding bootstrap/wiring/DTO/generated code). PRs below the bar are
  blocked in CI.
- Mock external services (LLM, search, CRM APIs) — never hit live providers in tests.

A teammate-correctness rule that matters: **every claim a teammate writes must carry a
citation**, and the runtime drops uncited claims at synthesis time. If you touch
research/synthesis, keep that invariant covered by tests.

---

## Coding standards

- **Explicit over clever.** No `any` without a written justification; use DTOs with
  validation decorators; handle errors explicitly (no silent `catch {}`).
- **DRY** — flag and remove repetition.
- No magic strings (use constants/enums), no hardcoded secrets (env vars only),
  no commented-out code, no `console.log`/`print` in production code (use logging),
  no skipped tests.
- Run `pnpm format` (Prettier) before committing.
- Follow existing patterns in the area you're touching rather than introducing new ones.

---

## Commit & PR conventions

- Small, focused commits. Descriptive messages that explain **why**, not just what.
- Prefix branches/PR titles by type: `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`.
- Open the PR against `main`. Fill in what changed, why, and how you tested it.
- Make sure `pnpm test`, `pnpm typecheck`, and `pnpm lint` pass locally first.
- Sign your commits off (`git commit -s`) to certify the
  [Developer Certificate of Origin](https://developercertificate.org/).

### Licensing of contributions

By submitting a contribution you agree it is licensed under the same terms as the file(s)
it touches — **AGPL-3.0-or-later** for the platform, **MIT** for the SDKs/clients and the
Chrome extension. The AGPL choice is deliberate: it keeps the prompts and tool scopes
auditable and prevents closed-source forks from running them in a black box. If you're
embedding getbeyond into a closed-source commercial product and AGPLv3 doesn't fit,
open an issue to talk.

---

## Reporting bugs & proposing features

Open a GitHub issue with enough to reproduce (steps, expected vs. actual, env). For larger
features or new teammates, open an issue to discuss the design before investing in a big PR.

Questions are welcome — open a discussion or an issue and we'll help you get unblocked.
