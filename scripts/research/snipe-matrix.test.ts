// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadPerp } from './load-dataset';
import { computeFactorMatrix, toOHLCV } from './factors';
import { labelEntries } from './snipe-labels';
import { monthIndex, monthlyThresholds, tailFlags, TAIL_ELIGIBLE, TAIL_PROBS } from './snipe-tails';
import { buildSymbolArrays } from './snipe-matrix';
import { SNIPE_COLUMNS, SNIPE_LOCKBOX_START, SNIPE_TIMEFRAMES } from './snipe';
import { writeSnipeFixture } from './snipe-fixture';

let dir: string;
const SYMBOL = 'BTCUSDT';
const LOCKBOX = Date.parse(SNIPE_LOCKBOX_START);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'snipe-matrix-'));
  await writeSnipeFixture(dir, [SYMBOL], [4242]);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('buildSymbolArrays intraday', { timeout: 30_000 }, () => {
  const run = () => buildSymbolArrays(dir, SYMBOL, 'intraday');

  it('returns aligned arrays with the 38 columns', () => {
    const a = run();
    const n = a.timestamps.length;
    expect(a.columns).toEqual([...SNIPE_COLUMNS]);
    expect(a.flags).toHaveLength(38);
    expect(a.finiteShare).toHaveLength(38);
    for (const f of a.flags) expect(f.length).toBe(n);
    for (const arr of [a.outcome, a.entryMs, a.exitMs, a.atrPct, a.atrQuintile, a.month]) expect(arr.length).toBe(n);
    expect(a.warmupBars).toBeGreaterThan(0);
    expect(a.month[0]).toBe(monthIndex(a.timestamps[0]));
  });

  it('never loads lockbox rows', () => {
    const a = run();
    const full = loadPerp(dir, SYMBOL, '1h', 'klines', { allowLockbox: true }).rows;
    expect(full[full.length - 1].t).toBeGreaterThanOrEqual(LOCKBOX);
    expect(a.timestamps[a.timestamps.length - 1]).toBeLessThan(LOCKBOX);
    // No label path or exit reaches the lockbox either.
    for (let i = 0; i < a.exitMs.length; i++) if (Number.isFinite(a.exitMs[i])) expect(a.exitMs[i]).toBeLessThan(LOCKBOX);
  });

  it('labels equal labelEntries called directly', () => {
    const a = run();
    const bars = loadPerp(dir, SYMBOL, '1h').rows.map(toOHLCV);
    const path = loadPerp(dir, SYMBOL, '5m').rows.map(toOHLCV);
    const direct = labelEntries({
      entryBars: bars,
      entryIntervalMs: 3_600_000,
      pathBars: path,
      maxHoldMs: SNIPE_TIMEFRAMES.intraday.maxHoldMs,
      atrPeriod: 14,
      barrierAtr: 1,
      sliceEndMs: LOCKBOX - 1,
    });
    expect(Array.from(a.outcome)).toEqual(Array.from(direct.outcome));
    expect(Array.from(a.exitMs)).toEqual(Array.from(direct.exitMs));
    expect(Array.from(a.entryMs)).toEqual(Array.from(direct.entryMs));
    expect(Array.from(a.atrPct)).toEqual(Array.from(direct.atrPct));
    expect(a.outcome.some((o) => o === 1) && a.outcome.some((o) => o === 2)).toBe(true);
  });

  it('flags equal tailFlags on the directly computed matrix, and ATR quintiles exist', () => {
    const a = run();
    const rows = loadPerp(dir, SYMBOL, '1h').rows;
    const matrix = computeFactorMatrix({
      candles: rows,
      snapshots: null,
      htf: rows.map((r) => ({ t: r.t, context: null })),
      interval: '1h',
      perp: rows,
    });
    // Compare a column that does not depend on HTF or snapshots.
    const name = 'raw.ret1';
    const idx = matrix.names.indexOf(name);
    const ts = Float64Array.from(matrix.timestamps);
    const direct = tailFlags(ts, matrix.values[idx], monthlyThresholds(ts, matrix.values[idx], TAIL_PROBS, 90, 3_600_000));
    expect(Array.from(a.flags[SNIPE_COLUMNS.indexOf(name)])).toEqual(Array.from(direct));
    expect(a.flags[SNIPE_COLUMNS.indexOf(name)].some((f) => (f & TAIL_ELIGIBLE) !== 0)).toBe(true);
    expect(a.atrQuintile.some((q) => q >= 0)).toBe(true);
  });

  it('makes columns without their source file NaN with a share of 0', () => {
    const a = run();
    expect(a.finiteShare[SNIPE_COLUMNS.indexOf('raw.basisPct')]).toBe(0);
    expect(a.finiteShare[SNIPE_COLUMNS.indexOf('raw.takerLongShortRatio')]).toBe(0);
    expect(a.finiteShare[SNIPE_COLUMNS.indexOf('raw.ret1')]).toBeGreaterThan(0.9);
  });
});

describe('buildSymbolArrays scalp', { timeout: 30_000 }, () => {
  it('uses 5m entry bars aligned with the 5m perp series', () => {
    const a = buildSymbolArrays(dir, SYMBOL, 'scalp');
    const rows = loadPerp(dir, SYMBOL, '5m').rows;
    expect(a.timestamps.length).toBe(rows.length);
    expect(a.timestamps[5]).toBe(rows[5].t);
    expect(a.flags[0].length).toBe(rows.length);
    expect(a.timestamps[a.timestamps.length - 1]).toBeLessThan(LOCKBOX);
  });
});

describe('buildSymbolArrays errors', () => {
  it('throws when the perp klines are missing', () => {
    expect(() => buildSymbolArrays(dir, 'NOPEUSDT', 'intraday')).toThrow(/no perp 1h klines/);
  });
});
