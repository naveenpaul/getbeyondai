import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { CsvImportController } from './csv-import.controller';
import { CsvImportWorker } from './csv-import.worker';

@Module({
  imports: [PrismaModule, QueueModule],
  controllers: [CsvImportController],
  providers: [CsvImportWorker],
})
export class ConnectorsModule {}
