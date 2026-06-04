import { Inject, Injectable } from '@nestjs/common';
import type { ConnectorKind, SourcingThreshold } from '@prisma/client';
import type {
  SaveSourcingSettingsRequest,
  SourcingSettingsResponse,
} from '@getbeyond/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  DEFAULT_SOURCING_CONFIG,
  resolveOrgSourcingConfig,
} from '../connectors/sourcing/org-sourcing-config';

/**
 * SourcingSettingsService — per-org Stage 5 waterfall config (connector priority
 * + verification threshold).
 *
 * Every method is scoped to an `orgId` the controller derives from the session
 * (never the body). Reads go through `resolveOrgSourcingConfig` so the GET
 * surface reports exactly what a run would use (defaults included); writes upsert
 * the single per-org row.
 */
@Injectable()
export class SourcingSettingsService {
  // Explicit field + @Inject + manual assignment (NOT param-property shorthand):
  // vitest/esbuild drops design:paramtypes metadata, so the shorthand injects
  // undefined under test. See getbeyond CLAUDE.md "NestJS DI — pitfall".
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  /**
   * The org's effective config + the server defaults. Absence of a stored row
   * surfaces the defaults (what a run would use), so the UI always has something
   * coherent to render and a "(default)" affordance.
   */
  async getSettings(orgId: string): Promise<SourcingSettingsResponse> {
    const resolved = await resolveOrgSourcingConfig(this.prisma, orgId);
    return {
      priority: resolved.priority,
      threshold: resolved.threshold,
      defaults: {
        priority: DEFAULT_SOURCING_CONFIG.priority,
        threshold: DEFAULT_SOURCING_CONFIG.threshold,
      },
    };
  }

  /**
   * Upsert the org's sourcing config on (orgId). The request is already
   * validated (enrichment-only kinds, no duplicates) by the DTO schema, so the
   * priority is safe to persist as ConnectorKind[]. Returns the resulting
   * settings (re-resolved) so the caller sees exactly what was stored.
   */
  async saveSettings(
    orgId: string,
    req: SaveSourcingSettingsRequest,
  ): Promise<SourcingSettingsResponse> {
    const contactPriority = req.priority as ConnectorKind[];
    const contactThreshold = req.threshold as SourcingThreshold;
    await this.prisma.orgSourcingConfig.upsert({
      where: { orgId },
      create: { orgId, contactPriority, contactThreshold },
      update: { contactPriority, contactThreshold },
    });
    return this.getSettings(orgId);
  }
}
