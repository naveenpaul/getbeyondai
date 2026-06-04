import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { SourcingSettingsService } from './sourcing-settings.service';

interface UpsertArgs {
  where: { orgId: string };
  create: { orgId: string; contactPriority: string[]; contactThreshold: string };
  update: { contactPriority: string[]; contactThreshold: string };
}

/**
 * Prisma stub: `findUnique` returns `row`, `upsert` records its args and returns
 * a row reflecting the create payload (the service re-reads via findUnique, so
 * we let upsert mutate the findUnique result for round-trip assertions).
 */
function makePrisma(initialRow: unknown): {
  prisma: PrismaService;
  upsert: ReturnType<typeof vi.fn>;
} {
  let row = initialRow;
  const upsert = vi.fn(async (args: UpsertArgs) => {
    row = {
      contactPriority: args.create.contactPriority,
      contactThreshold: args.create.contactThreshold,
    };
    return row;
  });
  const prisma = {
    orgSourcingConfig: {
      findUnique: async () => row,
      upsert,
    },
  } as unknown as PrismaService;
  return { prisma, upsert };
}

describe('SourcingSettingsService', () => {
  describe('getSettings', () => {
    it('returns defaults (with the defaults block) when no row exists', async () => {
      const { prisma } = makePrisma(null);
      const service = new SourcingSettingsService(prisma);
      const result = await service.getSettings('org-1');
      expect(result.priority).toEqual(['zoominfo', 'snov']);
      expect(result.threshold).toBe('verified');
      expect(result.defaults).toEqual({
        priority: ['zoominfo', 'snov'],
        threshold: 'verified',
      });
    });

    it('returns the stored config when a row exists', async () => {
      const { prisma } = makePrisma({
        contactPriority: ['snov'],
        contactThreshold: 'any',
      });
      const service = new SourcingSettingsService(prisma);
      const result = await service.getSettings('org-1');
      expect(result.priority).toEqual(['snov']);
      expect(result.threshold).toBe('any');
      // Defaults are always the server constants regardless of the stored value.
      expect(result.defaults.priority).toEqual(['zoominfo', 'snov']);
    });
  });

  describe('saveSettings', () => {
    it('upserts the priority + threshold scoped to the org and echoes them back', async () => {
      const { prisma, upsert } = makePrisma(null);
      const service = new SourcingSettingsService(prisma);
      const result = await service.saveSettings('org-1', {
        priority: ['snov', 'zoominfo'],
        threshold: 'any',
      });
      expect(upsert).toHaveBeenCalledOnce();
      const args = upsert.mock.calls[0]![0] as UpsertArgs;
      expect(args.where).toEqual({ orgId: 'org-1' });
      expect(args.create.contactPriority).toEqual(['snov', 'zoominfo']);
      expect(args.update.contactThreshold).toBe('any');
      // Round-trips through the re-read.
      expect(result.priority).toEqual(['snov', 'zoominfo']);
      expect(result.threshold).toBe('any');
    });

    it('persists an empty priority (sourcing turned off)', async () => {
      const { prisma, upsert } = makePrisma(null);
      const service = new SourcingSettingsService(prisma);
      const result = await service.saveSettings('org-1', {
        priority: [],
        threshold: 'verified',
      });
      const args = upsert.mock.calls[0]![0] as UpsertArgs;
      expect(args.create.contactPriority).toEqual([]);
      expect(result.priority).toEqual([]);
    });
  });
});
