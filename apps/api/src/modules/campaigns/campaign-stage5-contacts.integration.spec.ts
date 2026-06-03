import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { CampaignEvent, NormalizedContact } from '@getbeyond/shared';
import { CampaignOrchestrator } from './campaign-orchestrator';
import type { LlmProvider } from '../teammates/runtime/llm-provider';
import type { CreateMessageResult } from '../teammates/runtime/llm-types';
import type {
  CandidateCompany,
  SourcingProvider,
  SourcingResult,
} from '../connectors/sourcing/sourcing-provider';
import type { WaterfallConnector } from '../connectors/sourcing/waterfall-sourcing.service';
import type {
  runResearch,
  ResearchResult,
} from '../teammates/researcher/researcher.service';

/**
 * Integration coverage for Stage 5 (contact sourcing) against real Postgres.
 * Drives the REAL orchestrator + REAL upsertContact + REAL callModel through a
 * full run(): discover one company → qualify/rank (canned LLM + stubbed
 * Researcher) → Stage 5 waterfall (a fake connector) → assert the Contact +
 * ContactSource provenance + the CampaignCandidate↔Contact link land in the DB.
 * Proves the cross-cutting glue the unit tests stub: the join model + migration,
 * upsert provenance/tier, and org-global contact dedup across re-runs.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const ICP_JSON = JSON.stringify({
  summary: 'B2B SaaS, 11-50, seed',
  keywords: ['saas'],
  employeeCountMin: 11,
  employeeCountMax: 50,
  fundingStages: ['seed'],
  industries: ['software'],
  locations: ['US'],
});
const SCORE_JSON = JSON.stringify({ fitScore: 0.8, rationale: 'Strong match.' });

/** Canned LLM: first call returns the ICP, every later call returns the score. */
function cannedLlm(): LlmProvider {
  let calls = 0;
  return {
    name: 'fake',
    capabilities: {
      promptCaching: false,
      toolUse: true,
      systemPrompt: true,
    } as unknown as LlmProvider['capabilities'],
    createMessage: vi.fn(async (): Promise<CreateMessageResult> => {
      const text = calls++ === 0 ? ICP_JSON : SCORE_JSON;
      return {
        content: [{ type: 'text', text }],
        stopReason: 'end',
        usage: { inputTokens: 10, outputTokens: 10 },
        model: 'claude-sonnet-4-6',
      };
    }),
  };
}

function candidate(name: string, domain: string): CandidateCompany {
  return { name, domain, linkedinUrl: null, employeeCount: null, fundingStage: null, raw: {} };
}

function sourcingProvider(candidates: CandidateCompany[]): SourcingProvider {
  return {
    name: 'fake',
    findCandidates: async (): Promise<SourcingResult> => ({
      candidates,
      summary: `Read ${candidates.length}`,
    }),
  };
}

/** A Researcher that "completes" with a draftId that need not exist (readBrief falls back). */
function stubResearch(): typeof runResearch {
  return vi.fn(
    async (): Promise<ResearchResult> => ({
      runId: 'ignored',
      status: 'completed',
      draftId: 'no-such-draft',
      costCents: 0,
      toolCallCount: 0,
    }),
  ) as unknown as typeof runResearch;
}

const CONTACT: NormalizedContact = {
  emailRaw: 'dana@acme.com',
  externalId: 'https://linkedin.com/in/dana',
  externalUrl: 'https://linkedin.com/in/dana',
  firstName: 'Dana',
  lastName: 'Reed',
  title: 'VP Sales',
  company: 'Acme',
  linkedinUrl: 'https://linkedin.com/in/dana',
  emailVerification: 'verified',
  rawPayload: { src: 'snov' },
};

describe.skipIf(!DATABASE_URL)(
  'campaign Stage 5 contact sourcing (integration — needs live Postgres)',
  () => {
    let prisma: PrismaClient;
    let orgId: string;
    let snovAccountId: string;
    let campaignId: string;

    beforeAll(async () => {
      const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!dbName.includes('test')) {
        throw new Error(`Integration tests refuse to run against "${dbName}".`);
      }
      prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL! } } });
      await prisma.$connect();
    });

    afterAll(async () => {
      if (prisma) await prisma.$disconnect();
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE organizations, connector_accounts, campaigns, contacts,
          agent_runs RESTART IDENTITY CASCADE
      `);
      const o = await prisma.organization.create({ data: { name: 'OrgA' } });
      orgId = o.id;
      const snov = await prisma.connectorAccount.create({
        data: {
          orgId,
          kind: 'snov',
          authMode: 'byo_key',
          credentials: Buffer.from('x'),
        },
      });
      snovAccountId = snov.id;
      const campaign = await prisma.campaign.create({
        data: {
          orgId,
          title: 'C1',
          goal: 'Find SaaS lookalikes',
          createdBy: 'user-1',
          status: 'running',
        },
      });
      campaignId = campaign.id;
    });

    /** Build the orchestrator with a fake connector that yields `contacts`. */
    function orchestrator(contacts: NormalizedContact[]): CampaignOrchestrator {
      const events: CampaignEvent[] = [];
      const connector: WaterfallConnector = {
        kind: 'snov',
        accountId: snovAccountId,
        // eslint-disable-next-line @typescript-eslint/require-await
        async *sourceForCompany() {
          for (const c of contacts) yield c;
        },
      };
      return new CampaignOrchestrator({
        prisma,
        llm: cannedLlm(),
        buildSourcingProvider: async () =>
          sourcingProvider([candidate('Acme', 'acme.com')]),
        buildContactSourcers: async () => [connector],
        emitEvent: (e) => events.push(e),
        runResearch: stubResearch(),
      });
    }

    async function runOnce(): Promise<void> {
      const result = await orchestrator([CONTACT]).run({
        campaignId,
        orgId,
        triggeredBy: 'user-1',
        goal: 'Find SaaS lookalikes',
        winsListId: null,
        budgetCents: 100_000,
      });
      expect(result.status).toBe('completed');
      expect(result.candidateCount).toBe(1);
    }

    it('sources a contact, persists it with provenance, and links it to the candidate', async () => {
      await runOnce();

      const candidates = await prisma.campaignCandidate.findMany({
        where: { campaignId },
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.domain).toBe('acme.com');

      const contacts = await prisma.contact.findMany({ where: { orgId } });
      expect(contacts).toHaveLength(1);
      expect(contacts[0]!.normalizedEmail).toBe('dana@acme.com');
      expect(contacts[0]!.title).toBe('VP Sales');

      // Provenance: a ContactSource keyed to the Snov account.
      const sources = await prisma.contactSource.findMany({
        where: { contactId: contacts[0]!.id },
      });
      expect(sources).toHaveLength(1);
      expect(sources[0]!.sourceAccountId).toBe(snovAccountId);

      // The candidate↔contact link with source provenance.
      const links = await prisma.campaignCandidateContact.findMany({
        where: { campaignCandidateId: candidates[0]!.id },
      });
      expect(links).toHaveLength(1);
      expect(links[0]!.contactId).toBe(contacts[0]!.id);
      expect(links[0]!.sourceKind).toBe('snov');
      expect(links[0]!.emailVerification).toBe('verified');
    });

    it('dedupes the contact across re-runs (org-global identity), linking each candidate', async () => {
      await runOnce();
      // Re-run the same campaign: a second CampaignCandidate is created, but the
      // contact (same email) must NOT duplicate — upsert resolves to one row.
      campaignId = (
        await prisma.campaign.create({
          data: {
            orgId,
            title: 'C2',
            goal: 'again',
            createdBy: 'user-1',
            status: 'running',
          },
        })
      ).id;
      await runOnce();

      const contacts = await prisma.contact.findMany({ where: { orgId } });
      expect(contacts).toHaveLength(1); // org-global dedup by email

      const links = await prisma.campaignCandidateContact.findMany({
        where: { contactId: contacts[0]!.id },
      });
      expect(links).toHaveLength(2); // one per candidate across the two runs
    });
  },
);
