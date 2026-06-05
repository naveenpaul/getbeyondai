import { describe, expect, it } from 'vitest';
import {
  createSearchProvider,
  resolveSearchProviderConfig,
  searchProviderFromEnv,
} from './registry';
import { BraveSearchProvider } from './providers/brave.provider';
import { SearxngSearchProvider } from './providers/searxng.provider';
import { SearchProviderError } from './search-provider';

describe('createSearchProvider', () => {
  it('builds a Brave provider', () => {
    expect(createSearchProvider({ name: 'brave', braveApiKey: 'k' })).toBeInstanceOf(
      BraveSearchProvider,
    );
  });

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
      createSearchProvider({ name: 'bing' as 'brave' }),
    ).toThrow(SearchProviderError);
  });
});

describe('resolveSearchProviderConfig', () => {
  it('honors an explicit SEARCH_PROVIDER', () => {
    const cfg = resolveSearchProviderConfig({
      SEARCH_PROVIDER: 'searxng',
      SEARXNG_URL: 'http://s:8080',
    } as NodeJS.ProcessEnv);
    expect(cfg.name).toBe('searxng');
    expect(cfg.searxngUrl).toBe('http://s:8080');
  });

  it('infers searxng when SEARXNG_URL is set but no explicit provider', () => {
    const cfg = resolveSearchProviderConfig({
      SEARXNG_URL: 'http://s:8080',
    } as NodeJS.ProcessEnv);
    expect(cfg.name).toBe('searxng');
  });

  it('defaults to brave when nothing is configured', () => {
    expect(resolveSearchProviderConfig({} as NodeJS.ProcessEnv).name).toBe('brave');
  });

  it('passes the brave key + searxng token through', () => {
    const cfg = resolveSearchProviderConfig({
      SEARCH_PROVIDER: 'brave',
      BRAVE_SEARCH_API_KEY: 'bk',
      SEARXNG_AUTH_TOKEN: 'st',
    } as NodeJS.ProcessEnv);
    expect(cfg.braveApiKey).toBe('bk');
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
  it('builds the env-configured provider', () => {
    expect(
      searchProviderFromEnv({
        SEARCH_PROVIDER: 'brave',
        BRAVE_SEARCH_API_KEY: 'k',
      } as NodeJS.ProcessEnv),
    ).toBeInstanceOf(BraveSearchProvider);
    expect(
      searchProviderFromEnv({
        SEARXNG_URL: 'http://searxng:8080',
      } as NodeJS.ProcessEnv).name,
    ).toBe('searxng');
  });
});
