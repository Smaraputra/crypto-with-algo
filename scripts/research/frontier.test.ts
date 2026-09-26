// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MAKER_ROUND_TRIP_PERCENT,
  RECORDED_CONTROL_SD_PERCENT,
  formatFrontier,
  frontierRow,
  leverageRows,
  liquidationDistancePercent,
  parseArgs,
  requiredIc,
  sdPerTradeFromCi,
  tradesPerDayOf,
  type FrontierInput,
} from './frontier';

const CONTROL_1H: FrontierInput = {
  family: 'control',
  interval: '1h',
  n: 7519,
  // Recorded Phase 4 control 1h: point -0.063, CI low -0.166, symmetric high.
  bootstrapCi95: [-0.166, 0.04],
  symbolsTotal: 10,
  // 7519 trades over 10 symbols x 6 windows x 686 bars is about 4.7 years.
  oosBars: 41160,
};

describe('sdPerTradeFromCi', () => {
  it('recovers the recorded 4.56% per trade for control at 1h', () => {
    expect(sdPerTradeFromCi(CONTROL_1H.bootstrapCi95, CONTROL_1H.n)).toBeCloseTo(4.56, 1);
  });
  it('is NaN without a CI or below n 2', () => {
    expect(sdPerTradeFromCi(null, 100)).toBeNaN();
    expect(sdPerTradeFromCi([-1, 1], 1)).toBeNaN();
  });
});

describe('requiredIc', () => {
  it('is gross over twice the per-trade sd, the program convention', () => {
    expect(requiredIc(0.16, 4.56)).toBeCloseTo(0.0175, 3);
    expect(requiredIc(0.04, 4.56)).toBeCloseTo(0.0044, 3);
  });
  it('is NaN for a non-positive sd', () => {
    expect(requiredIc(0.1, 0)).toBeNaN();
    expect(requiredIc(0.1, NaN)).toBeNaN();
  });
});

describe('tradesPerDayOf', () => {
  it('scales trades per symbol-day up to the universe', () => {
    // 240 bars at 1h is 10 days; 12 trades over 2 symbols: 1.2 per symbol-day, 2.4 per day.
    expect(tradesPerDayOf({ ...CONTROL_1H, n: 12, symbolsTotal: 2, oosBars: 240 })).toBeCloseTo(2.4, 10);
  });
  it('is NaN with no bars', () => {
    expect(tradesPerDayOf({ ...CONTROL_1H, oosBars: 0 })).toBeNaN();
  });
});

describe('frontierRow', () => {
  const row = frontierRow(CONTROL_1H, { notionalUsdt: 50, targetPerDayUsdt: 0.5, tradesPerDay: [10] });

  it('charges taker plus slippage as the taker bar and 0.04% as the maker bar', () => {
    expect(row.costTakerPercent).toBeCloseTo(0.16, 10);
    expect(row.costMakerPercent).toBeCloseTo(MAKER_ROUND_TRIP_PERCENT, 10);
    expect(MAKER_ROUND_TRIP_PERCENT).toBeCloseTo(0.04, 10);
  });

  it('adds the target per trade to the cost before converting to an IC', () => {
    // 0.5 USDT over 10 trades on 50 USDT is 0.10% net per trade.
    const target = row.targets[0];
    const sd = sdPerTradeFromCi(CONTROL_1H.bootstrapCi95, CONTROL_1H.n);
    expect(target.tradesPerDay).toBe(10);
    expect(target.icTaker).toBeCloseTo((0.1 + 0.16) / (2 * sd), 6);
    expect(target.icMaker).toBeCloseTo((0.1 + 0.04) / (2 * sd), 6);
  });
});

describe('formatFrontier', () => {
  it('prints a dash, not NaN, for a report without a bootstrap CI', () => {
    const row = frontierRow({ ...CONTROL_1H, bootstrapCi95: null }, { notionalUsdt: 50, targetPerDayUsdt: 0.5, tradesPerDay: [10] });
    const text = formatFrontier([row], { notionalUsdt: 50, targetPerDayUsdt: 0.5 });
    expect(text).not.toContain('NaN');
    expect(text).toContain('control');
    expect(text).toContain('-');
  });
});

describe('frontier parseArgs', () => {
  it('applies defaults and parses lists', () => {
    const args = parseArgs(['--reports', 'a.json,b.json']);
    expect(args.reports).toEqual(['a.json', 'b.json']);
    expect(args.notionalUsdt).toBe(50);
    expect(args.targetPerDayUsdt).toBe(0.5);
    expect(args.tradesPerDay).toEqual([4, 8, 20, 50]);
    expect(parseArgs(['--reports', 'a', '--notional', '100', '--target-per-day', '1', '--trades-per-day', '2,3']).tradesPerDay).toEqual([2, 3]);
  });
  it('throws without --reports', () => {
    expect(() => parseArgs([])).toThrow(/--reports/);
  });
  it('rejects an unknown flag rather than absorbing it as a no-op', () => {
    expect(() => parseArgs(['--reports', 'a', '--notionel', '100'])).toThrow('Unknown flag --notionel');
  });
  it('rejects a non-finite or non-positive notional, target and trades-per-day entry', () => {
    expect(() => parseArgs(['--reports', 'a', '--notional', 'abc'])).toThrow(/--notional/);
    expect(() => parseArgs(['--reports', 'a', '--notional', '0'])).toThrow(/--notional/);
    expect(() => parseArgs(['--reports', 'a', '--notional', '-50'])).toThrow(/--notional/);
    expect(() => parseArgs(['--reports', 'a', '--target-per-day', '0'])).toThrow(/--target-per-day/);
    expect(() => parseArgs(['--reports', 'a', '--target-per-day', 'x'])).toThrow(/--target-per-day/);
    expect(() => parseArgs(['--reports', 'a', '--trades-per-day', '4,0,20'])).toThrow(/--trades-per-day/);
    expect(() => parseArgs(['--reports', 'a', '--trades-per-day', '4,x'])).toThrow(/--trades-per-day/);
    expect(() => parseArgs(['--reports', 'a', '--trades-per-day', '4,-8'])).toThrow(/--trades-per-day/);
  });
});

describe('profiles block', () => {
  it('prices the same row under standard, bnb and the promotion for BTCUSDT', () => {
    const row = frontierRow(CONTROL_1H, { notionalUsdt: 50, targetPerDayUsdt: 0.5, tradesPerDay: [8], feeProfile: 'standard' });
    const byName = Object.fromEntries(row.profiles.map((p) => [p.profile, p]));
    expect(byName.standard.costTakerPercent).toBeCloseTo(0.16, 10);
    expect(byName.bnb.costTakerPercent).toBeCloseTo(0.15, 10);
    expect(byName['promo-btc-eth-2026-07'].costTakerPercent).toBeCloseTo(0.132, 10);
    expect(byName['promo-btc-eth-2026-07'].costMakerPercent).toBe(0);
    expect(byName['promo-btc-eth-2026-07'].breakevenIcMaker).toBe(0);
    expect(byName.standard.breakevenIcTaker).toBeCloseTo(0.0175, 3);
  });
});

describe('leverage arithmetic', () => {
  it('scales the round trip with notional, not with edge', () => {
    const rows = leverageRows(100, [1, 10, 20], 0.072);
    expect(rows[1]).toEqual({ leverage: 10, notionalUsdt: 1000, costUsdt: 0.72, costPercentOfAccount: 0.72 });
    expect(rows[2].costPercentOfAccount).toBeCloseTo(1.44, 10);
  });
  it('liquidation distance is 1/L minus the maintenance margin, in percent', () => {
    expect(liquidationDistancePercent(20)).toBeCloseTo(4.6, 10);
    expect(liquidationDistancePercent(50, 0.005)).toBeCloseTo(1.5, 10);
  });
});

it('parseArgs takes --fee-profile and rejects an unknown one', () => {
  expect(parseArgs(['--reports', 'a.json']).feeProfile).toBe('standard');
  expect(parseArgs(['--reports', 'a.json', '--fee-profile', 'bnb']).feeProfile).toBe('bnb');
  expect(() => parseArgs(['--reports', 'a.json', '--fee-profile', 'vip9'])).toThrow(/Unknown --fee-profile/);
});

it('RECORDED_CONTROL_SD_PERCENT carries the five recorded intervals', () => {
  expect(RECORDED_CONTROL_SD_PERCENT).toEqual({ '5m': 0.78, '15m': 2.04, '1h': 4.56, '4h': 9.21, '1d': 15.92 });
});
