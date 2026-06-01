import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import type {
  LlmProviderName,
  LlmSettingsResponse,
  SaveLlmCredentialResponse,
  TeammateRoutingConfig,
  TestLlmCredentialResponse,
} from '@getbeyond/shared';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { LlmSettingsService } from './llm-settings.service';
import {
  LLM_PROVIDER_NAMES,
  SaveLlmCredentialRequestSchema,
  SaveLlmRoutingRequestSchema,
} from './llm-settings.dto';

/**
 * LLM settings HTTP surface (BYO-key configuration). Mirrors the contacts +
 * campaign controllers: AuthGuard everywhere, identity from @CurrentUser()
 * (never the body), Zod-validate request bodies before touching the service.
 *
 *   GET  /settings/llm                          → LlmSettingsResponse
 *   POST /settings/llm/credentials              → seal + store a provider key
 *   POST /settings/llm/credentials/:provider/test → live-verify the stored key
 *   PUT  /settings/llm/routing                  → upsert a teammate's routing
 *
 * The API NEVER returns stored key bytes — only whether a key is configured
 * and (via the test route) whether it authenticates.
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

  /**
   * Live-verify the stored key for a provider. An invalid key is a normal
   * `{ ok: false }` verdict (200), not an error status — only a bad `:provider`
   * path param is a 400.
   */
  @Post('credentials/:provider/test')
  async testCredential(
    @Param('provider') provider: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<TestLlmCredentialResponse> {
    if (!(LLM_PROVIDER_NAMES as readonly string[]).includes(provider)) {
      throw new BadRequestException(
        `Unknown provider "${provider}" — expected one of: ${LLM_PROVIDER_NAMES.join(', ')}.`,
      );
    }
    return this.settings.testCredential(
      user.orgId,
      provider as LlmProviderName,
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
