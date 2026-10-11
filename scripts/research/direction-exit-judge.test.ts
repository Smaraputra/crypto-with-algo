import { describe, expect, it } from 'vitest';
import {
  anatolyevGerko,
  condFor,
  judgeConfiguration,
  mfeCapture,
  neweyWestT,
  pickBest,
  tradesOf,
  type NamedReport,
} from './direction-exit-judge';

const DAY = 86_400_000;
const t2025 = Date.UTC(2025, 2, 1);
const t2026 = Date.UTC(2026, 2, 1);
function report(pnls: Array<[number, number]>, gates: Array<{ name: string; pass: boolean }> = []) {
  return {
    perSymbol: [{ symbol: 'BTCUSDT', windows: [{ trades: pnls.map(([exitTime, p], i) => ({ entryTime: exitTime - DAY, exitTime, side: i % 2 ? 'short' : 'long', pnlPercent: p, exitReason: 'time_stop', holdTimeBars: 24 })) }] }],
    gates: gates.map((g) => ({ ...g, value: null, threshold: 0 })),
  };
}

describe('tradesOf', () => {
  it('flattens per-symbol windows in exit order with the symbol attached', () => {
    const r = report([[t2026, 1], [t2025, -1]]);
    expect(tradesOf(r).map((t) => [t.symbol, t.exitTime])).toEqual([['BTCUSDT', t2025], ['BTCUSDT', t2026]]);
  });
});

describe('pickBest', () => {
  it('takes the highest expectancy that clears the trade and coverage floors', () => {
    const runs = [
      { key: 'C1', expectancy: 0.5, trades: 50, coverage: 0.5 },
      { key: 'C2', expectancy: 0.2, trades: 400, coverage: 0.2 },
      { key: 'C3', expectancy: 0.1, trades: 400, coverage: 0.6 },
      { key: 'C4', expectancy: 0.1, trades: 400, coverage: 0.7 },
    ];
    expect(pickBest(runs, { minCoverage: 0.3 })).toBe('C4');
    expect(() => pickBest([{ key: 'x', expectancy: 1, trades: 10 }], {})).toThrow();
  });
});

describe('judgeConfiguration', () => {
  it('fails a configuration whose 2026 part has no trades, never passing on NaN', () => {
    const pnls: Array<[number, number]> = Array.from({ length: 300 }, (_, i) => [t2025 + i * 3_600_000, 0.5]);
    const v = judgeConfiguration({ config: 'dx-d0 1h E1', report: report(pnls), varianceOfTrialSharpes: 0.01, numTrials: 2135 });
    expect(v.pass).toBe(false);
    expect(v.failed).toContain('part:2026');
  });

  it('carries a failed harness gate but ignores the inert trials gate', () => {
    const pnls: Array<[number, number]> = Array.from({ length: 300 }, (_, i) => [(i % 2 ? t2025 : t2026) + i * 3_600_000, 0.5]);
    const v = judgeConfiguration({ config: 'x', report: report(pnls, [{ name: 'symbols', pass: false }, { name: 'trials', pass: false }]), varianceOfTrialSharpes: 0.0001, numTrials: 2135 });
    expect(v.failed).toContain('symbols');
    expect(v.failed).not.toContain('trials');
  });

  it('fails the Bonferroni gate when the interval reaches zero', () => {
    const pnls: Array<[number, number]> = Array.from({ length: 300 }, (_, i) => [(i % 2 ? t2025 : t2026) + i * 3_600_000, i % 2 ? 1 : -0.9]);
    expect(judgeConfiguration({ config: 'x', report: report(pnls), varianceOfTrialSharpes: 0.01, numTrials: 2135 }).failed).toContain('bonferroni');
  });

  it('fills the reported statistics without letting them gate', () => {
    const pnls: Array<[number, number]> = Array.from({ length: 10 }, (_, i) => [t2025 + i * 3_600_000, i % 3 === 0 ? -1 : 2]);
    const v = judgeConfiguration({ config: 'x', report: report(pnls), varianceOfTrialSharpes: 0.01, numTrials: 2135, exit: 1 });
    expect(v.reported.winRate).toBeCloseTo(0.6, 10);
    expect(v.reported.avgWin).toBe(2);
    expect(v.reported.avgLoss).toBe(-1);
    expect(v.reported['exitReason:time_stop']).toBe(10);
    expect(v.reported.protectiveStops).toBe(0);
    expect(v.reported.mfeCapture).toBeNull();
  });
});

describe('neweyWestT', () => {
  const x = [0, 0, 1, 1];
  const y = [0, 1, 1, 1];
  it('matches the hand-computed lag 0 t (sqrt 2)', () => {
    expect(neweyWestT(x, y, 0)).toBeCloseTo(Math.SQRT2, 10);
  });
  it('applies the Bartlett weight at lag 1 (t = 2)', () => {
    expect(neweyWestT(x, y, 1)).toBeCloseTo(2, 10);
  });
  it('is null for a constant regressor', () => {
    expect(neweyWestT([1, 1, 1, 1], y, 1)).toBeNull();
  });
});

describe('anatolyevGerko', () => {
  it('is the mean over its standard error (2 * sqrt 3 for 1, 2, 3)', () => {
    expect(anatolyevGerko([1, 2, 3])).toBeCloseTo(2 * Math.sqrt(3), 10);
    expect(anatolyevGerko([1])).toBeNull();
  });
});

describe('mfeCapture', () => {
  it('measures the exit-bar close move over the best excursion, direction-signed', () => {
    const candles = {
      BTCUSDT: [
        { t: 0, o: 100, h: 104, l: 99, c: 102, v: 1, tbv: null },
        { t: 1, o: 102, h: 110, l: 101, c: 105, v: 1, tbv: null },
      ],
    };
    const trade = { symbol: 'BTCUSDT', entryTime: 0, exitTime: 1, side: 'long' as const, pnlPercent: 4, exitReason: 'time_stop' };
    expect(mfeCapture([trade], candles)).toBeCloseTo(5 / 10, 10);
    const flat = { ...trade, side: 'short' as const };
    // short MFE = (100 - 99) / 100 = 1%, exit move = (100 - 105) / 100 < 0
    expect(mfeCapture([flat], candles)).toBeCloseTo(-5, 10);
  });
});

describe('condFor', () => {
  const named = (family: string, interval: '1h' | '4h', cond: number, n: number, pnl: number): NamedReport => ({
    file: `${family}-${interval}-c${cond}-e1-k1.json`,
    family,
    interval,
    cond,
    exit: 1,
    k: 1,
    report: null,
    trades: Array.from({ length: n }, (_, i) => ({
      symbol: 'BTCUSDT',
      entryTime: i,
      exitTime: i + 1,
      side: 'long' as const,
      pnlPercent: pnl,
      exitReason: 'time_stop',
    })),
  });

  it('applies the trade floor and the coverage floor against the D0 E1 trade count, per interval', () => {
    const reports = [
      named('dx-d0', '1h', 0, 500, 0),
      named('dx-d2', '1h', 1, 90, 1.0), // best expectancy, but under 100 trades
      named('dx-d2', '1h', 2, 120, 0.9), // coverage 0.24 < 0.3
      named('dx-d2', '1h', 3, 150, 0.4), // coverage 0.30, qualifies
      named('dx-d2', '1h', 4, 300, 0.1),
      named('dx-d0', '4h', 0, 200, 0),
      named('dx-d2', '4h', 1, 100, 0.2),
      named('dx-d2', '4h', 2, 150, 0.3),
      named('dx-d2', '4h', 3, 120, -0.1),
      named('dx-d2', '4h', 4, 110, 0.25),
    ];
    expect(condFor(reports, '1h')).toBe(3);
    expect(condFor(reports, '4h')).toBe(2);
  });

  it('throws without a D0 E1 report', () => {
    expect(() => condFor([named('dx-d2', '1h', 1, 200, 1)], '1h')).toThrow();
  });
});
