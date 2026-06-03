import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import {
  DEPLOYMENT_MODE,
  resolveDeploymentMode,
} from '../../common/deployment';
import { apolloSourceAdapter } from './adapters/apollo/apollo.source';
import { snovSourceAdapter } from './adapters/snov/snov.source';
import {
  ApolloConnectController,
  APOLLO_SOURCE_ADAPTER,
} from './apollo-connect.controller';
import {
  SnovConnectController,
  SNOV_SOURCE_ADAPTER,
} from './snov-connect.controller';
import { CredentialManager } from './credential-manager';
import { CsvImportController } from './csv-import.controller';
import { CsvImportWorker } from './csv-import.worker';
import { HubspotOauthController } from './hubspot-oauth.controller';
import { HubspotSyncController } from './hubspot-sync.controller';
import { HubspotSyncWorker } from './hubspot-sync.worker';

@Module({
  imports: [PrismaModule, QueueModule, StorageModule, AuthModule],
  controllers: [
    CsvImportController,
    HubspotOauthController,
    HubspotSyncController,
    ApolloConnectController,
    SnovConnectController,
  ],
  providers: [
    CsvImportWorker,
    CredentialManager,
    HubspotSyncWorker,
    // The real adapter in prod; unit tests override this token with a stub.
    { provide: APOLLO_SOURCE_ADAPTER, useValue: apolloSourceAdapter },
    { provide: SNOV_SOURCE_ADAPTER, useValue: snovSourceAdapter },
    { provide: DEPLOYMENT_MODE, useFactory: resolveDeploymentMode },
  ],
  exports: [CredentialManager],
})
export class ConnectorsModule {}
