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
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type {
  ProspectSearchDetailResponse,
  ProspectSearchListResponse,
  ProspectSearchStatus,
  CreateProspectSearchResponse,
} from '@getbeyond/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import {
  RUN_EVENT_BUS,
  type RunEventBus,
} from '../teammates/runtime/run-event-bus';
import { ProspectSearchService } from './prospect-search.service';
import { CreateProspectSearchRequestSchema } from './prospect-search.dto';
import { buildProspectSearchStreamObservable } from './prospect-search-stream';

/**
 * ProspectSearch HTTP + SSE endpoints. Mirrors the Researcher controller's shape:
 * AuthGuard everywhere, identity from @CurrentUser() (never the body), enqueue
 * an async run + stream live progress via the RunEventBus.
 *
 *   POST /prospect-searches            → 201 CreateProspectSearchResponse (creates + enqueues)
 *   POST /prospect-searches/:id/rerun  → 201 CreateProspectSearchResponse (clones + enqueues)
 *   GET  /prospect-searches            → 200 ProspectSearchListResponse
 *   GET  /prospect-searches/:id        → 200 ProspectSearchDetailResponse
 *   GET  /prospect-searches/:id/stream → text/event-stream of ProspectSearchEvent
 */
@Controller('prospect-searches')
@UseGuards(AuthGuard)
export class ProspectSearchController {
  private readonly prisma: PrismaService;
  private readonly prospectSearches: ProspectSearchService;
  private readonly eventBus: RunEventBus;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ProspectSearchService) prospectSearches: ProspectSearchService,
    @Inject(RUN_EVENT_BUS) eventBus: RunEventBus,
  ) {
    this.prisma = prisma;
    this.prospectSearches = prospectSearches;
    this.eventBus = eventBus;
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<CreateProspectSearchResponse> {
    const parsed = CreateProspectSearchRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `request body validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return this.prospectSearches.create(user.orgId, user.userId, parsed.data);
  }

  /**
   * Re-run an existing prospectSearch: clones its persisted config into a new prospectSearch
   * and enqueues a fresh run. Tenant + existence are enforced in the service
   * (a prospectSearch from another org is rejected). Returns the new prospectSearch so the
   * client can navigate to and stream it.
   */
  @Post(':id/rerun')
  @HttpCode(201)
  async rerun(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<CreateProspectSearchResponse> {
    return this.prospectSearches.rerun(user.orgId, id, user.userId);
  }

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ProspectSearchListResponse> {
    return this.prospectSearches.list(user.orgId);
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ProspectSearchDetailResponse> {
    return this.prospectSearches.detail(user.orgId, id);
  }

  /**
   * SSE stream of prospectSearch progress events. Validates tenant + existence
   * synchronously (throws before the stream opens for unauthorized requests),
   * then pipes ProspectSearchEvents off the bus. Terminal events
   * (search_completed / search_failed) end the stream.
   */
  @Sse(':id/stream')
  async stream(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<Observable<MessageEvent>> {
    const prospectSearch = await this.prisma.prospectSearch.findUnique({
      where: { id },
      select: { orgId: true, status: true },
    });
    if (!prospectSearch) {
      throw new NotFoundException(`ProspectSearch ${id} not found`);
    }
    if (prospectSearch.orgId !== user.orgId) {
      throw new ForbiddenException('ProspectSearch belongs to another org');
    }
    return buildProspectSearchStreamObservable({
      prospectSearchId: id,
      prospectSearchStatus: prospectSearch.status as ProspectSearchStatus,
      eventBus: this.eventBus,
    });
  }
}
