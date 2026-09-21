import { describe, expect, it } from 'vitest';

import { simulateExposure, type ExposureSymbolInput } from './exposure-sim';
import {
  EXPOSURE_GRID_CELL_COUNT,
  MIN_TEST_BARS,
  MIN_TRAIN_BARS,
  expandExposureGrid,
  gridFor,
  jointFactorStart,
  maxSmoothingWarmupBars,
  minIsSharpeBarsFor,
  preSmooth,
  resolveExposureWindowConfig,
  runExposureWalkForward,
  selectCellIndex,
  sliceSymbolInput,
  smoothingWarmupBars,
  summarizeCell,
  type ExposureCellSummary,
} from './exposure-walk-forward';

const DAY = 24 * 60 * 60 * 1000;

/** A deterministic pseudo-random walk. No Math.random: a flaky gate test is
 * worse than no test. */
function walk(n: number, drift: number, seed: number): number[] {
  const out = [100];
  let s = seed;
  for (let i = 1; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out.push(out[i - 1] * (1 + drift + (s / 0x7fffffff - 0.5) * 0.02));
  }
  return out;
}

function sym(name: string, n: number, drift: number, seed: number, zFn: (i: number) => number): ExposureSymbolInput {
  const closes = walk(n, drift, seed);
  return {
    symbol: name,
    timestamps: closes.map((_, i) => i * DAY),
    closes,
    fundingRates: closes.map(() => 0),
    z: closes.map((_, i) => zFn(i)),
  };
}

describe('expandExposureGrid', () => {
  it('produces 36 distinct cells in the fixed band-major order', () => {
    const cells = expandExposureGrid();
    expect(cells).toHaveLength(EXPOSURE_GRID_CELL_COUNT);
    expect(cells).toHaveLength(36);

    const keys = new Set(cells.map((c) => `${c.band}|${c.zScale}|${c.smoothing}`));
    expect(keys.size).toBe(36);

    // The order is part of the contract: it sets the grid index, and therefore
    // both the earliest-index tie-break and the plateau's adjacency.
    expect(cells[0]).toEqual({ band: 0, zScale: 1, smoothing: 0 });
    expect(cells[cells.length - 1]).toEqual({ band: 0.5, zScale: 3, smoothing: 32 });
    // band=0 must be present: it is the internal control.
    expect(cells.some((c) => c.band === 0)).toBe(true);
  });
});

describe('gridFor', () => {
  it('always pins smoothing to 0 and carries the shared gross', () => {
    for (const cell of expandExposureGrid()) {
      const grid = gridFor(cell, { gross: 10, interval: '1d' });
      expect(grid.smoothing).toBe(0);
      expect(grid.gross).toBe(10);
      expect(grid.band).toBe(cell.band);
      expect(grid.zScale).toBe(cell.zScale);
    }
  });

  it('with gross = universe size, peak gross exposure is at most one unit', () => {
    const universe = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];
    const symbols = universe.map((s, i) => sym(s, 200, 0.001, 5 + i, () => -3));
    const result = simulateExposure(symbols, gridFor({ band: 0, zScale: 1, smoothing: 0 }, { gross: 3, interval: '1d' }), {});
    for (const g of result.grossExposure) {
      expect(g).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});

describe('preSmooth', () => {
  it('is a no-op for smoothing 0 or 1', () => {
    const symbols = [sym('AAAUSDT', 20, 0.001, 1, (i) => i)];
    const out = preSmooth(symbols, 0);
    expect(out[0].z).toEqual(symbols[0].z);
  });

  it('pre-smoothing alone is NOT enough: a trim at the raw warmup still leaves a dead head', () => {
    // The half-fix. The real column is NaN through its own warmup and finite
    // from `jointFactorStart` onward, which is where a naive trim would land.
    // A trailing mean does not make it finite any earlier, so the smoothed
    // column is STILL NaN for another `smoothing - 1` bars and a window
    // starting there sits its head out.
    const RAW_WARMUP = 40;
    const raw = sym('AAAUSDT', 400, 0.001, 3, (i) => (i < RAW_WARMUP ? Number.NaN : -2));

    // Trimmed to the raw warmup: the control shows the dead head the
    // pre-smoothing alone does NOT fix.
    const halfFixed = preSmooth([raw], 32);
    const halfSlice = sliceSymbolInput(halfFixed[0], RAW_WARMUP, 300);
    const halfGrid = gridFor({ band: 0, zScale: 1, smoothing: 0 }, { gross: 1, interval: '1d' });
    const halfResult = simulateExposure([halfSlice], halfGrid, {});
    expect(halfResult.grossExposure.slice(0, 31).every((g) => g === 0)).toBe(true);

    // The full fix: trim past `rawWarmup + smoothing - 1` as well, and the
    // smoothed column is finite at its first index so every window is
    // tradeable from its first bar.
    const trim = maxSmoothingWarmupBars(RAW_WARMUP);
    expect(trim).toBe(RAW_WARMUP + 31);
    expect(smoothingWarmupBars(RAW_WARMUP, 32)).toBe(RAW_WARMUP + 31);
    expect(smoothingWarmupBars(RAW_WARMUP, 0)).toBe(RAW_WARMUP);

    const fixed = preSmooth([raw], 32);
    const fixedSlice = sliceSymbolInput(fixed[0], trim, 300);
    expect(Number.isFinite(fixedSlice.z[0])).toBe(true);
    const fixedResult = simulateExposure([fixedSlice], halfGrid, {});
    expect(Math.abs(fixedResult.grossExposure[0])).toBeGreaterThan(0);
    expect(fixedResult.grossExposure.slice(0, 31).every((g) => g !== 0)).toBe(true);
  });
});

describe('jointFactorStart', () => {
  it('returns the LAST first-finite index across the universe', () => {
    const columns = new Map<string, readonly number[]>([
      ['AAAUSDT', [Number.NaN, Number.NaN, 1, 2]],
      ['BBBUSDT', [Number.NaN, 1, 2, 3]],
    ]);
    expect(jointFactorStart(columns)).toBe(2);
  });

  it('returns -1 when any symbol never produces a reading', () => {
    const columns = new Map<string, readonly number[]>([
      ['AAAUSDT', [Number.NaN, 1, 2]],
      ['BBBUSDT', [Number.NaN, Number.NaN, Number.NaN]],
    ]);
    expect(jointFactorStart(columns)).toBe(-1);
  });
});

describe('minIsSharpeBarsFor', () => {
  it('derives a per-window floor from the pooled sample gate', () => {
    expect(minIsSharpeBarsFor('1d', 0.4)).toBe(40);
    expect(minIsSharpeBarsFor('4h', 0.4)).toBe(40);
    expect(minIsSharpeBarsFor('5m', 0.4)).toBe(120);
  });
});

describe('resolveExposureWindowConfig', () => {
  const windows = { count: 6, trainFraction: 0.4, mode: 'rolling' as const };

  it('yields the arithmetic the plan records for a 1d-scale span', () => {
    const resolved = resolveExposureWindowConfig(1294, '1d', windows);
    expect(resolved.trainBars).toBe(517);
    expect(resolved.testWindowBars).toBe(129);
    expect(resolved.purgeGapBars).toBe(0);
    expect(resolved.stepSizeBars).toBe(129);
    expect(resolved.count).toBe(6);
    expect(resolved.bounds).toHaveLength(6);
    expect(resolved.minIsSharpeBars).toBe(40);
  });

  it('produces contiguous bounds starting right after the training slice', () => {
    const resolved = resolveExposureWindowConfig(2000, '1d', windows);
    const bounds = resolved.bounds;
    expect(bounds[0].testStart).toBe(resolved.trainBars);
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i].testStart).toBe(bounds[i - 1].testEnd + 1);
    }
    // The union is exactly count x testWindowBars bars.
    const total = bounds[bounds.length - 1].testEnd - bounds[0].testStart + 1;
    expect(total).toBe(resolved.count * resolved.testWindowBars);
  });

  it('throws when a window would be shorter than the floor', () => {
    expect(() => resolveExposureWindowConfig(400, '1d', { ...windows, count: 20 })).toThrow(
      new RegExp(`testWindowBars=\\d+ \\(< ${MIN_TEST_BARS}\\)`)
    );
  });

  it('throws when the pooled out-of-sample span cannot clear the sample gate', () => {
    // 5m needs 300 held bars; a single small window cannot reach it.
    expect(() => resolveExposureWindowConfig(400, '5m', { ...windows, count: 1 })).toThrow(
      /below the 300-bar sample gate/
    );
  });

  it('throws when the usable span is too short to earn a single return', () => {
    expect(() => resolveExposureWindowConfig(1, '1d', windows)).toThrow(/insufficient data/);
  });

  it('never lets the training slice fall below the smoothing warmup floor', () => {
    const resolved = resolveExposureWindowConfig(600, '1d', { ...windows, trainFraction: 0 });
    expect(resolved.trainBars).toBe(MIN_TRAIN_BARS);
    expect(MIN_TRAIN_BARS).toBe(64);
    // Without the floor, a zero train fraction would leave the longest
    // smoothing window with no history to warm up in.
    expect(Math.floor((600 - 1) * 0)).toBeLessThan(MIN_TRAIN_BARS);
  });
});

describe('summarizeCell and selectCellIndex', () => {
  function summary(overrides: Partial<ExposureCellSummary>): ExposureCellSummary {
    return {
      params: {},
      bars: 100,
      barsHeld: 100,
      sharpe: 0,
      meanReturnPercent: 0,
      returnSd: 0.01,
      turnover: 0,
      ...overrides,
    };
  }

  it('picks the highest in-sample Sharpe, earliest index winning ties', () => {
    const cells = [
      summary({ sharpe: 0.1 }),
      summary({ sharpe: 0.5 }),
      summary({ sharpe: 0.5 }),
      summary({ sharpe: 0.2 }),
    ];
    expect(selectCellIndex(cells, 40)).toBe(1);
  });

  it('skips a cell below the bars-held floor even with the best Sharpe', () => {
    const cells = [summary({ sharpe: 0.1 }), summary({ sharpe: 9, barsHeld: 39 })];
    expect(selectCellIndex(cells, 40)).toBe(0);
  });

  it('skips a degenerate cell whose Sharpe is the library zero, not a measurement', () => {
    // perPeriodSharpe returns 0 for a zero-variance series, so without the
    // spread check this cell would outrank a genuinely losing one.
    const cells = [summary({ sharpe: -0.4 }), summary({ sharpe: 0, returnSd: 0 })];
    expect(selectCellIndex(cells, 40)).toBe(0);
  });

  it('skips a cell with fewer than two finite returns', () => {
    const cells = [summary({ sharpe: -0.4 }), summary({ sharpe: 5, bars: 1 })];
    expect(selectCellIndex(cells, 40)).toBe(0);
  });

  it('returns -1 when nothing qualifies', () => {
    expect(selectCellIndex([summary({ barsHeld: 1 })], 40)).toBe(-1);
  });

  it('summarizeCell reports bars held from the gross exposure series', () => {
    const symbols = [sym('AAAUSDT', 300, 0.001, 9, () => -1)];
    const grid = gridFor({ band: 0, zScale: 1, smoothing: 0 }, { gross: 1, interval: '1d' });
    const result = simulateExposure(symbols, grid, {});
    const cell = summarizeCell({ band: 0, zScale: 1, smoothing: 0 }, result);
    expect(cell.barsHeld).toBeGreaterThan(0);
    expect(cell.barsHeld).toBeLessThanOrEqual(cell.bars);
    expect(cell.returnSd).toBeGreaterThan(0);
  });
});

describe('runExposureWalkForward', () => {
  function universe(n: number) {
    return ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'].map((s, i) =>
      sym(s, n, 0.0005, 11 + i, (idx) => Math.sin(idx / 40) * 2)
    );
  }

  it('emits one window per bound, each with a selected cell and an OOS run', () => {
    const result = runExposureWalkForward({
      symbols: universe(1500),
      interval: '1d',
      windows: { count: 6, trainFraction: 0.4, mode: 'rolling' },
      stress: { feeMultiplier: 1.5, slippageMultiplier: 2 },
    });
    expect(result.windows).toHaveLength(6);
    for (const w of result.windows) {
      expect(w.selectedParams).not.toBeNull();
      expect(w.skippedReason).toBeNull();
      expect(w.oos).not.toBeNull();
      expect(w.oosStressed).not.toBeNull();
      expect(w.isCells).toHaveLength(EXPOSURE_GRID_CELL_COUNT);
    }
    expect(result.allCells).toHaveLength(EXPOSURE_GRID_CELL_COUNT);
  });

  it('produces one allCells entry per grid cell, with distinct params', () => {
    const result = runExposureWalkForward({
      symbols: universe(1500),
      interval: '1d',
      windows: { count: 6, trainFraction: 0.4, mode: 'rolling' },
      stress: { feeMultiplier: 1.5, slippageMultiplier: 2 },
    });
    const keys = new Set(result.allCells.map((c) => JSON.stringify(c.params)));
    expect(keys.size).toBe(EXPOSURE_GRID_CELL_COUNT);
  });

  it('never hands the simulator a non-zero smoothing', () => {
    // The guard behind the pre-smoothing decision: if a cell's smoothing ever
    // reached the simulator, every window would restart its warmup.
    const result = runExposureWalkForward({
      symbols: universe(1500),
      interval: '1d',
      windows: { count: 6, trainFraction: 0.4, mode: 'rolling' },
      stress: { feeMultiplier: 1.5, slippageMultiplier: 2 },
    });
    for (const cell of result.allCells) {
      expect(cell.grid.smoothing).toBe(0);
    }
    for (const w of result.windows) {
      expect(w.oos!.grid.smoothing).toBe(0);
      expect(w.oosStressed!.grid.smoothing).toBe(0);
    }
    // The logical cell still records the smoothing it represents.
    expect(result.allCells.some((c) => c.params.smoothing === 32)).toBe(true);
  });

  it('the stressed run differs from the nominal one', () => {
    const result = runExposureWalkForward({
      symbols: universe(1500),
      interval: '1d',
      windows: { count: 6, trainFraction: 0.4, mode: 'rolling' },
      stress: { feeMultiplier: 1.5, slippageMultiplier: 2 },
    });
    const window = result.windows[0];
    const nominal = window.oos!.result.netReturns.reduce((a, b) => a + b, 0);
    const stressed = window.oosStressed!.result.netReturns.reduce((a, b) => a + b, 0);
    expect(stressed).toBeLessThan(nominal);
  });
});
