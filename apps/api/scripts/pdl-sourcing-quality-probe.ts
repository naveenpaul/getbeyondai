/**
 * Inspect the QUALITY of what our PDL query returns (throwaway): runs the real
 * icpToPdlSearchQuery for the Bengaluru-IT ICP and dumps each result's industry/
 * size/website so we can tell mistagged-junk-in-PDL from a filter-not-applying bug.
 *   node --env-file=.env -r ts-node/register/transpile-only \
 *     scripts/pdl-sourcing-quality-probe.ts
 */
import { PrismaClient } from '@prisma/client';
import {
  decryptCredentials,
  loadMasterKey,
} from '../src/modules/connectors/credential-encryption';
import { icpToPdlSearchQuery } from '../src/modules/connectors/sourcing/pdl-sourcing.provider';
import type { IcpCriteria } from '../src/modules/connectors/sourcing/sourcing-provider';

/* eslint-disable no-console */

const ICP: IcpCriteria = {
  keywords: ['IT', 'startup', 'technology'],
  employeeCountMin: null,
  employeeCountMax: 50,
  fundingStages: ['pre_seed', 'seed'],
  industries: [],
  locations: ['Bengaluru'],
};

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const masterKey = loadMasterKey(process.env.CREDENTIAL_MASTER_KEY ?? '');
    const account = await prisma.connectorAccount.findFirst({
      where: { kind: 'pdl' },
      select: { credentials: true },
    });
    const apiKey = decryptCredentials<{ apiKey: string }>(
      account!.credentials as Buffer,
      masterKey,
    ).apiKey;

    const query = icpToPdlSearchQuery(ICP);
    console.log('QUERY:', JSON.stringify(query), '\n');

    const res = await fetch('https://api.peopledatalabs.com/v5/company/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({ query, size: 10 }),
    });
    const body = (await res.json()) as {
      total?: number;
      data?: Array<Record<string, unknown>>;
    };
    console.log(`total=${body.total}\n`);
    for (const c of body.data ?? []) {
      console.log(
        `• ${String(c['name']).padEnd(40)} industry="${String(c['industry'])}"  ` +
          `size=${String(c['size'])}  emp=${String(c['employee_count'])}  web=${String(c['website'])}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
