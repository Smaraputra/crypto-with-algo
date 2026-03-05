import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()),
}));

import { fetchCryptoNews } from './crypto-news';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  vi.stubEnv('CRYPTOPANIC_API_TOKEN', 'test-token');
});

const mockApiResponse = {
  results: [
    {
      id: 1,
      title: 'Bitcoin hits new high',
      url: 'https://example.com/btc',
      source: { title: 'CoinDesk', domain: 'coindesk.com' },
      published_at: '2024-11-14T22:13:20Z',
      currencies: [{ code: 'BTC' }],
    },
    {
      id: 2,
      title: 'Ethereum upgrade',
      url: 'https://example.com/eth',
      source: { title: 'CryptoSlate', domain: 'cryptoslate.com' },
      published_at: '2024-11-14T22:15:00Z',
      currencies: [{ code: 'ETH' }],
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
      body: '',
      categories: 'BTC',
      publishedOn: Math.floor(Date.parse('2024-11-14T22:13:20Z') / 1000),
      imageUrl: null,
    });
  });

  it('joins multiple currency codes into categories', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            id: 3,
            title: 'Multi-coin news',
            url: 'https://example.com/multi',
            source: { title: 'Source', domain: 'source.com' },
            published_at: '2024-11-14T22:00:00Z',
            currencies: [{ code: 'BTC' }, { code: 'ETH' }],
          },
        ],
      }),
    });

    const result = await fetchCryptoNews();
    expect(result[0].categories).toBe('BTC,ETH');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(fetchCryptoNews()).rejects.toThrow('CryptoPanic News API returned 500');
  });

  it('passes currencies to URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    await fetchCryptoNews('BTC,ETH');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('currencies=BTC%2CETH'),
      expect.any(Object)
    );
  });

  it('limits to 20 items', async () => {
    const manyItems = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      title: `News ${i}`,
      url: `https://example.com/${i}`,
      source: { title: 'Source', domain: 'source.com' },
      published_at: '2024-11-14T22:00:00Z',
      currencies: [],
    }));

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: manyItems }),
    });

    const result = await fetchCryptoNews();
    expect(result).toHaveLength(20);
  });

  it('throws when CRYPTOPANIC_API_TOKEN is not set', async () => {
    vi.stubEnv('CRYPTOPANIC_API_TOKEN', '');

    await expect(fetchCryptoNews()).rejects.toThrow('CRYPTOPANIC_API_TOKEN is not configured');
  });
});
