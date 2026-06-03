import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { TeammatesModule } from '../teammates/teammates.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { ProspectSearchController } from './prospect-search.controller';
import { ProspectSearchService } from './prospect-search.service';
import { ProspectSearchWorker } from './prospect-search.worker';

/**
 * ProspectSearches module — the chat/prospect-searches lookalike-sourcing feature.
 *
 * Wires the prospectSearch controller (HTTP + SSE), the service (create/enqueue +
 * reads), and the pg-boss worker that runs the orchestrator. The orchestrator
 * itself is a plain class the worker constructs per job; it reuses the teammate
 * runtime (LlmResolver for the per-run provider) and the RunEventBus, both
 * exported by TeammatesModule.
 */
@Module({
  imports: [
    PrismaModule,
    QueueModule,
    AuthModule,
    TeammatesModule,
    ConnectorsModule,
  ],
  controllers: [ProspectSearchController],
  providers: [ProspectSearchService, ProspectSearchWorker],
})
export class ProspectSearchModule {}
