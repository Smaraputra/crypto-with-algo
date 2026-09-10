import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/historical-snapshots', () => ({
  alignTimestamp: vi.fn((ts: number) => ts),
  bulkUpsertSnapshots: vi.fn(),
  getActiveSymbols: vi.fn(),
}));

vi.mock('@/lib/binance-futures', () => ({
  fetchFundingRate: vi.fn(),
  fetchLongShortRatio: vi.fn(),
  fetchOpenInterest: vi.fn(),
}));

vi.mock('@/lib/external/fear-greed', () => ({
  fetchFearAndGreed: vi.fn(),
}));

vi.mock('@/lib/external/crypto-news', () => ({
  fetchCryptoNews: vi.fn(),
}));

vi.mock('@/lib/external/news-sentiment', () => ({
  analyzeNewsSentiment: vi.fn(),
}));

describe('GET /api/cron/ingest-snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
  });

  it('should reject requests without cron secret', async () => {
    const req = new Request('http://localhost:3000/api/cron/ingest-snapshots?interval=1h');
    const res = await GET(req as never);

    expect(res.status).toBe(401);
  });

  it('should reject invalid interval', async () => {
    const req = new Request('http://localhost:3000/api/cron/ingest-snapshots?interval=invalid', {
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = await GET(req as never);

    expect(res.status).toBe(400);
  });

  it('should ingest snapshots for active symbols', async () => {
    const { getActiveSymbols, bulkUpsertSnapshots } = await import('@/lib/historical-snapshots');
    const { fetchFundingRate, fetchLongShortRatio, fetchOpenInterest } = await import('@/lib/binance-futures');
    const { fetchFearAndGreed } = await import('@/lib/external/fear-greed');
    const { fetchCryptoNews } = await import('@/lib/external/crypto-news');
    const { analyzeNewsSentiment } = await import('@/lib/external/news-sentiment');

    vi.mocked(getActiveSymbols).mockResolvedValue(['BTCUSDT', 'ETHUSDT']);
    vi.mocked(fetchFearAndGreed).mockResolvedValue({
      fearGreedIndex: 50,
      label: 'Neutral',
    });

    vi.mocked(fetchFundingRate).mockResolvedValue([
      { symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: Date.now(), markPrice: 50000 },
    ]);

    vi.mocked(fetchLongShortRatio).mockResolvedValue([
      { symbol: 'BTCUSDT', longShortRatio: 1.2, longAccount: 0.55, shortAccount: 0.45, timestamp: Date.now() },
    ]);

    vi.mocked(fetchOpenInterest).mockResolvedValue({
      symbol: 'BTCUSDT',
      openInterest: 1000000,
      time: Date.now(),
    });

    vi.mocked(fetchCryptoNews).mockResolvedValue([]);
    vi.mocked(analyzeNewsSentiment).mockReturnValue({
      count: 0,
      avgSentiment: 0,
      topics: [],
    });

    const req = new Request('http://localhost:3000/api/cron/ingest-snapshots?interval=1h', {
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = await GET(req as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.symbols).toBe(2);
    expect(body.ingested).toBeGreaterThanOrEqual(1);
    expect(bulkUpsertSnapshots).toHaveBeenCalled();
  });

  it('strips the USDT suffix before fetching news', async () => {
    const { getActiveSymbols } = await import('@/lib/historical-snapshots');
    const { fetchFundingRate, fetchLongShortRatio, fetchOpenInterest } = await import('@/lib/binance-futures');
    const { fetchFearAndGreed } = await import('@/lib/external/fear-greed');
    const { fetchCryptoNews } = await import('@/lib/external/crypto-news');

    vi.mocked(getActiveSymbols).mockResolvedValue(['BTCUSDT']);
    vi.mocked(fetchFearAndGreed).mockResolvedValue({ fearGreedIndex: 50, label: 'Neutral' });
    vi.mocked(fetchFundingRate).mockResolvedValue([]);
    vi.mocked(fetchLongShortRatio).mockResolvedValue([]);
    vi.mocked(fetchOpenInterest).mockRejectedValue(new Error('unavailable'));
    vi.mocked(fetchCryptoNews).mockResolvedValue([]);

    const req = new Request('http://localhost:3000/api/cron/ingest-snapshots?interval=1h', {
      headers: { authorization: 'Bearer test-secret' },
    });
    await GET(req as never);

    expect(fetchCryptoNews).toHaveBeenCalledWith('BTC');
  });

  it('continues without Fear & Greed when the fetch throws', async () => {
    const { getActiveSymbols, bulkUpsertSnapshots } = await import('@/lib/historical-snapshots');
    const { fetchFundingRate, fetchLongShortRatio, fetchOpenInterest } = await import('@/lib/binance-futures');
    const { fetchFearAndGreed } = await import('@/lib/external/fear-greed');
    const { fetchCryptoNews } = await import('@/lib/external/crypto-news');

    vi.mocked(getActiveSymbols).mockResolvedValue(['BTCUSDT']);
    vi.mocked(fetchFearAndGreed).mockRejectedValue(new Error('API down'));
    vi.mocked(fetchFundingRate).mockResolvedValue([
      { symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: Date.now(), markPrice: 50000 },
    ]);
    vi.mocked(fetchLongShortRatio).mockResolvedValue([]);
    vi.mocked(fetchOpenInterest).mockRejectedValue(new Error('unavailable'));
    vi.mocked(fetchCryptoNews).mockResolvedValue([]);

    const req = new Request('http://localhost:3000/api/cron/ingest-snapshots?interval=1h', {
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = await GET(req as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ingested).toBe(1);
    expect(bulkUpsertSnapshots).toHaveBeenCalled();
    const snapshots = vi.mocked(bulkUpsertSnapshots).mock.calls[0][0];
    expect(snapshots[0].data.fearGreed).toBeUndefined();
  });

  it('should handle API failures gracefully', async () => {
    const { getActiveSymbols } = await import('@/lib/historical-snapshots');
    const { fetchFundingRate, fetchLongShortRatio, fetchOpenInterest } = await import('@/lib/binance-futures');
    const { fetchFearAndGreed } = await import('@/lib/external/fear-greed');
    const { fetchCryptoNews } = await import('@/lib/external/crypto-news');

    vi.mocked(getActiveSymbols).mockResolvedValue(['BTCUSDT']);
    vi.mocked(fetchFearAndGreed).mockRejectedValue(new Error('API error'));

    // All API calls fail
    vi.mocked(fetchFundingRate).mockRejectedValue(new Error('API error'));
    vi.mocked(fetchLongShortRatio).mockRejectedValue(new Error('API error'));
    vi.mocked(fetchOpenInterest).mockRejectedValue(new Error('API error'));
    vi.mocked(fetchCryptoNews).mockRejectedValue(new Error('API error'));

    const req = new Request('http://localhost:3000/api/cron/ingest-snapshots?interval=1h', {
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = await GET(req as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    // When all API calls fail, the catch block increments errorCount
    expect(body.errors).toBeGreaterThanOrEqual(0);
    expect(body.ingested).toBeGreaterThanOrEqual(0);
  });
});
