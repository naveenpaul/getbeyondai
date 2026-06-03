import { z } from 'zod';

/**
 * Zod schema for the multipart `metadata` field on POST /connectors/csv/import.
 *
 * The metadata field is JSON-encoded because multipart doesn't natively
 * carry structured objects — every non-file part is a string. Zod gives us
 * a typed parse + clear error messages without per-field decorator wiring.
 *
 * Identity (orgId, triggeredBy) is derived from the session by AuthGuard.
 * The metadata only carries the work-defining fields.
 */
export const CsvImportMetadataSchema = z.object({
  sourceAccountId: z.string().min(1, 'sourceAccountId is required'),
  /**
   * Display name for the ContactList this import creates. When omitted the
   * controller falls back to the uploaded filename, then to a generic default.
   */
  listName: z.string().min(1).max(200).optional(),
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
