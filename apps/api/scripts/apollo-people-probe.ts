/**
 * Apollo People + Enrichment PROBE (real key, no DB, throwaway diagnostic).
 *
 * Purpose: establish ground truth for the contacts-with-emails path before we
 * write the adapter enrichment step. The Apollo API changed so People Search no
 * longer returns emails — you must enrich (bulk_match, reveal_personal_emails)
 * to unlock them, which burns credits. The docs don't pin down (a) whether the
 * person `id` from search can be passed to bulk_match, or (b) the exact match
 * response shape. This probe answers both against the LIVE API.
 *
 *   APOLLO_API_KEY=… pnpm --filter @getbeyond/api apollo:people-probe
 *
 * Optional env overrides:
 *   PROBE_TITLES="VP of Sales,Head of Sales"   PROBE_LOCATIONS="United States"
 *   PROBE_SEARCH_LIMIT=5   PROBE_ENRICH_LIMIT=3
 *
 * Cost: 1 search call (free) + 1 bulk_match call enriching up to
 * PROBE_ENRICH_LIMIT people (DEFAULT 3 — burns ~3 email credits). Keep it small.
 * Not part of CI.
 */

const BASE_URL = 'https://api.apollo.io';

function list(name: string): string[] | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) ? n : fallback;
}

async function call(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave json null; text holds the raw body
  }
  return { status: res.status, json, text };
}

/* eslint-disable no-console */
async function main(): Promise<void> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error('APOLLO_API_KEY is not set. Pass your Apollo BYO key inline.');
  }

  const searchLimit = int('PROBE_SEARCH_LIMIT', 5);
  const enrichLimit = int('PROBE_ENRICH_LIMIT', 3);
  const titles = list('PROBE_TITLES') ?? ['VP of Sales', 'Head of Sales'];
  const locations = list('PROBE_LOCATIONS') ?? ['United States'];

  // ── Step 1: People Search (API-optimized endpoint, should NOT cost credits) ──
  const searchPath = '/api/v1/mixed_people/api_search';
  console.log(`\n=== STEP 1: POST ${searchPath} ===`);
  console.log('criteria:', JSON.stringify({ titles, locations, per_page: searchLimit }));
  const search = await call(apiKey, searchPath, {
    person_titles: titles,
    person_locations: locations,
    page: 1,
    per_page: searchLimit,
  });
  console.log(`HTTP ${search.status}`);
  if (search.status !== 200) {
    console.log('RAW BODY:', search.text.slice(0, 1000));
    throw new Error(`People search failed (HTTP ${search.status})`);
  }

  const people =
    ((search.json as { people?: unknown[] })?.people ?? []) as Array<
      Record<string, unknown>
    >;
  console.log(`people returned: ${people.length}`);
  if (people[0]) {
    console.log('first person KEYS:', Object.keys(people[0]).sort().join(', '));
    console.log('first person id:', people[0]['id']);
    console.log('first person email (expect masked/absent):', people[0]['email']);
    console.log('first person email_status:', people[0]['email_status']);
    console.log('RAW first person:', JSON.stringify(people[0], null, 2));
  }
  if (people.length === 0) {
    console.log('No people to enrich — stopping before bulk_match.');
    return;
  }

  // ── Step 2: Bulk enrichment — does passing `id` reveal an email? ──
  const sample = people.slice(0, enrichLimit);
  const details = sample.map((p) => ({
    // Pass BOTH the id and identity fields so we learn which Apollo honours.
    id: p['id'],
    first_name: p['first_name'],
    last_name: p['last_name'],
    name: p['name'],
    organization_name:
      (p['organization'] as { name?: unknown } | undefined)?.name ?? undefined,
    domain:
      (p['organization'] as { primary_domain?: unknown } | undefined)
        ?.primary_domain ?? undefined,
    linkedin_url: p['linkedin_url'],
  }));

  const matchPath = '/api/v1/people/bulk_match';
  console.log(`\n=== STEP 2: POST ${matchPath} (reveal_personal_emails=true) ===`);
  console.log(`enriching ${details.length} people (burns credits)…`);
  const match = await call(apiKey, matchPath, {
    reveal_personal_emails: true,
    reveal_phone_number: false,
    details,
  });
  console.log(`HTTP ${match.status}`);
  if (match.status !== 200) {
    console.log('RAW BODY:', match.text.slice(0, 1000));
    throw new Error(`Bulk match failed (HTTP ${match.status})`);
  }

  const matches =
    ((match.json as { matches?: unknown[] })?.matches ?? []) as Array<
      Record<string, unknown> | null
    >;
  console.log(`matches returned: ${matches.length}`);
  console.log('\nRevealed emails:');
  matches.forEach((m, i) => {
    if (!m) {
      console.log(`  [${i}] (no match)`);
      return;
    }
    console.log(
      `  [${i}] id=${m['id']} email=${m['email']} status=${m['email_status']}`,
    );
  });
  if (matches[0]) {
    console.log('\nRAW first match (verify field names):');
    console.log(JSON.stringify(matches[0], null, 2));
  }

  console.log(
    '\n=== VERDICT ===\n' +
      'If revealed emails above are real addresses (not email_not_unlocked), ' +
      'the two-step search→bulk_match(id) flow works and we implement it.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('apollo people probe failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
