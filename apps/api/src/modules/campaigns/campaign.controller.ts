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
  CampaignDetailResponse,
  CampaignListResponse,
  CampaignStatus,
  CreateCampaignResponse,
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
import { CampaignService } from './campaign.service';
import { CreateCampaignRequestSchema } from './campaign.dto';
import { buildCampaignStreamObservable } from './campaign-stream';

/**
 * Campaign HTTP + SSE endpoints. Mirrors the Researcher controller's shape:
 * AuthGuard everywhere, identity from @CurrentUser() (never the body), enqueue
 * an async run + stream live progress via the RunEventBus.
 *
 *   POST /campaigns            → 201 CreateCampaignResponse (creates + enqueues)
 *   GET  /campaigns            → 200 CampaignListResponse
 *   GET  /campaigns/:id        → 200 CampaignDetailResponse
 *   GET  /campaigns/:id/stream → text/event-stream of CampaignEvent
 */
@Controller('campaigns')
@UseGuards(AuthGuard)
export class CampaignController {
  private readonly prisma: PrismaService;
  private readonly campaigns: CampaignService;
  private readonly eventBus: RunEventBus;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(CampaignService) campaigns: CampaignService,
    @Inject(RUN_EVENT_BUS) eventBus: RunEventBus,
  ) {
    this.prisma = prisma;
    this.campaigns = campaigns;
    this.eventBus = eventBus;
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<CreateCampaignResponse> {
    const parsed = CreateCampaignRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `request body validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return this.campaigns.create(user.orgId, user.userId, parsed.data);
  }

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<CampaignListResponse> {
    return this.campaigns.list(user.orgId);
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<CampaignDetailResponse> {
    return this.campaigns.detail(user.orgId, id);
  }

  /**
   * SSE stream of campaign progress events. Validates tenant + existence
   * synchronously (throws before the stream opens for unauthorized requests),
   * then pipes CampaignEvents off the bus. Terminal events
   * (campaign_completed / campaign_failed) end the stream.
   */
  @Sse(':id/stream')
  async stream(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<Observable<MessageEvent>> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      select: { orgId: true, status: true },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign ${id} not found`);
    }
    if (campaign.orgId !== user.orgId) {
      throw new ForbiddenException('Campaign belongs to another org');
    }
    return buildCampaignStreamObservable({
      campaignId: id,
      campaignStatus: campaign.status as CampaignStatus,
      eventBus: this.eventBus,
    });
  }
}
