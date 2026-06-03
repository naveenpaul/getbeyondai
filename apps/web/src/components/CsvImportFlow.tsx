'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FileUp, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  ApiError,
  ensureCsvAccount,
  getCsvSyncRun,
  submitCsvImport,
  type CsvColumnMapping,
  type CsvSyncRunStatusResponse,
} from '@/lib/api-client';
import {
  parseCsvPreview,
  type ContactField,
  type CsvPreview,
} from '@/lib/csv-preview';

/**
 * Reusable CSV import flow: pick → preview + map → submit → poll → result.
 *
 * Extracted from the standalone /contacts/import page so it can also run
 * in-context (e.g. inside a modal launched from the campaign composer's
 * SourcePicker) without navigating away and losing the in-progress campaign.
 *
 * The component owns the whole state machine but renders NO page chrome — the
 * caller supplies the surrounding Card / modal. On reaching a terminal state it
 * fires `onComplete` with the SyncRun id + status so the caller can react (e.g.
 * select the freshly-created ContactList).
 */

const FIELD_LABELS: Record<ContactField, string> = {
  email: 'Email',
  firstName: 'First name',
  lastName: 'Last name',
  title: 'Title',
  company: 'Company',
  linkedinUrl: 'LinkedIn URL',
};

const REQUIRED_FIELDS: ContactField[] = ['email'];

type Phase =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'preview'; preview: CsvPreview }
  | { kind: 'submitting' }
  | { kind: 'polling'; syncRunId: string; status: CsvSyncRunStatusResponse }
  | { kind: 'done'; syncRunId: string; status: CsvSyncRunStatusResponse }
  | { kind: 'error'; message: string };

const POLL_INTERVAL_MS = 1500;

export interface CsvImportResultInfo {
  syncRunId: string;
  status: CsvSyncRunStatusResponse;
}

interface CsvImportFlowProps {
  /**
   * Fired once when the import reaches a terminal state (completed or failed).
   * Inspect `status.status` to distinguish. Used to select the new list, etc.
   */
  onComplete?: (result: CsvImportResultInfo) => void;
  /** Primary CTA on the success panel (e.g. "View contacts" / "Done"). */
  primaryAction?: { label: string; onClick: () => void };
  /** Show the "Import another" reset button on the result panel. */
  allowImportAnother?: boolean;
}

export function CsvImportFlow({
  onComplete,
  primaryAction,
  allowImportAnother = true,
}: CsvImportFlowProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<Record<ContactField, string | null>>({
    email: null,
    firstName: null,
    lastName: null,
    title: null,
    company: null,
    linkedinUrl: null,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onPickFile = useCallback(async (next: File | null): Promise<void> => {
    if (!next) return;
    setFile(next);
    setPhase({ kind: 'reading' });
    try {
      const text = await next.text();
      const preview = parseCsvPreview(text);
      if (preview.headers.length === 0) {
        setPhase({
          kind: 'error',
          message: 'Could not read any headers from this file.',
        });
        return;
      }
      setMapping(preview.inferredMapping);
      setPhase({ kind: 'preview', preview });
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to read file.',
      });
    }
  }, []);

  async function onSubmit(): Promise<void> {
    if (!file || phase.kind !== 'preview') return;
    if (!mapping.email) {
      setPhase({
        kind: 'error',
        message: 'Pick which CSV column holds the email address.',
      });
      return;
    }

    setPhase({ kind: 'submitting' });
    try {
      const { id: sourceAccountId } = await ensureCsvAccount();
      const columnMapping = trimMapping(mapping);
      const { syncRunId } = await submitCsvImport({
        file,
        sourceAccountId,
        columnMapping,
      });
      // Initial poll to seed state.
      const initial = await getCsvSyncRun(syncRunId);
      setPhase({ kind: 'polling', syncRunId, status: initial });
    } catch (err) {
      setPhase({ kind: 'error', message: formatError(err) });
    }
  }

  useEffect(() => {
    if (phase.kind !== 'polling') return;
    if (phase.status.status !== 'running') {
      setPhase({
        kind: 'done',
        syncRunId: phase.syncRunId,
        status: phase.status,
      });
      onComplete?.({ syncRunId: phase.syncRunId, status: phase.status });
      return;
    }
    const t = setTimeout(async () => {
      try {
        const next = await getCsvSyncRun(phase.syncRunId);
        setPhase({ kind: 'polling', syncRunId: phase.syncRunId, status: next });
      } catch (err) {
        setPhase({ kind: 'error', message: formatError(err) });
      }
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(t);
    // onComplete is intentionally excluded — it must fire exactly once at the
    // running→done transition, not on every identity change of the callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function reset(): void {
    setFile(null);
    setMapping({
      email: null,
      firstName: null,
      lastName: null,
      title: null,
      company: null,
      linkedinUrl: null,
    });
    setPhase({ kind: 'idle' });
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div className="space-y-6">
      <FilePicker
        file={file}
        onPick={onPickFile}
        disabled={
          phase.kind === 'submitting' ||
          phase.kind === 'polling' ||
          phase.kind === 'reading'
        }
        inputRef={fileInputRef}
      />

      {phase.kind === 'error' ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>{phase.message}</div>
        </div>
      ) : null}

      {phase.kind === 'reading' ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : null}

      {phase.kind === 'preview' ? (
        <>
          <Separator />
          <PreviewTable preview={phase.preview} />
          <Separator />
          <MappingEditor
            headers={phase.preview.headers}
            mapping={mapping}
            onChange={setMapping}
          />
          <div className="flex items-center justify-between">
            <Button type="button" variant="ghost" onClick={reset}>
              Start over
            </Button>
            <Button type="button" onClick={onSubmit} disabled={!mapping.email}>
              <Upload className="h-4 w-4" />
              Import {phase.preview.totalRows} rows
            </Button>
          </div>
        </>
      ) : null}

      {phase.kind === 'submitting' ? (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Uploading and enqueueing…
        </div>
      ) : null}

      {phase.kind === 'polling' || phase.kind === 'done' ? (
        <ResultPanel
          status={phase.status}
          onAnother={reset}
          primaryAction={primaryAction}
          allowImportAnother={allowImportAnother}
        />
      ) : null}
    </div>
  );
}

function FilePicker({
  file,
  onPick,
  disabled,
  inputRef,
}: {
  file: File | null;
  onPick: (file: File | null) => void | Promise<void>;
  disabled: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  return (
    <label
      htmlFor="csv-file"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) void onPick(f);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-8 text-sm transition-colors ${
        dragging
          ? 'border-foreground/60 bg-muted/40'
          : 'border-border hover:border-foreground/40'
      } ${disabled ? 'pointer-events-none opacity-60' : ''}`}
    >
      <FileUp className="h-6 w-6 text-muted-foreground" />
      <div className="font-medium">
        {file ? file.name : 'Drop CSV here, or click to pick a file'}
      </div>
      {file ? (
        <div className="text-xs text-muted-foreground">
          {formatBytes(file.size)}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          Header row required. Up to 50 MB.
        </div>
      )}
      <input
        id="csv-file"
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
        disabled={disabled}
      />
    </label>
  );
}

function PreviewTable({ preview }: { preview: CsvPreview }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase text-muted-foreground">
        Sample ({preview.sampleRows.length} of {preview.totalRows} rows)
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b text-left">
            <tr>
              {preview.headers.map((h, i) => (
                <th key={i} className="py-1.5 pr-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {preview.sampleRows.map((row, ri) => (
              <tr key={ri}>
                {preview.headers.map((_h, ci) => (
                  <td key={ci} className="max-w-[12rem] truncate py-1.5 pr-3">
                    {row[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MappingEditor({
  headers,
  mapping,
  onChange,
}: {
  headers: string[];
  mapping: Record<ContactField, string | null>;
  onChange: (next: Record<ContactField, string | null>) => void;
}): React.JSX.Element {
  function setField(field: ContactField, value: string): void {
    onChange({ ...mapping, [field]: value === '' ? null : value });
  }
  return (
    <div className="space-y-3">
      <div className="text-xs uppercase text-muted-foreground">
        Map CSV columns → contact fields
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(Object.keys(FIELD_LABELS) as ContactField[]).map((field) => (
          <div key={field} className="space-y-1">
            <label className="text-xs font-medium">
              {FIELD_LABELS[field]}
              {REQUIRED_FIELDS.includes(field) ? (
                <span className="text-destructive"> *</span>
              ) : null}
            </label>
            <select
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              value={mapping[field] ?? ''}
              onChange={(e) => setField(field, e.target.value)}
            >
              <option value="">
                {REQUIRED_FIELDS.includes(field) ? '— pick a column —' : '(skip)'}
              </option>
              {headers.map((h, i) => (
                <option key={i} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultPanel({
  status,
  onAnother,
  primaryAction,
  allowImportAnother,
}: {
  status: CsvSyncRunStatusResponse;
  onAnother: () => void;
  primaryAction?: { label: string; onClick: () => void };
  allowImportAnother: boolean;
}): React.JSX.Element {
  if (status.status === 'running') {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Importing… {status.recordsOut} of {status.recordsIn} rows so far.
      </div>
    );
  }
  if (status.status === 'failed') {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>Import failed.</div>
        </div>
        {status.errors.length > 0 ? <ErrorList errors={status.errors} /> : null}
        <Button type="button" variant="secondary" onClick={onAnother}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-emerald-300/40 bg-emerald-100/40 p-3 text-sm text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-200">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          Imported {status.recordsOut} of {status.recordsIn} rows.
          {status.errorCount > 0 ? (
            <span className="ml-1 text-emerald-800/80 dark:text-emerald-200/80">
              {status.errorCount} skipped.
            </span>
          ) : null}
        </div>
      </div>
      {status.errors.length > 0 ? <ErrorList errors={status.errors} /> : null}
      <div className="flex items-center justify-end gap-2">
        {allowImportAnother ? (
          <Button type="button" variant="ghost" onClick={onAnother}>
            Import another
          </Button>
        ) : null}
        {primaryAction ? (
          <Button type="button" onClick={primaryAction.onClick}>
            {primaryAction.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ErrorList({
  errors,
}: {
  errors: CsvSyncRunStatusResponse['errors'];
}): React.JSX.Element {
  return (
    <details className="rounded-md border border-border/60 p-3 text-xs">
      <summary className="cursor-pointer font-medium">
        {errors.length} row {errors.length === 1 ? 'error' : 'errors'}
      </summary>
      <ul className="mt-2 space-y-1">
        {errors.slice(0, 20).map((e, i) => (
          <li key={i} className="font-mono">
            Row {e.row}: {e.reason} — {e.message}
          </li>
        ))}
        {errors.length > 20 ? (
          <li className="italic text-muted-foreground">
            …{errors.length - 20} more.
          </li>
        ) : null}
      </ul>
    </details>
  );
}

function trimMapping(m: Record<ContactField, string | null>): CsvColumnMapping {
  const out: CsvColumnMapping = { email: m.email ?? '' };
  if (m.firstName) out.firstName = m.firstName;
  if (m.lastName) out.lastName = m.lastName;
  if (m.title) out.title = m.title;
  if (m.company) out.company = m.company;
  if (m.linkedinUrl) out.linkedinUrl = m.linkedinUrl;
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.status} — ${err.body.slice(0, 200)}`;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
