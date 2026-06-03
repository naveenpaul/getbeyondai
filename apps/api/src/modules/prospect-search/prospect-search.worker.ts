import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ProspectSearchEvent, SourcingConfig } from '@getbeyond/shared';
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
import type { WaterfallConnector } from '../connectors/sourcing/waterfall-sourcing.service';
import { apolloSourceAdapter } from '../connectors/adapters/apollo/apollo.source';
import { snovSourceAdapter } from '../connectors/adapters/snov/snov.source';
import { zoominfoSourceAdapter } from '../connectors/adapters/zoominfo/zoominfo.adapter';
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
  ProspectSearchOrchestrator,
  PROSPECT_SEARCH_TEAMMATE,
  CONTACT_SOURCING_DEFAULTS,
} from './prospect-search-orchestrator';
import type { ConnectorKind } from '@getbeyond/shared';
import { searchFailed, toBusEvent } from './prospect-search-events';

export const PROSPECT_SEARCH_RUN_QUEUE = 'prospect-search-run';

/**
 * pg-boss consumer for prospectSearch orchestrator runs.
 *
 * Producer (controller) creates the ProspectSearch synchronously (status='running')
 * to mint a prospectSearchId, then enqueues this job. The worker builds the per-run
 * sourcing provider from the prospectSearch's SourcingConfig, wires the orchestrator's
 * event sink to the RunEventBus (so the SSE stream sees live progress), and
 * drives the prospectSearch to terminal.
 *
 * Failure semantics:
 *   - The orchestrator never throws for expected failures (sourcing config,
 *     budget, research errors) — it sets ProspectSearch.status='failed' and emits
 *     search_failed itself. Those return cleanly; the job succeeds.
 *   - A genuine thrown error (DB unreachable) leaves the prospectSearch in 'running'
 *     and bubbles out. We emit a search_failed on the bus first (so the
 *     stream closes) then re-throw for pg-boss's retry policy.
 */
export interface ProspectSearchRunJobPayload {
  prospectSearchId: string;
  orgId: string;
  triggeredBy: string;
  goal: string;
  winsListId: string | null;
  sourcing: SourcingConfig | null;
  budgetCents?: number;
}

@Injectable()
export class ProspectSearchWorker implements OnModuleInit {
  private readonly logger = new Logger(ProspectSearchWorker.name);
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
    await this.queue.work<ProspectSearchRunJobPayload>(
      PROSPECT_SEARCH_RUN_QUEUE,
      async (job) => {
        const { data } = job;
        this.logger.log(
          `processing prospect-search-run job ${job.id} for ProspectSearch ${data.prospectSearchId}`,
        );
        try {
          // Resolve the per-run provider (org BYO → env → block). A "no key"
          // failure is caught below → search_failed on the stream.
          const { provider, modelPrimary } = await this.resolver.resolve(
            data.orgId,
            PROSPECT_SEARCH_TEAMMATE,
          );
          const orchestrator = new ProspectSearchOrchestrator({
            prisma: this.prisma,
            llm: provider,
            buildSourcingProvider: (orgId) =>
              buildSourcingProvider(
                this.prisma,
                this.credentials,
                orgId,
                data.sourcing,
              ),
            buildContactSourcers: (orgId) =>
              buildContactSourcers(this.prisma, this.credentials, orgId),
            // ProspectSearchEvents ride the same bus the teammate runtime uses.
            // toBusEvent stamps runId=prospectSearchId so the bus (which routes by
            // runId) delivers them to the stream subscribed by prospectSearchId.
            emitEvent: (event: ProspectSearchEvent) =>
              this.eventBus.publish(toBusEvent(event)),
          });
          const result = await orchestrator.run({
            prospectSearchId: data.prospectSearchId,
            orgId: data.orgId,
            triggeredBy: data.triggeredBy,
            goal: data.goal,
            winsListId: data.winsListId,
            modelName: modelPrimary,
            budgetCents: data.budgetCents,
          });
          this.logger.log(
            `completed prospect-search-run job ${job.id}: status=${result.status} ` +
              `prospects=${result.prospectCount} cost=${result.costCents}¢`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.eventBus.publish(
            toBusEvent(searchFailed(data.prospectSearchId, message)),
          );
          throw err;
        }
      },
    );
    this.logger.log(`registered worker for queue "${PROSPECT_SEARCH_RUN_QUEUE}"`);
  }
}

/**
 * Build the sourcing provider for a prospectSearch from its SourcingConfig.
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
 * orchestrator surfaces gracefully rather than failing the prospectSearch.
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

/**
 * Priority order for Stage 5 contact enrichment (eng-review A3 default):
 * ZoomInfo first (better verification for the verified-chase), then Snov. Only
 * connectors with a committed adapter are listed; ZoomInfo joins when its
 * adapter lands.
 */
const CONTACT_SOURCER_PRIORITY: readonly ConnectorKind[] = ['zoominfo', 'snov'];

/**
 * Build the org's ordered enrichment connectors for Stage 5 (contact sourcing).
 *
 * Mirrors `buildSourcingProvider`, but for the contacts-with-emails waterfall:
 * for each connected enrichment connector (in priority order) it loads + decrypts
 * the BYO key (invariant #6) and wraps the adapter as a `WaterfallConnector`
 * bound to those creds + the credential-manager's breaker hooks. A connector
 * that isn't connected, or whose key is rejected / circuit-broken, simply sits
 * out the waterfall — Stage 5 is best-effort and never fails the prospectSearch.
 */
export async function buildContactSourcers(
  prisma: PrismaService,
  credentials: CredentialManager,
  orgId: string,
): Promise<WaterfallConnector[]> {
  const connectors: WaterfallConnector[] = [];
  for (const kind of CONTACT_SOURCER_PRIORITY) {
    const connector = await buildOneContactSourcer(
      prisma,
      credentials,
      orgId,
      kind,
    );
    if (connector) connectors.push(connector);
  }
  return connectors;
}

/** Build one bound `WaterfallConnector`, or null if it can't participate. */
async function buildOneContactSourcer(
  prisma: PrismaService,
  credentials: CredentialManager,
  orgId: string,
  kind: ConnectorKind,
): Promise<WaterfallConnector | null> {
  const account = await prisma.connectorAccount.findUnique({
    where: { orgId_kind: { orgId, kind } },
    select: { id: true },
  });
  if (!account) return null;

  let creds;
  try {
    creds = await credentials.load(account.id);
  } catch (err) {
    // A benign credential problem (key rejected / circuit open) just means this
    // connector sits out the waterfall — never fail the prospectSearch over it.
    if (err instanceof CredentialManagerError) return null;
    throw err;
  }

  const accountId = account.id;
  if (kind === 'snov') {
    return {
      kind: 'snov',
      accountId,
      sourceForCompany: (company) =>
        snovSourceAdapter.syncContacts({
          creds,
          config: {
            domains: [company.domain],
            maxContactsPerDomain: CONTACT_SOURCING_DEFAULTS.contactsPerCompany,
          },
          onVendorFailure: (failureKind) =>
            credentials.reportVendorFailure(accountId, failureKind),
          onVendorSuccess: () => credentials.reportVendorSuccess(accountId),
        }),
    };
  }
  if (kind === 'zoominfo') {
    return {
      kind: 'zoominfo',
      accountId,
      sourceForCompany: (company) =>
        zoominfoSourceAdapter.syncContacts({
          creds,
          config: {
            companyName: company.name,
            maxContacts: CONTACT_SOURCING_DEFAULTS.contactsPerCompany,
          },
          onVendorFailure: (failureKind) =>
            credentials.reportVendorFailure(accountId, failureKind),
          onVendorSuccess: () => credentials.reportVendorSuccess(accountId),
        }),
    };
  }
  return null;
}
