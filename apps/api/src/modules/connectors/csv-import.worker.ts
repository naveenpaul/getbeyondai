import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { runCsvImport } from './csv-import.service';
import type { CsvColumnMapping } from './adapters/csv.source';

export const CSV_IMPORT_QUEUE = 'csv-import';

/**
 * Where the CSV bytes for this job actually live. Small uploads ride inline
 * in the pg-boss payload (cheap, no extra hop). Larger uploads (>1 MB) get
 * stashed in S3/MinIO and referenced by key — the worker fetches at execute
 * time and deletes the object on successful completion.
 */
export type CsvImportSource =
  | { kind: 'inline'; base64: string }
  | { kind: 's3'; key: string };

export interface CsvImportJobPayload {
  /** SyncRun row already created by the producer. The worker just transitions it. */
  syncRunId: string;
  orgId: string;
  sourceAccountId: string;
  csv: CsvImportSource;
  columnMapping: CsvColumnMapping;
  triggeredBy: string;
  /** Display name for the ContactList created from this import (optional). */
  listName?: string;
}

/**
 * Async consumer of csv-import jobs.
 *
 * For each job: hydrate the CSV bytes (inline base64 → Buffer, or S3 key →
 * fetch), call runCsvImport with the existing SyncRun, and on success
 * delete the S3 object (if any). On failure: re-throw so pg-boss applies
 * its retry policy. We deliberately do NOT delete the S3 object on failure
 * — pg-boss will retry with the same payload + same key, so deletion would
 * leave subsequent attempts with nothing to read. Orphaned S3 objects from
 * dead-lettered jobs are caught by a periodic sweep (T8-CSV.2c.4-ish).
 */
@Injectable()
export class CsvImportWorker implements OnModuleInit {
  private readonly logger = new Logger(CsvImportWorker.name);
  private readonly queue: QueueService;
  private readonly prisma: PrismaService;
  private readonly storage: StorageService;

  // Explicit @Inject + manual assignment — see CLAUDE.md "NestJS dependency
  // injection — pitfall" for why parameter-property syntax breaks under
  // vitest+esbuild.
  constructor(
    @Inject(QueueService) queue: QueueService,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(StorageService) storage: StorageService,
  ) {
    this.queue = queue;
    this.prisma = prisma;
    this.storage = storage;
  }

  async onModuleInit(): Promise<void> {
    await this.queue.work<CsvImportJobPayload>(
      CSV_IMPORT_QUEUE,
      async (job) => {
        this.logger.log(
          `processing csv-import job ${job.id} for SyncRun ${job.data.syncRunId} ` +
            `(source=${job.data.csv.kind})`,
        );
        const csvBuffer = await this.hydrate(job.data.csv);
        await runCsvImport(this.prisma, {
          orgId: job.data.orgId,
          sourceAccountId: job.data.sourceAccountId,
          csv: { kind: 'buffer', content: csvBuffer },
          columnMapping: job.data.columnMapping,
          triggeredBy: job.data.triggeredBy,
          listName: job.data.listName,
          syncRunId: job.data.syncRunId,
        });
        // Success path only — leave S3 object intact on failure so pg-boss
        // retries can replay against the same bytes.
        if (job.data.csv.kind === 's3') {
          await this.storage.delete(job.data.csv.key);
        }
        this.logger.log(`completed csv-import job ${job.id}`);
      },
    );
    this.logger.log(`registered worker for queue "${CSV_IMPORT_QUEUE}"`);
  }

  private async hydrate(source: CsvImportSource): Promise<Buffer> {
    switch (source.kind) {
      case 'inline':
        return Buffer.from(source.base64, 'base64');
      case 's3':
        return this.storage.get(source.key);
    }
  }
}
