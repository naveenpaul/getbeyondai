import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { SourcingSettingsController } from './sourcing-settings.controller';
import { SourcingSettingsService } from './sourcing-settings.service';

/**
 * Sourcing settings module — per-org Stage 5 waterfall configuration (connector
 * priority + verification threshold). Depends only on PrismaService (via
 * PrismaModule) and the AuthGuard (via AuthModule).
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SourcingSettingsController],
  providers: [SourcingSettingsService],
})
export class SourcingSettingsModule {}
