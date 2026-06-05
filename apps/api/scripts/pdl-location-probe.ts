/**
 * PDL LOCATION probe (throwaway) — does PDL Company Search do global city geo?
 *
 * ZoomInfo's geo filters are US/Canada-only; this checks whether PDL's Company
 * Search supports city-level location for India + UK + Europe (the gap we need
 * to fill). Decrypts the org's stored PDL key (no secrets in argv) and fires a
 * few /v5/company/search variants, reading the match `total` for each.
 *
 * COST: PDL Company Search bills a credit PER RECORD returned — we use size:1,
 * so ~6 credits total. `total` reflects the full match count regardless of size.
 *
 *   node --env-file=.env -r ts-node/register/transpile-only \
 *     scripts/pdl-location-probe.ts
 */

import { PrismaClient } from '@prisma/client';
import {
  decryptCredentials,
  loadMasterKey,
} from '../src/modules/connectors/credential-encryption';

/* eslint-disable no-console */

const PDL_SEARCH_URL = 'https://api.peopledatalabs.com/v5/company/search';

async function loadPdlKey(prisma: PrismaClient): Promise<string> {
  const masterB64 = process.env.CREDENTIAL_MASTER_KEY;
  if (!masterB64) throw new Error('CREDENTIAL_MASTER_KEY not set (use --env-file=.env)');
  const masterKey = loadMasterKey(masterB64);
  const account = await prisma.connectorAccount.findFirst({
    where: { kind: 'pdl' },
    select: { credentials: true },
  });
  if (!account) throw new Error('No PDL ConnectorAccount found');
  const creds = decryptCredentials<{ apiKey: string }>(
    account.credentials as Buffer,
    masterKey,
  );
  if (!creds.apiKey) throw new Error('Decrypted PDL creds missing apiKey');
  return creds.apiKey;
}

interface Probe {
  label: string;
  query: Record<string, unknown>;
}

/** Each query is an Elasticsearch term filter on PDL's company location fields. */
const PROBES: Probe[] = [
  { label: 'India (country)', query: { term: { 'location.country': 'india' } } },
  { label: 'Bengaluru (locality="bangalore")', query: { term: { 'location.locality': 'bangalore' } } },
  { label: 'Bengaluru (locality="bengaluru")', query: { term: { 'location.locality': 'bengaluru' } } },
  { label: 'United Kingdom (country)', query: { term: { 'location.country': 'united kingdom' } } },
  { label: 'London (locality="london")', query: { term: { 'location.locality': 'london' } } },
  { label: 'Berlin, Germany (locality="berlin")', query: { term: { 'location.locality': 'berlin' } } },
];

interface PdlSearchResult {
  status?: number;
  total?: number;
  data?: Array<Record<string, unknown>>;
  error?: { message?: string } | string;
}

async function pdlSearch(
  apiKey: string,
  query: Record<string, unknown>,
): Promise<{ httpStatus: number; body: PdlSearchResult }> {
  const res = await fetch(PDL_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({ query, size: 1 }),
  });
  const body = (await res.json().catch(() => ({}))) as PdlSearchResult;
  return { httpStatus: res.status, body };
}

function describeLocation(record: Record<string, unknown> | undefined): string {
  const loc = (record?.['location'] as Record<string, unknown>) ?? {};
  const s = (k: string) => (typeof loc[k] === 'string' ? (loc[k] as string) : '');
  return [s('locality'), s('region'), s('country')].filter(Boolean).join(', ') || '(no location)';
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const apiKey = await loadPdlKey(prisma);
    console.log(`Loaded PDL key from DB (****${apiKey.slice(-4)})\n`);
    for (const p of PROBES) {
      try {
        const { httpStatus, body } = await pdlSearch(apiKey, p.query);
        if (httpStatus >= 400) {
          const err =
            typeof body.error === 'string'
              ? body.error
              : body.error?.message ?? JSON.stringify(body).slice(0, 200);
          console.log(`• ${p.label}: HTTP ${httpStatus} — ${err}`);
          continue;
        }
        const first = body.data?.[0];
        const name = (first?.['name'] as string) ?? '(no sample)';
        console.log(
          `• ${p.label}: total=${body.total ?? '?'}  e.g. "${name}" — ${describeLocation(first)}`,
        );
      } catch (err) {
        console.log(`• ${p.label}: request failed — ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('pdl probe failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
