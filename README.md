# getbeyond

**Open-source AI GTM teammates for solo founders.** Test GTM on 1-5 accounts, find signal fast, then scale the pattern. Audit every prompt, every claim, every source — in code and in the app.

> Status: pre-launch. v1 in active development. See `../gtm_teammates_plan.md` for the full plan.

---

## What it is

A platform where solo founders run their GTM with **multiple AI teammates** under one runtime, each owning a workflow, all reading from a shared **Company Brain** (ICP, voice, offer, past wins, current pipeline).

The default motion is **rapid GTM testing**, not giant-workflow setup:

- pick 1-5 target accounts
- ask: "is this a fit?", "who's the right person?", "what should I say?"
- refine the targeting + message based on what you learn
- only then scale the winning pattern across larger lists and channels

The form factor matches the customer: solo founders do not need a giant RevOps project before they can learn what works. They need a fast loop from hypothesis → research → draft → approval → send → learning.

**v1 teammates:**

- **Researcher** — "tell me about this company/person" with cited sources
- **SDR Drafter** — outbound emails + LinkedIn DMs (drafts only, never auto-send)
- **Content Drafter** — LinkedIn/Twitter posts in your voice

**v1 data sources:** HubSpot, Salesforce, Apollo, ZoomInfo, CSV upload.
**v1 actions:** send via Gmail/Resend/Smartlead, post to LinkedIn/Twitter, log activity back to HubSpot/Salesforce.

## Why it exists

The AI SDR category is in trust collapse — 50-70% churn, hallucination is the killer. Closed-source tools have no way to prove they're not making things up. We do: every claim a teammate writes has a citation, the runtime drops uncited claims at synthesis time, and the prompts are AGPLv3 — you can read them.

Most GTM tools push founders toward big lead lists, bulk enrichment, and workflow setup before they know what message works. We think that is backwards. The job is to find signal quickly on a tiny set of accounts, learn what resonates, and then scale with confidence.

## Quickstart (self-host)

```bash
# Clone
git clone https://github.com/getbeyond/getbeyond.git
cd getbeyond

# Configure
cp .env.example .env
# Edit .env — fill ANTHROPIC_API_KEY, BRAVE_SEARCH_API_KEY,
# CREDENTIAL_MASTER_KEY + AUTH_SECRET (each: openssl rand -base64 32),
# CORS_ORIGIN, etc.

# Bring up Postgres + MinIO
docker compose up -d

# Install deps + run migrations
pnpm install
pnpm --filter @getbeyond/api prisma:migrate

# Optional: pre-create a dev Org so you can run a research session
# without the magic-link flow (useful for the test-keys flow).
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @getbeyond/api seed:dev   # paste IDs into apps/web/.env.local

# Run the API + the web client (turbo runs both in watch mode)
pnpm dev
```

API on `:3000`. Web on `:3001`.

**Sign in**: open `http://localhost:3001`, click "Try the Researcher", enter
your email, click "Send magic link". In dev the link prints to the API
process stdout — click it from there. First-time sign-in auto-creates an
Organization for your account. (Skip the magic-link step if you set the
`NEXT_PUBLIC_DEV_*` env vars from `seed:dev` — the legacy fallback path
still works for quick smoke tests.)

## One-click deploy to a server

```bash
# Agent-runnable installer (Claude Code, Codex, or any agent that can SSH)
# See deploy/Deployfile.md
```

Under 5 minutes from `ssh root@<ip>` to a working `/login` page, zero manual file editing.

## License

[AGPL-3.0-or-later](./LICENSE) for the platform. MIT for SDKs / clients / Chrome extension.

The trust positioning depends on readers being able to audit the prompts and tool scopes — AGPLv3 is the strongest license that protects against closed-source forks running our prompts in a black box. If you're embedding into a closed-source commercial product and AGPLv3 doesn't fit, talk to us.

## Contributing

The adapter architecture is designed so adding a new contact source or write-back destination is **one file, one registry line, zero changes elsewhere**. If your CRM / outreach tool / data vendor isn't listed, write the adapter and open a PR.

See `docs/CONTRIBUTING.md` (landing in Phase B).

## Project state

The full plan, including architecture decisions, eng review history, and the implementation task list, lives at `../gtm_teammates_plan.md`. Open decisions and deferred work are in `../TODOS.md`.
