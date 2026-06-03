import type { ConnectorKind, SourceAdapter } from '@getbeyond/shared';
import { csvSourceAdapter } from './adapters/csv.source';
import { hubspotSourceAdapter } from './adapters/hubspot.source';
import { apolloSourceAdapter } from './adapters/apollo/apollo.source';
import { snovSourceAdapter } from './adapters/snov/snov.source';

/**
 * Source-adapter registry (eng-review pass-2 adapter architecture section).
 *
 * The intelligence layer never references vendor adapters directly. It asks
 * the registry "give me the adapter for kind=hubspot" and gets back the
 * SourceAdapter contract. Adding a new source = implement the contract, add
 * one entry below, done.
 *
 * Architecture invariant: this registry MUST stay small. Any logic that
 * needs to special-case adapter kinds belongs inside the adapter, not in
 * a switch statement on `kind` somewhere else in the codebase.
 */

const SOURCE_ADAPTERS: Partial<Record<ConnectorKind, SourceAdapter<unknown>>> =
  {
    csv: csvSourceAdapter as SourceAdapter<unknown>,
    hubspot: hubspotSourceAdapter as SourceAdapter<unknown>,
    apollo: apolloSourceAdapter as SourceAdapter<unknown>,
    snov: snovSourceAdapter as SourceAdapter<unknown>,
    // salesforce, zoominfo land in T8.
  };

export class UnknownConnectorError extends Error {
  constructor(public readonly kind: string) {
    super(`No source adapter registered for connector kind "${kind}"`);
    this.name = 'UnknownConnectorError';
  }
}

export function getSourceAdapter(
  kind: ConnectorKind,
): SourceAdapter<unknown> {
  const adapter = SOURCE_ADAPTERS[kind];
  if (!adapter) throw new UnknownConnectorError(kind);
  return adapter;
}

export function isRegisteredSource(kind: ConnectorKind): boolean {
  return Object.hasOwn(SOURCE_ADAPTERS, kind);
}

export function listRegisteredSources(): ConnectorKind[] {
  return Object.keys(SOURCE_ADAPTERS) as ConnectorKind[];
}
