// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FORWARD_ALPHA, FORWARD_CELLS, FORWARD_DATA_START, FORWARD_NULL, FORWARD_WINDOW } from './forward-test';
import {
  compareSpans,
  forwardCell,
  forwardMinShiftBars,
  forwardRsiPass,
  forwardWindowMs,
  parseForwardRsiArgs,
  reduceToColumn,
  runForwardRsi,
  spanCheckPass,
  type SpanSeries,
} from './forward-rsi';
import { perpSeries5m, writeSnipeFixture } from './snipe-fixture';
import { computeFactorMatrix, toOHLCV } from './factors';
import { atr, rsi } from './families/legends-indicators';
import { runSpanCheck } from './forward-rsi';
import { buildSymbolArrays } from './snipe-matrix';
import { SNIPE_NULL_SD_INFLATION } from './snipe';

describe('forward-rsi pure parts', () => {
  it('the frozen cells map to the snipe cells and the locked constants', () => {
    expect(forwardCell('A1')).toEqual({ column: 'raw.rsi', tail: 'bottom', level: 'many', timeframe: 'scalp' });
    expect(forwardCell('A2')).toEqual({ column: 'raw.rsi', tail: 'top', level: 'many', timeframe: 'scalp' });
    expect(FORWARD_CELLS.A1.direction).toBe(1);
    expect(FORWARD_CELLS.A2.direction).toBe(-1);
    expect(forwardMinShiftBars()).toBe(8_640);
    expect(forwardWindowMs()).toEqual({ startMs: Date.parse(FORWARD_WINDOW.start), endMs: Date.parse(FORWARD_WINDOW.end) });
    expect(SNIPE_NULL_SD_INFLATION).toBe(FORWARD_NULL.sdInflation);
  });

  it('parses flags with the locked defaults and validates the span-check start', () => {
    const a = parseForwardRsiArgs(['--dataset-dir', 'd', '--out', 'o.json']);
    expect(a.draws).toBe(FORWARD_NULL.draws);
    expect(a.symbols).toHaveLength(10);
    expect(a.spanCheckStart).toBeUndefined();
    const b = parseForwardRsiArgs([
      '--dataset-dir', 'd', '--out', 'o.json', '--draws', '20', '--symbols', 'BTCUSDT,ETHUSDT',
      '--span-check-start', '2025-11-01T00:00:00Z',
    ]);
    expect(b).toMatchObject({ draws: 20, symbols: ['BTCUSDT', 'ETHUSDT'], spanCheckStart: Date.UTC(2025, 10, 1) });
    expect(() => parseForwardRsiArgs(['--out', 'o'])).toThrow(/--dataset-dir/);
    expect(() => parseForwardRsiArgs(['--dataset-dir', 'd'])).toThrow(/--out/);
    expect(() => parseForwardRsiArgs(['--dataset-dir', 'd', '--out', 'o', '--span-check-start', 'nope'])).toThrow(/date/);
    expect(() =>
      parseForwardRsiArgs(['--dataset-dir', 'd', '--out', 'o', '--span-check-start', '2026-04-01T00:00:00Z'])
    ).toThrow(/earlier/);
    expect(() => parseForwardRsiArgs(['--dataset-dir', 'd', '--out', 'o', '--allow-lockbox', 'x'])).toThrow(/Unknown flag/);
  });

  it('parses --window-end: absent and equal are binding, later is descriptive, earlier and invalid are refused', () => {
    const base = ['--dataset-dir', 'd', '--out', 'o'];
    const absent = parseForwardRsiArgs(base);
    expect(absent).toMatchObject({ mode: 'binding', windowEnd: FORWARD_WINDOW.end });
    expect(parseForwardRsiArgs([...base, '--window-end', FORWARD_WINDOW.end])).toMatchObject({
      mode: 'binding',
      windowEnd: FORWARD_WINDOW.end,
    });
    expect(parseForwardRsiArgs([...base, '--window-end', '2026-10-09T23:59:59.999+00:00'])).toMatchObject({ mode: 'binding' });
    const later = parseForwardRsiArgs([...base, '--window-end', '2026-11-09T23:59:59.999Z']);
    expect(later).toMatchObject({ mode: 'descriptive', windowEnd: '2026-11-09T23:59:59.999Z' });
    expect(forwardWindowMs(later.windowEnd).endMs).toBe(Date.parse('2026-11-09T23:59:59.999Z'));
    expect(() => parseForwardRsiArgs([...base, '--window-end', '2026-10-09T23:59:59.998Z'])).toThrow(/earlier/);
    expect(() => parseForwardRsiArgs([...base, '--window-end', 'nope'])).toThrow(/ISO/);
    expect(() => parseForwardRsiArgs([...base, '--window-end', '2026-13-45T00:00:00Z'])).toThrow(/ISO/);
    expect(() => parseForwardRsiArgs([...base, '--window-end', '2026-11-09'])).toThrow(/ISO/);
  });

  it('pass needs the empirical p, the inflated z p and the month consistency, each strictly', () => {
    const ok = { empiricalP: 0.01, zP1: 0.01 };
    expect(forwardRsiPass(ok, { pass: true })).toBe(true);
    expect(forwardRsiPass({ ...ok, empiricalP: FORWARD_ALPHA }, { pass: true })).toBe(false);
    expect(forwardRsiPass({ ...ok, zP1: FORWARD_ALPHA }, { pass: true })).toBe(false);
    expect(forwardRsiPass({ ...ok, zP1: 0.02 }, { pass: true })).toBe(false);
    expect(forwardRsiPass(ok, { pass: false })).toBe(false);
    expect(forwardRsiPass({ empiricalP: NaN, zP1: 0.001 }, { pass: true })).toBe(false);
    expect(FORWARD_ALPHA).toBeCloseTo(0.05 / 3, 15);
  });

  it('compareSpans reports the max difference inside the window only, and mismatches', () => {
    const ts = [0, 1, 2, 3, 4, 5];
    const base: SpanSeries = {
      timestamps: ts,
      values: [1, 2, 3, 4, 5, 6],
      outcome: [1, 1, 2, 2, 0, 0],
      flags: [0, 1, 0, 1, 0, 1],
    };
    const other: SpanSeries = {
      timestamps: ts,
      values: [100, 2 + 3e-12, 3, 4 - 5e-10, 5, 600],
      outcome: [2, 1, 2, 2, 0, 1],
      flags: [1, 1, 0, 1, 0, 0],
    };
    const c = compareSpans(base, other, 1, 4);
    expect(c.barsCompared).toBe(4);
    expect(c.maxAbsDiff).toBeCloseTo(5e-10, 15);
    expect(c.outcomeMismatches).toBe(0);
    expect(c.flagMismatches).toBe(0);
    expect(spanCheckPass(c)).toBe(true);
    const wide = compareSpans(base, other, 0, 5);
    expect(wide.maxAbsDiff).toBe(594);
    expect(wide.outcomeMismatches).toBe(2);
    expect(wide.flagMismatches).toBe(2);
    expect(spanCheckPass(wide)).toBe(false);
  });

  it('compareSpans handles NaN, missing bars and rejects an empty comparison', () => {
    const a: SpanSeries = { timestamps: [0, 1, 2], values: [NaN, 1, 2], outcome: [0, 0, 0], flags: [0, 0, 0] };
    const b: SpanSeries = { timestamps: [1, 2, 3], values: [1, NaN, 3], outcome: [0, 0, 0], flags: [0, 0, 0] };
    const c = compareSpans(a, b, 0, 3);
    expect(c.barsCompared).toBe(2);
    expect(c.barsOnlyInA).toBe(1);
    expect(c.barsOnlyInB).toBe(1);
    expect(c.finitenessMismatches).toBe(1);
    expect(spanCheckPass(c)).toBe(false);
    expect(spanCheckPass(compareSpans(a, b, 10, 20))).toBe(false);
  });
});

describe('forward-rsi on a synthetic dataset', { timeout: 300_000 }, () => {
  let dir: string;
  const BARS = 63_936; // 2026-03-01 to 2026-10-09 at 5m
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'forward-rsi-'));
    await writeSnipeFixture(dir, ['BTCUSDT', 'ETHUSDT'], [4242, 777], BARS);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reduceToColumn keeps one aligned flag column', () => {
    const a = buildSymbolArrays(dir, 'BTCUSDT', 'scalp', {
      allowLockbox: true,
      startMs: Date.parse(FORWARD_DATA_START),
      endMs: Date.parse(FORWARD_WINDOW.end),
    });
    const r = reduceToColumn(a, 'raw.rsi');
    expect(r.columns).toEqual(['raw.rsi']);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0]).toBe(a.flags[a.columns.indexOf('raw.rsi')]);
    expect(() => reduceToColumn(a, 'raw.nope')).toThrow(/not in the arrays/);
  });

  it('runs both cells, writes the report and records the span check', async () => {
    const out = join(dir, 'report.json');
    const lines: string[] = [];
    const report = await runForwardRsi(
      {
        datasetDir: dir,
        windowEnd: FORWARD_WINDOW.end,
        mode: 'binding',
        out,
        draws: 20,
        symbols: ['BTCUSDT', 'ETHUSDT'],
        spanCheckStart: Date.parse('2026-02-01T00:00:00Z'),
      },
      (l) => lines.push(l)
    );
    const disk = JSON.parse(readFileSync(out, 'utf8'));
    expect(disk.reportKind).toBe('forward-rsi');
    expect(disk).toMatchObject({ mode: 'binding', binding: true });
    expect(disk.datasetManifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(disk.window).toEqual(FORWARD_WINDOW);
    expect(disk.draws).toBe(20);
    expect(disk.sdInflation).toBe(1.25);
    expect(disk.cells.map((c: { name: string }) => c.name)).toEqual(['A1', 'A2']);
    expect(report.cells.map((c) => c.direction)).toEqual([1, -1]);
    for (const c of report.cells) {
      expect(c.report.resolved).toBeGreaterThan(0);
      expect(c.report.validDraws).toBe(20);
      expect(c.monthConsistency.period).toBe('month');
      // Two symbols can never satisfy the 7-symbol agreement leg, so the cell cannot pass.
      expect(c.pass).toBe(false);
    }
    expect(report.rsiSpanCheck).toMatchObject({ requested: true, symbol: 'BTCUSDT', pass: true });
    expect(report.rsiSpanCheck.comparison!.maxAbsDiff).toBeLessThanOrEqual(1e-9);
    expect(report.rsiSpanCheck.comparison!.barsCompared).toBeGreaterThan(20_000);
    expect(lines.join('\n')).toMatch(/A1 dir 1 FAIL/);
    expect(lines.join('\n')).toMatch(/rsiSpanCheck PASS/);
  });

  it('a descriptive run carries mode, binding false and no boolean pass on any cell', async () => {
    const out = join(dir, 'rd.json');
    const lines: string[] = [];
    const report = await runForwardRsi(
      {
        datasetDir: dir,
        out,
        draws: 5,
        symbols: ['BTCUSDT', 'ETHUSDT'],
        windowEnd: '2026-10-09T23:59:59.999Z',
        mode: 'descriptive',
      },
      (l) => lines.push(l)
    );
    const disk = JSON.parse(readFileSync(out, 'utf8'));
    expect(disk).toMatchObject({ mode: 'descriptive', binding: false });
    expect(disk.cells).toHaveLength(2);
    for (const c of disk.cells) {
      expect(c.pass).toBeNull();
      expect(c.descriptiveOnly).toBe(true);
      expect(typeof c.pass).not.toBe('boolean');
      expect(c.report.resolved).toBeGreaterThan(0);
    }
    expect(report.cells.every((c) => c.pass === null)).toBe(true);
    expect(lines.join('\n')).toMatch(/A1 dir 1 DESCRIPTIVE/);
    expect(lines.join('\n')).not.toMatch(/PASS|FAIL/);
  });

  it('without --span-check-start the block says not requested', async () => {
    const report = await runForwardRsi(
      { datasetDir: dir, windowEnd: FORWARD_WINDOW.end, mode: 'binding', out: join(dir, 'r2.json'), draws: 5, symbols: ['BTCUSDT', 'ETHUSDT'] },
      () => undefined
    );
    expect(report.rsiSpanCheck).toEqual({ requested: false });
  });

  it('refuses a span check when BTCUSDT is not among the symbols', async () => {
    await expect(
      runForwardRsi(
        { datasetDir: dir, windowEnd: FORWARD_WINDOW.end, mode: 'binding', out: join(dir, 'r3.json'), draws: 5, symbols: ['ETHUSDT'], spanCheckStart: Date.parse('2026-02-01') },
        () => undefined
      )
    ).rejects.toThrow(/BTCUSDT/);
  });
});

describe('span equality (Wilder RSI and ATR forget their start)', { timeout: 300_000 }, () => {
  const DAY = 86_400_000;
  // Long series from 2026-03-01; the short one starts 61 days later (2026-05-01); the window starts 4 months
  // after the short start (2026-09-01) and lasts 4 days.
  const rows = perpSeries5m(9001, 55_000);
  const shortStart = Date.UTC(2026, 4, 1);
  const windowStart = Date.UTC(2026, 8, 1);
  const windowEnd = windowStart + 4 * DAY;
  const shortRows = rows.filter((r) => r.t >= shortStart);

  function inWindow(ts: ArrayLike<number>, values: ArrayLike<number>): Map<number, number> {
    const m = new Map<number, number>();
    for (let i = 0; i < ts.length; i++) if (ts[i] >= windowStart && ts[i] <= windowEnd) m.set(ts[i], values[i]);
    return m;
  }
  function maxDiff(a: Map<number, number>, b: Map<number, number>): number {
    expect(a.size).toBeGreaterThan(1000);
    expect(b.size).toBe(a.size);
    let worst = 0;
    for (const [t, v] of a) {
      const w = b.get(t)!;
      expect(Number.isFinite(v)).toBe(true);
      expect(Number.isFinite(w)).toBe(true);
      worst = Math.max(worst, Math.abs(v - w));
    }
    return worst;
  }

  it('Wilder RSI(7) and ATR(14) agree within 1e-9 inside the window', () => {
    const longBars = rows.map(toOHLCV);
    const shortBars = shortRows.map(toOHLCV);
    for (const [name, fn] of [
      ['rsi7', (b: typeof longBars) => rsi(b, 7)],
      ['atr14', (b: typeof longBars) => atr(b, 14)],
    ] as const) {
      const a = inWindow(longBars.map((b) => b.timestamp), fn(longBars));
      const b = inWindow(shortBars.map((x) => x.timestamp), fn(shortBars));
      expect(maxDiff(a, b), name).toBeLessThanOrEqual(1e-9);
    }
  });

  it('the factor matrix raw.rsi and raw.atrPct agree within 1e-9 inside the window', () => {
    const build = (r: typeof rows) =>
      computeFactorMatrix({
        candles: r,
        snapshots: null,
        lsRows1h: null,
        htf: r.map((x) => ({ t: x.t, context: null })),
        interval: '5m',
        metrics: null,
        perp: r,
        premiumIndex: null,
        options: null,
        marketOptions: null,
      });
    const longM = build(rows);
    const shortM = build(shortRows);
    for (const name of ['raw.rsi', 'raw.atrPct']) {
      const a = inWindow(longM.timestamps, longM.values[longM.names.indexOf(name)]);
      const b = inWindow(shortM.timestamps, shortM.values[shortM.names.indexOf(name)]);
      expect(maxDiff(a, b), name).toBeLessThanOrEqual(1e-9);
    }
  });
});

describe('runSpanCheck on a dataset with a real start difference', { timeout: 300_000 }, () => {
  it('passes when the main span starts a month later than the earlier span', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forward-span-'));
    try {
      await writeSnipeFixture(dir, ['BTCUSDT'], [31337], 63_936);
      const window = { startMs: Date.UTC(2026, 7, 1), endMs: Date.parse(FORWARD_WINDOW.end) };
      const main = buildSymbolArrays(dir, 'BTCUSDT', 'scalp', {
        allowLockbox: true,
        startMs: Date.UTC(2026, 3, 1),
        endMs: window.endMs,
        captureColumn: 'raw.rsi',
      });
      const check = runSpanCheck(dir, reduceToColumn(main, 'raw.rsi'), Date.UTC(2026, 2, 1), window);
      expect(check.comparison!.barsCompared).toBe(19_872);
      expect(check.comparison!.maxAbsDiff).toBeLessThanOrEqual(1e-9);
      expect(check.comparison!.outcomeMismatches).toBe(0);
      expect(check.comparison!.flagMismatches).toBe(0);
      expect(check.pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
