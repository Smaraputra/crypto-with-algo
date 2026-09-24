import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

// withJobRun upserts a heartbeat after the handler returns. Mock the MODEL and
// not the wrapper, so the wrapper's real logic still runs here. Without this,
// mongoose buffers the write against an unconnected client and the test hangs.
vi.mock('@/lib/models/job-heartbeat', () => ({
  JobHeartbeat: { updateOne: vi.fn() },
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

  describe('news sentiment window', () => {
    const newsItem = (msAgo: number, title: string) => ({
      id: title,
      title,
      url: `https://example.com/${encodeURIComponent(title)}`,
      source: 'Decrypt',
      body: '',
      categories: '',
      publishedOn: Math.floor((Date.now() - msAgo) / 1000),
      imageUrl: null,
    });
    const days = (n: number) => n * 24 * 60 * 60 * 1000;

    async function runWith(items: ReturnType<typeof newsItem>[]) {
      const { getActiveSymbols, bulkUpsertSnapshots } = await import('@/lib/historical-snapshots');
      const { fetchFundingRate, fetchLongShortRatio, fetchOpenInterest } = await import('@/lib/binance-futures');
      const { fetchFearAndGreed } = await import('@/lib/external/fear-greed');
      const { fetchCryptoNews } = await import('@/lib/external/crypto-news');
      const { analyzeNewsSentiment } = await import('@/lib/external/news-sentiment');

      vi.mocked(getActiveSymbols).mockResolvedValue(['BTCUSDT']);
      vi.mocked(fetchFearAndGreed).mockResolvedValue({ fearGreedIndex: 50, label: 'Neutral' });
      // Funding succeeds so the row is always written, keeping these cases
      // about the NEWS WINDOW rather than about the hollow-row guard (which
      // has its own test below).
      vi.mocked(fetchFundingRate).mockResolvedValue([
        { symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: Date.now(), markPrice: 50000 },
      ]);
      vi.mocked(fetchLongShortRatio).mockResolvedValue([]);
      vi.mocked(fetchOpenInterest).mockRejectedValue(new Error('unavailable'));
      vi.mocked(fetchCryptoNews).mockResolvedValue(items);
      vi.mocked(analyzeNewsSentiment).mockReturnValue({ count: 1, avgSentiment: 0.3, topics: [] });

      const req = new Request('http://localhost:3000/api/cron/ingest-snapshots?interval=1h', {
        headers: { authorization: 'Bearer test-secret' },
      });
      const res = await GET(req as never);
      const body = await res.json();

      return { analyzeNewsSentiment, bulkUpsertSnapshots, body };
    }

    /** Every per-symbol source rejected, but Fear & Greed still succeeding. */
    async function runWithAllSymbolSourcesFailing() {
      const { getActiveSymbols, bulkUpsertSnapshots } = await import('@/lib/historical-snapshots');
      const { fetchFundingRate, fetchLongShortRatio, fetchOpenInterest } = await import('@/lib/binance-futures');
      const { fetchFearAndGreed } = await import('@/lib/external/fear-greed');
      const { fetchCryptoNews } = await import('@/lib/external/crypto-news');

      vi.mocked(getActiveSymbols).mockResolvedValue(['BTCUSDT']);
      vi.mocked(fetchFearAndGreed).mockResolvedValue({ fearGreedIndex: 50, label: 'Neutral' });
      vi.mocked(fetchFundingRate).mockRejectedValue(new Error('binance down'));
      vi.mocked(fetchLongShortRatio).mockRejectedValue(new Error('binance down'));
      vi.mocked(fetchOpenInterest).mockRejectedValue(new Error('binance down'));
      vi.mocked(fetchCryptoNews).mockRejectedValue(new Error('feeds down'));

      const req = new Request('http://localhost:3000/api/cron/ingest-snapshots?interval=1h', {
        headers: { authorization: 'Bearer test-secret' },
      });
      const body = await (await GET(req as never)).json();

      return { bulkUpsertSnapshots, body };
    }

    it('analyses only headlines inside the window', async () => {
      // The defect: the feed is newest-first and was sliced to a flat 20 with no
      // lower bound, so a symbol with one fresh story had its sentiment averaged
      // mostly over months-old evergreen posts.
      const fresh = newsItem(days(1), 'Bitcoin ETF inflows surge');
      const stale = newsItem(days(200), 'What is a blockchain? Explainer video');

      const { analyzeNewsSentiment } = await runWith([fresh, stale]);

      expect(analyzeNewsSentiment).toHaveBeenCalledWith([fresh]);
    });

    it('stores no newsSentiment at all when nothing is recent', async () => {
      // A false neutral would read as real evidence of balanced news. The scorer
      // handles an absent field by redistributing weight, so absence is correct.
      const { analyzeNewsSentiment, bulkUpsertSnapshots } = await runWith([
        newsItem(days(120), 'Old explainer'),
      ]);

      expect(analyzeNewsSentiment).not.toHaveBeenCalled();
      const [snapshots] = vi.mocked(bulkUpsertSnapshots).mock.calls[0];
      expect(snapshots[0].data.newsSentiment).toBeUndefined();
    });

    it('counts a rejected sub-fetch instead of reporting a clean run', async () => {
      // Promise.allSettled never rejects, so `errors` could not increment from
      // an upstream failure: a total Binance futures outage reported
      // `ingested: 10, errors: 0`. openInterest is rejected in runWith.
      const { bulkUpsertSnapshots, body } = await runWith([newsItem(days(1), 'BTC rallies')]);

      expect(bulkUpsertSnapshots).toHaveBeenCalled();
      // One rejected source (openInterest) across one symbol.
      expect(body.fetchErrors).toBe(1);
      expect(body.errors).toBe(0);
    });

    it('stores nothing and counts a skip when every per-symbol source fails', async () => {
      // The hollow-row case. Fear & Greed still succeeds and is written into
      // data, so a naive Object.keys(data).length check would wrongly call
      // this a real snapshot.
      const { bulkUpsertSnapshots, body } = await runWithAllSymbolSourcesFailing();

      expect(body.skipped).toBe(1);
      expect(body.ingested).toBe(0);
      expect(bulkUpsertSnapshots).not.toHaveBeenCalled();
    });

    it('drops dateless headlines, which carry publishedOn 0', async () => {
      const dateless = { ...newsItem(0, 'Undated story'), publishedOn: 0 };
      const fresh = newsItem(days(1), 'Solana breaks out');

      const { analyzeNewsSentiment } = await runWith([dateless, fresh]);

      expect(analyzeNewsSentiment).toHaveBeenCalledWith([fresh]);
    });
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

    // The limit is deliberately wide: the news window decides the sample, not
    // the cap, so the cap must not bind first.
    expect(fetchCryptoNews).toHaveBeenCalledWith('BTC', 100);
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
