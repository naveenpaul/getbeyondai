import type {
  ConnectorKind,
  Contact,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { normalizeEmail } from './identity';
import {
  type FieldProvenance,
  resolveFieldUpdates,
  tierFromConnectorKind,
} from './field-resolver';

/**
 * Cross-source contact upsert (eng-review pass-2 D2 + D3 + codex T2/T4).
 *
 * The same person across HubSpot + Apollo + CSV must collapse to ONE Contact.
 * Concurrency safety lives in three layers:
 *
 *   1. `pg_advisory_xact_lock(hashtext(orgId), hashtext(normalizedEmail))`
 *      serializes upserts targeting the same identity. Transaction-scoped, so
 *      no leaks under connection pooling.
 *   2. The DB-level `@@unique([orgId, normalizedEmail])` is the real safety —
 *      hashtext() is collision-prone in theory; the constraint catches it.
 *   3. The transaction wraps Contact + ContactEmail + ContactSource writes so
 *      a crash mid-flight leaves zero partial state.
 *
 * Field-merging policy (T4): incoming field values pass through the
 * per-field precedence resolver (manual > CRM > vendor > CSV; same-tier
 * last-write-wins). Empty / null incoming values never overwrite existing
 * populated values. `fieldProvenance` records the source+tier+updatedAt for
 * each field so future syncs can reason about it.
 *
 * Throws `InvalidEmailError` from `normalizeEmail()` BEFORE opening a
 * transaction — bad input never produces partial DB state.
 */
export interface UpsertContactInput {
  orgId: string;
  emailRaw: string;
  sourceAccountId: string;
  /** Determines the precedence tier for field merging (T4). */
  sourceKind: ConnectorKind;
  externalId: string;
  externalUrl?: string | null;
  fields?: {
    firstName?: string | null;
    lastName?: string | null;
    title?: string | null;
    company?: string | null;
    linkedinUrl?: string | null;
  };
  rawPayload: Prisma.InputJsonValue;
}

export interface UpsertContactResult {
  contact: Contact;
  /** True iff a new Contact row was created in this call (vs found existing). */
  created: boolean;
  /** True iff a new ContactSource row was created (vs the rawPayload was updated on an existing one). */
  sourceCreated: boolean;
}

export async function upsertContact(
  prisma: PrismaClient,
  input: UpsertContactInput,
): Promise<UpsertContactResult> {
  const normalizedEmail = normalizeEmail(input.emailRaw);

  return prisma.$transaction(async (tx) => {
    // Acquire transaction-scoped advisory lock keyed on (orgId, normalizedEmail).
    // Two-arg form hashes both strings to int4. Lock auto-releases on commit/rollback.
    // Use $executeRaw (not $queryRaw) — pg_advisory_xact_lock returns void, and
    // Prisma can't deserialize void columns from a SELECT result set.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.orgId}::text), hashtext(${normalizedEmail}::text))`;

    const existing = await tx.contact.findUnique({
      where: {
        orgId_normalizedEmail: {
          orgId: input.orgId,
          normalizedEmail,
        },
      },
    });

    const tier = tierFromConnectorKind(input.sourceKind);
    const existingProvenance: FieldProvenance = existing
      ? ((existing.fieldProvenance as unknown as FieldProvenance) ?? {})
      : {};

    const { updates, provenance } = resolveFieldUpdates({
      existingProvenance,
      incoming: input.fields ?? {},
      source: { accountId: input.sourceAccountId, tier },
    });

    let contact: Contact;
    let created = false;

    if (existing) {
      if (Object.keys(updates).length > 0) {
        contact = await tx.contact.update({
          where: { id: existing.id },
          data: {
            ...(updates as Prisma.ContactUpdateInput),
            fieldProvenance: provenance as unknown as Prisma.InputJsonValue,
            lastEditedAt: new Date(),
          },
        });
      } else {
        contact = existing;
      }
    } else {
      contact = await tx.contact.create({
        data: {
          orgId: input.orgId,
          normalizedEmail,
          firstName: updates.firstName ?? null,
          lastName: updates.lastName ?? null,
          title: updates.title ?? null,
          company: updates.company ?? null,
          linkedinUrl: updates.linkedinUrl ?? null,
          fieldProvenance: provenance as unknown as Prisma.InputJsonValue,
          emails: {
            create: {
              normalizedEmail,
              rawEmail: input.emailRaw.trim(),
              isPrimary: true,
              sourceAccountId: input.sourceAccountId,
            },
          },
        },
      });
      created = true;
    }

    const existingSource = await tx.contactSource.findUnique({
      where: {
        sourceAccountId_externalId: {
          sourceAccountId: input.sourceAccountId,
          externalId: input.externalId,
        },
      },
    });

    if (existingSource) {
      await tx.contactSource.update({
        where: { id: existingSource.id },
        data: {
          rawPayload: input.rawPayload,
          rawPayloadVersion: { increment: 1 },
          lastSyncedAt: new Date(),
          externalUrl: input.externalUrl ?? existingSource.externalUrl,
        },
      });
      return { contact, created, sourceCreated: false };
    }

    await tx.contactSource.create({
      data: {
        contactId: contact.id,
        sourceAccountId: input.sourceAccountId,
        externalId: input.externalId,
        externalUrl: input.externalUrl ?? null,
        rawPayload: input.rawPayload,
      },
    });
    return { contact, created, sourceCreated: true };
  });
}
