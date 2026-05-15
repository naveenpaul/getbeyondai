import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { upsertContact } from './contact-upsert';
import { InvalidEmailError } from './identity';

/**
 * Integration tests for `upsertContact` (T1b, eng-review pass-2 D2 + codex T2).
 *
 * Required setup before running:
 *   1. `docker compose up -d postgres` (from `getbeyond/`)
 *   2. Create a TEST database (separate from your dev DB):
 *        `psql ... -c "CREATE DATABASE getbeyond_test"`
 *   3. Apply migrations to the test DB:
 *        `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/getbeyond_test \
 *         pnpm --filter '@getbeyond/api' prisma:migrate`
 *   4. Run integration tests:
 *        `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/getbeyond_test \
 *         pnpm --filter '@getbeyond/api' test:integration`
 *
 * Safety: this suite TRUNCATEs Contact / ContactEmail / ContactSource /
 * ConnectorAccount / Organization before each test. It will refuse to run
 * unless the database name contains the substring 'test'.
 */

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)(
  'upsertContact (integration — needs live Postgres + applied migrations)',
  () => {
    let prisma: PrismaClient;
    let orgA: string;
    let orgB: string;
    let hubspotA: string;
    let apolloA: string;
    let hubspotB: string;

    beforeAll(async () => {
      // Belt-and-suspenders: refuse to run against a non-test DB.
      const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!dbName.includes('test')) {
        throw new Error(
          `Integration tests refuse to run against database "${dbName}". ` +
            `Name must contain 'test' (e.g. getbeyond_test). ` +
            `Tests TRUNCATE every contact/connector table on each run.`,
        );
      }

      prisma = new PrismaClient({
        datasources: { db: { url: DATABASE_URL! } },
      });
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE
          draft_actions, claims, drafts,
          contact_sources, contact_emails, contact_list_members, contact_lists,
          contacts, sync_runs, connector_accounts,
          tool_calls, model_calls, citations, agent_runs,
          voices, company_brains, users, organizations
        RESTART IDENTITY CASCADE
      `);

      const o1 = await prisma.organization.create({ data: { name: 'OrgA' } });
      const o2 = await prisma.organization.create({ data: { name: 'OrgB' } });
      orgA = o1.id;
      orgB = o2.id;

      const a1 = await prisma.connectorAccount.create({
        data: {
          orgId: orgA,
          kind: 'hubspot',
          authMode: 'oauth',
          credentials: Buffer.from('test-sealed-hs-A'),
          scopes: ['contacts.read', 'contacts.write'],
        },
      });
      const a2 = await prisma.connectorAccount.create({
        data: {
          orgId: orgA,
          kind: 'apollo',
          authMode: 'byo_key',
          credentials: Buffer.from('test-sealed-apo-A'),
        },
      });
      const a3 = await prisma.connectorAccount.create({
        data: {
          orgId: orgB,
          kind: 'hubspot',
          authMode: 'oauth',
          credentials: Buffer.from('test-sealed-hs-B'),
          scopes: ['contacts.read'],
        },
      });
      hubspotA = a1.id;
      apolloA = a2.id;
      hubspotB = a3.id;
    });

    it('new email → creates Contact + primary ContactEmail + ContactSource', async () => {
      const result = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        externalUrl: 'https://app.hubspot.com/contacts/123/contact/hs_001',
        fields: { firstName: 'Sarah', title: 'VP Eng', company: 'Acme' },
        rawPayload: { source: 'hubspot', firstname: 'Sarah', jobtitle: 'VP Eng' },
      });

      expect(result.created).toBe(true);
      expect(result.sourceCreated).toBe(true);
      expect(result.contact.normalizedEmail).toBe('sarah@acme.com');
      expect(result.contact.firstName).toBe('Sarah');
      expect(result.contact.title).toBe('VP Eng');
      expect(result.contact.company).toBe('Acme');

      const emails = await prisma.contactEmail.findMany({
        where: { contactId: result.contact.id },
      });
      expect(emails).toHaveLength(1);
      expect(emails[0].isPrimary).toBe(true);
      expect(emails[0].normalizedEmail).toBe('sarah@acme.com');
      expect(emails[0].rawEmail).toBe('sarah@acme.com');

      const sources = await prisma.contactSource.findMany({
        where: { contactId: result.contact.id },
      });
      expect(sources).toHaveLength(1);
      expect(sources[0].sourceAccountId).toBe(hubspotA);
      expect(sources[0].externalId).toBe('hs_001');
      expect(sources[0].rawPayloadVersion).toBe(1);
    });

    it('same email second source → one Contact, two ContactSource (the moat)', async () => {
      const r1 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        fields: { title: 'VP Eng' },
        rawPayload: { source: 'hubspot' },
      });

      const r2 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: apolloA,
        sourceKind: 'apollo',
        externalId: 'apo_xyz',
        fields: { title: 'Head of Engineering' },
        rawPayload: { source: 'apollo' },
      });

      expect(r1.contact.id).toBe(r2.contact.id);
      expect(r1.created).toBe(true);
      expect(r2.created).toBe(false);
      expect(r2.sourceCreated).toBe(true);

      const sources = await prisma.contactSource.findMany({
        where: { contactId: r1.contact.id },
      });
      expect(sources).toHaveLength(2);
      expect(sources.map((s) => s.sourceAccountId).sort()).toEqual(
        [hubspotA, apolloA].sort(),
      );

      // T1 leaves Contact fields untouched on second source — per-field
      // precedence (D3) lands in T4. The title stays as the first sync set it.
      expect(r2.contact.title).toBe('VP Eng');
    });

    it('same source second sync → ContactSource updates, rawPayloadVersion increments', async () => {
      await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        rawPayload: { source: 'hubspot', v: 1 },
      });

      const r2 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        rawPayload: { source: 'hubspot', v: 2 },
      });

      expect(r2.created).toBe(false);
      expect(r2.sourceCreated).toBe(false);

      const sources = await prisma.contactSource.findMany({
        where: { contactId: r2.contact.id },
      });
      expect(sources).toHaveLength(1);
      expect(sources[0].rawPayloadVersion).toBe(2);
      expect(sources[0].rawPayload).toEqual({ source: 'hubspot', v: 2 });
    });

    it('REGRESSION-IF-BROKEN: 10 concurrent upserts → one Contact, advisory lock holds', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        upsertContact(prisma, {
          orgId: orgA,
          emailRaw: 'sarah@acme.com',
          sourceAccountId: hubspotA,
          sourceKind: 'hubspot',
          externalId: `hs_${i}`,
          rawPayload: { i },
        }),
      );

      const results = await Promise.all(promises);

      // All resolved to the same Contact id.
      const ids = new Set(results.map((r) => r.contact.id));
      expect(ids.size).toBe(1);

      // Exactly one Contact + one ContactEmail in the DB.
      const contacts = await prisma.contact.findMany({ where: { orgId: orgA } });
      expect(contacts).toHaveLength(1);
      const emails = await prisma.contactEmail.findMany({
        where: { contactId: contacts[0].id },
      });
      expect(emails).toHaveLength(1);

      // 10 ContactSource rows (different externalIds).
      const sources = await prisma.contactSource.findMany({
        where: { contactId: contacts[0].id },
      });
      expect(sources).toHaveLength(10);

      // Exactly one of the parallel callers created the Contact; rest found existing.
      const createdCount = results.filter((r) => r.created).length;
      expect(createdCount).toBe(1);
    });

    it('throws InvalidEmailError BEFORE opening a transaction (no partial state)', async () => {
      await expect(
        upsertContact(prisma, {
          orgId: orgA,
          emailRaw: 'not-an-email',
          sourceAccountId: hubspotA,
          sourceKind: 'hubspot',
          externalId: 'hs_x',
          rawPayload: {},
        }),
      ).rejects.toThrow(InvalidEmailError);

      const contacts = await prisma.contact.findMany({ where: { orgId: orgA } });
      expect(contacts).toHaveLength(0);
      const sources = await prisma.contactSource.findMany();
      expect(sources).toHaveLength(0);
    });

    it('normalizes plus + uppercase variants to match existing canonical record', async () => {
      const r1 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        rawPayload: {},
      });

      const r2 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'Sarah+Work@Acme.COM',
        sourceAccountId: apolloA,
        sourceKind: 'apollo',
        externalId: 'apo_xyz',
        rawPayload: {},
      });

      expect(r2.contact.id).toBe(r1.contact.id);
      expect(r2.created).toBe(false);
      expect(r2.sourceCreated).toBe(true);
    });

    it('different orgs with the same email → TWO Contacts (orgId scoping)', async () => {
      const r1 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        rawPayload: {},
      });

      const r2 = await upsertContact(prisma, {
        orgId: orgB,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotB,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        rawPayload: {},
      });

      expect(r1.contact.id).not.toBe(r2.contact.id);
      expect(r1.contact.orgId).toBe(orgA);
      expect(r2.contact.orgId).toBe(orgB);
    });

    it('REGRESSION-IF-BROKEN: subdomain ≠ apex (sarah@acme.com vs sarah@mail.acme.com)', async () => {
      const r1 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        rawPayload: {},
      });

      const r2 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@mail.acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_002',
        rawPayload: {},
      });

      expect(r1.contact.id).not.toBe(r2.contact.id);

      const contacts = await prisma.contact.findMany({ where: { orgId: orgA } });
      expect(contacts).toHaveLength(2);
    });

    // ─── T4: per-field precedence (D3 + codex T4 hardening) ──────────────

    it('T4: HubSpot title persists when Apollo sync arrives later (lower tier blocked)', async () => {
      const r1 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        fields: { title: 'VP Eng', company: 'Acme' },
        rawPayload: { source: 'hubspot' },
      });
      expect(r1.contact.title).toBe('VP Eng');

      const r2 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: apolloA,
        sourceKind: 'apollo',
        externalId: 'apo_xyz',
        fields: { title: 'Head of Engineering', company: 'Acme Corp' },
        rawPayload: { source: 'apollo' },
      });

      // Apollo (tier 25) cannot overwrite HubSpot (tier 50). Both fields stay.
      expect(r2.contact.title).toBe('VP Eng');
      expect(r2.contact.company).toBe('Acme');
    });

    it('T4: Apollo data is overwritten when HubSpot sync arrives later (higher tier wins)', async () => {
      const r1 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: apolloA,
        sourceKind: 'apollo',
        externalId: 'apo_xyz',
        fields: { title: 'Head of Engineering' },
        rawPayload: { source: 'apollo' },
      });
      expect(r1.contact.title).toBe('Head of Engineering');

      const r2 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        fields: { title: 'VP Eng' },
        rawPayload: { source: 'hubspot' },
      });

      // HubSpot (tier 50) overwrites Apollo (tier 25).
      expect(r2.contact.title).toBe('VP Eng');
    });

    it('T4: Apollo cannot null-out a populated HubSpot field', async () => {
      await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        fields: { title: 'VP Eng' },
        rawPayload: {},
      });

      const r2 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: apolloA,
        sourceKind: 'apollo',
        externalId: 'apo_xyz',
        fields: { title: null }, // Apollo doesn't know the title
        rawPayload: {},
      });

      expect(r2.contact.title).toBe('VP Eng');
    });

    it('T4: manual provenance entry blocks any vendor sync overwrite', async () => {
      // Simulate a Contact whose title was manually edited (provenance tier='manual').
      const r1 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        fields: { title: 'VP Eng' },
        rawPayload: {},
      });

      // Promote the title's provenance to manual (mimics a user edit endpoint).
      await prisma.contact.update({
        where: { id: r1.contact.id },
        data: {
          title: 'CEO',
          fieldProvenance: {
            title: {
              source: 'manual',
              tier: 'manual',
              updatedAt: new Date().toISOString(),
            },
          },
        },
      });

      // Now a HubSpot sync tries to overwrite.
      const r2 = await upsertContact(prisma, {
        orgId: orgA,
        emailRaw: 'sarah@acme.com',
        sourceAccountId: hubspotA,
        sourceKind: 'hubspot',
        externalId: 'hs_001',
        fields: { title: 'VP Eng (vendor)' },
        rawPayload: {},
      });

      expect(r2.contact.title).toBe('CEO');
    });
  },
);
