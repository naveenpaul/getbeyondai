/**
 * ZoomInfo contact-sourcing PROBE (real credentials, no DB, throwaway).
 *
 * Validates the LIVE two-step flow the ZoomInfoSourceAdapter relies on, since
 * its response mapping was built against synthetic fixtures (not a live call):
 *   1. Contact Search by company name → people + personIds (no email).
 *   2. Contact Enrich (personIds, reveal email) → email + meta.matchStatus.
 * Prints the RAW first search row + first enrich match so we can confirm the
 * field paths (attributes.email, meta.matchStatus, id) the adapter assumes.
 *
 *   ZOOMINFO_CLIENT_ID=… ZOOMINFO_CLIENT_SECRET=… \
 *     pnpm --filter @getbeyond/api zoominfo:probe
 *
 * Optional env: ZI_COMPANY="Stripe"  ZI_TITLE="VP Sales"  ZI_LIMIT=3
 *
 * Cost: 1 search (free) + 1 enrich of up to ZI_LIMIT people (CONSUMES CREDITS).
 * Not part of CI.
 */

import { ZoomInfoClient } from '../src/modules/connectors/adapters/zoominfo/zoominfo.source';

/* eslint-disable no-console */
async function main(): Promise<void> {
  const clientId = process.env.ZOOMINFO_CLIENT_ID;
  const clientSecret = process.env.ZOOMINFO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Set ZOOMINFO_CLIENT_ID and ZOOMINFO_CLIENT_SECRET.');
  }
  const company = process.env.ZI_COMPANY ?? 'Stripe';
  const title = process.env.ZI_TITLE;
  const limit = Number.parseInt(process.env.ZI_LIMIT ?? '3', 10) || 3;

  const client = new ZoomInfoClient({ clientId, clientSecret });

  console.log(`\n=== STEP 1: contact search — company="${company}"${title ? ` title="${title}"` : ''} ===`);
  const search = await client.searchContacts(
    { companyName: company, ...(title ? { jobTitle: title } : {}) },
    { page: 1, pageSize: limit },
  );
  const rows = Array.isArray(search.data) ? (search.data as Record<string, unknown>[]) : [];
  console.log(`rows: ${rows.length}`);
  if (rows[0]) {
    console.log('first row KEYS:', Object.keys(rows[0]).join(', '));
    console.log('first row id:', rows[0]['id']);
    console.log('RAW first row:', JSON.stringify(rows[0], null, 2).slice(0, 800));
  }
  const ids = rows
    .map((r) => Number.parseInt(String(r['id'] ?? ''), 10))
    .filter((n) => Number.isInteger(n));
  if (ids.length === 0) {
    console.log('No personIds to enrich — stopping.');
    return;
  }

  console.log(`\n=== STEP 2: enrich ${ids.length} personIds (burns credits) ===`);
  const enriched = await client.enrichContacts(
    ids.map((personId) => ({ personId })),
    // linkedInUrl is not allowed on the GTM plan (verified live); company is nested.
    ['firstName', 'lastName', 'jobTitle', 'email', 'companyName'],
  );
  const matches = Array.isArray(enriched.data)
    ? (enriched.data as Record<string, unknown>[])
    : [];
  console.log(`matches: ${matches.length}`);
  matches.forEach((m, i) => {
    const attrs = (m['attributes'] as Record<string, unknown>) ?? {};
    const meta = (m['meta'] as Record<string, unknown>) ?? {};
    console.log(`  [${i}] email=${attrs['email']} matchStatus=${meta['matchStatus']} title=${attrs['jobTitle']}`);
  });
  if (matches[0]) {
    console.log('\nRAW first match (verify attributes.email + meta.matchStatus):');
    console.log(JSON.stringify(matches[0], null, 2).slice(0, 800));
  }

  console.log(
    '\n=== VERDICT ===\n' +
      'Confirm: search rows carry `id` (personId), and enrich matches carry ' +
      '`attributes.email` + `meta.matchStatus`. If the paths differ, adjust ' +
      'zoominfo.adapter.ts toNormalizedContact/personIdOf accordingly.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('zoominfo probe failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
