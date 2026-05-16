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
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import {
  CSV_IMPORT_QUEUE,
  type CsvImportJobPayload,
} from './csv-import.worker';
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
export class CsvImportController {
  private readonly prisma: PrismaService;
  private readonly queue: QueueService;

  // Explicit @Inject + manual assignment — see CLAUDE.md "NestJS dependency
  // injection — pitfall" for why parameter-property syntax breaks under
  // vitest+esbuild.
  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(QueueService) queue: QueueService,
  ) {
    this.prisma = prisma;
    this.queue = queue;
  }

  /**
   * Enqueue a CSV import job. Returns 202 + SyncRun id. Caller polls
   * GET /connectors/csv/sync-runs/:id for terminal status.
   *
   * v1 phase 2 (T8-CSV.2c.2): CSV bytes travel inline as base64 inside the
   * pg-boss job payload. Hard-capped at 5 MB by the multipart limit in
   * main.ts. The next slice (T8-CSV.2c.3) routes >5 MB files through
   * object storage and lifts the cap.
   */
  @Post('import')
  @HttpCode(202)
  async import(@Req() req: FastifyRequest): Promise<CsvImportEnqueueResponse> {
    const { fileBuffer, metadata } = await parseMultipart(req);

    const account = await this.prisma.connectorAccount.findUnique({
      where: { id: metadata.sourceAccountId },
    });
    if (!account) {
      throw new NotFoundException(
        `ConnectorAccount ${metadata.sourceAccountId} not found`,
      );
    }
    if (account.orgId !== metadata.orgId) {
      throw new ForbiddenException('ConnectorAccount belongs to another org');
    }
    if (account.kind !== 'csv') {
      throw new BadRequestException(
        `ConnectorAccount kind is ${account.kind}, not csv`,
      );
    }

    // Producer side: create the SyncRun synchronously so we can return its
    // id, then hand the file off to the worker queue.
    const syncRun = await this.prisma.syncRun.create({
      data: {
        orgId: metadata.orgId,
        connectorAccountId: metadata.sourceAccountId,
        direction: 'pull',
        status: 'running',
      },
    });

    await this.queue.send<CsvImportJobPayload>(CSV_IMPORT_QUEUE, {
      syncRunId: syncRun.id,
      orgId: metadata.orgId,
      sourceAccountId: metadata.sourceAccountId,
      csvBase64: fileBuffer.toString('base64'),
      columnMapping: metadata.columnMapping,
      triggeredBy: metadata.triggeredBy,
    });

    return { syncRunId: syncRun.id, status: 'running' };
  }

  /**
   * Poll SyncRun status. Returns 200 + the current state regardless of
   * whether the worker has finished (callers can poll until status ≠ 'running').
   *
   * Tenant guards: same as the upload endpoint — orgId is the load-bearing
   * isolation check until real auth lands. Pre-auth stub passes it via
   * `?orgId=` query param; real auth will pull it from OrgContext.
   */
  @Get('sync-runs/:id')
  async getSyncRun(
    @Param('id') id: string,
    @Query('orgId') orgId: string | undefined,
  ): Promise<CsvSyncRunStatusResponse> {
    if (!orgId) {
      throw new BadRequestException('orgId query parameter is required');
    }
    const syncRun = await this.prisma.syncRun.findUnique({ where: { id } });
    if (!syncRun) {
      throw new NotFoundException(`SyncRun ${id} not found`);
    }
    if (syncRun.orgId !== orgId) {
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
            'CSV file exceeds the 5 MB inline-base64 cap. ' +
              'Larger uploads route through object storage in a follow-up release.',
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
