// scripts/research/direction-exit-rows.test.ts
import { describe, expect, it } from 'vitest';
import { buildDxRows, CATEGORIES, pathAt, type PathInput } from './direction-exit-rows';

const HOUR = 3_600_000;
function path(closes: number[], gapAt?: number): PathInput {
  const t = closes.map((_, i) => (gapAt !== undefined && i >= gapAt ? i + 1 : i) * HOUR);
  return { t, o: closes.map((c) => c - 0.5), h: closes.map((c) => c + 1), l: closes.map((c) => c - 1), c: closes };
}

describe('pathAt', () => {
  it('measures the extremes after the signal bar, from its close and from the next open', () => {
    const p = path([100, 101, 104, 99, 102]);
    const r = pathAt(p, 0, 3, HOUR)!;
    expect(r.up).toBeCloseTo(5); // high 105 over close 100
    expect(r.down).toBeCloseTo(-2); // low 98 over close 100
    expect(r.fwd1).toBeCloseTo(((99 - 100.5) / 100.5) * 100); // close[3] over open[1]
    expect(r.up1).toBeCloseTo(((105 - 100.5) / 100.5) * 100);
  });

  it('returns null when the horizon runs past the data or spans a gap', () => {
    expect(pathAt(path([1, 2, 3]), 1, 3, HOUR)).toBeNull();
    expect(pathAt(path([100, 101, 102, 103, 104], 2), 0, 3, HOUR)).toBeNull();
  });
});

describe('buildDxRows', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  const p = path(closes);
  const names = ['composite', ...CATEGORIES.map((c) => `cat.${c}`), 'raw.realizedVol20'];
  const values = names.map((name) => Float64Array.from(closes, (_, i) => (name === 'composite' ? (i % 3 === 0 ? 30 : 5) : name === 'cat.sentiment' ? NaN : i)));
  const atr14 = Float64Array.from(closes, () => 2);
  const window = { start: new Date(0).toISOString(), end: new Date(30 * HOUR).toISOString() };

  it('emits every scored bar with its tier, categories, volatility, hour, ATR and outcome', () => {
    const { rows } = buildDxRows({ symbol: 'BTCUSDT', interval: '1h', style: 'day_trading', horizonBars: 4, path: p, names, values, atr14, window });
    expect(rows[0]).toMatchObject({ t: 0, score: 30, tier: 'buy', hourUtc: 0, vol20: 0 });
    expect(rows[0].cats.sentiment).toBeNull();
    expect(rows[0].cats.trend).toBe(0);
    expect(rows[0].atrPct).toBeCloseTo(2);
    expect(rows[0].fwd).toBeCloseTo(4);
    expect(rows[1].tier).toBe('neutral');
  });

  it('drops bars without an outcome and counts them', () => {
    const { rows, dropped } = buildDxRows({ symbol: 'BTCUSDT', interval: '1h', style: 'day_trading', horizonBars: 4, path: p, names, values, atr14, window: { start: window.start, end: new Date(39 * HOUR).toISOString() } });
    expect(rows.at(-1)!.t).toBe(35 * HOUR);
    expect(dropped).toBe(4);
  });

  it('carries no return in scores-only mode', () => {
    const { rows } = buildDxRows({ symbol: 'BTCUSDT', interval: '1h', style: 'day_trading', horizonBars: 4, path: p, names, values, atr14, window, scoresOnly: true });
    expect(Number.isNaN(rows[0].fwd)).toBe(true);
    expect(Number.isNaN(rows[0].up)).toBe(true);
  });
});
