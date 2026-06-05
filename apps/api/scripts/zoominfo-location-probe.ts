/**
 * ZoomInfo LOCATION probe (throwaway) — answers: can we city-target Bengaluru?
 *
 * Decrypts the org's stored ZoomInfo creds (no secrets in argv/env) and fires a
 * few CompanySearch variants against the LIVE GTM Data API to see which location
 * strategy actually returns Bengaluru companies:
 *   A. country="Bengaluru"          — the original failure (expect 400)
 *   B. zipCode + zipCodeRadiusMiles — the hypothesis (radius around a PIN code)
 *   C. zipCode + radius + IT + small headcount — the realistic query
 *   D. country="India" + IT + headcount — the fallback baseline
 *   E. state="Karnataka"            — a state-level alternative
 *
 * Company search is FREE (no credits, no record-limit) per ZoomInfo's plan; each
 * variant is one request against the request limit. Run:
 *   node --env-file=.env -r ts-node/register/transpile-only \
 *     scripts/zoominfo-location-probe.ts
 */

import { PrismaClient } from '@prisma/client';
import {
  decryptCredentials,
  loadMasterKey,
} from '../src/modules/connectors/credential-encryption';
import { ZoomInfoClient } from '../src/modules/connectors/adapters/zoominfo/zoominfo.source';

/* eslint-disable no-console */

/** The prospect search that failed with the country=Bengaluru 400. */
const FAILED_PROSPECT_SEARCH_ID = 'cmq0l50j90001brjpafvghhh2';

interface ZoomInfoCreds {
  clientId: string;
  clientSecret: string;
}

async function loadZoomInfoCreds(prisma: PrismaClient): Promise<ZoomInfoCreds> {
  const masterB64 = process.env.CREDENTIAL_MASTER_KEY;
  if (!masterB64) throw new Error('CREDENTIAL_MASTER_KEY not set (use --env-file=.env)');
  const masterKey = loadMasterKey(masterB64);

  // Prefer the org that owns the failed search; otherwise any connected ZoomInfo.
  const ps = await prisma.prospectSearch.findUnique({
    where: { id: FAILED_PROSPECT_SEARCH_ID },
    select: { orgId: true },
  });
  const account = await prisma.connectorAccount.findFirst({
    where: { kind: 'zoominfo', ...(ps ? { orgId: ps.orgId } : {}) },
    select: { id: true, orgId: true, credentials: true },
  });
  if (!account) throw new Error('No ZoomInfo ConnectorAccount found in the DB');

  const creds = decryptCredentials<ZoomInfoCreds>(
    account.credentials as Buffer,
    masterKey,
  );
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error('Decrypted creds missing clientId/clientSecret');
  }
  return creds;
}

interface Probe {
  label: string;
  attributes: Record<string, unknown>;
}

const PROBES: Probe[] = [
  {
    label: 'A. country="Bengaluru" (the original failure — expect 400)',
    attributes: { country: 'Bengaluru' },
  },
  {
    label: 'B. zipCode=560001 + radius=25 (the hypothesis)',
    attributes: { zipCode: '560001', zipCodeRadiusMiles: 25 },
  },
  {
    label: 'C. zipCode=560001 + radius=25 + IT + small headcount (realistic)',
    attributes: {
      zipCode: '560001',
      zipCodeRadiusMiles: 25,
      industryKeywords: 'IT OR software OR technology',
      employeeCount: '1to4,5to9,10to19,20to49',
    },
  },
  {
    label: 'D. country="India" + IT + small headcount (fallback baseline)',
    attributes: {
      country: 'India',
      industryKeywords: 'IT OR software OR technology',
      employeeCount: '1to4,5to9,10to19,20to49',
    },
  },
  {
    label: 'E. state="Karnataka" (state-level alternative)',
    attributes: { state: 'Karnataka' },
  },
];

/** Best-effort one-line location from a result's attribute bag. */
function locationOf(a: Record<string, unknown>): string {
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  const parts = [
    s('city') || s('companyCity'),
    s('state') || s('companyState'),
    s('country') || s('companyCountry'),
  ].filter(Boolean);
  return parts.join(', ') || s('street') || s('address') || '(no location fields)';
}

async function runProbe(client: ZoomInfoClient, p: Probe): Promise<void> {
  console.log(`\n=== ${p.label} ===`);
  console.log('  attributes:', JSON.stringify(p.attributes));
  try {
    const doc = await client.searchCompanies(p.attributes, {
      page: 1,
      pageSize: 5,
    });
    const rows = Array.isArray(doc.data)
      ? (doc.data as Record<string, unknown>[])
      : [];
    const meta = (doc as { meta?: { totalResults?: number } }).meta ?? {};
    console.log(`  OK — totalResults=${meta.totalResults ?? '?'} rows=${rows.length}`);
    for (const row of rows) {
      const a = (row['attributes'] as Record<string, unknown>) ?? {};
      const name = a['name'] ?? a['companyName'] ?? '(no name)';
      console.log(`    • ${String(name)}  —  ${locationOf(a)}`);
    }
    const first = rows[0];
    if (first) {
      const a0 = (first['attributes'] as Record<string, unknown>) ?? {};
      console.log('    first-row attribute keys:', Object.keys(a0).join(', '));
    }
  } catch (err) {
    console.log(
      '  ERROR —',
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const creds = await loadZoomInfoCreds(prisma);
    console.log(
      `Loaded ZoomInfo creds from DB (clientId ****${creds.clientId.slice(-4)})`,
    );
    const client = new ZoomInfoClient({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    });
    const ping = await client.ping();
    console.log('OAuth ping:', ping.ok ? 'OK' : `FAILED (${ping.error})`);
    if (!ping.ok) return;
    for (const probe of PROBES) await runProbe(client, probe);
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('probe failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
