import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { CampaignEvent, SourcingConfig } from '@getbeyond/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { LlmResolver } from '../teammates/runtime/llm-resolver';
import {
  RUN_EVENT_BUS,
  type RunEventBus,
} from '../teammates/runtime/run-event-bus';
import { ContactListSourcingProvider } from '../connectors/sourcing/contact-list-sourcing.provider';
import type { SourcingProvider } from '../connectors/sourcing/sourcing-provider';
import {
  CampaignOrchestrator,
  CAMPAIGN_TEAMMATE,
} from './campaign-orchestrator';
import { campaignFailed, toBusEvent } from './campaign-events';

export const CAMPAIGN_RUN_QUEUE = 'campaign-run';

/**
 * pg-boss consumer for campaign orchestrator runs.
 *
 * Producer (controller) creates the Campaign synchronously (status='running')
 * to mint a campaignId, then enqueues this job. The worker builds the per-run
 * sourcing provider from the campaign's SourcingConfig, wires the orchestrator's
 * event sink to the RunEventBus (so the SSE stream sees live progress), and
 * drives the campaign to terminal.
 *
 * Failure semantics:
 *   - The orchestrator never throws for expected failures (sourcing config,
 *     budget, research errors) — it sets Campaign.status='failed' and emits
 *     campaign_failed itself. Those return cleanly; the job succeeds.
 *   - A genuine thrown error (DB unreachable) leaves the campaign in 'running'
 *     and bubbles out. We emit a campaign_failed on the bus first (so the
 *     stream closes) then re-throw for pg-boss's retry policy.
 */
export interface CampaignRunJobPayload {
  campaignId: string;
  orgId: string;
  triggeredBy: string;
  goal: string;
  winsListId: string | null;
  sourcing: SourcingConfig | null;
  budgetCents?: number;
}

@Injectable()
export class CampaignWorker implements OnModuleInit {
  private readonly logger = new Logger(CampaignWorker.name);
  private readonly queue: QueueService;
  private readonly prisma: PrismaService;
  private readonly resolver: LlmResolver;
  private readonly eventBus: RunEventBus;

  constructor(
    @Inject(QueueService) queue: QueueService,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(LlmResolver) resolver: LlmResolver,
    @Inject(RUN_EVENT_BUS) eventBus: RunEventBus,
  ) {
    this.queue = queue;
    this.prisma = prisma;
    this.resolver = resolver;
    this.eventBus = eventBus;
  }

  async onModuleInit(): Promise<void> {
    await this.queue.work<CampaignRunJobPayload>(
      CAMPAIGN_RUN_QUEUE,
      async (job) => {
        const { data } = job;
        this.logger.log(
          `processing campaign-run job ${job.id} for Campaign ${data.campaignId}`,
        );
        try {
          // Resolve the per-run provider (org BYO → env → block). A "no key"
          // failure is caught below → campaign_failed on the stream.
          const { provider, modelPrimary } = await this.resolver.resolve(
            data.orgId,
            CAMPAIGN_TEAMMATE,
          );
          const orchestrator = new CampaignOrchestrator({
            prisma: this.prisma,
            llm: provider,
            buildSourcingProvider: (orgId) =>
              buildSourcingProvider(this.prisma, orgId, data.sourcing),
            // CampaignEvents ride the same bus the teammate runtime uses.
            // toBusEvent stamps runId=campaignId so the bus (which routes by
            // runId) delivers them to the stream subscribed by campaignId.
            emitEvent: (event: CampaignEvent) =>
              this.eventBus.publish(toBusEvent(event)),
          });
          const result = await orchestrator.run({
            campaignId: data.campaignId,
            orgId: data.orgId,
            triggeredBy: data.triggeredBy,
            goal: data.goal,
            winsListId: data.winsListId,
            modelName: modelPrimary,
            budgetCents: data.budgetCents,
          });
          this.logger.log(
            `completed campaign-run job ${job.id}: status=${result.status} ` +
              `candidates=${result.candidateCount} cost=${result.costCents}¢`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.eventBus.publish(
            toBusEvent(campaignFailed(data.campaignId, message)),
          );
          throw err;
        }
      },
    );
    this.logger.log(`registered worker for queue "${CAMPAIGN_RUN_QUEUE}"`);
  }
}

/**
 * Build the sourcing provider for a campaign from its SourcingConfig.
 *   - null → no source attached; returns null. The orchestrator derives the ICP
 *     and prompts for a source instead of qualifying (sourcing is optional).
 *   - contact_list → the no-key ContactListSourcingProvider (ships today).
 *   - apollo → reserved; throws a clear "not configured" error. The vendor SDK
 *     would live behind an adapter per invariant #5 when it lands.
 */
export function buildSourcingProvider(
  prisma: PrismaService,
  orgId: string,
  sourcing: SourcingConfig | null,
): SourcingProvider | null {
  if (sourcing === null) {
    return null;
  }
  if (sourcing.provider === 'contact_list') {
    return new ContactListSourcingProvider(prisma, orgId, sourcing.listId);
  }
  // sourcing.provider === 'apollo'
  throw new Error(
    'Apollo sourcing is not configured. Only the contact_list provider is ' +
      'available today; attach an imported ContactList as the candidate pool.',
  );
}
