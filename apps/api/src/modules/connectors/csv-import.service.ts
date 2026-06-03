import type { Prisma, PrismaClient, SyncRun } from '@prisma/client';
import { upsertContact } from '../contacts/contact-upsert';
import { InvalidEmailError } from '../contacts/identity';
import {
  type CsvColumnMapping,
  type CsvRowError,
  type CsvSourceConfig,
} from './adapters/csv.source';
import { getSourceAdapter } from './registry';

/**
 * End-to-end CSV import (eng-review T8-CSV.2a).
 *
 * Pipeline:
 *   1. Create SyncRun (status='running').
 *   2. Run the CSV source adapter; for each yielded NormalizedContact,
 *      call upsertContact (which holds the advisory lock + per-field
 *      precedence resolver).
 *   3. Adapter row errors (missing email, empty cells) → SyncRun.errors
 *      via onRowError. Upsert-time errors (malformed email that the
 *      adapter let through) → SyncRun.errors via try/catch on
 *      InvalidEmailError.
 *   4. On completion, update SyncRun with counts + errors + status.
 *
 * externalId namespacing: each import gets `csv:run:{syncRunId}` as the
 * adapter's externalIdNamespace, so re-imports of the same CSV produce
 * distinct ContactSource rows (each upload is its own logical snapshot,
 * cross-source dedup still merges into one Contact via normalizedEmail).
 *
 * Catastrophic failure (e.g. DB unreachable mid-run) marks SyncRun
 * status='failed' and rethrows. Caller decides what to surface.
 */

export interface CsvImportInput {
  orgId: string;
  /** ConnectorAccount of kind='csv'. Caller must have created it. */
  sourceAccountId: string;
  csv: { kind: 'string'; content: string } | { kind: 'buffer'; content: Buffer };
  columnMapping: CsvColumnMapping;
  /** userId of the operator that triggered the import. Stored on SyncRun. */
  triggeredBy: string;
  /**
   * Display name for the ContactList created from this import. Defaults to
   * DEFAULT_IMPORT_LIST_NAME when omitted or blank. The controller passes the
   * uploaded filename here so the list is recognizable in the picker.
   */
  listName?: string;
  /**
   * Reuse an existing SyncRun (the async producer / worker pattern). When
   * omitted, runCsvImport creates a new SyncRun. When provided, the SyncRun
   * must already exist; runCsvImport transitions it from `running` → terminal.
   */
  syncRunId?: string;
}

export interface CsvImportError {
  /** 1-indexed CSV row. `-1` for errors that don't have a row context. */
  row: number;
  reason: string;
  message: string;
  rawRow?: Record<string, unknown>;
}

export interface CsvImportResult {
  syncRun: SyncRun;
  recordsIn: number;
  recordsOut: number;
  errorCount: number;
  errors: CsvImportError[];
  /**
   * The ContactList created to hold the imported contacts, or `null` when the
   * import produced zero contacts (no point in an empty list). This list is
   * what prospect searches source candidates from.
   */
  listId: string | null;
}

/** Fallback ContactList name when the caller supplies none. */
export const DEFAULT_IMPORT_LIST_NAME = 'Imported contacts';

export async function runCsvImport(
  prisma: PrismaClient,
  input: CsvImportInput,
): Promise<CsvImportResult> {
  let syncRun: SyncRun;
  if (input.syncRunId) {
    const existing = await prisma.syncRun.findUnique({
      where: { id: input.syncRunId },
    });
    if (!existing) {
      throw new Error(`SyncRun ${input.syncRunId} not found`);
    }
    syncRun = existing;
  } else {
    syncRun = await prisma.syncRun.create({
      data: {
        orgId: input.orgId,
        connectorAccountId: input.sourceAccountId,
        direction: 'pull',
        status: 'running',
      },
    });
  }

  const errors: CsvImportError[] = [];
  let yieldedCount = 0;
  let upsertedCount = 0;
  let adapterErrorCount = 0;
  // Distinct Contact ids upserted this run. A Set because cross-row dedup
  // (two rows → same normalizedEmail → one Contact) must not produce two
  // ContactListMember rows for the same contact.
  const memberContactIds = new Set<string>();

  const onRowError = (e: CsvRowError): void => {
    adapterErrorCount++;
    errors.push({
      row: e.row,
      reason: e.reason,
      message: e.message,
      rawRow: e.rawRow,
    });
  };

  let listId: string | null = null;

  const adapter = getSourceAdapter('csv');
  const adapterConfig: CsvSourceConfig = {
    source: input.csv,
    columnMapping: input.columnMapping,
    onRowError,
    externalIdNamespace: `csv:run:${syncRun.id}`,
  };

  try {
    for await (const contact of adapter.syncContacts({
      creds: {},
      config: adapterConfig,
    })) {
      yieldedCount++;
      try {
        const upserted = await upsertContact(prisma, {
          orgId: input.orgId,
          emailRaw: contact.emailRaw,
          sourceAccountId: input.sourceAccountId,
          sourceKind: 'csv',
          externalId: contact.externalId,
          externalUrl: contact.externalUrl ?? null,
          fields: {
            firstName: contact.firstName ?? null,
            lastName: contact.lastName ?? null,
            title: contact.title ?? null,
            company: contact.company ?? null,
            linkedinUrl: contact.linkedinUrl ?? null,
          },
          rawPayload: contact.rawPayload as Prisma.InputJsonValue,
        });
        upsertedCount++;
        memberContactIds.add(upserted.contact.id);
      } catch (err) {
        if (err instanceof InvalidEmailError) {
          errors.push({
            row: -1,
            reason: `invalid_email_${err.reason}`,
            message: err.message,
          });
          continue;
        }
        throw err;
      }
    }

    // Group the imported contacts into a ContactList so prospect searches have a
    // candidate pool to source from. Skip when nothing was imported — an
    // empty list is just clutter. List + members are written in one
    // transaction; a failure here lands in the same catch below and marks
    // the SyncRun failed (no half-built list left behind).
    if (memberContactIds.size > 0) {
      listId = await createImportList(prisma, {
        orgId: input.orgId,
        syncRunId: syncRun.id,
        name: input.listName?.trim() || DEFAULT_IMPORT_LIST_NAME,
        createdBy: input.triggeredBy,
        contactIds: [...memberContactIds],
      });
    }
  } catch (err) {
    syncRun = await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: 'failed',
        completedAt: new Date(),
        recordsIn: yieldedCount + adapterErrorCount,
        recordsOut: upsertedCount,
        errorCount: errors.length + 1,
        errors: [
          ...errors,
          {
            row: -1,
            reason: 'fatal',
            message: err instanceof Error ? err.message : String(err),
          },
        ] as unknown as Prisma.InputJsonValue,
      },
    });
    throw err;
  }

  const recordsIn = yieldedCount + adapterErrorCount;
  syncRun = await prisma.syncRun.update({
    where: { id: syncRun.id },
    data: {
      status: 'completed',
      completedAt: new Date(),
      recordsIn,
      recordsOut: upsertedCount,
      errorCount: errors.length,
      errors: errors as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    syncRun,
    recordsIn,
    recordsOut: upsertedCount,
    errorCount: errors.length,
    errors,
    listId,
  };
}

/**
 * Create the ContactList + members for one CSV import, in a single
 * transaction so a crash never leaves a list with a wrong contactCount or
 * partial membership. `source` ties the list back to its SyncRun
 * (`csv:upload:{syncRunId}`); contactIds are already de-duplicated by the
 * caller, so `skipDuplicates` is only belt-and-suspenders against the
 * composite PK.
 */
async function createImportList(
  prisma: PrismaClient,
  args: {
    orgId: string;
    syncRunId: string;
    name: string;
    createdBy: string;
    contactIds: string[];
  },
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const list = await tx.contactList.create({
      data: {
        orgId: args.orgId,
        source: `csv:upload:${args.syncRunId}`,
        name: args.name,
        createdBy: args.createdBy,
        contactCount: args.contactIds.length,
      },
    });
    await tx.contactListMember.createMany({
      data: args.contactIds.map((contactId) => ({
        listId: list.id,
        contactId,
      })),
      skipDuplicates: true,
    });
    return list.id;
  });
}
