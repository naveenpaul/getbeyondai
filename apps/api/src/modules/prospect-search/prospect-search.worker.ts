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
  PROSPECT_SEARCH_DEFAULTS,
  CONTACT_SOURCING_DEFAULTS,
  extractText,
} from './prospect-search-orchestrator';
import { callModel } from '../teammates/runtime/call-model';
import { searchProviderFromEnv } from '../teammates/runtime/search/registry';
import { contentProviderFromEnv } from '../teammates/runtime/content/registry';
import { SearchDiscoverySourcingProvider } from '../connectors/sourcing/search-discovery.provider';
import { resolveDomainViaSearch } from '../connectors/sourcing/domain-resolver';
import type { WinKey } from '../connectors/sourcing/exclude-wins';
import type { ConnectorKind } from '@getbeyond/shared';
import { searchFailed, toBusEvent } from './prospect-search-events';

export const PROSPECT_SEARCH_RUN_QUEUE = 'prospect-search-run';

/**
 * Output-token cap for the discovery query-build + normalize calls. Higher than
 * the ICP/scoring cap because normalize can emit up to MAX_NORMALIZE_COMPANIES
 * rows when mining a list page; too low truncates the STRICT-JSON mid-array and
 * the parser yields zero companies.
 */
const DISCOVERY_NORMALIZE_MAX_TOKENS = 2048;

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

          // ── Search-discovery wiring (Phase B) ──────────────────────────────
          // Win companies: lookalike exemplars for query building + the
          // exclude-wins suppression set (names only — Contact has no domain).
          const winKeys = data.winsListId
            ? await loadWinKeys(this.prisma, data.orgId, data.winsListId)
            : [];
          // The two discovery LLM calls (query build + normalize) ride ONE
          // audited `news_discovery` AgentRun, minted lazily on first use and
          // capped by the per-search budget (invariants #3/#8). It's finalized
          // in the finally below so the stale-run reaper never touches it.
          const searcher = searchProviderFromEnv();
          const content = contentProviderFromEnv();
          let newsRunId: string | null = null;
          const discoveryChat = async (
            systemPrompt: string,
            userPrompt: string,
          ): Promise<string> => {
            if (!newsRunId) {
              const run = await this.prisma.agentRun.create({
                data: {
                  orgId: data.orgId,
                  teammate: PROSPECT_SEARCH_TEAMMATE,
                  triggeredBy: data.triggeredBy,
                  status: 'running',
                  inputContext: {
                    phase: 'news_discovery',
                    prospectSearchId: data.prospectSearchId,
                  },
                },
              });
              newsRunId = run.id;
            }
            const res = await callModel(this.prisma, provider, {
              runId: newsRunId,
              // Extraction-dominant step → the fast model (cite-or-abstain keeps
              // it honest); ICP derivation + scoring stay on modelPrimary.
              modelName: modelFast,
              systemPrompt,
              messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
              budgetCents: data.budgetCents ?? PROSPECT_SEARCH_DEFAULTS.budgetCents,
              // Higher cap than ICP/scoring: normalize can emit up to
              // MAX_NORMALIZE_COMPANIES rows when a mined list page names many
              // startups — a 1024 cap would truncate the JSON mid-array and the
              // parser would yield zero companies.
              maxTokens: DISCOVERY_NORMALIZE_MAX_TOKENS,
            });
            return extractText(res.message.content);
          };
          const buildSearchDiscovery = (): SourcingProvider =>
            new SearchDiscoverySourcingProvider({
              searcher,
              chat: discoveryChat,
              // Mine list/roundup pages for the companies they name (the answer
              // to "top startups in X" is in the page body, not the snippet).
              fetchPage: async (url: string) => {
                try {
                  return (await content.fetch(url)).text;
                } catch {
                  return null;
                }
              },
              resolveDomain: (name: string) => resolveDomainViaSearch(searcher, name),
              // Keep companies whose domain can't be resolved inline — Stage 2.5
              // enrichment backfills it; dropping pre-qualify lost most list-
              // mined companies (their domain rarely appears in list text).
              dropDomainless: false,
              winNames: winKeys.map((w) => w.name),
              winKeys,
              intent: data.goal,
            });

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
                undefined,
                // Search-discovery is the auto-discovery front-end; consulted
                // only when no explicit source is attached (buildSourcingProvider
                // returns early for an explicit provider before the chain).
                buildSearchDiscovery,
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
          try {
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
          } finally {
            // Finalize the news_discovery run (if search-discovery ran) so the
            // stale-run reaper never touches it. Best-effort: a failure here must
            // not mask the run's own outcome.
            if (newsRunId) {
              await this.prisma.agentRun
                .update({
                  where: { id: newsRunId },
                  data: { status: 'completed', completedAt: new Date() },
                })
                .catch(() => undefined);
            }
          }
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
  /**
   * Builds the keyless search-discovery provider (Phase B), or null when it
   * can't run. Prepended to the auto-discovery chain as the FRONT-END (it finds
   * companies the structured vendors can't, e.g. recently-funded). The worker
   * composes it with searxng + a callModel-backed chat + the wins; tests omit
   * it. Only used in auto-discovery (an explicit source is run alone).
   */
  buildSearchDiscovery?: () => SourcingProvider | null,
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
  // Search-discovery is the front-end (F2): it leads the chain so it runs first,
  // and the FallbackSourcingProvider falls through to the vendors when it returns
  // empty / is unavailable (the empty-fallthrough fix). Keyless + Cloud-safe.
  const searchDiscovery = buildSearchDiscovery?.() ?? null;
  if (searchDiscovery) chain.unshift(searchDiscovery);
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

/** Cap on wins loaded for exemplars + exclude-wins (exemplars are further capped to 5). */
const WINS_LOAD_LIMIT = 200;

/**
 * Load the org's win companies (names) from the wins ContactList for
 * search-discovery: lookalike exemplars for query building + the exclude-wins
 * suppression set. Org-scoped through the list (a cross-org listId matches no
 * rows). Deduped case-insensitively; `Contact` has no domain column, so the
 * keys are name-only (exclude-wins matches on name in that case).
 */
async function loadWinKeys(
  prisma: PrismaService,
  orgId: string,
  winsListId: string,
): Promise<WinKey[]> {
  const members = await prisma.contactListMember.findMany({
    where: { listId: winsListId, list: { orgId } },
    include: { contact: { select: { company: true } } },
    take: WINS_LOAD_LIMIT,
  });
  const seen = new Set<string>();
  const out: WinKey[] = [];
  for (const m of members) {
    const company = (m.contact.company ?? '').trim();
    if (!company) continue;
    const key = company.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: company });
  }
  return out;
}
