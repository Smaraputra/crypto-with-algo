// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { intervalToMs } from '@/lib/intervals';
import type { CandleRow, FlowRow, HtfRow } from './dataset-format';
import { computeFactorMatrix, type FactorMatrix } from './factors';

const FIVE_MIN = 300_000;
const QUARTER = 900_000;
const NEW_COLUMNS = ['raw.qhOpenImb', 'raw.fiveMinOpenImb', 'raw.largeTakerImb', 'raw.smallTakerImb'] as const;

/** Today's raw column list before the qh-flow columns, hard-coded so a reorder or rename fails here. */
const EXISTING_RAW_NAMES = [
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
  'raw.oiChange1',
  'raw.oiChange8',
  'raw.oiPriceDiv',
  'raw.takerLongShortRatio',
  'raw.topTraderPositionRatio',
  'raw.globalAccountRatio',
  'raw.fundingZ',
  'raw.basisPct',
  'raw.perpSpotSpreadPct',
  'raw.depthImbalance1',
  'raw.depthImbalance5',
  'raw.depthNotional1',
  'raw.depthSlope',
  'raw.depthFlow1',
  'raw.varianceRatio',
  'raw.ret1InMeanReversion',
  'raw.ret1InTrend',
  'raw.fundingProximity',
  'raw.hourOfDayDrift',
  'raw.sessionDrift',
  'raw.depthNotionalZ',
  'raw.ret1InHighTaker',
  'raw.ret1InLowTaker',
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
  'raw.hourOfDayDriftDev',
  'raw.weekdayDriftDev',
  'raw.ret1InAsia',
  'raw.ret1InNyOverlap',
  'raw.ret1NearRound',
  'raw.ret1FarRound',
  'raw.ret1AfterDown',
  'raw.ret1AfterUp',
  'raw.ret1InHighVolRatio',
  'raw.ret1InLowVolRatio',
];

function candlesFor(interval: string, count: number): { rows: CandleRow[]; htf: HtfRow[]; start: number } {
  const ms = intervalToMs(interval);
  const start = 1_700_000_000_000 - (1_700_000_000_000 % ms);
  let price = 100;
  const rows: CandleRow[] = [];
  for (let i = 0; i < count; i++) {
    price *= 1 + Math.sin(i / 3) / 400;
    rows.push({ t: start + i * ms, o: price, h: price * 1.002, l: price * 0.998, c: price * 1.0005, v: 1000, tbv: 500 });
  }
  return { rows, htf: rows.map((r) => ({ t: r.t, context: null })), start };
}

function flowRow(t: number, over: Partial<FlowRow> = {}): FlowRow {
  return {
    t,
    trades: 0,
    aggTrades: 0,
    buyBase: 0,
    sellBase: 0,
    buyQuote: 0,
    sellQuote: 0,
    buyQuoteSmall: 0,
    buyQuoteMedium: 0,
    buyQuoteLarge: 0,
    sellQuoteSmall: 0,
    sellQuoteMedium: 0,
    sellQuoteLarge: 0,
    buyQuoteOpen10s: 0,
    sellQuoteOpen10s: 0,
    source: 'test',
    ...over,
  };
}

function build(interval: string, count: number, flow: FlowRow[] | null | undefined): { matrix: FactorMatrix; start: number } {
  const { rows, htf, start } = candlesFor(interval, count);
  const matrix = computeFactorMatrix({ candles: rows, snapshots: null, htf, interval, flow });
  return { matrix, start };
}

function col(matrix: FactorMatrix, name: string): Float64Array {
  const i = matrix.names.indexOf(name);
  expect(i, `${name} missing`).toBeGreaterThanOrEqual(0);
  return matrix.values[i];
}

function at(matrix: FactorMatrix, bar: number): number[] {
  return NEW_COLUMNS.map((name) => col(matrix, name)[bar]);
}

/** Buckets of one bar. `over(i, isQuarter)` customises bucket i (0-based inside the bar). */
function barBuckets(
  openT: number,
  intervalMs: number,
  over: (i: number, isQuarter: boolean) => Partial<FlowRow>,
  skip: number[] = []
): FlowRow[] {
  const out: FlowRow[] = [];
  for (let i = 0; i < intervalMs / FIVE_MIN; i++) {
    if (skip.includes(i)) continue;
    const t = openT + i * FIVE_MIN;
    out.push(flowRow(t, over(i, t % QUARTER === 0)));
  }
  return out;
}

describe('qh-flow columns: column list', () => {
  it('keeps every existing raw column name and order, with the four new ones appended last', () => {
    const { matrix } = build('1h', 260, null);
    const raw = matrix.names.filter((n) => n.startsWith('raw.'));
    expect(raw.slice(0, raw.length - 4)).toEqual(EXISTING_RAW_NAMES);
    expect(raw.slice(-4)).toEqual([...NEW_COLUMNS]);
    expect(matrix.names.slice(-4)).toEqual([...NEW_COLUMNS]);
  });

  it('is NaN in all four columns when flow is absent, null or empty', () => {
    for (const flow of [undefined, null, []] as Array<FlowRow[] | null | undefined>) {
      const { matrix } = build('1h', 260, flow);
      for (const name of NEW_COLUMNS) {
        expect(col(matrix, name).every((v) => Number.isNaN(v))).toBe(true);
      }
    }
  });
});

describe('qh-flow columns at 1h', () => {
  const HOUR = 3_600_000;
  const BAR = 240;
  const data = (start: number): FlowRow[] => {
    const T = start + BAR * HOUR;
    // Quarter marks (i = 0, 3, 6, 9): open buy/sell 30/10, 20/20, 5/15, 45/5.
    const qOpen = new Map<number, [number, number]>([[0, [30, 10]], [3, [20, 20]], [6, [5, 15]], [9, [45, 5]]]);
    const rows = barBuckets(T, HOUR, (i, isQuarter) => {
      const [bo, so] = isQuarter ? qOpen.get(i)! : [1, 3];
      return {
        buyQuoteOpen10s: bo,
        sellQuoteOpen10s: so,
        buyQuote: 300,
        sellQuote: 200,
        buyQuoteLarge: 10 * (i + 1),
        sellQuoteLarge: 40,
        buyQuoteSmall: 50,
        sellQuoteSmall: 80,
      };
    });
    // Ignored: one bucket just before the bar and one exactly at its close.
    rows.unshift(flowRow(T - FIVE_MIN, { buyQuoteOpen10s: 9e6, buyQuote: 9e6, buyQuoteLarge: 9e6 }));
    rows.push(flowRow(T + HOUR, { buyQuoteOpen10s: 9e6, buyQuote: 9e6, buyQuoteLarge: 9e6 }));
    return rows;
  };

  it('matches hand-computed values on a complete bar and ignores buckets outside it', () => {
    const { start } = candlesFor('1h', 260);
    const { matrix } = build('1h', 260, data(start));
    const [qh, five, large, small] = at(matrix, BAR);
    // qh: diff 20 + 0 - 10 + 40 = 50 over total 40 + 40 + 20 + 50 = 150.
    expect(qh).toBeCloseTo(1 / 3, 12);
    // other 8 marks: buy 1 sell 3 -> diff -16 over total 32.
    expect(five).toBeCloseTo(-0.5, 12);
    // large: buy 10 * (1 + ... + 12) = 780, sell 12 * 40 = 480, over 12 * 500 = 6000.
    expect(large).toBeCloseTo(300 / 6000, 12);
    // small: buy 600, sell 960 over 6000.
    expect(small).toBeCloseTo(-360 / 6000, 12);
  });

  it('gives NaN to the neighbouring bars, which each hold only one stray bucket', () => {
    const { start } = candlesFor('1h', 260);
    const { matrix } = build('1h', 260, data(start));
    expect(at(matrix, BAR - 1).every(Number.isNaN)).toBe(true);
    expect(at(matrix, BAR + 1).every(Number.isNaN)).toBe(true);
  });

  it('is NaN in all four columns when any one bucket is missing', () => {
    const { start } = candlesFor('1h', 260);
    const T = start + BAR * HOUR;
    for (const skip of [0, 4, 11]) {
      const rows = barBuckets(T, HOUR, () => ({ buyQuoteOpen10s: 5, sellQuoteOpen10s: 1, buyQuote: 10, sellQuote: 10, buyQuoteLarge: 4, sellQuoteLarge: 1 }), [skip]);
      expect(at(build('1h', 260, rows).matrix, BAR).every(Number.isNaN)).toBe(true);
    }
  });

  it('gives NaN only to the column whose denominator is zero', () => {
    const { start } = candlesFor('1h', 260);
    const T = start + BAR * HOUR;

    // No quarter-hour opening flow: qh NaN, the other three finite.
    const noQh = barBuckets(T, HOUR, (_i, isQuarter) => ({
      buyQuoteOpen10s: isQuarter ? 0 : 4,
      sellQuoteOpen10s: isQuarter ? 0 : 2,
      buyQuote: 10,
      sellQuote: 10,
      buyQuoteLarge: 6,
      sellQuoteLarge: 2,
      buyQuoteSmall: 1,
      sellQuoteSmall: 3,
    }));
    const [qh1, five1, large1, small1] = at(build('1h', 260, noQh).matrix, BAR);
    expect(qh1).toBeNaN();
    expect(five1).toBeCloseTo(1 / 3, 12);
    expect(large1).toBeCloseTo(48 / 240, 12);
    expect(small1).toBeCloseTo(-24 / 240, 12);

    // No total taker quote: large and small NaN, the two opening columns finite.
    const noTotal = barBuckets(T, HOUR, (_i, isQuarter) => ({
      buyQuoteOpen10s: isQuarter ? 3 : 1,
      sellQuoteOpen10s: isQuarter ? 1 : 3,
    }));
    const [qh2, five2, large2, small2] = at(build('1h', 260, noTotal).matrix, BAR);
    expect(qh2).toBeCloseTo(0.5, 12);
    expect(five2).toBeCloseTo(-0.5, 12);
    expect(large2).toBeNaN();
    expect(small2).toBeNaN();
  });

  it('keeps the sign convention: more taker buying is positive', () => {
    const { start } = candlesFor('1h', 260);
    const T = start + BAR * HOUR;
    const buying = barBuckets(T, HOUR, () => ({ buyQuoteOpen10s: 9, sellQuoteOpen10s: 1, buyQuote: 10, sellQuote: 2, buyQuoteLarge: 8, sellQuoteLarge: 1, buyQuoteSmall: 2, sellQuoteSmall: 1 }));
    const [qh, five, large, small] = at(build('1h', 260, buying).matrix, BAR);
    expect(qh).toBeCloseTo(0.8, 12);
    expect(five).toBeCloseTo(0.8, 12);
    expect(large).toBeCloseTo(7 / 12, 12);
    expect(small).toBeCloseTo(1 / 12, 12);
  });
});

describe('qh-flow columns at 4h', () => {
  const FOUR_H = 4 * 3_600_000;
  const BAR = 240;

  const full = (start: number, skip: number[] = []): FlowRow[] =>
    barBuckets(
      start + BAR * FOUR_H,
      FOUR_H,
      (_i, isQuarter) => ({
        buyQuoteOpen10s: isQuarter ? 7 : 2,
        sellQuoteOpen10s: isQuarter ? 3 : 6,
        buyQuote: 100,
        sellQuote: 100,
        buyQuoteLarge: 20,
        sellQuoteLarge: 10,
        buyQuoteSmall: 5,
        sellQuoteSmall: 25,
      }),
      skip
    );

  it('has 16 quarter-hour and 32 other marks in a complete bar', () => {
    const { start } = candlesFor('4h', 260);
    const rows = full(start);
    expect(rows).toHaveLength(48);
    expect(rows.filter((r) => r.t % QUARTER === 0)).toHaveLength(16);
    expect(rows.filter((r) => r.t % QUARTER !== 0)).toHaveLength(32);
  });

  it('matches hand-computed values on a complete bar', () => {
    const { start } = candlesFor('4h', 260);
    const [qh, five, large, small] = at(build('4h', 260, full(start)).matrix, BAR);
    // qh: 16 * (7 - 3) over 16 * 10.
    expect(qh).toBeCloseTo(0.4, 12);
    // other: 32 * (2 - 6) over 32 * 8.
    expect(five).toBeCloseTo(-0.5, 12);
    // large: 48 * 10 over 48 * 200.
    expect(large).toBeCloseTo(0.05, 12);
    // small: 48 * -20 over 48 * 200.
    expect(small).toBeCloseTo(-0.1, 12);
  });

  it('is NaN in all four columns when one of the 48 buckets is missing', () => {
    const { start } = candlesFor('4h', 260);
    for (const skip of [0, 17, 47]) {
      expect(at(build('4h', 260, full(start, [skip])).matrix, BAR).every(Number.isNaN)).toBe(true);
    }
  });
});
