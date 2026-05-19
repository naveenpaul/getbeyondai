import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ANTHROPIC_CLIENT } from '../runtime/call-model';
import type { AnthropicMessagesClient } from '../runtime/call-model';
import { runResearch } from './researcher.service';
import {
  ResearcherRunRequestSchema,
  type ResearcherRunResponse,
} from './researcher.dto';

/**
 * POST /teammates/researcher/run (T4c).
 *
 * Body: { orgId, triggeredBy, target, budgetCents? }
 * Response: { runId, status, draftId?, costCents, toolCallCount }
 *
 * Synchronous for v1 — research runs typically complete in 30-60s, under
 * the request timeout. The AgentRun row is created up front so the user
 * can always look up `/audit?runId=…` even if the connection drops.
 */
@Controller('teammates/researcher')
export class ResearcherController {
  private readonly prisma: PrismaService;
  private readonly anthropic: AnthropicMessagesClient;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ANTHROPIC_CLIENT) anthropic: AnthropicMessagesClient,
  ) {
    this.prisma = prisma;
    this.anthropic = anthropic;
  }

  @Post('run')
  async run(@Body() body: unknown): Promise<ResearcherRunResponse> {
    const parsed = ResearcherRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `request body validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: parsed.data.orgId },
    });
    if (!org) {
      throw new NotFoundException(
        `Organization ${parsed.data.orgId} not found`,
      );
    }

    const result = await runResearch(
      { prisma: this.prisma, anthropic: this.anthropic },
      {
        orgId: parsed.data.orgId,
        triggeredBy: parsed.data.triggeredBy,
        target: parsed.data.target,
        budgetCents: parsed.data.budgetCents,
      },
    );

    return result;
  }
}
