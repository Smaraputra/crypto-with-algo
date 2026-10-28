import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OHLCV } from '../../src/types/market';
import { RV_V1 } from '../../src/lib/signals/cross-sectional/engine';
import { c1Signals, tradesFor } from './lab-v4-preview';
import { NV1_C1, coinSeriesInWindow } from './nv1-c1';
import type { ScoreRow } from './nv1-c1-scores';
import { buildTrades } from './nv1-core';
import { NV1_LOCK } from './next-version-v1';
import { panelGrid } from './rv-panel';
import { rvV1TakerSteps, syntheticPanel } from './rv-synthetic';
import type { StrategyReport } from './report-schema';
import {
  EXPORT_SPAN,
  NATIVE_REFERENCE,
  TRANCHE_FIELDS,
  c1Tranches,
  parseCliArgs,
  rvSpan,
  rvTranches,
  signalTranches,
  v8HarnessArgs,
  v8Tranches,
  writeExport,
  type Tranche,
} from './round4-native-export';

const HOUR = 3_600_000;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'r4-native-'));
  dirs.push(d);
  return d;
}

/** The CHoCH setup of lab-v4-preview.test.ts: one bull CHoCH with a positive break delta at bar 110. */
function chochBars(startMs: number, count = 150): OHLCV[] {
  const bars: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    bars.push({ timestamp: startMs + i * HOUR, open: 95, high: 100, low: 90, close: 95, volume: 1000, takerBuyVolume: 500 });
  }
  bars[25].high = 150;
  bars[50].low = 40;
  bars[75].close = 35;
  bars[75].low = 30;
  bars[85].high = 120;
  bars[110].close = 130;
  bars[110].high = 135;
  bars[110].takerBuyVolume = 800;
  return bars;
}

/** The divergence setup of lab-v4-preview.test.ts: a regular bear divergence, signal confirmed at bar 80. */
function divergenceBars(startMs: number): OHLCV[] {
  const bars: OHLCV[] = [];
  for (let i = 0; i < 150; i++) {
    bars.push({ timestamp: startMs + i * HOUR, open: 95, high: 100, low: 90, close: 95, volume: 1000, takerBuyVolume: 500 });
  }
  bars[25].high = 150;
  bars[60].high = 180;
  for (let i = 26; i <= 60; i++) bars[i].takerBuyVolume = 200;
  return bars;
}

const START = Date.UTC(2023, 0, 1);

describe('contract fields and the writer', () => {
  it('writes valid JSONL with every contract field, and a summary with manifest_hash and warmup_from', () => {
    const out = tmp();
    const tranches: Tranche[] = [
      {
        rule: 's1', symbol: 'BTCUSDT', side: 1, entry_ms: 1, exit_ms: 2, entry_price: 100, exit_price: 101,
        weight: 0.1, exit_reason: 'horizon', price_source: 'perp',
      },
      {
        rule: 's1', symbol: 'ETHUSDT', side: -1, entry_ms: 3, exit_ms: 4, entry_price: 50, exit_price: null,
        weight: -0.1, exit_reason: 'stop', price_source: 'perp',
      },
    ];
    writeExport(out, tranches, {
      rule: 's1', n_tranches: 2, mean_net_native: -0.001, manifest_hash: 'abc', warmup_from: '2022-01-01T00:00:00.000Z',
      span: { from: '2022-01-01T00:00:00.000Z', to_exclusive: '2026-07-01T00:00:00.000Z' },
      costs: { fee_taker: 0.0005, fee_maker: 0.0002, slippage_bps: 2, round_trip: 0.0014 },
      parity: {},
    });
    const lines = readFileSync(join(out, 'tranches.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      for (const f of TRANCHE_FIELDS) expect(row).toHaveProperty(f);
    }
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as Record<string, unknown>;
    expect(summary.manifest_hash).toBe('abc');
    expect(summary.warmup_from).toBe('2022-01-01T00:00:00.000Z');
    expect(summary.n_tranches).toBe(2);
  });
});

describe('flag refusal', () => {
  const base = ['s1', '--dataset-dir', '/d', '--out', '/o'];
  it('parses the required flags', () => {
    expect(parseCliArgs(base)).toMatchObject({ rule: 's1', datasetDir: '/d', out: '/o' });
  });
  it.each(['--allow-lockbox', '--allow-holdout-a', '--allowHoldoutA', '--holdout', '--holdout-h'])('refuses %s', (flag) => {
    expect(() => parseCliArgs([...base, flag])).toThrow(/refus/i);
  });
  it('refuses an unknown rule and an unknown flag', () => {
    expect(() => parseCliArgs(['nope', '--dataset-dir', '/d', '--out', '/o'])).toThrow(/rule/i);
    expect(() => parseCliArgs([...base, '--bogus'])).toThrow(/unknown/i);
  });
});

describe('S1 and S2 (lab-v4-preview callees)', () => {
  it('S1 keeps the symbol and matches c1Signals + tradesFor per symbol', () => {
    const bars = chochBars(START);
    const data = { BTCUSDT: { bars, settlements: [] }, ETHUSDT: { bars, settlements: [] } };
    const { tranches, nativeNets } = signalTranches('s1', data);
    const native = tradesFor(bars, [], c1Signals(bars));
    expect(native).toHaveLength(1);
    expect(tranches).toHaveLength(2);
    expect(tranches.map((t) => t.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    const t = tranches[0];
    expect(t).toMatchObject({
      rule: 's1', side: 1, weight: 0.1, exit_reason: 'horizon', price_source: 'perp',
      entry_ms: native[0].entryTime, exit_ms: native[0].exitTime, entry_price: 95, exit_price: 95,
    });
    expect(nativeNets).toEqual([native[0].net, native[0].net]);
    expect(t.exit_ms - t.entry_ms).toBe(8 * HOUR);
  });

  it('S2 emits a short with weight -1/10', () => {
    const bars = divergenceBars(START);
    const { tranches } = signalTranches('s2', { SOLUSDT: { bars, settlements: [] } });
    expect(tranches.length).toBeGreaterThan(0);
    expect(tranches[0]).toMatchObject({ rule: 's2', symbol: 'SOLUSDT', side: -1, weight: -0.1 });
  });

  it('drops rows at and after 2026-07-01 (the trade whose exit falls on the lockbox start is not made)', () => {
    // signal bar 110; entry bar 111, exit bar 119. Put bar 119 exactly on the lockbox start.
    const start = EXPORT_SPAN.to - 119 * HOUR;
    const bars = chochBars(start, 160);
    const { tranches } = signalTranches('s1', { BTCUSDT: { bars, settlements: [] } });
    expect(tranches).toHaveLength(0);
    // one hour earlier the exit bar is the last allowed bar and the trade stands
    const ok = signalTranches('s1', { BTCUSDT: { bars: chochBars(start - HOUR, 160), settlements: [] } });
    expect(ok.tranches).toHaveLength(1);
  });

  it('drops rows before 2022-01-01 (no extra history is read)', () => {
    const start = EXPORT_SPAN.from - 112 * HOUR; // the CHoCH build-up and signal bar 110 sit before the span
    const { tranches } = signalTranches('s1', { BTCUSDT: { bars: chochBars(start), settlements: [] } });
    expect(tranches).toHaveLength(0);
    const full = signalTranches('s1', { BTCUSDT: { bars: chochBars(START), settlements: [] } });
    expect(full.tranches).toHaveLength(1);
  });
});

describe('rv-v1', () => {
  const panel = syntheticPanel({ bars: 160, symbols: 10, mode: 'planted', strength: 1, seed: 3 });

  it('tranche weights reproduce the positions of rvV1TakerSteps', () => {
    const steps = rvV1TakerSteps(panel);
    const tr = rvTranches(panel);
    expect(tr.length).toBeGreaterThan(0);
    const byEntry = new Map<number, Tranche[]>();
    for (const t of tr) byEntry.set(t.entry_ms, [...(byEntry.get(t.entry_ms) ?? []), t]);
    steps.forEach((step, i) => {
      const equityBefore = i === 0 ? RV_V1.startingEquity : steps[i - 1].equityAfter;
      const entryMs = panel.t[step.k + 1];
      const rows = byEntry.get(entryMs) ?? [];
      const held = Object.entries(step.after.positions).filter(([, p]) => p.qty !== 0);
      expect(rows).toHaveLength(held.length);
      for (const [symbol, p] of held) {
        const s = panel.symbols.indexOf(symbol);
        const row = rows.find((r) => r.symbol === symbol) as Tranche;
        expect(row.side).toBe(p.qty > 0 ? 1 : -1);
        expect(row.entry_price).toBe(panel.open[s][step.k + 1]);
        expect(row.weight).toBeCloseTo((p.qty * panel.open[s][step.k + 1]) / equityBefore, 12);
        expect(Math.sign(row.weight)).toBe(row.side);
        expect(row.price_source).toBe('perp');
        const next = step.k + 2 < panel.t.length;
        expect(row.exit_ms).toBe(next ? panel.t[step.k + 2] : panel.t[step.k + 1] + RV_V1.barMs);
        expect(row.exit_price).toBe(next ? panel.open[s][step.k + 2] : panel.close[s][step.k + 1]);
        expect(row.exit_reason).toBe(next ? 'rebalance' : 'end_of_data');
      }
    });
  });

  it('the span ends before the lockbox: the last panel bar closes at or before 2026-06-30 23:59:59.999', () => {
    const grid = panelGrid(rvSpan());
    expect(grid.from).toBe(EXPORT_SPAN.from);
    expect(grid.to + RV_V1.barMs).toBeLessThan(EXPORT_SPAN.to);
  });
});

describe('C1 at k = 1', () => {
  function scoreRows(symbol: string, scores: number[], start: number): ScoreRow[] {
    return scores.map((score, i) => ({ symbol, t: start + i * HOUR, close: 100 + i, score }));
  }
  const c90 = NV1_LOCK.c1.c90;

  it('matches buildTrades directly (k = 1, hold 24, cost 0.16)', () => {
    const scores = new Array<number>(120).fill(0);
    scores[10] = c90 + 1;
    scores[11] = c90 + 2;
    scores[60] = -(c90 + 3);
    scores[61] = -(c90 + 3);
    scores[62] = -(c90 + 3);
    const rows = scoreRows('BTCUSDT', scores, START);
    const series = coinSeriesInWindow(rows, 'BTCUSDT', EXPORT_SPAN.from, EXPORT_SPAN.to, c90);
    const direct = buildTrades(series, {
      k: 1, hold: NV1_C1.hold, stepMs: NV1_C1.stepMs, costPct: NV1_C1.costPct, from: EXPORT_SPAN.from, to: EXPORT_SPAN.to,
    });
    expect(direct.length).toBeGreaterThan(0);
    const { tranches, nativeNets } = c1Tranches(rows);
    expect(tranches).toHaveLength(direct.length);
    direct.forEach((d, i) => {
      const t = tranches[i];
      expect(t.symbol).toBe('BTCUSDT');
      expect(t.side).toBe(d.d);
      expect(t.weight).toBe(d.d / 10);
      expect(t.price_source).toBe('spot');
      expect(t.entry_ms).toBe(d.openT + HOUR);
      expect(t.exit_ms).toBe(d.closeT + HOUR);
      expect(t.exit_reason).toBe('horizon');
      expect((t.exit_price as number) / t.entry_price - 1).toBeCloseTo((d.grossPct / 100) * d.d, 10);
      expect(nativeNets[i]).toBeCloseTo(d.netPct / 100, 12);
    });
    // k = 1 needs two consecutive same-side bars: the single-bar signal at 60..62 opens at 61, the pair at 10, 11 at 11
    expect(direct.map((d) => d.openT)).toEqual([START + 11 * HOUR, START + 61 * HOUR]);
  });

  it('drops score rows outside [2022-01-01, 2026-07-01)', () => {
    const scores = new Array<number>(120).fill(c90 + 1);
    const before = scoreRows('BTCUSDT', scores, EXPORT_SPAN.from - 70 * HOUR);
    expect(c1Tranches(before).tranches.every((t) => t.entry_ms >= EXPORT_SPAN.from)).toBe(true);
    const after = scoreRows('BTCUSDT', scores, EXPORT_SPAN.to + HOUR);
    expect(c1Tranches(after).tranches).toHaveLength(0);
  });
});

describe('v8 at 1h and 4h', () => {
  it('builds harness args from the runbook: fixed D0 E1, perp prices, no lockbox, ends before 2026-07-01', () => {
    for (const interval of ['1h', '4h'] as const) {
      const a = v8HarnessArgs(interval, '/ds', '/out/report.json');
      expect(a).toMatchObject({
        family: 'dx-d0', interval, fixedEval: true, fixParams: { exit: 1, k: 1 }, price: 'perp',
        allowLockbox: false, fundingSettlements: true, noBenchmark: true,
        evalFrom: EXPORT_SPAN.from, datasetDir: '/ds', out: '/out/report.json',
      });
      expect(a.end).toBe(EXPORT_SPAN.to - 1);
      expect(a.symbols).toHaveLength(10);
    }
  });

  it('turns report trades into tranches with prices from the perp bars', () => {
    const t0 = EXPORT_SPAN.from + 100 * HOUR;
    const bars: OHLCV[] = [];
    for (let i = 0; i < 40; i++) bars.push({ timestamp: t0 + i * HOUR, open: 100 + i, high: 200, low: 1, close: 100.5 + i, volume: 1 });
    const trade = (entry: number, exit: number, side: 'long' | 'short', reason: string) => ({
      entryTime: t0 + entry * HOUR, exitTime: t0 + exit * HOUR, side, pnlPercent: -0.1, exitReason: reason, holdTimeBars: exit - entry,
    });
    const report = {
      interval: '1h',
      pooled: { n: 3 },
      costs: { feePercent: 0.05, makerFeePercent: 0.02, takerFeePercent: 0.05, slippageBps: 3, fundingEnabled: true },
      perSymbol: [{ symbol: 'BTCUSDT', windows: [{ trades: [trade(1, 25, 'long', 'time_stop'), trade(30, 33, 'short', 'stop_loss')] }, { trades: [trade(2, 26, 'long', 'end_of_data')] }] }],
    } as unknown as StrategyReport;
    const { tranches, nativeNets } = v8Tranches('v8-1h', report, { BTCUSDT: bars });
    expect(tranches).toHaveLength(3);
    const horizon = tranches.find((t) => t.exit_reason === 'horizon') as Tranche;
    expect(horizon).toMatchObject({ rule: 'v8-1h', symbol: 'BTCUSDT', side: 1, weight: 0.1, entry_price: 101, exit_price: 125.5, price_source: 'perp' });
    const stop = tranches.find((t) => t.exit_reason === 'stop') as Tranche;
    expect(stop).toMatchObject({ side: -1, weight: -0.1, exit_price: null });
    expect(nativeNets.every((n) => n === -0.001)).toBe(true);
  });

  it('records the plain label and the recorded RESULT values', () => {
    expect(NATIVE_REFERENCE['v8-1h'].trades).toBe(3614);
    expect(NATIVE_REFERENCE['v8-4h'].trades).toBe(411);
    expect(NATIVE_REFERENCE.s1).toMatchObject({ trades: 2459, mean_net: -0.00126 });
    expect(NATIVE_REFERENCE.s2).toMatchObject({ trades: 1594, mean_net: -0.00093 });
    expect(NATIVE_REFERENCE.c1.mean_net).toBeCloseTo(0.00085, 8);
  });
});
