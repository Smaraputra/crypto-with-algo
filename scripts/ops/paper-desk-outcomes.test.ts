// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { IPaperTrade } from '@/lib/models/paper-trade';
import {
  buildBookReport,
  formatReport,
  parseArgs,
  trackStats,
} from './paper-desk-outcomes';
import { SCORER_CONFIG_VERSION } from '@/lib/signals/config-version';
import { evidenceFor } from '@/lib/trade-plan/evidence';

describe('parseArgs', () => {
  it('defaults to every book, every symbol, table output', () => {
    expect(parseArgs([])).toEqual({
      book: null,
      symbol: null,
      since: null,
      configVersion: SCORER_CONFIG_VERSION,
      json: false,
      mongoUri: null,
    });
  });

  it('reads an earlier scorer epoch on request, and rejects a malformed version', () => {
    expect(parseArgs(['--config-version', '7']).configVersion).toBe(7);
    expect(() => parseArgs(['--config-version', 'v7'])).toThrow(/--config-version/);
  });

  it('parses a book, a symbol, a date, json and a mongo uri', () => {
    const args = parseArgs([
      '--book',
      'day_trading:1h',
      '--symbol',
      'BTCUSDT',
      '--since',
      '2026-09-01',
      '--json',
      '--mongo-uri',
      'mongodb://localhost:27017/x',
    ]);
    expect(args.book).toEqual({ tradingStyle: 'day_trading', interval: '1h' });
    expect(args.symbol).toBe('BTCUSDT');
    expect(args.since?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(args.json).toBe(true);
    expect(args.mongoUri).toBe('mongodb://localhost:27017/x');
  });

  it('rejects an unknown book, an unknown flag, a missing value and a bad date', () => {
    expect(() => parseArgs(['--book', 'day_trading:30m'])).toThrow('Unknown paper desk book');
    expect(() => parseArgs(['--book', 'swing_trading:1m'])).toThrow('Unknown paper desk book');
    expect(() => parseArgs(['--nope'])).toThrow('Unknown flag "--nope"');
    expect(() => parseArgs(['--symbol'])).toThrow('--symbol requires a value');
    expect(() => parseArgs(['--since', 'not-a-date'])).toThrow('invalid date');
  });
});

describe('trackStats', () => {
  it('returns null with no trades', () => {
    expect(trackStats([], [])).toBeNull();
  });

  it('reports the mean, a bootstrap interval, the win rate and the total', () => {
    const returns = [1, -0.5, 0.25, -0.75, 2, -1, 0.5, 0.1];
    const stats = trackStats(returns, returns.map((r) => r * 10))!;
    expect(stats.trades).toBe(8);
    expect(stats.expectancyPercent).toBeCloseTo(0.2, 10);
    expect(stats.ciLowPercent).toBeLessThan(stats.expectancyPercent);
    expect(stats.ciHighPercent).toBeGreaterThan(stats.expectancyPercent);
    expect(stats.winRate).toBeCloseTo(5 / 8, 10);
    expect(stats.totalPnl).toBeCloseTo(16, 8);
  });

  it('is deterministic, so two reads of the same data agree', () => {
    const returns = [0.4, -0.2, 0.1, -0.3, 0.6];
    expect(trackStats(returns, returns)).toEqual(trackStats(returns, returns));
  });
});

/** A closed trade whose two tracks differ by a fixed amount. */
function trade(over: Partial<IPaperTrade> = {}): IPaperTrade {
  const base = {
    tradingStyle: 'day_trading',
    interval: '1h',
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 1,
    entryTime: 1,
    exitTime: 2,
    holdTimeBars: 1,
    exitReason: 'signal',
    entryScore: 35,
    exitScore: 5,
    entryTier: 'buy',
    entrySession: null,
    entryConfigVersion: 7,
    riskPercent: 0.5,
    rewardPercent: 1,
    fundingCost: 0,
    fundingCharges: [],
    engine: { entryPrice: 100, exitPrice: 101, fees: 0, slippageCost: 0, pnl: 1, pnlPercent: 1 },
    executable: {
      entryPrice: 100.2,
      exitPrice: 101,
      fees: 0,
      slippageCost: 0,
      pnl: 0.8,
      pnlPercent: 0.8,
      filled: true,
      entryDelayBars: 1,
      gappedStop: false,
      stoppedOnArrival: false,
    },
  };
  return { ...base, ...over } as unknown as IPaperTrade;
}

describe('buildBookReport', () => {
  const ledgers = [
    { equity: 1002, executableEquity: 1001, position: null },
    { equity: 999, executableEquity: 998, position: {} },
  ];

  it('reports both tracks and the lag cost between them', () => {
    const report = buildBookReport(
      { tradingStyle: 'day_trading', interval: '1h' },
      [trade(), trade({ entryTime: 3, exitTime: 4 })],
      ledgers,
      { missingScoreBars: 2, peakLeverage: 1.8 }
    );
    expect(report.book).toBe('day_trading:1h');
    expect(report.trades).toBe(2);
    expect(report.engine!.expectancyPercent).toBeCloseTo(1, 10);
    expect(report.executable!.expectancyPercent).toBeCloseTo(0.8, 10);
    // The engine books a better price than a live order could get.
    expect(report.lagCostPercent).toBeCloseTo(0.2, 10);
    expect(report.equity).toBeCloseTo(2001, 10);
    expect(report.startEquity).toBe(2000);
    expect(report.openPositions).toBe(1);
    expect(report.missingScoreBars).toBe(2);
    expect(report.peakLeverage).toBe(1.8);
  });

  it('attaches the recorded research expectancy for the interval', () => {
    const current = buildBookReport({ tradingStyle: 'day_trading', interval: '1h' }, [trade()], ledgers, null);
    expect(current.recordedExpectancyPercent).toBe(evidenceFor('1h').expectancyPercent);
    // Derived for today's scorer: a row measured under an earlier version is stale.
    expect(current.evidenceStatus).toBe(evidenceFor('1h').status);

    const unmeasured = buildBookReport({ tradingStyle: 'scalping', interval: '1m' }, [trade()], ledgers, null);
    expect(unmeasured.recordedExpectancyPercent).toBeNull();
    expect(unmeasured.evidenceStatus).toBe('none');
  });

  it('counts exit reasons and the execution exceptions', () => {
    const report = buildBookReport(
      { tradingStyle: 'day_trading', interval: '1h' },
      [
        trade(),
        trade({ entryTime: 3, exitReason: 'stop_loss' } as Partial<IPaperTrade>),
        trade({
          entryTime: 5,
          exitReason: 'stop_loss',
          executable: { ...trade().executable, gappedStop: true },
        } as Partial<IPaperTrade>),
        trade({
          entryTime: 7,
          executable: { ...trade().executable, stoppedOnArrival: true },
        } as Partial<IPaperTrade>),
        trade({
          entryTime: 9,
          executable: { ...trade().executable, filled: false },
        } as Partial<IPaperTrade>),
      ],
      ledgers,
      null
    );
    expect(report.byReason).toEqual({ signal: 3, stop_loss: 2 });
    expect(report.gappedStops).toBe(1);
    expect(report.stoppedOnArrival).toBe(1);
    expect(report.unfilled).toBe(1);
    // An unfilled trade is excluded from the executable track entirely.
    expect(report.executable!.trades).toBe(4);
  });

  it('handles a book with no trades yet', () => {
    const report = buildBookReport({ tradingStyle: 'scalping', interval: '5m' }, [], ledgers, null);
    expect(report.trades).toBe(0);
    expect(report.engine).toBeNull();
    expect(report.executable).toBeNull();
    expect(report.lagCostPercent).toBeNull();
  });
});

describe('formatReport', () => {
  const report = buildBookReport(
    { tradingStyle: 'day_trading', interval: '1h' },
    [trade(), trade({ entryTime: 3 })],
    [{ equity: 1002, executableEquity: 1001, position: null }],
    { missingScoreBars: 1, peakLeverage: 2.4 }
  );

  it('prints both tracks, the lag cost and the recorded number', () => {
    const text = formatReport([report], false);
    expect(text).toContain('=== day_trading:1h ===');
    expect(text).toContain('engine      n=2');
    expect(text).toContain('executable  n=2');
    expect(text).toContain('lag cost    +0.2000%');
    expect(text).toContain('recorded    -0.0687%');
    expect(text).toContain('peak leverage=2.40x');
    expect(text).toContain('Win rate is reported, never targeted.');
  });

  it('says so when a book has no closed trades', () => {
    const empty = buildBookReport({ tradingStyle: 'scalping', interval: '1m' }, [], [], null);
    expect(formatReport([empty], false)).toContain('no closed trades yet');
  });

  it('emits one JSON line per book', () => {
    const lines = formatReport([report, report], true).split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).book).toBe('day_trading:1h');
  });
});
