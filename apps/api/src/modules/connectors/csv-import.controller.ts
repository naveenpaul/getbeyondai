import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Inject,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../../common/prisma/prisma.service';
import { runCsvImport } from './csv-import.service';
import {
  CsvImportMetadataSchema,
  type CsvImportMetadata,
  type CsvImportResponse,
  CSV_IMPORT_ERROR_RESPONSE_CAP,
} from './csv-import.dto';

interface ParsedMultipart {
  fileBuffer: Buffer;
  metadata: CsvImportMetadata;
}

@Controller('connectors/csv')
export class CsvImportController {
  private readonly prisma: PrismaService;

  // Explicit @Inject + manual assignment instead of parameter-property syntax.
  // vitest uses esbuild which does NOT emit `design:paramtypes` decorator
  // metadata (only tsc with `emitDecoratorMetadata: true` does). NestJS DI
  // relies on that metadata to resolve constructor-injected services from
  // the parameter type. Without it, `private readonly prisma: PrismaService`
  // injects `undefined` in the test run. The explicit @Inject(PrismaService)
  // makes the dependency resolvable in both tsc-built and esbuild-transformed
  // execution paths.
  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  @Post('import')
  async import(@Req() req: FastifyRequest): Promise<CsvImportResponse> {
    const { fileBuffer, metadata } = await parseMultipart(req);

    // Validate the ConnectorAccount exists, is owned by the claimed org,
    // and is the right kind. The orgId-mismatch case is the load-bearing
    // tenant-isolation check until real auth replaces the body-based orgId.
    const account = await this.prisma.connectorAccount.findUnique({
      where: { id: metadata.sourceAccountId },
    });
    if (!account) {
      throw new NotFoundException(
        `ConnectorAccount ${metadata.sourceAccountId} not found`,
      );
    }
    if (account.orgId !== metadata.orgId) {
      // 403 not 404 — telling the caller "wrong org" leaks ConnectorAccount
      // existence across tenants. 403 still distinguishes from 404, but the
      // upstream observation is "you don't own this resource".
      throw new ForbiddenException('ConnectorAccount belongs to another org');
    }
    if (account.kind !== 'csv') {
      throw new BadRequestException(
        `ConnectorAccount kind is ${account.kind}, not csv`,
      );
    }

    const result = await runCsvImport(this.prisma, {
      orgId: metadata.orgId,
      sourceAccountId: metadata.sourceAccountId,
      csv: { kind: 'buffer', content: fileBuffer },
      columnMapping: metadata.columnMapping,
      triggeredBy: metadata.triggeredBy,
    });

    return {
      syncRunId: result.syncRun.id,
      status: result.syncRun.status as 'completed' | 'failed',
      recordsIn: result.recordsIn,
      recordsOut: result.recordsOut,
      errorCount: result.errorCount,
      errors: result.errors
        .slice(0, CSV_IMPORT_ERROR_RESPONSE_CAP)
        .map((e) => ({ row: e.row, reason: e.reason, message: e.message })),
    };
  }
}

/**
 * Pull the file + metadata fields out of a multipart request.
 *
 * Exported via `parseMultipart` (named export below) so the parsing logic
 * is testable without a live Fastify app.
 */
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
          throw new BadRequestException(
            'CSV file exceeds the configured upload size limit',
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
    throw new BadRequestException('multipart field "metadata" must be valid JSON');
  }

  const result = CsvImportMetadataSchema.safeParse(metadataParsed);
  if (!result.success) {
    throw new BadRequestException(
      `metadata validation failed: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  return { fileBuffer, metadata: result.data };
}
