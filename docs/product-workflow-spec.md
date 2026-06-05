# Product Workflow & IA Spec

Status: draft, 2026-06-01. Owns the UX/IA layer that `gtm_teammates_plan.md`
(strategy, scope, scenarios) does not. When this and the master plan disagree on
product motion, the master plan's `## Product` section wins; this doc refines it
into surfaces and flows.

Companion: design audit at
`~/.gstack/projects/naveenpaul-getbeyond/designs/design-audit-20260601/` — the
findings this spec is meant to resolve.

---

## 1. Core model: a loop, not a pipe

The product is a **loop**, not a linear ETL pipeline. The temptation is to build
it as: connect source → connect destination → pull → research → export → done.
That is the RevOps-setup shape the positioning explicitly rejects (master plan
§Product: "solo founders can't afford a weeks-long RevOps setup before they get
an answer").

```
        ┌──────────── Company Brain (ICP · voice · offer · wins · materials) ───────────┐
        │                   seed once, refined by every review                          │
        ▼                                                                                │
 Source                Contacts             Teammates                Drafts              │
 type-in / CSV  ──▶    (start: 1-5)   ──▶   Researcher + SDR   ──▶   cited,              │
 HubSpot / Apollo                            run in PARALLEL          abstain-checked     │
                                                                          │              │
                                                        human review ◀────┘              │
                                                   approve / edit / reject ──────────────┘
                                                          │       (edits = learning → Brain)
                                                          ▼
                                              DraftAction outbox
                                       Send (Gmail/Resend) + write-back (HubSpot) / CSV export
```

### Four planes (keep them distinct)

| Plane | What it is | Filled by | Architecture anchor |
|---|---|---|---|
| **Data** | *Who* you're targeting | Connectors / CSV / type-in | `Contact` / `ContactList` |
| **Context** | *Who you are* — ICP, voice, offer, proof | Brain setup (URLs, uploads, Q&A) | **Company Brain** |
| **Workers** | Read Data + Context, produce drafts | n/a (run on demand) | Teammates (read Contacts only) |
| **Outbox** | Send + write-back | Approval queue actions | `DraftAction` |

The most common modeling mistake: treating the **Brain as the ingestion pump**.
It is not. The Brain is the *context lens*. Connectors fill the **Data** plane
(`Contact` rows); the Brain is the durable **Context** plane that every run reads.

---

## 2. What a "source" actually is

A source is fundamentally **a list of contacts** — but it does two jobs, and CSV
vs CRM diverge on the second.

| | CSV upload | HubSpot / Salesforce |
|---|---|---|
| Direction | One-way (import) | Two-way (live sync) |
| Gives you | A static list of rows | List + CRM context (stage, owner, last activity, notes) |
| Write-back | None — export a *new* CSV | Same connector is the destination |
| Lifespan | Snapshot | Living connection |

**Everything normalizes to `Contact` rows at import time. Teammates only ever see
Contacts — never the source.** "Source" is an import-time concept, not a runtime
one. This is why the architecture invariant holds: teammates never call
connectors directly.

**The research material does not come from the source.** The source supplies the
*who* + CRM-known fields. The Researcher goes to the open web (Brave Search,
fetched pages, LinkedIn via the extension) for the cited claims.

---

## 3. The Company Brain: context corpus + the research lens

The Brain is the durable context every teammate reads. Your insight that pushes
it upstream: **the Brain serves the Researcher, not just the SDR Drafter.**

### Two homes for material

- **Your materials** (site, pricing page, docs, deck, case studies, past winning
  emails) → **Brain corpus**, durable, reused on every run. Fetched, stored, and
  retrievable. The product extracts ICP / offer / voice from them.
- **Per-run extra context** → optional one-off slot for material relevant to a
  single campaign, so it doesn't pollute the permanent Brain. Brain is the
  default; per-run is the escape hatch.

### Derived ICP promotion

The first useful Prospect Search can derive an ICP from the founder's goal plus a
wins list. That derived ICP should be reviewable and promotable into
`CompanyBrain.icp`, with provenance back to the source search, wins list, and
derivation run. Future searches should start from the saved Brain ICP unless the
user chooses a new wins list or edits explicit ICP criteria; per-search ICP
snapshots remain as audit records.

### Trust model extends to your own materials

The cite-or-abstain rule already governs claims about the target. Pointed at the
Brain corpus, it governs claims about **you**: a draft line like "we cut
onboarding time 40%" must cite the user's own case-study page, or it is dropped /
flagged abstained. The founder cannot accidentally ship puffery the drafter
invented about their own product. "Every claim, every source" now covers both
sides of the email.

---

## 4. The Researcher output: a fit brief, not a dossier

The Brain turns generic research into GTM research.

- **Without context:** "Tell me about Acme" → a Wikipedia-ish summary. True,
  cited, mostly useless for GTM.
- **With the Brain corpus as a lens:** the brief answers a founder's real
  questions.

**Fit brief output shape:**

1. **Fit** — does this account match your ICP? Score + reasoning, cited.
2. **Angle** — what in the target's world maps to your offer (a job posting, a
   tech-stack signal, a recent launch), cited.
3. **Hooks** — specific, citeable things to reference in outreach.
4. **Disqualifiers** — reasons not to spend time here.

A research run takes two contexts — **who they are** (web, fetched live) and
**who you are** (Brain corpus, durable) — and the brief is the intersection:
*is this a fit for you, and what's the angle.*

---

## 5. First-run journey: win → act → personalize → learn → scale

Entry model: **type-in-first** (zero connectors to first value). Connectors are
the scale accelerator, not the front door. (Open decision — see §8.)

**Beat 1 — A win in 60 seconds, zero setup.**
Land on one input: *"Who do you want to learn about?"* Type a company name or
paste a domain. Researcher streams a cited brief. Every claim has a citation chip;
unsourced claims dropped / flagged abstained. Footer shows run cost ("4¢").

**Beat 2 — Turn knowing into doing.**
From the brief: *"Draft outreach using this →"*. SDR Drafter writes a cold email,
every line traceable to a claim. Review: approve / edit / reject.

**Beat 3 — Make it sound like them (Brain enters here, lazily).**
First draft reads generic. That's the moment to introduce the Brain:
*"Connect your site to make this sharper →"*. They paste a URL. **This is the
single best onboarding action** — fastest Brain-seed AND most visible quality
upgrade in one move.

**Beat 1, redux — the before/after.**
The same target, re-researched through their offer, returns as a *fit brief*. The
quality jump motivates Brain investment by showing it, not asking on faith.

**Beat 4 — The edit is the lesson.**
An edit to a draft is signal: *"Got it — I'll remember you lead with X."* Feeds
the Brain and the targeting hypothesis. The loop closes.

**Beat 5 — Scale the winner (connectors appear NOW).**
Once a message + targeting pattern lands: *"Run this for more like them? Import a
CSV or connect HubSpot."* Batch-run, review inbox fills, export back to HubSpot /
download CSV, send via Gmail/Resend.

**Brain enters at "personalize," connectors enter at "scale," nothing blocks the
first win.** Never make the Contacts table or a CRM connection the first thing a
new user sees — that is Beat 5 masquerading as Beat 1.

---

## 6. Information architecture (the app shell)

The journey dictates the nav. Replace the static Workbench-tiles hub + ad-hoc
back-links with one **persistent app shell** in `apps/web/src/app/layout.tsx`,
current-section highlighted:

```
Brain · Contacts · Researcher · SDR Drafter · Drafts        [user menu]
```

- **Home** = a real workspace, not a launcher: pending-draft count, recent runs,
  in-flight work. (Resolves audit FINDING-003.)
- **Brain** = the context surface that is currently absent. (Resolves FINDING-004.)
- **Connectors / source setup** = under Settings, surfaced *contextually* at the
  scale moment ("Import 50 more like this →"), never as an entry gate.
- **Drafts** = one inbox with real approve / edit / reject / send actions; one
  canonical draft-detail route (collapse `/draft/sdr/[runId]` and `/drafts/[id]`).
  (Resolves FINDING-005, FINDING-008.)
- Post-login lands on the type-in / workspace, not a deep form. (FINDING-009.)

A persistent shell subsumes audit FINDING-001, FINDING-002 (the two wrong
back-links), and most of FINDING-006.

---

## 7. How this resolves the design audit

| Audit finding | Resolved by |
|---|---|
| 001 No persistent nav | §6 app shell |
| 002 Wrong back-links | §6 app shell (removes ad-hoc back-links) |
| 003 Workbench is a launcher | §6 home as workspace |
| 004 No Brain surface | §3, §6 Brain in nav |
| 005 Loop dead-ends at review | §1, §6 review actions in Drafts |
| 006 Inconsistent page template | §6 shared shell + page header |
| 008 Duplicate draft detail views | §6 one canonical route |
| 009 Post-login lands on deep form | §5 Beat 1 / §6 |

---

## 8. Open decisions

1. **Entry-model wedge** — type-in-first (this spec's assumption) vs HubSpot/CSV-
   first vs both-with-type-in-default. Decides whether connectors are central or
   peripheral to v1. *Unresolved.*
2. Brain corpus retrieval mechanics (chunking, embedding, citation granularity
   for user materials) — defer to eng spec.
3. Per-run extra-context UI — needed in v1 or v2?
4. Fit-brief scoring — qualitative reasoning only, or a numeric fit score?

---

## 9. Next step

Run this through `/plan-design-review` (IA/nav focus) before any code. The
app-shell in §6 is the highest-leverage build and should land first.
