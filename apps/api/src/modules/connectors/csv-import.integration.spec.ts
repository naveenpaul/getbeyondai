import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCsvImport } from './csv-import.service';

/**
 * Integration tests for runCsvImport (T8-CSV.2a).
 *
 * Setup is the same as contact-upsert.integration.spec.ts — see that file's
 * header for the required environment + safety guard. This suite shares the
 * test DB and TRUNCATEs the relevant tables before each test.
 */

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)(
  'runCsvImport (integration — needs live Postgres + applied migrations)',
  () => {
    let prisma: PrismaClient;
    let orgA: string;
    let orgB: string;
    let csvAccountA: string;
    let csvAccountB: string;

    beforeAll(async () => {
      const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!dbName.includes('test')) {
        throw new Error(
          `Integration tests refuse to run against database "${dbName}". ` +
            `Name must contain 'test' (e.g. getbeyond_test).`,
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
          kind: 'csv',
          authMode: 'upload',
          credentials: Buffer.from(''), // CSV has no real credentials
        },
      });
      const a2 = await prisma.connectorAccount.create({
        data: {
          orgId: orgB,
          kind: 'csv',
          authMode: 'upload',
          credentials: Buffer.from(''),
        },
      });
      csvAccountA = a1.id;
      csvAccountB = a2.id;
    });

    it('happy path: 3-row CSV → 3 Contacts + SyncRun completed', async () => {
      const csv = [
        'Email,First Name,Company',
        'sarah@acme.com,Sarah,Acme',
        'tom@beta.com,Tom,Beta',
        'priya@gamma.org,Priya,Gamma',
      ].join('\n');

      const result = await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: csv },
        columnMapping: { email: 'Email', firstName: 'First Name', company: 'Company' },
        triggeredBy: 'usr_test',
      });

      expect(result.recordsIn).toBe(3);
      expect(result.recordsOut).toBe(3);
      expect(result.errorCount).toBe(0);
      expect(result.syncRun.status).toBe('completed');

      const contacts = await prisma.contact.findMany({ where: { orgId: orgA } });
      expect(contacts).toHaveLength(3);
      expect(contacts.map((c) => c.normalizedEmail).sort()).toEqual([
        'priya@gamma.org',
        'sarah@acme.com',
        'tom@beta.com',
      ]);

      const sources = await prisma.contactSource.findMany({
        where: { sourceAccountId: csvAccountA },
      });
      expect(sources).toHaveLength(3);
      // All externalIds are namespaced with the SyncRun id.
      expect(sources.every((s) => s.externalId.startsWith(`csv:run:${result.syncRun.id}:row:`))).toBe(
        true,
      );
    });

    it('happy path also creates a ContactList of all imported contacts', async () => {
      const csv = [
        'Email,First Name,Company',
        'sarah@acme.com,Sarah,Acme',
        'tom@beta.com,Tom,Beta',
        'priya@gamma.org,Priya,Gamma',
      ].join('\n');

      const result = await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: csv },
        columnMapping: { email: 'Email', firstName: 'First Name', company: 'Company' },
        triggeredBy: 'usr_test',
        listName: 'Q2 prospects',
      });

      expect(result.listId).not.toBeNull();

      const list = await prisma.contactList.findUniqueOrThrow({
        where: { id: result.listId! },
      });
      expect(list.orgId).toBe(orgA);
      expect(list.name).toBe('Q2 prospects');
      expect(list.source).toBe(`csv:upload:${result.syncRun.id}`);
      expect(list.createdBy).toBe('usr_test');
      expect(list.contactCount).toBe(3);

      const members = await prisma.contactListMember.findMany({
        where: { listId: list.id },
      });
      expect(members).toHaveLength(3);

      // Every imported Contact is a member of the list.
      const contacts = await prisma.contact.findMany({ where: { orgId: orgA } });
      expect(members.map((m) => m.contactId).sort()).toEqual(
        contacts.map((c) => c.id).sort(),
      );
    });

    it('list name defaults when none supplied', async () => {
      const result = await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: ['Email', 'sarah@acme.com'].join('\n') },
        columnMapping: { email: 'Email' },
        triggeredBy: 'usr_test',
      });

      const list = await prisma.contactList.findUniqueOrThrow({
        where: { id: result.listId! },
      });
      expect(list.name).toBe('Imported contacts');
    });

    it('same email twice in one CSV → list has one member, count 1', async () => {
      const csv = [
        'Email',
        'sarah@acme.com',
        'SARAH+work@acme.com',
      ].join('\n');

      const result = await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: csv },
        columnMapping: { email: 'Email' },
        triggeredBy: 'usr_test',
      });

      const list = await prisma.contactList.findUniqueOrThrow({
        where: { id: result.listId! },
      });
      expect(list.contactCount).toBe(1);
      const members = await prisma.contactListMember.findMany({
        where: { listId: list.id },
      });
      expect(members).toHaveLength(1);
    });

    it('import with zero valid contacts creates no list', async () => {
      const result = await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: ['Email', 'malformed', ''].join('\n') },
        columnMapping: { email: 'Email' },
        triggeredBy: 'usr_test',
      });

      expect(result.recordsOut).toBe(0);
      expect(result.listId).toBeNull();
      const lists = await prisma.contactList.findMany({ where: { orgId: orgA } });
      expect(lists).toHaveLength(0);
    });

    it('each import creates its own list (re-import → two lists)', async () => {
      const csv = ['Email', 'sarah@acme.com', 'tom@beta.com'].join('\n');
      const mapping = { email: 'Email' };

      const r1 = await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: csv },
        columnMapping: mapping,
        triggeredBy: 'usr_test',
      });
      const r2 = await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: csv },
        columnMapping: mapping,
        triggeredBy: 'usr_test',
      });

      expect(r1.listId).not.toBe(r2.listId);
      const lists = await prisma.contactList.findMany({ where: { orgId: orgA } });
      expect(lists).toHaveLength(2);
      // Both lists reference the same two contacts (cross-import dedup of Contacts).
      for (const listId of [r1.listId!, r2.listId!]) {
        const members = await prisma.contactListMember.findMany({
          where: { listId },
        });
        expect(members).toHaveLength(2);
      }
    });

    it('mixed valid + invalid rows: bad rows in errors, valid ones in DB', async () => {
      const csv = [
        'Email,Name',
        'sarah@acme.com,Sarah',
        ',Anonymous',
        'tom@beta.com,Tom',
        'malformed,Mal',
      ].join('\n');

      const result = await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: csv },
        columnMapping: { email: 'Email' },
        triggeredBy: 'usr_test',
      });

      // recordsIn counts rows the adapter saw (3 yielded + 1 onRowError = 4)
      expect(result.recordsIn).toBe(4);
      expect(result.recordsOut).toBe(2);
      expect(result.errorCount).toBe(2);
      expect(result.syncRun.status).toBe('completed');

      const reasons = result.errors.map((e) => e.reason).sort();
      expect(reasons).toContain('missing_email');
      expect(reasons.some((r) => r.startsWith('invalid_email_'))).toBe(true);

      const contacts = await prisma.contact.findMany({ where: { orgId: orgA } });
      expect(contacts).toHaveLength(2);
    });

    it('same email twice in one CSV → one Contact, two ContactSource (cross-row dedup)', async () => {
      const csv = [
        'Email,Title',
        'sarah@acme.com,VP Eng',
        'SARAH+work@acme.com,Head of Engineering',
      ].join('\n');

      const result = await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: csv },
        columnMapping: { email: 'Email', title: 'Title' },
        triggeredBy: 'usr_test',
      });

      expect(result.recordsOut).toBe(2);
      const contacts = await prisma.contact.findMany({ where: { orgId: orgA } });
      expect(contacts).toHaveLength(1);

      const sources = await prisma.contactSource.findMany({
        where: { sourceAccountId: csvAccountA },
      });
      expect(sources).toHaveLength(2);
    });

    it('re-import same CSV → same Contacts, new ContactSource rows for the new run', async () => {
      const csv = ['Email', 'sarah@acme.com', 'tom@beta.com'].join('\n');

      const r1 = await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: csv },
        columnMapping: { email: 'Email' },
        triggeredBy: 'usr_test',
      });
      const r2 = await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: csv },
        columnMapping: { email: 'Email' },
        triggeredBy: 'usr_test',
      });

      expect(r1.syncRun.id).not.toBe(r2.syncRun.id);

      const contacts = await prisma.contact.findMany({ where: { orgId: orgA } });
      expect(contacts).toHaveLength(2);

      const sources = await prisma.contactSource.findMany({
        where: { sourceAccountId: csvAccountA },
      });
      // 2 contacts × 2 imports = 4 ContactSource rows (each namespaced per run).
      expect(sources).toHaveLength(4);
    });

    it('empty CSV → SyncRun completed with zero counts', async () => {
      const result = await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: '' },
        columnMapping: { email: 'Email' },
        triggeredBy: 'usr_test',
      });

      expect(result.syncRun.status).toBe('completed');
      expect(result.recordsIn).toBe(0);
      expect(result.recordsOut).toBe(0);
      expect(result.errorCount).toBe(0);
    });

    it('cross-org isolation: import to org A leaves org B untouched', async () => {
      const csv = ['Email', 'sarah@acme.com'].join('\n');

      await runCsvImport(prisma, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'string', content: csv },
        columnMapping: { email: 'Email' },
        triggeredBy: 'usr_test',
      });

      const contactsA = await prisma.contact.findMany({ where: { orgId: orgA } });
      const contactsB = await prisma.contact.findMany({ where: { orgId: orgB } });
      expect(contactsA).toHaveLength(1);
      expect(contactsB).toHaveLength(0);

      // Now an upload to orgB with the SAME email — should produce a separate Contact.
      await runCsvImport(prisma, {
        orgId: orgB,
        sourceAccountId: csvAccountB,
        csv: { kind: 'string', content: csv },
        columnMapping: { email: 'Email' },
        triggeredBy: 'usr_test',
      });

      const contactsBAfter = await prisma.contact.findMany({ where: { orgId: orgB } });
      expect(contactsBAfter).toHaveLength(1);
      expect(contactsBAfter[0]!.id).not.toBe(contactsA[0]!.id);
    });
  },
);
