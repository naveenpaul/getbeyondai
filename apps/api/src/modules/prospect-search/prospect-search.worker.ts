import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type {
  ProspectSearchEvent,
  IcpCriteriaInput,
  SourcingConfig,
} from '@getbeyond/shared';
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
  ZoomInfoSourcingProvider,
  type ZoomInfoCompanySearcher,
} from '../connectors/sourcing/zoominfo-sourcing.provider';
import { ZoomInfoClient } from '../connectors/adapters/zoominfo/zoominfo.source';
import type { DecryptedCredentials } from '@getbeyond/shared';
import {
  SourcingUnavailableError,
  type IcpCriteria,
  type SourcingProvider,
} from '../connectors/sourcing/sourcing-provider';
import {
  PdlSourcingProvider,
  type PdlCompanySearcher,
} from '../connectors/sourcing/pdl-sourcing.provider';
import { canonicalCountry } from '../connectors/sourcing/geo';
import { FallbackSourcingProvider } from '../connectors/sourcing/fallback-sourcing.provider';
import type { WaterfallConnector } from '../connectors/sourcing/waterfall-sourcing.service';
import type { CompanyEnrichmentProvider } from '../connectors/enrichment/enrichment-provider';
import {
  PdlEnrichmentProvider,
  type PdlCompanyEnricher,
} from '../connectors/enrichment/pdl-enrichment.provider';
import { resolveOrgSourcingConfig } from '../connectors/sourcing/org-sourcing-config';
import { apolloSourceAdapter } from '../connectors/adapters/apollo/apollo.source';
import { snovSourceAdapter } from '../connectors/adapters/snov/snov.source';
import { zoominfoSourceAdapter } from '../connectors/adapters/zoominfo/zoominfo.adapter';
import { pdlSourceAdapter } from '../connectors/adapters/pdl/pdl.source';
import {
  CredentialManager,
  CredentialManagerError,
  type CredentialManagerErrorCode,
} from '../connectors/credential-manager';
import {
  isApolloAllowed,
  isPdlAllowed,
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
  icpCriteria: IcpCriteriaInput | null;
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
          const { provider, modelPrimary, modelFast } =
            await this.resolver.resolve(data.orgId, PROSPECT_SEARCH_TEAMMATE);
          // Per-org Stage 5 tuning (connector priority + verification threshold);
          // defaults when the org never configured it.
          const sourcingConfig = await resolveOrgSourcingConfig(
            this.prisma,
            data.orgId,
          );
          const orchestrator = new ProspectSearchOrchestrator({
            prisma: this.prisma,
            llm: provider,
            buildSourcingProvider: (orgId, icp) =>
              buildSourcingProvider(
                this.prisma,
                this.credentials,
                orgId,
                data.sourcing,
                // Test-only injectables default to the registered adapters in
                // prod; the derived ICP rides last so it can steer geo routing.
                undefined,
                undefined,
                undefined,
                icp,
              ),
            buildEnrichmentProvider: (orgId) =>
              buildEnrichmentProvider(this.prisma, this.credentials, orgId),
            buildContactSourcers: (orgId) =>
              buildContactSourcers(
                this.prisma,
                this.credentials,
                orgId,
                sourcingConfig.priority,
              ),
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
            icpCriteria: data.icpCriteria,
            contactThreshold: sourcingConfig.threshold,
            modelName: modelPrimary,
            // Per-candidate research runs on the fast model (cost-dominant);
            // ICP derivation + scoring use modelPrimary for judgment quality.
            researchModelName: modelFast,
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
/** An empty ICP — the routing default when a caller doesn't pass one. */
const ICP_NONE: IcpCriteria = {
  keywords: [],
  employeeCountMin: null,
  employeeCountMax: null,
  fundingStages: [],
  industries: [],
  locations: [],
};

/** True when the ICP names a non-country location (a city/region) — the signal
 * that we need a source with fine, global geo (PDL/Apollo), since ZoomInfo can
 * only filter by country. */
function hasCityLocation(icp: IcpCriteria): boolean {
  return icp.locations.some(
    (loc) => loc.trim().length > 0 && canonicalCountry(loc) === null,
  );
}

export async function buildSourcingProvider(
  prisma: PrismaService,
  credentials: CredentialManager,
  orgId: string,
  sourcing: SourcingConfig | null,
  // Injectable for tests; production uses the registered Apollo adapter singleton.
  apolloAdapter: ApolloOrgSearcher = apolloSourceAdapter,
  // Defaults to the env-resolved mode; tests pass it explicitly.
  deploymentMode: DeploymentMode = resolveDeploymentMode(),
  // Builds a ZoomInfo company searcher from decrypted creds; tests inject a fake.
  zoomInfoSearcherFactory: (
    creds: DecryptedCredentials,
  ) => ZoomInfoCompanySearcher = defaultZoomInfoSearcherFactory,
  // The derived ICP — steers auto-discovery routing (geo-aware). Defaults to an
  // empty ICP (no city → the cheaper-first order, unchanged from before).
  icp: IcpCriteria = ICP_NONE,
  // Injectable for tests; production uses the registered PDL adapter singleton.
  pdlAdapter: PdlCompanySearcher = pdlSourceAdapter,
): Promise<SourcingProvider | null> {
  if (sourcing?.provider === 'contact_list') {
    return new ContactListSourcingProvider(prisma, orgId, sourcing.listId);
  }
  if (sourcing?.provider === 'zoominfo') {
    return buildZoomInfoProvider(
      prisma,
      credentials,
      orgId,
      deploymentMode,
      zoomInfoSearcherFactory,
      true,
    );
  }
  if (sourcing?.provider === 'apollo') {
    return buildApolloProvider(
      prisma,
      credentials,
      orgId,
      apolloAdapter,
      deploymentMode,
      true,
    );
  }
  if (sourcing?.provider === 'pdl') {
    return buildPdlProvider(
      prisma,
      credentials,
      orgId,
      pdlAdapter,
      deploymentMode,
      true,
    );
  }

  // Auto-discovery (no source attached). Order by the ICP's geo needs: a
  // city-scoped goal needs a source with fine, global geo, so prefer PDL (global
  // city-level) and Apollo (global free-form) over ZoomInfo (US/Canada-only geo).
  // A country-level / geo-free goal keeps the cheaper-first order (ZoomInfo
  // company search is free; PDL bills a credit per record).
  //
  // We build ALL connected/allowed providers in that order and wrap them in a
  // FallbackSourcingProvider, so a runtime failure on the preferred one (PDL out
  // of credits, an expired key, a tripped breaker) falls through to the next
  // capable source instead of dead-ending the search. A provider that isn't
  // connected/allowed contributes null and is simply omitted from the chain.
  const order: ReadonlyArray<'pdl' | 'zoominfo' | 'apollo'> = hasCityLocation(icp)
    ? ['pdl', 'apollo', 'zoominfo']
    : ['zoominfo', 'apollo', 'pdl'];
  const chain: SourcingProvider[] = [];
  for (const kind of order) {
    const provider =
      kind === 'zoominfo'
        ? await buildZoomInfoProvider(
            prisma,
            credentials,
            orgId,
            deploymentMode,
            zoomInfoSearcherFactory,
            false,
          )
        : kind === 'apollo'
          ? await buildApolloProvider(
              prisma,
              credentials,
              orgId,
              apolloAdapter,
              deploymentMode,
              false,
            )
          : await buildPdlProvider(
              prisma,
              credentials,
              orgId,
              pdlAdapter,
              deploymentMode,
              false,
            );
    if (provider) chain.push(provider);
  }
  if (chain.length === 0) return null;
  return chain.length === 1 ? chain[0]! : new FallbackSourcingProvider(chain);
}

/**
 * Build the PDL discovery provider, or null when it can't participate. Same
 * `explicit` semantics as {@link buildApolloProvider}. PDL is allowed in all
 * deployment modes today (`isPdlAllowed`); its key is loaded + decrypted at the
 * credential boundary (invariant #6).
 */
async function buildPdlProvider(
  prisma: PrismaService,
  credentials: CredentialManager,
  orgId: string,
  pdlAdapter: PdlCompanySearcher,
  deploymentMode: DeploymentMode,
  explicit: boolean,
): Promise<SourcingProvider | null> {
  if (!isPdlAllowed(deploymentMode)) {
    if (explicit) {
      throw new SourcingUnavailableError(
        'PDL discovery is not available on this deployment.',
      );
    }
    return null;
  }
  const account = await prisma.connectorAccount.findUnique({
    where: { orgId_kind: { orgId, kind: 'pdl' } },
    select: { id: true },
  });
  if (!account) {
    if (explicit) {
      throw new SourcingUnavailableError(
        'Connect PDL to discover companies matching your ICP.',
      );
    }
    return null;
  }
  let creds;
  try {
    creds = await credentials.load(account.id);
  } catch (err) {
    if (err instanceof CredentialManagerError) {
      if (explicit) throw new SourcingUnavailableError(pdlUnavailableMessage(err.code));
      return null;
    }
    throw err;
  }
  return new PdlSourcingProvider(pdlAdapter, creds, account.id, credentials);
}

/** Map a PDL credential-load failure to an action-oriented user message. */
function pdlUnavailableMessage(code: CredentialManagerErrorCode): string {
  switch (code) {
    case 'expired':
      return 'Your PDL key was rejected — reconnect PDL to keep discovering companies.';
    case 'circuit_broken':
      return 'PDL is temporarily unavailable (too many recent errors). Try again shortly.';
    default:
      return 'PDL isn’t connected. Connect PDL to discover companies.';
  }
}

/**
 * Build the per-run company-enrichment provider (Stage 2.5), or null when the
 * org hasn't connected PDL / it isn't usable. Mirrors {@link buildApolloProvider}
 * but is purely best-effort: enrichment is never user-requested-by-name, so a
 * benign problem (not connected, key rejected, circuit open, gated off) just
 * returns null and the orchestrator skips enrichment — it never surfaces a
 * `SourcingUnavailableError`. The PDL key is loaded + decrypted at the credential
 * boundary (invariant #6). PDL is allowed in all modes today (`isPdlAllowed`);
 * if its ToS later forces self-host-only, that one helper gates this too.
 */
export async function buildEnrichmentProvider(
  prisma: PrismaService,
  credentials: CredentialManager,
  orgId: string,
  // Injectable for tests; production uses the registered PDL adapter singleton.
  pdlAdapter: PdlCompanyEnricher = pdlSourceAdapter,
  // Defaults to the env-resolved mode; tests pass it explicitly.
  deploymentMode: DeploymentMode = resolveDeploymentMode(),
): Promise<CompanyEnrichmentProvider | null> {
  if (!isPdlAllowed(deploymentMode)) return null;
  const account = await prisma.connectorAccount.findUnique({
    where: { orgId_kind: { orgId, kind: 'pdl' } },
    select: { id: true },
  });
  if (!account) return null;
  let creds;
  try {
    creds = await credentials.load(account.id);
  } catch (err) {
    // A benign credential problem (key rejected / circuit open) just means no
    // enrichment this run — never fail the prospectSearch over it.
    if (err instanceof CredentialManagerError) return null;
    throw err;
  }
  return new PdlEnrichmentProvider(pdlAdapter, creds, account.id, credentials);
}

/**
 * Build the Apollo discovery provider, or null when it can't participate in
 * auto-discovery. `explicit` = the user chose Apollo by name, so a benign
 * problem (gated on Cloud / not connected / key rejected) becomes an actionable
 * `SourcingUnavailableError`; in auto-discovery the same problems return null so
 * the caller can try the next provider. Non-credential errors always bubble.
 */
async function buildApolloProvider(
  prisma: PrismaService,
  credentials: CredentialManager,
  orgId: string,
  apolloAdapter: ApolloOrgSearcher,
  deploymentMode: DeploymentMode,
  explicit: boolean,
): Promise<SourcingProvider | null> {
  // Apollo discovery is self-host-only (vendor ToS).
  if (!isApolloAllowed(deploymentMode)) {
    if (explicit) {
      throw new SourcingUnavailableError(
        'Apollo discovery is available on self-hosted getbeyond only.',
      );
    }
    return null;
  }
  const account = await prisma.connectorAccount.findUnique({
    where: { orgId_kind: { orgId, kind: 'apollo' } },
    select: { id: true },
  });
  if (!account) {
    if (explicit) {
      throw new SourcingUnavailableError(
        'Connect Apollo to discover companies matching your ICP.',
      );
    }
    return null;
  }
  let creds;
  try {
    creds = await credentials.load(account.id);
  } catch (err) {
    if (err instanceof CredentialManagerError) {
      // Explicit: surface "reconnect Apollo". Auto-discovery: a dead key must
      // NOT abort the whole chain — drop Apollo and let the next capable source
      // (PDL/ZoomInfo) try. Mirrors buildPdlProvider / buildZoomInfoProvider.
      if (explicit) {
        throw new SourcingUnavailableError(apolloUnavailableMessage(err.code));
      }
      return null;
    }
    throw err;
  }
  return new ApolloSourcingProvider(apolloAdapter, creds, account.id, credentials);
}

/**
 * Build the ZoomInfo discovery provider, or null when it can't participate.
 * Same `explicit` semantics as {@link buildApolloProvider}. ZoomInfo discovery
 * is self-host-only too (data-redistribution ToS). In auto-discovery a benign
 * problem returns null so the caller falls back to Apollo.
 */
async function buildZoomInfoProvider(
  prisma: PrismaService,
  credentials: CredentialManager,
  orgId: string,
  deploymentMode: DeploymentMode,
  searcherFactory: (creds: DecryptedCredentials) => ZoomInfoCompanySearcher,
  explicit: boolean,
): Promise<SourcingProvider | null> {
  if (deploymentMode !== 'self_host') {
    if (explicit) {
      throw new SourcingUnavailableError(
        'ZoomInfo discovery is available on self-hosted getbeyond only.',
      );
    }
    return null;
  }
  const account = await prisma.connectorAccount.findUnique({
    where: { orgId_kind: { orgId, kind: 'zoominfo' } },
    select: { id: true },
  });
  if (!account) {
    if (explicit) {
      throw new SourcingUnavailableError(
        'Connect ZoomInfo to discover companies matching your ICP.',
      );
    }
    return null;
  }
  let creds;
  try {
    creds = await credentials.load(account.id);
  } catch (err) {
    if (err instanceof CredentialManagerError) {
      // Explicit: surface "reconnect ZoomInfo". Auto: skip + let Apollo try.
      if (explicit) {
        throw new SourcingUnavailableError(zoomInfoUnavailableMessage(err.code));
      }
      return null;
    }
    throw err;
  }
  return new ZoomInfoSourcingProvider(
    searcherFactory(creds),
    account.id,
    credentials,
  );
}

/** Default factory: a real ZoomInfoClient built from the org's decrypted creds. */
function defaultZoomInfoSearcherFactory(
  creds: DecryptedCredentials,
): ZoomInfoCompanySearcher {
  return new ZoomInfoClient({
    clientId: typeof creds['clientId'] === 'string' ? creds['clientId'] : undefined,
    clientSecret:
      typeof creds['clientSecret'] === 'string' ? creds['clientSecret'] : undefined,
  });
}

/** Map a ZoomInfo credential-load failure to an action-oriented user message. */
function zoomInfoUnavailableMessage(code: CredentialManagerErrorCode): string {
  switch (code) {
    case 'expired':
      return 'Your ZoomInfo credentials were rejected — reconnect ZoomInfo to keep discovering companies.';
    case 'circuit_broken':
      return 'ZoomInfo is temporarily unavailable (too many recent errors). Try again shortly.';
    default:
      return 'ZoomInfo isn’t connected. Connect ZoomInfo to discover companies.';
  }
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
 * Build the org's ordered enrichment connectors for Stage 5 (contact sourcing).
 *
 * Mirrors `buildSourcingProvider`, but for the contacts-with-emails waterfall:
 * for each connected enrichment connector (in the caller-supplied `priority`
 * order — per-org configurable, defaults to [zoominfo, snov]) it loads +
 * decrypts the BYO key (invariant #6) and wraps the adapter as a
 * `WaterfallConnector` bound to those creds + the credential-manager's breaker
 * hooks. A connector that isn't connected, or whose key is rejected /
 * circuit-broken, simply sits out the waterfall — Stage 5 is best-effort and
 * never fails the prospectSearch. Both ZoomInfo and Snov adapters are wired.
 */
export async function buildContactSourcers(
  prisma: PrismaService,
  credentials: CredentialManager,
  orgId: string,
  priority: readonly ConnectorKind[],
): Promise<WaterfallConnector[]> {
  const connectors: WaterfallConnector[] = [];
  for (const kind of priority) {
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
