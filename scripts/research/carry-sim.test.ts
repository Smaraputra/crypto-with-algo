// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  BAR_MS,
  CARRY_COST_MAKER,
  CARRY_COST_TAKER,
  CARRY_TRIALS,
  DAY_MS,
  HOUR_MS,
  R1_GRID,
  annualised,
  barReturns,
  carryWindows,
  dailySums,
  feasibility,
  leverageTable,
  runBook,
  shiftWeights,
  trailingFundingAnnual,
  walkForward,
  weightPath,
  windowBars,
  type CarrySymbolInput,
  type Settlement,
} from './carry-sim';

const T0 = Date.UTC(2024, 0, 1);

/** A flat-price symbol on hourly bars, settling `rate` every `everyHours`. */
function flatSymbol(
  bars: number,
  rate: number,
  everyHours = 8,
  opts: { symbol?: string; price?: number; start?: number } = {}
): CarrySymbolInput {
  const start = opts.start ?? T0;
  const price = opts.price ?? 100;
  const t = Array.from({ length: bars }, (_, i) => start + i * HOUR_MS);
  const settlements: Settlement[] = [];
  for (let s = start; s <= start + (bars + 1) * HOUR_MS; s += everyHours * HOUR_MS) settlements.push({ t: s, rate });
  return {
    symbol: opts.symbol ?? 'BTCUSDT',
    t,
    spotClose: t.map(() => price),
    perpClose: t.map(() => price),
    perpHigh: t.map(() => price),
    settlements,
  };
}

describe('costs', () => {
  it('prices a side at spot taker plus perp taker plus 3 bps a leg, a round trip at 0.42%', () => {
    expect(CARRY_COST_TAKER.perSide).toBeCloseTo(0.001 + 0.0005 + 2 * 0.0003, 12);
    expect(2 * CARRY_COST_TAKER.perSide).toBeCloseTo(0.0042, 12);
    expect(CARRY_COST_MAKER.perSide).toBeCloseTo(0.001 + 0.0002, 12);
  });
  it('declares seven trials: R0 and six R1 cells', () => {
    expect(R1_GRID).toHaveLength(6);
    expect(CARRY_TRIALS).toBe(7);
  });
});

describe('trailingFundingAnnual', () => {
  it('annualises three settlements a day in calendar time', () => {
    const input = flatSymbol(24 * 10, 0.0001);
    const f = trailingFundingAnnual(input, 3);
    // Ten days in, a 3-day window holds 9 settlements: 9 x 0.0001 x 365 / 3.
    expect(f[24 * 10 - 1]).toBeCloseTo((9 * 0.0001 * 365) / 3, 10);
  });
  it('counts every settlement of a symbol on a 2h interval', () => {
    const f8 = trailingFundingAnnual(flatSymbol(24 * 10, 0.0001, 8), 3);
    const f2 = trailingFundingAnnual(flatSymbol(24 * 10, 0.0001, 2), 3);
    expect(f2[24 * 10 - 1]).toBeCloseTo(4 * f8[24 * 10 - 1], 10);
  });
  it('reads nothing after a bar close', () => {
    const input = flatSymbol(48, 0);
    // A huge settlement one hour after bar 10's close must not reach bar 10.
    input.settlements.push({ t: input.t[10] + BAR_MS + HOUR_MS, rate: 1 });
    input.settlements.sort((a, b) => a.t - b.t);
    const f = trailingFundingAnnual(input, 3);
    expect(f[10]).toBe(0);
    expect(f[11]).toBeGreaterThan(0);
  });
});

describe('settlement placement', () => {
  it('a settlement at exactly the entry close is not collected; one at the next close is', () => {
    // One settlement exactly at bar 5's close, one at bar 6's close.
    const input = flatSymbol(20, 0);
    input.settlements = [
      { t: input.t[5] + BAR_MS, rate: 0.01 },
      { t: input.t[6] + BAR_MS, rate: 0.02 },
    ];
    const w = new Float64Array(20);
    w[5] = 1; // decided at bar 5's close, held over (close_5, close_6]
    const r = barReturns(input, w, 5, 7, { name: 'free', perSide: 0 });
    expect(r.funding[5]).toBeCloseTo(0.02, 12);
  });

  it('a short perp RECEIVES a positive rate and PAYS a negative one', () => {
    const pos = barReturns(flatSymbol(30, 0.001), weightPath(flatSymbol(30, 0.001), { kind: 'always' }, 0, 29), 0, 29, {
      name: 'free',
      perSide: 0,
    });
    const neg = barReturns(flatSymbol(30, -0.001), weightPath(flatSymbol(30, -0.001), { kind: 'always' }, 0, 29), 0, 29, {
      name: 'free',
      perSide: 0,
    });
    const sum = (a: Float64Array) => a.reduce((s, v) => s + v, 0);
    expect(sum(pos.funding)).toBeGreaterThan(0);
    expect(sum(neg.funding)).toBeLessThan(0);
  });

  it('earns spot minus perp: a basis that widens against the hedge loses', () => {
    const input = flatSymbol(4, 0);
    input.perpClose = [100, 101, 101, 101]; // perp rises 1%, spot flat
    const w = weightPath(input, { kind: 'always' }, 0, 3);
    const r = barReturns(input, w, 0, 3, { name: 'free', perSide: 0 });
    expect(r.net[0]).toBeCloseTo(-0.01, 12);
  });
});

describe('weightPath', () => {
  it('starts flat and ends flat for both rules', () => {
    const input = flatSymbol(100, 0.001);
    for (const rule of [{ kind: 'always' } as const, R1_GRID[0]]) {
      const w = weightPath(input, rule, 10, 90);
      expect(w[9]).toBe(0);
      expect(w[90]).toBe(0);
    }
  });
  it('R1 enters above the threshold and leaves only below zero', () => {
    const input = flatSymbol(24 * 20, 0.0001); // 10.95% a year
    const enters = weightPath(input, { kind: 'hysteresis', lookbackDays: 3, enterAnnual: 0.05 }, 0, 24 * 20 - 1);
    const never = weightPath(input, { kind: 'hysteresis', lookbackDays: 3, enterAnnual: 0.2 }, 0, 24 * 20 - 1);
    expect(enters.some((v) => v === 1)).toBe(true);
    expect(never.every((v) => v === 0)).toBe(true);
  });
});

describe('booking and the book', () => {
  it('charges a side on entry and a side on exit, the exit inside the window', () => {
    const input = flatSymbol(48, 0);
    const { from, to } = windowBars(input, T0, T0 + DAY_MS);
    const w = weightPath(input, { kind: 'always' }, from, to);
    const r = barReturns(input, w, from, to, CARRY_COST_TAKER);
    const total = [...dailySums(input, r, from, to).values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(-2 * CARRY_COST_TAKER.perSide, 12);
    // Every booking lands on the window's one day.
    expect([...dailySums(input, r, from, to).keys()]).toEqual([T0]);
  });

  it('takes the mean over all symbols, so an idle symbol halves a two-symbol book', () => {
    const paying = flatSymbol(24 * 3, 0.001, 8, { symbol: 'AAAUSDT' });
    const flatFunding = flatSymbol(24 * 3, 0, 8, { symbol: 'BBBUSDT' });
    const free = { name: 'free', perSide: 0 };
    const one = runBook([paying], { kind: 'always' }, T0, T0 + 3 * DAY_MS, free);
    const two = runBook([paying, flatFunding], { kind: 'always' }, T0, T0 + 3 * DAY_MS, free);
    expect(annualised(two.daily)).toBeCloseTo(annualised(one.daily) / 2, 10);
  });
});

describe('carryWindows', () => {
  it('lays out seven six-month test windows from 2023 to mid-2026, each trained on the year before', () => {
    const windows = carryWindows();
    expect(windows).toHaveLength(7);
    expect(windows[0]).toMatchObject({
      testFrom: Date.UTC(2023, 0, 1),
      testTo: Date.UTC(2023, 6, 1),
      trainFrom: Date.UTC(2022, 0, 1),
      trainTo: Date.UTC(2023, 0, 1),
    });
    expect(windows[6]).toMatchObject({ testFrom: Date.UTC(2026, 0, 1), testTo: Date.UTC(2026, 6, 1) });
  });
});

describe('walkForward', () => {
  it('selects an R1 cell per window on the training span and runs both rules on the test span', () => {
    const input = flatSymbol(24 * 120, 0.0002, 8, { start: Date.UTC(2023, 0, 1) });
    const windows = [
      {
        trainFrom: Date.UTC(2023, 0, 1),
        trainTo: Date.UTC(2023, 1, 1),
        testFrom: Date.UTC(2023, 1, 1),
        testTo: Date.UTC(2023, 2, 1),
      },
    ];
    const [w] = walkForward([input], CARRY_COST_TAKER, windows);
    expect(R1_GRID).toContainEqual(w.r1Selected);
    expect(w.r0.daily.length).toBe(28);
    // 21.9% a year of funding against two sides of cost: R0 is positive.
    expect(annualised(w.r0.daily)).toBeGreaterThan(0);
  });
});

describe('shiftWeights', () => {
  it('rotates the held bars inside the window and keeps the duty cycle', () => {
    const w = new Float64Array([0, 1, 1, 0, 0, 1, 0, 0]);
    const s = shiftWeights(w, 1, 7, 2);
    const count = (a: Float64Array) => a.reduce((n, v) => n + v, 0);
    expect(count(s)).toBe(count(w));
    expect(s[0]).toBe(0);
    expect(s[7]).toBe(0);
  });
});

describe('leverageTable', () => {
  it('liquidates nothing at 1x and a 2% spike at 50x', () => {
    const input = flatSymbol(24 * 5, 0.0001, 8, { start: Date.UTC(2023, 0, 1) });
    input.perpHigh[50] = 102; // +2% inside one bar
    const windows = walkForward([input], CARRY_COST_TAKER, [
      {
        trainFrom: Date.UTC(2023, 0, 1),
        trainTo: Date.UTC(2023, 0, 2),
        testFrom: Date.UTC(2023, 0, 1),
        testTo: Date.UTC(2023, 0, 5),
      },
    ]);
    const rows = leverageTable([input], windows, 'r0', CARRY_COST_TAKER);
    const at = (l: number) => rows.find((r) => r.leverage === l)!;
    expect(at(1).liquidations).toBe(0);
    expect(at(50).liquidations).toBe(1);
    expect(at(50).worstAdverseMove).toBeCloseTo(0.02, 10);
    // Without a liquidation, leverage only rescales the same notional return by
    // the capital it ties up: return on capital x (1 + 1/L) is one number.
    expect(at(1).annualOnCapital * 2).toBeCloseTo(at(10).annualOnCapital * 1.1, 10);
    expect(at(10).liquidations).toBe(0);
  });
});

describe('feasibility', () => {
  it('needs a perp lot that clears the minimum notional after rounding down', () => {
    const btc = { stepSize: 0.001, minQty: 0.001, minNotional: 50 };
    expect(feasibility('BTCUSDT', 60000, 100, btc, 10).feasibleSingle).toBe(false);
    const row = feasibility('BTCUSDT', 60000, 1000, btc, 10);
    expect(row.notionalSingle).toBe(500);
    expect(row.feasibleSingle).toBe(true);
    expect(row.feasibleInBook).toBe(false);
  });
});
