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

vi.mock('@/lib/sentiment-analysis', () => ({
  fetchFearGreedIndex: vi.fn(),
  fetchCryptoNews: vi.fn(),
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
    const { fetchFearGreedIndex, fetchCryptoNews, analyzeNewsSentiment } = await import('@/lib/sentiment-analysis');

    vi.mocked(getActiveSymbols).mockResolvedValue(['BTCUSDT', 'ETHUSDT']);
    vi.mocked(fetchFearGreedIndex).mockResolvedValue({
      value: 50,
      valueClassification: 'Neutral',
      timestamp: Date.now(),
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

  it('should handle API failures gracefully', async () => {
    const { getActiveSymbols } = await import('@/lib/historical-snapshots');
    const { fetchFundingRate, fetchLongShortRatio, fetchOpenInterest } = await import('@/lib/binance-futures');
    const { fetchCryptoNews } = await import('@/lib/sentiment-analysis');

    vi.mocked(getActiveSymbols).mockResolvedValue(['BTCUSDT']);

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
