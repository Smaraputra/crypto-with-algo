// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HOUR_MS } from './carry-sim';
import { SCOUT_CUTOFF_MS, normaliseSettlements } from './funding-scout';
import {
  EPS,
  LIQ_HIGH_MULTIPLE,
  LIQ_MAINTENANCE,
  LOCKED_PER_SIDE,
  READ_CUTOFF_MS,
  STEP_MS,
  acquireReadMarkers,
  archiveMonthsForSpan,
  assertLockBinding,
  assertRequestEnd,
  assertSpanAllowed,
  clusterBootstrapAnnual,
  clusterIndex,
  hyperliquidCandleRequest,
  hyperliquidFundingRequest,
  main,
  normaliseSettlementsSpan,
  parseHyperliquidCandlesSpan,
  parseHyperliquidFundingSpan,
  parseLockedArgs,
  profileReport,
  repriceNet,
  sha256Hex,
  simulateBook,
  spreadAt,
  summariseLocked,
  type BinanceEvent,
  type BookResult,
  type CoinSeries,
  type LockedParams,
  type Position,
  type PriceBar,
} from './venue-spread-locked';

// ---------------------------------------------------------------------------
// Fixture builder
//
// Decision times are T(k) = T0 + k x 8h. A series is built from the spreads S(T(k))
// it must show. Hyperliquid has an hourly event at every hour, all zero except the
// event AT T(k), which carries the block value b_k. Binance has an 8h event at every
// T(k) carrying bn[k] (default 0). The window (T - 24h, T] holds exactly the blocks
// k, k-1 and k-2, so
//   S_k = (b_k + b_{k-1} + b_{k-2}) - (bn_k + bn_{k-1} + bn_{k-2})
// and b_k = S_k + bnWindow_k - b_{k-1} - b_{k-2}. Funding of a position held from
// T(i) to T(j) is therefore sign x (b_{i+1} + ... + b_j - (bn_{i+1} + ... + bn_j)).
// Prices are flat (Binance 100, Hyperliquid 50) unless overridden by timestamp.
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2024, 0, 1);
const T = (k: number): number => T0 + k * STEP_MS;
const flat = (p: number): PriceBar => ({ open: p, high: p, low: p });
const BN_PRICE = 100;
const HL_PRICE = 50;

interface Spec {
  coin: string;
  /** Desired S at steps -pre .. last. */
  spreads: number[];
  pre?: number;
  /** Binance rate at step index k. */
  bn?: Record<number, number>;
  /** Hyperliquid hourly timestamps to drop. */
  dropHl?: number[];
  /** Binance 1h bar overrides by open time (null removes the bar). */
  bOver?: Record<number, PriceBar | null>;
  /** Hyperliquid 8h candle overrides by open time (null removes the candle). */
  hOver?: Record<number, PriceBar | null>;
}

function blocksOf(spec: Spec): { first: number; last: number; b: Map<number, number>; bn: Map<number, number> } {
  const pre = spec.pre ?? 0;
  const first = -pre;
  const last = spec.spreads.length - pre - 1;
  const bn = new Map<number, number>();
  const bnAt = (k: number): number => spec.bn?.[k] ?? 0;
  for (let k = first - 3; k <= last; k++) bn.set(k, bnAt(k));
  const b = new Map<number, number>();
  const bAt = (k: number): number => b.get(k) ?? 0;
  for (let k = first; k <= last; k++) {
    const bnWindow = bnAt(k) + bnAt(k - 1) + bnAt(k - 2);
    b.set(k, spec.spreads[k - first] + bnWindow - bAt(k - 1) - bAt(k - 2));
  }
  return { first, last, b, bn };
}

function build(spec: Spec): CoinSeries {
  const { first, last, b, bn } = blocksOf(spec);
  const drop = new Set(spec.dropHl ?? []);
  const hf: { t: number; rate: number }[] = [];
  for (let t = T(first - 3); t <= T(last); t += HOUR_MS) {
    if (drop.has(t)) continue;
    const k = (t - T0) / STEP_MS;
    hf.push({ t, rate: Number.isInteger(k) ? (b.get(k) ?? 0) : 0 });
  }
  const bf: BinanceEvent[] = [];
  for (let k = first - 3; k <= last; k++) bf.push({ t: T(k), rate: bn.get(k) ?? 0, intervalHours: 8 });

  const bpx = new Map<number, PriceBar>();
  for (let t = T(-2); t <= T(last); t += HOUR_MS) {
    const over = spec.bOver?.[t];
    if (over === null) continue;
    bpx.set(t, over ?? flat(BN_PRICE));
  }
  const hpx = new Map<number, PriceBar>();
  for (let k = -2; k <= last; k++) {
    const over = spec.hOver?.[T(k)];
    if (over === null) continue;
    hpx.set(T(k), over ?? flat(HL_PRICE));
  }
  return { coin: spec.coin, symbol: `${spec.coin}USDT`, bf, hf, bpx, hpx };
}

const BASE: LockedParams = { fromT: T(0), lastT: T(5), slots: 10, level: 0.002, perSide: 0.00185, entryDelaySteps: 0 };

function run(specs: Spec[], over: Partial<LockedParams> = {}): BookResult {
  return simulateBook(specs.map(build), { ...BASE, ...over });
}

function expectPosition(p: Position, want: Partial<Position>): void {
  const { funding, basis, net, entryS, ...exact } = want;
  expect(p).toMatchObject(exact);
  if (funding !== undefined) expect(p.funding).toBeCloseTo(funding, 12);
  if (basis !== undefined) expect(p.basis).toBeCloseTo(basis, 12);
  if (net !== undefined) expect(p.net).toBeCloseTo(net, 12);
  if (entryS !== undefined) expect(p.entryS).toBeCloseTo(entryS, 12);
}

const COST = 2 * LOCKED_PER_SIDE;

describe('constants', () => {
  it('has the documented grid and tolerance', () => {
    expect(STEP_MS).toBe(8 * HOUR_MS);
    expect(EPS).toBe(1e-12);
    expect(READ_CUTOFF_MS).toBe(Date.UTC(2024, 6, 1));
  });
});

describe('1. entry on a crossing and exit on the sign flip', () => {
  it('opens at step 2 and closes at step 4 with hand-computed funding, basis and net', () => {
    // b: b2 = 0.003, b3 = 0.0025 + 0.0004 - 0.003 = -0.0001, b4 = -0.001 + 0.0005 - (-0.0001) - 0.003 = -0.0034.
    // Funding over (T2, T4] = sign x ((b3 + b4) - (bn3 + bn4)) = (-0.0035) - 0.0005 = -0.004.
    // Basis: long Binance 102 / 100 - 1 = 0.02, short Hyperliquid -(49 / 50 - 1) = 0.02.
    const book = run([
      {
        coin: 'A',
        spreads: [0, 0, 0.003, 0.0025, -0.001, -0.001],
        bn: { 3: 0.0004, 4: 0.0001 },
        bOver: { [T(4)]: flat(102) },
        hOver: { [T(4)]: flat(49) },
      },
    ]);
    expect(book.positions).toHaveLength(1);
    expectPosition(book.positions[0], {
      coin: 'A',
      symbol: 'AUSDT',
      sign: 1,
      entryT: T(2),
      exitT: T(4),
      entryS: 0.003,
      funding: -0.004,
      basis: 0.04,
      net: -0.004 + 0.04 - COST,
      reason: 'signal',
    });
    expect(book.counts).toEqual({ noSlot: 0, noPrice: 0, noCoverage: 0 });
  });

  it('takes the short side for a negative spread', () => {
    const book = run([{ coin: 'N', spreads: [0, 0, -0.003, -0.003, -0.003, -0.003] }]);
    expect(book.positions[0].sign).toBe(-1);
    expect(book.positions[0].entryS).toBeCloseTo(-0.003, 12);
  });
});

describe('2. first-step bypass and blocked crossings', () => {
  it('enters at the first step even when the previous spread was already above the level', () => {
    const book = run([{ coin: 'B', pre: 1, spreads: [0.003, 0.003, 0.003, 0.003, 0.003, 0.003, 0.003] }]);
    expect(book.positions).toHaveLength(1);
    expect(book.positions[0]).toMatchObject({ entryT: T(0), exitT: T(5), reason: 'end' });
  });

  it('does not enter later when the spread stays above the level after a blocked crossing', () => {
    const book = run(
      [
        { coin: 'A', spreads: [0, 0.004, 0.004, -0.001, -0.001, -0.001] },
        { coin: 'C', spreads: [0, 0.003, 0.003, 0.003, 0.003, 0.003] },
      ],
      { slots: 1 }
    );
    expect(book.positions.map((p) => p.coin)).toEqual(['A']);
    expect(book.positions[0]).toMatchObject({ entryT: T(1), exitT: T(3), reason: 'signal' });
    expect(book.counts.noSlot).toBe(1);
  });
});

describe('3. ordering of simultaneous crossings', () => {
  it('lets the larger |S| take the only slot', () => {
    const book = run(
      [
        { coin: 'X', spreads: [0, 0, 0.003, 0.003, 0.003, 0.003] },
        { coin: 'Y', spreads: [0, 0, 0.004, 0.004, 0.004, 0.004] },
      ],
      { slots: 1 }
    );
    expect(book.positions.map((p) => p.coin)).toEqual(['Y']);
    expect(book.counts.noSlot).toBe(1);
  });

  it('compares |S|, not S, so a larger negative spread wins', () => {
    const book = run(
      [
        { coin: 'POS', spreads: [0, 0, 0.003, 0.003, 0.003, 0.003] },
        { coin: 'NEG', spreads: [0, 0, -0.004, -0.004, -0.004, -0.004] },
      ],
      { slots: 1 }
    );
    expect(book.positions.map((p) => [p.coin, p.sign])).toEqual([['NEG', -1]]);
  });

  it('breaks an exact tie by the smaller coin name', () => {
    const book = run(
      [
        { coin: 'BBB', spreads: [0, 0, 0.003, 0.003, 0.003, 0.003] },
        { coin: 'AAA', spreads: [0, 0, 0.003, 0.003, 0.003, 0.003] },
      ],
      { slots: 1 }
    );
    expect(book.positions.map((p) => p.coin)).toEqual(['AAA']);
    expect(book.counts.noSlot).toBe(1);
  });
});

describe('4. coverage', () => {
  const t = T(3);
  const hlHours = (drop: number): { t: number; rate: number }[] =>
    Array.from({ length: 24 }, (_, i) => ({ t: t - (23 - i) * HOUR_MS, rate: 0.001 })).slice(drop);
  const series = (hf: { t: number; rate: number }[], bnTimes: number[], intervalHours = 8): CoinSeries => ({
    coin: 'Z',
    symbol: 'ZUSDT',
    hf,
    bf: bnTimes.map((bt) => ({ t: bt, rate: 0.0005, intervalHours })),
    bpx: new Map(),
    hpx: new Map(),
  });

  it('needs 22 Hyperliquid events in the window', () => {
    const bn = [t - 8 * HOUR_MS, t];
    expect(spreadAt(series(hlHours(2), bn), t)).toBeCloseTo(22 * 0.001 - 0.001, 12);
    expect(spreadAt(series(hlHours(3), bn), t)).toBeNull();
  });

  it('excludes the event at T - 24h and any event after T', () => {
    const hf = [{ t: t - 24 * HOUR_MS, rate: 9 }, ...hlHours(2), { t: t + HOUR_MS, rate: 9 }];
    expect(spreadAt(series(hf, [t - 8 * HOUR_MS, t]), t)).toBeCloseTo(0.022 - 0.001, 12);
  });

  it('needs 24 / intervalHours - 1 Binance events: 2 at 8h, 5 at 4h, and an event at or before T', () => {
    const hl = hlHours(0);
    expect(spreadAt(series(hl, [t]), t)).toBeNull();
    expect(spreadAt(series(hl, [t - 8 * HOUR_MS, t]), t)).not.toBeNull();
    const four = (n: number): number[] => Array.from({ length: n }, (_, i) => t - i * 4 * HOUR_MS);
    expect(spreadAt(series(hl, four(4), 4), t)).toBeNull();
    expect(spreadAt(series(hl, four(5), 4), t)).not.toBeNull();
    expect(spreadAt(series(hl, [t + 8 * HOUR_MS]), t)).toBeNull();
  });

  it('does not enter a crossing without coverage and counts it once', () => {
    // Three zero-rate hours before T2 are missing, so coverage fails at T2, T3 and T4 and returns at T5 (= lastT).
    const book = run([
      {
        coin: 'Q',
        spreads: [0, 0, 0.003, 0.003, 0.003, 0.003],
        dropHl: [T(2) - 3 * HOUR_MS, T(2) - 2 * HOUR_MS, T(2) - HOUR_MS],
      },
    ]);
    expect(book.positions).toHaveLength(0);
    expect(book.counts).toEqual({ noSlot: 0, noPrice: 0, noCoverage: 1 });
  });
});

describe('5. missing prices', () => {
  it('counts noPrice when a price at the entry step is missing', () => {
    const book = run([{ coin: 'A', spreads: [0, 0, 0.003, 0.003, 0.003, 0.003], bOver: { [T(2)]: null } }]);
    expect(book.positions).toHaveLength(0);
    expect(book.counts.noPrice).toBe(1);
  });

  it('closes as unavailable at the last step with both prices, funding up to it', () => {
    // b1 = 0.003, b2 = 0.004 - 0.003 = 0.001. Held T1 to T2: funding = b2 = 0.001.
    // Exit opens are those of T2 (Binance 101, Hyperliquid 49.5), not T3's Binance 120.
    const book = run([
      {
        coin: 'A',
        spreads: [0, 0.003, 0.004, 0.004, 0.004, 0.004],
        bOver: { [T(2)]: flat(101), [T(3)]: flat(120) },
        hOver: { [T(2)]: flat(49.5), [T(3)]: null },
      },
    ]);
    expect(book.positions).toHaveLength(1);
    expectPosition(book.positions[0], {
      entryT: T(1),
      exitT: T(2),
      funding: 0.001,
      basis: 0.02,
      net: 0.001 + 0.02 - COST,
      reason: 'unavailable',
    });
  });
});

describe('6. liquidation (short leg only, at 2 / 1.05 of its entry open)', () => {
  // longCoin: sign +1, long Binance, SHORT Hyperliquid, entered at T1. shortCoin: sign -1, long Hyperliquid, SHORT Binance.
  const longCoin = (extra: Partial<Spec>): Spec => ({
    coin: 'L',
    spreads: [0, 0.003, 0.003, 0.003, 0.003, 0.003],
    ...extra,
  });
  const shortCoin = (extra: Partial<Spec>): Spec => ({
    coin: 'S',
    spreads: [0, -0.003, -0.003, -0.003, -0.003, -0.003],
    ...extra,
  });

  it('defines the multiple as 2 / (1 + 5 percent)', () => {
    expect(LIQ_MAINTENANCE).toBe(0.05);
    expect(LIQ_HIGH_MULTIPLE).toBeCloseTo(1.9047619047619047, 15);
  });

  it('does not liquidate a short Hyperliquid leg whose step high is just below 1.9047 times its entry', () => {
    // 50 x 1.9047 = 95.235 < 95.2381.
    const book = run([longCoin({ hOver: { [T(1)]: { open: 50, high: 95.235, low: 50 } } })]);
    expect(book.positions[0]).toMatchObject({ entryT: T(1), exitT: T(5), reason: 'end' });
  });

  it('liquidates a short Hyperliquid leg whose step high is 1.905 times its entry, short return -1', () => {
    // 50 x 1.905 = 95.25. Long Binance leg 101 / 100 - 1 = 0.01, short leg replaced by -1.
    const book = run([
      longCoin({
        hOver: { [T(1)]: { open: 50, high: 95.25, low: 50 } },
        bOver: { [T(2)]: flat(101) },
      }),
    ]);
    expect(book.positions).toHaveLength(1);
    expectPosition(book.positions[0], {
      entryT: T(1),
      exitT: T(2),
      funding: 0,
      basis: 0.01 - 1,
      net: -0.99 - COST,
      reason: 'liquidated',
    });
  });

  it('liquidates a short Hyperliquid leg at exactly the multiple and at 2.0 times its entry', () => {
    const exact = run([longCoin({ hOver: { [T(1)]: { open: 50, high: LIQ_HIGH_MULTIPLE * 50, low: 50 } } })]);
    expect(exact.positions[0].reason).toBe('liquidated');
    const double = run([longCoin({ hOver: { [T(1)]: { open: 50, high: 100, low: 50 } } })]);
    expect(double.positions[0].reason).toBe('liquidated');
  });

  it('tests the high against the entry open, not the open of the step', () => {
    // Entered at T1 at 50. Step (T2, T3] candle opens at 80 with high 100: 100 / 50 = 2 >= multiple.
    const book = run([longCoin({ hOver: { [T(2)]: { open: 80, high: 100, low: 80 } } })]);
    expect(book.positions[0]).toMatchObject({ entryT: T(1), exitT: T(3), reason: 'liquidated' });
  });

  it('does not liquidate a short Binance leg whose step high is just below 1.9047 times its entry', () => {
    // 100 x 1.9047 = 190.47 < 190.476.
    const book = run([shortCoin({ bOver: { [T(1) + HOUR_MS]: { open: 100, high: 190.47, low: 100 } } })]);
    expect(book.positions[0]).toMatchObject({ sign: -1, entryT: T(1), exitT: T(5), reason: 'end' });
  });

  it('liquidates a short Binance leg (sign -1) whose step high is 1.905 times its entry, short return -1', () => {
    // Long Hyperliquid leg 52 / 50 - 1 = 0.04, short Binance leg replaced by -1.
    const book = run([
      shortCoin({
        bOver: { [T(1) + 7 * HOUR_MS]: { open: 100, high: 190.5, low: 100 } },
        hOver: { [T(2)]: flat(52) },
      }),
    ]);
    expectPosition(book.positions[0], {
      sign: -1,
      entryT: T(1),
      exitT: T(2),
      basis: 0.04 - 1,
      net: -0.96 - COST,
      reason: 'liquidated',
    });
  });

  it('counts a Binance spike in the bar opening T(2) only in the step ending at T(3)', () => {
    // The bar opening T(2) belongs to the step (T2, T3], not to the step ending at T2, so the position survives T2.
    const book = run([shortCoin({ bOver: { [T(2)]: { open: 100, high: 300, low: 100 } } })]);
    expect(book.positions[0]).toMatchObject({ entryT: T(1), exitT: T(3), reason: 'liquidated' });
  });

  it('never liquidates a long leg: Binance long crashing to 0.001 of its entry', () => {
    const book = run([longCoin({ bOver: { [T(1) + 3 * HOUR_MS]: { open: 100, high: 100, low: 0.1 } } })]);
    expect(book.positions[0].reason).toBe('end');
  });

  it('never liquidates a long leg: Hyperliquid long crashing to 0.001 of its entry', () => {
    const book = run([shortCoin({ hOver: { [T(1)]: { open: 50, high: 50, low: 0.05 } } })]);
    expect(book.positions[0].reason).toBe('end');
  });

  it('does not liquidate when the long leg doubles and the short leg collapses', () => {
    const plus = run([
      longCoin({
        bOver: { [T(1) + 2 * HOUR_MS]: { open: 100, high: 200, low: 100 } },
        hOver: { [T(1)]: { open: 50, high: 50, low: 0.1 } },
      }),
    ]);
    expect(plus.positions[0].reason).toBe('end');
    const minus = run([
      shortCoin({
        hOver: { [T(1)]: { open: 50, high: 100, low: 50 } },
        bOver: { [T(1) + 2 * HOUR_MS]: { open: 100, high: 100, low: 0.1 } },
      }),
    ]);
    expect(minus.positions[0].reason).toBe('end');
  });

  it('liquidation takes precedence over unavailability: closes as liquidated at the stored opens of T - 8h', () => {
    // Entered T1 (opens 100 and 50). Step (T2, T3]: Hyperliquid candle T2 has high 96 (>= 95.238, the multiple times the entry open 50), and the Hyperliquid candle at T3 is missing.
    // Stored last prices are the opens of T2 (Binance 104, Hyperliquid 48). Funding is counted up to T2:
    // spreads give b1 = 0.003, b2 = 0.004 - 0.003 = 0.001, b3 = 0.0045 - 0.001 - 0.003 = 0.0005, so (T1, T2] = 0.001 and not 0.0015.
    // Long Binance return 104 / 100 - 1 = 0.04, short Hyperliquid return -1.
    const book = run([
      {
        coin: 'L',
        spreads: [0, 0.003, 0.004, 0.0045, 0.0045, 0.0045],
        bOver: { [T(2)]: flat(104), [T(3)]: flat(130) },
        hOver: { [T(2)]: { open: 48, high: 96, low: 48 }, [T(3)]: null },
      },
    ]);
    expect(book.positions).toHaveLength(1);
    expectPosition(book.positions[0], {
      sign: 1,
      entryT: T(1),
      exitT: T(2),
      funding: 0.001,
      basis: 0.04 - 1,
      net: 0.001 + 0.04 - 1 - COST,
      reason: 'liquidated',
    });
  });

  it('liquidation takes precedence over unavailability for a short Binance leg with the Binance bar at T missing', () => {
    // sign -1: long Hyperliquid, short Binance. Entered T1. Spike in the bar opening T2 + 2h (step (T2, T3]), Binance bar at T3 missing.
    // Stored opens of T2: Binance 100, Hyperliquid 51. Long Hyperliquid return 51 / 50 - 1 = 0.02, short Binance -1.
    const book = run([
      {
        coin: 'S',
        spreads: [0, -0.003, -0.003, -0.003, -0.003, -0.003],
        bOver: { [T(2) + 2 * HOUR_MS]: { open: 100, high: 191, low: 100 }, [T(3)]: null },
        hOver: { [T(2)]: flat(51) },
      },
    ]);
    expect(book.positions).toHaveLength(1);
    expect(book.positions[0]).toMatchObject({ sign: -1, entryT: T(1), exitT: T(2), reason: 'liquidated' });
    expect(book.positions[0].basis).toBeCloseTo(0.02 - 1, 12);
  });

  it('still closes as unavailable when a price at T is missing and the step had no spike', () => {
    const book = run([
      longCoin({
        bOver: { [T(1) + 3 * HOUR_MS]: { open: 100, high: 100, low: 0.4 } },
        hOver: { [T(2)]: null },
      }),
    ]);
    expect(book.positions[0]).toMatchObject({ entryT: T(1), exitT: T(1), reason: 'unavailable' });
    expect(book.positions[0].basis).toBe(0);
  });
});

describe('7. end of span', () => {
  it('closes an open position at lastT with its cost, and lets no coin enter at lastT', () => {
    // b1 = 0.003, b2 = 0, b3 = 0, b4 = 0.003, b5 = 0. Funding over (T1, T5] = 0.003.
    const book = run([
      { coin: 'A', spreads: [0, 0.003, 0.003, 0.003, 0.003, 0.003] },
      { coin: 'D', spreads: [0, 0, 0, 0, 0, 0.003] },
    ]);
    expect(book.positions).toHaveLength(1);
    expectPosition(book.positions[0], {
      coin: 'A',
      entryT: T(1),
      exitT: T(5),
      funding: 0.003,
      basis: 0,
      net: 0.003 - COST,
      reason: 'end',
    });
    expect(book.counts).toEqual({ noSlot: 0, noPrice: 0, noCoverage: 0 });
  });
});

describe('8. one-step entry delay', () => {
  it('enters a step-2 crossing at the opens of step 3', () => {
    // b2 = 0.003, b3 = 0, b4 = 0, b5 = 0.003. Funding over (T3, T5] = 0.003.
    const book = run([{ coin: 'A', spreads: [0, 0, 0.003, 0.003, 0.003, 0.003], bOver: { [T(3)]: flat(103) }, hOver: { [T(3)]: flat(51) } }], {
      entryDelaySteps: 1,
    });
    expect(book.positions).toHaveLength(1);
    expectPosition(book.positions[0], {
      entryT: T(3),
      exitT: T(5),
      entryS: 0.003,
      funding: 0.003,
      basis: 100 / 103 - 1 - (50 / 51 - 1),
      net: 0.003 + (100 / 103 - 1 - (50 / 51 - 1)) - COST,
      reason: 'end',
    });
  });

  it('drops crossings found at lastT and the queue due at lastT', () => {
    const book = run(
      [
        { coin: 'A', spreads: [0, 0, 0, 0, 0, 0.003] },
        { coin: 'B', spreads: [0, 0, 0, 0, 0.003, 0.003] },
      ],
      { entryDelaySteps: 1 }
    );
    expect(book.positions).toHaveLength(0);
    expect(book.counts).toEqual({ noSlot: 0, noPrice: 0, noCoverage: 0 });
  });

  it('counts noSlot for a queued entry that finds no free slot', () => {
    const book = run(
      [
        { coin: 'P', spreads: [0, 0.004, 0.004, 0.004, 0.004, 0.004] },
        { coin: 'Q', spreads: [0, 0, 0.003, 0.003, 0.003, 0.003] },
      ],
      { entryDelaySteps: 1, slots: 1 }
    );
    expect(book.positions.map((p) => [p.coin, p.entryT])).toEqual([['P', T(2)]]);
    expect(book.counts.noSlot).toBe(1);
  });

  it('counts noPrice for a queued entry whose prices are missing at execution', () => {
    const book = run([{ coin: 'R', spreads: [0, 0, 0.003, 0.003, 0.003, 0.003], bOver: { [T(3)]: null } }], {
      entryDelaySteps: 1,
    });
    expect(book.positions).toHaveLength(0);
    expect(book.counts.noPrice).toBe(1);
  });
});

describe('9. a position closed at T frees its slot for an entry at the same T', () => {
  it('lets B enter at the step where A exits', () => {
    const book = run(
      [
        { coin: 'A', spreads: [0, 0.004, 0.004, -0.002, -0.002, -0.002] },
        { coin: 'B', spreads: [0, 0, 0, 0.003, 0.003, 0.003] },
      ],
      { slots: 1 }
    );
    expect(book.positions.map((p) => [p.coin, p.entryT, p.exitT, p.reason])).toEqual([
      ['A', T(1), T(3), 'signal'],
      ['B', T(3), T(5), 'end'],
    ]);
    expect(book.counts.noSlot).toBe(0);
  });
});

describe('10. repriceNet and profileReport', () => {
  const p: Position = {
    coin: 'A',
    symbol: 'AUSDT',
    sign: 1,
    entryT: T(1),
    exitT: T(2),
    entryS: 0.003,
    funding: 0,
    basis: 0,
    net: 0.01,
    reason: 'signal',
  };

  it('adds 2 x (lockedPerSide - perSide)', () => {
    expect(repriceNet(p, 0.00155, LOCKED_PER_SIDE)).toBeCloseTo(0.01 + 2 * (0.00185 - 0.00155), 14);
    expect(repriceNet(p, LOCKED_PER_SIDE, LOCKED_PER_SIDE)).toBe(0.01);
  });

  it('reports the annual point return for the four profiles', () => {
    const opts = { fromT: T(0), endT: T(0) + 365 * 24 * HOUR_MS, slots: 10 };
    const report = profileReport({ positions: [p, p], counts: { noSlot: 0, noPrice: 0, noCoverage: 0 } }, opts);
    expect(report.map((r) => r.name)).toEqual(['locked', 'taker', 'taker+10bps', 'locked+5bps']);
    for (const row of report) {
      const expected = (2 * (0.01 + 2 * (0.00185 - row.perSide))) / 20 / 1;
      expect(row.annual).toBeCloseTo(expected, 12);
    }
    expect(report.map((r) => r.perSide)).toEqual([0.00185, 0.00155, 0.00355, 0.00285]);
  });
});

describe('11. cluster bootstrap', () => {
  const pos = (entryT: number, net: number): Position => ({
    coin: 'A',
    symbol: 'AUSDT',
    sign: 1,
    entryT,
    exitT: entryT + STEP_MS,
    entryS: 0.003,
    funding: 0,
    basis: 0,
    net,
    reason: 'signal',
  });
  const DAY = 24 * HOUR_MS;

  it('indexes seven-day clusters from fromT', () => {
    expect(clusterIndex(T0, T0)).toBe(0);
    expect(clusterIndex(T0 + 7 * DAY - 1, T0)).toBe(0);
    expect(clusterIndex(T0 + 7 * DAY, T0)).toBe(1);
    expect(clusterIndex(T0 + 20 * DAY, T0)).toBe(2);
  });

  it('matches the hand derivation for 3 positions in 2 clusters', () => {
    // Span 14 days: W = 2, years = 14 / 365, slots 1 so capital = 2.
    // Cluster sums: c0 = 0.25 + 0.125 = 0.375, c1 = 0.5. Total 0.875.
    // point = 0.875 / 2 / (14 / 365) = 11.40625.
    // mulberry32(12345), two draws per resample, k = floor(u x 2), five resamples:
    //   (1,0) (0,1) (1,0) (0,1) (1,1) -> sums 0.875, 0.875, 0.875, 0.875, 1.0
    //   -> annuals 11.40625 x 4 and 1.0 / 2 / (14 / 365) = 13.035714285714285.
    // Sorted, q(0.025): position 0.1 x 4 ... (4 x 0.1 = 0.1) -> 11.40625.
    // q(0.975): position 3.9 -> 11.40625 + 0.9 x (13.035714285714285 - 11.40625) = 12.872767857142856.
    const result = clusterBootstrapAnnual([pos(T0, 0.25), pos(T0 + DAY, 0.125), pos(T0 + 8 * DAY, 0.5)], {
      fromT: T0,
      endT: T0 + 14 * DAY,
      slots: 1,
      seed: 12345,
      resamples: 5,
    });
    expect(result.W).toBe(2);
    expect(result.capital).toBe(2);
    expect(result.years).toBeCloseTo(14 / 365, 14);
    expect(result.point).toBeCloseTo(11.40625, 10);
    expect(result.lo).toBeCloseTo(11.40625, 10);
    expect(result.hi).toBeCloseTo(12.872767857142856, 10);
  });

  it('gives lo = hi = point when every cluster has the same sum', () => {
    const result = clusterBootstrapAnnual([pos(T0, 0.25), pos(T0 + DAY, 0.25), pos(T0 + 8 * DAY, 0.5)], {
      fromT: T0,
      endT: T0 + 14 * DAY,
      slots: 1,
      seed: 99,
      resamples: 50,
    });
    expect(result.lo).toBe(result.point);
    expect(result.hi).toBe(result.point);
  });

  it('has W = 105 and years = 2 over the lock span, capital 20', () => {
    const result = clusterBootstrapAnnual([], {
      fromT: Date.UTC(2024, 6, 1),
      endT: Date.UTC(2026, 6, 1),
      slots: 10,
      seed: 20261111,
      resamples: 3,
    });
    expect(result).toMatchObject({ W: 105, years: 2, capital: 20, point: 0, lo: 0, hi: 0 });
  });

  it('throws for a position outside the span', () => {
    expect(() =>
      clusterBootstrapAnnual([pos(T0 + 30 * DAY, 1)], { fromT: T0, endT: T0 + 14 * DAY, slots: 1, seed: 1, resamples: 2 })
    ).toThrow(/outside the span/);
  });
});

describe('12. summariseLocked', () => {
  const FROM = Date.UTC(2024, 6, 1);
  const END = Date.UTC(2026, 6, 1);
  const DAY = 24 * HOUR_MS;
  const pos = (entryT: number, net: number, coin = 'A', reason: Position['reason'] = 'signal', holdMs = STEP_MS): Position => ({
    coin,
    symbol: `${coin}USDT`,
    sign: 1,
    entryT,
    exitT: entryT + holdMs,
    entryS: 0.003,
    funding: 0,
    basis: 0,
    net,
    reason,
  });
  const book = (positions: Position[]): BookResult => ({ positions, counts: { noSlot: 1, noPrice: 2, noCoverage: 3 } });
  const weekly = (net: number): Position[] => Array.from({ length: 105 }, (_, w) => pos(FROM + w * 7 * DAY, net));
  const opts = { fromT: FROM, endT: END, slots: 10, seed: 20261111, resamples: 500 };

  it('passes when the point is at least the hurdle and the lower end is above 0', () => {
    // 105 x 0.2 = 21; 21 / 20 / 2 = 0.525. Every cluster has the same sum, so lo = point.
    const s = summariseLocked(book(weekly(0.2)), opts);
    expect(s.annual.point).toBeCloseTo(0.525, 12);
    expect(s.annual.lo).toBeGreaterThan(0);
    expect(s.pass).toBe(true);
    expect(s.hurdle).toBe(0.05);
  });

  it('fails when the point is below the hurdle although lo > 0', () => {
    const s = summariseLocked(book(weekly(0.01)), opts);
    expect(s.annual.point).toBeCloseTo(0.02625, 12);
    expect(s.annual.lo).toBeGreaterThan(0);
    expect(s.pass).toBe(false);
  });

  it('fails when the point clears the hurdle but the lower end is not above 0', () => {
    // All profit in week 0: point = 3 / 20 / 2 = 0.075, and about 37 percent of resamples miss that cluster.
    const s = summariseLocked(book([pos(FROM, 3)]), opts);
    expect(s.annual.point).toBeCloseTo(0.075, 12);
    expect(s.annual.lo).toBe(0);
    expect(s.pass).toBe(false);
  });

  it('breaks results down by half-year, year and reason, and reports slot use and the worst position', () => {
    const span = { fromT: FROM, endT: Date.UTC(2025, 6, 1), slots: 2, seed: 7, resamples: 20 };
    const a = pos(Date.UTC(2024, 6, 10), 0.04, 'A', 'signal', DAY);
    const b = pos(Date.UTC(2024, 11, 31), -0.02, 'B', 'liquidated', 2 * DAY);
    const c = pos(Date.UTC(2025, 0, 2), 0.1, 'A', 'end', DAY);
    const s = summariseLocked(book([a, b, c]), span);
    // capital = 2 x 2 = 4.
    expect(Object.keys(s.byHalfYear)).toEqual(['2024-H2', '2025-H1']);
    expect(s.byHalfYear['2024-H2'].n).toBe(2);
    expect(s.byHalfYear['2024-H2'].sumNet).toBeCloseTo(0.02, 12);
    expect(s.byHalfYear['2024-H2'].returnOnCapital).toBeCloseTo(0.005, 12);
    expect(s.byHalfYear['2025-H1']).toEqual({ n: 1, sumNet: 0.1, returnOnCapital: 0.025 });
    expect(Object.keys(s.byYear)).toEqual(['2024', '2025']);
    expect(s.byYear['2024'].returnOnCapital).toBeCloseTo(0.005, 12);
    expect(s.byYear['2025'].sumNet).toBeCloseTo(0.1, 12);
    expect(s.byReason).toEqual({ signal: 1, unavailable: 0, end: 1, liquidated: 1 });
    expect(s.counts).toEqual({ noSlot: 1, noPrice: 2, noCoverage: 3 });
    expect(s.distinctCoins).toBe(2);
    expect(s.worst).toEqual({ net: -0.02, coin: 'B', entryT: Date.UTC(2024, 11, 31) });
    // (1 + 2 + 1) days / (2 slots x 365 days).
    expect(s.slotUse).toBeCloseTo(4 / 730, 12);
  });

  it('has a null worst position for an empty book', () => {
    expect(summariseLocked(book([]), opts).worst).toBeNull();
  });
});

describe('13. assertSpanAllowed', () => {
  let dir: string;
  let lock: string;
  let sha: string;
  let out: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'venue-locked-'));
    lock = join(dir, 'lock.md');
    writeFileSync(lock, 'frozen lock text\n');
    sha = sha256Hex(Buffer.from('frozen lock text\n'));
    out = join(dir, 'report.json');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('allows a span ending at the cutoff with no lock', () => {
    expect(() => assertSpanAllowed(READ_CUTOFF_MS, { out })).not.toThrow();
    expect(() => assertSpanAllowed(READ_CUTOFF_MS - 1, { out })).not.toThrow();
  });

  it('refuses a later span without a lock file or sha', () => {
    expect(() => assertSpanAllowed(READ_CUTOFF_MS + 1, { out })).toThrow(/--lock-file/);
    expect(() => assertSpanAllowed(READ_CUTOFF_MS + 1, { out, lockFile: lock })).toThrow(/--lock-sha256/);
    expect(() => assertSpanAllowed(READ_CUTOFF_MS + 1, { out, lockSha256: sha })).toThrow(/--lock-file/);
  });

  it('refuses a wrong sha and a missing lock file', () => {
    expect(() => assertSpanAllowed(READ_CUTOFF_MS + 1, { out, lockFile: lock, lockSha256: 'ab'.repeat(32) })).toThrow(
      /does not equal/
    );
    expect(() => assertSpanAllowed(READ_CUTOFF_MS + 1, { out, lockFile: join(dir, 'none.md'), lockSha256: sha })).toThrow(
      /does not exist/
    );
  });

  it('passes with the correct sha and no marker, and refuses once the marker exists', () => {
    expect(() => assertSpanAllowed(Date.UTC(2026, 6, 1), { out, lockFile: lock, lockSha256: sha })).not.toThrow();
    writeFileSync(`${out}.read-done`, 'x');
    expect(() => assertSpanAllowed(Date.UTC(2026, 6, 1), { out, lockFile: lock, lockSha256: sha })).toThrow(/read-done/);
    // The marker only blocks spans beyond the cutoff.
    expect(() => assertSpanAllowed(READ_CUTOFF_MS, { out })).not.toThrow();
  });

  it('refuses once the marker beside the lock file exists', () => {
    rmSync(`${out}.read-done`, { force: true });
    expect(() => assertSpanAllowed(Date.UTC(2026, 6, 1), { out, lockFile: lock, lockSha256: sha })).not.toThrow();
    writeFileSync(`${lock}.read-done`, 'x');
    expect(() => assertSpanAllowed(Date.UTC(2026, 6, 1), { out, lockFile: lock, lockSha256: sha })).toThrow(
      /lock\.md\.read-done/
    );
    rmSync(`${lock}.read-done`, { force: true });
  });

  it('main refuses a late span before reading any file or making any request', async () => {
    const args = [
      '--universe', join(dir, 'missing-universe.json'),
      '--cache', join(dir, 'cache'),
      '--out', join(dir, 'other.json'),
      '--hl-meta', join(dir, 'missing-meta.json'),
      '--from', '2024-07-01',
      '--end', '2024-07-09',
    ];
    await expect(main(args)).rejects.toThrow(/span guard/);
  });
});

describe('13b. assertLockBinding', () => {
  const binding = {
    universeSha256: 'aa'.repeat(32),
    metaSha256: 'bb'.repeat(32),
    fromIso: '2024-07-01T00:00:00.000Z',
    endIso: '2026-07-01T00:00:00.000Z',
    coins: null,
  };
  const text = `lock ${binding.universeSha256} ${binding.metaSha256} ${binding.fromIso} ${binding.endIso}\n`;

  it('passes when the lock text holds all four strings and coins is null', () => {
    expect(() => assertLockBinding(text, binding)).not.toThrow();
  });

  it.each([
    ['universeSha256', binding.universeSha256],
    ['metaSha256', binding.metaSha256],
    ['fromIso', binding.fromIso],
    ['endIso', binding.endIso],
  ])('throws when the lock text lacks %s', (name, value) => {
    expect(() => assertLockBinding(text.replace(value, 'xxxx'), binding)).toThrow(new RegExp(name));
  });

  it('throws when coins is given, even an empty list', () => {
    expect(() => assertLockBinding(text, { ...binding, coins: ['BTC'] })).toThrow(/--coins/);
    expect(() => assertLockBinding(text, { ...binding, coins: [] })).toThrow(/--coins/);
  });
});

describe('13c. acquireReadMarkers', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'venue-markers-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const sha = 'cd'.repeat(32);

  it('creates both markers with a started line, completes them, and refuses a second call', () => {
    const out = join(dir, 'a-report.json');
    const lockFile = join(dir, 'a-lock.md');
    const markers = acquireReadMarkers(out, lockFile, sha);
    for (const path of [`${out}.read-done`, `${lockFile}.read-done`]) {
      expect(readFileSync(path, 'utf8')).toMatch(new RegExp(`^started \\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z ${sha}\\n$`));
    }
    expect(() => acquireReadMarkers(out, lockFile, sha)).toThrow(/a-report\.json\.read-done/);
    // The failed second call did not overwrite either marker.
    for (const path of [`${out}.read-done`, `${lockFile}.read-done`]) {
      expect(readFileSync(path, 'utf8')).toMatch(/^started /);
    }
    markers.complete();
    for (const path of [`${out}.read-done`, `${lockFile}.read-done`]) {
      expect(readFileSync(path, 'utf8')).toMatch(new RegExp(`^completed \\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z ${sha}\\n$`));
    }
  });

  it('throws on a pre-existing marker beside the lock file and creates nothing', () => {
    const out = join(dir, 'b-report.json');
    const lockFile = join(dir, 'b-lock.md');
    writeFileSync(`${lockFile}.read-done`, 'old\n');
    expect(() => acquireReadMarkers(out, lockFile, sha)).toThrow(/b-lock\.md\.read-done/);
    expect(existsSync(`${out}.read-done`)).toBe(false);
    expect(readFileSync(`${lockFile}.read-done`, 'utf8')).toBe('old\n');
  });

  it('throws on a pre-existing marker beside the output and leaves it untouched', () => {
    const out = join(dir, 'c-report.json');
    const lockFile = join(dir, 'c-lock.md');
    writeFileSync(`${out}.read-done`, 'old\n');
    expect(() => acquireReadMarkers(out, lockFile, sha)).toThrow(/c-report\.json\.read-done/);
    expect(existsSync(`${lockFile}.read-done`)).toBe(false);
    expect(readFileSync(`${out}.read-done`, 'utf8')).toBe('old\n');
  });

  it('keeps the first marker and throws when the second creation fails', () => {
    // The lock marker path has a missing parent directory, so the exclusive create of the second marker fails with ENOENT
    // after the first marker was created. Nothing is removed.
    const out = join(dir, 'd-report.json');
    const lockFile = join(dir, 'missing-dir', 'd-lock.md');
    expect(() => acquireReadMarkers(out, lockFile, sha)).toThrow();
    expect(readFileSync(`${out}.read-done`, 'utf8')).toMatch(/^started /);
    expect(existsSync(`${lockFile}.read-done`)).toBe(false);
  });
});

describe('request guards and parsers', () => {
  it('refuses a request that ends after the run span end', () => {
    const end = Date.UTC(2024, 6, 1);
    expect(() => assertRequestEnd(end - 1, end)).not.toThrow();
    expect(() => assertRequestEnd(end + 1, end)).toThrow(/data discipline/);
    expect(() => hyperliquidFundingRequest('BTC', 1, end + 5, end)).toThrow(/data discipline/);
    expect(() => hyperliquidCandleRequest('BTC', 1, end + 5, end)).toThrow(/data discipline/);
    expect(hyperliquidFundingRequest('BTC', 1, end - 1, end)).toEqual({
      type: 'fundingHistory',
      coin: 'BTC',
      startTime: 1,
      endTime: end - 1,
    });
    expect(hyperliquidCandleRequest('BTC', 1, end - 1, end)).toEqual({
      type: 'candleSnapshot',
      req: { coin: 'BTC', interval: '8h', startTime: 1, endTime: end - 1 },
    });
  });

  it('enumerates archive months through the month of spanEnd - 1 only', () => {
    expect(archiveMonthsForSpan(Date.UTC(2024, 5, 28), Date.UTC(2024, 6, 1))).toEqual(['2024-06']);
    expect(archiveMonthsForSpan(Date.UTC(2024, 5, 28), Date.UTC(2024, 6, 1) + 1)).toEqual(['2024-06', '2024-07']);
    expect(archiveMonthsForSpan(Date.UTC(2023, 10, 20), Date.UTC(2024, 1, 10))).toEqual([
      '2023-11',
      '2023-12',
      '2024-01',
      '2024-02',
    ]);
  });

  it('normaliseSettlementsSpan equals normaliseSettlements before the old cutoff and keeps later rows', () => {
    const base = Date.UTC(2024, 5, 29);
    const rows = [
      { timestamp: base + 8 * HOUR_MS + 5, intervalHours: 8, rate: 0.0002 },
      { timestamp: base, intervalHours: null, rate: 0.0001 },
      { timestamp: base + 8 * HOUR_MS + 7, intervalHours: 8, rate: 0.0003 },
      { timestamp: base + 16 * HOUR_MS, intervalHours: null, rate: 0.0004 },
    ];
    const old = normaliseSettlements(rows);
    expect(normaliseSettlementsSpan(rows, SCOUT_CUTOFF_MS)).toEqual(old);
    const late = [...rows, { timestamp: SCOUT_CUTOFF_MS + 3 * HOUR_MS, intervalHours: 8, rate: 0.0005 }];
    expect(normaliseSettlements(late)).toHaveLength(old.length);
    expect(normaliseSettlementsSpan(late, SCOUT_CUTOFF_MS + 8 * HOUR_MS)).toHaveLength(old.length + 1);
    expect(normaliseSettlementsSpan(late, SCOUT_CUTOFF_MS + 3 * HOUR_MS)).toHaveLength(old.length);
  });

  it('parses Hyperliquid funding past the old cutoff, rounding to the hour, last duplicate wins, span end exclusive', () => {
    const spanEnd = SCOUT_CUTOFF_MS + 2 * HOUR_MS;
    const json = [
      { time: SCOUT_CUTOFF_MS + 1_000, fundingRate: '0.0001', premium: '0' },
      { time: SCOUT_CUTOFF_MS + 2_000, fundingRate: '0.0002', premium: '0' },
      { time: SCOUT_CUTOFF_MS + HOUR_MS + 5, fundingRate: '0.0003', premium: '0' },
      { time: spanEnd + 4, fundingRate: '0.0009', premium: '0' },
      { time: spanEnd - 4, fundingRate: '0.0008', premium: '0' },
    ];
    // spanEnd - 4 rounds up to spanEnd, which is after spanEnd - 1 and dropped.
    expect(parseHyperliquidFundingSpan(json, spanEnd)).toEqual([
      { t: SCOUT_CUTOFF_MS, rate: 0.0002 },
      { t: SCOUT_CUTOFF_MS + HOUR_MS, rate: 0.0003 },
    ]);
  });

  it('parses Hyperliquid candles past the old cutoff and drops open times at or after the span end', () => {
    const spanEnd = SCOUT_CUTOFF_MS + STEP_MS;
    const json = [
      { t: SCOUT_CUTOFF_MS, o: '2', h: '3', l: '1', c: '2' },
      { t: spanEnd, o: '9', h: '9', l: '9', c: '9' },
    ];
    const map = parseHyperliquidCandlesSpan(json, spanEnd);
    expect([...map.keys()]).toEqual([SCOUT_CUTOFF_MS]);
    expect(map.get(SCOUT_CUTOFF_MS)).toEqual({ open: 2, high: 3, low: 1 });
  });
});

describe('parseLockedArgs', () => {

  it('accepts --dump-series and omits it otherwise', () => {
    expect(parseLockedArgs([...ok, '--dump-series', '/tmp/series.json']).dumpSeries).toBe('/tmp/series.json');
    expect(parseLockedArgs(ok).dumpSeries).toBeUndefined();
  });
  const ok = [
    '--universe', 'u.json',
    '--cache', 'c',
    '--out', 'o.json',
    '--hl-meta', 'm.json',
    '--from', '2024-07-01',
    '--end', '2026-07-01',
  ];

  it('parses the required flags and defaults', () => {
    const a = parseLockedArgs(ok);
    expect(a).toMatchObject({
      universe: 'u.json',
      cache: 'c',
      out: 'o.json',
      hlMeta: 'm.json',
      fromT: Date.UTC(2024, 6, 1),
      endT: Date.UTC(2026, 6, 1),
      coins: null,
      concurrency: 3,
    });
  });

  it('parses the optional flags', () => {
    const a = parseLockedArgs([...ok, '--coins', 'BTC,ETH', '--concurrency', '5', '--lock-file', 'l', '--lock-sha256', 'ab']);
    expect(a).toMatchObject({ coins: ['BTC', 'ETH'], concurrency: 5, lockFile: 'l', lockSha256: 'ab' });
  });

  it('rejects unaligned or invalid spans and unknown flags', () => {
    const swap = (flag: string, value: string): string[] => {
      const copy = [...ok];
      copy[copy.indexOf(flag) + 1] = value;
      return copy;
    };
    expect(() => parseLockedArgs(swap('--from', '2024-07-01T04:00:00Z'))).toThrow(/UTC midnight/);
    expect(() => parseLockedArgs(swap('--end', '2024-07-01T00:00:00Z'))).toThrow(/after --from/);
    expect(() => parseLockedArgs(swap('--end', 'not a date'))).toThrow(/ISO date/);
    expect(() => parseLockedArgs([...ok, '--delay', '1'])).toThrow(/Unknown flag/);
    expect(() => parseLockedArgs(ok.slice(0, -2))).toThrow(/--end is required/);
    expect(() => parseLockedArgs([...ok, '--concurrency', '0'])).toThrow(/concurrency/);
  });
});

describe('simulateBook input checks', () => {
  it('rejects a lastT off the 8h grid, a lastT before fromT and bad slots', () => {
    expect(() => simulateBook([], { ...BASE, lastT: T(5) + HOUR_MS })).toThrow(/8h grid/);
    expect(() => simulateBook([], { ...BASE, lastT: T(0) - STEP_MS })).toThrow(/before fromT/);
    expect(() => simulateBook([], { ...BASE, slots: 0 })).toThrow(/slots/);
  });
});

// ---------------------------------------------------------------------------
// 14. Parity fixture for the independent pandas re-implementation.
//
// PARITY_FIXTURE is the complete input. To rebuild the series, use the generator
// documented at the top of this file: T(k) = fromT + k x 8h for k = 0..11 (hour h means fromT + h x 1h); for each
// coin, with b_k = S_k + (bn_k + bn_{k-1} + bn_{k-2}) - b_{k-1} - b_{k-2} (b and bn
// are 0 before step 0), Hyperliquid has one event per hour from T(-3) to T(11) with
// rate b_k at t = T(k) and 0 elsewhere (minus the hours in dropHl); Binance has one
// 8h-interval event at each T(k), k = -3..11, with rate bn_k (default 0); Binance 1h
// bars exist at every hour from T(-2) to T(11) and Hyperliquid 8h candles at every
// T(k), k = -2..11, flat at 100 and 50 (open = high = low) except the stated
// overrides, where null removes the bar. fromT is 2024-01-01 00:00 UTC. Parameters:
// level 0.002, perSide 0.00185, slots 2.
// ---------------------------------------------------------------------------

type Ohlc = [open: number, high: number, low: number] | null;

const PARITY_FIXTURE = {
  fromT: Date.UTC(2024, 0, 1),
  steps: 12,
  slots: 2,
  level: 0.002,
  perSide: 0.00185,
  // bOver is keyed by hours after fromT (Binance 1h bar open time), hOver by step index k (Hyperliquid 8h candle at T(k)).
  coins: [
    {
      coin: 'AAA',
      spreads: [0, 0.003, 0.003, 0.0025, -0.001, -0.001, 0.0045, 0.0045, 0.0045, 0.0045, 0.0045, 0.0045],
      bn: { 3: 0.0004, 4: 0.0001 } as Record<number, number>,
      bOver: { 32: [102, 102, 102], 66: [100, 100, 0.4], 72: [101, 101, 101] } as Record<number, Ohlc>,
      hOver: { 4: [49, 49, 49], 8: [50, 96, 50], 9: [48, 48, 48] } as Record<number, Ohlc>,
    },
    {
      coin: 'BBB',
      spreads: [0, 0, -0.0035, -0.0035, -0.0035, -0.0035, -0.0035, 0.001, 0.001, 0.001, 0.001, 0.001],
      bn: {} as Record<number, number>,
      bOver: {} as Record<number, Ohlc>,
      hOver: {} as Record<number, Ohlc>,
    },
    {
      coin: 'CCC',
      spreads: [0, 0, 0.003, 0.003, 0.003, -0.001, -0.001, -0.001, 0.0035, 0.0035, 0.0035, 0.0035],
      bn: {} as Record<number, number>,
      bOver: {} as Record<number, Ohlc>,
      hOver: { 10: null } as Record<number, Ohlc>,
    },
  ],
};

describe('14. parity fixture', () => {
  const bar = (v: Ohlc): PriceBar | null => (v === null ? null : { open: v[0], high: v[1], low: v[2] });
  const toSpec = (c: (typeof PARITY_FIXTURE.coins)[number]): Spec => ({
    coin: c.coin,
    spreads: c.spreads,
    bn: c.bn,
    bOver: Object.fromEntries(Object.entries(c.bOver).map(([h, v]) => [T0 + Number(h) * HOUR_MS, bar(v)])),
    hOver: Object.fromEntries(Object.entries(c.hOver).map(([k, v]) => [T(Number(k)), bar(v)])),
  });
  const parityRun = (delay: 0 | 1): BookResult =>
    simulateBook(PARITY_FIXTURE.coins.map((c) => build(toSpec(c))), {
      fromT: PARITY_FIXTURE.fromT,
      lastT: T(PARITY_FIXTURE.steps - 1),
      slots: PARITY_FIXTURE.slots,
      level: PARITY_FIXTURE.level,
      perSide: PARITY_FIXTURE.perSide,
      entryDelaySteps: delay,
    });

  it('builds series that show the stated spreads', () => {
    for (const c of PARITY_FIXTURE.coins) {
      const series = build(toSpec(c));
      c.spreads.forEach((s, k) => expect(spreadAt(series, T(k))).toBeCloseTo(s, 12));
    }
  });

  it('produces the expected zero-delay book', () => {
    expect(summarise(parityRun(0))).toEqual(EXPECTED_DELAY0);
  });

  it('produces the expected one-step-delay book', () => {
    expect(summarise(parityRun(1))).toEqual(EXPECTED_DELAY1);
  });
});

type Row = [coin: string, sign: number, entryStep: number, exitStep: number, reason: string, net: number];
interface Expected {
  rows: Row[];
  counts: BookResult['counts'];
}

function summarise(book: BookResult): { rows: Row[]; counts: BookResult['counts'] } {
  return {
    rows: book.positions.map((p) => [
      p.coin,
      p.sign,
      (p.entryT - T0) / STEP_MS,
      (p.exitT - T0) / STEP_MS,
      p.reason,
      Math.round(p.net * 1e12) / 1e12,
    ]),
    counts: book.counts,
  };
}

// Rows are [coin, sign, entry step, exit step, reason, net], nets rounded to 12 decimals. Derived by hand:
// AAA first trade net = funding -0.001 + basis 0.04 - 0.0037; BBB net = funding -0.001 - 0.0037;
// AAA second trade: short Hyperliquid leg, candle T(8) high 96 >= 2 / 1.05 x its entry open 50 (95.238), so it is liquidated at T(9)
// with short return -1 and the long Binance leg 101 / 100 - 1 = 0.01 (the Binance bar low 0.4 at hour 66 is a long-side move and does not matter),
// basis 0.01 - 1 = -0.99, net = funding 0.0045 - 0.99 - 0.0037 = -0.9892 (delay 0) or funding 0.005 (delay 1) = -0.9887;
// CCC net = -0.0037 (no funding and no price move).
const EXPECTED_DELAY0: Expected = {
  rows: [
    ['AAA', 1, 1, 4, 'signal', 0.0353],
    ['BBB', -1, 2, 7, 'signal', -0.0047],
    ['AAA', 1, 6, 9, 'liquidated', -0.9892],
    ['CCC', 1, 8, 9, 'unavailable', -0.0037],
  ],
  counts: { noSlot: 1, noPrice: 0, noCoverage: 0 },
};
const EXPECTED_DELAY1: Expected = {
  rows: [
    ['AAA', 1, 2, 4, 'signal', 0.0353],
    ['BBB', -1, 3, 7, 'signal', -0.0047],
    ['AAA', 1, 7, 9, 'liquidated', -0.9887],
    ['CCC', 1, 9, 9, 'unavailable', -0.0037],
  ],
  counts: { noSlot: 1, noPrice: 0, noCoverage: 0 },
};
