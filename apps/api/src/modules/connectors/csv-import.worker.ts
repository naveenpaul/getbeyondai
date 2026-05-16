import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { runCsvImport } from './csv-import.service';
import type { CsvColumnMapping } from './adapters/csv.source';

export const CSV_IMPORT_QUEUE = 'csv-import';

/**
 * pg-boss job payload for the csv-import queue.
 *
 * For T8-CSV.2c.1 the CSV bytes travel inline as base64. Works for files up
 * to a few MB (pg-boss persists payloads in JSONB). Larger uploads need to
 * stash the file in object storage and reference it by key — that's a v1.1
 * enhancement.
 */
export interface CsvImportJobPayload {
  /** SyncRun row already created by the producer. The worker just transitions it. */
  syncRunId: string;
  orgId: string;
  sourceAccountId: string;
  csvBase64: string;
  columnMapping: CsvColumnMapping;
  triggeredBy: string;
}

/**
 * Async consumer of csv-import jobs. Lives in the same process as the API
 * for v1 simplicity; will move to a dedicated apps/worker binary when we
 * either need horizontal scaling or want a hard isolation boundary
 * between request-serving and background work.
 */
@Injectable()
export class CsvImportWorker implements OnModuleInit {
  private readonly logger = new Logger(CsvImportWorker.name);
  private readonly queue: QueueService;
  private readonly prisma: PrismaService;

  // Explicit @Inject(...) + manual assignment instead of parameter-property
  // syntax. vitest uses esbuild which does NOT emit `design:paramtypes`
  // decorator metadata, so parameter properties inject `undefined`. See
  // csv-import.controller.ts for the longer rationale.
  constructor(
    @Inject(QueueService) queue: QueueService,
    @Inject(PrismaService) prisma: PrismaService,
  ) {
    this.queue = queue;
    this.prisma = prisma;
  }

  async onModuleInit(): Promise<void> {
    await this.queue.work<CsvImportJobPayload>(
      CSV_IMPORT_QUEUE,
      async (job) => {
        this.logger.log(
          `processing csv-import job ${job.id} for SyncRun ${job.data.syncRunId}`,
        );
        const csvBuffer = Buffer.from(job.data.csvBase64, 'base64');
        await runCsvImport(this.prisma, {
          orgId: job.data.orgId,
          sourceAccountId: job.data.sourceAccountId,
          csv: { kind: 'buffer', content: csvBuffer },
          columnMapping: job.data.columnMapping,
          triggeredBy: job.data.triggeredBy,
          syncRunId: job.data.syncRunId,
        });
        this.logger.log(`completed csv-import job ${job.id}`);
      },
    );
    this.logger.log(`registered worker for queue "${CSV_IMPORT_QUEUE}"`);
  }
}
