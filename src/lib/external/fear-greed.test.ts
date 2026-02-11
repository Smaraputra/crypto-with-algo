import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()),
}));

import { fetchFearAndGreed } from './fear-greed';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});

describe('fetchFearAndGreed', () => {
  it('returns parsed sentiment data', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            value: '42',
            value_classification: 'Fear',
            timestamp: '1700000000',
          },
        ],
      }),
    });

    const result = await fetchFearAndGreed();

    expect(result).toEqual({
      fearGreedIndex: 42,
      label: 'Fear',
    });
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(fetchFearAndGreed()).rejects.toThrow('Fear & Greed API returned 500');
  });

  it('throws when no data entries returned', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await expect(fetchFearAndGreed()).rejects.toThrow('No Fear & Greed data returned');
  });

  it('calls fetch with correct URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ value: '50', value_classification: 'Neutral', timestamp: '1700000000' }],
      }),
    });

    await fetchFearAndGreed();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.alternative.me/fng/?limit=1&format=json',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('parses extreme greed correctly', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ value: '85', value_classification: 'Extreme Greed', timestamp: '1700000000' }],
      }),
    });

    const result = await fetchFearAndGreed();
    expect(result.fearGreedIndex).toBe(85);
    expect(result.label).toBe('Extreme Greed');
  });
});
