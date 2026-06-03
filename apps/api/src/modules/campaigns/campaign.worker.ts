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
import {
  ApolloSourcingProvider,
  type ApolloOrgSearcher,
} from '../connectors/sourcing/apollo-sourcing.provider';
import {
  SourcingUnavailableError,
  type SourcingProvider,
} from '../connectors/sourcing/sourcing-provider';
import { apolloSourceAdapter } from '../connectors/adapters/apollo/apollo.source';
import {
  CredentialManager,
  CredentialManagerError,
  type CredentialManagerErrorCode,
} from '../connectors/credential-manager';
import {
  isApolloAllowed,
  resolveDeploymentMode,
  type DeploymentMode,
} from '../../common/deployment';
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
  private readonly credentials: CredentialManager;

  constructor(
    @Inject(QueueService) queue: QueueService,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(LlmResolver) resolver: LlmResolver,
    @Inject(RUN_EVENT_BUS) eventBus: RunEventBus,
    @Inject(CredentialManager) credentials: CredentialManager,
  ) {
    this.queue = queue;
    this.prisma = prisma;
    this.resolver = resolver;
    this.eventBus = eventBus;
    this.credentials = credentials;
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
              buildSourcingProvider(
                this.prisma,
                this.credentials,
                orgId,
                data.sourcing,
              ),
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
 *   - contact_list → the no-key ContactListSourcingProvider (ships today).
 *   - apollo (explicit) → live company discovery; throws SourcingUnavailableError
 *     if Apollo isn't connected.
 *   - null (no source attached) → AUTO-DISCOVERY: if the org has connected
 *     Apollo, discover from the ICP automatically ("type a goal → ranked
 *     companies"); otherwise return null so the orchestrator prompts the user.
 *
 * Apollo is gated to self-hosted installs (see common/deployment.ts): on Cloud,
 * an explicit apollo source surfaces a SourcingUnavailableError and auto-discovery
 * skips Apollo entirely. Apollo paths load + decrypt the key at the credential
 * boundary (invariant #6); a benign, user-fixable problem (not connected / key
 * rejected / circuit open) throws `SourcingUnavailableError`, which the
 * orchestrator surfaces gracefully rather than failing the campaign.
 */
export async function buildSourcingProvider(
  prisma: PrismaService,
  credentials: CredentialManager,
  orgId: string,
  sourcing: SourcingConfig | null,
  // Injectable for tests; production uses the registered Apollo adapter singleton.
  apolloAdapter: ApolloOrgSearcher = apolloSourceAdapter,
  // Defaults to the env-resolved mode; tests pass it explicitly.
  deploymentMode: DeploymentMode = resolveDeploymentMode(),
): Promise<SourcingProvider | null> {
  if (sourcing?.provider === 'contact_list') {
    return new ContactListSourcingProvider(prisma, orgId, sourcing.listId);
  }

  // Apollo discovery is self-host-only (vendor ToS). On Cloud, an explicit
  // request is a clear "not here" message; auto-discovery just skips it.
  if (!isApolloAllowed(deploymentMode)) {
    if (sourcing?.provider === 'apollo') {
      throw new SourcingUnavailableError(
        'Apollo discovery is available on self-hosted getbeyond only.',
      );
    }
    return null;
  }

  // Explicit apollo, OR no source attached (auto-discovery) → try Apollo.
  const account = await prisma.connectorAccount.findUnique({
    where: { orgId_kind: { orgId, kind: 'apollo' } },
    select: { id: true },
  });
  if (!account) {
    if (sourcing?.provider === 'apollo') {
      // The user explicitly chose Apollo but hasn't connected it.
      throw new SourcingUnavailableError(
        'Connect Apollo to discover companies matching your ICP.',
      );
    }
    // No explicit source and no discovery provider connected → prompt.
    return null;
  }

  let creds;
  try {
    creds = await credentials.load(account.id);
  } catch (err) {
    if (err instanceof CredentialManagerError) {
      throw new SourcingUnavailableError(apolloUnavailableMessage(err.code));
    }
    throw err;
  }
  return new ApolloSourcingProvider(
    apolloAdapter,
    creds,
    account.id,
    credentials,
  );
}

/** Map a credential-load failure to an action-oriented user message. */
function apolloUnavailableMessage(code: CredentialManagerErrorCode): string {
  switch (code) {
    case 'expired':
      return 'Your Apollo key was rejected — reconnect Apollo to keep discovering companies.';
    case 'circuit_broken':
      return 'Apollo is temporarily unavailable (too many recent errors). Try again shortly.';
    default:
      return 'Apollo isn’t connected. Connect Apollo to discover companies.';
  }
}
