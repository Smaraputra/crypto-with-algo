import { describe, expect, it } from 'vitest';
import { DAY_MS, type Rebalance, type RulePaths } from './trend-signals';
import {
  TREND_COST,
  alphaCi,
  annualAlpha,
  annualisedSharpe,
  assertDaily,
  circularBlockIndices,
  losingStreak,
  maxDrawdown,
  olsAlphaBeta,
  runTrend,
  sharpeCi,
  shiftSignal,
  stressCost,
  timingNull,
  topEpisodeShare,
  type Settlement,
  type SimOptions,
  type TrendSymbolInput,
} from './trend-sim';

const D0 = Date.UTC(2024, 0, 2);
const FREE = { fee: 0, slippage: 0 };

/** Bars from `start`, opens equal to the previous close unless given. */
function input(
  symbol: string,
  closes: number[],
  opts: { start?: number; listing?: number; opens?: number[]; settlements?: Settlement[] } = {}
): TrendSymbolInput {
  const start = opts.start ?? D0;
  return {
    symbol,
    t: closes.map((_, i) => start + i * DAY_MS),
    open: opts.opens ?? closes.map((c, i) => (i === 0 ? c : closes[i - 1])),
    close: closes,
    listingDay: opts.listing ?? start + DAY_MS,
    settlements: opts.settlements ?? [],
  };
}

function paths(
  n: number,
  signal: number | number[],
  size: number | number[],
  rebalance: Rebalance,
  decide: (i: number) => boolean = () => true
): RulePaths {
  const fill = (v: number | number[]) => Float64Array.from(Array.isArray(v) ? v : new Array(n).fill(v));
  return { signal: fill(signal), size: fill(size), decide, rebalance };
}

function opts(from: number, to: number, extra: Partial<SimOptions> = {}): SimOptions {
  return { from, to, cost: FREE, delay: 0, ...extra };
}

const ON_CHANGE: Rebalance = { kind: 'on-signal-change' };

describe('runTrend, one sleeve', () => {
  const closes = [100, 100, 110, 99, 108.9];
  const a = input('A', closes);
  const from = D0 + DAY_MS;
  const to = D0 + 5 * DAY_MS;

  it('fills the first decision at the next open and earns the price path on its capital', () => {
    const run = runTrend([a], { A: paths(5, 1, 1, ON_CHANGE) }, opts(from, to));
    expect(run.days).toHaveLength(4);
    [0, 0.1, -0.1, 0.1].forEach((r, k) => expect(run.returns[k]).toBeCloseTo(r, 12));
    expect(run.turnover[0]).toBeCloseTo(1, 12);
    expect(run.turnover.slice(1)).toEqual([0, 0, 0]);
    expect(run.longLeg[1]).toBeCloseTo(0.1, 12);
    expect(run.shortLeg[1]).toBe(0);
  });

  it('charges fee plus slippage on every unit of traded notional', () => {
    const run = runTrend([a], { A: paths(5, 1, 1, ON_CHANGE) }, opts(from, to, { cost: TREND_COST }));
    expect(run.cost[0]).toBeCloseTo(0.0005 + 0.0002, 12);
    expect(run.returns[0]).toBeCloseTo(-0.0007, 12);
    const stressed = stressCost(TREND_COST);
    expect(stressed.fee).toBeCloseTo(0.00075, 12);
    expect(stressed.slippage).toBeCloseTo(0.0004, 12);
  });

  it('charges each settlement in (open, next open] on the notional at the open; a short receives', () => {
    const flat = [100, 100, 100, 100];
    const settlements: Settlement[] = [];
    for (let t = D0; t <= D0 + 4 * DAY_MS; t += 8 * 3_600_000) settlements.push({ t, rate: 0.0001 });
    const long = runTrend(
      [input('A', flat, { settlements })],
      { A: paths(4, 1, 1, ON_CHANGE) },
      opts(from, D0 + 4 * DAY_MS)
    );
    // Three settlements a day: +8h, +16h and the next 00:00. The one at the fill's own 00:00 belongs to the day before.
    expect(long.funding[0]).toBeCloseTo(-0.0003, 12);
    expect(long.returns[0]).toBeCloseTo(-0.0003, 12);
    const short = runTrend(
      [input('A', flat, { settlements })],
      { A: paths(4, -1, 1, ON_CHANGE) },
      opts(from, D0 + 4 * DAY_MS)
    );
    expect(short.funding[0]).toBeCloseTo(0.0003, 12);
    expect(short.shortLeg[0]).toBeCloseTo(0.0003, 12);
  });

  it('a one-bar delay fills a day later at that day open', () => {
    const rising = input('A', [100, 105, 110, 110]);
    const now = runTrend([rising], { A: paths(4, 1, 1, ON_CHANGE) }, opts(from, D0 + 4 * DAY_MS));
    const late = runTrend([rising], { A: paths(4, 1, 1, ON_CHANGE) }, opts(from, D0 + 4 * DAY_MS, { delay: 1 }));
    expect(now.returns[0]).toBeCloseTo(0.05, 12);
    expect(late.returns[0]).toBe(0);
    expect(late.returns[1]).toBeCloseTo(110 / 105 - 1, 12);
  });

  it('holds quantity between decisions, so the exposure drifts with price', () => {
    const decide = (i: number) => i === 0;
    const run = runTrend([a], { A: paths(5, 1, 0.5, { kind: 'on-decision' }, decide) }, opts(from, to));
    expect(run.turnover[0]).toBeCloseTo(0.5, 12);
    expect(run.turnover.slice(1)).toEqual([0, 0, 0]);
    // Quantity 0.005 after the fill: day 2 earns 0.005 x 10 on equity 1.
    expect(run.returns[1]).toBeCloseTo(0.05, 12);
    // Gross at the close is the drifted 0.55 over 1.05.
    expect(run.gross[1]).toBeCloseTo(0.55 / 1.05, 12);
  });

  it('on-signal-change ignores a size change; band trades a volatility-only change only past 20%', () => {
    const flat = input('A', [100, 100, 100, 100, 100]);
    const sizes = [1, 1, 1.1, 1.1, 1.5];
    const onChange = runTrend([flat], { A: paths(5, 1, sizes, ON_CHANGE) }, opts(from, to));
    expect(onChange.turnover.filter((x) => x > 0)).toHaveLength(1);
    const band = runTrend([flat], { A: paths(5, 1, sizes, { kind: 'band', band: 0.2 }) }, opts(from, to));
    // The entry trades on day 1 and the 10% resize is held back. The 1.5 target is decided at close 4,
    // so it would fill on day 5, outside this window.
    expect(band.turnover.filter((x) => x > 0)).toHaveLength(1);
    const wider = input('A', [100, 100, 100, 100, 100, 100]);
    const bandWide = runTrend(
      [wider],
      { A: paths(6, 1, [1, 1, 1.1, 1.1, 1.5, 1.5], { kind: 'band', band: 0.2 }) },
      opts(from, D0 + 6 * DAY_MS)
    );
    // Measured against the HELD weight 1.0 (the 1.1 never traded): 50% > 20%, so it trades 0.5.
    expect(bandWide.turnover[4]).toBeCloseTo(0.5, 12);
    expect(bandWide.turnover.filter((x) => x > 0)).toHaveLength(2);
  });

  it('a signal change trades at once in band mode, whatever its size', () => {
    const flat = input('A', [100, 100, 100, 100, 100]);
    const run = runTrend([flat], { A: paths(5, [1, 1, 8 / 9, 8 / 9, 8 / 9], 1, { kind: 'band', band: 0.2 }) }, opts(from, to));
    expect(run.turnover[2]).toBeCloseTo(1 / 9, 12);
  });
});

describe('runTrend, sleeves', () => {
  it('a sleeve joins at its listing day and every sleeve is re-equalised, paying for the turnover', () => {
    const a = input('A', [100, 100, 110, 121, 121, 121]);
    const b = input('B', [50, 50, 50, 50, 50, 50], { listing: D0 + 4 * DAY_MS });
    const p = { A: paths(6, 1, 1, ON_CHANGE), B: paths(6, 1, 1, ON_CHANGE) };
    const run = runTrend([a, b], p, opts(D0 + DAY_MS, D0 + 6 * DAY_MS));
    expect(run.startDay).toEqual({ A: D0 + DAY_MS, B: D0 + 4 * DAY_MS });
    // A alone to 1.21; then each sleeve holds 0.605 at weight 1: A sells 0.605, B buys 0.605.
    expect(run.turnover[3]).toBeCloseTo(1.21 / 1.21, 12);
    expect(run.contributions.B[2]).toBe(0);
    expect(run.sleeveReturns.B[2]).toBeNaN();
    expect(run.returns[3]).toBe(0);
    const costly = runTrend([a, b], p, opts(D0 + DAY_MS, D0 + 6 * DAY_MS, { cost: { fee: 0.001, slippage: 0 } }));
    expect(costly.cost[3]).toBeGreaterThan(0.001 * 0.99);
  });

  it('re-equalises capital at each month end, keeping each sleeve weight', () => {
    // From 2024-01-29: A doubles by the close of the 31st, B stays flat.
    const start = Date.UTC(2024, 0, 28);
    const a = input('A', [100, 100, 150, 200, 200, 200], { start, listing: start + DAY_MS });
    const b = input('B', [10, 10, 10, 10, 10, 10], { start, listing: start + DAY_MS });
    const p = { A: paths(6, 1, 1, ON_CHANGE), B: paths(6, 1, 1, ON_CHANGE) };
    const run = runTrend([a, b], p, opts(start + DAY_MS, start + 6 * DAY_MS));
    // Equity 1.5 at the 31st's close: A sells 0.25, B buys 0.25, on 2024-02-01.
    const feb1 = run.days.indexOf(Date.UTC(2024, 1, 1));
    expect(run.turnover[feb1]).toBeCloseTo(0.5 / 1.5, 12);
    expect(run.turnover.filter((x) => x > 0)).toHaveLength(2);
  });

  it('assigns each day to an episode and records them when a position ends', () => {
    const closes = [100, 100, 110, 110, 99, 99];
    const run = runTrend(
      [input('A', closes)],
      { A: paths(6, [1, 1, 0, -1, -1, -1], 1, ON_CHANGE) },
      opts(D0 + DAY_MS, D0 + 6 * DAY_MS)
    );
    // Long over days 1-2 (+10%), flat, then short from day 4 (+10% on the fall).
    expect(run.episodes).toHaveLength(2);
    expect(run.episodes[0]).toBeCloseTo(0.1, 12);
    expect(run.episodes[1]).toBeCloseTo(0.1, 12);
  });
});

describe('assertDaily', () => {
  it('rejects a gap in the bars', () => {
    const gappy = input('A', [1, 2, 3]);
    gappy.t[2] += DAY_MS;
    expect(() => assertDaily(gappy)).toThrow(/gap/);
  });
});

describe('statistics', () => {
  it('circularBlockIndices takes fixed-length blocks from uniform starts, wrapping, cut to n', () => {
    const draws = [0.5, 0.0, 0.9];
    let k = 0;
    expect(circularBlockIndices(5, 2, () => draws[k++])).toEqual([2, 3, 0, 1, 4]);
  });

  it('olsAlphaBeta recovers an exact line; annualAlpha scales the intercept by 365', () => {
    const x = [0.01, -0.02, 0.03, 0];
    const y = x.map((v) => 0.001 + 0.5 * v);
    const fit = olsAlphaBeta(y, x);
    expect(fit.alpha).toBeCloseTo(0.001, 12);
    expect(fit.beta).toBeCloseTo(0.5, 12);
    expect(annualAlpha(y, x).alpha).toBeCloseTo(0.365, 10);
  });

  it('annualisedSharpe is mean over sample sd times sqrt(365)', () => {
    expect(annualisedSharpe([0.01, 0.03])).toBeCloseTo((0.02 / Math.sqrt(0.0002)) * Math.sqrt(365), 10);
    expect(annualisedSharpe([0.01, 0.01])).toBeNaN();
  });

  it('the bootstrap CIs bracket their point estimates and reproduce by seed', () => {
    let s = 1;
    const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.04;
    const twin = Array.from({ length: 400 }, noise);
    const t = twin.map((x) => 0.0005 + 0.6 * x + noise() * 0.2);
    const ci = sharpeCi(t, { blockLen: 60, iterations: 300 });
    expect(ci.low).toBeLessThanOrEqual(ci.point);
    expect(ci.high).toBeGreaterThanOrEqual(ci.point);
    expect(sharpeCi(t, { blockLen: 60, iterations: 300 })).toEqual(ci);
    const a = alphaCi(t, twin, { blockLen: 60, iterations: 300 });
    expect(a.point).toBeCloseTo(annualAlpha(t, twin).alpha, 12);
    expect(a.low).toBeLessThanOrEqual(a.point);
  });

  it('maxDrawdown compounds the returns', () => {
    expect(maxDrawdown([0.1, -0.5, 0.2])).toBeCloseTo(0.5, 12);
  });

  it('topEpisodeShare and losingStreak', () => {
    const eps = [0.5, -0.1, -0.1, -0.1, 0.05, 0.05, -0.05];
    const top = topEpisodeShare(eps, 0.15);
    // ceil(7 x 0.15) = 2 episodes: 0.5 + 0.05 of a 0.25 total.
    expect(top.share).toBeCloseTo(0.55 / 0.25, 12);
    const streak = losingStreak(eps);
    expect(streak.longest).toBe(3);
    expect(streak.lossRate).toBeCloseTo(4 / 7, 12);
    expect(streak.expected).toBeCloseTo(Math.log(7 * (3 / 7)) / Math.log(7 / 4), 12);
  });
});

describe('timing null', () => {
  it('shiftSignal rotates the decision span only', () => {
    const p = paths(5, [1, 2, 3, 4, 5], 1, ON_CHANGE);
    expect(Array.from(shiftSignal(p, 1, 3, 1).signal)).toEqual([1, 4, 2, 3, 5]);
    expect(shiftSignal(p, 1, 3, 1).size).toBe(p.size);
  });

  it('gives p = 1 when the rule cannot differ from its twin, and refuses a span too short to shift', () => {
    let s = 7;
    const closes = [100];
    for (let i = 1; i < 800; i++) closes.push(closes[i - 1] * (1 + ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.05));
    const a = input('A', closes);
    const o = opts(D0 + DAY_MS, D0 + 800 * DAY_MS);
    const always = { A: paths(800, 1, 1, ON_CHANGE) };
    const run = runTrend([a], always, o);
    const range = { first: 0, last: run.days.length - 1 };
    const result = timingNull([a], always, run.returns, 0, o, range, 5);
    expect(result.p).toBe(1);
    expect(result.draws).toBe(5);
    const short = input('A', closes.slice(0, 600));
    const os = opts(D0 + DAY_MS, D0 + 600 * DAY_MS);
    expect(() => timingNull([short], always, run.returns, 0, os, range, 5)).toThrow(/too short/);
  });
});
