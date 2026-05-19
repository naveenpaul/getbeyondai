import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { AgentRunReaper } from './agent-run.reaper';
import { DraftActionReaper } from './draft-action.reaper';
import { OAuthStateReaper } from './oauth-state.reaper';
import { SyncRunReaper } from './sync-run.reaper';

@Module({
  imports: [PrismaModule, QueueModule],
  providers: [
    SyncRunReaper,
    DraftActionReaper,
    OAuthStateReaper,
    AgentRunReaper,
  ],
  exports: [
    SyncRunReaper,
    DraftActionReaper,
    OAuthStateReaper,
    AgentRunReaper,
  ],
})
export class ReapersModule {}
