import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import {
  CSV_IMPORT_QUEUE,
  type CsvImportJobPayload,
  type CsvImportSource,
} from './csv-import.worker';

/**
 * Files at or below this size ride inline (base64) in the pg-boss job
 * payload. Larger files get stashed in object storage and referenced by
 * key. 1 MB keeps tiny dev / test uploads zero-hop while real uploads
 * (which are mostly above 1 MB per real-world CSV sizes) route through S3.
 */
const INLINE_UPLOAD_THRESHOLD_BYTES = 1 * 1024 * 1024;
import {
  CsvImportMetadataSchema,
  type CsvImportEnqueueResponse,
  type CsvImportMetadata,
  type CsvSyncRunStatusResponse,
  CSV_IMPORT_ERROR_RESPONSE_CAP,
} from './csv-import.dto';

interface ParsedMultipart {
  fileBuffer: Buffer;
  metadata: CsvImportMetadata;
}

@Controller('connectors/csv')
@UseGuards(AuthGuard)
export class CsvImportController {
  private readonly prisma: PrismaService;
  private readonly queue: QueueService;
  private readonly storage: StorageService;

  // Explicit @Inject + manual assignment — see CLAUDE.md "NestJS dependency
  // injection — pitfall" for why parameter-property syntax breaks under
  // vitest+esbuild.
  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(QueueService) queue: QueueService,
    @Inject(StorageService) storage: StorageService,
  ) {
    this.prisma = prisma;
    this.queue = queue;
    this.storage = storage;
  }

  /**
   * Get-or-create the org's CSV ConnectorAccount.
   *
   * CSV uploads don't carry credentials, but the upload endpoint requires
   * a sourceAccountId so every Contact has a connector lineage. We expose
   * exactly one CSV account per org (the kind is one-of in v1) — calling
   * this from the UI before the first import surfaces an id the user
   * never has to think about.
   *
   * Idempotent: existing account returned untouched.
   */
  @Post('account')
  async ensureAccount(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<{ id: string }> {
    const existing = await this.prisma.connectorAccount.findFirst({
      where: { orgId: user.orgId, kind: 'csv' },
      select: { id: true },
    });
    if (existing) return { id: existing.id };
    const created = await this.prisma.connectorAccount.create({
      data: {
        orgId: user.orgId,
        kind: 'csv',
        authMode: 'upload',
        credentials: Buffer.from(''), // CSV uploads have no credentials
      },
      select: { id: true },
    });
    return { id: created.id };
  }

  /**
   * Enqueue a CSV import job. Returns 202 + SyncRun id. Caller polls
   * GET /connectors/csv/sync-runs/:id for terminal status.
   *
   * Routing: files ≤ INLINE_UPLOAD_THRESHOLD_BYTES (1 MB) ride inline as
   * base64 in the pg-boss payload. Files above the threshold spill to
   * object storage (MinIO/S3) — the payload carries the S3 key, the
   * worker fetches at execute time + deletes on success. The overall
   * file-size ceiling is whatever the multipart adapter accepts (50 MB).
   */
  @Post('import')
  @HttpCode(202)
  async import(
    @Req() req: FastifyRequest,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<CsvImportEnqueueResponse> {
    const { fileBuffer, metadata } = await parseMultipart(req);

    const account = await this.prisma.connectorAccount.findUnique({
      where: { id: metadata.sourceAccountId },
    });
    if (!account) {
      throw new NotFoundException(
        `ConnectorAccount ${metadata.sourceAccountId} not found`,
      );
    }
    if (account.orgId !== user.orgId) {
      throw new ForbiddenException('ConnectorAccount belongs to another org');
    }
    if (account.kind !== 'csv') {
      throw new BadRequestException(
        `ConnectorAccount kind is ${account.kind}, not csv`,
      );
    }

    // S3 upload happens BEFORE SyncRun creation. If S3 is down, we fail fast
    // without leaving an orphaned SyncRun in 'running'.
    const csv: CsvImportSource =
      fileBuffer.byteLength > INLINE_UPLOAD_THRESHOLD_BYTES
        ? {
            kind: 's3',
            key: await this.storage.put(fileBuffer, {
              prefix: 'csv-uploads',
              contentType: 'text/csv',
            }),
          }
        : { kind: 'inline', base64: fileBuffer.toString('base64') };

    const syncRun = await this.prisma.syncRun.create({
      data: {
        orgId: user.orgId,
        connectorAccountId: metadata.sourceAccountId,
        direction: 'pull',
        status: 'running',
      },
    });

    await this.queue.send<CsvImportJobPayload>(CSV_IMPORT_QUEUE, {
      syncRunId: syncRun.id,
      orgId: user.orgId,
      sourceAccountId: metadata.sourceAccountId,
      csv,
      columnMapping: metadata.columnMapping,
      triggeredBy: user.userId,
    });

    return { syncRunId: syncRun.id, status: 'running' };
  }

  /**
   * Poll SyncRun status. Returns 200 + the current state regardless of
   * whether the worker has finished (callers can poll until status ≠ 'running').
   * orgId comes from the session — 403 on cross-org access.
   */
  @Get('sync-runs/:id')
  async getSyncRun(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<CsvSyncRunStatusResponse> {
    const syncRun = await this.prisma.syncRun.findUnique({ where: { id } });
    if (!syncRun) {
      throw new NotFoundException(`SyncRun ${id} not found`);
    }
    if (syncRun.orgId !== user.orgId) {
      throw new ForbiddenException('SyncRun belongs to another org');
    }

    const rawErrors = Array.isArray(syncRun.errors) ? syncRun.errors : [];
    const errors = rawErrors
      .slice(0, CSV_IMPORT_ERROR_RESPONSE_CAP)
      .map((e: unknown) => {
        if (typeof e === 'object' && e !== null) {
          const obj = e as {
            row?: unknown;
            reason?: unknown;
            message?: unknown;
          };
          return {
            row: typeof obj.row === 'number' ? obj.row : -1,
            reason: typeof obj.reason === 'string' ? obj.reason : 'unknown',
            message: typeof obj.message === 'string' ? obj.message : '',
          };
        }
        return { row: -1, reason: 'unknown', message: '' };
      });

    return {
      syncRunId: syncRun.id,
      status: syncRun.status as 'running' | 'completed' | 'failed',
      recordsIn: syncRun.recordsIn,
      recordsOut: syncRun.recordsOut,
      errorCount: syncRun.errorCount,
      errors,
    };
  }
}

async function parseMultipart(req: FastifyRequest): Promise<ParsedMultipart> {
  if (!req.isMultipart()) {
    throw new BadRequestException(
      'request must be multipart/form-data (file + metadata fields)',
    );
  }

  let fileBuffer: Buffer | undefined;
  let metadataRaw: string | undefined;

  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (part.fieldname === 'file') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk as Buffer);
        }
        fileBuffer = Buffer.concat(chunks);
        if (part.file.truncated) {
          throw new PayloadTooLargeException(
            'CSV file exceeds the configured upload size limit (see main.ts CSV_UPLOAD_MAX_BYTES)',
          );
        }
      } else {
        // Drain unknown file parts so the request doesn't hang.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of part.file) {
          // discard
        }
      }
    } else if (part.type === 'field') {
      if (part.fieldname === 'metadata') {
        metadataRaw = String(part.value);
      }
    }
  }

  if (!fileBuffer) {
    throw new BadRequestException('multipart field "file" is required');
  }
  if (!metadataRaw) {
    throw new BadRequestException('multipart field "metadata" is required');
  }

  let metadataParsed: unknown;
  try {
    metadataParsed = JSON.parse(metadataRaw);
  } catch {
    throw new BadRequestException(
      'multipart field "metadata" must be valid JSON',
    );
  }

  const result = CsvImportMetadataSchema.safeParse(metadataParsed);
  if (!result.success) {
    throw new BadRequestException(
      `metadata validation failed: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  return { fileBuffer, metadata: result.data };
}
