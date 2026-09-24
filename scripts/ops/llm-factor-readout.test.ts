// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

import {
  formatReport,
  parseArgs,
  runLlmFactorReadout,
  type ReadoutDeps,
} from './llm-factor-readout';
import type { PanelObservation } from './llm-factor-stats';

const BAR = 3_600_000;
const NOW = Date.parse('2026-09-24T15:00:00.000Z');

function bar(ts: number, entries: Array<[string, number, number]>): PanelObservation[] {
  return entries.map(([symbol, score, forwardReturnPercent]) => ({
    symbol,
    candleTimestamp: ts,
    score,
    forwardReturnPercent,
  }));
}

function depsReturning(rows: PanelObservation[]): ReadoutDeps {
  return { loadResolved: vi.fn().mockResolvedValue(rows) };
}

describe('parseArgs', () => {
  it('defaults to every LLM interval', () => {
    expect(parseArgs([]).intervals).toEqual(['1h', '4h', '1d']);
  });

  it('accepts a subset of intervals', () => {
    expect(parseArgs(['--interval', '1h,1d']).intervals).toEqual(['1h', '1d']);
  });

  it('rejects an interval the panel does not vote on', () => {
    expect(() => parseArgs(['--interval', '5m'])).toThrow(/comma list/);
  });

  it('rejects an empty interval list', () => {
    expect(() => parseArgs(['--interval', ''])).toThrow(/comma list/);
  });

  it('parses a prompt version', () => {
    expect(parseArgs(['--prompt-version', '1']).promptVersion).toBe(1);
    expect(() => parseArgs(['--prompt-version', '0'])).toThrow(/positive integer/);
  });

  it('refuses a cross-section narrower than three', () => {
    // At two symbols, demeaning leaves +d and -d and the IC is +/-1 by
    // construction, which would read as a perfect factor on noise.
    expect(() => parseArgs(['--min-cross-section', '2'])).toThrow(/at least 3/);
    expect(parseArgs(['--min-cross-section', '4']).minCrossSection).toBe(4);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--backtest'])).toThrow(/Unknown argument/);
  });
});

describe('runLlmFactorReadout', () => {
  it('reports the horizon the interval is actually scored over', async () => {
    const report = await runLlmFactorReadout(
      depsReturning([]),
      { intervals: ['1h', '4h', '1d'], promptVersion: undefined, minCrossSection: 3 },
      NOW
    );

    // day_trading 24, swing_trading 30, position_trading 20.
    expect(report.intervals.map((r) => r.horizonBars)).toEqual([24, 30, 20]);
  });

  it('separates the panel\'s ranking from the market\'s direction', async () => {
    // Every symbol up 10%, spread exactly inverse to the call.
    const rows = bar(BAR, [
      ['A', 80, 10 - 4],
      ['B', 40, 10 - 2],
      ['C', -40, 10 + 2],
      ['D', -80, 10 + 4],
    ]);

    const report = await runLlmFactorReadout(
      depsReturning(rows),
      { intervals: ['1h'], promptVersion: undefined, minCrossSection: 3 },
      NOW
    );
    const r = report.intervals[0];

    expect(r.demeanedIc).toBeCloseTo(-1, 6);
    // The market contribution is visible and large, which is the point: a
    // per-tier mean would have read every tier as profitable.
    expect(r.meanForwardPercent).toBeCloseTo(10, 6);
  });

  it('refuses to call a short record readable', async () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      bar(i * BAR, [['A', 80, -1], ['B', 40, 0], ['C', -40, 1], ['D', -80, 2]])
    ).flat();

    const report = await runLlmFactorReadout(
      depsReturning(rows),
      { intervals: ['1h'], promptVersion: undefined, minCrossSection: 3 },
      NOW
    );

    expect(report.intervals[0].verdict).toMatch(/NOT READABLE/);
  });

  it('passes the prompt version through to the loader', async () => {
    const deps = depsReturning([]);
    await runLlmFactorReadout(
      deps,
      { intervals: ['1h'], promptVersion: 2, minCrossSection: 3 },
      NOW
    );

    expect(deps.loadResolved).toHaveBeenCalledWith('1h', 2);
  });

  it('records the bar range covered', async () => {
    const report = await runLlmFactorReadout(
      depsReturning(bar(BAR, [['A', 1, 1], ['B', 2, 2], ['C', 3, 3]])),
      { intervals: ['1h'], promptVersion: undefined, minCrossSection: 3 },
      NOW
    );

    expect(report.intervals[0].firstBar).toBe(new Date(BAR).toISOString());
    expect(report.intervals[0].lastBar).toBe(new Date(BAR).toISOString());
  });

  it('handles an interval with no resolved calls', async () => {
    const report = await runLlmFactorReadout(
      depsReturning([]),
      { intervals: ['1d'], promptVersion: undefined, minCrossSection: 3 },
      NOW
    );
    const r = report.intervals[0];

    expect(r.n).toBe(0);
    expect(r.firstBar).toBeNull();
    expect(r.verdict).toMatch(/too few cross-sections/);
  });
});

describe('formatReport', () => {
  async function sample() {
    const rows = Array.from({ length: 15 }, (_, i) =>
      bar(i * BAR, [['A', 80, -1], ['B', 40, 0], ['C', -40, 1], ['D', -80, 2]])
    ).flat();
    return runLlmFactorReadout(
      depsReturning(rows),
      { intervals: ['1h'], promptVersion: 1, minCrossSection: 3 },
      NOW
    );
  }

  it('prints the t-stat and its inflation factor on the same line', async () => {
    // They must never be separable by eye: the whole failure this guards
    // against is quoting t = -2.76 without the sqrt(horizon) correction.
    const line = formatReport(await sample(), false)
      .split('\n')
      .find((l) => l.includes('naiveT='));

    expect(line).toBeDefined();
    expect(line).toMatch(/inflatedBy=/);
  });

  it('prints the verdict for every interval', async () => {
    expect(formatReport(await sample(), false)).toMatch(/NOT READABLE/);
  });

  it('states that it is a measurement and not a backtest', async () => {
    expect(formatReport(await sample(), false)).toMatch(/never a backtest/);
  });

  it('emits one JSON object with --json', async () => {
    const output = formatReport(await sample(), true);

    expect(output.split('\n')).toHaveLength(1);
    expect(JSON.parse(output).intervals[0].interval).toBe('1h');
  });

  it('prints n/a rather than NaN for an empty interval', async () => {
    const report = await runLlmFactorReadout(
      depsReturning([]),
      { intervals: ['1d'], promptVersion: undefined, minCrossSection: 3 },
      NOW
    );

    const output = formatReport(report, false);
    expect(output).not.toMatch(/NaN/);
    expect(output).toMatch(/n\/a/);
  });
});
