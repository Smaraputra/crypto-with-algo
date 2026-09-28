// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { intervalToMs } from '@/lib/intervals';
import { OPTIONS_SLOT_MS } from '@/lib/options-flow';
import type { OHLCV } from '@/types/market';
import type { CandleRow, HtfRow, OptionsRow } from './dataset-format';
import {
  computeFactorMatrix,
  trailingZScore,
  DEPTH_NOTIONAL_Z_DAYS,
  DEPTH_NOTIONAL_Z_MIN_SAMPLES,
  MARKET_OPTIONS_NAMES,
  type FactorMatrix,
} from './factors';

const DAY_MS = 24 * 60 * 60 * 1000;

const INTERVAL = '1h';
const INTERVAL_MS = intervalToMs(INTERVAL);
const START = 1700000000000 - (1700000000000 % INTERVAL_MS);
const BAR_COUNT = 400;

// Deterministic random walk, the LCG pattern the other research tests use.
function generateCandles(count: number, seed = 4242): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;
  const next = () => {
    rng = (rng * 16807) % 2147483647;
    return rng / 2147483647;
  };

  for (let i = 0; i < count; i++) {
    const noise = (next() - 0.5) * 0.5;
    price = price * (1 + noise / 100);
    const volume = 1000 + next() * 5000;
    candles.push({
      timestamp: START + i * INTERVAL_MS,
      open: price * (1 + (next() - 0.5) * 0.003),
      high: price * (1 + next() * 0.005),
      low: price * (1 - next() * 0.005),
      close: price,
      volume,
      takerBuyVolume: volume * 0.5,
    });
  }
  return candles;
}

function toCandleRow(c: OHLCV): CandleRow {
  return { t: c.timestamp, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume, tbv: c.takerBuyVolume ?? null };
}

const candles = generateCandles(BAR_COUNT);
const candleRows = candles.map(toCandleRow);
const htfRows: HtfRow[] = candleRows.map((c) => ({ t: c.t, context: null }));

/**
 * One hourly options row per candle (own and market use different `seed`
 * offsets so their columns are independently verifiable), everything finite
 * and monotonically increasing so a trailing-window hand sum is easy to
 * reproduce in a test.
 */
function optionsRow(i: number, seed: number): OptionsRow {
  return {
    t: START + i * OPTIONS_SLOT_MS,
    dvolOpen: 60 + seed + Math.sin(i / 11) * 8,
    dvolHigh: 61 + seed + Math.sin(i / 11) * 8,
    dvolLow: 59 + seed + Math.sin(i / 11) * 8,
    dvolClose: 60 + seed + Math.sin(i / 11) * 8,
    callBuyNotional: 2_000_000 + seed + i * 100,
    callSellNotional: 1_500_000 + seed + i * 80,
    putBuyNotional: 1_000_000 + seed + i * 60,
    putSellNotional: 900_000 + seed + i * 50,
    netDelta: 100 + seed + i,
    netDollarGamma: 50 + seed + i * 0.5,
    tradeCount: 40 + i,
    greekTradeCount: 20 + i,
    vwIv: 65 + seed,
    putIv25: 62 + seed + (i % 5),
    callIv25: 58 + seed + (i % 7),
  };
}

const OWN_SEED = 0;
const MKT_SEED = 500;
const ownRows: OptionsRow[] = candleRows.map((c, i) => optionsRow(i, OWN_SEED));
const marketRows: OptionsRow[] = candleRows.map((c, i) => optionsRow(i, MKT_SEED));

function build(over: Partial<Parameters<typeof computeFactorMatrix>[0]> = {}): FactorMatrix {
  return computeFactorMatrix({
    candles: candleRows,
    snapshots: null,
    htf: htfRows,
    interval: INTERVAL,
    options: ownRows,
    marketOptions: marketRows,
    ...over,
  });
}

function column(matrix: FactorMatrix, name: string): Float64Array {
  const index = matrix.names.indexOf(name);
  expect(index, `factor ${name} is missing`).toBeGreaterThanOrEqual(0);
  return matrix.values[index];
}

const OPTIONS_FACTORS = [
  'raw.mktDvolZ30',
  'raw.mktOptDeltaFlow24Z',
  'raw.mktOptGammaFlow24Z',
  'raw.mktOptPutCallVol24',
  'raw.mktOptSkew24',
  'raw.ownDvolZ30',
  'raw.ownOptDeltaFlow24Z',
  'raw.ownOptGammaFlow24Z',
  'raw.ownOptPutCallVol24',
  'raw.ownOptSkew24',
  'raw.ret1InHighDvol',
  'raw.ret1InLowDvol',
  'raw.ret1InPosGammaFlow',
  'raw.ret1InNegGammaFlow',
];

describe('options factors: presence and category', () => {
  const matrix = build();

  it('adds the fourteen columns under raw', () => {
    expect(OPTIONS_FACTORS).toHaveLength(14);
    for (const name of OPTIONS_FACTORS) {
      const index = matrix.names.indexOf(name);
      expect(index, name).toBeGreaterThanOrEqual(0);
      expect(matrix.categories[index]).toBe('raw');
    }
  });

  it('exports MARKET_OPTIONS_NAMES as exactly the five mkt columns', () => {
    expect(MARKET_OPTIONS_NAMES).toEqual([
      'raw.mktDvolZ30',
      'raw.mktOptDeltaFlow24Z',
      'raw.mktOptGammaFlow24Z',
      'raw.mktOptPutCallVol24',
      'raw.mktOptSkew24',
    ]);
  });

  it('leaves every options column NaN when both inputs are absent', () => {
    const without = build({ options: null, marketOptions: null });
    for (const name of OPTIONS_FACTORS) {
      const values = column(without, name);
      for (let bar = without.warmupBars; bar < candleRows.length; bar++) {
        expect(values[bar], `${name} at ${bar}`).toBeNaN();
      }
    }
  });

  it('mkt* is finite with marketOptions alone while own* stays NaN', () => {
    const marketOnly = build({ options: null });
    const mktZ = column(marketOnly, 'raw.mktDvolZ30');
    const ownZ = column(marketOnly, 'raw.ownDvolZ30');
    expect(Array.from(mktZ).some((v) => Number.isFinite(v))).toBe(true);
    expect(Array.from(ownZ).every((v) => Number.isNaN(v))).toBe(true);

    const mktPcv = column(marketOnly, 'raw.mktOptPutCallVol24');
    const ownPcv = column(marketOnly, 'raw.ownOptPutCallVol24');
    expect(Array.from(mktPcv).some((v) => Number.isFinite(v))).toBe(true);
    expect(Array.from(ownPcv).every((v) => Number.isNaN(v))).toBe(true);
  });

  it('still produces the same composite with the options inputs supplied', () => {
    const without = build({ options: null, marketOptions: null });
    const a = column(matrix, 'composite');
    const b = column(without, 'composite');
    for (let bar = matrix.warmupBars; bar < candleRows.length; bar++) {
      expect(b[bar]).toBe(a[bar]);
    }
  });
});

describe('options alignment', () => {
  it('reads the row whose hour has closed at or before the bar close, at a finer interval than the options grid', () => {
    // 15m bars; the day_trading warmup threshold is a bar count, not a
    // wall-clock duration, so the same BAR_COUNT clears it the way the 1h
    // fixture above does.
    const fifteenMinMs = intervalToMs('15m');
    const fifteenMinCandles = generateCandles(BAR_COUNT, 7001).map((c, i) => ({
      ...c,
      timestamp: START + i * fifteenMinMs,
    }));
    const fifteenMinRows = fifteenMinCandles.map(toCandleRow);
    const fifteenMinHtf: HtfRow[] = fifteenMinRows.map((c) => ({ t: c.t, context: null }));

    // Hourly options rows covering the whole span, aligned to the same
    // START, matching the join rule the header describes.
    const hourlyRows: OptionsRow[] = Array.from(
      { length: Math.ceil((BAR_COUNT * fifteenMinMs) / OPTIONS_SLOT_MS) + 2 },
      (_, h) => optionsRow(h, OWN_SEED)
    );

    const withOptions = computeFactorMatrix({
      candles: fifteenMinRows,
      snapshots: null,
      htf: fifteenMinHtf,
      interval: '15m',
      options: hourlyRows,
      marketOptions: null,
    });

    const dvolClose = (h: number) => 60 + OWN_SEED + Math.sin(h / 11) * 8;

    // Pick an hour comfortably past warmup: the 4 sub-bars of that hour are
    // at offsets 0, 15, 30, 45 minutes past the hour boundary.
    const hour = Math.floor(withOptions.warmupBars / 4) + 20;
    const hourStartT = START + hour * OPTIONS_SLOT_MS;
    const barIndexAtOffset = (offsetMin: number) =>
      fifteenMinRows.findIndex((r) => r.t === hourStartT + offsetMin * 60_000);

    // The z-score reads the underlying dvol close indirectly (trailing
    // window), so probe a raw level instead: raw.ownOptPutCallVol24 (or
    // dvolClose via the z-score's own entering value would need unwinding
    // the z-score's running window). Use the "leaves NaN across a gap"
    // structure instead: assert dvolClose alignment through the z-score's
    // entering value by checking finiteness flips at the exact boundary a
    // fresh row appears, which is enough to prove which row a bar reads
    // without depending on the trailing window's exact mean/variance.
    const ownZ = column(withOptions, 'raw.ownDvolZ30');

    // Bars 0,1,2 within the hour must NOT yet see hour `hour`'s own row: they
    // read `hour - 1`. Bar 3 (offset 45) DOES see `hour`'s own row. Proven by
    // building a second matrix whose only difference is that hour's dvol
    // value, and checking the z-score changes starting exactly at offset 45.
    const bumpedRows = hourlyRows.map((r, h2) =>
      h2 === hour ? { ...r, dvolClose: (r.dvolClose ?? 0) + 1000 } : r
    );
    const bumped = computeFactorMatrix({
      candles: fifteenMinRows,
      snapshots: null,
      htf: fifteenMinHtf,
      interval: '15m',
      options: bumpedRows,
      marketOptions: null,
    });
    const bumpedOwnZ = column(bumped, 'raw.ownDvolZ30');

    for (const offset of [0, 15, 30]) {
      const bar = barIndexAtOffset(offset);
      expect(bar, `bar at offset ${offset}`).toBeGreaterThan(0);
      expect(bumpedOwnZ[bar]).toBeCloseTo(ownZ[bar], 8);
    }
    const bar45 = barIndexAtOffset(45);
    expect(bar45).toBeGreaterThan(0);
    expect(bumpedOwnZ[bar45]).not.toBeCloseTo(ownZ[bar45], 4);

    expect(dvolClose(hour)).not.toBeNaN(); // sanity: the probe hour has real data
  });

  it('refuses to carry a reading beyond the staleness cap', () => {
    // Rows present up through a bar well past warmup, then the file goes
    // silent. putCallVol24 (no minimum-sample gate of its own, unlike the
    // z-scored columns) is finite right up to the cutoff; a bar far past it
    // must not inherit the last reading.
    const probe = build();
    const cutoff = probe.warmupBars + 40;
    const sparse = ownRows.slice(0, cutoff);
    const matrixSparse = build({ options: sparse, marketOptions: null });
    const values = column(matrixSparse, 'raw.ownOptPutCallVol24');
    expect(Number.isFinite(values[cutoff - 1])).toBe(true);
    const lastBar = candleRows.length - 1;
    expect(values[lastBar]).toBeNaN();
  });
});

describe('trailing 24-hour options flow columns', () => {
  const matrix = build();

  it('ownOptDeltaFlow24Z matches trailingZScore over a hand-summed 24-hour trailing deltaFlow24', () => {
    // deltaFlow24 itself is only exposed z-scored (raw.ownOptDeltaFlow24Z),
    // so the hand sum is verified end to end: build the same hourly sum this
    // file's own rows imply, mask it from warmupBars the way the
    // implementation does, and feed it through the same exported
    // trailingZScore with the same window/minSamples. Own rows are
    // index-aligned 1:1 with candle bars in this fixture (both grids share
    // the 1h interval), so row i joins to bar i.
    const handDeltaFlow24 = new Float64Array(candleRows.length).fill(NaN);
    for (let i = 23; i < ownRows.length; i++) {
      let sum = 0;
      for (let k = i - 23; k <= i; k++) sum += ownRows[k].netDelta!;
      handDeltaFlow24[i] = sum;
    }
    const masked = new Float64Array(candleRows.length).fill(NaN);
    for (let bar = matrix.warmupBars; bar < candleRows.length; bar++) {
      masked[bar] = handDeltaFlow24[bar];
    }
    const windowBars = Math.max(1, Math.ceil((DEPTH_NOTIONAL_Z_DAYS * DAY_MS) / INTERVAL_MS));
    const expectedZ = trailingZScore(masked, windowBars, DEPTH_NOTIONAL_Z_MIN_SAMPLES);

    const actualZ = column(matrix, 'raw.ownOptDeltaFlow24Z');
    for (let bar = matrix.warmupBars; bar < candleRows.length; bar += 17) {
      if (Number.isNaN(expectedZ[bar])) expect(actualZ[bar], `bar ${bar}`).toBeNaN();
      else expect(actualZ[bar], `bar ${bar}`).toBeCloseTo(expectedZ[bar], 8);
    }
  });

  it('NaN across a one-hour gap', () => {
    const bar = matrix.warmupBars + 60;
    const gapHour = bar - 5; // the removed hour's index (own rows are 1:1 with bars here)
    const gapped = ownRows.filter((_, i) => i !== gapHour);
    const matrixGapped = build({ options: gapped });
    const pcv = column(matrixGapped, 'raw.ownOptPutCallVol24');

    // The bar AT the removed hour still reads the previous hour's row
    // (within the 2h staleness cap), whose own 24-hour window fully
    // precedes the gap, so it stays finite.
    expect(Number.isFinite(pcv[gapHour])).toBe(true);

    // Every later hour whose own 24-row trailing window spans the missing
    // hour is NaN: hours gapHour+1 .. gapHour+23.
    for (let i = gapHour + 1; i <= gapHour + 23; i++) {
      expect(pcv[i], `bar ${i}`).toBeNaN();
    }
    // The first hour whose window no longer includes the gap recovers.
    expect(Number.isFinite(pcv[gapHour + 24])).toBe(true);
  });

  it('putCallVol24 hand ratio, and NaN with zero call notional', () => {
    const bar = matrix.warmupBars + 80;
    const rowIndex = bar;
    let putSum = 0;
    let callSum = 0;
    for (let k = rowIndex - 23; k <= rowIndex; k++) {
      putSum += ownRows[k].putBuyNotional! + ownRows[k].putSellNotional!;
      callSum += ownRows[k].callBuyNotional! + ownRows[k].callSellNotional!;
    }
    const expected = putSum / callSum;
    expect(column(matrix, 'raw.ownOptPutCallVol24')[bar]).toBeCloseTo(expected, 6);

    const zeroCall = ownRows.map((r) => ({ ...r, callBuyNotional: 0, callSellNotional: 0 }));
    const matrixZeroCall = build({ options: zeroCall });
    expect(column(matrixZeroCall, 'raw.ownOptPutCallVol24')[bar]).toBeNaN();
  });

  it('skew24 hand mean', () => {
    const bar = matrix.warmupBars + 100;
    const rowIndex = bar;
    let sum = 0;
    let count = 0;
    for (let k = rowIndex - 23; k <= rowIndex; k++) {
      const diff = ownRows[k].putIv25! - ownRows[k].callIv25!;
      if (Number.isFinite(diff)) {
        sum += diff;
        count++;
      }
    }
    const expected = sum / count;
    expect(column(matrix, 'raw.ownOptSkew24')[bar]).toBeCloseTo(expected, 6);
  });
});

describe('dvol z-score', () => {
  it('is NaN until thirty readings and on a constant series', () => {
    const matrix = build();
    const z = column(matrix, 'raw.ownDvolZ30');
    expect(z[matrix.warmupBars]).toBeNaN();
    expect(Number.isFinite(z[matrix.warmupBars + 40])).toBe(true);

    const constantRows = ownRows.map((r) => ({ ...r, dvolClose: 60 }));
    const constantMatrix = build({ options: constantRows });
    const constantZ = column(constantMatrix, 'raw.ownDvolZ30');
    for (let bar = constantMatrix.warmupBars; bar < candleRows.length; bar++) {
      expect(constantZ[bar]).toBeNaN();
    }
  });
});

describe('options diagnostics', () => {
  it('the tercile and sign diagnostics partition raw.ret1', () => {
    const matrix = build();
    const ret1 = column(matrix, 'raw.ret1');
    const high = column(matrix, 'raw.ret1InHighDvol');
    const low = column(matrix, 'raw.ret1InLowDvol');
    const pos = column(matrix, 'raw.ret1InPosGammaFlow');
    const neg = column(matrix, 'raw.ret1InNegGammaFlow');

    let sawHigh = false;
    let sawPos = false;
    for (let bar = matrix.warmupBars; bar < candleRows.length; bar++) {
      // A bar is never simultaneously in the high and low tercile.
      expect(Number.isFinite(high[bar]) && Number.isFinite(low[bar])).toBe(false);
      if (Number.isFinite(high[bar])) {
        expect(high[bar]).toBe(ret1[bar]);
        sawHigh = true;
      }
      if (Number.isFinite(low[bar])) expect(low[bar]).toBe(ret1[bar]);

      // Pos/neg gamma flow is a strict sign split: never both finite, and
      // exactly one is finite whenever ret1 and gammaFlow24 are both known.
      expect(Number.isFinite(pos[bar]) && Number.isFinite(neg[bar])).toBe(false);
      if (Number.isFinite(pos[bar])) {
        expect(pos[bar]).toBe(ret1[bar]);
        sawPos = true;
      }
      if (Number.isFinite(neg[bar])) expect(neg[bar]).toBe(ret1[bar]);
    }
    expect(sawHigh).toBe(true);
    expect(sawPos).toBe(true);
  });
});

describe('no lookahead across options factors', () => {
  it('removing every options row whose close is after the bar close leaves the value at that bar unchanged', () => {
    const matrix = build();
    const probeBars = [matrix.warmupBars + 60, candleRows.length - 2];

    for (const bar of probeBars) {
      const cutoffClose = candleRows[bar].t + INTERVAL_MS - 1;
      const truncated = build({
        options: ownRows.filter((r) => r.t + OPTIONS_SLOT_MS - 1 <= cutoffClose),
        marketOptions: marketRows.filter((r) => r.t + OPTIONS_SLOT_MS - 1 <= cutoffClose),
      });

      for (const name of OPTIONS_FACTORS) {
        const a = column(truncated, name)[bar];
        const b = column(matrix, name)[bar];
        if (Number.isNaN(b)) expect(a, `${name} at ${bar}`).toBeNaN();
        else expect(a, `${name} at ${bar}`).toBeCloseTo(b, 8);
      }
    }
  });
});
