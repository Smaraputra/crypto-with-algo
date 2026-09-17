// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { computeSignalScore } from '@/lib/signals/scorer';
import { DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { prepareBacktest } from '@/lib/backtest/optimized-engine';
import {
  alignHtfToLtf,
  computeHtfSeries,
  htfContextAtBar,
} from '@/lib/signals/htf';
import { intervalToMs } from '@/lib/intervals';
import type { OHLCV } from '@/types/market';
import type { CandleRow, HtfRow, SnapshotRow } from './dataset-format';
import { computeFactorMatrix } from './factors';

// Deterministic random walk, same LCG pattern as src/lib/backtest/engine-parity.test.ts
function generateCandles(count: number, seed = 4242): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    const drift = i < count / 2 ? 0.0015 : -0.0015;
    const noise = (nextRandom() - 0.5) * 0.5;
    price = price * (1 + drift + noise / 100);
    const high = price * (1 + nextRandom() * 0.005);
    const low = price * (1 - nextRandom() * 0.005);
    const open = price * (1 + (nextRandom() - 0.5) * 0.003);
    const volume = 1000 + nextRandom() * 5000;

    candles.push({
      timestamp: 1700000000000 + i * 3600000,
      open,
      high,
      low,
      close: price,
      volume,
      takerBuyVolume: volume * (0.3 + nextRandom() * 0.4),
    });
  }

  return candles;
}

function toCandleRow(candle: OHLCV): CandleRow {
  return {
    t: candle.timestamp,
    o: candle.open,
    h: candle.high,
    l: candle.low,
    c: candle.close,
    v: candle.volume,
    tbv: candle.takerBuyVolume ?? null,
  };
}

/** Sparse synthetic snapshots: every 4th bar, mirroring engine-parity.test.ts's pattern. */
function buildSnapshotRows(candles: OHLCV[]): SnapshotRow[] {
  return candles
    .filter((_, i) => i % 4 === 0)
    .map((c, i) => ({
      t: c.timestamp,
      fundingRate: { rate: -0.001 + (i % 5) * 0.0004, markPrice: c.close },
      longShortRatio: { ratio: 1.2 + (i % 3) * 0.5, longAccount: 0.55, shortAccount: 0.45 },
      openInterest: null,
      fearGreed: { index: (i * 7) % 100, label: 'Varies' },
      newsSentiment:
        i % 6 === 0
          ? { count: 5, avgSentiment: 0.4, topics: ['btc'] }
          : null,
    }));
}

/** Real causal HTF rows, replicating export-dataset.ts's buildHtfRows (not exported) for a test fixture. */
function buildHtfRows(ltfCandles: OHLCV[], ltfInterval: string, htfCandles: OHLCV[], htfInterval: string): HtfRow[] {
  const series = computeHtfSeries(htfCandles);
  const map = alignHtfToLtf(ltfCandles, intervalToMs(ltfInterval), htfCandles, intervalToMs(htfInterval));

  return ltfCandles.map((candle, i) => {
    const htfBar = map[i];
    const context = htfBar === -1 ? null : htfContextAtBar(series, htfBar, htfInterval);
    return { t: candle.timestamp, context };
  });
}

const INTERVAL = '1h';
const STYLE = 'day_trading' as const;

function buildFixture(count = 600) {
  const candles = generateCandles(count);
  const htfCandles = generateCandles(320, 9001).map((c, i) => ({
    ...c,
    timestamp: candles[0].timestamp - 220 * 4 * 3600000 + i * 4 * 3600000,
  }));

  return {
    candleRows: candles.map(toCandleRow),
    snapshotRows: buildSnapshotRows(candles),
    htfRows: buildHtfRows(candles, INTERVAL, htfCandles, '4h'),
    candles,
    htfCandles,
  };
}

describe('computeFactorMatrix', () => {
  const { candleRows, snapshotRows, htfRows } = buildFixture();
  const matrix = computeFactorMatrix({
    candles: candleRows,
    snapshots: snapshotRows,
    htf: htfRows,
    interval: INTERVAL,
  });

  it('names and categories stay parallel and cover every expected factor', () => {
    expect(matrix.categories).toHaveLength(matrix.names.length);
    expect(matrix.values).toHaveLength(matrix.names.length);

    const categoryOf = new Map(matrix.names.map((name, i) => [name, matrix.categories[i]]));

    expect(categoryOf.get('composite')).toBe('composite');
    for (const cat of ['trend', 'momentum', 'volume', 'volatility', 'futures', 'sentiment', 'htf']) {
      expect(categoryOf.get(`cat.${cat}`)).toBe(cat);
    }

    // Signals that must fire for a synthetic series with this style/data
    expect(categoryOf.get('sig.EMA Cross')).toBe('trend');
    expect(categoryOf.get('sig.SMA Trend')).toBe('trend');
    expect(categoryOf.get('sig.RSI')).toBe('momentum');
    expect(categoryOf.get('sig.MACD')).toBe('momentum');
    expect(categoryOf.get('sig.OBV')).toBe('volume');
    expect(categoryOf.get('sig.Bollinger')).toBe('volatility');
    expect(categoryOf.get('sig.ATR')).toBe('volatility');
    expect(categoryOf.get('sig.SuperTrend')).toBe('trend');
    // Futures/sentiment fire on the bars where the sparse synthetic snapshot lands
    expect(categoryOf.get('sig.Funding Rate')).toBe('futures');
    expect(categoryOf.get('sig.Long/Short Ratio')).toBe('futures');
    expect(categoryOf.get('sig.Fear & Greed')).toBe('sentiment');
    // HTF confluence for the 4h confirmation timeframe
    expect(categoryOf.get('sig.HTF EMA Cross')).toBe('htf');
    expect(categoryOf.get('sig.HTF SMA Trend')).toBe('htf');
    expect(categoryOf.get('sig.HTF SuperTrend')).toBe('htf');

    for (const rawName of [
      'raw.rsi',
      'raw.emaSpreadPct',
      'raw.atrPct',
      'raw.fundingRate',
      'raw.longShortRatio',
      'raw.takerBuyRatio',
      'raw.fearGreed',
      'raw.htfTrend',
      'raw.ret1',
      'raw.ret5',
      'raw.ret20',
      'raw.realizedVol20',
    ]) {
      expect(categoryOf.get(rawName)).toBe('raw');
    }
  });

  it('is NaN for every factor before warmup', () => {
    for (let bar = 0; bar < matrix.warmupBars; bar++) {
      for (const series of matrix.values) {
        expect(Number.isNaN(series[bar])).toBe(true);
      }
    }
  });

  it('is finite after warmup for factors whose inputs always exist', () => {
    const alwaysPresent = [
      'composite',
      'cat.trend',
      'cat.momentum',
      'cat.volume',
      'cat.volatility',
      'raw.rsi',
      'raw.emaSpreadPct',
      'raw.atrPct',
    ];
    const idxByName = new Map(matrix.names.map((n, i) => [n, i]));

    for (const name of alwaysPresent) {
      const idx = idxByName.get(name)!;
      for (let bar = matrix.warmupBars; bar < matrix.closes.length; bar++) {
        expect(Number.isFinite(matrix.values[idx][bar])).toBe(true);
      }
    }

    // Return/volatility factors are finite once their own lookback is satisfied
    const ret20Idx = idxByName.get('raw.ret20')!;
    const volIdx = idxByName.get('raw.realizedVol20')!;
    for (let bar = Math.max(matrix.warmupBars, 20); bar < matrix.closes.length; bar++) {
      expect(Number.isFinite(matrix.values[ret20Idx][bar])).toBe(true);
      expect(Number.isFinite(matrix.values[volIdx][bar])).toBe(true);
    }
  });

  it('raw.ret1 matches a hand computation', () => {
    const idx = matrix.names.indexOf('raw.ret1');
    const bar = matrix.warmupBars + 30;
    const expected = (matrix.closes[bar] - matrix.closes[bar - 1]) / matrix.closes[bar - 1];
    expect(matrix.values[idx][bar]).toBeCloseTo(expected, 12);
  });

  it('has no lookahead: the factor vector at bar i is identical when future bars are removed', () => {
    const probeBars = [matrix.warmupBars + 15, Math.floor(candleRows.length / 2), candleRows.length - 2];

    for (const bar of probeBars) {
      const truncatedCandles = candleRows.slice(0, bar + 1);
      const cutoff = truncatedCandles[truncatedCandles.length - 1].t;
      const truncatedSnapshots = snapshotRows.filter((s) => s.t <= cutoff);
      const truncatedHtf = htfRows.slice(0, bar + 1);

      const truncated = computeFactorMatrix({
        candles: truncatedCandles,
        snapshots: truncatedSnapshots,
        htf: truncatedHtf,
        interval: INTERVAL,
      });

      // The truncated series' name universe is a subset of the full series';
      // compare every name it does have, by name (not position).
      const fullIdxByName = new Map(matrix.names.map((n, i) => [n, i]));
      for (let i = 0; i < truncated.names.length; i++) {
        const name = truncated.names[i];
        const fullIdx = fullIdxByName.get(name);
        expect(fullIdx).toBeDefined();

        const truncatedValue = truncated.values[i][bar];
        const fullValue = matrix.values[fullIdx!][bar];

        if (Number.isNaN(truncatedValue) || Number.isNaN(fullValue)) {
          expect(Number.isNaN(truncatedValue)).toBe(Number.isNaN(fullValue));
        } else {
          expect(truncatedValue).toBeCloseTo(fullValue, 8);
        }
      }
    }
  });

  it('composite equals a direct computeSignalScore call for the same bar', () => {
    const ohlcv = candleRows.map((r) => ({
      timestamp: r.t,
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
      ...(r.tbv !== null ? { takerBuyVolume: r.tbv } : {}),
    }));

    const leanSnapshots = snapshotRows.map((row) => ({
      timestamp: row.t,
      data: {
        fundingRate: row.fundingRate
          ? { rate: row.fundingRate.rate, markPrice: row.fundingRate.markPrice ?? undefined }
          : undefined,
        longShortRatio: row.longShortRatio ?? undefined,
        openInterest: row.openInterest ?? undefined,
        newsSentiment: row.newsSentiment ?? undefined,
        fearGreed: row.fearGreed ?? undefined,
      },
    }));

    const prepared = prepareBacktest(
      ohlcv,
      '',
      INTERVAL,
      getStyleConfig(STYLE).config,
      leanSnapshots
    );
    const bar = matrix.warmupBars + 42;

    const suite = prepared.indicators[bar];
    const snap = prepared.snapshots?.[bar] ?? null;
    const htfCtx = htfRows[bar]?.context ?? null;
    const stIdx = bar - prepared.stOffset;
    const superTrendAtBar =
      stIdx >= 0 && stIdx < prepared.superTrend.length ? prepared.superTrend[stIdx] : undefined;

    const expected = computeSignalScore(
      suite,
      snap?.futures ?? null,
      snap?.sentiment ?? null,
      DEFAULT_TEMPLATE_WEIGHTS[STYLE],
      superTrendAtBar ? { values: prepared.superTrend, current: superTrendAtBar } : null,
      htfCtx
    );

    const compositeIdx = matrix.names.indexOf('composite');
    expect(matrix.values[compositeIdx][bar]).toBeCloseTo(expected.score, 10);
  });
});
