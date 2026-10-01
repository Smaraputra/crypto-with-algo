// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { OHLCV } from '@/types/market';
import type { TradePlanResponse } from '@/lib/trade-plan/types';

const mockAuth = vi.fn();
const mockConnectDB = vi.fn();
const mockSignalFindOne = vi.fn();
const mockSnapshotFindOne = vi.fn();
const mockGetCandles = vi.fn();
const mockGetLiveTierExpectancy = vi.fn();
const mockLedgerFindOne = vi.fn();

vi.mock('@/lib/auth', () => ({ auth: () => mockAuth() }));
vi.mock('@/lib/mongodb', () => ({ connectDB: () => mockConnectDB() }));
vi.mock('@/lib/redis', () => ({
  cachedFetch: (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
}));
vi.mock('@/lib/candle-ingestion', () => ({
  getCandles: (...args: unknown[]) => mockGetCandles(...args),
}));
vi.mock('@/lib/models/global-signal', () => ({
  GlobalSignal: { findOne: (...args: unknown[]) => mockSignalFindOne(...args) },
}));
vi.mock('@/lib/models/historical-snapshot', () => ({
  HistoricalSnapshot: { findOne: (...args: unknown[]) => mockSnapshotFindOne(...args) },
}));
vi.mock('@/lib/models/paper-ledger', () => ({
  PaperLedger: { findOne: (...args: unknown[]) => mockLedgerFindOne(...args) },
}));
vi.mock('@/lib/signals/outcome-analytics', () => ({
  getLiveTierExpectancy: (...args: unknown[]) => mockGetLiveTierExpectancy(...args),
}));

const HOUR = 3_600_000;

function bars(count: number): OHLCV[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: i * HOUR,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  }));
}

/** Mongoose's findOne(...).sort(...).lean() chain resolving to `doc`. */
function chain(doc: unknown) {
  return { sort: () => ({ lean: () => Promise.resolve(doc) }) };
}

/** Mongoose's findOne(...).lean() chain, with no sort. */
function plain(doc: unknown) {
  return { lean: () => Promise.resolve(doc) };
}

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/trade-plan');
  for (const [key, val] of Object.entries(params)) url.searchParams.set(key, val);
  return new NextRequest(url);
}

const VALID = { symbol: 'SOLUSDT', tradingStyle: 'day_trading', interval: '1h' };

describe('GET /api/trade-plan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'user1' } });
    mockConnectDB.mockResolvedValue(undefined);
    mockGetLiveTierExpectancy.mockResolvedValue([
      { tier: 'buy', count: 40, expectancyPercent: -0.05, winRate: 0.48, avgMfePercent: 1, avgMaePercent: -1 },
    ]);
    mockSnapshotFindOne.mockReturnValue(chain({ data: { fundingRate: { rate: 0.0001 } } }));
    mockLedgerFindOne.mockReturnValue(plain(null));
  });

  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(makeRequest(VALID));
    expect(res.status).toBe(401);
  });

  it('rejects a symbol outside the signal set, a bad style, and an interval the style does not score', async () => {
    const { GET } = await import('./route');
    expect((await GET(makeRequest({ ...VALID, symbol: 'PEPEUSDT' }))).status).toBe(400);
    expect((await GET(makeRequest({ ...VALID, tradingStyle: 'hodl' }))).status).toBe(400);
    expect((await GET(makeRequest({ ...VALID, interval: '5m' }))).status).toBe(400);
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('returns a reason instead of a plan when no signal exists yet', async () => {
    mockSignalFindOne.mockReturnValue(chain(null));
    const { GET } = await import('./route');
    const res = await GET(makeRequest(VALID));
    const body = (await res.json()) as TradePlanResponse;
    expect(res.status).toBe(200);
    expect(body.plan).toBeNull();
    expect(body.unavailableReason).toContain('No 1h signal');
  });

  it('builds the plan from the latest signal, candles up to its bar, and the latest funding rate', async () => {
    const candles = bars(1001);
    const last = candles[candles.length - 1];
    mockSignalFindOne.mockReturnValue(
      chain({
        score: 35,
        tier: 'buy',
        candleTimestamp: last.timestamp,
        configVersion: 7,
        createdAt: new Date(last.timestamp + HOUR + 20_000),
      })
    );
    mockGetCandles.mockResolvedValue(candles);

    const { GET } = await import('./route');
    const res = await GET(makeRequest(VALID));
    const body = (await res.json()) as TradePlanResponse;

    expect(res.status).toBe(200);
    expect(mockSignalFindOne).toHaveBeenCalledWith({ symbol: 'SOLUSDT', tradingStyle: 'day_trading', interval: '1h' });
    // Candles end at the scored bar: nothing after it is fetched.
    expect(mockGetCandles).toHaveBeenCalledWith('SOLUSDT', '1h', undefined, last.timestamp, 1001);
    // Funding comes from the snapshot interval the engine maps 1h to.
    expect(mockSnapshotFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'SOLUSDT', interval: '1h' })
    );

    expect(body.unavailableReason).toBeNull();
    expect(body.plan?.entry).toMatchObject({ side: 'long', stopPrice: 96, targetPrice: 108 });
    expect(body.plan?.entry?.costs.fundingRate).toBe(0.0001);
  });

  it('reads the live record for the signal\'s own configVersion at the interval\'s cost', async () => {
    const candles = bars(50);
    mockSignalFindOne.mockReturnValue(
      chain({
        score: 10,
        tier: 'neutral',
        candleTimestamp: candles[49].timestamp,
        configVersion: 7,
        createdAt: new Date(),
      })
    );
    mockGetCandles.mockResolvedValue(candles);

    const { GET } = await import('./route');
    const body = (await (await GET(makeRequest(VALID))).json()) as TradePlanResponse;

    expect(mockGetLiveTierExpectancy).toHaveBeenCalledWith({
      tradingStyle: 'day_trading',
      interval: '1h',
      configVersion: 7,
      costPercentRoundTrip: 0.16,
    });
    expect(body.liveRecord).toEqual({
      configVersion: 7,
      horizonBars: 24,
      costPercentRoundTrip: 0.16,
      tiers: [{ tier: 'buy', count: 40, expectancyPercent: -0.05, winRate: 0.48 }],
    });
    expect(body.plan?.entry).toBeNull();
  });

  it('maps 5m funding to the 1h snapshot rows and tolerates a missing rate', async () => {
    const candles = bars(20).map((b, i) => ({ ...b, timestamp: i * 300_000 }));
    mockSignalFindOne.mockReturnValue(
      chain({ score: 35, tier: 'buy', candleTimestamp: candles[19].timestamp, configVersion: 7, createdAt: new Date() })
    );
    mockGetCandles.mockResolvedValue(candles);
    mockSnapshotFindOne.mockReturnValue(chain(null));

    const { GET } = await import('./route');
    const body = (await (
      await GET(makeRequest({ symbol: 'SOLUSDT', tradingStyle: 'scalping', interval: '5m' }))
    ).json()) as TradePlanResponse;

    expect(mockSnapshotFindOne).toHaveBeenCalledWith(expect.objectContaining({ interval: '1h' }));
    expect(body.plan?.entry?.costs.fundingRate).toBeNull();
    expect(body.plan?.entry?.costs.fundingPercent).toBeNull();
  });

  it('projects the paper desk position when the desk holds one', async () => {
    const candles = bars(1001);
    const last = candles[candles.length - 1];
    mockSignalFindOne.mockReturnValue(
      chain({ score: 35, tier: 'buy', candleTimestamp: last.timestamp, configVersion: 7, createdAt: new Date() })
    );
    mockGetCandles.mockResolvedValue(candles);
    mockLedgerFindOne.mockReturnValue(
      plain({
        position: {
          side: 'long',
          entryPrice: 98,
          entryTime: last.timestamp - HOUR,
          quantity: 1.5,
          stopPrice: 96,
          targetPrice: 108,
          entryScore: 31,
        },
      })
    );

    const { GET } = await import('./route');
    const body = (await (await GET(makeRequest(VALID))).json()) as TradePlanResponse;

    expect(mockLedgerFindOne).toHaveBeenCalledWith({
      tradingStyle: 'day_trading',
      interval: '1h',
      symbol: 'SOLUSDT',
    });
    expect(body.deskPosition).toMatchObject({ side: 'long', entryPrice: 98, quantity: 1.5 });
    // A long entered at 98 with the bar closing at 100 is about 2% up.
    expect(body.deskPosition?.unrealisedPercent).toBeCloseTo((2 / 98) * 100, 10);
    // A score of 35 is nowhere near the 7.25 exit level.
    expect(body.deskPosition?.exitsNow).toBe(false);
  });

  it('marks the desk position as exiting once the score crosses back', async () => {
    const candles = bars(1001);
    const last = candles[candles.length - 1];
    mockSignalFindOne.mockReturnValue(
      chain({ score: 3, tier: 'neutral', candleTimestamp: last.timestamp, configVersion: 7, createdAt: new Date() })
    );
    mockGetCandles.mockResolvedValue(candles);
    mockLedgerFindOne.mockReturnValue(
      plain({
        position: {
          side: 'long',
          entryPrice: 100,
          entryTime: last.timestamp - HOUR,
          quantity: 1,
          stopPrice: 96,
          targetPrice: 108,
          entryScore: 31,
        },
      })
    );

    const { GET } = await import('./route');
    const body = (await (await GET(makeRequest(VALID))).json()) as TradePlanResponse;
    expect(body.deskPosition?.exitsNow).toBe(true);
  });

  it('reports no desk position when the desk is flat', async () => {
    const candles = bars(1001);
    mockSignalFindOne.mockReturnValue(
      chain({
        score: 35,
        tier: 'buy',
        candleTimestamp: candles[1000].timestamp,
        configVersion: 7,
        createdAt: new Date(),
      })
    );
    mockGetCandles.mockResolvedValue(candles);
    mockLedgerFindOne.mockReturnValue(plain({ position: null }));

    const { GET } = await import('./route');
    const body = (await (await GET(makeRequest(VALID))).json()) as TradePlanResponse;
    expect(body.deskPosition).toBeNull();
  });

  it('returns the reason when the scored bar is missing from the candle store', async () => {
    mockSignalFindOne.mockReturnValue(
      chain({ score: 35, tier: 'buy', candleTimestamp: 999 * HOUR, configVersion: 7, createdAt: new Date() })
    );
    mockGetCandles.mockResolvedValue(bars(10));

    const { GET } = await import('./route');
    const body = (await (await GET(makeRequest(VALID))).json()) as TradePlanResponse;
    expect(body.plan).toBeNull();
    expect(body.unavailableReason).toContain('is not in the candle history');
    expect(body.liveRecord).not.toBeNull();
  });
});
