import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { TeammatesModule } from '../teammates/teammates.module';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { CampaignWorker } from './campaign.worker';

/**
 * Campaigns module — the chat/campaigns lookalike-sourcing feature.
 *
 * Wires the campaign controller (HTTP + SSE), the service (create/enqueue +
 * reads), and the pg-boss worker that runs the orchestrator. The orchestrator
 * itself is a plain class the worker constructs per job; it reuses the teammate
 * runtime (LLM_PROVIDER) and the RunEventBus, both exported by TeammatesModule.
 */
@Module({
  imports: [PrismaModule, QueueModule, AuthModule, TeammatesModule],
  controllers: [CampaignController],
  providers: [CampaignService, CampaignWorker],
})
export class CampaignsModule {}
