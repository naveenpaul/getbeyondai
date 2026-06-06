import { describe, expect, it } from 'vitest';
import {
  createSearchProvider,
  resolveSearchProviderConfig,
  searchProviderFromEnv,
} from './registry';
import { SearxngSearchProvider } from './providers/searxng.provider';
import { SearchProviderError } from './search-provider';

describe('createSearchProvider', () => {
  it('builds a SearXNG provider when a URL is given', () => {
    expect(
      createSearchProvider({ name: 'searxng', searxngUrl: 'http://searxng:8080' }),
    ).toBeInstanceOf(SearxngSearchProvider);
  });

  it('throws when searxng is selected without a URL', () => {
    expect(() => createSearchProvider({ name: 'searxng' })).toThrow(
      /requires SEARXNG_URL/,
    );
  });

  it('throws a clear error for an unknown provider name', () => {
    expect(() =>
      createSearchProvider({ name: 'bing' as 'searxng' }),
    ).toThrow(SearchProviderError);
  });
});

describe('resolveSearchProviderConfig', () => {
  it('honors an explicit SEARCH_PROVIDER=searxng', () => {
    const cfg = resolveSearchProviderConfig({
      SEARCH_PROVIDER: 'searxng',
      SEARXNG_URL: 'http://s:8080',
    } as NodeJS.ProcessEnv);
    expect(cfg.name).toBe('searxng');
    expect(cfg.searxngUrl).toBe('http://s:8080');
  });

  it('defaults to searxng when no provider is named', () => {
    const cfg = resolveSearchProviderConfig({
      SEARXNG_URL: 'http://s:8080',
    } as NodeJS.ProcessEnv);
    expect(cfg.name).toBe('searxng');
    expect(cfg.searxngUrl).toBe('http://s:8080');
  });

  it('passes the searxng token through', () => {
    const cfg = resolveSearchProviderConfig({
      SEARXNG_URL: 'http://s:8080',
      SEARXNG_AUTH_TOKEN: 'st',
    } as NodeJS.ProcessEnv);
    expect(cfg.searxngToken).toBe('st');
  });

  it('surfaces an unknown explicit value as a loud construction error', () => {
    const cfg = resolveSearchProviderConfig({
      SEARCH_PROVIDER: 'google',
    } as NodeJS.ProcessEnv);
    expect(() => createSearchProvider(cfg)).toThrow(SearchProviderError);
  });
});

describe('searchProviderFromEnv', () => {
  it('builds the env-configured SearXNG provider', () => {
    expect(
      searchProviderFromEnv({
        SEARXNG_URL: 'http://searxng:8080',
      } as NodeJS.ProcessEnv).name,
    ).toBe('searxng');
  });

  it('throws when SEARXNG_URL is missing', () => {
    expect(() => searchProviderFromEnv({} as NodeJS.ProcessEnv)).toThrow(
      /requires SEARXNG_URL/,
    );
  });
});
