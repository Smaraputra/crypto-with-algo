// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { LiveRow } from './live-record-stats';
import { analyseRescoreCell, buildReport, parityOf, parseArgs, pearson } from './v8-rescore-run';
import { V8_RESCORE_CELLS, V8_RESCORE_VERDICT_LEVEL } from './v8-rescore';

function row(over: Partial<LiveRow>): LiveRow {
  return {
    symbol: 'BTCUSDT',
    interval: '1h',
    tradingStyle: 'day_trading',
    tier: 'neutral',
    score: 0,
    configVersion: 8,
    candleTimestamp: 0,
    horizonBars: 24,
    forwardReturnPercent: 0,
    ...over,
  };
}

describe('parityOf', () => {
  it('joins on symbol, interval, style and timestamp and reports the differences', () => {
    const rescored = [
      row({ candleTimestamp: 1, score: 30, tier: 'buy' }),
      row({ candleTimestamp: 2, score: 10, tier: 'neutral' }),
      row({ candleTimestamp: 3, score: -40, tier: 'strong_sell' }),
      row({ candleTimestamp: 4, score: 5 }),
      row({ symbol: 'ETHUSDT', candleTimestamp: 1, score: 99, tier: 'strong_buy' }),
    ];
    const live = [
      row({ candleTimestamp: 1, score: 27, tier: 'neutral' }),
      row({ candleTimestamp: 2, score: 12, tier: 'neutral' }),
      row({ candleTimestamp: 3, score: -41, tier: 'strong_sell' }),
      row({ candleTimestamp: 9, score: 7 }),
    ];
    const p = parityOf(rescored, live);
    expect(p.matched).toBe(3);
    expect(p.sameTierShare).toBeCloseTo(2 / 3, 10);
    expect(p.meanAbsScoreDiff).toBeCloseTo((3 + 2 + 1) / 3, 10);
    expect(p.maxAbsScoreDiff).toBe(3);
    expect(p.scoreCorrelation).toBeGreaterThan(0.99);
  });

  it('reports NaN when nothing matches', () => {
    const p = parityOf([row({ candleTimestamp: 1 })], [row({ candleTimestamp: 2 })]);
    expect(p.matched).toBe(0);
    expect(Number.isNaN(p.sameTierShare)).toBe(true);
  });

  it('pearson is 1 for a linear map and NaN for a constant', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(Number.isNaN(pearson([1, 1, 1], [1, 2, 3]))).toBe(true);
  });
});

describe('analyseRescoreCell at the Bonferroni level', () => {
  // 600 hourly timestamps, 4 symbols; buy rows win and sell rows lose by construction.
  const rows: LiveRow[] = [];
  for (let t = 0; t < 600; t++) {
    for (const [k, symbol] of ['A', 'B', 'C', 'D'].entries()) {
      const buy = (t + k) % 2 === 0;
      rows.push(
        row({
          symbol,
          candleTimestamp: t * 3_600_000,
          tier: buy ? 'buy' : 'sell',
          score: buy ? 30 : -30,
          forwardReturnPercent: (buy ? 1 : -1) * (0.5 + ((t * 7 + k) % 10) / 20),
        })
      );
    }
  }
  const cell = { style: 'day_trading', interval: '1h', horizonBars: 24 };

  it('uses the study level, reports RIGHT on a perfect signal, and is deterministic', () => {
    const a = analyseRescoreCell(rows, [], cell, 200, 13);
    const b = analyseRescoreCell(rows, [], cell, 200, 13);
    expect(a.verdict.level).toBe(V8_RESCORE_VERDICT_LEVEL);
    expect(a.verdict.verdict).toBe('RIGHT');
    expect(a.intervals.bh.loLevel).toBeDefined();
    expect(a.intervals.bh.loLevel).toBeLessThanOrEqual(a.intervals.bh.lo95 + 1e-12);
    expect(b.verdict).toEqual(a.verdict);
    expect(a.costPercent).toBeGreaterThan(0);
  });

  it('is not assessable with too few rows', () => {
    const few = rows.slice(0, 40);
    expect(analyseRescoreCell(few, [], cell, 50, 13).verdict.verdict).toBe('NOT ASSESSABLE');
  });
});

describe('buildReport', () => {
  it('has one entry per pre-registered cell and the report kind', () => {
    const report = buildReport([], 0, [], 'a'.repeat(64), 'b'.repeat(64), null, 10, 13);
    expect(report.reportKind).toBe('v8-rescore');
    expect(report.cells).toHaveLength(V8_RESCORE_CELLS.length);
    expect(report.cells.every((c) => c.verdict.verdict === 'NOT ASSESSABLE')).toBe(true);
    expect(Object.keys(report.parity)).toHaveLength(6);
  });

  it('parses flags', () => {
    expect(parseArgs(['--rows', 'r', '--live-export', 'l', '--out', 'o', '--expect-sha256', 'AB'])).toEqual({
      rowsPath: 'r',
      liveExportPath: 'l',
      outPath: 'o',
      expectSha256: 'ab',
    });
    expect(() => parseArgs(['--rows', 'r', '--out', 'o'])).toThrow('--live-export');
  });
});
