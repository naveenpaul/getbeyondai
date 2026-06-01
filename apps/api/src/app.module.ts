import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { PrismaModule } from './common/prisma/prisma.module';
import { OrgContextModule } from './common/org-context/org-context.module';
import { QueueModule } from './modules/queue/queue.module';
import { StorageModule } from './modules/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { ConnectorsModule } from './modules/connectors/connectors.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { DraftsModule } from './modules/drafts/drafts.module';
import { InvitesModule } from './modules/invites/invites.module';
import { LlmSettingsModule } from './modules/llm-settings/llm-settings.module';
import { ReapersModule } from './modules/reapers/reapers.module';
import { TeammatesModule } from './modules/teammates/teammates.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    OrgContextModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    AuthModule,
    ConnectorsModule,
    ContactsModule,
    DraftsModule,
    InvitesModule,
    LlmSettingsModule,
    ReapersModule,
    TeammatesModule,
    CampaignsModule,
    // Feature modules land as we implement them:
    //   teammates (runtime + researcher + sdr-drafter + content-drafter)
    //   company-brain, contacts, drafts, fetch, audit, auth, integrations
  ],
  controllers: [AppController],
})
export class AppModule {}
