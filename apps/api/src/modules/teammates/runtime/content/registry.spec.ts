import { describe, expect, it } from 'vitest';
import {
  contentProviderFromEnv,
  createContentProvider,
  resolveContentProviderConfig,
} from './registry';
import { LocalExtractProvider } from './providers/local-extract.provider';
import { JinaReaderProvider } from './providers/jina-reader.provider';
import { Crawl4aiProvider } from './providers/crawl4ai.provider';
import {
  ContentProviderError,
  type ContentProviderName,
} from './content-provider';

describe('createContentProvider', () => {
  it('builds a LocalExtractProvider for "local"', () => {
    const provider = createContentProvider({ name: 'local' });
    expect(provider).toBeInstanceOf(LocalExtractProvider);
    expect(provider.name).toBe('local');
  });

  it('builds a JinaReaderProvider for "jina" (no required config)', () => {
    const provider = createContentProvider({ name: 'jina' });
    expect(provider).toBeInstanceOf(JinaReaderProvider);
    expect(provider.name).toBe('jina');
  });

  it('builds a Crawl4aiProvider for "crawl4ai" with a URL', () => {
    const provider = createContentProvider({
      name: 'crawl4ai',
      crawl4aiUrl: 'http://crawl4ai:11235',
    });
    expect(provider).toBeInstanceOf(Crawl4aiProvider);
    expect(provider.name).toBe('crawl4ai');
  });

  it('throws when "crawl4ai" is selected without a URL', () => {
    expect(() => createContentProvider({ name: 'crawl4ai' })).toThrow(
      /CRAWL4AI_URL/,
    );
  });

  it('throws a ContentProviderError for an unknown provider value', () => {
    const bogus = 'firecrawl' as unknown as ContentProviderName;
    const err = (() => {
      try {
        createContentProvider({ name: bogus });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ContentProviderError);
    expect((err as ContentProviderError).message).toContain('firecrawl');
    expect((err as ContentProviderError).provider).toBe('firecrawl');
  });
});

describe('resolveContentProviderConfig', () => {
  it('defaults to local when CONTENT_PROVIDER is unset', () => {
    expect(resolveContentProviderConfig({})).toEqual({
      name: 'local',
      crawl4aiUrl: undefined,
      crawl4aiToken: undefined,
    });
  });

  it('defaults to local when CONTENT_PROVIDER is blank', () => {
    expect(resolveContentProviderConfig({ CONTENT_PROVIDER: '  ' }).name).toBe(
      'local',
    );
  });

  it('infers crawl4ai when CRAWL4AI_URL is set but no explicit provider', () => {
    const cfg = resolveContentProviderConfig({
      CRAWL4AI_URL: 'http://localhost:11235',
    });
    expect(cfg.name).toBe('crawl4ai');
    expect(cfg.crawl4aiUrl).toBe('http://localhost:11235');
  });

  it('an explicit CONTENT_PROVIDER still overrides the CRAWL4AI_URL inference', () => {
    expect(
      resolveContentProviderConfig({
        CONTENT_PROVIDER: 'local',
        CRAWL4AI_URL: 'http://localhost:11235',
      }).name,
    ).toBe('local');
  });

  it('reads crawl4ai + url + token, lowercasing the name', () => {
    expect(
      resolveContentProviderConfig({
        CONTENT_PROVIDER: 'Crawl4AI',
        CRAWL4AI_URL: 'http://crawl4ai:11235',
        CRAWL4AI_API_TOKEN: 'tok',
      }),
    ).toEqual({
      name: 'crawl4ai',
      jinaUrl: undefined,
      jinaToken: undefined,
      crawl4aiUrl: 'http://crawl4ai:11235',
      crawl4aiToken: 'tok',
    });
  });

  it('reads jina + url + token', () => {
    expect(
      resolveContentProviderConfig({
        CONTENT_PROVIDER: 'jina',
        JINA_READER_URL: 'http://reader.internal:3000',
        JINA_API_KEY: 'jk',
      }),
    ).toMatchObject({
      name: 'jina',
      jinaUrl: 'http://reader.internal:3000',
      jinaToken: 'jk',
    });
  });

  it('treats empty url/token strings as undefined', () => {
    const config = resolveContentProviderConfig({
      CONTENT_PROVIDER: 'local',
      CRAWL4AI_URL: '',
      CRAWL4AI_API_TOKEN: '',
      JINA_READER_URL: '',
      JINA_API_KEY: '',
    });
    expect(config.crawl4aiUrl).toBeUndefined();
    expect(config.crawl4aiToken).toBeUndefined();
    expect(config.jinaUrl).toBeUndefined();
    expect(config.jinaToken).toBeUndefined();
  });
});

describe('contentProviderFromEnv', () => {
  it('builds the local provider from an empty env', () => {
    expect(contentProviderFromEnv({})).toBeInstanceOf(LocalExtractProvider);
  });

  it('builds the crawl4ai provider from a configured env', () => {
    const provider = contentProviderFromEnv({
      CONTENT_PROVIDER: 'crawl4ai',
      CRAWL4AI_URL: 'http://crawl4ai:11235',
    });
    expect(provider).toBeInstanceOf(Crawl4aiProvider);
  });

  it('builds the jina provider from a configured env', () => {
    expect(
      contentProviderFromEnv({ CONTENT_PROVIDER: 'jina' }),
    ).toBeInstanceOf(JinaReaderProvider);
  });

  it('throws when crawl4ai is selected without a URL', () => {
    expect(() =>
      contentProviderFromEnv({ CONTENT_PROVIDER: 'crawl4ai' }),
    ).toThrow(/CRAWL4AI_URL/);
  });
});
