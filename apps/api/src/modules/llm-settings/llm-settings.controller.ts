import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import type {
  LlmSettingsResponse,
  SaveLlmCredentialResponse,
  TeammateRoutingConfig,
} from '@getbeyond/shared';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { LlmSettingsService } from './llm-settings.service';
import {
  SaveLlmCredentialRequestSchema,
  SaveLlmRoutingRequestSchema,
} from './llm-settings.dto';

/**
 * LLM settings HTTP surface (BYO-key configuration). Mirrors the contacts +
 * campaign controllers: AuthGuard everywhere, identity from @CurrentUser()
 * (never the body), Zod-validate request bodies before touching the service.
 *
 *   GET  /settings/llm             → LlmSettingsResponse (status + routing)
 *   POST /settings/llm/credentials → seal + store a provider key
 *   PUT  /settings/llm/routing     → upsert a teammate's provider + models
 *
 * The API NEVER returns stored key bytes — only whether a key is configured.
 */
@Controller('settings/llm')
@UseGuards(AuthGuard)
export class LlmSettingsController {
  private readonly settings: LlmSettingsService;

  constructor(@Inject(LlmSettingsService) settings: LlmSettingsService) {
    this.settings = settings;
  }

  @Get()
  async get(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<LlmSettingsResponse> {
    return this.settings.getSettings(user.orgId);
  }

  @Post('credentials')
  async saveCredential(
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<SaveLlmCredentialResponse> {
    const parsed = SaveLlmCredentialRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `request body validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return this.settings.saveCredential(
      user.orgId,
      parsed.data.provider,
      parsed.data.apiKey,
    );
  }

  @Put('routing')
  async saveRouting(
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<TeammateRoutingConfig> {
    const parsed = SaveLlmRoutingRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `request body validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return this.settings.saveRouting(user.orgId, parsed.data);
  }
}
