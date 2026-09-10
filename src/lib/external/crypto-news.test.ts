import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCachedFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/redis', () => ({
  cachedFetch: (key: string, fn: () => Promise<unknown>, ttl: number) =>
    mockCachedFetch(key, fn, ttl),
}));

import { fetchCryptoNews } from './crypto-news';
import { parseFeed, dedupeAndSort } from './rss-news';
import { cointelegraphRss, decryptRss } from '@/__fixtures__/news';
import type { CryptoNewsItem } from '@/types/news';

const feedItems = dedupeAndSort([
  ...parseFeed(cointelegraphRss, 'Cointelegraph'),
  ...parseFeed(decryptRss, 'Decrypt'),
]);

function makeItems(count: number): CryptoNewsItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    title: `Bitcoin story ${i}`,
    url: `https://example.com/${i}`,
    source: 'CoinDesk',
    body: '',
    categories: '',
    publishedOn: 1_800_000_000 - i,
    imageUrl: null,
  }));
}

describe('fetchCryptoNews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: pass through to the real fetcher argument.
    mockCachedFetch.mockImplementation((_key, fn) => fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the merged feed when no ticker is given', async () => {
    mockCachedFetch.mockResolvedValue(feedItems);

    const result = await fetchCryptoNews();

    expect(result).toEqual(feedItems);
  });

  it('narrows the merged feed to the requested ticker', async () => {
    mockCachedFetch.mockResolvedValue(feedItems);

    const result = await fetchCryptoNews('BTC');

    expect(result).toHaveLength(1);
    expect(result[0].title).toContain('Bitcoin ETF');
  });

  it('caches the whole feed under one key, not one key per ticker', async () => {
    mockCachedFetch.mockResolvedValue(feedItems);

    await fetchCryptoNews('BTC');
    await fetchCryptoNews('ETH');

    // Snapshot ingestion asks for ten symbols a cycle; a per-symbol key meant
    // ten upstream fetches per cycle.
    const keys = new Set(mockCachedFetch.mock.calls.map((call) => call[0]));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('news:crypto:all');
  });

  it('caches for five minutes', async () => {
    mockCachedFetch.mockResolvedValue(feedItems);

    await fetchCryptoNews();

    expect(mockCachedFetch).toHaveBeenCalledWith('news:crypto:all', expect.any(Function), 300);
  });

  it('limits the result to 20 items', async () => {
    mockCachedFetch.mockResolvedValue(makeItems(50));

    const result = await fetchCryptoNews();

    expect(result).toHaveLength(20);
  });

  it('limits after filtering, so a ticker can still return 20 stories', async () => {
    mockCachedFetch.mockResolvedValue(makeItems(50));

    const result = await fetchCryptoNews('BTC');

    expect(result).toHaveLength(20);
  });

  it('returns an empty list when no story matches the ticker', async () => {
    mockCachedFetch.mockResolvedValue(feedItems);

    await expect(fetchCryptoNews('LTC')).resolves.toEqual([]);
  });

  it('requires no API credentials', async () => {
    delete process.env.CRYPTOPANIC_API_TOKEN;
    mockCachedFetch.mockResolvedValue(feedItems);

    // The previous provider threw without a token; RSS feeds are unauthenticated.
    await expect(fetchCryptoNews('BTC')).resolves.toHaveLength(1);
  });
});
