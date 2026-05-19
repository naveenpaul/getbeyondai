import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import {
  ANTHROPIC_CLIENT,
  createAnthropicClient,
} from './runtime/call-model';
import {
  InMemoryRunEventBus,
  RUN_EVENT_BUS,
} from './runtime/run-event-bus';
import { ResearcherController } from './researcher/researcher.controller';
import { ResearcherWorker } from './researcher/researcher.worker';

/**
 * Teammates module — wires the Anthropic SDK singleton and registers all
 * teammate controllers + workers. The runtime itself is import-only (no DI
 * surface); services consume it as pure functions.
 *
 * Future teammates (SDR Drafter, Content Drafter, Reply Handler) add their
 * controllers + workers here without touching the runtime.
 */
@Module({
  imports: [PrismaModule, QueueModule],
  controllers: [ResearcherController],
  providers: [
    {
      provide: ANTHROPIC_CLIENT,
      useFactory: () =>
        createAnthropicClient(process.env.ANTHROPIC_API_KEY ?? ''),
    },
    {
      provide: RUN_EVENT_BUS,
      useClass: InMemoryRunEventBus,
    },
    ResearcherWorker,
  ],
  exports: [ANTHROPIC_CLIENT, RUN_EVENT_BUS],
})
export class TeammatesModule {}
