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
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import {
  RUN_EVENT_BUS,
  type RunEvent,
  type RunEventBus,
} from '../runtime/run-event-bus';
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

const SSE_HEARTBEAT_MS = 15_000;
const TERMINAL_EVENT_TYPES: ReadonlySet<RunEvent['type']> = new Set([
  'run_completed',
  'run_abstained',
  'run_failed',
]);

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
  private readonly eventBus: RunEventBus;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(QueueService) queue: QueueService,
    @Inject(RUN_EVENT_BUS) eventBus: RunEventBus,
  ) {
    this.prisma = prisma;
    this.queue = queue;
    this.eventBus = eventBus;
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

  /**
   * SSE stream of live progress events for a run (T4e.4).
   *
   *   GET /teammates/researcher/runs/:id/stream?orgId=
   *     Content-Type: text/event-stream
   *
   * Connection lifecycle:
   *   - On connect: validates tenant + run exists (throws synchronously
   *     before the stream opens for unauthorized requests).
   *   - Replays the bus's buffered events first so a client that connects
   *     mid-run sees everything that already happened.
   *   - Pipes future events through. Heartbeats every 15s keep stale
   *     connections detectable on the client side.
   *   - Completes the stream when a terminal event arrives
   *     (run_completed / run_abstained / run_failed). The client should
   *     also handle EventSource onerror to reconnect-or-give-up.
   *
   * For runs that are already terminal when the client connects (e.g.
   * page reload after the worker finished), the snapshot replay still
   * delivers the terminal event and the stream closes immediately.
   */
  @Sse('runs/:id/stream')
  async stream(
    @Param('id') id: string,
    @Query('orgId') orgId: string | undefined,
  ): Promise<Observable<MessageEvent>> {
    if (!orgId) {
      throw new BadRequestException('orgId query parameter is required');
    }
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) {
      throw new NotFoundException(`AgentRun ${id} not found`);
    }
    if (run.orgId !== orgId) {
      throw new ForbiddenException('AgentRun belongs to another org');
    }

    const eventBus = this.eventBus;
    const runStatus = run.status;

    return new Observable<MessageEvent>((subscriber) => {
      // Tracking + cleanup handles declared up front so closures below can
      // reach them. heartbeat may stay undefined when we terminate early
      // (run was already terminal at connect time).
      const delivered = new Set<string>();
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribeBus: (() => void) | undefined;

      const terminate = (): void => {
        if (heartbeat) clearInterval(heartbeat);
        unsubscribeBus?.();
        subscriber.complete();
      };

      // We track delivered event identity by (type|at|data-json) — the bus
      // doesn't assign monotonic ids — to avoid double-emitting the same
      // event between snapshot-replay and the live subscription.
      const emit = (event: RunEvent): void => {
        const key = `${event.type}|${event.at}|${JSON.stringify(event.data)}`;
        if (delivered.has(key)) return;
        delivered.add(key);
        subscriber.next({ type: event.type, data: event });
        if (TERMINAL_EVENT_TYPES.has(event.type)) terminate();
      };

      // Replay buffer first, then subscribe to live events.
      for (const event of eventBus.snapshot(id)) emit(event);
      unsubscribeBus = eventBus.subscribe(id, emit);

      // If the run was ALREADY terminal in the DB AND no terminal event is
      // in the replay buffer (it aged out of the 60s window), synthesize
      // one from the row so the client doesn't wait forever.
      const replayHasTerminal = [...delivered].some((key) =>
        Array.from(TERMINAL_EVENT_TYPES).some((t) => key.startsWith(`${t}|`)),
      );
      if (
        (runStatus === 'completed' ||
          runStatus === 'abstained' ||
          runStatus === 'failed') &&
        !replayHasTerminal
      ) {
        subscriber.next({
          type: `run_${runStatus}`,
          data: {
            type: `run_${runStatus}`,
            runId: id,
            at: new Date().toISOString(),
            data: { synthesized: true, status: runStatus },
          },
        });
        terminate();
        return () => undefined;
      }

      heartbeat = setInterval(() => {
        subscriber.next({
          type: 'heartbeat',
          data: { at: new Date().toISOString() },
        });
      }, SSE_HEARTBEAT_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();

      return () => {
        if (heartbeat) clearInterval(heartbeat);
        unsubscribeBus?.();
      };
    });
  }
}
