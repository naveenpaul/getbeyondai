import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { LlmCredentialManager } from '../teammates/runtime/llm-credential-manager';
import { KeyVerifier } from './key-verifier';
import { LlmSettingsController } from './llm-settings.controller';
import { LlmSettingsService } from './llm-settings.service';

/**
 * LLM settings module — the BYO-key + teammate-routing configuration surface.
 *
 * LlmCredentialManager was previously orphaned (defined but in no module's
 * providers, so it could not inject). We register it here as a provider; it
 * depends only on PrismaService (supplied by PrismaModule) and reads
 * CREDENTIAL_MASTER_KEY from env at construction.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [LlmSettingsController],
  providers: [LlmSettingsService, LlmCredentialManager, KeyVerifier],
})
export class LlmSettingsModule {}
