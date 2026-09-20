import { describe, it, expect } from 'vitest';
import { buildInputsPacket, type PacketDeps } from './packet';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const T0 = 1789689600000; // a 1h bar open, and a day boundary

function candle(timestamp: number, close: number) {
  return { timestamp, open: close - 1, high: close + 2, low: close - 2, close, volume: 10 };
}

function deps(overrides: Partial<PacketDeps> = {}): PacketDeps {
  return {
    getCandles: async () => [candle(T0 - 2 * HOUR, 100), candle(T0 - HOUR, 101), candle(T0, 102), candle(T0 + HOUR, 103)],
    findLatestSignal: async () => ({
      score: 12.5, tier: 'neutral', confidence: 90, candleTimestamp: T0,
      components: [{ category: 'trend', score: 30, weight: 0.2, signals: [{ name: 'RSI', direction: 'neutral', strength: 10, description: 'RSI neutral at 51.2' }] }],
    }),
    findLatestSnapshot: async () => ({ timestamp: T0 + HOUR, data: { fundingRate: { rate: 0.0001 }, fearGreed: { index: 55, label: 'Greed' } } }),
    fetchNews: async () => [
      { title: 'Old news', source: 'a', url: 'https://a', publishedOn: (T0 + HOUR - 60000) / 1000 },
      { title: 'Future news', source: 'b', url: 'https://b', publishedOn: (T0 + HOUR + 60000) / 1000 },
    ],
    ...overrides,
  };
}

describe('buildInputsPacket', () => {
  it('uses the last closed bar, drops the open bar, and keeps only news published by the bar close', async () => {
    const now = T0 + HOUR + 30 * 60000; // the T0 + HOUR bar is still open
    const packet = await buildInputsPacket(deps(), 'BTCUSDT', '1h', now);
    expect(packet).not.toBeNull();
    expect(packet!.lastClosedBar.timestamp).toBe(T0);
    expect(packet!.lastClosedBar.closeTime).toBe(T0 + HOUR);
    expect(packet!.closes).toEqual([100, 101, 102]);
    expect(packet!.news.map((n) => n.title)).toEqual(['Old news']);
    expect(packet!.tradingStyle).toBe('day_trading');
    expect(packet!.signal?.tier).toBe('neutral');
    expect(packet!.snapshot?.fearGreed?.index).toBe(55);
    expect(packet!.inputsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the same inputs to the same value and different inputs to a different one', async () => {
    const now = T0 + HOUR + 30 * 60000;
    const a = await buildInputsPacket(deps(), 'BTCUSDT', '1h', now);
    const b = await buildInputsPacket(deps(), 'BTCUSDT', '1h', now + 1000);
    const c = await buildInputsPacket(deps({ fetchNews: async () => [] }), 'BTCUSDT', '1h', now);
    expect(a!.inputsHash).toBe(b!.inputsHash);
    expect(a!.inputsHash).not.toBe(c!.inputsHash);
  });

  it('returns null with no closed candle and tolerates missing signal, snapshot, and news', async () => {
    expect(await buildInputsPacket(deps({ getCandles: async () => [] }), 'BTCUSDT', '1h', T0)).toBeNull();
    const packet = await buildInputsPacket(
      deps({ findLatestSignal: async () => null, findLatestSnapshot: async () => null, fetchNews: async () => { throw new Error('feed down'); } }),
      'BTCUSDT', '1h', T0 + HOUR + 60000
    );
    expect(packet!.signal).toBeNull();
    expect(packet!.snapshot).toBeNull();
    expect(packet!.news).toEqual([]);
  });

  it('keeps a snapshot exactly two intervals old and nulls one older', async () => {
    const now = T0 + HOUR + 30 * 60000; // last closed bar is T0, closeTime T0 + HOUR
    const atBound = await buildInputsPacket(
      deps({ findLatestSnapshot: async () => ({ timestamp: T0 - HOUR, data: { fearGreed: { index: 40, label: 'Fear' } } }) }),
      'BTCUSDT', '1h', now
    );
    expect(atBound!.snapshot).not.toBeNull();
    expect(atBound!.snapshot?.fearGreed?.index).toBe(40);

    const pastBound = await buildInputsPacket(
      deps({ findLatestSnapshot: async () => ({ timestamp: T0 - HOUR - 60000, data: { fearGreed: { index: 40, label: 'Fear' } } }) }),
      'BTCUSDT', '1h', now
    );
    expect(pastBound!.snapshot).toBeNull();
  });

  it('drops dateless news items and caps the survivors at the packet limit', async () => {
    const now = T0 + HOUR + 30 * 60000; // last closed bar T0, closeTime T0 + HOUR
    const closeTime = T0 + HOUR;
    const items = [
      { title: 'dateless', source: 'x', url: 'https://x/dateless', publishedOn: 0 },
      { title: 'future', source: 'x', url: 'https://x/future', publishedOn: (closeTime + 60000) / 1000 },
      ...Array.from({ length: 28 }, (_, i) => ({
        title: `item-${i}`,
        source: 'x',
        url: `https://x/${i}`,
        publishedOn: (closeTime - (i + 1) * 60000) / 1000,
      })),
    ];

    const packet = await buildInputsPacket(deps({ fetchNews: async () => items }), 'BTCUSDT', '1h', now);

    expect(packet!.news).toHaveLength(10);
    expect(packet!.news.some((n) => n.title === 'dateless')).toBe(false);
    expect(packet!.news.some((n) => n.title === 'future')).toBe(false);
    expect(packet!.news.map((n) => n.title)).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4', 'item-5', 'item-6', 'item-7', 'item-8', 'item-9']);
  });

  it('drops news published before the lookback floor and keeps one exactly on it', async () => {
    const now = T0 + HOUR + 30 * 60000; // last closed bar T0, closeTime T0 + HOUR
    const closeTime = T0 + HOUR;
    const floor = closeTime - 3 * DAY; // 1h horizon is 24 bars, so the three-day floor applies

    const onFloor = await buildInputsPacket(
      deps({ fetchNews: async () => [{ title: 'on floor', source: 'x', url: 'https://x/on', publishedOn: floor / 1000 }] }),
      'BTCUSDT', '1h', now
    );
    expect(onFloor!.news.map((n) => n.title)).toEqual(['on floor']);

    const belowFloor = await buildInputsPacket(
      deps({ fetchNews: async () => [{ title: 'below floor', source: 'x', url: 'https://x/below', publishedOn: (floor - 60000) / 1000 }] }),
      'BTCUSDT', '1h', now
    );
    expect(belowFloor!.news).toEqual([]);
  });

  it('widens the news window with the interval horizon, so 1d keeps what 1h drops', async () => {
    const tenDaysBefore = (closeTime: number) => (closeTime - 10 * DAY) / 1000;
    const stale = (closeTime: number) => [
      { title: 'ten days old', source: 'x', url: 'https://x/ten', publishedOn: tenDaysBefore(closeTime) },
    ];

    const hourly = await buildInputsPacket(
      deps({ fetchNews: async () => stale(T0 + HOUR) }),
      'BTCUSDT', '1h', T0 + HOUR + 30 * 60000
    );
    expect(hourly!.news).toEqual([]);

    // 1d is position_trading, a 20 bar horizon, so ten days is well inside it.
    const daily = await buildInputsPacket(
      deps({
        getCandles: async () => [candle(T0 - DAY, 100), candle(T0, 102), candle(T0 + DAY, 103)],
        findLatestSignal: async () => null,
        findLatestSnapshot: async () => null,
        fetchNews: async () => stale(T0 + DAY),
      }),
      'BTCUSDT', '1d', T0 + DAY + 6 * HOUR
    );
    expect(daily!.lastClosedBar.closeTime).toBe(T0 + DAY);
    expect(daily!.news.map((n) => n.title)).toEqual(['ten days old']);
  });

  it('keeps the newest survivors when the feed arrives out of order', async () => {
    const now = T0 + HOUR + 30 * 60000;
    const closeTime = T0 + HOUR;
    const ages = [40, 5, 90, 1, 60];
    const items = ages.map((minutes) => ({
      title: `age-${minutes}`,
      source: 'x',
      url: `https://x/${minutes}`,
      publishedOn: (closeTime - minutes * 60000) / 1000,
    }));

    const packet = await buildInputsPacket(deps({ fetchNews: async () => items }), 'BTCUSDT', '1h', now);

    expect(packet!.news.map((n) => n.title)).toEqual(['age-1', 'age-5', 'age-40', 'age-60', 'age-90']);
  });

  it('keeps a signal exactly two intervals old and nulls one older', async () => {
    const now = T0 + HOUR + 30 * 60000; // last closed bar is T0

    const atBound = await buildInputsPacket(
      deps({ findLatestSignal: async () => ({ score: 1, tier: 'neutral', confidence: 90, candleTimestamp: T0 - 2 * HOUR, components: [] }) }),
      'BTCUSDT', '1h', now
    );
    expect(atBound!.signal).not.toBeNull();

    const pastBound = await buildInputsPacket(
      deps({ findLatestSignal: async () => ({ score: 1, tier: 'neutral', confidence: 90, candleTimestamp: T0 - 2 * HOUR - 60000, components: [] }) }),
      'BTCUSDT', '1h', now
    );
    expect(pastBound!.signal).toBeNull();
  });
});
