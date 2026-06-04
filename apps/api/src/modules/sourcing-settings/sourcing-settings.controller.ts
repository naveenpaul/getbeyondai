import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { SourcingSettingsResponse } from '@getbeyond/shared';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { SourcingSettingsService } from './sourcing-settings.service';
import { SaveSourcingSettingsRequestSchema } from './sourcing-settings.dto';

/**
 * Sourcing settings HTTP surface (Stage 5 waterfall config). Mirrors the LLM
 * settings controller: AuthGuard everywhere, identity from @CurrentUser() (never
 * the body), Zod-validate the request body before touching the service.
 *
 *   GET /settings/sourcing → SourcingSettingsResponse
 *   PUT /settings/sourcing → upsert priority + threshold
 */
@Controller('settings/sourcing')
@UseGuards(AuthGuard)
export class SourcingSettingsController {
  private readonly settings: SourcingSettingsService;

  constructor(@Inject(SourcingSettingsService) settings: SourcingSettingsService) {
    this.settings = settings;
  }

  @Get()
  async get(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<SourcingSettingsResponse> {
    return this.settings.getSettings(user.orgId);
  }

  @Put()
  async save(
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<SourcingSettingsResponse> {
    const parsed = SaveSourcingSettingsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `request body validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return this.settings.saveSettings(user.orgId, parsed.data);
  }
}
