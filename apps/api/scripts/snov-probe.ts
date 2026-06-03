/**
 * Snov.io Domain Search PROBE (real credentials, no DB, throwaway diagnostic).
 *
 * Purpose: head-to-head with the Apollo probe. Snov is DOMAIN-driven (no
 * ICP-wide people discovery): you give a company domain (+ optional job titles)
 * and Snov returns prospects, then a per-prospect email search returns a
 * VERIFIED email. This probe runs that full async flow against the LIVE API and
 * dumps RAW responses so we can confirm the exact v2 envelope.
 *
 *   SNOV_CLIENT_ID=… SNOV_CLIENT_SECRET=… pnpm --filter @getbeyond/api snov:probe
 *
 * Optional env overrides:
 *   SNOV_DOMAIN=stripe.com   SNOV_POSITIONS="VP of Sales,Head of Sales"
 *   SNOV_ENRICH_LIMIT=3      (how many prospects to resolve emails for)
 *
 * Snov v2 quirks this probe encodes:
 *   - `start` endpoints take params in the QUERY STRING, not the JSON body.
 *   - responses are JSON:API-ish: { data, meta, links }. The poll URL lives in
 *     `links` (a key containing "/result"); `meta.status` signals completion.
 *
 * Cost: prospect search ~1 credit; each email resolution 1 credit ONLY if a
 * verified email is found. SNOV_ENRICH_LIMIT caps email lookups. Not in CI.
 */

const BASE_URL = 'https://api.snov.io';
const OAUTH_PATH = '/v1/oauth/access_token';
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_TRIES = 25;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a query string, expanding string[] values to repeated `key[]=` params. */
function qs(params: Record<string, string | number | string[] | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((item) => sp.append(`${k}[]`, item));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`${BASE_URL}${OAUTH_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  const token = (JSON.parse(text) as { access_token?: string }).access_token;
  if (!token) throw new Error(`OAuth response had no access_token: ${text.slice(0, 200)}`);
  return token;
}

type Json = Record<string, unknown>;

async function req(
  token: string,
  method: 'GET' | 'POST',
  url: string,
): Promise<{ status: number; json: Json; text: string }> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {
    /* non-JSON; text holds the body */
  }
  return { status: res.status, json, text };
}

/** Find the poll URL inside a JSON:API `links` object (any value containing /result). */
function resultLink(resp: Json): string | null {
  const links = resp['links'];
  if (links && typeof links === 'object') {
    for (const v of Object.values(links as Record<string, unknown>)) {
      if (typeof v === 'string' && v.includes('/result')) {
        return v.startsWith('http') ? v : `${BASE_URL}${v}`;
      }
    }
  }
  // Fallback: some endpoints carry a hash to build the result path ourselves.
  const hash =
    (resp['task_hash'] as string | undefined) ?? (resp['hash'] as string | undefined);
  return hash ? null : null;
}

function status(resp: Json): string {
  const meta = resp['meta'] as Json | undefined;
  return String(meta?.['status'] ?? resp['status'] ?? '');
}

/** POST a start URL, then poll its result link until meta.status is terminal. */
async function startAndPoll(
  token: string,
  startUrl: string,
  label: string,
): Promise<Json> {
  console.log(`\n--- POST ${startUrl}`);
  const start = await req(token, 'POST', startUrl);
  console.log(`HTTP ${start.status} | status="${status(start.json)}"`);
  console.log(`RAW start (${label}):`, JSON.stringify(start.json).slice(0, 600));
  // Snov returns 202 Accepted for async starts; only >=300 is a real failure.
  if (start.status >= 300) return start.json;

  const link = resultLink(start.json);
  if (!link) {
    console.log('(no result link found — returning start payload as-is)');
    return start.json;
  }
  console.log(`polling: ${link}`);
  let last: Json = start.json;
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    const r = await req(token, 'GET', link);
    last = r.json;
    const st = status(r.json);
    // HTTP 200 = task done (even if data is empty). 202 = still processing.
    if (r.status === 200 && st !== 'in_progress' && st !== 'pending') return r.json;
    await delay(POLL_INTERVAL_MS);
  }
  console.log('(polling exhausted — returning last payload)');
  return last;
}

/* eslint-disable no-console */
async function main(): Promise<void> {
  const clientId = process.env.SNOV_CLIENT_ID;
  const clientSecret = process.env.SNOV_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Set SNOV_CLIENT_ID and SNOV_CLIENT_SECRET (your Snov API user id + secret).');
  }

  const domain = process.env.SNOV_DOMAIN ?? 'stripe.com';
  const positions = list('SNOV_POSITIONS'); // default: no filter (maximise hits)
  const enrichLimit = int('SNOV_ENRICH_LIMIT', 3);

  console.log('=== Snov OAuth ===');
  const token = await getToken(clientId, clientSecret);
  console.log('access_token acquired (Bearer).');

  // ── Step 0: company info — cheapest call, confirms domain + flow work ──
  console.log(`\n=== STEP 0: company info for ${domain} ===`);
  const company = await startAndPoll(
    token,
    `${BASE_URL}/v2/domain-search/start${qs({ domain })}`,
    'company',
  );
  console.log('company data:', JSON.stringify(company['data'] ?? company).slice(0, 500));

  // ── Step 1: prospect search (domain + optional positions, in QUERY STRING) ──
  console.log(`\n=== STEP 1: prospects for ${domain}${positions ? ` positions=${positions.join('|')}` : ' (no position filter)'} ===`);
  const prospects = await startAndPoll(
    token,
    `${BASE_URL}/v2/domain-search/prospects/start${qs({ domain, page: 1, positions })}`,
    'prospects',
  );
  const data = prospects['data'];
  const rows = (Array.isArray(data)
    ? data
    : ((data as Json | undefined)?.['prospects'] as unknown[] | undefined) ?? []) as Array<Json>;
  console.log(`\nprospects returned: ${rows.length}`);
  rows.slice(0, 10).forEach((p, i) => {
    console.log(
      `  [${i}] ${p['first_name'] ?? ''} ${p['last_name'] ?? ''} — ${p['position'] ?? '—'} | hashKeys=${Object.keys(p).filter((k) => k.includes('hash')).join(',') || '(none)'}`,
    );
  });
  if (rows[0]) console.log('\nRAW first prospect:', JSON.stringify(rows[0], null, 2));

  // ── Step 2: resolve verified emails. Each prospect carries a ready-made
  //    `search_emails_start` URL — POST it directly, then poll its result. ──
  const starts = rows
    .slice(0, enrichLimit)
    .map((p) => p['search_emails_start'] as string | undefined)
    .filter((u): u is string => Boolean(u));
  console.log(`\n=== STEP 2: resolve verified emails for ${starts.length} prospects ===`);
  for (const [i, startUrl] of starts.entries()) {
    const emailResult = await startAndPoll(token, startUrl, `emails[${i}]`);
    console.log(`  [${i}] →`, JSON.stringify(emailResult['data'] ?? emailResult).slice(0, 500));
  }

  console.log(
    '\n=== VERDICT ===\n' +
      'Did Step 1 find real people at this domain, and Step 2 return VERIFIED ' +
      'emails? Snov needs a DOMAIN as input (no ICP-wide discovery) — judge ' +
      'coverage + verification vs the Apollo probe.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('snov probe failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
