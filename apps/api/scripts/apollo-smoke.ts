/**
 * Apollo Organization Search smoke test (real key, no DB).
 *
 * Verifies our ApolloSourceAdapter.searchOrganizations against the LIVE Apollo
 * API so we can confirm the response field mappings (primary_domain,
 * estimated_num_employees, latest_funding_stage, `organizations` vs `accounts`)
 * match reality. Prints the normalized companies plus the RAW first record so
 * you can eyeball any field drift.
 *
 *   APOLLO_API_KEY=… pnpm --filter @getbeyond/api apollo:smoke
 *
 * Optional env overrides:
 *   SMOKE_KEYWORDS="devtools,observability"  SMOKE_LOCATIONS="United States"
 *   SMOKE_EMP_MIN=1  SMOKE_EMP_MAX=50  SMOKE_LIMIT=5
 *
 * This calls a paid vendor API — it makes 1 search request. Not part of CI.
 */

import { apolloSourceAdapter } from '../src/modules/connectors/adapters/apollo/apollo.source';

function list(name: string): string[] | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function int(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) ? n : undefined;
}

async function main(): Promise<void> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error(
      'APOLLO_API_KEY is not set. Pass your Apollo BYO key inline before running.',
    );
  }

  const limit = int('SMOKE_LIMIT') ?? 5;
  const search = {
    keywords: list('SMOKE_KEYWORDS') ?? ['devtools'],
    industries: list('SMOKE_INDUSTRIES'),
    locations: list('SMOKE_LOCATIONS') ?? ['United States'],
    companyHeadcount: { min: int('SMOKE_EMP_MIN') ?? 1, max: int('SMOKE_EMP_MAX') ?? 50 },
  };

  // eslint-disable-next-line no-console
  console.log('Apollo Organization Search — criteria:', JSON.stringify(search, null, 2));

  const companies = [];
  for await (const company of apolloSourceAdapter.searchOrganizations({
    creds: { apiKey },
    config: { search, maxOrgs: limit },
    onVendorFailure: async (kind) => {
      // eslint-disable-next-line no-console
      console.error(`vendor failure: ${kind}`);
    },
  })) {
    companies.push(company);
  }

  // eslint-disable-next-line no-console
  console.log(`\nNormalized ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}:`);
  for (const c of companies) {
    // eslint-disable-next-line no-console
    console.log(
      `  • ${c.name} | domain=${c.domain ?? '—'} | employees=${c.employeeCount ?? '—'} | funding=${c.fundingStage ?? '—'} | li=${c.linkedinUrl ?? '—'}`,
    );
  }

  if (companies[0]) {
    // eslint-disable-next-line no-console
    console.log('\nRAW first record (verify field names map correctly):');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(companies[0].raw, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('apollo smoke failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
