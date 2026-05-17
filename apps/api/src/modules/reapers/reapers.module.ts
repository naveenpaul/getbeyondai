import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { DraftActionReaper } from './draft-action.reaper';
import { SyncRunReaper } from './sync-run.reaper';

@Module({
  imports: [PrismaModule, QueueModule],
  providers: [SyncRunReaper, DraftActionReaper],
  exports: [SyncRunReaper, DraftActionReaper],
})
export class ReapersModule {}
