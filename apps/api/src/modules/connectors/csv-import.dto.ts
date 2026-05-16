import { z } from 'zod';

/**
 * Zod schema for the multipart `metadata` field on POST /connectors/csv/import.
 *
 * The metadata field is JSON-encoded because multipart doesn't natively
 * carry structured objects — every non-file part is a string. Zod gives us
 * a typed parse + clear error messages without per-field decorator wiring.
 *
 * Pre-auth stub: `orgId` + `triggeredBy` live in the body. When the real
 * auth middleware lands, both come from OrgContext instead and this DTO
 * shrinks to `{ sourceAccountId, columnMapping }`.
 */
export const CsvImportMetadataSchema = z.object({
  orgId: z.string().min(1, 'orgId is required'),
  sourceAccountId: z.string().min(1, 'sourceAccountId is required'),
  triggeredBy: z.string().min(1, 'triggeredBy is required'),
  columnMapping: z.object({
    email: z.string().min(1, 'columnMapping.email is required'),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    company: z.string().min(1).optional(),
    linkedinUrl: z.string().min(1).optional(),
  }),
});

export type CsvImportMetadata = z.infer<typeof CsvImportMetadataSchema>;

/**
 * Response returned immediately after a successful enqueue. 202 Accepted.
 * Caller polls GET /connectors/csv/sync-runs/:id for terminal status.
 */
export interface CsvImportEnqueueResponse {
  syncRunId: string;
  /** Always 'running' at this point — the worker will drive it terminal. */
  status: 'running';
}

/**
 * Response from GET /connectors/csv/sync-runs/:id.
 * Errors array is capped at CSV_IMPORT_ERROR_RESPONSE_CAP entries.
 */
export interface CsvSyncRunStatusResponse {
  syncRunId: string;
  status: 'running' | 'completed' | 'failed';
  recordsIn: number;
  recordsOut: number;
  errorCount: number;
  errors: Array<{
    row: number;
    reason: string;
    message: string;
  }>;
}

/** Cap on errors[] length in poll responses. */
export const CSV_IMPORT_ERROR_RESPONSE_CAP = 100;
