/**
 * ZoomInfo COMPANY-DISCOVERY probe (real credentials, no DB, throwaway).
 *
 * Validates the LIVE company-search path the ZoomInfoSourcingProvider relies on.
 * The provider's ICP→attributes mapper (`icpToZoomInfoCompanyCriteria`) and its
 * result parser (`toCandidate`) were built against ZoomInfo's documented shape,
 * NOT a verified live call — this probe closes that gap:
 *   1. Build a sample ICP from env, map it to CompanySearch attributes, PRINT them.
 *   2. Run the live CompanySearch (free — no contact-credit burn).
 *   3. PRINT the raw first result row + what `toCandidate` extracts from it.
 * Use the output to confirm/fix the best-effort attribute names in
 * `icpToZoomInfoCompanyCriteria` and the field paths in `toCandidate`.
 *
 *   ZOOMINFO_CLIENT_ID=… ZOOMINFO_CLIENT_SECRET=… \
 *     pnpm --filter @getbeyond/api zoominfo:company-probe
 *
 * Optional env (the sample ICP): ZI_INDUSTRY="Software"  ZI_LOCATION="United Kingdom"
 *   ZI_KEYWORDS="payments,fintech"  ZI_EMP_MIN=10  ZI_EMP_MAX=200  ZI_LIMIT=5
 *
 * Cost: 1 company search (free per ZoomInfo's GTM plan). Not part of CI.
 */

import { ZoomInfoClient } from '../src/modules/connectors/adapters/zoominfo/zoominfo.source';
import {
  icpToZoomInfoCompanyCriteria,
  toCandidate,
} from '../src/modules/connectors/sourcing/zoominfo-sourcing.provider';
import type { IcpCriteria } from '../src/modules/connectors/sourcing/sourcing-provider';

/* eslint-disable no-console */
function envList(name: string): string[] {
  const raw = process.env[name];
  return raw
    ? raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
}
function envInt(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) ? n : null;
}

async function main(): Promise<void> {
  const clientId = process.env.ZOOMINFO_CLIENT_ID;
  const clientSecret = process.env.ZOOMINFO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Set ZOOMINFO_CLIENT_ID and ZOOMINFO_CLIENT_SECRET.');
  }
  const limit = envInt('ZI_LIMIT') ?? 5;

  // A sample ICP — the same shape the orchestrator's deriveIcp produces.
  const icp: IcpCriteria = {
    keywords: envList('ZI_KEYWORDS'),
    employeeCountMin: envInt('ZI_EMP_MIN'),
    employeeCountMax: envInt('ZI_EMP_MAX'),
    fundingStages: [],
    industries: envList('ZI_INDUSTRY'),
    locations: envList('ZI_LOCATION'),
  };

  const attributes = icpToZoomInfoCompanyCriteria(icp);
  console.log('\n=== ICP → ZoomInfo CompanySearch attributes (verify these names) ===');
  console.log(JSON.stringify({ icp, attributes }, null, 2));

  const client = new ZoomInfoClient({ clientId, clientSecret });

  console.log(`\n=== Live CompanySearch (pageSize=${limit}) ===`);
  const doc = await client.searchCompanies(attributes, { page: 1, pageSize: limit });
  const rows = Array.isArray(doc.data) ? (doc.data as Record<string, unknown>[]) : [];
  console.log(`rows: ${rows.length}`);

  if (rows[0]) {
    console.log('\nfirst row KEYS:', Object.keys(rows[0]).join(', '));
    const attrs = rows[0]['attributes'];
    if (attrs && typeof attrs === 'object') {
      console.log('first row attribute KEYS:', Object.keys(attrs).join(', '));
    }
    console.log('RAW first row:', JSON.stringify(rows[0], null, 2).slice(0, 1200));
    console.log('\ntoCandidate(first row) →', JSON.stringify(toCandidate(rows[0]), null, 2));
  }

  console.log(
    '\n=== VERDICT ===\n' +
      '1. If the search 400s or returns 0 rows, the ATTRIBUTE NAMES above are\n' +
      '   wrong for your plan — fix icpToZoomInfoCompanyCriteria.\n' +
      '2. If toCandidate(...) shows null name/domain/employeeCount but the RAW\n' +
      '   row clearly has them, the FIELD PATHS are wrong — fix toCandidate.\n' +
      'Both live in zoominfo-sourcing.provider.ts.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(
      'zoominfo company probe failed:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
