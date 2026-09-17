import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchFundingRate = vi.hoisted(() => vi.fn());
const mockFetchLongShortRatio = vi.hoisted(() => vi.fn());
const mockFetchOpenInterestHistory = vi.hoisted(() => vi.fn());
const mockBulkWrite = vi.hoisted(() => vi.fn());
const mockFetchFearAndGreedHistory = vi.hoisted(() => vi.fn());

vi.mock('@/lib/binance-futures', () => ({
  fetchFundingRate: (...args: unknown[]) => mockFetchFundingRate(...args),
  fetchLongShortRatio: (...args: unknown[]) => mockFetchLongShortRatio(...args),
  fetchOpenInterestHistory: (...args: unknown[]) => mockFetchOpenInterestHistory(...args),
}));
vi.mock('@/lib/models/historical-snapshot', () => ({
  HistoricalSnapshot: { bulkWrite: (...args: unknown[]) => mockBulkWrite(...args) },
}));
vi.mock('@/lib/external/fear-greed', () => ({
  fetchFearAndGreedHistory: (...args: unknown[]) => mockFetchFearAndGreedHistory(...args),
}));

import {
  buildBackfillSnapshots,
  fetchFundingHistory,
  backfillSnapshotRange,
  loadFearGreedLookup,
  MAX_FEAR_GREED_CARRY_DAYS,
  FUNDING_INTERVAL_MS,
} from './snapshot-backfill';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1); // aligned to every interval

function build(overrides: Partial<Parameters<typeof buildBackfillSnapshots>[0]> = {}) {
  return buildBackfillSnapshots({
    symbol: 'BTCUSDT',
    interval: '1h',
    startTime: T0,
    endTime: T0 + 10 * HOUR,
    fundingEvents: [],
    longShortRatios: [],
    openInterest: [],
    fearGreedAt: () => null,
    ...overrides,
  });
}

describe('buildBackfillSnapshots', () => {
  it('writes every bar in the window, not only bars with futures history', () => {
    // Regression: timestamps came from the long/short response, capped at 500 bars.
    const { snapshots } = build({ interval: '4h', startTime: T0, endTime: T0 + 730 * DAY });

    expect(snapshots).toHaveLength(730 * 6 + 1);
    expect(snapshots[1].timestamp - snapshots[0].timestamp).toBe(4 * HOUR);
  });

  it('aligns bars the way live ingestion does', () => {
    const { snapshots } = build({ startTime: T0 + 20 * 60_000, endTime: T0 + 3 * HOUR + 5 * 60_000 });

    // The partial first hour is skipped; the bar containing endTime is included.
    expect(snapshots.map((s) => s.timestamp)).toEqual([T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]);
  });

  it('attaches Fear & Greed to every bar where a reading exists', () => {
    const { snapshots, coverage } = build({ fearGreedAt: (ts) => (ts >= T0 + 5 * HOUR ? { index: 30, label: 'Fear' } : null) });

    expect(snapshots[4].data.fearGreed).toBeUndefined();
    expect(snapshots[5].data.fearGreed).toEqual({ index: 30, label: 'Fear' });
    expect(coverage.fearGreed).toBe(6);
  });

  it('carries funding forward within one settlement plus one bar, and no further', () => {
    const { snapshots } = build({
      endTime: T0 + 12 * HOUR,
      fundingEvents: [{ symbol: 'BTCUSDT', fundingTime: T0, fundingRate: 0.0001, markPrice: 80_000 }],
    });

    const staleness = FUNDING_INTERVAL_MS + HOUR;
    for (const s of snapshots) {
      if (s.timestamp - T0 <= staleness) expect(s.data.fundingRate).toEqual({ rate: 0.0001, markPrice: 80_000 });
      else expect(s.data.fundingRate).toBeUndefined();
    }
  });

  it('omits markPrice from funding events that predate it, keeping the rate', () => {
    // Regression: Binance returns markPrice "" before mid-2023; NaN failed the
    // schema cast and every 48-month 1d backfill wrote nothing.
    const { snapshots, coverage } = build({
      fundingEvents: [{ symbol: 'BTCUSDT', fundingTime: T0, fundingRate: 0.0001, markPrice: Number.NaN }],
    });

    expect(snapshots[0].data.fundingRate).toEqual({ rate: 0.0001 });
    expect(coverage.fundingRate).toBeGreaterThan(0);
  });

  it('never uses a funding event from after the bar', () => {
    const { snapshots } = build({
      fundingEvents: [{ symbol: 'BTCUSDT', fundingTime: T0 + 5 * HOUR, fundingRate: 0.0002, markPrice: 80_000 }],
    });

    expect(snapshots[4].data.fundingRate).toBeUndefined();
    expect(snapshots[5].data.fundingRate).toEqual({ rate: 0.0002, markPrice: 80_000 });
  });

  it('adds long/short and open interest only on bars Binance returned', () => {
    const { snapshots, coverage } = build({
      longShortRatios: [{ symbol: 'BTCUSDT', timestamp: T0 + 9 * HOUR, longShortRatio: 1.3, longAccount: 0.57, shortAccount: 0.43 }],
      openInterest: [{ symbol: 'BTCUSDT', timestamp: T0 + 9 * HOUR, sumOpenInterest: 100, sumOpenInterestValue: 8_000_000 }],
    });

    expect(snapshots[9].data.longShortRatio).toEqual({ ratio: 1.3, longAccount: 0.57, shortAccount: 0.43 });
    expect(snapshots[9].data.openInterest).toEqual({ value: 100, sumValue: 8_000_000 });
    expect(snapshots[8].data.longShortRatio).toBeUndefined();
    expect(coverage.longShortRatio).toBe(1);
    expect(coverage.openInterest).toBe(1);
  });

  it('leaves fields out entirely when there is nothing to write, so merges keep live data', () => {
    const { snapshots } = build();

    for (const s of snapshots) {
      expect(Object.keys(s.data)).toHaveLength(0);
    }
  });
});

describe('fetchFundingHistory', () => {
  beforeEach(() => {
    mockFetchFundingRate.mockReset();
  });

  function page(from: number, count: number) {
    return Array.from({ length: count }, (_, i) => ({
      symbol: 'BTCUSDT',
      fundingTime: from + i * FUNDING_INTERVAL_MS,
      fundingRate: 0.0001,
      markPrice: 80_000,
    }));
  }

  it('pages forward until a short page, covering years rather than one call', async () => {
    // Regression: a single 1,000-event call covered about 333 days.
    const start = T0;
    const end = T0 + 4 * 365 * DAY;
    mockFetchFundingRate
      .mockResolvedValueOnce(page(start, 1000))
      .mockResolvedValueOnce(page(start + 1000 * FUNDING_INTERVAL_MS, 1000))
      .mockResolvedValueOnce(page(start + 2000 * FUNDING_INTERVAL_MS, 1000))
      .mockResolvedValueOnce(page(start + 3000 * FUNDING_INTERVAL_MS, 1000))
      .mockResolvedValueOnce(page(start + 4000 * FUNDING_INTERVAL_MS, 380));

    const events = await fetchFundingHistory('BTCUSDT', start, end);

    expect(mockFetchFundingRate).toHaveBeenCalledTimes(5);
    expect(events).toHaveLength(4380);
    expect(mockFetchFundingRate.mock.calls[1][2]).toBe(start + 999 * FUNDING_INTERVAL_MS + 1);
    expect(mockFetchFundingRate.mock.calls[0]).toEqual(['BTCUSDT', 1000, start, end]);
  });

  it('returns events oldest first without duplicates', async () => {
    const events = page(T0, 3);
    mockFetchFundingRate.mockResolvedValueOnce([events[2], events[0], events[1], events[0]]);

    const result = await fetchFundingHistory('BTCUSDT', T0, T0 + DAY);

    expect(result.map((e) => e.fundingTime)).toEqual(events.map((e) => e.fundingTime));
  });

  it('stops rather than looping when the cursor cannot advance', async () => {
    const stuck = page(T0, 1000).map((e) => ({ ...e, fundingTime: T0 }));
    mockFetchFundingRate.mockResolvedValue(stuck);

    await fetchFundingHistory('BTCUSDT', T0 + 1, T0 + DAY);

    expect(mockFetchFundingRate).toHaveBeenCalledTimes(1);
  });

  it('propagates a fetch failure so the caller can decide', async () => {
    mockFetchFundingRate.mockRejectedValue(new Error('HTTP 418'));

    await expect(fetchFundingHistory('BTCUSDT', T0, T0 + DAY)).rejects.toThrow('HTTP 418');
  });
});

describe('backfillSnapshotRange', () => {
  beforeEach(() => {
    mockFetchLongShortRatio.mockReset().mockResolvedValue([]);
    mockFetchOpenInterestHistory.mockReset().mockResolvedValue([]);
    mockBulkWrite.mockReset().mockResolvedValue(undefined);
  });

  function run(overrides: Partial<Parameters<typeof backfillSnapshotRange>[0]> = {}) {
    return backfillSnapshotRange({
      symbol: 'BTCUSDT',
      interval: '1h',
      startTime: T0,
      endTime: T0 + 10 * HOUR,
      fundingEvents: [],
      fearGreedAt: () => null,
      ...overrides,
    });
  }

  it('requests recent long/short and open interest history for the pair', async () => {
    await run({ symbol: 'ETHUSDT', interval: '4h' });

    expect(mockFetchLongShortRatio).toHaveBeenCalledWith('ETHUSDT', '4h', 500);
    expect(mockFetchOpenInterestHistory).toHaveBeenCalledWith('ETHUSDT', '4h', 500);
  });

  it('builds and upserts a snapshot for every bar, returning the count and coverage', async () => {
    const result = await run();

    expect(result.snapshots).toBe(11);
    expect(mockBulkWrite).toHaveBeenCalledTimes(1);
    expect((mockBulkWrite.mock.calls[0][0] as unknown[])).toHaveLength(11);
    expect(result.coverage).toEqual({ fundingRate: 0, longShortRatio: 0, openInterest: 0, fearGreed: 0 });
  });

  it('still builds snapshots when long/short and open interest both fail', async () => {
    mockFetchLongShortRatio.mockRejectedValue(new Error('HTTP 418'));
    mockFetchOpenInterestHistory.mockRejectedValue(new Error('HTTP 418'));

    const result = await run();

    expect(result.snapshots).toBe(11);
    expect(result.coverage.longShortRatio).toBe(0);
    expect(result.coverage.openInterest).toBe(0);
  });

  it('splits large windows into upsert chunks of 5000', async () => {
    // 6,000 hourly bars needs two chunks.
    const result = await run({ startTime: T0, endTime: T0 + 5_999 * HOUR });

    expect(result.snapshots).toBe(6000);
    expect(mockBulkWrite).toHaveBeenCalledTimes(2);
    for (const call of mockBulkWrite.mock.calls) {
      expect((call[0] as unknown[]).length).toBeLessThanOrEqual(5000);
    }
  });

  it('attaches funding, long/short, open interest, and Fear & Greed onto the built bars', async () => {
    mockFetchLongShortRatio.mockResolvedValue([
      { symbol: 'BTCUSDT', timestamp: T0, longShortRatio: 1.2, longAccount: 0.55, shortAccount: 0.45 },
    ]);
    mockFetchOpenInterestHistory.mockResolvedValue([
      { symbol: 'BTCUSDT', timestamp: T0, sumOpenInterest: 10, sumOpenInterestValue: 900_000 },
    ]);

    const result = await run({
      fundingEvents: [{ symbol: 'BTCUSDT', fundingTime: T0, fundingRate: 0.0001, markPrice: 80_000 }],
      fearGreedAt: () => ({ index: 40, label: 'Fear' }),
    });

    // Funding staleness is FUNDING_INTERVAL_MS (8h) + the 1h bar interval, so
    // the bar at T0 + 10h falls just outside it and gets no funding.
    expect(result.coverage).toEqual({ fundingRate: 10, longShortRatio: 1, openInterest: 1, fearGreed: 11 });
  });
});

describe('loadFearGreedLookup', () => {
  beforeEach(() => {
    mockFetchFearAndGreedHistory.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('requests the given number of days', async () => {
    mockFetchFearAndGreedHistory.mockResolvedValue([]);

    await loadFearGreedLookup(63);

    expect(mockFetchFearAndGreedHistory).toHaveBeenCalledWith(63);
  });

  it('resolves a timestamp to the reading recorded for its UTC day', async () => {
    mockFetchFearAndGreedHistory.mockResolvedValue([
      { timestamp: T0, fearGreedIndex: 55, label: 'Greed' },
    ]);

    const lookup = await loadFearGreedLookup(3);

    expect(lookup(T0 + 5 * HOUR)).toEqual({ index: 55, label: 'Greed' });
  });

  it(`carries a reading forward up to ${MAX_FEAR_GREED_CARRY_DAYS} days over a gap`, async () => {
    mockFetchFearAndGreedHistory.mockResolvedValue([
      { timestamp: T0, fearGreedIndex: 55, label: 'Greed' },
    ]);

    const lookup = await loadFearGreedLookup(6);

    expect(lookup(T0 + MAX_FEAR_GREED_CARRY_DAYS * DAY)).toEqual({ index: 55, label: 'Greed' });
    expect(lookup(T0 + (MAX_FEAR_GREED_CARRY_DAYS + 1) * DAY)).toBeNull();
  });

  it('returns a lookup that always answers null when the fetch fails, without throwing', async () => {
    mockFetchFearAndGreedHistory.mockRejectedValue(new Error('API down'));

    const lookup = await loadFearGreedLookup(6);

    expect(lookup(T0)).toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
