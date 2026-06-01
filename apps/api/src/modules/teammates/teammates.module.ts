import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { LLM_PROVIDER } from './runtime/llm-provider';
import { createAnthropicProvider } from './runtime/providers/anthropic.provider';
import {
  InMemoryRunEventBus,
  RUN_EVENT_BUS,
} from './runtime/run-event-bus';
import { ResearcherController } from './researcher/researcher.controller';
import { ResearcherWorker } from './researcher/researcher.worker';
import { SdrDrafterController } from './sdr-drafter/sdr-drafter.controller';
import { SdrDrafterWorker } from './sdr-drafter/sdr-drafter.worker';

/**
 * Teammates module — wires the Anthropic SDK singleton and registers all
 * teammate controllers + workers. The runtime itself is import-only (no DI
 * surface); services consume it as pure functions.
 *
 * Future teammates (SDR Drafter, Content Drafter, Reply Handler) add their
 * controllers + workers here without touching the runtime.
 */
@Module({
  imports: [PrismaModule, QueueModule, AuthModule],
  controllers: [ResearcherController, SdrDrafterController],
  providers: [
    {
      // P1: single Anthropic provider built from env. Later phases replace
      // this with a registry/resolver that builds a per-run, per-org provider
      // bound to the resolved (BYO or env) key.
      provide: LLM_PROVIDER,
      useFactory: () =>
        createAnthropicProvider(process.env.ANTHROPIC_API_KEY ?? ''),
    },
    {
      // useFactory, not useClass: the constructor takes an options bag
      // (`opts: { bufferCleanupMs? } = {}`), which NestJS would try to
      // DI-resolve as a provider named `Object` and fail. The options
      // default to {}, so construct it directly.
      provide: RUN_EVENT_BUS,
      useFactory: () => new InMemoryRunEventBus(),
    },
    ResearcherWorker,
    SdrDrafterWorker,
  ],
  exports: [LLM_PROVIDER, RUN_EVENT_BUS],
})
export class TeammatesModule {}
