// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { OHLCV } from '@/types/market';
import type { BacktestConfig } from '@/lib/backtest/types';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/types';
import { studyCostConfig } from '@/lib/backtest/cost-model';
import { emptyLedger, barOfTimestamp, stepLedger } from './step';
import type { BarDecision, LedgerState } from './types';
import { TRADE_PLAN_STRATEGY } from '@/lib/trade-plan/rule';

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

/** A flat bar at `close` with an explicit range, so stop and target hits are deliberate. */
function bar(i: number, close: number, opts: Partial<OHLCV> = {}): OHLCV {
  return {
    timestamp: T0 + i * HOUR,
    open: opts.open ?? close,
    high: opts.high ?? close,
    low: opts.low ?? close,
    close,
    volume: 1,
    ...opts,
  };
}

const CONFIG: BacktestConfig = {
  ...DEFAULT_BACKTEST_CONFIG,
  allowShorts: true,
  entryThreshold: 29,
  exitThreshold: 7.25,
  shortEntryThreshold: -29,
  shortExitThreshold: -7.25,
  stopLossPercent: 0.02,
  takeProfitPercent: 0.04,
  positionSizing: { method: 'risk_based', riskPerTrade: 0.01 },
  ...studyCostConfig('1h'),
  startEquity: 1000,
};

/** No slippage and no fees, so arithmetic assertions read cleanly. */
const CLEAN: BacktestConfig = { ...CONFIG, slippageBps: 0, feePercent: 0, makerFeePercent: 0, takerFeePercent: 0 };

function scored(score: number, signalCreatedAt: number): BarDecision {
  return {
    scored: true,
    score,
    tier: score >= 29 ? 'buy' : score <= -29 ? 'sell' : 'neutral',
    session: null,
    signalCreatedAt,
  };
}

const UNSCORED: BarDecision = { scored: false, score: 0, tier: 'neutral', session: null, signalCreatedAt: null };

/** Walks the whole window, returning the final state and every closed trade. */
function run(
  candles: OHLCV[],
  decisions: (BarDecision | null)[],
  config = CLEAN,
  fundingRate: number | null = null,
  from = 1
): { state: LedgerState; closed: ReturnType<typeof stepLedger>['closed']; skips: (string | null)[] } {
  let state = emptyLedger(config.startEquity);
  const closed: ReturnType<typeof stepLedger>['closed'] = [];
  const skips: (string | null)[] = [];
  for (let i = from; i < candles.length; i++) {
    const out = stepLedger(state, {
      candles,
      bar: i,
      interval: '1h',
      decision: decisions[i] ?? UNSCORED,
      fundingRate,
      config,
    });
    state = out.state;
    closed.push(...out.closed);
    skips.push(out.skipped);
  }
  return { state, closed, skips };
}

describe('the desk strategy has no management hook', () => {
  // The desk omits bar-loop's management step (see step.ts's header). If the
  // strategy ever gains a manage hook, the desk must grow the same step first,
  // or its trades stop matching the engine's.
  it('TRADE_PLAN_STRATEGY defines no manage hook', () => {
    expect(TRADE_PLAN_STRATEGY.manage).toBeUndefined();
  });
});

describe('barOfTimestamp', () => {
  it('recovers an earlier bar index from its timestamp on the interval grid', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100), bar(3, 100)];
    expect(barOfTimestamp(candles[1].timestamp, 3, candles[3], HOUR)).toBe(1);
    expect(barOfTimestamp(candles[3].timestamp, 3, candles[3], HOUR)).toBe(3);
  });
});

describe('stepLedger: entries and the engine track', () => {
  it('opens a long at the bar close on a score at the entry level and sizes 1% of equity', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100)];
    const { state } = run(candles, [null, scored(35, T0 + 2 * HOUR), null]);
    const pos = state.position!.engine;
    expect(pos.side).toBe('long');
    expect(pos.entryPrice).toBe(100);
    expect(pos.entryBar).toBe(1);
    expect(pos.stopPrice).toBeCloseTo(98, 10);
    expect(pos.targetPrice).toBeCloseTo(104, 10);
    // 1% of 1000 risked over a 2-point stop distance.
    expect(pos.quantity).toBeCloseTo(10 / 2, 10);
  });

  it('opens a short on a score at the negative entry level', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100)];
    const { state } = run(candles, [null, scored(-35, T0 + 2 * HOUR), null]);
    const pos = state.position!.engine;
    expect(pos.side).toBe('short');
    expect(pos.stopPrice).toBeCloseTo(102, 10);
    expect(pos.targetPrice).toBeCloseTo(96, 10);
  });

  it('stays flat inside the entry band', () => {
    const candles = [bar(0, 100), bar(1, 100)];
    const { state } = run(candles, [null, scored(20, T0 + 2 * HOUR)]);
    expect(state.position).toBeNull();
  });

  it('closes on the score exit at the bar close, recording the score as exitScore', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 101)];
    const { closed } = run(candles, [null, scored(35, T0 + 2 * HOUR), scored(5, T0 + 3 * HOUR)]);
    expect(closed).toHaveLength(1);
    expect(closed[0].engine).toMatchObject({
      exitReason: 'signal',
      exitPrice: 101,
      exitBar: 2,
      exitScore: 5,
      entryScore: 35,
    });
  });

  it('checks the stop before the target when a bar spans both', () => {
    // A bar whose range covers the 98 stop and the 104 target: the stop wins.
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100, { high: 105, low: 97 })];
    const { closed } = run(candles, [null, scored(35, T0 + 2 * HOUR), scored(35, T0 + 3 * HOUR)]);
    expect(closed).toHaveLength(1);
    expect(closed[0].engine.exitReason).toBe('stop_loss');
    expect(closed[0].engine.exitPrice).toBeCloseTo(98, 10);
  });

  it('allows a same-bar re-entry after a stop, sized on the post-stop equity', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100, { low: 97 })];
    const { state, closed } = run(candles, [null, scored(35, T0 + 2 * HOUR), scored(35, T0 + 3 * HOUR)]);
    expect(closed).toHaveLength(1);
    expect(closed[0].engine.exitReason).toBe('stop_loss');
    // Flat again at the top of step 3, so the same bar opens a new position.
    expect(state.position).not.toBeNull();
    expect(state.position!.engine.entryBar).toBe(2);
    // Equity fell by the stopped trade, so the new size is smaller.
    expect(state.equity).toBeLessThan(1000);
    expect(state.position!.engine.quantity).toBeLessThan(closed[0].engine.quantity);
  });

  it('does not re-enter on the bar a signal exit closed a position', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100)];
    // A score of 5 exits a long; it is not an entry level either, but the
    // point is that the bar's entry branch never runs at all.
    const { state, closed } = run(candles, [null, scored(35, T0 + 2 * HOUR), scored(5, T0 + 3 * HOUR)]);
    expect(closed[0].engine.exitReason).toBe('signal');
    expect(state.position).toBeNull();
  });
});

describe('stepLedger: a missing score is not a decision', () => {
  it('opens nothing on an unscored bar and reports the skip', () => {
    const candles = [bar(0, 100), bar(1, 100)];
    const { state, skips } = run(candles, [null, UNSCORED]);
    expect(state.position).toBeNull();
    expect(skips).toEqual(['missing_score']);
  });

  it('still checks the stop on an unscored bar, so a held position is never unmanaged', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100, { low: 97 })];
    const { closed, skips } = run(candles, [null, scored(35, T0 + 2 * HOUR), UNSCORED]);
    expect(closed).toHaveLength(1);
    expect(closed[0].engine.exitReason).toBe('stop_loss');
    expect(skips[1]).toBe('missing_score');
  });

  it('does not close a position on a score that was never computed', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100)];
    const { state, closed } = run(candles, [null, scored(35, T0 + 2 * HOUR), UNSCORED]);
    expect(closed).toHaveLength(0);
    expect(state.position).not.toBeNull();
  });
});

describe('stepLedger: the session filter gates entries only', () => {
  const sessionConfig: BacktestConfig = { ...CLEAN, allowedSessions: ['new_york'] };

  it('skips an entry outside the allowed session', () => {
    const candles = [bar(0, 100), bar(1, 100)];
    const decision: BarDecision = { ...scored(35, T0 + 2 * HOUR), session: 'asia' };
    const { state, skips } = run(candles, [null, decision], sessionConfig);
    expect(state.position).toBeNull();
    expect(skips).toEqual(['session_filtered']);
  });

  it('takes an entry inside the allowed session', () => {
    const candles = [bar(0, 100), bar(1, 100)];
    const decision: BarDecision = { ...scored(35, T0 + 2 * HOUR), session: 'new_york' };
    const { state } = run(candles, [null, decision], sessionConfig);
    expect(state.position).not.toBeNull();
  });
});

describe('stepLedger: the executable track', () => {
  it('fills the entry at the next bar open, not at the signal close the engine uses', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 102, { open: 101 }), bar(3, 100)];
    // Entry on bar 1 at close 100; bar 2 opens at 101, which is what a live order gets.
    const { closed } = run(candles, [
      null,
      scored(35, T0 + 2 * HOUR),
      null,
      scored(5, T0 + 4 * HOUR),
    ]);
    expect(closed).toHaveLength(1);
    const { engine, executable } = closed[0];
    expect(engine.entryPrice).toBe(100);
    expect(executable.filled).toBe(true);
    expect(executable.entryPrice).toBe(101);
    expect(executable.entryDelayBars).toBe(1);
    // The long entered a point higher, so it earns a point less on the same exit.
    expect(executable.pnl).toBeCloseTo(engine.pnl - engine.quantity * 1, 8);
  });

  it('fills part way into the next bar at that bar\'s open, the next-open convention', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 102, { open: 101 }), bar(3, 105, { open: 104 }), bar(4, 100)];
    // Written 30 minutes into bar 2, which is where a live order would sit.
    const normal = scored(35, T0 + 2 * HOUR + 30 * 60_000);
    const { closed } = run(candles, [null, normal, null, null, scored(5, T0 + 5 * HOUR)]);
    expect(closed[0].executable.entryPrice).toBe(101);
    expect(closed[0].executable.entryDelayBars).toBe(1);
  });

  it('slips a further bar when the score itself arrives after the next bar closed', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 102, { open: 101 }), bar(3, 105, { open: 104 }), bar(4, 100)];
    // Written 10 minutes into bar 3: bar 2 is already gone, so bar 3's open is
    // the first price the order could have got.
    const late = scored(35, T0 + 3 * HOUR + 10 * 60_000);
    const { closed } = run(candles, [null, late, null, null, scored(5, T0 + 5 * HOUR)]);
    expect(closed[0].executable.entryPrice).toBe(104);
    expect(closed[0].executable.entryDelayBars).toBe(2);
  });

  it('fills a gapped stop at the bar open rather than at the stop price', () => {
    // Entry on bar 1 (close 100, stop 98). Bar 2 is quiet and fills the live
    // entry at its open of 101. Bar 3 gaps down and opens at 95, already
    // through the stop: the engine still books 98, a live order gets 95.
    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(2, 101, { open: 101, high: 101.5, low: 100.5 }),
      bar(3, 95, { open: 95, high: 95.5, low: 94 }),
    ];
    const { closed } = run(candles, [null, scored(35, T0 + 2 * HOUR), null, null]);
    expect(closed).toHaveLength(1);
    const { engine, executable } = closed[0];
    expect(engine.exitReason).toBe('stop_loss');
    expect(engine.exitPrice).toBeCloseTo(98, 10);
    expect(executable.gappedStop).toBe(true);
    expect(executable.entryPrice).toBe(101);
    expect(executable.exitPrice).toBe(95);
    // The engine lost 2 a unit; a live order lost 6.
    expect(executable.pnl).toBeCloseTo(engine.quantity * -6, 8);
    expect(executable.pnl).toBeLessThan(engine.pnl);
  });

  it('keeps the stop price when the exit bar did not open beyond it', () => {
    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(2, 101, { open: 101, high: 101.5, low: 100.5 }),
      bar(3, 98.5, { open: 99.8, high: 99.8, low: 97.5 }),
    ];
    const { closed } = run(candles, [null, scored(35, T0 + 2 * HOUR), null, null]);
    expect(closed[0].engine.exitReason).toBe('stop_loss');
    expect(closed[0].executable.gappedStop).toBe(false);
    expect(closed[0].executable.exitPrice).toBeCloseTo(98, 10);
  });

  it('stops a position out on arrival when the fill open is already past the stop', () => {
    // Entry decided at close 100 with a stop at 98; the next bar opens at 97.
    const candles = [bar(0, 100), bar(1, 100), bar(2, 97, { open: 97, high: 97.5, low: 96 }), bar(3, 97)];
    const { closed } = run(candles, [null, scored(35, T0 + 2 * HOUR), null, null]);
    expect(closed).toHaveLength(1);
    const { executable } = closed[0];
    expect(executable.stoppedOnArrival).toBe(true);
    expect(executable.entryPrice).toBe(97);
    expect(executable.exitPrice).toBe(97);
    // Entered and exited at the same price, so only costs remain; with the
    // clean config there are none.
    expect(executable.pnl).toBeCloseTo(0, 10);
  });

  it('marks a trade unfilled when it opened and closed inside one bar', () => {
    // A long opened on the last bar of the window never reaches a next open.
    const candles = [bar(0, 100), bar(1, 100)];
    const { state } = run(candles, [null, scored(35, T0 + 2 * HOUR)]);
    // Still open, so nothing booked; the executable entry is pending.
    expect(state.position!.executableEntryPrice).toBeNull();
  });

  it('applies exit slippage once, not once per track', () => {
    // Both tracks exit at the same bar close on the same signal, so after one
    // application of slippage each they must agree on the exit price. The
    // engine's stored exitPrice is already slipped, so re-slipping it here
    // would quietly charge the exit twice.
    const candles = [bar(0, 100), bar(1, 100), bar(2, 102, { open: 101 }), bar(3, 103)];
    const { closed } = run(
      candles,
      [null, scored(35, T0 + 2 * HOUR), null, scored(5, T0 + 4 * HOUR)],
      CONFIG
    );
    const { engine, executable } = closed[0];
    expect(engine.exitReason).toBe('signal');
    expect(executable.exitPrice).toBeCloseTo(engine.exitPrice, 10);
    // 3 bps of 1h slippage against a sell, applied exactly once.
    expect(engine.exitPrice).toBeCloseTo(103 * (1 - 0.0003), 10);
  });

  it('tracks the two equities apart, and never sizes from the executable one', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 102, { open: 101 }), bar(3, 103)];
    const { state, closed } = run(candles, [
      null,
      scored(35, T0 + 2 * HOUR),
      null,
      scored(5, T0 + 4 * HOUR),
    ]);
    expect(state.equity).toBeCloseTo(1000 + closed[0].engine.pnl, 8);
    expect(state.executableEquity).toBeCloseTo(1000 + closed[0].executable.pnl, 8);
    expect(state.executableEquity).toBeLessThan(state.equity);
  });

  it('charges the executable track the venue fees and slippage under a real cost config', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 102, { open: 101 }), bar(3, 103)];
    const { closed } = run(
      candles,
      [null, scored(35, T0 + 2 * HOUR), null, scored(5, T0 + 4 * HOUR)],
      CONFIG
    );
    const { executable, engine } = closed[0];
    expect(executable.fees).toBeGreaterThan(0);
    expect(executable.slippageCost).toBeGreaterThan(0);
    // Same quantity on both tracks: only the prices differ.
    expect(executable.entryPrice).not.toBe(engine.entryPrice);
    expect(engine.quantity).toBeGreaterThan(0);
  });
});

describe('stepLedger: funding', () => {
  const fundingConfig: BacktestConfig = { ...CLEAN, fundingEnabled: true };

  it('never charges funding on the entry bar', () => {
    const candles = [bar(0, 100), bar(1, 100)];
    let state = emptyLedger(1000);
    const out = stepLedger(state, {
      candles,
      bar: 1,
      interval: '1h',
      decision: scored(35, T0 + 2 * HOUR),
      fundingRate: 0.01,
      config: fundingConfig,
    });
    state = out.state;
    expect(state.position!.engine.fundingPnl ?? 0).toBe(0);
  });

  it('charges a long when a funding timestamp is crossed while held', () => {
    // Settlements fall every 8h on the epoch grid. From T0 the next one the
    // position can be charged for lands in bar 9's window, so the trade is
    // held from bar 1 to bar 11 to span it.
    const candles = Array.from({ length: 14 }, (_, i) => bar(i, 100));
    const decisions: (BarDecision | null)[] = candles.map(() => null);
    decisions[1] = scored(35, T0 + 2 * HOUR);
    decisions[11] = scored(5, T0 + 12 * HOUR);
    const { closed } = run(candles, decisions, fundingConfig, 0.01);
    expect(closed).toHaveLength(1);
    // A positive rate means longs pay.
    expect(closed[0].engine.fundingCost).toBeGreaterThan(0);
    expect(closed[0].executable.filled).toBe(true);
  });

  it('credits a short the same crossing a long pays', () => {
    const candles = Array.from({ length: 14 }, (_, i) => bar(i, 100));
    const decisions: (BarDecision | null)[] = candles.map(() => null);
    decisions[1] = scored(-35, T0 + 2 * HOUR);
    decisions[11] = scored(-5, T0 + 12 * HOUR);
    const { closed } = run(candles, decisions, fundingConfig, 0.01);
    expect(closed[0].engine.side).toBe('short');
    expect(closed[0].engine.fundingCost).toBeLessThan(0);
  });

  it('skips accrual when no rate is pinned to the bar', () => {
    const candles = Array.from({ length: 14 }, (_, i) => bar(i, 100));
    const decisions: (BarDecision | null)[] = candles.map(() => null);
    decisions[1] = scored(35, T0 + 2 * HOUR);
    decisions[11] = scored(5, T0 + 12 * HOUR);
    const { closed } = run(candles, decisions, fundingConfig, null);
    expect(closed[0].engine.fundingCost).toBe(0);
  });
});

describe('stepLedger: forceExit, the scorer-version epoch close', () => {
  function openThen(decisionAt2: BarDecision, candle2 = bar(2, 101)) {
    const candles = [bar(0, 100), bar(1, 100), candle2];
    const opened = stepLedger(emptyLedger(CLEAN.startEquity), {
      candles,
      bar: 1,
      interval: '1h',
      decision: scored(35, T0 + 2 * HOUR),
      fundingRate: null,
      config: CLEAN,
    });
    expect(opened.state.position).not.toBeNull();
    return stepLedger(opened.state, {
      candles,
      bar: 2,
      interval: '1h',
      decision: decisionAt2,
      fundingRate: null,
      config: CLEAN,
      forceExit: true,
    });
  }

  it('closes at this bar close as epoch_end even when the score would hold', () => {
    const out = openThen(scored(35, T0 + 3 * HOUR));
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].engine).toMatchObject({ exitReason: 'epoch_end', exitPrice: 101, exitBar: 2 });
    expect(out.state.position).toBeNull();
  });

  it('closes on an unscored bar too, and opens nothing on the bar', () => {
    const out = openThen(UNSCORED);
    expect(out.closed).toHaveLength(1);
    expect(out.state.position).toBeNull();
    expect(out.skipped).toBeNull();
  });

  it('lets the bar stop fire first: a stop hit books stop_loss, not epoch_end', () => {
    const out = openThen(scored(35, T0 + 3 * HOUR), bar(2, 97, { low: 97.5, open: 100 }));
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].engine.exitReason).toBe('stop_loss');
  });
});
