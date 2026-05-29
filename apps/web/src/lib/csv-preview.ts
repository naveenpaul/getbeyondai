/**
 * Tiny RFC-4180-aware CSV reader for the import preview UI.
 *
 * We intentionally don't pull a runtime dep (PapaParse, csv-parse) just to
 * read the header row + 5 sample rows on the client. The reader handles:
 *   - Quoted fields (single column may contain commas)
 *   - Escaped quotes (`""` inside a quoted field → a single `"`)
 *   - CRLF or LF line endings
 *
 * It does NOT handle the long tail (BOM, non-standard escape rules,
 * embedded newlines inside quoted fields). The server-side parser is the
 * source of truth for the actual import; this is preview-only.
 */

const CONTACT_FIELDS = [
  'email',
  'firstName',
  'lastName',
  'title',
  'company',
  'linkedinUrl',
] as const;

export type ContactField = (typeof CONTACT_FIELDS)[number];

export interface CsvPreview {
  headers: string[];
  sampleRows: string[][];
  /** Inferred mapping: ContactField → CSV header name (or null if no guess). */
  inferredMapping: Record<ContactField, string | null>;
  /** Total rows in the file (excluding header). */
  totalRows: number;
}

/**
 * Parse the first N rows of a CSV string. Returns headers, the first
 * `sampleSize` data rows, and a guess at which CSV column maps to which
 * Contact field.
 */
export function parseCsvPreview(
  text: string,
  sampleSize: number = 5,
): CsvPreview {
  const allRows = parseCsv(text);
  if (allRows.length === 0) {
    return {
      headers: [],
      sampleRows: [],
      inferredMapping: emptyMapping(),
      totalRows: 0,
    };
  }
  const headers = allRows[0] ?? [];
  const data = allRows.slice(1).filter((row) => row.some((c) => c.length > 0));
  return {
    headers,
    sampleRows: data.slice(0, sampleSize),
    inferredMapping: inferMapping(headers),
    totalRows: data.length,
  };
}

/** Map ContactField → guess at matching CSV header, or null. */
export function inferMapping(
  headers: string[],
): Record<ContactField, string | null> {
  const out: Record<ContactField, string | null> = emptyMapping();
  const normalized = headers.map((h) => normalizeHeader(h));

  // Order matters: each match must be unique — once a CSV column is taken
  // for `firstName`, don't double-bind it to `lastName`.
  const taken = new Set<string>();
  for (const field of CONTACT_FIELDS) {
    const patterns = MATCH_PATTERNS[field];
    for (let i = 0; i < normalized.length; i += 1) {
      const h = normalized[i];
      if (!h || taken.has(h)) continue;
      if (patterns.some((p) => p(h))) {
        out[field] = headers[i] ?? null;
        if (out[field] !== null) taken.add(h);
        break;
      }
    }
  }
  return out;
}

function emptyMapping(): Record<ContactField, string | null> {
  return {
    email: null,
    firstName: null,
    lastName: null,
    title: null,
    company: null,
    linkedinUrl: null,
  };
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_-]+/g, '');
}

const MATCH_PATTERNS: Record<ContactField, Array<(h: string) => boolean>> = {
  email: [
    (h) => h === 'email' || h === 'emailaddress' || h === 'primaryemail',
    (h) => h.endsWith('email'),
  ],
  firstName: [
    (h) => h === 'firstname' || h === 'givenname' || h === 'first',
  ],
  lastName: [
    (h) => h === 'lastname' || h === 'surname' || h === 'familyname' || h === 'last',
  ],
  title: [
    (h) => h === 'title' || h === 'jobtitle' || h === 'role' || h === 'position',
  ],
  company: [
    (h) => h === 'company' || h === 'companyname' || h === 'employer' || h === 'organization' || h === 'org',
  ],
  linkedinUrl: [
    (h) => h === 'linkedin' || h === 'linkedinurl' || h === 'linkedinprofile',
  ],
};

/**
 * Bare-bones RFC-4180 reader: rows separated by CR/LF/CRLF, fields by ','.
 * Honors double-quoted fields with embedded commas and `""` for an
 * escaped quote.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      // Treat CRLF as one separator.
      if (ch === '\r' && text[i + 1] === '\n') i += 2;
      else i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Trailing field / row (no terminal newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
