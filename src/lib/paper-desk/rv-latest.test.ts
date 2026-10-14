import { describe, expect, it } from 'vitest';

import type { RvFillStats } from '@/lib/models/rv-book';
import type { RvStepRecord } from '@/lib/signals/cross-sectional/engine';
import {
  NEGATIVE_STREAK_FLAG,
  isPendingStep,
  makerFillRate,
  pendingReasonLabel,
  positionRows,
  raisedAlertKinds,
  type RvBookView,
  type RvStepView,
} from './rv-latest';

const bucket = (makerFilled: number, makerFallback: number, steps = 1) => ({ makerFilled, makerFallback, steps });

function fillStats(overrides: Partial<RvFillStats> = {}): RvFillStats {
  return {
    '00': bucket(0, 0, 0),
    '08': bucket(0, 0, 0),
    '16': bucket(0, 0, 0),
    weekday: bucket(0, 0, 0),
    weekend: bucket(0, 0, 0),
    ...overrides,
  };
}

function record(overrides: Partial<RvStepRecord> = {}): RvStepRecord {
  return {
    equityBefore: 10_000,
    equityAfter: 10_000,
    funding: [],
    fills: [],
    fees: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    stale: [],
    skippedEntries: [],
    halted: null,
    gross: 2,
    ...overrides,
  };
}

function book(overrides: Partial<RvBookView> = {}): RvBookView {
  return {
    bookName: 'rv-v1',
    version: 'rv-v1',
    validationStatus: 'unvalidated',
    validationRef: null,
    startedAt: '2026-10-15T01:05:00.000Z',
    startBarTime: null,
    lastStepBarTime: null,
    tracks: { taker: { cash: 10_000, positions: {} }, maker: { cash: 10_000, positions: {} } },
    equity: { taker: 10_000, maker: 10_000 },
    peakEquity: { taker: 10_000, maker: 10_000 },
    alerts: { drawdownTaker: false, drawdownMaker: false, negativeStreak: 0 },
    fillStats: fillStats(),
    createdAt: '2026-10-15T01:05:00.000Z',
    updatedAt: '2026-10-15T01:05:00.000Z',
    ...overrides,
  };
}

function step(overrides: Partial<RvStepView> = {}): RvStepView {
  return {
    bookName: 'rv-v1',
    barTime: 1_791_964_800_000,
    fillTime: 1_791_993_600_000,
    targets: {},
    taker: record(),
    maker: record(),
    bookAfter: null,
    rebalanceHourUtc: 8,
    isWeekend: false,
    pendingReasons: [],
    createdAt: '2026-10-15T09:05:00.000Z',
    ...overrides,
  };
}

describe('raisedAlertKinds', () => {
  it('is empty when no flag is raised', () => {
    expect(raisedAlertKinds({ drawdownTaker: false, drawdownMaker: false, negativeStreak: 0 })).toEqual([]);
  });

  it('names each drawdown flag that is set', () => {
    expect(raisedAlertKinds({ drawdownTaker: true, drawdownMaker: false, negativeStreak: 0 })).toEqual([
      'drawdown_taker',
    ]);
    expect(raisedAlertKinds({ drawdownTaker: true, drawdownMaker: true, negativeStreak: 0 })).toEqual([
      'drawdown_taker',
      'drawdown_maker',
    ]);
  });

  it('raises the negative streak at 10 steps, not 9', () => {
    expect(NEGATIVE_STREAK_FLAG).toBe(10);
    expect(raisedAlertKinds({ drawdownTaker: false, drawdownMaker: false, negativeStreak: 9 })).toEqual([]);
    expect(raisedAlertKinds({ drawdownTaker: false, drawdownMaker: false, negativeStreak: 10 })).toEqual([
      'negative_streak',
    ]);
  });
});

describe('makerFillRate', () => {
  it('sums the hour buckets only, so weekday and weekend do not count twice', () => {
    const rate = makerFillRate(
      fillStats({
        '00': bucket(3, 1),
        '08': bucket(2, 2),
        '16': bucket(1, 1),
        weekday: bucket(5, 3),
        weekend: bucket(1, 1),
      })
    );
    expect(rate).toEqual({ filled: 6, fallback: 4, rate: 0.6 });
  });

  it('has no rate before any maker order, never 0 or NaN', () => {
    expect(makerFillRate(fillStats())).toEqual({ filled: 0, fallback: 0, rate: null });
  });

  it('reports a real 0 when every order fell back to taker', () => {
    expect(makerFillRate(fillStats({ '16': bucket(0, 4) }))).toEqual({ filled: 0, fallback: 4, rate: 0 });
  });
});

describe('pendingReasonLabel', () => {
  it('keeps the prefix before the first space', () => {
    expect(pendingReasonLabel('fill_bar_unavailable:SOLUSDT (fetch failed: timeout)')).toBe(
      'fill_bar_unavailable:SOLUSDT'
    );
    expect(pendingReasonLabel('funding_missing:AVAXUSDT')).toBe('funding_missing:AVAXUSDT');
  });

  it('drops the colon an engine error code carries before its message', () => {
    expect(pendingReasonLabel('held_symbol_unscored: SOLUSDT is held but missing from the ranking')).toBe(
      'held_symbol_unscored'
    );
  });
});

describe('isPendingStep', () => {
  it('is false for a completed step', () => {
    expect(isPendingStep(step({ bookAfter: book() }), null)).toBe(false);
  });

  it('is true for a pending step past the cursor, or before any step', () => {
    const pending = step({ taker: null, maker: null, pendingReasons: ['funding_missing:SOLUSDT'] });
    expect(isPendingStep(pending, null)).toBe(true);
    expect(isPendingStep(pending, pending.barTime - 8 * 3_600_000)).toBe(true);
  });

  it('is false for a pending orphan at or behind the cursor', () => {
    const orphan = step({ taker: null, maker: null, pendingReasons: ['funding_missing:SOLUSDT'] });
    expect(isPendingStep(orphan, orphan.barTime + 8 * 3_600_000)).toBe(false);
  });
});

describe('positionRows', () => {
  const held = book({
    tracks: {
      taker: {
        cash: 10_000,
        positions: {
          BTCUSDT: { qty: 0.04, avgEntry: 64_000, lastMark: 65_000 },
          DOGEUSDT: { qty: -16_000, avgEntry: 0.16, lastMark: 0.15 },
        },
      },
      maker: {
        cash: 10_000,
        positions: {
          BTCUSDT: { qty: 0.041, avgEntry: 63_900, lastMark: 65_000 },
          DOGEUSDT: { qty: -16_100, avgEntry: 0.161, lastMark: 0.15 },
          AVAXUSDT: { qty: 80, avgEntry: 31, lastMark: 30 },
        },
      },
    },
    equity: { taker: 10_000, maker: 10_100 },
  });

  it('reads positions from the book tracks, weights and entry from the taker track', () => {
    const rows = positionRows(held, null);
    const btc = rows.find((r) => r.symbol === 'BTCUSDT')!;
    expect(btc.side).toBe('long');
    expect(btc.weight).toBeCloseTo(0.26, 10);
    expect(btc.entry).toBe(64_000);
    expect(btc.lastPrice).toBe(65_000);
    expect(btc.unrealizedTaker).toBeCloseTo(40, 10);
    expect(btc.unrealizedMaker).toBeCloseTo(45.1, 10);
    expect(btc.makerOnly).toBe(false);

    const doge = rows.find((r) => r.symbol === 'DOGEUSDT')!;
    expect(doge.side).toBe('short');
    expect(doge.weight).toBeCloseTo(-0.24, 10);
    expect(doge.unrealizedTaker).toBeCloseTo(160, 10);
  });

  it('marks a leg held by the maker track only and sizes it from that track', () => {
    const avax = positionRows(held, null).find((r) => r.symbol === 'AVAXUSDT')!;
    expect(avax.makerOnly).toBe(true);
    expect(avax.unrealizedTaker).toBeNull();
    expect(avax.weight).toBeCloseTo((80 * 30) / 10_100, 10);
    expect(avax.unrealizedMaker).toBeCloseTo(-80, 10);
  });

  it('treats a zero-quantity taker entry as not held when the maker track holds the leg', () => {
    const zeroTaker = book({
      tracks: {
        taker: { cash: 10_000, positions: { AVAXUSDT: { qty: 0, avgEntry: 31, lastMark: 30 } } },
        maker: { cash: 10_000, positions: { AVAXUSDT: { qty: 80, avgEntry: 31, lastMark: 30 } } },
      },
      equity: { taker: 10_000, maker: 10_100 },
    });
    const [avax] = positionRows(zeroTaker, null);
    expect(avax.symbol).toBe('AVAXUSDT');
    expect(avax.makerOnly).toBe(true);
    expect(avax.side).toBe('long');
    expect(avax.weight).toBeCloseTo((80 * 30) / 10_100, 10);
    expect(avax.unrealizedTaker).toBeNull();
    expect(avax.unrealizedMaker).toBeCloseTo(-80, 10);
  });

  it('orders longs before shorts, largest absolute weight first on each side', () => {
    expect(positionRows(held, null).map((r) => r.symbol)).toEqual(['BTCUSDT', 'AVAXUSDT', 'DOGEUSDT']);
    const twoShorts = book({
      tracks: {
        taker: {
          cash: 10_000,
          positions: {
            DOGEUSDT: { qty: -16_000, avgEntry: 0.16, lastMark: 0.15 },
            SOLUSDT: { qty: -16, avgEntry: 150, lastMark: 151.25 },
            BTCUSDT: { qty: 0.04, avgEntry: 64_000, lastMark: 65_000 },
          },
        },
        maker: { cash: 10_000, positions: {} },
      },
    });
    expect(positionRows(twoShorts, null).map((r) => r.symbol)).toEqual(['BTCUSDT', 'SOLUSDT', 'DOGEUSDT']);
  });

  it('flags a symbol the last completed step could not mark on either track as stale', () => {
    const completed = step({
      taker: record({ stale: ['DOGEUSDT'] }),
      maker: record({ stale: ['AVAXUSDT'] }),
      bookAfter: held,
    });
    const rows = positionRows(held, completed);
    expect(rows.find((r) => r.symbol === 'DOGEUSDT')!.stale).toBe(true);
    expect(rows.find((r) => r.symbol === 'AVAXUSDT')!.stale).toBe(true);
    expect(rows.find((r) => r.symbol === 'BTCUSDT')!.stale).toBe(false);
  });

  it('ignores zero quantities and is empty for a flat book', () => {
    expect(positionRows(book(), null)).toEqual([]);
    const flat = book({
      tracks: {
        taker: { cash: 10_000, positions: { BTCUSDT: { qty: 0, avgEntry: 1, lastMark: 1 } } },
        maker: { cash: 10_000, positions: {} },
      },
    });
    expect(positionRows(flat, null)).toEqual([]);
  });
});
