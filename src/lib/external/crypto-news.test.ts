import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()),
}));

import { fetchCryptoNews } from './crypto-news';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});

const mockApiResponse = {
  Data: [
    {
      id: '1',
      title: 'Bitcoin hits new high',
      url: 'https://example.com/btc',
      source: 'CoinDesk',
      body: 'Bitcoin reached a new all-time high today...',
      categories: 'BTC|Trading',
      published_on: 1700000000,
      imageurl: 'https://example.com/img.jpg',
    },
    {
      id: '2',
      title: 'Ethereum upgrade',
      url: 'https://example.com/eth',
      source: 'CryptoSlate',
      body: 'The Ethereum network completed...',
      categories: 'ETH',
      published_on: 1700000100,
      imageurl: '',
    },
  ],
};

describe('fetchCryptoNews', () => {
  it('returns parsed news items', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => mockApiResponse,
    });

    const result = await fetchCryptoNews();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: '1',
      title: 'Bitcoin hits new high',
      url: 'https://example.com/btc',
      source: 'CoinDesk',
      body: 'Bitcoin reached a new all-time high today...',
      categories: 'BTC|Trading',
      publishedOn: 1700000000,
      imageUrl: 'https://example.com/img.jpg',
    });
  });

  it('sets imageUrl to null for empty string', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => mockApiResponse,
    });

    const result = await fetchCryptoNews();
    expect(result[1].imageUrl).toBeNull();
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(fetchCryptoNews()).rejects.toThrow('CryptoCompare News API returned 500');
  });

  it('passes categories to URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ Data: [] }),
    });

    await fetchCryptoNews('BTC,ETH');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('categories=BTC%2CETH'),
      expect.any(Object)
    );
  });

  it('limits to 20 items', async () => {
    const manyItems = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      title: `News ${i}`,
      url: `https://example.com/${i}`,
      source: 'Source',
      body: 'Body text',
      categories: 'BTC',
      published_on: 1700000000 + i,
      imageurl: '',
    }));

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ Data: manyItems }),
    });

    const result = await fetchCryptoNews();
    expect(result).toHaveLength(20);
  });

  it('truncates body to 200 chars', async () => {
    const longBody = 'x'.repeat(500);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        Data: [{
          id: '1', title: 'T', url: 'u', source: 's',
          body: longBody, categories: '', published_on: 0, imageurl: '',
        }],
      }),
    });

    const result = await fetchCryptoNews();
    expect(result[0].body).toHaveLength(200);
  });
});
