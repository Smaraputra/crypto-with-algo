// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createSeededRandom } from '@/lib/stats/seeded-random';
import { broadOptions } from './broad-harness';
import {
  FLOW_CALENDAR,
  MIN_SHIFT_WEEKS,
  alignedSource,
  alignedValueAt,
  contractFlowSeries,
  dailyOrderFlow,
  decisionCloses,
  firstPositionIndex,
  flowNull,
  flowSchedule,
  flowSimOptions,
  flowValues,
  isFridayBar,
  isSaturdayClose,
  lagValueAt,
  nullP,
  nullShift,
  orthogonalise,
  permuteSections,
  plainValueAt,
  quintileSignals,
  rankBook,
  sectionsOf,
  standardise,
  weekFriday,
  weeklyOrderFlow,
  wholeWeeks,
  type FlowInputs,
  type PanelEntry,
  type Section,
} from './broad-flow';
import { flowInputsOf, flowUniverse, plantedUniverse } from './broad-flow-fixtures';
import type { PerpCandleRow } from './dataset-format';
import { DAY_MS } from './trend-signals';
import {
  MIN_SHIFT_DAYS,
  NULL_CALENDAR_DAYS,
  olsAlphaBeta,
  runTrend,
  type SimOptions,
  type TrendRun,
  type TrendSymbolInput,
} from './trend-sim';

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const row = (t: number, o: { v?: number; tbv?: number | null; c?: number } = {}): PerpCandleRow => {
  const c = o.c ?? 100;
  const v = o.v ?? 10;
  return { t, o: c, h: c, l: c, c, v, qv: v * c, n: 1, tbv: o.tbv === undefined ? v / 2 : o.tbv };
};

describe('calendar', () => {
  it('weeks run Saturday to Friday: a Saturday bar belongs to the following Friday, a Friday bar ends its week', () => {
    // 2024-01-05 is a Friday, 2024-01-06 a Saturday.
    expect(isFridayBar(utc(2024, 1, 5))).toBe(true);
    expect(weekFriday(utc(2024, 1, 5))).toBe(utc(2024, 1, 5));
    expect(weekFriday(utc(2024, 1, 6))).toBe(utc(2024, 1, 12));
    expect(weekFriday(utc(2024, 1, 11))).toBe(utc(2024, 1, 12));
    // The Friday bar closes at Saturday 00:00, the weekly decision close.
    expect(isSaturdayClose(utc(2024, 1, 5) + DAY_MS)).toBe(true);
    expect(isSaturdayClose(utc(2024, 1, 5))).toBe(false);
  });

  it('the null calendar holds S = 2,373 days and S_w = 338 whole weeks, Friday 2020-01-10 to Friday 2026-06-26', () => {
    expect(NULL_CALENDAR_DAYS).toBe(2373);
    expect(FLOW_CALENDAR.weeks).toEqual({ firstFriday: utc(2020, 1, 10), weeks: 338 });
    expect(FLOW_CALENDAR.weeks.firstFriday + 337 * 7 * DAY_MS).toBe(utc(2026, 6, 26));
    // A calendar starting on a Saturday and ending on a Friday is whole weeks only.
    expect(wholeWeeks(utc(2024, 1, 6), 14)).toEqual({ firstFriday: utc(2024, 1, 12), weeks: 2 });
    expect(wholeWeeks(utc(2024, 1, 7), 13)).toEqual({ firstFriday: utc(2024, 1, 19), weeks: 1 });
  });

  it('decision closes: every 00:00 close daily, every Saturday 00:00 weekly, from <= close < to', () => {
    const from = utc(2024, 1, 1);
    expect(decisionCloses('daily', from, utc(2024, 1, 4))).toEqual([utc(2024, 1, 1), utc(2024, 1, 2), utc(2024, 1, 3)]);
    expect(decisionCloses('weekly', from, utc(2024, 1, 21))).toEqual([utc(2024, 1, 6), utc(2024, 1, 13), utc(2024, 1, 20)]);
    expect(decisionCloses('weekly', utc(2024, 1, 6), utc(2024, 1, 13))).toEqual([utc(2024, 1, 6)]);
  });
});

describe('dailyOrderFlow (header SIGNALS, notes F1 and F2)', () => {
  const d0 = utc(2024, 1, 1);
  it('of = ln(taker-buy base volume) - ln(base volume - taker-buy base volume)', () => {
    const [day] = dailyOrderFlow([row(d0, { v: 10, tbv: 7 })]);
    expect(day.buy).toBe(7);
    expect(day.sell).toBe(3);
    expect(day.of).toBeCloseTo(Math.log(7) - Math.log(3), 15);
    expect(day.logReturn).toBeUndefined();
  });

  it('is undefined when tbv is null, 0, equal to v, above v or negative; a zero-volume bar is not a traded day', () => {
    const days = dailyOrderFlow([
      row(d0, { tbv: null }),
      row(d0 + DAY_MS, { v: 10, tbv: 0 }),
      row(d0 + 2 * DAY_MS, { v: 10, tbv: 10 }),
      row(d0 + 3 * DAY_MS, { v: 10, tbv: 11 }),
      row(d0 + 4 * DAY_MS, { v: 10, tbv: -1 }),
      row(d0 + 5 * DAY_MS, { v: 0, tbv: 0 }),
      row(d0 + 6 * DAY_MS, { v: 10, tbv: 1e-9 }),
    ]);
    expect(days.map((d) => d.t)).toEqual([0, 1, 2, 3, 4, 6].map((k) => d0 + k * DAY_MS));
    expect(days.map((d) => d.of === undefined)).toEqual([true, true, true, true, true, false]);
    // Known but one-sided volumes: buy 0 or sell 0 are known (they enter a week's sums).
    expect([days[1].buy, days[1].sell, days[2].buy, days[2].sell]).toEqual([0, 10, 10, 0]);
    // Unknown: null, above v, negative.
    expect([days[0].buy, days[3].buy, days[4].buy]).toEqual([undefined, undefined, undefined]);
  });

  it('the log return is over the previous traded day, skipping a zero-volume day', () => {
    const days = dailyOrderFlow([row(d0, { c: 100 }), row(d0 + DAY_MS, { v: 0, c: 100 }), row(d0 + 2 * DAY_MS, { c: 110 })]);
    expect(days).toHaveLength(2);
    expect(days[1].logReturn).toBeCloseTo(Math.log(1.1), 15);
  });
});

describe('weeklyOrderFlow (header SIGNALS, note F3)', () => {
  // Saturday 2024-01-06 to Friday 2024-01-12 is one week; the next runs to Friday 2024-01-19.
  const sat = utc(2024, 1, 6);
  const day = (k: number) => sat + k * DAY_MS;

  it('sums the week\'s buy and sell base volume, Saturday to Friday, and needs at least 5 traded days', () => {
    const rows = [0, 1, 2, 3, 4, 5, 6].map((k) => row(day(k), { v: 10, tbv: 4 + (k === 6 ? 2 : 0) }));
    const [w] = weeklyOrderFlow(rows);
    expect(w.friday).toBe(day(6));
    expect(w.tradedDays).toBe(7);
    expect(w.buy).toBe(30);
    expect(w.sell).toBe(40);
    expect(w.of).toBeCloseTo(Math.log(30) - Math.log(40), 15);
    // Five traded days (two zero-volume days) still define the week; four do not.
    const five = rows.map((r, k) => (k === 1 || k === 2 ? { ...r, v: 0 } : r));
    expect(weeklyOrderFlow(five)[0]).toMatchObject({ tradedDays: 5 });
    expect(weeklyOrderFlow(five)[0].of).toBeDefined();
    const four = rows.map((r, k) => (k <= 2 ? { ...r, v: 0 } : r));
    expect(weeklyOrderFlow(four)[0].tradedDays).toBe(4);
    expect(weeklyOrderFlow(four)[0].of).toBeUndefined();
  });

  it('a day with zero buy volume does not void its week; an unknown buy volume does', () => {
    const rows = [0, 1, 2, 3, 4, 5, 6].map((k) => row(day(k), { v: 10, tbv: k === 3 ? 0 : 5 }));
    expect(weeklyOrderFlow(rows)[0].of).toBeCloseTo(Math.log(30) - Math.log(40), 15);
    const unknown = rows.map((r, k) => (k === 3 ? { ...r, tbv: null } : r));
    expect(weeklyOrderFlow(unknown)[0].of).toBeUndefined();
    expect(weeklyOrderFlow(unknown)[0].buy).toBeUndefined();
  });

  it('aligns weeks to Saturday 00:00 and returns the week\'s log return over the previous week\'s last close', () => {
    // Start on a Wednesday: the first week holds three days (Wed to Fri) and has no flow and no return.
    const wed = utc(2024, 1, 3);
    const rows = Array.from({ length: 17 }, (_, k) => row(wed + k * DAY_MS, { c: 100 + k }));
    const weeks = weeklyOrderFlow(rows);
    expect(weeks.map((w) => w.friday)).toEqual([utc(2024, 1, 5), utc(2024, 1, 12), utc(2024, 1, 19)]);
    expect(weeks.map((w) => w.tradedDays)).toEqual([3, 7, 7]);
    expect(weeks[0].of).toBeUndefined();
    expect(weeks[0].logReturn).toBeUndefined();
    expect(weeks[1].close).toBe(109);
    expect(weeks[1].logReturn).toBeCloseTo(Math.log(109 / 102), 15);
    expect(weeks[2].logReturn).toBeCloseTo(Math.log(116 / 109), 15);
  });

  it('a week whose Friday is missing closes at its last traded day; a week with no traded day carries the close', () => {
    const rows = [
      ...[0, 1, 2, 3, 4, 5].map((k) => row(day(k), { c: 100 + k })),
      // The whole next week is missing; trading resumes on Saturday two weeks on.
      ...[14, 15, 16, 17, 18, 19, 20].map((k) => row(day(k), { c: 200 })),
    ];
    const weeks = weeklyOrderFlow(rows);
    expect(weeks.map((w) => [w.tradedDays, w.close])).toEqual([
      [6, 105],
      [0, 105],
      [7, 200],
    ]);
    expect(weeks[1].logReturn).toBe(0);
    expect(weeks[2].logReturn).toBeCloseTo(Math.log(200 / 105), 15);
  });
});

describe('standardise (header SIGNALS, note F4)', () => {
  const series = Array.from({ length: 40 }, (_, i) => Math.sin(i) + (i % 3));

  it('OF = of / the sample sd over the trailing 30 periods, the current included', () => {
    const out = standardise(series);
    const window = series.slice(10, 40);
    const mean = window.reduce((a, b) => a + b, 0) / 30;
    const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / 29);
    expect(out[39]).toBeCloseTo(series[39] / sd, 12);
    // A value 30 periods back is outside the window; 29 back is inside.
    const moved30 = [...series];
    moved30[9] = 100;
    expect(standardise(moved30)[39]).toBe(out[39]);
    const moved29 = [...series];
    moved29[10] = 100;
    expect(standardise(moved29)[39]).not.toBe(out[39]);
  });

  it('needs 20 defined periods in the window, skips undefined ones, and is undefined where of is', () => {
    expect(standardise(series).slice(0, 19).every((v) => v === undefined)).toBe(true);
    expect(standardise(series)[19]).toBeDefined();
    const gappy: Array<number | undefined> = [...series];
    for (let i = 20; i < 31; i++) gappy[i] = undefined;
    // At 39 the window 10..39 holds 30 - 11 = 19 defined values: too few.
    expect(standardise(gappy)[39]).toBeUndefined();
    gappy[30] = series[30];
    // Now 20 defined values: the sd is over exactly those.
    const defined = gappy.slice(10, 40).filter((v): v is number => v !== undefined);
    expect(defined).toHaveLength(20);
    const mean = defined.reduce((a, b) => a + b, 0) / 20;
    const sd = Math.sqrt(defined.reduce((a, b) => a + (b - mean) ** 2, 0) / 19);
    expect(standardise(gappy)[39]).toBeCloseTo(series[39] / sd, 12);
    expect(standardise(gappy)[25]).toBeUndefined();
  });

  it('a window without variance gives no signal', () => {
    expect(standardise(new Array(25).fill(0.3))[24]).toBeUndefined();
  });
});

describe('orthogonalise (header SIGNALS, note F5)', () => {
  const random = createSeededRandom(3);
  const panel: PanelEntry[][] = Array.from({ length: 12 }, (_, p) =>
    ['A', 'B', 'C', 'D', 'E'].map((id, j) => ({
      id,
      r: 0.05 * (random() - 0.5),
      of: random() - 0.5 + 3 * (random() - 0.5) * 0.05,
      member: j < 4 || p % 2 === 0,
    }))
  );

  it('each period\'s fit is pooled OLS with an intercept over every member pair so far; residuals use that fit', () => {
    const { residuals, fits } = orthogonalise(panel);
    for (let p = 0; p < panel.length; p++) {
      const pairs = panel.slice(0, p + 1).flat().filter((e) => e.member);
      const { alpha, beta } = olsAlphaBeta(
        pairs.map((e) => e.of!),
        pairs.map((e) => e.r!)
      );
      expect(fits[p]!.n).toBe(pairs.length);
      expect(fits[p]!.alpha).toBeCloseTo(alpha, 12);
      expect(fits[p]!.beta).toBeCloseTo(beta, 12);
      for (const e of panel[p]) expect(residuals[p].get(e.id)).toBeCloseTo(e.of! - alpha - beta * e.r!, 12);
    }
    // A non-member gets a residual against the fit it did not enter.
    expect(panel[1].find((e) => e.id === 'E')!.member).toBe(false);
    expect(residuals[1].has('E')).toBe(true);
  });

  it('is causal: changing any later period leaves every earlier fit and residual unchanged', () => {
    const before = orthogonalise(panel);
    for (let cut = 0; cut < panel.length - 1; cut++) {
      const mutated = panel.map((period, p) =>
        p > cut ? period.map((e) => ({ ...e, of: (e.of ?? 0) * 7 + 1, r: (e.r ?? 0) - 0.3, member: !e.member })) : period
      );
      const after = orthogonalise(mutated);
      expect(after.fits.slice(0, cut + 1)).toEqual(before.fits.slice(0, cut + 1));
      expect(after.residuals.slice(0, cut + 1)).toEqual(before.residuals.slice(0, cut + 1));
      expect(after.fits[cut + 1]).not.toEqual(before.fits[cut + 1]);
    }
  });

  it('skips undefined pairs; fewer than 3 pairs or no return variance gives no residual', () => {
    const two: PanelEntry[][] = [
      [
        { id: 'A', of: 1, r: 0.01, member: true },
        { id: 'B', of: 2, r: 0.02, member: true },
        { id: 'C', of: undefined, r: 0.03, member: true },
        { id: 'D', of: 3, r: undefined, member: true },
      ],
    ];
    const out = orthogonalise(two);
    expect(out.fits[0]).toBeNull();
    expect(out.residuals[0].size).toBe(0);
    const flatR = orthogonalise([[1, 2, 3].map((of, k) => ({ id: String(k), of, r: 0.01, member: true }))]);
    expect(flatR.fits[0]).toBeNull();
  });
});

describe('quintileSignals (header PORTFOLIO)', () => {
  const members = (values: Array<number | undefined>) => values.map((value, k) => ({ id: `C${String(k).padStart(2, '0')}`, value }));

  it('q = floor(M / 5): long the q highest, short the q lowest; flat when q < 2', () => {
    const nine = quintileSignals(members([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect([nine.M, nine.q, nine.flat]).toEqual([9, 1, true]);
    expect([...nine.positions.values()].every((p) => p === 0)).toBe(true);
    const ten = quintileSignals(members([5, 3, 9, 1, 7, 2, 8, 4, 6, 0]));
    expect([ten.M, ten.q, ten.flat]).toEqual([10, 2, false]);
    expect(ten.positions.get('C02')).toBe(1); // 9
    expect(ten.positions.get('C06')).toBe(1); // 8
    expect(ten.positions.get('C09')).toBe(-1); // 0
    expect(ten.positions.get('C03')).toBe(-1); // 1
    expect([...ten.positions.values()].filter((p) => p === 0)).toHaveLength(6);
    expect(quintileSignals(members(Array.from({ length: 15 }, (_, k) => k))).q).toBe(3);
    expect(quintileSignals(members(Array.from({ length: 14 }, (_, k) => k))).q).toBe(2);
  });

  it('members without a defined value are not ranked and hold 0; ties go by contract id', () => {
    const book = quintileSignals(members([1, 1, 1, 1, undefined, 1, 1, 1, 1, 1, 1, Number.NaN]));
    expect(book.M).toBe(10);
    expect(book.positions.get('C04')).toBe(0);
    expect(book.positions.get('C11')).toBe(0);
    // All equal: ascending by id, so the two smallest ids are short and the two largest long.
    expect(book.ranked).toEqual(['C00', 'C01', 'C02', 'C03', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10']);
    expect([book.positions.get('C00'), book.positions.get('C01')]).toEqual([-1, -1]);
    expect([book.positions.get('C09'), book.positions.get('C10')]).toEqual([1, 1]);
  });
});

const loaded: FlowInputs = flowInputsOf(flowUniverse());
const base = (frequency: 'daily' | 'weekly'): SimOptions => flowSimOptions(broadOptions(loaded.from, loaded.to), frequency);

function book(rule: 'DO' | 'W' | 'WO' | 'D', inputs: TrendSymbolInput[] = loaded.inputs) {
  const frequency = rule === 'W' || rule === 'WO' ? 'weekly' : 'daily';
  const schedule = flowSchedule(inputs, frequency, loaded.from, loaded.to);
  const values = flowValues(rule, inputs, loaded.bars, schedule);
  const sections = sectionsOf(schedule, inputs, plainValueAt(inputs, values.values));
  return { schedule, values, sections, book: rankBook(inputs, schedule, sections) };
}

describe('flow inputs and values on a synthetic universe', () => {
  it('carries every member\'s traded bars, aligned to the real days of its calendar', () => {
    expect(loaded.inputs).toHaveLength(Object.keys(loaded.bars).length);
    const lll = loaded.inputs.find((i) => i.symbol === 'LLLUSDT#1')!;
    const real = Array.from(lll.carried!).filter((c) => c === 0).length;
    expect(loaded.bars['LLLUSDT#1']).toHaveLength(real);
    expect(Array.from(lll.carried!).filter((c) => c === 1)).toHaveLength(3);
  });

  it('daily: no flow on a carried day; weekly: values sit on Friday bars only', () => {
    const lll = loaded.inputs.find((i) => i.symbol === 'LLLUSDT#1')!;
    const daily = contractFlowSeries(lll, loaded.bars[lll.symbol], 'daily');
    lll.carried!.forEach((c, i) => {
      if (c === 1) expect(Number.isNaN(daily.raw[i])).toBe(true);
    });
    const weekly = contractFlowSeries(lll, loaded.bars[lll.symbol], 'weekly');
    weekly.raw.forEach((v, i) => {
      if (!Number.isNaN(v)) expect(isFridayBar(lll.t[i])).toBe(true);
    });
    expect(weekly.raw.filter((v) => !Number.isNaN(v)).length).toBeGreaterThan(300);
  });

  it('the schedule ranks only members whose contract has not ended by the close', () => {
    const { schedule } = book('D');
    const kkk = loaded.inputs.findIndex((i) => i.symbol === 'KKKUSDT#1');
    const end = loaded.inputs[kkk].endDay!;
    expect(end).toBe(utc(2024, 3, 15));
    const at = (close: number) => schedule.members[schedule.closes.indexOf(close)].some((m) => m.input === kkk);
    // Its last bar (2024-03-15) is decided at the close of 2024-03-15; at the close ending it, it is gone.
    expect(at(end)).toBe(true);
    expect(at(end + DAY_MS)).toBe(false);
    for (const members of schedule.members) for (const m of members) expect(m.bar).toBeGreaterThanOrEqual(0);
  });

  it('DO and WO values are residuals from the sample\'s first period on, none before; D and W are OF', () => {
    for (const rule of ['DO', 'WO'] as const) {
      const { values, schedule } = book(rule);
      const btc = loaded.inputs.find((i) => i.symbol === 'BTCUSDT#1')!;
      const v = values.values[btc.symbol];
      const firstBar = btc.t.indexOf(schedule.closes[0] - DAY_MS);
      expect(v.slice(0, firstBar).every((x) => Number.isNaN(x))).toBe(true);
      expect(Number.isFinite(v[firstBar])).toBe(true);
      expect(values.fits!.every((f) => f !== null)).toBe(true);
    }
    const d = book('D');
    const btc = loaded.inputs.find((i) => i.symbol === 'BTCUSDT#1')!;
    expect(Array.from(d.values.values[btc.symbol])).toEqual(Array.from(d.values.series[btc.symbol].of));
    expect(d.values.fits).toBeNull();
  });

  it('is causal end to end: changing every volume and price after a date leaves every value before it unchanged', () => {
    for (const rule of ['DO', 'WO'] as const) {
      const cut = utc(2023, 6, 1);
      const altered: Record<string, PerpCandleRow[]> = Object.fromEntries(
        Object.entries(loaded.bars).map(([id, rows]) => [
          id,
          rows.map((r) => (r.t >= cut ? { ...r, c: r.c * 1.5, tbv: r.v * 0.9 } : r)),
        ])
      );
      const frequency = rule === 'DO' ? 'daily' : 'weekly';
      const schedule = flowSchedule(loaded.inputs, frequency, loaded.from, loaded.to);
      const before = flowValues(rule, loaded.inputs, loaded.bars, schedule).values;
      const after = flowValues(rule, loaded.inputs, altered, schedule).values;
      let compared = 0;
      for (const input of loaded.inputs) {
        input.t.forEach((t, i) => {
          if (t >= cut) return;
          compared++;
          expect(Object.is(after[input.symbol][i], before[input.symbol][i])).toBe(true);
        });
        expect(Array.from(after[input.symbol]).some((v, i) => input.t[i] >= cut && v !== before[input.symbol][i])).toBe(true);
      }
      expect(compared).toBeGreaterThan(10_000);
    }
  });
});

describe('rankBook paths (note F6)', () => {
  it('daily: the signal sits on every deciding bar of a ranked member; weekly: Friday bars only', () => {
    const daily = book('D');
    const weekly = book('W');
    const btc = loaded.inputs.find((i) => i.symbol === 'BTCUSDT#1')!;
    expect(daily.book.paths[btc.symbol].decide(0)).toBe(true);
    const w = weekly.book.paths[btc.symbol];
    btc.t.forEach((t, i) => {
      expect(w.decide(i)).toBe(isFridayBar(t));
      if (w.signal[i] !== 0 || w.defined![i] === 1) expect(isFridayBar(t)).toBe(true);
    });
    expect(w.rebalance).toEqual({ kind: 'on-decision' });
    expect(Array.from(w.size).every((s) => s === 1)).toBe(true);
  });

  it('per period: q longs and q shorts among the ranked, M the defined members', () => {
    const { book: b, schedule, sections } = book('DO');
    schedule.closes.forEach((close, p) => {
      let longs = 0;
      let shorts = 0;
      let ranked = 0;
      for (const m of schedule.members[p]) {
        const paths = b.paths[loaded.inputs[m.input].symbol];
        if (paths.defined![m.bar] === 1) ranked++;
        if (paths.signal[m.bar] === 1) longs++;
        if (paths.signal[m.bar] === -1) shorts++;
      }
      const period = b.periods[p];
      expect(period.close).toBe(close);
      expect(ranked).toBe(period.ranked);
      expect(sections[p].filter((s) => s.value !== undefined)).toHaveLength(period.ranked);
      const q = period.q >= 2 ? period.q : 0;
      expect([longs, shorts]).toEqual([q, q]);
    });
  });
});

describe('container: SimOptions.reequaliseAt (note F7)', () => {
  const daily = book('DO');

  it('the legends container refuses it; absent or never true, the broad run is unchanged', () => {
    const plain = broadOptions(loaded.from, loaded.to);
    expect(() => runTrend(loaded.inputs, daily.book.paths, { ...plain, broad: undefined, reequaliseAt: () => true })).toThrow(
      /reequaliseAt needs SimOptions.broad/
    );
    const without = runTrend(loaded.inputs, daily.book.paths, plain);
    const never = runTrend(loaded.inputs, daily.book.paths, { ...plain, reequaliseAt: () => false });
    expect(never.returns).toEqual(without.returns);
    expect(never.turnover).toEqual(without.turnover);
    // Monthly re-equalisation only: the book drifts away from neutrality between ranking closes.
    const maxNet = Math.max(...without.broad!.openLong.map((l, k) => Math.abs(l - without.broad!.openShort[k])));
    expect(maxNet).toBeGreaterThan(0.01);
  });

  /** A universe with no halt and no delisting, every open at the previous close. */
  const clean = flowInputsOf(plantedUniverse(13, 0, 1));
  const cleanBook = (frequency: 'daily' | 'weekly') => {
    const rule = frequency === 'daily' ? 'DO' : 'WO';
    const schedule = flowSchedule(clean.inputs, frequency, clean.from, clean.to);
    const values = flowValues(rule, clean.inputs, clean.bars, schedule);
    const b = rankBook(clean.inputs, schedule, sectionsOf(schedule, clean.inputs, plainValueAt(clean.inputs, values.values)));
    const opts = flowSimOptions(broadOptions(clean.from, clean.to), frequency);
    return { b, run: runTrend(clean.inputs, b.paths, opts) };
  };
  const neutralAt = (run: TrendRun, k: number) => {
    const { openLong, openShort } = run.broad!;
    expect(openLong[k]).toBeGreaterThan(0);
    expect(Math.abs(openLong[k] - openShort[k])).toBeLessThanOrEqual(1e-9 * openLong[k]);
  };

  it('daily: the book is dollar-neutral at every fill, each leg q / M of equity', () => {
    const { b, run } = cleanBook('daily');
    const first = firstPositionIndex(run);
    expect(first).toBe(0);
    for (let k = first; k < run.days.length; k++) {
      neutralAt(run, k);
      // The decision at the close before day k fills at its open; with no cash, a leg is q / M of equity.
      const period = b.periods[k];
      expect(period.close).toBe(run.days[k]);
      expect(run.broad!.openLong[k]).toBeCloseTo(period.q / period.ranked, 12);
      expect(run.broad!.cash[k]).toBe(0);
    }
  });

  it('capital is split across the RANKED members: an unranked live member gets 0, each leg is q / M of equity', () => {
    const schedule = flowSchedule(clean.inputs, 'daily', clean.from, clean.to);
    const values = flowValues('D', clean.inputs, clean.bars, schedule).values;
    // P00 has no value from 2023-01-01 to 2023-03-01: live but unranked there, so M = 12 of 13 members.
    const p00 = clean.inputs[0];
    expect(p00.symbol).toBe('P00USDT#1');
    const blanked = { ...values, [p00.symbol]: Float64Array.from(values[p00.symbol]) };
    p00.t.forEach((t, i) => {
      if (t >= utc(2022, 12, 31) && t < utc(2023, 2, 28)) blanked[p00.symbol][i] = Number.NaN;
    });
    const b = rankBook(clean.inputs, schedule, sectionsOf(schedule, clean.inputs, plainValueAt(clean.inputs, blanked)));
    const run = runTrend(clean.inputs, b.paths, flowSimOptions(broadOptions(clean.from, clean.to), 'daily'));
    const from = run.days.indexOf(utc(2023, 1, 2));
    const to = run.days.indexOf(utc(2023, 2, 27));
    for (let k = from; k <= to; k++) {
      expect(b.periods[k]).toMatchObject({ members: 13, ranked: 12, q: 2 });
      expect(run.broad!.openLong[k]).toBeCloseTo(2 / 12, 12);
      neutralAt(run, k);
      // P00 holds nothing while unranked.
      expect(run.contributions[p00.symbol][k]).toBe(0);
    }
    expect(run.broad!.openLong[from - 40]).toBeCloseTo(2 / 13, 12);
  });

  it('weekly: dollar-neutral at every Saturday fill, drifting within the week', () => {
    const { run } = cleanBook('weekly');
    let saturdays = 0;
    let drift = 0;
    for (let k = firstPositionIndex(run); k < run.days.length; k++) {
      if (new Date(run.days[k]).getUTCDay() === 6) {
        neutralAt(run, k);
        saturdays++;
      } else {
        drift = Math.max(drift, Math.abs(run.broad!.openLong[k] - run.broad!.openShort[k]));
      }
    }
    expect(saturdays).toBeGreaterThan(280);
    expect(drift).toBeGreaterThan(1e-4);
  });

  it('a delisting\'s capital stays cash until the next ranking close; equity is conserved throughout', () => {
    const run = runTrend(loaded.inputs, daily.book.paths, base('daily'));
    const k = run.days.indexOf(utc(2024, 3, 15));
    const delisted = run.broad!.delistings.find((d) => d.symbol === 'KKKUSDT#1');
    const cash = run.broad!.cash;
    if (delisted) expect(delisted.day).toBe(utc(2024, 3, 15));
    // KKK is ranked at its last decision, so it holds capital on its last day; that capital is cash afterwards.
    expect(daily.book.paths['KKKUSDT#1'].defined![loaded.inputs.find((i) => i.symbol === 'KKKUSDT#1')!.t.indexOf(utc(2024, 3, 14))]).toBe(1);
    for (let j = k; j < run.days.indexOf(utc(2024, 4, 1)); j++) expect(cash[j]).toBeGreaterThan(0);
    expect(cash[run.days.indexOf(utc(2024, 4, 1))]).toBe(0);
    expect(cash[k - 1]).toBe(0);
  });
});

describe('gate 3 nulls (note F9)', () => {
  it('shifts: [365, S - 365] days and [52, S_w - 52] weeks', () => {
    expect(nullShift('daily', 0)).toBe(MIN_SHIFT_DAYS);
    expect(nullShift('daily', 0.999_999_999)).toBe(NULL_CALENDAR_DAYS - 365);
    expect(nullShift('weekly', 0)).toBe(MIN_SHIFT_WEEKS);
    expect(nullShift('weekly', 0.999_999_999)).toBe(338 - 52);
  });

  it('aligned sources: k days earlier on the wrapping day calendar; k whole weeks earlier, Friday to Friday', () => {
    const btc = loaded.inputs.find((i) => i.symbol === 'BTCUSDT#1')!;
    const i = btc.t.indexOf(utc(2021, 3, 5)); // a Friday
    expect(alignedSource(btc, i, 400, 'daily', FLOW_CALENDAR)).toBe(utc(2021, 3, 5) - 400 * DAY_MS);
    // 2021-03-05 is calendar day 429: 429 - 1000 wraps to 429 - 1000 + 2373.
    expect(alignedSource(btc, i, 1000, 'daily', FLOW_CALENDAR)).toBe(FLOW_CALENDAR.start + (429 - 1000 + 2373) * DAY_MS);
    expect(alignedSource(btc, i, 52, 'weekly', FLOW_CALENDAR)).toBe(utc(2021, 3, 5) - 52 * 7 * DAY_MS);
    const w = (utc(2021, 3, 5) - utc(2020, 1, 10)) / (7 * DAY_MS);
    expect(alignedSource(btc, i, 100, 'weekly', FLOW_CALENDAR)).toBe(utc(2020, 1, 10) + (w - 100 + 338) * 7 * DAY_MS);
    expect(isFridayBar(alignedSource(btc, i, 100, 'weekly', FLOW_CALENDAR))).toBe(true);
    expect(() => alignedSource(btc, i + 1, 52, 'weekly', FLOW_CALENDAR)).toThrow(/not a Friday of the null calendar/);
  });

  for (const rule of ['DO', 'W'] as const) {
    it(`${rule} aligned: one k per draw for every contract, a source outside the contract's life holds nothing`, () => {
      const { schedule, values } = book(rule);
      const frequency = rule === 'DO' ? 'daily' : 'weekly';
      const opts = base(frequency);
      const plain = plainValueAt(loaded.inputs, values.values);
      const seen: Array<{ k: number; sections: Section[] }> = [];
      const result = flowNull(
        'aligned',
        { inputs: loaded.inputs, schedule, values: values.values, opts, range: { first: 0, last: 400 } },
        0.1,
        3,
        7,
        (d) => seen.push({ k: d.k!, sections: d.sections })
      );
      expect(seen.map((s) => s.k)).toEqual(result.shifts);
      const random = createSeededRandom(7);
      expect(result.shifts).toEqual([0, 1, 2].map(() => nullShift(frequency, random())));
      let outside = 0;
      for (const { k, sections } of seen) {
        schedule.members.forEach((members, p) =>
          members.forEach((m, j) => {
            const input = loaded.inputs[m.input];
            const source = alignedSource(input, m.bar, k, frequency, FLOW_CALENDAR);
            const sb = input.t.indexOf(source);
            if (sb === -1) outside++;
            expect(sections[p][j].value).toBe(sb === -1 ? undefined : plain(m.input, sb));
          })
        );
      }
      expect(outside).toBeGreaterThan(0);
      expect(result.outsideLifeShare).toBeGreaterThan(0);
      expect(alignedValueAt(loaded.inputs, values.values, frequency, seen[0].k)(0, schedule.members[50][0].bar)).toBe(
        seen[0].sections[50][0].value
      );
    });
  }

  it('permuted: each period\'s values are permuted among that period\'s ranked members only', () => {
    const { schedule, values, sections } = book('DO');
    const seen: Section[][] = [];
    const result = flowNull(
      'permuted',
      { inputs: loaded.inputs, schedule, values: values.values, opts: base('daily'), range: { first: 0, last: 400 } },
      0.1,
      2,
      7,
      (d) => seen.push(d.sections)
    );
    expect(result.shifts).toBeUndefined();
    let moved = 0;
    for (const permuted of seen) {
      permuted.forEach((section, p) => {
        expect(section.map((m) => m.id)).toEqual(sections[p].map((m) => m.id));
        expect(section.map((m) => m.value === undefined)).toEqual(sections[p].map((m) => m.value === undefined));
        const sorted = (s: Section) => s.filter((m) => m.value !== undefined).map((m) => m.value!).sort((a, b) => a - b);
        expect(sorted(section)).toEqual(sorted(sections[p]));
        if (section.some((m, j) => m.value !== sections[p][j].value)) moved++;
      });
    }
    expect(moved).toBeGreaterThan(seen.length * sections.length * 0.9);
    expect(seen[0]).not.toEqual(seen[1]);
    // The same seed gives the same permutations.
    const again = permuteSections(sections, createSeededRandom(7));
    expect(again).toEqual(seen[0]);
  });

  it('p = (1 + draws at or above the observed, or undefined) / (draws + 1); an undefined observed Sharpe gives 1', () => {
    expect(nullP(1, [0.5, 1, 1.5, Number.NaN])).toEqual({ p: 4 / 5, nullMean: 1, undefinedDraws: 1 });
    expect(nullP(2, [0.5, 1])).toMatchObject({ p: 1 / 3 });
    expect(nullP(Number.NaN, [0.5])).toEqual({ p: 1, nullMean: Number.NaN, undefinedDraws: 0 });
    const { schedule, values } = book('D');
    const ctx = { inputs: loaded.inputs, schedule, values: values.values, opts: base('daily'), range: { first: 0, last: 10 } };
    expect(flowNull('aligned', ctx, Number.NaN, 5, 7)).toMatchObject({ p: 1, draws: 0 });
  });

  it('lagValueAt reads the previous day, or the previous Friday', () => {
    const { values } = book('W');
    const btc = loaded.inputs.findIndex((i) => i.symbol === 'BTCUSDT#1');
    const t = loaded.inputs[btc].t;
    const friday = t.indexOf(utc(2023, 3, 3));
    const v = values.values['BTCUSDT#1'];
    expect(lagValueAt(loaded.inputs, values.values, 'weekly')(btc, friday)).toBe(v[friday - 7]);
    expect(lagValueAt(loaded.inputs, values.values, 'daily')(btc, friday)).toBe(Number.isNaN(v[friday - 1]) ? undefined : v[friday - 1]);
    expect(lagValueAt(loaded.inputs, values.values, 'weekly')(btc, 3)).toBeUndefined();
  });
});
