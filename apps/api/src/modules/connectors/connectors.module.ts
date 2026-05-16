import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CsvImportController } from './csv-import.controller';

@Module({
  imports: [PrismaModule],
  controllers: [CsvImportController],
})
export class ConnectorsModule {}
