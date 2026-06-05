/**
 * PDL sourcing END-TO-END probe (throwaway) — drives the REAL PdlSourcingProvider.
 *
 * Validates the whole chain live: ICP → icpToPdlSearchQuery → PDL Company Search
 * → toCandidate → CandidateCompany[], for the exact goals we care about
 * (Bengaluru / London / Berlin IT startups). Decrypts the org's stored PDL key.
 * COST: one search per ICP at size=5 → ~15 credits.
 *
 *   node --env-file=.env -r ts-node/register/transpile-only \
 *     scripts/pdl-sourcing-e2e-probe.ts
 */

import { PrismaClient } from '@prisma/client';
import {
  decryptCredentials,
  loadMasterKey,
} from '../src/modules/connectors/credential-encryption';
import { pdlSourceAdapter } from '../src/modules/connectors/adapters/pdl/pdl.source';
import {
  PdlSourcingProvider,
  icpToPdlSearchQuery,
} from '../src/modules/connectors/sourcing/pdl-sourcing.provider';
import type { IcpCriteria } from '../src/modules/connectors/sourcing/sourcing-provider';

/* eslint-disable no-console */

const noopHealth = {
  reportVendorFailure: async () => {},
  reportVendorSuccess: () => {},
};

function icp(locations: string[]): IcpCriteria {
  return {
    keywords: ['IT', 'startup', 'technology'],
    employeeCountMin: null,
    employeeCountMax: 50,
    fundingStages: ['pre_seed', 'seed'],
    industries: [],
    locations,
  };
}

const GOALS: Array<{ label: string; icp: IcpCriteria }> = [
  { label: 'IT startups in Bengaluru', icp: icp(['Bengaluru']) },
  { label: 'IT startups in London', icp: icp(['London']) },
  { label: 'IT startups in Berlin', icp: icp(['Berlin']) },
];

async function loadKey(prisma: PrismaClient): Promise<string> {
  const masterKey = loadMasterKey(process.env.CREDENTIAL_MASTER_KEY ?? '');
  const account = await prisma.connectorAccount.findFirst({
    where: { kind: 'pdl' },
    select: { credentials: true },
  });
  if (!account) throw new Error('No PDL ConnectorAccount found');
  return decryptCredentials<{ apiKey: string }>(
    account.credentials as Buffer,
    masterKey,
  ).apiKey;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const apiKey = await loadKey(prisma);
    const provider = new PdlSourcingProvider(
      pdlSourceAdapter,
      { apiKey },
      'probe-account',
      noopHealth,
    );

    for (const goal of GOALS) {
      console.log(`\n=== ${goal.label} ===`);
      console.log('query:', JSON.stringify(icpToPdlSearchQuery(goal.icp)));
      const result = await provider.findCandidates(goal.icp, { limit: 5 });
      console.log(`summary: ${result.summary}`);
      for (const c of result.candidates) {
        const loc = (c.raw['location'] as { name?: string })?.name ?? '?';
        console.log(`  • ${c.name}  [${c.domain ?? 'no domain'}]  emp=${c.employeeCount ?? '?'}  — ${loc}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('e2e probe failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
