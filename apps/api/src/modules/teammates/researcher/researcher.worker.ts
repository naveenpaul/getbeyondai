import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { LLM_PROVIDER, type LlmProvider } from '../runtime/llm-provider';
import { RUN_EVENT_BUS, type RunEventBus } from '../runtime/run-event-bus';
import { runResearch } from './researcher.service';

export const RESEARCHER_RUN_QUEUE = 'researcher-run';

/**
 * pg-boss consumer for asynchronous research runs (T4d.1).
 *
 * The producer (controller) creates the AgentRun synchronously to mint a
 * runId, then enqueues a job. This worker drives the existing AgentRun
 * to terminal — completed, abstained (bound trip), or failed (thrown
 * exception → re-throw lets pg-boss apply its retry policy).
 *
 * Failure semantics:
 *   - Caught BudgetExceededError / bound trips inside runAgent already
 *     transition AgentRun.status = 'abstained' before returning. Those are
 *     "this job succeeded; the run gave up cleanly" — no retry.
 *   - Genuine thrown errors (DB unreachable, mocked-out Anthropic, etc.)
 *     leave AgentRun in 'running' and bubble out. pg-boss retries the job.
 *     The AgentRunReaper (T4d.3) covers the case where the worker died
 *     mid-flight without ever marking the run terminal.
 */
export interface ResearcherRunJobPayload {
  runId: string;
  orgId: string;
  triggeredBy: string;
  target: string;
  /** Optional override; defaults applied by runResearch when absent. */
  budgetCents?: number;
}

@Injectable()
export class ResearcherWorker implements OnModuleInit {
  private readonly logger = new Logger(ResearcherWorker.name);
  private readonly queue: QueueService;
  private readonly prisma: PrismaService;
  private readonly llm: LlmProvider;
  private readonly eventBus: RunEventBus;

  constructor(
    @Inject(QueueService) queue: QueueService,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(LLM_PROVIDER) llm: LlmProvider,
    @Inject(RUN_EVENT_BUS) eventBus: RunEventBus,
  ) {
    this.queue = queue;
    this.prisma = prisma;
    this.llm = llm;
    this.eventBus = eventBus;
  }

  async onModuleInit(): Promise<void> {
    await this.queue.work<ResearcherRunJobPayload>(
      RESEARCHER_RUN_QUEUE,
      async (job) => {
        this.logger.log(
          `processing researcher-run job ${job.id} for AgentRun ${job.data.runId} ` +
            `(target=${truncate(job.data.target, 60)})`,
        );
        try {
          const result = await runResearch(
            {
              prisma: this.prisma,
              llm: this.llm,
              emitEvent: (event) => this.eventBus.publish(event),
            },
            {
              runId: job.data.runId,
              orgId: job.data.orgId,
              triggeredBy: job.data.triggeredBy,
              target: job.data.target,
              budgetCents: job.data.budgetCents,
            },
          );
          this.logger.log(
            `completed researcher-run job ${job.id}: status=${result.status} ` +
              `tools=${result.toolCallCount} cost=${result.costCents}¢ ` +
              `draftId=${result.draftId ?? '(none)'}`,
          );
        } catch (err) {
          // Thrown errors leave the AgentRun in status='running'; the
          // AgentRunReaper will mark it failed within 5 min. Surface the
          // failure on the bus immediately so subscribers stop polling /
          // close the stream cleanly. Then re-throw so pg-boss applies
          // its retry policy.
          this.eventBus.publish({
            type: 'run_failed',
            runId: job.data.runId,
            at: new Date().toISOString(),
            data: { message: err instanceof Error ? err.message : String(err) },
          });
          throw err;
        }
      },
    );
    this.logger.log(`registered worker for queue "${RESEARCHER_RUN_QUEUE}"`);
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}
