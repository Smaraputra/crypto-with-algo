import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()),
}));

import { fetchFearAndGreed, fetchFearAndGreedHistory } from './fear-greed';

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

describe('fetchFearAndGreedHistory', () => {
  it('returns daily entries with ms timestamps', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { value: '73', value_classification: 'Greed', timestamp: '1788652800' },
          { value: '25', value_classification: 'Fear', timestamp: '1788566400' },
        ],
      }),
    });

    const result = await fetchFearAndGreedHistory(2);

    expect(result).toEqual([
      { timestamp: 1788652800000, fearGreedIndex: 73, label: 'Greed' },
      { timestamp: 1788566400000, fearGreedIndex: 25, label: 'Fear' },
    ]);
  });

  it('requests the given number of days', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await fetchFearAndGreedHistory(90);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.alternative.me/fng/?limit=90&format=json',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(fetchFearAndGreedHistory(30)).rejects.toThrow('Fear & Greed API returned 503');
  });

  it('returns empty array when API returns no data', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await expect(fetchFearAndGreedHistory(30)).resolves.toEqual([]);
  });
});
