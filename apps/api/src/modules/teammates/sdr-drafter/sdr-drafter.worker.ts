import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { LLM_PROVIDER, type LlmProvider } from '../runtime/llm-provider';
import { RUN_EVENT_BUS, type RunEventBus } from '../runtime/run-event-bus';
import { runSdrDrafter } from './sdr-drafter.service';

export const SDR_DRAFTER_RUN_QUEUE = 'sdr-drafter-run';

/**
 * pg-boss consumer for asynchronous SDR Drafter runs. Mirrors the
 * Researcher worker — controller creates the AgentRun synchronously to
 * mint a runId, enqueues a job, this worker drives the run to terminal.
 */
export interface SdrDrafterRunJobPayload {
  runId: string;
  orgId: string;
  triggeredBy: string;
  contactId: string;
  briefDraftId?: string;
  goal?: string;
  budgetCents?: number;
}

@Injectable()
export class SdrDrafterWorker implements OnModuleInit {
  private readonly logger = new Logger(SdrDrafterWorker.name);
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
    await this.queue.work<SdrDrafterRunJobPayload>(
      SDR_DRAFTER_RUN_QUEUE,
      async (job) => {
        this.logger.log(
          `processing sdr-drafter-run job ${job.id} for AgentRun ${job.data.runId} ` +
            `(contact=${job.data.contactId})`,
        );
        try {
          const result = await runSdrDrafter(
            {
              prisma: this.prisma,
              llm: this.llm,
              emitEvent: (event) => this.eventBus.publish(event),
            },
            {
              runId: job.data.runId,
              orgId: job.data.orgId,
              triggeredBy: job.data.triggeredBy,
              contactId: job.data.contactId,
              briefDraftId: job.data.briefDraftId,
              goal: job.data.goal,
              budgetCents: job.data.budgetCents,
            },
          );
          this.logger.log(
            `completed sdr-drafter-run job ${job.id}: status=${result.status} ` +
              `tools=${result.toolCallCount} cost=${result.costCents}¢ ` +
              `draftId=${result.draftId ?? '(none)'}`,
          );
        } catch (err) {
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
    this.logger.log(`registered worker for queue "${SDR_DRAFTER_RUN_QUEUE}"`);
  }
}
