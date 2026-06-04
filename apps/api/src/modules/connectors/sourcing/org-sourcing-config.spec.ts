import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import {
  DEFAULT_SOURCING_CONFIG,
  resolveOrgSourcingConfig,
} from './org-sourcing-config';

/** A prisma stub whose orgSourcingConfig.findUnique returns `row`. */
function prismaWithRow(row: unknown): PrismaService {
  return {
    orgSourcingConfig: {
      findUnique: async () => row,
    },
  } as unknown as PrismaService;
}

describe('resolveOrgSourcingConfig', () => {
  it('returns the built-in defaults when the org has no config row', async () => {
    const prisma = prismaWithRow(null);
    const config = await resolveOrgSourcingConfig(prisma, 'org-1');
    expect(config).toEqual(DEFAULT_SOURCING_CONFIG);
    expect(config.priority).toEqual(['zoominfo', 'snov']);
    expect(config.threshold).toBe('verified');
  });

  it('returns the stored priority + threshold when a row exists', async () => {
    const prisma = prismaWithRow({
      contactPriority: ['snov', 'zoominfo'],
      contactThreshold: 'any',
    });
    const config = await resolveOrgSourcingConfig(prisma, 'org-1');
    expect(config.priority).toEqual(['snov', 'zoominfo']);
    expect(config.threshold).toBe('any');
  });

  it('treats a stored empty priority as "source nothing", NOT as defaults', async () => {
    const prisma = prismaWithRow({
      contactPriority: [],
      contactThreshold: 'verified',
    });
    const config = await resolveOrgSourcingConfig(prisma, 'org-1');
    expect(config.priority).toEqual([]);
  });

  it('filters out non-enrichment connectors from a stale/hand-edited row', async () => {
    const prisma = prismaWithRow({
      // apollo/hubspot are discovery/CRM, not contact-enrichment — must be dropped.
      contactPriority: ['apollo', 'zoominfo', 'hubspot', 'snov'],
      contactThreshold: 'verified',
    });
    const config = await resolveOrgSourcingConfig(prisma, 'org-1');
    expect(config.priority).toEqual(['zoominfo', 'snov']);
  });
});
