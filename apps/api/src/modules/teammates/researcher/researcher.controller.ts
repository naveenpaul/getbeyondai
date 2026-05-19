import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { RESEARCHER_NAME } from './researcher.service';
import {
  RESEARCHER_RUN_QUEUE,
  type ResearcherRunJobPayload,
} from './researcher.worker';
import {
  ResearcherRunRequestSchema,
  type ResearcherRunEnqueueResponse,
  type ResearcherRunStatusResponse,
} from './researcher.dto';

/**
 * Researcher HTTP endpoints (T4d.2).
 *
 *   POST /teammates/researcher/run
 *     Body: { orgId, triggeredBy, target, budgetCents? }
 *     → 202 { runId, status: 'running' }
 *     Creates the AgentRun synchronously + enqueues the worker job, then
 *     returns immediately. Caller polls GET /runs/:id until terminal.
 *
 *   GET /teammates/researcher/runs/:id?orgId=
 *     → 200 ResearcherRunStatusResponse
 *     Returns the AgentRun's current state. When status='completed', also
 *     returns the persisted Draft + Claims with their citation URLs joined
 *     for inline display.
 *
 * Auth (pre-real-auth stub): orgId arrives via body / query. Real auth
 * wires it from OrgContext.
 */
@Controller('teammates/researcher')
export class ResearcherController {
  private readonly prisma: PrismaService;
  private readonly queue: QueueService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(QueueService) queue: QueueService,
  ) {
    this.prisma = prisma;
    this.queue = queue;
  }

  @Post('run')
  @HttpCode(202)
  async enqueue(@Body() body: unknown): Promise<ResearcherRunEnqueueResponse> {
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

    // Mint the AgentRun synchronously so the caller has a runId to poll on.
    // The worker drives this same row to terminal.
    const run = await this.prisma.agentRun.create({
      data: {
        orgId: parsed.data.orgId,
        teammate: RESEARCHER_NAME,
        triggeredBy: parsed.data.triggeredBy,
        status: 'running',
        inputContext: {
          target: parsed.data.target,
        } satisfies Record<string, unknown>,
      },
    });

    await this.queue.send<ResearcherRunJobPayload>(RESEARCHER_RUN_QUEUE, {
      runId: run.id,
      orgId: parsed.data.orgId,
      triggeredBy: parsed.data.triggeredBy,
      target: parsed.data.target,
      budgetCents: parsed.data.budgetCents,
    });

    return { runId: run.id, status: 'running' };
  }

  @Get('runs/:id')
  async getRun(
    @Param('id') id: string,
    @Query('orgId') orgId: string | undefined,
  ): Promise<ResearcherRunStatusResponse> {
    if (!orgId) {
      throw new BadRequestException('orgId query parameter is required');
    }

    const run = await this.prisma.agentRun.findUnique({
      where: { id },
      include: {
        drafts: {
          where: { teammate: RESEARCHER_NAME },
          include: { claims: { include: { citation: true } } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        toolCalls: { select: { id: true } },
      },
    });

    if (!run) {
      throw new NotFoundException(`AgentRun ${id} not found`);
    }
    if (run.orgId !== orgId) {
      throw new ForbiddenException('AgentRun belongs to another org');
    }

    const draftRow = run.drafts[0];
    const draft = draftRow
      ? {
          id: draftRow.id,
          type: draftRow.type as string,
          content: draftRow.content,
          claims: draftRow.claims.map((c) => ({
            id: c.id,
            text: c.text,
            citationId: c.citationId,
            citationUrl: c.citation?.url ?? null,
            abstained: c.abstained,
            confidence: c.confidence,
          })),
        }
      : null;

    return {
      runId: run.id,
      status: run.status as ResearcherRunStatusResponse['status'],
      reason: run.reason,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      costCents: run.costCents,
      toolCallCount: run.toolCalls.length,
      draft,
    };
  }
}
