/**
 * PDL search-SHAPE probe (throwaway) — learn the industry/size query shape.
 *
 * Geo is proven (pdl-location-probe). This locks HOW to express "IT" + "small
 * headcount" in a PDL Company Search query, so the ICP→query mapper is built
 * against what actually returns results. size:1 each → ~7 credits.
 *
 *   node --env-file=.env -r ts-node/register/transpile-only \
 *     scripts/pdl-search-shape-probe.ts
 */

import { PrismaClient } from '@prisma/client';
import {
  decryptCredentials,
  loadMasterKey,
} from '../src/modules/connectors/credential-encryption';

/* eslint-disable no-console */

const PDL_SEARCH_URL = 'https://api.peopledatalabs.com/v5/company/search';
const BLR = { term: { 'location.locality': 'bangalore' } };

const PROBES: Array<{ label: string; query: Record<string, unknown> }> = [
  { label: 'BLR only (baseline)', query: BLR },
  {
    label: 'BLR + industry term "information technology and services"',
    query: { bool: { must: [BLR, { term: { industry: 'information technology and services' } }] } },
  },
  {
    label: 'BLR + industry term "computer software"',
    query: { bool: { must: [BLR, { term: { industry: 'computer software' } }] } },
  },
  {
    label: 'BLR + tags match "information technology"',
    query: { bool: { must: [BLR, { match: { tags: 'information technology' } }] } },
  },
  {
    label: 'BLR + size terms [1-10, 11-50]',
    query: { bool: { must: [BLR, { terms: { size: ['1-10', '11-50'] } }] } },
  },
  {
    label: 'BLR + employee_count <= 50',
    query: { bool: { must: [BLR, { range: { employee_count: { lte: 50 } } }] } },
  },
  {
    label: 'BLR + (software OR internet OR IT services) + size small  [full combo]',
    query: {
      bool: {
        must: [
          BLR,
          {
            bool: {
              should: [
                { term: { industry: 'computer software' } },
                { term: { industry: 'internet' } },
                { term: { industry: 'information technology and services' } },
              ],
            },
          },
          { terms: { size: ['1-10', '11-50'] } },
        ],
      },
    },
  },
];

async function loadPdlKey(prisma: PrismaClient): Promise<string> {
  const masterKey = loadMasterKey(process.env.CREDENTIAL_MASTER_KEY ?? '');
  const account = await prisma.connectorAccount.findFirst({
    where: { kind: 'pdl' },
    select: { credentials: true },
  });
  if (!account) throw new Error('No PDL ConnectorAccount found');
  const { apiKey } = decryptCredentials<{ apiKey: string }>(
    account.credentials as Buffer,
    masterKey,
  );
  return apiKey;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const apiKey = await loadPdlKey(prisma);
    console.log(`PDL key ****${apiKey.slice(-4)}\n`);
    for (const p of PROBES) {
      const res = await fetch(PDL_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({ query: p.query, size: 1 }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        total?: number;
        data?: Array<Record<string, unknown>>;
        error?: unknown;
      };
      if (res.status >= 400) {
        console.log(`• ${p.label}: HTTP ${res.status} — ${JSON.stringify(body.error ?? body).slice(0, 160)}`);
        continue;
      }
      const first = body.data?.[0];
      console.log(
        `• ${p.label}: total=${body.total ?? '?'}  e.g. "${(first?.['name'] as string) ?? '—'}"` +
          `  size=${(first?.['size'] as string) ?? '?'}  industry=${(first?.['industry'] as string) ?? '?'}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('shape probe failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
