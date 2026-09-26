import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { GET } from './route';

const mockConnectDB = vi.fn();
vi.mock('@/lib/mongodb', () => ({
  connectDB: () => mockConnectDB(),
}));

const mockAuth = vi.fn();
vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}));

const mockLoadRows = vi.hoisted(() => vi.fn());
const mockLoadCoverage = vi.hoisted(() => vi.fn());

vi.mock('@/lib/signals/calibration-analytics', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/signals/calibration-analytics')>();
  return {
    ...actual,
    loadCalibrationRows: mockLoadRows,
    loadCalibrationCoverage: mockLoadCoverage,
  };
});

// Redis is absent in tests, so cachedFetch falls through to the fetcher. Mocked
// explicitly so the route's caching is not silently untested-but-skipped.
const mockCachedFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/redis', () => ({
  cachedFetch: (key: string, fetcher: () => Promise<unknown>, ttl: number) =>
    mockCachedFetch(key, fetcher, ttl),
}));

const HOUR = 3_600_000;

function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    symbol: 'BTCUSDT',
    candleTimestamp: i * HOUR,
    tier: 'buy' as const,
    score: 30,
    forwardReturnPercent: i % 2 === 0 ? 1 : -1,
    mfePercent: 1,
    maePercent: -1,
    configVersion: 7,
  }));
}

const COVERAGE = {
  statusCounts: { pending: 4, resolved: 100, unresolvable: 0 },
  resolvedFrom: 0,
  resolvedTo: 99 * HOUR,
  configVersions: [6, 7],
};

function request(query: string) {
  return new Request(`http://localhost/api/admin/calibration?${query}`);
}

describe('GET /api/admin/calibration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockLoadRows.mockResolvedValue(rows(100));
    mockLoadCoverage.mockResolvedValue(COVERAGE);
    mockCachedFetch.mockImplementation((_key, fetcher) => fetcher());
  });

  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  it('returns 500, not 401, when ADMIN_EMAIL is unconfigured', async () => {
    delete process.env.ADMIN_EMAIL;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await GET(request('style=day_trading&interval=1h'));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('Admin access is not configured');
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it('rejects a non-admin before touching the record', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'someone@example.com' } });

    const response = await GET(request('style=day_trading&interval=1h'));

    expect(response.status).toBe(401);
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it('rejects an interval the style does not score', async () => {
    // day_trading scores 15m and 1h. Accepting 4h here would silently produce a
    // block whose horizon belongs to a different style -- the pooling defect.
    const response = await GET(request('style=day_trading&interval=4h'));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('does not score 4h');
    expect(data.allowedIntervals).toEqual(['15m', '1h']);
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it('rejects an unknown trading style', async () => {
    const response = await GET(request('style=hodling&interval=1h'));

    expect(response.status).toBe(400);
  });

  it('defaults to the composite source rather than pooling sources', async () => {
    await GET(request('style=day_trading&interval=1h'));

    expect(mockLoadRows).toHaveBeenCalledWith(expect.objectContaining({ source: 'composite' }));
  });

  it('passes the symbol and configVersion filters through', async () => {
    await GET(request('style=day_trading&interval=1h&symbol=ETHUSDT&configVersion=7'));

    expect(mockLoadRows).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'ETHUSDT', configVersion: 7 })
    );
  });

  it('leaves coverage unfiltered by configVersion so a thin slice is distinguishable from a thin record', async () => {
    await GET(request('style=day_trading&interval=1h&configVersion=7'));

    const coverageArgs = mockLoadCoverage.mock.calls[0][0];
    expect(coverageArgs).not.toHaveProperty('configVersion');
    expect(coverageArgs).toMatchObject({ tradingStyle: 'day_trading', interval: '1h' });
  });

  it('uses the interval default round-trip cost and says that it did', async () => {
    const response = await GET(request('style=day_trading&interval=1h'));
    const data = await response.json();

    // 1h: two taker legs at 0.05% plus 3bps slippage each = 0.16%.
    expect(data.meta.costPercentRoundTrip).toBeCloseTo(0.16, 10);
    expect(data.meta.costIsDefault).toBe(true);
  });

  it('honours a cost override', async () => {
    const response = await GET(request('style=day_trading&interval=1h&cost=0'));
    const data = await response.json();

    expect(data.meta.costPercentRoundTrip).toBe(0);
    expect(data.meta.costIsDefault).toBe(false);
  });

  it('sets the block length from the style horizon, not from the row count', async () => {
    const response = await GET(request('style=day_trading&interval=1h'));
    const data = await response.json();

    // day_trading resolves 24 bars ahead.
    expect(data.meta.horizonBars).toBe(24);
    expect(data.meta.meanBlockLenBars).toBe(24);
  });

  it('emits a cumulative path over rows one bar apart at 1h', async () => {
    // The bar length comes from the interval, not from gaps between the
    // actionable rows that survive filtering. With 100 hourly buy signals and a
    // 24-bar horizon, a correct sampler keeps about four; inferring the bar
    // from sparse actionable rows would keep fewer and understate the path.
    mockLoadRows.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => ({
        symbol: 'BTCUSDT',
        candleTimestamp: i * HOUR,
        tier: 'buy' as const,
        score: 31,
        forwardReturnPercent: 1,
        mfePercent: 1,
        maePercent: -1,
        configVersion: 7,
      }))
    );

    const response = await GET(request('style=day_trading&interval=1h'));
    const data = await response.json();

    expect(data.cumulative).toHaveLength(1);
    expect(data.cumulative[0].count).toBe(5);
  });

  it('returns all four views plus coverage', async () => {
    const response = await GET(request('style=day_trading&interval=1h'));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toHaveProperty('tiers');
    expect(data).toHaveProperty('reliability');
    expect(data).toHaveProperty('distribution');
    expect(data).toHaveProperty('cumulative');
    expect(data.meta.statusCounts).toEqual(COVERAGE.statusCounts);
    expect(data.meta.configVersions).toEqual([6, 7]);
  });

  it('defaults the cumulative path to non-overlapping', async () => {
    const response = await GET(request('style=day_trading&interval=1h'));

    expect((await response.json()).meta.overlapping).toBe(false);
  });

  it('caches per filter combination, so two filters cannot share a payload', async () => {
    await GET(request('style=day_trading&interval=1h&symbol=BTCUSDT'));
    await GET(request('style=day_trading&interval=1h&symbol=ETHUSDT'));

    const [firstKey] = mockCachedFetch.mock.calls[0];
    const [secondKey] = mockCachedFetch.mock.calls[1];
    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).toContain('BTCUSDT');
  });

  it('returns 500 and no detail when the record cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockLoadRows.mockRejectedValue(new Error('mongo is down'));

    const response = await GET(request('style=day_trading&interval=1h'));
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Internal server error');
    expect(JSON.stringify(data)).not.toContain('mongo is down');
  });
});
