import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { PrismaModule } from './common/prisma/prisma.module';
import { OrgContextModule } from './common/org-context/org-context.module';
import { QueueModule } from './modules/queue/queue.module';
import { ConnectorsModule } from './modules/connectors/connectors.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    OrgContextModule,
    PrismaModule,
    QueueModule,
    ConnectorsModule,
    // Feature modules land as we implement them:
    //   teammates (runtime + researcher + sdr-drafter + content-drafter)
    //   company-brain, contacts, drafts, fetch, audit, auth, integrations
  ],
  controllers: [AppController],
})
export class AppModule {}
