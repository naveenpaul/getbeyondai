import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import {
  ANTHROPIC_CLIENT,
  createAnthropicClient,
} from './runtime/call-model';
import { ResearcherController } from './researcher/researcher.controller';

/**
 * Teammates module — wires the Anthropic SDK singleton and registers all
 * teammate controllers. The runtime itself is import-only (no DI surface);
 * services consume it as pure functions.
 *
 * Future teammates (SDR Drafter, Content Drafter, Reply Handler) add their
 * controllers here without touching the runtime.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ResearcherController],
  providers: [
    {
      provide: ANTHROPIC_CLIENT,
      useFactory: () =>
        createAnthropicClient(process.env.ANTHROPIC_API_KEY ?? ''),
    },
  ],
  exports: [ANTHROPIC_CLIENT],
})
export class TeammatesModule {}
