// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import { BROAD_COST, BROAD_FEE, DELIST_HAIRCUT, LEAVE_SLIPPAGE, tierSlippage } from './broad-trend';
import {
  C3_FIRST_DEFINED,
  DAY_MS,
  TF_FIRST_DEFINED,
  broadPaths,
  c3BroadPaths,
  c3State,
  pointInTimeBasket,
  tf1Paths,
  tf2Paths,
  tf3Paths,
  tf4Paths,
  twinOf,
  twinOfBroad,
  type Rebalance,
  type RulePaths,
} from './trend-signals';
import {
  NULL_CALENDAR_DAYS,
  NULL_CALENDAR_START,
  annualAlpha,
  assertCashBalance,
  commonShiftPaths,
  memberDays,
  misalignedShare,
  runTrend,
  stressBroad,
  stressCost,
  timingNull,
  type MembershipSpan,
  type Settlement,
  type SimOptions,
  type TrendRun,
  type TrendSymbolInput,
} from './trend-sim';

const D = DAY_MS;
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const FEE = BROAD_FEE.fee;
const ON_CHANGE: Rebalance = { kind: 'on-signal-change' };

/** Bars start on 2023-12-31, so the first ranking close (2024-01-01) decides on a bar. */
const START = utc(2023, 12, 31);
const JAN1 = utc(2024, 1, 1);
const FEB1 = utc(2024, 2, 1);
const MAR1 = utc(2024, 3, 1);
const APR1 = utc(2024, 4, 1);
/** Bar index of a day for inputs starting at START. */
const at = (day: number) => Math.round((day - START) / D);
const flat = (n: number, v: number) => new Array<number>(n).fill(v);
const span = (from: number, to: number, rank: number): MembershipSpan => ({ from, to, rank });

/**
 * A contract's daily bars from `start`: opens equal the previous close unless
 * overridden; a carried index repeats the previous close as open and close.
 */
function contract(
  symbol: string,
  start: number,
  closes: number[],
  o: {
    opens?: Record<number, number>;
    carried?: number[];
    membership?: MembershipSpan[];
    ended?: boolean;
    settlements?: Settlement[];
  } = {}
): TrendSymbolInput {
  const close = [...closes];
  const carried = new Uint8Array(close.length);
  for (const i of o.carried ?? []) {
    carried[i] = 1;
    close[i] = close[i - 1];
  }
  const open = close.map((c, i) => (i === 0 ? c : close[i - 1]));
  for (const [i, v] of Object.entries(o.opens ?? {})) open[Number(i)] = v;
  return {
    symbol,
    t: close.map((_, i) => start + i * D),
    open,
    close,
    listingDay: start,
    settlements: o.settlements ?? [],
    carried: o.carried ? carried : undefined,
    membership: o.membership,
    endDay: o.ended ? start + (close.length - 1) * D : null,
  };
}

function paths(
  n: number,
  signal: number | number[],
  size: number | number[],
  rebalance: Rebalance = ON_CHANGE,
  decide: (i: number) => boolean = () => true
): RulePaths {
  const fill = (v: number | number[]) => Float64Array.from(Array.isArray(v) ? v : new Array(n).fill(v));
  return { signal: fill(signal), size: fill(size), decide, rebalance };
}

function broadOpts(from: number, to: number, extra: Partial<SimOptions> = {}): SimOptions {
  return { from, to, cost: BROAD_FEE, delay: 0, broad: BROAD_COST, ...extra };
}

const dayOf = (run: TrendRun, day: number) => {
  const k = run.days.indexOf(day);
  if (k === -1) throw new Error(`day ${new Date(day).toISOString()} is outside the run`);
  return k;
};

describe('broad costs', () => {
  it('tierSlippage is 2, 5 and 10 bps for ranks 1-10, 11-25 and 26-50, and refuses any other rank', () => {
    expect([1, 10, 11, 25, 26, 50].map(tierSlippage)).toEqual([0.0002, 0.0002, 0.0005, 0.0005, 0.001, 0.001]);
    expect(() => tierSlippage(0)).toThrow();
    expect(() => tierSlippage(51)).toThrow();
    expect(() => tierSlippage(1.5)).toThrow();
    expect(LEAVE_SLIPPAGE).toBe(0.001);
    expect(DELIST_HAIRCUT).toBe(0.02);
    expect(BROAD_FEE).toEqual({ fee: 0.0005, slippage: 0 });
  });

  it('(g) stressBroad doubles every tier, the leave slippage and the haircut; stressCost is unchanged', () => {
    const s = stressBroad(BROAD_COST);
    expect([5, 20, 40].map(s.slippageForRank)).toEqual([0.0004, 0.001, 0.002]);
    expect(s.leaveSlippage).toBe(0.002);
    expect(s.delistHaircut).toBe(0.04);
    expect(() => s.slippageForRank(51)).toThrow();
    expect(stressCost(BROAD_FEE).fee).toBeCloseTo(0.00075, 15);
    expect(stressCost(BROAD_FEE).slippage).toBe(0);
  });
});

describe('broad runTrend: leaving', () => {
  // A (rank 3) stays a member; B (rank 12) leaves at the 2024-02-01 ranking close, with an overnight gap to 55.
  const n = at(utc(2024, 2, 2)) + 1;
  const a = contract('A', START, flat(n, 100), { membership: [span(JAN1, FEB1, 3), span(FEB1, MAR1, 3)] });
  const bCloses = flat(n, 50);
  bCloses[at(FEB1)] = 60;
  bCloses[at(FEB1) + 1] = 60;
  const b = contract('B', START, bCloses, { opens: { [at(FEB1)]: 55 }, membership: [span(JAN1, FEB1, 12)] });
  const p = { A: paths(n, 1, 1), B: paths(n, 1, 1) };

  it('(a) trades a leaver to 0 at the next open with the leave slippage and fee, and moves its capital to cash', () => {
    const run = runTrend([a, b], p, broadOpts(JAN1, utc(2024, 2, 3)));
    // 2024-01-01: each sleeve buys 0.5 of notional; A at 2 bps (rank 3), B at 5 bps (rank 12), plus the fee.
    const jan = dayOf(run, JAN1);
    expect(run.cost[jan]).toBeCloseTo(0.5 * (FEE + 0.0002) + 0.5 * (FEE + 0.0005), 12);
    const equityJan = 1 - 0.00035 - 0.0005;

    // 2024-02-01: A takes the whole equity, buying from 0.005 to equityJan / 100; B gaps 50 -> 55 on 0.01 and sells.
    const k = dayOf(run, FEB1);
    const aTraded = (equityJan / 100 - 0.005) * 100;
    const aCost = aTraded * (FEE + 0.0002);
    const bGap = 0.01 * (55 - 50);
    const bTraded = 0.01 * 55;
    const bCost = bTraded * (FEE + LEAVE_SLIPPAGE);
    const residual = bGap - bCost;
    expect(run.turnover[k]).toBeCloseTo((aTraded + bTraded) / equityJan, 12);
    expect(run.cost[k]).toBeCloseTo((aCost + bCost) / equityJan, 12);
    expect(run.contributions.B[k]).toBeCloseTo(residual / equityJan, 12);
    expect(run.returns[k]).toBeCloseTo((residual - aCost) / equityJan, 12);

    const detail = run.broad!;
    expect(detail.leaves).toHaveLength(1);
    expect(detail.leaves[0].symbol).toBe('B');
    expect(detail.leaves[0].close).toBe(FEB1);
    expect(detail.leaves[0].day).toBe(FEB1);
    expect(detail.leaves[0].traded).toBeCloseTo(bTraded, 12);
    expect(detail.leaves[0].cost).toBeCloseTo(bCost, 12);
    expect(detail.leaves[0].residual).toBeCloseTo(residual, 12);
    const equityFeb = equityJan - aCost + residual;
    expect(detail.cash[k]).toBeCloseTo(residual / equityFeb, 12);
    expect(detail.members[k - 1]).toBe(2);
    expect(detail.members[k]).toBe(1);

    // B holds nothing afterwards; the books balance (asserted inside the run every day).
    expect(run.turnover[k + 1]).toBe(0);
    expect(run.contributions.B[k + 1]).toBe(0);
    expect(run.sleeveReturns.B[k + 1]).toBeNaN();
    expect(run.returns.reduce((e, r) => e * (1 + r), 1)).toBeCloseTo(equityFeb, 12);
  });

  it('under a one-bar delay the leave replaces any pending order and fills a day later', () => {
    const run = runTrend([a, b], p, broadOpts(JAN1, utc(2024, 2, 3), { delay: 1 }));
    expect(run.broad!.leaves.map((l) => [l.symbol, l.close, l.day])).toEqual([['B', FEB1, utc(2024, 2, 2)]]);
    // B holds through 2024-02-01 (gap 50 -> 55, then 55 -> 60) and sells at the 2024-02-02 open of 60.
    const leave = run.broad!.leaves[0];
    expect(leave.traded).toBeCloseTo(0.01 * 60, 12);
  });
});

describe('broad runTrend: delisting', () => {
  it.each([
    ['long', 1, 0.98],
    ['short', -1, 1.02],
  ])('(b) closes a %s at the last close moved 2%% against it plus the fee, then holds cash to the next close', (_, side, factor) => {
    const n = at(utc(2024, 2, 2)) + 1;
    const a = contract('A', START, flat(n, 100), { membership: [span(JAN1, FEB1, 5), span(FEB1, MAR1, 5)] });
    const end = at(utc(2024, 1, 20));
    const bCloses = flat(end + 1, 50);
    bCloses[end] = 40;
    const b = contract('B', START, bCloses, { membership: [span(JAN1, FEB1, 5)], ended: true });
    const run = runTrend([a, b], { A: paths(n, 1, 1), B: paths(end + 1, side, 1) }, broadOpts(JAN1, utc(2024, 2, 3)));

    const qty = side * 0.01;
    const exitPrice = 40 * factor;
    const haircut = 0.01 * 40 * 0.02;
    const fee = 0.01 * exitPrice * FEE;
    const move = qty * (40 - 50);
    const prevEquity = 1 - 2 * 0.5 * (FEE + 0.0002);
    const k = dayOf(run, utc(2024, 1, 20));

    expect(run.broad!.delistings).toHaveLength(1);
    const exit = run.broad!.delistings[0];
    expect(exit.symbol).toBe('B');
    expect(exit.day).toBe(utc(2024, 1, 20));
    expect(exit.qty).toBeCloseTo(qty, 12);
    expect(exit.close).toBe(40);
    expect(exit.exitPrice).toBeCloseTo(exitPrice, 12);
    expect(exit.haircut).toBeCloseTo(haircut, 12);
    expect(exit.fee).toBeCloseTo(fee, 12);

    const bPnl = move - haircut - fee;
    expect(run.contributions.B[k]).toBeCloseTo(bPnl / prevEquity, 12);
    expect(run.cost[k]).toBeCloseTo((haircut + fee) / prevEquity, 12);
    expect(run.turnover[k]).toBeCloseTo((0.01 * exitPrice) / prevEquity, 12);
    // The haircut is a cost, not a leg: the leg holds the price move only.
    expect(side > 0 ? run.longLeg[k] : run.shortLeg[k]).toBeCloseTo(move / prevEquity, 12);

    const bCapital = 0.5 - 0.5 * (FEE + 0.0002) + bPnl;
    const equityAfter = prevEquity + bPnl;
    expect(run.broad!.cash[k]).toBeCloseTo(bCapital / equityAfter, 12);
    expect(run.broad!.cash[dayOf(run, utc(2024, 1, 31))]).toBeCloseTo(bCapital / equityAfter, 12);
    for (let j = k + 1; j < run.days.length; j++) {
      expect(run.contributions.B[j]).toBe(0);
      expect(run.sleeveReturns.B[j]).toBeNaN();
    }
    // At the 2024-02-01 ranking close the cash is re-split: A, the only member, buys up to the whole equity.
    const feb = dayOf(run, FEB1);
    expect(run.broad!.cash[feb]).toBe(0);
    expect(run.turnover[feb]).toBeCloseTo((equityAfter / 100 - 0.005) * 100 / equityAfter, 12);
  });

  it('a stressed run exits a delisting at the doubled 4% haircut', () => {
    const n = at(utc(2024, 1, 10)) + 1;
    const b = contract('B', START, flat(n, 50), { membership: [span(JAN1, FEB1, 1)], ended: true });
    const run = runTrend(
      [b],
      { B: paths(n, 1, 1) },
      broadOpts(JAN1, utc(2024, 1, 11), { cost: stressCost(BROAD_FEE), broad: stressBroad(BROAD_COST) })
    );
    const qty = 1 / 50;
    expect(run.broad!.delistings[0].exitPrice).toBeCloseTo(50 * 0.96, 12);
    expect(run.broad!.delistings[0].haircut).toBeCloseTo(qty * 50 * 0.04, 12);
    expect(run.broad!.delistings[0].fee).toBeCloseTo(qty * 48 * 0.00075, 12);
    // The entry paid 1.5x the fee and twice the rank-1 tier.
    expect(run.cost[0]).toBeCloseTo(0.00075 + 0.0004, 12);
  });

  it('a member selected after its last bar holds its equal share as cash until the next ranking close', () => {
    // B's last bar is 2024-01-31: it is delisted at that close and the 2024-02-01 ranking still selects it.
    const n = at(utc(2024, 2, 3)) + 1;
    const a = contract('A', START, flat(n, 100), { membership: [span(JAN1, FEB1, 1), span(FEB1, MAR1, 1)] });
    const b = contract('B', START, flat(at(utc(2024, 1, 31)) + 1, 50), {
      membership: [span(JAN1, FEB1, 2), span(FEB1, MAR1, 2)],
      ended: true,
    });
    const run = runTrend([a, b], { A: paths(n, 1, 1), B: paths(b.t.length, 1, 1) }, broadOpts(JAN1, utc(2024, 2, 4)));
    const entry = 0.5 * (FEE + 0.0002);
    const delist = 0.01 * 50 * 0.02 + 0.01 * 49 * FEE;
    const equity = 1 - 2 * entry - delist;
    // A goes from 0.5 of notional to equity / 2; B's half is cash.
    const aCost = (0.5 - equity / 2) * (FEE + 0.0002);
    const k = dayOf(run, FEB1);
    expect(run.turnover[k]).toBeCloseTo((0.5 - equity / 2) / equity, 12);
    expect(run.broad!.cash[k]).toBeCloseTo(equity / 2 / (equity - aCost), 12);
    expect(run.broad!.members[k]).toBe(1);
    expect(run.contributions.B[k]).toBe(0);
  });
});

describe('broad runTrend: membership drives joins', () => {
  it('(c) re-equalises only at ranking closes: a mid-month listing triggers nothing', () => {
    const n = at(utc(2024, 2, 2)) + 1;
    const aCloses = Array.from({ length: n }, (_, i) => 100 * 1.01 ** i);
    const a = contract('A', START, aCloses, { membership: [span(JAN1, MAR1, 1)] });
    const bStart = utc(2024, 1, 14);
    const b = contract('B', bStart, flat(n - at(bStart), 50), { membership: [span(FEB1, MAR1, 2)] });
    b.listingDay = utc(2024, 1, 15);
    const p = { A: paths(n, 1, 1), B: paths(b.t.length, 1, 1) };

    const run = runTrend([a, b], p, broadOpts(JAN1, utc(2024, 2, 3)));
    for (let day = utc(2024, 1, 2); day <= utc(2024, 1, 31); day += D) expect(run.turnover[dayOf(run, day)]).toBe(0);
    expect(run.startDay).toEqual({ A: JAN1, B: FEB1 });
    const feb = dayOf(run, FEB1);
    expect(run.turnover[feb]).toBeGreaterThan(0);
    expect(run.contributions.B[feb]).toBeLessThan(0);

    // The legends container (no membership) joins B at its listing and re-equalises there.
    const legends = runTrend(
      [
        { ...a, membership: undefined },
        { ...b, membership: undefined },
      ],
      p,
      { from: JAN1, to: utc(2024, 2, 3), cost: BROAD_FEE, delay: 0 }
    );
    expect(legends.turnover[dayOf(legends, utc(2024, 1, 15))]).toBeGreaterThan(0);
  });

  it('(d) a rejoining sleeve takes a forced first decision even off its schedule', () => {
    // B decides only at bar 0, so only a forced decision can put it back in after it rejoins.
    const n = at(utc(2024, 3, 2)) + 1;
    const a = contract('A', START, flat(n, 100), { membership: [span(JAN1, APR1, 1)] });
    const bCloses = flat(n, 50);
    bCloses[at(MAR1)] = 55;
    bCloses[at(MAR1) + 1] = 55;
    const b = contract('B', START, bCloses, { membership: [span(JAN1, FEB1, 2), span(MAR1, APR1, 2)] });
    const p = { A: paths(n, 1, 1), B: paths(n, 1, 1, ON_CHANGE, (i) => i === 0) };
    expect(p.B.decide(at(utc(2024, 2, 29)))).toBe(false);
    const run = runTrend([a, b], p, broadOpts(JAN1, utc(2024, 3, 3)));

    // January: both buy 0.5 at 2 bps. February 1: B sells its 0.5 at 10 bps with no gap, a negative residual.
    const equityJan = 1 - 2 * 0.5 * (FEE + 0.0002);
    const bLeaveCost = 0.5 * (FEE + LEAVE_SLIPPAGE);
    expect(run.broad!.leaves[0].residual).toBeCloseTo(-bLeaveCost, 12);
    const aFebCost = (equityJan - 0.5) * (FEE + 0.0002);
    const equityFeb = equityJan - bLeaveCost - aFebCost;
    // March 1: B rejoins with half the equity and buys at the 50 open, then gains 5 on the day.
    const share = equityFeb / 2;
    const bQty = share / 50;
    const k = dayOf(run, MAR1);
    expect(run.contributions.B[k]).toBeCloseTo((bQty * 5 - share * (FEE + 0.0002)) / equityFeb, 12);
    expect(run.sleeveReturns.B[k]).toBeCloseTo((bQty * 5 - share * (FEE + 0.0002)) / share, 12);
    expect(run.startDay.B).toBe(JAN1);
    // February: B is out.
    expect(run.contributions.B[dayOf(run, utc(2024, 2, 15))]).toBe(0);
  });
});

describe('broad runTrend: carried days', () => {
  const settlements: Settlement[] = [];
  for (let t = START; t <= utc(2024, 1, 20); t += 8 * 3_600_000) settlements.push({ t, rate: 0.0001 });

  it('(e) an order due on a carried day fills at the next real bar open', () => {
    // 2024-01-01 is carried: the first order fills at the 2024-01-02 open of 105.
    const closes = flat(6, 100);
    closes[2] = 110;
    const a = contract('A', START, closes, { carried: [1], opens: { 2: 105 }, membership: [span(JAN1, FEB1, 1)] });
    const run = runTrend([a], { A: paths(6, 1, 1) }, broadOpts(JAN1, utc(2024, 1, 4)));
    expect(run.turnover[0]).toBe(0);
    expect(run.returns[0]).toBe(0);
    expect(run.turnover[1]).toBeCloseTo(1, 12);
    expect(run.returns[1]).toBeCloseTo((1 / 105) * (110 - 105) - (FEE + 0.0002), 12);
  });

  it('(e) charges no funding and books no move on a carried day, and does not charge the skipped settlements later', () => {
    const n = at(utc(2024, 1, 10)) + 1;
    const a = contract('A', START, flat(n, 100), { carried: [at(utc(2024, 1, 5))], settlements, membership: [span(JAN1, FEB1, 1)] });
    const run = runTrend([a], { A: paths(n, 1, 1) }, broadOpts(JAN1, utc(2024, 1, 8)));
    // Three settlements a day on 0.01 x 100 of notional: 0.0003 a day.
    const entry = FEE + 0.0002;
    const k4 = dayOf(run, utc(2024, 1, 4));
    expect(run.funding[k4]).toBeCloseTo(-0.0003 / (1 - entry - 3 * 0.0003), 12);
    const k5 = dayOf(run, utc(2024, 1, 5));
    expect(run.funding[k5]).toBe(0);
    expect(run.returns[k5]).toBe(0);
    expect(run.funding[k5 + 1]).toBeCloseTo(-0.0003 / (1 - entry - 4 * 0.0003), 12);
  });

  it('(e) a rule exit decided before a carried day waits for the next real open', () => {
    const n = at(utc(2024, 1, 10)) + 1;
    const closes = flat(n, 100);
    closes[at(utc(2024, 1, 6))] = 120;
    const a = contract('A', START, closes, {
      carried: [at(utc(2024, 1, 5))],
      opens: { [at(utc(2024, 1, 6))]: 120 },
      settlements,
      membership: [span(JAN1, FEB1, 1)],
    });
    // The exit is decided at the close of 2024-01-04 (bar 01-04 reads 0), due at the carried 01-05 open.
    const signal = Array.from({ length: n }, (_, i) => (i < at(utc(2024, 1, 4)) ? 1 : 0));
    const run = runTrend([a], { A: paths(n, signal, 1) }, broadOpts(JAN1, utc(2024, 1, 8)));
    const k5 = dayOf(run, utc(2024, 1, 5));
    expect(run.turnover[k5]).toBe(0);
    // Equity before 2024-01-06: the entry cost and four days of funding (none on the carried day).
    const prev = 1 - (FEE + 0.0002) - 4 * 0.0003;
    expect(run.turnover[k5 + 1]).toBeCloseTo((0.01 * 120) / prev, 12);
    expect(run.returns[k5 + 1]).toBeCloseTo((0.01 * 20 - 0.01 * 120 * (FEE + 0.0002)) / prev, 12);
    expect(run.funding[k5 + 1]).toBe(0);
  });
});

describe('broad runTrend: tiered slippage', () => {
  it('(f) each member pays the tier of its rank, and a new rank applies from its ranking close', () => {
    const n = at(utc(2024, 2, 2)) + 1;
    const mk = (s: string, ranks: [number, number]) =>
      contract(s, START, flat(n, 100), { membership: [span(JAN1, FEB1, ranks[0]), span(FEB1, MAR1, ranks[1])] });
    const run = runTrend(
      [mk('A', [5, 30]), mk('B', [20, 20]), mk('C', [40, 40])],
      { A: paths(n, 1, 1), B: paths(n, 1, 1), C: paths(n, 1, 1) },
      broadOpts(JAN1, utc(2024, 2, 2))
    );
    const third = 1 / 3;
    expect(run.contributions.A[0]).toBeCloseTo(-third * (FEE + 0.0002), 12);
    expect(run.contributions.B[0]).toBeCloseTo(-third * (FEE + 0.0005), 12);
    expect(run.contributions.C[0]).toBeCloseTo(-third * (FEE + 0.001), 12);
    expect(run.cost[0]).toBeCloseTo(third * (3 * FEE + 0.0002 + 0.0005 + 0.001), 12);
    // February 1: A's re-equalisation trade (down to equity / 3) is charged at its new rank 30.
    const capitals = [third * (1 - FEE - 0.0002), third * (1 - FEE - 0.0005), third * (1 - FEE - 0.001)];
    const equity = capitals.reduce((x, y) => x + y, 0);
    const k = dayOf(run, FEB1);
    const aTraded = Math.abs(equity / 3 - third);
    expect(run.contributions.A[k]).toBeCloseTo((-aTraded * (FEE + 0.001)) / equity, 12);
  });
});

describe('defined signals and the broad twin', () => {
  const n = 420;
  const t = Array.from({ length: n }, (_, i) => utc(2022, 1, 1) + i * D);
  // Alternating 2% moves keep every volatility estimate positive and every return sign defined.
  const c = Array.from({ length: n }, (_, i) => 100 * (1 + 0.001 * i) * (i % 2 === 0 ? 1 : 1.02));

  it('(h) masks each TF rule at its boundary and zeroes the signal before it, leaving the builders unchanged', () => {
    const builders = { TF1: tf1Paths, TF2: tf2Paths, TF3: tf3Paths, TF4: tf4Paths } as const;
    expect(TF_FIRST_DEFINED).toEqual({ TF1: 60, TF2: 365, TF3: 199, TF4: 359 });
    for (const rule of ['TF1', 'TF2', 'TF3', 'TF4'] as const) {
      const legends = builders[rule](t, c);
      const before = Array.from(legends.signal);
      const broad = broadPaths(rule, { t, close: c });
      const first = TF_FIRST_DEFINED[rule];
      expect(broad.defined![first - 1]).toBe(0);
      expect(broad.defined![first]).toBe(1);
      expect(Array.from(broad.defined!.slice(first)).every((x) => x === 1)).toBe(true);
      for (let i = 0; i < n; i++) expect(broad.signal[i]).toBe(i < first ? 0 : legends.signal[i]);
      expect(Array.from(broad.size)).toEqual(Array.from(legends.size));
      expect(Array.from(builders[rule](t, c).signal)).toEqual(before);
      expect(legends.defined).toBeUndefined();
    }
    // TF1's partial score before bar 60 is real in the legends builder and held as 0 in the broad paths.
    expect(tf1Paths(t, c).signal[59]).not.toBe(0);
  });

  it('(h) a zero volatility leaves TF1 undefined (its size is undefined)', () => {
    const flatClose = new Array(100).fill(100);
    const broad = broadPaths('TF1', { t: t.slice(0, 100), close: flatClose });
    expect(Array.from(broad.defined!).every((x) => x === 0)).toBe(true);
  });

  it('(h) twinOfBroad is long where defined and holds nothing elsewhere; twinOf is unchanged', () => {
    const p = broadPaths('TF2', { t, close: c });
    const twin = twinOfBroad(p);
    for (let i = 0; i < n; i++) expect(twin.signal[i]).toBe(i < 365 ? 0 : 1);
    expect(twin.size).toBe(p.size);
    expect(Array.from(twinOf(p).signal).every((x) => x === 1)).toBe(true);
    expect(() => twinOfBroad(tf2Paths(t, c))).toThrow(/defined/);
  });

  it('(h) the broad twin holds nothing in a sleeve until its rule is defined', () => {
    // A member from 2024-01-01 whose bars begin 100 days earlier: TF3 is defined from bar 199.
    const s = utc(2024, 1, 1) - 100 * D;
    const len = 260;
    const closes = Array.from({ length: len }, (_, i) => 100 + i);
    const a = contract('A', s, closes, { membership: [span(JAN1, utc(2024, 7, 1), 1)] });
    const twin = twinOfBroad(broadPaths('TF3', a));
    const run = runTrend([a], { A: twin }, broadOpts(JAN1, s + len * D));
    const firstFill = s + 200 * D;
    for (let day = JAN1; day < firstFill; day += D) expect(run.turnover[dayOf(run, day)]).toBe(0);
    expect(run.turnover[dayOf(run, firstFill)]).toBeCloseTo(1, 12);
  });
});

describe('point-in-time C3 basket', () => {
  const B0 = utc(2024, 1, 31);
  const series = (symbol: string, closes: number[], extra: { carried?: number[]; ended?: boolean } = {}) =>
    contract(symbol, B0, closes, extra);

  it('(i) moves by the members with real closes on both days, ignores non-members and charges the delisting haircut', () => {
    // Days from 2024-01-31: X +10% on 02-02, 02-04 and 02-07, carried on 02-05; Q +10% on 02-05; Z ends on
    // 02-02; Y is never a member.
    const x = series('X', [100, 100, 110, 110, 121, 121, 121, 133.1], { carried: [5] });
    const q = series('Q', [20, 20, 20, 20, 20, 22, 22, 22]);
    const z = series('Z', [50, 50, 50], { ended: true });
    const y = series('Y', [10, 10, 1000, 1, 1, 1, 1, 1]);
    const month = [{ from: FEB1, to: MAR1 }];
    const membership = { X: month, Q: month, Z: month };
    const basket = pointInTimeBasket([x, q, y, z], membership, DELIST_HAIRCUT);
    expect(basket.days[0]).toBe(FEB1);
    expect(basket.days).toHaveLength(29);
    const moves = [
      0, // 02-01, the base
      (0.1 + 0 + 0) / 3, // 02-02: X +10%, Q and Z flat
      (0 + 0 - 0.02) / 3, // 02-03: X and Q flat, Z ended on 02-02 and was a member then
      (0.1 + 0) / 2, // 02-04: X and Q; Z is gone
      0.1, // 02-05: X is carried and skipped, Q +10%
      0, // 02-06: X's previous close is carried, Q flat
      (0.1 + 0) / 2, // 02-07
    ];
    let level = 1;
    moves.forEach((m, k) => {
      level *= 1 + m;
      expect(basket.index[k]).toBeCloseTo(level, 12);
    });
    // Y is ignored: the same basket without it.
    expect(Array.from(pointInTimeBasket([x, q, z], membership, DELIST_HAIRCUT).index)).toEqual(Array.from(basket.index));
    expect(Array.from(basket.state)).toEqual(Array.from(c3State(basket.index)));
    expect(Array.from(basket.defined).every((v) => v === 0)).toBe(true);
  });

  it('(i) charges a contract that was a member on its last day, not one selected after it', () => {
    // V is a member in February and ends on 02-29, then drops out; W ends on 02-29 but joins only in March.
    // 30 bars from 2024-01-31: the last is 2024-02-29.
    const flat30 = (s: string) => series(s, flat(30, 100), { ended: true });
    const u = series('U', flat(32, 100));
    const v = flat30('V');
    const w = flat30('W');
    const membership = {
      U: [{ from: FEB1, to: APR1 }],
      V: [{ from: FEB1, to: MAR1 }],
      W: [{ from: MAR1, to: APR1 }],
    };
    const basket = pointInTimeBasket([u, v, w], membership, DELIST_HAIRCUT);
    const k = basket.days.indexOf(MAR1);
    // March 1: U flat and V's haircut; W contributes nothing.
    expect(basket.index[k] / basket.index[k - 1]).toBeCloseTo(1 + (0 - 0.02) / 2, 12);
    const vOnly = pointInTimeBasket([u, v, w], { ...membership, W: [] }, DELIST_HAIRCUT);
    expect(vOnly.index[k]).toBeCloseTo(basket.index[k], 12);
  });

  it('(h) C3 is defined from basket position 28 + 365 and read by date', () => {
    const days = 500;
    const closes = Array.from({ length: days + 1 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i / 7)));
    const x = series('X', closes);
    const basket = pointInTimeBasket([x], { X: [{ from: FEB1, to: FEB1 + days * D }] }, DELIST_HAIRCUT);
    expect(C3_FIRST_DEFINED).toBe(393);
    expect(basket.defined[392]).toBe(0);
    expect(basket.defined[393]).toBe(1);
    // A contract starting later reads the shared state on its own dates.
    const later = series('L', closes.slice(0, 50));
    later.t = later.t.map((d) => d + 380 * D);
    const p = c3BroadPaths(later.t, basket);
    for (let i = 0; i < later.t.length; i++) {
      const k = basket.days.indexOf(later.t[i]);
      expect(p.signal[i]).toBe(k === -1 ? 0 : basket.state[k]);
      expect(p.defined![i]).toBe(k === -1 ? 0 : basket.defined[k]);
    }
    expect(broadPaths('C3', later, basket).signal).toEqual(p.signal);
    expect(() => broadPaths('C3', later)).toThrow(/basket/);
  });
});

describe('timing nulls', () => {
  const day0 = utc(2022, 1, 1);
  const bars = (symbol: string, startDay: number, values: number[]): { input: TrendSymbolInput; p: RulePaths } => {
    const input = contract(symbol, day0 + startDay * D, values.map(() => 100));
    return { input, p: paths(values.length, values, 1) };
  };

  it('(j) wrapped shifts every input by the same k, modulo its own full length', () => {
    const one = bars('A', 0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const two = bars('B', 3, [100, 101, 102, 103, 104, 105, 106]);
    const cal = { start: day0, days: 20 };
    const shifted = commonShiftPaths('wrapped', [one.input, two.input], { A: one.p, B: two.p }, 3, cal);
    expect(Array.from(shifted.A.signal)).toEqual([7, 8, 9, 0, 1, 2, 3, 4, 5, 6]);
    expect(Array.from(shifted.B.signal)).toEqual([104, 105, 106, 100, 101, 102, 103]);
    const twelve = commonShiftPaths('wrapped', [one.input, two.input], { A: one.p, B: two.p }, 12, cal);
    expect(Array.from(twelve.A.signal)).toEqual([8, 9, 0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Array.from(twelve.B.signal)).toEqual([102, 103, 104, 105, 106, 100, 101]);
    expect(shifted.A.size).toBe(one.p.size);
  });

  it('(j) aligned reads day d - k on a wrapping calendar and holds nothing outside an input\'s life', () => {
    const one = bars('A', 0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const two = bars('B', 5, [101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
    const full = bars('F', 0, Array.from({ length: 20 }, (_, i) => i + 1));
    const cal = { start: day0, days: 20 };
    const shifted = commonShiftPaths(
      'aligned',
      [one.input, two.input, full.input],
      { A: one.p, B: two.p, F: full.p },
      3,
      cal
    );
    expect(Array.from(shifted.A.signal)).toEqual([0, 0, 0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Array.from(shifted.B.signal)).toEqual([0, 0, 0, 101, 102, 103, 104, 105, 106, 107]);
    // The calendar wraps: day 0 reads day 17.
    expect(Array.from(shifted.F.signal.slice(0, 4))).toEqual([18, 19, 20, 1]);
    const outside = bars('O', 25, [1, 2]);
    expect(() => commonShiftPaths('aligned', [outside.input], { O: outside.p }, 3, cal)).toThrow(/outside the null calendar/);
  });

  it('(j) a shared state is shifted once for every input, modulo its own length (wrapped) or on the calendar (aligned)', () => {
    const state = new Float64Array(10);
    state[8] = 1;
    const shared = { days: Array.from({ length: 10 }, (_, i) => day0 + i * D), state };
    const x = bars('X', 0, new Array(15).fill(0));
    const cal = { start: day0, days: 20 };
    const wrapped = commonShiftPaths('wrapped', [x.input], { X: x.p }, 3, cal, shared);
    expect(Array.from(wrapped.X.signal).map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0)).toEqual([1]);
    const aligned = commonShiftPaths('aligned', [x.input], { X: x.p }, 3, cal, shared);
    expect(Array.from(aligned.X.signal).map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0)).toEqual([11]);
  });

  describe('timingNull with a common shift', () => {
    // A long contract over the whole calendar and a short one (400 bars), both members from 2023-06-01.
    const calendar = { calendarStart: day0, calendarDays: 900 };
    let seed = 5;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.06;
    const walk = (n: number) => {
      const out = [100];
      for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + noise()));
      return out;
    };
    const from = utc(2023, 6, 1);
    const to = utc(2024, 6, 1);
    const membership = [span(from, to, 1)];
    const a = contract('A', day0, walk(900), { membership });
    const b = contract('B', day0 + 500 * D, walk(400), { membership: [span(from, to, 2)] });
    const signalOf = (n: number) => Array.from({ length: n }, (_, i) => (Math.floor(i / 9) % 3 === 0 ? 0 : 1));
    const p = { A: paths(900, signalOf(900), 1), B: paths(400, signalOf(400), 1) };
    const opts = broadOpts(from, to);
    const run = runTrend([a, b], p, opts);
    const twin = runTrend([a, b], { A: paths(900, 1, 1), B: paths(400, 1, 1) }, opts);
    const range = { first: 0, last: run.days.length - 1 };
    const alpha = annualAlpha(run.returns, twin.returns).alpha;

    it.each(['wrapped', 'aligned'] as const)('%s draws one k per draw and applies it to every input', (mode) => {
      const seen: Array<{ k: number; shifted: Record<string, RulePaths> }> = [];
      const result = timingNull([a, b], p, twin.returns, alpha, opts, range, 6, 7, {
        mode,
        ...calendar,
        onDraw: (k, shifted) => seen.push({ k, shifted }),
      });
      expect(result.shifts).toHaveLength(6);
      expect(seen.map((s) => s.k)).toEqual(result.shifts);
      for (const { k, shifted } of seen) {
        expect(k).toBeGreaterThanOrEqual(365);
        expect(k).toBeLessThanOrEqual(900 - 365);
        const expected = commonShiftPaths(mode, [a, b], p, k, { start: day0, days: 900 });
        expect(Array.from(shifted.A.signal)).toEqual(Array.from(expected.A.signal));
        expect(Array.from(shifted.B.signal)).toEqual(Array.from(expected.B.signal));
      }
      expect(result.p * 7).toBeCloseTo(Math.round(result.p * 7), 9);
      expect(result.p).toBeGreaterThan(0);
      expect(result.p).toBeLessThanOrEqual(1);
      // Same seed, same draws.
      expect(timingNull([a, b], p, twin.returns, alpha, opts, range, 6, 7, { mode, ...calendar })).toEqual(result);
    });

    it.each(['independent', 'wrapped', 'aligned'] as const)(
      '%s: an undefined observed alpha is never a pass (p = 1, no draws)',
      (mode) => {
        const result = timingNull([a, b], p, twin.returns, Number.NaN, opts, range, 6, 7, { mode, ...calendar });
        expect(result.p).toBe(1);
        expect(result.draws).toBe(0);
      }
    );

    it('draws k = 365 + floor(u x (S - 729)) from one seeded uniform per draw', () => {
      const result = timingNull([a, b], p, twin.returns, alpha, opts, range, 6, 7, { mode: 'wrapped', ...calendar });
      const random = createSeededRandom(7);
      expect(result.shifts).toEqual(Array.from({ length: 6 }, () => 365 + Math.floor(random() * (900 - 729))));
    });

    it('wrapped reports the share of member-days whose input is no longer than k', () => {
      const result = timingNull([a, b], p, twin.returns, alpha, opts, range, 6, 7, { mode: 'wrapped', ...calendar });
      const aDays = memberDays(a, opts);
      const bDays = memberDays(b, opts);
      expect(aDays).toBe(bDays);
      const expected = result.shifts!.reduce((s, k) => s + (k >= 400 ? bDays / (aDays + bDays) : 0), 0) / 6;
      expect(result.misalignedShare).toBeCloseTo(expected, 12);
      expect(result.shifts!.some((k) => k >= 400)).toBe(true);
    });

    it('aligned leaves the short input empty where its shifted source lies outside its bars', () => {
      const seen: Array<{ k: number; shifted: Record<string, RulePaths> }> = [];
      timingNull([a, b], p, twin.returns, alpha, opts, range, 1, 7, {
        mode: 'aligned',
        ...calendar,
        onDraw: (k, shifted) => seen.push({ k, shifted }),
      });
      const { k, shifted } = seen[0];
      // B's bars are calendar days 500 to 899; bar i (day 500 + i) reads day 500 + i - k, wrapping at 900.
      let empty = 0;
      for (let i = 0; i < 400; i++) {
        const source = (((500 + i - k) % 900) + 900) % 900;
        const inLife = source >= 500;
        if (!inLife) empty++;
        expect(shifted.B.signal[i]).toBe(inLife ? p.B.signal[source - 500] : 0);
      }
      expect(empty).toBeGreaterThan(0);
    });

    it('the independent default is unchanged and still refuses a span too short to shift', () => {
      const legendsInput = (x: TrendSymbolInput): TrendSymbolInput => ({ ...x, membership: undefined, listingDay: from });
      const legendsOpts: SimOptions = { from, to, cost: BROAD_FEE, delay: 0 };
      expect(() =>
        timingNull([legendsInput(a), legendsInput(b)], p, twin.returns, alpha, legendsOpts, range, 2)
      ).toThrow(/too short/);
      expect(() =>
        timingNull([legendsInput(a), legendsInput(b)], p, twin.returns, alpha, legendsOpts, range, 2, 7, { mode: 'independent' })
      ).toThrow(/too short/);
      // 'wrapped' skips the length check.
      expect(() =>
        timingNull([legendsInput(a), legendsInput(b)], p, twin.returns, alpha, legendsOpts, range, 1, 7, { mode: 'wrapped', ...calendar })
      ).not.toThrow();
    });

    it('misalignedShare counts an input no longer than k, the boundary included', () => {
      expect(misalignedShare([400, 900], [10, 30], 399)).toBe(0);
      expect(misalignedShare([400, 900], [10, 30], 400)).toBeCloseTo(0.25, 15);
      expect(misalignedShare([400, 900], [10, 30], 900)).toBe(1);
      expect(misalignedShare([400], [0], 500)).toBeNaN();
    });

    it('defaults to the 2020-01-01 to 2026-06-30 calendar', () => {
      expect(NULL_CALENDAR_START).toBe(utc(2020, 1, 1));
      expect(NULL_CALENDAR_DAYS).toBe(2373);
    });
  });
});

describe('the cash invariant', () => {
  /*
   * (k) The invariant cannot be broken from outside a run: every day's PnL is
   * booked to a sleeve's capital and to the equity in the same step, and every
   * transfer (a split at a ranking close, a leaver's or a delisting's capital to
   * cash) moves one amount between capital and cash. So the helper the run calls
   * after every day and every ranking close is tested directly.
   */
  it('(k) passes within 1e-9 of max(1, equity) and throws beyond it', () => {
    expect(() => assertCashBalance(0.6, 0.4, 1, JAN1)).not.toThrow();
    expect(() => assertCashBalance(0.6, 0.4 + 5e-10, 1, JAN1)).not.toThrow();
    expect(() => assertCashBalance(0.6, 0.4 + 2e-9, 1, JAN1)).toThrow(/is not equity/);
    expect(() => assertCashBalance(600, 400 + 5e-7, 1000, JAN1)).not.toThrow();
    expect(() => assertCashBalance(600, 400 + 2e-6, 1000, JAN1)).toThrow(/is not equity/);
    expect(() => assertCashBalance(Number.NaN, 0, 1, JAN1)).toThrow();
  });
});

describe('broad input checks', () => {
  const n = at(utc(2024, 1, 10)) + 1;
  const ok = () => contract('A', START, flat(n, 100), { membership: [span(JAN1, FEB1, 1)] });
  const run = (input: TrendSymbolInput, extra: Partial<SimOptions> = {}) =>
    runTrend([input], { A: paths(input.t.length, 1, 1) }, broadOpts(JAN1, utc(2024, 1, 8), extra));

  it('a broad run starts at a ranking close', () => {
    expect(() => run(ok(), { from: utc(2024, 1, 2) })).toThrow(/ranking close/);
  });

  it('refuses a span that does not run between ranking closes, and overlapping spans', () => {
    expect(() => run({ ...ok(), membership: [span(utc(2024, 1, 15), FEB1, 1)] })).toThrow(/ranking close/);
    expect(() => run({ ...ok(), membership: [span(JAN1, MAR1, 1), span(FEB1, APR1, 1)] })).toThrow(/overlap/);
  });

  it('refuses a carried bar that does not repeat the last close, and an end day that is not the last bar', () => {
    const bad = contract('A', START, flat(n, 100), { carried: [3], membership: [span(JAN1, FEB1, 1)] });
    bad.close[3] = 101;
    expect(() => run(bad)).toThrow(/carried/);
    expect(() => run({ ...ok(), endDay: utc(2024, 1, 5) })).toThrow(/endDay/);
  });

  it('throws when an active member has no bar', () => {
    // Membership through February but bars only to 2024-01-10 and no end day.
    expect(() => run(ok(), { to: utc(2024, 1, 20) })).toThrow(/no bar/);
  });

  it('legends mode refuses broad-only fields rather than ignore them', () => {
    const legends: SimOptions = { from: JAN1, to: utc(2024, 1, 8), cost: BROAD_FEE, delay: 0 };
    expect(() => runTrend([ok()], { A: paths(n, 1, 1) }, legends)).toThrow(/SimOptions.broad/);
    const ended = contract('A', START, flat(n, 100), { ended: true });
    expect(() => runTrend([ended], { A: paths(n, 1, 1) }, legends)).toThrow(/SimOptions.broad/);
    const carried = contract('A', START, flat(n, 100), { carried: [2] });
    expect(() => runTrend([carried], { A: paths(n, 1, 1) }, legends)).toThrow(/SimOptions.broad/);
  });

  it('a sleeve re-selected before its exit filled stops the run', () => {
    const m = at(utc(2024, 3, 5)) + 1;
    const a = contract('A', START, flat(m, 100), { membership: [span(JAN1, FEB1, 1), span(MAR1, APR1, 1)] });
    // A 40-bar delay keeps the February exit pending past the March ranking close.
    expect(() => runTrend([a], { A: paths(m, 1, 1) }, broadOpts(JAN1, utc(2024, 3, 3), { delay: 40 }))).toThrow(/before its exit filled/);
  });
});
